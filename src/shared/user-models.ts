// Models the user adds from Hugging Face (pure; shared by the core and by the renderer's demo mode).
//
//   buildUserModel(detail, variant, ...)  a picked quant variant -> a CatalogModel (id from repo + quant, VRAM and context
//                                         planned by model-fit.ts, no extra llama args)
//   sanitizeUserModels(raw)               everything read back from settings.json / settings.update goes through here:
//                                         repo and file names must match safe patterns, sizes must be positive, unknown
//                                         keys are dropped. These values end up in config.sh on the rented server and in
//                                         download URLs, so a hand-edited or hostile entry must not get through.

import type { HubMmproj, HubModelDetail, HubQuantVariant } from './hub';
import { isSafeGgufPath, isValidRepoId, toGb } from './hub-parse';
import { planFit, profilesFitting, type FitProfile } from './model-fit';
import type { CatalogModel } from './types';

export const MAX_USER_MODELS = 200;
export const MAX_FAVORITE_REPOS = 500;

export type UserModelErrorCode = 'invalid' | 'gated' | 'no_vision' | 'size_unknown' | 'unsupported';

/** A friendly, user-facing reason a model cannot be added. */
export class UserModelError extends Error {
  constructor(
    readonly code: UserModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserModelError';
  }
}

// ───────────────────────────── ids and labels ─────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const QUANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL_RE = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_RE = /[\u0000-\u001f\u007f]/; // no g flag: .test() on a global regex keeps state between calls

/** Lower-case letters, digits, '.', '_' and '-' only; runs of anything else become one '-'. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
}

/** 32-bit FNV-1a as 6+ base-36 chars: a short, stable disambiguator (not a security hash). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0');
}

/**
 * Catalog id of a user model: `hf-<owner>-<name>-<quant>`, safe characters only, at most 100 long (longer names are cut
 * and given a hash suffix). The same repo + quant always gives the same id, so adding it again replaces the entry.
 * `disambiguator` (the variant's first file) is only passed when a repo has two variants with the same quant label.
 */
export function userModelId(repo: string, quant: string, disambiguator?: string): string {
  const base = slug(`hf-${repo.replace('/', '-')}-${quant}`);
  const extra = disambiguator ? `-${shortHash(disambiguator)}` : '';
  if (base.length + extra.length <= 100) return base + extra;
  return `${base.slice(0, 80).replace(/[-._]+$/, '')}-${shortHash(`${repo}|${quant}|${disambiguator ?? ''}`)}${extra}`;
}

/** "Qwen3.8-27B-GGUF" -> "Qwen3.8-27B". */
export function repoDisplayName(repo: string): string {
  const name = repo.slice(repo.indexOf('/') + 1);
  return name.replace(/[-_.]?gguf$/i, '') || name;
}

const UNCENSORED_RE = /uncensor|abliterat|heretic|unfiltered|\bnsfw\b/i;

/** Heuristic for the Uncensored / Standard toggle of the model picker. */
export function guessVariant(repo: string): 'uncensored' | 'standard' {
  return UNCENSORED_RE.test(repo) ? 'uncensored' : 'standard';
}

/** The vision projector to use: F16 first (supported everywhere), then BF16, Q8_0, F32, then the smallest. */
export function pickMmproj(mmprojs: readonly HubMmproj[]): HubMmproj | undefined {
  const order = ['F16', 'BF16', 'Q8_0', 'F32'];
  const rank = (m: HubMmproj): number => {
    const i = order.indexOf(m.label.toUpperCase());
    return i < 0 ? order.length : i;
  };
  return [...mmprojs].sort((a, b) => rank(a) - rank(b) || a.sizeBytes - b.sizeBytes || (a.file < b.file ? -1 : 1))[0];
}

// ───────────────────────────── build ─────────────────────────────

export interface BuildUserModelInput {
  detail: HubModelDetail;
  variant: HubQuantVariant;
  /** Download the vision projector as well. */
  withVision?: boolean;
  /** The GPU profiles the model is planned against (Settings.vast.profiles). */
  profiles: readonly FitProfile[];
  /** YYYY-MM-DD; defaults to today. */
  today?: string;
}

/** A picked variant -> catalog entry. Throws UserModelError with a message fit to show the user. */
export function buildUserModel(input: BuildUserModelInput): CatalogModel {
  const { detail, variant } = input;
  if (!isValidRepoId(detail.repo)) throw new UserModelError('invalid', `"${detail.repo}" is not a Hugging Face repo id.`);
  if (detail.gated) {
    throw new UserModelError(
      'gated',
      `${detail.repo} is gated: Hugging Face asks for a login and an accepted licence before it lets anyone download it, and the rented GPU server has no login. Pick a repo that is not gated (many models have open GGUF re-uploads).`,
    );
  }
  if (variant.unsupported) throw new UserModelError('unsupported', variant.unsupported);
  if (variant.files.length === 0 || !variant.files.every(isSafeGgufPath)) {
    throw new UserModelError('unsupported', 'This quant has file names the GPU server cannot download.');
  }
  if (!variant.sizeKnown || variant.sizeBytes <= 0) {
    throw new UserModelError('size_unknown', 'Hugging Face did not report the file sizes of this quant, so the download and VRAM cannot be planned. Try again in a moment.');
  }

  let mmproj: HubMmproj | undefined;
  if (input.withVision) {
    mmproj = pickMmproj(detail.mmprojs);
    if (!mmproj) throw new UserModelError('no_vision', `${detail.repo} has no vision projector (mmproj file).`);
  }
  const totalBytes = variant.sizeBytes + (mmproj?.sizeBytes ?? 0);
  const sizeGb = toGb(totalBytes);
  const fit = planFit({ sizeGb, ggufContext: detail.contextLength, totalParams: detail.totalParams, vision: !!mmproj, profiles: input.profiles });

  const quant = variant.label;
  const name = repoDisplayName(detail.repo);
  const sameLabel = detail.variants.filter((v) => v.label === quant).length > 1;
  const model: CatalogModel = {
    id: userModelId(detail.repo, quant, sameLabel ? variant.id : undefined),
    label: `${name} - ${quant} - ${detail.author}`.slice(0, 160),
    family: `hf-${slug(name).slice(0, 90) || 'model'}`,
    variant: guessVariant(detail.repo),
    repo: detail.repo,
    files: [...variant.files],
    sizeGb,
    minTotalVramGb: fit.minTotalVramGb,
    contextLength: fit.contextLength,
    llamaArgs: [],
    profiles: fit.profiles,
    notes: `Added from huggingface.co/${detail.repo}${detail.license ? ` (licence: ${detail.license})` : ''}. Context length and VRAM are estimates.`.slice(0, 500),
    verifiedAt: input.today ?? new Date().toISOString().slice(0, 10),
    source: 'user',
    quant: QUANT_RE.test(quant) ? quant : 'unknown',
  };
  if (mmproj) model.mmproj = mmproj.file;
  return model;
}

// ───────────────────────────── sanitize ─────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROL_ALL_RE, ' ').trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function finite(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/** One stored user model, or null when it is not a valid one. `reservedIds` = built-in ids a user model must not shadow. */
export function sanitizeUserModel(raw: unknown, reservedIds?: ReadonlySet<string>): CatalogModel | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
  if (!id || reservedIds?.has(id)) return null;
  const repo = typeof raw.repo === 'string' && isValidRepoId(raw.repo) ? raw.repo : null;
  if (!repo) return null;
  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 200) return null;
  const files = raw.files.filter(isSafeGgufPath);
  if (files.length !== raw.files.length || new Set(files).size !== files.length) return null;
  const mmproj = raw.mmproj === undefined || raw.mmproj === null || raw.mmproj === '' ? undefined : isSafeGgufPath(raw.mmproj) ? raw.mmproj : null;
  if (mmproj === null) return null;
  const sizeGb = finite(raw.sizeGb, 0.001, 5000);
  const minTotalVramGb = finite(raw.minTotalVramGb, 0.001, 5000);
  const contextLength = finite(raw.contextLength, 512, 4_194_304);
  if (sizeGb === undefined || minTotalVramGb === undefined || contextLength === undefined) return null;
  const label = text(raw.label, 160) ?? repo;

  const m: CatalogModel = {
    id,
    label,
    family: typeof raw.family === 'string' && FAMILY_RE.test(raw.family) ? raw.family : `hf-${slug(repo.slice(repo.indexOf('/') + 1)).slice(0, 90) || 'model'}`,
    variant: raw.variant === 'uncensored' ? 'uncensored' : 'standard',
    repo,
    files,
    sizeGb: Math.round(sizeGb * 100) / 100,
    minTotalVramGb: Math.ceil(minTotalVramGb),
    contextLength: Math.round(contextLength),
    llamaArgs: Array.isArray(raw.llamaArgs)
      ? raw.llamaArgs.map((a) => (typeof a === 'string' && a.length > 0 && a.length <= 300 && !HAS_CONTROL_RE.test(a) ? a : null)).filter((a): a is string => a !== null).slice(0, 40)
      : [],
    profiles: Array.isArray(raw.profiles) ? [...new Set(raw.profiles.filter((p): p is string => typeof p === 'string' && PROFILE_ID_RE.test(p)))].slice(0, 50) : [],
    source: 'user',
  };
  if (mmproj) m.mmproj = mmproj;
  const notes = text(raw.notes, 500);
  if (notes) m.notes = notes;
  if (raw.experimental === true) m.experimental = true;
  if (typeof raw.verifiedAt === 'string' && DATE_RE.test(raw.verifiedAt)) m.verifiedAt = raw.verifiedAt;
  if (typeof raw.quant === 'string' && QUANT_RE.test(raw.quant)) m.quant = raw.quant;
  return m;
}

/** Valid, unique-by-id user models (first one wins), at most MAX_USER_MODELS. Anything else in the list is dropped. */
export function sanitizeUserModels(raw: unknown, reservedIds?: ReadonlySet<string>): CatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const m = sanitizeUserModel(item, reservedIds);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
    if (out.length >= MAX_USER_MODELS) break;
  }
  return out;
}

/** Valid, unique repo ids, order kept, at most MAX_FAVORITE_REPOS. */
export function sanitizeFavoriteRepos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r === 'string' && isValidRepoId(r) && !out.includes(r)) out.push(r);
    if (out.length >= MAX_FAVORITE_REPOS) break;
  }
  return out;
}

/** The same models with `profiles` recomputed against the current profile list (profiles can be edited after a model was added). */
export function withCurrentProfiles(models: readonly CatalogModel[], profiles: readonly FitProfile[]): CatalogModel[] {
  return models.map((m) => ({ ...m, profiles: profilesFitting(m.minTotalVramGb, profiles) }));
}
