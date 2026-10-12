// Card, SectionLabel, ScrollArea, Separator. Owner: ui-foundation.
import * as RSA from '@radix-ui/react-scroll-area';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { cn } from '@renderer/lib/cn';

export interface CardProps extends ComponentProps<'div'> {
  /** 'flat' = surface-1 (default), 'raised' = surface-2, 'ghost' = border only. */
  variant?: 'flat' | 'raised' | 'ghost';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover affordance for clickable cards. */
  interactive?: boolean;
}

export function Card({ variant = 'flat', padding = 'md', interactive, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-ob-border',
        variant === 'flat' && 'bg-ob-surface-1',
        variant === 'raised' && 'bg-ob-surface-2',
        variant === 'ghost' && 'bg-transparent',
        padding === 'sm' && 'p-3',
        padding === 'md' && 'p-4',
        padding === 'lg' && 'p-5',
        interactive && 'ob-transition cursor-default hover:border-[#30414f] hover:bg-[#121e24]',
        className,
      )}
      {...rest}
    />
  );
}

export interface SectionLabelProps {
  children: ReactNode;
  /** Right-aligned slot (count, action button…). */
  action?: ReactNode;
  className?: string;
  as?: 'div' | 'h2' | 'h3';
}

/** Mono uppercase 11 px label with .06em tracking (SPEC §5). */
export function SectionLabel({ children, action, className, as: As = 'div' }: SectionLabelProps) {
  return (
    <As className={cn('ob-section-label flex min-h-6 items-center justify-between gap-2', className)}>
      <span className="truncate">{children}</span>
      {action ? <span className="flex shrink-0 items-center gap-1 normal-case tracking-normal">{action}</span> : null}
    </As>
  );
}

export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  orientation?: 'vertical' | 'horizontal' | 'both';
  onScroll?: ComponentProps<'div'>['onScroll'];
}

function ScrollBar({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <RSA.Scrollbar
      orientation={orientation}
      className={cn(
        'z-10 flex touch-none select-none p-[2px] transition-colors duration-150',
        orientation === 'vertical' ? 'h-full w-2.5' : 'h-2.5 flex-col',
      )}
    >
      <RSA.Thumb className="relative flex-1 rounded-full bg-[#2b3a47] hover:bg-ob-border-strong" />
    </RSA.Scrollbar>
  );
}

/** Thin, dark, overlay scrollbars (Radix). The viewport fills the root; give the root a height. */
export function ScrollArea({ children, className, viewportClassName, viewportRef, orientation = 'vertical', onScroll }: ScrollAreaProps) {
  return (
    <RSA.Root type="hover" scrollHideDelay={500} className={cn('relative overflow-hidden', className)}>
      <RSA.Viewport ref={viewportRef} onScroll={onScroll} className={cn('size-full rounded-[inherit] [&>div]:!block', viewportClassName)}>
        {children}
      </RSA.Viewport>
      {orientation !== 'horizontal' ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== 'vertical' ? <ScrollBar orientation="horizontal" /> : null}
      <RSA.Corner />
    </RSA.Root>
  );
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} className={cn('shrink-0 bg-ob-border', vertical ? 'w-px self-stretch' : 'h-px w-full', className)} />;
}
