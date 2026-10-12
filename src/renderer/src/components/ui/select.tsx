// Select (Radix). M13: trigger = input well (reference .sel), list = menu surface with 28 px rows. Owner: ui-foundation.
import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { FIELD_BASE } from './input';

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Text shown in the trigger when selected (defaults to label). */
  triggerLabel?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectGroupDef {
  label: ReactNode;
  options: SelectOption[];
}

export interface SelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroupDef[];
  placeholder?: ReactNode;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  /** Ghost trigger (no border/background until hover) for toolbars. */
  ghost?: boolean;
  /** Technical values (models, encoders, paths): Chivo Mono 10.5 px like the reference .sel. */
  mono?: boolean;
  'aria-label'?: string;
  id?: string;
  align?: 'start' | 'center' | 'end';
}

function Item({ o }: { o: SelectOption }) {
  return (
    <RS.Item
      value={o.value}
      disabled={o.disabled}
      className={cn(
        'relative flex min-h-7 cursor-default select-none items-center gap-2.5 rounded-[2px] py-1 pl-2.5 pr-8 text-[12px] tracking-[-0.01em] text-t2 outline-none',
        'data-[highlighted]:bg-s3 data-[highlighted]:text-t1 data-[state=checked]:text-t1 data-[disabled]:opacity-40',
      )}
    >
      {o.icon ? <span className="flex shrink-0 items-center text-t3">{o.icon}</span> : null}
      <div className="flex min-w-0 flex-col">
        <RS.ItemText>{o.label}</RS.ItemText>
        {o.description ? <span className="font-mono text-[9.5px] tracking-[0.01em] text-t3">{o.description}</span> : null}
      </div>
      <RS.ItemIndicator className="absolute right-2.5 flex items-center text-t1">
        <Check size={13} aria-hidden />
      </RS.ItemIndicator>
    </RS.Item>
  );
}

export function Select({
  value,
  onValueChange,
  options,
  groups,
  placeholder,
  size = 'md',
  disabled,
  className,
  contentClassName,
  ghost,
  mono,
  id,
  align = 'start',
  ...aria
}: SelectProps) {
  const all = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  const selected = all.find((o) => o.value === value);
  return (
    <RS.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RS.Trigger
        id={id}
        aria-label={aria['aria-label']}
        className={cn(
          ghost
            ? 'ob-transition rounded-[2px] border border-transparent bg-transparent text-[11.5px] text-t2 hover:bg-hov hover:text-t1 data-[state=open]:bg-s3 data-[state=open]:text-t1'
            : cn(FIELD_BASE, 'data-[state=open]:border-acc'),
          'inline-flex items-center justify-between gap-2.5 text-left',
          size === 'sm' ? 'h-6 pl-2.5 pr-2 text-[11px]' : 'h-7 pl-[11px] pr-[9px]',
          mono && 'font-mono text-[10.5px] tracking-[-0.01em]',
          'data-[placeholder]:text-t3',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {selected?.icon ? <span className="flex shrink-0 items-center text-t3">{selected.icon}</span> : null}
          <RS.Value placeholder={placeholder}>{selected ? (selected.triggerLabel ?? selected.label) : undefined}</RS.Value>
        </span>
        <RS.Icon className="shrink-0 text-t3">
          <ChevronDown size={11} aria-hidden />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={4}
          align={align}
          collisionPadding={8}
          className={cn(
            'ob-popover z-[90] max-h-[min(380px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden animate-ob-pop-in',
            contentClassName,
          )}
        >
          <RS.Viewport className="p-1">
            {groups
              ? groups.map((g, gi) => (
                  <RS.Group key={gi}>
                    {gi > 0 ? <RS.Separator className="-mx-1 my-1 h-px bg-rule" /> : null}
                    <RS.Label className="ob-cap px-2.5 pb-1 pt-2">{g.label}</RS.Label>
                    {g.options.map((o) => (
                      <Item key={o.value} o={o} />
                    ))}
                  </RS.Group>
                ))
              : (options ?? []).map((o) => <Item key={o.value} o={o} />)}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
