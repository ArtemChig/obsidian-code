// Test harness for the agent loop: an in-memory CoreContext wired to the real LLM client + model registry
// pointed at the mock-llm server, with fake tools.

import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ActivityRegistry, CoreContext, EventBus, ExtensionsApi, SessionStore, SettingsStore, ToolContext, ToolDef,
} from '@core/contracts';
import type { CoreEventName, CoreEvents } from '@shared/protocol';
import type { ActivityItem, Session, SessionSummary, Settings } from '@shared/types';
import { createLlmClient } from '@core/llm/client';
import { createModelRegistry, type ModelRegistryImpl } from '@core/llm/registry';
import { resetEndpointStates } from '@core/llm/dialect';
import { AgentManagerImpl } from '@core/agent/manager';
import { lastUserText, startMockLlm, type MockLlm } from '../../fixtures/mock-llm/server';

export interface Harness {
  ctx: CoreContext;
  agent: AgentManagerImpl;
  mock: MockLlm;
  dir: string;
  cwd: string;
  events: { event: CoreEventName; data: unknown }[];
  projectAllow: string[];
  hooks: { fn?: ExtensionsApi['runHooks'] };
  activity: Map<string, ActivityItem>;
  settings: Settings;
  registry: ModelRegistryImpl;
  createSession(init?: Partial<SessionSummary>): Session;
  session(id: string): Session;
  eventsOf<E extends CoreEventName>(name: E): CoreEvents[E][];
  waitIdle(id: string, timeoutMs?: number): Promise<void>;
  until(cond: () => boolean, timeoutMs?: number, what?: string): Promise<void>;
  close(): Promise<void>;
}

export function defaultSettings(): Settings {
  return {
    setupDone: true, defaultModel: null, defaultPermissionMode: 'default', defaultCwd: '', thinkingByDefault: true, preferUncensored: true,
    local: { enabled: true, baseUrl: 'http://127.0.0.1:9' }, custom: [],
    vast: {
      profiles: [], monthlyBudget: 100, idleMinutes: 15, heartbeatMinutes: 10, maxSessionHours: 4, clockOutOnQuit: true,
      clockOutMode: 'destroy', parkMaxDays: 3, image: '', localPort: 18080, extraLlamaArgs: [], userModels: [], favoriteRepos: [],
      autoClockOut: { default: 'off', stallMinutes: 10, finishGraceMinutes: 2 },
    },
    search: { provider: 'duckduckgo' }, permissions: { allow: [], deny: [] }, trustedFolders: [], projectAllow: {}, hooks: {}, mcpServers: {}, importClaudeConfig: false,
    shell: 'auto', maxToolOutputChars: 30000, autoCompactPercent: 80, notifications: false, launchAtLogin: false,
    ui: { sidebar: { groupOrder: [], groupNames: {}, categories: [], collapsed: [] } },
    engine: { default: 'builtin', claudeCode: { executable: 'auto', systemPrompt: 'lean', importUserClaudeConfig: false, extraEnv: {} } },
  };
}

export async function until(cond: () => boolean, timeoutMs = 8000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface HarnessOptions {
  tools?: ToolDef[];
  nCtx?: number;
  vision?: boolean;
  ext?: Partial<ExtensionsApi>;
  settings?: Partial<Settings>;
  /** Point the 'local' provider at a real server instead of the mock (live tests). */
  localBaseUrl?: string;
  /** LLM idle timeout override. */
  idleTimeoutMs?: number;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  resetEndpointStates();
  const dir = mkdtempSync(join(tmpdir(), 'oc-agent-'));
  const cwd = join(dir, 'project');
  await fs.mkdir(cwd, { recursive: true });
  const mock = await startMockLlm({ modelId: 'mock-qwen3-uncensored', nCtx: opts.nCtx ?? 32768, vision: opts.vision ?? true });
  // title requests are answered by a persistent route so scripted turns stay in order
  mock.route((req) => lastUserText(req).startsWith('Write a short title'), { text: 'Mock Title' });

  const events: { event: CoreEventName; data: unknown }[] = [];
  const bus: EventBus = {
    emit: (event, data) => { events.push({ event, data }); },
    on: () => () => {},
  };

  const sessions = new Map<string, Session>();
  let counter = 0;
  const sessionStore: SessionStore = {
    list: () => [...sessions.values()].map(({ messages: _m, todos: _t, changedFiles: _c, ...rest }) => rest),
    get: (id) => sessions.get(id),
    create: (init) => {
      const now = Date.now();
      const s: Session = {
        title: 'New session', kind: 'chat', status: 'idle', model: null, permissionMode: 'default', thinking: true,
        ...init, id: init.id ?? `s${++counter}`, createdAt: now, updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
        messages: [], todos: [], changedFiles: [],
      } as Session;
      sessions.set(s.id, s);
      return s;
    },
    save: (s) => { sessions.set(s.id, s); },
    delete: (id) => { sessions.delete(id); },
    search: () => [],
    flush: async () => {},
  };

  const settings: Settings = { ...defaultSettings(), ...opts.settings, local: { enabled: true, baseUrl: opts.localBaseUrl ?? mock.url } };
  const projectAllow: string[] = [];
  const settingsStore: SettingsStore = {
    get: () => settings,
    update: (p) => Object.assign(settings, p),
    forProject: () => ({ permissions: { allow: [...projectAllow], deny: [] }, hooks: {} }),
    addProjectAllowRule: (_cwd, rule) => { if (!projectAllow.includes(rule)) projectAllow.push(rule); },
    onChange: () => () => {},
  };

  const activity = new Map<string, ActivityItem>();
  const stops = new Map<string, () => void>();
  const activityRegistry: ActivityRegistry = {
    upsert: (item) => { activity.set(item.id, item); },
    list: () => [...activity.values()],
    onStop: (id, fn) => { stops.set(id, fn); },
    stop: (id) => { stops.get(id)?.(); },
  };

  const hooks: { fn?: ExtensionsApi['runHooks'] } = {};
  const ext: ExtensionsApi = {
    memoryText: async () => '',
    skills: async () => [],
    loadSkill: async () => null,
    agentTypes: async () => [],
    agentDefinition: async () => null,
    slashCommands: async () => [{ name: 'greet', description: 'Say hello', source: 'project' }],
    expandCommand: async (_cwd, name, args) => (name === 'greet' ? `Say hello to ${args || 'everyone'}` : null),
    mcpTools: () => [],
    runHooks: async (event, payload, c, signal) => (hooks.fn ? hooks.fn(event, payload, c, signal) : { block: false }),
    ...opts.ext,
  };

  const toolList = opts.tools ?? defaultTools();
  const ctx = {
    bus, dataDir: dir, sessions: sessionStore, settings: settingsStore,
    secrets: { get: () => null, set: () => {}, has: () => false },
    kv: { read: <T,>(_k: string, f: T) => f, write: () => {} },
    llm: createLlmClient({ retryDelaysMs: [], idleTimeoutMs: opts.idleTimeoutMs }),
    tools: { all: () => toolList, get: (n: string) => toolList.find((t) => t.name === n) },
    ext,
    shells: { start: () => 'x', output: () => ({ output: '', running: false, exitCode: 0 }), kill: () => true, list: () => [] },
    scheduler: { list: () => [], create: () => { throw new Error('no'); }, update: () => { throw new Error('no'); }, delete: () => {}, runNow: async () => ({ sessionId: '' }) },
    activity: activityRegistry,
    native: { notify: () => {}, isElectron: false },
  } as unknown as CoreContext;
  const registry = createModelRegistry(ctx, { autoPoll: false });
  ctx.models = registry;
  const agent = new AgentManagerImpl(ctx);
  ctx.agent = agent;
  await registry.refresh();

  const h: Harness = {
    ctx, agent, mock, dir, cwd, events, projectAllow, hooks, activity, settings, registry,
    createSession: (init = {}) => sessionStore.create({ cwd, ...init }),
    session: (id) => sessions.get(id)!,
    eventsOf: <E extends CoreEventName>(name: E) => events.filter((e) => e.event === name).map((e) => e.data as CoreEvents[E]),
    waitIdle: async (id, timeoutMs = 8000) => {
      await new Promise((r) => setTimeout(r, 5));
      await until(() => !agent.isRunning(id), timeoutMs, `session ${id} idle`);
    },
    until,
    close: async () => {
      registry.dispose();
      await mock.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    },
  };
  return h;
}

// ───────────────────────────── fake tools ─────────────────────────────

export interface ToolLog { name: string; start: number; end: number; input: Record<string, unknown> }
export const toolLog: ToolLog[] = [];

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});

export function fakeRead(delayMs = 120): ToolDef {
  return {
    name: 'Read', description: 'Read a file', concurrencySafe: true,
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    permission: () => 'read',
    title: (i) => `Read ${String(i.file_path)}`,
    async run(input, ctx: ToolContext) {
      const start = Date.now();
      await sleep(delayMs, ctx.signal);
      const p = resolve(ctx.cwd, String(input.file_path));
      let content = '';
      try { content = await fs.readFile(p, 'utf8'); ctx.readFiles.set(p, Date.now()); } catch { content = `(missing ${input.file_path})`; }
      toolLog.push({ name: 'Read', start, end: Date.now(), input });
      return { content };
    },
  };
}

export function fakeEdit(delayMs = 60): ToolDef {
  return {
    name: 'Write', description: 'Write a file', concurrencySafe: false,
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
    permission: () => 'edit',
    title: (i) => `Write ${String(i.file_path)}`,
    ruleFor: () => 'Write',
    async run(input, ctx) {
      const start = Date.now();
      const p = resolve(ctx.cwd, String(input.file_path));
      let existed = true;
      try { await fs.access(p); } catch { existed = false; }
      await ctx.checkpointFile(p);
      await sleep(delayMs, ctx.signal);
      await fs.writeFile(p, String(input.content));
      ctx.recordChange({ path: p, additions: 1, deletions: 0, isNew: !existed });
      toolLog.push({ name: 'Write', start, end: Date.now(), input });
      return { content: `Wrote ${p}`, display: { kind: 'diff', path: p, before: '', after: String(input.content), isNewFile: !existed } };
    },
  };
}

export function fakeBash(): ToolDef {
  return {
    name: 'Bash', description: 'Run a command', concurrencySafe: false,
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: () => 'exec',
    title: (i) => `Run: ${String(i.command)}`,
    ruleFor: (i) => `Bash(${String(i.command).split(' ')[0]}:*)`,
    async run(input, ctx) {
      const cmd = String(input.command);
      const start = Date.now();
      if (cmd.startsWith('sleep')) {
        ctx.progress('sleeping…');
        await sleep(10_000, ctx.signal);
      }
      if (cmd.startsWith('big')) return { content: 'x'.repeat(50_000) };
      toolLog.push({ name: 'Bash', start, end: Date.now(), input });
      return { content: `ran: ${cmd}`, display: { kind: 'bash', command: cmd, output: `ran: ${cmd}`, exitCode: 0 } };
    },
  };
}

export function fakeAsk(): ToolDef {
  return {
    name: 'AskUserQuestion', description: 'Ask', concurrencySafe: false,
    inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
    permission: () => 'none', title: () => 'Question',
    async run(input, ctx) {
      const q = String(input.question ?? 'Which?');
      const answers = await ctx.askUser([{ question: q, header: 'Q', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]);
      return { content: `Answer: ${answers[q]}` };
    },
  };
}

export function fakeExitPlan(): ToolDef {
  return {
    name: 'ExitPlanMode', description: 'Exit plan mode', concurrencySafe: false,
    inputSchema: { type: 'object', properties: { plan: { type: 'string' } } },
    permission: () => 'none', title: () => 'Plan',
    async run(input, ctx) {
      const r = await ctx.requestPlanApproval(String(input.plan));
      return { content: r.approved ? `approved (${r.mode})` : `rejected: ${r.feedback ?? ''}`, display: { kind: 'plan', plan: String(input.plan) } };
    },
  };
}

export function fakeTask(): ToolDef {
  return {
    name: 'Task', description: 'Subagent', concurrencySafe: true,
    inputSchema: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, subagent_type: { type: 'string' } } },
    permission: () => 'none', title: (i) => `Task: ${String(i.description)}`,
    async run(input, ctx) {
      try {
        const r = await ctx.runSubagent({ agentType: String(input.subagent_type ?? 'general-purpose'), description: String(input.description ?? ''), prompt: String(input.prompt ?? '') });
        return { content: r.result, display: { kind: 'subagent', sessionId: r.sessionId, agentType: String(input.subagent_type ?? 'general-purpose'), description: String(input.description) } };
      } catch (e) {
        return { content: `Subagent failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

export function fakeTodo(): ToolDef {
  return {
    name: 'TodoWrite', description: 'Todos', concurrencySafe: false,
    inputSchema: { type: 'object', properties: { todos: { type: 'array' } } },
    permission: () => 'none', title: () => 'Todos',
    async run(input, ctx) {
      ctx.todos.set(input.todos as never);
      return { content: 'ok' };
    },
  };
}

export function defaultTools(): ToolDef[] {
  return [fakeRead(), fakeEdit(), fakeBash(), fakeAsk(), fakeExitPlan(), fakeTask(), fakeTodo()];
}
