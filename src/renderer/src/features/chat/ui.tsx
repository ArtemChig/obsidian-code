// Small building blocks shared by the chat transcript, cards and panels. Owner: ui-chat.
import { Ban, Check, CircleDashed, CircleSlash, CircleX, ShieldAlert, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ImageBlock, ToolStatus } from '@shared/types';
import { Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { Spinner } from '@renderer/components/ui/feedback';
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
  /** Background the fade blends into (CSS colour). */
  fadeFrom?: string;
  /** Label suffix, e.g. "42 more lines". */
  moreLabel?: string;
  /** Called when the user expands/collapses. */
  onToggle?: (expanded: boolean) => void;
}

/** Clamps tall content with a fade and a "Show more" toggle; renders plainly when it fits. */
export function Clamp({ children, maxHeight = 320, className, fadeFrom = 'var(--ob-code-bg)', moreLabel, onToggle }: ClampProps) {
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
      {clamped ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
          style={{ background: `linear-gradient(to bottom, transparent, ${fadeFrom})` }}
        />
      ) : null}
      {overflows ? (
        <div className={cn('flex justify-center', clamped ? 'absolute inset-x-0 bottom-1.5' : 'py-1.5')}>
          <button
            type="button"
            onClick={toggle}
            data-testid="show-more"
            className="ob-transition rounded-pill border border-ob-border bg-ob-surface-2 px-2.5 py-0.5 text-meta text-ob-text-2 hover:border-[#30414f] hover:text-ob-text"
          >
            {expanded ? 'Show less' : `Show more${moreLabel ? ` · ${moreLabel}` : ''}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Tool status icon ─────────────────────────────

export function ToolStatusIcon({ status, size = 14, className }: { status: ToolStatus; size?: number; className?: string }) {
  switch (status) {
    case 'running':
      return <Spinner size={size} className={cn('text-ob-accent', className)} label="Running" />;
    case 'pending':
      return <CircleDashed size={size} aria-label="Queued" className={cn('text-ob-text-3', className)} />;
    case 'awaiting_permission':
      return <ShieldAlert size={size} aria-label="Needs permission" className={cn('text-ob-warning', className)} />;
    case 'done':
      return <Check size={size} aria-label="Done" className={cn('text-ob-success', className)} />;
    case 'error':
      return <CircleX size={size} aria-label="Failed" className={cn('text-ob-danger', className)} />;
    case 'denied':
      return <Ban size={size} aria-label="Denied" className={cn('text-ob-danger', className)} />;
    case 'interrupted':
      return <CircleSlash size={size} aria-label="Interrupted" className={cn('text-ob-warning', className)} />;
    default:
      return null;
  }
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
        className={cn(
          'ob-transition overflow-hidden rounded-[8px] border border-ob-border bg-ob-code-bg hover:border-ob-border-strong',
          natural ? 'block h-full' : 'size-full',
        )}
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
          className="ob-transition absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-ob-border bg-ob-surface-3 text-ob-text-2 opacity-0 hover:text-ob-text group-hover/thumb:opacity-100 focus-visible:opacity-100"
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
          <div className="flex justify-center">
            <img src={imageSrc(image)} alt={image.name ?? 'Image'} className="max-h-[60vh] max-w-full rounded-[8px] border border-ob-border" />
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

const TONE_SEL: Record<NonNullable<OptionRowProps['tone']>, string> = {
  accent: 'border-[rgba(143,184,222,0.45)] bg-ob-accent-soft',
  warning: 'border-[rgba(232,184,92,0.45)] bg-ob-warning-soft',
  danger: 'border-[rgba(240,113,120,0.4)] bg-ob-danger-soft',
};

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
        'ob-transition group flex w-full gap-3 rounded-[8px] border px-3 text-left',
        compact ? 'min-h-9 items-center py-1.5' : 'items-start py-2',
        selected ? TONE_SEL[tone] : 'border-ob-border bg-[rgba(255,255,255,0.012)] hover:border-[#30414f] hover:bg-ob-hover',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[10.5px]',
          !compact && 'mt-px',
          selected ? 'border-transparent bg-ob-text text-ob-bg' : 'border-ob-border text-ob-text-3 group-hover:text-ob-text-2',
        )}
        aria-hidden
      >
        {index}
      </span>
      {kind !== 'plain' ? (
        <span
          aria-hidden
          className={cn(
            'mt-[3px] flex size-3.5 shrink-0 items-center justify-center border',
            kind === 'radio' ? 'rounded-full' : 'rounded-[3px]',
            selected ? 'border-ob-accent bg-ob-accent text-ob-accent-ink' : 'border-[#3a4a57]',
          )}
        >
          {selected ? kind === 'radio' ? <span className="size-1.5 rounded-full bg-ob-accent-ink" /> : <Check size={10} strokeWidth={3} /> : null}
        </span>
      ) : null}
      <span className={cn('flex min-w-0 flex-1', compact ? 'flex-wrap items-baseline gap-x-2.5 gap-y-0.5' : 'flex-col gap-0.5')}>
        <span className="text-ui text-ob-text">{title}</span>
        {description ? <span className="text-small text-ob-text-3">{description}</span> : null}
      </span>
      {trailing}
    </button>
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
