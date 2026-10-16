// Pure helpers for the Models view (browse Hugging Face, favorites, added models, recommended). Owner: ui-views.
import type { HubModelDetail, HubModelSummary, HubPipelineTag, HubQuantVariant, HubSort } from '@shared/hub';
import { DEFAULT_GPU_PROFILES } from '@shared/gpu-profiles';
import { isValidRepoId, parseRepoRef, recommendVariant } from '@shared/hub-parse';
import { planFit, profileCapacityGb, type ModelFit } from '@shared/model-fit';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { pickMmproj } from '@shared/user-models';

// ───────────────────────────── Search controls ─────────────────────────────

export const SORT_OPTIONS: { value: HubSort; label: string }[] = [
  { value: 'downloads', label: 'Most downloads' },
  { value: 'likes', label: 'Most likes' },
  { value: 'lastModified', label: 'Recently updated' },
  { value: 'trendingScore', label: 'Trending' },
];

export type TypeFilter = 'all' | HubPipelineTag;

export const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All GGUF' },
  { value: 'text-generation', label: 'Text' },
  { value: 'image-text-to-text', label: 'Vision + text' },
];

export function sortLabel(sort: HubSort): string {
  return SORT_OPTIONS.find((o) => o.value === sort)?.label ?? sort;
}

/** The text of the search box as a direct repo reference ("owner/name", a huggingface.co URL, "owner/name:Q4_K_M"), else null. */
export function directRepo(query: string): { repo: string; quant?: string } | null {
  const q = query.trim();
  if (!q || /\s/.test(q)) return null;
  const ref = parseRepoRef(q);
  return ref && isValidRepoId(ref.repo) ? ref : null;
}

// ───────────────────────────── Formatting ─────────────────────────────

/** 999 -> "999", 1234 -> "1.2k", 25_300 -> "25k", 999_999 -> "1M", 6_663_225 -> "6.7M". */
export function compactCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(Math.round(n));
  const units = ['k', 'M', 'B'];
  let v = n;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  let r = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  if (r >= 1000 && i < units.length - 1) {
    r = 1;
    i++;
  }
  return `${r}${units[i]}`;
}

/** Parameter count: 27_320_697_856 -> "27.3B", 800_000_000 -> "0.8B", 320_759_404_382 -> "321B". */
export function formatParams(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  const b = n / 1e9;
  if (b >= 100) return `${Math.round(b)}B`;
  if (b >= 10) return `${(Math.round(b * 10) / 10).toString()}B`;
  if (b >= 1) return `${(Math.round(b * 10) / 10).toString()}B`;
  return `${(Math.round(b * 100) / 100).toString()}B`;
}

/** 262144 -> "262k", 131072 -> "131k", 1048576 -> "1M". */
export function formatContext(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_048_576)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/** "17.6 GB", "0.93 GB" (decimal, like the download size). */
export function formatGb(gb: number | null | undefined): string {
  if (gb == null || !Number.isFinite(gb)) return '—';
  return `${gb >= 100 ? Math.round(gb) : gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
}

export function repoUrl(repo: string): string {
  return `https://huggingface.co/${repo}`;
}

export function splitRepo(repo: string): { author: string; name: string } {
  const i = repo.indexOf('/');
  return i < 0 ? { author: '', name: repo } : { author: repo.slice(0, i), name: repo.slice(i + 1) };
}

export function parseIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ───────────────────────────── Profiles & fit ─────────────────────────────

/** "Light, Standard and Max" / "Standard and Max" / "none of your profiles". */
export function fitSummary(profileIds: readonly string[], profiles: readonly Pick<GpuProfile, 'id' | 'label'>[]): string {
  const labels = profileIds.map((id) => profiles.find((p) => p.id === id)?.label ?? id);
  if (labels.length === 0) return 'none of your profiles';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The smallest profile (by VRAM) that fits, for "needs at least ...". */
export function smallestFitting(profileIds: readonly string[], profiles: readonly GpuProfile[]): GpuProfile | undefined {
  return profiles.filter((p) => profileIds.includes(p.id)).sort((a, b) => profileCapacityGb(a) - profileCapacityGb(b))[0];
}

export interface VariantRow {
  variant: HubQuantVariant;
  /** Planned context / VRAM / fitting profiles for this variant (with the vision projector when selected). */
  fit: ModelFit;
  /** Download size including the vision projector when it is selected. */
  sizeGb: number;
  /** Fits the profile picked in the view. */
  fitsSelected: boolean;
  /** The catalog model this variant already is, when the user added it. */
  added: CatalogModel | null;
  /** Can be added (sizes known, file names supported, repo not gated). */
  addable: boolean;
  /** Why it cannot be added. */
  reason?: string;
  recommended: boolean;
}

/** The user's added model that is this variant of this repo, if any (matched on repo + first file). */
export function addedModelFor(userModels: readonly CatalogModel[], repo: string, variant: Pick<HubQuantVariant, 'files'>): CatalogModel | null {
  return userModels.find((m) => m.repo === repo && m.files[0] === variant.files[0]) ?? null;
}

export function mmprojFor(detail: Pick<HubModelDetail, 'mmprojs'>) {
  return pickMmproj(detail.mmprojs);
}

export interface RowOptions {
  profiles: readonly GpuProfile[];
  /** The profile the view is "fitting for". */
  profileId: string;
  withVision: boolean;
  userModels: readonly CatalogModel[];
}

/** One row per quant variant (smallest first, as the hub client sorts them), with fit, added state and the recommended pick. */
export function buildVariantRows(detail: HubModelDetail, o: RowOptions): VariantRow[] {
  const mm = o.withVision ? mmprojFor(detail) : undefined;
  const fitProfiles = o.profiles.map((p) => ({ id: p.id, numGpus: p.numGpus, minGpuRamGb: p.minGpuRamGb }));
  const rows: VariantRow[] = detail.variants.map((variant) => {
    const sizeGb = Math.round((variant.sizeGb + (mm?.sizeGb ?? 0)) * 100) / 100;
    const fit = planFit({ sizeGb, ggufContext: detail.contextLength, totalParams: detail.totalParams, vision: !!mm, profiles: fitProfiles });
    let reason: string | undefined;
    if (detail.gated) reason = 'Gated repo: Hugging Face needs a login the rented server does not have.';
    else if (variant.unsupported) reason = variant.unsupported;
    else if (!variant.sizeKnown) reason = 'Hugging Face did not report the sizes of these files.';
    return {
      variant,
      fit,
      sizeGb,
      fitsSelected: fit.profiles.includes(o.profileId),
      added: addedModelFor(o.userModels, detail.repo, variant),
      addable: reason === undefined,
      reason,
      recommended: false,
    };
  });
  const pick = recommendedVariant(rows);
  return rows.map((r) => ({ ...r, recommended: pick !== undefined && r.variant.id === pick.id }));
}

/** The sweet-spot quant that fits the selected profile (Q4_K_M-ish first), among the addable ones. */
export function recommendedVariant(rows: readonly VariantRow[]): HubQuantVariant | undefined {
  const pool = rows.filter((r) => r.addable && r.fitsSelected).map((r) => r.variant);
  return recommendVariant(pool);
}

/** Add button state of a row. */
export type AddState = 'add' | 'added' | 'blocked';

export function addState(row: Pick<VariantRow, 'added' | 'addable'>): AddState {
  if (row.added) return 'added';
  return row.addable ? 'add' : 'blocked';
}

// ───────────────────────────── Added models & defaults ─────────────────────────────

/** Profiles that use `modelId` as their default model. */
export function profilesDefaultingTo(profiles: readonly GpuProfile[], modelId: string): GpuProfile[] {
  return profiles.filter((p) => p.defaultModelId === modelId);
}

/** The id a profile's default model goes back to ("Restore default"); undefined for a profile the app does not ship. */
export function shippedDefaultId(profileId: string): string | undefined {
  return DEFAULT_GPU_PROFILES.find((p) => p.id === profileId)?.defaultModelId;
}

/** Profiles whose default model was changed from the shipped one. */
export function changedDefaults(profiles: readonly GpuProfile[]): { profile: GpuProfile; shippedId: string }[] {
  const out: { profile: GpuProfile; shippedId: string }[] = [];
  for (const profile of profiles) {
    const shippedId = shippedDefaultId(profile.id);
    if (shippedId && profile.defaultModelId !== shippedId) out.push({ profile, shippedId });
  }
  return out;
}

/** Copy of `profiles` with one profile's default model replaced. */
export function withDefaultModel(profiles: readonly GpuProfile[], profileId: string, modelId: string): GpuProfile[] {
  return profiles.map((p) => (p.id === profileId ? { ...p, defaultModelId: modelId } : p));
}

/** Profiles a model can be made the default of: the ones it fits. */
export function defaultTargets(model: Pick<CatalogModel, 'profiles'>, profiles: readonly GpuProfile[]): GpuProfile[] {
  return profiles.filter((p) => model.profiles.includes(p.id));
}

// ───────────────────────────── Result rows ─────────────────────────────

/** A one-line "author/name" split for the list, plus whether the user already added a quant of this repo. */
export function addedCountFor(userModels: readonly CatalogModel[], repo: string): number {
  return userModels.filter((m) => m.repo === repo).length;
}

/** Tags worth a badge on the detail pane: the repo's quant count, vision and a gated flag first, then its own tags. */
export function detailBadges(d: Pick<HubModelSummary, 'hasVision' | 'gated' | 'quantLabels' | 'pipelineTag' | 'tags'>): string[] {
  const out: string[] = [];
  if (d.pipelineTag) out.push(d.pipelineTag);
  if (d.hasVision && d.pipelineTag !== 'image-text-to-text') out.push('vision');
  for (const t of d.tags) if (!out.includes(t)) out.push(t);
  return out.slice(0, 10);
}

/** Merge a next page into the list without duplicates (a cursor page can repeat a repo when the ranking shifts). */
export function mergePages(prev: readonly HubModelSummary[], next: readonly HubModelSummary[]): HubModelSummary[] {
  const seen = new Set(prev.map((m) => m.repo));
  return [...prev, ...next.filter((m) => !seen.has(m.repo))];
}
