// Select (Radix). Owner: ui-foundation.
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
        'relative flex min-h-7 cursor-default select-none items-center gap-2 rounded-[5px] py-1 pl-2 pr-7 text-ui text-ob-text outline-none',
        'data-[highlighted]:bg-[rgba(236,240,241,0.07)] data-[disabled]:opacity-40',
      )}
    >
      {o.icon ? <span className="flex shrink-0 items-center text-ob-text-3">{o.icon}</span> : null}
      <div className="flex min-w-0 flex-col">
        <RS.ItemText>{o.label}</RS.ItemText>
        {o.description ? <span className="text-small text-ob-text-3">{o.description}</span> : null}
      </div>
      <RS.ItemIndicator className="absolute right-2 flex items-center text-ob-accent">
        <Check size={14} aria-hidden />
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
            ? 'ob-transition rounded-ctl border border-transparent bg-transparent text-ui text-ob-text-2 hover:bg-ob-hover hover:text-ob-text data-[state=open]:bg-ob-hover'
            : FIELD_BASE,
          'inline-flex items-center justify-between gap-2 text-left',
          size === 'sm' ? 'h-7 px-2 text-small' : 'h-8 px-2.5',
          'data-[placeholder]:text-ob-text-3',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {selected?.icon ? <span className="flex shrink-0 items-center text-ob-text-3">{selected.icon}</span> : null}
          <RS.Value placeholder={placeholder}>{selected ? (selected.triggerLabel ?? selected.label) : undefined}</RS.Value>
        </span>
        <RS.Icon className="shrink-0 text-ob-text-3">
          <ChevronDown size={14} aria-hidden />
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
                    {gi > 0 ? <RS.Separator className="-mx-1 my-1 h-px bg-ob-border" /> : null}
                    <RS.Label className="ob-section-label px-2 pb-1 pt-1.5">{g.label}</RS.Label>
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
