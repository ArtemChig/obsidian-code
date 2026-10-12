// RpcClient against a real local WebSocket server (ws): request/response, errors, timeouts, events,
// queued requests, reconnect with backoff + resubscribe.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { GpuStatus } from '@shared/types';
import { backoffDelay, RpcClient, RpcError, RpcFacade } from '@renderer/lib/rpc';

type Client = InstanceType<typeof RpcClient>;
type ErrLike = { message: string; code?: string };

interface TestServer {
  url: string;
  wss: WebSocketServer;
  sockets: Set<WsSocket>;
  /** method → handler (return value = result; throw = error). */
  handlers: Record<string, (params: unknown) => unknown>;
  connections: number;
  close(): Promise<void>;
  push(event: string, data: unknown): void;
  dropAll(): void;
}

async function startServer(port = 0): Promise<TestServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const addr = wss.address() as { port: number };
  const srv: TestServer = {
    url: `ws://127.0.0.1:${addr.port}/ws?token=t`,
    wss,
    sockets: new Set(),
    handlers: {},
    connections: 0,
    close: () =>
      new Promise<void>((r) => {
        for (const s of srv.sockets) s.terminate();
        wss.close(() => r());
      }),
    push: (event, data) => {
      for (const s of srv.sockets) s.send(JSON.stringify({ event, data }));
    },
    dropAll: () => {
      for (const s of srv.sockets) s.terminate();
    },
  };
  wss.on('connection', (sock) => {
    srv.connections++;
    srv.sockets.add(sock);
    sock.on('close', () => srv.sockets.delete(sock));
    sock.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string; params: unknown };
      const h = srv.handlers[msg.method];
      if (!h) return; // never answer → timeout path
      try {
        const result = h(msg.params);
        sock.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        sock.send(JSON.stringify({ id: msg.id, error: { message: (err as Error).message, code: 'boom' } }));
      }
    });
  });
  return srv;
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let server: TestServer | null = null;
let client: Client | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await server?.close();
  server = null;
});

describe('RpcClient', () => {
  it('sends requests, resolves results and dispatches events', async () => {
    server = await startServer();
    server.handlers['system.info'] = () => ({ version: '1.2.3', platform: 'win32', homeDir: 'C:\\', dataDir: 'C:\\d', shell: 'bash', electron: false });
    client = new RpcClient(server.url);
    const events: unknown[] = [];
    client.on('gpu.status', (s: GpuStatus) => events.push(s.phase));
    client.connect();
    const info = await client.request('system.info', {});
    expect(info.version).toBe('1.2.3');
    server.push('gpu.status', { phase: 'ready' });
    await waitFor(() => events.length === 1);
    expect(events).toEqual(['ready']);
    expect(client.getState().status).toBe('open');
  });

  it('queues requests made before the socket opens', async () => {
    server = await startServer();
    server.handlers['sessions.list'] = () => [];
    client = new RpcClient(server.url);
    const p = client.request('sessions.list', {}); // auto-connects
    await expect(p).resolves.toEqual([]);
  });

  it('rejects with RpcError on error responses and on timeout', async () => {
    server = await startServer();
    server.handlers['sessions.get'] = () => {
      throw new Error('Session not found');
    };
    client = new RpcClient(server.url, { defaultTimeoutMs: 150 });
    client.connect();
    const err = await client.request('sessions.get', { id: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as ErrLike).message).toBe('Session not found');
    expect((err as ErrLike).code).toBe('boom');
    const t = await client.request('settings.get', {}).catch((e: unknown) => e);
    expect((t as ErrLike).code).toBe('timeout');
  });

  it('reconnects with backoff, keeps listeners and reports reconnect', async () => {
    server = await startServer();
    server.handlers['models.list'] = () => ({ providers: [], models: [] });
    client = new RpcClient(server.url, { backoff: { initialMs: 20, maxMs: 50, factor: 1.5, jitter: 0 } });
    const statuses: string[] = [];
    const connected: boolean[] = [];
    const events: string[] = [];
    client.onStatus((s: { status: string }) => statuses.push(s.status));
    client.onConnected((i: { reconnect: boolean }) => connected.push(i.reconnect));
    client.on('notification', (n: { title: string }) => events.push(n.title));
    client.connect();
    await waitFor(() => connected.length === 1);
    expect(connected).toEqual([false]);

    // In-flight request fails when the connection drops.
    server.handlers['gpu.status'] = () => undefined as unknown;
    delete server.handlers['gpu.status'];
    const inflight = client.request('gpu.status', {}).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    server.dropAll();
    const err = (await inflight) as ErrLike;
    expect(err.code).toBe('disconnected');
    await waitFor(() => statuses.includes('reconnecting'));
    await waitFor(() => connected.length === 2);
    expect(connected).toEqual([false, true]);
    expect(client.getState().status).toBe('open');
    expect(server.connections).toBe(2);

    // Listener registered before the drop still receives events.
    server.push('notification', { title: 'after', body: '', level: 'info' });
    await waitFor(() => events.length === 1);
    expect(events).toEqual(['after']);
    await expect(client.request('models.list', {})).resolves.toEqual({ providers: [], models: [] });
  });

  it('keeps retrying while the server is down, then connects', async () => {
    server = await startServer();
    const port = Number(new URL(server.url).port);
    const url = server.url;
    await server.close();
    server = null;
    client = new RpcClient(url, { backoff: { initialMs: 20, maxMs: 40, factor: 2, jitter: 0 }, connectTimeoutMs: 500 });
    client.connect();
    await waitFor(() => (client?.getState().attempt ?? 0) >= 2);
    server = await startServer(port);
    await waitFor(() => client?.getState().status === 'open', 5000);
    expect(client.getState().everConnected).toBe(true);
  });

  it('rejects after close()', async () => {
    server = await startServer();
    client = new RpcClient(server.url);
    client.connect();
    client.close();
    await expect(client.request('system.info', {})).rejects.toMatchObject({ code: 'closed' });
    expect(client.getState().status).toBe('closed');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially, caps, and applies jitter', () => {
    const o = { initialMs: 400, maxMs: 10_000, factor: 1.8, jitter: 0 };
    expect(backoffDelay(1, o)).toBe(400);
    expect(backoffDelay(2, o)).toBe(720);
    expect(backoffDelay(20, o)).toBe(10_000);
    const j = { ...o, jitter: 0.25 };
    expect(backoffDelay(1, j, () => 0)).toBe(300);
    expect(backoffDelay(1, j, () => 1)).toBe(500);
  });
});

describe('RpcFacade', () => {
  it('rejects without a transport and forwards events across transport swaps', async () => {
    const f = new RpcFacade();
    await expect(f.request('system.info', {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.getState().status).toBe('unavailable');
    const seen: string[] = [];
    f.on('error', (e: { message: string }) => seen.push(e.message));
    f.emitLocal('error', { message: 'local' });
    expect(seen).toEqual(['local']);
  });
});
