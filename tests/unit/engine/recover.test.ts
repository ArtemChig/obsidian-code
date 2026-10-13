// Tool calls written as text by the model are turned back into tool_use blocks in the Anthropic stream between
// llama.cpp and Claude Code (src/core/engine/recover.ts, wired into the shim). Frame shapes are llama.cpp's real
// /v1/messages stream (captured from the local server).

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ToolCallRecovery, toChatToolSpecs } from '@core/engine/recover';
import { AnthropicShim } from '@core/engine/shim';

type Json = Record<string, unknown>;

const TOOLS = [
  { name: 'TodoWrite', input_schema: { type: 'object', properties: { todos: { type: 'array' } } } },
  { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'integer' } } } },
];

const frame = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = frame('message_start', { message: { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } });
const blockStart = (index: number, block: Json) => frame('content_block_start', { index, content_block: block });
const delta = (index: number, d: Json) => frame('content_block_delta', { index, delta: d });
const textDeltas = (index: number, text: string, size = 7) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(delta(index, { type: 'text_delta', text: text.slice(i, i + size) }));
  return out.join('');
};
const stop = (index: number) => frame('content_block_stop', { index });
const end = (reason: string) => frame('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 3 } }) + frame('message_stop', {});

const textBlock = (index: number, text: string, reason = 'end_turn') =>
  start + blockStart(index, { type: 'text', text: '' }) + textDeltas(index, text) + stop(index) + end(reason);

/** Run a whole stream through the recovery in chunks of `size` bytes. */
function run(tools: unknown, stream: string, size = 64): { out: string; rec: ToolCallRecovery } {
  const rec = new ToolCallRecovery(tools, () => 'toolu_test');
  const bytes = Buffer.from(stream, 'utf8');
  let out = '';
  for (let i = 0; i < bytes.length; i += size) out += rec.write(bytes.subarray(i, i + size));
  out += rec.end();
  return { out, rec };
}

function events(sse: string): Json[] {
  return sse.split(/\n\n/).filter(Boolean).map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) as Json);
}

// what the local model really produced once: the tool name as the tag, no <tool_call><function=… wrapper
const MALFORMED = '<TodoWrite>\n<parameter=todos>\n[{"content": "Create hello.txt", "status": "in_progress", "activeForm": "Creating hello.txt"}, '
  + '{"content": "List files", "status": "pending", "activeForm": "Listing files"}]\n</parameter>\n</function>\n</tool_call>';

describe('tool calls written as text (Anthropic stream)', () => {
  it('ordinary text is forwarded byte for byte, whatever the chunking', () => {
    const stream = textBlock(0, 'Hello — это тест. Done.');
    for (const size of [1, 5, 64, 100000]) expect(run(TOOLS, stream, size).out).toBe(stream);
  });

  it('text that starts with < but is not a tool call is released unchanged', () => {
    const stream = textBlock(0, '<div class="x">hi</div> and more');
    const { out, rec } = run(TOOLS, stream, 9);
    expect(out).toBe(stream);
    expect(rec.recovered).toBe(0);
    const prefixOnly = textBlock(0, '<Tod');
    expect(run(TOOLS, prefixOnly).out).toBe(prefixOnly);
  });

  it('turns a <ToolName> text call into a tool_use block and ends the turn with tool_use', () => {
    const { out, rec } = run(TOOLS, textBlock(0, MALFORMED), 11);
    expect(rec.recovered).toBe(1);
    const ev = events(out);
    expect(ev.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(ev[1]).toMatchObject({ index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: 'TodoWrite', input: {} } });
    const args = JSON.parse(((ev[2]!.delta as Json).partial_json as string)) as { todos: { content: string; status: string }[] };
    expect(args.todos.map((t) => t.content)).toEqual(['Create hello.txt', 'List files']);
    expect((ev[4]!.delta as Json).stop_reason).toBe('tool_use');
    expect(out).not.toContain('<parameter=');
  });

  it('also repairs the standard <tool_call><function=…> text form and keeps block indexes consistent after a thinking block', () => {
    const text = '<tool_call>\n<function=Read>\n<parameter=file_path>\nC:\\tmp\\a.txt\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>';
    const stream = start
      + blockStart(0, { type: 'thinking', thinking: '' }) + delta(0, { type: 'thinking_delta', thinking: 'hmm' }) + stop(0)
      + blockStart(1, { type: 'text', text: '' }) + textDeltas(1, text) + stop(1) + end('end_turn');
    const { out } = run(TOOLS, stream);
    const ev = events(out);
    const tool = ev.find((e) => e.type === 'content_block_start' && (e.content_block as Json).type === 'tool_use')!;
    expect(tool.index).toBe(1);
    expect(JSON.parse((ev.find((e) => e.type === 'content_block_delta' && e.index === 1)!.delta as Json).partial_json as string)).toEqual({ file_path: 'C:\\tmp\\a.txt', limit: 20 });
    expect((ev.at(-2)!.delta as Json).stop_reason).toBe('tool_use');
  });

  it('several text-form calls become several tool_use blocks and later blocks are renumbered', () => {
    const one = '<tool_call><function=Read><parameter=file_path>a.txt</parameter></function></tool_call>';
    const text = `${one}\n${one.replace('a.txt', 'b.txt')}`;
    const stream = start + blockStart(0, { type: 'text', text: '' }) + textDeltas(0, text) + stop(0)
      + blockStart(1, { type: 'tool_use', id: 'toolu_real', name: 'Read', input: {} }) + delta(1, { type: 'input_json_delta', partial_json: '{}' }) + stop(1) + end('tool_use');
    const ev = events(run(TOOLS, stream).out);
    const starts = ev.filter((e) => e.type === 'content_block_start').map((e) => [e.index, (e.content_block as Json).name]);
    expect(starts).toEqual([[0, 'Read'], [1, 'Read'], [2, 'Read']]);
    expect(ev.filter((e) => e.type === 'content_block_stop').map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('an unparsable or mixed block is forwarded unchanged (nothing is lost)', () => {
    for (const text of ['<TodoWrite> I would call TodoWrite now, with no parameters.', `Intro?\n${MALFORMED}`, `${MALFORMED}\nand then some prose`, '<tool_call>\nnot json and not xml\n</tool_call>']) {
      const stream = textBlock(0, text);
      const { out, rec } = run(TOOLS, stream, 13);
      expect(out).toBe(stream);
      expect(rec.recovered).toBe(0);
    }
  });

  it('a stream that ends while a block is held back is released as received; no tools means no processing', () => {
    const cut = start + blockStart(0, { type: 'text', text: '' }) + textDeltas(0, '<TodoWrite>\n<param');
    const { out } = run(TOOLS, cut, 10);
    expect(out).toBe(cut);
    const plain = textBlock(0, MALFORMED);
    const none = new ToolCallRecovery(undefined);
    expect(none.active).toBe(false);
    expect(run([], plain).out).toBe(plain);
    expect(toChatToolSpecs([{ name: 'A', input_schema: { type: 'object' } }, { nope: 1 }, null])).toHaveLength(1);
  });

  it('keeps ping events from ending a held block', () => {
    const ping = 'event: ping\ndata: {"type": "ping"}\n\n';
    const stream = start + blockStart(0, { type: 'text', text: '' }) + textDeltas(0, MALFORMED.slice(0, 40)) + ping + textDeltas(0, MALFORMED.slice(40)) + stop(0) + end('end_turn');
    const { out, rec } = run(TOOLS, stream, 17);
    expect(rec.recovered).toBe(1);
    expect(out).toContain('event: ping');
  });

  it('the shim repairs a streaming /v1/messages response that carries tools, and leaves other calls alone', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(textBlock(0, MALFORMED));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const shim = new AnthropicShim();
    try {
      const base = await shim.baseUrl({ baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
      const post = (body: Json) => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
      const fixed = events(await post({ model: 'm', stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'x' }] }));
      expect(fixed.some((e) => e.type === 'content_block_start' && (e.content_block as Json).name === 'TodoWrite')).toBe(true);
      expect((fixed.at(-2)!.delta as Json).stop_reason).toBe('tool_use');
      // no tools in the request (titles, summaries): untouched
      expect(await post({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] })).toBe(textBlock(0, MALFORMED));
      // not a streaming call: untouched
      expect(await post({ model: 'm', tools: TOOLS, messages: [{ role: 'user', content: 'x' }] })).toBe(textBlock(0, MALFORMED));
    } finally {
      shim.close();
      upstream.close();
    }
  });
});
