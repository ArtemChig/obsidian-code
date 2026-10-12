// Input, Textarea (auto-grow), Field. Owner: ui-foundation.
import { useCallback, useLayoutEffect, useRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

export const FIELD_BASE =
  'w-full rounded-ctl border border-ob-border bg-ob-surface-2 text-ui text-ob-text placeholder:text-ob-text-3 ' +
  'ob-transition hover:border-[#2f404e] focus-visible:outline-none focus:border-[rgba(143,184,222,0.65)] ' +
  'focus:shadow-[0_0_0_3px_rgba(143,184,222,0.14)] disabled:cursor-not-allowed disabled:opacity-50';

const INVALID = 'border-[rgba(240,113,120,0.6)] focus:border-ob-danger focus:shadow-[0_0_0_3px_rgba(240,113,120,0.14)]';

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

export function Input({ size = 'md', icon: Icon, trailing, invalid, mono, className, wrapperClassName, ...rest }: InputProps) {
  const h = size === 'sm' ? 'h-7' : size === 'md' ? 'h-8' : 'h-9';
  if (!Icon && !trailing) {
    return (
      <input
        aria-invalid={invalid || undefined}
        className={cn(FIELD_BASE, h, 'px-2.5', mono && 'font-mono text-[12px]', invalid && INVALID, className)}
        {...rest}
      />
    );
  }
  return (
    <div className={cn('relative flex items-center', wrapperClassName)}>
      {Icon ? <Icon size={14} aria-hidden className="pointer-events-none absolute left-2.5 text-ob-text-3" /> : null}
      <input
        aria-invalid={invalid || undefined}
        className={cn(FIELD_BASE, h, Icon ? 'pl-8' : 'pl-2.5', trailing ? 'pr-9' : 'pr-2.5', mono && 'font-mono text-[12px]', invalid && INVALID, className)}
        {...rest}
      />
      {trailing ? <div className="absolute right-1.5 flex items-center">{trailing}</div> : null}
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
    const line = parseFloat(cs.lineHeight) || 19;
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
          ? 'w-full resize-none border-0 bg-transparent text-ui text-ob-text placeholder:text-ob-text-3 focus-visible:outline-none'
          : cn(FIELD_BASE, 'resize-none px-2.5 py-[7px] leading-[19px]'),
        mono && 'font-mono text-[12px]',
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
  /** Put the control to the right of the label (switches). */
  inline?: boolean;
}

export function Field({ label, htmlFor, description, error, children, className, inline }: FieldProps) {
  if (inline) {
    return (
      <div className={cn('flex items-center justify-between gap-6', className)}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={htmlFor} className="text-ui font-medium text-ob-text">
            {label}
          </label>
          {description ? <div className="text-small text-ob-text-3">{description}</div> : null}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-small font-medium text-ob-text-2">
        {label}
      </label>
      {children}
      {error ? <div className="text-small text-ob-danger">{error}</div> : description ? <div className="text-small text-ob-text-3">{description}</div> : null}
    </div>
  );
}
