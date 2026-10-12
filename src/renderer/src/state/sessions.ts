// Sessions store: summaries (incl. subagents), active session, loaded transcripts, unread + queued markers.
// Owner: ui-foundation. Mutated only through state/sync.ts (events) and state/actions.ts.
import { create } from 'zustand';
import type { SessionSummary } from '@shared/types';
import type { TranscriptEntry } from './transcript';

export interface QueuedMessage {
  messageId: string;
  text: string;
  at: number;
}

export interface SessionsStore {
  /** Every known session summary keyed by id (chat, scheduled and subagent sessions). */
  sessions: Record<string, SessionSummary>;
  /** True once sessions.list returned. */
  loaded: boolean;
  activeSessionId: string | null;
  /** Loaded transcripts keyed by session id. */
  transcripts: Record<string, TranscriptEntry>;
  /** Session ids currently being fetched via sessions.get. */
  loading: Record<string, boolean>;
  /** Last sessions.get error per session. */
  loadErrors: Record<string, string>;
  /** Sessions with activity the user has not seen. */
  unread: Record<string, true>;
  /** Messages sent while the session was running (chat.send → queued:true), until their message.added arrives. */
  queued: Record<string, QueuedMessage[]>;
}

export const useSessions = create<SessionsStore>(() => ({
  sessions: {},
  loaded: false,
  activeSessionId: null,
  transcripts: {},
  loading: {},
  loadErrors: {},
  unread: {},
  queued: {},
}));

/**
 * Pure: which queued chips are still real. A chip disappears once its message is in the transcript, and all of a
 * session's chips go once the session is idle (the core drains its queue before going idle; builtins such as /clear
 * never add their message, and a restarted core has no queue at all).
 */
export function reconcileQueued(queue: QueuedMessage[] | undefined, messageIds: ReadonlySet<string>, busy: boolean): QueuedMessage[] {
  if (!queue?.length || !busy) return [];
  return queue.filter((q) => !messageIds.has(q.messageId));
}

/** Replace a session's queued chips (no-op when unchanged). */
export function setQueued(sessionId: string, next: QueuedMessage[]): void {
  useSessions.setState((st) => {
    const prev = st.queued[sessionId] ?? [];
    if (prev.length === next.length && prev.every((q, i) => q === next[i])) return st;
    const queued = { ...st.queued };
    if (next.length) queued[sessionId] = next;
    else delete queued[sessionId];
    return { queued };
  });
}
