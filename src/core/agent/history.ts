// Transcript (Message[]) → OpenAI chat history (docs/research/llama-server.md §8.4).
//  * one system message, first; the transcript starts at the last compact_summary
//  * 'command' messages (local slash-command echoes) never reach the model
//  * consecutive user-side messages (user, hook reminders, compact summary) merge into one user message
//  * assistant: visible text + reasoning_content (the client strips it per dialect) + tool_calls with valid JSON
//  * one tool message per call, in call order, right after its assistant message

import type { ChatContentPart, ChatMessage, ChatToolCall } from '../contracts';
import type { Block, Message, ToolUseBlock } from '../../shared/types';

export interface HistoryOptions {
  system: string;
  supportsVision: boolean;
}

export function isUserSide(m: Message): boolean {
  return m.role === 'user' || (m.role === 'system' && m.tag === 'compact_summary');
}

/** Index of the last compact_summary message (history starts there), or 0. */
export function historyStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.tag === 'compact_summary') return i;
  return 0;
}

function userParts(blocks: Block[], vision: boolean): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text') { if (b.text) parts.push({ type: 'text', text: b.text }); }
    else if (b.type === 'image') {
      if (vision) parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
      else parts.push({ type: 'text', text: `[image omitted${b.name ? `: ${b.name}` : ''} — the current model cannot see images]` });
    }
  }
  return parts;
}

function mergeParts(parts: ChatContentPart[]): string | ChatContentPart[] {
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => (p as { text: string }).text).join('\n\n');
  // merge adjacent text parts to keep the prompt tidy
  const out: ChatContentPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.type === 'text' && last && last.type === 'text') last.text += `\n\n${p.text}`;
    else out.push(p.type === 'text' ? { ...p } : p);
  }
  return out;
}

export function toolResultText(t: ToolUseBlock): string {
  if (t.result) return t.result.content || (t.result.isError ? 'Error' : '(no output)');
  switch (t.status) {
    case 'interrupted': return 'Interrupted by the user before the tool finished.';
    case 'denied': return 'The user denied this tool call.';
    default: return 'The tool did not produce a result.';
  }
}

function safeArgs(input: Record<string, unknown>): string {
  try { return JSON.stringify(input ?? {}); } catch { return '{}'; }
}

export function buildHistory(messages: Message[], opts: HistoryOptions): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: opts.system }];
  let pendingUser: ChatContentPart[] = [];
  const flushUser = () => {
    if (!pendingUser.length) return;
    out.push({ role: 'user', content: mergeParts(pendingUser) });
    pendingUser = [];
  };
  const start = historyStart(messages);
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.tag === 'command') continue;
    if (isUserSide(m)) {
      pendingUser.push(...userParts(m.blocks, opts.supportsVision));
      continue;
    }
    if (m.role !== 'assistant') continue;
    const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    const reasoning = m.blocks.filter((b) => b.type === 'thinking').map((b) => (b as { text: string }).text).join('');
    const tools = m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (!text && !tools.length) continue; // empty (e.g. interrupted before the first token)
    flushUser();
    const calls: ChatToolCall[] = tools.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: safeArgs(t.input) } }));
    const a: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: text || (calls.length ? null : '') };
    if (reasoning) a.reasoning_content = reasoning;
    if (calls.length) a.tool_calls = calls;
    out.push(a);
    for (const t of tools) {
      const content = toolResultText(t);
      const imgs = opts.supportsVision ? t.result?.images ?? [] : [];
      if (imgs.length) {
        out.push({
          role: 'tool', tool_call_id: t.id,
          content: [{ type: 'text', text: content }, ...imgs.map((im) => ({ type: 'image_url' as const, image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))],
        });
      } else {
        out.push({ role: 'tool', tool_call_id: t.id, content: !opts.supportsVision && t.result?.images?.length ? `${content}\n[image omitted — the current model cannot see images]` : content });
      }
    }
  }
  flushUser();
  // The template needs at least one real user message.
  if (!out.some((m) => m.role === 'user')) out.splice(1, 0, { role: 'user', content: 'Continue.' });
  return out;
}

/** Rough token estimate for a history (chars / 3.6, images ≈ 768 tokens). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    const c = (m as { content: unknown }).content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) for (const p of c as ChatContentPart[]) { if (p.type === 'text') chars += p.text.length; else images++; }
    if (m.role === 'assistant') {
      chars += m.reasoning_content?.length ?? 0;
      for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length + tc.function.name.length + 20;
    }
  }
  return Math.ceil(chars / 3.6) + images * 768;
}
