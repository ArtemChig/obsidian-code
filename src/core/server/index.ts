// HTTP + WebSocket server of the core (owner: platform).
//   GET  /health            → { ok, name, version }               (no auth; reveals nothing)
//   GET  /ws?token=…        → WebSocket JSON-RPC + event push       (token required)
//   POST /rpc               → { method, params } → { result } | { error }   (token via ?token= or Bearer; for scripts)
// Listens on 127.0.0.1 only. Every bus event is broadcast to every connected client.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { CoreContext } from '../contracts';
import { subscribeAll } from './bus';
import { appVersion, createRpcHandlers, dispatchRpc, RpcError, type RpcHandlers } from './rpc';

export { createEventBus, subscribeAll, ALL_EVENT_NAMES, type EventBusImpl } from './bus';
export { createRpcHandlers, dispatchRpc, RpcError, type RpcHandlers } from './rpc';

const MAX_PAYLOAD = 64 * 1024 * 1024; // images can be large
const HEARTBEAT_MS = 30_000;

export interface ServerOptions {
  ctx: CoreContext;
  host?: string;
  /** 0 / undefined = random free port. */
  port?: number;
  /** Auth token; generated when omitted. */
  token?: string;
  /** Override the dispatch table (tests). */
  handlers?: RpcHandlers;
}

export interface ServerHandle {
  port: number;
  token: string;
  /** ws://127.0.0.1:PORT/ws?token=… */
  url: string;
  clientCount(): number;
  close(): Promise<void>;
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorPayload(err: unknown): { message: string; code?: string } {
  if (err instanceof RpcError) return err.code ? { message: err.message, code: err.code } : { message: err.message };
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? { message: err.message, code } : { message: err.message };
  }
  return { message: String(err) };
}

function safeStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => (typeof val === 'bigint' ? Number(val) : val));
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { ctx } = opts;
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? generateToken();
  const handlers = opts.handlers ?? createRpcHandlers(ctx);
  const version = appVersion();

  const call = async (method: unknown, params: unknown): Promise<unknown> => dispatchRpc(handlers, method as string, params);

  // ── HTTP
  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const text = safeStringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_PAYLOAD) {
          reject(new Error('Payload too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, name: 'obsidian-code', version });
      return;
    }
    if (url.pathname === '/rpc') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: 'Method not allowed' } });
        return;
      }
      const auth = req.headers.authorization;
      const given = url.searchParams.get('token') ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : null);
      if (!tokenMatches(token, given)) {
        sendJson(res, 401, { error: { message: 'Unauthorized' } });
        return;
      }
      void readBody(req)
        .then(async (text) => {
          let body: { method?: unknown; params?: unknown };
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            sendJson(res, 400, { error: { message: 'Invalid JSON' } });
            return;
          }
          try {
            const result = await call(body.method, body.params);
            sendJson(res, 200, { result: result ?? null });
          } catch (err) {
            sendJson(res, 200, { error: errorPayload(err) });
          }
        })
        .catch((err: unknown) => {
          if (!res.headersSent) sendJson(res, 400, { error: errorPayload(err) });
        });
      return;
    }
    sendJson(res, 404, { error: { message: 'Not found' } });
  });

  // ── WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const alive = new WeakMap<WebSocket, boolean>();

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!tokenMatches(token, url.searchParams.get('token'))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws: WebSocket, payload: unknown): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    let text: string;
    try {
      text = safeStringify(payload);
    } catch (err) {
      const id = (payload as { id?: unknown }).id;
      if (typeof id !== 'number') return;
      text = JSON.stringify({ id, error: { message: `Result not serializable: ${errorPayload(err).message}` } });
    }
    ws.send(text);
  };

  wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', (err) => console.error('[server] ws error:', err.message));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: { id?: unknown; method?: unknown; params?: unknown };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        send(ws, { id: -1, error: { message: 'Invalid JSON', code: 'parse_error' } });
        return;
      }
      const id = typeof msg?.id === 'number' ? msg.id : -1;
      void call(msg?.method, msg?.params).then(
        (result) => send(ws, { id, result: result ?? null }),
        (err: unknown) => send(ws, { id, error: errorPayload(err) }),
      );
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // ── event fan-out
  const unsubscribe = subscribeAll(ctx.bus, (event, data) => {
    if (wss.clients.size === 0) return;
    let text: string;
    try {
      text = safeStringify({ event, data });
    } catch (err) {
      console.error(`[server] event ${event} not serializable:`, errorPayload(err).message);
      return;
    }
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  });

  // ── listen
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(opts.port ?? 0, host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  httpServer.on('error', (err) => console.error('[server] http error:', err.message));
  const port = (httpServer.address() as AddressInfo).port;

  let closed: Promise<void> | null = null;
  return {
    port,
    token,
    url: `ws://${host}:${port}/ws?token=${token}`,
    clientCount: () => wss.clients.size,
    close() {
      if (closed) return closed;
      closed = (async () => {
        unsubscribe();
        clearInterval(heartbeat);
        for (const ws of wss.clients) {
          try {
            ws.close(1001, 'Core shutting down');
          } catch {
            /* ignore */
          }
        }
        const wssClosed = new Promise<void>((resolve) => wss.close(() => resolve()));
        // give clients a moment to complete the close handshake, then drop the rest
        await Promise.race([wssClosed, new Promise((r) => setTimeout(r, 500))]);
        for (const ws of wss.clients) ws.terminate();
        await wssClosed;
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections?.();
        });
      })();
      return closed;
    },
  };
}
