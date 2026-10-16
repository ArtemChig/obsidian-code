// Model browser service (owner: gpu): the core side of the Models view.
//   search / details   Hugging Face (src/core/gpu/hub.ts), cached
//   addModel           a picked quant variant -> a CatalogModel in Settings.vast.userModels (planned VRAM + context)
//   removeModel        takes it out again (never a built-in, never one a clocked-in or parked instance uses)
//   setFavorite        Settings.vast.favoriteRepos
// Everything persistent lives in the settings store, which re-validates it (src/shared/user-models.ts), so the GPU
// manager, the scheduler and `gpu.catalog` see the same list (core/index.ts registers it with the catalog).

import type { ModelBrowserApi, SettingsStore } from '../contracts';
import type { HubModelDetail, HubSearchParams, HubSearchResult } from '../../shared/hub';
import { findVariant, isValidRepoId } from '../../shared/hub-parse';

export { findVariant };
import type { CatalogModel, GpuProfile, GpuStatus, Settings } from '../../shared/types';
import { buildUserModel, MAX_FAVORITE_REPOS, MAX_USER_MODELS, UserModelError } from '../../shared/user-models';
import { builtinCatalogModels, setUserCatalogModels } from './catalog';
import { HubClient } from './hub';
import { DEFAULT_GPU_PROFILES } from './profiles';

export type ModelBrowserErrorCode = 'invalid' | 'not_found' | 'builtin' | 'in_use' | 'limit';

/** A refusal with a message fit to show the user (the RPC layer sends `code` along). */
export class ModelBrowserError extends Error {
  constructor(
    readonly code: ModelBrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelBrowserError';
  }
}

export interface ModelBrowserOptions {
  settings: SettingsStore;
  hub?: HubClient;
  /** Live GPU status, to refuse removing the model an instance is using. */
  gpuStatus?: () => Pick<GpuStatus, 'phase' | 'modelId' | 'parked'>;
  /** Names of the scheduled tasks that run on this model: removing it would make them fail unattended. */
  usedBy?: (modelId: string) => string[];
  /** YYYY-MM-DD stamped on added models (tests). */
  today?: () => string;
}

/** What a profile's default model becomes when the user's model it pointed at is removed: the shipped default, else the first built-in for it. */
export function restoredDefaultModelId(profile: Pick<GpuProfile, 'id' | 'defaultModelId'>): string {
  const shipped = DEFAULT_GPU_PROFILES.find((p) => p.id === profile.id);
  if (shipped) return shipped.defaultModelId;
  const first = builtinCatalogModels().find((m) => m.profiles.includes(profile.id) && m.family !== 'test');
  return first?.id ?? profile.defaultModelId;
}

/**
 * Keep the catalog's user models in sync with Settings.vast.userModels (and the profiles they are planned against):
 * once now, then on every settings change. Register it BEFORE the listener that pushes `settings.updated` to clients,
 * so a client that refetches `gpu.catalog` on that event sees the new list. Returns the unsubscribe function (it also
 * empties the user models again).
 */
export function bindUserCatalog(settings: Pick<SettingsStore, 'get' | 'onChange'>): () => void {
  const sync = (s: Settings): void => setUserCatalogModels(s.vast.userModels, s.vast.profiles);
  sync(settings.get());
  const off = settings.onChange(sync);
  return () => {
    off();
    setUserCatalogModels([]); // the catalog is process-wide: do not leak this core's models into the next one
  };
}

export function createModelBrowser(opts: ModelBrowserOptions): ModelBrowserApi {
  const hub = opts.hub ?? new HubClient();
  const { settings } = opts;
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));

  // The settings store deep-merges `vast`, so a partial object is fine at runtime; the type just does not know that.
  const patchVast = (patch: Partial<Settings['vast']>): Settings => settings.update({ vast: patch as Settings['vast'] });

  const search = (params: HubSearchParams, o?: { refresh?: boolean }): Promise<HubSearchResult> => hub.search(params, o);
  const details = (repo: string, o?: { refresh?: boolean }): Promise<HubModelDetail> => hub.details(repo, o);

  const addModel = async (p: { repo: string; quant: string; withVision?: boolean }): Promise<CatalogModel> => {
    const repo = String(p.repo ?? '').trim();
    const quant = String(p.quant ?? '').trim();
    if (!isValidRepoId(repo)) throw new ModelBrowserError('invalid', `"${repo}" is not a Hugging Face repo id. Use the form owner/name.`);
    if (!quant) throw new ModelBrowserError('invalid', 'Pick a quant to add.');
    const detail = await hub.details(repo);
    const variant = findVariant(detail, quant);
    if (!variant) {
      const have = [...new Set(detail.variants.map((v) => v.label))].join(', ') || 'none';
      throw new ModelBrowserError('not_found', `${repo} has no quant "${quant}". Available: ${have}.`);
    }
    // Everything below is synchronous: no other add/remove can interleave between reading and writing the settings.
    const s = settings.get();
    let model: CatalogModel;
    try {
      model = buildUserModel({ detail, variant, withVision: p.withVision === true, profiles: s.vast.profiles, today: today() });
    } catch (err) {
      if (err instanceof UserModelError) throw new ModelBrowserError('invalid', err.message);
      throw err;
    }
    const others = s.vast.userModels.filter((m) => m.id !== model.id);
    if (others.length >= MAX_USER_MODELS) {
      throw new ModelBrowserError('limit', `You can keep at most ${MAX_USER_MODELS} added models. Remove some first.`);
    }
    patchVast({ userModels: [...others, model] });
    return model;
  };

  const removeModel = (id: string): void => {
    const s = settings.get();
    const model = s.vast.userModels.find((m) => m.id === id);
    if (!model) {
      if (builtinCatalogModels().some((m) => m.id === id)) {
        throw new ModelBrowserError('builtin', 'Recommended models are built in and cannot be removed.');
      }
      throw new ModelBrowserError('not_found', `No added model "${id}".`);
    }
    const st = opts.gpuStatus?.();
    const busy = !!st && ((st.modelId === id && st.phase !== 'off' && st.phase !== 'error') || st.parked?.modelId === id);
    if (busy) {
      throw new ModelBrowserError('in_use', `${model.label} is in use by the GPU right now. Clock out (and discard the parked instance) first.`);
    }
    const tasks = opts.usedBy?.(id) ?? [];
    if (tasks.length > 0) {
      const names = tasks.slice(0, 3).map((n) => `"${n}"`).join(', ') + (tasks.length > 3 ? ` and ${tasks.length - 3} more` : '');
      throw new ModelBrowserError('in_use', `${model.label} is used by the scheduled task${tasks.length === 1 ? '' : 's'} ${names}. Change the model of ${tasks.length === 1 ? 'that task' : 'those tasks'} first.`);
    }
    // A profile that used it as its default goes back to the shipped default, so clock-in never points at a model that is gone.
    const profiles = s.vast.profiles.map((p) => (p.defaultModelId === id ? { ...p, defaultModelId: restoredDefaultModelId(p) } : p));
    patchVast({ userModels: s.vast.userModels.filter((m) => m.id !== id), profiles });
  };

  const setFavorite = (repo: string, favorite: boolean): string[] => {
    const r = String(repo ?? '').trim();
    if (!isValidRepoId(r)) throw new ModelBrowserError('invalid', `"${r}" is not a Hugging Face repo id.`);
    const cur = settings.get().vast.favoriteRepos;
    if (favorite === cur.includes(r)) return cur;
    const next = favorite ? [r, ...cur].slice(0, MAX_FAVORITE_REPOS) : cur.filter((x) => x !== r);
    return patchVast({ favoriteRepos: next }).vast.favoriteRepos;
  };

  return { search, details, addModel, removeModel, setFavorite };
}
