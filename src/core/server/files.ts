// Workspace file helpers for the files.* RPC methods (owner: platform).
//   files.list   — directory listing (absolute paths; `dir` may be absolute or cwd-relative)
//   files.search — fuzzy file-name search under cwd (relative POSIX-style paths, for @mentions)
//   files.read   — read a text file with a byte cap

import { open, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import fg from 'fast-glob';

/** Directories never descended into by files.search. */
export const SEARCH_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  '.idea',
  'AppData',
  '$RECYCLE.BIN',
];
const MAX_INDEXED_FILES = 50_000;
const INDEX_TIME_BUDGET_MS = 4_000;
const INDEX_TTL_MS = 15_000;

function resolveIn(cwd: string, p: string | undefined): string {
  if (!p) return resolve(cwd);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export async function listDir(
  cwd: string,
  dir?: string,
): Promise<{ name: string; path: string; isDir: boolean; size?: number }[]> {
  if (!cwd) throw new Error('cwd is required');
  const abs = resolveIn(cwd, dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const out = await Promise.all(
    entries
      .filter((e) => e.name !== '.git')
      .map(async (e) => {
        const p = join(abs, e.name);
        let isDir = e.isDirectory();
        let size: number | undefined;
        if (e.isSymbolicLink() || (!isDir && e.isFile())) {
          try {
            const st = await stat(p);
            isDir = st.isDirectory();
            if (!isDir) size = st.size;
          } catch {
            /* broken link */
          }
        }
        return size === undefined ? { name: e.name, path: p, isDir } : { name: e.name, path: p, isDir, size };
      }),
  );
  return out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
}

// ── file index for fuzzy search (cached per cwd for a few seconds)

interface IndexEntry {
  at: number;
  files: Promise<string[]>;
}
const indexCache = new Map<string, IndexEntry>();

async function indexFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const stream = fg.stream('**/*', {
    cwd,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: SEARCH_IGNORE_DIRS.map((d) => `**/${d}/**`),
  });
  const deadline = Date.now() + INDEX_TIME_BUDGET_MS;
  for await (const entry of stream) {
    files.push(String(entry));
    if (files.length >= MAX_INDEXED_FILES || Date.now() > deadline) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      break;
    }
  }
  return files;
}

function getIndex(cwd: string): Promise<string[]> {
  const key = resolve(cwd).toLowerCase();
  const hit = indexCache.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.files;
  const files = indexFiles(resolve(cwd));
  indexCache.set(key, { at: Date.now(), files });
  files.catch(() => indexCache.delete(key));
  return files;
}

/** Clear the file-index cache (tests). */
export function clearFileIndexCache(): void {
  indexCache.clear();
}

/**
 * fzf-style score of `query` against `path` (both lower-case); -Infinity when not a subsequence.
 * Rewards matches in the basename, consecutive characters and segment starts; penalises long paths.
 */
export function fuzzyScore(path: string, query: string): number {
  if (!query) return 0;
  const baseStart = path.lastIndexOf('/') + 1;
  const base = path.slice(baseStart);
  let score = 0;
  const subIdx = base.indexOf(query);
  if (subIdx >= 0) score += 100 + (subIdx === 0 ? 50 : 0) + (base.length === query.length ? 50 : 0);
  else if (path.includes(query)) score += 40;

  let qi = 0;
  let prev = -2;
  for (let i = 0; i < path.length && qi < query.length; i++) {
    if (path[i] !== query[qi]) continue;
    let s = 1;
    if (i === prev + 1) s += 5;
    const before = i > 0 ? path[i - 1] : '/';
    if (before === '/' || before === '_' || before === '-' || before === '.' || before === ' ') s += 3;
    if (i >= baseStart) s += 2;
    score += s;
    prev = i;
    qi++;
  }
  if (qi < query.length) return Number.NEGATIVE_INFINITY;
  return score - path.length * 0.05;
}

export async function searchFiles(cwd: string, query: string, limit = 50): Promise<string[]> {
  if (!cwd) throw new Error('cwd is required');
  const max = Math.max(1, Math.min(500, Math.floor(limit) || 50));
  const files = await getIndex(cwd);
  const tokens = query.toLowerCase().replace(/\\/g, '/').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, max);
  }
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    let total = 0;
    for (const t of tokens) {
      const s = fuzzyScore(lower, t);
      if (s === Number.NEGATIVE_INFINITY) {
        total = s;
        break;
      }
      total += s;
    }
    if (total !== Number.NEGATIVE_INFINITY) scored.push({ f, s: total });
  }
  scored.sort((a, b) => b.s - a.s || a.f.length - b.f.length || a.f.localeCompare(b.f));
  return scored.slice(0, max).map((x) => x.f);
}

export async function readTextFile(
  path: string,
  baseDir: string,
  maxBytes = 1_000_000,
): Promise<{ content: string; truncated: boolean }> {
  if (!path) throw new Error('path is required');
  const abs = resolveIn(baseDir, path);
  const st = await stat(abs);
  if (st.isDirectory()) throw new Error(`${abs} is a directory`);
  const cap = Math.max(1, Math.min(Math.floor(maxBytes) || 1_000_000, 20_000_000));
  const len = Math.min(st.size, cap);
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const data = buf.subarray(0, bytesRead);
    const probe = data.subarray(0, Math.min(8192, data.length));
    if (probe.includes(0)) {
      return { content: `(binary file, ${st.size} bytes)`, truncated: false };
    }
    let content = data.toString('utf8');
    if (st.size > cap && content.endsWith('\uFFFD')) content = content.replace(/\uFFFD+$/, '');
    return { content, truncated: st.size > cap };
  } finally {
    await fh.close();
  }
}

/** Relative path helper (POSIX separators) used for display. */
export function toRelative(cwd: string, abs: string): string {
  return relative(cwd, abs).split('\\').join('/');
}
