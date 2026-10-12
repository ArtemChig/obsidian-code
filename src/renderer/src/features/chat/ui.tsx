// Small building blocks shared by the chat transcript, cards and panels. Owner: ui-chat.
import { Check, ChevronDown, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ImageBlock, ToolStatus } from '@shared/types';
import { Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { StatusDot, type Tone } from '@renderer/components/ui/feedback';
import { useNow } from '@renderer/components/ui/time';
import { cn } from '@renderer/lib/cn';
import { formatBytes, formatDuration } from '@renderer/lib/format';
import { base64Bytes } from './lib/composer';

// ───────────────────────────── Clamp ("Show more") ─────────────────────────────

export interface ClampProps {
  children: ReactNode;
  /** Collapsed height in px. */
  maxHeight?: number;
  className?: string;
  /** Kept for API compatibility: M13 has no gradient fades — the cut is flat, closed by a "Show more" row. */
  fadeFrom?: string;
  /** Label suffix, e.g. "42 more lines". */
  moreLabel?: string;
  /** Called when the user expands/collapses. */
  onToggle?: (expanded: boolean) => void;
}

/** Clamps tall content with a flat cut and a "Show more" row; renders plainly when it fits. */
export function Clamp({ children, maxHeight = 320, className, moreLabel, onToggle }: ClampProps) {
  const inner = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > maxHeight + 24);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxHeight]);

  const toggle = useCallback(() => {
    setExpanded((e) => {
      onToggle?.(!e);
      return !e;
    });
  }, [onToggle]);

  const clamped = overflows && !expanded;
  return (
    <div className={cn('relative', className)}>
      <div ref={inner} style={clamped ? { maxHeight, overflow: 'hidden' } : undefined}>
        {children}
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={toggle}
          data-testid="show-more"
          aria-expanded={expanded}
          className="ob-transition flex h-6 w-full items-center justify-center gap-1.5 border-t border-rule2 font-mono text-[9px] uppercase tracking-[0.14em] text-t3 hover:bg-hov hover:text-t1"
        >
          <ChevronDown size={11} aria-hidden className={cn('transition-transform duration-150', expanded && 'rotate-180')} />
          {expanded ? 'Show less' : `Show more${moreLabel ? ` · ${moreLabel}` : ''}`}
        </button>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Tool status dot ─────────────────────────────

const STATUS_DOT: Record<ToolStatus, { tone: Tone; pulse?: boolean; label: string }> = {
  running: { tone: 'violet', pulse: true, label: 'Running' },
  pending: { tone: 'neutral', label: 'Queued' },
  awaiting_permission: { tone: 'warning', pulse: true, label: 'Needs permission' },
  done: { tone: 'success', label: 'Done' },
  error: { tone: 'danger', label: 'Failed' },
  denied: { tone: 'danger', label: 'Denied' },
  interrupted: { tone: 'warning', label: 'Interrupted' },
};

/** M13 status mark: a flat dot (violet running · yellow waiting on you · red failed · green done) centred in a `size` box. */
export function ToolStatusIcon({ status, size = 14, className }: { status: ToolStatus; size?: number; className?: string }) {
  const d = STATUS_DOT[status];
  if (!d) return null;
  return (
    <span role="img" aria-label={d.label} className={cn('inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
      <StatusDot tone={d.tone} pulse={d.pulse} size={6} />
    </span>
  );
}

// ───────────────────────────── Images ─────────────────────────────

export function imageSrc(img: Pick<ImageBlock, 'mediaType' | 'data'>): string {
  return `data:${img.mediaType};base64,${img.data}`;
}

export function ImageThumb({
  image,
  size = 64,
  natural,
  onRemove,
  onOpen,
  className,
}: {
  image: ImageBlock;
  size?: number;
  /** Keep the image's aspect ratio: `size` is the height, width follows (max 2.2× size). */
  natural?: boolean;
  onRemove?: () => void;
  onOpen?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn('group/thumb relative shrink-0', className)}
      style={natural ? { height: size, maxWidth: size * 2.2 } : { width: size, height: size }}
      data-testid="image-thumb"
    >
      <button
        type="button"
        onClick={onOpen}
        title={`${image.name ?? 'Image'} · ${formatBytes(base64Bytes(image.data))}`}
        className={cn('ob-transition overflow-hidden rounded-[2px] border border-rule bg-s2 hover:border-line', natural ? 'block h-full' : 'size-full')}
      >
        <img
          src={imageSrc(image)}
          alt={image.name ?? 'Attached image'}
          className={natural ? 'h-full w-auto max-w-full object-cover' : 'size-full object-cover'}
          draggable={false}
        />
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${image.name ?? 'image'}`}
          onClick={onRemove}
          className="ob-transition absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-[2px] bg-s0 text-t2 opacity-0 shadow-[inset_0_0_0_1px_var(--line)] hover:text-t1 group-hover/thumb:opacity-100 focus-visible:opacity-100"
        >
          <X size={11} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** Full-size image viewer. */
export function ImageLightbox({ image, onClose }: { image: ImageBlock | null; onClose: () => void }) {
  return (
    <Dialog open={!!image} onOpenChange={(o) => !o && onClose()}>
      {image ? (
        <DialogContent size="xl" title={image.name ?? 'Image'} description={`${image.mediaType} · ${formatBytes(base64Bytes(image.data))}`}>
          <div className="flex justify-center rounded-[2px] bg-s1 p-3">
            <img src={imageSrc(image)} alt={image.name ?? 'Image'} className="max-h-[60vh] max-w-full rounded-[2px]" />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

// ───────────────────────────── Numbered option rows (prompts) ─────────────────────────────

export interface OptionRowProps {
  index: number;
  title: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  /** 'radio' / 'check' draw an indicator; 'plain' only the number key. */
  kind?: 'radio' | 'check' | 'plain';
  tone?: 'accent' | 'danger' | 'warning';
  onSelect: () => void;
  trailing?: ReactNode;
  className?: string;
  testId?: string;
  /** One line: description inline after the title (permission / plan rows). */
  compact?: boolean;
}

// Selected row = the M13 selection recipe (wash + 2 px edge); deny / keep-planning rows use their status colour.
const TONE_SEL: Record<NonNullable<OptionRowProps['tone']>, string> = {
  accent: 'bg-acc-wash shadow-[inset_2px_0_0_var(--acc)]',
  warning: 'bg-warn-wash shadow-[inset_2px_0_0_var(--warn)]',
  danger: 'bg-err-wash shadow-[inset_2px_0_0_var(--err)]',
};
const TONE_KEY: Record<NonNullable<OptionRowProps['tone']>, string> = {
  accent: 'bg-acc text-acc-ink',
  warning: 'bg-warn text-black',
  danger: 'bg-err text-black',
};

/** A 32 px decision row on a sub-hairline: number in a key cap · optional radio / check · title + quiet description. */
export function OptionRow({ index, title, description, selected, kind = 'plain', tone = 'accent', onSelect, trailing, className, testId, compact }: OptionRowProps) {
  return (
    <button
      type="button"
      role={kind === 'check' ? 'checkbox' : kind === 'radio' ? 'radio' : undefined}
      aria-checked={kind === 'plain' ? undefined : !!selected}
      data-testid={testId}
      data-selected={selected || undefined}
      onClick={onSelect}
      className={cn(
        'ob-transition group flex min-h-8 w-full gap-3 border-b border-rule2 px-3 text-left',
        compact ? 'items-center py-1' : 'items-start py-[7px]',
        selected ? TONE_SEL[tone] : 'hover:bg-hov',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[2px] px-1 font-mono text-[10px] leading-none',
          selected ? TONE_KEY[tone] : 'bg-s3 text-t1 shadow-[inset_0_0_0_1px_var(--line)]',
        )}
        aria-hidden
      >
        {index}
      </span>
      {kind !== 'plain' ? (
        <span
          aria-hidden
          className={cn(
            'flex shrink-0 items-center justify-center',
            !compact && 'mt-[3px]',
            kind === 'radio' ? 'size-3 rounded-full' : 'size-[13px] rounded-[1px]',
            selected
              ? kind === 'radio'
                ? 'shadow-[inset_0_0_0_1px_var(--acc)]'
                : 'bg-acc text-acc-ink'
              : 'shadow-[inset_0_0_0_1px_var(--line)]',
          )}
        >
          {selected ? kind === 'radio' ? <span className="size-1.5 rounded-full bg-acc" /> : <Check size={10} strokeWidth={3} /> : null}
        </span>
      ) : null}
      <span className={cn('flex min-w-0 flex-1', compact ? 'flex-wrap items-baseline gap-x-3 gap-y-0.5' : 'flex-col gap-0.5')}>
        <span className="text-[12.5px] tracking-[-0.012em] text-t1">{title}</span>
        {description ? <span className="text-[11.5px] tracking-[-0.006em] text-t3">{description}</span> : null}
      </span>
      {trailing}
    </button>
  );
}

// ───────────────────────────── Composer toolbar value ─────────────────────────────

/** Mono toolbar label + value (reference .sel without the frame: it sits inside the composer well). */
export function ToolbarValue({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className="shrink-0 font-mono text-[9px] font-medium uppercase tracking-[0.13em] text-t3 @max-[600px]:hidden">{label}</span>
      <span className="min-w-0 truncate font-mono text-[10.5px] tracking-[-0.01em]">{children}</span>
    </span>
  );
}

/** True when the keyboard event target is a text field (so global shortcuts must not fire). */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return false;
}

/** True while a modal/menu layer is open (Radix dialogs, menus, popovers, selects). */
export function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]');
}

/** Live elapsed time in whole seconds ("0s", "12s", "3m 04s"); frozen when `until` is set. */
export function Elapsed({ since, until, className }: { since: number; until?: number | null; className?: string }) {
  const now = useNow(until ? false : 1000);
  const ms = Math.max(0, (until ?? Math.max(now, since)) - since);
  return <span className={cn('ob-tabular whitespace-nowrap', className)}>{ms < 1000 ? '0s' : formatDuration(ms)}</span>;
}
