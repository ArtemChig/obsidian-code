// VRAM and context planning for models added from Hugging Face (pure; the core stores the result when a model is added,
// the Models view shows the same numbers per quant variant).
//
// A rented GPU that cannot load the model costs real money, so the estimate leans safe. The bootstrap still has its
// load fallback (smaller context, no vision, no KV quantisation) for the cases where a guess is off.
//
//   need(ctx) = weights + overhead + KV cache(ctx)
//   weights   = the download size (all files, incl. the vision projector, the same figure as CatalogModel.sizeGb)
//   overhead  = 1.5 GB (CUDA context, compute buffers) + 2 % of the weights (+ 0.6 GB when vision is on)
//   KV cache  = ctx / 1024 x (0.045 + 0.0022 x billions of parameters) GB, capped at 0.4 GB per 1k tokens, for the q8_0
//               cache the server uses. Dense 8B/27B/70B models land within ~25 % of the real figure; MoE and hybrid
//               (linear attention) models need less than this, so for them the plan is conservative.

/** The part of a GPU profile the plan needs. */
export interface FitProfile {
  id: string;
  numGpus: number;
  minGpuRamGb: number;
}

/** Context lengths a plan chooses from. */
export const STANDARD_CONTEXTS: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
/** Used when the GGUF header's context length is unknown. */
export const DEFAULT_CONTEXT_CAP = 131072;
/** Never plan beyond this, even for 1M-token models: the KV cache would not fit anything we rent. */
export const MAX_PLANNED_CONTEXT = 262144;
/**
 * The smallest context a plan settles for. A coding agent's system prompt and tool definitions alone take ~15k tokens,
 * so a profile that could only serve 8k or 16k is not offered for the model; the next bigger profile is.
 */
const MIN_USABLE_CONTEXT = 32768;

/**
 * Nominal VRAM of a profile: Vast reports 30 for a 32 GB card and 90 for a 96 GB one, so the minimum is rounded up to
 * the next multiple of 8 per GPU (the same figure the catalog's minTotalVramGb values are written against).
 */
export function profileCapacityGb(p: Pick<FitProfile, 'numGpus' | 'minGpuRamGb'>): number {
  return p.numGpus * Math.ceil(p.minGpuRamGb / 8) * 8;
}

/** Billions of parameters: from the GGUF header when known, else guessed from the download size (~4.8 bits/weight). */
export function estimateParamsB(sizeGb: number, totalParams?: number): number {
  if (totalParams && Number.isFinite(totalParams) && totalParams > 0) return totalParams / 1e9;
  return Math.max(0.1, (sizeGb * 8) / 4.8);
}

/** Estimated q8_0 KV cache in GB for `contextLength` tokens. */
export function kvCacheGb(contextLength: number, paramsB: number): number {
  const per1k = Math.min(0.4, 0.045 + 0.0022 * paramsB);
  return (contextLength / 1024) * per1k;
}

export interface VramInput {
  sizeGb: number;
  contextLength: number;
  totalParams?: number;
  vision?: boolean;
}

/** Estimated VRAM in GB needed to serve the model at `contextLength`. */
export function estimateVramGb(i: VramInput): number {
  const overhead = 1.5 + 0.02 * i.sizeGb + (i.vision ? 0.6 : 0);
  return i.sizeGb + overhead + kvCacheGb(i.contextLength, estimateParamsB(i.sizeGb, i.totalParams));
}

export interface FitInput {
  sizeGb: number;
  /** context_length from the GGUF header, when known. */
  ggufContext?: number;
  totalParams?: number;
  vision?: boolean;
  profiles: readonly FitProfile[];
}

export interface ModelFit {
  /** The context to serve with (-c). */
  contextLength: number;
  /** Estimated VRAM at that context, rounded up: the offer filter and the clock-in check compare against it. */
  minTotalVramGb: number;
  /** Ids of the profiles with enough VRAM (empty when the model is bigger than every profile). */
  profiles: string[];
}

function contextCandidates(cap: number): number[] {
  const min = Math.min(cap, MIN_USABLE_CONTEXT);
  const set = new Set<number>([cap, ...STANDARD_CONTEXTS.filter((c) => c < cap)]);
  return [...set].filter((c) => c >= min).sort((a, b) => b - a);
}

/** Profile ids whose nominal VRAM covers `minTotalVramGb`. */
export function profilesFitting(minTotalVramGb: number, profiles: readonly FitProfile[]): string[] {
  return profiles.filter((p) => profileCapacityGb(p) >= minTotalVramGb).map((p) => p.id);
}

/**
 * Pick the context and VRAM figure for a model: the longest context that still fits the smallest profile that can
 * hold the model with a useful context (>= 32k, or the GGUF's own limit when that is lower), capped by the GGUF context
 * length. A model bigger than every profile gets a 32k context and `profiles: []` (it can still be used with a bigger
 * custom profile).
 */
export function planFit(i: FitInput): ModelFit {
  const header = i.ggufContext && Number.isFinite(i.ggufContext) && i.ggufContext > 0 ? Math.floor(i.ggufContext) : DEFAULT_CONTEXT_CAP;
  const cap = Math.max(2048, Math.min(header, MAX_PLANNED_CONTEXT));
  const need = (ctx: number): number => estimateVramGb({ sizeGb: i.sizeGb, contextLength: ctx, totalParams: i.totalParams, vision: i.vision });
  const candidates = contextCandidates(cap);
  const minCtx = candidates[candidates.length - 1];

  const fitting = i.profiles.filter((p) => need(minCtx) <= profileCapacityGb(p));
  if (fitting.length === 0) {
    const ctx = Math.min(cap, 32768);
    return { contextLength: ctx, minTotalVramGb: Math.ceil(need(ctx)), profiles: [] };
  }
  const smallest = Math.min(...fitting.map(profileCapacityGb));
  const ctx = candidates.find((c) => need(c) <= smallest) ?? minCtx;
  const minTotalVramGb = Math.ceil(need(ctx));
  return { contextLength: ctx, minTotalVramGb, profiles: profilesFitting(minTotalVramGb, i.profiles) };
}
