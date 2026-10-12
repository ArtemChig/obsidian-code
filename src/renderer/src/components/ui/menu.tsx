// DropdownMenu + ContextMenu (Radix), sharing one look. Owner: ui-foundation.
import * as RCM from '@radix-ui/react-context-menu';
import * as RDM from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { Shortcut } from './kbd';

const CONTENT = 'ob-popover z-[90] min-w-[188px] p-1 text-ui animate-ob-pop-in focus-visible:outline-none';
const ITEM =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-ob-text outline-none ' +
  'data-[highlighted]:bg-[rgba(236,240,241,0.07)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40';
const DANGER = 'text-ob-danger data-[highlighted]:bg-ob-danger-soft';
const SEPARATOR = '-mx-1 my-1 h-px bg-ob-border';
const LABEL = 'ob-section-label px-2 pb-1 pt-1.5';

export interface MenuItemExtras {
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  /** Secondary text after the label. */
  hint?: ReactNode;
  /** Custom leading node (replaces icon), e.g. a StatusDot. */
  leading?: ReactNode;
  /** Right-side node (badges, check marks). */
  trailing?: ReactNode;
}

function ItemInner({ icon: Icon, leading, trailing, shortcut, hint, children, danger }: MenuItemExtras & { children: ReactNode }) {
  return (
    <>
      {leading ?? (Icon ? <Icon size={14} aria-hidden className={cn('shrink-0', danger ? 'text-ob-danger' : 'text-ob-text-3')} /> : null)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="truncate text-small text-ob-text-3">{hint}</span> : null}
      {trailing ? <span className="flex shrink-0 items-center gap-1.5">{trailing}</span> : null}
      {shortcut ? <Shortcut keys={shortcut} className="ml-3 opacity-80" /> : null}
    </>
  );
}

// ───────────────────────────── Dropdown ─────────────────────────────

export const DropdownMenu = RDM.Root;
export const DropdownMenuTrigger = RDM.Trigger;
export const DropdownMenuGroup = RDM.Group;
export const DropdownMenuSub = RDM.Sub;
export const DropdownMenuRadioGroup = RDM.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 4, align = 'start', ...rest }: ComponentProps<typeof RDM.Content>) {
  return (
    <RDM.Portal>
      <RDM.Content sideOffset={sideOffset} align={align} collisionPadding={8} className={cn(CONTENT, className)} {...rest} />
    </RDM.Portal>
  );
}

export function DropdownMenuItem({ icon, leading, trailing, shortcut, danger, hint, className, children, ...rest }: ComponentProps<typeof RDM.Item> & MenuItemExtras) {
  return (
    <RDM.Item className={cn(ITEM, danger && DANGER, className)} {...rest}>
      <ItemInner icon={icon} leading={leading} trailing={trailing} shortcut={shortcut} hint={hint} danger={danger}>
        {children}
      </ItemInner>
    </RDM.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...rest }: ComponentProps<typeof RDM.CheckboxItem>) {
  return (
    <RDM.CheckboxItem className={cn(ITEM, 'pl-7', className)} {...rest}>
      <RDM.ItemIndicator className="absolute left-2 flex items-center text-ob-accent">
        <Check size={14} aria-hidden />
      </RDM.ItemIndicator>
      {children}
    </RDM.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...rest }: ComponentProps<typeof RDM.RadioItem>) {
  return (
    <RDM.RadioItem className={cn(ITEM, 'pl-7', className)} {...rest}>
      <RDM.ItemIndicator className="absolute left-2 flex items-center text-ob-accent">
        <Check size={14} aria-hidden />
      </RDM.ItemIndicator>
      {children}
    </RDM.RadioItem>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <RDM.Separator className={cn(SEPARATOR, className)} />;
}

export function DropdownMenuLabel({ className, ...rest }: ComponentProps<typeof RDM.Label>) {
  return <RDM.Label className={cn(LABEL, className)} {...rest} />;
}

export function DropdownMenuSubTrigger({ icon, className, children, ...rest }: ComponentProps<typeof RDM.SubTrigger> & { icon?: LucideIcon }) {
  return (
    <RDM.SubTrigger className={cn(ITEM, 'data-[state=open]:bg-[rgba(236,240,241,0.07)]', className)} {...rest}>
      <ItemInner icon={icon}>{children}</ItemInner>
      <ChevronRight size={14} aria-hidden className="text-ob-text-3" />
    </RDM.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...rest }: ComponentProps<typeof RDM.SubContent>) {
  return (
    <RDM.Portal>
      <RDM.SubContent sideOffset={6} collisionPadding={8} className={cn(CONTENT, className)} {...rest} />
    </RDM.Portal>
  );
}

// ───────────────────────────── Context menu ─────────────────────────────

export const ContextMenu = RCM.Root;
export const ContextMenuTrigger = RCM.Trigger;
export const ContextMenuGroup = RCM.Group;

export function ContextMenuContent({ className, ...rest }: ComponentProps<typeof RCM.Content>) {
  return (
    <RCM.Portal>
      <RCM.Content collisionPadding={8} className={cn(CONTENT, className)} {...rest} />
    </RCM.Portal>
  );
}

export function ContextMenuItem({ icon, leading, trailing, shortcut, danger, hint, className, children, ...rest }: ComponentProps<typeof RCM.Item> & MenuItemExtras) {
  return (
    <RCM.Item className={cn(ITEM, danger && DANGER, className)} {...rest}>
      <ItemInner icon={icon} leading={leading} trailing={trailing} shortcut={shortcut} hint={hint} danger={danger}>
        {children}
      </ItemInner>
    </RCM.Item>
  );
}

export function ContextMenuSeparator({ className }: { className?: string }) {
  return <RCM.Separator className={cn(SEPARATOR, className)} />;
}

export function ContextMenuLabel({ className, ...rest }: ComponentProps<typeof RCM.Label>) {
  return <RCM.Label className={cn(LABEL, className)} {...rest} />;
}
