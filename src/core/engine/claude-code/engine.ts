// The claude-code engine: runs a session on the real Claude Code harness (Claude Agent SDK → bundled claude.exe)
// pointed at the session's own model endpoint through the local shim (../shim.ts). Every model call of the harness
// goes to that endpoint; no Anthropic account is involved. See docs/research/claude-agent-sdk.md.
//
// One long-lived SDK query per active session in streaming-input mode. The app keeps its own queue (one turn at a
// time) so queued messages can still be withdrawn and every turn maps to a resumable point of the Claude session.

import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffLines } from 'diff';
import type { CoreContext, ToolDef } from '../../contracts';
import type { CoreEventName, CoreEvents } from '../../../shared/protocol';
import type {
  ActivityItem, EngineInfo, ImageBlock, Message, ModelInfo, PermissionDecision, PermissionMode, PermissionRequest, PlanRequest,
  QuestionRequest, Session, SlashCommandInfo, ToolDisplay,
} from '../../../shared/types';
import { CheckpointStore, pathKey } from '../../agent/checkpoints';
import { renderTranscript } from '../../agent/compaction';
import { decidePermission, isInside } from '../../agent/permissions';
import { localDate, osName, shellName } from '../../agent/prompt';
import { clipLine, errorMessage, isDefaultTitle, newId, sanitizeTitle, toSummary } from '../../agent/util';
import { resolveShellKind } from '../../tools/lib/shell';
import { buildClaudeEnv, resolveClaudeExecutable, type ExecutableInfo } from '../env';
import { AnthropicShim, modelAlias } from '../shim';
import { EDIT_TOOL_NAMES, inputFilePath, toQuestions, uiToolName } from './display';
import { createObsidianMcpServer, stableKey } from './mcp';
import { leanSystemPrompt, prepareConfigDir } from './setup';
import { Translator, type TranslatorHost } from './translate';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');
type Query = import('@anthropic-ai/claude-agent-sdk').Query;
type Options = import('@anthropic-ai/claude-agent-sdk').Options;
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult;
type PermissionUpdate = import('@anthropic-ai/claude-agent-sdk').PermissionUpdate;
type Obj = Record<string, unknown>;

export const HEADLESS_NO_ANSWER = '(no answer — running unattended)';
const IDLE_CLOSE_MS = 10 * 60_000;
const INTERRUPT_GRACE_MS = 8_000;
/** Reasons decidePermission gives for reads/edits of sensitive locations: Claude Code must ask even when it would not. */
const PROTECTED_REASON = /credential|data folder|UNC|protected path/i;

export interface TurnResult { ok: boolean; finalText: string; error?: string; interrupted?: boolean }

interface QueueItem {
  messageId: string;
  text: string;
  images?: ImageBlock[];
  tag?: Message['tag'];
  headless?: boolean;
  onDone?: (r: TurnResult) => void;
}

/** Persisted per session (kv 'claude-code.<sessionId>'). */
export interface EngineState {
  sdkSessionId?: string;
  /** Last main-chain entry uuid seen (resume point for the next turn). */
  lastUuid?: string;
  /** user message id → chain uuid just before it (resumeSessionAt for a rewind to that message). */
  turns: { messageId: string; resumeAt?: string }[];
  /** Pending truncating resume (set by rewind, consumed by the next start). */
  fork?: { resumeAt: string };
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(m: SDKUserMessage): void {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false }); else this.items.push(m);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined as never, done: true }); },
    };
  }
}

interface Live {
  q: Query;
  input: InputQueue;
  key: string;
  mode: PermissionMode;
  configDir: string;
  closed: boolean;
  pump: Promise<void>;
  commands?: SlashCommandInfo[];
}

interface Turn { resolve: (r: TurnResult) => void; interruptTimer?: ReturnType<typeof setTimeout> }

interface Rt {
  id: string;
  busy: boolean;
  queue: QueueItem[];
  live: Live | null;
  starting: Promise<Live> | null;
  turn: Turn | null;
  translator: Translator;
  headless: boolean;
  pendingHuman: number;
  idleWaiters: (() => void)[];
  titleDone: boolean;
  provisionalTitle?: string;
  activityStartedAt: number;
  activityRegistered: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  currentTurnId?: string;
  interruptRequested: boolean;
  /** A turn Claude Code started by itself (e.g. reacting to a finished background agent). */
  backgroundTurn: boolean;
  backgroundWaiters: (() => void)[];
  /** Tool calls denied via canUseTool (shown as 'denied'). */
  denied: Set<string>;
  /** PreToolUse snapshots for diffs. */
  before: Map<string, { existed: boolean; content: string }>;
  /** Rich displays produced by the obsidian MCP tools, keyed by stableKey(name, input). */
  mcpDisplays: Map<string, ToolDisplay>;
  stderrTail: string;
}

type Pending =
  | { kind: 'permission'; ownerId: string; request: PermissionRequest; resolve: (v: { decision: PermissionDecision; message?: string } | null) => void }
  | { kind: 'question'; ownerId: string; request: QuestionRequest; resolve: (v: Record<string, string> | null) => void }
  | { kind: 'plan'; ownerId: string; request: PlanRequest; resolve: (v: { approved: boolean; mode: PermissionMode; feedback?: string } | null) => void };

export interface ClaudeCodeEngineDeps {
  loadSdk?: () => Promise<Pick<Sdk, 'query'>>;
  shim?: AnthropicShim;
  /** null = the endpoint serves /v1/messages; else a user-facing reason. */
  probeMessagesApi?: (baseUrl: string, apiKey: string | undefined, model: string) => Promise<string | null>;
  resolveExecutable?: (setting: string | undefined) => ExecutableInfo;
  idleCloseMs?: number;
  appVersion?: string;
  /** ~/.claude (tests point this elsewhere). */
  userClaudeDir?: string;
}

const STATIC_COMMANDS: SlashCommandInfo[] = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin', argumentHint: '<optional custom summarization instructions>' },
  { name: 'context', description: 'Show current context usage', source: 'builtin' },
  { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'builtin' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', source: 'builtin' },
  { name: 'review', description: 'Review a pull request', source: 'builtin' },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch', source: 'builtin' },
];

function clone<T>(v: T): T { return structuredClone(v); }

/** Probe POST /v1/messages/count_tokens: llama.cpp (b5xxx+) and Anthropic-compatible servers answer it. */
export async function probeMessagesApi(baseUrl: string, apiKey: string | undefined, model: string): Promise<string | null> {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (apiKey) { headers.authorization = `Bearer ${apiKey}`; headers['x-api-key'] = apiKey; }
  let res: Response;
  try {
    res = await fetch(`${root}/v1/messages/count_tokens`, {
      method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`The model endpoint ${root} is unreachable (${errorMessage(e)}).`);
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return `This model endpoint (${root}) does not serve the Anthropic Messages API (/v1/messages), which the Claude Code engine needs. Use a llama.cpp server (llama-server) or switch this session to the Obsidian engine.`;
  }
  if (res.status === 401 || res.status === 403) return `The model endpoint ${root} rejected the API key (HTTP ${res.status}).`;
  return null;
}

export class ClaudeCodeEngine {
  private readonly runtimes = new Map<string, Rt>();
  private readonly pendingReqs = new Map<string, Pending>();
  private readonly probed = new Map<string, string | null>();
  private readonly states = new Map<string, EngineState>();
  private readonly checkpoints: CheckpointStore;
  private readonly shim: AnthropicShim;
  private sdk: Promise<Pick<Sdk, 'query'>> | null = null;
  private subscribed = false;
  private commandCache: SlashCommandInfo[] | null = null;
  private versionCache = new Map<string, Promise<string | undefined>>();

  constructor(private readonly ctx: CoreContext, private readonly deps: ClaudeCodeEngineDeps = {}) {
    this.checkpoints = new CheckpointStore(ctx.dataDir);
    this.shim = deps.shim ?? new AnthropicShim();
  }

  // ───────────────────────────── plumbing ─────────────────────────────

  private emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void {
    try { this.ctx.bus.emit(event, data); } catch { /* listeners must not break the engine */ }
  }

  private session(id: string): Session {
    const s = this.ctx.sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return s;
  }

  private mutate<T>(id: string, fn: (s: Session) => T): T {
    const s = this.session(id);
    const r = fn(s);
    s.updatedAt = Date.now();
    this.ctx.sessions.save(s);
    return r;
  }

  private emitSession(id: string): void {
    const s = this.ctx.sessions.get(id);
    if (s) this.emit('session.updated', toSummary(s));
  }

  private stateKey(id: string): string { return `claude-code.${id}`; }

  /** Per-session engine state (write-through cache over the kv store, which survives restarts). */
  state(id: string): EngineState {
    let st = this.states.get(id);
    if (!st) {
      try { st = this.ctx.kv.read<EngineState>(this.stateKey(id), { turns: [] }); } catch { st = { turns: [] }; }
      if (!Array.isArray(st.turns)) st.turns = [];
      this.states.set(id, st);
    }
    return st;
  }

  private saveState(id: string, st: EngineState): void {
    this.states.set(id, st);
    try { this.ctx.kv.write(this.stateKey(id), st); } catch { /* best effort */ }
  }

  private settings() {
    const s = this.ctx.settings.get();
    const cc = s.engine?.claudeCode;
    return {
      all: s,
      executable: cc?.executable ?? 'auto',
      systemPrompt: cc?.systemPrompt ?? 'lean',
      importUser: cc?.importUserClaudeConfig ?? true,
      extraEnv: cc?.extraEnv ?? {},
    };
  }

  private loadSdk(): Promise<Pick<Sdk, 'query'>> {
    this.sdk ??= (this.deps.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk')))();
    this.sdk.catch(() => { this.sdk = null; });
    return this.sdk;
  }

  private translatorHost(): TranslatorHost {
    return {
      session: (id) => this.ctx.sessions.get(id),
      mutate: (id, fn) => this.mutate(id, fn),
      emit: (e, d) => this.emit(e, d),
      newId,
      createSubagent: (parentId, toolUseId, agentType, description) => this.createSubagent(parentId, toolUseId, agentType, description),
      setStatus: (id, status) => {
        const changed = this.mutate(id, (s) => { if (s.status === status) return false; s.status = status; return true; });
        if (changed) this.emitSession(id);
      },
      takeBefore: (toolUseId) => {
        for (const rt of this.runtimes.values()) {
          const b = rt.before.get(toolUseId);
          if (b) { rt.before.delete(toolUseId); return b; }
        }
        return undefined;
      },
      readText: (abs) => { try { return readFileSync(abs, 'utf8'); } catch { return null; } },
      recordChange: (sessionId, toolUseId, abs) => this.recordChange(sessionId, toolUseId, abs),
      takeMcpDisplay: (name, input) => {
        for (const rt of this.runtimes.values()) {
          const key = stableKey(name, input);
          const d = rt.mcpDisplays.get(key);
          if (d) { rt.mcpDisplays.delete(key); return d; }
        }
        return undefined;
      },
      wasDenied: (toolUseId) => [...this.runtimes.values()].some((rt) => rt.denied.has(toolUseId)),
      resolvePath: (sessionId, p) => resolve(this.ctx.sessions.get(sessionId)?.cwd ?? '.', p),
    };
  }

  private runtime(id: string): Rt {
    if (!this.subscribed) {
      this.subscribed = true;
      try {
        this.ctx.bus.on('session.deleted', ({ sessionId }) => {
          const rt = this.runtimes.get(sessionId);
          if (!rt) return;
          this.interrupt(sessionId);
          for (const item of rt.queue.splice(0)) item.onDone?.({ ok: false, finalText: '', interrupted: true });
          this.closeLive(rt);
          this.runtimes.delete(sessionId);
        });
        // permission mode changed by the user (or by plan approval) while a query is live → tell Claude Code now
        this.ctx.bus.on('session.updated', (sum) => {
          const rt = this.runtimes.get(sum.id);
          const live = rt?.live;
          if (!live || live.closed || live.mode === sum.permissionMode) return;
          live.mode = sum.permissionMode;
          void live.q.setPermissionMode(sum.permissionMode).catch(() => undefined);
        });
      } catch { /* bus without listeners (tests) */ }
    }
    let rt = this.runtimes.get(id);
    if (!rt) {
      const s = this.session(id);
      rt = {
        id, busy: false, queue: [], live: null, starting: null, turn: null, translator: new Translator(this.translatorHost(), id),
        headless: false, pendingHuman: 0, idleWaiters: [], titleDone: false, activityStartedAt: Date.now(), activityRegistered: false,
        interruptRequested: false, backgroundTurn: false, backgroundWaiters: [], denied: new Set(), before: new Map(), mcpDisplays: new Map(), stderrTail: '',
      };
      this.runtimes.set(id, rt);
      if (s.status === 'running' || s.status === 'waiting') this.mutate(id, (x) => { x.status = 'idle'; });
    }
    return rt;
  }

  private setStatus(rt: Rt, status: Session['status']): void {
    const changed = this.mutate(rt.id, (s) => { if (s.status === status) return false; s.status = status; return true; });
    if (changed) this.emitSession(rt.id);
  }

  private activity(rt: Rt, status: ActivityItem['status'], detail?: string): void {
    try {
      const s = this.session(rt.id);
      const ended = status === 'done' || status === 'error' || status === 'stopped';
      this.ctx.activity.upsert({
        id: rt.id, kind: 'session', title: s.title || 'Session', sessionId: rt.id, status,
        startedAt: rt.activityStartedAt, endedAt: ended ? Date.now() : undefined, detail,
      });
      if (!rt.activityRegistered) {
        rt.activityRegistered = true;
        this.ctx.activity.onStop(rt.id, () => this.interrupt(rt.id));
      }
    } catch { /* optional */ }
  }

  private addMessage(sessionId: string, msg: Message): void {
    this.mutate(sessionId, (s) => { s.messages.push(msg); });
    this.emit('message.added', { sessionId, message: clone(msg) });
  }

  private note(sessionId: string, text: string, tag: Message['tag'] = 'command'): void {
    const msg: Message = { id: newId(), role: 'assistant', tag, createdAt: Date.now(), blocks: [{ type: 'text', text }] };
    this.addMessage(sessionId, msg);
    this.emit('message.completed', { sessionId, messageId: msg.id, meta: {} });
  }

  private reportError(rt: Rt, message: string): void {
    try { this.setStatus(rt, 'error'); } catch { /* session gone */ }
    this.activity(rt, 'error', message);
    this.emit('error', { message, sessionId: rt.id });
  }

  private createSubagent(parentId: string, toolUseId: string, agentType: string, description: string): string {
    const ps = this.session(parentId);
    const child = this.ctx.sessions.create({
      cwd: ps.cwd, kind: 'subagent', parentSessionId: parentId, parentToolUseId: toolUseId, title: description || agentType,
      model: ps.model, permissionMode: ps.permissionMode, thinking: ps.thinking, engine: 'claude-code', status: 'running',
    });
    this.emit('session.created', toSummary(child));
    return child.id;
  }

  // ───────────────────────────── changes / checkpoints ─────────────────────────────

  private recordChange(sessionId: string, toolUseId: string, abs: string): void {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const rootId = s.kind === 'subagent' && s.parentSessionId ? s.parentSessionId : sessionId;
    const targets = rootId === sessionId ? [sessionId] : [sessionId, rootId];
    void (async () => {
      let after = '';
      let exists = true;
      try { after = await fs.readFile(abs, 'utf8'); } catch { exists = false; }
      const orig = await this.checkpoints.original(rootId, abs).catch(() => null);
      const before = orig?.existed ? orig.content.toString('utf8') : '';
      let additions = 0;
      let deletions = 0;
      if (before.length + after.length <= 4_000_000) {
        for (const part of diffLines(before, after)) {
          if (part.added) additions += part.count ?? 0;
          else if (part.removed) deletions += part.count ?? 0;
        }
      }
      for (const sid of targets) {
        const changed = this.mutate(sid, (x) => {
          const key = pathKey(abs);
          const f = x.changedFiles.find((c) => pathKey(resolve(x.cwd, c.path)) === key);
          if (!exists && orig && !orig.existed) { x.changedFiles = x.changedFiles.filter((c) => c !== f); return true; }
          if (f) Object.assign(f, { additions, deletions, isNew: f.isNew || !orig?.existed, lastToolUseId: toolUseId });
          else x.changedFiles.push({ path: abs, additions, deletions, isNew: orig ? !orig.existed : false, lastToolUseId: toolUseId });
          return true;
        });
        if (changed) this.emit('changes.updated', { sessionId: sid, changedFiles: clone(this.session(sid).changedFiles) });
      }
    })().catch(() => undefined);
  }

  async fileDiff(sessionId: string, path: string): Promise<{ before: string; after: string }> {
    const s = this.session(sessionId);
    const abs = resolve(s.cwd, path);
    let after = '';
    try { after = await fs.readFile(abs, 'utf8'); } catch { after = ''; }
    const root = s.kind === 'subagent' && s.parentSessionId ? s.parentSessionId : sessionId;
    const orig = await this.checkpoints.original(root, abs);
    if (!orig) return { before: after, after };
    return { before: orig.existed ? orig.content.toString('utf8') : '', after };
  }

  // ───────────────────────────── public API ─────────────────────────────

  async send(sessionId: string, text: string, images?: ImageBlock[]): Promise<{ messageId: string; queued: boolean }> {
    this.session(sessionId);
    if (!text.trim() && !images?.length) throw new Error('Empty message');
    const rt = this.runtime(sessionId);
    const messageId = newId();
    return { messageId, queued: this.enqueue(rt, { messageId, text, images }) };
  }

  dequeue(sessionId: string, messageId?: string): { messageId: string; text: string }[] {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return [];
    const removed: { messageId: string; text: string }[] = [];
    rt.queue = rt.queue.filter((item) => {
      if (item.onDone || (messageId && item.messageId !== messageId)) return true;
      removed.push({ messageId: item.messageId, text: item.text });
      return false;
    });
    return removed;
  }

  async runHeadless(opts: { sessionId: string; prompt: string }): Promise<{ ok: boolean; finalText: string }> {
    const s = this.session(opts.sessionId);
    const rt = this.runtime(opts.sessionId);
    const r = await new Promise<TurnResult>((done) => {
      this.enqueue(rt, { messageId: newId(), text: opts.prompt, headless: true, tag: s.kind === 'scheduled' ? 'scheduled_prompt' : undefined, onDone: done });
    });
    return { ok: r.ok, finalText: r.finalText || (r.error ? `Error: ${r.error}` : '') };
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.busy ?? false;
  }

  owns(requestId: string): boolean {
    return this.pendingReqs.has(requestId);
  }

  pending(sessionId?: string): { permissions: PermissionRequest[]; questions: QuestionRequest[]; plans: PlanRequest[] } {
    const out = { permissions: [] as PermissionRequest[], questions: [] as QuestionRequest[], plans: [] as PlanRequest[] };
    for (const p of this.pendingReqs.values()) {
      if (sessionId && p.request.sessionId !== sessionId && p.ownerId !== sessionId) continue;
      if (p.kind === 'permission') out.permissions.push(clone(p.request));
      else if (p.kind === 'question') out.questions.push(clone(p.request));
      else out.plans.push(clone(p.request));
    }
    return out;
  }

  respondPermission(requestId: string, decision: PermissionDecision, message?: string): void {
    const p = this.pendingReqs.get(requestId);
    if (!p || p.kind !== 'permission') throw new Error('No pending permission request with that id (it may have been answered already).');
    this.pendingReqs.delete(requestId);
    this.emit('permission.resolved', { requestId, sessionId: p.request.sessionId, decision });
    p.resolve({ decision, message });
  }

  answerQuestion(requestId: string, answers: Record<string, string>): void {
    const p = this.pendingReqs.get(requestId);
    if (!p || p.kind !== 'question') throw new Error('No pending question with that id (it may have been answered already).');
    this.pendingReqs.delete(requestId);
    this.emit('question.resolved', { requestId, sessionId: p.request.sessionId });
    p.resolve(answers ?? {});
  }

  respondPlan(requestId: string, approve: boolean, mode?: PermissionMode, feedback?: string): void {
    const p = this.pendingReqs.get(requestId);
    if (!p || p.kind !== 'plan') throw new Error('No pending plan approval with that id (it may have been answered already).');
    this.pendingReqs.delete(requestId);
    this.emit('plan.resolved', { requestId, sessionId: p.request.sessionId, approved: approve });
    p.resolve({ approved: approve, mode: mode ?? 'default', feedback });
  }

  private resolvePendingNull(requestId: string): void {
    const p = this.pendingReqs.get(requestId);
    if (!p) return;
    this.pendingReqs.delete(requestId);
    if (p.kind === 'permission') this.emit('permission.resolved', { requestId, sessionId: p.request.sessionId, decision: 'deny' });
    else if (p.kind === 'question') this.emit('question.resolved', { requestId, sessionId: p.request.sessionId });
    else this.emit('plan.resolved', { requestId, sessionId: p.request.sessionId, approved: false });
    (p.resolve as (v: null) => void)(null);
  }

  interrupt(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    for (const [id, p] of [...this.pendingReqs]) if (p.ownerId === sessionId) this.resolvePendingNull(id);
    if (rt.busy) rt.interruptRequested = true; // also covers a turn that is still starting the harness
    const turn = rt.turn;
    if (!turn) return;
    const live = rt.live;
    if (live && !live.closed) void live.q.interrupt().catch(() => undefined);
    // a harness that does not answer the interrupt is stopped hard; the next turn resumes the Claude session
    turn.interruptTimer ??= setTimeout(() => {
      if (rt.turn !== turn) return;
      this.closeLive(rt);
      this.finishTurn(rt, { ok: false, finalText: '', interrupted: true });
    }, live ? INTERRUPT_GRACE_MS : 0);
  }

  async rewind(sessionId: string, atMessageId: string, restoreFiles: boolean): Promise<string[]> {
    const rt = this.runtime(sessionId);
    if (rt.busy) {
      for (const item of rt.queue.splice(0)) item.onDone?.({ ok: false, finalText: '', interrupted: true });
      this.interrupt(sessionId);
      await new Promise<void>((r) => { const t = setTimeout(r, 12_000); rt.idleWaiters.push(() => { clearTimeout(t); r(); }); });
    }
    const s = this.session(sessionId);
    const idx = s.messages.findIndex((m) => m.id === atMessageId);
    if (idx < 0) throw new Error('That message is no longer in this session.');
    if (s.messages[idx]!.role !== 'user') throw new Error('Rewind needs a user message.');
    const turnIds = s.messages.slice(idx).filter((m) => m.role === 'user').map((m) => m.id);
    let restored: string[] = [];
    if (restoreFiles) {
      restored = await this.checkpoints.restore(sessionId, turnIds);
      await this.checkpoints.drop(sessionId, turnIds);
    }
    const restoredKeys = new Set(restored.map(pathKey));
    this.mutate(sessionId, (x) => {
      x.messages = x.messages.slice(0, idx);
      if (restoreFiles) x.changedFiles = x.changedFiles.filter((f) => !restoredKeys.has(pathKey(resolve(x.cwd, f.path))));
    });
    // the Claude session continues from the chain entry just before the rewound message (a fork of it), or starts
    // over (seeded with the remaining transcript) when that point is unknown
    this.closeLive(rt);
    const st = this.state(sessionId);
    const entry = st.turns.find((t) => t.messageId === atMessageId);
    if (st.sdkSessionId && entry?.resumeAt) {
      st.fork = { resumeAt: entry.resumeAt };
      st.lastUuid = entry.resumeAt;
    } else {
      st.sdkSessionId = undefined;
      st.fork = undefined;
      st.lastUuid = undefined;
    }
    const drop = new Set(turnIds);
    st.turns = st.turns.filter((t) => !drop.has(t.messageId));
    this.saveState(sessionId, st);
    this.emit('session.reset', { sessionId });
    if (restoreFiles) this.emit('changes.updated', { sessionId, changedFiles: clone(this.session(sessionId).changedFiles) });
    this.emitSession(sessionId);
    return restored;
  }

  /** Engine switch onto claude-code: the next turn starts a fresh Claude session seeded with the transcript. */
  resetForSwitch(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (rt) this.closeLive(rt);
    this.saveState(sessionId, { turns: [] });
  }

  async commands(sessionId?: string): Promise<SlashCommandInfo[]> {
    const rt = sessionId ? this.runtimes.get(sessionId) : undefined;
    const live = rt?.live;
    if (live && !live.closed) {
      if (!live.commands) {
        try { live.commands = this.toCommandInfo(await live.q.supportedCommands()); } catch { /* fall back */ }
      }
      if (live.commands?.length) { this.commandCache = live.commands; return clone(live.commands); }
    }
    if (!this.commandCache) {
      const cached = this.ctx.kv.read<SlashCommandInfo[] | null>('claude-code.commands', null);
      if (Array.isArray(cached) && cached.length) this.commandCache = cached;
    }
    return clone(this.commandCache ?? STATIC_COMMANDS);
  }

  private toCommandInfo(list: { name: string; description: string; argumentHint?: string }[]): SlashCommandInfo[] {
    return list
      .filter((c) => c && typeof c.name === 'string' && c.name)
      .map((c) => ({ name: c.name.replace(/^\//, ''), description: c.description ?? '', source: 'builtin' as const, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }));
  }

  async info(): Promise<EngineInfo> {
    const exe = (this.deps.resolveExecutable ?? resolveClaudeExecutable)(this.settings().executable);
    if (!exe.path) return { id: 'claude-code', label: 'Claude Code', available: false, detail: exe.error ?? 'Claude Code was not found.' };
    try { await this.loadSdk(); } catch (e) {
      return { id: 'claude-code', label: 'Claude Code', available: false, detail: `The Claude Agent SDK could not be loaded: ${errorMessage(e)}` };
    }
    const version = exe.version ?? await this.executableVersion(exe.path);
    const where = exe.source === 'sdk' ? 'bundled with' : exe.source === 'installed' ? 'installed claude, driven by' : 'custom executable, driven by';
    return {
      id: 'claude-code', label: 'Claude Code', available: true,
      detail: `Claude Code ${version ?? '(unknown version)'} — ${where} Agent SDK ${exe.sdkVersion ?? '?'}`,
    };
  }

  private executableVersion(path: string): Promise<string | undefined> {
    let p = this.versionCache.get(path);
    if (!p) {
      p = new Promise((done) => {
        try {
          execFile(path, ['--version'], { timeout: 15_000, windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, (err, stdout) => {
            done(err ? undefined : /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1]);
          });
        } catch { done(undefined); }
      });
      this.versionCache.set(path, p);
    }
    return p;
  }

  dispose(): void {
    for (const rt of this.runtimes.values()) this.closeLive(rt);
    this.shim.close();
  }

  // ───────────────────────────── queue ─────────────────────────────

  private enqueue(rt: Rt, item: QueueItem): boolean {
    const queued = rt.busy;
    rt.queue.push(item);
    if (!rt.busy) {
      rt.busy = true;
      void this.drain(rt);
    }
    return queued;
  }

  private async drain(rt: Rt): Promise<void> {
    if (rt.idleTimer) { clearTimeout(rt.idleTimer); rt.idleTimer = undefined; }
    try {
      while (rt.queue.length) {
        const item = rt.queue.shift()!;
        let result: TurnResult;
        try {
          result = await this.runTurn(rt, item);
        } catch (e) {
          result = { ok: false, finalText: '', error: errorMessage(e) };
          this.reportError(rt, errorMessage(e));
        }
        try { item.onDone?.(result); } catch { /* ignore */ }
      }
    } finally {
      rt.busy = false;
      for (const w of rt.idleWaiters.splice(0)) w();
      if (rt.live && !rt.live.closed) {
        rt.idleTimer = setTimeout(() => { if (!rt.busy) this.closeLive(rt); }, this.deps.idleCloseMs ?? IDLE_CLOSE_MS);
        rt.idleTimer.unref?.();
      }
    }
  }

  // ───────────────────────────── one turn ─────────────────────────────

  private async runTurn(rt: Rt, item: QueueItem): Promise<TurnResult> {
    rt.headless = !!item.headless;
    rt.interruptRequested = false;
    rt.activityStartedAt = Date.now();
    const s0 = this.session(rt.id);
    const text = item.text ?? '';
    const isCommand = /^\/[A-Za-z]/.test(text.trim()) && !item.images?.length;
    const blocks: Message['blocks'] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of item.images ?? []) blocks.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name });
    const priorMessages = s0.messages.filter((m) => m.role !== 'system');
    const userMsg: Message = { id: item.messageId, role: 'user', createdAt: Date.now(), blocks };
    if (item.tag) userMsg.tag = item.tag;
    else if (isCommand) userMsg.tag = 'command';
    this.setStatus(rt, 'running');
    this.activity(rt, 'running');
    this.addMessage(rt.id, userMsg);
    if (isDefaultTitle(s0.title) && text.trim() && !isCommand) {
      rt.provisionalTitle = clipLine(text, 50);
      this.mutate(rt.id, (x) => { x.title = rt.provisionalTitle!; });
      this.emitSession(rt.id);
    }

    let live: Live;
    try {
      live = await this.ensureLive(rt);
    } catch (e) {
      const message = errorMessage(e);
      this.reportError(rt, message);
      return { ok: false, finalText: '', error: message };
    }
    if (rt.interruptRequested) {
      this.setStatus(rt, 'idle');
      this.activity(rt, 'stopped');
      return { ok: false, finalText: '', interrupted: true };
    }
    const st = this.state(rt.id);
    // a session that has history the Claude session does not know (engine switch, fork, failed resume): seed it
    let prompt = text;
    if (!st.sdkSessionId && !st.turns.length && priorMessages.length && !isCommand) {
      const model = this.ctx.sessions.get(rt.id)?.model;
      let ctxLen = 32_768;
      try { ctxLen = this.ctx.models.resolve(model ?? null).model.contextLength || ctxLen; } catch { /* default */ }
      const transcript = renderTranscript(priorMessages, Math.max(8_000, Math.min(120_000, Math.floor(ctxLen * 1.2))));
      if (transcript.trim()) {
        prompt = `<system-reminder>\nThis conversation started earlier (in another engine or session). Transcript so far:\n\n${transcript}\n</system-reminder>\n\n${text}`;
      }
    }
    // let a turn Claude Code started on its own finish first, so this turn's result is ours
    if (rt.backgroundTurn) await new Promise<void>((r) => { const t = setTimeout(r, 30 * 60_000); rt.backgroundWaiters.push(() => { clearTimeout(t); r(); }); });
    st.turns.push({ messageId: item.messageId, resumeAt: st.lastUuid });
    this.saveState(rt.id, st);
    rt.currentTurnId = item.messageId;
    rt.translator.beginTurn();
    rt.translator.lastChainUuid = st.lastUuid;

    const content: Obj[] = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    for (const img of item.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    const done = new Promise<TurnResult>((resolveTurn) => { rt.turn = { resolve: resolveTurn }; });
    live.input.push({
      type: 'user',
      message: { role: 'user', content: content.length === 1 && content[0]!.type === 'text' ? prompt : content } as SDKUserMessage['message'],
      parent_tool_use_id: null,
    });
    const result = await done;
    const st2 = this.state(rt.id);
    if (rt.translator.lastChainUuid) { st2.lastUuid = rt.translator.lastChainUuid; this.saveState(rt.id, st2); }
    if (result.error && !result.interrupted) {
      this.reportError(rt, result.error);
    } else {
      this.setStatus(rt, 'idle');
      this.activity(rt, result.interrupted ? 'stopped' : 'done');
    }
    if (result.ok && !isCommand) void this.maybeTitle(rt, text);
    return result;
  }

  private finishTurn(rt: Rt, r: TurnResult): void {
    const turn = rt.turn;
    if (!turn) return;
    rt.turn = null;
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    rt.translator.endTurn(!!r.interrupted);
    for (const [id, p] of [...this.pendingReqs]) if (p.ownerId === rt.id) this.resolvePendingNull(id);
    rt.denied.clear();
    rt.before.clear();
    turn.resolve(r);
  }

  // ───────────────────────────── the Claude Code process ─────────────────────────────

  private liveKey(s: Session, model: ModelInfo, endpointBase: string): string {
    const cc = this.settings();
    return JSON.stringify([endpointBase, model.ref.model, s.thinking, cc.systemPrompt, cc.executable, cc.importUser, cc.extraEnv, s.cwd]);
  }

  private closeLive(rt: Rt): void {
    const live = rt.live;
    rt.live = null;
    if (rt.idleTimer) { clearTimeout(rt.idleTimer); rt.idleTimer = undefined; }
    if (!live || live.closed) return;
    live.closed = true;
    try { live.input.close(); } catch { /* ignore */ }
    try { live.q.close(); } catch { /* ignore */ }
  }

  private trusted(cwd: string): boolean {
    const s = this.settings().all;
    return (s.trustedFolders ?? []).some((f) => { try { return isInside(f, cwd); } catch { return false; } });
  }

  private async ensureLive(rt: Rt): Promise<Live> {
    if (rt.starting) return rt.starting;
    const s = this.session(rt.id);
    let resolved: { endpoint: { baseUrl: string; apiKey?: string }; model: ModelInfo };
    try {
      resolved = this.ctx.models.resolve(s.model);
    } catch {
      await this.ctx.models.refresh().catch(() => undefined);
      resolved = this.ctx.models.resolve(this.session(rt.id).model);
    }
    if (!s.model) { this.mutate(rt.id, (x) => { x.model = { ...resolved.model.ref }; }); this.emitSession(rt.id); }
    const key = this.liveKey(s, resolved.model, resolved.endpoint.baseUrl);
    if (rt.live && !rt.live.closed && rt.live.key === key) return rt.live;
    this.closeLive(rt);
    rt.starting = this.startLive(rt, resolved, key).finally(() => { rt.starting = null; });
    return rt.starting;
  }

  private async startLive(rt: Rt, resolved: { endpoint: { baseUrl: string; apiKey?: string }; model: ModelInfo }, key: string): Promise<Live> {
    const s = this.session(rt.id);
    const cc = this.settings();
    const { endpoint, model } = resolved;
    const probeKey = `${endpoint.baseUrl}\n${endpoint.apiKey ?? ''}`;
    if (!this.probed.has(probeKey) || this.probed.get(probeKey)) {
      const reason = await (this.deps.probeMessagesApi ?? probeMessagesApi)(endpoint.baseUrl, endpoint.apiKey, model.ref.model);
      this.probed.set(probeKey, reason);
    }
    const unsupported = this.probed.get(probeKey);
    if (unsupported) throw new Error(unsupported);
    const exe = (this.deps.resolveExecutable ?? resolveClaudeExecutable)(cc.executable);
    if (!exe.path) throw new Error(exe.error ?? 'Claude Code was not found. Check Settings → Engine.');
    const sdk = await this.loadSdk();
    const configDir = await prepareConfigDir(this.ctx.dataDir, cc.importUser, this.deps.userClaudeDir);
    const alias = modelAlias(model.ref.model);
    const baseUrl = await this.shim.baseUrl({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: { alias, id: model.ref.model } });
    const env = buildClaudeEnv({
      baseEnv: process.env, baseUrl, apiKey: 'obsidian-local', model: alias, contextLength: model.contextLength, configDir,
      extraEnv: cc.extraEnv, appVersion: this.deps.appVersion, autoCompactPercent: cc.all.autoCompactPercent,
    });
    const trusted = this.trusted(s.cwd);
    let memory = '';
    if (!trusted) {
      try { memory = (await this.ctx.ext?.memoryText(s.cwd)) ?? ''; } catch { memory = ''; }
      try {
        if (this.ctx.settings.forProject(s.cwd)?.untrusted) {
          this.emit('notification', {
            title: 'Project settings ignored',
            body: 'This folder is not trusted, so Claude Code runs without its .claude project settings, hooks, skills and commands. Add it under Settings → Permissions → Trusted folders to load them.',
            level: 'warning', sessionId: rt.id,
          });
        }
      } catch { /* no project settings */ }
    }
    const memoryBlock = memory.trim() ? `# Memory (instructions from OBSIDIAN.md / CLAUDE.md files — follow them)\n${memory.trim().slice(0, 8000)}` : '';
    const systemPrompt: Options['systemPrompt'] = cc.systemPrompt === 'claude_code'
      ? { type: 'preset', preset: 'claude_code', ...(memoryBlock ? { append: memoryBlock } : {}) }
      : await leanSystemPrompt({ cwd: s.cwd, shell: shellName(cc.all), os: osName(), date: localDate(), memory });

    const st = this.state(rt.id);
    const resume: Partial<Options> = {};
    if (st.sdkSessionId) {
      resume.resume = st.sdkSessionId;
      if (st.fork?.resumeAt) { resume.resumeSessionAt = st.fork.resumeAt; resume.forkSession = true; }
    }
    const input = new InputQueue();
    const live: Live = { q: null as unknown as Query, input, key, mode: s.permissionMode, configDir, closed: false, pump: Promise.resolve() };
    const options: Options = {
      cwd: s.cwd,
      model: alias,
      env,
      pathToClaudeCodeExecutable: exe.path,
      includePartialMessages: true,
      forwardSubagentText: true,
      permissionMode: s.permissionMode,
      allowDangerouslySkipPermissions: true,
      settingSources: trusted ? ['user', 'project', 'local'] : ['user'],
      settings: { skipWebFetchPreflight: true } as Options['settings'],
      disallowedTools: ['WebSearch'],
      mcpServers: { obsidian: createObsidianMcpServer({ ctx: this.ctx, sessionId: rt.id, cwd: s.cwd, onDisplay: (k, d) => rt.mcpDisplays.set(k, d) }) as any },
      thinking: s.thinking ? { type: 'adaptive' } : { type: 'disabled' },
      systemPrompt,
      canUseTool: (toolName, toolInput, opts) => this.canUseTool(rt, toolName, toolInput, opts as Obj),
      hooks: { PreToolUse: [{ hooks: [async (inp) => this.preToolUse(rt, live, inp as Obj)] }] },
      stderr: (d: string) => { rt.stderrTail = (rt.stderrTail + d).slice(-4000); },
      ...resume,
    };
    live.q = sdk.query({ prompt: input, options });
    rt.live = live;
    live.pump = this.pump(rt, live);
    void live.q.supportedCommands?.().then((c) => {
      live.commands = this.toCommandInfo(c);
      if (live.commands.length) {
        this.commandCache = live.commands;
        try { this.ctx.kv.write('claude-code.commands', live.commands); } catch { /* ignore */ }
      }
    }).catch(() => undefined);
    return live;
  }

  private async pump(rt: Rt, live: Live): Promise<void> {
    let failure: string | undefined;
    try {
      for await (const m of live.q) {
        if (live.closed && !rt.turn) break;
        this.onMessage(rt, live, m as unknown as Obj);
      }
    } catch (e) {
      failure = errorMessage(e);
    } finally {
      const wasClosed = live.closed;
      live.closed = true;
      if (rt.live === live) rt.live = null;
      if (rt.turn) {
        if (rt.interruptRequested || wasClosed) {
          this.finishTurn(rt, { ok: false, finalText: '', interrupted: true });
        } else {
          const tail = rt.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
          this.finishTurn(rt, { ok: false, finalText: '', error: `Claude Code stopped unexpectedly${failure ? `: ${failure}` : ''}${tail && !failure?.includes(tail) ? ` (${tail})` : ''}` });
        }
      }
    }
  }

  private onMessage(rt: Rt, live: Live, m: Obj): void {
    const type = m.type;
    if (type === 'system') {
      const sub = m.subtype;
      if (sub === 'init' && typeof m.session_id === 'string') {
        const st = this.state(rt.id);
        if (st.sdkSessionId !== m.session_id || st.fork) {
          st.sdkSessionId = m.session_id;
          st.fork = undefined;
          this.saveState(rt.id, st);
        }
      } else if (sub === 'status' && typeof m.permissionMode === 'string' && m.permissionMode !== live.mode) {
        const mode = m.permissionMode as PermissionMode;
        if (['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(mode)) {
          live.mode = mode;
          this.mutate(rt.id, (x) => { x.permissionMode = mode; });
          this.emitSession(rt.id);
        }
      } else if (sub === 'compact_boundary') {
        const meta = (m.compact_metadata ?? {}) as Obj;
        const pre = Number(meta.pre_tokens ?? 0);
        this.note(rt.id, `Conversation compacted by Claude Code (${meta.trigger === 'auto' ? 'automatic' : 'manual'}${pre ? `, ${pre.toLocaleString('en-US')} tokens before` : ''}). Older turns stay visible here; the model now sees a summary.`, 'compact_summary');
      } else if (sub === 'local_command_output' && typeof m.content === 'string') {
        this.note(rt.id, m.content);
      } else if (sub === 'task_started' || sub === 'task_notification' || sub === 'task_updated') {
        rt.translator.onTask(m);
      } else if (sub === 'notification' && typeof m.text === 'string') {
        this.emit('notification', { title: 'Claude Code', body: m.text, level: m.priority === 'high' || m.priority === 'immediate' ? 'warning' : 'info', sessionId: rt.id });
      }
      return;
    }
    if (type === 'conversation_reset') {
      const st = this.state(rt.id);
      if (typeof m.new_conversation_id === 'string') { st.sdkSessionId = m.new_conversation_id; st.lastUuid = undefined; st.turns = []; this.saveState(rt.id, st); }
      this.note(rt.id, 'Claude Code started a fresh conversation context. Earlier messages stay visible here but the model no longer sees them.');
      return;
    }
    if (type === 'result') {
      this.applyUsage(rt, m);
      if (!rt.turn) {
        if (rt.backgroundTurn) {
          rt.backgroundTurn = false;
          rt.translator.endTurn(false);
          const st = this.state(rt.id);
          if (rt.translator.lastChainUuid) { st.lastUuid = rt.translator.lastChainUuid; this.saveState(rt.id, st); }
          if (!rt.busy) { this.setStatus(rt, 'idle'); this.activity(rt, 'done'); }
          for (const w of rt.backgroundWaiters.splice(0)) w();
        }
        return;
      }
      const interrupted = rt.interruptRequested && (m.subtype !== 'success' || m.is_error === true);
      const isError = m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success');
      let error: string | undefined;
      if (isError && !interrupted) {
        const errs = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).filter((e) => !e.startsWith('[ede_diagnostic]')) : [];
        error = errs.join('\n') || (typeof m.result === 'string' && m.result) || `Claude Code ended the turn with "${String(m.subtype)}".`;
        if (m.subtype === 'error_max_turns') error = 'Claude Code stopped: maximum number of turns reached.';
      }
      const finalText = typeof m.result === 'string' && !isError ? m.result : rt.translator.lastText;
      this.finishTurn(rt, { ok: !isError, finalText, error, interrupted });
      return;
    }
    if (type === 'user' && m.isReplay === true && m.parent_tool_use_id == null) {
      // output of a local slash command (/context, /cost, ...) is replayed as <local-command-stdout>
      const c = (m.message as Obj | undefined)?.content;
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? (c as Obj[]).map((b) => String(b?.text ?? '')).join('\n') : '';
      const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw)?.[1]?.trim();
      if (out && !/^Compacted\b/.test(out)) this.note(rt.id, out);
      return;
    }
    // Claude Code can start a turn on its own (a background agent finished and it reacts): show it as running
    if (!rt.turn && !rt.backgroundTurn && (type === 'stream_event' || type === 'assistant') && m.parent_tool_use_id == null) {
      rt.backgroundTurn = true;
      rt.translator.beginTurn();
      this.setStatus(rt, 'running');
      this.activity(rt, 'running');
    }
    rt.translator.handle(m);
  }

  private applyUsage(rt: Rt, m: Obj): void {
    const u = (m.usage ?? {}) as Obj;
    const input = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
    const output = Number(u.output_tokens ?? 0);
    const { requests, lastPromptTokens } = rt.translator.usage();
    this.mutate(rt.id, (s) => {
      s.usage.inputTokens += Number.isFinite(input) ? input : 0;
      s.usage.outputTokens += Number.isFinite(output) ? output : 0;
      s.usage.requests += requests;
      if (lastPromptTokens) s.usage.lastPromptTokens = lastPromptTokens;
    });
    this.emitSession(rt.id);
  }

  // ───────────────────────────── permissions, questions, plans ─────────────────────────────

  private appDecision(rt: Rt, toolName: string, input: Obj) {
    const s = this.session(rt.id);
    const name = uiToolName(toolName);
    let def: ToolDef | undefined;
    try { def = this.ctx.tools.get(name); } catch { def = undefined; }
    const tool: ToolDef = def ?? ({ name: toolName, description: '', inputSchema: {}, permission: () => 'exec', title: () => toolName, run: async () => ({ content: '' }) } as unknown as ToolDef);
    const settings = this.settings().all;
    let kind: ReturnType<ToolDef['permission']>;
    try { kind = tool.permission(input as any, { cwd: s.cwd, settings }); } catch { kind = 'exec'; }
    let proj = { allow: [] as string[], deny: [] as string[] };
    try { proj = this.ctx.settings.forProject(s.cwd)?.permissions ?? proj; } catch { /* none */ }
    const decision = decidePermission({
      tool, input, cwd: s.cwd, mode: s.permissionMode, kind,
      allow: [...(settings.permissions?.allow ?? []), ...(proj.allow ?? [])],
      deny: [...(settings.permissions?.deny ?? []), ...(proj.deny ?? [])],
      shellKind: resolveShellKind(settings.shell),
      protectedDirs: this.ctx.dataDir && !isInside(this.ctx.dataDir, s.cwd) ? [this.ctx.dataDir] : [],
    });
    let title = toolName;
    try { title = def ? tool.title(input as any) : toolName; } catch { /* keep */ }
    return { decision, title, known: !!def };
  }

  private async preToolUse(rt: Rt, live: Live, inp: Obj): Promise<Obj> {
    const toolName = String(inp.tool_name ?? '');
    const input = (inp.tool_input && typeof inp.tool_input === 'object' ? inp.tool_input : {}) as Obj;
    const toolUseId = String(inp.tool_use_id ?? '');
    const s = this.session(rt.id);
    const { decision } = this.appDecision(rt, toolName, input);
    if (decision.action === 'deny' && decision.reason !== 'plan mode') {
      rt.denied.add(toolUseId);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } };
    }
    if (EDIT_TOOL_NAMES.has(toolName)) {
      const p = inputFilePath(input);
      if (p) {
        const abs = resolve(s.cwd, p);
        if (!isInside(live.configDir, abs)) {
          let content = '';
          let existed = true;
          try { content = await fs.readFile(abs, 'utf8'); } catch { existed = false; }
          rt.before.set(toolUseId, { existed, content });
          try {
            await this.checkpoints.checkpoint(rt.id, rt.currentTurnId ?? 'initial', abs);
          } catch (e) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: errorMessage(e) } };
          }
        }
      }
    }
    if (decision.action === 'ask' && PROTECTED_REASON.test(decision.reason ?? '')) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: decision.reason } };
    }
    return { continue: true };
  }

  private waitForHuman<V>(rt: Rt, make: (resolve: (v: V | null) => void) => Pending, announce: () => void): Promise<V | null> {
    return new Promise<V | null>((resolveOuter) => {
      const entry = make((v) => {
        rt.pendingHuman = Math.max(0, rt.pendingHuman - 1);
        if (rt.pendingHuman === 0 && rt.busy) { this.setStatus(rt, 'running'); this.activity(rt, 'running'); }
        resolveOuter(v);
      });
      this.pendingReqs.set(entry.request.requestId, entry);
      rt.pendingHuman++;
      this.setStatus(rt, 'waiting');
      this.activity(rt, 'waiting');
      announce();
      if (rt.interruptRequested) this.resolvePendingNull(entry.request.requestId);
    });
  }

  private async canUseTool(rt: Rt, toolName: string, input: Obj, opts: Obj): Promise<PermissionResult> {
    const toolUseId = String(opts.toolUseID ?? '');
    const s = this.session(rt.id);
    const interrupted: PermissionResult = { behavior: 'deny', message: 'Interrupted by the user.', interrupt: true };

    if (toolName === 'AskUserQuestion') {
      const questions = toQuestions(input.questions);
      if (rt.headless) {
        const answers = Object.fromEntries(questions.map((q) => [q.question, HEADLESS_NO_ANSWER]));
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const request: QuestionRequest = { requestId: newId(), sessionId: rt.id, toolUseId, questions: clone(questions), createdAt: Date.now() };
      const answers = await this.waitForHuman<Record<string, string>>(rt, (r) => ({ kind: 'question', ownerId: rt.id, request, resolve: r }), () => this.emit('question.requested', clone(request)));
      if (!answers) return interrupted;
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }

    if (toolName === 'ExitPlanMode') {
      const plan = String(input.plan ?? '');
      if (rt.headless) return { behavior: 'deny', message: `${HEADLESS_NO_ANSWER}. Present the plan as your final answer and stop.` };
      const request: PlanRequest = { requestId: newId(), sessionId: rt.id, toolUseId, plan, createdAt: Date.now() };
      const res = await this.waitForHuman<{ approved: boolean; mode: PermissionMode; feedback?: string }>(
        rt, (r) => ({ kind: 'plan', ownerId: rt.id, request, resolve: r }), () => this.emit('plan.requested', clone(request)),
      );
      if (!res) return interrupted;
      if (res.approved) {
        const mode: PermissionMode = res.mode && res.mode !== 'plan' ? res.mode : 'default';
        if (rt.live) rt.live.mode = mode;
        this.mutate(rt.id, (x) => { x.permissionMode = mode; });
        this.emitSession(rt.id);
        const update: PermissionUpdate = { type: 'setMode', mode, destination: 'session' };
        return { behavior: 'allow', updatedInput: input, updatedPermissions: [update] };
      }
      const fb = res.feedback?.trim();
      rt.denied.add(toolUseId);
      return fb
        ? { behavior: 'deny', message: `The user wants to keep planning and said: ${fb}` }
        : { behavior: 'deny', message: 'The user rejected the plan. Wait for their instructions.', interrupt: true };
    }

    const { decision, title } = this.appDecision(rt, toolName, input);
    if (decision.action === 'deny' && decision.reason !== 'plan mode') { rt.denied.add(toolUseId); return { behavior: 'deny', message: decision.message }; }
    if (decision.action === 'allow' && !PROTECTED_REASON.test(String(opts.decisionReason ?? ''))) return { behavior: 'allow', updatedInput: input };
    if (rt.headless) {
      rt.denied.add(toolUseId);
      return {
        behavior: 'deny',
        message: `Permission for "${title}" was denied automatically: this is an unattended (scheduled) run in "${s.permissionMode}" permission mode, so nobody can approve it. Continue without it (e.g. with read-only tools) or finish and report what needs approval.`,
      };
    }
    const suggestedRule = decision.action === 'ask' ? decision.suggestedRule : undefined;
    const request: PermissionRequest = {
      requestId: newId(), sessionId: rt.id, toolUseId, toolName: uiToolName(toolName), input: clone(input),
      title: title !== toolName ? title : String(opts.title ?? title), suggestedRule: suggestedRule || undefined, createdAt: Date.now(),
    };
    rt.translator.setToolStatus(toolUseId, 'awaiting_permission');
    const answer = await this.waitForHuman<{ decision: PermissionDecision; message?: string }>(
      rt, (r) => ({ kind: 'permission', ownerId: rt.id, request, resolve: r }), () => this.emit('permission.requested', clone(request)),
    );
    if (!answer) { rt.denied.add(toolUseId); return interrupted; }
    if (answer.decision === 'deny') {
      rt.denied.add(toolUseId);
      const fb = answer.message?.trim();
      return fb
        ? { behavior: 'deny', message: `The user denied this tool call and said: ${fb}` }
        : { behavior: 'deny', message: 'The user denied this tool call. Stop what you are doing and wait for the user\'s next instruction.', interrupt: true };
    }
    rt.translator.setToolStatus(toolUseId, 'running');
    if (answer.decision === 'allow_always') {
      if (suggestedRule) { try { this.ctx.settings.addProjectAllowRule(s.cwd, suggestedRule); } catch { /* best effort */ } }
      const suggestions = Array.isArray(opts.suggestions) ? (opts.suggestions as PermissionUpdate[]) : [];
      // persisted by the app (project allow rule) — Claude Code only needs it for this session, so nothing is
      // written into the user's .claude/settings.local.json
      const updatedPermissions = suggestions.map((u) => ({ ...u, destination: 'session' }) as PermissionUpdate);
      return { behavior: 'allow', updatedInput: input, ...(updatedPermissions.length ? { updatedPermissions } : {}) };
    }
    return { behavior: 'allow', updatedInput: input };
  }

  // ───────────────────────────── titles ─────────────────────────────

  private async maybeTitle(rt: Rt, prompt: string): Promise<void> {
    if (rt.titleDone) return;
    rt.titleDone = true;
    try {
      const s = this.session(rt.id);
      if (s.kind === 'subagent') return;
      if (!(isDefaultTitle(s.title) || s.title === rt.provisionalTitle)) return;
      const { endpoint, model } = this.ctx.models.resolve(s.model);
      let text = '';
      for await (const ev of this.ctx.llm.stream(endpoint, {
        model: model.ref.model, thinking: false, maxTokens: 24,
        messages: [{ role: 'user', content: `Write a short title (at most 6 words) for a conversation that starts with the request below. Reply with the title only.\n\nRequest: ${prompt.slice(0, 1500)}` }],
      })) {
        if (ev.type === 'text') text += ev.delta;
      }
      const title = sanitizeTitle(text.trim()) || clipLine(prompt, 50);
      const cur = this.session(rt.id);
      if (!(isDefaultTitle(cur.title) || cur.title === rt.provisionalTitle) || !title || cur.title === title) return;
      this.mutate(rt.id, (x) => { x.title = title; });
      this.emitSession(rt.id);
    } catch { /* best effort */ }
  }
}
