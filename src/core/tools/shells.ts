// ShellRegistry: background commands (Bash/PowerShell with run_in_background) that outlive a single tool call.

import type { ChildProcess } from 'node:child_process';
import type { CoreContext, ShellRegistry } from '../contracts';
import { cleanOutput, killTree, killTreeSync, OutputBuffer, spawnShell, type ShellKind, type ShellProc } from './lib/shell';
import { oneLine } from './lib/text';

interface ShellRecord {
  id: string;
  command: string;
  kind: ShellKind;
  cwd: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  proc?: ShellProc;
  child?: ChildProcess;
  buf: OutputBuffer;
  readOffset: number;
  running: boolean;
  exitCode: number | null;
  killed: boolean;
}

const MAX_FINISHED = 30;

// One process-exit hook for all registries (tests create many).
const exitCallbacks = new Set<() => void>();
let exitHookInstalled = false;
function onProcessExit(cb: () => void): () => void {
  exitCallbacks.add(cb);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const fn of exitCallbacks) fn(); });
  }
  return () => { exitCallbacks.delete(cb); };
}

export type DisposableShellRegistry = ShellRegistry & { dispose(): void };

export function createShellRegistry(ctx: CoreContext): DisposableShellRegistry {
  const records = new Map<string, ShellRecord>();
  let counter = 0;

  const activityId = (id: string) => `shell:${id}`;

  function report(rec: ShellRecord): void {
    try {
      ctx.activity?.upsert({
        id: activityId(rec.id),
        kind: 'shell',
        title: oneLine(rec.command, 80),
        sessionId: rec.sessionId,
        status: rec.running ? 'running' : rec.killed ? 'stopped' : rec.exitCode === 0 ? 'done' : 'error',
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        detail: rec.running ? `${rec.kind} · ${rec.cwd}` : rec.killed ? 'killed' : `exit code ${rec.exitCode}`,
      });
    } catch { /* activity is optional */ }
  }

  function prune(): void {
    const finished = [...records.values()].filter((r) => !r.running).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (finished.length > MAX_FINISHED) {
      const r = finished.shift()!;
      records.delete(r.id);
    }
  }

  function finalize(rec: ShellRecord, code: number | null): void {
    if (!rec.running) return;
    rec.running = false;
    rec.exitCode = code;
    rec.endedAt = Date.now();
    rec.child?.stdout?.destroy();
    rec.child?.stderr?.destroy();
    rec.proc?.cleanup();
    report(rec);
    prune();
  }

  const exitHook = () => {
    for (const r of records.values()) if (r.running) killTreeSync(r.child?.pid);
  };
  const removeExitHook = onProcessExit(exitHook);

  const registry: DisposableShellRegistry = {
    start({ command, cwd, shell, sessionId }) {
      const id = `bash_${++counter}`;
      const rec: ShellRecord = {
        id, command, kind: shell, cwd, sessionId, startedAt: Date.now(), buf: new OutputBuffer(), readOffset: 0,
        running: true, exitCode: null, killed: false,
      };
      records.set(id, rec);
      try {
        const proc = spawnShell(shell, command, cwd);
        rec.proc = proc;
        rec.child = proc.child;
        const { child } = proc;
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        const onData = (d: string) => rec.buf.push(d);
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (err) => {
          rec.buf.push(`\n${err.message}\n`);
          finalize(rec, -1);
        });
        let grace: NodeJS.Timeout | undefined;
        child.on('exit', (code) => {
          grace = setTimeout(() => finalize(rec, code), 300);
        });
        child.on('close', (code) => {
          if (grace) clearTimeout(grace);
          finalize(rec, code);
        });
      } catch (e) {
        rec.buf.push(e instanceof Error ? e.message : String(e));
        finalize(rec, -1);
        return id;
      }
      report(rec);
      try {
        ctx.activity?.onStop(activityId(id), () => { registry.kill(id); });
      } catch { /* optional */ }
      return id;
    },

    output(id, opts) {
      const rec = records.get(id);
      if (!rec) return { output: '', running: false, exitCode: null };
      const sinceLast = opts?.sinceLastRead ?? false;
      const { text, end } = sinceLast ? rec.buf.since(rec.readOffset) : { text: rec.buf.all(), end: rec.buf.total };
      if (sinceLast) rec.readOffset = end;
      let output = cleanOutput(text);
      if (rec.proc) output = rec.proc.tidy(output);
      if (opts?.filter) {
        let re: RegExp | null = null;
        try { re = new RegExp(opts.filter); } catch { re = null; }
        const lines = output.split('\n');
        output = lines.filter((l) => (re ? re.test(l) : l.includes(opts.filter!))).join('\n');
      }
      return { output, running: rec.running, exitCode: rec.exitCode };
    },

    kill(id) {
      const rec = records.get(id);
      if (!rec || !rec.running) return false;
      rec.killed = true;
      void killTree(rec.child?.pid).then(() => {
        // 'close' normally follows; make sure the record ends even if pipes are held open by orphans.
        setTimeout(() => finalize(rec, rec.exitCode ?? 1), 1500).unref();
      });
      return true;
    },

    list(sessionId) {
      return [...records.values()]
        .filter((r) => !sessionId || r.sessionId === sessionId)
        .map((r) => ({ id: r.id, command: r.command, running: r.running, startedAt: r.startedAt, sessionId: r.sessionId }));
    },

    dispose() {
      removeExitHook();
      for (const r of records.values()) {
        if (r.running) {
          r.killed = true;
          void killTree(r.child?.pid);
        }
      }
    },
  };
  return registry;
}
