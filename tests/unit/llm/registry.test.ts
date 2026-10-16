import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CoreContext, LlmProvider } from '@core/contracts';
import type { CoreEvents } from '@shared/protocol';
import type { ModelInfo, Settings } from '@shared/types';
import { createModelRegistry, type ModelRegistryImpl } from '@core/llm/registry';
import { getDialect, resetEndpointStates } from '@core/llm/dialect';
import { startMockLlm, type MockLlm } from '../../fixtures/mock-llm/server';

let local: MockLlm;
let custom: MockLlm;
beforeAll(async () => {
  local = await startMockLlm({ modelId: 'qwen3.6-35b-a3b-uncensored', nCtx: 131072, vision: true });
  custom = await startMockLlm({ modelId: 'some-model', dialect: 'vllm', nCtx: 65536 });
});
afterAll(async () => { await local.close(); await custom.close(); });

const registries: ModelRegistryImpl[] = [];
afterEach(() => { registries.splice(0).forEach((r) => r.dispose()); resetEndpointStates(); });

function makeCtx(settings: Partial<Settings>, secrets: Record<string, string> = {}) {
  const events: { event: string; data: unknown }[] = [];
  let s = {
    defaultModel: null, preferUncensored: true, custom: [],
    local: { enabled: true, baseUrl: local.url },
    ...settings,
  } as unknown as Settings;
  const listeners: ((s: Settings) => void)[] = [];
  const ctx = {
    bus: { emit: (event: string, data: unknown) => events.push({ event, data }), on: () => () => {} },
    settings: {
      get: () => s,
      update: (p: Partial<Settings>) => { s = { ...s, ...p }; listeners.forEach((l) => l(s)); return s; },
      onChange: (fn: (s: Settings) => void) => { listeners.push(fn); return () => {}; },
    },
    secrets: { get: (n: string) => secrets[n] ?? null, has: (n: string) => n in secrets, set: () => {} },
  } as unknown as CoreContext;
  return { ctx, events };
}

function reg(ctx: CoreContext) {
  const r = createModelRegistry(ctx, { autoPoll: false });
  registries.push(r);
  return r;
}

describe('model registry', () => {
  it('local provider: n_ctx, vision, thinking, uncensored variant, dialect, models.updated', async () => {
    const { ctx, events } = makeCtx({});
    const r = reg(ctx);
    const snap = await r.refresh();
    const m = snap.models.find((x) => x.ref.provider === 'local')!;
    expect(m).toMatchObject({
      ref: { provider: 'local', model: 'qwen3.6-35b-a3b-uncensored' },
      contextLength: 131072, supportsVision: true, supportsThinking: true, variant: 'uncensored', status: 'online',
    });
    expect(snap.providers.find((p) => p.id === 'local')?.status).toBe('online');
    expect(getDialect(local.url)).toBe('llamacpp');
    expect(events.filter((e) => e.event === 'models.updated')).toHaveLength(1);
    await r.refresh();
    expect(events.filter((e) => e.event === 'models.updated')).toHaveLength(1); // unchanged → no event
    expect(r.pickDefault()).toEqual({ provider: 'local', model: 'qwen3.6-35b-a3b-uncensored' });
    const res = r.resolve(null);
    expect(res.endpoint.baseUrl).toBe(local.url);
  });

  it('loading (503) → starting; offline → friendly resolve error', async () => {
    local.setInfo({ healthStatus: 503 });
    try {
      const { ctx } = makeCtx({});
      const r = reg(ctx);
      await r.refresh();
      expect(r.providers().find((p) => p.id === 'local')?.status).toBe('starting');
      expect(() => r.resolve({ provider: 'local', model: 'x' })).toThrow(/still loading/);
    } finally { local.setInfo({ healthStatus: 200 }); }
    const { ctx } = makeCtx({ local: { enabled: true, baseUrl: 'http://127.0.0.1:9' } });
    const r = reg(ctx);
    await r.refresh();
    expect(r.providers().find((p) => p.id === 'local')?.status).toBe('offline');
    expect(() => r.resolve({ provider: 'local', model: 'x' })).toThrow(/isn't reachable/);
    expect(() => r.resolve({ provider: 'vast', model: 'x' })).toThrow("Your Vast GPU isn't clocked in — clock in or pick the Local model.");
  });

  it('custom provider with API key from secrets; vllm context length; settings change triggers refresh', async () => {
    const { ctx } = makeCtx({ custom: [{ id: 'c1', label: 'My vLLM', baseUrl: `${custom.url}/v1` }] }, { 'custom.c1.apiKey': 'sekret' });
    const r = reg(ctx);
    await r.refresh();
    const m = r.models().find((x) => x.ref.provider === 'custom:c1')!;
    expect(m).toMatchObject({ contextLength: 65536, variant: 'standard', status: 'online' });
    const res = r.resolve({ provider: 'custom:c1', model: 'some-model' });
    expect(res.endpoint.apiKey).toBe('sekret');
    expect(getDialect(custom.url)).toBe('vllm');
    // removing the endpoint removes the provider
    ctx.settings.update({ custom: [] });
    await r.refresh();
    expect(r.providers().some((p) => p.id === 'custom:c1')).toBe(false);
  });

  it('register(vast) + pickDefault order: settings default (online) → vast → local → custom', async () => {
    const { ctx } = makeCtx({ custom: [{ id: 'c1', label: 'C', baseUrl: custom.url }] });
    const r = reg(ctx);
    let vastOnline = false;
    const vastModel: ModelInfo = {
      ref: { provider: 'vast', model: 'qwen3.8-27b-heretic' }, label: 'Qwen 27B', contextLength: 65536,
      supportsVision: false, supportsTools: true, supportsThinking: true, variant: 'uncensored', status: 'online',
    };
    const vast: LlmProvider = {
      id: 'vast',
      info: () => ({ id: 'vast', label: 'Vast GPU', status: vastOnline ? 'online' : 'offline', baseUrl: vastOnline ? local.url : null }),
      endpoint: () => (vastOnline ? { baseUrl: local.url, apiKey: 'k' } : null),
      listModels: async () => [{ ...vastModel, status: vastOnline ? 'online' : 'offline' }],
    };
    r.register(vast);
    await r.refresh();
    expect(r.pickDefault()?.provider).toBe('local');
    vastOnline = true;
    await r.refresh();
    expect(r.pickDefault()).toEqual(vastModel.ref);
    expect(r.resolve(null).endpoint.apiKey).toBe('k');
    ctx.settings.update({ defaultModel: { provider: 'custom:c1', model: 'some-model' } });
    await r.refresh();
    expect(r.pickDefault()).toEqual({ provider: 'custom:c1', model: 'some-model' });
  });

  it('a settings change re-probes the providers, except one that only changes the sidebar layout (Settings.ui)', async () => {
    const { ctx } = makeCtx({});
    const r = reg(ctx);
    let probes = 0;
    r.register({
      id: 'vast',
      info: () => ({ id: 'vast', label: 'Vast GPU', status: 'offline', baseUrl: null }),
      endpoint: () => null,
      listModels: async () => { probes++; return []; },
    });
    await r.refresh();
    const base = probes;
    const settle = () => new Promise((res) => setTimeout(res, 250));
    ctx.settings.update({ ui: { sidebar: { groupOrder: [], groupNames: {}, categories: [], collapsed: ['pinned'] } } } as Partial<Settings>);
    await settle();
    expect(probes).toBe(base); // collapsing a group is no reason to ask the model servers again
    ctx.settings.update({ shell: 'cmd' });
    await settle();
    expect(probes).toBeGreaterThan(base);
  });

  it('keeps last-known models (with the new status) when the provider drops', async () => {
    const { ctx } = makeCtx({});
    const r = reg(ctx);
    await r.refresh();
    local.setInfo({ healthStatus: 503 });
    try {
      await r.refresh();
      const m = r.models().filter((x) => x.ref.provider === 'local');
      expect(m).toHaveLength(1);
      expect(m[0]!.status).toBe('starting');
      expect(r.pickDefault()).toBeNull();
    } finally { local.setInfo({ healthStatus: 200 }); }
  });

  it('disabled local provider', async () => {
    const { ctx } = makeCtx({ local: { enabled: false, baseUrl: local.url } });
    const r = reg(ctx);
    await r.refresh();
    expect(r.providers().find((p) => p.id === 'local')?.detail).toBe('Disabled in Settings');
    expect(() => r.resolve({ provider: 'local', model: 'x' })).toThrow(/disabled/);
    expect(r.pickDefault()).toBeNull();
    expect(() => r.resolve(null)).toThrow(/No model is available/);
  });

  it('emits models.updated typed per protocol', async () => {
    const { ctx, events } = makeCtx({});
    const r = reg(ctx);
    await r.refresh();
    const data = events.find((e) => e.event === 'models.updated')!.data as CoreEvents['models.updated'];
    expect(Array.isArray(data.models)).toBe(true);
    expect(Array.isArray(data.providers)).toBe(true);
  });
});
