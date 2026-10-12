// Scriptable OpenAI-compatible SSE server for tests (agent-core). Reproduces llama-server's wire behaviour
// (docs/research/llama-server.md §8.10): leading role chunk, reasoning_content deltas, content deltas, native tool_calls
// deltas (id/name only in the first delta, "{" as the first argument fragment), finish chunk with an empty delta,
// usage chunk with choices: [] + timings, [DONE], return_progress role chunks, <think> tags in content, text-form
// tool calls, truncated calls, pre-stream HTTP JSON errors and in-stream errors.
//
// Usage:
//   const mock = await startMockLlm();
//   mock.enqueue({ text: 'Hello' }, { toolCalls: [{ name: 'Read', arguments: { file_path: 'a.txt' } }] });
//   ... point an Endpoint at mock.url ...
//   await mock.close();

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface MockToolCall { name: string; arguments: string | Record<string, unknown>; id?: string }

export interface MockRequest {
  path: string;
  headers: IncomingMessage['headers'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface MockTurn {
  /** Only use this turn for matching requests (queue scan picks the first match). */
  match?: (req: MockRequest) => boolean;
  /** reasoning_content deltas. A string is split into small chunks. */
  reasoning?: string | string[];
  /** content deltas. A string is split into small chunks. */
  text?: string | string[];
  /** Native tool calls (streamed like llama-server). */
  toolCalls?: MockToolCall[];
  /** Default: 'tool_calls' when toolCalls, else 'stop'. */
  finishReason?: string;
  /** null = no usage chunk (timings on the finish chunk instead). Default: estimated. */
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  /** Emit llama.cpp return_progress role chunks first. */
  progress?: boolean;
  /** Pre-stream HTTP error with a JSON body. */
  httpError?: { status: number; body: unknown };
  /** In-stream error (`data: {"error":…}`) after the scripted deltas. */
  streamError?: { message: string; type?: string; code?: number };
  /** Delay between chunks (ms). */
  chunkDelayMs?: number;
  /** Delay before the first byte (ms). */
  initialDelayMs?: number;
  /** After N data chunks stop writing and keep the connection open until the client aborts. */
  hangAfter?: number;
  /** Close the connection without finish_reason / [DONE]. */
  endWithoutDone?: boolean;
  /** Raw SSE body to send verbatim (e.g. a docs/research sample). */
  raw?: string;
  /** Non-streaming JSON response (HTTP 200, application/json). */
  json?: unknown;
}

export type MockResponder = MockTurn | ((req: MockRequest) => MockTurn);

export interface MockInfo {
  modelId: string;
  nCtx: number;
  vision: boolean;
  dialect: 'llamacpp' | 'vllm' | 'generic';
  /** HTTP status of /health (503 = loading). */
  healthStatus: number;
}

export interface MockLlm {
  /** Root URL, e.g. http://127.0.0.1:PORT */
  url: string;
  /** Chat-completions requests received (in order). */
  requests: MockRequest[];
  /** Number of chat requests whose connection the client closed before the stream finished. */
  aborted: number;
  enqueue(...turns: MockTurn[]): void;
  /** Persistent responder checked before the queue. */
  route(match: (req: MockRequest) => boolean, responder: MockResponder): void;
  /** Used when nothing matches (default: a short text reply "OK"). */
  setFallback(responder: MockResponder): void;
  setInfo(info: Partial<MockInfo>): void;
  /** Turns still queued. */
  remaining(): number;
  /** Resolves when `n` chat requests have been received. */
  waitForRequests(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const CHUNK_ID = 'chatcmpl-MOCKmockMOCKmockMOCKmockMOCKmock';

export function splitText(s: string, size = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Qwen3.5/3.6 XML tool-call text form. */
export function qwenXmlToolCall(name: string, args: Record<string, unknown>): string {
  const params = Object.entries(args)
    .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>\n`)
    .join('');
  return `<tool_call>\n<function=${name}>\n${params}</function>\n</tool_call>`;
}

/** Hermes JSON tool-call text form. */
export function hermesToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
}

/** Last user message text of a chat request (handy for match functions). */
export function lastUserText(req: MockRequest): string {
  const msgs = (req.body?.messages ?? []) as { role: string; content: unknown }[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: { type: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : '')).join('');
  }
  return '';
}

function randId(n = 32): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

export async function startMockLlm(initial: Partial<MockInfo> = {}): Promise<MockLlm> {
  const info: MockInfo = { modelId: 'mock-qwen3-uncensored', nCtx: 32768, vision: true, dialect: 'llamacpp', healthStatus: 200, ...initial };
  const queue: MockTurn[] = [];
  const routes: { match: (req: MockRequest) => boolean; responder: MockResponder }[] = [];
  let fallback: MockResponder = { text: 'OK' };
  const requests: MockRequest[] = [];
  const sockets = new Set<Socket>();
  const waiters: { n: number; resolve: () => void }[] = [];
  const state = { aborted: 0 };

  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      choices: [{ finish_reason: finish, index: 0, delta }],
      created: Math.floor(Date.now() / 1000),
      id: CHUNK_ID,
      model: info.modelId,
      system_fingerprint: 'b0000-mock',
      object: 'chat.completion.chunk',
      ...extra,
    });

  function pickTurn(req: MockRequest): MockTurn {
    for (const r of routes) {
      if (r.match(req)) return typeof r.responder === 'function' ? r.responder(req) : r.responder;
    }
    const idx = queue.findIndex((t) => !t.match || t.match(req));
    if (idx >= 0) return queue.splice(idx, 1)[0]!;
    return typeof fallback === 'function' ? fallback(req) : fallback;
  }

  function buildChunks(turn: MockTurn, req: MockRequest): string[] {
    const out: string[] = [];
    if (turn.progress) {
      const total = 100;
      out.push(chunk({ role: 'assistant', content: null }, null, { prompt_progress: { total, cache: 0, processed: 0, time_ms: 0 } }));
      out.push(chunk({ role: 'assistant', content: null }, null, { prompt_progress: { total, cache: 0, processed: total, time_ms: 5 } }));
    }
    out.push(chunk({ role: 'assistant', content: null }));
    let completion = 0;
    const reasoning = turn.reasoning === undefined ? [] : Array.isArray(turn.reasoning) ? turn.reasoning : splitText(turn.reasoning);
    for (const r of reasoning) { out.push(chunk({ reasoning_content: r })); completion++; }
    const text = turn.text === undefined ? [] : Array.isArray(turn.text) ? turn.text : splitText(turn.text);
    for (const t of text) { out.push(chunk({ content: t })); completion++; }
    (turn.toolCalls ?? []).forEach((tc, index) => {
      const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
      const first = args.startsWith('{') ? '{' : args.slice(0, 1);
      out.push(chunk({ tool_calls: [{ index, id: tc.id ?? randId(), type: 'function', function: { name: tc.name, arguments: first } }] }));
      for (const frag of splitText(args.slice(first.length), 6)) {
        out.push(chunk({ tool_calls: [{ index, function: { arguments: frag } }] }));
        completion++;
      }
    });
    if (turn.streamError) {
      out.push(JSON.stringify({ error: { code: turn.streamError.code ?? 500, message: turn.streamError.message, type: turn.streamError.type ?? 'server_error' } }));
      return out;
    }
    if (turn.endWithoutDone) return out;
    const finish = turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop');
    const promptTokens = Math.ceil(JSON.stringify(req.body?.messages ?? []).length / 3.6);
    const usage = turn.usage === undefined ? { prompt_tokens: promptTokens, completion_tokens: completion } : turn.usage;
    const timings = { cache_n: 0, prompt_n: usage?.prompt_tokens ?? promptTokens, prompt_ms: 1, predicted_n: usage?.completion_tokens ?? completion, predicted_ms: 1 };
    if (usage === null) {
      out.push(chunk({}, finish, { timings }));
    } else {
      out.push(chunk({}, finish));
      out.push(JSON.stringify({
        choices: [], created: Math.floor(Date.now() / 1000), id: CHUNK_ID, model: info.modelId, system_fingerprint: 'b0000-mock',
        object: 'chat.completion.chunk', usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens, prompt_tokens_details: { cached_tokens: 0 } }, timings,
      }));
    }
    out.push('[DONE]');
    return out;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function handleChat(req: MockRequest, res: ServerResponse): Promise<void> {
    const turn = pickTurn(req);
    if (turn.initialDelayMs) await sleep(turn.initialDelayMs);
    if (turn.httpError) {
      const body = JSON.stringify(turn.httpError.body);
      res.writeHead(turn.httpError.status, { 'Content-Type': 'application/json; charset=utf-8', Server: 'llama.cpp' });
      res.end(body);
      return;
    }
    if (turn.json !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(turn.json));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close', Server: 'llama.cpp' });
    let closed = false;
    let finished = false;
    res.on('close', () => { closed = true; if (!finished) state.aborted++; });
    if (turn.raw !== undefined) {
      res.write(turn.raw);
      finished = true;
      res.end();
      return;
    }
    const chunks = buildChunks(turn, req);
    let n = 0;
    for (const c of chunks) {
      if (closed) return;
      if (turn.hangAfter !== undefined && n >= turn.hangAfter) {
        // keep the connection open until the client goes away
        await new Promise<void>((resolve) => res.on('close', () => resolve()));
        return;
      }
      res.write(`data: ${c}\n\n`);
      n++;
      if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
    }
    finished = true;
    res.end();
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(info.dialect === 'llamacpp' ? { Server: 'llama.cpp' } : {}) });
    res.end(JSON.stringify(body));
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method === 'GET') {
      if (path === '/health') {
        if (info.healthStatus === 200) return sendJson(res, 200, { status: 'ok' });
        return sendJson(res, info.healthStatus, { error: { code: info.healthStatus, message: 'Loading model', type: 'unavailable_error' } });
      }
      if (path === '/v1/models' || path === '/models') {
        const owned = info.dialect === 'llamacpp' ? 'llamacpp' : info.dialect === 'vllm' ? 'vllm' : 'organization-owner';
        const entry: Record<string, unknown> = { id: info.modelId, object: 'model', created: 1, owned_by: owned };
        if (info.dialect === 'llamacpp') {
          entry.meta = { n_ctx: info.nCtx, n_ctx_train: info.nCtx * 2 };
          entry.architecture = { input_modalities: info.vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] };
        }
        if (info.dialect === 'vllm') entry.max_model_len = info.nCtx;
        return sendJson(res, 200, { object: 'list', data: [entry] });
      }
      if (path === '/props' && info.dialect === 'llamacpp') {
        return sendJson(res, 200, {
          default_generation_settings: { n_ctx: info.nCtx, params: {} },
          total_slots: 4, model_alias: info.modelId, model_path: `C:\\models\\${info.modelId}.gguf`,
          modalities: { vision: info.vision, audio: false }, chat_template: '{%- if enable_thinking %}<think>{%- endif %}',
          chat_template_caps: { supports_tools: true }, build_info: 'b0000-mock',
        });
      }
      if (path === '/version' && info.dialect === 'vllm') return sendJson(res, 200, { version: '0.11.0' });
      if (path === '/slots' && info.dialect === 'llamacpp') return sendJson(res, 200, [{ id: 0, is_processing: false }]);
      return sendJson(res, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } });
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      const bufs: Buffer[] = [];
      req.on('data', (b: Buffer) => bufs.push(b));
      req.on('end', () => {
        const text = Buffer.concat(bufs).toString('utf8');
        let body: unknown = null;
        try { body = JSON.parse(text); } catch {
          return sendJson(res, 400, { error: { code: 400, message: '[json.exception.parse_error.101] parse error', type: 'invalid_request_error' } });
        }
        const mreq: MockRequest = { path, headers: req.headers, body };
        requests.push(mreq);
        for (const w of [...waiters]) if (requests.length >= w.n) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
        handleChat(mreq, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } });
      });
      return;
    }
    sendJson(res, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } });
  });
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get aborted() { return state.aborted; },
    enqueue: (...turns) => { queue.push(...turns); },
    route: (match, responder) => { routes.push({ match, responder }); },
    setFallback: (r) => { fallback = r; },
    setInfo: (i) => { Object.assign(info, i); },
    remaining: () => queue.length,
    waitForRequests: (n, timeoutMs = 10_000) => new Promise<void>((resolve, reject) => {
      if (requests.length >= n) { resolve(); return; }
      const t = setTimeout(() => reject(new Error(`mock-llm: timed out waiting for ${n} requests (got ${requests.length})`)), timeoutMs);
      waiters.push({ n, resolve: () => { clearTimeout(t); resolve(); } });
    }),
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  } as MockLlm;
}
