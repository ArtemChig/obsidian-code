// Small shared pieces of the Models view. Owner: ui-views.
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/cn';

/** The star: lit (filled, --t1) when the repo is a favorite. */
export function FavoriteButton({ on, onToggle, size = 'sm', active }: { on: boolean; onToggle: () => void; size?: 'xs' | 'sm' | 'md'; active?: boolean }) {
  const px = size === 'xs' ? 12 : size === 'sm' ? 13 : 15;
  return (
    <IconButton
      label={on ? 'Remove from favorites' : 'Add to favorites'}
      size={size}
      active={active ? on : undefined}
      tooltipSide="bottom"
      data-testid="models-favorite"
      data-on={on || undefined}
      className={cn(on && 'text-t1')}
      icon={<Star size={px} aria-hidden className={on ? 'fill-current' : undefined} />}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

/** Mono number with an optional small unit after it (reference .num + .unit). */
export function Num({ children, unit, className }: { children: ReactNode; unit?: string; className?: string }) {
  return (
    <span className={cn('ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2', className)}>
      {children}
      {unit ? <span className="ob-unit ml-1">{unit}</span> : null}
    </span>
  );
}

/** A quiet error/notice line with an action on the right (hairline below, no frame). */
export function Notice({ children, action, tone = 'neutral', testId }: { children: ReactNode; action?: ReactNode; tone?: 'neutral' | 'warning' | 'danger'; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-center justify-between gap-3 border-b border-rule2 px-4 py-2 text-[11.5px] leading-[1.45]',
        tone === 'warning' ? 'text-warn' : tone === 'danger' ? 'text-err' : 'text-t3',
      )}
    >
      <span className="min-w-0">{children}</span>
      {action ? <span className="flex shrink-0 items-center gap-2">{action}</span> : null}
    </div>
  );
}
