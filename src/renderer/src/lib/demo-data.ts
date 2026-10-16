// Realistic sample data for DEMO MODE (?demo=1). Owner: ui-foundation.
// Feature areas extend it from their own folders via registerDemoData()/registerDemoHandler() (see lib/demo.ts).
import type { RpcResult } from '@shared/protocol';
import type {
  EngineInfo,
  ActivityItem,
  AgentTypeInfo,
  AutoClockOutWatch,
  CatalogModel,
  GpuOffer,
  GpuProfile,
  GpuSessionRecord,
  GpuStatus,
  Message,
  ModelInfo,
  PermissionRequest,
  PlanRequest,
  ProviderInfo,
  QuestionRequest,
  ScheduledTask,
  Session,
  Settings,
  SkillInfo,
  SlashCommandInfo,
} from '@shared/types';

export type DemoFileEntry = RpcResult<'files.list'>[number];

export interface DemoData {
  system: RpcResult<'system.info'>;
  /** Full sessions (summary + transcript). */
  sessions: Session[];
  providers: ProviderInfo[];
  models: ModelInfo[];
  gpuStatus: GpuStatus;
  catalog: CatalogModel[];
  /** Offers per GPU profile id. */
  offers: Record<string, GpuOffer[]>;
  history: GpuSessionRecord[];
  schedules: ScheduledTask[];
  activity: ActivityItem[];
  settings: Settings;
  commands: SlashCommandInfo[];
  skills: SkillInfo[];
  agents: AgentTypeInfo[];
  /** files.list results keyed by absolute directory path. */
  files: Record<string, DemoFileEntry[]>;
  /** files.read contents keyed by absolute path. */
  fileContents: Record<string, string>;
  pending: { permissions: PermissionRequest[]; questions: QuestionRequest[]; plans: PlanRequest[] };
  serverLog: string;
  /** secrets.has answers. */
  secrets: Record<string, boolean>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEMO_HOME = 'C:\\Users\\dev';
export const DEMO_PROJECT = 'E:\\programming projects\\Dedicated LLM\\obsidian-code';
const HEARTH = 'E:\\programming projects\\hearth';
const BENCH = 'E:\\programming projects\\llama-bench';
const NOTES = 'C:\\Users\\dev\\notes';

const LOCAL_MODEL = { provider: 'local' as const, model: 'Qwen3.6-35B-A3B-Uncensored-Q4_K_M' };
const VAST_MODEL = { provider: 'vast' as const, model: 'qwen38-27b-uncensored-hauhau-q5kp' };

export const DEMO_PROFILES: GpuProfile[] = [
  {
    id: 'light',
    label: 'Light',
    description: '1× RTX 5090 · 32 GB — Qwen3.8 27B, fast and cheap',
    gpuNames: ['RTX 5090'],
    numGpus: 1,
    minGpuRamGb: 30,
    minCpuRamGb: 32,
    minDiskGb: 80,
    minInetDownMbps: 500,
    minReliability: 0.98,
    maxPricePerHour: 1,
    datacenterOnly: false,
    defaultModelId: 'qwen38-27b-uncensored-hauhau-q5kp',
  },
  {
    id: 'standard',
    label: 'Standard',
    description: '1× RTX PRO 6000 · 96 GB — Qwen3.8 Flash-Next 125B-A6B',
    gpuNames: ['RTX PRO 6000 WS', 'RTX PRO 6000 S', 'RTX PRO 6000 Max-Q'],
    numGpus: 1,
    minGpuRamGb: 90,
    minCpuRamGb: 64,
    minDiskGb: 200,
    minInetDownMbps: 1000,
    minReliability: 0.98,
    maxPricePerHour: 2.2,
    datacenterOnly: false,
    defaultModelId: 'qwen38-flash-next-uncensored-huihui-v2-q4kxl',
  },
  {
    id: 'max',
    label: 'Max',
    description: '2× RTX PRO 6000 · 192 GB — GLM-5.3 Flash 320B-A18B',
    gpuNames: ['RTX PRO 6000 WS', 'RTX PRO 6000 S', 'RTX PRO 6000 Max-Q'],
    numGpus: 2,
    minGpuRamGb: 90,
    minCpuRamGb: 128,
    minDiskGb: 250,
    minInetDownMbps: 1000,
    minReliability: 0.97,
    maxPricePerHour: 4,
    datacenterOnly: false,
    defaultModelId: 'glm53-flash-uncensored-huihui-iq4xs',
  },
];

function cat(
  id: string,
  label: string,
  family: string,
  variant: 'uncensored' | 'standard',
  repo: string,
  file: string,
  sizeGb: number,
  minTotalVramGb: number,
  contextLength: number,
  profiles: string[],
  experimental?: boolean,
): CatalogModel {
  return { id, label, family, variant, repo, files: [file], sizeGb, minTotalVramGb, contextLength, llamaArgs: [], profiles, experimental, verifiedAt: '2026-10-12' };
}

export const DEMO_CATALOG: CatalogModel[] = [
  cat('qwen38-27b-uncensored-hauhau-q5kp', 'Qwen3.8 27B Uncensored · HauhauCS Q5_K_P', 'qwen3.8-27b', 'uncensored', 'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-Q5_K_P.gguf', 21.15, 32, 131072, ['light']),
  cat('qwen38-27b-standard-unsloth-q5kxl', 'Qwen3.8 27B · Unsloth UD-Q5_K_XL', 'qwen3.8-27b', 'standard', 'unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q5_K_XL.gguf', 21.81, 32, 131072, ['light']),
  cat('qwen38-27b-uncensored-hauhau-q8kp', 'Qwen3.8 27B Uncensored · HauhauCS Q8_K_P', 'qwen3.8-27b', 'uncensored', 'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-Q8_K_P.gguf', 32.39, 48, 262144, ['standard']),
  cat('qwen38-27b-standard-unsloth-q8', 'Qwen3.8 27B · Unsloth Q8_0', 'qwen3.8-27b', 'standard', 'unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-Q8_0.gguf', 29.98, 48, 262144, ['standard']),
  cat('qwen38-flash-next-uncensored-huihui-v2-q4kxl', 'Qwen3.8 Flash-Next 125B-A6B Uncensored · huihui v2', 'qwen3.8-flash-next', 'uncensored', 'huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF', 'Q4_K_XL/Huihui-Qwen3.8-Flash-Next-00001-of-00003.gguf', 111.33, 96, 131072, ['standard'], true),
  cat('qwen38-flash-next-standard-ggml-iq4nl', 'Qwen3.8 Flash-Next 125B-A6B · ggml-org IQ4_NL', 'qwen3.8-flash-next', 'standard', 'ggml-org/Qwen3.8-Flash-Next-GGUF', 'Qwen3.8-Flash-Next-IQ4_NL-00001-of-00003.gguf', 106.19, 96, 131072, ['standard'], true),
  cat('glm53-flash-uncensored-huihui-iq4xs', 'GLM-5.3 Flash 320B-A18B Uncensored · huihui', 'glm-5.3-flash', 'uncensored', 'huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF', 'UD-IQ4_XS/GLM-5.3-Flash-00001-of-00004.gguf', 157.99, 192, 131072, ['max'], true),
  cat('glm53-flash-standard-unsloth-iq4xs', 'GLM-5.3 Flash 320B-A18B · Unsloth UD-IQ4_XS', 'glm-5.3-flash', 'standard', 'unsloth/GLM-5.3-Flash-GGUF', 'UD-IQ4_XS/GLM-5.3-Flash-00001-of-00004.gguf', 157.99, 192, 131072, ['max'], true),
];

/** The global watch Settings → Vast.ai (default "unresponsive") arms at clock-in. */
export function demoDefaultWatch(armedAt: number): AutoClockOutWatch {
  return { mode: 'unresponsive', armedAt, source: 'default', stallMinutes: 10, finishGraceMinutes: 2 };
}

export const DEMO_SETTINGS: Settings = {
  defaultModel: LOCAL_MODEL,
  defaultPermissionMode: 'default',
  defaultCwd: DEMO_PROJECT,
  thinkingByDefault: true,
  preferUncensored: true,
  local: { enabled: true, baseUrl: 'http://127.0.0.1:8080' },
  custom: [{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeySecret: 'custom.openrouter.apiKey', models: ['qwen/qwen3.8-235b-a22b'] }],
  vast: {
    profiles: DEMO_PROFILES,
    monthlyBudget: 150,
    idleMinutes: 30,
    heartbeatMinutes: 5,
    maxSessionHours: 6,
    clockOutOnQuit: true,
    clockOutMode: 'destroy',
    parkMaxDays: 3,
    image: 'ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561',
    localPort: 18080,
    extraLlamaArgs: [],
    autoClockOut: { default: 'unresponsive', stallMinutes: 10, finishGraceMinutes: 2 },
  },
  search: { provider: 'duckduckgo' },
  permissions: { allow: ['Bash(npm test:*)', 'Bash(git status:*)', 'WebFetch(domain:docs.vast.ai)'], deny: ['Bash(rm -rf:*)'] },
  trustedFolders: [],
  projectAllow: {},
  hooks: {},
  mcpServers: {},
  importClaudeConfig: true,
  shell: 'auto',
  maxToolOutputChars: 30000,
  autoCompactPercent: 80,
  notifications: true,
  launchAtLogin: false,
  ui: { sidebar: { groupOrder: [], groupNames: {}, categories: [], collapsed: [] } },
  engine: {
    default: 'builtin',
    claudeCode: { executable: 'auto', systemPrompt: 'lean', importUserClaudeConfig: true, extraEnv: {} },
  },
};

/** engines.list in demo mode. */
export const DEMO_ENGINES: EngineInfo[] = [
  { id: 'builtin', label: 'Obsidian', available: true, detail: "The app's own agent loop (compact prompt and tools for local models)." },
  { id: 'claude-code', label: 'Claude Code', available: true, detail: 'Claude Code 2.1.296 — bundled with Agent SDK 0.3.296' },
];

function steps(phase: GpuStatus['phase']): GpuStatus['steps'] {
  const order: { id: GpuStatus['phase']; label: string }[] = [
    { id: 'searching', label: 'Find a GPU offer' },
    { id: 'renting', label: 'Rent instance' },
    { id: 'connecting', label: 'Connect over SSH' },
    { id: 'downloading', label: 'Download model' },
    { id: 'loading', label: 'Load weights' },
    { id: 'ready', label: 'Ready' },
  ];
  const idx = order.findIndex((s) => s.id === phase);
  return order.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: phase === 'off' ? 'todo' : phase === 'ready' ? 'done' : i < idx ? 'done' : i === idx ? 'active' : 'todo',
  }));
}

export { steps as demoGpuSteps };

// ───────────────────────────── Transcript sample ─────────────────────────────

function glmTranscript(t0: number): Message[] {
  const parserBefore = `export function parseTextToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    const body = m[1].trim();
    if (body.startsWith('{')) calls.push(parseHermes(body));
    else if (body.startsWith('<function=')) calls.push(parseQwenXml(body));
  }
  return calls;
}`;
  const parserAfter = `export function parseTextToolCalls(text: string, schemas: ToolSchemas): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    const body = m[1].trim();
    if (body.startsWith('{')) calls.push(parseHermes(body));
    else if (body.startsWith('<function=')) calls.push(parseQwenXml(body, schemas));
    else if (body.includes('<arg_key>')) calls.push(parseGlmArgs(body, schemas));
  }
  return calls;
}`;
  return [
    {
      id: 'm-glm-1',
      role: 'user',
      createdAt: t0,
      blocks: [
        {
          type: 'text',
          text: 'GLM-5.3 emits tool calls as `<arg_key>`/`<arg_value>` pairs and our fallback parser drops them. Can you fix `parseTextToolCalls` and add a test?',
        },
      ],
    },
    {
      id: 'm-glm-2',
      role: 'assistant',
      createdAt: t0 + 4_000,
      meta: { model: VAST_MODEL.model, durationMs: 48_200, promptTokens: 18_412, completionTokens: 1_906 },
      blocks: [
        {
          type: 'thinking',
          durationMs: 6_400,
          text: 'The parser only knows the Hermes JSON and Qwen XML shapes. GLM wraps each argument as <arg_key>name</arg_key><arg_value>value</arg_value> after the function name on the first line. I should read the parser, add a third branch, coerce values using the tool schema, and cover it with a test.',
        },
        { type: 'text', text: "I'll read the current parser first." },
        {
          type: 'tool_use',
          id: 'tu-glm-read',
          name: 'Read',
          input: { file_path: `${DEMO_PROJECT}\\src\\core\\llm\\toolcalls.ts` },
          status: 'done',
          startedAt: t0 + 12_000,
          endedAt: t0 + 12_090,
          result: {
            content: parserBefore,
            display: { kind: 'file', path: `${DEMO_PROJECT}\\src\\core\\llm\\toolcalls.ts`, content: parserBefore, startLine: 41, totalLines: 186 },
          },
        },
        {
          type: 'tool_use',
          id: 'tu-glm-edit',
          name: 'Edit',
          input: { file_path: `${DEMO_PROJECT}\\src\\core\\llm\\toolcalls.ts`, old_string: '…', new_string: '…' },
          status: 'done',
          startedAt: t0 + 24_000,
          endedAt: t0 + 24_140,
          result: {
            content: 'Edited src/core/llm/toolcalls.ts',
            display: { kind: 'diff', path: `${DEMO_PROJECT}\\src\\core\\llm\\toolcalls.ts`, before: parserBefore, after: parserAfter },
          },
        },
        {
          type: 'tool_use',
          id: 'tu-glm-bash',
          name: 'Bash',
          input: { command: 'npx vitest run tests/unit/agent-core/toolcalls.test.ts', description: 'Run the parser tests' },
          status: 'done',
          startedAt: t0 + 30_000,
          endedAt: t0 + 33_800,
          result: {
            content: 'exit 0',
            display: {
              kind: 'bash',
              command: 'npx vitest run tests/unit/agent-core/toolcalls.test.ts',
              exitCode: 0,
              output:
                ' RUN  v5.0.4 E:/programming projects/Dedicated LLM/obsidian-code\n\n ✓ tests/unit/agent-core/toolcalls.test.ts (9 tests) 14ms\n   ✓ parses Hermes JSON calls\n   ✓ parses Qwen XML calls\n   ✓ parses GLM arg_key/arg_value calls\n   ✓ coerces numbers and booleans by schema\n   ✓ rejects invalid JSON arguments\n\n Test Files  1 passed (1)\n      Tests  9 passed (9)\n   Duration  412ms',
            },
          },
        },
        {
          type: 'text',
          text: [
            'Fixed. The fallback parser now understands all three text formats:',
            '',
            '| Format | Example | Handled by |',
            '|---|---|---|',
            '| Hermes JSON | `{"name": …, "arguments": …}` | `parseHermes` |',
            '| Qwen XML | `<function=Read><parameter=file_path>…` | `parseQwenXml` |',
            '| GLM pairs | `<arg_key>path</arg_key><arg_value>…` | `parseGlmArgs` (new) |',
            '',
            'Values are coerced with the tool schema, so `limit` arrives as a number and `replace_all` as a boolean:',
            '',
            '```ts',
            'function coerce(value: string, schema?: JsonSchema): unknown {',
            "  if (schema?.type === 'number' || schema?.type === 'integer') return Number(value);",
            "  if (schema?.type === 'boolean') return value === 'true';",
            "  if (schema?.type === 'object' || schema?.type === 'array') return JSON.parse(value);",
            '  return value;',
            '}',
            '```',
            '',
            'All **9 tests** pass. One thing to watch: GLM sometimes closes the block with `</tool_call>` *inside* a string value — the parser now only matches the outermost closing tag.',
          ].join('\n'),
        },
      ],
    },
  ];
}

function makeSession(p: Partial<Session> & Pick<Session, 'id' | 'title' | 'cwd' | 'createdAt' | 'updatedAt'>): Session {
  return {
    kind: 'chat',
    status: 'idle',
    model: LOCAL_MODEL,
    permissionMode: 'default',
    thinking: true,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    messages: [],
    todos: [],
    changedFiles: [],
    ...p,
  };
}

function simpleExchange(id: string, t: number, question: string, answer: string): Message[] {
  return [
    { id: `${id}-u`, role: 'user', createdAt: t, blocks: [{ type: 'text', text: question }] },
    {
      id: `${id}-a`,
      role: 'assistant',
      createdAt: t + 3_000,
      meta: { model: LOCAL_MODEL.model, durationMs: 21_000, promptTokens: 6_120, completionTokens: 412 },
      blocks: [
        { type: 'thinking', text: 'Let me think about the most direct way to answer this.', durationMs: 3_100 },
        { type: 'text', text: answer },
      ],
    },
  ];
}

export function createDemoData(now: number = Date.now()): DemoData {
  const sessions: Session[] = [
    makeSession({
      id: 's-glm',
      title: 'Fix GLM tool-call parsing',
      cwd: DEMO_PROJECT,
      createdAt: now - 2 * HOUR,
      updatedAt: now - 14 * MIN,
      model: VAST_MODEL,
      pinned: true,
      usage: { inputTokens: 64_210, outputTokens: 5_380, lastPromptTokens: 18_412, requests: 7 },
      messages: glmTranscript(now - 2 * HOUR),
      todos: [
        { id: 't1', content: 'Read the current fallback parser', status: 'completed' },
        { id: 't2', content: 'Add GLM arg_key/arg_value branch with schema coercion', status: 'completed' },
        { id: 't3', content: 'Cover the new format with unit tests', status: 'completed' },
      ],
      changedFiles: [
        { path: `${DEMO_PROJECT}\\src\\core\\llm\\toolcalls.ts`, additions: 38, deletions: 4, isNew: false, lastToolUseId: 'tu-glm-edit' },
        { path: `${DEMO_PROJECT}\\tests\\unit\\agent-core\\toolcalls.test.ts`, additions: 61, deletions: 0, isNew: true, lastToolUseId: 'tu-glm-edit' },
      ],
    }),
    makeSession({
      id: 's-sse',
      title: 'Add WebSocket reconnect backoff',
      cwd: DEMO_PROJECT,
      engine: 'claude-code',
      createdAt: now - 40 * MIN,
      updatedAt: now - 20_000,
      status: 'running',
      usage: { inputTokens: 22_018, outputTokens: 1_204, lastPromptTokens: 11_930, requests: 3 },
      messages: simpleExchange('m-sse', now - 40 * MIN, 'Add exponential backoff with jitter to the renderer WebSocket client and refetch state after reconnect.', "On it — I'll start with `lib/rpc.ts` and then wire a refetch into the store."),
    }),
    makeSession({
      id: 's-perm',
      title: 'Clean up stale build artifacts',
      cwd: DEMO_PROJECT,
      createdAt: now - 25 * MIN,
      updatedAt: now - 2 * MIN,
      status: 'waiting',
      usage: { inputTokens: 8_400, outputTokens: 512, lastPromptTokens: 8_400, requests: 2 },
      messages: simpleExchange('m-perm', now - 25 * MIN, 'Delete the old out/ and release/ folders and rebuild.', 'I need to run a shell command to remove them — waiting for your permission.'),
    }),
    makeSession({
      id: 's-hearth',
      title: 'Hearth: stream TTS in chunks',
      cwd: HEARTH,
      createdAt: now - 5 * HOUR,
      updatedAt: now - 3 * HOUR,
      usage: { inputTokens: 41_000, outputTokens: 3_900, lastPromptTokens: 14_200, requests: 6 },
      messages: simpleExchange('m-hearth', now - 5 * HOUR, 'Make the TTS pipeline stream audio sentence by sentence.', 'Done — sentences are now flushed to the audio queue as soon as the splitter emits them.'),
    }),
    makeSession({
      id: 's-hearth-2',
      title: 'Profile memory usage on long chats',
      cwd: HEARTH,
      createdAt: now - 2 * DAY,
      updatedAt: now - 30 * HOUR,
      messages: simpleExchange('m-hearth2', now - 2 * DAY, 'Why does memory grow over long chats?', 'The message cache never evicts rendered markdown; I added an LRU with 200 entries.'),
    }),
    makeSession({
      id: 's-bench',
      title: 'Benchmark Qwen3.8 27B on RTX 5090',
      cwd: BENCH,
      createdAt: now - 26 * HOUR,
      updatedAt: now - 22 * HOUR,
      model: VAST_MODEL,
      messages: simpleExchange('m-bench', now - 26 * HOUR, 'Run llama-bench for pp512/tg128 and summarize.', '**pp512: 4,812 t/s**, **tg128: 61.4 t/s** with q8_0 KV cache and flash attention on.'),
    }),
    makeSession({
      id: 's-audit',
      title: 'Nightly dependency audit',
      cwd: DEMO_PROJECT,
      kind: 'scheduled',
      scheduleId: 'sch-audit',
      createdAt: now - 9 * HOUR,
      updatedAt: now - 8.6 * HOUR,
      permissionMode: 'acceptEdits',
      messages: simpleExchange('m-audit', now - 9 * HOUR, 'Run npm audit and summarize anything high or critical.', 'No high or critical advisories. 2 moderate ones in dev dependencies (no runtime exposure).'),
    }),
    makeSession({
      id: 's-notes',
      title: 'Summarize research notes',
      cwd: NOTES,
      createdAt: now - 4 * DAY,
      updatedAt: now - 4 * DAY + 20 * MIN,
      messages: simpleExchange('m-notes', now - 4 * DAY, 'Summarize the vast-api notes into a checklist.', '1. Search offers\n2. Create from offer\n3. Poll until running\n4. Destroy and verify'),
    }),
    makeSession({
      id: 's-sse-explore',
      title: 'Explore: find reconnect call sites',
      cwd: DEMO_PROJECT,
      kind: 'subagent',
      parentSessionId: 's-sse',
      parentToolUseId: 'tu-sse-task',
      createdAt: now - 3 * MIN,
      updatedAt: now - 10_000,
      status: 'running',
      permissionMode: 'default',
    }),
  ];

  const gpuStatus: GpuStatus = {
    phase: 'ready',
    message: 'Ready — Qwen3.8 27B Uncensored on RTX 5090',
    profileId: 'light',
    modelId: 'qwen38-27b-uncensored-hauhau-q5kp',
    instanceId: 26_418_220,
    gpuName: 'RTX 5090',
    numGpus: 1,
    pricePerHour: 0.524,
    location: 'Quebec, CA',
    clockedInAt: now - 47 * MIN,
    readyAt: now - 41 * MIN,
    endpoint: 'http://127.0.0.1:18080',
    sessionCost: 0.41,
    monthCost: 37.42,
    monthlyBudget: 150,
    creditBalance: 84.17,
    steps: steps('ready'),
    // The default watch Settings → Vast.ai arms at every clock-in.
    autoClockOut: demoDefaultWatch(now - 47 * MIN),
    autoClockOutWatches: [demoDefaultWatch(now - 47 * MIN)],
  };

  const offers: Record<string, GpuOffer[]> = {
    light: [
      { offerId: 54_138_583, gpuName: 'RTX 5090', numGpus: 1, gpuRamGb: 31.8, cpuRamGb: 64, diskGb: 120, inetDownMbps: 2_480, reliability: 0.995, pricePerHour: 0.524, location: 'Quebec, CA', datacenter: true, verified: true },
      { offerId: 53_483_881, gpuName: 'RTX 5090', numGpus: 1, gpuRamGb: 31.8, cpuRamGb: 96, diskGb: 200, inetDownMbps: 1_210, reliability: 0.991, pricePerHour: 0.587, location: 'Oregon, US', datacenter: false, verified: true },
      { offerId: 54_002_117, gpuName: 'RTX 5090', numGpus: 1, gpuRamGb: 31.8, cpuRamGb: 64, diskGb: 100, inetDownMbps: 860, reliability: 0.984, pricePerHour: 0.612, location: 'Bavaria, DE', datacenter: false, verified: true },
    ],
    standard: [
      { offerId: 54_377_120, gpuName: 'RTX PRO 6000 WS', numGpus: 1, gpuRamGb: 95.6, cpuRamGb: 128, diskGb: 250, inetDownMbps: 3_100, reliability: 0.993, pricePerHour: 1.19, location: 'Texas, US', datacenter: true, verified: true },
      { offerId: 54_120_334, gpuName: 'RTX PRO 6000 Max-Q', numGpus: 1, gpuRamGb: 95.6, cpuRamGb: 96, diskGb: 220, inetDownMbps: 1_700, reliability: 0.988, pricePerHour: 1.36, location: 'Ontario, CA', datacenter: false, verified: true },
    ],
    max: [
      { offerId: 54_377_895, gpuName: 'RTX PRO 6000 WS', numGpus: 2, gpuRamGb: 95.6, cpuRamGb: 256, diskGb: 400, inetDownMbps: 4_200, reliability: 0.981, pricePerHour: 2.644, location: 'British Columbia, CA', datacenter: true, verified: true },
    ],
  };

  const history: GpuSessionRecord[] = [
    { id: 'g6', instanceId: 26_301_115, profileId: 'light', modelId: 'qwen38-27b-uncensored-hauhau-q5kp', gpuName: 'RTX 5090', numGpus: 1, pricePerHour: 0.531, startedAt: now - 22 * HOUR - 2.4 * HOUR, endedAt: now - 22 * HOUR, cost: 1.27, endReason: 'clock_out' },
    { id: 'g5', instanceId: 26_244_870, profileId: 'standard', modelId: 'qwen38-27b-uncensored-hauhau-q8kp', gpuName: 'RTX PRO 6000 WS', numGpus: 1, pricePerHour: 1.21, startedAt: now - 2 * DAY - 3 * HOUR, endedAt: now - 2 * DAY, cost: 3.63, endReason: 'idle' },
    { id: 'g4', instanceId: 26_190_002, profileId: 'light', modelId: 'qwen38-27b-standard-unsloth-q5kxl', gpuName: 'RTX 5090', numGpus: 1, pricePerHour: 0.552, startedAt: now - 3 * DAY - 1.6 * HOUR, endedAt: now - 3 * DAY, cost: 0.88, endReason: 'clock_out' },
    { id: 'g3', instanceId: 26_100_477, profileId: 'max', modelId: 'glm53-flash-uncensored-huihui-iq4xs', gpuName: 'RTX PRO 6000 WS', numGpus: 2, pricePerHour: 2.71, startedAt: now - 5 * DAY - 2.1 * HOUR, endedAt: now - 5 * DAY, cost: 5.69, endReason: 'app_quit' },
    { id: 'g2', instanceId: 26_022_310, profileId: 'light', modelId: 'qwen38-27b-uncensored-hauhau-q5kp', gpuName: 'RTX 5090', numGpus: 1, pricePerHour: 0.519, startedAt: now - 6 * DAY - 2.9 * HOUR, endedAt: now - 6 * DAY, cost: 1.5, endReason: 'clock_out' },
  ];

  const schedules: ScheduledTask[] = [
    { id: 'sch-audit', name: 'Nightly dependency audit', prompt: 'Run npm audit and summarize anything high or critical.', cwd: DEMO_PROJECT, schedule: '0 2 * * *', oneShot: false, enabled: true, model: null, permissionMode: 'acceptEdits', allowAutoClockIn: false, createdAt: now - 12 * DAY, lastRunAt: now - 9 * HOUR, lastRunSessionId: 's-audit', lastRunStatus: 'ok', nextRunAt: now + 15 * HOUR },
    { id: 'sch-standup', name: 'Weekday standup summary', prompt: 'Summarize yesterday’s git commits across my projects as standup notes.', cwd: 'E:\\programming projects', schedule: '30 8 * * 1-5', oneShot: false, enabled: true, model: LOCAL_MODEL, permissionMode: 'default', allowAutoClockIn: false, createdAt: now - 20 * DAY, lastRunAt: now - 26 * HOUR, lastRunStatus: 'ok', nextRunAt: now + 21 * HOUR },
    { id: 'sch-bench', name: 'Weekly benchmark on Vast', prompt: 'Clock in on the light profile, run llama-bench, record results, clock out.', cwd: BENCH, schedule: '0 10 * * 6', oneShot: false, enabled: false, model: VAST_MODEL, permissionMode: 'bypassPermissions', allowAutoClockIn: true, createdAt: now - 9 * DAY, lastRunAt: now - 6 * DAY, lastRunStatus: 'error', lastRunMessage: 'Budget guard: monthly budget would be exceeded', nextRunAt: undefined },
  ];

  const activity: ActivityItem[] = [
    { id: 'a-sse', kind: 'session', title: 'Add WebSocket reconnect backoff', sessionId: 's-sse', status: 'running', startedAt: now - 90_000, detail: 'Editing src/renderer/src/lib/rpc.ts' },
    { id: 'a-sse-explore', kind: 'subagent', title: 'Explore: find reconnect call sites', sessionId: 's-sse-explore', status: 'running', startedAt: now - 3 * MIN, detail: 'Grep "onclose" · 12 matches' },
    { id: 'a-perm', kind: 'session', title: 'Clean up stale build artifacts', sessionId: 's-perm', status: 'waiting', startedAt: now - 2 * MIN, detail: 'Waiting for permission: Bash' },
    { id: 'a-shell', kind: 'shell', title: 'npm run dev:web', sessionId: 's-sse', status: 'running', startedAt: now - 38 * MIN, detail: 'VITE ready in 412 ms · http://localhost:5173' },
    { id: 'a-gpu', kind: 'gpu', title: 'RTX 5090 · Qwen3.8 27B Uncensored', status: 'running', startedAt: now - 47 * MIN, detail: '$0.52/h · Quebec, CA' },
    { id: 'a-audit', kind: 'schedule_run', title: 'Nightly dependency audit', sessionId: 's-audit', status: 'done', startedAt: now - 9 * HOUR, endedAt: now - 8.6 * HOUR, detail: 'No high or critical advisories' },
  ];

  const commands: SlashCommandInfo[] = [
    { name: 'clear', description: 'Start a new conversation in this session', source: 'builtin' },
    { name: 'compact', description: 'Summarize older history to free context', source: 'builtin', argumentHint: '[instructions]' },
    { name: 'model', description: 'Switch the model for this session', source: 'builtin', argumentHint: '<model id>' },
    { name: 'plan', description: 'Toggle plan mode', source: 'builtin' },
    { name: 'init', description: 'Generate an OBSIDIAN.md for this project', source: 'builtin' },
    { name: 'help', description: 'Show help', source: 'builtin' },
    { name: 'cost', description: 'Show token usage for this session', source: 'builtin' },
    { name: 'todos', description: 'Show the todo list', source: 'builtin' },
    { name: 'agents', description: 'List available subagent types', source: 'builtin' },
    { name: 'skills', description: 'List available skills', source: 'builtin' },
    { name: 'memory', description: 'Show loaded memory files', source: 'builtin' },
    { name: 'thinking', description: 'Turn thinking on or off', source: 'builtin', argumentHint: 'on|off' },
    { name: 'rewind', description: 'Rewind the conversation to an earlier message', source: 'builtin' },
    { name: 'review', description: 'Review the current git diff for bugs', source: 'project', argumentHint: '[path]' },
    { name: 'release-notes', description: 'Draft release notes from commits since the last tag', source: 'user' },
  ];

  const files: Record<string, DemoFileEntry[]> = {
    [DEMO_PROJECT]: [
      { name: 'docs', path: `${DEMO_PROJECT}\\docs`, isDir: true },
      { name: 'src', path: `${DEMO_PROJECT}\\src`, isDir: true },
      { name: 'tests', path: `${DEMO_PROJECT}\\tests`, isDir: true },
      { name: 'package.json', path: `${DEMO_PROJECT}\\package.json`, isDir: false, size: 2631 },
      { name: 'SPEC.md', path: `${DEMO_PROJECT}\\SPEC.md`, isDir: false, size: 29858 },
      { name: 'tsconfig.json', path: `${DEMO_PROJECT}\\tsconfig.json`, isDir: false, size: 119 },
    ],
    [`${DEMO_PROJECT}\\src`]: [
      { name: 'core', path: `${DEMO_PROJECT}\\src\\core`, isDir: true },
      { name: 'main', path: `${DEMO_PROJECT}\\src\\main`, isDir: true },
      { name: 'renderer', path: `${DEMO_PROJECT}\\src\\renderer`, isDir: true },
      { name: 'shared', path: `${DEMO_PROJECT}\\src\\shared`, isDir: true },
    ],
  };

  return {
    system: { version: '0.1.0', platform: 'win32', homeDir: DEMO_HOME, dataDir: `${DEMO_HOME}\\AppData\\Roaming\\obsidian-code`, shell: 'C:\\Program Files\\Git\\bin\\bash.exe', electron: false },
    sessions,
    providers: [
      { id: 'local', label: 'Local · llama-server', status: 'online', baseUrl: 'http://127.0.0.1:8080', detail: '4 slots · ~20 tok/s' },
      { id: 'vast', label: 'Vast GPU', status: 'online', baseUrl: 'http://127.0.0.1:18080', detail: 'RTX 5090 · Quebec, CA' },
      { id: 'custom:openrouter', label: 'OpenRouter', status: 'offline', baseUrl: 'https://openrouter.ai/api/v1', detail: 'API key missing' },
    ],
    models: [
      { ref: LOCAL_MODEL, label: 'Qwen3.6 35B-A3B Uncensored', contextLength: 65_536, supportsVision: true, supportsTools: true, supportsThinking: true, variant: 'uncensored', status: 'online' },
      { ref: VAST_MODEL, label: 'Qwen3.8 27B Uncensored', contextLength: 131_072, supportsVision: false, supportsTools: true, supportsThinking: true, variant: 'uncensored', status: 'online' },
      { ref: { provider: 'custom:openrouter', model: 'qwen/qwen3.8-235b-a22b' }, label: 'Qwen3.8 235B-A22B', contextLength: 262_144, supportsVision: false, supportsTools: true, supportsThinking: true, variant: 'standard', status: 'offline' },
    ],
    gpuStatus,
    catalog: DEMO_CATALOG,
    offers,
    history,
    schedules,
    activity,
    settings: DEMO_SETTINGS,
    commands,
    skills: [
      { name: 'release-checklist', description: 'Steps to cut a release build and verify the installer', path: `${DEMO_PROJECT}\\.obsidian-code\\skills\\release-checklist\\SKILL.md`, source: 'project' },
      { name: 'pdf', description: 'Read, split and merge PDF files', path: `${DEMO_HOME}\\.claude\\skills\\pdf\\SKILL.md`, source: 'claude-user' },
    ],
    agents: [
      { name: 'general-purpose', description: 'Multi-step tasks with the full tool set', source: 'builtin' },
      { name: 'Explore', description: 'Fast read-only codebase exploration', source: 'builtin', tools: ['Read', 'Glob', 'Grep', 'LS'] },
      { name: 'Plan', description: 'Read-only research that returns an implementation plan', source: 'builtin', tools: ['Read', 'Glob', 'Grep', 'LS', 'WebFetch'] },
      { name: 'reviewer', description: 'Reviews diffs for correctness and style', source: 'project', tools: ['Read', 'Grep', 'Bash'] },
    ],
    files,
    fileContents: {
      [`${DEMO_PROJECT}\\package.json`]: '{\n  "name": "obsidian-code",\n  "version": "0.1.0",\n  "private": true\n}\n',
    },
    pending: {
      permissions: [
        {
          requestId: 'perm-demo-1',
          sessionId: 's-perm',
          toolUseId: 'tu-perm-bash',
          toolName: 'Bash',
          input: { command: 'rm -rf out release && npm run build', description: 'Remove stale build output and rebuild' },
          title: 'Run: rm -rf out release && npm run build',
          suggestedRule: 'Bash(npm run build:*)',
          createdAt: now - 2 * MIN,
        },
      ],
      questions: [],
      plans: [],
    },
    serverLog: [
      'main: loading model from /root/models/Qwen3.8-27B-Uncensored-Q5_K_P.gguf',
      'llama_model_loader: loaded meta data with 41 key-value pairs and 851 tensors',
      'load_tensors: offloaded 65/65 layers to GPU',
      'llama_context: n_ctx = 131072, flash_attn = 1, type_k = q8_0, type_v = q8_0',
      'srv  init: initializing slots, n_slots = 2',
      'main: server is listening on http://127.0.0.1:8080 - starting the main loop',
      `srv  update_slots: all slots are idle (3 requests served)`,
    ].join('\n'),
    secrets: { 'vast.apiKey': true, 'local.apiKey': false, 'search.braveKey': false, 'search.tavilyKey': false },
  };
}
