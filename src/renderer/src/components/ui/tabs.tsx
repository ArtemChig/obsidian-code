// Tabs (Radix) — 'underline' (panels, views) and 'pill' (segmented control) variants. Owner: ui-foundation.
import * as RTabs from '@radix-ui/react-tabs';
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

type Variant = 'underline' | 'pill';
const VariantCtx = createContext<Variant>('underline');

export function Tabs({ className, ...rest }: ComponentProps<typeof RTabs.Root>) {
  return <RTabs.Root className={cn('flex min-h-0 flex-col', className)} {...rest} />;
}

export interface TabsListProps extends ComponentProps<typeof RTabs.List> {
  variant?: Variant;
}

export function TabsList({ variant = 'underline', className, ...rest }: TabsListProps) {
  return (
    <VariantCtx.Provider value={variant}>
      <RTabs.List
        className={cn(
          variant === 'underline'
            ? 'flex h-10 shrink-0 items-stretch gap-4 border-b border-ob-border px-3'
            : 'inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[8px] border border-ob-border bg-ob-surface-1 p-[3px]',
          className,
        )}
        {...rest}
      />
    </VariantCtx.Provider>
  );
}

export interface TabsTriggerProps extends ComponentProps<typeof RTabs.Trigger> {
  icon?: ReactNode;
  /** Small count / badge after the label. */
  count?: ReactNode;
}

export function TabsTrigger({ className, children, icon, count, ...rest }: TabsTriggerProps) {
  const variant = useContext(VariantCtx);
  return (
    <RTabs.Trigger
      className={cn(
        'ob-transition group inline-flex select-none items-center gap-1.5 whitespace-nowrap text-ui font-medium outline-offset-0',
        variant === 'underline'
          ? cn(
              'relative -mb-px border-b-2 border-transparent px-0.5 text-ob-text-3 hover:text-ob-text-2',
              'data-[state=active]:border-ob-accent data-[state=active]:text-ob-text',
            )
          : cn(
              'h-full rounded-[6px] px-2.5 text-small text-ob-text-3 hover:text-ob-text-2',
              'data-[state=active]:bg-ob-surface-3 data-[state=active]:text-ob-text data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.3)]',
            ),
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {count !== undefined && count !== null && count !== 0 ? (
        <span className="ob-tabular rounded-pill bg-[rgba(236,240,241,0.07)] px-1.5 font-mono text-[10px] leading-4 text-ob-text-2 group-data-[state=active]:bg-ob-accent-soft group-data-[state=active]:text-ob-accent">
          {count}
        </span>
      ) : null}
    </RTabs.Trigger>
  );
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof RTabs.Content>) {
  return <RTabs.Content className={cn('min-h-0 flex-1 focus-visible:outline-none', className)} {...rest} />;
}
