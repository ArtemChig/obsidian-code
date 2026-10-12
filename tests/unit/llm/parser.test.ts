import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatToolSpec, LlmEvent } from '@core/contracts';
import { StreamParser, TRUNCATED_TOOL_CALL_ERROR, type ToolCallEvent } from '@core/llm/parser';
import { SseParser } from '@core/llm/sse';
import { LlmError } from '@core/llm/errors';

const SAMPLES = join(process.cwd(), 'docs', 'research', 'samples');

function sample(name: string): string {
  return readFileSync(join(SAMPLES, name), 'utf8');
}

interface Collected { thinking: string; text: string; calls: ToolCallEvent[]; done?: Extract<LlmEvent, { type: 'done' }>; events: LlmEvent[] }

function collect(events: LlmEvent[]): Collected {
  const c: Collected = { thinking: '', text: '', calls: [], events };
  for (const e of events) {
    if (e.type === 'thinking') c.thinking += e.delta;
    else if (e.type === 'text') c.text += e.delta;
    else if (e.type === 'tool_call') c.calls.push(e as ToolCallEvent);
    else if (e.type === 'done') c.done = e;
  }
  return c;
}

/** Run raw SSE text through the SSE reader + chunk parser, feeding it in odd-sized pieces to exercise buffering. */
function runSse(raw: string, opts: ConstructorParameters<typeof StreamParser>[0] = {}, piece = 37): Collected {
  const sse = new SseParser();
  const p = new StreamParser(opts);
  const events: LlmEvent[] = [];
  for (let i = 0; i < raw.length; i += piece) {
    for (const ev of sse.feed(raw.slice(i, i + piece))) events.push(...p.feedData(ev.data));
  }
  for (const ev of sse.end()) events.push(...p.feedData(ev.data));
  events.push(...p.finish());
  return collect(events);
}

function summary(name: string) {
  return JSON.parse(sample(`${name}.summary.json`)).summary as {
    reasoning: string; content: string; finish_reason: string;
    tool_calls: Record<string, { id: string; name: string; arguments: string }>;
    usage: { prompt_tokens: number; completion_tokens: number } | null;
    timings: Record<string, number>;
  };
}

const WEATHER_TOOLS: ChatToolSpec[] = [
  { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'get_time', description: 't', parameters: { type: 'object', properties: { timezone: { type: 'string' } } } } },
];

describe('StreamParser over real llama-server samples', () => {
  it('chat_default_stream: reasoning_content → thinking, content → text, usage from usage chunk', () => {
    const s = summary('chat_default_stream');
    const c = runSse(sample('chat_default_stream.sse.txt'));
    expect(c.thinking).toBe(s.reasoning);
    expect(c.text).toBe(s.content);
    expect(c.calls).toHaveLength(0);
    expect(c.done?.finishReason).toBe('stop');
    expect(c.done?.usage).toEqual({ promptTokens: s.usage!.prompt_tokens, completionTokens: s.usage!.completion_tokens });
  });

  it('chat_nothink_stream: no thinking at all', () => {
    const s = summary('chat_nothink_stream');
    const c = runSse(sample('chat_nothink_stream.sse.txt'));
    expect(c.thinking).toBe('');
    expect(c.text).toBe(s.content);
  });

  it('chat_nothink_no_include_usage: usage derived from timings on the finish chunk', () => {
    const s = summary('chat_nothink_no_include_usage');
    const c = runSse(sample('chat_nothink_no_include_usage.sse.txt'));
    expect(c.text).toBe(s.content);
    expect(c.done?.usage).toEqual({ promptTokens: s.timings.prompt_n + s.timings.cache_n, completionTokens: s.timings.predicted_n });
  });

  it('chat_reasoning_format_none: <think> merged with first token and </think> in content → thinking/text split', () => {
    const s = summary('chat_reasoning_format_none');
    const c = runSse(sample('chat_reasoning_format_none.sse.txt'));
    const raw = s.content;
    const open = raw.indexOf('<think>\n') + '<think>\n'.length;
    const close = raw.indexOf('</think>');
    expect(c.thinking).toBe(raw.slice(open, close));
    expect(c.text).toBe(raw.slice(close + '</think>'.length).replace(/^\s+/, ''));
    expect(c.text).not.toContain('<think>');
    expect(c.thinking).not.toContain('</think>');
  });

  it('think tags split across deltas at every possible boundary', () => {
    const content = '<think>\nplan it</think>\n\nanswer <b>bold</b>';
    for (let piece = 1; piece <= 6; piece++) {
      const p = new StreamParser();
      const events: LlmEvent[] = [];
      for (let i = 0; i < content.length; i += piece) {
        events.push(...p.feed({ choices: [{ index: 0, delta: { content: content.slice(i, i + piece) } }] }));
      }
      events.push(...p.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      events.push(...p.finish());
      const c = collect(events);
      expect(c.thinking).toBe('plan it');
      expect(c.text).toBe('answer <b>bold</b>');
    }
  });

  it('stream_return_progress: repeated role chunks are ignored, progress surfaced', () => {
    const progress: number[] = [];
    const c = runSse(sample('stream_return_progress.sse.txt'), { onProgress: (p) => progress.push(p.processed) });
    expect(c.text).toBe('delta');
    expect(progress).toEqual([0, 1985, 1989]);
    expect(c.done?.usage?.promptTokens).toBe(1989);
  });

  for (const name of ['tools_parallel_nothink', 'tools_parallel_think', 'loop_1_toolcall_think']) {
    it(`${name}: parallel native tool calls accumulated by index`, () => {
      const s = summary(name);
      const c = runSse(sample(`${name}.sse.txt`), { tools: WEATHER_TOOLS });
      expect(c.thinking).toBe(s.reasoning);
      const expected = Object.keys(s.tool_calls).sort().map((k) => s.tool_calls[k]!);
      expect(c.calls.map((x) => ({ id: x.id, name: x.name, arguments: x.arguments }))).toEqual(
        expected.map((x) => ({ id: x.id, name: x.name, arguments: x.arguments })),
      );
      expect(c.calls.every((x) => !x.error)).toBe(true);
      expect(c.done?.finishReason).toBe('tool_calls');
    });
  }

  it('tools_typed_params: text before the call, typed JSON arguments', () => {
    const s = summary('tools_typed_params');
    const c = runSse(sample('tools_typed_params.sse.txt'), { tools: WEATHER_TOOLS });
    expect(c.text).toBe(s.content);
    expect(c.calls).toHaveLength(1);
    const args = JSON.parse(c.calls[0]!.arguments);
    expect(args).toMatchObject({ offset: 10, limit: 20, verbose: true, tags: ['x', 'y'], options: { encoding: 'utf-8' } });
  });

  it('tools_truncated_by_max_tokens: finish_reason length → call is never executable', () => {
    const c = runSse(sample('tools_truncated_by_max_tokens.sse.txt'), { tools: WEATHER_TOOLS });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.error).toBe(TRUNCATED_TOOL_CALL_ERROR);
    expect(c.calls[0]!.arguments).toBe('{}');
    expect(c.calls[0]!.rawArguments).toBe('{"path":"C');
    expect(c.done?.finishReason).toBe('length');
  });

  it('tools_as_text_no_tools_field: Qwen XML in content → tool call when tools were sent', () => {
    const c = runSse(sample('tools_as_text_no_tools_field.sse.txt'), { tools: WEATHER_TOOLS });
    expect(c.text).toBe('');
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.name).toBe('get_weather');
    expect(JSON.parse(c.calls[0]!.arguments)).toEqual({ city: 'Oslo' });
    expect(c.calls[0]!.id).toMatch(/^call_/);
    expect(c.done?.finishReason).toBe('tool_calls');
  });

  it('tools_as_text_no_tools_field: without tools the XML stays as text', () => {
    const s = summary('tools_as_text_no_tools_field');
    const c = runSse(sample('tools_as_text_no_tools_field.sse.txt'));
    expect(c.calls).toHaveLength(0);
    expect(c.text).toBe(s.content);
  });

  it('tools_as_text_hermes_json: Hermes JSON in content → tool call', () => {
    const c = runSse(sample('tools_as_text_hermes_json.sse.txt'), { tools: WEATHER_TOOLS });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.name).toBe('get_weather');
    expect(JSON.parse(c.calls[0]!.arguments)).toEqual({ city: 'Oslo' });
  });

  it('error_template_stream body is a JSON error (pre-stream) — chunk with error key throws a typed error', () => {
    const p = new StreamParser();
    const body = JSON.parse(sample('error_template_stream.sse.txt'));
    expect(() => p.feed(body)).toThrow(LlmError);
    try { p.feed(body); } catch (e) { expect((e as LlmError).kind).toBe('bad_history'); }
  });

  it('EOF without [DONE] or finish_reason → retryable stream error', () => {
    const p = new StreamParser();
    p.feed({ choices: [{ index: 0, delta: { content: 'hi' } }] });
    expect(() => p.finish()).toThrow(/ended unexpectedly/);
  });

  it('missing index: groups by id, else continues the last call; object arguments accepted', () => {
    const p = new StreamParser();
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'a', function: { name: 'x', arguments: '' } }] } }] });
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '{"q":' } }] } }] });
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'a', function: { arguments: '1}' } }] } }] });
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'b', function: { name: 'y', arguments: { z: true } } }] } }], });
    p.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    const c = collect(p.finish());
    expect(c.calls.map((x) => [x.id, x.name, x.arguments])).toEqual([['a', 'x', '{"q":1}'], ['b', 'y', '{"z":true}']]);
    // finish_reason 'stop' with calls → tool_calls (don't trust the server value)
    expect(c.done?.finishReason).toBe('tool_calls');
  });

  it('invalid JSON (not truncated) → light repair, else error event', () => {
    const p = new StreamParser();
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{"a":1} trailing' } }] } }] });
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'y', arguments: '{"a": [1, 2' } }] } }] });
    p.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'c', function: { name: 'z', arguments: 'nonsense' } }] } }] });
    p.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    const c = collect(p.finish());
    expect(c.calls[0]!.arguments).toBe('{"a":1}');
    expect(JSON.parse(c.calls[1]!.arguments)).toEqual({ a: [1, 2] });
    expect(c.calls[2]!.error).toMatch(/not valid JSON/);
  });

  it('reasoning field variants: reasoning / reasoning_details, never double counted', () => {
    const p = new StreamParser();
    const ev = [
      ...p.feed({ choices: [{ index: 0, delta: { reasoning: 'a', reasoning_details: [{ type: 'reasoning.text', text: 'a' }] } }] }),
      ...p.feed({ choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'b' }] } }] }),
      ...p.feed({ choices: [{ index: 0, delta: { content: 'x' } }] }),
      ...p.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...p.finish(),
    ];
    const c = collect(ev);
    expect(c.thinking).toBe('ab');
    expect(c.text).toBe('x');
  });

  it('thinkStartsOpen: content before </think> without opener → flag set for later requests', () => {
    let flagged = false;
    const p = new StreamParser({ onThinkStartsOpen: () => { flagged = true; } });
    const events = [
      ...p.feed({ choices: [{ index: 0, delta: { content: 'hmm' } }] }),
      ...p.feed({ choices: [{ index: 0, delta: { content: '</think>\n\nDone' } }] }),
      ...p.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...p.finish(),
    ];
    expect(flagged).toBe(true);
    expect(collect(events).text).toBe('hmmDone');
    // next request on that endpoint starts in think state
    const p2 = new StreamParser({ thinkStartsOpen: true, thinkingRequested: true });
    const c2 = collect([
      ...p2.feed({ choices: [{ index: 0, delta: { content: 'reasoning here</think>\n\nanswer' } }] }),
      ...p2.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...p2.finish(),
    ]);
    expect(c2.thinking).toBe('reasoning here');
    expect(c2.text).toBe('answer');
  });

  it('text-form call truncated by length is never executable', () => {
    const p = new StreamParser({ tools: WEATHER_TOOLS });
    p.feed({ choices: [{ index: 0, delta: { content: '<tool_call>\n<function=get_weather>\n<parameter=city>\nOs' } }] });
    p.feed({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
    const c = collect(p.finish());
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.error).toBe(TRUNCATED_TOOL_CALL_ERROR);
  });
});

const parseTextNames = (content: string) => [...content.matchAll(/<function=([^>\n]+)>|"name":\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]!);

describe('every captured *.sse.txt sample parses consistently with its summary', () => {
  const files = readdirSync(SAMPLES).filter((f) => f.endsWith('.sse.txt'));
  for (const f of files) {
    const name = f.replace(/\.sse\.txt$/, '');
    if (!existsSync(join(SAMPLES, `${name}.summary.json`))) continue;
    it(name, () => {
      const s = summary(name);
      const raw = sample(f);
      if (!raw.includes('data:')) return; // pre-stream JSON error body
      const c = runSse(raw, { tools: WEATHER_TOOLS });
      const content = s.content ?? '';
      if (!content.includes('<think>') && !content.includes('<tool_call>')) {
        expect(c.thinking).toBe(s.reasoning ?? '');
        expect(c.text).toBe(content);
      }
      const expected = Object.keys(s.tool_calls ?? {}).sort().map((k) => s.tool_calls[k]!.name);
      if (content.includes('<tool_call>')) expected.push(...parseTextNames(content)); // text-form fallback (tools were sent)
      if (s.finish_reason !== 'length') expect(c.calls.filter((x) => !x.error).map((x) => x.name)).toEqual(expected);
      expect(c.done).toBeDefined();
    });
  }
});
