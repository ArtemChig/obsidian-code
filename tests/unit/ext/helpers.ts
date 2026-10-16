// Shared helpers for the extensions tests: temp dirs, a fake CoreContext, small utilities.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoreContext, ToolContext } from '@core/contracts';
import type { Settings } from '@shared/types';

export function defaultSettings(patch: Partial<Settings> = {}): Settings {
  return {
    defaultModel: null,
    defaultPermissionMode: 'default',
    defaultCwd: os.homedir(),
    thinkingByDefault: true,
    preferUncensored: true,
    local: { enabled: true, baseUrl: 'http://127.0.0.1:8080' },
    custom: [],
    vast: {
      profiles: [], monthlyBudget: 100, idleMinutes: 20, heartbeatMinutes: 5, maxSessionHours: 6, clockOutOnQuit: true,
      clockOutMode: 'destroy', parkMaxDays: 3, image: '', localPort: 18080, extraLlamaArgs: [],
      autoClockOut: { default: 'off', stallMinutes: 10, finishGraceMinutes: 2 },
    },
    search: { provider: 'duckduckgo' },
    permissions: { allow: [], deny: [] },
    trustedFolders: [],
    projectAllow: {},
    hooks: {},
    mcpServers: {},
    importClaudeConfig: false,
    shell: 'auto',
    maxToolOutputChars: 30000,
    autoCompactPercent: 80,
    notifications: true,
    launchAtLogin: false,
    ui: { sidebar: { groupOrder: [], groupNames: {}, categories: [], collapsed: [] } },
    engine: { default: 'builtin', claudeCode: { executable: 'auto', systemPrompt: 'lean', importUserClaudeConfig: false, extraEnv: {} } },
    ...patch,
  };
}

export interface FakeCtx {
  ctx: CoreContext;
  dataDir: string;
  /** Replace settings and notify listeners (like SettingsStore.update). */
  update(patch: Partial<Settings>): void;
  setProjectHooks(cwd: string, hooks: Settings['hooks']): void;
  secrets: Map<string, string>;
}

export function makeCtx(dataDir: string, patch: Partial<Settings> = {}): FakeCtx {
  let settings = defaultSettings(patch);
  const listeners = new Set<(s: Settings) => void>();
  const projectHooks = new Map<string, Settings['hooks']>();
  const secrets = new Map<string, string>();
  const ctx = {
    dataDir,
    settings: {
      get: () => settings,
      update: (p: Partial<Settings>) => {
        settings = { ...settings, ...p };
        for (const l of listeners) l(settings);
        return settings;
      },
      forProject: (cwd: string) => ({ permissions: { allow: [], deny: [] }, hooks: projectHooks.get(cwd) ?? {} }),
      addProjectAllowRule: () => undefined,
      onChange: (fn: (s: Settings) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    secrets: {
      get: (n: string) => secrets.get(n) ?? null,
      set: (n: string, v: string | null) => (v === null ? secrets.delete(n) : secrets.set(n, v)),
      has: (n: string) => secrets.has(n),
    },
  } as unknown as CoreContext;
  return {
    ctx,
    dataDir,
    secrets,
    update: (p) => ctx.settings.update(p),
    setProjectHooks: (cwd, hooks) => void projectHooks.set(cwd, hooks),
  };
}

export function toolContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    cwd: process.cwd(),
    toolUseId: 't1',
    signal: new AbortController().signal,
    permissionMode: 'default',
    settings: defaultSettings(),
    secret: () => null,
    dataDir: os.tmpdir(),
    progress: () => undefined,
    readFiles: new Map(),
    checkpointFile: async () => undefined,
    recordChange: () => undefined,
    todos: { get: () => [], set: () => undefined },
    askUser: async () => ({}),
    requestPlanApproval: async () => ({ approved: true, mode: 'default' }),
    runSubagent: async () => ({ sessionId: 'x', result: '' }),
    shells: undefined as never,
    scheduler: undefined as never,
    ext: undefined as never,
    complete: async () => '',
    ...over,
  };
}

const tmpRoots: string[] = [];

export function tmpDir(prefix = 'oc-ext-'): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of tmpRoots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
}

/** Write a file (creating parent dirs) and return its path. */
export function write(file: string, content: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

export function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Is a process with this pid alive? */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
