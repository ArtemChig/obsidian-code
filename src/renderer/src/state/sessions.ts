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
