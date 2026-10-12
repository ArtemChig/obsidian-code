// Pure session helpers for the chat view. Owner: ui-chat (unit-tested).
import type { Message, SessionSummary } from '@shared/types';

/**
 * May this session be deleted when the user moves to another folder (it is replaced by a new session there)?
 * Only when it is provably empty: its transcript is loaded and has no messages, it never made a model request, has
 * nothing queued and is not running. A transcript that is still loading (or failed to load) counts as NOT empty —
 * a long history must never be deleted because it was not on screen yet.
 */
export function isDisposableSession(session: SessionSummary, messages: Message[] | undefined, queuedCount: number): boolean {
  if (!messages) return false;
  if (messages.length > 0 || queuedCount > 0) return false;
  if (session.usage.requests > 0) return false;
  return session.status === 'idle';
}

/** Absolute form of a tool/changed-file path (absolute already, or relative to the session folder). */
export function absolutePath(path: string, cwd: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(path)) return path;
  const sep = cwd.includes('\\') || /^[a-zA-Z]:/.test(cwd) ? '\\' : '/';
  const rel = path.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${rel}`;
}

/** Messages rendered before "Show earlier" kicks in. */
export const TRANSCRIPT_WINDOW = 120;
/** How many more each "Show earlier" click reveals (all at once would mount hundreds of markdown/shiki blocks). */
export const REVEAL_STEP = 100;

/** Index of the first rendered message, given how many extra older messages were revealed. */
export function windowStart(total: number, revealed: number): number {
  return Math.max(0, total - TRANSCRIPT_WINDOW - revealed);
}
