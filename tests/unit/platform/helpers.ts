// Test helpers for the platform area: temp data dirs and a CoreContext built from the real platform modules
// (stores, bus, activity) plus STUB agent / models / gpu / ext / scheduler / tools.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { CoreContext, GpuManager, NativeBridge } from '@core/contracts';
import { createActivityRegistry } from '@core/activity/index';
import { createEventBus } from '@core/server/bus';
import { createStores } from '@core/store/index';
import type { GpuStatus } from '@shared/types';

export function tempDir(prefix = 'oc-platform-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may keep handles briefly */
      }
    },
  };
}

export function gpuStatus(over: Partial<GpuStatus> = {}): GpuStatus {
  return { phase: 'off', message: '', sessionCost: 0, monthCost: 0, monthlyBudget: 200, steps: [], ...over };
}

export interface StubGpu extends GpuManager {
  current: GpuStatus;
}

export function stubGpu(initial: Partial<GpuStatus> = {}): StubGpu {
  const gpu: StubGpu = {
    current: gpuStatus(initial),
    status: vi.fn(() => gpu.current),
    provider: vi.fn(() => ({
      id: 'vast',
      info: () => ({ id: 'vast' as const, label: 'Vast', status: 'offline' as const, baseUrl: null }),
      endpoint: () => null,
      listModels: async () => [],
    })),
    catalog: vi.fn(() => []),
    offers: vi.fn(async () => []),
    clockIn: vi.fn(async () => {
      gpu.current = { ...gpu.current, phase: 'ready' };
      return gpu.current;
    }),
    clockOut: vi.fn(async () => {
      gpu.current = { ...gpu.current, phase: 'off' };
      return gpu.current;
    }),
    switchModel: vi.fn(async () => gpu.current),
    history: vi.fn(() => []),
    destroyOrphans: vi.fn(async () => []),
    serverLog: vi.fn(async () => 'log'),
    testKey: vi.fn(async () => ({ ok: true, message: 'ok' })),
    waitUntilReady: vi.fn(async () => gpu.current.phase === 'ready'),
    dispose: vi.fn(async () => undefined),
  };
  return gpu;
}

export function makeCtx(dataDir: string, opts: { native?: Partial<NativeBridge>; gpu?: StubGpu } = {}): CoreContext {
  const native: NativeBridge = { isElectron: false, notify: vi.fn(), ...opts.native };
  const stores = createStores(dataDir, native);
  const bus = createEventBus();
  const ctx = {
    dataDir,
    native,
    ...stores,
    bus,
    activity: createActivityRegistry(bus),
    llm: { stream: vi.fn() },
    models: {
      providers: vi.fn(() => []),
      models: vi.fn(() => []),
      refresh: vi.fn(async () => ({ providers: [], models: [] })),
      register: vi.fn(),
      resolve: vi.fn(),
      pickDefault: vi.fn(() => ({ provider: 'local' as const, model: 'qwen-local' })),
    },
    tools: { all: () => [], get: () => undefined },
    ext: {
      memoryText: vi.fn(async () => ''),
      skills: vi.fn(async () => [{ name: 'sk', description: 'a skill', path: '/x', source: 'user' as const }]),
      loadSkill: vi.fn(async () => null),
      agentTypes: vi.fn(async () => []),
      agentDefinition: vi.fn(async () => null),
      slashCommands: vi.fn(async () => [{ name: 'deploy', description: 'Deploy', source: 'project' as const }]),
      expandCommand: vi.fn(async () => null),
      mcpTools: vi.fn(() => []),
      runHooks: vi.fn(async () => ({ block: false })),
    },
    shells: { start: vi.fn(), output: vi.fn(), kill: vi.fn(), list: vi.fn(() => []) },
    agent: {
      send: vi.fn(async () => ({ messageId: 'm1', queued: false })),
      interrupt: vi.fn(),
      respondPermission: vi.fn(),
      answerQuestion: vi.fn(),
      respondPlan: vi.fn(),
      rewind: vi.fn(async () => ['a.txt']),
      pending: vi.fn(() => ({ permissions: [], questions: [], plans: [] })),
      runHeadless: vi.fn(async () => ({ ok: true, finalText: 'All done.' })),
      isRunning: vi.fn(() => false),
      fileDiff: vi.fn(async () => ({ before: 'a', after: 'b' })),
    },
    gpu: opts.gpu ?? stubGpu(),
    scheduler: {
      list: vi.fn(() => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(async () => ({ sessionId: 's1' })),
    },
  } as unknown as CoreContext;
  return ctx;
}
