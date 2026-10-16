// The agent loop (SPEC §4.1): queueing, streaming, tool execution, permissions, plan mode, questions, subagents,
// hooks, context management, slash commands, rewind, headless runs, interrupts.

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { diffLines } from 'diff';
import type {
  ChatRequest, ChatToolSpec, CoreContext, Endpoint, LlmEvent, PermissionKind, ToolContext, ToolDef,
} from '../contracts';
import type { AgentManager } from '../contracts';
import type { CoreEventName, CoreEvents } from '../../shared/protocol';
import type {
  ActivityItem, AgentTypeInfo, Block, ChangedFile, ImageBlock, Message, ModelInfo, ModelRef, PermissionDecision,
  PermissionMode, PermissionRequest, PlanRequest, Question, QuestionRequest, Session, Settings, Todo, ToolResultPayload,
  ToolStatus, ToolUseBlock,
} from '../../shared/types';
import { isContextOverflow } from '../llm/errors';
import type { ToolCallEvent } from '../llm/parser';
import { parseTextToolCalls } from '../llm/textToolCalls';
import { CheckpointStore, pathKey } from './checkpoints';
import { BUILTIN_COMMANDS, INIT_PROMPT, isBuiltinCommand, parseSlashCommand } from './commands';
import { isRealUserMessage, planCompaction, renderTranscript, SUMMARY_SYSTEM, summaryMessageText, summaryPrompt } from './compaction';
import { buildHistory, estimateTokens } from './history';
import { decidePermission, isInside } from './permissions';
import { resolveShellKind } from '../tools/lib/shell';
import { buildSystemPrompt, gitSummary, localDate, osName, planModeReminder, shellName, wrapReminder } from './prompt';
import { BUILTIN_AGENTS, builtinDefinition, MAX_CONCURRENT_SUBAGENTS, MAX_SUBAGENT_DEPTH, subagentToolNames, type AgentDefinition } from './subagents';
import {
  AbortedError, clipLine, errorMessage, isDefaultTitle, newId, raceAbort, sanitizeTitle, Semaphore, toSummary, truncateOutput, withTimeout,
} from './util';

export const MAX_STEPS = 200;
const MAX_STOP_HOOK_CONTINUES = 3;
// A reasoning model sometimes emits a long thinking block and then stops (EOS) without any answer or tool call.
// When that happens we nudge it to continue instead of ending the turn silently — bounded so a genuinely stuck
// model can't loop forever.
const MAX_AUTO_CONTINUES = 4;
/** Also matched by src/core/gpu/auto-clockout.ts (3 of these in a row without a tool call = the model is stuck). */
export const CONTINUE_AFTER_THINKING_NOTE =
  'You ended your turn with reasoning but produced no answer and called no tool. Continue now: either call a tool to make progress, or write your final answer to the user. Do not stop after thinking.';
// Markup that signals the model wrote an actual tool call (not just mentioned a tool) inside its reasoning.
const EMBEDDED_TOOL_CALL_RE = /<tool_call>|<function\s*=|<\|tool_call\|>|\barg_key\b/;
const DEFAULT_MAX_TOOL_OUTPUT = 30_000;
const DEFAULT_AUTO_COMPACT = 80;
export const HEADLESS_NO_ANSWER = '(no answer — running unattended)';

interface TurnResult { ok: boolean; finalText: string; error?: string; interrupted?: boolean }

interface QueueItem {
  messageId: string;
  text: string;
  images?: ImageBlock[];
  tag?: Message['tag'];
  headless?: boolean;
  /** Typed by the user in the chat UI (send()). Only these may use the '# note' memory shortcut. */
  interactive?: boolean;
  onDone?: (r: TurnResult) => void;
}

interface Runtime {
  id: string;
  rootId: string;
  parentId?: string;
  depth: number;
  busy: boolean;
  queue: QueueItem[];
  abort: AbortController | null;
  readFiles: Map<string, number>;
  headless: boolean;
  inheritedHeadless: boolean;
  systemPrompt?: string;
  agentDef?: AgentDefinition;
  currentTurnId?: string;
  sessionStarted: boolean;
  prevMode?: PermissionMode;
  pendingHuman: number;
  children: Set<string>;
  subagentSlots: Semaphore;
  idleWaiters: (() => void)[];
  tokensSinceUsage: number;
  titleDone: boolean;
  provisionalTitle?: string;
  stopAfterTools: boolean;
  activityStartedAt: number;
  activityRegistered: boolean;
  modelInfo?: ModelInfo;
}

type PendingEntry =
  | { kind: 'permission'; ownerId: string; request: PermissionRequest; resolve: (v: { decision: PermissionDecision; message?: string } | null) => void }
  | { kind: 'question'; ownerId: string; request: QuestionRequest; resolve: (v: Record<string, string> | null) => void }
  | { kind: 'plan'; ownerId: string; request: PlanRequest; resolve: (v: { approved: boolean; mode: PermissionMode; feedback?: string } | null) => void };

interface StepResult { messageId: string; text: string; toolCalls: ToolCallEvent[]; finishReason: string }

function textOfMessage(m: Message): string {
  return m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
}

function thinkingOfMessage(m: Message): string {
  return m.blocks.filter((b) => b.type === 'thinking').map((b) => (b as { text: string }).text).join('');
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class AgentManagerImpl implements AgentManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly pendingReqs = new Map<string, PendingEntry>();
  private checkpointStore: CheckpointStore | null = null;

  constructor(private readonly ctx: CoreContext) {}

  // ───────────────────────────── plumbing ─────────────────────────────

  private get checkpoints(): CheckpointStore {
    if (!this.checkpointStore) this.checkpointStore = new CheckpointStore(this.ctx.dataDir);
    return this.checkpointStore;
  }

  private settings(): Settings {
    const s = this.ctx.settings.get();
    return s;
  }

  private emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void {
    try { this.ctx.bus.emit(event, data); } catch { /* listeners must not break the loop */ }
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

  private findMessage(s: Session, messageId: string): Message | undefined {
    for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i]!.id === messageId) return s.messages[i];
    return undefined;
  }

  private subscribed = false;

  private runtime(id: string): Runtime {
    if (!this.subscribed) {
      this.subscribed = true;
      try {
        this.ctx.bus.on('session.deleted', ({ sessionId }) => {
          this.interrupt(sessionId);
          const rt = this.runtimes.get(sessionId);
          if (rt) for (const item of rt.queue.splice(0)) item.onDone?.({ ok: false, finalText: '', interrupted: true });
          this.runtimes.delete(sessionId);
        });
      } catch { /* bus without listeners */ }
    }
    let rt = this.runtimes.get(id);
    if (!rt) {
      const s = this.session(id);
      let depth = 0;
      let rootId = id;
      let parentId: string | undefined;
      if (s.kind === 'subagent' && s.parentSessionId) {
        parentId = s.parentSessionId;
        const p = this.runtimes.get(s.parentSessionId);
        depth = (p?.depth ?? 0) + 1;
        rootId = p?.rootId ?? s.parentSessionId;
      }
      rt = {
        id, rootId, parentId, depth, busy: false, queue: [], abort: null, readFiles: new Map(), headless: false, inheritedHeadless: false,
        sessionStarted: false, pendingHuman: 0, children: new Set(), subagentSlots: new Semaphore(MAX_CONCURRENT_SUBAGENTS),
        idleWaiters: [], tokensSinceUsage: 0, titleDone: false, stopAfterTools: false, activityStartedAt: Date.now(), activityRegistered: false,
      };
      this.runtimes.set(id, rt);
      // a session persisted mid-run (crash) is not running any more
      if (s.status === 'running' || s.status === 'waiting') {
        this.mutate(id, (x) => { x.status = 'idle'; });
      }
    }
    return rt;
  }

  private setStatus(rt: Runtime, status: Session['status']): void {
    const changed = this.mutate(rt.id, (s) => {
      if (s.status === status) return false;
      s.status = status;
      return true;
    });
    if (changed) this.emitSession(rt.id);
  }

  private activity(rt: Runtime, status: ActivityItem['status'], detail?: string): void {
    try {
      const s = this.session(rt.id);
      const id = rt.id;
      const ended = status === 'done' || status === 'error' || status === 'stopped';
      this.ctx.activity.upsert({
        id, kind: s.kind === 'subagent' ? 'subagent' : 'session', title: s.title || 'Session', sessionId: rt.id, status,
        startedAt: rt.activityStartedAt, endedAt: ended ? Date.now() : undefined, detail,
      });
      if (!rt.activityRegistered) {
        rt.activityRegistered = true;
        this.ctx.activity.onStop(id, () => this.interrupt(rt.id));
      }
    } catch { /* activity registry optional */ }
  }

  /** Project hooks/allow rules of an untrusted folder are ignored (settings store); tell the user once per session. */
  private noticeUntrustedProject(sessionId: string, cwd: string): void {
    let u: { hooks: number; allow: string[]; files: string[] } | undefined;
    try { u = this.ctx.settings.forProject(cwd)?.untrusted; } catch { return; }
    if (!u) return;
    const what = [u.hooks ? `${u.hooks} hook${u.hooks === 1 ? '' : 's'}` : '', u.allow.length ? `${u.allow.length} allow rule${u.allow.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    this.emit('notification', {
      title: 'Project settings ignored',
      body: `This folder's project settings define ${what}. They are ignored until you add the folder under Settings → Permissions → Trusted folders.`,
      level: 'warning',
      sessionId,
    });
  }

  private async hook(
    event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart',
    payload: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ block: boolean; message?: string; additionalContext?: string }> {
    const ext = this.ctx.ext;
    if (!ext || typeof ext.runHooks !== 'function') return { block: false };
    if (signal?.aborted) return { block: false };
    try {
      const run = Promise.resolve(ext.runHooks(event, { hook_event_name: event, cwd, ...payload }, cwd, signal));
      // the runner kills its processes on abort; don't wait for it either way
      return (signal ? await raceAbort(run, signal) : await run) ?? { block: false };
    } catch {
      return { block: false };
    }
  }

  private addMessage(sessionId: string, msg: Message): void {
    this.mutate(sessionId, (s) => { s.messages.push(msg); });
    this.emit('message.added', { sessionId, message: clone(msg) });
  }

  private addReminder(sessionId: string, text: string): void {
    this.addMessage(sessionId, { id: newId(), role: 'user', tag: 'hook', createdAt: Date.now(), blocks: [{ type: 'text', text: wrapReminder(text) }] });
  }

  private commandEcho(rt: Runtime, item: QueueItem, input: string, output: string): void {
    const now = Date.now();
    this.addMessage(rt.id, { id: item.messageId, role: 'user', tag: 'command', createdAt: now, blocks: [{ type: 'text', text: input }] });
    const reply: Message = { id: newId(), role: 'assistant', tag: 'command', createdAt: now, blocks: [{ type: 'text', text: output }] };
    this.addMessage(rt.id, reply);
    this.emit('message.completed', { sessionId: rt.id, messageId: reply.id, meta: {} });
  }

  // ───────────────────────────── public API ─────────────────────────────

  async send(sessionId: string, text: string, images?: ImageBlock[]): Promise<{ messageId: string; queued: boolean }> {
    this.session(sessionId);
    if (!text.trim() && !images?.length) throw new Error('Empty message');
    const rt = this.runtime(sessionId);
    const messageId = newId();
    const queued = this.enqueue(rt, { messageId, text, images, interactive: true });
    return { messageId, queued };
  }

  dequeue(sessionId: string, messageId?: string): { messageId: string; text: string }[] {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return [];
    const removed: { messageId: string; text: string }[] = [];
    rt.queue = rt.queue.filter((item) => {
      // Only user-sent items (no onDone waiter: headless/subagent runs are not withdrawable).
      if (item.onDone || (messageId && item.messageId !== messageId)) return true;
      removed.push({ messageId: item.messageId, text: item.text ?? '' });
      return false;
    });
    return removed;
  }

  private enqueue(rt: Runtime, item: QueueItem): boolean {
    const queued = rt.busy;
    rt.queue.push(item);
    if (!rt.busy) {
      rt.busy = true;
      void this.drain(rt);
    }
    return queued;
  }

  private enqueueAndWait(rt: Runtime, item: Omit<QueueItem, 'onDone'>): Promise<TurnResult> {
    return new Promise<TurnResult>((resolveDone) => {
      this.enqueue(rt, { ...item, onDone: resolveDone });
    });
  }

  private async drain(rt: Runtime): Promise<void> {
    try {
      while (rt.queue.length) {
        const item = rt.queue.shift()!;
        let result: TurnResult;
        try {
          result = await this.handleItem(rt, item);
        } catch (e) {
          result = { ok: false, finalText: '', error: errorMessage(e) };
          this.reportError(rt, e);
        }
        try { item.onDone?.(result); } catch { /* ignore */ }
      }
    } finally {
      rt.busy = false;
      const waiters = rt.idleWaiters.splice(0);
      waiters.forEach((w) => w());
    }
  }

  private reportError(rt: Runtime, e: unknown): void {
    const message = errorMessage(e);
    try { this.setStatus(rt, 'error'); } catch { /* session gone */ }
    this.activity(rt, 'error', message);
    this.emit('error', { message, sessionId: rt.id });
  }

  interrupt(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.abort?.abort();
    for (const [id, p] of [...this.pendingReqs]) {
      if (p.ownerId === sessionId) this.resolvePending(id, null);
    }
    for (const child of rt.children) this.interrupt(child);
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.busy ?? false;
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

  /** Resolve a pending request as interrupted (null). */
  private resolvePending(requestId: string, value: null): void {
    const p = this.pendingReqs.get(requestId);
    if (!p) return;
    this.pendingReqs.delete(requestId);
    if (p.kind === 'permission') this.emit('permission.resolved', { requestId, sessionId: p.request.sessionId, decision: 'deny' });
    else if (p.kind === 'question') this.emit('question.resolved', { requestId, sessionId: p.request.sessionId });
    else this.emit('plan.resolved', { requestId, sessionId: p.request.sessionId, approved: false });
    (p.resolve as (v: null) => void)(value);
  }

  async runHeadless(opts: { sessionId: string; prompt: string }): Promise<{ ok: boolean; finalText: string }> {
    const s = this.session(opts.sessionId);
    const rt = this.runtime(opts.sessionId);
    const r = await this.enqueueAndWait(rt, {
      messageId: newId(), text: opts.prompt, headless: true, tag: s.kind === 'scheduled' ? 'scheduled_prompt' : undefined,
    });
    return { ok: r.ok, finalText: r.finalText || (r.error ? `Error: ${r.error}` : '') };
  }

  async rewind(sessionId: string, atMessageId: string, restoreFiles: boolean): Promise<string[]> {
    const rt = this.runtime(sessionId);
    if (rt.busy) {
      // going back in time: queued messages are dropped, the running turn is interrupted
      for (const item of rt.queue.splice(0)) item.onDone?.({ ok: false, finalText: '', interrupted: true });
      this.interrupt(sessionId);
      await withTimeout(new Promise<void>((r) => rt.idleWaiters.push(r)), 10_000, undefined);
    }
    return this.doRewind(rt, atMessageId, restoreFiles);
  }

  private async doRewind(rt: Runtime, atMessageId: string, restoreFiles: boolean): Promise<string[]> {
    const s = this.session(rt.id);
    const idx = s.messages.findIndex((m) => m.id === atMessageId);
    if (idx < 0) throw new Error('That message is no longer in this session.');
    if (s.messages[idx]!.role !== 'user') throw new Error('Rewind needs a user message.');
    const turnIds = s.messages.slice(idx).filter((m) => m.role === 'user').map((m) => m.id);
    let restored: string[] = [];
    if (restoreFiles) {
      restored = await this.checkpoints.restore(rt.id, turnIds);
      await this.checkpoints.drop(rt.id, turnIds);
    }
    const restoredKeys = new Set(restored.map(pathKey));
    this.mutate(rt.id, (x) => {
      x.messages = x.messages.slice(0, idx);
      if (restoreFiles) x.changedFiles = x.changedFiles.filter((f) => !restoredKeys.has(pathKey(resolve(x.cwd, f.path))));
    });
    rt.readFiles.clear();
    if (restoreFiles) {
      // recompute stats for files that still have older checkpoints
      for (const f of this.session(rt.id).changedFiles) void this.refreshChangeStats(rt, f.path, f.lastToolUseId);
    }
    this.emit('session.reset', { sessionId: rt.id });
    if (restoreFiles) this.emit('changes.updated', { sessionId: rt.id, changedFiles: clone(this.session(rt.id).changedFiles) });
    this.emitSession(rt.id);
    return restored;
  }

  async fileDiff(sessionId: string, path: string): Promise<{ before: string; after: string }> {
    const s = this.session(sessionId);
    const abs = resolve(s.cwd, path);
    let after = '';
    try { after = await fs.readFile(abs, 'utf8'); } catch { after = ''; }
    const root = this.rootSessionId(sessionId);
    const orig = await this.checkpoints.original(root, abs);
    if (!orig) return { before: after, after };
    return { before: orig.existed ? orig.content.toString('utf8') : '', after };
  }

  private rootSessionId(sessionId: string): string {
    const rt = this.runtimes.get(sessionId);
    if (rt) return rt.rootId;
    let s = this.ctx.sessions.get(sessionId);
    let guard = 0;
    while (s?.kind === 'subagent' && s.parentSessionId && guard++ < 5) {
      const p = this.ctx.sessions.get(s.parentSessionId);
      if (!p) break;
      s = p;
    }
    return s?.id ?? sessionId;
  }

  // ───────────────────────────── input handling ─────────────────────────────

  private async handleItem(rt: Runtime, item: QueueItem): Promise<TurnResult> {
    rt.headless = !!item.headless || rt.inheritedHeadless;
    const text = item.text ?? '';
    // subagent prompts are model-written task descriptions, never slash commands
    const cmd = item.images?.length || rt.depth > 0 ? null : parseSlashCommand(text);
    if (cmd) {
      if (isBuiltinCommand(cmd.name)) return this.runBuiltin(rt, item, cmd.name, cmd.args);
      const s = this.session(rt.id);
      let expanded: string | null = null;
      try { expanded = await this.ctx.ext?.expandCommand(s.cwd, cmd.name, cmd.args) ?? null; } catch { expanded = null; }
      if (expanded != null) return this.runPrompt(rt, item, expanded);
      this.commandEcho(rt, item, text.trim(), `Unknown command \`/${cmd.name}\`. Type \`/help\` to see the available commands.`);
      return { ok: false, finalText: '', error: `Unknown command /${cmd.name}` };
    }
    // single-line "# note" → project memory, only for messages the user typed: subagent, scheduled and headless prompts
    // are model/task-written and must not silently persist instructions into every future system prompt
    const mem = item.interactive && rt.depth === 0 && !item.headless ? /^#(?!#)\s*([^\n]+)$/.exec(text.trim()) : null;
    if (mem && !item.images?.length) return this.memoryNote(rt, item, mem[1]!.trim());
    return this.runPrompt(rt, item, text);
  }

  private async memoryNote(rt: Runtime, item: QueueItem, note: string): Promise<TurnResult> {
    const s = this.session(rt.id);
    const file = join(s.cwd, 'OBSIDIAN.md');
    let existing = '';
    try { existing = await fs.readFile(file, 'utf8'); } catch { existing = ''; }
    const prefix = existing ? (existing.endsWith('\n') ? '' : '\n') : '# Project memory\n\n';
    await fs.writeFile(file, `${existing}${prefix}- ${note}\n`, 'utf8');
    this.commandEcho(rt, item, `# ${note}`, `Saved to project memory (\`${file}\`).`);
    this.addReminder(rt.id, `The user added this note to the project memory file OBSIDIAN.md: ${note}`);
    return { ok: true, finalText: '' };
  }

  private async runPrompt(rt: Runtime, item: QueueItem, text: string): Promise<TurnResult> {
    const s0 = this.session(rt.id);
    const cwd = s0.cwd;
    const reminders: string[] = [];
    // Stoppable from here on: Stop pressed during a slow SessionStart/UserPromptSubmit hook kills the hook and skips
    // the model call (before, interrupt() found no controller and the whole turn ran anyway).
    const abort = new AbortController();
    rt.abort = abort;
    rt.activityStartedAt = Date.now();
    this.setStatus(rt, 'running');
    this.activity(rt, 'running');
    if (!rt.sessionStarted) {
      rt.sessionStarted = true;
      if (rt.depth === 0) {
        this.noticeUntrustedProject(rt.id, cwd);
        const h = await this.hook('SessionStart', { session_id: rt.id, source: s0.messages.length ? 'resume' : 'startup' }, cwd, abort.signal);
        if (h.additionalContext && !abort.signal.aborted) reminders.push(h.additionalContext);
      }
    }
    const submit = rt.depth === 0 && !abort.signal.aborted
      ? await this.hook('UserPromptSubmit', { session_id: rt.id, prompt: text }, cwd, abort.signal)
      : { block: false as const, additionalContext: undefined };
    const stoppedEarly = abort.signal.aborted;
    if (submit.block && !stoppedEarly) {
      rt.abort = null;
      this.commandEcho(rt, item, text, `Prompt blocked by a UserPromptSubmit hook${submit.message ? `: ${submit.message}` : '.'}`);
      this.setStatus(rt, 'idle');
      this.activity(rt, 'done');
      return { ok: false, finalText: '', error: submit.message ?? 'Blocked by hook' };
    }
    if (submit.additionalContext && !stoppedEarly) reminders.push(submit.additionalContext);

    const blocks: Block[] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of item.images ?? []) blocks.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name });
    const userMsg: Message = { id: item.messageId, role: 'user', createdAt: Date.now(), blocks };
    if (item.tag) userMsg.tag = item.tag;
    this.addMessage(rt.id, userMsg);
    rt.tokensSinceUsage += Math.ceil(text.length / 3.6) + (item.images?.length ?? 0) * 768;

    // provisional title (first 50 chars of the prompt) — replaced by a generated title after the first reply
    const sNow = this.session(rt.id);
    if (rt.depth === 0 && isDefaultTitle(sNow.title) && text.trim()) {
      const provisional = clipLine(text, 50);
      rt.provisionalTitle = provisional;
      this.mutate(rt.id, (x) => { x.title = provisional; });
    }
    if (this.session(rt.id).permissionMode === 'plan') reminders.push(planModeReminder());
    for (const r of reminders) this.addReminder(rt.id, r);

    rt.currentTurnId = userMsg.id;
    rt.stopAfterTools = false;
    if (abort.signal.aborted) {
      // stopped while a hook was running: keep the message (like an interrupt right after sending), skip the model
      rt.abort = null;
      this.setStatus(rt, 'idle');
      this.activity(rt, 'stopped');
      return { ok: false, finalText: '', interrupted: true };
    }
    let result: TurnResult;
    try {
      result = await this.runTurn(rt);
    } catch (e) {
      if (rt.abort?.signal.aborted) {
        result = { ok: false, finalText: '', interrupted: true };
      } else {
        rt.abort = null;
        this.reportError(rt, e);
        return { ok: false, finalText: '', error: errorMessage(e) };
      }
    } finally {
      rt.abort = null;
    }
    this.setStatus(rt, 'idle');
    this.activity(rt, result.interrupted ? 'stopped' : 'done');
    if (rt.depth === 0 && !result.interrupted) void this.maybeTitle(rt, text);
    return result;
  }

  // ───────────────────────────── the loop ─────────────────────────────

  private async resolveModel(rt: Runtime): Promise<{ endpoint: Endpoint; model: ModelInfo }> {
    const s = this.session(rt.id);
    let r: { endpoint: Endpoint; model: ModelInfo };
    try {
      r = this.ctx.models.resolve(s.model);
    } catch {
      await this.ctx.models.refresh().catch(() => undefined);
      r = this.ctx.models.resolve(this.session(rt.id).model);
    }
    if (!s.model) {
      this.mutate(rt.id, (x) => { x.model = { ...r.model.ref }; });
      this.emitSession(rt.id);
    }
    rt.modelInfo = r.model;
    return r;
  }

  private allTools(): ToolDef[] {
    try { return this.ctx.tools.all(); } catch { return []; }
  }

  private sessionTools(rt: Runtime): ToolDef[] {
    const all = this.allTools();
    if (rt.depth === 0 || !rt.agentDef) return all;
    const allowed = new Set(subagentToolNames(all.map((t) => t.name), rt.agentDef, rt.depth));
    return all.filter((t) => allowed.has(t.name));
  }

  private async agentTypes(cwd: string): Promise<AgentTypeInfo[]> {
    let list: AgentTypeInfo[] = [];
    try { list = (await withTimeout(this.ctx.ext?.agentTypes(cwd) ?? Promise.resolve([]), 5000, [])) ?? []; } catch { list = []; }
    const names = new Set(list.map((a) => a.name.toLowerCase()));
    for (const b of BUILTIN_AGENTS) if (!names.has(b.name.toLowerCase())) list.push({ name: b.name, description: b.description, tools: b.tools, source: 'builtin' });
    return list;
  }

  private async systemPrompt(rt: Runtime, tools: ToolDef[]): Promise<string> {
    if (rt.systemPrompt) return rt.systemPrompt;
    const s = this.session(rt.id);
    const ext = this.ctx.ext;
    const [memory, skills, agentTypes, git] = await Promise.all([
      withTimeout(ext?.memoryText(s.cwd) ?? Promise.resolve(''), 5000, ''),
      withTimeout(ext?.skills(s.cwd) ?? Promise.resolve([]), 5000, []),
      this.agentTypes(s.cwd),
      gitSummary(s.cwd),
    ]);
    rt.systemPrompt = buildSystemPrompt({
      cwd: s.cwd, date: localDate(), os: osName(), shell: shellName(this.settings()), git, memory: memory ?? '', skills: skills ?? [], agentTypes,
      toolNames: tools.map((t) => t.name),
      subagent: rt.depth > 0 && rt.agentDef ? { name: rt.agentDef.name, systemPrompt: rt.agentDef.systemPrompt } : undefined,
    });
    return rt.systemPrompt;
  }

  private async maybeAutoCompact(rt: Runtime, signal: AbortSignal): Promise<void> {
    const s = this.session(rt.id);
    if (!s.usage.lastPromptTokens) return;
    const model = rt.modelInfo ?? (await this.resolveModel(rt)).model;
    const pct = this.settings().autoCompactPercent || DEFAULT_AUTO_COMPACT;
    const limit = (model.contextLength * pct) / 100;
    const estimate = s.usage.lastPromptTokens + rt.tokensSinceUsage;
    if (estimate > limit) {
      try { await this.compact(rt, { reason: 'auto', signal }); } catch (e) { if (signal.aborted) throw e; /* keep going; overflow handling retries */ }
    }
  }

  private async runTurn(rt: Runtime): Promise<TurnResult> {
    const signal = rt.abort!.signal;
    let overflowRetried = false;
    let stopHookRuns = 0;
    let autoContinues = 0;
    let finalText = '';
    let steps = 0;
    for (; steps < MAX_STEPS; steps++) {
      if (signal.aborted) return { ok: false, finalText, interrupted: true };
      await this.maybeAutoCompact(rt, signal);
      if (signal.aborted) return { ok: false, finalText, interrupted: true };
      const { endpoint, model } = await this.resolveModel(rt);
      const tools = this.sessionTools(rt);
      const system = await this.systemPrompt(rt, tools);
      const s = this.session(rt.id);
      const specs: ChatToolSpec[] = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      const req: ChatRequest = {
        model: model.ref.model,
        messages: buildHistory(s.messages, { system, supportsVision: model.supportsVision }),
        tools: specs.length ? specs : undefined,
        thinking: s.thinking,
        signal,
      };
      let res: StepResult;
      try {
        res = await this.streamStep(rt, endpoint, model, req);
      } catch (e) {
        if (signal.aborted) return { ok: false, finalText, interrupted: true };
        if (isContextOverflow(e) && !overflowRetried) {
          overflowRetried = true;
          const did = await this.compact(rt, { reason: 'overflow', signal });
          if (did) { steps--; continue; }
        }
        throw e;
      }
      if (res.text) finalText = res.text;
      if (signal.aborted) return { ok: false, finalText, interrupted: true };
      if (!res.toolCalls.length) {
        // The model may have written a real tool call inside its reasoning (some Qwen/GLM builds do this when they
        // "decide" mid-thought). Recover and run it so the turn makes progress instead of ending.
        const recovered = this.recoverToolCallsFromThinking(rt, res, specs);
        if (recovered.length) {
          const cont = await this.executeTools(rt, res.messageId, recovered, signal);
          if (signal.aborted) return { ok: false, finalText, interrupted: true };
          if (!cont || rt.stopAfterTools) return { ok: true, finalText };
          continue;
        }
        // The model thought but produced no answer and called no tool — nudge it to continue instead of stopping
        // silently (this is what the user otherwise has to do by typing "keep going"). Bounded by MAX_AUTO_CONTINUES.
        if (!res.text.trim() && autoContinues < MAX_AUTO_CONTINUES) {
          autoContinues++;
          this.addReminder(rt.id, CONTINUE_AFTER_THINKING_NOTE);
          continue;
        }
        if (rt.depth === 0) {
          const h = await this.hook('Stop', { session_id: rt.id, stop_hook_active: stopHookRuns > 0, last_message: res.text }, s.cwd, signal);
          if (h.block && h.message && stopHookRuns < MAX_STOP_HOOK_CONTINUES) {
            stopHookRuns++;
            this.addReminder(rt.id, `A Stop hook asked you to continue: ${h.message}`);
            continue;
          }
        }
        return { ok: true, finalText };
      }
      const cont = await this.executeTools(rt, res.messageId, res.toolCalls, signal);
      if (signal.aborted) return { ok: false, finalText, interrupted: true };
      if (!cont || rt.stopAfterTools) return { ok: true, finalText };
    }
    this.emit('notification', { title: 'Agent stopped', body: `Stopped after ${MAX_STEPS} model calls in one turn.`, level: 'warning', sessionId: rt.id });
    return { ok: true, finalText };
  }

  private appendDelta(sessionId: string, messageId: string, type: 'text' | 'thinking', delta: string): number {
    const idx = this.mutate(sessionId, (s) => {
      const m = this.findMessage(s, messageId);
      if (!m) return -1;
      const last = m.blocks[m.blocks.length - 1];
      if (last && last.type === type) { (last as { text: string }).text += delta; return m.blocks.length - 1; }
      m.blocks.push({ type, text: delta } as Block);
      return m.blocks.length - 1;
    });
    if (idx >= 0) this.emit('message.delta', { sessionId, messageId, blockIndex: idx, blockType: type, delta });
    return idx;
  }

  private async streamStep(rt: Runtime, endpoint: Endpoint, model: ModelInfo, req: ChatRequest): Promise<StepResult> {
    const msg: Message = { id: newId(), role: 'assistant', createdAt: Date.now(), blocks: [], meta: { model: model.ref.model } };
    this.addMessage(rt.id, msg);
    const started = Date.now();
    let thinkingIdx = -1;
    let thinkingStart = 0;
    const calls: ToolCallEvent[] = [];
    let done: Extract<LlmEvent, { type: 'done' }> | undefined;
    const closeThinking = () => {
      if (thinkingIdx < 0) return;
      const idx = thinkingIdx;
      const durationMs = Date.now() - thinkingStart;
      thinkingIdx = -1;
      const block = this.mutate(rt.id, (s) => {
        const m = this.findMessage(s, msg.id);
        const b = m?.blocks[idx];
        if (b && b.type === 'thinking') { b.durationMs = durationMs; return clone(b); }
        return null;
      });
      if (block) this.emit('message.block', { sessionId: rt.id, messageId: msg.id, blockIndex: idx, block });
    };
    // Prefill progress → 'message.progress' (throttled ~4/s), only until the first streamed event.
    let firstEvent = false;
    let lastProgressAt = 0;
    const onProgress: ChatRequest['onProgress'] = (p) => {
      if (firstEvent) return;
      const work = p.total - p.cache;
      const progress = work > 0 ? Math.min(1, Math.max(0, (p.processed - p.cache) / work)) : p.processed >= p.total ? 1 : 0;
      const now = Date.now();
      if (now - lastProgressAt < 250 && progress < 1) return;
      lastProgressAt = now;
      this.emit('message.progress', { sessionId: rt.id, messageId: msg.id, phase: 'prefill', progress, processed: p.processed, total: p.total });
    };
    try {
      for await (const ev of this.ctx.llm.stream(endpoint, { ...req, onProgress })) {
        firstEvent = true;
        if (ev.type === 'thinking') {
          const idx = this.appendDelta(rt.id, msg.id, 'thinking', ev.delta);
          if (idx !== thinkingIdx) { closeThinking(); thinkingIdx = idx; thinkingStart = Date.now(); }
        } else if (ev.type === 'text') {
          closeThinking();
          this.appendDelta(rt.id, msg.id, 'text', ev.delta);
        } else if (ev.type === 'tool_call') {
          closeThinking();
          calls.push(ev as ToolCallEvent);
        } else if (ev.type === 'done') {
          done = ev;
        }
      }
    } catch (e) {
      closeThinking();
      const aborted = req.signal?.aborted ?? false;
      const hasContent = this.mutate(rt.id, (s) => {
        const m = this.findMessage(s, msg.id);
        if (!m) return false;
        if (aborted) { m.meta = { ...(m.meta ?? {}), durationMs: Date.now() - started, interrupted: true }; return true; }
        if (!m.blocks.length) { s.messages = s.messages.filter((x) => x.id !== msg.id); return false; }
        m.meta = { ...(m.meta ?? {}), durationMs: Date.now() - started };
        return true;
      });
      if (hasContent) {
        const meta = this.findMessage(this.session(rt.id), msg.id)?.meta;
        this.emit('message.completed', { sessionId: rt.id, messageId: msg.id, meta });
      } else if (!aborted) {
        this.emit('session.reset', { sessionId: rt.id });
      }
      throw e;
    }
    closeThinking();

    this.materializeToolCalls(rt.id, msg.id, calls);

    const usage = done?.usage;
    const meta: Message['meta'] = { model: model.ref.model, durationMs: Date.now() - started, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens };
    this.mutate(rt.id, (s) => {
      const m = this.findMessage(s, msg.id);
      if (m) m.meta = meta;
      if (usage) {
        s.usage.inputTokens += usage.promptTokens;
        s.usage.outputTokens += usage.completionTokens;
        s.usage.lastPromptTokens = usage.promptTokens;
      }
      s.usage.requests += 1;
    });
    if (usage) rt.tokensSinceUsage = usage.completionTokens;
    this.emit('message.completed', { sessionId: rt.id, messageId: msg.id, meta });
    this.emitSession(rt.id);
    const text = textOfMessage(this.findMessage(this.session(rt.id), msg.id) ?? msg);
    return { messageId: msg.id, text, toolCalls: calls, finishReason: done?.finishReason ?? 'stop' };
  }

  /** Append tool_use blocks for `calls` to the message and emit them. Mutates each call's id to be unique within the
   *  message and flags invalid-JSON / non-object arguments with an error so they are reported, not executed. */
  private materializeToolCalls(sessionId: string, messageId: string, calls: ToolCallEvent[]): void {
    const seen = new Set<string>();
    for (const b of this.findMessage(this.session(sessionId), messageId)?.blocks ?? []) {
      if (b.type === 'tool_use') seen.add(b.id);
    }
    for (const c of calls) {
      let id = c.id || `call_${newId()}`;
      while (seen.has(id)) id = `${id}_${seen.size}`;
      seen.add(id);
      c.id = id;
      let input: Record<string, unknown> = {};
      if (!c.error) {
        try {
          const parsed = JSON.parse(c.arguments || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          else c.error = 'Tool arguments must be a JSON object.';
        } catch {
          c.error = `Your tool call arguments were not valid JSON, so the call was NOT executed. Received: ${clipLine(c.arguments, 300)}`;
        }
      }
      const block: ToolUseBlock = { type: 'tool_use', id, name: c.name, input, status: 'pending' };
      const idx = this.mutate(sessionId, (s) => {
        const m = this.findMessage(s, messageId);
        if (!m) return -1;
        m.blocks.push(block);
        return m.blocks.length - 1;
      });
      if (idx >= 0) this.emit('message.block', { sessionId, messageId, blockIndex: idx, block: clone(block) });
    }
  }

  /** When a step ends with no tool calls and no answer, a model may have written a text-form tool call inside its
   *  reasoning. Recover it (materializing blocks on the message) so the turn makes progress. Returns the recovered
   *  calls, or an empty array when there is nothing to recover. */
  private recoverToolCallsFromThinking(rt: Runtime, res: StepResult, specs: ChatToolSpec[]): ToolCallEvent[] {
    if (res.toolCalls.length || res.text.trim()) return [];
    const msg = this.findMessage(this.session(rt.id), res.messageId);
    const thinking = msg ? thinkingOfMessage(msg) : '';
    if (!thinking || !EMBEDDED_TOOL_CALL_RE.test(thinking)) return [];
    const parsed = parseTextToolCalls(thinking, specs.length ? specs : undefined, () => `call_${newId()}`);
    if (!parsed.calls.length) return [];
    const calls: ToolCallEvent[] = parsed.calls.map((p) => ({ type: 'tool_call', id: p.id, name: p.name, arguments: p.arguments }));
    this.materializeToolCalls(rt.id, res.messageId, calls);
    return calls;
  }

  // ───────────────────────────── tools ─────────────────────────────

  private updateTool(sessionId: string, messageId: string, toolId: string, patch: Partial<ToolUseBlock>): ToolUseBlock | null {
    const block = this.mutate(sessionId, (s) => {
      const m = this.findMessage(s, messageId);
      const b = m?.blocks.find((x) => x.type === 'tool_use' && x.id === toolId) as ToolUseBlock | undefined;
      if (!b) return null;
      Object.assign(b, patch);
      for (const k of Object.keys(patch) as (keyof ToolUseBlock)[]) if (patch[k] === undefined) delete b[k];
      return clone(b);
    });
    if (block) this.emit('tool.updated', { sessionId, messageId, tool: block });
    return block;
  }

  private finishTool(sessionId: string, messageId: string, toolId: string, status: ToolStatus, result: ToolResultPayload): void {
    this.updateTool(sessionId, messageId, toolId, { status, result, endedAt: Date.now(), progress: undefined });
  }

  private async executeTools(rt: Runtime, messageId: string, calls: ToolCallEvent[], signal: AbortSignal): Promise<boolean> {
    const byName = new Map(this.sessionTools(rt).map((t) => [t.name, t]));
    const isSafe = (c: ToolCallEvent) => c.name === 'Task' || !!c.error || !byName.has(c.name) || byName.get(c.name)!.concurrencySafe;
    const batches: ToolCallEvent[][] = [];
    for (const c of calls) {
      const last = batches[batches.length - 1];
      if (isSafe(c) && last && isSafe(last[0]!)) last.push(c);
      else batches.push([c]);
    }
    let stop = false;
    for (const batch of batches) {
      if (signal.aborted) break;
      if (stop) {
        // the user denied an earlier call of this message: don't evaluate (or auto-run) the rest
        for (const c of batch) {
          this.finishTool(rt.id, messageId, c.id, 'denied', { content: 'Skipped: the user denied a previous tool call in this message.', isError: true });
        }
        continue;
      }
      const results = await Promise.all(batch.map((c) => this.runToolCall(rt, messageId, c, byName.get(c.name), signal)));
      if (results.some((r) => r.stop)) stop = true;
    }
    if (signal.aborted) {
      // anything that never ran is interrupted (history needs a result for every call)
      for (const c of calls) {
        const s = this.session(rt.id);
        const b = this.findMessage(s, messageId)?.blocks.find((x) => x.type === 'tool_use' && x.id === c.id) as ToolUseBlock | undefined;
        if (b && (b.status === 'pending' || b.status === 'running' || b.status === 'awaiting_permission')) {
          this.finishTool(rt.id, messageId, c.id, 'interrupted', { content: 'Interrupted by the user before the tool finished.', isError: true });
        }
      }
      return false;
    }
    return !stop;
  }

  private settingsRules(cwd: string): { allow: string[]; deny: string[] } {
    const s = this.settings();
    let proj: { allow: string[]; deny: string[] } = { allow: [], deny: [] };
    try { proj = this.ctx.settings.forProject(cwd)?.permissions ?? proj; } catch { /* no project settings */ }
    return {
      allow: [...(s.permissions?.allow ?? []), ...(proj.allow ?? [])],
      deny: [...(s.permissions?.deny ?? []), ...(proj.deny ?? [])],
    };
  }

  private async runToolCall(rt: Runtime, messageId: string, call: ToolCallEvent, tool: ToolDef | undefined, signal: AbortSignal): Promise<{ stop: boolean }> {
    const fail = (content: string, status: ToolStatus = 'error') => {
      this.finishTool(rt.id, messageId, call.id, status, { content, isError: true });
      return { stop: false };
    };
    if (call.error) return fail(call.error);
    if (!tool) {
      const names = this.sessionTools(rt).map((t) => t.name).join(', ');
      return fail(`Unknown tool "${call.name}". Available tools: ${names || '(none)'}.`);
    }
    const s = this.session(rt.id);
    const block = this.findMessage(s, messageId)?.blocks.find((x) => x.type === 'tool_use' && x.id === call.id) as ToolUseBlock | undefined;
    // Normalise once (aliases such as "cmd"/"filePath" → canonical keys) so the permission engine, the approval dialog,
    // hooks and run() all see exactly the input that will be executed.
    let input: Record<string, unknown> = block?.input ?? {};
    if (tool.normalize) {
      try {
        const n = tool.normalize(input);
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          if (JSON.stringify(n) !== JSON.stringify(input)) this.updateTool(rt.id, messageId, call.id, { input: clone(n) });
          input = n;
        }
      } catch { /* keep the raw input; run() reports the problem */ }
    }
    const settings = this.settings();
    let kind: PermissionKind;
    try { kind = tool.permission(input, { cwd: s.cwd, settings }); } catch { kind = 'exec'; }
    const rules = this.settingsRules(s.cwd);
    const decision = decidePermission({
      tool, input, cwd: s.cwd, mode: s.permissionMode, kind, allow: rules.allow, deny: rules.deny,
      shellKind: resolveShellKind(settings.shell),
      // the app's data dir (settings, secrets, sessions) is protected unless the session itself works inside it
      protectedDirs: this.ctx.dataDir && !isInside(this.ctx.dataDir, s.cwd) ? [this.ctx.dataDir] : [],
    });
    if (decision.action === 'deny') return fail(decision.message, decision.reason === 'plan mode' ? 'error' : 'denied');
    if (decision.action === 'ask') {
      let title = tool.name;
      try { title = tool.title(input); } catch { /* keep name */ }
      if (rt.headless) {
        return fail(
          `Permission for "${title}" was denied automatically: this is an unattended (scheduled) run in "${s.permissionMode}" permission mode, so nobody can approve it. Continue without it (e.g. with read-only tools) or finish and report what needs approval.`,
          'denied',
        );
      }
      this.updateTool(rt.id, messageId, call.id, { status: 'awaiting_permission' });
      const answer = await this.askPermission(rt, call.id, tool.name, input, title, decision.suggestedRule);
      if (!answer || signal.aborted) {
        this.finishTool(rt.id, messageId, call.id, 'interrupted', { content: 'Interrupted by the user.', isError: true });
        return { stop: true };
      }
      if (answer.decision === 'deny') {
        const fb = answer.message?.trim();
        this.finishTool(rt.id, messageId, call.id, 'denied', {
          content: fb
            ? `The user denied this tool call and said: ${fb}`
            : 'The user denied this tool call. Stop what you are doing and wait for the user\'s next instruction.',
          isError: true,
        });
        return { stop: !fb };
      }
      if (answer.decision === 'allow_always' && decision.suggestedRule) {
        try { this.ctx.settings.addProjectAllowRule(s.cwd, decision.suggestedRule); } catch { /* best effort */ }
      }
    }
    const pre = await this.hook('PreToolUse', { session_id: rt.id, tool_name: tool.name, tool_input: input, tool_use_id: call.id }, s.cwd, signal);
    if (pre.block) return fail(`Blocked by a PreToolUse hook${pre.message ? `: ${pre.message}` : '.'}`, 'denied');
    if (signal.aborted) {
      this.finishTool(rt.id, messageId, call.id, 'interrupted', { content: 'Interrupted by the user before the tool ran.', isError: true });
      return { stop: true };
    }

    this.updateTool(rt.id, messageId, call.id, { status: 'running', startedAt: Date.now() });
    const tctx = this.toolContext(rt, messageId, call.id, signal);
    let result: ToolResultPayload;
    try {
      result = await raceAbort(Promise.resolve().then(() => tool.run(input, tctx)), signal);
    } catch (e) {
      if (signal.aborted || e instanceof AbortedError) {
        this.finishTool(rt.id, messageId, call.id, 'interrupted', { content: 'Interrupted by the user.', isError: true });
        return { stop: true };
      }
      result = { content: `Error: ${errorMessage(e)}`, isError: true };
    }
    if (!result || typeof result.content !== 'string') result = { ...(result ?? {}), content: String(result?.content ?? '') };
    const max = settings.maxToolOutputChars || DEFAULT_MAX_TOOL_OUTPUT;
    result = { ...result, content: truncateOutput(result.content, max) };
    const post = await this.hook('PostToolUse', {
      session_id: rt.id, tool_name: tool.name, tool_input: input, tool_use_id: call.id, tool_response: result.content, is_error: !!result.isError,
    }, s.cwd, signal);
    if (post.additionalContext) result.content += `\n\n${wrapReminder(post.additionalContext)}`;
    if (post.block && post.message) result.content += `\n\n${wrapReminder(`PostToolUse hook: ${post.message}`)}`;
    rt.tokensSinceUsage += Math.ceil(result.content.length / 3.6) + (result.images?.length ?? 0) * 768;
    this.finishTool(rt.id, messageId, call.id, result.isError ? 'error' : 'done', result);
    return { stop: false };
  }

  private askPermission(rt: Runtime, toolUseId: string, toolName: string, input: Record<string, unknown>, title: string, suggestedRule: string): Promise<{ decision: PermissionDecision; message?: string } | null> {
    const request: PermissionRequest = {
      requestId: newId(), sessionId: rt.rootId, toolUseId, toolName, input: clone(input), title, suggestedRule, createdAt: Date.now(),
    };
    return this.waitForHuman(rt, (resolveFn) => ({ kind: 'permission', ownerId: rt.id, request, resolve: resolveFn }), () => this.emit('permission.requested', clone(request)));
  }

  private waitForHuman<V>(rt: Runtime, make: (resolve: (v: V | null) => void) => PendingEntry, announce: () => void): Promise<V | null> {
    return new Promise<V | null>((resolveOuter) => {
      const entry = make((v) => {
        rt.pendingHuman = Math.max(0, rt.pendingHuman - 1);
        if (rt.pendingHuman === 0 && rt.busy) {
          this.setStatus(rt, 'running');
          this.activity(rt, 'running');
          if (rt.rootId !== rt.id) { const root = this.runtimes.get(rt.rootId); if (root?.busy && root.pendingHuman === 0) this.setStatus(root, 'running'); }
        }
        resolveOuter(v);
      });
      this.pendingReqs.set(entry.request.requestId, entry);
      rt.pendingHuman++;
      this.setStatus(rt, 'waiting');
      this.activity(rt, 'waiting');
      if (rt.rootId !== rt.id) { const root = this.runtimes.get(rt.rootId); if (root) this.setStatus(root, 'waiting'); }
      announce();
      if (rt.abort?.signal.aborted) this.resolvePending(entry.request.requestId, null);
    });
  }

  private toolContext(rt: Runtime, messageId: string, toolUseId: string, signal: AbortSignal): ToolContext {
    const s = this.session(rt.id);
    let lastProgress = 0;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingProgress: string | undefined;
    const flushProgress = () => {
      progressTimer = undefined;
      if (pendingProgress === undefined) return;
      lastProgress = Date.now();
      const p = pendingProgress;
      pendingProgress = undefined;
      const b = this.findMessage(this.session(rt.id), messageId)?.blocks.find((x) => x.type === 'tool_use' && x.id === toolUseId) as ToolUseBlock | undefined;
      if (b && b.status === 'running') this.updateTool(rt.id, messageId, toolUseId, { progress: p });
    };
    return {
      sessionId: rt.id,
      cwd: s.cwd,
      toolUseId,
      signal,
      permissionMode: s.permissionMode,
      settings: this.settings(),
      secret: (name) => { try { return this.ctx.secrets.get(name); } catch { return null; } },
      dataDir: this.ctx.dataDir,
      progress: (text) => {
        pendingProgress = text;
        const wait = 100 - (Date.now() - lastProgress);
        if (wait <= 0) flushProgress();
        else if (!progressTimer) { progressTimer = setTimeout(flushProgress, wait); progressTimer.unref?.(); }
      },
      readFiles: rt.readFiles,
      checkpointFile: async (absPath) => {
        const root = this.runtimes.get(rt.rootId) ?? rt;
        await this.checkpoints.checkpoint(root.id, root.currentTurnId ?? 'initial', resolve(s.cwd, absPath));
      },
      recordChange: (change) => this.recordChange(rt, toolUseId, change),
      todos: {
        get: () => clone(this.session(rt.id).todos ?? []),
        set: (todos: Todo[]) => {
          this.mutate(rt.id, (x) => { x.todos = clone(todos); });
          this.emit('todos.updated', { sessionId: rt.id, todos: clone(todos) });
        },
      },
      askUser: (questions) => this.askUser(rt, toolUseId, questions),
      requestPlanApproval: (plan) => this.requestPlanApproval(rt, toolUseId, plan),
      runSubagent: (opts) => this.runSubagent(rt, toolUseId, opts, signal),
      shells: this.ctx.shells,
      scheduler: this.ctx.scheduler,
      ext: this.ctx.ext,
      complete: (prompt, opts) => this.complete(rt.id, prompt, opts, signal),
    };
  }

  private async askUser(rt: Runtime, toolUseId: string, questions: Question[]): Promise<Record<string, string>> {
    if (rt.headless) {
      const out: Record<string, string> = {};
      for (const q of questions) out[q.question] = HEADLESS_NO_ANSWER;
      return out;
    }
    const request: QuestionRequest = { requestId: newId(), sessionId: rt.rootId, toolUseId, questions: clone(questions), createdAt: Date.now() };
    const answers = await this.waitForHuman<Record<string, string>>(rt, (r) => ({ kind: 'question', ownerId: rt.id, request, resolve: r }), () => this.emit('question.requested', clone(request)));
    if (!answers) throw new AbortedError();
    return answers;
  }

  private async requestPlanApproval(rt: Runtime, toolUseId: string, plan: string): Promise<{ approved: boolean; mode: PermissionMode; feedback?: string }> {
    if (rt.headless) {
      return { approved: false, mode: 'plan', feedback: `${HEADLESS_NO_ANSWER}. Present the plan as your final answer and stop.` };
    }
    const request: PlanRequest = { requestId: newId(), sessionId: rt.rootId, toolUseId, plan, createdAt: Date.now() };
    const res = await this.waitForHuman<{ approved: boolean; mode: PermissionMode; feedback?: string }>(
      rt, (r) => ({ kind: 'plan', ownerId: rt.id, request, resolve: r }), () => this.emit('plan.requested', clone(request)),
    );
    if (!res) throw new AbortedError();
    if (res.approved) {
      const mode: PermissionMode = res.mode && res.mode !== 'plan' ? res.mode : 'default';
      this.mutate(rt.id, (s) => { s.permissionMode = mode; });
      this.emitSession(rt.id);
      return { approved: true, mode, feedback: res.feedback };
    }
    if (!res.feedback?.trim()) rt.stopAfterTools = true; // "keep planning" without feedback → wait for the user
    return { approved: false, mode: 'plan', feedback: res.feedback };
  }

  private recordChange(rt: Runtime, toolUseId: string, change: Omit<ChangedFile, 'lastToolUseId'>): void {
    const targets = [rt.id];
    if (rt.rootId !== rt.id) targets.push(rt.rootId);
    for (const sid of targets) {
      const ok = this.mutate(sid, (s) => {
        const abs = resolve(s.cwd, change.path);
        const key = pathKey(abs);
        const existing = s.changedFiles.find((f) => pathKey(resolve(s.cwd, f.path)) === key);
        if (existing) {
          existing.additions = change.additions;
          existing.deletions = change.deletions;
          existing.isNew = existing.isNew || change.isNew;
          existing.lastToolUseId = toolUseId;
        } else {
          s.changedFiles.push({ path: abs, additions: change.additions, deletions: change.deletions, isNew: change.isNew, lastToolUseId: toolUseId });
        }
        return true;
      });
      if (ok) this.emit('changes.updated', { sessionId: sid, changedFiles: clone(this.session(sid).changedFiles) });
    }
    const root = this.runtimes.get(rt.rootId) ?? rt;
    void this.refreshChangeStats(root, resolve(this.session(rt.id).cwd, change.path), toolUseId, targets);
  }

  /** Cumulative diff stats (vs the session's first checkpoint of the file) via the diff package. */
  private async refreshChangeStats(rootRt: Runtime, path: string, toolUseId: string, targets: string[] = [rootRt.id]): Promise<void> {
    try {
      const abs = resolve(this.session(rootRt.id).cwd, path);
      const orig = await this.checkpoints.original(rootRt.id, abs);
      if (!orig) return;
      let after = '';
      let exists = true;
      try { after = await fs.readFile(abs, 'utf8'); } catch { exists = false; }
      const before = orig.existed ? orig.content.toString('utf8') : '';
      if (before.length + after.length > 4_000_000) return;
      let additions = 0;
      let deletions = 0;
      for (const part of diffLines(before, after)) {
        if (part.added) additions += part.count ?? 0;
        else if (part.removed) deletions += part.count ?? 0;
      }
      for (const sid of targets) {
        const changed = this.mutate(sid, (s) => {
          const key = pathKey(abs);
          const f = s.changedFiles.find((x) => pathKey(resolve(s.cwd, x.path)) === key);
          if (!f) return false;
          if (!exists && !orig.existed) { s.changedFiles = s.changedFiles.filter((x) => x !== f); return true; }
          f.additions = additions;
          f.deletions = deletions;
          f.isNew = !orig.existed;
          f.lastToolUseId = f.lastToolUseId || toolUseId;
          return true;
        });
        if (changed) this.emit('changes.updated', { sessionId: sid, changedFiles: clone(this.session(sid).changedFiles) });
      }
    } catch { /* stats are best effort */ }
  }

  // ───────────────────────────── subagents ─────────────────────────────

  private async runSubagent(
    parent: Runtime, toolUseId: string, opts: { agentType: string; description: string; prompt: string; model?: ModelRef }, signal: AbortSignal,
  ): Promise<{ sessionId: string; result: string }> {
    const depth = parent.depth + 1;
    if (depth > MAX_SUBAGENT_DEPTH) throw new Error(`Subagents can't start further subagents (maximum depth ${MAX_SUBAGENT_DEPTH}). Do the work directly.`);
    const ps = this.session(parent.id);
    const agentType = opts.agentType?.trim() || 'general-purpose';
    let def: AgentDefinition | null = null;
    try { def = (await this.ctx.ext?.agentDefinition(ps.cwd, agentType)) ?? null; } catch { def = null; }
    def ??= builtinDefinition(agentType);
    if (!def) {
      const types = await this.agentTypes(ps.cwd);
      throw new Error(`Unknown subagent type "${agentType}". Available types: ${types.map((t) => t.name).join(', ')}.`);
    }
    const release = await parent.subagentSlots.acquire(signal);
    let childId: string | undefined;
    const onAbort = () => { if (childId) this.interrupt(childId); };
    try {
      const model = opts.model ?? this.modelFromDefinition(def.model) ?? ps.model;
      const child = this.ctx.sessions.create({
        cwd: ps.cwd, kind: 'subagent', parentSessionId: parent.id, parentToolUseId: toolUseId, title: opts.description || agentType,
        model, permissionMode: ps.permissionMode, thinking: ps.thinking,
      });
      childId = child.id;
      this.emit('session.created', toSummary(child));
      parent.children.add(child.id);
      const crt = this.runtime(child.id);
      crt.depth = depth;
      crt.parentId = parent.id;
      crt.rootId = parent.rootId;
      crt.agentDef = def;
      crt.inheritedHeadless = parent.headless;
      crt.titleDone = true;
      crt.sessionStarted = true;
      signal.addEventListener('abort', onAbort, { once: true });
      const res = await this.enqueueAndWait(crt, { messageId: newId(), text: opts.prompt, headless: parent.headless });
      if (res.interrupted || signal.aborted) throw new AbortedError();
      if (!res.ok) throw new Error(`The ${def.name} subagent failed: ${res.error ?? 'unknown error'}`);
      return { sessionId: child.id, result: res.finalText.trim() || '(The subagent finished without a final report.)' };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (childId) parent.children.delete(childId);
      release();
    }
  }

  private modelFromDefinition(model: string | undefined): ModelRef | null {
    if (!model || model === 'inherit') return null;
    let list: ModelInfo[] = [];
    try { list = this.ctx.models.models(); } catch { list = []; }
    const m = list.find((x) => x.ref.model === model || `${x.ref.provider}:${x.ref.model}` === model || x.label.toLowerCase() === model.toLowerCase());
    return m ? { ...m.ref } : null;
  }

  // ───────────────────────────── one-off completions, titles, compaction ─────────────────────────────

  private async complete(sessionId: string, prompt: string, opts: { maxTokens?: number; system?: string } = {}, signal?: AbortSignal): Promise<string> {
    const rt = this.runtime(sessionId);
    const { endpoint, model } = await this.resolveModel(rt);
    const messages: ChatRequest['messages'] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });
    let text = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    for await (const ev of this.ctx.llm.stream(endpoint, { model: model.ref.model, messages, thinking: false, maxTokens: opts.maxTokens ?? 1024, signal })) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'done') usage = ev.usage;
    }
    if (usage) {
      try {
        this.mutate(sessionId, (s) => { s.usage.inputTokens += usage!.promptTokens; s.usage.outputTokens += usage!.completionTokens; });
      } catch { /* session gone */ }
    }
    return text.trim();
  }

  private async maybeTitle(rt: Runtime, prompt: string): Promise<void> {
    if (rt.titleDone) return;
    rt.titleDone = true;
    try {
      const s = this.session(rt.id);
      if (s.kind === 'subagent') return;
      if (s.messages.filter(isRealUserMessage).length !== 1) return;
      if (!(isDefaultTitle(s.title) || s.title === rt.provisionalTitle)) return;
      const fallback = clipLine(prompt, 50);
      let title = '';
      try {
        title = sanitizeTitle(await this.complete(
          rt.id,
          `Write a short title (at most 6 words) for a conversation that starts with the request below. Reply with the title only.\n\nRequest: ${prompt.slice(0, 1500)}`,
          { maxTokens: 24 },
        ));
      } catch { title = ''; }
      const finalTitle = title || fallback;
      const cur = this.session(rt.id);
      if (!(isDefaultTitle(cur.title) || cur.title === rt.provisionalTitle)) return;
      if (!finalTitle || cur.title === finalTitle) return;
      this.mutate(rt.id, (x) => { x.title = finalTitle; });
      this.emitSession(rt.id);
      this.activity(rt, rt.busy ? (rt.pendingHuman ? 'waiting' : 'running') : 'done');
    } catch { /* titles are best effort */ }
  }

  /** Summarise older history into a compact_summary message. Returns false when there is nothing to compact. */
  private async compact(rt: Runtime, opts: { reason: 'auto' | 'manual' | 'overflow'; instructions?: string; signal?: AbortSignal }): Promise<boolean> {
    const s = this.session(rt.id);
    const plan = planCompaction(s.messages);
    if (!plan) return false;
    const anchorId = s.messages[plan.insertAt]?.id;
    const { endpoint, model } = await this.resolveModel(rt);
    const maxChars = Math.max(8000, Math.floor(model.contextLength * 0.5 * 3.5));
    const transcript = renderTranscript(s.messages.slice(plan.from, plan.to), maxChars);
    let summary = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    for await (const ev of this.ctx.llm.stream(endpoint, {
      model: model.ref.model,
      messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: summaryPrompt(transcript, opts.instructions) }],
      thinking: false,
      maxTokens: 3000,
      signal: opts.signal,
    })) {
      if (ev.type === 'text') summary += ev.delta;
      else if (ev.type === 'done') usage = ev.usage;
    }
    if (!summary.trim()) throw new Error('Compaction failed: the model returned an empty summary.');
    const msg: Message = {
      id: newId(), role: 'system', tag: 'compact_summary', createdAt: Date.now(),
      blocks: [{ type: 'text', text: summaryMessageText(summary, plan.currentRequest) }],
    };
    rt.systemPrompt = undefined; // the prompt is re-prefilled anyway: refresh memory/skills/git
    this.mutate(rt.id, (x) => {
      const at = anchorId ? x.messages.findIndex((m) => m.id === anchorId) : -1;
      if (at >= 0) x.messages.splice(at, 0, msg);
      else x.messages.push(msg);
      if (usage) { x.usage.inputTokens += usage.promptTokens; x.usage.outputTokens += usage.completionTokens; }
    });
    const tools = this.sessionTools(rt);
    const system = await this.systemPrompt(rt, tools);
    const est = estimateTokens(buildHistory(this.session(rt.id).messages, { system, supportsVision: model.supportsVision })) + Math.ceil(JSON.stringify(tools.map((t) => t.inputSchema)).length / 3.6);
    this.mutate(rt.id, (x) => { x.usage.lastPromptTokens = est; });
    rt.tokensSinceUsage = 0;
    this.emit('session.reset', { sessionId: rt.id });
    this.emitSession(rt.id);
    if (opts.reason !== 'manual') {
      this.emit('notification', { title: 'Context compacted', body: 'Older messages were summarised to stay within the model\'s context window.', level: 'info', sessionId: rt.id });
    }
    return true;
  }

  // ───────────────────────────── slash commands ─────────────────────────────

  private async runBuiltin(rt: Runtime, item: QueueItem, name: string, args: string): Promise<TurnResult> {
    const s = this.session(rt.id);
    const input = `/${name}${args ? ` ${args}` : ''}`;
    const echo = (out: string): TurnResult => { this.commandEcho(rt, item, input, out); return { ok: true, finalText: out }; };
    switch (name) {
      case 'clear': {
        await this.archive(s);
        this.mutate(rt.id, (x) => {
          x.messages = [];
          x.todos = [];
          x.changedFiles = [];
          x.usage = { ...x.usage, lastPromptTokens: 0 };
        });
        rt.systemPrompt = undefined;
        rt.readFiles.clear();
        rt.tokensSinceUsage = 0;
        this.emit('session.reset', { sessionId: rt.id });
        this.emit('todos.updated', { sessionId: rt.id, todos: [] });
        this.emit('changes.updated', { sessionId: rt.id, changedFiles: [] });
        this.emitSession(rt.id);
        return { ok: true, finalText: '' };
      }
      case 'compact': {
        rt.abort = new AbortController();
        this.setStatus(rt, 'running');
        try {
          const did = await this.compact(rt, { reason: 'manual', instructions: args, signal: rt.abort.signal });
          return echo(did ? 'Conversation compacted. Older messages were summarised; the summary is used as context from now on.' : 'Nothing to compact yet.');
        } catch (e) {
          if (rt.abort?.signal.aborted) return echo('Compaction interrupted.');
          return { ...echo(`Compaction failed: ${errorMessage(e)}`), ok: false };
        } finally {
          rt.abort = null;
          this.setStatus(rt, 'idle');
        }
      }
      case 'model': {
        let models: ModelInfo[] = [];
        try { models = this.ctx.models.models(); } catch { models = []; }
        if (!args) {
          const cur = s.model ? `${s.model.provider}:${s.model.model}` : 'default';
          const list = models.map((m) => `- \`${m.ref.provider}:${m.ref.model}\` — ${m.label}${m.variant ? ` (${m.variant})` : ''}, ${m.status}`).join('\n');
          return echo(`Current model: \`${cur}\`\n\n${list || 'No models are available right now.'}\n\nSwitch with \`/model <id>\`.`);
        }
        const q = args.toLowerCase();
        const m = models.find((x) => `${x.ref.provider}:${x.ref.model}`.toLowerCase() === q)
          ?? models.find((x) => x.ref.model.toLowerCase() === q)
          ?? models.find((x) => x.label.toLowerCase() === q)
          ?? models.find((x) => x.ref.model.toLowerCase().includes(q) || x.label.toLowerCase().includes(q));
        if (!m) return { ...echo(`No model matches "${args}". Type \`/model\` to list models.`), ok: false };
        this.mutate(rt.id, (x) => { x.model = { ...m.ref }; });
        this.emitSession(rt.id);
        return echo(`Model set to \`${m.ref.provider}:${m.ref.model}\` (${m.label}).`);
      }
      case 'plan': {
        if (args) {
          if (s.permissionMode !== 'plan') { rt.prevMode = s.permissionMode; this.mutate(rt.id, (x) => { x.permissionMode = 'plan'; }); this.emitSession(rt.id); }
          return this.runPrompt(rt, item, args);
        }
        const next: PermissionMode = s.permissionMode === 'plan' ? (rt.prevMode && rt.prevMode !== 'plan' ? rt.prevMode : 'default') : 'plan';
        if (next === 'plan') rt.prevMode = s.permissionMode;
        this.mutate(rt.id, (x) => { x.permissionMode = next; });
        this.emitSession(rt.id);
        return echo(next === 'plan' ? 'Plan mode on: the agent will research read-only and propose a plan before changing anything.' : `Plan mode off (permission mode: ${next}).`);
      }
      case 'init':
        return this.runPrompt(rt, item, INIT_PROMPT);
      case 'help': {
        let custom: { name: string; description: string; argumentHint?: string }[] = [];
        try { custom = (await this.ctx.ext?.slashCommands(s.cwd)) ?? []; } catch { custom = []; }
        custom = custom.filter((c) => !isBuiltinCommand(c.name));
        const fmt = (c: { name: string; description: string; argumentHint?: string }) => `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}\` — ${c.description}`;
        const parts = ['**Built-in commands**', ...BUILTIN_COMMANDS.map(fmt)];
        if (custom.length) parts.push('', '**Custom commands**', ...custom.map(fmt));
        parts.push('', 'Start a message with `#` to add a note to the project memory (OBSIDIAN.md).');
        return echo(parts.join('\n'));
      }
      case 'cost': {
        const u = s.usage;
        let ctxLen = rt.modelInfo?.contextLength;
        if (!ctxLen) { try { ctxLen = this.ctx.models.resolve(s.model).model.contextLength; } catch { ctxLen = undefined; } }
        const pct = ctxLen ? ` (${Math.round((u.lastPromptTokens / ctxLen) * 100)}% of ${ctxLen.toLocaleString('en-US')})` : '';
        return echo([
          `- Requests: ${u.requests}`,
          `- Input tokens: ${u.inputTokens.toLocaleString('en-US')}`,
          `- Output tokens: ${u.outputTokens.toLocaleString('en-US')}`,
          `- Context in use: ${u.lastPromptTokens.toLocaleString('en-US')} tokens${pct}`,
          `- Cost: open-weight models have no per-token price; rented Vast GPU time is shown in the GPU panel.`,
        ].join('\n'));
      }
      case 'todos': {
        const t = s.todos ?? [];
        if (!t.length) return echo('No todos yet.');
        return echo(t.map((x) => `- [${x.status === 'completed' ? 'x' : ' '}] ${x.content}${x.status === 'in_progress' ? ' *(in progress)*' : ''}`).join('\n'));
      }
      case 'agents': {
        const types = await this.agentTypes(s.cwd);
        return echo(types.map((a) => `- **${a.name}** (${a.source}) — ${a.description}${a.tools?.length ? ` · tools: ${a.tools.join(', ')}` : ''}`).join('\n'));
      }
      case 'skills': {
        let skills: { name: string; description: string; source: string }[] = [];
        try { skills = (await this.ctx.ext?.skills(s.cwd)) ?? []; } catch { skills = []; }
        return echo(skills.length ? skills.map((k) => `- **${k.name}** (${k.source}) — ${k.description}`).join('\n') : 'No skills found. Add skills under `~/.obsidian-code/skills/<name>/SKILL.md` or `<project>/.obsidian-code/skills`.');
      }
      case 'memory': {
        let text = '';
        try { text = (await this.ctx.ext?.memoryText(s.cwd)) ?? ''; } catch { text = ''; }
        const file = join(s.cwd, 'OBSIDIAN.md');
        const body = text.trim() ? `\n\n\`\`\`markdown\n${text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text}\n\`\`\`` : '\n\nNo memory files found.';
        return echo(`Project memory file: \`${file}\` (add notes by starting a message with \`#\`).${body}`);
      }
      case 'thinking': {
        const a = args.toLowerCase();
        const next = a === 'on' || a === 'true' ? true : a === 'off' || a === 'false' ? false : !s.thinking;
        this.mutate(rt.id, (x) => { x.thinking = next; });
        this.emitSession(rt.id);
        return echo(`Thinking ${next ? 'on' : 'off'}.`);
      }
      case 'rewind': {
        const restore = /\b(files|--files|restore|--restore)\b/i.test(args);
        const n = Math.max(1, Number.parseInt(/\d+/.exec(args)?.[0] ?? '1', 10));
        const users = s.messages.filter(isRealUserMessage);
        const target = users[users.length - n];
        if (!target) return { ...echo('Nothing to rewind.'), ok: false };
        const restored = await this.doRewind(rt, target.id, restore);
        return echo(`Rewound ${n} turn${n === 1 ? '' : 's'}.${restore ? ` Restored ${restored.length} file${restored.length === 1 ? '' : 's'}${restored.length ? `: ${restored.map((p) => `\`${p}\``).join(', ')}` : ''}.` : ''}`);
      }
      default:
        return echo(`Unknown command /${name}.`);
    }
  }

  private async archive(s: Session): Promise<void> {
    if (!s.messages.length) return;
    try {
      const dir = join(this.ctx.dataDir, 'archive', s.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, `${Date.now()}.json`), JSON.stringify({ archivedAt: Date.now(), title: s.title, messages: s.messages, todos: s.todos, changedFiles: s.changedFiles }));
    } catch { /* archive is best effort */ }
  }
}

export function createAgentManagerImpl(ctx: CoreContext): AgentManagerImpl {
  return new AgentManagerImpl(ctx);
}
