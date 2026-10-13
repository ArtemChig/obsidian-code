// Claude Agent SDK message stream → the app's transcript + CoreEvents (so the UI works unchanged for claude-code
// sessions). One Translator per root session; subagent (Task/Agent) traffic — messages whose parent_tool_use_id is
// the Agent tool_use id — is mirrored into a child session of kind 'subagent'.
//
// Mapping (docs/research/claude-agent-sdk.md §"Message shapes"):
//   stream_event message_start            → message.added (empty assistant message, one per API call)
//   stream_event text/thinking deltas     → message.delta
//   stream_event content_block_start tool → message.block (ToolUseBlock, pending)
//   assistant (one per finished block)    → authoritative block text / tool input → message.block / tool.updated (running)
//   stream_event message_stop             → message.completed (meta: tokens, duration)
//   user tool_result                      → tool.updated (done/error/denied + ToolDisplay), todos/changes side effects
//   result                                → usage totals; ends the turn (handled by the engine)

import type { CoreEventName, CoreEvents } from '../../../shared/protocol';
import type { Block, Message, Session, ToolDisplay, ToolResultPayload, ToolStatus, ToolUseBlock } from '../../../shared/types';
import { EDIT_TOOL_NAMES, SUBAGENT_TOOL_NAMES, inputFilePath, toTodos, toolDisplay, uiToolName } from './display';

type Obj = Record<string, unknown>;

export interface TranslatorHost {
  session(id: string): Session | undefined;
  mutate<T>(id: string, fn: (s: Session) => T): T;
  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void;
  newId(): string;
  /** Create the child session for a Task/Agent tool call; returns its id. */
  createSubagent(parentSessionId: string, toolUseId: string, agentType: string, description: string): string;
  /** Set a (child) session's status. */
  setStatus(sessionId: string, status: Session['status']): void;
  /** File content captured before an edit tool ran (PreToolUse), keyed by tool_use id. */
  takeBefore(toolUseId: string): { existed: boolean; content: string } | undefined;
  /** Current text of a file (for diffs), null when unreadable. */
  readText(absPath: string): string | null;
  /** An edit tool changed this file. */
  recordChange(sessionId: string, toolUseId: string, absPath: string): void;
  /** Display produced by an in-process MCP tool for (name, input). */
  takeMcpDisplay(name: string, input: Obj): ToolDisplay | undefined;
  /** Tool calls that were denied through canUseTool (status 'denied'). */
  wasDenied(toolUseId: string): boolean;
  /** Text of the `ui` ToolUseBlock while it waits for permission. */
  resolvePath(sessionId: string, p: string): string;
}

interface ApiMsg {
  apiId: string;
  sessionId: string;
  messageId: string;
  /** SDK content index → UI block index. */
  blocks: Map<number, number>;
  /** Finished (assistant-message) blocks matched so far, by UI index. */
  finalized: Set<number>;
  thinkingStarted: Map<number, number>;
  startedAt: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  streamed: boolean;
  completed: boolean;
}

interface ToolRef { sessionId: string; messageId: string; name: string; input: Obj }

export interface TurnUsage { inputTokens: number; outputTokens: number; requests: number; lastPromptTokens?: number }

function clone<T>(v: T): T { return structuredClone(v); }

function asObj(v: unknown): Obj {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  if (typeof v === 'string' && v.startsWith('{')) { try { return JSON.parse(v) as Obj; } catch { return {}; } }
  return {};
}

function contentText(content: unknown): { text: string; images: { mediaType: string; data: string }[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: { mediaType: string; data: string }[] = [];
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content as Obj[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image') {
        const src = b.source as Obj | undefined;
        if (src && typeof src.data === 'string') images.push({ mediaType: String(src.media_type ?? 'image/png'), data: src.data });
      }
    }
  }
  return { text: parts.join('\n'), images };
}

export class Translator {
  /** scope ('main' or the parent tool_use id) → API message being streamed. */
  private readonly current = new Map<string, ApiMsg>();
  private readonly byApiId = new Map<string, ApiMsg>();
  private readonly tools = new Map<string, ToolRef>();
  private readonly subagents = new Map<string, string>();
  /** Tool calls waiting for a permission answer. */
  private readonly awaiting = new Set<string>();
  /** Claude Code task id (agentId) → child session. */
  private readonly tasks = new Map<string, string>();
  /** Child sessions of agents that run in the background (Agent returns at once; a task_notification ends them). */
  private readonly background = new Set<string>();
  /** Requests whose message_start reached us in this turn (main + subagents). */
  private requests = 0;
  private lastMainPromptTokens: number | undefined;
  /** uuid of the last main-chain transcript entry (assistant/user) — resumeSessionAt target for rewinds. */
  lastChainUuid: string | undefined;
  /** Final text of the main agent's last assistant message in this turn. */
  lastText = '';

  constructor(private readonly host: TranslatorHost, readonly rootId: string) {}

  /** Child session id for a Task/Agent tool_use id (if any). */
  subagentSession(toolUseId: string): string | undefined {
    return this.subagents.get(toolUseId);
  }

  toolRef(toolUseId: string): ToolRef | undefined {
    return this.tools.get(toolUseId);
  }

  /** Reset per-turn counters. */
  beginTurn(): void {
    this.requests = 0;
    this.lastMainPromptTokens = undefined;
    this.lastText = '';
  }

  private scopeOf(m: Obj): string {
    const p = m.parent_tool_use_id;
    return typeof p === 'string' && p ? p : 'main';
  }

  /** Session that receives messages of a scope (creates the subagent child lazily). */
  private sessionFor(scope: string): string {
    if (scope === 'main') return this.rootId;
    const known = this.subagents.get(scope);
    if (known) return known;
    const ref = this.tools.get(scope);
    const input = ref?.input ?? {};
    const child = this.host.createSubagent(ref?.sessionId ?? this.rootId, scope, String(input.subagent_type ?? 'general-purpose'), String(input.description ?? 'Subagent'));
    this.subagents.set(scope, child);
    return child;
  }

  private findMessage(s: Session, id: string): Message | undefined {
    for (let i = s.messages.length - 1; i >= 0; i--) if (s.messages[i]!.id === id) return s.messages[i];
    return undefined;
  }

  private startMessage(scope: string, apiId: string, streamed: boolean, usage?: Obj, model?: string): ApiMsg {
    const sessionId = this.sessionFor(scope);
    const msg: Message = { id: this.host.newId(), role: 'assistant', createdAt: Date.now(), blocks: [], meta: model ? { model } : {} };
    this.host.mutate(sessionId, (s) => { s.messages.push(msg); });
    this.host.emit('message.added', { sessionId, message: clone(msg) });
    const prompt = usage ? Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) : undefined;
    const rec: ApiMsg = {
      apiId, sessionId, messageId: msg.id, blocks: new Map(), finalized: new Set(), thinkingStarted: new Map(), startedAt: Date.now(),
      promptTokens: prompt || undefined, model, streamed, completed: false,
    };
    this.current.set(scope, rec);
    if (apiId) this.byApiId.set(apiId, rec);
    this.requests++;
    if (scope === 'main' && prompt) this.lastMainPromptTokens = prompt;
    return rec;
  }

  private pushBlock(rec: ApiMsg, block: Block, sdkIndex?: number): number {
    const idx = this.host.mutate(rec.sessionId, (s) => {
      const m = this.findMessage(s, rec.messageId);
      if (!m) return -1;
      m.blocks.push(block);
      return m.blocks.length - 1;
    });
    if (idx >= 0) {
      if (sdkIndex !== undefined) rec.blocks.set(sdkIndex, idx);
      this.host.emit('message.block', { sessionId: rec.sessionId, messageId: rec.messageId, blockIndex: idx, block: clone(block) });
    }
    return idx;
  }

  private appendDelta(rec: ApiMsg, sdkIndex: number, type: 'text' | 'thinking', delta: string): void {
    if (!delta) return;
    let idx = rec.blocks.get(sdkIndex);
    const r = this.host.mutate(rec.sessionId, (s) => {
      const m = this.findMessage(s, rec.messageId);
      if (!m) return -1;
      if (idx === undefined) {
        m.blocks.push({ type, text: '' } as Block);
        idx = m.blocks.length - 1;
      }
      const b = m.blocks[idx];
      if (b && (b.type === 'text' || b.type === 'thinking')) b.text += delta;
      return idx;
    });
    if (r === undefined || r < 0) return;
    rec.blocks.set(sdkIndex, r);
    this.host.emit('message.delta', { sessionId: rec.sessionId, messageId: rec.messageId, blockIndex: r, blockType: type, delta });
  }

  private completeMessage(rec: ApiMsg, interrupted = false): void {
    if (rec.completed) return;
    rec.completed = true;
    const meta: Message['meta'] = { model: rec.model, durationMs: Date.now() - rec.startedAt };
    if (rec.promptTokens) meta.promptTokens = rec.promptTokens;
    if (rec.completionTokens) meta.completionTokens = rec.completionTokens;
    if (interrupted) meta.interrupted = true;
    const keep = this.host.mutate(rec.sessionId, (s) => {
      const m = this.findMessage(s, rec.messageId);
      if (!m) return false;
      if (!m.blocks.length && !interrupted) { s.messages = s.messages.filter((x) => x !== m); return false; }
      m.meta = { ...(m.meta ?? {}), ...meta };
      return true;
    });
    if (keep) this.host.emit('message.completed', { sessionId: rec.sessionId, messageId: rec.messageId, meta });
    else this.host.emit('session.reset', { sessionId: rec.sessionId });
  }

  private updateTool(sessionId: string, messageId: string, toolId: string, patch: Partial<ToolUseBlock>): ToolUseBlock | null {
    const block = this.host.mutate(sessionId, (s) => {
      const m = this.findMessage(s, messageId);
      const b = m?.blocks.find((x) => x.type === 'tool_use' && x.id === toolId) as ToolUseBlock | undefined;
      if (!b) return null;
      Object.assign(b, patch);
      for (const k of Object.keys(patch) as (keyof ToolUseBlock)[]) if (patch[k] === undefined) delete b[k];
      return clone(b);
    });
    if (block) this.host.emit('tool.updated', { sessionId, messageId, tool: block });
    return block;
  }

  /** Mark a tool block (e.g. while a permission prompt is open). canUseTool can run before the SDK hands us the
   *  finished tool_use block, so the status is remembered and applied when the block arrives. */
  setToolStatus(toolUseId: string, status: ToolStatus): void {
    if (status === 'awaiting_permission') this.awaiting.add(toolUseId); else this.awaiting.delete(toolUseId);
    const ref = this.tools.get(toolUseId);
    if (ref) this.updateTool(ref.sessionId, ref.messageId, toolUseId, { status });
  }

  // ───────────────────────────── entry point ─────────────────────────────

  handle(raw: unknown): void {
    const m = raw as Obj;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'stream_event': this.onStreamEvent(m); break;
      case 'assistant': this.onAssistant(m); break;
      case 'user': this.onUser(m); break;
      default: break;
    }
  }

  private onStreamEvent(m: Obj): void {
    const scope = this.scopeOf(m);
    const ev = (m.event ?? {}) as Obj;
    const type = String(ev.type ?? '');
    if (type === 'message_start') {
      const message = (ev.message ?? {}) as Obj;
      const prev = this.current.get(scope);
      if (prev && !prev.completed) this.completeMessage(prev);
      this.startMessage(scope, String(message.id ?? ''), true, message.usage as Obj | undefined, typeof message.model === 'string' ? message.model : undefined);
      return;
    }
    const rec = this.current.get(scope);
    if (!rec || rec.completed) return;
    const index = Number(ev.index ?? 0);
    if (type === 'content_block_start') {
      const cb = (ev.content_block ?? {}) as Obj;
      if (cb.type === 'tool_use') {
        const id = String(cb.id ?? '');
        const name = String(cb.name ?? '');
        const block: ToolUseBlock = { type: 'tool_use', id, name: uiToolName(name), input: {}, status: 'pending' };
        this.tools.set(id, { sessionId: rec.sessionId, messageId: rec.messageId, name, input: {} });
        this.pushBlock(rec, block, index);
      } else if (cb.type === 'thinking') {
        rec.thinkingStarted.set(index, Date.now());
      }
      return;
    }
    if (type === 'content_block_delta') {
      const d = (ev.delta ?? {}) as Obj;
      if (d.type === 'text_delta') this.appendDelta(rec, index, 'text', String(d.text ?? ''));
      else if (d.type === 'thinking_delta') this.appendDelta(rec, index, 'thinking', String(d.thinking ?? ''));
      return;
    }
    if (type === 'content_block_stop') {
      const started = rec.thinkingStarted.get(index);
      const ui = rec.blocks.get(index);
      if (started !== undefined && ui !== undefined) {
        rec.thinkingStarted.delete(index);
        const block = this.host.mutate(rec.sessionId, (s) => {
          const b = this.findMessage(s, rec.messageId)?.blocks[ui];
          if (b && b.type === 'thinking') { b.durationMs = b.durationMs ?? Date.now() - started; return clone(b); }
          return null;
        });
        if (block) this.host.emit('message.block', { sessionId: rec.sessionId, messageId: rec.messageId, blockIndex: ui, block });
      }
      return;
    }
    if (type === 'message_delta') {
      const u = (ev.usage ?? {}) as Obj;
      if (typeof u.output_tokens === 'number') rec.completionTokens = u.output_tokens;
      return;
    }
    if (type === 'message_stop') this.completeMessage(rec);
  }

  private onAssistant(m: Obj): void {
    const scope = this.scopeOf(m);
    const message = (m.message ?? {}) as Obj;
    const apiId = String(message.id ?? '');
    if (scope === 'main' && typeof m.uuid === 'string') this.lastChainUuid = m.uuid;
    let rec = (apiId && this.byApiId.get(apiId)) || undefined;
    if (!rec || (rec.completed && !rec.streamed)) {
      rec = rec && !rec.completed ? rec : undefined;
    }
    if (!rec) rec = this.startMessage(scope, apiId, false, message.usage as Obj | undefined, typeof message.model === 'string' ? message.model : undefined);
    const content = Array.isArray(message.content) ? (message.content as Obj[]) : [];
    const thinkingMs = typeof m.thinking_duration_ms === 'number' ? m.thinking_duration_ms : undefined;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' || b.type === 'thinking') {
        const kind = b.type;
        const text = String((kind === 'text' ? b.text : b.thinking) ?? '');
        if (scope === 'main' && kind === 'text' && text.trim()) this.lastText = text;
        const ui = this.firstUnfinalized(rec, kind);
        if (ui === undefined) {
          if (!text) continue;
          const block: Block = kind === 'text' ? { type: 'text', text } : { type: 'thinking', text, durationMs: thinkingMs };
          const idx = this.pushBlock(rec, block);
          if (idx >= 0) rec.finalized.add(idx);
          continue;
        }
        rec.finalized.add(ui);
        const updated = this.host.mutate(rec.sessionId, (s) => {
          const blk = this.findMessage(s, rec!.messageId)?.blocks[ui];
          if (!blk || blk.type !== kind) return null;
          let changed = false;
          if (text && blk.text !== text) { blk.text = text; changed = true; }
          if (blk.type === 'thinking' && thinkingMs !== undefined && blk.durationMs !== thinkingMs) { blk.durationMs = thinkingMs; changed = true; }
          return changed ? clone(blk) : null;
        });
        if (updated) this.host.emit('message.block', { sessionId: rec.sessionId, messageId: rec.messageId, blockIndex: ui, block: updated });
      } else if (b.type === 'tool_use') {
        const id = String(b.id ?? '');
        const name = String(b.name ?? '');
        const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Obj;
        const existing = this.tools.get(id);
        this.tools.set(id, { sessionId: rec.sessionId, messageId: rec.messageId, name, input });
        const status: ToolStatus = this.awaiting.has(id) ? 'awaiting_permission' : 'running';
        const patch: Partial<ToolUseBlock> = { input: clone(input), status, startedAt: Date.now() };
        const updated = existing ? this.updateTool(existing.sessionId, existing.messageId, id, patch) : null;
        if (!updated) {
          const idx = this.pushBlock(rec, { type: 'tool_use', id, name: uiToolName(name), input: clone(input), status, startedAt: Date.now() });
          if (idx >= 0) rec.finalized.add(idx);
        } else {
          const ui = this.host.session(rec.sessionId) ? this.findMessage(this.host.session(rec.sessionId)!, rec.messageId)?.blocks.findIndex((x) => x.type === 'tool_use' && x.id === id) : -1;
          if (ui !== undefined && ui >= 0) rec.finalized.add(ui);
        }
        if (SUBAGENT_TOOL_NAMES.has(name)) this.sessionFor(id);
      }
    }
    if (!rec.streamed) this.completeMessage(rec);
  }

  private firstUnfinalized(rec: ApiMsg, kind: 'text' | 'thinking'): number | undefined {
    const s = this.host.session(rec.sessionId);
    const msg = s ? this.findMessage(s, rec.messageId) : undefined;
    if (!msg) return undefined;
    const streamedIdx = [...rec.blocks.values()].sort((a, b) => a - b);
    for (const i of streamedIdx) {
      if (rec.finalized.has(i)) continue;
      if (msg.blocks[i]?.type === kind) return i;
    }
    return undefined;
  }

  private onUser(m: Obj): void {
    const scope = this.scopeOf(m);
    if (scope === 'main' && typeof m.uuid === 'string' && !m.isReplay) this.lastChainUuid = m.uuid;
    const message = (m.message ?? {}) as Obj;
    const content = message.content;
    const blocks = Array.isArray(content) ? (content as Obj[]) : [];
    const results = blocks.filter((b) => b && b.type === 'tool_result');
    if (!results.length) {
      // the prompt a subagent was started with: show it as the child transcript's first user message
      if (scope !== 'main' && !m.isReplay && !m.isSynthetic) {
        const { text, images } = contentText(content);
        if (!text.trim() && !images.length) return;
        const sessionId = this.sessionFor(scope);
        const msg: Message = { id: this.host.newId(), role: 'user', createdAt: Date.now(), blocks: [{ type: 'text', text }] };
        this.host.mutate(sessionId, (s) => { s.messages.push(msg); });
        this.host.emit('message.added', { sessionId, message: clone(msg) });
      }
      return;
    }
    for (const r of results) this.onToolResult(r, results.length === 1 ? m.tool_use_result : undefined);
  }

  private onToolResult(r: Obj, toolUseResult: unknown): void {
    const id = String(r.tool_use_id ?? '');
    const ref = this.tools.get(id);
    if (!ref) return;
    const { text, images } = contentText(r.content);
    const isError = r.is_error === true;
    const denied = isError && this.host.wasDenied(id);
    const interrupted = isError && /interrupted by (the )?user|\[Request interrupted/i.test(text);
    const name = ref.name;
    let before: { existed: boolean; content: string } | undefined;
    let after: string | null | undefined;
    if (EDIT_TOOL_NAMES.has(name)) {
      before = this.host.takeBefore(id);
      const p = inputFilePath(ref.input);
      if (p && !isError) {
        const abs = this.host.resolvePath(ref.sessionId, p);
        after = this.host.readText(abs);
        this.host.recordChange(ref.sessionId, id, abs);
      }
    }
    const subagentSessionId = SUBAGENT_TOOL_NAMES.has(name) ? this.subagents.get(id) : undefined;
    if (subagentSessionId) {
      const r = asObj(toolUseResult);
      if (typeof r.agentId === 'string') this.tasks.set(r.agentId, subagentSessionId);
      if (!isError && (r.isAsync === true || r.status === 'async_launched')) {
        this.background.add(subagentSessionId);
      } else {
        const live = this.current.get(id);
        if (live && !live.completed) this.completeMessage(live);
        this.host.setStatus(subagentSessionId, isError && !interrupted ? 'error' : 'idle');
      }
    }
    const display = toolDisplay({
      name, input: ref.input, toolUseResult, content: text, isError, before, after, subagentSessionId,
      mcpDisplay: name.startsWith('mcp__obsidian__') ? this.host.takeMcpDisplay(name, ref.input) : undefined,
    });
    const result: ToolResultPayload = { content: text };
    if (isError) result.isError = true;
    if (images.length) result.images = images;
    if (display) result.display = display;
    this.awaiting.delete(id);
    const status: ToolStatus = denied ? 'denied' : interrupted ? 'interrupted' : isError ? 'error' : 'done';
    this.updateTool(ref.sessionId, ref.messageId, id, { status, result, endedAt: Date.now(), progress: undefined });
    if (name === 'TodoWrite' && !isError) {
      const todos = display?.kind === 'todos' ? display.todos : toTodos(ref.input.todos);
      this.host.mutate(ref.sessionId, (s) => { s.todos = clone(todos); });
      this.host.emit('todos.updated', { sessionId: ref.sessionId, todos: clone(todos) });
    }
  }

  /** system task_started / task_notification / task_updated: background agent lifecycle. */
  onTask(m: Obj): void {
    const taskId = typeof m.task_id === 'string' ? m.task_id : '';
    const toolUseId = typeof m.tool_use_id === 'string' ? m.tool_use_id : '';
    if (m.subtype === 'task_started') {
      const child = (taskId && this.tasks.get(taskId)) || (toolUseId && this.subagents.get(toolUseId)) || undefined;
      if (!child) return;
      if (taskId) this.tasks.set(taskId, child);
      // a resumed agent (SendMessage) streams under the new tool_use id
      if (toolUseId && !this.subagents.has(toolUseId)) this.subagents.set(toolUseId, child);
      if (m.is_backgrounded === true) this.background.add(child);
      this.host.setStatus(child, 'running');
      return;
    }
    const status = m.subtype === 'task_notification' ? m.status : (m.patch as Obj | undefined)?.status;
    if (typeof status !== 'string' || status === 'running' || status === 'pending') return;
    const child = (taskId && this.tasks.get(taskId)) || (toolUseId && this.subagents.get(toolUseId)) || undefined;
    if (!child) return;
    this.background.delete(child);
    for (const [scope, rec] of [...this.current]) {
      if (rec.sessionId === child && !rec.completed) { this.completeMessage(rec, status !== 'completed'); this.current.delete(scope); }
    }
    this.host.setStatus(child, status === 'failed' ? 'error' : 'idle');
  }

  /** Background agents still running (their messages keep arriving between turns). */
  hasBackgroundAgents(): boolean {
    return this.background.size > 0;
  }

  /** The turn ended (result / error / interrupt): close anything still streaming and pending tools. */
  endTurn(interrupted: boolean): void {
    for (const [scope, rec] of [...this.current]) {
      if (this.background.has(rec.sessionId) && !interrupted) continue;
      if (!rec.completed) this.completeMessage(rec, interrupted);
      this.current.delete(scope);
    }
    if (interrupted) this.background.clear();
    for (const [id, ref] of [...this.tools]) {
      if (this.background.has(ref.sessionId)) continue;
      this.tools.delete(id);
      const s = this.host.session(ref.sessionId);
      const b = s ? this.findMessage(s, ref.messageId)?.blocks.find((x) => x.type === 'tool_use' && x.id === id) as ToolUseBlock | undefined : undefined;
      if (b && (b.status === 'pending' || b.status === 'running' || b.status === 'awaiting_permission')) {
        this.updateTool(ref.sessionId, ref.messageId, id, {
          status: 'interrupted', endedAt: Date.now(), progress: undefined,
          result: { content: interrupted ? 'Interrupted by the user.' : 'The tool did not report a result.', isError: true },
        });
      }
    }
    for (const child of new Set(this.subagents.values())) {
      if (this.background.has(child)) continue;
      const s = this.host.session(child);
      if (s && (s.status === 'running' || s.status === 'waiting')) this.host.setStatus(child, 'idle');
    }
    for (const [apiId, rec] of [...this.byApiId]) if (rec.completed) this.byApiId.delete(apiId);
  }

  usage(): { requests: number; lastPromptTokens?: number } {
    return { requests: this.requests, lastPromptTokens: this.lastMainPromptTokens };
  }
}
