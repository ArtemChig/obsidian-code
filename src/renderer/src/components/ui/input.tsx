// Input, Textarea (auto-grow), Field (M13: reference .inp / .txt / .srow). Owner: ui-foundation.
import { useCallback, useLayoutEffect, useRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

/** The input well: --s1 fill, 1 px --line outline, 2 px radius; focus turns the outline cold white. */
export const FIELD_BASE =
  'w-full rounded-[2px] border border-line bg-s1 text-[11.5px] text-t1 placeholder:text-t3 ' +
  'ob-transition hover:border-line-hi focus-visible:outline-none focus:border-acc ' +
  'disabled:cursor-not-allowed disabled:opacity-45';

const INVALID = 'border-err hover:border-err focus:border-err';

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'> {
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  /** Right-side slot (e.g. a Kbd hint or clear button). */
  trailing?: ReactNode;
  invalid?: boolean;
  /** Use the mono font (paths, URLs, keys). */
  mono?: boolean;
  wrapperClassName?: string;
}

const MONO = 'font-mono text-[10.5px] tracking-[-0.01em]';

export function Input({ size = 'md', icon: Icon, trailing, invalid, mono, className, wrapperClassName, ...rest }: InputProps) {
  const h = size === 'sm' ? 'h-6' : size === 'md' ? 'h-7' : 'h-8 text-[12.5px]';
  if (!Icon && !trailing) {
    return (
      <input
        aria-invalid={invalid || undefined}
        className={cn(FIELD_BASE, h, 'px-[11px]', mono && MONO, invalid && INVALID, className)}
        {...rest}
      />
    );
  }
  return (
    <div className={cn('relative flex items-center', wrapperClassName)}>
      {Icon ? <Icon size={12} aria-hidden className="pointer-events-none absolute left-[11px] text-t3" /> : null}
      <input
        aria-invalid={invalid || undefined}
        className={cn(FIELD_BASE, h, Icon ? 'pl-[30px]' : 'pl-[11px]', trailing ? 'pr-9' : 'pr-[11px]', mono && MONO, invalid && INVALID, className)}
        {...rest}
      />
      {trailing ? <div className="absolute right-1 flex items-center">{trailing}</div> : null}
    </div>
  );
}

export interface TextareaProps extends ComponentProps<'textarea'> {
  /** Grow with content between minRows and maxRows (default true). */
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
  invalid?: boolean;
  mono?: boolean;
  /** Borderless variant for composers. */
  bare?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ autoGrow = true, minRows = 2, maxRows = 12, invalid, mono, bare, className, ref, onInput, value, ...rest }: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el;
    },
    [ref],
  );

  const resize = useCallback(() => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    const cs = window.getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 18;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    const min = minRows * line + pad + border;
    const max = maxRows * line + pad + border;
    const next = Math.min(max, Math.max(min, el.scrollHeight + border));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight + border > max ? 'auto' : 'hidden';
  }, [autoGrow, minRows, maxRows]);

  useLayoutEffect(resize, [resize, value]);

  return (
    <textarea
      ref={setRef}
      rows={minRows}
      value={value}
      aria-invalid={invalid || undefined}
      onInput={(e) => {
        resize();
        onInput?.(e);
      }}
      className={cn(
        bare
          ? 'w-full resize-none border-0 bg-transparent text-ui text-t1 placeholder:text-t3 focus-visible:outline-none'
          : cn(FIELD_BASE, 'resize-none px-[11px] py-[6px] text-[12px] leading-[18px]'),
        mono && 'font-mono text-[11px] tracking-[-0.01em]',
        invalid && INVALID,
        className,
      )}
      {...rest}
    />
  );
}

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Put the control to the right of the label (switches) — the reference settings row. */
  inline?: boolean;
}

export function Field({ label, htmlFor, description, error, children, className, inline }: FieldProps) {
  if (inline) {
    return (
      <div className={cn('flex min-h-[42px] items-center justify-between gap-6', className)}>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <label htmlFor={htmlFor} className="text-[12.5px] font-medium tracking-[-0.016em] text-t1">
            {label}
          </label>
          {description ? <div className="text-[11px] leading-[1.45] text-t3">{description}</div> : null}
          {error ? <div className="text-[11px] text-err">{error}</div> : null}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[11.5px] font-medium tracking-[-0.01em] text-t2">
        {label}
      </label>
      {children}
      {error ? <div className="text-[11px] text-err">{error}</div> : description ? <div className="text-[11px] leading-[1.45] text-t3">{description}</div> : null}
    </div>
  );
}
