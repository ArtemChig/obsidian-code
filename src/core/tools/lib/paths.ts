// Path handling: accept absolute or cwd-relative paths, Windows separators, quotes, ~, and Git-Bash style /c/... paths.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

function stripQuotes(p: string): string {
  if (p.length >= 2) {
    const a = p[0];
    const b = p[p.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return p.slice(1, -1);
  }
  return p;
}

/** Convert `/c/Users/x`, `/mnt/c/Users/x` or `/cygdrive/c/x` to `C:\Users\x` (Windows only, only when that drive exists). */
function fromMsysPath(p: string): string | null {
  if (!IS_WIN) return null;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(p.replace(/\\/g, '/'));
  if (!m) return null;
  const drive = m[1].toUpperCase();
  try {
    if (!existsSync(`${drive}:\\`)) return null;
  } catch {
    return null;
  }
  return `${drive}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
}

/** Resolve a user/model supplied path against cwd. Never touches the filesystem except for the drive-exists probe. */
export function resolvePath(raw: string, cwd: string): string {
  let p = stripQuotes(String(raw ?? '').trim());
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, IS_WIN ? '' : '/'));
    } catch { /* keep as is */ }
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(homedir(), p.slice(1));
  const msys = fromMsysPath(p);
  if (msys) p = msys;
  let abs = path.resolve(cwd || process.cwd(), p);
  // Trim trailing separators (but keep roots like C:\ and /).
  const root = path.parse(abs).root;
  while (abs.length > root.length && /[\\/]$/.test(abs)) abs = abs.slice(0, -1);
  if (IS_WIN && /^[a-z]:/.test(abs)) abs = abs[0].toUpperCase() + abs.slice(1);
  return abs;
}

/** Forward-slash form used in all model-visible output (safe inside JSON; accepted by Windows APIs). */
export function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** cwd-relative when inside cwd, absolute otherwise; forward slashes. */
export function displayPath(abs: string, cwd: string): string {
  if (cwd && isInside(abs, cwd)) {
    const rel = path.relative(cwd, abs);
    return slash(rel === '' ? '.' : rel);
  }
  return slash(abs);
}

/** Canonical key for the readFiles map. */
export function fileKey(abs: string): string {
  return path.resolve(abs);
}

export function samePath(a: string, b: string): boolean {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}
