// Local Anthropic-compatibility shim between the Claude Code process and the session's model endpoint
// (docs/research/claude-agent-sdk.md §"Mid-conversation system messages").
//
// Claude Code points ANTHROPIC_BASE_URL at http://127.0.0.1:<port>/r/<routeId>; the shim forwards every request under
// that prefix to the route's upstream (local llama-server or the Vast tunnel) and nothing else, so:
//   * every model call of the harness (main turns, subagents, compaction, titles, WebFetch summaries) provably goes to
//     the session's own endpoint — the shim has no other upstream;
//   * the real endpoint API key never enters the Claude Code environment (the shim injects it);
//   * request bodies are adapted where llama.cpp differs from api.anthropic.com: Claude Code appends `role: "system"`
//     entries mid-conversation, which llama.cpp's chat templates reject (HTTP 500 "System message must be at the
//     beginning"); they are folded into the neighbouring user turn as <system-reminder> text.
// Responses (SSE) are piped through untouched.

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface ShimRoute {
  /** Upstream server root (with or without /v1). */
  baseUrl: string;
  apiKey?: string;
  /** Claude Code rejects model ids containing '/': it is given `alias`, the shim sends `id`. */
  model?: { alias: string; id: string };
}

/** A model id Claude Code accepts (no '/', which it reads as a provider prefix). */
export function modelAlias(id: string): string {
  return id.replace(/[\\/]+/g, '--');
}

export interface ShimRequestInfo {
  routeId: string;
  method: string;
  path: string;
  /** x-claude-code-request-class (main | subagent | compaction | auxiliary | workflow) when Claude Code sends it. */
  requestClass?: string;
  status?: number;
}

type Json = Record<string, unknown>;
type ContentBlock = Json & { type?: string };

function toBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === 'object') as ContentBlock[];
  return [];
}

function textOf(content: unknown): string {
  return toBlocks(content).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n\n');
}

/**
 * Fold `role: "system"` entries of an Anthropic Messages body into user turns (as <system-reminder> text) and merge
 * the resulting consecutive same-role turns. tool_result blocks stay first in a merged user turn (Anthropic + llama.cpp
 * pair them with the preceding tool_use). Returns the input object unchanged when there is nothing to fold.
 */
export function foldSystemMessages(body: Json): Json {
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.some((m) => m && (m as Json).role === 'system')) return body;
  const out: { role: string; content: ContentBlock[] }[] = [];
  for (const raw of messages as Json[]) {
    if (!raw || typeof raw !== 'object') continue;
    let role = String(raw.role ?? 'user');
    let blocks = toBlocks(raw.content);
    if (role === 'system') {
      const text = textOf(raw.content).trim();
      if (!text) continue;
      role = 'user';
      blocks = [{ type: 'text', text: text.startsWith('<system-reminder>') ? text : `<system-reminder>\n${text}\n</system-reminder>` }];
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      const all = [...prev.content, ...blocks];
      prev.content = role === 'user' ? [...all.filter((b) => b.type === 'tool_result'), ...all.filter((b) => b.type !== 'tool_result')] : all;
    } else {
      out.push({ role, content: blocks });
    }
  }
  return { ...body, messages: out };
}

/**
 * Anthropic semantics: no `thinking` (or type 'disabled') means no extended thinking. llama.cpp ignores the field and
 * applies the chat template's default (Qwen3.x thinks by default), so make "off" explicit via chat_template_kwargs.
 * Claude Code sends `thinking: {type: 'adaptive'}` on main turns when thinking is on; its side requests (compaction,
 * WebFetch summaries, titles) carry none and run without reasoning.
 */
export function applyThinking(body: Json): Json {
  const t = body.thinking as Json | undefined;
  const off = !t || t.type === 'disabled';
  if (!off || body.chat_template_kwargs !== undefined) return body;
  return { ...body, chat_template_kwargs: { enable_thinking: false } };
}

/** Map the model alias Claude Code was given (no '/') back to the served model id. */
export function applyModel(body: Json, model?: { alias: string; id: string }): Json {
  if (!model || body.model !== model.alias || model.alias === model.id) return body;
  return { ...body, model: model.id };
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'authorization', 'x-api-key', 'accept-encoding']);

export class AnthropicShim {
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private readonly routes = new Map<string, ShimRoute>();
  private readonly byKey = new Map<string, string>();
  /** Observer for tests/diagnostics. */
  onRequest?: (info: ShimRequestInfo) => void;

  /** Base URL for Claude Code (ANTHROPIC_BASE_URL) that forwards to `route`. Same route → same id. */
  async baseUrl(route: ShimRoute): Promise<string> {
    const port = await this.start();
    const upstream = route.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
    const key = `${upstream}\n${route.apiKey ?? ''}`;
    let id = this.byKey.get(key);
    if (!id) {
      id = randomBytes(9).toString('base64url');
      this.byKey.set(key, id);
      this.routes.set(id, { baseUrl: upstream, apiKey: route.apiKey, model: route.model });
    }
    return `http://127.0.0.1:${port}/r/${id}`;
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? (a as AddressInfo).port : 0;
  }

  private start(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    this.starting ??= new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => { void this.handle(req, res); });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        srv.unref();
        resolve((srv.address() as AddressInfo).port);
      });
    });
    return this.starting;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/r\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(req.url ?? '');
    const route = m ? this.routes.get(m[1]!) : undefined;
    if (!m || !route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"not_found_error","message":"unknown route"}}'); return; }
    const path = m[2] || '/';
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(path) && body.length) {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as Json;
        let next = applyModel(foldSystemMessages(parsed), route.model);
        if (!path.startsWith('/v1/messages/count_tokens')) next = applyThinking(next);
        if (next !== parsed) body = Buffer.from(JSON.stringify(next), 'utf8');
      } catch { /* not JSON: forward as is */ }
    }
    const info: ShimRequestInfo = { routeId: m[1]!, method: req.method ?? 'GET', path, requestClass: (req.headers['x-claude-code-request-class'] as string | undefined) || undefined };
    const target = new URL(route.baseUrl + path);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase().startsWith('x-claude-code-')) continue;
      headers[k] = v;
    }
    if (route.apiKey) { headers.authorization = `Bearer ${route.apiKey}`; headers['x-api-key'] = route.apiKey; }
    headers['content-length'] = String(body.length);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const up = send({ hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search, method: req.method, headers }, (ur) => {
      info.status = ur.statusCode;
      try { this.onRequest?.(info); } catch { /* observer */ }
      const h = { ...ur.headers };
      delete h.connection; delete h['keep-alive'];
      res.writeHead(ur.statusCode ?? 502, h);
      ur.pipe(res);
    });
    up.on('error', (e) => {
      info.status = 502;
      try { this.onRequest?.(info); } catch { /* observer */ }
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Model endpoint unreachable (${route.baseUrl}): ${e.message}` } }));
    });
    // the client went away (interrupt): stop the upstream generation too
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.end(body);
  }

  close(): void {
    try { this.server?.close(); } catch { /* ignore */ }
    this.server = null;
    this.starting = null;
  }
}
