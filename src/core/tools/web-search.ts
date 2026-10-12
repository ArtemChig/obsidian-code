import { parseHTML } from 'linkedom';
import { defineTool, fail, ok, type ToolContext } from './types';
import { decodeBody, fetchBytes, friendlyFetchError } from './lib/http';

/* eslint-disable @typescript-eslint/no-explicit-any */

type WebSearchInput = { query: string; allowed_domains?: string[]; blocked_domains?: string[] };

export interface SearchResult { title: string; url: string; snippet?: string }

const MAX_RESULTS = 10;

// ───────────────────────────── helpers ─────────────────────────────

function clean(s: string | null | undefined): string {
  return String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function normDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function filterResults(results: SearchResult[], allowed?: string[], blocked?: string[]): SearchResult[] {
  const allow = (allowed ?? []).map(normDomain).filter(Boolean);
  const block = (blocked ?? []).map(normDomain).filter(Boolean);
  return results.filter((r) => {
    const h = hostOf(r.url);
    if (!h) return false;
    if (allow.length && !allow.some((d) => domainMatches(h, d))) return false;
    if (block.some((d) => domainMatches(h, d))) return false;
    return true;
  });
}

// ───────────────────────────── DuckDuckGo HTML ─────────────────────────────

/** Decode DuckDuckGo's redirect links (//duckduckgo.com/l/?uddg=<encoded>&rut=…). Returns null for ads/unusable links. */
export function decodeDdgUrl(href: string): string | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href, 'https://duckduckgo.com');
  } catch {
    return null;
  }
  if (u.hostname.endsWith('duckduckgo.com')) {
    if (u.pathname === '/l/' || u.pathname === '/l') {
      const target = u.searchParams.get('uddg');
      return target && /^https?:\/\//i.test(target) ? target : null;
    }
    return null; // ads (/y.js) and internal links
  }
  return /^https?:$/.test(u.protocol) ? u.href : null;
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  try {
    const { document } = parseHTML(html) as any;
    for (const el of document.querySelectorAll('.result')) {
      const cls = String(el.getAttribute('class') ?? '');
      if (cls.includes('result--ad')) continue;
      const a = el.querySelector('a.result__a');
      if (!a) continue;
      const url = decodeDdgUrl(a.getAttribute('href') ?? '');
      if (!url) continue;
      const title = clean(a.textContent);
      if (!title) continue;
      const snippet = clean(el.querySelector('.result__snippet')?.textContent);
      out.push({ title, url, snippet: snippet || undefined });
    }
  } catch { /* fall through to regex */ }
  if (out.length) return out;

  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = decodeDdgUrl(m[1].replace(/&amp;/g, '&'));
    if (!url) continue;
    const title = clean(m[2]);
    if (title) out.push({ title, url, snippet: clean(m[3]) || undefined });
  }
  return out;
}

async function searchDuckDuckGo(query: string, ctx: ToolContext): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  const headers = { Referer: 'https://html.duckduckgo.com/', Accept: 'text/html' };
  let res = await fetchBytes(`https://html.duckduckgo.com/html/?q=${q}`, { signal: ctx.signal, headers, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
  let html = decodeBody(res.body, res.contentType);
  let results = parseDuckDuckGo(html);
  const blocked = (h: string) => /anomaly|challenge-form|are you a human|unusual traffic/i.test(h);
  if (results.length === 0 && (res.status === 202 || res.status === 403 || res.status === 429 || blocked(html))) {
    // second attempt via POST, which DuckDuckGo's own form uses
    res = await fetchBytes('https://html.duckduckgo.com/html/', {
      signal: ctx.signal, headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, method: 'POST', body: `q=${q}&b=`, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024,
    });
    html = decodeBody(res.body, res.contentType);
    results = parseDuckDuckGo(html);
    if (results.length === 0 && (res.status !== 200 || blocked(html))) {
      throw new Error(`DuckDuckGo refused the request (HTTP ${res.status}; probably rate limiting or bot detection). Try again later, or configure Brave/Tavily/SearXNG in Settings → Web search.`);
    }
  }
  return results;
}

// ───────────────────────────── Brave / Tavily / SearXNG ─────────────────────────────

async function getJson(url: string, ctx: ToolContext, init: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string } = {}): Promise<any> {
  const res = await fetchBytes(url, { signal: ctx.signal, timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024, ...init, headers: { Accept: 'application/json', ...init.headers } });
  const text = decodeBody(res.body, res.contentType);
  if (res.status >= 400) {
    let detail = '';
    try { detail = JSON.stringify(JSON.parse(text)).slice(0, 200); } catch { detail = text.replace(/\s+/g, ' ').slice(0, 200); }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the server did not return JSON');
  }
}

async function searchBrave(query: string, key: string, ctx: ToolContext): Promise<SearchResult[]> {
  const data = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`, ctx, { headers: { 'X-Subscription-Token': key } });
  return (data?.web?.results ?? []).map((r: any) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.description) || undefined }));
}

async function searchTavily(query: string, key: string, ctx: ToolContext, allowed?: string[], blocked?: string[]): Promise<SearchResult[]> {
  const body: Record<string, unknown> = { query, max_results: MAX_RESULTS, search_depth: 'basic' };
  if (allowed?.length) body.include_domains = allowed.map(normDomain);
  if (blocked?.length) body.exclude_domains = blocked.map(normDomain);
  const data = await getJson('https://api.tavily.com/search', ctx, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (data?.results ?? []).map((r: any) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.content).slice(0, 400) || undefined }));
}

async function searchSearxng(query: string, baseUrl: string, ctx: ToolContext): Promise<SearchResult[]> {
  const u = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  const data = await getJson(u.href, ctx);
  return (data?.results ?? []).map((r: any) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.content).slice(0, 400) || undefined }));
}

// ───────────────────────────── tool ─────────────────────────────

export const webSearchTool = defineTool<WebSearchInput>(
  {
    name: 'WebSearch',
    description: 'Search the web for current information; returns up to 10 results (title, URL, snippet). Read a result with WebFetch.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains' },
      },
      required: ['query'],
    },
    concurrencySafe: true,
    permission: () => 'network',
    title: (i) => `Search: ${i.query ?? ''}`.trim(),
    ruleFor: () => 'WebSearch',

    async run(input, ctx) {
      const query = input.query.trim();
      if (!query) return fail('query must not be empty.');
      const provider = ctx.settings?.search?.provider ?? 'duckduckgo';
      let used: string = provider;
      const notes: string[] = [];

      let q = query;
      const allowed = input.allowed_domains?.filter(Boolean);
      if (allowed?.length && (provider === 'duckduckgo' || provider === 'brave')) {
        q += ` (${allowed.map((d) => `site:${normDomain(d)}`).join(' OR ')})`;
      }

      let results: SearchResult[];
      try {
        if (provider === 'brave' && ctx.secret('search.braveKey')) {
          results = await searchBrave(q, ctx.secret('search.braveKey')!, ctx);
        } else if (provider === 'tavily' && ctx.secret('search.tavilyKey')) {
          results = await searchTavily(query, ctx.secret('search.tavilyKey')!, ctx, allowed, input.blocked_domains);
        } else if (provider === 'searxng' && ctx.settings?.search?.searxngUrl) {
          results = await searchSearxng(query, ctx.settings.search.searxngUrl, ctx);
        } else {
          if (provider !== 'duckduckgo') {
            notes.push(`(The "${provider}" search provider is not configured${provider === 'searxng' ? ' (no SearXNG URL)' : ' (no API key)'}; used DuckDuckGo instead.)`);
          }
          used = 'duckduckgo';
          results = await searchDuckDuckGo(q, ctx);
        }
      } catch (e) {
        if (ctx.signal?.aborted) return fail('Interrupted by user.');
        return fail(`Web search failed (${used}): ${e instanceof Error && !(e as { cause?: unknown }).cause ? e.message : friendlyFetchError(e, 20_000)}`);
      }

      results = filterResults(results, allowed, input.blocked_domains).slice(0, MAX_RESULTS);
      const label = used === 'duckduckgo' ? 'DuckDuckGo' : used[0].toUpperCase() + used.slice(1);
      if (results.length === 0) {
        return ok(`No results found for "${query}" (${label}).${notes.length ? `\n${notes.join('\n')}` : ''}`, { display: { kind: 'search', query, results: [] } });
      }
      const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
      const list = results.map((r, i) => `${i + 1}. [${r.title}](${r.url})${r.snippet ? `\n   ${clip(r.snippet)}` : ''}`).join('\n');
      const content = `Search results for "${query}" (${label}):\n\n${list}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n\nUse WebFetch on a URL to read the page.`;
      return ok(content, { display: { kind: 'search', query, results } });
    },
  },
  { aliases: { query: ['q', 'search', 'search_query', 'keywords'], allowed_domains: ['domains', 'include_domains'], blocked_domains: ['exclude_domains'] } },
);
