// Hugging Face hub client for the model browser (owner: gpu).
//
// Anonymous, read-only use of the public API (no token is ever sent):
//   search   GET /api/models?search=<q>&filter=gguf&sort=<s>&direction=-1&limit=<n>&full=true[&cursor=<c>]
//            -> hits carry `siblings` (file NAMES only, no sizes), tags, downloads, likes. No `gguf` / `cardData`.
//   details  GET /api/models/<owner>/<repo>?blobs=true
//            -> siblings with sizes, `gguf` {total (parameters), architecture, context_length, ...}, `cardData`.
//   Pagination is a `Link: <...&cursor=...>; rel="next"` header; only the cursor is taken from it.
//   An unknown, private or gated repo answers 401 ("Invalid username or password.") to an anonymous caller, not 404.
//
// Responses are cached in memory (default 10 min), identical in-flight requests share one fetch, every request has a
// timeout (default 15 s) and HTTP 429 / 5xx / network failures become a HubError with a message fit to show the user.
// When a refresh fails and an older answer for the same request exists, that answer is returned with `stale: true`.
// `fetch`, the clock and all timings are injectable for tests.

import {
  HUB_PIPELINE_TAGS,
  HUB_SORTS,
  type HubErrorCode,
  type HubModelDetail,
  type HubModelSummary,
  type HubSearchParams,
  type HubSearchResult,
  type HubSort,
} from '../../shared/hub';
import { isValidRepoId, parseModelDetail, parseModelSummary } from '../../shared/hub-parse';

// The parsing lives in src/shared/hub-parse.ts (the renderer's demo mode runs the same code); re-exported here.
export * from '../../shared/hub-parse';

export const HF_BASE_URL = 'https://huggingface.co';
export const HUB_CACHE_TTL_MS = 10 * 60_000;
export const HUB_TIMEOUT_MS = 15_000;
export const HUB_DEFAULT_LIMIT = 30;
export const HUB_MAX_LIMIT = 100;
const MAX_CACHE_ENTRIES = 200;

// ───────────────────────────── Errors ─────────────────────────────

export class HubError extends Error {
  readonly code: HubErrorCode;
  readonly status?: number;
  /** Seconds until Hugging Face allows requests again (rate_limited only, when it said so). */
  readonly retryAfterSec?: number;

  constructor(code: HubErrorCode, message: string, extra: { status?: number; retryAfterSec?: number; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'HubError';
    this.code = code;
    this.status = extra.status;
    this.retryAfterSec = extra.retryAfterSec;
  }
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  // `RateLimit: "api";r=0;t=28` = seconds until the window resets.
  const rl = /(?:^|;)\s*t=(\d+)/.exec(headers.get('ratelimit') ?? '');
  if (rl) return Number(rl[1]);
  return undefined;
}

function httpError(res: Response, what: { repo?: string }): HubError {
  const status = res.status;
  if (status === 429) {
    const retryAfterSec = retryAfterSeconds(res.headers);
    const when = retryAfterSec !== undefined ? `Try again in ${retryAfterSec < 90 ? `${Math.max(1, retryAfterSec)} s` : `${Math.ceil(retryAfterSec / 60)} min`}.` : 'Try again in a minute.';
    return new HubError('rate_limited', `Hugging Face is limiting requests right now. ${when}`, { status, retryAfterSec });
  }
  if (status >= 500) {
    return new HubError('server', `Hugging Face is having trouble right now (HTTP ${status}). Try again in a moment.`, { status });
  }
  if ((status === 401 || status === 403 || status === 404) && what.repo) {
    return new HubError('not_found', `Could not find "${what.repo}" on Hugging Face. It may be private, gated, renamed or deleted.`, { status });
  }
  return new HubError('bad_response', `Hugging Face rejected the request (HTTP ${status}).`, { status });
}

// ───────────────────────────── Client ─────────────────────────────

export interface HubClientOptions {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxCacheEntries?: number;
  /** Clock for cache expiry (tests). */
  now?: () => number;
}

interface CacheEntry {
  value: unknown;
  at: number;
}

const STALE_OK: ReadonlySet<HubErrorCode> = new Set(['rate_limited', 'server', 'network', 'timeout']);

export class HubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly ttl: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: HubClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.baseUrl = (opts.baseUrl ?? HF_BASE_URL).replace(/\/+$/, '');
    this.ttl = opts.cacheTtlMs ?? HUB_CACHE_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? HUB_TIMEOUT_MS;
    this.maxEntries = opts.maxCacheEntries ?? MAX_CACHE_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /** Drops every cached answer (the "refresh" button). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Search GGUF repos. `refresh` skips a fresh cache entry. */
  async search(params: HubSearchParams = {}, opts: { refresh?: boolean } = {}): Promise<HubSearchResult> {
    const q = new URLSearchParams();
    const query = (params.query ?? '').trim();
    if (query) q.set('search', query);
    q.set('filter', 'gguf');
    if (params.pipelineTag && HUB_PIPELINE_TAGS.includes(params.pipelineTag)) q.set('pipeline_tag', params.pipelineTag);
    q.set('sort', params.sort && HUB_SORTS.includes(params.sort) ? params.sort : ('downloads' satisfies HubSort));
    q.set('direction', '-1');
    const limit = Number.isFinite(params.limit) ? Math.min(HUB_MAX_LIMIT, Math.max(1, Math.floor(params.limit as number))) : HUB_DEFAULT_LIMIT;
    q.set('limit', String(limit));
    q.set('full', 'true');
    if (params.cursor) q.set('cursor', params.cursor);
    const path = `/api/models?${q.toString()}`;

    const r = await this.cached<{ models: HubModelSummary[]; nextCursor?: string }>(`search ${path}`, opts.refresh, async () => {
      const { json, headers } = await this.getJson(path, {});
      if (!Array.isArray(json)) throw new HubError('bad_response', 'Hugging Face returned an unexpected response.');
      const models = json.map(parseModelSummary).filter((m): m is HubModelSummary => m !== null);
      return { models, nextCursor: nextCursorFrom(headers) };
    });
    const res: HubSearchResult = { models: r.value.models, fetchedAt: r.at, cached: r.cached };
    if (r.value.nextCursor) res.nextCursor = r.value.nextCursor;
    if (r.stale) res.stale = true;
    return res;
  }

  /** One repo with file sizes, quant variants and GGUF header facts. */
  async details(repo: string, opts: { refresh?: boolean } = {}): Promise<HubModelDetail> {
    const ref = String(repo ?? '').trim();
    if (!isValidRepoId(ref)) {
      throw new HubError('invalid_repo', `"${ref}" is not a Hugging Face repo id. Use the form owner/name.`);
    }
    const [owner, name] = ref.split('/');
    const path = `/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?blobs=true`;
    const r = await this.cached<HubModelDetail>(`detail ${ref.toLowerCase()}`, opts.refresh, async () => {
      const { json } = await this.getJson(path, { repo: ref });
      const detail = parseModelDetail(json);
      if (!detail) throw new HubError('bad_response', 'Hugging Face returned an unexpected response.');
      return detail;
    });
    return r.value;
  }

  // ── internals ──

  private async cached<T>(
    key: string,
    refresh: boolean | undefined,
    load: () => Promise<T>,
  ): Promise<{ value: T; at: number; cached: boolean; stale: boolean }> {
    const hit = this.cache.get(key);
    if (hit && !refresh && this.now() - hit.at < this.ttl) {
      return { value: structuredClone(hit.value as T), at: hit.at, cached: true, stale: false };
    }
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      const value = await p;
      const at = this.now();
      this.store(key, { value, at });
      return { value: structuredClone(value), at, cached: false, stale: false };
    } catch (e) {
      if (hit && e instanceof HubError && STALE_OK.has(e.code)) {
        return { value: structuredClone(hit.value as T), at: hit.at, cached: true, stale: true };
      }
      throw e;
    }
  }

  private store(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async getJson(path: string, what: { repo?: string }): Promise<{ json: unknown; headers: Headers }> {
    const url = this.baseUrl + path;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new HubError('timeout', `Hugging Face did not answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} s. Try again.`));
      }, this.timeoutMs);
    });
    const work = (async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'obsidian-code' },
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new HubError('network', "Can't reach Hugging Face. Check your internet connection and try again.", { cause: e });
      }
      if (!res.ok) throw httpError(res, what);
      try {
        return { json: JSON.parse(await res.text()) as unknown, headers: res.headers };
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        throw new HubError('bad_response', 'Hugging Face returned an unexpected response.', { cause: e });
      }
    })();
    work.catch(() => undefined); // if the timeout wins, a late failure of the aborted request must not go unhandled
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** `Link: <https://huggingface.co/api/models?...&cursor=XYZ>; rel="next"` -> "XYZ" (only the cursor is trusted). */
function nextCursorFrom(headers: Headers): string | undefined {
  const link = headers.get('link');
  if (!link) return undefined;
  for (const part of link.split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (!m) continue;
    try {
      const c = new URL(m[1]).searchParams.get('cursor');
      if (c) return c;
    } catch {
      // not a URL: ignore
    }
  }
  return undefined;
}
