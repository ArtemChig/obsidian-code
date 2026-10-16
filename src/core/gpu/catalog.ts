// Vast.ai model catalog (owner: gpu).
// Source of truth: docs/research/catalog.json (verified against the Hugging Face API on 2026-10-12, see
// docs/research/catalog.md). Field conventions (additive to CatalogModel):
//   * files[0] is passed to llama-server `-m`; further split parts load automatically; extra non-split files
//     (e.g. an MTP draft head) may follow the split parts and are downloaded but not passed to -m.
//   * llamaArgs may contain the placeholder `{modelDir}` which the server bootstrap replaces with the local
//     download directory (/root/models/<id>).
//   * sizeGb = total download in decimal GB (all files + mmproj).
//   * experimental = upstream llama.cpp support is young; the pipeline falls back to the profile's
//     non-experimental model on the same instance if the experimental one fails to load.

import type { CatalogModel } from '../../shared/types';
import { sanitizeUserModels, withCurrentProfiles } from '../../shared/user-models';
import type { FitProfile } from '../../shared/model-fit';

export const CATALOG: readonly CatalogModel[] = [
  {
    id: "qwen38-27b-uncensored-hauhau-q5kp",
    label: "Qwen3.8 27B Uncensored - HauhauCS Aggressive Q5_K_P",
    family: "qwen3.8-27b",
    variant: "uncensored",
    repo: "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF",
    files: [
      "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf"
    ],
    mmproj: "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
    sizeGb: 21.15,
    minTotalVramGb: 32,
    contextLength: 131072,
    llamaArgs: [
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--parallel",
      "1"
    ],
    profiles: [
      "light"
    ],
    notes: "Recommended default for 'light' (1x RTX 5090). arch qwen35; 64 layers + 1 embedded NextN/MTP layer (verified in the GGUF header). Upstream embedded MTP via --spec-type draft-mtp; the HauhauCS 'FastMTP' sidecar needs a patched llama.cpp build and is NOT used. Est. VRAM at 131072 ctx with q8_0 KV: about 26 GiB of 31.8 GiB. Vision via the BF16 mmproj.",
    verifiedAt: "2026-10-12"
  },
  {
    id: "qwen38-27b-uncensored-heretic-ara-q5km",
    label: "Qwen3.8 27B Uncensored - heretic-ara Q5_K_M (mradermacher)",
    family: "qwen3.8-27b",
    variant: "uncensored",
    repo: "mradermacher/Qwen3.8-27B-heretic-ara-GGUF",
    files: [
      "Qwen3.8-27B-heretic-ara.Q5_K_M.gguf"
    ],
    mmproj: "Qwen3.8-27B-heretic-ara.mmproj-f16.gguf",
    sizeGb: 20.46,
    minTotalVramGb: 32,
    contextLength: 131072,
    llamaArgs: [
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--parallel",
      "1"
    ],
    profiles: [
      "light"
    ],
    notes: "Static GGUF of heretic-org/Qwen3.8-27B-heretic-ara (heretic-org publishes safetensors only, no GGUF). Embedded NextN/MTP layer verified in the GGUF header.",
    verifiedAt: "2026-10-12"
  },
  {
    id: "qwen38-27b-standard-unsloth-q5kxl",
    label: "Qwen3.8 27B - Unsloth UD-Q5_K_XL",
    family: "qwen3.8-27b",
    variant: "standard",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    files: [
      "Qwen3.8-27B-UD-Q5_K_XL.gguf"
    ],
    mmproj: "mmproj-BF16.gguf",
    sizeGb: 21.81,
    minTotalVramGb: 32,
    contextLength: 131072,
    llamaArgs: [
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--parallel",
      "1"
    ],
    profiles: [
      "light"
    ],
    notes: "Standard (vendor-aligned) weights. Embedded NextN/MTP layer verified in the GGUF header.",
    verifiedAt: "2026-10-12"
  },
  {
    id: "qwen38-27b-uncensored-hauhau-q8kp",
    label: "Qwen3.8 27B Uncensored - HauhauCS Aggressive Q8_K_P",
    family: "qwen3.8-27b",
    variant: "uncensored",
    repo: "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF",
    files: [
      "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf"
    ],
    mmproj: "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
    sizeGb: 32.39,
    minTotalVramGb: 48,
    contextLength: 262144,
    llamaArgs: [
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--parallel",
      "1"
    ],
    profiles: [
      "standard"
    ],
    notes: "Reliable fallback for 'standard' (1x RTX PRO 6000) when Flash-Next fails to load. Est. VRAM at 262144 ctx with q8_0 KV: about 41 GiB.",
    verifiedAt: "2026-10-12"
  },
  {
    id: "qwen38-27b-standard-unsloth-q8",
    label: "Qwen3.8 27B - Unsloth Q8_0",
    family: "qwen3.8-27b",
    variant: "standard",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    files: [
      "Qwen3.8-27B-Q8_0.gguf"
    ],
    mmproj: "mmproj-BF16.gguf",
    sizeGb: 29.98,
    minTotalVramGb: 48,
    contextLength: 262144,
    llamaArgs: [
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "2",
      "--parallel",
      "1"
    ],
    profiles: [
      "standard"
    ],
    notes: "Standard fallback for 'standard'. Embedded NextN/MTP layer verified in the GGUF header.",
    verifiedAt: "2026-10-12"
  },
  {
    id: "qwen38-flash-next-uncensored-huihui-v2-q4kxl",
    label: "Qwen3.8 Flash-Next 125B-A6B Uncensored - huihui v2 UD-Q4_K_XL",
    family: "qwen3.8-flash-next",
    variant: "uncensored",
    repo: "huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF",
    files: [
      "unsloth-UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf",
      "unsloth-UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004.gguf",
      "unsloth-UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004.gguf",
      "unsloth-UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004.gguf"
    ],
    sizeGb: 111.33,
    minTotalVramGb: 96,
    contextLength: 131072,
    llamaArgs: [
      "--parallel",
      "1"
    ],
    profiles: [
      "standard"
    ],
    notes: "arch qwen4exp (upstream since PR #27742, 2026-08-27). The 28.84 GB per_layer_token_embd (n-gram PLE table) is read lazily from disk via mmap (--lazy-mode auto is the default), so only about 82.5 GB must be VRAM-resident. Do NOT pass --load-mode none (it would defeat mmap). No MTP: this repo ships no MTP head and Unsloth's Flash-Next MTP heads hit GGML_ASSERT at startup (llama.cpp #29811). No mmproj on purpose (QSA indexer OOM risk with images, #30032). v2 = experts not ablated (huihui: better for coding).",
    experimental: true,
    verifiedAt: "2026-10-12"
  },
  {
    id: "qwen38-flash-next-standard-ggml-iq4nl",
    label: "Qwen3.8 Flash-Next 125B-A6B - ggml-org IQ4_NL + MTP",
    family: "qwen3.8-flash-next",
    variant: "standard",
    repo: "ggml-org/Qwen3.8-Flash-Next-GGUF",
    files: [
      "Qwen3.8-Flash-Next-IQ4_NL-00001-of-00002.gguf",
      "Qwen3.8-Flash-Next-IQ4_NL-00002-of-00002.gguf",
      "mtp-Qwen3.8-Flash-Next-Q8_0.gguf"
    ],
    sizeGb: 106.19,
    minTotalVramGb: 96,
    contextLength: 131072,
    llamaArgs: [
      "-md",
      "{modelDir}/mtp-Qwen3.8-Flash-Next-Q8_0.gguf",
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      "3",
      "--parallel",
      "1"
    ],
    profiles: [
      "standard"
    ],
    notes: "files[0..1] = split model (pass files[0] to -m); files[2] = separate MTP draft head (the ggml-org head is the combination reported working in llama.cpp #29811). The bootstrap must replace '{modelDir}' in llamaArgs with the local download dir. About 73.2 GB VRAM-resident + 4.1 GB MTP; the 28.82 GB PLE table is lazily mmapped. No mmproj: MTP + image input aborts the server (open issue #30307).",
    experimental: true,
    verifiedAt: "2026-10-12"
  },
  {
    id: "glm53-flash-uncensored-huihui-iq4xs",
    label: "GLM-5.3 Flash 320B-A18B Uncensored - huihui UD-IQ4_XS",
    family: "glm-5.3-flash",
    variant: "uncensored",
    repo: "huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF",
    files: [
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00001-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00002-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00003-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00004-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00005-of-00005.gguf"
    ],
    mmproj: "mmproj-model-bf16.gguf",
    sizeGb: 157.99,
    minTotalVramGb: 192,
    contextLength: 131072,
    llamaArgs: [],
    profiles: [
      "max"
    ],
    notes: "arch glm5-next (upstream PR #27773 merged 2026-09-30; MTP PR #29928 2026-10-07). The embedded NextN layer is present but MTP is NOT enabled: draft-mtp roughly halves prompt processing on multi-GPU layer split (#27428) and breaks image requests (#30204). Never set -ub 2048 (CUDA illegal memory access on sm_120, #28282). About 146 GiB of weights across 2 x 95.6 GiB; MLA KV cache is small.",
    experimental: true,
    verifiedAt: "2026-10-12"
  },
  {
    id: "glm53-flash-standard-unsloth-iq4xs",
    label: "GLM-5.3 Flash 320B-A18B - Unsloth UD-IQ4_XS",
    family: "glm-5.3-flash",
    variant: "standard",
    repo: "unsloth/GLM-5.3-Flash-GGUF",
    files: [
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00001-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00002-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00003-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00004-of-00005.gguf",
      "UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00005-of-00005.gguf"
    ],
    mmproj: "mmproj-BF16.gguf",
    sizeGb: 157.99,
    minTotalVramGb: 192,
    contextLength: 131072,
    llamaArgs: [],
    profiles: [
      "max"
    ],
    notes: "Same quant recipe and size as the huihui uncensored build (parts 2-5 differ by hash; part 1 is metadata only).",
    experimental: true,
    verifiedAt: "2026-10-12"
  },
  {
    id: "test-qwen35-0.8b-q8",
    label: "TEST - Qwen3.5 0.8B Q8_0 (smoke test)",
    family: "test",
    variant: "standard",
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    files: [
      "Qwen3.5-0.8B-Q8_0.gguf"
    ],
    sizeGb: 0.81,
    minTotalVramGb: 4,
    contextLength: 32768,
    llamaArgs: [],
    profiles: [
      "light",
      "standard",
      "max"
    ],
    notes: "0.81 GB, arch qwen35 (same code path as Qwen3.8-27B, but no MTP layer). For cheap live clock-in pipeline tests.",
    verifiedAt: "2026-10-12"
  },
  {
    id: "test-qwen35-2b-uncensored-hauhau-q4km",
    label: "TEST - Qwen3.5 2B Uncensored HauhauCS Q4_K_M (smoke test)",
    family: "test",
    variant: "uncensored",
    repo: "HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive",
    files: [
      "Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf"
    ],
    sizeGb: 1.27,
    minTotalVramGb: 4,
    contextLength: 32768,
    llamaArgs: [],
    profiles: [
      "light",
      "standard",
      "max"
    ],
    notes: "1.27 GB uncensored tiny model for smoke tests (arch qwen35, no MTP layer).",
    verifiedAt: "2026-10-12"
  }
];

/** Download speed assumed for warm-up estimates (≈150 MB/s, see SPEC §5b). */
export const WARMUP_DOWNLOAD_MBPS = 150;
/** Fixed overhead for instance boot + SSH + weight loading, in seconds. */
export const WARMUP_OVERHEAD_SEC = 180;

// ───────────────────────────── Built-in + user models ─────────────────────────────
// CATALOG above is the built-in, recommended list and never changes. Models the user added from Hugging Face
// (Settings.vast.userModels) are registered here by the core (setUserCatalogModels, on start and on every settings
// change), so every lookup below sees both. Built-ins come first; entries carry `source` ('builtin' | 'user').

const BUILTIN: readonly CatalogModel[] = CATALOG.map((m) => ({ ...m, source: 'builtin' as const }));
const BUILTIN_IDS: ReadonlySet<string> = new Set(CATALOG.map((m) => m.id));
let userModels: readonly CatalogModel[] = [];

/**
 * Register the user's added models. They are re-validated here (a built-in id can never be shadowed) and, when
 * `profiles` is given, their `profiles` are recomputed from the current GPU profiles' VRAM.
 */
export function setUserCatalogModels(models: readonly CatalogModel[], profiles?: readonly FitProfile[]): void {
  const clean = sanitizeUserModels(models, BUILTIN_IDS);
  userModels = profiles ? withCurrentProfiles(clean, profiles) : clean;
}

/** The registered user models (copies). */
export function userCatalogModels(): CatalogModel[] {
  return userModels.map(copyModel);
}

/** The built-in models only (copies, tagged `source: 'builtin'`). */
export function builtinCatalogModels(): CatalogModel[] {
  return BUILTIN.map(copyModel);
}

export function isUserModel(m: Pick<CatalogModel, 'source'>): boolean {
  return m.source === 'user';
}

function all(): readonly CatalogModel[] {
  return userModels.length === 0 ? BUILTIN : [...BUILTIN, ...userModels];
}

function copyModel(m: CatalogModel): CatalogModel {
  return { ...m, files: [...m.files], llamaArgs: [...m.llamaArgs], profiles: [...m.profiles] };
}

/**
 * The models config.sh must know on a server that is being rented for `modelId`: every built-in plus the chosen user
 * model. (A live switch uploads the full list over SSH first, so the instance env stays small however many models the
 * user added.)
 */
export function serverCatalog(modelId?: string): CatalogModel[] {
  const extra = modelId ? userModels.find((m) => m.id === modelId) : undefined;
  return (extra ? [...BUILTIN, extra] : [...BUILTIN]).map(copyModel);
}

/** A fresh copy of the catalog: built-ins first, then the user's models (callers may mutate their copy freely). */
export function catalogModels(): CatalogModel[] {
  return all().map(copyModel);
}

export function getCatalogModel(id: string): CatalogModel | undefined {
  const m = all().find((x) => x.id === id);
  return m ? copyModel(m) : undefined;
}

export function requireCatalogModel(id: string): CatalogModel {
  const m = getCatalogModel(id);
  if (!m) throw new Error(`Unknown catalog model "${id}"`);
  return m;
}

export function isExperimental(m: CatalogModel): boolean {
  return m.experimental === true;
}

export function isTestModel(m: CatalogModel): boolean {
  return m.family === 'test';
}

/** Models recommended for a profile (test models excluded unless includeTest). */
export function modelsForProfile(profileId: string, opts: { includeTest?: boolean } = {}): CatalogModel[] {
  return all().filter((m) => m.profiles.includes(profileId) && (opts.includeTest || !isTestModel(m)));
}

/**
 * The Uncensored <-> Standard toggle: the same family's model with the other (or the requested) variant.
 * Prefers a sibling recommended for the same profiles, then the closest download size. Returns the model
 * itself when it already has the requested variant, undefined when the family has no such variant.
 */
export function siblingVariant(modelId: string, variant: 'uncensored' | 'standard'): CatalogModel | undefined {
  const m = getCatalogModel(modelId);
  if (!m) return undefined;
  if (m.variant === variant) return m;
  const candidates = all().filter((c) => c.family === m.family && c.variant === variant);
  if (candidates.length === 0) return undefined;
  const overlap = (c: CatalogModel) => c.profiles.filter((p) => m.profiles.includes(p)).length;
  return [...candidates].sort((a, b) => overlap(b) - overlap(a) || Math.abs(a.sizeGb - m.sizeGb) - Math.abs(b.sizeGb - m.sizeGb))[0];
}

/** Toggle helper for the UI: flips the variant of the given model. */
export function toggleVariant(modelId: string): CatalogModel | undefined {
  const m = getCatalogModel(modelId);
  if (!m) return undefined;
  return siblingVariant(modelId, m.variant === 'uncensored' ? 'standard' : 'uncensored');
}

/**
 * Default model for a profile: the profile's configured defaultModelId (adjusted to the preferred variant),
 * else the first recommended model of the preferred variant.
 */
export function defaultModelForProfile(profileId: string, defaultModelId: string | undefined, preferUncensored = true): CatalogModel | undefined {
  const want: 'uncensored' | 'standard' = preferUncensored ? 'uncensored' : 'standard';
  if (defaultModelId) {
    const base = getCatalogModel(defaultModelId);
    if (base) return siblingVariant(base.id, want) ?? base;
  }
  const list = modelsForProfile(profileId);
  return list.find((m) => m.variant === want && !isExperimental(m)) ?? list.find((m) => m.variant === want) ?? list[0];
}

/**
 * Non-experimental fallback for an experimental model on the same instance (catalog.md §6.2): a model recommended
 * for one of the same profiles, same variant preferred, that fits the given total VRAM. Undefined when there is none
 * (e.g. the 'max' profile).
 */
export function experimentalFallback(modelId: string, totalVramGb: number): CatalogModel | undefined {
  const m = getCatalogModel(modelId);
  if (!m || !isExperimental(m)) return undefined;
  // Built-ins only: the app never swaps in a model the user added by themselves behind their back.
  const pool = BUILTIN.filter(
    (c) => !isExperimental(c) && !isTestModel(c) && c.id !== m.id && c.minTotalVramGb <= totalVramGb && c.profiles.some((p) => m.profiles.includes(p)),
  );
  return pool.find((c) => c.variant === m.variant) ?? pool[0];
}

/** Estimated warm-up (boot + download + load) in seconds for a fresh instance (sizeGb / ~150 MB/s + overhead). */
export function estimateWarmupSeconds(m: Pick<CatalogModel, 'sizeGb'>, downloadMBps = WARMUP_DOWNLOAD_MBPS): number {
  const download = (m.sizeGb * 1000) / Math.max(1, downloadMBps);
  return Math.round(download + WARMUP_OVERHEAD_SEC);
}

/** Human label like "~15 min" for the GPU view. */
export function warmupLabel(m: Pick<CatalogModel, 'sizeGb'>): string {
  const min = Math.max(1, Math.round(estimateWarmupSeconds(m) / 60));
  return `~${min} min`;
}

/** Estimated warm-up cost in USD: GPU time during warm-up + bandwidth (sizeGb x $/GB). */
export function estimateWarmupCost(m: Pick<CatalogModel, 'sizeGb'>, pricePerHour: number, inetDownCostPerGb = 0): number {
  return (estimateWarmupSeconds(m) / 3600) * pricePerHour + m.sizeGb * inetDownCostPerGb;
}

/** Disk to request for a model: max(profile minimum, size x 1.3 + 20 GB), rounded up to 10 GB. */
export function diskGbFor(m: Pick<CatalogModel, 'sizeGb'>, profileMinDiskGb = 0): number {
  const need = Math.ceil((m.sizeGb * 1.3 + 20) / 10) * 10;
  return Math.max(profileMinDiskGb, need);
}
