// Shared M13 view chrome for the ui-views features (GPU, Activity, Scheduled, Settings): view header, mono meta line,
// key/value lines, rail blocks, status-framed notices, the radio mark. No fills, no frames: hairlines carry the structure. Owner: ui-views.
import { Fragment, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/cn';

/** View header (reference .s6-hd): 56 px, Chivo 600 17 px title, a short --t3 description beside it, actions right. */
export function ViewHeader({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-6 py-2', className)}>
      <h1 className="text-title font-semibold leading-[1.2] text-t1">{title}</h1>
      {description ? <p className="min-w-0 max-w-[72ch] flex-1 basis-[220px] text-[11px] leading-[1.45] tracking-[-0.006em] text-t3">{description}</p> : null}
      {children}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Mono meta line with slash separators (reference .mn): put values in <b> so they read --t2. */
export function MetaLine({ items, className, testId }: { items: ReactNode[]; className?: string; testId?: string }) {
  const parts = items.filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return (
    <span data-testid={testId} className={cn('ob-mn inline-flex min-w-0 flex-wrap items-baseline gap-x-[7px] [&_b]:font-normal [&_b]:text-t2', className)}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden className="opacity-[.42]">
              /
            </span>
          ) : null}
          <span className="min-w-0">{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

const KV_TONE = { default: 'text-t1', dim: 'text-t2', ok: 'text-ok', warn: 'text-warn', err: 'text-err' } as const;

/** Key/value line (reference .kv): 11.5 px --t3 label, mono value right. Wrap a set of them in a <dl>. */
export function Kv({ label, children, tone = 'default', testId, className, title }: { label: ReactNode; children: ReactNode; tone?: keyof typeof KV_TONE; testId?: string; className?: string; title?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2.5 py-[5px]', className)}>
      <dt className="shrink-0 text-[11.5px] tracking-[-0.008em] text-t3">{label}</dt>
      <dd className={cn('ob-tabular min-w-0 truncate text-right font-mono text-[11.5px] tracking-[-0.03em]', KV_TONE[tone])} data-testid={testId} title={title}>
        {children}
      </dd>
    </div>
  );
}

/** A block of a side rail (reference .sblk): mono cap row (label left, value right), then content on the ground. */
export function RailBlock({ label, aside, children, testId, className, ariaLabel }: { label: ReactNode; aside?: ReactNode; children: ReactNode; testId?: string; className?: string; ariaLabel?: string }) {
  return (
    <section className={cn('border-b border-rule2 px-5 py-4', className)} data-testid={testId} aria-label={ariaLabel}>
      <div className="ob-cap mb-[13px] flex items-baseline gap-2.5">
        <span className="truncate">{label}</span>
        {aside ? <span className="ml-auto flex shrink-0 items-center gap-2 tracking-[0.1em] text-t1">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Status-framed row (reference .kwarn): the one place a status-coloured frame is right. --err for problems that cost
 * money or failed, --warn for things waiting on the user.
 */
export function Notice({
  tone = 'warn',
  icon: Icon,
  title,
  children,
  action,
  className,
  testId,
  alert,
}: {
  tone?: 'warn' | 'err';
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
  alert?: boolean;
}) {
  return (
    <div
      role={alert ? 'alert' : undefined}
      data-testid={testId}
      className={cn(
        'flex flex-wrap items-center gap-x-[9px] gap-y-2 rounded-[2px] px-3 py-[9px]',
        tone === 'err' ? 'shadow-[inset_0_0_0_1px_var(--err)]' : 'shadow-[inset_0_0_0_1px_var(--warn)]',
        className,
      )}
    >
      {Icon ? <Icon size={13} aria-hidden className={cn('shrink-0 self-start mt-[2px]', tone === 'err' ? 'text-err' : 'text-warn')} /> : null}
      <div className="min-w-[200px] flex-1 text-[11.5px] leading-[1.5] tracking-[-0.01em]">
        {title ? <b className={cn('font-medium', tone === 'err' ? 'text-err' : 'text-warn')}>{title}</b> : null}
        {title && children ? ' ' : null}
        {children ? <span className="text-t2">{children}</span> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Radio mark (reference .radio i): 12 px ring in --line; on = --acc ring + 6 px dot. Decorative. */
export function RadioMark({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-3 shrink-0 items-center justify-center rounded-full',
        on ? 'shadow-[inset_0_0_0_1px_var(--acc)]' : 'shadow-[inset_0_0_0_1px_var(--line)]',
        className,
      )}
    >
      {on ? <span className="size-1.5 rounded-full bg-acc" /> : null}
    </span>
  );
}

/** Column header cell style (reference thead th / .srchd). */
export const TH = 'ob-label h-7 whitespace-nowrap border-b border-rule px-2 text-left align-middle font-medium first:pl-0 last:pr-0';
/** Body cell style: 28 px rows on a sub-hairline. */
export const TD = 'h-7 whitespace-nowrap border-b border-rule2 px-2 align-middle first:pl-0 last:pr-0';
