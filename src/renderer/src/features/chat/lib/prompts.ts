// Pure helpers for the inline prompt cards. Owner: ui-chat (unit-tested).
import type { Block, Question, ToolUseBlock } from '@shared/types';

/** Selection state of one question in the QuestionCard. */
export interface QState {
  picked: string[];
  otherOn: boolean;
  other: string;
}

/** Answer text for one question: picked labels in option order, plus the free text. Empty string = unanswered. */
export function answerFor(q: Question, s: QState): string {
  const labels = q.options.map((o) => o.label).filter((l) => s.picked.includes(l));
  const other = s.otherOn ? s.other.trim() : '';
  return [...labels, ...(other ? [other] : [])].join(', ');
}

export type PreviewItem = { kind: 'text'; key: string; text: string } | { kind: 'tool'; key: string; tool: ToolUseBlock };

/** Last few visible steps of a (child) session: assistant text + tool calls, oldest first. */
export function previewItems(messages: { id: string; role: string; blocks: Block[] }[], limit = 4): PreviewItem[] {
  const out: PreviewItem[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    m.blocks.forEach((b, i) => {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'text', key: `${m.id}:${i}`, text: b.text.trim() });
      if (b.type === 'tool_use') out.push({ kind: 'tool', key: b.id, tool: b });
    });
  }
  return out.slice(-limit);
}

// ───────────────────────────── Prompt-card keyboard routing ─────────────────────────────

/**
 * May a key press drive the front-most prompt card (1/2/3, Enter, Esc)?
 * Never while focus is in a text field — not even an empty composer: a follow-up such as "1. also…" or an Esc meant
 * for the field must not silently allow, deny or "always allow" a tool call. Inside the card, its own inputs handle
 * their keys. Anything else (the card itself, a button, the page body) routes to the card.
 */
export function promptKeyRoutes(target: { editable: boolean; inCard: boolean }): boolean {
  return !target.editable;
}

/** What has focus when a prompt card becomes the active one. */
export type FocusHolder = 'none' | 'composer-empty' | 'composer-draft' | 'editable' | 'other';

/** Typing in the last this-many ms keeps focus where it is (a keystroke in flight must not land on the card). */
export const PROMPT_FOCUS_IDLE_MS = 1500;

/**
 * Should a newly active prompt card take keyboard focus (so 1/2/3 and Esc answer it)? Only when nothing else is being
 * typed into: no focus at all, or an empty composer the user has not typed in for a moment.
 */
export function promptTakesFocus(holder: FocusHolder, msSinceTyping: number): boolean {
  if (holder === 'none') return true;
  if (holder === 'composer-empty') return msSinceTyping >= PROMPT_FOCUS_IDLE_MS;
  return false; // a draft, another field, or a control the user is on: keys from a non-field still reach the card

}
