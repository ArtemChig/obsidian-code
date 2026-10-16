// Models view store (features/models/store.ts) against a controllable fake transport: request parameters, out-of-order
// answers, paging, debounce, caching of details, favorites, add/remove and the profile defaults. Mock transport only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreEventName, CoreEvents, RpcMethod, RpcParams, RpcResult } from '@shared/protocol';
import type { HubModelDetail, HubModelSummary } from '@shared/hub';
import type { CatalogModel, Settings } from '@shared/types';
import {
  SEARCH_DEBOUNCE_MS,
  addVariant,
  loadDetails,
  loadMore,
  removeAdded,
  resetModelsStore,
  restoreProfileDefault,
  runSearch,
  selectRepo,
  setProfileDefault,
  setQuery,
  setSort,
  setTab,
  setType,
  toggleFavorite,
  useModels,
} from '@renderer/features/models/store';
import { DEMO_SETTINGS } from '@renderer/lib/demo-data';
import { RpcError, rpc, type RpcTransport } from '@renderer/lib/rpc';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { bindEvents, catalogInputsKey } from '@renderer/state/sync';
import { useToasts } from '@renderer/state/toasts';

// ───────────────────────────── fake transport ─────────────────────────────

type Handler = (params: unknown) => unknown | Promise<unknown>;

interface Fake extends RpcTransport {
  calls: { method: string; params: unknown }[];
  handlers: Record<string, Handler>;
  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void;
  callsOf(method: string): unknown[];
}

function fakeTransport(): Fake {
  const anyListeners = new Set<(e: CoreEventName, d: unknown) => void>();
  const t = {
    kind: 'demo' as const,
    calls: [] as { method: string; params: unknown }[],
    handlers: {} as Record<string, Handler>,
    async request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      t.calls.push({ method, params });
      const h = t.handlers[method];
      if (!h) throw new RpcError(`no fake handler for ${method}`, 'fake', method);
      return (await h(params)) as RpcResult<M>;
    },
    on: () => () => undefined,
    onAny(fn: (e: CoreEventName, d: unknown) => void) {
      anyListeners.add(fn);
      return () => anyListeners.delete(fn);
    },
    onStatus: () => () => undefined,
    onConnected: () => () => undefined,
    getState: () => ({ status: 'open', attempt: 0, nextRetryAt: null, lastError: null, everConnected: true }),
    connect: () => undefined,
    retryNow: () => undefined,
    close: () => undefined,
    emit(event: CoreEventName, data: unknown) {
      for (const fn of anyListeners) fn(event, data);
    },
    callsOf: (method: string) => t.calls.filter((c) => c.method === method).map((c) => c.params),
  };
  return t as unknown as Fake;
}

const summary = (repo: string, over: Partial<HubModelSummary> = {}): HubModelSummary => ({
  repo,
  author: repo.split('/')[0],
  name: repo.split('/')[1],
  downloads: 10,
  likes: 1,
  gated: false,
  baseModels: [],
  tags: [],
  quantLabels: [],
  hasVision: false,
  ...over,
});

const detail = (repo: string): HubModelDetail => ({ ...summary(repo), variants: [], mmprojs: [], drafts: [], warnings: [] });

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const settings = (over: Partial<Settings['vast']> = {}): Settings => ({ ...structuredClone(DEMO_SETTINGS), vast: { ...structuredClone(DEMO_SETTINGS.vast), ...over } });

let t: Fake;

beforeEach(() => {
  t = fakeTransport();
  rpc.setTransport(t);
  resetModelsStore();
  useToasts.setState({ toasts: [] });
  useSettings.setState({ settings: settings({ favoriteRepos: ['a/fav'] }) });
  useGpu.setState({ catalog: null });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────── search ─────────────────────────────

describe('search', () => {
  it('asks the core with the current controls; empty query and type "all" are left out', async () => {
    t.handlers['hub.search'] = () => ({ models: [summary('a/b')], fetchedAt: 5, cached: false });
    await runSearch();
    expect(t.callsOf('hub.search')).toEqual([{ query: undefined, sort: 'downloads', pipelineTag: undefined, limit: 30, refresh: undefined }]);
    useModels.setState({ query: '  qwen coder ', sort: 'likes', type: 'text-generation' });
    await runSearch({ refresh: true });
    expect(t.callsOf('hub.search')[1]).toEqual({ query: 'qwen coder', sort: 'likes', pipelineTag: 'text-generation', limit: 30, refresh: true });
  });

  it('stores results, the cursor, the stale flag and the fetch time', async () => {
    t.handlers['hub.search'] = () => ({ models: [summary('a/b'), summary('c/d')], nextCursor: 'cur1', fetchedAt: 1234, cached: true, stale: true });
    const p = runSearch();
    expect(useModels.getState().status).toBe('loading');
    await p;
    const s = useModels.getState();
    expect(s.status).toBe('ready');
    expect(s.results.map((m) => m.repo)).toEqual(['a/b', 'c/d']);
    expect(s.nextCursor).toBe('cur1');
    expect(s.stale).toBe(true);
    expect(s.fetchedAt).toBe(1234);
    expect(s.error).toBeUndefined();
  });

  it('an older answer that arrives late never overwrites a newer search', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let n = 0;
    t.handlers['hub.search'] = () => (++n === 1 ? first.promise : second.promise);
    const p1 = runSearch();
    const p2 = runSearch();
    second.resolve({ models: [summary('new/one')], fetchedAt: 2, cached: false });
    await p2;
    first.resolve({ models: [summary('old/one')], fetchedAt: 1, cached: false });
    await p1;
    expect(useModels.getState().results.map((m) => m.repo)).toEqual(['new/one']);
    expect(useModels.getState().status).toBe('ready');
  });

  it('a failure shows the message; the next success clears it', async () => {
    t.handlers['hub.search'] = () => {
      throw new RpcError('Hugging Face is limiting requests right now. Try again in 28 s.', 'rate_limited');
    };
    await runSearch();
    expect(useModels.getState()).toMatchObject({ status: 'error', error: 'Hugging Face is limiting requests right now. Try again in 28 s.' });
    t.handlers['hub.search'] = () => ({ models: [summary('a/b')], fetchedAt: 1, cached: false });
    await runSearch();
    expect(useModels.getState()).toMatchObject({ status: 'ready', error: undefined });
  });

  it('typing is debounced into one search; sort and type search at once', async () => {
    vi.useFakeTimers();
    t.handlers['hub.search'] = () => ({ models: [], fetchedAt: 1, cached: false });
    setQuery('q');
    setQuery('qw');
    setQuery('qwe');
    expect(t.callsOf('hub.search')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 10);
    expect(t.callsOf('hub.search')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(t.callsOf('hub.search')).toHaveLength(1);
    expect((t.callsOf('hub.search')[0] as { query: string }).query).toBe('qwe');
    setSort('likes');
    setType('image-text-to-text');
    expect(t.callsOf('hub.search')).toHaveLength(3);
    expect(t.callsOf('hub.search')[2]).toMatchObject({ sort: 'likes', pipelineTag: 'image-text-to-text' });
    // an explicit search cancels a pending debounced one
    setQuery('abc');
    void runSearch();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    expect(t.callsOf('hub.search')).toHaveLength(4);
  });

  it('load more appends the next page without duplicates, using the cursor', async () => {
    t.handlers['hub.search'] = (p) =>
      (p as { cursor?: string }).cursor
        ? { models: [summary('a/2'), summary('a/3')], fetchedAt: 2, cached: false }
        : { models: [summary('a/1'), summary('a/2')], nextCursor: 'next', fetchedAt: 1, cached: false };
    await runSearch();
    const more = loadMore();
    expect(useModels.getState().status).toBe('more');
    await more;
    expect(useModels.getState().results.map((m) => m.repo)).toEqual(['a/1', 'a/2', 'a/3']);
    expect(useModels.getState().nextCursor).toBeUndefined();
    expect(t.callsOf('hub.search')[1]).toMatchObject({ cursor: 'next', limit: 30 });
    // nothing more to load: no request
    await loadMore();
    expect(t.callsOf('hub.search')).toHaveLength(2);
  });

  it('load more does nothing while a search is running, and a failure toasts but keeps the list', async () => {
    useModels.setState({ results: [summary('a/1')], nextCursor: 'c', status: 'loading' });
    await loadMore();
    expect(t.callsOf('hub.search')).toHaveLength(0);
    useModels.setState({ status: 'ready' });
    t.handlers['hub.search'] = () => {
      throw new RpcError('Hugging Face is having trouble right now (HTTP 503). Try again in a moment.');
    };
    await loadMore();
    expect(useModels.getState().status).toBe('ready');
    expect(useModels.getState().results).toHaveLength(1);
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ level: 'error', title: 'Could not load more models' });
  });
});

// ───────────────────────────── details ─────────────────────────────

describe('details', () => {
  it('loads once, dedupes concurrent loads, and refresh forces a new request', async () => {
    const d = deferred<HubModelDetail>();
    t.handlers['hub.details'] = () => d.promise;
    const a = loadDetails('a/b');
    const b = loadDetails('a/b');
    expect(useModels.getState().details['a/b']?.status).toBe('loading');
    d.resolve(detail('a/b'));
    await Promise.all([a, b]);
    expect(t.callsOf('hub.details')).toHaveLength(1);
    expect(useModels.getState().details['a/b']).toMatchObject({ status: 'ready' });
    await loadDetails('a/b');
    expect(t.callsOf('hub.details')).toHaveLength(1);
    t.handlers['hub.details'] = () => detail('a/b');
    await loadDetails('a/b', { refresh: true });
    expect(t.callsOf('hub.details')).toHaveLength(2);
    expect(t.callsOf('hub.details')[1]).toEqual({ repo: 'a/b', refresh: true });
  });

  it('an error is kept per repo (with the earlier data, if any) and can be retried', async () => {
    t.handlers['hub.details'] = () => detail('a/b');
    await loadDetails('a/b');
    t.handlers['hub.details'] = () => {
      throw new RpcError('Hugging Face did not answer within 15 s. Try again.');
    };
    await loadDetails('a/b', { refresh: true });
    const e = useModels.getState().details['a/b'];
    expect(e).toMatchObject({ status: 'error', error: 'Hugging Face did not answer within 15 s. Try again.' });
    expect(e.data?.repo).toBe('a/b');
    t.handlers['hub.details'] = () => detail('a/b');
    await loadDetails('a/b'); // an errored entry is loaded again
    expect(useModels.getState().details['a/b'].status).toBe('ready');
  });

  it('selecting a repo loads its details; clearing the selection does not', async () => {
    t.handlers['hub.details'] = () => detail('x/y');
    selectRepo('x/y');
    expect(useModels.getState().selected).toBe('x/y');
    await waitFor(() => useModels.getState().details['x/y']?.status === 'ready');
    selectRepo(null);
    expect(useModels.getState().selected).toBeNull();
    expect(t.callsOf('hub.details')).toHaveLength(1);
  });

  it('setTab switches the tab and closes the open repo (it would hide the next list in a narrow window)', () => {
    useModels.setState({ selected: 'a/b' });
    setTab('favorites');
    expect(useModels.getState()).toMatchObject({ tab: 'favorites', selected: null });
    useModels.setState({ selected: 'a/b' });
    setTab('favorites'); // same tab: nothing changes
    expect(useModels.getState().selected).toBe('a/b');
  });
});

// ───────────────────────────── favorites ─────────────────────────────

describe('favorites', () => {
  it('toggles against the list in the settings and updates it from the answer', async () => {
    t.handlers['hub.setFavorite'] = (p) => ({ favorites: (p as { favorite: boolean; repo: string }).favorite ? ['x/new', 'a/fav'] : [] });
    await toggleFavorite('x/new');
    expect(t.callsOf('hub.setFavorite')).toEqual([{ repo: 'x/new', favorite: true }]);
    expect(useSettings.getState().settings!.vast.favoriteRepos).toEqual(['x/new', 'a/fav']);
    await toggleFavorite('a/fav');
    expect(t.callsOf('hub.setFavorite')[1]).toEqual({ repo: 'a/fav', favorite: false });
    expect(useSettings.getState().settings!.vast.favoriteRepos).toEqual([]);
  });

  it('a failure toasts and leaves the list alone', async () => {
    t.handlers['hub.setFavorite'] = () => {
      throw new RpcError('"x" is not a Hugging Face repo id.');
    };
    await toggleFavorite('x/new');
    expect(useSettings.getState().settings!.vast.favoriteRepos).toEqual(['a/fav']);
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ level: 'error', title: 'Could not add the favorite' });
  });
});

// ───────────────────────────── add / remove ─────────────────────────────

const added = (id = 'hf-x'): CatalogModel => ({
  id, label: 'X - Q4_K_M - a', family: 'hf-x', variant: 'standard', repo: 'a/x', files: ['x.gguf'], sizeGb: 5, minTotalVramGb: 10, contextLength: 32768, llamaArgs: [], profiles: ['light'], source: 'user', quant: 'Q4_K_M',
});

describe('add and remove', () => {
  it('adds a variant by id with the vision choice, toasts, refreshes the catalog and clears the busy flag', async () => {
    t.handlers['hub.addModel'] = async () => {
      expect(Object.keys(useModels.getState().busy)).toEqual(['add:a/x:Q4/x-00001-of-00002.gguf']);
      return added();
    };
    t.handlers['gpu.catalog'] = () => [added()];
    const m = await addVariant('a/x', { id: 'Q4/x-00001-of-00002.gguf', label: 'Q4_K_M' }, true);
    expect(m?.id).toBe('hf-x');
    expect(t.callsOf('hub.addModel')).toEqual([{ repo: 'a/x', quant: 'Q4/x-00001-of-00002.gguf', withVision: true }]);
    expect(useModels.getState().busy).toEqual({});
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ level: 'success', title: 'Model added' });
    await waitFor(() => (useGpu.getState().catalog?.length ?? 0) === 1);
  });

  it('a refusal (gated repo, no projector ...) toasts its reason and returns null', async () => {
    t.handlers['hub.addModel'] = () => {
      throw new RpcError('unsloth/x is gated: Hugging Face asks for a login ...', 'invalid');
    };
    expect(await addVariant('a/x', { id: 'x.gguf', label: 'Q4_K_M' }, false)).toBeNull();
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ level: 'error', title: 'Could not add the model', body: expect.stringContaining('gated') });
    expect(useModels.getState().busy).toEqual({});
  });

  it('removes a model, refreshing the catalog; a refusal toasts', async () => {
    t.handlers['hub.removeModel'] = () => ({ ok: true });
    t.handlers['gpu.catalog'] = () => [];
    useGpu.setState({ catalog: [added()] });
    expect(await removeAdded('hf-x')).toBe(true);
    expect(t.callsOf('hub.removeModel')).toEqual([{ id: 'hf-x' }]);
    await waitFor(() => useGpu.getState().catalog?.length === 0);
    t.handlers['hub.removeModel'] = () => {
      throw new RpcError('hf-x is in use by the GPU right now. Clock out first.', 'in_use');
    };
    expect(await removeAdded('hf-x')).toBe(false);
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ level: 'error', title: 'Could not remove the model' });
    expect(useModels.getState().busy).toEqual({});
  });
});

// ───────────────────────────── profile defaults ─────────────────────────────

describe('profile defaults', () => {
  beforeEach(() => {
    t.handlers['settings.update'] = (p) => {
      const patch = (p as { patch: { vast: { profiles: Settings['vast']['profiles'] } } }).patch;
      return { ...useSettings.getState().settings!, vast: { ...useSettings.getState().settings!.vast, ...patch.vast } };
    };
  });

  it('sets one profile default and keeps the others', async () => {
    expect(await setProfileDefault('standard', 'hf-x')).toBe(true);
    const sent = (t.callsOf('settings.update')[0] as { patch: { vast: { profiles: { id: string; defaultModelId: string }[] } } }).patch.vast.profiles;
    expect(sent.find((p) => p.id === 'standard')!.defaultModelId).toBe('hf-x');
    expect(sent.find((p) => p.id === 'light')!.defaultModelId).toBe('qwen38-27b-uncensored-hauhau-q5kp');
    expect(useSettings.getState().settings!.vast.profiles.find((p) => p.id === 'standard')!.defaultModelId).toBe('hf-x');
  });

  it('restores the shipped default; a profile the app does not ship has none to restore', async () => {
    await setProfileDefault('light', 'hf-x');
    expect(await restoreProfileDefault('light')).toBe(true);
    expect(useSettings.getState().settings!.vast.profiles.find((p) => p.id === 'light')!.defaultModelId).toBe('qwen38-27b-uncensored-hauhau-q5kp');
    const before = t.callsOf('settings.update').length;
    expect(await restoreProfileDefault('custom')).toBe(false);
    expect(t.callsOf('settings.update')).toHaveLength(before);
  });

  it('a failed save returns false', async () => {
    t.handlers['settings.update'] = () => {
      throw new RpcError('disk full');
    };
    expect(await setProfileDefault('light', 'hf-x')).toBe(false);
  });
});

// ───────────────────────────── gpu catalog follows the settings ─────────────────────────────

describe('catalog refresh on settings.updated', () => {
  it('catalogInputsKey only changes with the added models or the profiles hardware', () => {
    const base = settings();
    const key = catalogInputsKey(base);
    expect(catalogInputsKey(settings({ monthlyBudget: 999, favoriteRepos: ['x/y'] }))).toBe(key); // unrelated
    expect(catalogInputsKey(settings({ userModels: [added()] }))).not.toBe(key);
    const bigger = settings();
    bigger.vast.profiles[0] = { ...bigger.vast.profiles[0], minGpuRamGb: 48 };
    expect(catalogInputsKey(bigger)).not.toBe(key);
    const renamed = settings();
    renamed.vast.profiles[0] = { ...renamed.vast.profiles[0], defaultModelId: 'hf-x', label: 'Renamed' };
    expect(catalogInputsKey(renamed)).toBe(key); // a default or a label does not change any model's fit
    expect(catalogInputsKey(null)).toBe('');
  });

  it('refetches a loaded catalog when a model was added or removed, and leaves it alone otherwise', async () => {
    const off = bindEvents();
    try {
      t.handlers['gpu.catalog'] = () => [added()];
      // catalog not loaded yet: nothing to refresh
      t.emit('settings.updated', settings({ userModels: [added()] }));
      await new Promise((r) => setTimeout(r, 10));
      expect(t.callsOf('gpu.catalog')).toHaveLength(0);

      // the catalog is loaded now, and the settings the app holds have no added models
      useSettings.setState({ settings: settings() });
      useGpu.setState({ catalog: [] });
      t.emit('settings.updated', settings({ userModels: [added()] }));
      await waitFor(() => useGpu.getState().catalog?.length === 1);
      expect(t.callsOf('gpu.catalog')).toHaveLength(1);

      // an unrelated settings change: no refetch
      t.emit('settings.updated', settings({ userModels: [added()], monthlyBudget: 5 }));
      await new Promise((r) => setTimeout(r, 10));
      expect(t.callsOf('gpu.catalog')).toHaveLength(1);
      expect(useSettings.getState().settings!.vast.monthlyBudget).toBe(5);

      t.handlers['gpu.catalog'] = () => [];
      t.emit('settings.updated', settings({ userModels: [] }));
      await waitFor(() => useGpu.getState().catalog?.length === 0);
    } finally {
      off();
    }
  });
});
