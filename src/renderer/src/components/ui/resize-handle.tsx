// Drag handle on a panel's edge (owner: ui-foundation). Sits over the panel's --rule hairline: invisible until hovered,
// --line on hover, --acc while dragging. Drag to resize, double-click (or Enter) for the default width, and with the
// keyboard: ←/→ (Shift = bigger steps), Home / End = narrowest / widest. The parent must be `relative`.
import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@renderer/lib/cn';

export interface ResizeHandleProps {
  /** Which edge of the panel the handle sits on: 'right' grows the panel when dragged right, 'left' when dragged left. */
  edge: 'left' | 'right';
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  className?: string;
  testId?: string;
}

/** Window width, live (panels cap their saved width to what the window allows). */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    () => window.innerWidth,
  );
}

const STEP = 16;
const BIG_STEP = 64;

/** Body class while a handle is dragged: the resize cursor everywhere and no text selection. */
const RESIZING_CLASS = 'ob-resizing';

export function clampSize(v: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, v)));
}

/** The width a drag from `startX` (at `startWidth`) to `x` gives. */
export function dragWidth(edge: 'left' | 'right', startWidth: number, startX: number, x: number, min: number, max: number): number {
  const delta = edge === 'right' ? x - startX : startX - x;
  return clampSize(startWidth + delta, min, max);
}

/** The width a key press gives, or null for keys the handle ignores. */
export function keyWidth(edge: 'left' | 'right', key: string, shift: boolean, value: number, min: number, max: number, defaultValue: number): number | null {
  const step = shift ? BIG_STEP : STEP;
  const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight';
  if (key === grow) return clampSize(value + step, min, max);
  if (key === shrink) return clampSize(value - step, min, max);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key === 'Enter') return clampSize(defaultValue, min, max);
  return null;
}

export function ResizeHandle({ edge, value, min, max, defaultValue, onChange, label, className, testId }: ResizeHandleProps) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const stop = () => {
    start.current = null;
    setDragging(false);
    document.documentElement.classList.remove(RESIZING_CLASS);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start.current = { x: e.clientX, w: value };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    document.documentElement.classList.add(RESIZING_CLASS);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const w = dragWidth(edge, start.current.w, start.current.x, e.clientX, min, max);
    if (w !== value) onChange(w);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const w = keyWidth(edge, e.key, e.shiftKey, value, min, max, defaultValue);
    if (w === null) return;
    e.preventDefault();
    if (w !== value) onChange(w);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      data-dragging={dragging || undefined}
      title={`${label} — drag, or double-click for the default width`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => onChange(clampSize(defaultValue, min, max))}
      onKeyDown={onKeyDown}
      className={cn(
        // 8 px hit area, mostly outside the panel so it stays clear of the panel's own scrollbar.
        'group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none select-none outline-offset-[-1px]',
        edge === 'right' ? '-right-[6px]' : '-left-[6px]',
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          'absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-line group-focus-visible:bg-acc',
          edge === 'right' ? 'left-px' : 'right-px',
          dragging && '!bg-acc',
        )}
      />
    </div>
  );
}
