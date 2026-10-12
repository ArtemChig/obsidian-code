// Live time helpers: useNow (shared ticker), RelativeTime, LiveDuration. Owner: ui-foundation.
import { useCallback, useState, useSyncExternalStore } from 'react';
import { cn } from '@renderer/lib/cn';
import { formatClock, formatDateTime, formatDuration, relativeTime } from '@renderer/lib/format';

// One interval per period, shared by every subscriber.
const tickers = new Map<number, { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null; now: number }>();

function subscribe(period: number, fn: () => void): () => void {
  let t = tickers.get(period);
  if (!t) {
    t = { listeners: new Set(), timer: null, now: Date.now() };
    tickers.set(period, t);
  }
  const ticker = t;
  ticker.listeners.add(fn);
  if (!ticker.timer) {
    ticker.now = Date.now();
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const l of [...ticker.listeners]) l();
    }, period);
  }
  return () => {
    ticker.listeners.delete(fn);
    if (ticker.listeners.size === 0 && ticker.timer) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
}

/** Current time, re-rendering every `periodMs` (shared timers). Pass 0/false to disable ticking. */
export function useNow(periodMs: number | false = 1000): number {
  const period = periodMs || 0;
  const [mountedAt] = useState(() => Date.now());
  const sub = useCallback((fn: () => void) => (period ? subscribe(period, fn) : () => {}), [period]);
  return useSyncExternalStore(sub, () => (period ? (tickers.get(period)?.now ?? mountedAt) : mountedAt));
}

export interface RelativeTimeProps {
  ts: number;
  className?: string;
  /** Prefix such as "updated". */
  prefix?: string;
  /** Compact form ("1d", "5w") for dense lists. */
  short?: boolean;
  /** Append " ago" ("5m ago"; "just now" for the first seconds). */
  ago?: boolean;
}

/** "now", "5m", "3h", "yesterday"… with the full date in the tooltip. Updates every 30 s. */
export function RelativeTime({ ts, className, prefix, short, ago }: RelativeTimeProps) {
  const now = useNow(30_000);
  // Past timestamps only: a value written a moment ago (or by a clock a few ms ahead) reads "now", never "in <1m".
  const ref = Math.max(now, Date.now());
  const rel = relativeTime(Math.min(ts, ref), ref, { short });
  return (
    <time dateTime={new Date(ts).toISOString()} title={formatDateTime(ts)} className={cn('ob-tabular whitespace-nowrap', className)}>
      {prefix ? `${prefix} ` : ''}
      {ago ? (rel === 'now' ? 'just now' : /^\d/.test(rel) ? `${rel} ago` : rel) : rel}
    </time>
  );
}

export interface LiveDurationProps {
  /** Start epoch ms. */
  since: number;
  /** End epoch ms — when set the value is frozen. */
  until?: number | null;
  format?: 'clock' | 'compact';
  className?: string;
}

/** Ticking elapsed time: "1:02:03" (clock) or "3m 04s" (compact). */
export function LiveDuration({ since, until, format = 'clock', className }: LiveDurationProps) {
  const now = useNow(until ? false : 1000);
  const end = until ?? Math.max(now, since);
  const ms = Math.max(0, end - since);
  return <span className={cn('ob-tabular whitespace-nowrap', className)}>{format === 'clock' ? formatClock(ms) : formatDuration(ms)}</span>;
}
