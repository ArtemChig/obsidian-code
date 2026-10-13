// Engine router (owner: engine): the AgentManager the rest of the core sees. Each session runs on one agent harness —
// the app's own loop ('builtin', src/core/agent) or the real Claude Code harness ('claude-code', ./claude-code) —
// chosen by session.engine (set from settings.engine.default at creation; sessions without it are 'builtin').

import type { AgentManager, CoreContext } from '../contracts';
import type { EngineId, EngineInfo, ImageBlock, PermissionDecision, PermissionMode, SessionSummary, SlashCommandInfo } from '../../shared/types';
import { AgentManagerImpl } from '../agent/manager';
import { toSummary } from '../agent/util';
import { ClaudeCodeEngine, type ClaudeCodeEngineDeps } from './claude-code/engine';

export const ENGINE_IDS: EngineId[] = ['builtin', 'claude-code'];

export function isEngineId(v: unknown): v is EngineId {
  return typeof v === 'string' && (ENGINE_IDS as string[]).includes(v);
}

export class EngineRouter implements AgentManager {
  readonly builtin: AgentManagerImpl;
  readonly claude: ClaudeCodeEngine;

  constructor(private readonly ctx: CoreContext, deps: { builtin?: AgentManagerImpl; claude?: ClaudeCodeEngineDeps } = {}) {
    this.builtin = deps.builtin ?? new AgentManagerImpl(ctx);
    this.claude = new ClaudeCodeEngine(ctx, deps.claude);
  }

  engineOf(sessionId: string): EngineId {
    const e = this.ctx.sessions.get(sessionId)?.engine;
    return e === 'claude-code' ? 'claude-code' : 'builtin';
  }

  private pick(sessionId: string): AgentManagerImpl | ClaudeCodeEngine {
    return this.engineOf(sessionId) === 'claude-code' ? this.claude : this.builtin;
  }

  send(sessionId: string, text: string, images?: ImageBlock[]): Promise<{ messageId: string; queued: boolean }> {
    return this.pick(sessionId).send(sessionId, text, images);
  }

  interrupt(sessionId: string): void {
    // both: a session may have just switched engines while the old one was still winding down
    this.builtin.interrupt(sessionId);
    this.claude.interrupt(sessionId);
  }

  dequeue(sessionId: string, messageId?: string): { messageId: string; text: string }[] {
    return [...this.builtin.dequeue(sessionId, messageId), ...this.claude.dequeue(sessionId, messageId)];
  }

  respondPermission(requestId: string, decision: PermissionDecision, message?: string): void {
    if (this.claude.owns(requestId)) this.claude.respondPermission(requestId, decision, message);
    else this.builtin.respondPermission(requestId, decision, message);
  }

  answerQuestion(requestId: string, answers: Record<string, string>): void {
    if (this.claude.owns(requestId)) this.claude.answerQuestion(requestId, answers);
    else this.builtin.answerQuestion(requestId, answers);
  }

  respondPlan(requestId: string, approve: boolean, mode?: PermissionMode, feedback?: string): void {
    if (this.claude.owns(requestId)) this.claude.respondPlan(requestId, approve, mode, feedback);
    else this.builtin.respondPlan(requestId, approve, mode, feedback);
  }

  rewind(sessionId: string, atMessageId: string, restoreFiles: boolean): Promise<string[]> {
    return this.pick(sessionId).rewind(sessionId, atMessageId, restoreFiles);
  }

  pending(sessionId?: string): ReturnType<AgentManager['pending']> {
    const a = this.builtin.pending(sessionId);
    const b = this.claude.pending(sessionId);
    return { permissions: [...a.permissions, ...b.permissions], questions: [...a.questions, ...b.questions], plans: [...a.plans, ...b.plans] };
  }

  runHeadless(opts: { sessionId: string; prompt: string }): Promise<{ ok: boolean; finalText: string }> {
    return this.pick(opts.sessionId).runHeadless(opts);
  }

  isRunning(sessionId: string): boolean {
    return this.builtin.isRunning(sessionId) || this.claude.isRunning(sessionId);
  }

  fileDiff(sessionId: string, path: string): Promise<{ before: string; after: string }> {
    return this.pick(sessionId).fileDiff(sessionId, path);
  }

  async engines(): Promise<EngineInfo[]> {
    const builtin: EngineInfo = { id: 'builtin', label: 'Obsidian', available: true, detail: 'The app\'s own agent loop (compact prompt and tools for local models).' };
    let cc: EngineInfo;
    try { cc = await this.claude.info(); } catch (e) {
      cc = { id: 'claude-code', label: 'Claude Code', available: false, detail: e instanceof Error ? e.message : String(e) };
    }
    return [builtin, cc];
  }

  /** Switch engines (idle sessions only). History stays in the transcript; claude-code is seeded with it. */
  setEngine(sessionId: string, engine: EngineId): SessionSummary {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (!isEngineId(engine)) throw new Error(`Unknown engine: ${String(engine)}`);
    const current = s.engine ?? 'builtin';
    if (current === engine) return toSummary(s);
    if (this.isRunning(sessionId) || s.status === 'running' || s.status === 'waiting') {
      throw new Error('Wait for the current turn to finish (or stop it) before switching engines.');
    }
    if (engine === 'claude-code') this.claude.resetForSwitch(sessionId);
    s.engine = engine;
    s.updatedAt = Date.now();
    this.ctx.sessions.save(s);
    const sum = toSummary(s);
    this.ctx.bus.emit('session.updated', sum);
    return sum;
  }

  async commands(cwd: string, sessionId?: string): Promise<SlashCommandInfo[]> {
    // claude-code sessions: Claude Code's own list (its built-ins, .claude commands and skills) — the text is passed
    // straight to the harness, so the app's own commands would not work there
    if (sessionId && this.engineOf(sessionId) === 'claude-code') return this.claude.commands(sessionId);
    return this.ctx.ext.slashCommands(cwd);
  }

  dispose(): void {
    this.claude.dispose();
  }
}

export function createAgentRouter(ctx: CoreContext, deps?: ConstructorParameters<typeof EngineRouter>[1]): EngineRouter {
  return new EngineRouter(ctx, deps);
}
