// Typed LLM errors + HTTP error classification (docs/research/llama-server.md §5, §8.8).

export type LlmErrorKind =
  | 'offline'          // fetch failed / connection refused
  | 'loading'          // 503 / "Loading model" — retryable
  | 'context_overflow' // prompt exceeds the context window — the agent compacts and retries once
  | 'auth'             // 401 / 403
  | 'bad_request'      // other 4xx
  | 'bad_history'      // template / tool-argument errors (a bug in history building)
  | 'unknown_field'    // strict endpoint rejected a non-standard body field
  | 'server_error'     // other 5xx
  | 'timeout'          // idle timeout (no bytes for N seconds)
  | 'aborted'          // caller aborted
  | 'stream';          // stream ended unexpectedly / in-stream error

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly code?: string | number;
  readonly type?: string;
  readonly retryable: boolean;
  /** Extra numeric details when the server provides them (context overflow). */
  readonly promptTokens?: number;
  readonly contextLength?: number;

  constructor(
    message: string,
    opts: { kind: LlmErrorKind; status?: number; code?: string | number; type?: string; retryable?: boolean; promptTokens?: number; contextLength?: number },
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.type = opts.type;
    this.promptTokens = opts.promptTokens;
    this.contextLength = opts.contextLength;
    this.retryable = opts.retryable ?? (opts.kind === 'offline' || opts.kind === 'loading' || opts.kind === 'stream');
  }
}

export function isLlmError(e: unknown): e is LlmError {
  return e instanceof LlmError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'LlmError' && 'kind' in e);
}

export function isContextOverflow(e: unknown): boolean {
  return isLlmError(e) && e.kind === 'context_overflow';
}

const OVERFLOW_RE = /exceed_context_size_error|context_length_exceeded|maximum context length|context size|context window|too many tokens|prompt is too long|exceeds the available context/i;
const UNKNOWN_FIELD_RE = /unrecognized request argument|unknown (field|parameter|argument)|extra (fields|inputs) not permitted|additional properties|unexpected (keyword|field)|not allowed: (chat_template_kwargs|reasoning_format|return_progress|cache_prompt|top_k|min_p)/i;

/** Pull a human message out of an error body (JSON or text). */
export function errorMessageFromBody(text: string): { message: string; type?: string; code?: string | number; body?: Record<string, unknown> } {
  const trimmed = text.trim();
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const err = (j.error && typeof j.error === 'object' ? j.error : j) as Record<string, unknown>;
    let message = typeof err.message === 'string' ? err.message : typeof j.error === 'string' ? (j.error as string) : typeof j.detail === 'string' ? (j.detail as string) : trimmed;
    message = cleanServerMessage(message);
    return { message, type: typeof err.type === 'string' ? err.type : undefined, code: (err.code as string | number | undefined), body: err };
  } catch {
    return { message: cleanServerMessage(trimmed || 'empty response') };
  }
}

/** llama.cpp template errors carry a long Jinja trace — keep the useful tail. */
function cleanServerMessage(msg: string): string {
  const jinja = msg.indexOf('Jinja Exception:');
  if (jinja >= 0) return msg.slice(jinja).trim();
  const m = msg.trim();
  return m.length > 600 ? `${m.slice(0, 600)}…` : m;
}

/** Map an HTTP error response to a typed, readable LlmError. */
export function classifyHttpError(status: number, bodyText: string, baseUrl?: string): LlmError {
  const { message, type, code, body } = errorMessageFromBody(bodyText);
  const hay = `${type ?? ''} ${message}`;
  if (OVERFLOW_RE.test(hay)) {
    const n = body && typeof body.n_prompt_tokens === 'number' ? body.n_prompt_tokens : undefined;
    const c = body && typeof body.n_ctx === 'number' ? body.n_ctx : undefined;
    return new LlmError(
      `The conversation is too long for the model's context window${n && c ? ` (${n} > ${c} tokens)` : ''}.`,
      { kind: 'context_overflow', status, code, type, retryable: false, promptTokens: n, contextLength: c },
    );
  }
  if (status === 503 || /loading model/i.test(message)) {
    return new LlmError('The model server is still loading the model — try again in a moment.', { kind: 'loading', status, code, type });
  }
  if (status === 401 || status === 403) {
    return new LlmError(`The model server rejected the API key (HTTP ${status}). Check the key in Settings → Models.`, { kind: 'auth', status, code, type });
  }
  if (status === 400 && UNKNOWN_FIELD_RE.test(message)) {
    return new LlmError(`The endpoint rejected a request field: ${message}`, { kind: 'unknown_field', status, code, type });
  }
  if (status === 500 && /Jinja Exception|Failed to parse tool call arguments/i.test(message)) {
    return new LlmError(`The model server rejected the conversation format: ${message}`, { kind: 'bad_history', status, code, type });
  }
  if (status === 404) {
    return new LlmError(`The model endpoint was not found (HTTP 404${baseUrl ? ` at ${baseUrl}` : ''}): ${message}`, { kind: 'bad_request', status, code, type });
  }
  if (status >= 400 && status < 500) {
    return new LlmError(`The model server refused the request (HTTP ${status}): ${message}`, { kind: 'bad_request', status, code, type });
  }
  return new LlmError(`Model server error (HTTP ${status}): ${message}`, { kind: 'server_error', status, code, type, retryable: status === 502 || status === 504 });
}

/** Errors carried inside the SSE stream: `data: {"error":{…}}` or vLLM's `{"object":"error",…}`. */
export function classifyStreamError(obj: Record<string, unknown>): LlmError {
  const err = (obj.error && typeof obj.error === 'object' ? obj.error : obj) as Record<string, unknown>;
  const status = typeof err.code === 'number' ? err.code : 500;
  return classifyHttpError(status, JSON.stringify({ error: err }));
}

export function offlineError(baseUrl: string, cause?: unknown): LlmError {
  const detail = cause instanceof Error ? (cause as Error & { cause?: { code?: string } }).cause?.code ?? cause.message : '';
  return new LlmError(`Can't reach the model server at ${baseUrl}${detail ? ` (${detail})` : ''} — is it running?`, { kind: 'offline' });
}
