// Validation for the renderer's openPath / showItemInFolder IPC (owner: platform). Pure (node:fs/path only) so it is
// unit-testable without Electron. The renderer only needs these for the memory file and session folders, so a renderer
// bug must never be able to launch a program (.exe/.bat/.lnk… by file association) or reach a network share (UNC paths
// make Windows send NTLM credentials to the host).

import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

/** Document types the OS may open with their default app; everything else is only revealed in Explorer. */
const OPENABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.log', '.yaml', '.yml', '.toml', '.csv']);

function localAbsolute(p: string): string | null {
  if (!p || p.includes('\0')) return 'Invalid path';
  if (/^[\\/][\\/]/.test(p)) return 'Network and device paths are not allowed';
  const winAbs = /^[a-zA-Z]:[\\/]/.test(p);
  if (!winAbs && !(process.platform !== 'win32' && isAbsolute(p))) return 'Path must be absolute';
  return null;
}

/** Error message, or null when `p` may be revealed in the file manager. */
export function checkRevealPath(p: unknown): string | null {
  if (typeof p !== 'string') return 'Invalid path';
  return localAbsolute(p);
}

/** Error message, or null when `p` may be opened with the OS default app (a folder or a plain document). */
export function checkOpenPath(p: unknown): string | null {
  if (typeof p !== 'string') return 'Invalid path';
  const bad = localAbsolute(p);
  if (bad) return bad;
  let real: string;
  try {
    real = realpathSync.native(p);
  } catch {
    return 'File not found';
  }
  if (/^[\\/][\\/]/.test(real) && !/^\\\\\?\\[a-zA-Z]:/.test(real)) return 'Network and device paths are not allowed';
  try {
    if (statSync(real).isDirectory()) return null;
  } catch {
    return 'File not found';
  }
  const ok = (x: string): boolean => OPENABLE_EXTENSIONS.has(extname(x).toLowerCase());
  return ok(p) && ok(real) ? null : 'Opening this type of file is blocked; use "Show in folder" instead';
}
