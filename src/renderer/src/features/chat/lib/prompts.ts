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
