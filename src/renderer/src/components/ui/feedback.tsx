// Spinner, ProgressBar, Skeleton, EmptyState, StatusDot. Owner: ui-foundation.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

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
      className={cn('shrink-0 animate-[ob-spin_0.8s_linear_infinite]', className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'violet';

const BAR_TONES: Record<Tone, string> = {
  neutral: 'bg-ob-text-3',
  accent: 'bg-ob-accent',
  success: 'bg-ob-success',
  warning: 'bg-ob-warning',
  danger: 'bg-ob-danger',
  violet: 'bg-ob-violet',
};

export interface ProgressBarProps {
  /** 0..1; undefined/null = indeterminate. */
  value?: number | null;
  tone?: Tone;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  label?: string;
}

export function ProgressBar({ value, tone = 'accent', size = 'sm', className, label }: ProgressBarProps) {
  const indeterminate = value == null || !Number.isFinite(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, value as number)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cn(
        'relative w-full overflow-hidden rounded-pill bg-[rgba(236,240,241,0.07)]',
        size === 'xs' ? 'h-[3px]' : size === 'sm' ? 'h-1' : 'h-1.5',
        className,
      )}
    >
      {indeterminate ? (
        <div className={cn('absolute inset-y-0 left-0 w-2/5 rounded-pill animate-[ob-indeterminate_1.3s_ease-in-out_infinite]', BAR_TONES[tone])} />
      ) : (
        <div className={cn('h-full rounded-pill transition-[width] duration-300 ease-out', BAR_TONES[tone])} style={{ width: `${pct}%` }} />
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

export function EmptyState({ icon: Icon, title, description, action, className, size = 'md' }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', size === 'md' ? 'gap-3 px-6 py-12' : 'gap-2 px-4 py-8', className)}>
      {Icon ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-[10px] border border-ob-border bg-ob-surface-2 text-ob-text-2',
            size === 'md' ? 'size-10' : 'size-8',
          )}
        >
          <Icon size={size === 'md' ? 18 : 16} aria-hidden />
        </div>
      ) : null}
      <div className="flex max-w-[360px] flex-col gap-1">
        <div className={cn('font-medium text-ob-text', size === 'md' ? 'text-[14px]' : 'text-ui')}>{title}</div>
        {description ? <div className="text-ui text-ob-text-3">{description}</div> : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

// ───────────────────────────── StatusDot ─────────────────────────────

const DOT_TONES: Record<Tone, string> = {
  neutral: 'bg-ob-text-3',
  accent: 'bg-ob-accent',
  success: 'bg-ob-success',
  warning: 'bg-ob-warning',
  danger: 'bg-ob-danger',
  violet: 'bg-ob-violet',
};

const DOT_GLOW: Record<Tone, string> = {
  neutral: '',
  accent: 'shadow-[0_0_0_3px_rgba(143,184,222,0.16)]',
  success: 'shadow-[0_0_0_3px_rgba(95,211,154,0.16)]',
  warning: 'shadow-[0_0_0_3px_rgba(232,184,92,0.16)]',
  danger: 'shadow-[0_0_0_3px_rgba(240,113,120,0.16)]',
  violet: 'shadow-[0_0_0_3px_rgba(179,166,232,0.16)]',
};

/** Map common status strings to tones. */
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
      return 'accent';
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
  glow?: boolean;
  size?: 6 | 7 | 8;
  className?: string;
  label?: string;
}

export function StatusDot({ tone, status, pulse, glow, size = 7, className, label }: StatusDotProps) {
  const t = tone ?? statusTone(status);
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('relative inline-flex shrink-0 rounded-full', DOT_TONES[t], glow && DOT_GLOW[t], pulse && 'animate-ob-pulse', className)}
      style={{ width: size, height: size }}
    />
  );
}
