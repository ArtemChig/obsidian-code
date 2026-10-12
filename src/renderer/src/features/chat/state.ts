// Chat-local UI state (owner: ui-chat): composer drafts + attachments per session, last turn error per session,
// and a focus/insert channel used by the right panels ("click a file → insert @mention").
import { create } from 'zustand';
import type { ImageBlock } from '@shared/types';
import { rpc } from '@renderer/lib/rpc';

export interface ChatError {
  message: string;
  at: number;
}

export interface ChatLocalStore {
  /** Unsent composer text per session (survives switching sessions). */
  drafts: Record<string, string>;
  /** Pasted / dropped images per session. */
  attachments: Record<string, ImageBlock[]>;
  /** Last 'error' event per session (shown as a banner with Retry until the next turn starts). */
  errors: Record<string, ChatError>;
  /** Bumped to ask the composer of a session to focus (and move the caret to the end). */
  focusNonce: Record<string, number>;
}

export const useChatLocal = create<ChatLocalStore>(() => ({ drafts: {}, attachments: {}, errors: {}, focusNonce: {} }));

export function setDraft(sessionId: string, text: string): void {
  useChatLocal.setState((s) => (s.drafts[sessionId] === text ? s : { drafts: { ...s.drafts, [sessionId]: text } }));
}

export function setAttachments(sessionId: string, images: ImageBlock[]): void {
  useChatLocal.setState((s) => ({ attachments: { ...s.attachments, [sessionId]: images } }));
}

export function focusComposer(sessionId: string): void {
  useChatLocal.setState((s) => ({ focusNonce: { ...s.focusNonce, [sessionId]: (s.focusNonce[sessionId] ?? 0) + 1 } }));
}

/** Append text (e.g. an @mention) to a session's draft with sensible spacing, then focus the composer. */
export function insertIntoComposer(sessionId: string, text: string): void {
  const cur = useChatLocal.getState().drafts[sessionId] ?? '';
  const sep = cur === '' || /\s$/.test(cur) ? '' : ' ';
  setDraft(sessionId, `${cur}${sep}${text} `);
  focusComposer(sessionId);
}

export function clearError(sessionId: string): void {
  useChatLocal.setState((s) => {
    if (!s.errors[sessionId]) return s;
    const errors = { ...s.errors };
    delete errors[sessionId];
    return { errors };
  });
}

let bound = false;

/** Subscribe once to core events that feed this store (listeners survive reconnects and transport swaps). */
export function bindChatEvents(): void {
  if (bound) return;
  bound = true;
  rpc.on('error', (e) => {
    if (!e.sessionId) return;
    const id = e.sessionId;
    useChatLocal.setState((s) => ({ errors: { ...s.errors, [id]: { message: e.message, at: Date.now() } } }));
  });
  rpc.on('session.updated', (s) => {
    // A new turn started: the previous error is no longer current.
    if (s.status === 'running' && useChatLocal.getState().errors[s.id]) clearError(s.id);
  });
}
