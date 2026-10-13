// Tool calls that arrive as text, repaired in the Anthropic Messages stream between llama.cpp and Claude Code.
//
// Qwen-style models now and then write a tool call as plain text instead of the format llama.cpp's parser recognises
// (e.g. `<TodoWrite>\n<parameter=todos>\n[...]\n</parameter>\n</function>\n</tool_call>`). The server then ends the turn
// with `stop_reason: "end_turn"` and the call as text, and Claude Code shows it as the answer and stops. The app's own
// loop has a fallback parser for this (core/llm/textToolCalls.ts); this module gives Claude Code the same safety net.
//
// Only a text block that STARTS with a tool-call opener is ever held back (a few characters of decision latency for
// text that starts with "<"; ordinary text streams through untouched). When the held block parses as tool call(s)
// (and nothing but the call is in it), it is replaced by tool_use blocks and `stop_reason` becomes "tool_use"; otherwise
// the original events are forwarded unchanged.

import { StringDecoder } from 'node:string_decoder';
import { nanoid } from 'nanoid';
import type { ChatToolSpec } from '../contracts';
import { parseTextToolCalls } from '../llm/textToolCalls';

type Json = Record<string, unknown>;

export interface AnthropicToolSpec { name?: unknown; input_schema?: unknown }

/** Anthropic tool definitions → the shape the fallback parser coerces values with. */
export function toChatToolSpecs(tools: unknown): ChatToolSpec[] {
  if (!Array.isArray(tools)) return [];
  return (tools as AnthropicToolSpec[]).flatMap((t): ChatToolSpec[] => {
    if (!t || typeof t.name !== 'string' || !t.name) return [];
    const schema = t.input_schema && typeof t.input_schema === 'object' ? (t.input_schema as Record<string, unknown>) : {};
    return [{ type: 'function', function: { name: t.name, description: '', parameters: schema } }];
  });
}

type Verdict = 'no' | 'maybe' | 'yes';

export class ToolCallRecovery {
  private readonly specs: ChatToolSpec[];
  private readonly openers: string[];
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');
  private holding: { index: number; frames: string[]; text: string } | null = null;
  /** Added to the index of every block after a replaced one (a text block can become several tool_use blocks). */
  private shift = 0;
  /** Tool calls synthesized so far (observable for tests/diagnostics). */
  recovered = 0;

  constructor(tools: unknown, private readonly makeId: () => string = () => `toolu_${nanoid(24)}`) {
    this.specs = toChatToolSpecs(tools);
    this.openers = ['<tool_call>', '<function=', ...this.specs.map((s) => `<${s.function.name}>`)];
  }

  get active(): boolean { return this.specs.length > 0; }

  /** Feed raw bytes of the upstream SSE body; returns what to forward downstream now. */
  write(chunk: Buffer | string): string {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.pending);
      if (!m) break;
      const end = m.index + m[0].length;
      out += this.frame(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
    }
    return out;
  }

  /** The upstream body ended: forward whatever is still held back, unchanged. */
  end(): string {
    this.pending += this.decoder.end();
    let out = '';
    if (this.holding) {
      out += this.releaseHeld();
    }
    out += this.pending;
    this.pending = '';
    return out;
  }

  private verdict(text: string): Verdict {
    const t = text.trimStart();
    if (!t) return 'maybe';
    let maybe = false;
    for (const o of this.openers) {
      if (t.startsWith(o)) return 'yes';
      if (o.startsWith(t)) maybe = true;
    }
    return maybe ? 'maybe' : 'no';
  }

  private releaseHeld(): string {
    const h = this.holding;
    this.holding = null;
    return h ? h.frames.join('') : '';
  }

  private parse(frame: string): { event?: string; data: Json } | null {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return null;
    try {
      const j = JSON.parse(data.join('\n')) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? { event, data: j as Json } : null;
    } catch { return null; }
  }

  private render(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** The frame with its block index moved by the current shift (unchanged when the shift is 0). */
  private shifted(frame: string, p: { event?: string; data: Json } | null): string {
    if (!this.shift || !p || typeof p.data.index !== 'number') return frame;
    return this.render(p.event ?? String(p.data.type ?? 'message'), { ...p.data, index: p.data.index + this.shift });
  }

  private frame(frame: string): string {
    if (!this.active) return frame;
    const p = this.parse(frame);
    if (!p) return this.releaseHeld() + frame;
    const type = String(p.data.type ?? p.event ?? '');
    const index = typeof p.data.index === 'number' ? p.data.index : -1;
    if (type === 'ping') return frame; // keep-alives may appear anywhere; they never end a held block

    if (this.holding) {
      if (type === 'content_block_delta' && index === this.holding.index) {
        const d = p.data.delta as Json | undefined;
        if (d?.type !== 'text_delta' || typeof d.text !== 'string') return this.releaseHeld() + this.shifted(frame, p);
        this.holding.frames.push(this.shifted(frame, p));
        this.holding.text += d.text;
        if (this.verdict(this.holding.text) === 'no') return this.releaseHeld();
        return '';
      }
      if (type === 'content_block_stop' && index === this.holding.index) return this.finishHeld(frame, p);
      // anything else while holding (ping, message_delta, another block): not a clean tool-call block
      return this.releaseHeld() + this.frame2(frame, p, type, index);
    }
    return this.frame2(frame, p, type, index);
  }

  private frame2(frame: string, p: { event?: string; data: Json }, type: string, index: number): string {
    if (type === 'content_block_start') {
      const block = p.data.content_block as Json | undefined;
      if (block?.type === 'text' && (typeof block.text !== 'string' || block.text === '')) {
        this.holding = { index, frames: [this.shifted(frame, p)], text: '' };
        return '';
      }
    }
    if (type === 'message_delta' && this.recovered > 0) {
      const d = (p.data.delta ?? {}) as Json;
      if (d.stop_reason === 'end_turn' || d.stop_reason === 'stop_sequence') {
        return this.render(p.event ?? 'message_delta', { ...p.data, delta: { ...d, stop_reason: 'tool_use' } });
      }
    }
    return this.shifted(frame, p);
  }

  private finishHeld(stopFrame: string, stop: { event?: string; data: Json }): string {
    const h = this.holding!;
    this.holding = null;
    const parsed = parseTextToolCalls(h.text.trim(), this.specs, this.makeId);
    if (!parsed.calls.length || parsed.rest.trim()) return h.frames.join('') + this.shifted(stopFrame, stop);
    let out = '';
    parsed.calls.forEach((call, k) => {
      const idx = h.index + this.shift + k;
      out += this.render('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
      out += this.render('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: call.arguments } });
      out += this.render('content_block_stop', { type: 'content_block_stop', index: idx });
    });
    this.shift += parsed.calls.length - 1;
    this.recovered += parsed.calls.length;
    return out;
  }
}
