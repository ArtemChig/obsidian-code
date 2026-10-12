// ui-chat: question answers and the subagent mini-transcript preview.
import { describe, expect, it } from 'vitest';
import type { Message, Question } from '@shared/types';
import { answerFor, previewItems, PROMPT_FOCUS_IDLE_MS, promptKeyRoutes, promptTakesFocus } from '@renderer/features/chat/lib/prompts';

type Item = { kind: 'text'; key: string; text: string } | { kind: 'tool'; key: string; tool: { id: string } };

const single: Question = {
  question: 'Which approach?',
  header: 'Approach',
  multiSelect: false,
  options: [
    { label: 'Minimal', description: '' },
    { label: 'Refactor', description: '' },
  ],
};
const multi: Question = { ...single, question: 'Which files?', multiSelect: true, options: [{ label: 'a.ts', description: '' }, { label: 'b.ts', description: '' }, { label: 'c.ts', description: '' }] };

describe('answerFor', () => {
  it('is empty until something is picked', () => {
    expect(answerFor(single, { picked: [], otherOn: false, other: '' })).toBe('');
    expect(answerFor(single, { picked: [], otherOn: true, other: '   ' })).toBe('');
  });

  it('uses option order for multi-select and appends the free text', () => {
    expect(answerFor(multi, { picked: ['c.ts', 'a.ts'], otherOn: false, other: 'ignored' })).toBe('a.ts, c.ts');
    expect(answerFor(multi, { picked: ['b.ts'], otherOn: true, other: 'tests too' })).toBe('b.ts, tests too');
  });

  it('single select with Other uses only the free text', () => {
    expect(answerFor(single, { picked: [], otherOn: true, other: 'Something else' })).toBe('Something else');
  });
});

describe('previewItems', () => {
  const messages: Message[] = [
    { id: 'u', role: 'user', createdAt: 0, blocks: [{ type: 'text', text: 'prompt' }] },
    {
      id: 'a',
      role: 'assistant',
      createdAt: 1,
      blocks: [
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'Looking…' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: {}, status: 'done' },
        { type: 'text', text: '   ' },
        { type: 'tool_use', id: 't2', name: 'Read', input: {}, status: 'running' },
        { type: 'text', text: 'Found it.' },
      ],
    },
  ];

  it('keeps assistant text and tools in order, skipping thinking, blanks and user turns', () => {
    const items = previewItems(messages, 10);
    expect(items.map((i: Item) => (i.kind === 'text' ? i.text : i.tool.id))).toEqual(['Looking…', 't1', 't2', 'Found it.']);
  });

  it('returns only the last N steps', () => {
    expect(previewItems(messages, 2).map((i: Item) => i.key)).toEqual(['t2', 'a:5']);
  });
});

describe('prompt-card keyboard routing', () => {
  it('never routes keys typed into a text field (an empty composer included) to the card', () => {
    // "1. also…" typed into the empty composer must not "Allow once"; "2" must not save an allow rule; Esc must not deny.
    expect(promptKeyRoutes({ editable: true, inCard: false })).toBe(false);
    // The card's own inputs (feedback, "Other") handle their keys themselves.
    expect(promptKeyRoutes({ editable: true, inCard: true })).toBe(false);
    // Focus on the card itself, a button or the page body routes to the card.
    expect(promptKeyRoutes({ editable: false, inCard: true })).toBe(true);
    expect(promptKeyRoutes({ editable: false, inCard: false })).toBe(true);
  });

  it('a new card takes focus only when nothing is being typed', () => {
    expect(promptTakesFocus('none', 0)).toBe(true);
    expect(promptTakesFocus('composer-empty', PROMPT_FOCUS_IDLE_MS + 1)).toBe(true);
    expect(promptTakesFocus('composer-empty', 200)).toBe(false); // a keystroke in flight stays in the composer
    expect(promptTakesFocus('composer-draft', 60_000)).toBe(false);
    expect(promptTakesFocus('editable', 60_000)).toBe(false);
    expect(promptTakesFocus('other', 60_000)).toBe(false);
  });
});
