// Read-before-write tracking on top of ToolContext.readFiles (path → mtimeMs at read time).
// A side table (keyed by the readFiles Map instance) remembers a content hash so that a file whose mtime
// changed but whose content did not (sync clients, antivirus, `touch`) is not reported as modified.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ToolContext } from '../../contracts';
import { fileKey } from './paths';

const hashes = new WeakMap<Map<string, number>, Map<string, string>>();

export function hashBuffer(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function table(ctx: Pick<ToolContext, 'readFiles'>): Map<string, string> {
  let t = hashes.get(ctx.readFiles);
  if (!t) {
    t = new Map();
    hashes.set(ctx.readFiles, t);
  }
  return t;
}

function findKey(ctx: Pick<ToolContext, 'readFiles'>, abs: string): string | undefined {
  const key = fileKey(abs);
  if (ctx.readFiles.has(key)) return key;
  if (ctx.readFiles.has(abs)) return abs;
  if (process.platform === 'win32') {
    const lower = key.toLowerCase();
    for (const k of ctx.readFiles.keys()) if (k.toLowerCase() === lower) return k;
  }
  return undefined;
}

export function wasRead(ctx: Pick<ToolContext, 'readFiles'>, abs: string): boolean {
  return findKey(ctx, abs) !== undefined;
}

/** Record that the model has seen the current content of a file (contentHash = hashBuffer of its bytes). */
export function markRead(ctx: Pick<ToolContext, 'readFiles'>, abs: string, mtimeMs: number, contentHash?: string): void {
  const existing = findKey(ctx, abs);
  const key = existing ?? fileKey(abs);
  ctx.readFiles.set(key, mtimeMs);
  const t = table(ctx);
  if (contentHash !== undefined) t.set(key, contentHash);
  else t.delete(key);
}

export type FreshnessResult = { ok: true } | { ok: false; error: string };

/** Verify the model read this file and that it has not changed on disk since. `currentHash` = hashBuffer() of the file's current bytes. */
export async function checkFresh(ctx: Pick<ToolContext, 'readFiles'>, abs: string, displayName: string, currentMtimeMs: number, currentHash?: string): Promise<FreshnessResult> {
  const key = findKey(ctx, abs);
  if (key === undefined) {
    return { ok: false, error: `File has not been read yet. Use the Read tool on ${displayName} first, then retry.` };
  }
  const readMtime = ctx.readFiles.get(key) ?? 0;
  if (currentMtimeMs > readMtime + 1) {
    const known = table(ctx).get(key);
    if (known !== undefined) {
      try {
        const h = currentHash ?? hashBuffer(await fs.readFile(abs));
        if (h === known) return { ok: true };
      } catch { /* fall through */ }
    }
    return { ok: false, error: `File ${displayName} has been modified since it was last read (by the user, a linter or another command). Read it again before editing.` };
  }
  return { ok: true };
}
