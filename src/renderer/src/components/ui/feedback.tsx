// Spinner, ProgressBar (flat bar + segmented "disk meter"), Skeleton, EmptyState, StatusDot. Owner: ui-foundation.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

/** Minimal spinner: a faint ring with one rotating quarter arc. Inherits currentColor. */
export function Spinner({ size = 14, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('shrink-0 animate-[ob-spin_0.9s_linear_infinite]', className)}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="butt" />
    </svg>
  );
}

/**
 * Tones. Colour only means status: accent = cold white (the live edge / selection), success = --ok,
 * warning = --warn (waiting for you), danger = --err, violet = --live (running / streaming), neutral = grey.
 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'violet';

const BAR_TONES: Record<Tone, string> = {
  neutral: 'bg-t2',
  accent: 'bg-acc',
  success: 'bg-ok',
  warning: 'bg-warn',
  danger: 'bg-err',
  violet: 'bg-live',
};

export interface ProgressBarProps {
  /** 0..1; undefined/null = indeterminate. */
  value?: number | null;
  tone?: Tone;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  label?: string;
  /** 'bar' = flat 2–4 px track · 'segments' = the reference "disk meter" (discrete cells). */
  variant?: 'bar' | 'segments';
  /** Cell count for variant="segments" (default 20). */
  segments?: number;
}

export function ProgressBar({ value, tone = 'accent', size = 'sm', className, label, variant = 'bar', segments = 20 }: ProgressBarProps) {
  const indeterminate = value == null || !Number.isFinite(value);
  const ratio = indeterminate ? 0 : Math.max(0, Math.min(1, value as number));
  const pct = ratio * 100;
  const aria = {
    role: 'progressbar' as const,
    'aria-label': label,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': indeterminate ? undefined : Math.round(pct),
  };

  if (variant === 'segments' && !indeterminate) {
    const filled = Math.round(ratio * segments);
    // Filled cells are grey (t2) unless the tone carries a status (warning / danger…), like the reference capbar.
    const on = tone === 'accent' || tone === 'neutral' ? 'bg-t2' : BAR_TONES[tone];
    return (
      <div {...aria} className={cn('flex w-full gap-[2px]', size === 'xs' ? 'h-1' : size === 'sm' ? 'h-1.5' : 'h-2', className)}>
        {Array.from({ length: segments }, (_, i) => (
          <i key={i} className={cn('block flex-1', i < filled ? on : 'bg-s4')} />
        ))}
      </div>
    );
  }

  return (
    <div
      {...aria}
      className={cn('relative w-full overflow-hidden bg-s4', size === 'xs' ? 'h-[2px]' : size === 'sm' ? 'h-[3px]' : 'h-1', className)}
    >
      {indeterminate ? (
        <div className={cn('absolute inset-y-0 left-0 w-2/5 animate-[ob-indeterminate_1.3s_ease-in-out_infinite]', BAR_TONES[tone])} />
      ) : (
        <div className={cn('h-full transition-[width] duration-300 ease-out', BAR_TONES[tone])} style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('ob-skeleton h-3', className)} />;
}

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  size?: 'sm' | 'md';
}

/** No tile, no frame: a quiet glyph, a title and one line of help, floating in space. */
export function EmptyState({ icon: Icon, title, description, action, className, size = 'md' }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', size === 'md' ? 'gap-3 px-6 py-12' : 'gap-2 px-4 py-8', className)}>
      {Icon ? <Icon size={size === 'md' ? 18 : 16} aria-hidden className="text-t3" /> : null}
      <div className="flex max-w-[360px] flex-col gap-1">
        <div className={cn('font-semibold text-t1', size === 'md' ? 'text-[13.5px] tracking-[-0.022em]' : 'text-[12.5px] tracking-[-0.016em]')}>{title}</div>
        {description ? <div className="text-[11.5px] leading-[1.5] text-t3">{description}</div> : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

// ───────────────────────────── StatusDot ─────────────────────────────

const DOT_TONES: Record<Tone, string> = {
  neutral: 'bg-line',
  accent: 'bg-acc',
  success: 'bg-ok',
  warning: 'bg-warn',
  danger: 'bg-err',
  violet: 'bg-live',
};

// A flat 3 px halo at 18 % (reference .recdot) — not a glow.
const DOT_HALO: Record<Tone, string> = {
  neutral: '',
  accent: 'shadow-[0_0_0_3px_rgba(230,238,255,0.16)]',
  success: 'shadow-[0_0_0_3px_rgba(59,224,122,0.18)]',
  warning: 'shadow-[0_0_0_3px_rgba(255,212,38,0.18)]',
  danger: 'shadow-[0_0_0_3px_rgba(255,111,98,0.18)]',
  violet: 'shadow-[0_0_0_3px_rgba(191,107,255,0.2)]',
};

/** Map common status strings to tones: running/in-flight → violet (--live), waiting → warning, done → success. */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'online':
    case 'ready':
    case 'done':
    case 'ok':
    case 'completed':
    case 'success':
      return 'success';
    case 'running':
    case 'starting':
    case 'in_progress':
    case 'searching':
    case 'renting':
    case 'connecting':
    case 'downloading':
    case 'loading':
    case 'switching':
      return 'violet';
    case 'waiting':
    case 'awaiting_permission':
    case 'pending':
    case 'stopping':
    case 'warning':
    case 'skipped':
      return 'warning';
    case 'error':
    case 'denied':
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

export interface StatusDotProps {
  tone?: Tone;
  /** Alternative to tone: a status string mapped with statusTone(). */
  status?: string | null;
  pulse?: boolean;
  /** Flat halo ring (live/recording emphasis). */
  glow?: boolean;
  size?: 5 | 6 | 7 | 8;
  className?: string;
  label?: string;
}

export function StatusDot({ tone, status, pulse, glow, size = 6, className, label }: StatusDotProps) {
  const t = tone ?? statusTone(status);
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('relative inline-flex shrink-0 rounded-full', DOT_TONES[t], glow && DOT_HALO[t], pulse && 'animate-ob-pulse', className)}
      style={{ width: size, height: size }}
    />
  );
}
