// SessionStore (owner: platform): one JSON file per session in <dataDir>/sessions/<id>.json.
//
// * In-memory index of summaries (built at startup by reading every file once).
// * Full sessions are loaded lazily on get() and then kept as LIVE objects for the rest of the process: every caller
//   (agent, server, scheduler) shares the same object, mutates it and calls save(). Never clone-and-replace.
// * Writes are debounced per session (~300 ms) and atomic (tmp + rename); writes of one session are serialized.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, Session, SessionSummary } from '../../shared/types';
import type { SessionStore } from '../contracts';
import { readJsonSync, writeFileAtomic } from './fsutil';

export const SESSION_WRITE_DEBOUNCE_MS = 300;
const MAX_SEARCH_TEXT = 200_000;
const MAX_SEARCH_RESULTS = 50;

export interface SessionStoreImpl extends SessionStore {
  /** Directory holding <id>.json files. */
  readonly dir: string;
  /** Number of pending (debounced, not yet written) sessions. */
  pendingWrites(): number;
}

export function toSummary(s: Session | SessionSummary): SessionSummary {
  const summary: SessionSummary = {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    kind: s.kind,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    status: s.status,
    model: s.model,
    permissionMode: s.permissionMode,
    thinking: s.thinking,
    usage: { ...s.usage },
  };
  if (s.parentSessionId !== undefined) summary.parentSessionId = s.parentSessionId;
  if (s.parentToolUseId !== undefined) summary.parentToolUseId = s.parentToolUseId;
  if (s.scheduleId !== undefined) summary.scheduleId = s.scheduleId;
  if (s.pinned !== undefined) summary.pinned = s.pinned;
  if (s.engine !== undefined) summary.engine = s.engine;
  return summary;
}

function messageText(m: Message): string {
  const parts: string[] = [];
  for (const b of m.blocks ?? []) {
    if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n');
}

function buildSearchText(s: Session): string {
  let out = '';
  for (const m of s.messages ?? []) {
    if (m.role === 'system') continue;
    const t = messageText(m);
    if (!t) continue;
    out += (out ? '\n' : '') + t;
    if (out.length >= MAX_SEARCH_TEXT) return out.slice(0, MAX_SEARCH_TEXT);
  }
  return out;
}

function snippetAround(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 80);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s;
}

/** Fill in missing fields of a session read from disk (older/partial files). */
function normalize(raw: Partial<Session> & { id: string }): Session {
  const now = Date.now();
  return {
    title: 'New session',
    cwd: '',
    kind: 'chat',
    createdAt: now,
    updatedAt: raw.createdAt ?? now,
    model: null,
    permissionMode: 'default',
    thinking: true,
    ...raw,
    status: raw.status === 'running' || raw.status === 'waiting' ? 'idle' : (raw.status ?? 'idle'),
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0, ...(raw.usage ?? {}) },
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    todos: Array.isArray(raw.todos) ? raw.todos : [],
    changedFiles: Array.isArray(raw.changedFiles) ? raw.changedFiles : [],
  };
}

export function createSessionStore(dataDir: string): SessionStoreImpl {
  const dir = join(dataDir, 'sessions');
  mkdirSync(dir, { recursive: true });

  const index = new Map<string, SessionSummary>();
  const live = new Map<string, Session>();
  const searchText = new Map<string, string>();
  const searchDirty = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const writeChains = new Map<string, Promise<void>>();
  const deleted = new Set<string>();

  const fileOf = (id: string): string => join(dir, `${id}.json`);

  // ── load index
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const raw = readJsonSync<Partial<Session>>(join(dir, name));
    if (!raw || typeof raw !== 'object') continue;
    const session = normalize({ ...raw, id });
    index.set(id, toSummary(session));
    searchText.set(id, buildSearchText(session));
  }

  const writeNow = (id: string): Promise<void> => {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    const prev = writeChains.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (deleted.has(id)) return;
        const s = live.get(id);
        if (!s) return;
        await writeFileAtomic(fileOf(id), JSON.stringify(s));
      })
      .catch((err: unknown) => {
        console.error(`[sessions] failed to write ${id}:`, err instanceof Error ? err.message : err);
      });
    writeChains.set(id, next);
    void next.finally(() => {
      if (writeChains.get(id) === next) writeChains.delete(id);
    });
    return next;
  };

  const scheduleWrite = (id: string): void => {
    if (timers.has(id)) return;
    const t = setTimeout(() => {
      timers.delete(id);
      void writeNow(id);
    }, SESSION_WRITE_DEBOUNCE_MS);
    timers.set(id, t);
  };

  const ensureSearchText = (id: string): string => {
    if (searchDirty.has(id)) {
      const s = live.get(id);
      if (s) searchText.set(id, buildSearchText(s));
      searchDirty.delete(id);
    }
    return searchText.get(id) ?? '';
  };

  const store: SessionStoreImpl = {
    dir,
    list(opts) {
      const out: SessionSummary[] = [];
      for (const [id, summary] of index) {
        const s = live.get(id);
        const sum = s ? toSummary(s) : summary;
        if (!opts?.includeSubagents && sum.kind === 'subagent') continue;
        out.push(sum);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get(id) {
      const cached = live.get(id);
      if (cached) return cached;
      if (!index.has(id) || deleted.has(id)) return undefined;
      const raw = readJsonSync<Partial<Session>>(fileOf(id));
      if (!raw) return undefined;
      const session = normalize({ ...raw, id });
      live.set(id, session);
      return session;
    },

    create(init) {
      const now = Date.now();
      const id = init.id && !index.has(init.id) ? init.id : randomUUID();
      const session: Session = {
        title: 'New session',
        kind: 'chat',
        status: 'idle',
        model: null,
        permissionMode: 'default',
        thinking: true,
        ...init,
        id,
        createdAt: init.createdAt ?? now,
        updatedAt: init.updatedAt ?? now,
        usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0, ...(init.usage ?? {}) },
        messages: [],
        todos: [],
        changedFiles: [],
      };
      deleted.delete(id);
      live.set(id, session);
      index.set(id, toSummary(session));
      searchText.set(id, '');
      scheduleWrite(id);
      return session;
    },

    save(session) {
      if (deleted.has(session.id)) return;
      live.set(session.id, session);
      index.set(session.id, toSummary(session));
      searchDirty.add(session.id);
      scheduleWrite(session.id);
    },

    delete(id) {
      deleted.add(id);
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.delete(id);
      live.delete(id);
      index.delete(id);
      searchText.delete(id);
      searchDirty.delete(id);
      const chain = writeChains.get(id) ?? Promise.resolve();
      void chain.finally(() => {
        try {
          rmSync(fileOf(id), { force: true });
        } catch (err) {
          console.error(`[sessions] failed to delete ${id}:`, err instanceof Error ? err.message : err);
        }
        try {
          rmSync(join(dataDir, 'checkpoints', id), { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      });
    },

    search(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const titleHits: { sessionId: string; title: string; snippet: string; updatedAt: number }[] = [];
      const textHits: typeof titleHits = [];
      for (const [id, sum0] of index) {
        const sum = live.get(id) ?? sum0;
        if (sum.kind === 'subagent') continue;
        const title = sum.title ?? '';
        const text = ensureSearchText(id);
        const tIdx = title.toLowerCase().indexOf(q);
        const mIdx = text.toLowerCase().indexOf(q);
        if (tIdx < 0 && mIdx < 0) continue;
        const snippet = mIdx >= 0 ? snippetAround(text, mIdx, q.length) : title;
        (tIdx >= 0 ? titleHits : textHits).push({ sessionId: id, title, snippet, updatedAt: sum.updatedAt });
      }
      const byRecent = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt;
      return [...titleHits.sort(byRecent), ...textHits.sort(byRecent)]
        .slice(0, MAX_SEARCH_RESULTS)
        .map(({ sessionId, title, snippet }) => ({ sessionId, title, snippet }));
    },

    async flush() {
      const ids = new Set<string>([...timers.keys()]);
      await Promise.all([...ids].map((id) => writeNow(id)));
      await Promise.all([...writeChains.values()]);
    },

    pendingWrites() {
      return timers.size;
    },
  };
  return store;
}
