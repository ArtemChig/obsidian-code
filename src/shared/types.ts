// Shared domain types used by core (Node), main (Electron) and renderer (React).
// This file is the contract between modules. Change it only in coordination with every owner.

// ───────────────────────────── Models & providers ─────────────────────────────

/** Which backend serves a model. 'local' = llama-server on this PC, 'vast' = rented GPU, 'custom:<id>' = user-configured OpenAI-compatible endpoint. */
export type ProviderId = 'local' | 'vast' | `custom:${string}`;

export interface ModelRef {
  provider: ProviderId;
  /** Model id as the provider's /v1/models reports it (or catalog id for vast). */
  model: string;
}

export type ProviderStatus = 'online' | 'offline' | 'starting' | 'error';

export interface ModelInfo {
  ref: ModelRef;
  label: string;
  /** Context window in tokens (from server /props or catalog; default 32768 if unknown). */
  contextLength: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsThinking: boolean;
  /** 'uncensored' (abliterated/heretic/etc.) or 'standard' (original vendor weights). */
  variant?: 'uncensored' | 'standard';
  status: ProviderStatus;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  status: ProviderStatus;
  baseUrl: string | null;
  detail?: string;
}

// ───────────────────────────── Sessions & transcript ─────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type SessionKind = 'chat' | 'subagent' | 'scheduled';
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Last request's prompt size — used for the context meter. */
  lastPromptTokens: number;
  requests: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  kind: SessionKind;
  parentSessionId?: string;
  /** For subagents: the tool_use id of the Task call that spawned it. */
  parentToolUseId?: string;
  scheduleId?: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  model: ModelRef | null;
  permissionMode: PermissionMode;
  thinking: boolean;
  pinned?: boolean;
  usage: UsageTotals;
}

export interface Session extends SessionSummary {
  messages: Message[];
  todos: Todo[];
  /** Files changed in this session (for the Changes panel). */
  changedFiles: ChangedFile[];
}

export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: Role;
  createdAt: number;
  blocks: Block[];
  /** 'compact_summary' marks a message produced by context compaction. 'command' = slash-command echo. */
  tag?: 'compact_summary' | 'command' | 'scheduled_prompt' | 'hook';
  meta?: { model?: string; durationMs?: number; promptTokens?: number; completionTokens?: number; interrupted?: boolean };
}

export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock;

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; text: string; durationMs?: number }
export interface ImageBlock { type: 'image'; mediaType: string; /** base64 without data: prefix */ data: string; name?: string }

export type ToolStatus = 'pending' | 'awaiting_permission' | 'running' | 'done' | 'error' | 'denied' | 'interrupted';

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  startedAt?: number;
  endedAt?: number;
  result?: ToolResultPayload;
  /** Live progress text (e.g. streaming bash output tail). */
  progress?: string;
}

export interface ToolResultPayload {
  /** What the model sees. */
  content: string;
  isError?: boolean;
  /** Optional images returned to the model (e.g. Read of a PNG). */
  images?: { mediaType: string; data: string }[];
  /** Rich rendering hint for the UI. */
  display?: ToolDisplay;
}

export type ToolDisplay =
  | { kind: 'diff'; path: string; before: string; after: string; isNewFile?: boolean }
  | { kind: 'file'; path: string; content: string; startLine: number; totalLines: number }
  | { kind: 'bash'; command: string; output: string; exitCode: number | null; shellId?: string; background?: boolean }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'search'; query: string; results: { title: string; url: string; snippet?: string }[] }
  | { kind: 'web'; url: string; title?: string; bytes: number }
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'subagent'; sessionId: string; agentType: string; description: string }
  | { kind: 'plan'; plan: string }
  | { kind: 'questions'; questions: Question[]; answers?: Record<string, string> }
  | { kind: 'markdown'; markdown: string };

export interface Todo { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export interface ChangedFile { path: string; additions: number; deletions: number; isNew: boolean; lastToolUseId: string }

// ───────────────────────────── Interactive requests ─────────────────────────────

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Human readable one-liner, e.g. "Run: npm install". */
  title: string;
  /** Suggested rule for "always allow", e.g. "Bash(npm install:*)". */
  suggestedRule?: string;
  createdAt: number;
}

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  questions: Question[];
  createdAt: number;
}

export interface PlanRequest {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  plan: string;
  createdAt: number;
}

// ───────────────────────────── Slash commands, skills, agents ─────────────────────────────

export interface SlashCommandInfo {
  name: string; // without leading slash
  description: string;
  source: 'builtin' | 'user' | 'project';
  argumentHint?: string;
}

export interface SkillInfo { name: string; description: string; path: string; source: 'user' | 'project' | 'claude-user' | 'claude-project' }
export interface AgentTypeInfo { name: string; description: string; tools?: string[]; model?: string; source: 'builtin' | 'user' | 'project' }

// ───────────────────────────── GPU (Vast.ai) ─────────────────────────────

export interface GpuProfile {
  id: string; // 'light' | 'standard' | 'max' | user-defined
  label: string;
  description: string;
  gpuNames: string[]; // Vast gpu_name values accepted, e.g. ["RTX PRO 6000 WS","RTX PRO 6000 S"]
  numGpus: number;
  minGpuRamGb: number; // per GPU
  minCpuRamGb: number;
  minDiskGb: number;
  minInetDownMbps: number;
  minReliability: number; // 0..1
  maxPricePerHour: number; // USD, safety cap
  datacenterOnly: boolean;
  defaultModelId: string; // catalog id
}

export interface CatalogModel {
  id: string;
  label: string;
  family: string;
  variant: 'uncensored' | 'standard';
  /** Hugging Face repo, e.g. "unsloth/Qwen3.8-27B-GGUF" */
  repo: string;
  /** GGUF file(s) inside the repo (split files listed in order; first part is passed to llama-server). */
  files: string[];
  mmproj?: string;
  sizeGb: number;
  minTotalVramGb: number;
  contextLength: number;
  /** Extra llama-server args, e.g. ["--spec-type","draft-mtp"]. */
  llamaArgs: string[];
  profiles: string[]; // GpuProfile ids it is recommended for
  notes?: string;
  experimental?: boolean;
  verifiedAt?: string; // ISO date the repo/files were last verified to exist
}

export type GpuPhase =
  | 'off'
  | 'searching'      // finding an offer
  | 'renting'        // instance created, waiting for it to boot
  | 'connecting'     // waiting for SSH
  | 'downloading'    // model download on the server
  | 'loading'        // llama-server loading weights
  | 'ready'
  | 'switching'      // changing model while clocked in
  | 'stopping'
  | 'error';

export interface GpuStatus {
  phase: GpuPhase;
  message: string;
  /** 0..1 for downloading/loading when known */
  progress?: number;
  profileId?: string;
  modelId?: string;
  instanceId?: number;
  gpuName?: string;
  numGpus?: number;
  pricePerHour?: number;
  location?: string;
  clockedInAt?: number;
  readyAt?: number;
  /** Local tunnel URL when ready, e.g. http://127.0.0.1:18080 */
  endpoint?: string;
  sessionCost: number;
  monthCost: number;
  monthlyBudget: number;
  creditBalance?: number;
  lastError?: string;
  /** Instances found on the account labelled for this app but not tracked (e.g. after a crash). */
  orphanInstanceIds?: number[];
  /** A stopped ("parked") instance that keeps the model on disk for a fast next clock-in. */
  parked?: { instanceId: number; profileId: string; modelId: string; gpuName: string; storageCostPerHour: number; parkedAt: number };
  /** Ordered checklist for the UI. */
  steps: { id: GpuPhase; label: string; state: 'todo' | 'active' | 'done' | 'error' }[];
  /**
   * How llama-server was started on the instance: 'full' = the catalog configuration; 'safe' / 'safe-minimal' = the
   * fallback after the full configuration failed to load (see droppedFeatures). Absent until the server reports it.
   */
  serverMode?: GpuServerMode;
  /** Features the safe-mode fallback turned off: 'mtp' | 'vision' | 'flash-attn' | 'kv-quant'. */
  droppedFeatures?: string[];
  /** Context length the server actually runs with (safe modes lower it). */
  serverContextLength?: number;
  /** The newest failure log saved this run (<dataDir>/logs/gpu-<instanceId>-<YYYYMMDD-HHMMSS>.log). */
  failureLogPath?: string;
}

export type GpuServerMode = 'full' | 'safe' | 'safe-minimal';

export interface GpuOffer {
  offerId: number;
  gpuName: string;
  numGpus: number;
  gpuRamGb: number;
  cpuRamGb: number;
  diskGb: number;
  inetDownMbps: number;
  reliability: number;
  pricePerHour: number;
  location: string;
  datacenter: boolean;
  verified: boolean;
}

export interface GpuSessionRecord {
  id: string;
  instanceId: number;
  profileId: string;
  modelId: string;
  gpuName: string;
  numGpus: number;
  pricePerHour: number;
  startedAt: number;
  endedAt?: number;
  cost: number;
  endReason?: 'clock_out' | 'idle' | 'app_quit' | 'budget' | 'max_hours' | 'error' | 'orphan_cleanup' | 'server_watchdog';
}

// ───────────────────────────── Scheduler ─────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  /** Cron expression (5 or 6 fields) OR an ISO timestamp for one-shot. */
  schedule: string;
  oneShot: boolean;
  enabled: boolean;
  model: ModelRef | null; // null = default model
  permissionMode: PermissionMode;
  /** If the chosen provider is 'vast' and not clocked in, allow auto clock-in (and clock-out after). */
  allowAutoClockIn: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastRunSessionId?: string;
  lastRunStatus?: 'ok' | 'error' | 'skipped';
  lastRunMessage?: string;
  nextRunAt?: number;
}

// ───────────────────────────── Activity (oversight) ─────────────────────────────

export interface ActivityItem {
  id: string;
  kind: 'session' | 'subagent' | 'shell' | 'schedule_run' | 'gpu';
  title: string;
  sessionId?: string;
  status: 'running' | 'waiting' | 'done' | 'error' | 'stopped';
  startedAt: number;
  endedAt?: number;
  detail?: string;
}

// ───────────────────────────── Settings ─────────────────────────────

export interface CustomEndpoint { id: string; label: string; baseUrl: string; /** secret name in secret store holding the API key, if any */ apiKeySecret?: string; models?: string[] }

export interface HookConfig { matcher?: string; command: string; timeoutMs?: number }

export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface Settings {
  defaultModel: ModelRef | null;
  defaultPermissionMode: PermissionMode;
  defaultCwd: string;
  thinkingByDefault: boolean;
  /** Prefer uncensored catalog models when picking defaults. */
  preferUncensored: boolean;
  local: { enabled: boolean; baseUrl: string; apiKeySecret?: string };
  custom: CustomEndpoint[];
  vast: {
    profiles: GpuProfile[];
    monthlyBudget: number;
    idleMinutes: number;      // server watchdog: destroy after N min without inference
    heartbeatMinutes: number; // server watchdog: destroy after N min without app heartbeat
    maxSessionHours: number;  // hard cap per clock-in
    clockOutOnQuit: boolean;
    /** 'destroy' = delete the instance (no further cost, model re-downloads next time).
     *  'park' = stop the instance and keep its disk (storage is billed, next clock-in on the same machine skips the download
     *  if that GPU is still free; otherwise falls back to a fresh instance). Parked instances are destroyed after parkMaxDays. */
    clockOutMode: 'destroy' | 'park';
    parkMaxDays: number;
    image: string;            // docker image for the server
    localPort: number;        // tunnel port on this PC
    extraLlamaArgs: string[];
  };
  search: { provider: 'duckduckgo' | 'brave' | 'tavily' | 'searxng'; searxngUrl?: string };
  permissions: { allow: string[]; deny: string[] };
  /**
   * Folders whose project settings (.obsidian-code/settings.json, .claude/settings*.json) may add hooks (shell commands)
   * and allow rules. Subfolders inherit trust. Deny rules from project files always apply. Never read from a project file.
   */
  trustedFolders: string[];
  /** "Always allow" rules granted from permission prompts, per project folder (kept here, not inside the repo). */
  projectAllow: Record<string, string[]>;
  hooks: { PreToolUse?: HookConfig[]; PostToolUse?: HookConfig[]; UserPromptSubmit?: HookConfig[]; Stop?: HookConfig[]; SessionStart?: HookConfig[] };
  mcpServers: Record<string, McpServerConfig>;
  /** Read skills/agents/commands/CLAUDE.md from ~/.claude and <project>/.claude too. */
  importClaudeConfig: boolean;
  shell: 'auto' | 'git-bash' | 'powershell' | 'cmd';
  maxToolOutputChars: number;
  autoCompactPercent: number; // compact when prompt tokens exceed this % of context
  notifications: boolean;
  launchAtLogin: boolean;
}
