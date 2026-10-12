// Card (a plain hairline-separated section), SectionLabel, ScrollArea, Separator. Owner: ui-foundation.
import * as RSA from '@radix-ui/react-scroll-area';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { cn } from '@renderer/lib/cn';

export interface CardProps extends ComponentProps<'div'> {
  /**
   * M13 has no cards. 'flat' / 'ghost' = no fill, no frame (consecutive Cards are separated by one --rule hairline);
   * 'raised' = an --s1 well for the rare block that must read as a container (code-like content).
   */
  variant?: 'flat' | 'raised' | 'ghost';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover affordance for clickable sections (--hov wash). */
  interactive?: boolean;
}

export function Card({ variant = 'flat', padding = 'md', interactive, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'ob-card [.ob-card+&]:border-t [.ob-card+&]:border-rule',
        variant === 'raised' && 'rounded-[2px] bg-s1',
        padding === 'sm' && 'py-3',
        padding === 'md' && 'py-4',
        padding === 'lg' && 'py-5',
        (variant === 'raised' || interactive) && padding === 'sm' && 'px-3',
        (variant === 'raised' || interactive) && padding === 'md' && 'px-4',
        (variant === 'raised' || interactive) && padding === 'lg' && 'px-5',
        interactive && 'ob-transition cursor-default hover:bg-hov',
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
  /** Draw the reference's trailing hairline (.cap s) between the label and the action. */
  rule?: boolean;
}

/** Chivo Mono 9 px, weight 500, .22em, UPPERCASE, --t3 (reference .cap). */
export function SectionLabel({ children, action, className, as: As = 'div', rule }: SectionLabelProps) {
  return (
    <As className={cn('ob-cap flex min-h-6 items-center gap-2.5', !rule && 'justify-between', className)}>
      <span className="truncate">{children}</span>
      {rule ? <span aria-hidden className="h-px min-w-4 flex-1 bg-rule2" /> : null}
      {action ? <span className="flex shrink-0 items-center gap-1 tracking-[0.1em]">{action}</span> : null}
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
      className={cn('z-10 flex touch-none select-none p-px transition-colors duration-150', orientation === 'vertical' ? 'h-full w-1.5' : 'h-1.5 flex-col')}
    >
      <RSA.Thumb className="relative flex-1 rounded-[2px] bg-s4 hover:bg-s5" />
    </RSA.Scrollbar>
  );
}

/** Thin overlay scrollbars (Radix): 6 px, --s4 thumb, no track. The viewport fills the root; give the root a height. */
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

/** The hairline (--rule), or the sub-hairline (--rule2) with `subtle`. */
export function Separator({ className, vertical, subtle }: { className?: string; vertical?: boolean; subtle?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn('shrink-0', subtle ? 'bg-rule2' : 'bg-rule', vertical ? 'w-px self-stretch' : 'h-px w-full', className)}
    />
  );
}
