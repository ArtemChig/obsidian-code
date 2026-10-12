// Tabs (Radix) — 'underline' (panels, views: reference .phd .tab) and 'pill' (= segmented control, reference .seg),
// plus a standalone <Segmented> radio group. Owner: ui-foundation.
import * as RTabs from '@radix-ui/react-tabs';
import { createContext, useContext, useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

type Variant = 'underline' | 'pill';
const VariantCtx = createContext<Variant>('underline');

export function Tabs({ className, ...rest }: ComponentProps<typeof RTabs.Root>) {
  return <RTabs.Root className={cn('flex min-h-0 flex-col', className)} {...rest} />;
}

export interface TabsListProps extends ComponentProps<typeof RTabs.List> {
  variant?: Variant;
}

// Segmented frame: 1 px --line outline, 2 px radius, segments split by --line.
const SEG_FRAME = 'inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-[2px] border border-line';
const SEG_ITEM =
  'ob-transition inline-flex select-none items-center gap-1.5 whitespace-nowrap px-[11px] text-[11px] tracking-[-0.008em] text-t3 ' +
  'not-first:border-l not-first:border-line hover:text-t1 ' +
  'disabled:pointer-events-none disabled:opacity-40';
const SEG_ON = 'bg-acc font-semibold text-acc-ink hover:text-acc-ink';

export function TabsList({ variant = 'underline', className, ...rest }: TabsListProps) {
  return (
    <VariantCtx.Provider value={variant}>
      <RTabs.List
        className={cn(variant === 'underline' ? 'flex h-[30px] shrink-0 items-stretch border-b border-rule px-2.5' : SEG_FRAME, className)}
        {...rest}
      />
    </VariantCtx.Provider>
  );
}

export interface TabsTriggerProps extends ComponentProps<typeof RTabs.Trigger> {
  icon?: ReactNode;
  /** Small count after the label (mono). */
  count?: ReactNode;
}

export function TabsTrigger({ className, children, icon, count, ...rest }: TabsTriggerProps) {
  const variant = useContext(VariantCtx);
  const hasCount = count !== undefined && count !== null && count !== 0;
  if (variant === 'pill') {
    return (
      <RTabs.Trigger className={cn(SEG_ITEM, 'outline-offset-[-2px] data-[state=active]:bg-acc data-[state=active]:font-semibold data-[state=active]:text-acc-ink', className)} {...rest}>
        {icon}
        {children}
        {hasCount ? <span className="ob-tabular font-mono text-[9px] tracking-[0.03em]">{count}</span> : null}
      </RTabs.Trigger>
    );
  }
  return (
    <RTabs.Trigger
      className={cn(
        'ob-transition group relative inline-flex select-none items-center gap-[7px] whitespace-nowrap px-[11px] text-[11.5px] font-medium tracking-[-0.01em] outline-offset-[-2px]',
        'text-t3 hover:text-t1 data-[state=active]:text-t1 first:pl-0.5',
        // reference .phd .tab.on::after: a 1 px cold-white underline under the label only, replacing the list's hairline.
        'after:pointer-events-none after:absolute after:bottom-[-1px] after:left-[11px] after:right-[11px] after:h-px after:bg-transparent first:after:left-0.5',
        'data-[state=active]:after:bg-acc',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {hasCount ? (
        <span className="ob-tabular font-mono text-[9px] tracking-[0.03em] text-t3 group-data-[state=active]:text-acc">{count}</span>
      ) : null}
    </RTabs.Trigger>
  );
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof RTabs.Content>) {
  return <RTabs.Content className={cn('min-h-0 flex-1 focus-visible:outline-none', className)} {...rest} />;
}

// ───────────────────────────── Segmented ─────────────────────────────

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Accessible name when the label is an icon only. */
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
  disabled?: boolean;
}

/** Single-choice segmented control (reference .seg): a radio group with roving focus and arrow-key navigation. */
export function Segmented<T extends string = string>({ value, onValueChange, options, size = 'md', className, disabled, ...aria }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir || !enabled.length) return;
    e.preventDefault();
    const cur = enabled.indexOf(options.findIndex((o) => o.value === value));
    const next = enabled[(cur + dir + enabled.length) % enabled.length];
    onValueChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={aria['aria-label']} onKeyDown={onKeyDown} className={cn(SEG_FRAME, size === 'sm' && 'h-6', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled || disabled}
            onClick={() => onValueChange(o.value)}
            className={cn(SEG_ITEM, 'outline-offset-[-2px]', size === 'sm' && 'px-2.5 text-[10.5px]', on && SEG_ON)}
          >
            {Icon ? <Icon size={12} aria-hidden /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
