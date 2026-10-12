// Per-endpoint state shared by the LLM client and the model registry: server dialect (llamacpp / vllm / generic),
// learned quirks, and a concurrency limiter (docs/research/llama-server.md §8.1, SPEC §5b).

import type { Endpoint } from '../contracts';

export type Dialect = 'llamacpp' | 'vllm' | 'generic';

export interface EndpointState {
  dialect?: Dialect;
  detecting?: Promise<Dialect>;
  /** Strict endpoint: don't send non-standard body fields. */
  noExtras?: boolean;
  /** Template pre-fills `<think>`: content starts inside thinking. */
  thinkStartsOpen?: boolean;
  /** Max concurrent requests from us (local server is shared with another app). */
  maxConcurrent?: number;
  active: number;
  waiters: (() => void)[];
}

const states = new Map<string, EndpointState>();

/** Strip trailing slashes and one trailing `/v1`. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(u)) u = u.slice(0, -3);
  return u.replace(/\/+$/, '');
}

export function endpointState(baseUrl: string): EndpointState {
  const key = normalizeBaseUrl(baseUrl);
  let s = states.get(key);
  if (!s) { s = { active: 0, waiters: [] }; states.set(key, s); }
  return s;
}

export function setDialect(baseUrl: string, dialect: Dialect): void {
  endpointState(baseUrl).dialect = dialect;
}

export function getDialect(baseUrl: string): Dialect | undefined {
  return states.get(normalizeBaseUrl(baseUrl))?.dialect;
}

export function setMaxConcurrent(baseUrl: string, n: number | undefined): void {
  endpointState(baseUrl).maxConcurrent = n;
}

/** Test helper: forget everything learned about endpoints. */
export function resetEndpointStates(): void {
  states.clear();
}

export async function acquireSlot(baseUrl: string, signal?: AbortSignal): Promise<() => void> {
  const s = endpointState(baseUrl);
  const release = () => {
    s.active = Math.max(0, s.active - 1);
    const next = s.waiters.shift();
    if (next) next();
  };
  if (!s.maxConcurrent || s.active < s.maxConcurrent) {
    s.active++;
    return release;
  }
  await new Promise<void>((resolve, reject) => {
    const go = () => { signal?.removeEventListener('abort', onAbort); s.active++; resolve(); };
    const onAbort = () => {
      const i = s.waiters.indexOf(go);
      if (i >= 0) s.waiters.splice(i, 1);
      reject(signal?.reason ?? new Error('aborted'));
    };
    s.waiters.push(go);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return release;
}

export function authHeaders(endpoint: Endpoint): Record<string, string> {
  return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}

export async function fetchJson(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<{ status: number; json: unknown; headers: Headers } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { headers: { Accept: 'application/json', ...(opts.headers ?? {}) }, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, headers: res.headers };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Probe the endpoint once (cached). Network failures are not cached. */
export async function detectDialect(endpoint: Endpoint, fetchImpl?: typeof fetch): Promise<Dialect> {
  const s = endpointState(endpoint.baseUrl);
  if (s.dialect) return s.dialect;
  if (s.detecting) return s.detecting;
  const root = normalizeBaseUrl(endpoint.baseUrl);
  const headers = authHeaders(endpoint);
  s.detecting = (async (): Promise<Dialect> => {
    let reachable = false;
    const props = await fetchJson(`${root}/props`, { headers, timeoutMs: 3000, fetchImpl });
    if (props) {
      reachable = true;
      const j = props.json as Record<string, unknown> | null;
      if (props.status === 200 && j && (j.build_info !== undefined || j.default_generation_settings !== undefined)) return 'llamacpp';
      if (/llama\.cpp/i.test(props.headers.get('server') ?? '')) return 'llamacpp';
    }
    const models = await fetchJson(`${root}/v1/models`, { headers, timeoutMs: 4000, fetchImpl });
    if (models) {
      reachable = true;
      if (/llama\.cpp/i.test(models.headers.get('server') ?? '')) return 'llamacpp';
      const data = (models.json as { data?: { owned_by?: string; max_model_len?: number }[] } | null)?.data;
      if (Array.isArray(data)) {
        if (data.some((m) => m.owned_by === 'llamacpp')) return 'llamacpp';
        if (data.some((m) => m.owned_by === 'vllm' || typeof m.max_model_len === 'number')) return 'vllm';
      }
    }
    const version = await fetchJson(`${root}/version`, { headers, timeoutMs: 3000, fetchImpl });
    if (version) {
      reachable = true;
      const j = version.json as Record<string, unknown> | null;
      if (version.status === 200 && j && typeof j.version === 'string' && Object.keys(j).length <= 3) return 'vllm';
    }
    if (!reachable) throw new Error('unreachable');
    return 'generic';
  })();
  try {
    const d = await s.detecting;
    s.dialect = d;
    return d;
  } catch {
    return 'generic';
  } finally {
    s.detecting = undefined;
  }
}
