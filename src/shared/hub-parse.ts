// Pure Hugging Face model parsing shared by the core hub client (src/core/gpu/hub.ts), the model browser and the renderer
// (demo mode runs the recorded API responses through the same code). No Node or DOM APIs in here.
//
// What the public API gives us: a search hit lists file NAMES only; the detail response (?blobs=true) adds sizes and
// the GGUF header facts. Anything that is not a model weight file is kept out of the quant variants: vision projectors
// (mmproj*), MTP draft heads (mtp-*, MTP/), imatrix data, vocab files and LoRA adapters.

import type {
  HubDraftFile,
  HubMmproj,
  HubModelDetail,
  HubModelSummary,
  HubQuantVariant,
} from "./hub";

// ───────────────────────────── Repo references ─────────────────────────────

const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);
const RESERVED_FIRST_SEGMENTS = new Set([
  'models', 'datasets', 'spaces', 'docs', 'api', 'blog', 'collections', 'organizations', 'papers', 'posts', 'settings', 'join', 'login', 'pricing', 'tasks',
]);

export function isValidRepoId(repo: string): boolean {
  return typeof repo === 'string' && REPO_ID_RE.test(repo) && !repo.includes('..');
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+=@,()-]{0,199}$/;

/**
 * A repo-relative .gguf path the server may download: every segment starts with a letter or digit and uses only
 * `A-Za-z0-9._+=@,()-`, no `..`. This is the boundary for anything that later reaches a shell command or a URL (the
 * bootstrap quotes everything as well; this keeps odd names from ever getting that far).
 */
export function isSafeGgufPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 400 || !/\.gguf$/i.test(p) || p.includes('..')) return false;
  return p.split('/').every((seg) => SAFE_SEGMENT_RE.test(seg));
}

/**
 * What a user may paste to add a model: "owner/name", "owner/name:Q4_K_M" (llama.cpp `-hf` style), or a
 * huggingface.co / hf.co URL of the repo (any sub-page: /tree/main, /blob/main/...). Null when it is none of these.
 */
export function parseRepoRef(input: string): { repo: string; quant?: string } | null {
  let s = String(input ?? '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!s) return null;
  if (/^(https?:\/\/)?(www\.)?(huggingface\.co|hf\.co)\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (!HF_HOSTS.has(u.hostname.toLowerCase())) return null;
    const seg = u.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
    if (seg.length < 2 || RESERVED_FIRST_SEGMENTS.has(seg[0].toLowerCase())) return null;
    // hf.co/owner/name:Q4_K_M keeps the quant in the second segment.
    s = `${seg[0]}/${seg[1]}`;
  }
  let quant: string | undefined;
  const colon = s.indexOf(':');
  if (colon >= 0) {
    quant = s.slice(colon + 1).trim();
    s = s.slice(0, colon);
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(quant)) return null;
  }
  if (!isValidRepoId(s)) return null;
  return quant ? { repo: s, quant } : { repo: s };
}

// ───────────────────────────── Quant labels ─────────────────────────────

// Q4_K_M, IQ4_XS, Q8_0, Q5_K_P, TQ1_0, Q4_0_4_8 | BF16 F16 F32 | MXFP4(_MOE); optional "UD-" (Unsloth dynamic) / "i1-"
// (mradermacher imatrix) prefix. Case-insensitive because some repos use lower case (q4_k_m).
const QUANT_RE = new RegExp(
  '(?<![A-Za-z0-9])(?:(UD|i1)-)?(' +
    '(?:IQ|TQ|Q)\\d(?:_(?:K|M|S|L|XL|XS|XXS|NL|P|\\d))*' +
    '|BF16|FP16|F16|FP32|F32|NVFP4|MXFP4(?:_MOE)?' +
    ')(?![A-Za-z0-9])',
  'gi',
);

/** The last quant label in `text` ("Foo-7B-UD-Q4_K_XL" -> "UD-Q4_K_XL"), normalised; null when there is none. */
export function detectQuantLabel(text: string): string | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(QUANT_RE)) last = m;
  if (!last) return null;
  const prefix = last[1] ? (last[1].toLowerCase() === 'ud' ? 'UD-' : 'i1-') : '';
  let core = last[2].toUpperCase();
  if (core === 'FP16') core = 'F16';
  if (core === 'FP32') core = 'F32';
  return prefix + core;
}

/** Approximate bits per weight implied by a label ("Q4_K_M" -> 4, "BF16" -> 16); null when unknown. */
export function quantBits(label: string): number | null {
  const core = label.replace(/^(UD|i1)-/i, '').toUpperCase();
  if (core === 'F32') return 32;
  if (core === 'BF16' || core === 'F16') return 16;
  if (core.startsWith('MXFP4') || core === 'NVFP4') return 4;
  const m = /^(?:IQ|TQ|Q)(\d)/.exec(core);
  return m ? Number(m[1]) : null;
}

/** Plain code-unit order: identical on every machine (localeCompare depends on the ICU locale). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareLabels(a: string, b: string): number {
  const ba = quantBits(a) ?? 99;
  const bb = quantBits(b) ?? 99;
  return ba - bb || cmp(a, b);
}

const FLOAT_LABELS = new Set(['F32', 'F16', 'BF16']);

/** Sweet-spot order used by recommendVariant: good quality per GB first. */
const PREFERRED_LABELS = [
  'UD-Q4_K_XL', 'Q4_K_M', 'UD-Q4_K_M', 'MXFP4', 'MXFP4_MOE', 'UD-Q5_K_XL', 'Q5_K_M', 'Q4_K_XL', 'Q4_K_L', 'UD-Q4_K_S', 'Q4_K_S',
  'IQ4_XS', 'UD-IQ4_XS', 'Q5_K_S', 'Q6_K', 'UD-Q6_K_XL', 'Q8_0', 'UD-Q3_K_XL', 'Q3_K_M', 'IQ3_M', 'Q2_K',
];

/**
 * A sensible default quant for "add this model": the first sweet-spot label that exists (and fits `maxBytes` when
 * given), else the biggest non-float variant that fits, else the smallest variant. Undefined when nothing fits.
 */
export function recommendVariant(variants: readonly HubQuantVariant[], opts: { maxBytes?: number } = {}): HubQuantVariant | undefined {
  const fits = (v: HubQuantVariant) => opts.maxBytes === undefined || (v.sizeKnown && v.sizeBytes <= opts.maxBytes);
  const pool = variants.filter(fits);
  if (pool.length === 0) return undefined;
  const norm = (l: string) => l.replace(/^i1-/, '').toUpperCase();
  for (const want of PREFERRED_LABELS) {
    const hit = pool.find((v) => norm(v.label) === want);
    if (hit) return hit;
  }
  const quantised = pool.filter((v) => !FLOAT_LABELS.has(norm(v.label)));
  const byBig = (a: HubQuantVariant, b: HubQuantVariant) => b.sizeBytes - a.sizeBytes;
  if (quantised.length > 0) return [...quantised].sort(byBig)[0];
  return [...pool].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
}

// ───────────────────────────── Sibling (file list) parsing ─────────────────────────────

interface RawSibling {
  rfilename?: unknown;
  size?: unknown;
  lfs?: { size?: unknown } | null;
}

export interface ParsedSiblings {
  variants: HubQuantVariant[];
  mmprojs: HubMmproj[];
  drafts: HubDraftFile[];
  warnings: string[];
}

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** Decimal GB (bytes / 1e9) rounded to 2 decimals, the unit of CatalogModel.sizeGb. */
export function toGb(bytes: number): number {
  return Math.round((bytes / 1e9) * 100) / 100;
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function stripGguf(name: string): string {
  return name.replace(/\.gguf$/i, '');
}

function siblingSize(s: RawSibling): number | null {
  if (typeof s.size === 'number' && Number.isFinite(s.size) && s.size >= 0) return s.size;
  const l = s.lfs?.size;
  if (typeof l === 'number' && Number.isFinite(l) && l >= 0) return l;
  return null;
}

function isDraftFile(path: string): boolean {
  return /^mtp[-_.]/i.test(baseName(path)) || /(^|\/)mtp\//i.test(path);
}

/** .gguf files that are not models: imatrix data, vocab files, LoRA adapters. */
function isAuxFile(base: string, label: string | null): boolean {
  if (label === null && /imatrix/i.test(base)) return true;
  if (/^ggml-vocab/i.test(base)) return true;
  if (/(^|[-_.])lora([-_.]|$)/i.test(base)) return true;
  return false;
}

interface Group {
  dir: string;
  prefix: string;
  total: number | null;
  parts: { idx: number; path: string; size: number | null }[];
}

function labelFor(dir: string, stem: string): string {
  const fromStem = detectQuantLabel(stem);
  const folder = dir ? baseName(dir) : '';
  const fromFolder = folder ? detectQuantLabel(folder) : null;
  // The folder is the more specific one when the file name only has the bare quant ("UD-Q4_K_XL/x-Q4_K_XL.gguf").
  if (fromStem && fromFolder && fromFolder !== fromStem && fromFolder.endsWith(fromStem)) return fromFolder;
  return fromStem ?? fromFolder ?? 'unknown';
}

/**
 * Turns a repo's file list into quant variants. Split files (`name-00001-of-00004.gguf`, also inside sub-folders) are
 * grouped into one variant with the parts in order and the summed size; an incomplete set is left out with a warning.
 * mmproj files, MTP draft heads, imatrix data, vocab files and LoRA adapters are never variants.
 */
export function parseGgufSiblings(siblings: unknown): ParsedSiblings {
  const out: ParsedSiblings = { variants: [], mmprojs: [], drafts: [], warnings: [] };
  const list: RawSibling[] = Array.isArray(siblings) ? (siblings as RawSibling[]) : [];
  const groups = new Map<string, Group>();

  for (const s of list) {
    const path = typeof s?.rfilename === 'string' ? s.rfilename : '';
    if (!path || !/\.gguf$/i.test(path)) continue;
    const base = baseName(path);
    const size = siblingSize(s);

    if (/mmproj/i.test(path)) {
      if (!isSafeGgufPath(path)) {
        out.warnings.push(`${path}: vision projector with unsupported characters in its name, left out`);
        continue;
      }
      const bytes = size ?? 0;
      out.mmprojs.push({ file: path, sizeBytes: bytes, sizeGb: toGb(bytes), label: detectQuantLabel(stripGguf(base)) ?? 'unknown' });
      continue;
    }
    if (isDraftFile(path)) {
      const bytes = size ?? 0;
      out.drafts.push({ file: path, sizeBytes: bytes, sizeGb: toGb(bytes), label: detectQuantLabel(stripGguf(base)) ?? 'unknown' });
      continue;
    }
    const split = SPLIT_RE.exec(base);
    const stem = split ? split[1] : stripGguf(base);
    if (isAuxFile(base, detectQuantLabel(stem))) continue;

    const dir = dirName(path);
    if (split) {
      const key = `${dir}\u0000${split[1]}\u0000${Number(split[3])}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { dir, prefix: split[1], total: Number(split[3]), parts: [] }));
      g.parts.push({ idx: Number(split[2]), path, size });
    } else {
      groups.set(`${path}\u0000single`, { dir, prefix: stem, total: null, parts: [{ idx: 1, path, size }] });
    }
  }

  for (const g of groups.values()) {
    const label = labelFor(g.dir, g.prefix);
    const parts = [...g.parts].sort((a, b) => a.idx - b.idx);
    if (g.total !== null) {
      const have = new Set(parts.map((p) => p.idx));
      let missing = 0;
      for (let i = 1; i <= g.total; i++) if (!have.has(i)) missing++;
      if (missing > 0 || g.total < 1) {
        out.warnings.push(`${label}${g.dir ? ` (${g.dir})` : ''}: ${missing} of ${g.total} parts missing, left out`);
        continue;
      }
    }
    const sizeKnown = parts.every((p) => p.size !== null);
    const sizeBytes = parts.reduce((n, p) => n + (p.size ?? 0), 0);
    const v: HubQuantVariant = {
      id: parts[0].path,
      label,
      files: parts.map((p) => p.path),
      sizeBytes,
      sizeGb: toGb(sizeBytes),
      sizeKnown,
      parts: parts.length,
    };
    if (g.dir) v.folder = g.dir;
    const bad = v.files.find((f) => !isSafeGgufPath(f));
    if (bad) v.unsupported = `The file name "${bad}" has characters the GPU server's downloader does not support.`;
    out.variants.push(v);
  }

  out.variants.sort((a, b) => a.sizeBytes - b.sizeBytes || compareLabels(a.label, b.label) || cmp(a.id, b.id));
  out.mmprojs.sort((a, b) => a.sizeBytes - b.sizeBytes || cmp(a.file, b.file));
  out.drafts.sort((a, b) => cmp(a.file, b.file));
  return out;
}

/** The variant a caller means: its id (first file path), else its quant label (case-insensitive; an addable one first). */
export function findVariant(detail: Pick<HubModelDetail, 'variants'>, quant: string): HubQuantVariant | undefined {
  const byId = detail.variants.find((v) => v.id === quant);
  if (byId) return byId;
  const q = quant.trim().toLowerCase();
  const same = detail.variants.filter((v) => v.label.toLowerCase() === q);
  return same.find((v) => !v.unsupported) ?? same[0];
}

// ───────────────────────────── Model parsing ─────────────────────────────

const NOISE_TAGS = new Set([
  'gguf', 'endpoints_compatible', 'autotrain_compatible', 'text-generation-inference', 'safetensors', 'transformers', 'deprecated',
]);
const NOISE_TAG_PREFIXES = ['license:', 'base_model:', 'region:', 'dataset:', 'arxiv:', 'doi:'];
const MAX_DISPLAY_TAGS = 12;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] {
  if (typeof v === 'string') return v ? [v] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function parseTags(tags: string[], card: Record<string, unknown> | undefined): { license?: string; baseModels: string[]; display: string[] } {
  let license = tags.find((t) => t.startsWith('license:'))?.slice('license:'.length);
  const cardLicense = str(card?.license) ?? strArray(card?.license)[0];
  license ??= cardLicense;
  if (license === 'other') license = str(card?.license_name) ?? license;

  const baseModels: string[] = [];
  const addBase = (id: string) => {
    if (id && !baseModels.includes(id)) baseModels.push(id);
  };
  for (const t of tags) {
    if (!t.startsWith('base_model:')) continue;
    const rest = t.slice('base_model:'.length);
    const rel = /^(?:quantized|finetune|adapter|merge):(.+)$/.exec(rest);
    addBase(rel ? rel[1] : rest);
  }
  for (const b of strArray(card?.base_model)) addBase(b);

  const display = tags
    .filter((t) => !NOISE_TAGS.has(t) && !NOISE_TAG_PREFIXES.some((p) => t.startsWith(p)) && !/^[a-z]{2}$/.test(t))
    .slice(0, MAX_DISPLAY_TAGS);
  return { license, baseModels, display };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** A search hit (or the detail response) as the list row. Null when it has no usable repo id. */
export function parseModelSummary(raw: unknown): HubModelSummary | null {
  const r = asRecord(raw);
  if (!r) return null;
  const repo = str(r.id) ?? str(r.modelId);
  if (!repo || !isValidRepoId(repo)) return null; // ids end up in URLs and in the catalog: only well-formed ones are listed
  const slash = repo.indexOf('/');
  const card = asRecord(r.cardData);
  const tags = strArray(r.tags);
  const t = parseTags(tags, card);
  const sib = parseGgufSiblings(r.siblings);
  const labels = [...new Set(sib.variants.map((v) => v.label))].sort(compareLabels);
  return {
    repo,
    author: str(r.author) ?? repo.slice(0, slash),
    name: repo.slice(slash + 1),
    downloads: num(r.downloads) ?? 0,
    likes: num(r.likes) ?? 0,
    lastModified: str(r.lastModified),
    createdAt: str(r.createdAt),
    gated: r.gated === 'auto' || r.gated === 'manual' || r.gated === true,
    license: t.license,
    baseModels: t.baseModels,
    pipelineTag: str(r.pipeline_tag) ?? str(card?.pipeline_tag),
    tags: t.display,
    quantLabels: labels,
    hasVision: sib.mmprojs.length > 0,
  };
}

/** The detail response (`?blobs=true`) with variants, vision projectors and the GGUF header facts. Null when unusable. */
export function parseModelDetail(raw: unknown): HubModelDetail | null {
  const summary = parseModelSummary(raw);
  if (!summary) return null;
  const r = raw as Record<string, unknown>;
  const gguf = asRecord(r.gguf);
  const totalParams = num(gguf?.total);
  const sib = parseGgufSiblings(r.siblings);
  if (totalParams && totalParams > 0) {
    for (const v of sib.variants) {
      if (v.sizeKnown && v.sizeBytes > 0) v.bitsPerWeight = Math.round(((v.sizeBytes * 8) / totalParams) * 100) / 100;
    }
  }
  return {
    ...summary,
    variants: sib.variants,
    mmprojs: sib.mmprojs,
    drafts: sib.drafts,
    architecture: str(gguf?.architecture),
    contextLength: num(gguf?.context_length),
    totalParams,
    sha: str(r.sha),
    warnings: sib.warnings,
  };
}
