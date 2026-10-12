// Switch (Radix) + Checkbox. Owner: ui-foundation.
import * as RSw from '@radix-ui/react-switch';
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  'aria-label'?: string;
  className?: string;
  /** Optional inline label to the right. */
  label?: ReactNode;
}

export function Switch({ checked, onCheckedChange, disabled, size = 'md', id, className, label, ...aria }: SwitchProps) {
  const sw = (
    <RSw.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={aria['aria-label']}
      className={cn(
        'ob-transition relative inline-flex shrink-0 items-center rounded-pill border outline-offset-2',
        'border-[#2f3f4c] bg-[#22303c] hover:border-[#3a4b59]',
        'data-[state=checked]:border-ob-accent data-[state=checked]:bg-ob-accent',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'md' ? 'h-[18px] w-8' : 'h-4 w-7',
        !label && className,
      )}
    >
      <RSw.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-ob-text-2 transition-transform duration-150 ease-out',
          'data-[state=checked]:bg-ob-accent-ink',
          size === 'md'
            ? 'size-3 translate-x-[2px] data-[state=checked]:translate-x-[16px]'
            : 'size-2.5 translate-x-[2px] data-[state=checked]:translate-x-[14px]',
        )}
      />
    </RSw.Root>
  );
  if (!label) return sw;
  return (
    <label className={cn('inline-flex cursor-default select-none items-center gap-2 text-ui text-ob-text-2', className)}>
      {sw}
      {label}
    </label>
  );
}

export interface CheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: ReactNode;
  description?: ReactNode;
  className?: string;
  'aria-label'?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled, id, label, description, className, ...aria }: CheckboxProps) {
  const on = checked === true || checked === 'indeterminate';
  const box = (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
      aria-label={aria['aria-label']}
      disabled={disabled}
      onClick={() => onCheckedChange(checked === 'indeterminate' ? true : !checked)}
      className={cn(
        'ob-transition flex size-4 shrink-0 items-center justify-center rounded-[4px] border outline-offset-2',
        on ? 'border-ob-accent bg-ob-accent text-ob-accent-ink' : 'border-[#3a4a57] bg-transparent hover:border-ob-border-strong',
        'disabled:cursor-not-allowed disabled:opacity-45',
        !label && className,
      )}
    >
      {checked === 'indeterminate' ? <Minus size={12} strokeWidth={2.5} aria-hidden /> : checked ? <Check size={12} strokeWidth={2.75} aria-hidden /> : null}
    </button>
  );
  if (!label) return box;
  return (
    <label className={cn('flex cursor-default select-none items-start gap-2.5', disabled && 'opacity-60', className)}>
      <span className="pt-[1.5px]">{box}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-ui text-ob-text">{label}</span>
        {description ? <span className="text-small text-ob-text-3">{description}</span> : null}
      </span>
    </label>
  );
}
