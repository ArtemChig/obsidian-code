// Composer helpers: palette triggers, completions, permission-mode cycling. Owner: ui-chat. Pure (unit-tested).
import type { PermissionMode } from '@shared/types';

export type TriggerKind = 'slash' | 'mention';

export interface Trigger {
  kind: TriggerKind;
  /** Text typed after the trigger character, up to the caret. */
  query: string;
  /** Index of the trigger character ("/" or "@"). */
  start: number;
  /** End of the token (caret position, extended over the rest of a word under the caret). */
  end: number;
}

/**
 * Detect an active palette trigger at the caret.
 *  - slash: the message starts with "/" and the caret is still inside the first word ("/comp|").
 *  - mention: the word under the caret starts with "@" at the start of the text or after whitespace ("see @src/ap|").
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const c = Math.max(0, Math.min(caret, text.length));
  if (text.startsWith('/')) {
    const firstWs = text.search(/\s/);
    const firstEnd = firstWs < 0 ? text.length : firstWs;
    if (c >= 1 && c <= firstEnd) return { kind: 'slash', query: text.slice(1, c), start: 0, end: firstEnd };
  }
  // Walk back from the caret to the start of the current word.
  let s = c;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  if (text[s] === '@') {
    let e = c;
    while (e < text.length && !/\s/.test(text[e])) e++;
    const query = text.slice(s + 1, c);
    // "@" inside an email-like token never reaches here (s is the word start); avoid "@@".
    if (!query.includes('@')) return { kind: 'mention', query, start: s, end: e };
  }
  return null;
}

/** Replace the trigger token with `insert` (+ a trailing space). Returns the new text and caret. */
export function applyCompletion(text: string, t: Trigger, insert: string): { text: string; caret: number } {
  const before = text.slice(0, t.start);
  let after = text.slice(t.end);
  const needsSpace = !after.startsWith(' ');
  if (!needsSpace) after = after.slice(1);
  const next = `${before}${insert} ${after}`;
  return { text: next, caret: before.length + insert.length + 1 };
}

/** "@relative/path" for a files.search result (always forward slashes; quoted when it has spaces). */
export function mentionFor(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/**
 * Shift+Tab order: default → acceptEdits → plan → default. Bypass ("never ask") joins the cycle only when the user
 * opted into it (default permission mode = bypass in Settings); otherwise it is picked from the mode menu, with a
 * confirmation. From bypass, Shift+Tab goes back to default.
 */
export function nextPermissionMode(mode: PermissionMode, allowBypass = false): PermissionMode {
  const cycle = allowBypass ? PERMISSION_MODES : PERMISSION_MODES.filter((m) => m !== 'bypassPermissions');
  const i = cycle.indexOf(mode);
  return i < 0 ? 'default' : cycle[(i + 1) % cycle.length];
}

/** Slash command text for a palette pick: no-arg commands run on Enter, others wait for arguments. */
export function slashInsert(name: string): string {
  return `/${name}`;
}

/** Strip a data: URL prefix → { mediaType, data } (base64). */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

/** Longest side (px) images are downscaled to before they are attached to a message. */
export const MAX_IMAGE_SIDE = 1024;

/** Target size that fits `w`×`h` within `max` px on the long side, keeping the aspect ratio (never upscales). */
export function fitWithin(w: number, h: number, max = MAX_IMAGE_SIDE): { width: number; height: number; scaled: boolean } {
  if (!(w > 0) || !(h > 0)) return { width: Math.max(0, Math.round(w) || 0), height: Math.max(0, Math.round(h) || 0), scaled: false };
  const long = Math.max(w, h);
  if (long <= max) return { width: Math.round(w), height: Math.round(h), scaled: false };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: true };
}

/** Output format for a re-encoded image: PNG keeps transparency (png/gif/webp/bmp sources), JPEG for photos. */
export function reencodeType(sourceType: string): 'image/png' | 'image/jpeg' {
  return /^image\/jpe?g$/i.test(sourceType) ? 'image/jpeg' : 'image/png';
}

/** Approximate decoded size of a base64 payload. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}
