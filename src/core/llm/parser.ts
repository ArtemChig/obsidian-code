// Chunk-level parser for OpenAI-compatible streaming chat completions (docs/research/llama-server.md §8.3).
// Feed it parsed JSON chunks; it yields LlmEvents. Handles reasoning_content / reasoning / reasoning_details,
// <think> tags inside content (tags split across deltas, opener merged with the first token), native tool_calls
// accumulated by index, and the text-form tool-call fallback.

import { nanoid } from 'nanoid';
import type { ChatToolSpec, LlmEvent } from '../contracts';
import { classifyStreamError, LlmError } from './errors';
import { parseTextToolCalls } from './textToolCalls';

/** tool_call event with optional extras. `error` set ⇒ the call must NOT be executed; the agent returns the error to the model. */
export type ToolCallEvent = Extract<LlmEvent, { type: 'tool_call' }> & { error?: string; rawArguments?: string };

export interface Usage { promptTokens: number; completionTokens: number }

export interface ParserOptions {
  /** Tools were sent with the request (enables the text-form tool-call fallback). */
  tools?: ChatToolSpec[];
  /** Thinking was requested (only used with thinkStartsOpen). */
  thinkingRequested?: boolean;
  /** Endpoint flag: the template pre-fills `<think>` so content starts inside thinking. */
  thinkStartsOpen?: boolean;
  /** Called when we detect a `</think>` without an opener (sets the endpoint flag for later requests). */
  onThinkStartsOpen?: () => void;
  onProgress?: (p: { total: number; cache: number; processed: number; timeMs: number }) => void;
  makeId?: () => string;
}

export const TRUNCATED_TOOL_CALL_ERROR =
  'Your tool call was cut off by the output limit before its arguments were complete, so it was NOT executed. Retry with smaller arguments (e.g. split a large Write into several Edits).';

type Acc = { index: number; id?: string; name: string; args: string };
type State = 'text' | 'think' | 'toolcall';

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const TOOL_TAGS = ['<tool_call>', '<function='];

function partialSuffixLen(s: string, tags: string[]): number {
  // longest suffix of s that is a proper prefix of any tag
  let best = 0;
  for (const tag of tags) {
    const max = Math.min(tag.length - 1, s.length);
    for (let n = max; n > best; n--) {
      if (s.endsWith(tag.slice(0, n))) { best = n; break; }
    }
  }
  return best;
}

function textOf(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  let s = '';
  for (const d of details) {
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>;
      if (typeof o.text === 'string') s += o.text;
      else if (typeof o.summary === 'string') s += o.summary;
    }
  }
  return s || undefined;
}

/** Try to repair slightly broken JSON arguments (text after the last `}`, missing closing braces). */
export function repairJson(args: string): string | null {
  const t = args.trim();
  try { JSON.parse(t); return t; } catch { /* continue */ }
  const last = t.lastIndexOf('}');
  if (last > 0) {
    const cut = t.slice(0, last + 1);
    try { JSON.parse(cut); return cut; } catch { /* continue */ }
  }
  // close unbalanced braces/brackets (outside strings)
  let inStr = false; let esc = false; const stack: string[] = [];
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr || !stack.length) return null;
  const closed = t + stack.reverse().join('');
  try { JSON.parse(closed); return closed; } catch { return null; }
}

export class StreamParser {
  private state: State = 'text';
  private pending = '';
  private toolBuf = '';
  private sawThinkOpen = false;
  private trimLeading = false;
  private thinkFresh = false;
  private sawReasoningField = false;
  private emittedContent = false;
  private readonly accs: Acc[] = [];
  private readonly byIndex = new Map<number, Acc>();
  private readonly byId = new Map<string, Acc>();
  private lastAcc: Acc | undefined;
  private nextIndex = 0;

  finishReason: string | null = null;
  usage: Usage | undefined;
  timings: Record<string, number> | undefined;
  sawDone = false;
  invalidChunks = 0;
  /** Total characters received (for usage estimation when the server sends none). */
  outputChars = 0;

  constructor(private readonly opts: ParserOptions = {}) {
    if (opts.thinkStartsOpen && opts.thinkingRequested) { this.state = 'think'; this.sawThinkOpen = true; this.thinkFresh = true; }
  }

  private get toolsSent(): boolean { return !!this.opts.tools?.length; }

  /** Feed one SSE data payload (string). Returns events to emit now. */
  feedData(data: string): LlmEvent[] {
    if (data === '[DONE]') { this.sawDone = true; return []; }
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { this.invalidChunks++; return []; }
    return this.feed(chunk as Record<string, unknown>);
  }

  /** Feed one parsed chunk. */
  feed(chunk: Record<string, unknown>): LlmEvent[] {
    if (!chunk || typeof chunk !== 'object') return [];
    if (chunk.error) throw classifyStreamError(chunk);
    if (chunk.object === 'error') throw classifyStreamError(chunk);
    const out: LlmEvent[] = [];
    const u = chunk.usage as Record<string, number> | undefined | null;
    if (u && typeof u === 'object' && typeof u.prompt_tokens === 'number') {
      this.usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens ?? 0 };
    }
    if (chunk.timings && typeof chunk.timings === 'object') this.timings = chunk.timings as Record<string, number>;
    const prog = chunk.prompt_progress as Record<string, number> | undefined;
    if (prog && this.opts.onProgress) {
      this.opts.onProgress({ total: prog.total ?? 0, cache: prog.cache ?? 0, processed: prog.processed ?? 0, timeMs: prog.time_ms ?? 0 });
    }
    const choices = chunk.choices as Record<string, unknown>[] | undefined;
    const c = Array.isArray(choices) ? choices[0] : undefined;
    if (!c) return out;
    // non-streaming shape (some servers answer stream:true with a full message)
    const d = ((c.delta ?? c.message) ?? {}) as Record<string, unknown>;

    const r = [d.reasoning_content, d.reasoning, textOf(d.reasoning_details)].find((x) => typeof x === 'string' && x.length > 0) as string | undefined;
    if (r) {
      this.sawReasoningField = true;
      // a server that separates reasoning never needs the thinkStartsOpen path
      if (this.state === 'think' && !this.emittedContent && this.pending === '') { this.state = 'text'; this.sawThinkOpen = false; }
      this.outputChars += r.length;
      out.push({ type: 'thinking', delta: r });
    }
    if (typeof d.content === 'string' && d.content.length > 0) {
      this.outputChars += d.content.length;
      this.content(d.content, out);
    }
    if (Array.isArray(d.tool_calls)) this.toolCalls(d.tool_calls as Record<string, unknown>[]);
    if (c.finish_reason != null && typeof c.finish_reason === 'string') this.finishReason = c.finish_reason;
    return out;
  }

  // ───────────── content state machine ─────────────

  private content(delta: string, out: LlmEvent[]): void {
    this.emittedContent = true;
    if (this.state === 'toolcall') { this.toolBuf += delta; return; }
    this.pending += delta;
    this.drain(out, false);
  }

  private textTags(): string[] {
    const tags = [THINK_OPEN];
    if (!this.sawThinkOpen) tags.push(THINK_CLOSE);
    if (this.toolsSent) tags.push(...TOOL_TAGS);
    return tags;
  }

  private emitText(text: string, out: LlmEvent[]): void {
    let t = text;
    if (this.trimLeading) {
      t = t.replace(/^\s+/, '');
      if (t.length) this.trimLeading = false;
    }
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.delta += t;
    else out.push({ type: 'text', delta: t });
  }

  private emitThinking(text: string, out: LlmEvent[]): void {
    let t = text;
    if (this.thinkFresh) {
      t = t.replace(/^\r?\n/, '');
      if (t.length) this.thinkFresh = false;
    }
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === 'thinking') last.delta += t;
    else out.push({ type: 'thinking', delta: t });
  }

  private drain(out: LlmEvent[], final: boolean): void {
    for (;;) {
      if (this.state === 'text') {
        const tags = this.textTags();
        let best = -1; let bestTag = '';
        for (const tag of tags) {
          const i = this.pending.indexOf(tag);
          if (i >= 0 && (best < 0 || i < best)) { best = i; bestTag = tag; }
        }
        if (best < 0) {
          const keep = final ? 0 : partialSuffixLen(this.pending, tags);
          this.emitText(this.pending.slice(0, this.pending.length - keep), out);
          this.pending = this.pending.slice(this.pending.length - keep);
          return;
        }
        this.emitText(this.pending.slice(0, best), out);
        const after = this.pending.slice(best + bestTag.length);
        if (bestTag === THINK_OPEN) {
          this.state = 'think';
          this.sawThinkOpen = true;
          this.thinkFresh = true;
          this.pending = after;
        } else if (bestTag === THINK_CLOSE) {
          // reasoning arrived without an opener (template pre-filled <think>): drop the tag, remember for next time
          this.opts.onThinkStartsOpen?.();
          this.sawThinkOpen = true;
          this.trimLeading = true;
          this.pending = after;
        } else {
          this.state = 'toolcall';
          this.toolBuf = bestTag + after;
          this.pending = '';
          return;
        }
      } else if (this.state === 'think') {
        const i = this.pending.indexOf(THINK_CLOSE);
        if (i < 0) {
          const keep = final ? 0 : partialSuffixLen(this.pending, [THINK_CLOSE]);
          this.emitThinking(this.pending.slice(0, this.pending.length - keep), out);
          this.pending = this.pending.slice(this.pending.length - keep);
          return;
        }
        this.emitThinking(this.pending.slice(0, i), out);
        this.pending = this.pending.slice(i + THINK_CLOSE.length);
        this.state = 'text';
        this.trimLeading = true;
      } else {
        this.toolBuf += this.pending;
        this.pending = '';
        return;
      }
    }
  }

  // ───────────── tool-call accumulator ─────────────

  private toolCalls(list: Record<string, unknown>[]): void {
    for (const tc of list) {
      if (!tc || typeof tc !== 'object') continue;
      const index = typeof tc.index === 'number' ? tc.index : undefined;
      const id = typeof tc.id === 'string' && tc.id ? tc.id : undefined;
      let a: Acc | undefined = index != null ? this.byIndex.get(index) : id ? this.byId.get(id) : this.lastAcc;
      if (!a) {
        a = { index: index ?? this.nextIndex, name: '', args: '' };
        this.nextIndex = Math.max(this.nextIndex, a.index + 1);
        this.accs.push(a);
        this.byIndex.set(a.index, a);
      }
      if (id && !a.id) { a.id = id; this.byId.set(id, a); }
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      const n = fn.name;
      if (typeof n === 'string' && n && n !== a.name) a.name = a.name ? a.name + n : n;
      const g = fn.arguments;
      if (typeof g === 'string') a.args += g;
      else if (g && typeof g === 'object') a.args = JSON.stringify(g);
      this.lastAcc = a;
    }
  }

  /** Call at end of stream. Throws on an unexpected EOF. Returns the remaining events (text flush, tool calls, done). */
  finish(): LlmEvent[] {
    if (!this.sawDone && this.finishReason == null) {
      throw new LlmError('The model stream ended unexpectedly.', { kind: 'stream', retryable: true });
    }
    const out: LlmEvent[] = [];
    // flush the content state machine
    if (this.state === 'think') {
      this.drain(out, true);
    } else if (this.state === 'text') {
      this.drain(out, true);
    }
    const makeId = this.opts.makeId ?? (() => `call_${nanoid(24)}`);
    const calls: ToolCallEvent[] = [];
    const truncated = this.finishReason === 'length';

    const native = [...this.accs].sort((x, y) => x.index - y.index);
    native.forEach((a, i) => {
      if (!a.name) return; // dropped: no name
      const id = a.id ?? makeId();
      let args = a.args.trim() === '' ? '{}' : a.args;
      let ok = true;
      try { JSON.parse(args); } catch { ok = false; }
      const isLast = i === native.length - 1;
      if (truncated && (!ok || isLast)) {
        calls.push({ type: 'tool_call', id, name: a.name, arguments: '{}', rawArguments: a.args, error: TRUNCATED_TOOL_CALL_ERROR });
        return;
      }
      if (!ok) {
        const fixed = repairJson(args);
        if (fixed) args = fixed;
        else {
          calls.push({
            type: 'tool_call', id, name: a.name, arguments: '{}', rawArguments: a.args,
            error: `Your tool call arguments were not valid JSON, so the call was NOT executed. Received: ${a.args.slice(0, 300)}`,
          });
          return;
        }
      }
      calls.push({ type: 'tool_call', id, name: a.name, arguments: args });
    });

    if (this.state === 'toolcall') {
      const buf = this.toolBuf;
      this.toolBuf = '';
      if (!calls.length) {
        const parsed = parseTextToolCalls(buf, this.opts.tools, makeId);
        if (parsed.calls.length) {
          if (parsed.rest) this.emitText(parsed.rest, out);
          parsed.calls.forEach((p, i) => {
            const isLast = i === parsed.calls.length - 1;
            const unclosed = !/<\/tool_call>\s*$|<\/function>\s*$/.test(buf.trim());
            if (truncated && isLast && unclosed) {
              calls.push({ type: 'tool_call', id: p.id, name: p.name, arguments: '{}', rawArguments: p.arguments, error: TRUNCATED_TOOL_CALL_ERROR });
            } else {
              calls.push({ type: 'tool_call', id: p.id, name: p.name, arguments: p.arguments });
            }
          });
        } else {
          this.emitText(buf, out);
        }
      } else {
        this.emitText(buf, out);
      }
    }
    out.push(...calls);
    const finishReason = truncated ? 'length' : calls.length ? 'tool_calls' : (this.finishReason ?? 'stop');
    let usage = this.usage;
    if (!usage && this.timings && typeof this.timings.prompt_n === 'number') {
      usage = { promptTokens: (this.timings.prompt_n ?? 0) + (this.timings.cache_n ?? 0), completionTokens: this.timings.predicted_n ?? 0 };
    }
    out.push({ type: 'done', finishReason, usage });
    return out;
  }
}
