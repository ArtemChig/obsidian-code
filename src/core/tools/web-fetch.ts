import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool, fail, ok, type ToolContext, type ToolResultPayload } from './types';
import { decodeBody, fetchBytes, friendlyFetchError } from './lib/http';
import { htmlToMarkdown } from './lib/html';
import { extractPdfText } from './lib/pdf';
import { truncateEnd } from './lib/text';
import { looksBinary } from './lib/textfile';
import { canonicalHost, normalizeUrl, privateResolutionError } from './lib/url';

type WebFetchInput = { url: string; prompt?: string };

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const EXTRACT_THRESHOLD = 12_000;
const EXTRACT_INPUT_MAX = 48_000;

interface CacheEntry {
  url: string;
  finalUrl: string;
  fetchedAt: number;
  title: string;
  markdown: string;
  bytes: number;
  contentType: string;
  truncated: boolean;
}

export { normalizeUrl };

function cacheFile(ctx: ToolContext, url: string): string {
  return path.join(ctx.dataDir, 'webcache', `${createHash('sha256').update(url).digest('hex').slice(0, 40)}.json`);
}

async function readCache(ctx: ToolContext, url: string): Promise<CacheEntry | null> {
  try {
    const entry = JSON.parse(await fs.readFile(cacheFile(ctx, url), 'utf8')) as CacheEntry;
    if (Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry;
  } catch { /* miss */ }
  return null;
}

async function writeCache(ctx: ToolContext, url: string, entry: CacheEntry): Promise<void> {
  try {
    const file = cacheFile(ctx, url);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entry));
  } catch { /* cache is best-effort */ }
}

function budget(ctx: ToolContext): number {
  const n = ctx.settings?.maxToolOutputChars;
  return typeof n === 'number' && n > 1000 ? n : 30000;
}

async function answer(ctx: ToolContext, entry: CacheEntry, prompt: string | undefined): Promise<ToolResultPayload> {
  const display = { kind: 'web' as const, url: entry.finalUrl, title: entry.title || undefined, bytes: entry.bytes };
  const header = `Fetched ${entry.finalUrl}${entry.title ? ` — ${entry.title}` : ''}`;
  const md = entry.markdown;

  if (prompt && md.length > EXTRACT_THRESHOLD) {
    const clipped = md.length > EXTRACT_INPUT_MAX;
    try {
      const text = await ctx.complete(
        `Web page: ${entry.finalUrl}${entry.title ? ` (${entry.title})` : ''}\n\n--- PAGE CONTENT ---\n${clipped ? md.slice(0, EXTRACT_INPUT_MAX) : md}\n--- END OF PAGE CONTENT ---\n\n` +
          `Task: ${prompt}\n\nAnswer using only the page content above. Be concise and exact: keep names, numbers, commands and code verbatim. If the page does not contain the answer, say so.`,
        { maxTokens: 1500, system: 'You extract information from web pages for another AI assistant. Use only the supplied page content.' },
      );
      if (text.trim()) {
        return ok(`${header}\n\n${text.trim()}${clipped ? '\n\n(Note: the page was longer than the extraction window; only its first part was considered.)' : ''}`, { display });
      }
    } catch (e) {
      if (ctx.signal?.aborted) return fail('Interrupted by user.');
      // fall through: return the raw (truncated) content instead
      const note = `(Automatic extraction failed: ${e instanceof Error ? e.message : String(e)}. Returning the page content instead.)\n\n`;
      return ok(`${header}\n\n${note}${truncateEnd(md, budget(ctx), '… [content truncated]')}`, { display });
    }
  }
  const limit = budget(ctx);
  const body = md.length > limit ? `${md.slice(0, limit)}\n\n… [content truncated: ${md.length - limit} more characters. Call WebFetch again with a "prompt" to extract specific information, or fetch a more specific URL.]` : md;
  return ok(`${header}${entry.truncated ? ' (download truncated at 5 MB)' : ''}\n\n${body || '(the page has no readable text content)'}`, { display });
}

export const webFetchTool = defineTool<WebFetchInput>(
  {
    name: 'WebFetch',
    description:
      'Fetch a URL and return its main content as Markdown (http is upgraded to https; cached 15 min). For long pages pass prompt to get only what you need. ' +
      'If it redirects to another host, call again with the new URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        prompt: { type: 'string', description: 'What to extract from the page' },
      },
      required: ['url'],
    },
    concurrencySafe: true,
    permission: () => 'network',
    title: (i) => `Fetch ${i.url ?? ''}`.trim(),
    ruleFor: (i) => {
      const n = normalizeUrl(String(i.url ?? ''));
      return 'error' in n ? '' : `WebFetch(domain:${canonicalHost(n.original.hostname)})`;
    },

    async run(input, ctx) {
      const norm = normalizeUrl(input.url);
      if ('error' in norm) return fail(norm.error);
      const key = norm.url.href;

      const cached = await readCache(ctx, key);
      if (cached) return answer(ctx, cached, input.prompt);

      const rebind = await privateResolutionError(norm.url.hostname);
      if (rebind) return fail(rebind);

      let res;
      try {
        try {
          res = await fetchBytes(norm.url.href, { signal: ctx.signal, maxBytes: MAX_BYTES });
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          if (norm.url.protocol !== norm.original.protocol) {
            // https upgrade failed: retry the URL exactly as given
            res = await fetchBytes(norm.original.href, { signal: ctx.signal, maxBytes: MAX_BYTES });
          } else throw e;
        }
      } catch (e) {
        if (ctx.signal?.aborted) return fail('Interrupted by user.');
        return fail(`Failed to fetch ${norm.url.href}: ${friendlyFetchError(e, 30_000)}`);
      }

      if (res.redirectTo) {
        return ok(`The URL redirected (HTTP ${res.status}) to a different host: ${res.redirectTo}\nTo follow it, call WebFetch again with that URL.`);
      }
      const ct = res.contentType.toLowerCase();
      if (res.status >= 400) {
        const snippet = ct.includes('text') || ct.includes('json') ? decodeBody(res.body, res.contentType).replace(/\s+/g, ' ').slice(0, 300) : '';
        return fail(`HTTP ${res.status} ${res.statusText} for ${res.url}${snippet ? `\n${snippet}` : ''}`);
      }

      let title = '';
      let markdown: string;
      if (ct.startsWith('image/')) {
        if (res.body.length > MAX_BYTES || res.truncated) return fail('Image is too large to return (max 5 MB).');
        return ok(`Fetched image ${res.url} (${res.contentType}, ${res.body.length} bytes) attached below.`, {
          images: [{ mediaType: ct.split(';')[0].trim(), data: res.body.toString('base64') }],
          display: { kind: 'web', url: res.url, bytes: res.body.length },
        });
      } else if (ct.includes('application/pdf') || res.body.subarray(0, 5).toString('latin1') === '%PDF-') {
        const pdf = extractPdfText(res.body);
        if (!pdf.usable) return fail(`Fetched a PDF (${res.url}) but could not extract text from it.`);
        markdown = pdf.text;
      } else if (ct.includes('html') || ct.includes('xhtml') || (!ct && /^\s*<(!doctype|html)/i.test(res.body.subarray(0, 200).toString('latin1')))) {
        const r = htmlToMarkdown(decodeBody(res.body, res.contentType), res.url);
        title = r.title;
        markdown = r.markdown;
      } else if (ct.includes('json')) {
        const text = decodeBody(res.body, res.contentType);
        try {
          markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(text), null, 2)}\n\`\`\``;
        } catch {
          markdown = text;
        }
      } else if (ct.startsWith('text/') || ct.includes('xml') || ct.includes('javascript') || ct.includes('yaml') || ct === '') {
        if (looksBinary(res.body)) return fail(`Unsupported binary content (${res.contentType || 'unknown type'}) at ${res.url}.`);
        markdown = decodeBody(res.body, res.contentType);
      } else {
        return fail(`Unsupported content type "${res.contentType}" at ${res.url}.`);
      }

      const entry: CacheEntry = {
        url: key,
        finalUrl: res.url,
        fetchedAt: Date.now(),
        title,
        markdown,
        bytes: res.body.length,
        contentType: res.contentType,
        truncated: res.truncated,
      };
      await writeCache(ctx, key, entry);
      return answer(ctx, entry, input.prompt);
    },
  },
  { aliases: { url: ['uri', 'link', 'href', 'website', 'page'], prompt: ['question', 'query', 'instructions'] } },
);
