// Internal contracts between core modules. Each module implements its interface and receives
// the others through a `CoreContext` (dependency injection) — no module imports another
// module's internals, only these interfaces and src/shared/*.

import type { CoreEventName, CoreEvents } from '../shared/protocol';
import type {
  ActivityItem, AgentTypeInfo, ChangedFile, GpuStatus, ImageBlock, Message, ModelInfo, ModelRef, PermissionDecision,
  PermissionMode, ProviderInfo, Question, ScheduledTask, Session, SessionSummary, Settings, SkillInfo,
  SlashCommandInfo, Todo, ToolDisplay, ToolResultPayload,
} from '../shared/types';

// ───────────────────────────── Event bus ─────────────────────────────

export interface EventBus {
  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void;
  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void;
}

// ───────────────────────────── Store (src/core/store) ─────────────────────────────

export interface SessionStore {
  list(opts?: { includeSubagents?: boolean }): SessionSummary[];
  get(id: string): Session | undefined;
  create(init: Partial<SessionSummary> & { cwd: string }): Session;
  /** Persist the full session (debounced writes are fine; flush() forces). */
  save(session: Session): void;
  delete(id: string): void;
  search(query: string): { sessionId: string; title: string; snippet: string }[];
  flush(): Promise<void>;
}

export interface SettingsStore {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
  /** Project-level overrides (.obsidian-code/settings.json, and .claude/settings.json permissions when importClaudeConfig). */
  forProject(cwd: string): { permissions: { allow: string[]; deny: string[] }; hooks: Settings['hooks'] };
  addProjectAllowRule(cwd: string, rule: string): void;
  onChange(fn: (s: Settings) => void): () => void;
}

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string | null): void;
  has(name: string): boolean;
}

/** Simple append-only JSON storage for small records (gpu ledger, schedules). */
export interface KvStore {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}

// ───────────────────────────── LLM (src/core/llm) ─────────────────────────────

/** OpenAI chat-completions message shapes we send. */
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string | ChatContentPart[] };

export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export interface ChatToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Ask the server to think (Qwen: chat_template_kwargs.enable_thinking). */
  thinking?: boolean;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string } // emitted once per completed call
  | { type: 'done'; finishReason: string; usage?: { promptTokens: number; completionTokens: number } };

export interface Endpoint { baseUrl: string; apiKey?: string }

export interface LlmClient {
  /** Streams an OpenAI-compatible chat completion. Must handle: reasoning_content deltas, <think> tags in content,
   *  native tool_calls deltas, and Qwen-style <tool_call>{json}</tool_call> in content as a fallback. */
  stream(endpoint: Endpoint, req: ChatRequest): AsyncIterable<LlmEvent>;
}

export interface LlmProvider {
  id: string; // ProviderId
  info(): ProviderInfo;
  endpoint(): Endpoint | null; // null when offline
  listModels(): Promise<ModelInfo[]>;
}

export interface ModelRegistry {
  providers(): ProviderInfo[];
  models(): ModelInfo[];
  refresh(): Promise<{ providers: ProviderInfo[]; models: ModelInfo[] }>;
  register(provider: LlmProvider): void;
  /** Resolve a ModelRef to an endpoint + model info, or throw a friendly error ("Vast GPU is not clocked in"). */
  resolve(ref: ModelRef | null): { endpoint: Endpoint; model: ModelInfo };
  /** Best available model right now (session default → settings default → vast if ready → local → custom). */
  pickDefault(): ModelRef | null;
}

// ───────────────────────────── Tools (src/core/tools) ─────────────────────────────

export type PermissionKind = 'read' | 'edit' | 'exec' | 'network' | 'none';

export interface ToolContext {
  sessionId: string;
  cwd: string;
  toolUseId: string;
  signal: AbortSignal;
  permissionMode: PermissionMode;
  settings: Settings;
  /** Read a secret (e.g. 'search.braveKey'). Never put secret values in tool output. */
  secret(name: string): string | null;
  /** Data dir for tool caches (e.g. WebFetch cache). */
  dataDir: string;
  /** Stream progress text to the UI (e.g. tail of bash output). */
  progress(text: string): void;
  /** Files read in this session (path → mtimeMs at read time). Edit/Write require prior Read for existing files. */
  readFiles: Map<string, number>;
  /** Record a file's pre-change content for rewind, then mark it changed. Call BEFORE writing. */
  checkpointFile(absPath: string): Promise<void>;
  /** Report a completed change for the Changes panel. */
  recordChange(change: Omit<ChangedFile, 'lastToolUseId'>): void;
  todos: { get(): Todo[]; set(todos: Todo[]): void };
  askUser(questions: Question[]): Promise<Record<string, string>>;
  /** Plan mode: present a plan; resolves with approval and the permission mode to continue in. */
  requestPlanApproval(plan: string): Promise<{ approved: boolean; mode: PermissionMode; feedback?: string }>;
  /** Run a subagent to completion and return its final report text. */
  runSubagent(opts: { agentType: string; description: string; prompt: string; model?: ModelRef }): Promise<{ sessionId: string; result: string }>;
  shells: ShellRegistry;
  scheduler: SchedulerApi;
  ext: ExtensionsApi;
  /** One-off LLM call with the session's model (no tools) — e.g. WebFetch summarisation. */
  complete(prompt: string, opts?: { maxTokens?: number; system?: string }): Promise<string>;
}

export interface ToolDef<I = Record<string, unknown>> {
  name: string;
  /** Model-facing description (keep concise — local models have small prompt budgets). */
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  /** What kind of permission running this needs given the input. 'none' = never asks. */
  permission(input: I, ctx: Pick<ToolContext, 'cwd' | 'settings'>): PermissionKind;
  /** Short human title for permission prompts/tool cards, e.g. "Edit src/app.ts". */
  title(input: I): string;
  /** Suggested "always allow" rule, e.g. "Bash(npm test:*)" or "Edit". */
  ruleFor?(input: I): string;
  /** Read-only tools may run concurrently. */
  concurrencySafe: boolean;
  run(input: I, ctx: ToolContext): Promise<ToolResultPayload>;
}

export interface ShellRegistry {
  /** Start a background command; returns an id. */
  start(opts: { command: string; cwd: string; shell: 'bash' | 'powershell' | 'cmd'; sessionId: string }): string;
  output(id: string, opts?: { sinceLastRead?: boolean; filter?: string }): { output: string; running: boolean; exitCode: number | null };
  kill(id: string): boolean;
  list(sessionId?: string): { id: string; command: string; running: boolean; startedAt: number; sessionId: string }[];
}

// ───────────────────────────── Extensions (src/core/ext) ─────────────────────────────

export interface ExtensionsApi {
  /** CLAUDE.md / AGENTS.md / OBSIDIAN.md memory text for this cwd (user + project hierarchy), already concatenated. */
  memoryText(cwd: string): Promise<string>;
  skills(cwd: string): Promise<SkillInfo[]>;
  loadSkill(cwd: string, name: string): Promise<{ name: string; body: string; dir: string } | null>;
  agentTypes(cwd: string): Promise<AgentTypeInfo[]>;
  /** System prompt + allowed tools for a subagent type. */
  agentDefinition(cwd: string, name: string): Promise<{ name: string; systemPrompt: string; tools?: string[]; model?: string } | null>;
  slashCommands(cwd: string): Promise<SlashCommandInfo[]>;
  /** Expand a custom (file-based) slash command into prompt text, or null if not a custom command. */
  expandCommand(cwd: string, name: string, args: string): Promise<string | null>;
  /** Tools exposed by connected MCP servers (names: mcp__<server>__<tool>). */
  mcpTools(): ToolDef[];
  /** Run hooks; returns { block: true, message } if a hook blocked (exit code 2). */
  runHooks(event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart', payload: Record<string, unknown>, cwd: string): Promise<{ block: boolean; message?: string; additionalContext?: string }>;
}

// ───────────────────────────── Agent (src/core/agent) ─────────────────────────────

export interface AgentManager {
  send(sessionId: string, text: string, images?: ImageBlock[]): Promise<{ messageId: string; queued: boolean }>;
  interrupt(sessionId: string): void;
  respondPermission(requestId: string, decision: PermissionDecision, message?: string): void;
  answerQuestion(requestId: string, answers: Record<string, string>): void;
  respondPlan(requestId: string, approve: boolean, mode?: PermissionMode, feedback?: string): void;
  rewind(sessionId: string, atMessageId: string, restoreFiles: boolean): Promise<string[]>;
  pending(sessionId?: string): { permissions: import('../shared/types').PermissionRequest[]; questions: import('../shared/types').QuestionRequest[]; plans: import('../shared/types').PlanRequest[] };
  /** Run a prompt in a (new) session headlessly and resolve when the turn finishes (scheduler uses this). */
  runHeadless(opts: { sessionId: string; prompt: string }): Promise<{ ok: boolean; finalText: string }>;
  isRunning(sessionId: string): boolean;
  fileDiff(sessionId: string, path: string): Promise<{ before: string; after: string }>;
}

// ───────────────────────────── GPU (src/core/gpu) ─────────────────────────────

export interface GpuManager {
  status(): GpuStatus;
  provider(): LlmProvider; // id 'vast'
  catalog(): import('../shared/types').CatalogModel[];
  offers(profileId: string, limit?: number): Promise<import('../shared/types').GpuOffer[]>;
  clockIn(opts: { profileId: string; modelId?: string; offerId?: number }): Promise<GpuStatus>;
  clockOut(reason?: import('../shared/types').GpuSessionRecord['endReason']): Promise<GpuStatus>;
  switchModel(modelId: string): Promise<GpuStatus>;
  history(limit?: number): import('../shared/types').GpuSessionRecord[];
  destroyOrphans(): Promise<number[]>;
  serverLog(lines?: number): Promise<string>;
  testKey(): Promise<{ ok: boolean; message: string; creditBalance?: number }>;
  /** Wait until ready (used by scheduler auto clock-in). */
  waitUntilReady(timeoutMs: number): Promise<boolean>;
  dispose(): Promise<void>;
}

// ───────────────────────────── Scheduler (src/core/scheduler) ─────────────────────────────

export interface SchedulerApi {
  list(): ScheduledTask[];
  create(t: Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'>): ScheduledTask;
  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask;
  delete(id: string): void;
  runNow(id: string): Promise<{ sessionId: string }>;
}

// ───────────────────────────── Activity (src/core/activity) ─────────────────────────────

export interface ActivityRegistry {
  upsert(item: ActivityItem): void;
  list(): ActivityItem[];
  /** Register how to stop an item. */
  onStop(id: string, fn: () => void): void;
  stop(id: string): void;
}

// ───────────────────────────── Composition root ─────────────────────────────

export interface CoreContext {
  bus: EventBus;
  dataDir: string; // e.g. %APPDATA%/obsidian-code (or OBSIDIAN_CODE_DATA_DIR)
  sessions: SessionStore;
  settings: SettingsStore;
  secrets: SecretStore;
  kv: KvStore;
  llm: LlmClient;
  models: ModelRegistry;
  tools: { all(): ToolDef[]; get(name: string): ToolDef | undefined };
  ext: ExtensionsApi;
  shells: ShellRegistry;
  agent: AgentManager;
  gpu: GpuManager;
  scheduler: SchedulerApi;
  activity: ActivityRegistry;
  /** Native integrations injected by Electron main (no-ops in standalone/browser mode). */
  native: NativeBridge;
}

export interface NativeBridge {
  notify(title: string, body: string): void;
  isElectron: boolean;
  /** Encrypt/decrypt for SecretStore (Electron safeStorage). Null when unavailable → store uses its own fallback. */
  encrypt?(plain: string): Buffer;
  decrypt?(data: Buffer): string;
}

export type { ChangedFile, Message, ModelInfo, ModelRef, Session, Settings, ToolDisplay };
