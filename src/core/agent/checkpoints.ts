// File checkpoints for rewind: dataDir/checkpoints/<sessionId>/<userMsgId>/{index.json, <n>.bin}
// The first change to a file during a user turn stores the file's original bytes (or that it did not exist).
// order.json keeps the turn order so "earliest checkpoint" survives truncated transcripts.

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface CheckpointEntry { path: string; existed: boolean; blob?: string }
interface TurnIndex { files: CheckpointEntry[] }

const WIN = process.platform === 'win32';
export function pathKey(p: string): string {
  const r = resolve(p);
  return WIN ? r.toLowerCase() : r;
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Write via a temp file + rename so a crash never leaves a truncated index/blob behind. */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (e) {
        // Windows: a virus scanner or indexer briefly holding the target makes rename fail with EPERM/EBUSY/EACCES
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export class CheckpointStore {
  private readonly cache = new Map<string, TurnIndex>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  private sessionDir(sessionId: string): string { return join(this.dataDir, 'checkpoints', safeName(sessionId)); }
  private turnDir(sessionId: string, turnId: string): string { return join(this.sessionDir(sessionId), safeName(turnId)); }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  private async readIndex(sessionId: string, turnId: string): Promise<TurnIndex> {
    const key = `${sessionId}/${turnId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let idx: TurnIndex = { files: [] };
    try { idx = JSON.parse(await fs.readFile(join(this.turnDir(sessionId, turnId), 'index.json'), 'utf8')) as TurnIndex; } catch { /* none */ }
    this.cache.set(key, idx);
    return idx;
  }

  async order(sessionId: string): Promise<string[]> {
    try { return JSON.parse(await fs.readFile(join(this.sessionDir(sessionId), 'order.json'), 'utf8')) as string[]; } catch { return []; }
  }

  private async addToOrder(sessionId: string, turnId: string): Promise<void> {
    const order = await this.order(sessionId);
    if (order.includes(turnId)) return;
    order.push(turnId);
    await fs.mkdir(this.sessionDir(sessionId), { recursive: true });
    await fs.writeFile(join(this.sessionDir(sessionId), 'order.json'), JSON.stringify(order));
  }

  /** Save the original content of absPath for this turn (no-op if already saved in this turn). */
  async checkpoint(sessionId: string, turnId: string, absPath: string): Promise<void> {
    await this.withLock(`${sessionId}`, async () => {
      const idx = await this.readIndex(sessionId, turnId);
      const key = pathKey(absPath);
      if (idx.files.some((f) => pathKey(f.path) === key)) return;
      const dir = this.turnDir(sessionId, turnId);
      await fs.mkdir(dir, { recursive: true });
      let entry: CheckpointEntry;
      let data: Buffer | null;
      try {
        data = await fs.readFile(absPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EISDIR') return;
        // Only a missing file may be recorded as "did not exist" (rewind deletes such files). Any other failure
        // (locked/busy file, EPERM, EMFILE, too large…) must stop the edit: there would be no backup to restore.
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new Error(`Could not save a rewind checkpoint of ${absPath} (${code ?? errText(e)}); the file was not changed.`);
        data = null;
      }
      if (data) {
        const blob = `${idx.files.length}.bin`;
        try {
          await writeAtomic(join(dir, blob), data);
        } catch (e) {
          throw new Error(`Could not save a rewind checkpoint of ${absPath} (${(e as NodeJS.ErrnoException).code ?? errText(e)}); the file was not changed.`);
        }
        entry = { path: resolve(absPath), existed: true, blob };
      } else {
        entry = { path: resolve(absPath), existed: false };
      }
      const next: TurnIndex = { files: [...idx.files, entry] };
      await writeAtomic(join(dir, 'index.json'), JSON.stringify(next));
      idx.files = next.files; // the cached index only changes once the new one is on disk
      await this.addToOrder(sessionId, turnId);
    });
  }

  /** Earliest recorded original state of a file in this session (across all turns), or null. */
  async original(sessionId: string, absPath: string): Promise<{ existed: boolean; content: Buffer } | null> {
    const key = pathKey(absPath);
    for (const turnId of await this.order(sessionId)) {
      const idx = await this.readIndex(sessionId, turnId);
      const f = idx.files.find((x) => pathKey(x.path) === key);
      if (f) {
        if (!f.existed || !f.blob) return { existed: false, content: Buffer.alloc(0) };
        try { return { existed: true, content: await fs.readFile(join(this.turnDir(sessionId, turnId), f.blob)) }; } catch { return null; }
      }
    }
    return null;
  }

  /** Files touched in the given turns. */
  async filesIn(sessionId: string, turnIds: string[]): Promise<string[]> {
    const seen = new Map<string, string>();
    for (const t of turnIds) for (const f of (await this.readIndex(sessionId, t)).files) if (!seen.has(pathKey(f.path))) seen.set(pathKey(f.path), f.path);
    return [...seen.values()];
  }

  /**
   * Restore every file changed in `turnIds` to its state before the earliest of those turns.
   * Files that did not exist then are deleted. Returns the restored paths.
   */
  async restore(sessionId: string, turnIds: string[]): Promise<string[]> {
    const wanted = new Set(turnIds);
    const order = (await this.order(sessionId)).filter((t) => wanted.has(t));
    const firstState = new Map<string, { entry: CheckpointEntry; turnId: string }>();
    for (const t of order) {
      for (const f of (await this.readIndex(sessionId, t)).files) {
        const k = pathKey(f.path);
        if (!firstState.has(k)) firstState.set(k, { entry: f, turnId: t });
      }
    }
    const restored: string[] = [];
    for (const { entry, turnId } of firstState.values()) {
      try {
        if (entry.existed && entry.blob) {
          const data = await fs.readFile(join(this.turnDir(sessionId, turnId), entry.blob));
          await fs.mkdir(dirname(entry.path), { recursive: true });
          await fs.writeFile(entry.path, data);
        } else {
          await fs.rm(entry.path, { force: true });
        }
        restored.push(entry.path);
      } catch { /* best effort per file */ }
    }
    return restored;
  }

  /** Forget the given turns (after a restore). */
  async drop(sessionId: string, turnIds: string[]): Promise<void> {
    const order = await this.order(sessionId);
    for (const t of turnIds) {
      this.cache.delete(`${sessionId}/${t}`);
      await fs.rm(this.turnDir(sessionId, t), { recursive: true, force: true }).catch(() => {});
    }
    const rest = order.filter((t) => !turnIds.includes(t));
    try {
      await fs.mkdir(this.sessionDir(sessionId), { recursive: true });
      await fs.writeFile(join(this.sessionDir(sessionId), 'order.json'), JSON.stringify(rest));
    } catch { /* ignore */ }
  }
}
