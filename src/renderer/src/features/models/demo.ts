// Demo-mode data for the Models view (loaded automatically with ?demo=1). Owner: ui-views.
// The responses are real, recorded from the public Hugging Face API (see ./demo-fixtures) and run through the same
// parsing, VRAM planning and model building the core uses, so the demo works offline and behaves like the real thing.
//   ?hub=error → every Hugging Face call fails with a rate-limit message (the error state of the list and the detail pane)
//   ?hub=slow  → Hugging Face answers after ~2 s (loading skeletons)
import type { HubModelDetail, HubModelSummary, HubSearchResult, HubSort } from '@shared/hub';
import { DEFAULT_GPU_PROFILES } from '@shared/gpu-profiles';
import { findVariant, isValidRepoId, parseModelDetail, parseModelSummary } from '@shared/hub-parse';
import type { CatalogModel, Settings } from '@shared/types';
import { buildUserModel, MAX_USER_MODELS, UserModelError, withCurrentProfiles } from '@shared/user-models';
import { registerDemoHandler, type DemoContext } from '@renderer/lib/demo';
import { RpcError } from '@renderer/lib/rpc';
import details from './demo-fixtures/details.json';
import hits from './demo-fixtures/hits.json';

type RawDetails = Record<string, { pipeline_tag?: string }>;

const rawDetails = details as unknown as RawDetails;
const SUMMARIES: HubModelSummary[] = (hits as unknown[])
  .map((h) => parseModelSummary(h))
  .filter((m): m is HubModelSummary => m !== null)
  .map((m) => ({ ...m, pipelineTag: m.pipelineTag ?? rawDetails[m.repo]?.pipeline_tag }));

const mode = (): string | null => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('hub');
  } catch {
    return null;
  }
};

async function gate(ctx: DemoContext, method: string): Promise<void> {
  if (mode() === 'slow') await ctx.sleep(2000);
  else await ctx.sleep(220);
  if (mode() === 'error') throw new RpcError('Hugging Face is limiting requests right now. Try again in 28 s.', 'rate_limited', method);
}

function detailFor(repo: string): HubModelDetail {
  const raw = (details as unknown as Record<string, unknown>)[repo];
  const d = raw ? parseModelDetail(raw) : null;
  if (!d) {
    throw new RpcError(`Could not find "${repo}" on Hugging Face. It may be private, gated, renamed or deleted. (Demo mode only has recorded details for ${Object.keys(details).length} repos.)`, 'not_found', 'hub.details');
  }
  return { ...d, pipelineTag: d.pipelineTag ?? rawDetails[repo]?.pipeline_tag };
}

function sortKey(m: HubModelSummary, sort: HubSort): number {
  switch (sort) {
    case 'likes':
      return m.likes;
    case 'lastModified':
      return Date.parse(m.lastModified ?? '') || 0;
    case 'trendingScore':
      // no trending data in the recordings: likes per day since creation is a fair stand-in
      return m.likes / Math.max(1, (Date.now() - (Date.parse(m.createdAt ?? '') || Date.now())) / 86_400_000);
    default:
      return m.downloads;
  }
}

registerDemoHandler('hub.search', async (p, ctx): Promise<HubSearchResult> => {
  await gate(ctx, 'hub.search');
  const words = (p.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  let list = SUMMARIES.filter((m) => words.every((w) => m.repo.toLowerCase().includes(w)));
  if (p.pipelineTag) list = list.filter((m) => m.pipelineTag === p.pipelineTag);
  const sort = p.sort ?? 'downloads';
  list = [...list].sort((a, b) => sortKey(b, sort) - sortKey(a, sort));
  const limit = Math.max(1, Math.min(100, p.limit ?? 30));
  const offset = Math.max(0, Number(p.cursor) || 0);
  const page = list.slice(offset, offset + limit);
  const next = offset + limit < list.length ? String(offset + limit) : undefined;
  return { models: page, nextCursor: next, fetchedAt: ctx.now(), cached: false };
});

registerDemoHandler('hub.details', async (p, ctx) => {
  await gate(ctx, 'hub.details');
  if (!isValidRepoId(p.repo)) throw new RpcError(`"${p.repo}" is not a Hugging Face repo id. Use the form owner/name.`, 'invalid_repo', 'hub.details');
  return detailFor(p.repo);
});

function patchVast(ctx: DemoContext, patch: Partial<Settings['vast']>): Settings {
  const cur = ctx.data.settings;
  const next = { ...cur, vast: { ...cur.vast, ...patch } } as Settings;
  ctx.data.settings = next;
  ctx.emit('settings.updated', next);
  return next;
}

/** The demo's catalog is data.catalog: built-ins as given, user models appended with their profiles kept current. */
function syncCatalog(ctx: DemoContext): void {
  const s = ctx.data.settings.vast;
  const builtin = ctx.data.catalog.filter((m) => m.source !== 'user');
  ctx.data.catalog = [...builtin, ...withCurrentProfiles(s.userModels, s.profiles)];
}

registerDemoHandler('hub.addModel', async (p, ctx): Promise<CatalogModel> => {
  await gate(ctx, 'hub.addModel');
  const detail = detailFor(p.repo);
  const variant = findVariant(detail, p.quant);
  if (!variant) throw new RpcError(`${p.repo} has no quant "${p.quant}".`, 'not_found', 'hub.addModel');
  let model: CatalogModel;
  try {
    model = buildUserModel({ detail, variant, withVision: p.withVision === true, profiles: ctx.data.settings.vast.profiles });
  } catch (err) {
    if (err instanceof UserModelError) throw new RpcError(err.message, 'invalid', 'hub.addModel');
    throw err;
  }
  const others = ctx.data.settings.vast.userModels.filter((m) => m.id !== model.id);
  if (others.length >= MAX_USER_MODELS) throw new RpcError(`You can keep at most ${MAX_USER_MODELS} added models.`, 'limit', 'hub.addModel');
  patchVast(ctx, { userModels: [...others, model] });
  syncCatalog(ctx);
  return model;
});

registerDemoHandler('hub.removeModel', async (p, ctx) => {
  await ctx.sleep(120);
  const s = ctx.data.settings.vast;
  if (!s.userModels.some((m) => m.id === p.id)) {
    if (ctx.data.catalog.some((m) => m.id === p.id)) throw new RpcError('Recommended models are built in and cannot be removed.', 'builtin', 'hub.removeModel');
    throw new RpcError(`No added model "${p.id}".`, 'not_found', 'hub.removeModel');
  }
  const profiles = s.profiles.map((pr) => {
    if (pr.defaultModelId !== p.id) return pr;
    const shipped = DEFAULT_GPU_PROFILES.find((d) => d.id === pr.id)?.defaultModelId;
    return shipped ? { ...pr, defaultModelId: shipped } : pr;
  });
  patchVast(ctx, { userModels: s.userModels.filter((m) => m.id !== p.id), profiles });
  syncCatalog(ctx);
  return { ok: true as const };
});

registerDemoHandler('hub.setFavorite', async (p, ctx) => {
  if (!isValidRepoId(p.repo)) throw new RpcError(`"${p.repo}" is not a Hugging Face repo id.`, 'invalid', 'hub.setFavorite');
  const cur = ctx.data.settings.vast.favoriteRepos;
  const next = p.favorite ? [p.repo, ...cur.filter((r) => r !== p.repo)] : cur.filter((r) => r !== p.repo);
  patchVast(ctx, { favoriteRepos: next });
  return { favorites: next };
});

// gpu.catalog: the built-ins are tagged like the real core does, user models follow them.
registerDemoHandler('gpu.catalog', async (_p, ctx) => {
  const all = (await ctx.fallback()) as CatalogModel[];
  return all.map((m) => ({ ...m, source: m.source ?? ('builtin' as const) }));
});
