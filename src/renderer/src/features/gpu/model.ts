// Pure helpers for the GPU view: price statistics, budget maths, warm-up estimates, catalog sibling lookup. Owner: ui-views.
import type { CatalogModel, GpuOffer, GpuProfile, GpuSessionRecord, GpuStatus } from '@shared/types';

// ───────────────────────────── Safe mode (bootstrap.sh load fallback) ─────────────────────────────

const DROPPED_LABEL: Record<string, string> = {
  mtp: 'MTP speculative decoding',
  vision: 'vision',
  'flash-attn': 'flash attention',
  'kv-quant': 'the q8_0 KV cache',
};

/** "MTP speculative decoding and vision disabled because the full configuration failed to load. Context 64K." */
export function safeModeSummary(s: Pick<GpuStatus, 'droppedFeatures' | 'serverContextLength'>): string {
  const items = (s.droppedFeatures ?? []).map((d) => DROPPED_LABEL[d] ?? d);
  const list = items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const ctx = s.serverContextLength ? ` Context ${Math.round(s.serverContextLength / 1024)}K.` : '';
  if (!list) return `The full configuration failed to load, so the model runs with a reduced setup.${ctx}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} disabled because the full configuration failed to load.${ctx}`;
}

/** File name of a saved failure log path (Windows or POSIX separators). */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ───────────────────────────── Prices & budget ─────────────────────────────

export interface PriceStats {
  count: number;
  min: number;
  median: number;
  max: number;
  /** The cheapest offer (what a clock-in would pick). */
  best: GpuOffer;
}

/** Cheapest / median / max $/h over a list of offers; null when there are none. */
export function priceStats(offers: readonly GpuOffer[] | null | undefined): PriceStats | null {
  if (!offers || offers.length === 0) return null;
  const sorted = [...offers].sort((a, b) => a.pricePerHour - b.pricePerHour);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2].pricePerHour : (sorted[n / 2 - 1].pricePerHour + sorted[n / 2].pricePerHour) / 2;
  return { count: n, min: sorted[0].pricePerHour, median, max: sorted[n - 1].pricePerHour, best: sorted[0] };
}

/** Whole hours of rental left in this month's budget at `pricePerHour`; null when it cannot be computed. */
export function hoursLeft(budget: number, monthCost: number, pricePerHour: number): number | null {
  if (!Number.isFinite(budget) || !Number.isFinite(monthCost) || !Number.isFinite(pricePerHour) || pricePerHour <= 0) return null;
  return Math.max(0, Math.floor((budget - monthCost) / pricePerHour));
}

/** 0..1 share of the monthly budget spent (clamped); 0 when there is no budget. */
export function budgetRatio(budget: number, spent: number): number {
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(spent)) return 0;
  return Math.max(0, Math.min(1, spent / budget));
}

export function budgetTone(ratio: number): 'accent' | 'warning' | 'danger' {
  return ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : 'accent';
}

// ───────────────────────────── Warm-up estimate ─────────────────────────────

/** Heuristic download speed on a rented machine (SPEC §5b: sizeGb / ~150 MB/s). */
export const DOWNLOAD_MB_PER_SEC = 150;
/** Instance boot + SSH + docker pull overhead (seconds). */
export const BOOT_OVERHEAD_SEC = 120;
/** Weights → VRAM load time per GB (seconds). */
export const LOAD_SEC_PER_GB = 2;

export function warmupSeconds(model: Pick<CatalogModel, 'sizeGb'> | undefined | null): number {
  if (!model) return 0;
  return Math.round((model.sizeGb * 1000) / DOWNLOAD_MB_PER_SEC + BOOT_OVERHEAD_SEC + model.sizeGb * LOAD_SEC_PER_GB);
}

/** "~5 min", "~1 h 05 min". */
export function formatWarmup(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `~${h} h ${String(m).padStart(2, '0')} min` : `~${h} h`;
}

/** Money burnt while the machine warms up (billed per second from the moment it is rented). */
export function warmupCost(seconds: number, pricePerHour: number | null | undefined): number | null {
  if (pricePerHour == null || !Number.isFinite(pricePerHour)) return null;
  return (seconds / 3600) * pricePerHour;
}

// ───────────────────────────── Profiles & catalog ─────────────────────────────

/** "1× RTX 5090", "2× RTX PRO 6000". */
export function gpuSpec(profile: Pick<GpuProfile, 'numGpus' | 'gpuNames'>): string {
  const base = (profile.gpuNames[0] ?? 'GPU').replace(/\s+(WS|S|Max-Q)$/i, '');
  return `${profile.numGpus}× ${base}`;
}

/** Nominal total VRAM of a profile ("minGpuRamGb" is the Vast-reported figure, e.g. 30 for a 32 GB card). */
export function profileVramGb(profile: Pick<GpuProfile, 'numGpus' | 'minGpuRamGb'>): number {
  return profile.numGpus * Math.ceil(profile.minGpuRamGb / 8) * 8;
}

export function isTestModel(m: Pick<CatalogModel, 'family' | 'id'>): boolean {
  return m.family === 'test' || m.id.startsWith('test-');
}

/** Catalog models recommended for a profile (always including its default), cheapest download first within a family. */
export function profileModels(catalog: readonly CatalogModel[], profile: Pick<GpuProfile, 'id' | 'defaultModelId'>, opts: { includeTest?: boolean } = {}): CatalogModel[] {
  const out = catalog.filter((m) => (m.profiles.includes(profile.id) || m.id === profile.defaultModelId) && (opts.includeTest || !isTestModel(m) || m.id === profile.defaultModelId));
  return out.sort((a, b) => {
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    return a.sizeGb - b.sizeGb;
  });
}

/**
 * The model to select when the user flips the Uncensored ↔ Standard toggle: same family, other variant, recommended for the
 * profile; the closest download size wins. Falls back to any model of that variant for the profile.
 */
export function siblingModel(
  catalog: readonly CatalogModel[],
  current: CatalogModel | undefined,
  variant: 'uncensored' | 'standard',
  profile: Pick<GpuProfile, 'id' | 'defaultModelId'>,
  opts: { includeTest?: boolean } = {},
): CatalogModel | undefined {
  const pool = profileModels(catalog, profile, opts).filter((m) => m.variant === variant);
  if (pool.length === 0) return undefined;
  if (!current) return pool.find((m) => m.id === profile.defaultModelId) ?? pool[0];
  const sameFamily = pool.filter((m) => m.family === current.family);
  const candidates = sameFamily.length ? sameFamily : pool;
  return [...candidates].sort((a, b) => Math.abs(a.sizeGb - current.sizeGb) - Math.abs(b.sizeGb - current.sizeGb))[0];
}

/** Variants that exist for a profile (to disable the missing side of the toggle). */
export function availableVariants(catalog: readonly CatalogModel[], profile: Pick<GpuProfile, 'id' | 'defaultModelId'>, opts: { includeTest?: boolean } = {}): Set<'uncensored' | 'standard'> {
  return new Set(profileModels(catalog, profile, opts).map((m) => m.variant));
}

/** Short display label: "Qwen3.8 27B Uncensored - HauhauCS Q5_K_P" → name + detail. */
export function splitModelLabel(label: string): { name: string; detail: string } {
  const m = label.match(/^(.*?)\s+[·\-–]\s+(.*)$/);
  return m ? { name: m[1].trim(), detail: m[2].trim() } : { name: label, detail: '' };
}

export function contextLabel(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M ctx`;
  return `${Math.round(tokens / 1024)}k ctx`;
}

// ───────────────────────────── History ─────────────────────────────

export const END_REASON_LABEL: Record<NonNullable<GpuSessionRecord['endReason']>, string> = {
  clock_out: 'Clocked out',
  idle: 'Idle timeout',
  app_quit: 'App quit',
  budget: 'Budget reached',
  max_hours: 'Max hours',
  error: 'Error',
  orphan_cleanup: 'Orphan cleanup',
  server_watchdog: 'Server watchdog',
};

export function endReasonTone(reason: GpuSessionRecord['endReason']): 'neutral' | 'warning' | 'danger' | 'success' {
  switch (reason) {
    case 'clock_out':
    case 'app_quit':
      return 'success';
    case 'error':
    case 'orphan_cleanup':
    case 'server_watchdog':
      return 'danger';
    case 'budget':
    case 'max_hours':
    case 'idle':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function sumCost(records: readonly Pick<GpuSessionRecord, 'cost'>[]): number {
  return records.reduce((a, r) => a + (Number.isFinite(r.cost) ? r.cost : 0), 0);
}
