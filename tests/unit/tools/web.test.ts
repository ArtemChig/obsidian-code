import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeUrl, webFetchTool } from '../../../src/core/tools/web-fetch';
import { decodeDdgUrl, filterResults, parseBing, parseDuckDuckGo, parseDuckDuckGoLite, webSearchTool } from '../../../src/core/tools/web-search';
import { cleanupTempDirs, makeCtx, makeTempDir, OFFLINE } from './helpers';

afterAll(cleanupTempDirs);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const ARTICLE_HTML = `<!doctype html><html><head><title>Test Article Title</title><meta charset="utf-8">
<script>var tracking = "SHOULD_NOT_APPEAR";</script><style>.x{color:red}</style></head>
<body><nav><a href="/home">Home</a><a href="/about">About</a></nav>
<article><h1>Test Article Title</h1>
<p>This is the first paragraph of a reasonably long article about <strong>widgets</strong> and how they work in practice. It needs enough text for the readability heuristics to treat it as real content rather than boilerplate navigation.</p>
<p>The second paragraph links to <a href="/relative/page">a relative page</a> and to <a href="https://other.example/abs">an absolute page</a>, and includes <code>inline code</code>.</p>
<h2>Details</h2><ul><li>Alpha item</li><li>Beta item</li></ul>
<pre><code>const answer = 42;</code></pre>
<p>A closing paragraph with more words so that the article is comfortably above the minimum length threshold used by the extraction algorithm, which looks at text density and paragraph counts.</p>
<img src="/img/pic.png" alt="A diagram"></article>
<footer>Copyright junk footer</footer></body></html>`;

let server: http.Server;
let base: string;
let counters: Record<string, number> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    counters[url.pathname] = (counters[url.pathname] ?? 0) + 1;
    switch (url.pathname) {
      case '/article':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(ARTICLE_HTML);
      case '/count':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`hit ${counters['/count']}`);
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"a":1,"b":[1,2]}');
      case '/redirect-same':
        res.writeHead(302, { location: '/article' });
        return res.end();
      case '/redirect-cross':
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/article` });
        return res.end();
      case '/404':
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<html><body>Nothing here friend</body></html>');
      case '/slow':
        return void setTimeout(() => { res.writeHead(200); res.end('late'); }, 5000);
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('abcdefghi '.repeat(700_000)); // ~7 MB
      case '/long': {
        const paras = Array.from({ length: 150 }, (_, i) => `<p>Paragraph ${i + 1}: ${'lorem ipsum dolor sit amet consectetur '.repeat(6)}</p>`).join('');
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<html><head><title>Long page</title></head><body><article><h1>Long page</h1>${paras}</article></body></html>`);
      }
      case '/img.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      case '/ua':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(String(req.headers['user-agent']));
      case '/search': // SearXNG-style
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ results: [
          { title: 'Result One', url: 'https://one.example/a', content: 'first <b>snippet</b>' },
          { title: 'Result Two', url: 'https://two.example/b', content: 'second snippet' },
          { title: 'Blocked', url: 'https://spam.example/c', content: 'nope' },
        ], echo: { q: url.searchParams.get('q'), format: url.searchParams.get('format') } }));
      default:
        res.writeHead(404);
        return res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  counters = {};
  vi.unstubAllGlobals();
});

describe('WebFetch', () => {
  it('converts HTML to clean Markdown (main content only, absolute links)', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir);
    const r = await webFetchTool.run({ url: `${base}/article` }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Test Article Title');
    expect(r.content).toContain('first paragraph');
    expect(r.content).toContain('**widgets**');
    expect(r.content).toContain(`[a relative page](${base}/relative/page)`);
    expect(r.content).toContain('[an absolute page](https://other.example/abs)');
    expect(r.content).toContain('`inline code`');
    expect(r.content).toContain('- Alpha item');
    expect(r.content).toContain('const answer = 42;');
    expect(r.content).toContain('[image: A diagram]');
    expect(r.content).not.toContain('SHOULD_NOT_APPEAR');
    expect(r.content).not.toContain('color:red');
    expect(r.display).toMatchObject({ kind: 'web', url: `${base}/article`, title: 'Test Article Title' });
  });

  it('caches for 15 minutes in dataDir/webcache and refetches after expiry', async () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data dir');
    const ctx = makeCtx(dir, { dataDir });
    const a = await webFetchTool.run({ url: `${base}/count` }, ctx);
    const b = await webFetchTool.run({ url: `${base}/count` }, ctx);
    expect(a.content).toContain('hit 1');
    expect(b.content).toContain('hit 1');
    expect(counters['/count']).toBe(1);
    const cacheDir = path.join(dataDir, 'webcache');
    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    // age the entry past the TTL
    const file = path.join(cacheDir, files[0]);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.fetchedAt = Date.now() - 16 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(entry));
    const c = await webFetchTool.run({ url: `${base}/count` }, ctx);
    expect(c.content).toContain('hit 2');
  });

  it('follows same-host redirects and reports cross-host redirects', async () => {
    const ctx = makeCtx(makeTempDir());
    const same = await webFetchTool.run({ url: `${base}/redirect-same` }, ctx);
    expect(same.content).toContain('Test Article Title');
    expect(same.display).toMatchObject({ url: `${base}/article` });
    const cross = await webFetchTool.run({ url: `${base}/redirect-cross` }, ctx);
    expect(cross.isError).toBeFalsy();
    expect(cross.content).toContain('redirected');
    expect(cross.content).toContain(`http://localhost:${new URL(base).port}/article`);
  });

  it('handles JSON, plain text, images and HTTP errors', async () => {
    const ctx = makeCtx(makeTempDir());
    const json = await webFetchTool.run({ url: `${base}/json` }, ctx);
    expect(json.content).toContain('```json');
    expect(json.content).toContain('"b": [');
    const img = await webFetchTool.run({ url: `${base}/img.png` }, ctx);
    expect(img.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    const nf = await webFetchTool.run({ url: `${base}/404` }, ctx);
    expect(nf.isError).toBe(true);
    expect(nf.content).toContain('HTTP 404');
    expect(nf.content).toContain('Nothing here friend');
  });

  it('sends a browser user agent', async () => {
    const r = await webFetchTool.run({ url: `${base}/ua` }, makeCtx(makeTempDir()));
    expect(r.content).toContain('Mozilla/5.0');
    expect(r.content).toContain('Chrome');
  });

  it('caps downloads at 5 MB', async () => {
    const ctx = makeCtx(makeTempDir(), { settings: { maxToolOutputChars: 1_000_000_000 } });
    const r = await webFetchTool.run({ url: `${base}/big` }, ctx);
    expect(r.content).toContain('truncated at 5 MB');
    expect(r.content.length).toBeLessThan(5.3 * 1024 * 1024);
    expect(r.content.length).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('aborts on signal', async () => {
    const ctx = makeCtx(makeTempDir());
    const p = webFetchTool.run({ url: `${base}/slow` }, ctx);
    setTimeout(() => ctx.controller.abort(), 300);
    const t = Date.now();
    const r = await p;
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.isError).toBe(true);
  });

  it('extracts with ctx.complete only when a prompt is given and the page is long', async () => {
    const ctx = makeCtx(makeTempDir());
    const short = await webFetchTool.run({ url: `${base}/article`, prompt: 'what are the list items?' }, ctx);
    expect(ctx.completeCalls).toHaveLength(0);
    expect(short.content).toContain('Alpha item');

    const long = await webFetchTool.run({ url: `${base}/long`, prompt: 'Which paragraph mentions lorem?' }, ctx);
    expect(ctx.completeCalls).toHaveLength(1);
    expect(ctx.completeCalls[0]).toContain('Which paragraph mentions lorem?');
    expect(ctx.completeCalls[0]).toContain('Paragraph 1:');
    expect(long.content).toContain('EXTRACTED ANSWER');
    expect(long.content).not.toContain('Paragraph 2:');
    expect(long.display).toMatchObject({ kind: 'web' });
  });

  it('returns truncated content (with a hint) for long pages without a prompt, and falls back if extraction fails', async () => {
    const ctx = makeCtx(makeTempDir(), { settings: { maxToolOutputChars: 3000 } });
    const r = await webFetchTool.run({ url: `${base}/long` }, ctx);
    expect(ctx.completeCalls).toHaveLength(0);
    expect(r.content.length).toBeLessThan(3600);
    expect(r.content).toContain('content truncated');
    expect(r.content).toContain('prompt');

    ctx.completeImpl = async () => { throw new Error('model offline'); };
    const f = await webFetchTool.run({ url: `${base}/long`, prompt: 'anything' }, ctx);
    expect(f.isError).toBeFalsy();
    expect(f.content).toContain('extraction failed: model offline');
    expect(f.content).toContain('Paragraph 1:');
  });

  it('normalises URLs: https upgrade (except local hosts), missing scheme, bad schemes', () => {
    const up = normalizeUrl('http://example.com/a?b=1') as { url: URL };
    expect(up.url.href).toBe('https://example.com/a?b=1');
    expect((normalizeUrl('example.com/x') as { url: URL }).url.href).toBe('https://example.com/x');
    expect((normalizeUrl('http://localhost:3000/x') as { url: URL }).url.protocol).toBe('http:');
    expect((normalizeUrl('http://127.0.0.1:8080') as { url: URL }).url.protocol).toBe('http:');
    expect((normalizeUrl('http://192.168.1.5/') as { url: URL }).url.protocol).toBe('http:');
    expect(normalizeUrl('ftp://example.com')).toHaveProperty('error');
    expect(normalizeUrl('http://')).toHaveProperty('error');
  });

  it('declares network permission, domain rules and titles', () => {
    const c = { cwd: '.', settings: makeCtx('.').settings };
    expect(webFetchTool.permission({ url: 'https://a.b' }, c)).toBe('network');
    expect(webFetchTool.ruleFor?.({ url: 'https://docs.example.com/page?q=1' })).toBe('WebFetch(domain:docs.example.com)');
    expect(webFetchTool.ruleFor?.({ url: 'http://example.com/x' })).toBe('WebFetch(domain:example.com)');
    expect(webFetchTool.title({ url: 'https://a.b/c' })).toBe('Fetch https://a.b/c');
  });

  it('reports DNS/connection failures readably', async () => {
    const r = await webFetchTool.run({ url: 'http://127.0.0.1:1/never' }, makeCtx(makeTempDir()));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Failed to fetch/);
  });
});

const DDG_HTML = `<html><body><div class="serp__results"><div id="links" class="results">
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%26b%3D2&amp;rut=abc123">Example &amp; Co: <b>Page</b> One</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">This is the <b>first</b> snippet &amp; more text.</a>
  </div></div>
<div class="result results_links results_links_deep result--ad">
  <h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=zzz">Buy stuff now</a></h2>
  <a class="result__snippet">Sponsored</a></div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.docs.rs%2Fcrate%2Ffoo&amp;rut=def">foo - Rust</a></h2>
  <a class="result__snippet" href="x">Second snippet</a></div>
<div class="result web-result"><h2 class="result__title"><a class="result__a" href="https://direct.example/page">Direct link</a></h2></div>
</div></div></body></html>`;

const LITE_HTML = `<html><body><table>
<tr><td><a rel="nofollow" href="https://weather.example/orlando" class="result-link">Orlando Weather</a></td></tr>
<tr><td class="result-snippet">Current conditions in Orlando, FL.</td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwttr.in%2FOrlando&amp;rut=z" class="result-link">wttr.in Orlando</a></td></tr>
<tr><td class="result-snippet">Terminal weather.</td></tr>
</table></body></html>`;

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://www.weather.gov/mlb/">NWS Orlando</a></h2><div class="b_caption"><p>National Weather Service forecast.</p></div></li>
<li class="b_algo"><h2><a href="https://wttr.in/Orlando">wttr.in</a></h2><div class="b_caption"><p>Weather for Orlando.</p></div></li>
<li class="b_ad"><h2><a href="https://www.bing.com/ck/a?!&&u=aHR0cHM6Ly9hZC5leGFtcGxl">Ad</a></h2></li>
</ol></body></html>`;

describe('WebSearch (offline parsing and providers)', () => {
  it('parses DuckDuckGo HTML, decodes uddg redirects, skips ads', () => {
    const results = parseDuckDuckGo(DDG_HTML);
    expect(results).toEqual([
      { title: 'Example & Co: Page One', url: 'https://example.com/page?a=1&b=2', snippet: 'This is the first snippet & more text.' },
      { title: 'foo - Rust', url: 'https://www.docs.rs/crate/foo', snippet: 'Second snippet' },
      { title: 'Direct link', url: 'https://direct.example/page', snippet: undefined },
    ]);
  });

  it('decodes DuckDuckGo URLs', () => {
    expect(decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fx&rut=1')).toBe('https://a.com/x');
    expect(decodeDdgUrl('https://duckduckgo.com/y.js?ad=1')).toBeNull();
    expect(decodeDdgUrl('https://plain.example/z')).toBe('https://plain.example/z');
    expect(decodeDdgUrl('')).toBeNull();
    expect(decodeDdgUrl('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeNull();
  });

  it('filters by allowed and blocked domains (subdomains included)', () => {
    const rs = [
      { title: 'a', url: 'https://docs.rs/a' }, { title: 'b', url: 'https://www.example.com/b' },
      { title: 'c', url: 'https://sub.example.com/c' }, { title: 'd', url: 'https://other.org/d' },
    ];
    expect(filterResults(rs, ['example.com']).map((r) => r.title)).toEqual(['b', 'c']);
    expect(filterResults(rs, undefined, ['https://example.com/', 'docs.rs']).map((r) => r.title)).toEqual(['d']);
    expect(filterResults(rs, ['example.com'], ['sub.example.com']).map((r) => r.title)).toEqual(['b']);
  });

  it('DuckDuckGo default: markdown list + search display (fetch stubbed)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const r = await webSearchTool.run({ query: 'rust foo crate' }, makeCtx(makeTempDir()));
    expect(calls[0]).toBe('https://html.duckduckgo.com/html/?q=rust%20foo%20crate');
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('1. [Example & Co: Page One](https://example.com/page?a=1&b=2)\n   This is the first snippet & more text.');
    expect(r.content).toContain('2. [foo - Rust](https://www.docs.rs/crate/foo)');
    expect(r.display).toMatchObject({ kind: 'search', query: 'rust foo crate' });
    expect((r.display as { results: unknown[] }).results).toHaveLength(3);

    const filtered = await webSearchTool.run({ query: 'rust', blocked_domains: ['docs.rs'], allowed_domains: ['example.com', 'docs.rs'] }, makeCtx(makeTempDir()));
    expect(calls[1]).toContain(encodeURIComponent('(site:example.com OR site:docs.rs)'));
    expect(filtered.content).toContain('example.com/page');
    expect(filtered.content).not.toContain('docs.rs/crate');
  });

  it('reports bot-detection clearly after every free engine fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html><body><div class="anomaly-modal">unusual traffic</div></body></html>', { status: 202, headers: { 'content-type': 'text/html' } }));
    const r = await webSearchTool.run({ query: 'x' }, makeCtx(makeTempDir()));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('every free search engine failed');
    expect(r.content).toContain('Settings');
  });

  it('falls back to DuckDuckGo Lite when the HTML endpoint resets the connection', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://html.duckduckgo.com/')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      if (u.startsWith('https://lite.duckduckgo.com/')) return new Response(LITE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('', { status: 200 });
    });
    const r = await webSearchTool.run({ query: 'weather orlando' }, makeCtx(makeTempDir()));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('(DuckDuckGo Lite)');
    expect(r.content).toContain('[Orlando Weather](https://weather.example/orlando)');
    // the HTML endpoint was retried once (reset) then Lite was tried
    expect(calls.filter((c) => c.startsWith('https://html.duckduckgo.com/')).length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.startsWith('https://lite.duckduckgo.com/'))).toBe(true);
  });

  it('falls back to Bing when both DuckDuckGo endpoints return nothing', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('duckduckgo.com')) return new Response('<html><body>no results</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (u.startsWith('https://www.bing.com/')) return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('', { status: 200 });
    });
    const r = await webSearchTool.run({ query: 'orlando weather now' }, makeCtx(makeTempDir()));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('(Bing)');
    expect(r.content).toContain('[NWS Orlando](https://www.weather.gov/mlb/)');
  });

  it('parseDuckDuckGoLite and parseBing parse results and skip internal links', () => {
    const lite = parseDuckDuckGoLite(LITE_HTML);
    expect(lite[0]).toMatchObject({ title: 'Orlando Weather', url: 'https://weather.example/orlando' });
    const bing = parseBing(BING_HTML);
    expect(bing.map((b) => b.url)).toEqual(['https://www.weather.gov/mlb/', 'https://wttr.in/Orlando']);
    expect(bing.some((b) => b.url.includes('bing.com'))).toBe(false); // ck/a ad/redirect skipped
  });

  it('Brave: uses the subscription token header and parses results', async () => {
    let seen: { url: string; token: string | null } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url: String(url), token: init.headers['X-Subscription-Token'] ?? null };
      return new Response(JSON.stringify({ web: { results: [{ title: 'Brave <b>hit</b>', url: 'https://brave.example/x', description: 'desc <strong>bold</strong> &amp; more' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const ctx = makeCtx(makeTempDir(), { settings: { search: { provider: 'brave' } } });
    ctx.secrets['search.braveKey'] = 'BSA-secret';
    const r = await webSearchTool.run({ query: 'hello world' }, ctx);
    expect(seen?.url).toContain('https://api.search.brave.com/res/v1/web/search?q=hello%20world');
    expect(seen?.token).toBe('BSA-secret');
    expect(r.content).toContain('[Brave hit](https://brave.example/x)');
    expect(r.content).toContain('desc bold & more');
    expect(r.content).not.toContain('BSA-secret');
  });

  it('Tavily: bearer auth, domain filters passed natively', async () => {
    let seen: { url: string; auth: string; body: Record<string, unknown> } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string; method: string }) => {
      seen = { url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) };
      expect(init.method).toBe('POST');
      return new Response(JSON.stringify({ results: [{ title: 'T1', url: 'https://t.example/1', content: 'tavily content' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const ctx = makeCtx(makeTempDir(), { settings: { search: { provider: 'tavily' } } });
    ctx.secrets['search.tavilyKey'] = 'tvly-secret';
    const r = await webSearchTool.run({ query: 'q', allowed_domains: ['t.example'], blocked_domains: ['bad.example'] }, ctx);
    expect(seen?.url).toBe('https://api.tavily.com/search');
    expect(seen?.auth).toBe('Bearer tvly-secret');
    expect(seen?.body).toMatchObject({ query: 'q', include_domains: ['t.example'], exclude_domains: ['bad.example'] });
    expect(r.content).toContain('[T1](https://t.example/1)');
  });

  it('SearXNG: calls /search?format=json on the configured instance (local server)', async () => {
    const ctx = makeCtx(makeTempDir(), { settings: { search: { provider: 'searxng', searxngUrl: base } } });
    const r = await webSearchTool.run({ query: 'cats & dogs', blocked_domains: ['spam.example'] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('[Result One](https://one.example/a)\n   first snippet');
    expect(r.content).toContain('Result Two');
    expect(r.content).not.toContain('Blocked');
    expect(r.content).toContain('(SearXNG)');
  });

  it('falls back to DuckDuckGo with a note when the chosen provider is not configured', async () => {
    vi.stubGlobal('fetch', async () => new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    const ctx = makeCtx(makeTempDir(), { settings: { search: { provider: 'brave' } } });
    const r = await webSearchTool.run({ query: 'x' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('"brave" search provider is not configured');
    expect(r.content).toContain('Example & Co');
  });

  it('surfaces provider HTTP errors without leaking keys', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"quota exceeded"}', { status: 429, headers: { 'content-type': 'application/json' } }));
    const ctx = makeCtx(makeTempDir(), { settings: { search: { provider: 'brave' } } });
    ctx.secrets['search.braveKey'] = 'SECRETKEY';
    const r = await webSearchTool.run({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('429');
    expect(r.content).not.toContain('SECRETKEY');
  });

  it('validates input and declares permission/title', async () => {
    const ctx = makeCtx(makeTempDir());
    expect((await webSearchTool.run({ query: '  ' }, ctx)).isError).toBe(true);
    expect((await webSearchTool.run({} as never, ctx)).isError).toBe(true);
    const c = { cwd: '.', settings: ctx.settings };
    expect(webSearchTool.permission({ query: 'q' }, c)).toBe('network');
    expect(webSearchTool.title({ query: 'rust' })).toBe('Search: rust');
    expect(webSearchTool.ruleFor?.({ query: 'q' })).toBe('WebSearch');
  });
});

describe.skipIf(OFFLINE)('live web', () => {
  it('WebSearch .live DuckDuckGo returns results', async () => {
    const r = await webSearchTool.run({ query: 'Node.js documentation' }, makeCtx(makeTempDir()));
    if (r.isError && /refused|rate/i.test(r.content)) {
      console.warn('DuckDuckGo rate-limited this run:', r.content);
      return;
    }
    expect(r.isError).toBeFalsy();
    const results = (r.display as { results: { url: string }[] }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https?:\/\//);
    expect(results.every((x) => !x.url.includes('duckduckgo.com/l/'))).toBe(true);
  }, 40_000);

  it('WebFetch .live fetches https://example.com and upgrades http', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir);
    const r = await webFetchTool.run({ url: 'http://example.com' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Example Domain');
    expect((r.display as { url: string }).url).toMatch(/^https:\/\/example\.com/);
  }, 40_000);
});
