// Styled cmdk primitives for palettes (global Ctrl+K palette lives in app/CommandPalette.tsx). Owner: ui-foundation.
import * as RD from '@radix-ui/react-dialog';
import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { Kbd, Shortcut } from './kbd';

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  label?: string;
  /** cmdk props: custom filter, controlled value, loop… */
  commandProps?: Omit<ComponentProps<typeof Cmdk>, 'children'>;
  className?: string;
  footer?: ReactNode;
}

export function CommandDialog({ open, onOpenChange, children, label = 'Command palette', commandProps, className, footer }: CommandDialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-[95] bg-[rgba(4,8,10,0.5)] animate-ob-fade-in" />
        <RD.Content
          aria-label={label}
          className={cn(
            'fixed left-1/2 top-[13vh] z-[96] w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden',
            'rounded-[12px] border border-[#2a3a47] bg-ob-surface-1 shadow-[0_16px_48px_rgba(0,0,0,0.55)] animate-ob-pop-in focus-visible:outline-none',
            className,
          )}
        >
          <RD.Title className="sr-only">{label}</RD.Title>
          <RD.Description className="sr-only">Type a command or search</RD.Description>
          <Cmdk label={label} loop {...commandProps} className={cn('flex flex-col', commandProps?.className)}>
            {children}
          </Cmdk>
          {footer ?? <CommandFooter />}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Inline (non-dialog) command list, e.g. for composer slash/mention popovers. */
export function Command({ className, ...rest }: ComponentProps<typeof Cmdk>) {
  return <Cmdk className={cn('flex flex-col', className)} {...rest} />;
}

export function CommandInput({ className, leading, ...rest }: ComponentProps<typeof Cmdk.Input> & { leading?: ReactNode }) {
  return (
    <div className="flex h-12 items-center gap-2.5 border-b border-ob-border px-4">
      {leading ?? <Search size={16} aria-hidden className="shrink-0 text-ob-text-3" />}
      <Cmdk.Input
        className={cn('h-full min-w-0 flex-1 bg-transparent text-[14px] text-ob-text placeholder:text-ob-text-3 focus-visible:outline-none', className)}
        {...rest}
      />
    </div>
  );
}

export function CommandList({ className, ...rest }: ComponentProps<typeof Cmdk.List>) {
  return <Cmdk.List className={cn('max-h-[min(420px,58vh)] overflow-y-auto overscroll-contain p-1.5 [scroll-padding-block:6px]', className)} {...rest} />;
}

export function CommandEmpty({ className, children = 'No results', ...rest }: ComponentProps<typeof Cmdk.Empty>) {
  return (
    <Cmdk.Empty className={cn('px-3 py-8 text-center text-ui text-ob-text-3', className)} {...rest}>
      {children}
    </Cmdk.Empty>
  );
}

export function CommandGroup({ className, ...rest }: ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn(
        '[&_[cmdk-group-heading]]:ob-section-label [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5',
        className,
      )}
      {...rest}
    />
  );
}

export function CommandSeparator({ className }: { className?: string }) {
  return <Cmdk.Separator className={cn('-mx-1.5 my-1 h-px bg-ob-border', className)} />;
}

export interface CommandItemProps extends ComponentProps<typeof Cmdk.Item> {
  icon?: LucideIcon;
  /** Custom leading node (overrides icon). */
  leading?: ReactNode;
  shortcut?: string;
  hint?: ReactNode;
  /** Right side slot (badges…). */
  trailing?: ReactNode;
}

export function CommandItem({ icon: Icon, leading, shortcut, hint, trailing, className, children, ...rest }: CommandItemProps) {
  return (
    <Cmdk.Item
      className={cn(
        'group flex h-9 cursor-default select-none items-center gap-2.5 rounded-[7px] px-2.5 text-ui text-ob-text-2 outline-none',
        'data-[selected=true]:bg-ob-accent-soft data-[selected=true]:text-ob-text data-[disabled=true]:opacity-40',
        className,
      )}
      {...rest}
    >
      {leading ?? (Icon ? <Icon size={15} aria-hidden className="shrink-0 text-ob-text-3 group-data-[selected=true]:text-ob-accent" /> : null)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="max-w-[45%] truncate text-small text-ob-text-3">{hint}</span> : null}
      {trailing}
      {shortcut ? <Shortcut keys={shortcut} /> : null}
    </Cmdk.Item>
  );
}

export function CommandFooter({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-4 border-t border-ob-border bg-[#0d161a] px-4 text-small text-ob-text-3">
      {children ?? (
        <>
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd> close
          </span>
        </>
      )}
    </div>
  );
}

export { Cmdk };
