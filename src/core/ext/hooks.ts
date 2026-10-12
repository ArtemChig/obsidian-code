// Hooks: run user-configured shell commands at lifecycle events with a JSON payload on stdin.
//   exit 0  → stdout may be JSON { additionalContext?, decision?: 'block'|'deny', reason? } (plain text becomes
//             context for UserPromptSubmit / SessionStart)
//   exit 2  → block; stderr is the message shown to the model/user
//   other   → logged only

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import treeKill from 'tree-kill';
import type { HookConfig, Settings } from '../../shared/types';
import { resolveShell } from './shell';
import type { ExtLogger } from './util';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';
export interface HookOutcome { block: boolean; message?: string; additionalContext?: string }

export interface HookDeps {
  settings(): Settings;
  projectHooks(cwd: string): Settings['hooks'];
  log: ExtLogger;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDIN_CHARS = 1_000_000;

const KEY_ALIASES: Record<string, string> = {
  sessionId: 'session_id',
  toolName: 'tool_name',
  toolInput: 'tool_input',
  toolUseId: 'tool_use_id',
  toolResponse: 'tool_response',
  toolResult: 'tool_response',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function capStrings(v: unknown, max: number): unknown {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `…[${v.length - max} more chars]` : v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, max)]));
  return v;
}

/** JSON written to the hook's stdin: the payload plus Claude Code compatible snake_case aliases. */
export function buildHookStdin(event: HookEvent, payload: Record<string, unknown>, cwd: string): string {
  const out: Record<string, unknown> = { hook_event_name: event, cwd, ...payload };
  for (const [camel, snake] of Object.entries(KEY_ALIASES)) {
    if (camel in payload && !(snake in out)) out[snake] = payload[camel];
  }
  const isTool = event === 'PreToolUse' || event === 'PostToolUse';
  if (isTool) {
    if (!('tool_input' in out) && 'input' in payload) out.tool_input = payload.input;
    if (event === 'PostToolUse' && !('tool_response' in out)) {
      const r = payload.result ?? payload.output;
      if (r !== undefined) out.tool_response = r;
    }
    if (!('tool_name' in out)) {
      const n = payload.tool ?? payload.name;
      if (typeof n === 'string') out.tool_name = n;
    }
  }
  let json = JSON.stringify(out);
  if (json.length > MAX_STDIN_CHARS) json = JSON.stringify(capStrings(out, 20_000));
  return json;
}

function toolNameOf(payload: Record<string, unknown>): string | undefined {
  return str(payload.tool_name) ?? str(payload.toolName) ?? str(payload.tool) ?? str(payload.name);
}

export function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  const m = matcher?.trim();
  if (!m || m === '*') return true;
  if (toolName === undefined) return false;
  try {
    return new RegExp(`^(?:${m})$`).test(toolName);
  } catch {
    return m === toolName;
  }
}

function interpretJson(event: HookEvent, stdout: string): HookOutcome {
  const t = stdout.trim();
  if (!t) return { block: false };
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const hs = (o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {}) as Record<string, unknown>;
      const additionalContext = str(o.additionalContext) ?? str(hs.additionalContext);
      const decision = (str(o.decision) ?? str(hs.permissionDecision) ?? '').toLowerCase();
      const out: HookOutcome = { block: false };
      if (additionalContext) out.additionalContext = additionalContext;
      if (decision === 'block' || decision === 'deny') {
        out.block = true;
        out.message = str(o.reason) ?? str(o.message) ?? str(hs.permissionDecisionReason) ?? 'Blocked by hook';
      } else if (o.continue === false) {
        out.block = true;
        out.message = str(o.stopReason) ?? str(o.reason) ?? 'Stopped by hook';
      }
      return out;
    } catch {
      /* not JSON — fall through to plain text handling */
    }
  }
  if (event === 'UserPromptSubmit' || event === 'SessionStart') return { block: false, additionalContext: t };
  return { block: false };
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted?: boolean; spawnError?: string }

/** After the hook process exits, wait at most this long for its pipes to close (a backgrounded grandchild may hold them). */
const EXIT_GRACE_MS = 300;

function runShellCommand(hook: HookConfig, stdin: string, cwd: string, event: HookEvent, deps: HookDeps, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const shell = resolveShell(deps.settings().shell);
    const timeoutMs = Math.max(50, Math.min(hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, 600_000));
    const env = {
      ...process.env,
      OBSIDIAN_CODE_PROJECT_DIR: cwd,
      CLAUDE_PROJECT_DIR: cwd,
      OBSIDIAN_CODE_HOOK_EVENT: event,
    };
    let child;
    try {
      child = spawn(shell.file, shell.args(hook.command), {
        cwd: existsSync(cwd) ? cwd : undefined,
        env,
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim === true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (e as Error).message });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (): void => {
      if (child.pid) treeKill(child.pid, 'SIGKILL', () => undefined);
      else child.kill('SIGKILL');
    };
    const onAbort = (): void => {
      kill();
      finish({ code: null, aborted: true });
    };
    const finish = (r: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      // Resolve even if a grandchild keeps the pipes open after the kill.
      setTimeout(() => finish({ code: null }), 1000).unref();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (c: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) { out.push(c); outBytes += c.length; }
    });
    child.stderr.on('data', (c: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) { err.push(c); errBytes += c.length; }
    });
    child.stdin.on('error', () => undefined); // hook exited without reading stdin (EPIPE)
    child.on('error', (e) => finish({ code: null, spawnError: e.message }));
    child.on('exit', (code) => {
      exitCode = code;
      graceTimer = setTimeout(() => finish({ code: exitCode }), EXIT_GRACE_MS);
      graceTimer.unref?.();
    });
    child.on('close', (code) => finish({ code: exitCode ?? code }));
    try {
      child.stdin.end(stdin);
    } catch {
      /* ignore */
    }
  });
}

export function createHookRunner(deps: HookDeps) {
  function collect(event: HookEvent, cwd: string): HookConfig[] {
    const all: HookConfig[] = [];
    const seen = new Set<string>();
    const lists: (HookConfig[] | undefined)[] = [deps.settings().hooks?.[event]];
    try {
      lists.push(deps.projectHooks(cwd)?.[event]);
    } catch (e) {
      deps.log.warn(`reading project hooks for ${cwd} failed: ${(e as Error).message}`);
    }
    for (const list of lists) {
      for (const h of list ?? []) {
        if (!h || typeof h.command !== 'string' || !h.command.trim()) continue;
        const key = `${h.matcher ?? ''}\u0000${h.command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(h);
      }
    }
    return all;
  }

  async function runHooks(event: HookEvent, payload: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<HookOutcome> {
    if (signal?.aborted) return { block: false };
    const isTool = event === 'PreToolUse' || event === 'PostToolUse';
    const toolName = toolNameOf(payload);
    const hooks = collect(event, cwd).filter((h) => !isTool || matcherMatches(h.matcher, toolName));
    if (!hooks.length) return { block: false };

    const stdin = buildHookStdin(event, payload, cwd);
    const results = await Promise.all(
      hooks.map(async (h): Promise<HookOutcome> => {
        const r = await runShellCommand(h, stdin, cwd, event, deps, signal);
        if (r.aborted) return { block: false };
        const label = `${event} hook \`${h.command.length > 80 ? h.command.slice(0, 77) + '...' : h.command}\``;
        if (r.spawnError) {
          deps.log.error(`${label} failed to start: ${r.spawnError}`);
          return { block: false };
        }
        if (r.timedOut) {
          deps.log.warn(`${label} timed out after ${h.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS} ms`);
          return { block: false };
        }
        if (r.code === 2) {
          const message = r.stderr.trim() || r.stdout.trim() || 'Blocked by hook';
          deps.log.info(`${label} blocked: ${message.slice(0, 200)}`);
          return { block: true, message };
        }
        if (r.code !== 0) {
          deps.log.warn(`${label} exited with code ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
          return { block: false };
        }
        return interpretJson(event, r.stdout);
      }),
    );

    const blocks = results.filter((r) => r.block);
    const contexts = results.map((r) => r.additionalContext).filter((c): c is string => !!c);
    const outcome: HookOutcome = { block: blocks.length > 0 };
    if (blocks.length) outcome.message = blocks.map((b) => b.message ?? 'Blocked by hook').join('\n');
    if (contexts.length) outcome.additionalContext = contexts.join('\n\n');
    return outcome;
  }

  return { runHooks };
}
