// DropdownMenu + ContextMenu (Radix), sharing one look. M13: --s0 surface, 1 px --line, separation shadow,
// 28 px rows, highlighted row on --s3, shortcuts as quiet mono. Owner: ui-foundation.
import * as RCM from '@radix-ui/react-context-menu';
import * as RDM from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { Shortcut } from './kbd';

export const MENU_CONTENT = 'ob-popover z-[90] min-w-[200px] p-1 text-[12px] animate-ob-pop-in focus-visible:outline-none';
export const MENU_ITEM =
  'relative flex h-7 cursor-default select-none items-center gap-2.5 rounded-[2px] px-2.5 tracking-[-0.01em] text-t2 outline-none ' +
  'data-[highlighted]:bg-s3 data-[highlighted]:text-t1 data-[disabled]:pointer-events-none data-[disabled]:opacity-40';
const DANGER = 'text-err data-[highlighted]:bg-err-wash data-[highlighted]:text-err';
const SEPARATOR = '-mx-1 my-1 h-px bg-rule';
const LABEL = 'ob-cap px-2.5 pb-1 pt-2';

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
      {leading ?? (Icon ? <Icon size={13} aria-hidden className={cn('shrink-0', danger ? 'text-err' : 'text-t3')} /> : null)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">{hint}</span> : null}
      {trailing ? <span className="flex shrink-0 items-center gap-1.5">{trailing}</span> : null}
      {shortcut ? <Shortcut keys={shortcut} plain className="ml-4" /> : null}
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
      <RDM.Content sideOffset={sideOffset} align={align} collisionPadding={8} className={cn(MENU_CONTENT, className)} {...rest} />
    </RDM.Portal>
  );
}

export function DropdownMenuItem({ icon, leading, trailing, shortcut, danger, hint, className, children, ...rest }: ComponentProps<typeof RDM.Item> & MenuItemExtras) {
  return (
    <RDM.Item className={cn(MENU_ITEM, danger && DANGER, className)} {...rest}>
      <ItemInner icon={icon} leading={leading} trailing={trailing} shortcut={shortcut} hint={hint} danger={danger}>
        {children}
      </ItemInner>
    </RDM.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...rest }: ComponentProps<typeof RDM.CheckboxItem>) {
  return (
    <RDM.CheckboxItem className={cn(MENU_ITEM, 'pl-[30px]', className)} {...rest}>
      <RDM.ItemIndicator className="absolute left-2.5 flex items-center text-t1">
        <Check size={13} aria-hidden />
      </RDM.ItemIndicator>
      {children}
    </RDM.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...rest }: ComponentProps<typeof RDM.RadioItem>) {
  return (
    <RDM.RadioItem className={cn(MENU_ITEM, 'pl-[30px]', className)} {...rest}>
      <RDM.ItemIndicator className="absolute left-2.5 flex items-center text-t1">
        <Check size={13} aria-hidden />
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
    <RDM.SubTrigger className={cn(MENU_ITEM, 'data-[state=open]:bg-s3 data-[state=open]:text-t1', className)} {...rest}>
      <ItemInner icon={icon}>{children}</ItemInner>
      <ChevronRight size={12} aria-hidden className="text-t3" />
    </RDM.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...rest }: ComponentProps<typeof RDM.SubContent>) {
  return (
    <RDM.Portal>
      <RDM.SubContent sideOffset={6} collisionPadding={8} className={cn(MENU_CONTENT, className)} {...rest} />
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
      <RCM.Content collisionPadding={8} className={cn(MENU_CONTENT, className)} {...rest} />
    </RCM.Portal>
  );
}

export function ContextMenuItem({ icon, leading, trailing, shortcut, danger, hint, className, children, ...rest }: ComponentProps<typeof RCM.Item> & MenuItemExtras) {
  return (
    <RCM.Item className={cn(MENU_ITEM, danger && DANGER, className)} {...rest}>
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
