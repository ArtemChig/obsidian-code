import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest, LlmEvent } from '@core/contracts';
import { createLlmClient } from '@core/llm/client';
import { resetEndpointStates, setDialect } from '@core/llm/dialect';
import { LlmError } from '@core/llm/errors';
import type { ToolCallEvent } from '@core/llm/parser';
import { startMockLlm, type MockLlm } from '../../fixtures/mock-llm/server';

let mock: MockLlm;
beforeAll(async () => { mock = await startMockLlm(); });
afterAll(async () => { await mock.close(); });
afterEach(() => { resetEndpointStates(); mock.requests.length = 0; });

const client = createLlmClient({ retryDelaysMs: [10, 10] });

async function run(req: Partial<ChatRequest> = {}, baseUrl = `${mock.url}/v1`): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const ev of client.stream({ baseUrl }, { model: 'm', messages: [{ role: 'user', content: 'hi' }], ...req })) out.push(ev);
  return out;
}

const TOOLS: ChatRequest['tools'] = [
  { type: 'function', function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } },
];

describe('LlmClient (against mock-llm)', () => {
  it('streams reasoning, text, usage; llamacpp body carries the dialect extras', async () => {
    mock.enqueue({ reasoning: 'thinking hard', text: 'Hello world', progress: true });
    const ev = await run({ thinking: true, tools: TOOLS });
    expect(ev.filter((e) => e.type === 'thinking').map((e) => (e as { delta: string }).delta).join('')).toBe('thinking hard');
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello world');
    const done = ev.at(-1) as Extract<LlmEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.finishReason).toBe('stop');
    expect(done.usage?.promptTokens).toBeGreaterThan(0);
    const body = mock.requests[0]!.body;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.reasoning_format).toBe('deepseek');
    expect(body.return_progress).toBe(true);
    expect(body.cache_prompt).toBe(true);
    expect(body.top_k).toBe(20);
    expect(body.max_tokens).toBeUndefined();
    expect(body.tools).toHaveLength(1);
  });

  it('thinking off → enable_thinking false', async () => {
    mock.enqueue({ text: 'x' });
    await run({ thinking: false });
    expect(mock.requests[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('native tool calls; invalid history args replaced with {}; reasoning kept for llamacpp', async () => {
    mock.enqueue({ toolCalls: [{ name: 'Read', arguments: { file_path: 'a.txt' } }, { name: 'Read', arguments: { file_path: 'b.txt' } }] });
    const ev = await run({
      tools: TOOLS,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: null, reasoning_content: 'old thoughts', tool_calls: [{ id: 'x', type: 'function', function: { name: 'Read', arguments: '{bad' } }] },
        { role: 'tool', tool_call_id: 'x', content: 'r' },
        { role: 'user', content: 'u2' },
      ],
    });
    const calls = ev.filter((e) => e.type === 'tool_call') as ToolCallEvent[];
    expect(calls.map((c) => JSON.parse(c.arguments).file_path)).toEqual(['a.txt', 'b.txt']);
    const sent = mock.requests[0]!.body.messages;
    expect(sent[2].tool_calls[0].function.arguments).toBe('{}');
    expect(sent[2].reasoning_content).toBe('old thoughts');
  });

  it('generic dialect: no llama.cpp extras, reasoning stripped from history', async () => {
    const generic = await startMockLlm({ dialect: 'generic' });
    try {
      generic.enqueue({ text: 'ok' });
      const out: LlmEvent[] = [];
      for await (const e of client.stream({ baseUrl: generic.url }, {
        model: 'm',
        messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', reasoning_content: 'r' }, { role: 'user', content: 'c' }],
      })) out.push(e);
      const body = generic.requests[0]!.body;
      expect(body.reasoning_format).toBeUndefined();
      expect(body.return_progress).toBeUndefined();
      expect(body.top_k).toBeUndefined();
      expect(body.messages[1].reasoning_content).toBeUndefined();
    } finally { await generic.close(); }
  });

  it('vllm dialect detected via /v1/models: keeps reasoning only for the current turn', async () => {
    const vllm = await startMockLlm({ dialect: 'vllm' });
    try {
      vllm.enqueue({ text: 'ok' });
      for await (const _ of client.stream({ baseUrl: vllm.url }, {
        model: 'm',
        messages: [
          { role: 'user', content: 'a' }, { role: 'assistant', content: 'b', reasoning_content: 'old' },
          { role: 'user', content: 'c' }, { role: 'assistant', content: null, reasoning_content: 'new', tool_calls: [{ id: '1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: '1', content: 'x' },
        ],
      })) { /* drain */ }
      const body = vllm.requests[0]!.body;
      expect(body.chat_template_kwargs).toBeDefined();
      expect(body.reasoning_format).toBeUndefined();
      expect(body.messages[1].reasoning_content).toBeUndefined();
      expect(body.messages[3].reasoning_content).toBe('new');
    } finally { await vllm.close(); }
  });

  it('strict endpoint rejecting an unknown field → retried once without extras and remembered', async () => {
    const strict = await startMockLlm({ dialect: 'generic' });
    try {
      strict.enqueue({ httpError: { status: 400, body: { error: { message: 'Unrecognized request argument supplied: chat_template_kwargs', type: 'invalid_request_error' } } } });
      strict.enqueue({ text: 'fine' }, { text: 'again' });
      const out: LlmEvent[] = [];
      for await (const e of client.stream({ baseUrl: strict.url }, { model: 'm', messages: [{ role: 'user', content: 'a' }], thinking: false })) out.push(e);
      expect(out.some((e) => e.type === 'text')).toBe(true);
      expect(strict.requests[0]!.body.chat_template_kwargs).toBeDefined();
      expect(strict.requests[1]!.body.chat_template_kwargs).toBeUndefined();
      for await (const _ of client.stream({ baseUrl: strict.url }, { model: 'm', messages: [{ role: 'user', content: 'a' }], thinking: false })) { /* drain */ }
      expect(strict.requests[2]!.body.chat_template_kwargs).toBeUndefined();
    } finally { await strict.close(); }
  });

  it('context overflow → typed error', async () => {
    mock.enqueue({ httpError: { status: 400, body: { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 140000, n_ctx: 131072 } } } });
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('context_overflow');
    expect(err.message).toMatch(/too long/);
  });

  it('template error (500 JSON on stream:true) → bad_history, readable message', async () => {
    const raw = readFileSync(join(process.cwd(), 'docs/research/samples/error_template_stream.sse.txt'), 'utf8');
    mock.enqueue({ httpError: { status: 500, body: JSON.parse(raw) } });
    const err = await run().catch((e) => e);
    expect(err.kind).toBe('bad_history');
    expect(err.message).toMatch(/System message must be at the beginning/);
    expect(err.message).not.toMatch(/CallExpression/);
  });

  it('in-stream error chunk → typed error', async () => {
    mock.enqueue({ text: 'partial', streamError: { message: 'boom', code: 500 } });
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/boom/);
  });

  it('503 loading → retried with backoff, then succeeds', async () => {
    mock.enqueue({ httpError: { status: 503, body: { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } } } }, { text: 'ready' });
    const ev = await run();
    expect(ev.some((e) => e.type === 'text')).toBe(true);
    expect(mock.requests).toHaveLength(2);
  });

  it('401 → auth error (not retried)', async () => {
    mock.enqueue({ httpError: { status: 401, body: { error: { message: 'Invalid API Key' } } } });
    const err = await run().catch((e) => e);
    expect(err.kind).toBe('auth');
    expect(mock.requests).toHaveLength(1);
  });

  it('offline endpoint → offline error with a readable message', async () => {
    setDialect('http://127.0.0.1:9', 'llamacpp');
    const err = await run({}, 'http://127.0.0.1:9').catch((e) => e);
    expect(err.kind).toBe('offline');
    expect(err.message).toMatch(/Can't reach the model server/);
  });

  it('abort via signal closes the stream', async () => {
    mock.enqueue({ text: 'aaaa', hangAfter: 2 });
    const ctrl = new AbortController();
    const got: LlmEvent[] = [];
    const p = (async () => {
      for await (const e of client.stream({ baseUrl: mock.url }, { model: 'm', messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal })) {
        got.push(e);
        if (e.type === 'text') ctrl.abort();
      }
    })();
    const err = await p.catch((e) => e);
    expect(err.kind).toBe('aborted');
    expect(got.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.aborted).toBeGreaterThanOrEqual(1);
  });

  it('idle timeout when no bytes arrive', async () => {
    const quick = createLlmClient({ idleTimeoutMs: 300, retryDelaysMs: [] });
    mock.enqueue({ text: 'aa', hangAfter: 1 });
    const err = await (async () => { for await (const _ of quick.stream({ baseUrl: mock.url }, { model: 'm', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ } })().catch((e) => e);
    expect(err.kind).toBe('timeout');
  });

  it('stream ending without [DONE] → retried before any event? no: events were emitted → error', async () => {
    mock.enqueue({ text: 'abc', endWithoutDone: true });
    const err = await run().catch((e) => e);
    expect(err.kind).toBe('stream');
  });

  it('non-streaming JSON answer is accepted', async () => {
    mock.enqueue({ json: { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'r', tool_calls: [{ type: 'function', id: 'q1', function: { name: 'Read', arguments: '{"file_path":"x"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 3 } } });
    const ev = await run({ tools: TOOLS });
    expect(ev.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'q1', name: 'Read' });
    expect(ev.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls', usage: { promptTokens: 5, completionTokens: 3 } });
  });

  it('raw real sample replayed through HTTP (chat_default_stream)', async () => {
    const raw = readFileSync(join(process.cwd(), 'docs/research/samples/chat_default_stream.sse.txt'), 'utf8');
    const summary = JSON.parse(readFileSync(join(process.cwd(), 'docs/research/samples/chat_default_stream.summary.json'), 'utf8')).summary;
    mock.enqueue({ raw });
    const ev = await run();
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(summary.content);
    expect(ev.filter((e) => e.type === 'thinking').map((e) => (e as { delta: string }).delta).join('')).toBe(summary.reasoning);
  });

  it('complete-style request sends max_tokens', async () => {
    mock.enqueue({ text: 'short' });
    await run({ maxTokens: 64, thinking: false });
    expect(mock.requests[0]!.body.max_tokens).toBe(64);
  });
});
