// Wire protocol between the renderer (or any client) and the core over WebSocket.
//
//   client → core : { id: number, method: keyof RpcMethods, params }
//   core → client : { id, result } | { id, error: { message, code? } }
//   core → client : { event: keyof CoreEvents, data }        (server push, no id)
//
// Connect to ws://127.0.0.1:<port>/ws?token=<token>. The token is generated per core start.

import type {
  ActivityItem, AgentTypeInfo, Block, EngineId, EngineInfo, CatalogModel, ChangedFile, GpuOffer, GpuSessionRecord, GpuStatus,
  ImageBlock, Message, ModelInfo, ModelRef, PermissionDecision, PermissionMode, PermissionRequest, PlanRequest,
  ProviderInfo, QuestionRequest, ScheduledTask, Session, SessionSummary, Settings, SkillInfo, SlashCommandInfo,
  Todo, ToolUseBlock,
} from './types';

export interface RpcMethods {
  // ── system
  'system.info': { params: {}; result: { version: string; platform: string; homeDir: string; dataDir: string; shell: string; electron: boolean } };

  // ── sessions
  'sessions.list': { params: { includeSubagents?: boolean }; result: SessionSummary[] };
  'sessions.get': { params: { id: string }; result: Session };
  'sessions.create': { params: { cwd?: string; title?: string; model?: ModelRef | null; permissionMode?: PermissionMode; engine?: EngineId }; result: SessionSummary };
  'sessions.rename': { params: { id: string; title: string }; result: SessionSummary };
  'sessions.delete': { params: { id: string }; result: { ok: true } };
  'sessions.fork': { params: { id: string; atMessageId?: string }; result: SessionSummary };
  'sessions.setPinned': { params: { id: string; pinned: boolean }; result: SessionSummary };
  'sessions.search': { params: { query: string }; result: { sessionId: string; title: string; snippet: string }[] };

  // ── chat
  /** Send a user message (or a slash command like "/compact"). Returns immediately; progress arrives via events. */
  'chat.send': { params: { sessionId: string; text: string; images?: ImageBlock[] }; result: { messageId: string; queued: boolean } };
  'chat.interrupt': { params: { sessionId: string }; result: { ok: true } };
  /** Withdraw queued (not yet started) messages: one by id, or all of the session's when messageId is omitted. */
  'chat.dequeue': { params: { sessionId: string; messageId?: string }; result: { removed: { messageId: string; text: string }[] } };
  'chat.respondPermission': { params: { requestId: string; decision: PermissionDecision; message?: string }; result: { ok: true } };
  'chat.answerQuestion': { params: { requestId: string; answers: Record<string, string> }; result: { ok: true } };
  'chat.respondPlan': { params: { requestId: string; approve: boolean; mode?: PermissionMode; feedback?: string }; result: { ok: true } };
  'chat.setPermissionMode': { params: { sessionId: string; mode: PermissionMode }; result: SessionSummary };
  'chat.setModel': { params: { sessionId: string; model: ModelRef }; result: SessionSummary };
  'chat.setThinking': { params: { sessionId: string; thinking: boolean }; result: SessionSummary };
  /** Switch a session's agent harness. Only allowed while the session is idle; history is carried over. */
  'chat.setEngine': { params: { sessionId: string; engine: EngineId }; result: SessionSummary };
  /** Rewind: drop messages from atMessageId (a user message) onward; optionally restore files to that point. */
  'chat.rewind': { params: { sessionId: string; atMessageId: string; restoreFiles: boolean }; result: { ok: true; restoredFiles: string[] } };
  'chat.pending': { params: { sessionId?: string }; result: { permissions: PermissionRequest[]; questions: QuestionRequest[]; plans: PlanRequest[] } };

  // ── workspace helpers
  'commands.list': { params: { cwd: string }; result: SlashCommandInfo[] };
  'skills.list': { params: { cwd: string }; result: SkillInfo[] };
  'agents.list': { params: { cwd: string }; result: AgentTypeInfo[] };
  'files.list': { params: { cwd: string; dir?: string }; result: { name: string; path: string; isDir: boolean; size?: number }[] };
  'files.search': { params: { cwd: string; query: string; limit?: number }; result: string[] };
  'files.read': { params: { path: string; maxBytes?: number }; result: { content: string; truncated: boolean } };
  'files.diff': { params: { sessionId: string; path: string }; result: { before: string; after: string } };

  // ── models
  'models.list': { params: {}; result: { providers: ProviderInfo[]; models: ModelInfo[] } };
  'models.refresh': { params: {}; result: { providers: ProviderInfo[]; models: ModelInfo[] } };
  'engines.list': { params: {}; result: EngineInfo[] };

  // ── gpu (vast.ai)
  'gpu.status': { params: {}; result: GpuStatus };
  'gpu.catalog': { params: {}; result: CatalogModel[] };
  'gpu.offers': { params: { profileId: string; limit?: number }; result: GpuOffer[] };
  'gpu.clockIn': { params: { profileId: string; modelId?: string; offerId?: number }; result: GpuStatus };
  'gpu.clockOut': { params: { reason?: 'clock_out' | 'app_quit' }; result: GpuStatus };
  'gpu.switchModel': { params: { modelId: string }; result: GpuStatus };
  'gpu.history': { params: { limit?: number }; result: GpuSessionRecord[] };
  'gpu.destroyOrphans': { params: {}; result: { destroyed: number[] } };
  'gpu.serverLog': { params: { lines?: number }; result: { text: string } };
  'gpu.testKey': { params: {}; result: { ok: boolean; message: string; creditBalance?: number } };

  // ── scheduler
  'schedules.list': { params: {}; result: ScheduledTask[] };
  'schedules.create': { params: Omit<ScheduledTask, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunSessionId' | 'lastRunStatus' | 'lastRunMessage' | 'nextRunAt'>; result: ScheduledTask };
  'schedules.update': { params: { id: string; patch: Partial<ScheduledTask> }; result: ScheduledTask };
  'schedules.delete': { params: { id: string }; result: { ok: true } };
  'schedules.runNow': { params: { id: string }; result: { sessionId: string } };

  // ── activity / oversight
  'activity.list': { params: {}; result: ActivityItem[] };
  'activity.stop': { params: { id: string }; result: { ok: true } };

  // ── settings & secrets
  'settings.get': { params: {}; result: Settings };
  'settings.update': { params: { patch: Partial<Settings> }; result: Settings };
  /** Secrets never travel back to the client; only presence is reported. Names: 'vast.apiKey', 'search.braveKey', 'search.tavilyKey', 'custom.<id>.apiKey', 'local.apiKey'. */
  'secrets.set': { params: { name: string; value: string | null }; result: { ok: true } };
  'secrets.has': { params: { names: string[] }; result: Record<string, boolean> };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result'];

export interface RpcRequest<M extends RpcMethod = RpcMethod> { id: number; method: M; params: RpcParams<M> }
export interface RpcResponseOk<M extends RpcMethod = RpcMethod> { id: number; result: RpcResult<M> }
export interface RpcResponseErr { id: number; error: { message: string; code?: string } }

/** Server-pushed events. Every session-scoped event carries sessionId. */
export interface CoreEvents {
  'session.created': SessionSummary;
  'session.updated': SessionSummary;
  'session.deleted': { sessionId: string };
  /** A complete message was appended (user message, or an assistant message once started). */
  'message.added': { sessionId: string; message: Message };
  /** Streaming append to the last block of a message (text or thinking). If blockIndex is new, the block is created. */
  'message.delta': { sessionId: string; messageId: string; blockIndex: number; blockType: 'text' | 'thinking'; delta: string };
  /** Replace a whole block (used for tool_use blocks and final block states). */
  'message.block': { sessionId: string; messageId: string; blockIndex: number; block: Block };
  'message.completed': { sessionId: string; messageId: string; meta: Message['meta'] };
  /** Prompt-processing progress of a pending assistant message (llama.cpp prefill), throttled; stops at the first token.
   *  progress = 0..1 of the uncached prompt; processed/total = prompt tokens (incl. cache) when known. */
  'message.progress': { sessionId: string; messageId: string; phase: 'prefill'; progress: number; processed?: number; total?: number };
  /** Messages were removed (rewind / compaction). The client should refetch via sessions.get. */
  'session.reset': { sessionId: string };
  'tool.updated': { sessionId: string; messageId: string; tool: ToolUseBlock };
  'todos.updated': { sessionId: string; todos: Todo[] };
  'changes.updated': { sessionId: string; changedFiles: ChangedFile[] };
  'permission.requested': PermissionRequest;
  'permission.resolved': { requestId: string; sessionId: string; decision: PermissionDecision };
  'question.requested': QuestionRequest;
  'question.resolved': { requestId: string; sessionId: string };
  'plan.requested': PlanRequest;
  'plan.resolved': { requestId: string; sessionId: string; approved: boolean };
  'models.updated': { providers: ProviderInfo[]; models: ModelInfo[] };
  'gpu.status': GpuStatus;
  'schedules.updated': ScheduledTask[];
  'activity.updated': ActivityItem[];
  'settings.updated': Settings;
  'notification': { title: string; body: string; level: 'info' | 'success' | 'warning' | 'error'; sessionId?: string };
  'error': { message: string; sessionId?: string };
}

export type CoreEventName = keyof CoreEvents;
export interface CoreEventMessage<E extends CoreEventName = CoreEventName> { event: E; data: CoreEvents[E] }
