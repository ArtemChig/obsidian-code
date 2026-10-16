// The demo core answers hub.* from recorded Hugging Face responses (features/models/demo.ts): /?demo=1 works offline and
// goes through the same parsing, VRAM planning and model building as the real core.
import { beforeAll, describe, expect, it } from 'vitest';
import '@renderer/features/gpu/demo';
import '@renderer/features/models/demo';
import { createDemoTransport } from '@renderer/lib/demo';
import { rpc } from '@renderer/lib/rpc';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { bindEvents } from '@renderer/state/sync';
import { loadGpuCatalog } from '@renderer/state/actions';

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const QWEN = 'unsloth/Qwen3.8-27B-GGUF';

describe('the demo model browser', () => {
  beforeAll(async () => {
    bindEvents();
    const t = createDemoTransport({ latencyMs: 0, speed: 0 });
    rpc.setTransport(t);
    t.connect();
    await waitFor(() => useConnection.getState().ready);
  });

  it('lists the recorded repos, most downloaded first, with the facts the list shows', async () => {
    const r = await rpc.request('hub.search', {});
    expect(r.models.length).toBeGreaterThanOrEqual(8);
    expect(r.cached).toBe(false);
    const dl = r.models.map((m) => m.downloads);
    expect(dl).toEqual([...dl].sort((a, b) => b - a));
    const top = r.models.find((m) => m.repo === QWEN)!;
    expect(top).toMatchObject({ author: 'unsloth', name: 'Qwen3.8-27B-GGUF', license: 'apache-2.0', hasVision: true });
    expect(top.quantLabels).toContain('UD-Q4_K_XL');
    expect(top.downloads).toBeGreaterThan(1_000_000);
  });

  it('searches by words, sorts, filters by task and pages', async () => {
    const gemma = await rpc.request('hub.search', { query: 'gemma' });
    expect(gemma.models.length).toBeGreaterThanOrEqual(2);
    expect(gemma.models.every((m) => m.repo.toLowerCase().includes('gemma'))).toBe(true);
    expect((await rpc.request('hub.search', { query: 'qwen3.8 unsloth' })).models.every((m) => /unsloth/.test(m.repo) && /qwen3\.8/i.test(m.repo))).toBe(true);
    expect((await rpc.request('hub.search', { query: 'nonexistentmodelname' })).models).toEqual([]);

    const byLikes = await rpc.request('hub.search', { sort: 'likes' });
    const likes = byLikes.models.map((m) => m.likes);
    expect(likes).toEqual([...likes].sort((a, b) => b - a));
    const byDate = await rpc.request('hub.search', { sort: 'lastModified' });
    const dates = byDate.models.map((m) => Date.parse(m.lastModified ?? ''));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));

    const text = await rpc.request('hub.search', { pipelineTag: 'text-generation' });
    expect(text.models.every((m) => m.pipelineTag === 'text-generation')).toBe(true);

    const p1 = await rpc.request('hub.search', { limit: 4 });
    expect(p1.models).toHaveLength(4);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await rpc.request('hub.search', { limit: 4, cursor: p1.nextCursor });
    const all = await rpc.request('hub.search', { limit: 100 });
    expect([...p1.models, ...p2.models].map((m) => m.repo)).toEqual(all.models.slice(0, 8).map((m) => m.repo));
    expect(all.nextCursor).toBeUndefined();
  });

  it('details: variants with sizes, the vision projector, the GGUF header facts; unknown repos fail friendly', async () => {
    const d = await rpc.request('hub.details', { repo: QWEN });
    expect(d).toMatchObject({ repo: QWEN, architecture: 'qwen35', contextLength: 262144 });
    expect(d.variants.length).toBeGreaterThan(20);
    expect(d.variants.every((v) => v.sizeKnown)).toBe(true);
    expect(d.mmprojs.length).toBeGreaterThan(0);
    await expect(rpc.request('hub.details', { repo: 'nobody/unrecorded-GGUF' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(rpc.request('hub.details', { repo: 'not a repo' })).rejects.toMatchObject({ code: 'invalid_repo' });
  });

  it('adds a model: it joins the catalog as a user model, tagged apart from the built-in ones', async () => {
    await loadGpuCatalog(true, true);
    const before = useGpu.getState().catalog!;
    expect(before.every((m) => m.source === 'builtin')).toBe(true);

    const m = await rpc.request('hub.addModel', { repo: QWEN, quant: 'UD-Q4_K_XL', withVision: true });
    expect(m).toMatchObject({ id: 'hf-unsloth-qwen3.8-27b-gguf-ud-q4_k_xl', source: 'user', repo: QWEN, mmproj: 'mmproj-F16.gguf', llamaArgs: [] });
    expect(m.profiles).toEqual(['light', 'standard', 'max']);

    // settings.updated arrives and the stores follow: the model is in the settings and, after the refetch, the catalog
    await waitFor(() => (useSettings.getState().settings?.vast.userModels.length ?? 0) === 1);
    await waitFor(() => useGpu.getState().catalog?.some((x) => x.id === m.id) === true);
    const cat = useGpu.getState().catalog!;
    expect(cat).toHaveLength(before.length + 1);
    expect(cat.filter((x) => x.source === 'user').map((x) => x.id)).toEqual([m.id]);
    expect(cat.filter((x) => x.source === 'builtin')).toHaveLength(before.length);

    // adding it again replaces it
    await rpc.request('hub.addModel', { repo: QWEN, quant: 'UD-Q4_K_XL' });
    expect(useSettings.getState().settings!.vast.userModels).toHaveLength(1);
  });

  it('refuses what the real core refuses', async () => {
    await expect(rpc.request('hub.addModel', { repo: QWEN, quant: 'Q9_Z' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(rpc.request('hub.addModel', { repo: 'nobody/unrecorded-GGUF', quant: 'Q8_0' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(rpc.request('hub.removeModel', { id: 'qwen38-27b-standard-unsloth-q8' })).rejects.toMatchObject({ code: 'builtin' });
    await expect(rpc.request('hub.removeModel', { id: 'hf-nothing' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(rpc.request('hub.setFavorite', { repo: 'bad', favorite: true })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('favorites keep the newest first', async () => {
    const start = useSettings.getState().settings!.vast.favoriteRepos;
    expect(start.length).toBeGreaterThan(0);
    const on = await rpc.request('hub.setFavorite', { repo: 'unsloth/gemma-4-12b-it-GGUF', favorite: true });
    expect(on.favorites[0]).toBe('unsloth/gemma-4-12b-it-GGUF');
    const off = await rpc.request('hub.setFavorite', { repo: 'unsloth/gemma-4-12b-it-GGUF', favorite: false });
    expect(off.favorites).toEqual(start);
    await waitFor(() => useSettings.getState().settings!.vast.favoriteRepos.length === start.length);
  });

  it('removing an added model resets a profile default that pointed at it', async () => {
    const id = 'hf-unsloth-qwen3.8-27b-gguf-ud-q4_k_xl';
    const s = useSettings.getState().settings!;
    const profiles = s.vast.profiles.map((p) => (p.id === 'light' ? { ...p, defaultModelId: id } : p));
    await rpc.request('settings.update', { patch: { vast: { ...s.vast, profiles } } });
    await waitFor(() => useSettings.getState().settings!.vast.profiles.find((p) => p.id === 'light')!.defaultModelId === id);

    expect(await rpc.request('hub.removeModel', { id })).toEqual({ ok: true });
    await waitFor(() => (useSettings.getState().settings?.vast.userModels.length ?? 1) === 0);
    expect(useSettings.getState().settings!.vast.profiles.find((p) => p.id === 'light')!.defaultModelId).toBe('qwen38-27b-uncensored-hauhau-q5kp');
    await waitFor(() => useGpu.getState().catalog?.every((x) => x.source === 'builtin') === true);
  });
});
