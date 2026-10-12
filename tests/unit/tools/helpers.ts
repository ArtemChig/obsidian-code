// Shared test helpers for the tools area: temp dirs (with spaces in the name), a fake ToolContext, result helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoreContext, ToolContext } from '../../../src/core/contracts';
import { createShellRegistry } from '../../../src/core/tools/shells';
import type { ChangedFile, Question, Settings, Todo, ToolResultPayload } from '../../../src/shared/types';

export const OFFLINE = process.env.OFFLINE === '1';

const tempDirs: string[] = [];

/** Fresh temp directory whose name contains a space (exercises Windows path quoting). */
export function makeTempDir(prefix = 'oc tools '): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

export const DEFAULT_SETTINGS = {
  defaultModel: null,
  defaultPermissionMode: 'default',
  defaultCwd: '',
  thinkingByDefault: true,
  preferUncensored: true,
  local: { enabled: true, baseUrl: 'http://127.0.0.1:8080' },
  custom: [],
  search: { provider: 'duckduckgo' },
  permissions: { allow: [], deny: [] },
  hooks: {},
  mcpServers: {},
  importClaudeConfig: false,
  shell: 'auto',
  maxToolOutputChars: 30000,
  autoCompactPercent: 80,
  notifications: false,
  launchAtLogin: false,
} as unknown as Settings;

export interface FakeCtx extends ToolContext {
  checkpoints: string[];
  changes: Omit<ChangedFile, 'lastToolUseId'>[];
  progressLog: string[];
  todoList: Todo[];
  /** Answers returned by askUser (question text → answer). */
  answers: Record<string, string>;
  asked: Question[][];
  controller: AbortController;
  secrets: Record<string, string>;
  subagentCalls: { agentType: string; description: string; prompt: string }[];
  planDecision: { approved: boolean; mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; feedback?: string };
  scheduled: any[];
  completeCalls: string[];
  completeImpl: (prompt: string) => Promise<string>;
  skillTable: Record<string, { name: string; body: string; dir: string }>;
  registry: ReturnType<typeof createShellRegistry>;
}

export function makeCtx(cwd: string, overrides: { settings?: Partial<Settings>; dataDir?: string; readFiles?: Map<string, number> } = {}): FakeCtx {
  const controller = new AbortController();
  const settings = { ...DEFAULT_SETTINGS, ...overrides.settings } as Settings;
  const core = {
    activity: { upsert() {}, onStop() {}, list: () => [], stop() {} },
    settings: { get: () => settings },
  } as unknown as CoreContext;
  const registry = createShellRegistry(core);
  const todoState: { list: Todo[] } = { list: [] };
  const scheduled: any[] = [];

  const ctx: FakeCtx = {
    sessionId: 'test-session',
    cwd,
    toolUseId: 'toolu_1',
    signal: controller.signal,
    permissionMode: 'default',
    settings,
    secret: (name) => ctx.secrets[name] ?? null,
    dataDir: overrides.dataDir ?? path.join(cwd, '.data'),
    progress: (t) => { ctx.progressLog.push(t); },
    readFiles: overrides.readFiles ?? new Map(),
    async checkpointFile(p) { ctx.checkpoints.push(p); },
    recordChange(c) { ctx.changes.push(c); },
    todos: { get: () => todoState.list, set: (t) => { todoState.list = t; ctx.todoList = t; } },
    async askUser(qs) { ctx.asked.push(qs); return ctx.answers; },
    async requestPlanApproval() { return ctx.planDecision; },
    async runSubagent(opts) { ctx.subagentCalls.push(opts); return { sessionId: 'sub-1', result: `report for ${opts.description}` }; },
    shells: registry,
    scheduler: {
      list: () => scheduled,
      create(t) {
        const task = { ...t, id: `task_${scheduled.length + 1}`, createdAt: Date.now(), nextRunAt: Date.now() + 3600_000 };
        scheduled.push(task);
        return task as never;
      },
      update: () => { throw new Error('not used'); },
      delete(id) {
        const i = scheduled.findIndex((t) => t.id === id);
        if (i >= 0) scheduled.splice(i, 1);
      },
      runNow: async () => ({ sessionId: 's' }),
    },
    ext: {
      memoryText: async () => '',
      skills: async () => Object.values(ctx.skillTable).map((s) => ({ name: s.name, description: '', path: s.dir, source: 'user' as const })),
      loadSkill: async (_cwd, name) => ctx.skillTable[name] ?? null,
      agentTypes: async () => [],
      agentDefinition: async () => null,
      slashCommands: async () => [],
      expandCommand: async () => null,
      mcpTools: () => [],
      runHooks: async () => ({ block: false }),
    },
    async complete(prompt) { ctx.completeCalls.push(prompt); return ctx.completeImpl(prompt); },
    checkpoints: [],
    changes: [],
    progressLog: [],
    todoList: [],
    answers: {},
    asked: [],
    controller,
    secrets: {},
    subagentCalls: [],
    planDecision: { approved: true, mode: 'acceptEdits' },
    scheduled,
    completeCalls: [],
    completeImpl: async () => 'EXTRACTED ANSWER',
    skillTable: {},
    registry,
  };
  return ctx;
}

export function text(r: ToolResultPayload): string {
  return r.content;
}

/** Normalise CRLF so assertions are line-ending agnostic. */
export function lf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

export function write(dir: string, rel: string, content: string | Buffer): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
