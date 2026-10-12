// Composer popover list for "/" commands and "@" file mentions. Keyboard lives in the composer textarea
// (focus never leaves it); this component only renders and scrolls the active row into view. Owner: ui-chat.
import { useEffect, useRef, type ReactNode } from 'react';
import { Spinner } from '@renderer/components/ui/feedback';
import { Kbd } from '@renderer/components/ui/kbd';
import { cn } from '@renderer/lib/cn';

export interface PaletteItem {
  key: string;
  label: ReactNode;
  /** Muted text right after the label (argument hint, directory). */
  hint?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
}

export interface PaletteProps {
  id: string;
  testId: string;
  title: string;
  items: PaletteItem[];
  active: number;
  loading?: boolean;
  empty?: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

export function optionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

export function Palette({ id, testId, title, items, active, loading, empty = 'No matches', onPick, onHover }: PaletteProps) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);

  return (
    <div
      className="ob-popover absolute inset-x-0 bottom-[calc(100%+6px)] z-40 overflow-hidden animate-ob-pop-in"
      data-testid={testId}
      onMouseDown={(e) => e.preventDefault() /* keep focus in the textarea */}
    >
      <div className="flex h-8 items-center gap-2 border-b border-ob-border px-3">
        <span className="ob-section-label text-[10px]">{title}</span>
        {loading ? <Spinner size={11} className="text-ob-text-3" /> : null}
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-meta text-ob-text-3">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span className="mr-1.5">navigate</span>
          <Kbd>Tab</Kbd>
          <span>complete</span>
        </span>
      </div>
      <div ref={list} id={id} role="listbox" aria-label={title} className="max-h-[min(320px,42vh)] overflow-y-auto p-1">
        {items.length === 0 ? (
          <div className="px-3 py-4 text-center text-small text-ob-text-3">{loading ? 'Searching…' : empty}</div>
        ) : (
          items.map((it, i) => (
            <div
              key={it.key}
              id={optionId(id, i)}
              role="option"
              aria-selected={i === active}
              data-index={i}
              data-testid="palette-item"
              onMouseMove={() => i !== active && onHover(i)}
              onClick={() => onPick(i)}
              className={cn(
                'flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-[6px] px-2.5 py-1.5',
                i === active ? 'bg-ob-accent-soft text-ob-text' : 'text-ob-text-2',
              )}
            >
              {it.icon ? <span className={cn('flex shrink-0 items-center', i === active ? 'text-ob-accent' : 'text-ob-text-3')}>{it.icon}</span> : null}
              <span className="flex min-w-0 flex-1 items-baseline gap-3">
                <span className={cn('flex min-w-0 items-baseline gap-2', it.description ? 'w-[min(40%,230px)] shrink-0' : 'flex-1')}>
                  <span className="shrink-0 truncate text-ui">{it.label}</span>
                  {it.hint ? <span className="min-w-0 truncate font-mono text-[11px] text-ob-text-3">{it.hint}</span> : null}
                </span>
                {it.description ? <span className="min-w-0 flex-1 truncate text-small text-ob-text-3">{it.description}</span> : null}
              </span>
              {it.trailing}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
