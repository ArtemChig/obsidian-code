// Model browser service + the hub.* RPC methods. Mock fetch only (recorded Hugging Face responses); nothing touches the network.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreContext } from '../../../src/core/contracts';
import { getCatalogModel, setUserCatalogModels, userCatalogModels } from '../../../src/core/gpu/catalog';
import { HubClient, HubError } from '../../../src/core/gpu/hub';
import { bindUserCatalog, createModelBrowser, findVariant, ModelBrowserError, restoredDefaultModelId } from '../../../src/core/gpu/model-browser';
import { createRpcHandlers, dispatchRpc, RpcError } from '../../../src/core/server/rpc';
import { createSettingsStore, type SettingsStoreImpl } from '../../../src/core/store/settings';
import { parseModelDetail } from '../../../src/shared/hub-parse';
import type { GpuStatus } from '../../../src/shared/types';
import { MAX_USER_MODELS } from '../../../src/shared/user-models';

const fx = (name: string): any => JSON.parse(readFileSync(path.join(__dirname, '../../fixtures/hub', name), 'utf8'));
const QWEN = 'unsloth/Qwen3.8-27B-GGUF';
const GLM = 'unsloth/GLM-5.3-Flash-GGUF';

let dir: string;
let settings: SettingsStoreImpl;
let off: () => void;
let calls: string[];
let gpu: Partial<GpuStatus>;
let respond: (url: string) => Response;
let tasks: string[];

function makeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return respond(url);
  }) as unknown as typeof fetch;
}

const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });

function defaultRespond(url: string): Response {
  if (url.includes(`/api/models/${QWEN}`)) return ok(fx('detail-unsloth-qwen38-27b.json'));
  if (url.includes(`/api/models/${GLM}`)) return ok(fx('detail-unsloth-glm53-flash.json'));
  if (url.includes('/api/models?')) return ok(fx('search-qwen.json'));
  return new Response('{"error":"Invalid username or password."}', { status: 401 });
}

function build() {
  const hub = new HubClient({ fetch: makeFetch() });
  return createModelBrowser({ settings, hub, gpuStatus: () => gpu as GpuStatus, usedBy: () => tasks, today: () => '2026-10-16' });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'oc-browser-'));
  settings = createSettingsStore(dir);
  off = bindUserCatalog(settings);
  calls = [];
  gpu = { phase: 'off' };
  tasks = [];
  respond = defaultRespond;
});

afterEach(() => {
  off();
  setUserCatalogModels([]);
  rmSync(dir, { recursive: true, force: true });
});

describe('addModel', () => {
  it('adds a quant by label: stored in settings, visible in the catalog, defaults planned against the profiles', async () => {
    const browser = build();
    const m = await browser.addModel({ repo: QWEN, quant: 'UD-Q4_K_XL' });
    expect(m).toMatchObject({ id: 'hf-unsloth-qwen3.8-27b-gguf-ud-q4_k_xl', repo: QWEN, files: ['Qwen3.8-27B-UD-Q4_K_XL.gguf'], source: 'user', quant: 'UD-Q4_K_XL', llamaArgs: [], verifiedAt: '2026-10-16' });
    expect(m.mmproj).toBeUndefined();
    expect(settings.get().vast.userModels).toEqual([m]);
    // persisted and live in the process-wide catalog (bindUserCatalog)
    expect(createSettingsStore(dir).get().vast.userModels).toEqual([m]);
    expect(getCatalogModel(m.id)).toMatchObject({ id: m.id, source: 'user' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`https://huggingface.co/api/models/${QWEN}?blobs=true`);
  });

  it('accepts the variant id, a lower-case label, and adding again replaces instead of duplicating', async () => {
    const browser = build();
    const a = await browser.addModel({ repo: QWEN, quant: 'ud-q4_k_xl' });
    const b = await browser.addModel({ repo: QWEN, quant: 'Qwen3.8-27B-UD-Q4_K_XL.gguf' });
    expect(b.id).toBe(a.id);
    expect(settings.get().vast.userModels).toHaveLength(1);
    // the second add reused the cached details
    expect(calls).toHaveLength(1);
    const c = await browser.addModel({ repo: QWEN, quant: 'Q8_0' });
    expect(settings.get().vast.userModels.map((m) => m.id)).toEqual([a.id, c.id]);
  });

  it('re-adding with vision replaces the entry and downloads the projector too', async () => {
    const browser = build();
    const plain = await browser.addModel({ repo: QWEN, quant: 'UD-Q4_K_XL' });
    const vis = await browser.addModel({ repo: QWEN, quant: 'UD-Q4_K_XL', withVision: true });
    expect(vis.id).toBe(plain.id);
    expect(vis.mmproj).toBe('mmproj-F16.gguf');
    expect(vis.sizeGb).toBeGreaterThan(plain.sizeGb);
    expect(settings.get().vast.userModels).toEqual([vis]);
  });

  it('a split quant keeps its parts in order', async () => {
    const m = await build().addModel({ repo: GLM, quant: 'UD-IQ4_XS' });
    expect(m.files.map((f) => f.slice(-19))).toEqual(['00001-of-00005.gguf', '00002-of-00005.gguf', '00003-of-00005.gguf', '00004-of-00005.gguf', '00005-of-00005.gguf']);
    expect(m.profiles).toEqual(['max']);
  });

  it('refuses a gated repo and saves nothing', async () => {
    respond = (url) => ok({ ...fx('detail-unsloth-qwen38-27b.json'), gated: 'manual' });
    const e = await build().addModel({ repo: QWEN, quant: 'Q8_0' }).catch((x) => x);
    expect(e).toBeInstanceOf(ModelBrowserError);
    expect(e.message).toMatch(/gated/);
    expect(e.message).toMatch(/login/);
    expect(settings.get().vast.userModels).toEqual([]);
    expect(userCatalogModels()).toEqual([]);
  });

  it('an unknown quant lists what the repo has', async () => {
    const e = await build().addModel({ repo: QWEN, quant: 'Q9_Z' }).catch((x) => x);
    expect(e).toMatchObject({ code: 'not_found' });
    expect(e.message).toContain('Q9_Z');
    expect(e.message).toContain('UD-Q4_K_XL');
  });

  it('vision requested but the repo has no projector', async () => {
    const d = fx('detail-unsloth-qwen38-27b.json');
    d.siblings = d.siblings.filter((s: { rfilename: string }) => !/mmproj/.test(s.rfilename));
    respond = () => ok(d);
    await expect(build().addModel({ repo: QWEN, quant: 'Q8_0', withVision: true })).rejects.toThrow(/no vision projector/);
    expect(settings.get().vast.userModels).toEqual([]);
  });

  it('a quant whose file names the server cannot download is refused with the reason', async () => {
    const d = fx('detail-unsloth-qwen38-27b.json');
    d.siblings.push({ rfilename: 'Weird [name]-Q5_0.gguf', size: 1_000_000_000 });
    respond = () => ok(d);
    const e = await build().addModel({ repo: QWEN, quant: 'Q5_0' }).catch((x) => x);
    expect(e.message).toMatch(/characters the GPU server's downloader does not support/);
  });

  it('validates its input before calling Hugging Face', async () => {
    const browser = build();
    await expect(browser.addModel({ repo: 'nope', quant: 'Q8_0' })).rejects.toThrow(/owner\/name/);
    await expect(browser.addModel({ repo: 'a/b;c', quant: 'Q8_0' })).rejects.toThrow(/owner\/name/);
    await expect(browser.addModel({ repo: QWEN, quant: '  ' })).rejects.toThrow(/Pick a quant/);
    expect(calls).toHaveLength(0);
  });

  it('Hugging Face errors reach the caller with their friendly message', async () => {
    respond = () => new Response('', { status: 503 });
    const e = await build().addModel({ repo: QWEN, quant: 'Q8_0' }).catch((x) => x);
    expect(e).toBeInstanceOf(HubError);
    expect(e.message).toMatch(/having trouble/);
    respond = () => new Response('{"error":"Invalid username or password."}', { status: 401 });
    const e2 = await build().addModel({ repo: 'ghost/Nothing-GGUF', quant: 'Q8_0' }).catch((x) => x);
    expect(e2).toMatchObject({ code: 'not_found' });
  });

  it(`keeps at most ${MAX_USER_MODELS} models`, async () => {
    const filler = Array.from({ length: MAX_USER_MODELS }, (_, i) => ({
      id: `hf-filler-${i}`, label: 'x', family: 'hf-x', variant: 'standard', repo: 'a/b', files: ['x.gguf'], sizeGb: 1, minTotalVramGb: 4, contextLength: 8192, llamaArgs: [], profiles: [],
    }));
    settings.update({ vast: { userModels: filler } } as never);
    expect(settings.get().vast.userModels).toHaveLength(MAX_USER_MODELS);
    const e = await build().addModel({ repo: QWEN, quant: 'Q8_0' }).catch((x) => x);
    expect(e).toMatchObject({ code: 'limit' });
  });

  it('plans against the profiles in the settings, including a custom one', async () => {
    const profiles = [...settings.get().vast.profiles, { ...settings.get().vast.profiles[0], id: 'mine', label: 'Mine', numGpus: 1, minGpuRamGb: 48 }];
    settings.update({ vast: { profiles } } as never);
    const m = await build().addModel({ repo: QWEN, quant: 'UD-Q4_K_XL' });
    expect(m.profiles).toEqual(['light', 'standard', 'max', 'mine']);
  });
});

describe('removeModel', () => {
  it('removes it from settings and the catalog', async () => {
    const browser = build();
    const a = await browser.addModel({ repo: QWEN, quant: 'Q8_0' });
    const b = await browser.addModel({ repo: QWEN, quant: 'UD-Q4_K_XL' });
    browser.removeModel(a.id);
    expect(settings.get().vast.userModels.map((m) => m.id)).toEqual([b.id]);
    expect(getCatalogModel(a.id)).toBeUndefined();
    expect(getCatalogModel(b.id)).toBeDefined();
  });

  it('never removes a built-in, and unknown ids are an error', () => {
    const browser = build();
    expect(() => browser.removeModel('qwen38-27b-uncensored-hauhau-q5kp')).toThrow(/built in/);
    expect(() => browser.removeModel('hf-nothing')).toThrow(/No added model/);
    expect(getCatalogModel('qwen38-27b-uncensored-hauhau-q5kp')).toBeDefined();
  });

  it('a profile that used it as its default gets the shipped default back', async () => {
    const browser = build();
    const m = await browser.addModel({ repo: QWEN, quant: 'Q8_0' });
    const profiles = settings.get().vast.profiles.map((p) => (p.id === 'light' ? { ...p, defaultModelId: m.id } : p));
    settings.update({ vast: { profiles } } as never);
    expect(settings.get().vast.profiles.find((p) => p.id === 'light')!.defaultModelId).toBe(m.id);
    browser.removeModel(m.id);
    const after = settings.get().vast.profiles;
    expect(after.find((p) => p.id === 'light')!.defaultModelId).toBe('qwen38-27b-uncensored-hauhau-q5kp');
    expect(after.find((p) => p.id === 'standard')!.defaultModelId).toBe('qwen38-flash-next-uncensored-huihui-v2-q4kxl');
  });

  it('restoredDefaultModelId: shipped default, else the first built-in for a custom profile', () => {
    expect(restoredDefaultModelId({ id: 'max', defaultModelId: 'x' })).toBe('glm53-flash-uncensored-huihui-iq4xs');
    expect(restoredDefaultModelId({ id: 'nonexistent', defaultModelId: 'keep-me' })).toBe('keep-me');
  });

  it('refuses while the GPU runs it or a parked instance holds it, allows once clocked out', async () => {
    const browser = build();
    const m = await browser.addModel({ repo: QWEN, quant: 'Q8_0' });
    for (const phase of ['searching', 'downloading', 'loading', 'ready', 'switching'] as const) {
      gpu = { phase, modelId: m.id };
      expect(() => browser.removeModel(m.id), phase).toThrow(/in use by the GPU/);
    }
    gpu = { phase: 'off', parked: { instanceId: 1, profileId: 'light', modelId: m.id, gpuName: 'RTX 5090', storageCostPerHour: 0.01, parkedAt: 0 } };
    expect(() => browser.removeModel(m.id)).toThrow(/in use by the GPU/);
    // another model in use is fine
    gpu = { phase: 'ready', modelId: 'qwen38-27b-uncensored-hauhau-q5kp' };
    browser.removeModel(m.id);
    expect(settings.get().vast.userModels).toEqual([]);
    expect(await Promise.resolve(gpu.phase)).toBe('ready');
  });

  it('refuses while a scheduled task runs on it, naming the tasks', async () => {
    const browser = build();
    const m = await browser.addModel({ repo: QWEN, quant: 'Q8_0' });
    tasks = ['Nightly audit'];
    expect(() => browser.removeModel(m.id)).toThrow(/scheduled task "Nightly audit"/);
    tasks = ['A', 'B', 'C', 'D', 'E'];
    expect(() => browser.removeModel(m.id)).toThrow(/tasks "A", "B", "C" and 2 more/);
    expect(settings.get().vast.userModels).toHaveLength(1);
    tasks = [];
    browser.removeModel(m.id);
    expect(settings.get().vast.userModels).toEqual([]);
  });

  it('a stale modelId after an error or clock-out does not block removal', async () => {
    const browser = build();
    const m = await browser.addModel({ repo: QWEN, quant: 'Q8_0' });
    gpu = { phase: 'error', modelId: m.id };
    browser.removeModel(m.id);
    expect(settings.get().vast.userModels).toEqual([]);
  });
});

describe('favorites', () => {
  it('newest first, idempotent, removable', () => {
    const browser = build();
    expect(browser.setFavorite('a/one', true)).toEqual(['a/one']);
    expect(browser.setFavorite('b/two', true)).toEqual(['b/two', 'a/one']);
    expect(browser.setFavorite('b/two', true)).toEqual(['b/two', 'a/one']);
    expect(browser.setFavorite('a/one', false)).toEqual(['b/two']);
    expect(browser.setFavorite('a/one', false)).toEqual(['b/two']);
    expect(settings.get().vast.favoriteRepos).toEqual(['b/two']);
    expect(createSettingsStore(dir).get().vast.favoriteRepos).toEqual(['b/two']);
  });

  it('rejects anything that is not a repo id', () => {
    const browser = build();
    for (const bad of ['', 'x', 'a/b/c', 'a/b;c', '../x', 'a b/c']) expect(() => browser.setFavorite(bad, true), bad).toThrow(/repo id/);
    expect(settings.get().vast.favoriteRepos).toEqual([]);
  });

  it('does not touch the user models or the hub', () => {
    const browser = build();
    browser.setFavorite('a/one', true);
    expect(settings.get().vast.userModels).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('search and details pass through the hub client', () => {
  it('search', async () => {
    const r = await build().search({ query: 'qwen', sort: 'likes', pipelineTag: 'text-generation' });
    expect(r.models).toHaveLength(3);
    const u = new URL(calls[0]);
    expect(u.searchParams.get('search')).toBe('qwen');
    expect(u.searchParams.get('sort')).toBe('likes');
    expect(u.searchParams.get('pipeline_tag')).toBe('text-generation');
    expect(u.searchParams.get('filter')).toBe('gguf');
  });

  it('details', async () => {
    const d = await build().details(QWEN);
    expect(d.variants.length).toBeGreaterThan(20);
    expect(d).toEqual(parseModelDetail(fx('detail-unsloth-qwen38-27b.json')));
  });
});

describe('findVariant', () => {
  it('by id, by label (any case), preferring an addable variant', () => {
    const d = parseModelDetail(fx('detail-unsloth-qwen38-27b.json'))!;
    expect(findVariant(d, 'Qwen3.8-27B-Q8_0.gguf')?.label).toBe('Q8_0');
    expect(findVariant(d, 'q8_0')?.label).toBe('Q8_0');
    expect(findVariant(d, ' UD-IQ4_XS ')?.label).toBe('UD-IQ4_XS');
    expect(findVariant(d, 'nope')).toBeUndefined();
    const dup = { ...d.variants[0], id: 'zz/' + d.variants[0].files[0], files: ['zz/' + d.variants[0].files[0]] };
    const bad = { ...dup, unsupported: 'x' };
    const detail = { ...d, variants: [bad, d.variants[0]] };
    expect(findVariant(detail, d.variants[0].label)?.unsupported).toBeUndefined();
  });
});

describe('hub.* RPC', () => {
  function handlersFor(overrides: Partial<CoreContext> = {}) {
    const ctx = { settings, dataDir: dir, modelBrowser: build(), gpu: { status: () => gpu, catalog: () => [] }, ...overrides } as unknown as CoreContext;
    return createRpcHandlers(ctx);
  }

  it('hub.search maps params and returns the result', async () => {
    const h = handlersFor();
    const r = (await dispatchRpc(h, 'hub.search', { query: 'qwen', sort: 'trendingScore', limit: 5, cursor: 'c1', pipelineTag: 'image-text-to-text', refresh: true })) as { models: unknown[] };
    expect(r.models).toHaveLength(3);
    const u = new URL(calls[0]);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ search: 'qwen', sort: 'trendingScore', limit: '5', cursor: 'c1', pipeline_tag: 'image-text-to-text' });
    await dispatchRpc(h, 'hub.search', {}); // defaults
    await dispatchRpc(h, 'hub.search', undefined);
    expect(calls).toHaveLength(2); // the second plain search is a cache hit of the first plain one
  });

  it('hub.search validates sort and pipelineTag', async () => {
    const h = handlersFor();
    await expect(dispatchRpc(h, 'hub.search', { sort: 'popularity' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.search', { pipelineTag: 'audio' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.search', { limit: 'ten' })).rejects.toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(0);
  });

  it('hub.details, hub.addModel, hub.removeModel and hub.setFavorite', async () => {
    const h = handlersFor();
    const d = (await dispatchRpc(h, 'hub.details', { repo: QWEN })) as { repo: string };
    expect(d.repo).toBe(QWEN);
    const m = (await dispatchRpc(h, 'hub.addModel', { repo: QWEN, quant: 'UD-Q5_K_XL', withVision: true })) as { id: string; mmproj: string; source: string };
    expect(m).toMatchObject({ source: 'user', mmproj: 'mmproj-F16.gguf' });
    expect(settings.get().vast.userModels.map((x) => x.id)).toEqual([m.id]);
    expect(await dispatchRpc(h, 'hub.setFavorite', { repo: QWEN, favorite: true })).toEqual({ favorites: [QWEN] });
    expect(await dispatchRpc(h, 'hub.removeModel', { id: m.id })).toEqual({ ok: true });
    expect(settings.get().vast.userModels).toEqual([]);
  });

  it('params are validated', async () => {
    const h = handlersFor();
    await expect(dispatchRpc(h, 'hub.details', {})).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.addModel', { repo: QWEN })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.removeModel', {})).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.setFavorite', { repo: QWEN })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.setFavorite', { repo: QWEN, favorite: 'yes' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(dispatchRpc(h, 'hub.details', [])).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('Hugging Face and refusal errors keep their friendly message and carry a code', async () => {
    const h = handlersFor();
    respond = () => new Response('', { status: 429, headers: { 'retry-after': '30' } });
    const e1: any = await dispatchRpc(h, 'hub.search', { query: 'x' }).catch((x: any) => x);
    expect(e1).toBeInstanceOf(RpcError);
    expect(e1).toMatchObject({ code: 'rate_limited' });
    expect(e1.message).toMatch(/Try again in 30 s/);

    respond = () => new Response('', { status: 401 });
    const e2: any = await dispatchRpc(h, 'hub.details', { repo: 'ghost/Nothing-GGUF' }).catch((x: any) => x);
    expect(e2).toMatchObject({ code: 'not_found' });
    expect(e2.message).toMatch(/Could not find "ghost\/Nothing-GGUF"/);

    respond = () => ok({ ...fx('detail-unsloth-qwen38-27b.json'), gated: 'auto' });
    const e3: any = await dispatchRpc(h, 'hub.addModel', { repo: QWEN, quant: 'Q8_0' }).catch((x: any) => x);
    expect(e3).toMatchObject({ code: 'invalid' });
    expect(e3.message).toMatch(/gated/);

    const e4: any = await dispatchRpc(h, 'hub.removeModel', { id: 'qwen38-27b-standard-unsloth-q8' }).catch((x: any) => x);
    expect(e4).toMatchObject({ code: 'builtin' });
  });

  it('without a model browser every hub method says it is unavailable', async () => {
    const h = handlersFor({ modelBrowser: undefined });
    for (const [m, p] of [['hub.search', {}], ['hub.details', { repo: QWEN }], ['hub.addModel', { repo: QWEN, quant: 'Q8_0' }], ['hub.removeModel', { id: 'x' }], ['hub.setFavorite', { repo: QWEN, favorite: true }]] as const) {
      await expect(dispatchRpc(h, m, p), m).rejects.toMatchObject({ code: 'unavailable' });
    }
  });

  it('settings.update cannot smuggle a hostile model past the validation', async () => {
    const h = handlersFor();
    const evil = { id: 'hf-evil', label: 'x', family: 'f', variant: 'standard', repo: 'a/b', files: ['$(id).gguf'], sizeGb: 1, minTotalVramGb: 4, contextLength: 8192, llamaArgs: [], profiles: [] };
    const s = (await dispatchRpc(h, 'settings.update', { patch: { vast: { userModels: [evil], favoriteRepos: ['x;y/z'] } } })) as { vast: { userModels: unknown[]; favoriteRepos: string[] } };
    expect(s.vast.userModels).toEqual([]);
    expect(s.vast.favoriteRepos).toEqual([]);
    expect(userCatalogModels()).toEqual([]);
  });
});
