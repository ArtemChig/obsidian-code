// Git branch detection for the chat header: reads <dir>/.git/HEAD through files.read, walking up a few parents.
// Owner: ui-chat. parseGitHead/candidateDirs are pure (unit-tested).
import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/rpc';

/** "ref: refs/heads/main" → "main"; a detached sha → its first 7 chars; anything else → null. */
export function parseGitHead(content: string): string | null {
  const t = content.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(t);
  if (ref) return ref[1].trim();
  if (/^[0-9a-f]{40}$/i.test(t)) return t.slice(0, 7);
  return null;
}

/** ".git" file of a worktree/submodule: "gitdir: ../.git/worktrees/x" → that path (absolute or relative to dir). */
export function parseGitDirFile(content: string): string | null {
  const m = /^gitdir:\s*(.+)$/m.exec(content.trim());
  return m ? m[1].trim() : null;
}

/** cwd and up to `levels` parents (Windows or POSIX separators). */
export function candidateDirs(cwd: string, levels = 4): string[] {
  const sep = cwd.includes('\\') ? '\\' : '/';
  const out: string[] = [];
  let cur = cwd.replace(/[\\/]+$/, '');
  for (let i = 0; i <= levels && cur; i++) {
    out.push(cur);
    const idx = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
    if (idx <= 0) break;
    const parent = cur.slice(0, idx);
    if (/^[A-Za-z]:$/.test(parent)) {
      out.push(parent + sep);
      break;
    }
    cur = parent;
  }
  return out;
}

function join(dir: string, ...parts: string[]): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return [dir.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

/** Branch per cwd. Misses (no repo, or the core was not reachable) expire after a minute. */
const cache = new Map<string, { p: Promise<string | null>; at: number }>();
const MISS_TTL = 60_000;

async function tryRead(path: string): Promise<string | null> {
  try {
    const r = await rpc.request('files.read', { path, maxBytes: 4096 }, { timeoutMs: 5000 });
    return r.content;
  } catch {
    return null;
  }
}

async function detect(cwd: string): Promise<string | null> {
  for (const dir of candidateDirs(cwd)) {
    const head = await tryRead(join(dir, '.git', 'HEAD'));
    if (head !== null) {
      const branch = parseGitHead(head);
      if (branch) return branch;
    }
    const gitFile = await tryRead(join(dir, '.git'));
    const gitdir = gitFile ? parseGitDirFile(gitFile) : null;
    if (gitdir) {
      const abs = /^([A-Za-z]:[\\/]|\/)/.test(gitdir) ? gitdir : join(dir, gitdir);
      const h = await tryRead(join(abs, 'HEAD'));
      const branch = h ? parseGitHead(h) : null;
      if (branch) return branch;
    }
  }
  return null;
}

/** Current git branch for a folder (cached per cwd for the app lifetime; refreshed when `nonce` changes). */
export function useGitBranch(cwd: string | undefined, nonce = 0): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd) {
      setBranch(null);
      return;
    }
    let alive = true;
    const key = `${cwd}#${nonce}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = { p: detect(cwd), at: Date.now() };
      cache.set(key, hit);
    }
    const entry = hit;
    void entry.p.then((b) => {
      if (b === null && Date.now() - entry.at > MISS_TTL) cache.delete(key);
      if (alive) setBranch(b);
    });
    return () => {
      alive = false;
    };
  }, [cwd, nonce]);
  return branch;
}
