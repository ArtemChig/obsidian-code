// ripgrep discovery and execution for the Grep tool.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type GrepMode = 'content' | 'files_with_matches' | 'count';

export interface GrepParams {
  pattern: string;
  /** Directory (or file) to search. */
  target: string;
  targetIsFile: boolean;
  mode: GrepMode;
  ignoreCase: boolean;
  lineNumbers: boolean;
  after: number;
  before: number;
  globs: string[];
  type?: string;
  multiline: boolean;
  /** Max output lines (entries); 0 = unlimited. */
  limit: number;
  signal?: AbortSignal;
  /** Skip node_modules (when the search root is not inside one). */
  skipNodeModules: boolean;
}

export interface GrepRaw {
  /** One entry per output line, paths relative to `root`, NUL-separated from the rest for content/count modes. */
  lines: string[];
  /** Directory the relative paths in `lines` are relative to. */
  root: string;
  truncated: boolean;
  error?: string;
  timedOut?: boolean;
}

let rgOverride: string | null | undefined;
let rgCache: Promise<string | null> | undefined;

/** Test hook: force a ripgrep path (null = pretend ripgrep is missing, undefined = auto-detect). */
export function setRipgrepPathForTests(p: string | null | undefined): void {
  rgOverride = p;
  rgCache = undefined;
}

/** Executables cannot run from inside an asar archive; electron-builder unpacks them next to it. */
export function fixAsarPath(p: string): string {
  return p.includes('app.asar') && !p.includes('app.asar.unpacked') ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

export function getRipgrepPath(): Promise<string | null> {
  if (rgOverride !== undefined) return Promise.resolve(rgOverride);
  if (process.env.OBSIDIAN_CODE_NO_RG === '1') return Promise.resolve(null);
  rgCache ??= (async () => {
    try {
      const mod = (await import('@vscode/ripgrep')) as { rgPath?: string };
      if (!mod.rgPath) return null;
      const p = fixAsarPath(mod.rgPath);
      return existsSync(p) ? p : null;
    } catch {
      return null;
    }
  })();
  return rgCache;
}

const TIMEOUT_MS = 60_000;

export function splitGlobs(glob: string | undefined): string[] {
  if (!glob) return [];
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of glob) {
    if (c === '{') depth++;
    if (c === '}') depth = Math.max(0, depth - 1);
    if ((c === ' ' || c === ',') && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

export function runRipgrep(rg: string, p: GrepParams): Promise<GrepRaw> {
  const isFile = p.targetIsFile;
  const root = isFile ? path.dirname(p.target) : p.target;
  const args = ['--no-config', '--hidden', '--glob', '!.git', '--max-columns', '500', '--max-columns-preview', '--color', 'never', '--with-filename', '--sort', 'path'];
  if (p.skipNodeModules) args.push('--glob', '!node_modules');
  if (p.ignoreCase) args.push('-i');
  if (p.multiline) args.push('-U', '--multiline-dotall');
  if (p.type) args.push('--type', p.type);
  for (const g of p.globs) args.push('--glob', g);
  if (p.mode === 'files_with_matches') args.push('-l');
  else if (p.mode === 'count') args.push('-c', '--null');
  else {
    args.push('--no-heading', '--null');
    if (p.lineNumbers) args.push('-n');
    else args.push('--no-line-number');
    if (p.after > 0) args.push('-A', String(p.after));
    if (p.before > 0) args.push('-B', String(p.before));
  }
  args.push('-e', p.pattern, '--');
  if (isFile) args.push(path.basename(p.target));

  return new Promise<GrepRaw>((resolve) => {
    const child = spawn(rg, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let partial = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (extra: Partial<GrepRaw> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.signal?.removeEventListener('abort', onAbort);
      resolve({ lines, root, truncated, timedOut, ...extra });
    };
    const kill = () => {
      try { child.kill(); } catch { /* already exited */ }
    };
    const onAbort = () => {
      kill();
      finish();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    p.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (truncated) return;
      partial += d;
      let nl = partial.indexOf('\n');
      while (nl !== -1) {
        let line = partial.slice(0, nl);
        partial = partial.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lines.push(line);
        if (p.limit > 0 && lines.length >= p.limit) {
          truncated = true;
          kill();
          return;
        }
        nl = partial.indexOf('\n');
      }
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < 4000) stderr += d;
    });
    child.on('error', (err) => finish({ error: `ripgrep failed to start: ${err.message}`, lines: [] }));
    child.on('close', (code) => {
      if (!truncated && partial) {
        lines.push(partial.endsWith('\r') ? partial.slice(0, -1) : partial);
        partial = '';
      }
      // exit 1 = no matches; 2 = error (possibly with partial results, e.g. unreadable files)
      if (code === 2 && lines.length === 0 && stderr.trim()) finish({ error: stderr.trim().split('\n').slice(0, 6).join('\n') });
      else finish();
    });
  });
}

