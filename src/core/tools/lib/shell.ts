// Shell plumbing shared by Bash, PowerShell and the ShellRegistry: shell discovery, spawning (Git Bash / PowerShell / cmd),
// process-tree kill, bounded output capture, foreground execution with timeout/abort/progress, and the read-only
// command allowlist + "always allow" rule derivation.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import treeKill from 'tree-kill';
import type { Settings } from '../../../shared/types';

export type ShellKind = 'bash' | 'powershell' | 'cmd';

const IS_WIN = process.platform === 'win32';

// ───────────────────────────── discovery ─────────────────────────────

export function findGitBash(): string | null {
  const override = process.env.OBSIDIAN_CODE_BASH;
  if (override && existsSync(override)) return override;
  if (!IS_WIN) return existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    ...(local ? [path.join(local, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function powershellExe(): string {
  if (!IS_WIN) return 'pwsh';
  const root = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(p) ? p : 'powershell.exe';
}

/** settings.shell → the shell the Bash tool actually uses. */
export function resolveShellKind(setting: Settings['shell'] | undefined): ShellKind {
  switch (setting) {
    case 'powershell': return 'powershell';
    case 'cmd': return IS_WIN ? 'cmd' : 'bash';
    case 'git-bash':
    case 'auto':
    default:
      return findGitBash() ? 'bash' : IS_WIN ? 'powershell' : 'bash';
  }
}

export function shellLabel(kind: ShellKind): string {
  return kind === 'bash' ? 'Git Bash' : kind === 'powershell' ? 'PowerShell' : 'cmd.exe';
}

// ───────────────────────────── spawning ─────────────────────────────

export interface ShellProc {
  child: ChildProcess;
  cleanup(): void;
  /** Hide the temp-script path from error text (e.g. "bash: line 2: foo: command not found"). */
  tidy(text: string): string;
}

const swept = new Set<string>();

/** Write a command to a temp script file. Passing it as a command-line argument would let Windows/MSYS argument
 *  parsing rewrite backslashes and cap the length, so every shell runs from a file instead. */
function writeTempScript(dirName: string, ext: string, content: string): string {
  const dir = path.join(tmpdir(), dirName);
  mkdirSync(dir, { recursive: true });
  if (!swept.has(dir)) {
    swept.add(dir);
    try {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (Date.now() - statSync(p).mtimeMs > 24 * 3600_000) unlinkSync(p);
      }
    } catch { /* best effort */ }
  }
  const file = path.join(dir, `${randomBytes(6).toString('hex')}${ext}`);
  writeFileSync(file, content, 'utf8');
  return file;
}

function removeQuietly(file: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}

function shellEnv(kind: ShellKind): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'dumb',
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
  if (kind === 'bash') env.LANG = 'C.UTF-8';
  return env;
}

const PS_PRE = "$ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; ";
const PS_POST = '\nif ($?) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }\n';

export function spawnShell(kind: ShellKind, command: string, cwd: string): ShellProc {
  const env = shellEnv(kind);
  const base = { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  if (kind === 'bash') {
    const exe = findGitBash();
    if (!exe) throw new Error('Git Bash was not found (expected C:\\Program Files\\Git\\bin\\bash.exe).');
    // `bash -c <command>` would pass through MSYS argv parsing, which collapses "\\" to "\" and caps the length at 32 KB.
    const scriptPath = writeTempScript('obsidian-code-sh', '.sh', `${command.replace(/\r\n/g, '\n')}\n`);
    const fwd = scriptPath.replace(/\\/g, '/');
    const msys = fwd.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
    const child = spawn(exe, [fwd], base);
    return {
      child,
      cleanup: () => removeQuietly(scriptPath),
      tidy: (t) => t.split(msys).join('bash').split(fwd).join('bash').split(scriptPath).join('bash'),
    };
  }
  if (kind === 'cmd') {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], { ...base, windowsVerbatimArguments: true });
    return { child, cleanup() {}, tidy: (t) => t };
  }
  // PowerShell: run from a temp script (-File). -EncodedCommand makes stderr come back as CLIXML and -Command
  // mangles quoting/length; a BOM-prefixed file avoids both and keeps Unicode intact.
  const scriptPath = writeTempScript('obsidian-code-ps', '.ps1', `\ufeff${PS_PRE}${command}${PS_POST}`);
  const args = ['-NoProfile', '-NonInteractive', ...(IS_WIN ? ['-ExecutionPolicy', 'Bypass'] : []), '-File', scriptPath];
  const child = spawn(powershellExe(), args, base);
  return {
    child,
    cleanup: () => removeQuietly(scriptPath),
    tidy: (t) => t.split(scriptPath).join('<command>'),
  };
}

export function killTree(pid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    try {
      treeKill(pid, 'SIGKILL', () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Synchronous kill for process-exit hooks. */
export function killTreeSync(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* best effort */ }
}

// ───────────────────────────── output capture ─────────────────────────────

/** Bounded capture: keeps the first headMax chars and the last ~tailMax chars, tracking absolute offsets for incremental reads. */
export class OutputBuffer {
  private head = '';
  private tail = '';
  private tailStart = 0;
  total = 0;

  constructor(private readonly headMax = 200_000, private readonly tailMax = 800_000) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headMax) {
      const take = this.headMax - this.head.length;
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
      this.tailStart = this.head.length;
      if (!rest) return;
    }
    this.tail += rest;
    if (this.tail.length > this.tailMax * 1.5) {
      const cut = this.tail.length - this.tailMax;
      this.tail = this.tail.slice(cut);
      this.tailStart += cut;
    }
  }

  get dropped(): number {
    return this.tailStart - this.head.length;
  }

  private marker(): string {
    return this.dropped > 0 ? `\n… [${this.dropped} characters of output dropped] …\n` : '';
  }

  all(): string {
    return this.head + this.marker() + this.tail;
  }

  recent(n: number): string {
    if (this.tail.length >= n) return this.tail.slice(this.tail.length - n);
    const all = this.all();
    return all.length > n ? all.slice(all.length - n) : all;
  }

  /** Output produced at or after absolute offset `offset`. */
  since(offset: number): { text: string; end: number } {
    if (offset >= this.total) return { text: '', end: this.total };
    if (offset >= this.tailStart) return { text: this.tail.slice(offset - this.tailStart), end: this.total };
    let text = '';
    if (offset < this.head.length) text += this.head.slice(offset);
    text += this.marker() + this.tail;
    return { text, end: this.total };
  }
}

/** Strip ANSI, normalise CRLF, collapse carriage-return progress lines. */
export function cleanOutput(raw: string): string {
  let s = stripAnsi(raw).replace(/\r\n/g, '\n');
  if (s.includes('\r')) {
    s = s
      .split('\n')
      .map((line) => {
        if (!line.includes('\r')) return line;
        const segs = line.split('\r').filter((x) => x.length > 0);
        return segs.length ? segs[segs.length - 1] : '';
      })
      .join('\n');
  }
  return s;
}

// ───────────────────────────── foreground execution ─────────────────────────────

export interface RunOptions {
  command: string;
  cwd: string;
  kind: ShellKind;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called (throttled) with the tail of the output so far. */
  onProgress?: (tail: string) => void;
  progressIntervalMs?: number;
}

export interface RunResult {
  /** Full captured output (ANSI-stripped, head+tail bounded). */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Spawn failure, if any. */
  error?: string;
  durationMs: number;
}

export function runCommand(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const done = (r: Omit<RunResult, 'durationMs'>) => resolve({ ...r, durationMs: Date.now() - start });
    if (opts.signal?.aborted) return done({ output: '', exitCode: null, timedOut: false, aborted: true });
    if (!existsSync(opts.cwd)) return done({ output: '', exitCode: null, timedOut: false, aborted: false, error: `Working directory does not exist: ${opts.cwd}` });

    let proc: ShellProc;
    try {
      proc = spawnShell(opts.kind, opts.command, opts.cwd);
    } catch (e) {
      return done({ output: '', exitCode: null, timedOut: false, aborted: false, error: e instanceof Error ? e.message : String(e) });
    }
    const { child } = proc;
    const buf = new OutputBuffer();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitCode: number | null = null;
    let spawnError: string | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let failsafe: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let lastProgress = 0;
    const interval = opts.progressIntervalMs ?? 500;

    const emitProgress = () => {
      progressTimer = undefined;
      lastProgress = Date.now();
      if (!opts.onProgress) return;
      const tail = cleanOutput(buf.recent(4000)).split('\n').slice(-40).join('\n');
      try { opts.onProgress(tail); } catch { /* UI errors must not kill the command */ }
    };
    const scheduleProgress = () => {
      if (!opts.onProgress || progressTimer) return;
      progressTimer = setTimeout(emitProgress, Math.max(0, interval - (Date.now() - lastProgress)));
    };

    const onAbort = () => {
      aborted = true;
      void killTree(child.pid);
      failsafe ??= setTimeout(() => finish(), 3000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid);
      failsafe ??= setTimeout(() => finish(), 3000);
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      if (failsafe) clearTimeout(failsafe);
      if (progressTimer) clearTimeout(progressTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      proc.cleanup();
      let output = cleanOutput(buf.all());
      output = proc.tidy(output);
      done({ output, exitCode, timedOut, aborted, error: spawnError });
    }

    const onData = (d: string) => {
      buf.push(d);
      scheduleProgress();
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      spawnError = err.message;
      finish();
    });
    child.on('exit', (code) => {
      exitCode = code;
      // Streams normally close right after exit; a daemonised grandchild may keep them open, so don't wait forever.
      graceTimer = setTimeout(() => finish(), 300);
    });
    child.on('close', (code) => {
      if (exitCode === null) exitCode = code;
      finish();
    });
  });
}

// ───────────────────────────── read-only allowlist & rules ─────────────────────────────

/** Split a command into segments on ; && || | newline (outside quotes). Returns null for constructs we can't reason about. */
export function splitSegments(command: string, kind: ShellKind): string[] | null {
  let cmd = command.trim();
  // harmless stderr/devnull redirections
  cmd = cmd.replace(/\s+2>&1/g, '').replace(/\s+[12]?>\s*\/dev\/null/g, '').replace(/\s+[12]?>\s*\$null/gi, '').replace(/\s+[12]?>\s*nul\b/gi, '');
  const segs: string[] = [];
  let cur = '';
  let inS = false;
  let inD = false;
  const push = () => {
    if (cur.trim()) segs.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (inS) {
      if (c === "'") inS = false;
      cur += c;
      continue;
    }
    if (c === '`') return null;
    if (c === '$' && (n === '(' || n === '{')) return null;
    if (inD) {
      if (c === '"') inD = false;
      else if (c === '\\' && kind === 'bash' && n !== undefined) { cur += c + n; i++; continue; }
      cur += c;
      continue;
    }
    if (c === "'") { inS = true; cur += c; continue; }
    if (c === '"') { inD = true; cur += c; continue; }
    if (c === '\\' && kind === 'bash' && n !== undefined) { cur += c + n; i++; continue; }
    if (c === '>' || c === '<') return null;
    if (kind === 'powershell' && (c === '{' || c === '}' || c === '(' || c === ')')) return null; // script blocks / grouped expressions can run anything
    if (c === ';' || c === '\n' || c === '\r') { push(); continue; }
    if (c === '&') {
      if (n === '&') { push(); i++; continue; }
      return null;
    }
    if (c === '|') {
      push();
      if (n === '|') i++;
      continue;
    }
    cur += c;
  }
  if (inS || inD) return null;
  push();
  return segs;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

const RO_COMMON = new Set([
  'ls', 'dir', 'pwd', 'whoami', 'date', 'hostname', 'uname', 'which', 'where', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep',
  'fgrep', 'rg', 'tree', 'stat', 'du', 'df', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'printenv',
  'id', 'nl', 'cd', 'true', 'false', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'type',
]);
const RO_PS = new Set([
  'get-childitem', 'get-content', 'get-location', 'get-item', 'get-date', 'test-path', 'resolve-path', 'get-process', 'get-command',
  'select-string', 'measure-object', 'select-object', 'sort-object', 'format-list', 'format-table', 'out-string', 'split-path',
  'get-itemproperty', 'get-filehash', 'get-help', 'get-service', 'get-computerinfo', 'get-host', 'write-output', 'gc', 'gci', 'gl', 'gi',
  'gcm', 'sls', 'select', 'sort', 'measure', 'ft', 'fl', 'cd', 'set-location', 'sl',
]);
const RO_GIT = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'describe', 'ls-files', 'ls-tree', 'blame', 'shortlog', 'cat-file', 'reflog', 'grep',
  'rev-list', 'name-rev', 'merge-base', 'show-ref', 'count-objects', 'whatchanged',
]);
const VERSION_ONLY = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'py', 'pip', 'pip3', 'git', 'cargo', 'rustc', 'go', 'java', 'dotnet', 'tsc', 'deno', 'bun', 'docker']);

function gitReadOnly(all: string[]): boolean {
  // allow "git -C <dir> <subcommand>"
  const tokens = all[1] === '-C' && all.length > 3 ? [all[0], ...all.slice(3)] : all;
  const sub = tokens[1];
  if (!sub) return false;
  if (tokens.some((t) => t.startsWith('--output') || t.startsWith('--ext-diff') || t === '-c' || t.startsWith('--exec-path') || t.startsWith('--open-files-in-pager') || /^-O./.test(t))) return false;
  if (RO_GIT.has(sub)) return true;
  const rest = tokens.slice(2);
  if (sub === 'branch') return rest.every((t) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '-l', '--verbose'].includes(t));
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === 'show'));
  if (sub === 'tag') return rest.length === 0 || rest.every((t) => ['-l', '--list', '-n'].includes(t));
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'config') return rest[0] === '--get' || rest[0] === '--list' || rest[0] === '-l';
  if (sub === 'worktree') return rest[0] === 'list';
  return false;
}

function segmentReadOnly(segment: string, kind: ShellKind): boolean {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return true;
  let first = tokens[0];
  if (/^[A-Za-z_]\w*=/.test(first)) return false; // env prefix: be conservative
  first = path.basename(first.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (first === 'git') return gitReadOnly([first, ...tokens.slice(1)]);
  if (VERSION_ONLY.has(first) && tokens.length === 2 && ['-v', '-V', '--version', 'version'].includes(tokens[1])) return true;
  if (first === 'npm' && ['ls', 'list', 'view', 'outdated', 'root'].includes(tokens[1] ?? '')) return true;
  if (first === 'find') return !tokens.some((t) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(t));
  if (first === 'rg' && tokens.some((t) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(t))) return false; // can execute programs
  if (first === 'hostname' && tokens.length > 1) return false; // would set the host name
  if (first === 'date' && tokens.slice(1).some((t) => /^(-s|--set)/.test(t))) return false;
  if (kind === 'powershell') return RO_PS.has(first) || (RO_COMMON.has(first) && first !== 'type');
  return RO_COMMON.has(first);
}

/** True for simple, clearly read-only commands (git status, ls, pwd, …) that may run without a prompt. */
export function isReadOnlyCommand(command: string, kind: ShellKind): boolean {
  if (!command.trim() || command.length > 600) return false;
  const segs = splitSegments(command, kind);
  if (!segs || segs.length === 0) return false;
  return segs.every((s) => segmentReadOnly(s, kind));
}

/** Suggested "always allow" rule: `Bash(npm test:*)` for simple commands, the exact command otherwise. */
export function commandRule(toolName: 'Bash' | 'PowerShell', command: string, kind: ShellKind): string {
  const cmd = command.trim();
  const segs = splitSegments(cmd, kind);
  if (segs && segs.length === 1) {
    const tokens = tokenize(segs[0]);
    if (tokens.length > 0 && !/^[A-Za-z_]\w*=/.test(tokens[0])) {
      const second = tokens[1];
      const subcommandLike = second !== undefined && /^[A-Za-z][\w-]*$/.test(second) && !second.includes('.');
      const prefix = subcommandLike ? `${tokens[0]} ${second}` : tokens[0];
      return `${toolName}(${prefix}:*)`;
    }
  }
  return `${toolName}(${cmd})`;
}
