// Models view state + actions (zustand): Hugging Face search/paging, repo details, favorites, add/remove, profile defaults.
// Everything that talks to the core goes through the typed hub.* RPC methods; failures toast and leave the view usable.
import { create } from 'zustand';
import type { HubModelDetail, HubModelSummary, HubQuantVariant, HubSort } from '@shared/hub';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { loadGpuCatalog, updateSettings } from '@renderer/state/actions';
import { useSettings } from '@renderer/state/settings';
import { toast } from '@renderer/state/toasts';
import { mergePages, shippedDefaultId, withDefaultModel, type TypeFilter } from './model';

export type ModelsTab = 'browse' | 'favorites' | 'mine' | 'recommended';

export interface DetailEntry {
  status: 'loading' | 'ready' | 'error';
  data?: HubModelDetail;
  error?: string;
}

export interface ModelsStore {
  tab: ModelsTab;
  query: string;
  sort: HubSort;
  type: TypeFilter;
  results: HubModelSummary[];
  nextCursor?: string;
  /** idle = never searched; loading = first page; more = next page. */
  status: 'idle' | 'loading' | 'more' | 'ready' | 'error';
  error?: string;
  /** The shown results are older than the cache lifetime because Hugging Face could not be reached. */
  stale: boolean;
  fetchedAt?: number;
  /** Repo shown in the detail pane (Browse and Favorites share it). */
  selected: string | null;
  details: Record<string, DetailEntry>;
  /** Profile the quant table is fitted against ("fits Light"). null = the default GPU profile. */
  fitProfileId: string | null;
  withVision: boolean;
  /** Variant ids being added / model ids being removed right now. */
  busy: Record<string, boolean>;
}

const initial = (): ModelsStore => ({
  tab: 'browse',
  query: '',
  sort: 'downloads',
  type: 'all',
  results: [],
  nextCursor: undefined,
  status: 'idle',
  error: undefined,
  stale: false,
  fetchedAt: undefined,
  selected: null,
  details: {},
  fitProfileId: null,
  withVision: true,
  busy: {},
});

export const useModels = create<ModelsStore>(initial);

/** Test helper: back to a fresh store. */
export function resetModelsStore(): void {
  cancelScheduledSearch();
  searchToken++;
  useModels.setState(initial(), true);
}

const set = (patch: Partial<ModelsStore> | ((s: ModelsStore) => Partial<ModelsStore>)): void => useModels.setState(patch);

// ───────────────────────────── Search ─────────────────────────────

let searchToken = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
export const SEARCH_DEBOUNCE_MS = 350;

function cancelScheduledSearch(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** Run the search for the current query/sort/type (first page). A newer search makes older answers irrelevant. */
export async function runSearch(opts: { refresh?: boolean } = {}): Promise<void> {
  cancelScheduledSearch();
  const token = ++searchToken;
  const { query, sort, type } = useModels.getState();
  set({ status: 'loading', error: undefined });
  try {
    const r = await rpc.request('hub.search', {
      query: query.trim() || undefined,
      sort,
      pipelineTag: type === 'all' ? undefined : type,
      limit: 30,
      refresh: opts.refresh || undefined,
    });
    if (token !== searchToken) return;
    set({ results: r.models, nextCursor: r.nextCursor, status: 'ready', stale: !!r.stale, fetchedAt: r.fetchedAt, error: undefined });
  } catch (err) {
    if (token !== searchToken) return;
    set({ status: 'error', error: errorMessage(err) });
  }
}

/** Debounced search while typing. */
export function scheduleSearch(): void {
  cancelScheduledSearch();
  timer = setTimeout(() => {
    timer = undefined;
    void runSearch();
  }, SEARCH_DEBOUNCE_MS);
}

export async function loadMore(): Promise<void> {
  const s = useModels.getState();
  if (!s.nextCursor || s.status === 'loading' || s.status === 'more') return;
  const token = ++searchToken;
  set({ status: 'more' });
  try {
    const r = await rpc.request('hub.search', {
      query: s.query.trim() || undefined,
      sort: s.sort,
      pipelineTag: s.type === 'all' ? undefined : s.type,
      limit: 30,
      cursor: s.nextCursor,
    });
    if (token !== searchToken) return;
    set((cur) => ({ results: mergePages(cur.results, r.models), nextCursor: r.nextCursor, status: 'ready', stale: !!r.stale }));
  } catch (err) {
    if (token !== searchToken) return;
    set({ status: 'ready' });
    toast({ title: 'Could not load more models', body: errorMessage(err), level: 'error' });
  }
}

export function setQuery(query: string): void {
  set({ query });
  scheduleSearch();
}

export function setSort(sort: HubSort): void {
  set({ sort });
  void runSearch();
}

export function setType(type: TypeFilter): void {
  set({ type });
  void runSearch();
}

/** Switch tabs. The open repo is closed: in a narrow window it would otherwise hide the new tab's list behind its detail. */
export function setTab(tab: ModelsTab): void {
  if (tab === useModels.getState().tab) return;
  set({ tab, selected: null });
}

// ───────────────────────────── Details ─────────────────────────────

/** Select a repo for the detail pane and load its details (cached in the store for the session). */
export function selectRepo(repo: string | null): void {
  set({ selected: repo });
  if (repo) void loadDetails(repo);
}

export async function loadDetails(repo: string, opts: { refresh?: boolean } = {}): Promise<void> {
  const cur = useModels.getState().details[repo];
  if (!opts.refresh && (cur?.status === 'ready' || cur?.status === 'loading')) return;
  set((s) => ({ details: { ...s.details, [repo]: { status: 'loading', data: cur?.data } } }));
  try {
    const data = await rpc.request('hub.details', { repo, refresh: opts.refresh || undefined });
    set((s) => ({ details: { ...s.details, [repo]: { status: 'ready', data } } }));
  } catch (err) {
    set((s) => ({ details: { ...s.details, [repo]: { status: 'error', error: errorMessage(err), data: cur?.data } } }));
  }
}

// ───────────────────────────── Favorites ─────────────────────────────

export async function toggleFavorite(repo: string): Promise<void> {
  const favorites = useSettings.getState().settings?.vast.favoriteRepos ?? [];
  const favorite = !favorites.includes(repo);
  try {
    const r = await rpc.request('hub.setFavorite', { repo, favorite });
    // The settings.updated event carries the same list; this keeps the star right even before it arrives.
    useSettings.setState((st) => (st.settings ? { settings: { ...st.settings, vast: { ...st.settings.vast, favoriteRepos: r.favorites } } } : st));
  } catch (err) {
    toast({ title: favorite ? 'Could not add the favorite' : 'Could not remove the favorite', body: errorMessage(err), level: 'error' });
  }
}

// ───────────────────────────── Add / remove ─────────────────────────────

/** Add a quant for GPU clock-ins. Resolves to the new catalog entry, or null (the failure is toasted). */
export async function addVariant(repo: string, variant: Pick<HubQuantVariant, 'id' | 'label'>, withVision: boolean): Promise<CatalogModel | null> {
  const key = `add:${repo}:${variant.id}`;
  set((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    const m = await rpc.request('hub.addModel', { repo, quant: variant.id, withVision });
    toast({ title: 'Model added', body: `${m.label} is in your list. Pick it in the GPU view to clock in with it.`, level: 'success' });
    void loadGpuCatalog(true, true);
    return m;
  } catch (err) {
    toast({ title: 'Could not add the model', body: errorMessage(err), level: 'error' });
    return null;
  } finally {
    set((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

export async function removeAdded(id: string): Promise<boolean> {
  const key = `rm:${id}`;
  set((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    await rpc.request('hub.removeModel', { id });
    void loadGpuCatalog(true, true);
    return true;
  } catch (err) {
    toast({ title: 'Could not remove the model', body: errorMessage(err), level: 'error' });
    return false;
  } finally {
    set((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

// ───────────────────────────── Profile defaults ─────────────────────────────

function profiles(): GpuProfile[] {
  return useSettings.getState().settings?.vast.profiles ?? [];
}

/** Make `modelId` the model a profile clocks in with by default. */
export async function setProfileDefault(profileId: string, modelId: string): Promise<boolean> {
  const next = withDefaultModel(profiles(), profileId, modelId);
  const ok = await updateSettings({ vast: { profiles: next } } as never);
  return ok !== null;
}

/** Put a profile's default back to the one the app ships with. */
export async function restoreProfileDefault(profileId: string): Promise<boolean> {
  const shipped = shippedDefaultId(profileId);
  if (!shipped) return false;
  return setProfileDefault(profileId, shipped);
}
