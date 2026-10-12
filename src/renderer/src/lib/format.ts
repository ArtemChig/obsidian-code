// Formatting helpers shared by every renderer area. Owner: ui-foundation. Pure functions (unit-tested).
import type { ModelRef } from '@shared/types';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * "now", "45s", "12m", "3h", "yesterday", "4d", "Mar 3", "Mar 3, 2025".
 * short=true uses "1d" instead of "yesterday" and "5w" instead of dates within ~2 months (sidebars).
 */
export function relativeTime(ts: number, now: number = Date.now(), opts: { short?: boolean } = {}): string {
  const diff = now - ts;
  if (diff < 0) return relativeFuture(-diff);
  if (diff < 10 * SEC) return 'now';
  if (diff < MIN) return `${Math.floor(diff / SEC)}s`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 2 * DAY) return opts.short ? '1d' : 'yesterday';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  if (opts.short && diff < 9 * 7 * DAY) return `${Math.floor(diff / (7 * DAY))}w`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "in 5m", "in 2h", "in 3d" */
export function relativeFuture(diffMs: number): string {
  if (diffMs < MIN) return 'in <1m';
  if (diffMs < HOUR) return `in ${Math.round(diffMs / MIN)}m`;
  if (diffMs < DAY) return `in ${Math.round(diffMs / HOUR)}h`;
  return `in ${Math.round(diffMs / DAY)}d`;
}

/** Long relative form for tooltips/lists: "5 minutes ago", "in 2 hours". */
export function relativeTimeLong(ts: number, now: number = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < MIN) return rtf.format(Math.round(diff / SEC), 'second');
  if (abs < HOUR) return rtf.format(Math.round(diff / MIN), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  return rtf.format(Math.round(diff / DAY), 'day');
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Compact duration: "850ms", "12s", "3m 04s", "1h 02m", "2d 3h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < SEC) return `${Math.round(ms)}ms`;
  if (ms < MIN) return `${Math.floor(ms / SEC)}s`;
  if (ms < HOUR) {
    const m = Math.floor(ms / MIN);
    const s = Math.floor((ms % MIN) / SEC);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return `${d}d ${h}h`;
}

/** Stopwatch: "0:42", "12:05", "1:02:03". */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / SEC);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** USD: "$0.00", "$1.19", "$0.0042" for tiny amounts when precise=true. */
export function formatMoney(usd: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (usd == null || !Number.isFinite(usd)) return '—';
  const abs = Math.abs(usd);
  const digits = opts.precise && abs > 0 && abs < 0.1 ? 3 : 2;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${usd < 0 ? '-' : ''}$${s}`;
}

export function formatPerHour(usd: number | null | undefined): string {
  return usd == null ? '—' : `${formatMoney(usd)}/h`;
}

/** Token counts: 950, 12.3k, 128k, 1.2M */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

// ───────────────────────────── Paths (Windows-aware) ─────────────────────────────

export function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** Last path segment: "C:\\a\\b\\proj" → "proj", "/home/x/" → "x", "C:\\" → "C:". */
export function basename(p: string): string {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : p;
}

export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx <= 0 ? trimmed : trimmed.slice(0, idx);
}

/** Collapse the home dir to "~" and keep the last `keep` segments: "~/…/projects/app". */
export function shortenPath(p: string, homeDir?: string | null, keep = 3): string {
  let s = p;
  const sep = p.includes('\\') ? '\\' : '/';
  if (homeDir && s.toLowerCase().startsWith(homeDir.toLowerCase())) s = `~${s.slice(homeDir.length)}`;
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep + 1) return s;
  const head = parts[0];
  return [head, '…', ...parts.slice(-keep)].join(sep);
}

/** Path relative to cwd when inside it, else the original path. */
export function relativeToCwd(p: string, cwd: string): string {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const b = norm(cwd);
  if (a.toLowerCase().startsWith(`${b.toLowerCase()}/`)) return a.slice(b.length + 1);
  return p;
}

// ───────────────────────────── Models ─────────────────────────────

export function modelKey(ref: ModelRef | null | undefined): string {
  return ref ? `${ref.provider}::${ref.model}` : '';
}

export function parseModelKey(key: string): ModelRef | null {
  const idx = key.indexOf('::');
  if (idx < 0) return null;
  return { provider: key.slice(0, idx) as ModelRef['provider'], model: key.slice(idx + 2) };
}

export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/** Strip a path / quant suffix for display: "unsloth/Qwen3.8-27B-GGUF:Q5_K_M" → "Qwen3.8-27B". */
export function shortModelName(id: string): string {
  let s = basename(id);
  s = s.replace(/\.gguf$/i, '');
  s = s.replace(/[-_.]GGUF.*$/i, '');
  s = s.replace(/:.*$/, '');
  return s;
}

export function providerLabel(provider: string): string {
  if (provider === 'local') return 'Local';
  if (provider === 'vast') return 'Vast GPU';
  if (provider.startsWith('custom:')) return provider.slice(7);
  return provider;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
