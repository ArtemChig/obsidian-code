// Hugging Face model-browser shapes shared by the core (src/core/gpu/hub.ts) and the renderer. Types only.
// The core turns the raw public Hugging Face API into these; nothing here is the raw API shape.

/** Sort orders the hub client asks Hugging Face for (descending). */
export type HubSort = 'downloads' | 'likes' | 'lastModified' | 'trendingScore';

export const HUB_SORTS: readonly HubSort[] = ['downloads', 'likes', 'lastModified', 'trendingScore'];

/**
 * Optional task filter (Hugging Face `pipeline_tag`). Many chat models carry no tag at all (the Unsloth repos, for one),
 * so the default is no filter; 'text-generation' and 'image-text-to-text' (vision chat models) narrow the list.
 */
export type HubPipelineTag = 'text-generation' | 'image-text-to-text';

export const HUB_PIPELINE_TAGS: readonly HubPipelineTag[] = ['text-generation', 'image-text-to-text'];

export interface HubSearchParams {
  /** Free-text query; empty = browse everything tagged gguf. */
  query?: string;
  sort?: HubSort;
  pipelineTag?: HubPipelineTag;
  /** Page size, 1..100 (default 30). */
  limit?: number;
  /** `nextCursor` of the previous page. */
  cursor?: string;
}

/** One quantisation of a model: a single .gguf, or the ordered parts of a split one. */
export interface HubQuantVariant {
  /** Unique within the repo; the repo-relative path of the first part. */
  id: string;
  /** Quant label as detected from the file name / folder: Q4_K_M, IQ4_XS, UD-Q5_K_XL, BF16, MXFP4 ... ("unknown" when none). */
  label: string;
  /** Repo-relative paths in load order; files[0] is what llama-server gets as -m (further parts load automatically). */
  files: string[];
  /** Sum of all parts. 0 when sizes are unknown (see sizeKnown). */
  sizeBytes: number;
  /** Decimal GB (bytes / 1e9) rounded to 2 decimals, the same unit as CatalogModel.sizeGb. */
  sizeGb: number;
  /** False when any part had no size in the API response (search results never carry sizes). */
  sizeKnown: boolean;
  /** Number of split parts (1 = a single file). */
  parts: number;
  /** Sub-folder inside the repo, when the files are not at the top level. */
  folder?: string;
  /** Approximate bits per weight (sizeBytes * 8 / total parameters); only when both are known. */
  bitsPerWeight?: number;
  /** Why this variant cannot be added (a file name the GPU server's downloader cannot handle); absent = addable. */
  unsupported?: string;
}

/** A vision projector (`mmproj*.gguf`): optional, never a model variant. */
export interface HubMmproj {
  file: string;
  sizeBytes: number;
  sizeGb: number;
  /** BF16 / F16 / F32 / Q8_0 ... or "unknown". */
  label: string;
}

/** A speculative-decoding draft head shipped next to the model (`mtp-*.gguf`, `MTP/` folder). Not a variant. */
export interface HubDraftFile {
  file: string;
  sizeBytes: number;
  sizeGb: number;
  label: string;
}

/** What the list needs to render a row. Built from a search hit (no sizes) or from the detail response. */
export interface HubModelSummary {
  /** "owner/name" */
  repo: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  /** ISO timestamps as sent by Hugging Face. */
  lastModified?: string;
  createdAt?: string;
  /** Gated repos (auto/manual approval) need a Hugging Face login to download; the rented server has none. */
  gated: boolean;
  license?: string;
  /** Models this one was derived/quantised from ("Qwen/Qwen3.8-27B"). */
  baseModels: string[];
  pipelineTag?: string;
  /** Display tags with the noise removed (gguf, region:us, license:*, base_model:* ...). */
  tags: string[];
  /** Distinct quant labels found in the file list, smallest-name order not guaranteed. */
  quantLabels: string[];
  /** True when the repo ships at least one mmproj file. */
  hasVision: boolean;
}

export interface HubModelDetail extends HubModelSummary {
  /** Complete variants, smallest first. */
  variants: HubQuantVariant[];
  mmprojs: HubMmproj[];
  /** MTP / draft heads (listed so the UI can mention them; not selectable as variants). */
  drafts: HubDraftFile[];
  /** From the GGUF header Hugging Face parsed (absent for repos it could not read). */
  architecture?: string;
  contextLength?: number;
  /** Total parameter count. */
  totalParams?: number;
  sha?: string;
  /** Things that were left out and why ("Q4_K_M: part 2 of 3 missing"). */
  warnings: string[];
}

export interface HubSearchResult {
  models: HubModelSummary[];
  /** Pass as `cursor` to get the next page; absent on the last page. */
  nextCursor?: string;
  /** Epoch ms the underlying response was fetched. */
  fetchedAt: number;
  /** Served from the in-memory cache. */
  cached: boolean;
  /** The request failed and this is an older cached answer for the same request. */
  stale?: boolean;
}

export type HubErrorCode =
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'network'
  | 'timeout'
  | 'bad_response'
  | 'invalid_repo';
