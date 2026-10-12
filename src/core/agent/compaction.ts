// Context compaction planning + summarisation prompt (SPEC §4.1 "Context").
// The old messages stay in the transcript for the user; a compact_summary message is inserted where the kept part
// begins, and history sent to the model starts at the last compact_summary (see history.ts).

import type { Message, ToolUseBlock } from '../../shared/types';
import { historyStart } from './history';

export interface CompactionPlan {
  /** Messages [from, to) are summarised. */
  from: number;
  to: number;
  /** The summary message is inserted at this index (== to). */
  insertAt: number;
  /** Single-turn mode: the current request must be repeated inside the summary. */
  currentRequest?: string;
}

export function isRealUserMessage(m: Message): boolean {
  return m.role === 'user' && m.tag !== 'hook' && m.tag !== 'command';
}

function textOf(m: Message): string {
  return m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
}

/** Decide what to summarise. Keeps the last 2 user turns; falls back to fewer when the history is short. */
export function planCompaction(messages: Message[]): CompactionPlan | null {
  const base = historyStart(messages);
  const idx: number[] = [];
  for (let i = base; i < messages.length; i++) if (isRealUserMessage(messages[i]!)) idx.push(i);
  const meaningful = (from: number, to: number) => messages.slice(from, to).some((m) => m.tag !== 'command' && (m.role === 'assistant' || isRealUserMessage(m)));
  if (idx.length >= 3) {
    const keepFrom = idx[idx.length - 2]!;
    if (meaningful(base, keepFrom)) return { from: base, to: keepFrom, insertAt: keepFrom };
  }
  if (idx.length === 2) {
    const keepFrom = idx[1]!;
    if (meaningful(base, keepFrom) && messages.slice(base, keepFrom).some((m) => m.role === 'assistant')) return { from: base, to: keepFrom, insertAt: keepFrom };
  }
  // single (long) turn: keep the last 2 assistant steps, summarise the rest and restate the request
  const lastUser = idx[idx.length - 1];
  const assistantIdx: number[] = [];
  for (let i = (lastUser ?? base); i < messages.length; i++) if (messages[i]!.role === 'assistant' && messages[i]!.tag !== 'command') assistantIdx.push(i);
  if (assistantIdx.length > 2) {
    const insertAt = assistantIdx[assistantIdx.length - 2]!;
    return { from: base, to: insertAt, insertAt, currentRequest: currentRequestText(messages, base, lastUser) };
  }
  return null;
}

const REQUEST_RE = /\nThe user's current request \(verbatim\):\n([\s\S]*?)\n\nContinue the task from where it left off\.\s*$/;

/**
 * The request a single long turn is working on. After a first single-turn compaction the summary sits *after* that
 * request, so it is no longer inside the history window: look further back in the transcript (old messages stay there),
 * and fall back to the request restated by the previous summary.
 */
function currentRequestText(messages: Message[], base: number, lastUser: number | undefined): string {
  if (lastUser !== undefined) return textOf(messages[lastUser]!);
  for (let i = base - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isRealUserMessage(m) && m.tag !== 'compact_summary') return textOf(m);
  }
  const prev = messages[base];
  if (prev?.tag === 'compact_summary') {
    const m = REQUEST_RE.exec(textOf(prev));
    if (m) return m[1]!;
  }
  return '';
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.floor(n * 0.7))}\n…[${s.length - n} chars omitted]…\n${s.slice(-Math.floor(n * 0.3))}` : s;
}

/** Render messages as a plain-text transcript for the summariser, capped at maxChars. */
export function renderTranscript(messages: Message[], maxChars: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.tag === 'command') continue;
    if (m.tag === 'compact_summary') { parts.push(`[Earlier summary]\n${textOf(m)}`); continue; }
    if (m.role === 'user') {
      const t = textOf(m);
      const imgs = m.blocks.filter((b) => b.type === 'image').length;
      parts.push(`${m.tag === 'hook' ? '[App note]' : 'USER'}: ${clip(t, 4000)}${imgs ? ` [${imgs} image(s)]` : ''}`);
    } else if (m.role === 'assistant') {
      const t = textOf(m);
      if (t) parts.push(`ASSISTANT: ${clip(t, 3000)}`);
      for (const b of m.blocks) {
        if (b.type !== 'tool_use') continue;
        const tb = b as ToolUseBlock;
        let input = '';
        try { input = JSON.stringify(tb.input); } catch { input = '{}'; }
        parts.push(`TOOL CALL ${tb.name} ${clip(input, 600)}`);
        const res = tb.result?.content ?? tb.status;
        parts.push(`TOOL RESULT (${tb.status}): ${clip(res, 1500)}`);
      }
    }
  }
  const all = parts.join('\n\n');
  if (all.length <= maxChars) return all;
  // keep the start (goals) and the most recent part
  const head = Math.floor(maxChars * 0.3);
  return `${all.slice(0, head)}\n\n…[middle of the conversation omitted]…\n\n${all.slice(all.length - (maxChars - head))}`;
}

export const SUMMARY_SYSTEM = 'You compress coding-agent conversations into a precise working summary for the agent to continue from. Output only the summary in Markdown.';

export function summaryPrompt(transcript: string, instructions?: string): string {
  return [
    'Summarise the conversation below so the work can continue without it. Include:',
    '1. The user\'s requests and goals (verbatim where it matters) and any constraints or preferences.',
    '2. Key decisions and findings.',
    '3. Files read, created or changed (paths) and important code details.',
    '4. Commands run and their outcomes; errors and how they were fixed.',
    '5. Current state and the pending next steps.',
    'Be concise but complete; use short bullet points.',
    instructions?.trim() ? `\nAdditional instructions from the user: ${instructions.trim()}` : '',
    '\n<conversation>\n' + transcript + '\n</conversation>',
  ].filter(Boolean).join('\n');
}

export function summaryMessageText(summary: string, currentRequest?: string): string {
  const parts = [
    '<compact_summary>',
    'This session continues from an earlier conversation that was compacted to save context. Summary of the earlier part:',
    '',
    summary.trim(),
    '</compact_summary>',
  ];
  if (currentRequest !== undefined) {
    parts.push('', 'The user\'s current request (verbatim):', currentRequest, '', 'Continue the task from where it left off.');
  }
  return parts.join('\n');
}
