// Badge. Owner: ui-foundation.
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import type { Tone } from './feedback';

const SOFT: Record<Tone, string> = {
  neutral: 'bg-[rgba(236,240,241,0.06)] text-ob-text-2 border-[rgba(236,240,241,0.08)]',
  accent: 'bg-ob-accent-soft text-ob-accent border-[rgba(143,184,222,0.22)]',
  success: 'bg-ob-success-soft text-ob-success border-[rgba(95,211,154,0.22)]',
  warning: 'bg-ob-warning-soft text-ob-warning border-[rgba(232,184,92,0.22)]',
  danger: 'bg-ob-danger-soft text-ob-danger border-[rgba(240,113,120,0.24)]',
  violet: 'bg-ob-violet-soft text-ob-violet border-[rgba(179,166,232,0.22)]',
};

const OUTLINE: Record<Tone, string> = {
  neutral: 'text-ob-text-2 border-ob-border',
  accent: 'text-ob-accent border-[rgba(143,184,222,0.35)]',
  success: 'text-ob-success border-[rgba(95,211,154,0.35)]',
  warning: 'text-ob-warning border-[rgba(232,184,92,0.35)]',
  danger: 'text-ob-danger border-[rgba(240,113,120,0.35)]',
  violet: 'text-ob-violet border-[rgba(179,166,232,0.35)]',
};

export interface BadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  tone?: Tone;
  variant?: 'soft' | 'outline';
  size?: 'sm' | 'md';
  /** Mono uppercase label style (e.g. "UNCENSORED"). */
  mono?: boolean;
  pill?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', variant = 'soft', size = 'sm', mono, pill, icon: Icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap border font-medium',
        variant === 'soft' ? SOFT[tone] : OUTLINE[tone],
        size === 'sm' ? 'h-[18px] px-1.5 text-meta' : 'h-[22px] px-2 text-small',
        pill ? 'rounded-pill' : 'rounded-[4px]',
        mono && 'font-mono text-[10px] uppercase tracking-[0.06em]',
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon size={size === 'sm' ? 11 : 12} aria-hidden /> : null}
      {children}
    </span>
  );
}
