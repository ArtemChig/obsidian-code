// HTTP helper for WebFetch/WebSearch: browser UA, timeout + abort, size cap, manual same-host redirects.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** Follow redirects only when they stay on the same host (default true). Cross-host redirects are reported, not followed. */
  sameHostRedirectsOnly?: boolean;
}

export interface FetchResult {
  status: number;
  statusText: string;
  /** Final URL after same-host redirects. */
  url: string;
  contentType: string;
  body: Buffer;
  truncated: boolean;
  /** Set when the server redirected to a different host. */
  redirectTo?: string;
  headers: Headers;
}

function normHost(h: string): string {
  return h.toLowerCase().replace(/^www\./, '');
}

export function friendlyFetchError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return `Request timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (err?.name === 'AbortError') return 'Request was cancelled';
  const code = err?.cause?.code;
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'DNS lookup failed (host not found or no internet)';
    case 'ECONNREFUSED': return 'Connection refused';
    case 'ECONNRESET': return 'Connection reset by the server';
    case 'ETIMEDOUT': case 'UND_ERR_CONNECT_TIMEOUT': return 'Connection timed out';
    case 'CERT_HAS_EXPIRED': case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `TLS certificate problem (${code})`;
    default:
      return err?.cause?.message || err?.message || String(e);
  }
}

async function readBody(res: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    if (size + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { body: Buffer.concat(chunks), truncated };
}

export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);
  let current = url;
  let method = opts.method ?? 'GET';
  let body = opts.body;

  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(current, {
      method,
      body,
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, current).href;
      try { await res.body?.cancel(); } catch { /* ignore */ }
      const sameHost = normHost(new URL(next).hostname) === normHost(new URL(current).hostname);
      if (!sameHost && (opts.sameHostRedirectsOnly ?? true)) {
        return { status: res.status, statusText: res.statusText, url: current, contentType: '', body: Buffer.alloc(0), truncated: false, redirectTo: next, headers: res.headers };
      }
      current = next;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const { body: buf, truncated } = await readBody(res, maxBytes);
    return {
      status: res.status,
      statusText: res.statusText,
      url: current,
      contentType: res.headers.get('content-type') ?? '',
      body: buf,
      truncated,
      headers: res.headers,
    };
  }
  throw new Error('Too many redirects');
}

/** Decode with the charset from Content-Type / <meta charset>, defaulting to UTF-8. */
export function decodeBody(body: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
