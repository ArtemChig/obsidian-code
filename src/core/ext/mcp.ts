// MCP client manager: connects the servers from settings.mcpServers (stdio / streamable-http with SSE fallback /
// sse), exposes their tools as ToolDefs named mcp__<server>__<tool>, reconnects on settings change.
//
// stdio launch note: StdioClientTransport spawns through `cross-spawn`, which on Windows routes anything that is not
// a real .exe/.com (npx, npm, *.cmd, *.bat, unresolved names) through `cmd.exe /d /s /c` with correct escaping.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import treeKill from 'tree-kill';
import type { ToolDef } from '../contracts';
import type { McpServerConfig, ToolResultPayload } from '../../shared/types';
import { expandVars, splitArgs, truncate } from './util';
import type { ExtLogger } from './util';

export interface McpServerStatus {
  name: string;
  status: 'connecting' | 'connected' | 'error';
  transport: 'stdio' | 'http' | 'sse';
  toolCount: number;
  error?: string;
  /** Tool names as exposed to the model (mcp__server__tool). */
  tools: string[];
}

export interface McpManagerDeps {
  secret(name: string): string | null;
  log: ExtLogger;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  version?: string;
}

interface RawTool { name: string; title?: string; description?: string; inputSchema?: unknown }

interface Conn {
  /** Key in settings.mcpServers. */
  name: string;
  /** Sanitised, unique name used inside tool names. */
  safe: string;
  sig: string;
  cfg: McpServerConfig;
  transportKind: 'stdio' | 'http' | 'sse';
  status: 'connecting' | 'connected' | 'error';
  error?: string;
  client?: Client;
  pid?: number | null;
  stderrTail: string;
  tools: ToolDef[];
  closing: boolean;
  retries: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Cancels the connect attempt currently in flight (closes its client / kills its process). */
  abortAttempt?: () => Promise<void>;
}

const MAX_TOOL_NAME = 64;
const MAX_DESCRIPTION = 1000;

export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_') || '_';
}

/** mcp__<server>__<tool>, kept within 64 chars (OpenAI function-name limit) by shortening the tool part. */
export function mcpToolName(server: string, tool: string): string {
  const prefix = `mcp__${sanitizeName(server)}__`;
  const t = sanitizeName(tool);
  if (prefix.length + t.length <= MAX_TOOL_NAME) return prefix + t;
  const hash = createHash('sha1').update(`${server}\0${tool}`).digest('hex').slice(0, 6);
  const room = Math.max(1, MAX_TOOL_NAME - prefix.length - 7);
  return `${prefix}${t.slice(0, room)}_${hash}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s: Record<string, unknown> = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...(schema as Record<string, unknown>) } : {};
  delete s.$schema;
  s.type = 'object';
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  return s;
}

function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${text}\n${f}`;
}

function approxBase64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

/** MCP CallToolResult → ToolResultPayload (text / image / audio / resource / resource_link / structuredContent). */
export function convertCallToolResult(res: unknown): ToolResultPayload {
  const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
  const parts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  const items = Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : [];
  for (const item of items) {
    switch (item?.type) {
      case 'text':
        if (typeof item.text === 'string') parts.push(item.text);
        break;
      case 'image': {
        const data = typeof item.data === 'string' ? item.data : '';
        const mediaType = typeof item.mimeType === 'string' ? item.mimeType : 'image/png';
        if (data) images.push({ mediaType, data });
        parts.push(`[image returned: ${mediaType}]`);
        break;
      }
      case 'audio': {
        const data = typeof item.data === 'string' ? item.data : '';
        parts.push(`[audio returned: ${String(item.mimeType ?? 'audio')}, ${approxBase64Bytes(data)} bytes — not playable here]`);
        break;
      }
      case 'resource': {
        const rs = (item.resource ?? {}) as Record<string, unknown>;
        const uri = String(rs.uri ?? '');
        const mime = typeof rs.mimeType === 'string' ? rs.mimeType : undefined;
        if (typeof rs.text === 'string') {
          parts.push(`[Resource ${uri}${mime ? ` (${mime})` : ''}]\n${rs.text}`);
        } else if (typeof rs.blob === 'string') {
          if (mime?.startsWith('image/')) {
            images.push({ mediaType: mime, data: rs.blob });
            parts.push(`[image resource ${uri} (${mime})]`);
          } else {
            parts.push(`[Binary resource ${uri} (${mime ?? 'unknown type'}, ${approxBase64Bytes(rs.blob)} bytes) not shown]`);
          }
        }
        break;
      }
      case 'resource_link': {
        const label = String(item.name ?? item.uri ?? 'resource');
        parts.push(`[Resource link: ${label} -> ${String(item.uri ?? '')}${item.description ? ` — ${String(item.description)}` : ''}]`);
        break;
      }
      default:
        if (item) parts.push(JSON.stringify(item));
    }
  }
  let content = parts.join('\n').trim();
  if (!content && r.structuredContent !== undefined) content = JSON.stringify(r.structuredContent, null, 2);
  if (!content && r.toolResult !== undefined) content = typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult, null, 2);
  if (!content) content = images.length ? '' : '(no output)';
  const payload: ToolResultPayload = { content };
  if (r.isError === true) payload.isError = true;
  if (images.length) payload.images = images;
  if (content && !payload.isError) payload.display = { kind: 'markdown', markdown: fence(truncate(content, 20_000)) };
  return payload;
}

function titleFor(server: string, tool: string, input: Record<string, unknown>): string {
  for (const v of Object.values(input ?? {})) {
    if (typeof v === 'string' && v.trim()) return `${server}: ${tool} "${truncate(v.replace(/\s+/g, ' ').trim(), 48)}"`;
  }
  return `${server}: ${tool}`;
}

/**
 * Close a client. For stdio servers also tree-kill the process if it has not exited after a grace period: on Windows
 * the SDK terminates only the launcher (cmd.exe / npx) and would leave the real server behind.
 */
async function closeClientAndTree(client: Client, pid: number | null | undefined): Promise<void> {
  const killer = pid ? setTimeout(() => treeKill(pid, 'SIGKILL', () => undefined), 2500) : undefined;
  try {
    await withTimeout(client.close(), 6000, 'close');
  } catch {
    /* ignore */
  } finally {
    if (killer) clearTimeout(killer);
  }
}

export function createMcpManager(deps: McpManagerDeps) {
  const conns = new Map<string, Conn>();
  const connectTimeout = deps.connectTimeoutMs ?? 45_000;
  const toolTimeout = deps.toolTimeoutMs ?? 120_000;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();
  let cachedTools: ToolDef[] = [];

  const rebuild = (): void => {
    cachedTools = [...conns.values()].filter((c) => c.status === 'connected').flatMap((c) => c.tools);
  };

  function transportKindOf(cfg: McpServerConfig): 'stdio' | 'http' | 'sse' {
    if (cfg.type === 'http' || cfg.type === 'sse' || cfg.type === 'stdio') return cfg.type;
    return cfg.url && !cfg.command ? 'http' : 'stdio';
  }

  function expandAll(cfg: McpServerConfig): { command?: string; args: string[]; env: Record<string, string>; url?: string; headers: Record<string, string> } {
    const x = (s: string): string => expandVars(s, deps.secret);
    let command = cfg.command ? x(cfg.command) : undefined;
    let args = (cfg.args ?? []).map(x);
    // Tolerate "command": "npx -y pkg" written as one string.
    if (command && !args.length && /\s/.test(command.trim()) && !existsSync(command)) {
      const words = splitArgs(command);
      command = words[0];
      args = words.slice(1);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = x(String(v));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = x(String(v));
    return { command, args, env, url: cfg.url ? x(cfg.url) : undefined, headers };
  }

  function makeClient(conn: Conn): Client {
    return new Client(
      { name: 'obsidian-code', version: deps.version ?? '0.1.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error || !tools || conn.closing || conn.client === undefined) return;
              applyTools(conn, tools as RawTool[]);
            },
          },
        },
      },
    );
  }

  function applyTools(conn: Conn, raw: RawTool[]): void {
    const used = new Set<string>();
    conn.tools = raw.map((t) => {
      let name = mcpToolName(conn.safe, t.name);
      for (let i = 2; used.has(name); i++) name = mcpToolName(conn.safe, `${t.name}_${i}`);
      used.add(name);
      return buildToolDef(conn, t, name);
    });
    rebuild();
  }

  function buildToolDef(conn: Conn, t: RawTool, name: string): ToolDef {
    const desc = (t.description ?? t.title ?? '').replace(/\s+/g, ' ').trim() || `MCP tool ${t.name} from server ${conn.name}`;
    return {
      name,
      description: truncate(desc, MAX_DESCRIPTION),
      inputSchema: normalizeSchema(t.inputSchema),
      permission: () => 'exec',
      title: (input) => titleFor(conn.name, t.name, input),
      ruleFor: () => name,
      concurrencySafe: false,
      run: async (input, tctx) => {
        const client = conn.client;
        if (!client || conn.status !== 'connected') {
          return { content: `MCP server "${conn.name}" is not connected${conn.error ? `: ${conn.error}` : ''}. Check Settings → MCP servers.`, isError: true };
        }
        if (tctx.signal.aborted) return { content: 'Tool call was interrupted before it started.', isError: true };
        try {
          const res = await client.callTool({ name: t.name, arguments: input ?? {} }, undefined, {
            timeout: toolTimeout,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: 10 * 60_000,
            signal: tctx.signal,
            onprogress: (p) => {
              const frac = p.total ? `${p.progress}/${p.total}` : String(p.progress);
              tctx.progress(`${frac}${p.message ? ` ${p.message}` : ''}`);
            },
          });
          return convertCallToolResult(res);
        } catch (e) {
          if (tctx.signal.aborted) return { content: 'Tool call was interrupted.', isError: true };
          return { content: `MCP tool ${t.name} (server "${conn.name}") failed: ${errMessage(e)}`, isError: true };
        }
      },
    };
  }

  async function listAllTools(client: Client): Promise<RawTool[]> {
    const out: RawTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      out.push(...(res.tools as RawTool[]));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async function closeClient(conn: Conn): Promise<void> {
    const client = conn.client;
    const pid = conn.pid;
    conn.client = undefined;
    conn.pid = undefined;
    if (client) await closeClientAndTree(client, pid);
  }

  async function attempt(conn: Conn): Promise<void> {
    const x = expandAll(conn.cfg);
    const tryOnce = async (kind: 'stdio' | 'streamable' | 'sse'): Promise<{ client: Client; pid: number | null }> => {
      const client = makeClient(conn);
      let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
      if (kind === 'stdio') {
        if (!x.command) throw new Error('no "command" configured for stdio server');
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
        Object.assign(env, x.env);
        const t = new StdioClientTransport({ command: x.command, args: x.args, env, stderr: 'pipe' });
        t.stderr?.on('data', (chunk: Buffer) => {
          conn.stderrTail = (conn.stderrTail + chunk.toString('utf8')).slice(-4000);
        });
        transport = t;
      } else {
        if (!x.url) throw new Error('no "url" configured for remote server');
        const url = new URL(x.url);
        const requestInit: RequestInit = Object.keys(x.headers).length ? { headers: x.headers } : {};
        transport = kind === 'streamable' ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit });
      }
      client.onclose = () => onUnexpectedClose(conn, client);
      client.onerror = (e) => deps.log.warn(`mcp ${conn.name}: ${errMessage(e)}`);
      const pidOf = (): number | null => (transport instanceof StdioClientTransport ? transport.pid : null);
      conn.abortAttempt = () => closeClientAndTree(client, pidOf());
      try {
        await withTimeout(client.connect(transport), connectTimeout, `connecting to MCP server "${conn.name}"`, () => {
          void closeClientAndTree(client, pidOf());
        });
      } catch (e) {
        void closeClientAndTree(client, pidOf());
        throw e;
      } finally {
        conn.abortAttempt = undefined;
      }
      return { client, pid: pidOf() };
    };

    conn.stderrTail = '';
    let result: { client: Client; pid: number | null };
    if (conn.transportKind === 'stdio') {
      result = await tryOnce('stdio');
    } else if (conn.transportKind === 'sse') {
      result = await tryOnce('sse');
    } else {
      try {
        result = await tryOnce('streamable');
      } catch (e1) {
        if (conn.closing || disposed) throw e1;
        deps.log.info(`mcp ${conn.name}: streamable HTTP failed (${errMessage(e1)}); trying SSE`);
        try {
          result = await tryOnce('sse');
        } catch (e2) {
          throw new Error(`Streamable HTTP: ${errMessage(e1)}; SSE fallback: ${errMessage(e2)}`);
        }
      }
    }

    if (conn.closing || disposed) {
      conn.client = result.client;
      conn.pid = result.pid;
      await closeClient(conn);
      return;
    }
    conn.client = result.client;
    conn.pid = result.pid;
    try {
      applyTools(conn, await withTimeout(listAllTools(result.client), 30_000, 'listing tools'));
    } catch (e) {
      await closeClient(conn);
      throw e;
    }
  }

  function connect(conn: Conn): Promise<void> {
    conn.status = 'connecting';
    conn.error = undefined;
    const p = attempt(conn).then(
      () => {
        if (conn.closing || disposed) return;
        conn.status = 'connected';
        conn.retries = 0;
        deps.log.info(`mcp ${conn.name}: connected (${conn.tools.length} tools)`);
        rebuild();
      },
      (e: unknown) => {
        if (conn.closing || disposed) return;
        const tail = conn.stderrTail.trim();
        conn.status = 'error';
        conn.error = errMessage(e) + (tail ? ` — server stderr: ${truncate(tail.slice(-500), 500)}` : '');
        conn.tools = [];
        deps.log.error(`mcp ${conn.name}: ${conn.error}`);
        rebuild();
      },
    );
    return p;
  }

  function onUnexpectedClose(conn: Conn, client: Client): void {
    if (conn.closing || disposed || conn.client !== client) return;
    conn.client = undefined;
    conn.pid = undefined;
    conn.status = 'error';
    conn.error = 'connection closed unexpectedly';
    conn.tools = [];
    rebuild();
    deps.log.warn(`mcp ${conn.name}: connection closed unexpectedly`);
    scheduleReconnect(conn);
  }

  function scheduleReconnect(conn: Conn): void {
    if (conn.closing || disposed || conn.retries >= 5) return;
    const delay = Math.min(30_000, 2000 * 2 ** conn.retries);
    conn.retries++;
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = undefined;
      if (conn.closing || disposed || conns.get(conn.name) !== conn) return;
      void connect(conn).then(() => {
        if (conn.status === 'error') scheduleReconnect(conn);
      });
    }, delay);
    conn.retryTimer.unref?.();
  }

  async function teardown(conn: Conn): Promise<void> {
    conn.closing = true;
    if (conn.retryTimer) clearTimeout(conn.retryTimer);
    conn.tools = [];
    const abort = conn.abortAttempt;
    if (abort) await abort();
    await closeClient(conn);
  }

  /**
   * Make the connected set match `servers` (enabled ones). The diff itself is serialised; the (possibly slow) connects
   * are not, so a hanging server never blocks a later settings change. Resolves when this call's connects finished.
   */
  function reconcile(servers: Record<string, McpServerConfig> | undefined): Promise<void> {
    const plan = (): Promise<void>[] => {
      if (disposed) return [];
      const wanted = new Map<string, McpServerConfig>();
      for (const [key, cfg] of Object.entries(servers ?? {})) {
        if (cfg && typeof cfg === 'object' && cfg.enabled !== false) wanted.set(key, cfg);
      }
      const pending: Promise<void>[] = [];
      const tearing = new Map<string, Promise<void>>();
      for (const [key, conn] of [...conns]) {
        const cfg = wanted.get(key);
        if (!cfg || JSON.stringify(cfg) !== conn.sig) {
          conns.delete(key);
          const t = teardown(conn);
          tearing.set(key, t);
          pending.push(t);
        }
      }
      const usedSafe = new Set([...conns.values()].map((c) => c.safe));
      for (const [key, cfg] of wanted) {
        if (conns.has(key)) continue;
        let safe = sanitizeName(key);
        for (let i = 2; usedSafe.has(safe); i++) safe = `${sanitizeName(key)}_${i}`;
        usedSafe.add(safe);
        const conn: Conn = {
          name: key,
          safe,
          sig: JSON.stringify(cfg),
          cfg,
          transportKind: transportKindOf(cfg),
          status: 'connecting',
          stderrTail: '',
          tools: [],
          closing: false,
          retries: 0,
        };
        conns.set(key, conn);
        // A changed server is only relaunched after its previous process is gone (exclusive resources, ports).
        const prior = tearing.get(key);
        pending.push(prior ? prior.then(() => connect(conn)) : connect(conn));
      }
      rebuild();
      return pending;
    };
    const planned = chain.then(plan);
    chain = planned.then(() => undefined, () => undefined);
    return planned.then((pending) => Promise.allSettled(pending)).then(() => undefined);
  }

  /** Drop and re-establish one server's connection (or all when no name is given). */
  async function reconnect(name?: string): Promise<void> {
    const targets = [...conns.values()].filter((c) => !name || c.name === name);
    await Promise.allSettled(
      targets.map(async (conn) => {
        if (conn.retryTimer) clearTimeout(conn.retryTimer);
        conn.retries = 0;
        await closeClient(conn);
        if (disposed || conn.closing || conns.get(conn.name) !== conn) return;
        conn.tools = [];
        rebuild();
        await connect(conn);
      }),
    );
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const all = [...conns.values()];
    conns.clear();
    cachedTools = [];
    await Promise.allSettled(all.map((c) => teardown(c)));
  }

  return {
    reconcile,
    reconnect,
    dispose,
    tools: (): ToolDef[] => cachedTools,
    status: (): McpServerStatus[] =>
      [...conns.values()].map((c) => ({
        name: c.name,
        status: c.status,
        transport: c.transportKind,
        toolCount: c.tools.length,
        tools: c.tools.map((t) => t.name),
        ...(c.error ? { error: c.error } : {}),
      })),
  };
}
