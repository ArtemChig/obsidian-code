// Small shared helpers for the extensions area: paths, mtime-checked file cache, safe directory reads, logging.

import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ExtensionsOptions {
  /** Home directory used for ~/.obsidian-code and ~/.claude (default: $OBSIDIAN_CODE_HOME or os.homedir()). Tests pass a temp dir. */
  homeDir?: string;
  /** How long start() waits for the initial MCP connections before returning (they keep connecting in the background). */
  mcpStartupWaitMs?: number;
  /** Per-server MCP connect timeout (default 45 s: first-run `npx -y` downloads can be slow). */
  mcpConnectTimeoutMs?: number;
  /** Per-call MCP tool timeout (default 120 s, reset by progress notifications). */
  mcpToolTimeoutMs?: number;
  /** Debounce for settings-change driven MCP reconciliation (default 300 ms). */
  mcpReconcileDebounceMs?: number;
  /** First auto-reconnect delay after an MCP server drops (default 2 s, doubles per attempt, max 30 s). */
  mcpReconnectBaseMs?: number;
  /** An MCP connection must stay up this long before its retry budget is restored (default 60 s). */
  mcpStableMs?: number;
}

export function resolveHome(opts?: ExtensionsOptions): string {
  return opts?.homeDir ?? (process.env.OBSIDIAN_CODE_HOME || os.homedir());
}

/** Case-insensitive on Windows. Used as map/set key for de-duplication. */
export function pathKey(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** True for a directory, or a symlink/junction that points to one. */
export async function isDirectory(entry: Dirent, parent: string): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return (await fsp.stat(path.join(parent, entry.name))).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/** True for a regular file, or a symlink that points to one. */
export async function isFile(entry: Dirent, parent: string): Promise<boolean> {
  if (entry.isFile()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return (await fsp.stat(path.join(parent, entry.name))).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

const MAX_FILE_BYTES = 512 * 1024;

/**
 * Parse-result cache keyed by absolute path and invalidated by (mtimeMs, size).
 * `get` returns null when the path is missing or is not a regular file.
 */
export class FileCache<T> {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; value: T }>();

  async get(file: string, parse: (raw: string) => T): Promise<T | null> {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      this.entries.delete(file);
      return null;
    }
    if (!st.isFile()) return null;
    const hit = this.entries.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    let raw: string;
    try {
      const fh = await fsp.open(file, 'r');
      try {
        const len = Math.min(st.size, MAX_FILE_BYTES);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, 0);
        raw = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    const value = parse(raw);
    this.entries.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }
}

/** Best-effort append-only logger writing to <dataDir>/logs/ext.log. Never throws. */
export interface ExtLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Most recent lines (in memory) — handy for diagnostics and tests. */
  recent(): string[];
}

export function createLogger(dataDir: string): ExtLogger {
  const recent: string[] = [];
  let ensured = false;
  let chain: Promise<void> = Promise.resolve();
  const write = (level: string, msg: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${msg.replace(/\r?\n/g, '\\n')}`;
    recent.push(line);
    if (recent.length > 200) recent.shift();
    chain = chain
      .then(async () => {
        const dir = path.join(dataDir, 'logs');
        if (!ensured) {
          await fsp.mkdir(dir, { recursive: true });
          ensured = true;
        }
        await fsp.appendFile(path.join(dir, 'ext.log'), line + '\n', 'utf8');
      })
      .catch(() => undefined);
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    recent: () => recent.slice(),
  };
}

/** Expand ${VAR}, ${VAR:-default} (process.env) and ${secret:NAME} (secret store) in a config string. */
export function expandVars(input: string, secret: (name: string) => string | null): string {
  return input.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const e = expr.trim();
    if (e.startsWith('secret:')) return secret(e.slice('secret:'.length).trim()) ?? '';
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(e);
    if (!m) return whole;
    const v = process.env[m[1]!];
    return v !== undefined && v !== '' ? v : (m[2] ?? '');
  });
}

/** Split an argument string like `foo "bar baz" 'qux'` into words (quotes group, backslash escapes inside double quotes only for \" and \\). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) {
        cur += s[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
