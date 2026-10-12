// Tooltip (Radix). Owner: ui-foundation.
import * as RT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { Shortcut } from './kbd';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RT.Provider delayDuration={450} skipDelayDuration={200}>
    {children}
  </RT.Provider>
);

export interface TooltipProps {
  content: ReactNode;
  /** Keyboard shortcut shown after the label, e.g. "Ctrl+K". */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
  className?: string;
  /** Must be a single element that can hold a ref (button, span…). */
  children: ReactNode;
}

export function Tooltip({ content, shortcut, side = 'top', align = 'center', sideOffset = 6, delayDuration, disabled, className, children }: TooltipProps) {
  if (disabled || (!content && !shortcut)) return <>{children}</>;
  return (
    <RT.Root delayDuration={delayDuration}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            'z-[100] flex max-w-[280px] items-center gap-2 rounded-[6px] border border-ob-border bg-ob-surface-3 px-2 py-1 text-small text-ob-text shadow-pop',
            'animate-ob-fade-in select-none',
            className,
          )}
        >
          <span className="min-w-0">{content}</span>
          {shortcut ? <Shortcut keys={shortcut} className="-mr-0.5" /> : null}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
