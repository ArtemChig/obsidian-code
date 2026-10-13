// DEMO MODE — a fake core that answers every RpcMethods call with realistic data and simulates streaming turns.
// Owner: ui-foundation. Enabled with ?demo=1 (see app/boot.ts).
//
// Extension API for other renderer areas (call from src/renderer/src/features/<area>/demo.ts — every such file is
// auto-imported in demo mode before the demo core starts):
//
//   registerDemoData({ sessions: [mySession] })            // merge sample data (records merged by id)
//   registerDemoData((d) => ({ catalog: [...d.catalog, x] })) // or derive from the current data
//   registerDemoHandler('gpu.offers', (params, ctx) => …)    // override one method; ctx.fallback() calls the default
//
import type { CoreEventName, CoreEvents, RpcMethod, RpcParams, RpcResult } from '@shared/protocol';
import type {
  ActivityItem,
  Block,
  GpuStatus,
  Message,
  PermissionDecision,
  PermissionMode,
  Question,
  ScheduledTask,
  Session,
  SessionSummary,
  Todo,
  ToolUseBlock,
} from '@shared/types';
import { createDemoData, DEMO_ENGINES, demoGpuSteps, type DemoData } from './demo-data';
import {
  EventHub,
  RpcError,
  type AnyEventListener,
  type ConnectionState,
  type RpcRequestOptions,
  type RpcTransport,
} from './rpc';

export type { DemoData } from './demo-data';

// ───────────────────────────── Registry (extension points) ─────────────────────────────

export interface DemoContext {
  /** Live, mutable demo data. Mutate it, then emit the matching event. */
  readonly data: DemoData;
  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  newId(prefix: string): string;
  getSession(id: string): Session;
  /** Patch a session summary and emit session.updated. */
  updateSession(id: string, patch: Partial<SessionSummary>): SessionSummary;
  /** Call the built-in handler for the current method (inside registerDemoHandler). */
  fallback(): Promise<unknown>;
  /** Run the built-in simulated assistant turn for a user prompt. */
  runTurn(sessionId: string, text: string): Promise<void>;
}

export type DemoHandler<M extends RpcMethod> = (params: RpcParams<M>, ctx: DemoContext) => RpcResult<M> | Promise<RpcResult<M>>;
export type DemoDataPatch = Partial<DemoData> | ((current: DemoData) => Partial<DemoData> | void);

const dataPatches: DemoDataPatch[] = [];
const handlerOverrides = new Map<RpcMethod, DemoHandler<RpcMethod>>();
let activeTransport: DemoTransport | null = null;

/** Merge sample data into the demo core. Records with an `id` (or requestId / ref) are merged by key; objects are shallow-merged. */
export function registerDemoData(patch: DemoDataPatch): void {
  dataPatches.push(patch);
  if (activeTransport) activeTransport.applyPatch(patch);
}

/** Override (or add) the demo implementation of one RPC method. */
export function registerDemoHandler<M extends RpcMethod>(method: M, fn: DemoHandler<M>): void {
  handlerOverrides.set(method, fn as unknown as DemoHandler<RpcMethod>);
}

/** Test helper: forget registered patches/handlers. */
export function resetDemoRegistry(): void {
  dataPatches.length = 0;
  handlerOverrides.clear();
}

function keyOf(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (typeof o.id === 'string' || typeof o.id === 'number') return String(o.id);
  if (typeof o.requestId === 'string') return o.requestId;
  if (typeof o.offerId === 'number') return String(o.offerId);
  if (typeof o.name === 'string') return o.name;
  if (o.ref && typeof o.ref === 'object') {
    const r = o.ref as { provider?: string; model?: string };
    return `${r.provider}::${r.model}`;
  }
  return null;
}

function mergeArray<T>(base: T[], patch: T[]): T[] {
  const out = base.slice();
  for (const item of patch) {
    const k = keyOf(item);
    const idx = k === null ? -1 : out.findIndex((x) => keyOf(x) === k);
    if (idx >= 0) out[idx] = item;
    else out.push(item);
  }
  return out;
}

export function mergeDemoData(base: DemoData, patch: Partial<DemoData>): DemoData {
  const out: DemoData = { ...base };
  for (const [k, v] of Object.entries(patch) as [keyof DemoData, unknown][]) {
    if (v === undefined) continue;
    const cur = base[k] as unknown;
    if (Array.isArray(cur) && Array.isArray(v)) {
      (out as unknown as Record<string, unknown>)[k] = mergeArray(cur, v);
    } else if (k === 'pending' && v && typeof v === 'object') {
      const p = v as Partial<DemoData['pending']>;
      out.pending = {
        permissions: mergeArray(base.pending.permissions, p.permissions ?? []),
        questions: mergeArray(base.pending.questions, p.questions ?? []),
        plans: mergeArray(base.pending.plans, p.plans ?? []),
      };
    } else if (cur && typeof cur === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
      (out as unknown as Record<string, unknown>)[k] = { ...(cur as object), ...(v as object) };
    } else {
      (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

// ───────────────────────────── Helpers ─────────────────────────────

function summaryOf(s: Session): SessionSummary {
  const { messages: _m, todos: _t, changedFiles: _c, ...summary } = s;
  return summary;
}

function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    // Prefer to cut at a space for nicer streaming.
    let end = Math.min(text.length, i + size);
    const space = text.lastIndexOf(' ', end);
    if (space > i + size / 2 && end < text.length) end = space + 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const DEMO_THINKING = [
  'The user wants me to {task}. Before touching anything I should look at how the relevant code is organised, ',
  'then make the smallest change that solves it, and verify with the existing tests. ',
  'Keep the answer short and show the diff.',
].join('');

// ───────────────────────────── Transport ─────────────────────────────

export interface DemoTransportOptions {
  /** Simulated request latency (ms). Default 40–110 ms; set 0 in tests. */
  latencyMs?: number;
  /** Multiplier for streaming / scenario delays (1 = realistic, 0 = instant; tests use 0). */
  speed?: number;
  /** Override the starting data (otherwise createDemoData() + registered patches). */
  data?: DemoData;
}

export class DemoTransport implements RpcTransport {
  readonly kind = 'demo' as const;
  data: DemoData;
  private hub = new EventHub();
  private statusFns = new Set<(s: ConnectionState) => void>();
  private connectedFns = new Set<(i: { reconnect: boolean }) => void>();
  private state: ConnectionState = { status: 'idle', attempt: 0, nextRetryAt: null, lastError: null, everConnected: false };
  private seq = 1;
  private aborts = new Map<string, AbortController>();
  private queues = new Map<string, { messageId: string; text: string }[]>();
  private waiters = new Map<string, (value: unknown) => void>();
  private gpuAbort: AbortController | null = null;
  private readonly latency: number | null;
  private readonly speed: number;

  constructor(opts: DemoTransportOptions = {}) {
    this.latency = opts.latencyMs ?? null;
    this.speed = opts.speed ?? 1;
    let data = opts.data ?? createDemoData();
    for (const p of dataPatches) data = this.patched(data, p);
    this.data = data;
    activeTransport = this;
  }

  private patched(data: DemoData, p: DemoDataPatch): DemoData {
    const partial = typeof p === 'function' ? p(data) : p;
    return partial ? mergeDemoData(data, partial) : data;
  }

  applyPatch(p: DemoDataPatch): void {
    this.data = this.patched(this.data, p);
  }

  // ── RpcTransport

  getState(): ConnectionState {
    return this.state;
  }
  onStatus(fn: (s: ConnectionState) => void): () => void {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }
  onConnected(fn: (i: { reconnect: boolean }) => void): () => void {
    this.connectedFns.add(fn);
    return () => this.connectedFns.delete(fn);
  }
  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void {
    return this.hub.on(event, fn);
  }
  onAny(fn: AnyEventListener): () => void {
    return this.hub.onAny(fn);
  }

  connect(): void {
    if (this.state.status === 'open') return;
    this.setState({ status: 'connecting' });
    setTimeout(() => {
      const reconnect = this.state.everConnected;
      this.setState({ status: 'open', everConnected: true, attempt: 0, lastError: null });
      for (const fn of [...this.connectedFns]) fn({ reconnect });
    }, 0);
  }
  retryNow(): void {
    this.connect();
  }
  close(): void {
    for (const a of this.aborts.values()) a.abort();
    this.gpuAbort?.abort();
    this.setState({ status: 'closed' });
    if (activeTransport === this) activeTransport = null;
  }

  /** Simulate a dropped connection (for UI testing of the reconnecting banner). */
  simulateDisconnect(ms = 4000): void {
    this.setState({ status: 'reconnecting', attempt: 1, nextRetryAt: Date.now() + ms, lastError: 'Connection lost (demo)' });
    setTimeout(() => {
      this.setState({ status: 'open', attempt: 0, nextRetryAt: null, lastError: null });
      for (const fn of [...this.connectedFns]) fn({ reconnect: true });
    }, ms);
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.statusFns]) fn(this.state);
  }

  async request<M extends RpcMethod>(method: M, params: RpcParams<M>, _opts?: RpcRequestOptions): Promise<RpcResult<M>> {
    if (this.state.status === 'closed') throw new RpcError('Connection closed', 'closed', method);
    const lat = this.latency ?? 40 + Math.random() * 70;
    if (lat > 0) await new Promise((r) => setTimeout(r, lat));
    const ctx = this.context(method, params);
    const override = handlerOverrides.get(method) as DemoHandler<M> | undefined;
    try {
      const result = override ? await override(params, ctx) : await this.builtin(method, params);
      return clone(result);
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(err instanceof Error ? err.message : String(err), 'demo_error', method);
    }
  }

  // ── context for handlers

  private context<M extends RpcMethod>(method: M, params: RpcParams<M>): DemoContext {
    return {
      data: this.data,
      emit: (e, d) => this.emit(e, d),
      sleep: (ms, signal) => this.sleep(ms, signal),
      now: () => Date.now(),
      newId: (p) => this.newId(p),
      getSession: (id) => this.session(id),
      updateSession: (id, patch) => this.updateSession(id, patch),
      fallback: () => this.builtin(method, params),
      runTurn: (sessionId, text) => this.startTurn(sessionId, text, this.newId('m')),
    };
  }

  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void {
    const payload = clone(data);
    queueMicrotask(() => this.hub.emit(event, payload));
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const d = Math.round(ms * this.speed);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      if (d <= 0) return queueMicrotask(resolve);
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, d);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
  }

  private session(id: string): Session {
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s) throw new RpcError(`Session not found: ${id}`, 'not_found');
    return s;
  }

  private updateSession(id: string, patch: Partial<SessionSummary>): SessionSummary {
    const s = this.session(id);
    Object.assign(s, patch);
    const summary = summaryOf(s);
    this.emit('session.updated', summary);
    return summary;
  }

  private setActivity(item: ActivityItem): void {
    const idx = this.data.activity.findIndex((a) => a.id === item.id);
    if (idx >= 0) this.data.activity[idx] = item;
    else this.data.activity.unshift(item);
    this.emit('activity.updated', this.data.activity);
  }

  // ── built-in handlers (every RpcMethods entry)

  private builtin<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const h = (this.handlers as unknown as Record<string, (p: unknown) => unknown>)[method];
    if (!h) return Promise.reject(new RpcError(`Demo: method not implemented: ${method}`, 'not_implemented', method));
    return Promise.resolve(h(params) as RpcResult<M>);
  }

  private readonly handlers: { [M in RpcMethod]: (p: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>> } = {
    'system.info': () => this.data.system,

    // sessions
    'sessions.list': (p) => this.data.sessions.filter((s) => p.includeSubagents || s.kind !== 'subagent').map(summaryOf),
    'sessions.get': (p) => this.session(p.id),
    'sessions.create': (p) => {
      const now = Date.now();
      const s: Session = {
        id: this.newId('s'),
        title: p.title ?? 'New session',
        cwd: p.cwd ?? this.data.settings.defaultCwd,
        kind: 'chat',
        createdAt: now,
        updatedAt: now,
        status: 'idle',
        model: p.model ?? this.data.settings.defaultModel,
        permissionMode: p.permissionMode ?? this.data.settings.defaultPermissionMode,
        thinking: this.data.settings.thinkingByDefault,
        engine: p.engine ?? this.data.settings.engine?.default ?? 'builtin',
        usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
        messages: [],
        todos: [],
        changedFiles: [],
      };
      this.data.sessions.unshift(s);
      const summary = summaryOf(s);
      this.emit('session.created', summary);
      return summary;
    },
    'sessions.rename': (p) => this.updateSession(p.id, { title: p.title, updatedAt: Date.now() }),
    'sessions.delete': (p) => {
      this.aborts.get(p.id)?.abort();
      this.data.sessions = this.data.sessions.filter((s) => s.id !== p.id && s.parentSessionId !== p.id);
      this.emit('session.deleted', { sessionId: p.id });
      return { ok: true as const };
    },
    'sessions.fork': (p) => {
      const src = this.session(p.id);
      const now = Date.now();
      let messages = clone(src.messages);
      if (p.atMessageId) {
        const idx = messages.findIndex((m) => m.id === p.atMessageId);
        if (idx >= 0) messages = messages.slice(0, idx + 1);
      }
      const s: Session = { ...clone(src), id: this.newId('s'), title: `${src.title} (fork)`, createdAt: now, updatedAt: now, status: 'idle', pinned: false, messages };
      this.data.sessions.unshift(s);
      const summary = summaryOf(s);
      this.emit('session.created', summary);
      return summary;
    },
    'sessions.setPinned': (p) => this.updateSession(p.id, { pinned: p.pinned }),
    'sessions.search': (p) => {
      const q = p.query.toLowerCase();
      const out: RpcResult<'sessions.search'> = [];
      for (const s of this.data.sessions) {
        for (const m of s.messages) {
          for (const b of m.blocks) {
            if (b.type !== 'text') continue;
            const i = b.text.toLowerCase().indexOf(q);
            if (i >= 0) {
              out.push({ sessionId: s.id, title: s.title, snippet: b.text.slice(Math.max(0, i - 40), i + 80) });
              break;
            }
          }
          if (out.length && out[out.length - 1].sessionId === s.id) break;
        }
      }
      return out.slice(0, 20);
    },

    // chat
    'chat.send': (p) => this.chatSend(p.sessionId, p.text),
    'chat.interrupt': (p) => {
      this.aborts.get(p.sessionId)?.abort();
      this.queues.delete(p.sessionId);
      return { ok: true as const };
    },
    'chat.dequeue': (p) => {
      const q = this.queues.get(p.sessionId) ?? [];
      const removed = q.filter((x) => !p.messageId || x.messageId === p.messageId);
      this.queues.set(p.sessionId, q.filter((x) => !removed.includes(x)));
      return { removed: removed.map((x) => ({ messageId: x.messageId, text: x.text })) };
    },
    'chat.respondPermission': (p) => {
      const req = this.data.pending.permissions.find((r) => r.requestId === p.requestId);
      this.data.pending.permissions = this.data.pending.permissions.filter((r) => r.requestId !== p.requestId);
      if (req) this.emit('permission.resolved', { requestId: p.requestId, sessionId: req.sessionId, decision: p.decision });
      const w = this.waiters.get(p.requestId);
      if (w) {
        this.waiters.delete(p.requestId);
        w({ decision: p.decision, message: p.message });
      } else if (req) {
        // Seeded request (no live turn): resolve it with a short follow-up so the UI shows progress.
        void this.finishSeededPermission(req.sessionId, req.toolUseId, req.toolName, req.input, p.decision);
      }
      return { ok: true as const };
    },
    'chat.answerQuestion': (p) => {
      const req = this.data.pending.questions.find((r) => r.requestId === p.requestId);
      this.data.pending.questions = this.data.pending.questions.filter((r) => r.requestId !== p.requestId);
      if (req) this.emit('question.resolved', { requestId: p.requestId, sessionId: req.sessionId });
      const w = this.waiters.get(p.requestId);
      if (w) {
        this.waiters.delete(p.requestId);
        w(p.answers);
      }
      return { ok: true as const };
    },
    'chat.respondPlan': (p) => {
      const req = this.data.pending.plans.find((r) => r.requestId === p.requestId);
      this.data.pending.plans = this.data.pending.plans.filter((r) => r.requestId !== p.requestId);
      if (req) this.emit('plan.resolved', { requestId: p.requestId, sessionId: req.sessionId, approved: p.approve });
      const w = this.waiters.get(p.requestId);
      if (w) {
        this.waiters.delete(p.requestId);
        w({ approve: p.approve, mode: p.mode, feedback: p.feedback });
      }
      return { ok: true as const };
    },
    'chat.setPermissionMode': (p) => this.updateSession(p.sessionId, { permissionMode: p.mode }),
    'chat.setModel': (p) => this.updateSession(p.sessionId, { model: p.model }),
    'chat.setThinking': (p) => this.updateSession(p.sessionId, { thinking: p.thinking }),
    'chat.setEngine': (p) => {
      if (this.session(p.sessionId).status === 'running') throw new Error('Wait for the current turn to finish (or stop it) before switching engines.');
      return this.updateSession(p.sessionId, { engine: p.engine });
    },
    'chat.rewind': (p) => {
      const s = this.session(p.sessionId);
      const idx = s.messages.findIndex((m) => m.id === p.atMessageId);
      if (idx >= 0) s.messages = s.messages.slice(0, idx);
      const restored = p.restoreFiles ? s.changedFiles.map((f) => f.path) : [];
      if (p.restoreFiles) {
        s.changedFiles = [];
        this.emit('changes.updated', { sessionId: s.id, changedFiles: [] });
      }
      this.emit('session.reset', { sessionId: s.id });
      return { ok: true as const, restoredFiles: restored };
    },
    'chat.pending': (p) => {
      const f = <T extends { sessionId: string }>(xs: T[]) => (p.sessionId ? xs.filter((x) => x.sessionId === p.sessionId) : xs);
      return { permissions: f(this.data.pending.permissions), questions: f(this.data.pending.questions), plans: f(this.data.pending.plans) };
    },

    // workspace
    'commands.list': () => this.data.commands,
    'skills.list': () => this.data.skills,
    'agents.list': () => this.data.agents,
    'files.list': (p) => {
      const dir = (p.dir ?? p.cwd).replace(/[\\/]+$/, '');
      const known = this.data.files[dir];
      if (known) return known;
      const sep = dir.includes('\\') ? '\\' : '/';
      return [
        { name: 'src', path: `${dir}${sep}src`, isDir: true },
        { name: 'README.md', path: `${dir}${sep}README.md`, isDir: false, size: 2_140 },
        { name: 'package.json', path: `${dir}${sep}package.json`, isDir: false, size: 980 },
      ];
    },
    'files.search': (p) => {
      const all = new Set<string>();
      for (const entries of Object.values(this.data.files)) for (const e of entries) if (!e.isDir) all.add(e.path);
      for (const s of this.data.sessions) for (const f of s.changedFiles) all.add(f.path);
      const extra = ['src\\renderer\\src\\lib\\rpc.ts', 'src\\renderer\\src\\app\\AppShell.tsx', 'src\\core\\agent\\loop.ts', 'src\\core\\gpu\\vast.ts', 'src\\shared\\protocol.ts', 'README.md'];
      for (const e of extra) all.add(`${p.cwd}\\${e}`);
      const q = p.query.toLowerCase();
      const cwdPrefix = p.cwd.replace(/[\\/]+$/, '') + '\\';
      return [...all]
        .map((f) => (f.startsWith(cwdPrefix) ? f.slice(cwdPrefix.length) : f))
        .filter((f) => f.toLowerCase().includes(q))
        .slice(0, p.limit ?? 50);
    },
    'files.read': (p) => ({ content: this.data.fileContents[p.path] ?? `// ${p.path}\n// (demo file contents)\n`, truncated: false }),
    'files.diff': (p) => {
      const s = this.session(p.sessionId);
      for (const m of s.messages) {
        for (const b of m.blocks) {
          if (b.type === 'tool_use' && b.result?.display?.kind === 'diff' && b.result.display.path === p.path) {
            return { before: b.result.display.before, after: b.result.display.after };
          }
        }
      }
      return { before: '', after: this.data.fileContents[p.path] ?? '' };
    },

    // models
    'models.list': () => ({ providers: this.data.providers, models: this.data.models }),
    'engines.list': () => DEMO_ENGINES,
    'models.refresh': async () => {
      await this.sleep(600);
      const r = { providers: this.data.providers, models: this.data.models };
      this.emit('models.updated', r);
      return r;
    },

    // gpu
    'gpu.status': () => this.liveGpu(),
    'gpu.catalog': () => this.data.catalog,
    'gpu.offers': (p) => (this.data.offers[p.profileId] ?? []).slice(0, p.limit ?? 20),
    'gpu.clockIn': (p) => this.clockIn(p.profileId, p.modelId),
    'gpu.clockOut': () => this.clockOut(),
    'gpu.switchModel': (p) => {
      const g = this.data.gpuStatus;
      if (g.phase !== 'ready') throw new RpcError('Not clocked in', 'not_ready');
      void this.runGpuSwitch(p.modelId);
      return { ...g, phase: 'switching' as const, message: 'Switching model…' };
    },
    'gpu.history': (p) => this.data.history.slice(0, p.limit ?? 50),
    'gpu.destroyOrphans': () => {
      const destroyed = this.data.gpuStatus.orphanInstanceIds ?? [];
      this.data.gpuStatus = { ...this.data.gpuStatus, orphanInstanceIds: [] };
      this.emit('gpu.status', this.liveGpu());
      return { destroyed };
    },
    'gpu.serverLog': () => ({ text: this.data.serverLog }),
    'gpu.testKey': () =>
      this.data.secrets['vast.apiKey']
        ? { ok: true, message: 'Key OK — account has credit', creditBalance: this.data.gpuStatus.creditBalance ?? 0 }
        : { ok: false, message: 'No Vast.ai API key configured' },

    // scheduler
    'schedules.list': () => this.data.schedules,
    'schedules.create': (p) => {
      const t: ScheduledTask = { ...p, id: this.newId('sch'), createdAt: Date.now(), nextRunAt: Date.now() + 3_600_000 };
      this.data.schedules.push(t);
      this.emit('schedules.updated', this.data.schedules);
      return t;
    },
    'schedules.update': (p) => {
      const t = this.data.schedules.find((x) => x.id === p.id);
      if (!t) throw new RpcError('Schedule not found', 'not_found');
      Object.assign(t, p.patch, { id: t.id });
      this.emit('schedules.updated', this.data.schedules);
      return t;
    },
    'schedules.delete': (p) => {
      this.data.schedules = this.data.schedules.filter((x) => x.id !== p.id);
      this.emit('schedules.updated', this.data.schedules);
      return { ok: true as const };
    },
    'schedules.runNow': (p) => {
      const t = this.data.schedules.find((x) => x.id === p.id);
      if (!t) throw new RpcError('Schedule not found', 'not_found');
      const now = Date.now();
      const s: Session = {
        id: this.newId('s'),
        title: t.name,
        cwd: t.cwd,
        kind: 'scheduled',
        scheduleId: t.id,
        createdAt: now,
        updatedAt: now,
        status: 'idle',
        model: t.model ?? this.data.settings.defaultModel,
        permissionMode: t.permissionMode,
        thinking: true,
        usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
        messages: [],
        todos: [],
        changedFiles: [],
      };
      this.data.sessions.unshift(s);
      this.emit('session.created', summaryOf(s));
      Object.assign(t, { lastRunAt: now, lastRunSessionId: s.id, lastRunStatus: 'ok' });
      this.emit('schedules.updated', this.data.schedules);
      void this.startTurn(s.id, t.prompt, this.newId('m'));
      return { sessionId: s.id };
    },

    // activity
    'activity.list': () => this.data.activity,
    'activity.stop': (p) => {
      const a = this.data.activity.find((x) => x.id === p.id);
      if (a) {
        if (a.sessionId) this.aborts.get(a.sessionId)?.abort();
        if (a.kind === 'gpu') void this.clockOut();
        this.setActivity({ ...a, status: 'stopped', endedAt: Date.now() });
      }
      return { ok: true as const };
    },

    // settings & secrets
    'settings.get': () => this.data.settings,
    'settings.update': (p) => {
      const cur = this.data.settings;
      const next = { ...cur, ...p.patch } as typeof cur;
      if (p.patch.vast) next.vast = { ...cur.vast, ...p.patch.vast };
      if (p.patch.local) next.local = { ...cur.local, ...p.patch.local };
      if (p.patch.search) next.search = { ...cur.search, ...p.patch.search };
      if (p.patch.permissions) next.permissions = { ...cur.permissions, ...p.patch.permissions };
      this.data.settings = next;
      this.emit('settings.updated', next);
      return next;
    },
    'secrets.set': (p) => {
      this.data.secrets[p.name] = !!p.value;
      return { ok: true as const };
    },
    'secrets.has': (p) => Object.fromEntries(p.names.map((n) => [n, !!this.data.secrets[n]])),
  };

  // ───────────────────────────── GPU simulation ─────────────────────────────

  private liveGpu(): GpuStatus {
    const g = this.data.gpuStatus;
    if (g.clockedInAt && g.pricePerHour && g.phase !== 'off') {
      const cost = ((Date.now() - g.clockedInAt) / 3_600_000) * g.pricePerHour;
      return { ...g, sessionCost: Math.round(cost * 1000) / 1000 };
    }
    return g;
  }

  private setGpu(patch: Partial<GpuStatus>): void {
    this.data.gpuStatus = { ...this.data.gpuStatus, ...patch };
    if (patch.phase) this.data.gpuStatus.steps = demoGpuSteps(patch.phase);
    this.emit('gpu.status', this.liveGpu());
  }

  private clockIn(profileId: string, modelId?: string): GpuStatus {
    const g = this.data.gpuStatus;
    if (g.phase !== 'off' && g.phase !== 'error') throw new RpcError('Already clocked in', 'busy');
    if (!this.data.secrets['vast.apiKey']) throw new RpcError('Vast.ai API key missing — add it in Settings', 'no_key');
    if (g.monthCost >= g.monthlyBudget) throw new RpcError('Monthly budget reached', 'budget');
    const profile = this.data.settings.vast.profiles.find((p) => p.id === profileId) ?? this.data.settings.vast.profiles[0];
    const model = modelId ?? profile?.defaultModelId;
    this.gpuAbort?.abort();
    const ac = new AbortController();
    this.gpuAbort = ac;
    this.data.gpuStatus = { ...g, phase: 'searching', message: 'Searching offers…', profileId: profile?.id, modelId: model, lastError: undefined, progress: undefined, steps: demoGpuSteps('searching') };
    void this.runClockIn(ac.signal);
    return this.data.gpuStatus;
  }

  private async runClockIn(signal: AbortSignal): Promise<void> {
    try {
      const profileId = this.data.gpuStatus.profileId ?? 'light';
      const offer = (this.data.offers[profileId] ?? [])[0];
      this.emit('gpu.status', this.data.gpuStatus);
      await this.sleep(1200, signal);
      this.setGpu({
        phase: 'renting',
        message: `Renting ${offer?.numGpus ?? 1}× ${offer?.gpuName ?? 'GPU'} in ${offer?.location ?? 'unknown'}`,
        gpuName: offer?.gpuName,
        numGpus: offer?.numGpus,
        pricePerHour: offer?.pricePerHour,
        location: offer?.location,
        instanceId: 26_500_000 + Math.floor(Math.random() * 99_999),
        clockedInAt: Date.now(),
        sessionCost: 0,
      });
      this.setActivity({ id: 'a-gpu', kind: 'gpu', title: `${offer?.gpuName ?? 'GPU'} · clocking in`, status: 'running', startedAt: Date.now(), detail: 'Renting instance' });
      await this.sleep(2000, signal);
      this.setGpu({ phase: 'connecting', message: 'Waiting for SSH…' });
      await this.sleep(1500, signal);
      const size = this.data.catalog.find((c) => c.id === this.data.gpuStatus.modelId)?.sizeGb ?? 20;
      for (let i = 1; i <= 8; i++) {
        const progress = i / 8;
        this.setGpu({ phase: 'downloading', progress, message: `Downloading model — ${(size * progress).toFixed(1)} / ${size.toFixed(1)} GB` });
        await this.sleep(500, signal);
      }
      for (let i = 1; i <= 3; i++) {
        this.setGpu({ phase: 'loading', progress: i / 3, message: 'Loading weights into VRAM…' });
        await this.sleep(500, signal);
      }
      const label = this.data.catalog.find((c) => c.id === this.data.gpuStatus.modelId)?.label ?? this.data.gpuStatus.modelId;
      this.setGpu({ phase: 'ready', progress: undefined, readyAt: Date.now(), endpoint: 'http://127.0.0.1:18080', message: `Ready — ${label}` });
      this.setActivity({ id: 'a-gpu', kind: 'gpu', title: `${this.data.gpuStatus.gpuName} · ${label}`, status: 'running', startedAt: this.data.gpuStatus.clockedInAt ?? Date.now(), detail: `$${this.data.gpuStatus.pricePerHour?.toFixed(2)}/h` });
      this.emit('notification', { title: 'GPU ready', body: `${label} is serving on ${this.data.gpuStatus.gpuName}`, level: 'success' });
    } catch {
      /* aborted by clock-out */
    }
  }

  private clockOut(): GpuStatus {
    const g = this.liveGpu();
    this.gpuAbort?.abort();
    this.gpuAbort = null;
    if (g.phase === 'off') return g;
    this.setGpu({ phase: 'stopping', message: 'Destroying instance…' });
    void (async () => {
      await this.sleep(1000);
      const ended = Date.now();
      if (g.clockedInAt) {
        this.data.history.unshift({
          id: this.newId('g'),
          instanceId: g.instanceId ?? 0,
          profileId: g.profileId ?? 'light',
          modelId: g.modelId ?? '',
          gpuName: g.gpuName ?? 'GPU',
          numGpus: g.numGpus ?? 1,
          pricePerHour: g.pricePerHour ?? 0,
          startedAt: g.clockedInAt,
          endedAt: ended,
          cost: g.sessionCost,
          endReason: 'clock_out',
        });
      }
      this.setGpu({
        phase: 'off',
        message: 'Clocked out — instance destroyed',
        monthCost: Math.round((g.monthCost + g.sessionCost) * 100) / 100,
        sessionCost: 0,
        clockedInAt: undefined,
        readyAt: undefined,
        endpoint: undefined,
        instanceId: undefined,
        progress: undefined,
      });
      const a = this.data.activity.find((x) => x.id === 'a-gpu');
      if (a) this.setActivity({ ...a, status: 'done', endedAt: ended, detail: `Cost $${g.sessionCost.toFixed(2)}` });
      this.emit('notification', { title: 'Clocked out', body: `Instance destroyed · session cost $${g.sessionCost.toFixed(2)}`, level: 'info' });
    })();
    return this.data.gpuStatus;
  }

  private async runGpuSwitch(modelId: string): Promise<void> {
    this.setGpu({ phase: 'switching', message: 'Switching model…', modelId });
    await this.sleep(2500);
    const label = this.data.catalog.find((c) => c.id === modelId)?.label ?? modelId;
    this.setGpu({ phase: 'ready', message: `Ready — ${label}` });
  }

  // ───────────────────────────── Chat simulation ─────────────────────────────

  private chatSend(sessionId: string, text: string): RpcResult<'chat.send'> {
    const s = this.session(sessionId);
    const messageId = this.newId('m');
    if (s.status === 'running' || s.status === 'waiting') {
      const q = this.queues.get(sessionId) ?? [];
      q.push({ messageId, text });
      this.queues.set(sessionId, q);
      return { messageId, queued: true };
    }
    void this.startTurn(sessionId, text, messageId);
    return { messageId, queued: false };
  }

  private addMessage(s: Session, m: Message): void {
    s.messages.push(m);
    this.emit('message.added', { sessionId: s.id, message: m });
  }

  private setBlock(s: Session, m: Message, index: number, block: Block): void {
    m.blocks[index] = block;
    this.emit('message.block', { sessionId: s.id, messageId: m.id, blockIndex: index, block });
  }

  private setTool(s: Session, m: Message, index: number, tool: ToolUseBlock): void {
    m.blocks[index] = tool;
    this.emit('tool.updated', { sessionId: s.id, messageId: m.id, tool });
  }

  private async stream(s: Session, m: Message, index: number, type: 'text' | 'thinking', text: string, signal: AbortSignal): Promise<void> {
    const block = { type, text: '' } as Block & { text: string };
    m.blocks[index] = block;
    for (const piece of chunkText(text, type === 'thinking' ? 28 : 16)) {
      await this.sleep(type === 'thinking' ? 38 : 30, signal);
      block.text += piece;
      this.emit('message.delta', { sessionId: s.id, messageId: m.id, blockIndex: index, blockType: type, delta: piece });
    }
  }

  private waitFor<T>(requestId: string, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(requestId, resolve as (v: unknown) => void);
      signal.addEventListener(
        'abort',
        () => {
          this.waiters.delete(requestId);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  async startTurn(sessionId: string, text: string, userMessageId: string): Promise<void> {
    const s = this.session(sessionId);
    const ac = new AbortController();
    this.aborts.set(sessionId, ac);
    const now = Date.now();
    const isCommand = text.startsWith('/');
    this.addMessage(s, { id: userMessageId, role: 'user', createdAt: now, blocks: [{ type: 'text', text }], tag: isCommand ? 'command' : undefined });
    this.updateSession(sessionId, { status: 'running', updatedAt: now });
    const actId = `a-${sessionId}`;
    this.setActivity({ id: actId, kind: s.kind === 'subagent' ? 'subagent' : 'session', title: s.title, sessionId, status: 'running', startedAt: now, detail: 'Thinking…' });

    let assistant: Message | null = null;
    let interrupted = false;
    const started = Date.now();
    try {
      if (isCommand && (await this.handleCommand(s, text))) {
        // handled without a model turn
      } else {
        assistant = { id: this.newId('m'), role: 'assistant', createdAt: Date.now(), blocks: [] };
        this.addMessage(s, assistant);
        await this.scriptedTurn(s, assistant, text, ac.signal);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
      interrupted = true;
      if (assistant) {
        assistant.blocks.forEach((b, i) => {
          if (b.type === 'tool_use' && (b.status === 'running' || b.status === 'pending' || b.status === 'awaiting_permission')) {
            this.setTool(s, assistant as Message, i, { ...b, status: 'interrupted', endedAt: Date.now() });
          }
        });
      }
      for (const kind of ['permissions', 'questions', 'plans'] as const) {
        const list = this.data.pending[kind] as { requestId: string; sessionId: string }[];
        for (const r of list.filter((x) => x.sessionId === sessionId)) {
          if (kind === 'permissions') this.emit('permission.resolved', { requestId: r.requestId, sessionId, decision: 'deny' });
          if (kind === 'questions') this.emit('question.resolved', { requestId: r.requestId, sessionId });
          if (kind === 'plans') this.emit('plan.resolved', { requestId: r.requestId, sessionId, approved: false });
        }
        (this.data.pending as Record<string, unknown[]>)[kind] = list.filter((x) => x.sessionId !== sessionId);
      }
    } finally {
      this.aborts.delete(sessionId);
    }

    if (assistant) {
      const completion = Math.round(assistant.blocks.reduce((n, b) => n + ('text' in b ? b.text.length : 60), 0) / 3.6);
      const prompt = 4_000 + s.messages.length * 900;
      const meta = { model: s.model?.model, durationMs: Date.now() - started, promptTokens: prompt, completionTokens: completion, interrupted: interrupted || undefined };
      assistant.meta = meta;
      this.emit('message.completed', { sessionId, messageId: assistant.id, meta });
      s.usage = { inputTokens: s.usage.inputTokens + prompt, outputTokens: s.usage.outputTokens + completion, lastPromptTokens: prompt, requests: s.usage.requests + 1 };
    }
    const title = s.title === 'New session' && !isCommand ? text.split(/\s+/).slice(0, 6).join(' ').replace(/[.,:;!?]+$/, '') : s.title;
    this.updateSession(sessionId, { status: 'idle', updatedAt: Date.now(), usage: s.usage, title });
    this.setActivity({ id: actId, kind: s.kind === 'subagent' ? 'subagent' : 'session', title, sessionId, status: interrupted ? 'stopped' : 'done', startedAt: now, endedAt: Date.now(), detail: interrupted ? 'Interrupted' : 'Finished' });

    const next = this.queues.get(sessionId)?.shift();
    if (next) {
      await this.sleep(300);
      void this.startTurn(sessionId, next.text, next.messageId);
    }
  }

  private async handleCommand(s: Session, text: string): Promise<boolean> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    const reply = (md: string) => {
      const m: Message = { id: this.newId('m'), role: 'assistant', createdAt: Date.now(), blocks: [{ type: 'text', text: md }], tag: 'command' };
      this.addMessage(s, m);
      this.emit('message.completed', { sessionId: s.id, messageId: m.id, meta: { durationMs: 5 } });
    };
    switch (cmd) {
      case 'clear':
        s.messages = [];
        s.todos = [];
        this.emit('session.reset', { sessionId: s.id });
        return true;
      case 'plan': {
        const mode: PermissionMode = s.permissionMode === 'plan' ? 'default' : 'plan';
        this.updateSession(s.id, { permissionMode: mode });
        reply(mode === 'plan' ? 'Plan mode **on** — I will research and propose a plan before editing anything.' : 'Plan mode **off**.');
        return true;
      }
      case 'thinking': {
        const on = arg ? arg === 'on' : !s.thinking;
        this.updateSession(s.id, { thinking: on });
        reply(`Thinking ${on ? '**on**' : '**off**'}.`);
        return true;
      }
      case 'compact': {
        await this.sleep(900);
        const m: Message = {
          id: this.newId('m'),
          role: 'system',
          createdAt: Date.now(),
          tag: 'compact_summary',
          blocks: [{ type: 'text', text: 'Summary of the earlier conversation: the user and assistant worked on the parser fix, tests pass.' }],
        };
        s.messages = [m];
        this.emit('session.reset', { sessionId: s.id });
        return true;
      }
      case 'cost':
        reply(`**Usage** — ${s.usage.inputTokens.toLocaleString()} input · ${s.usage.outputTokens.toLocaleString()} output tokens across ${s.usage.requests} requests.`);
        return true;
      case 'help':
        reply(this.data.commands.map((c) => `- \`/${c.name}\` — ${c.description}`).join('\n'));
        return true;
      default:
        return false;
    }
  }

  private async scriptedTurn(s: Session, m: Message, text: string, signal: AbortSignal): Promise<void> {
    const lower = text.toLowerCase();
    let i = 0;
    const task = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    if (s.thinking) {
      const t0 = Date.now();
      await this.stream(s, m, i, 'thinking', DEMO_THINKING.replace('{task}', task.replace(/[.?!]+$/, '').toLowerCase()), signal);
      this.setBlock(s, m, i, { type: 'thinking', text: (m.blocks[i] as { text: string }).text, durationMs: Date.now() - t0 });
      i++;
    }

    const wantsPlan = s.permissionMode === 'plan' || /\bplan\b/.test(lower);
    const wantsQuestion = /\b(ask|question|which|choose|prefer)\b/.test(lower);
    const wantsAgent = /\b(explore|subagent|agent|research|investigate)\b/.test(lower);
    const wantsRun = /\b(run|delete|remove|install|build|test|deploy)\b/.test(lower);

    await this.stream(s, m, i++, 'text', "I'll start by looking at the relevant code.", signal);

    // Grep (always)
    const grep: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'Grep', input: { pattern: 'reconnect|backoff', glob: 'src/**/*.ts' }, status: 'running', startedAt: Date.now() };
    this.setBlock(s, m, i, grep);
    this.setTool(s, m, i, grep);
    await this.sleep(700, signal);
    const files = ['src/renderer/src/lib/rpc.ts', 'src/renderer/src/state/sync.ts', 'src/core/server/ws.ts'];
    this.setTool(s, m, i++, {
      ...grep,
      status: 'done',
      endedAt: Date.now(),
      result: { content: files.join('\n'), display: { kind: 'list', title: `${files.length} files`, items: files } },
    });

    if (wantsAgent) await this.subagentStep(s, m, i++, task, signal);

    if (wantsQuestion) {
      const questions: Question[] = [
        {
          header: 'Approach',
          question: 'Which approach should I take?',
          multiSelect: false,
          options: [
            { label: 'Minimal fix', description: 'Smallest change that solves the problem' },
            { label: 'Refactor', description: 'Clean up the surrounding code while fixing it' },
          ],
        },
      ];
      const tool: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'AskUserQuestion', input: { questions }, status: 'running', startedAt: Date.now() };
      this.setBlock(s, m, i, tool);
      const req = { requestId: this.newId('q'), sessionId: s.id, toolUseId: tool.id, questions, createdAt: Date.now() };
      this.data.pending.questions.push(req);
      this.updateSession(s.id, { status: 'waiting' });
      this.emit('question.requested', req);
      const answers = await this.waitFor<Record<string, string>>(req.requestId, signal);
      this.updateSession(s.id, { status: 'running' });
      this.setTool(s, m, i++, { ...tool, status: 'done', endedAt: Date.now(), result: { content: JSON.stringify(answers), display: { kind: 'questions', questions, answers } } });
    }

    if (wantsPlan) {
      const plan = `## Plan\n\n1. Add \`backoffDelay(attempt)\` with jitter to \`lib/rpc.ts\`\n2. Re-send queued requests after reconnect\n3. Refetch sessions, models and GPU status in \`state/sync.ts\`\n4. Unit-test the backoff curve and the resubscribe path`;
      const tool: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'ExitPlanMode', input: { plan }, status: 'running', startedAt: Date.now() };
      this.setBlock(s, m, i, tool);
      const req = { requestId: this.newId('pl'), sessionId: s.id, toolUseId: tool.id, plan, createdAt: Date.now() };
      this.data.pending.plans.push(req);
      this.updateSession(s.id, { status: 'waiting' });
      this.emit('plan.requested', req);
      const r = await this.waitFor<{ approve: boolean; mode?: PermissionMode; feedback?: string }>(req.requestId, signal);
      this.updateSession(s.id, { status: 'running', ...(r.approve ? { permissionMode: r.mode ?? 'default' } : {}) });
      this.setTool(s, m, i++, { ...tool, status: 'done', endedAt: Date.now(), result: { content: r.approve ? 'Plan approved' : `Keep planning: ${r.feedback ?? ''}`, display: { kind: 'plan', plan } } });
      if (!r.approve) {
        await this.stream(s, m, i++, 'text', `Understood — I'll keep refining the plan${r.feedback ? `: ${r.feedback}` : ''}.`, signal);
        return;
      }
    }

    // Todo list
    const todos: Todo[] = [
      { id: 'd1', content: 'Read the WebSocket client', status: 'completed' },
      { id: 'd2', content: 'Add backoff with jitter', status: 'in_progress', activeForm: 'Adding backoff with jitter' },
      { id: 'd3', content: 'Verify with tests', status: 'pending' },
    ];
    const todoTool: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'TodoWrite', input: { todos }, status: 'done', startedAt: Date.now(), endedAt: Date.now(), result: { content: 'Todos updated', display: { kind: 'todos', todos } } };
    this.setBlock(s, m, i, todoTool);
    this.setTool(s, m, i++, todoTool);
    s.todos = todos;
    this.emit('todos.updated', { sessionId: s.id, todos });

    // Edit
    const path = `${s.cwd}\\src\\renderer\\src\\lib\\rpc.ts`;
    const before = 'private scheduleReconnect(): void {\n  this.retryTimer = setTimeout(() => this.open(), 1000);\n}';
    const after =
      'private scheduleReconnect(): void {\n  const attempt = this.state.attempt + 1;\n  const delay = backoffDelay(attempt, this.backoff);\n  this.setState({ status: \'reconnecting\', attempt, nextRetryAt: Date.now() + delay });\n  this.retryTimer = setTimeout(() => this.open(), delay);\n}';
    const edit: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'Edit', input: { file_path: path, old_string: before, new_string: after }, status: 'running', startedAt: Date.now() };
    this.setBlock(s, m, i, edit);
    await this.sleep(600, signal);
    this.setTool(s, m, i++, { ...edit, status: 'done', endedAt: Date.now(), result: { content: `Edited ${path}`, display: { kind: 'diff', path, before, after } } });
    const changed = s.changedFiles.filter((f) => f.path !== path);
    changed.push({ path, additions: 4, deletions: 1, isNew: false, lastToolUseId: edit.id });
    s.changedFiles = changed;
    this.emit('changes.updated', { sessionId: s.id, changedFiles: changed });

    // Bash (with a permission prompt when the prompt asks to run something)
    const command = wantsRun ? 'npm test -- tests/unit/ui-foundation' : 'npx tsc --noEmit -p tsconfig.web.json';
    const bash: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'Bash', input: { command, description: wantsRun ? 'Run the unit tests' : 'Typecheck the renderer' }, status: 'pending', startedAt: Date.now() };
    this.setBlock(s, m, i, bash);
    let denied = false;
    if (wantsRun && s.permissionMode !== 'bypassPermissions') {
      this.setTool(s, m, i, { ...bash, status: 'awaiting_permission' });
      const req = { requestId: this.newId('p'), sessionId: s.id, toolUseId: bash.id, toolName: 'Bash', input: bash.input, title: `Run: ${command}`, suggestedRule: 'Bash(npm test:*)', createdAt: Date.now() };
      this.data.pending.permissions.push(req);
      this.updateSession(s.id, { status: 'waiting' });
      this.emit('permission.requested', req);
      const r = await this.waitFor<{ decision: PermissionDecision; message?: string }>(req.requestId, signal);
      this.updateSession(s.id, { status: 'running' });
      denied = r.decision === 'deny';
      if (denied) {
        this.setTool(s, m, i++, { ...bash, status: 'denied', endedAt: Date.now(), result: { content: `User denied${r.message ? `: ${r.message}` : ''}`, isError: true } });
      }
    }
    if (!denied) {
      this.setTool(s, m, i, { ...bash, status: 'running', progress: '> vitest run\n' });
      await this.sleep(900, signal);
      const output = wantsRun
        ? ' RUN  v5.0.4\n\n ✓ tests/unit/ui-foundation/rpc.test.ts (8 tests) 120ms\n ✓ tests/unit/ui-foundation/transcript.test.ts (11 tests) 9ms\n\n Test Files  2 passed (2)\n      Tests  19 passed (19)\n   Duration  1.12s'
        : '';
      this.setTool(s, m, i++, { ...bash, status: 'done', endedAt: Date.now(), progress: undefined, result: { content: output || '(no output)', display: { kind: 'bash', command, output, exitCode: 0 } } });
    }
    const done = todos.map((t) => ({ ...t, status: 'completed' as const }));
    s.todos = done;
    this.emit('todos.updated', { sessionId: s.id, todos: done });

    const answer = denied
      ? "I didn't run the command since you denied it. The edit is in place — run the tests yourself when you're ready:\n\n```bash\nnpm test -- tests/unit/ui-foundation\n```"
      : [
          'Done. Reconnects now back off exponentially with jitter:',
          '',
          '- **Delay** grows `400ms → 720ms → 1.3s → …` and caps at **10s**',
          '- Queued requests are re-sent once the socket reopens',
          '- After every reconnect the store refetches sessions, models, GPU status and pending prompts',
          '',
          '| Attempt | Base delay | With jitter |',
          '|---:|---:|---|',
          '| 1 | 400 ms | 300–500 ms |',
          '| 3 | 1.3 s | 0.97–1.6 s |',
          '| 8 | 10 s | 7.5–12.5 s |',
          '',
          '```ts',
          'export function backoffDelay(attempt: number, o = DEFAULT_BACKOFF): number {',
          '  const base = Math.min(o.maxMs, o.initialMs * o.factor ** (attempt - 1));',
          '  const spread = base * o.jitter;',
          '  return Math.round(base - spread + Math.random() * 2 * spread);',
          '}',
          '```',
        ].join('\n');
    await this.stream(s, m, i++, 'text', answer, signal);
  }

  private async subagentStep(s: Session, m: Message, index: number, task: string, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const child: Session = {
      id: this.newId('s'),
      title: `Explore: ${task.slice(0, 40)}`,
      cwd: s.cwd,
      kind: 'subagent',
      parentSessionId: s.id,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      model: s.model,
      permissionMode: 'default',
      thinking: false,
      usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
      messages: [],
      todos: [],
      changedFiles: [],
    };
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: this.newId('tu'),
      name: 'Task',
      input: { description: 'Find reconnect call sites', subagent_type: 'Explore', prompt: task },
      status: 'running',
      startedAt: now,
    };
    child.parentToolUseId = tool.id;
    this.data.sessions.push(child);
    this.emit('session.created', summaryOf(child));
    this.setBlock(s, m, index, { ...tool, result: { content: '', display: { kind: 'subagent', sessionId: child.id, agentType: 'Explore', description: 'Find reconnect call sites' } } });
    this.setActivity({ id: `a-${child.id}`, kind: 'subagent', title: child.title, sessionId: child.id, status: 'running', startedAt: now, detail: 'Explore' });
    const cm: Message = { id: this.newId('m'), role: 'assistant', createdAt: Date.now(), blocks: [] };
    this.addMessage(child, { id: this.newId('m'), role: 'user', createdAt: now, blocks: [{ type: 'text', text: task }] });
    this.addMessage(child, cm);
    await this.stream(child, cm, 0, 'text', 'Searching for WebSocket close handlers and reconnect logic…', signal);
    const g: ToolUseBlock = { type: 'tool_use', id: this.newId('tu'), name: 'Grep', input: { pattern: 'onclose' }, status: 'running', startedAt: Date.now() };
    this.setBlock(child, cm, 1, g);
    await this.sleep(900, signal);
    this.setTool(child, cm, 1, { ...g, status: 'done', endedAt: Date.now(), result: { content: '3 matches', display: { kind: 'list', title: '3 matches', items: ['src/renderer/src/lib/rpc.ts:241', 'src/core/server/ws.ts:88', 'src/core/server/ws.ts:132'] } } });
    await this.stream(child, cm, 2, 'text', 'Found 3 call sites: the renderer client and two in the core server.', signal);
    this.emit('message.completed', { sessionId: child.id, messageId: cm.id, meta: { durationMs: Date.now() - now } });
    child.status = 'idle';
    this.emit('session.updated', summaryOf(child));
    this.setActivity({ id: `a-${child.id}`, kind: 'subagent', title: child.title, sessionId: child.id, status: 'done', startedAt: now, endedAt: Date.now(), detail: 'Explore' });
    this.setTool(s, m, index, {
      ...tool,
      status: 'done',
      endedAt: Date.now(),
      result: { content: 'Found 3 call sites.', display: { kind: 'subagent', sessionId: child.id, agentType: 'Explore', description: 'Find reconnect call sites' } },
    });
  }

  private async finishSeededPermission(sessionId: string, toolUseId: string, toolName: string, input: Record<string, unknown>, decision: PermissionDecision): Promise<void> {
    const s = this.data.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const now = Date.now();
    const m: Message = { id: this.newId('m'), role: 'assistant', createdAt: now, blocks: [] };
    this.updateSession(sessionId, { status: 'running', updatedAt: now });
    this.addMessage(s, m);
    const tool: ToolUseBlock = { type: 'tool_use', id: toolUseId, name: toolName, input, status: decision === 'deny' ? 'denied' : 'running', startedAt: now };
    this.setBlock(s, m, 0, tool);
    if (decision !== 'deny') {
      await this.sleep(1200);
      const command = String(input.command ?? '');
      this.setTool(s, m, 0, { ...tool, status: 'done', endedAt: Date.now(), result: { content: 'ok', display: { kind: 'bash', command, output: 'vite v7.3.7 building for production...\n✓ 1423 modules transformed.\n✓ built in 6.41s', exitCode: 0 } } });
      await this.stream(s, m, 1, 'text', 'Removed the stale folders and rebuilt successfully.', new AbortController().signal);
    } else {
      await this.stream(s, m, 1, 'text', "OK — I won't delete anything.", new AbortController().signal);
    }
    this.emit('message.completed', { sessionId, messageId: m.id, meta: { durationMs: Date.now() - now } });
    this.updateSession(sessionId, { status: 'idle', updatedAt: Date.now() });
  }
}

export function createDemoTransport(opts?: DemoTransportOptions): DemoTransport {
  return new DemoTransport(opts);
}

export function getActiveDemoTransport(): DemoTransport | null {
  return activeTransport;
}
