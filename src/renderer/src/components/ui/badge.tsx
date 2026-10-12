// Badge → the M13 tag: 1 px border, Chivo Mono 8.5 px uppercase tracked (reference .pill / .chip2). Owner: ui-foundation.
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import type { Tone } from './feedback';

// Neutral tags carry the functional --line outline; status tones use their colour at ~45 % for the edge.
const EDGE: Record<Tone, string> = {
  neutral: 'text-t1 shadow-[inset_0_0_0_1px_var(--line)]',
  accent: 'text-acc shadow-[inset_0_0_0_1px_var(--acc)]',
  success: 'text-ok shadow-[inset_0_0_0_1px_var(--ok-edge)]',
  warning: 'text-warn shadow-[inset_0_0_0_1px_var(--warn-edge)]',
  danger: 'text-err shadow-[inset_0_0_0_1px_var(--err-edge)]',
  violet: 'text-live shadow-[inset_0_0_0_1px_var(--live-edge)]',
};

// 'soft' adds the faint status wash; neutral stays fill-free.
const WASH: Record<Tone, string> = {
  neutral: '',
  accent: 'bg-acc-wash',
  success: 'bg-ok-wash',
  warning: 'bg-warn-wash',
  danger: 'bg-err-wash',
  violet: 'bg-live-wash',
};

export interface BadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  tone?: Tone;
  /** 'outline' = edge only · 'soft' = edge + faint status wash (neutral: identical). */
  variant?: 'soft' | 'outline';
  size?: 'sm' | 'md';
  /** Kept for API compatibility: every tag is mono uppercase in M13. */
  mono?: boolean;
  /** Kept for API compatibility: tags are square (1 px radius) in M13. */
  pill?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', variant = 'soft', size = 'sm', mono, pill, icon: Icon, className, children, ...rest }: BadgeProps) {
  void mono;
  void pill;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center gap-[5px] whitespace-nowrap rounded-[1px] font-mono font-medium uppercase leading-none',
        EDGE[tone],
        variant === 'soft' && WASH[tone],
        size === 'sm' ? 'h-[17px] px-1.5 text-[8.5px] tracking-[0.14em]' : 'h-5 px-2 text-[9.5px] tracking-[0.14em]',
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon size={size === 'sm' ? 9 : 10} aria-hidden /> : null}
      {children}
    </span>
  );
}
