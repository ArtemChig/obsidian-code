// OpenAI-compatible streaming chat client (fetch + SSE). See docs/research/llama-server.md §8 and SPEC §4.1/§5b.

import type { ChatMessage, ChatRequest, Endpoint, LlmClient, LlmEvent } from '../contracts';
import { acquireSlot, authHeaders, detectDialect, endpointState, normalizeBaseUrl, type Dialect } from './dialect';
import { classifyHttpError, isLlmError, LlmError, offlineError } from './errors';
import { StreamParser } from './parser';
import { readSse } from './sse';

export interface LlmClientOptions {
  /** Abort if no bytes arrive for this long (default 120 s). */
  idleTimeoutMs?: number;
  /** Backoff delays for retryable failures before the first event (default [1000, 3000]). */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
  /** Prefill progress (llama.cpp return_progress) — informational. */
  onProgress?: (baseUrl: string, p: { total: number; cache: number; processed: number; timeMs: number }) => void;
  log?: (msg: string) => void;
}

export interface ExtendedLlmClient extends LlmClient {
  /** Build the exact request body that would be sent (for tests / debugging). */
  buildBody(req: ChatRequest, dialect: Dialect, opts?: { noExtras?: boolean }): Record<string, unknown>;
}

const DEFAULT_IDLE_MS = 120_000;

/** Ensure history is acceptable to strict templates: valid JSON tool args, reasoning per dialect. */
export function prepareMessages(messages: ChatMessage[], dialect: Dialect): ChatMessage[] {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
  return messages.map((m, i) => {
    if (m.role !== 'assistant') return m;
    const out: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: m.content };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        let args = tc.function.arguments;
        try { JSON.parse(args); } catch { args = '{}'; }
        return { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args } };
      });
      if (out.content === '') out.content = null;
    } else if (out.content == null) {
      out.content = '';
    }
    const keepReasoning = dialect === 'llamacpp' || (dialect === 'vllm' && i > lastUser);
    if (keepReasoning && m.reasoning_content) out.reasoning_content = m.reasoning_content;
    return out;
  });
}

function buildBody(req: ChatRequest, dialect: Dialect, opts: { noExtras?: boolean } = {}): Record<string, unknown> {
  const thinking = req.thinking ?? true;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: prepareMessages(req.messages, dialect),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools?.length) body.tools = req.tools;
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  const extras = !opts.noExtras;
  if (dialect === 'llamacpp' || dialect === 'vllm') {
    body.temperature = req.temperature ?? (thinking ? 0.6 : 0.7);
    body.top_p = req.topP ?? (thinking ? 0.95 : 0.8);
    if (extras) {
      body.top_k = 20;
      body.min_p = 0;
      body.presence_penalty = thinking ? 0.5 : 1.0;
      body.chat_template_kwargs = { enable_thinking: thinking };
      if (dialect === 'llamacpp') {
        body.reasoning_format = 'deepseek';
        body.return_progress = true;
        body.cache_prompt = true;
      }
    }
  } else {
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.topP != null) body.top_p = req.topP;
    if (extras && req.thinking !== undefined) body.chat_template_kwargs = { enable_thinking: thinking };
  }
  return body;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.6);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortedError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', on); resolve(); }, ms);
    const on = () => { clearTimeout(t); reject(abortedError()); };
    signal?.addEventListener('abort', on, { once: true });
  });
}

function abortedError(): LlmError {
  return new LlmError('The request was aborted.', { kind: 'aborted', retryable: false });
}

export function createLlmClient(options: LlmClientOptions = {}): ExtendedLlmClient {
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const retryDelays = options.retryDelaysMs ?? [1000, 3000];
  const fetchImpl = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function* attempt(endpoint: Endpoint, req: ChatRequest, dialect: Dialect, emitted: { count: number }): AsyncGenerator<LlmEvent> {
    const root = normalizeBaseUrl(endpoint.baseUrl);
    const st = endpointState(root);
    const body = buildBody(req, dialect, { noExtras: st.noExtras });
    const ctrl = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, idleMs);
    };
    const onAbort = () => ctrl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted) ctrl.abort();
    arm();
    const fail = (e: unknown): never => {
      if (req.signal?.aborted) throw abortedError();
      if (timedOut) throw new LlmError(`The model server sent nothing for ${Math.round(idleMs / 1000)} s — giving up.`, { kind: 'timeout', retryable: false });
      if (isLlmError(e)) throw e;
      throw offlineError(root, e);
    };
    let res: Response;
    try {
      res = await fetchImpl(`${root}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(endpoint) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      return fail(e);
    }
    try {
      arm();
      const ctype = res.headers.get('content-type') ?? '';
      const parser = new StreamParser({
        tools: req.tools,
        thinkingRequested: req.thinking ?? true,
        thinkStartsOpen: st.thinkStartsOpen,
        onThinkStartsOpen: () => { st.thinkStartsOpen = true; },
        onProgress: options.onProgress ? (p) => options.onProgress!(root, p) : undefined,
      });
      if (!res.ok || !/text\/event-stream/i.test(ctype)) {
        let text = '';
        try { text = await res.text(); } catch (e) { fail(e); }
        if (!res.ok) throw classifyHttpError(res.status, text, root);
        // 200 but not SSE: a non-streaming completion
        let json: Record<string, unknown>;
        try { json = JSON.parse(text) as Record<string, unknown>; } catch {
          throw new LlmError(`The model server returned an unexpected response: ${text.slice(0, 200)}`, { kind: 'stream' });
        }
        for (const ev of parser.feed(json)) { emitted.count++; yield ev; }
        if (parser.finishReason == null) parser.finishReason = 'stop';
        for (const ev of finishWithUsage(parser, body)) { emitted.count++; yield ev; }
        return;
      }
      for await (const sse of readSse(res.body!, arm)) {
        if (req.signal?.aborted) throw abortedError();
        const events = parser.feedData(sse.data);
        for (const ev of events) { emitted.count++; yield ev; }
        if (parser.sawDone) break;
      }
      if (req.signal?.aborted) throw abortedError();
      if (timedOut) fail(new Error('timeout'));
      for (const ev of finishWithUsage(parser, body)) { emitted.count++; yield ev; }
    } catch (e) {
      fail(e);
    } finally {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      // closing the controller closes the HTTP connection (server stops generating within ~0.5 s)
      ctrl.abort();
    }
  }

  function finishWithUsage(parser: StreamParser, body: Record<string, unknown>): LlmEvent[] {
    const events = parser.finish();
    const done = events[events.length - 1];
    if (done && done.type === 'done' && !done.usage) {
      const promptChars = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length;
      done.usage = { promptTokens: estimateTokens(promptChars), completionTokens: estimateTokens(parser.outputChars) };
    }
    return events;
  }

  async function* stream(endpoint: Endpoint, req: ChatRequest): AsyncGenerator<LlmEvent> {
    const root = normalizeBaseUrl(endpoint.baseUrl);
    const st = endpointState(root);
    if (req.signal?.aborted) throw abortedError();
    const dialect = st.dialect ?? (await detectDialect(endpoint, options.fetchImpl));
    let release: (() => void) | undefined;
    try {
      release = await acquireSlot(root, req.signal);
    } catch {
      throw abortedError();
    }
    try {
      let tries = 0;
      let extrasRetried = false;
      for (;;) {
        const emitted = { count: 0 };
        try {
          yield* attempt(endpoint, req, dialect, emitted);
          return;
        } catch (e) {
          if (!isLlmError(e)) throw e;
          if (e.kind === 'aborted') throw e;
          if (emitted.count > 0) throw e; // can't replay a partially delivered stream
          if (e.kind === 'unknown_field' && !st.noExtras && !extrasRetried) {
            st.noExtras = true;
            extrasRetried = true;
            options.log?.(`llm: ${root} rejected extra fields; retrying without them`);
            continue;
          }
          if (e.retryable && tries < retryDelays.length) {
            await sleep(retryDelays[tries]!, req.signal);
            tries++;
            continue;
          }
          throw e;
        }
      }
    } finally {
      release?.();
    }
  }

  return {
    stream,
    buildBody,
  };
}
