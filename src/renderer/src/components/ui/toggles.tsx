// Switch (Radix) + Checkbox (M13: reference .tog / .chk). Owner: ui-foundation.
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

/** Off: --line outline with a grey knob. On: a solid cold-white pill with a black knob. */
export function Switch({ checked, onCheckedChange, disabled, size = 'md', id, className, label, ...aria }: SwitchProps) {
  const sw = (
    <RSw.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={aria['aria-label']}
      className={cn(
        'ob-transition relative inline-flex shrink-0 items-center rounded-full border border-line bg-transparent outline-offset-2',
        'hover:border-line-hi data-[state=checked]:border-acc data-[state=checked]:bg-acc',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'md' ? 'h-[18px] w-[34px]' : 'h-4 w-7',
        !label && className,
      )}
    >
      <RSw.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-line transition-transform duration-150 ease-out data-[state=checked]:bg-acc-ink',
          size === 'md'
            ? 'size-3 translate-x-[2px] data-[state=checked]:translate-x-[18px]'
            : 'size-2.5 translate-x-[2px] data-[state=checked]:translate-x-[14px]',
        )}
      />
    </RSw.Root>
  );
  if (!label) return sw;
  return (
    <label className={cn('inline-flex cursor-default select-none items-center gap-2 text-[11.5px] text-t2', checked && 'text-t1', className)}>
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

/** 13 px square, 1 px --line; checked = solid cold white with a black tick. */
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
        'ob-transition flex size-[13px] shrink-0 items-center justify-center rounded-[1px] border outline-offset-2',
        on ? 'border-acc bg-acc text-acc-ink' : 'border-line bg-transparent hover:border-line-hi',
        'disabled:cursor-not-allowed disabled:opacity-45',
        !label && className,
      )}
    >
      {checked === 'indeterminate' ? <Minus size={9} strokeWidth={3} aria-hidden /> : checked ? <Check size={10} strokeWidth={3} aria-hidden /> : null}
    </button>
  );
  if (!label) return box;
  return (
    <label className={cn('flex cursor-default select-none items-start gap-2.5', disabled && 'opacity-60', className)}>
      <span className="pt-[2.5px]">{box}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[12px] tracking-[-0.01em] text-t1">{label}</span>
        {description ? <span className="text-[11px] text-t3">{description}</span> : null}
      </span>
    </label>
  );
}
