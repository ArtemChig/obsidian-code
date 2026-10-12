// Typed JSON-RPC client for the core WebSocket (src/shared/protocol.ts). Owner: ui-foundation.
//
//   import { rpc } from '@renderer/lib/rpc';
//   const sessions = await rpc.request('sessions.list', {});
//   const off = rpc.on('gpu.status', (s) => …);
//
// `rpc` is a facade over the active transport: the real WebSocket client (RpcClient) or the demo transport
// (lib/demo.ts). Event listeners registered on the facade survive transport swaps and reconnects.
import type {
  CoreEventName,
  CoreEvents,
  RpcMethod,
  RpcParams,
  RpcResult,
} from '@shared/protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unavailable';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Reconnect attempt counter (0 while connected). */
  attempt: number;
  /** Epoch ms of the next reconnect attempt, when scheduled. */
  nextRetryAt: number | null;
  lastError: string | null;
  /** True once the first connection succeeded. */
  everConnected: boolean;
}

export interface RpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AnyEventListener = (event: CoreEventName, data: unknown) => void;

export interface RpcTransport {
  readonly kind: 'core' | 'demo';
  request<M extends RpcMethod>(method: M, params: RpcParams<M>, opts?: RpcRequestOptions): Promise<RpcResult<M>>;
  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void;
  onAny(fn: AnyEventListener): () => void;
  onStatus(fn: (s: ConnectionState) => void): () => void;
  /** Fires after each successful connection; reconnect=true for every connection after the first. */
  onConnected(fn: (info: { reconnect: boolean }) => void): () => void;
  getState(): ConnectionState;
  connect(): void;
  retryNow(): void;
  close(): void;
}

export class RpcError extends Error {
  readonly code?: string;
  readonly method?: string;
  constructor(message: string, code?: string, method?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.method = method;
  }
}

/** Human-readable message from anything thrown by rpc.request. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ───────────────────────────── Event hub ─────────────────────────────

export class EventHub {
  private byEvent = new Map<string, Set<(data: unknown) => void>>();
  private any = new Set<AnyEventListener>();

  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void {
    let set = this.byEvent.get(event);
    if (!set) {
      set = new Set();
      this.byEvent.set(event, set);
    }
    const f = fn as (data: unknown) => void;
    set.add(f);
    return () => {
      set.delete(f);
    };
  }

  onAny(fn: AnyEventListener): () => void {
    this.any.add(fn);
    return () => {
      this.any.delete(fn);
    };
  }

  emit(event: CoreEventName, data: unknown): void {
    const set = this.byEvent.get(event);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(data);
        } catch (err) {
          console.error(`[rpc] listener for "${event}" threw`, err);
        }
      }
    }
    for (const fn of [...this.any]) {
      try {
        fn(event, data);
      } catch (err) {
        console.error('[rpc] any-listener threw', err);
      }
    }
  }
}

class Listeners<T> {
  private set = new Set<(v: T) => void>();
  add(fn: (v: T) => void): () => void {
    this.set.add(fn);
    return () => {
      this.set.delete(fn);
    };
  }
  emit(v: T): void {
    for (const fn of [...this.set]) {
      try {
        fn(v);
      } catch (err) {
        console.error('[rpc] listener threw', err);
      }
    }
  }
}

// ───────────────────────────── WebSocket client ─────────────────────────────

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Per-method timeouts for slow operations. */
export const METHOD_TIMEOUTS: Partial<Record<RpcMethod, number>> = {
  'gpu.clockIn': 180_000,
  'gpu.clockOut': 180_000,
  'gpu.switchModel': 180_000,
  'gpu.destroyOrphans': 120_000,
  'gpu.offers': 60_000,
  'gpu.testKey': 60_000,
  'gpu.serverLog': 60_000,
  'models.refresh': 60_000,
  'chat.rewind': 60_000,
  'sessions.fork': 60_000,
  'files.search': 20_000,
};

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** 0..1 — random spread around the computed delay. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 400, maxMs: 10_000, factor: 1.8, jitter: 0.25 };

export function backoffDelay(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF, rand: () => number = Math.random): number {
  const base = Math.min(o.maxMs, o.initialMs * Math.pow(o.factor, Math.max(0, attempt - 1)));
  const spread = base * o.jitter;
  return Math.max(0, Math.round(base - spread + rand() * 2 * spread));
}

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

export type WebSocketFactory = (url: string) => WsLike;

export interface RpcClientOptions {
  /** Defaults to the global WebSocket (browser / Node 22+). */
  createSocket?: WebSocketFactory;
  defaultTimeoutMs?: number;
  backoff?: Partial<BackoffOptions>;
  /** Max time to wait for the socket to open before treating the attempt as failed. */
  connectTimeoutMs?: number;
}

interface PendingCall {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  payload: string;
  cleanup?: () => void;
}

const WS_OPEN = 1;

export class RpcClient implements RpcTransport {
  readonly kind = 'core' as const;
  private ws: WsLike | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private hub = new EventHub();
  private statusListeners = new Listeners<ConnectionState>();
  private connectedListeners = new Listeners<{ reconnect: boolean }>();
  private state: ConnectionState = { status: 'idle', attempt: 0, nextRetryAt: null, lastError: null, everConnected: false };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly backoff: BackoffOptions;
  private readonly createSocket: WebSocketFactory;
  private readonly defaultTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    readonly url: string,
    opts: RpcClientOptions = {},
  ) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
    this.createSocket =
      opts.createSocket ??
      ((u: string) => {
        const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket;
        if (!Ctor) throw new Error('WebSocket is not available in this environment');
        return new Ctor(u);
      });
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    this.statusListeners.emit(this.state);
  }

  onStatus(fn: (s: ConnectionState) => void): () => void {
    return this.statusListeners.add(fn);
  }

  onConnected(fn: (info: { reconnect: boolean }) => void): () => void {
    return this.connectedListeners.add(fn);
  }

  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void {
    return this.hub.on(event, fn);
  }

  onAny(fn: AnyEventListener): () => void {
    return this.hub.onAny(fn);
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.state.status === 'open' || this.state.status === 'connecting')) return;
    this.open();
  }

  retryNow(): void {
    if (this.closedByUser) this.closedByUser = false;
    if (this.state.status === 'open' || this.state.status === 'connecting') return;
    this.clearRetry();
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    this.clearRetry();
    this.clearConnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close(1000, 'client closed');
      } catch {
        /* ignore */
      }
    }
    this.failAll(new RpcError('Connection closed', 'closed'));
    this.setState({ status: 'closed', nextRetryAt: null });
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>, opts: RpcRequestOptions = {}): Promise<RpcResult<M>> {
    if (this.closedByUser) return Promise.reject(new RpcError('Connection closed', 'closed', method));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    const timeoutMs = opts.timeoutMs ?? METHOD_TIMEOUTS[method] ?? this.defaultTimeoutMs;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup?.();
        reject(new RpcError(`Request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout', method));
      }, timeoutMs);
      const call: PendingCall = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        sent: false,
        payload,
      };
      if (opts.signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new RpcError(`Request "${method}" aborted`, 'aborted', method));
        };
        if (opts.signal.aborted) {
          clearTimeout(timer);
          reject(new RpcError(`Request "${method}" aborted`, 'aborted', method));
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        call.cleanup = () => opts.signal?.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, call);
      this.trySend(id, call);
      if (!this.ws && this.state.status === 'idle') this.open();
    });
  }

  // ── internals

  private trySend(_id: number, call: PendingCall): void {
    if (call.sent || !this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(call.payload);
      call.sent = true;
    } catch {
      /* stays queued; flushed on next open */
    }
  }

  private flushQueue(): void {
    for (const [id, call] of this.pending) this.trySend(id, call);
  }

  private open(): void {
    this.clearConnectTimer();
    const reconnect = this.state.everConnected || this.state.attempt > 0;
    this.setState({ status: reconnect ? 'reconnecting' : 'connecting', nextRetryAt: null });
    let ws: WsLike;
    try {
      ws = this.createSocket(this.url);
    } catch (err) {
      this.setState({ lastError: errorMessage(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WS_OPEN) {
        this.setState({ lastError: 'Connection attempt timed out' });
        this.dropSocket(ws);
        this.scheduleReconnect();
      }
    }, this.connectTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      const wasReconnect = this.state.everConnected;
      this.setState({ status: 'open', attempt: 0, nextRetryAt: null, lastError: null, everConnected: true });
      this.flushQueue();
      this.connectedListeners.emit({ reconnect: wasReconnect });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleMessage(ev.data);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setState({ lastError: 'WebSocket error' });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.ws = null;
      const code = (ev as { code?: number } | undefined)?.code;
      if (code && code !== 1000 && code !== 1005) this.setState({ lastError: `Connection closed (code ${code})` });
      // In-flight calls will never get their response.
      for (const [id, call] of this.pending) {
        if (call.sent) {
          this.pending.delete(id);
          clearTimeout(call.timer);
          call.cleanup?.();
          call.reject(new RpcError(`Connection lost during "${call.method}"`, 'disconnected', call.method));
        }
      }
      if (this.closedByUser) {
        this.setState({ status: 'closed' });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private dropSocket(ws: WsLike): void {
    ws.onopen = ws.onclose = ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (this.ws === ws) this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.clearRetry();
    const attempt = this.state.attempt + 1;
    const delay = backoffDelay(attempt, this.backoff);
    this.setState({ status: 'reconnecting', attempt, nextRetryAt: Date.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private failAll(err: RpcError): void {
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.cleanup?.();
      call.reject(err);
    }
  }

  private handleMessage(raw: unknown): void {
    let msg: unknown;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      console.warn('[rpc] non-JSON message ignored');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { id?: unknown; result?: unknown; error?: { message?: string; code?: string }; event?: unknown; data?: unknown };
    if (typeof m.id === 'number') {
      const call = this.pending.get(m.id);
      if (!call) return;
      this.pending.delete(m.id);
      clearTimeout(call.timer);
      call.cleanup?.();
      if (m.error) call.reject(new RpcError(m.error.message ?? 'Unknown error', m.error.code, call.method));
      else call.resolve(m.result);
      return;
    }
    if (typeof m.event === 'string') {
      this.hub.emit(m.event as CoreEventName, m.data);
    }
  }
}

// ───────────────────────────── Facade (global `rpc`) ─────────────────────────────

const UNAVAILABLE: ConnectionState = { status: 'unavailable', attempt: 0, nextRetryAt: null, lastError: null, everConnected: false };

export class RpcFacade {
  private transport: RpcTransport | null = null;
  private unbind: (() => void)[] = [];
  private hub = new EventHub();
  private statusListeners = new Listeners<ConnectionState>();
  private connectedListeners = new Listeners<{ reconnect: boolean }>();

  /** Install the active transport (core client or demo). Listeners registered on the facade are kept. */
  setTransport(t: RpcTransport | null): void {
    for (const off of this.unbind) off();
    this.unbind = [];
    if (this.transport && this.transport !== t) {
      try {
        this.transport.close();
      } catch {
        /* ignore */
      }
    }
    this.transport = t;
    if (t) {
      this.unbind.push(
        t.onAny((event, data) => this.hub.emit(event, data)),
        t.onStatus((s) => this.statusListeners.emit(s)),
        t.onConnected((info) => this.connectedListeners.emit(info)),
      );
    }
    this.statusListeners.emit(this.getState());
  }

  getTransport(): RpcTransport | null {
    return this.transport;
  }

  get kind(): 'core' | 'demo' | null {
    return this.transport?.kind ?? null;
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>, opts?: RpcRequestOptions): Promise<RpcResult<M>> {
    if (!this.transport) return Promise.reject(new RpcError('Not connected to the Obsidian core', 'unavailable', method));
    return this.transport.request(method, params, opts);
  }

  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void {
    return this.hub.on(event, fn);
  }

  onAny(fn: AnyEventListener): () => void {
    return this.hub.onAny(fn);
  }

  onStatus(fn: (s: ConnectionState) => void): () => void {
    return this.statusListeners.add(fn);
  }

  onConnected(fn: (info: { reconnect: boolean }) => void): () => void {
    return this.connectedListeners.add(fn);
  }

  getState(): ConnectionState {
    return this.transport?.getState() ?? UNAVAILABLE;
  }

  retryNow(): void {
    this.transport?.retryNow();
  }

  /** Test helper: emit an event locally as if the core had pushed it. */
  emitLocal<E extends CoreEventName>(event: E, data: CoreEvents[E]): void {
    this.hub.emit(event, data);
  }
}

export const rpc = new RpcFacade();
