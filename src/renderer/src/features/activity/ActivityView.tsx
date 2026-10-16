// Activity view ("oversee the work"): live list of sessions, subagents, shells, schedule runs and the GPU, with Stop and Open. Owner: ui-views.
import {
  Activity as ActivityIcon,
  Bot,
  CalendarClock,
  CircleStop,
  Copy,
  Cpu,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  ShieldAlert,
  SquareArrowOutUpRight,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ActivityItem } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { EmptyState, Skeleton, StatusDot } from '@renderer/components/ui/feedback';
import { SectionLabel } from '@renderer/components/ui/layout';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/components/ui/menu';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { LiveDuration, RelativeTime } from '@renderer/components/ui/time';
import { cn } from '@renderer/lib/cn';
import { formatDuration, pluralize } from '@renderer/lib/format';
import { navigate, openSession, stopActivity } from '@renderer/state/actions';
import { useActivity } from '@renderer/state/activity';
import { usePending } from '@renderer/state/pending';
import { useSessions } from '@renderer/state/sessions';
import { copyToClipboard } from '../chat/session-actions';
import { CoreMissing, SyncFailed, useCoreMissing, useSyncError } from '../settings/core-missing';
import { ViewHeader } from '../settings/view-kit';
import {
  KIND_LABEL,
  KIND_ORDER,
  KIND_PLURAL,
  PENDING_LABEL,
  STATUS_LABEL,
  activityCounts,
  breakdown,
  groupActivity,
  isLive,
  pendingRows,
  type KindFilter,
  type PendingKind,
  type PendingRow,
} from './model';

const KIND_ICON: Record<ActivityItem['kind'], LucideIcon> = {
  session: MessageSquare,
  subagent: Bot,
  shell: Terminal,
  schedule_run: CalendarClock,
  gpu: Cpu,
};

const PENDING_ICON: Record<PendingKind, LucideIcon> = { permission: ShieldAlert, question: MessageCircleQuestion, plan: ListChecks };

const RECENT_PAGE = 12;

export function ActivityView() {
  const items = useActivity((s) => s.items);
  const loaded = useActivity((s) => s.loaded);
  const permissions = usePending((s) => s.permissions);
  const questions = usePending((s) => s.questions);
  const plans = usePending((s) => s.plans);
  const sessions = useSessions((s) => s.sessions);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const [confirmGpu, setConfirmGpu] = useState<ActivityItem | null>(null);
  const coreMissing = useCoreMissing();
  const syncError = useSyncError('activity');

  const pending = useMemo(() => pendingRows(permissions, questions, plans), [permissions, questions, plans]);
  const counts = useMemo(() => activityCounts(items, pending.length), [items, pending.length]);
  const groups = useMemo(() => groupActivity(items, filter), [items, filter]);
  const liveItems = useMemo(() => items.filter(isLive), [items]);
  const recent = showAll ? groups.recent : groups.recent.slice(0, RECENT_PAGE);
  const sessionTitle = (id?: string) => (id ? sessions[id]?.title : undefined);
  const parentTitle = (id?: string) => {
    const parent = id ? sessions[id]?.parentSessionId : undefined;
    return parent ? sessions[parent]?.title : undefined;
  };

  const stop = (item: ActivityItem) => {
    if (item.kind === 'gpu') setConfirmGpu(item);
    else void stopActivity(item.id);
  };

  return (
    <div className="@container flex h-full flex-col overflow-y-auto" data-testid="activity-view">
      <ViewHeader
        title="Activity"
        description="Everything running on this machine: sessions, subagents, background shells, scheduled runs and the rented GPU. Stop anything from here."
      />

      <div className="flex shrink-0 flex-wrap items-stretch gap-y-3 border-b border-rule px-6 pb-[13px] pt-3" data-testid="activity-counters">
        <Counter id="running" label="Running" value={counts.running} tone="violet" sub={counts.running ? breakdown(liveItems.filter((i) => i.status === 'running')) : 'nothing active'} loaded={loaded} />
        <Counter id="waiting" label="Waiting for you" value={Math.max(counts.waiting, counts.pending)} tone="warning" sub={counts.pending ? pluralize(counts.pending, 'request') : counts.waiting ? 'needs input' : 'all clear'} loaded={loaded} />
        <Counter id="done" label="Finished" value={counts.done} tone="success" sub="recent runs" loaded={loaded} />
        <Counter id="failed" label="Failed" value={counts.failed} tone="danger" sub={counts.failed ? 'check the details' : 'no failures'} loaded={loaded} />
      </div>

      <div className="flex h-[50px] shrink-0 items-center gap-3 border-b border-rule px-6">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as KindFilter)}>
          <TabsList variant="pill" aria-label="Filter by kind" data-testid="activity-filter">
            <TabsTrigger value="all" count={items.length || undefined}>
              All
            </TabsTrigger>
            {KIND_ORDER.filter((k) => counts.byKind[k] > 0 || filter === k).map((k) => (
              <TabsTrigger key={k} value={k} count={counts.byKind[k] || undefined}>
                {KIND_PLURAL[k]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="ob-mn ml-auto hidden @min-[640px]:inline">
          <b className="font-normal text-t2">{items.length}</b> {items.length === 1 ? 'item' : 'items'} · updates live
        </span>
      </div>

      <div className="flex flex-col gap-7 px-6 pb-12 pt-5">
        {pending.length > 0 ? (
          <section className="flex flex-col" aria-label="Needs your attention" data-testid="activity-pending">
            <SectionLabel rule action={<span className="ob-tabular text-warn">{pending.length}</span>}>
              Needs you
            </SectionLabel>
            <ul className="mt-1.5 flex flex-col border-t border-rule">
              {pending.map((p) => (
                <PendingItem key={p.requestId} row={p} sessionTitle={sessionTitle(p.sessionId)} />
              ))}
            </ul>
          </section>
        ) : null}

        {!loaded && coreMissing ? (
          <div className="h-[320px]">
            <CoreMissing what="Activity" />
          </div>
        ) : !loaded && syncError ? (
          <div className="h-[320px]">
            <SyncFailed what="activity" error={syncError} />
          </div>
        ) : !loaded ? (
          <div className="flex flex-col" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex h-8 items-center gap-3 border-b border-rule2">
                <Skeleton className="size-1.5" />
                <Skeleton className="h-2.5 w-1/3" />
                <Skeleton className="ml-auto h-2.5 w-16" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={ActivityIcon} title="Nothing has run yet" description="Sessions, subagents, shells and scheduled runs show up here while they work." />
        ) : (
          <>
            <Group testId="activity-running" title="Running" count={groups.running.length} tone="violet" empty={filter === 'all' ? 'Nothing is running right now.' : `No running ${KIND_PLURAL[filter as keyof typeof KIND_PLURAL].toLowerCase()}.`}>
              {groups.running.map((i) => (
                <Row key={i.id} item={i} parent={parentTitle(i.sessionId)} sessionTitle={sessionTitle(i.sessionId)} onStop={() => stop(i)} />
              ))}
            </Group>
            {groups.waiting.length > 0 ? (
              <Group testId="activity-waiting" title="Waiting for you" count={groups.waiting.length} tone="warning">
                {groups.waiting.map((i) => (
                  <Row key={i.id} item={i} parent={parentTitle(i.sessionId)} sessionTitle={sessionTitle(i.sessionId)} onStop={() => stop(i)} />
                ))}
              </Group>
            ) : null}
            <Group testId="activity-recent" title="Recent" count={groups.recent.length} empty="No finished runs yet.">
              {recent.map((i) => (
                <Row key={i.id} item={i} parent={parentTitle(i.sessionId)} sessionTitle={sessionTitle(i.sessionId)} onStop={() => stop(i)} />
              ))}
              {groups.recent.length > RECENT_PAGE ? (
                <li className="py-1">
                  <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => setShowAll((v) => !v)} data-testid="activity-show-all">
                    {showAll ? 'Show fewer' : `Show all ${groups.recent.length}`}
                  </Button>
                </li>
              ) : null}
            </Group>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmGpu !== null}
        onOpenChange={(o) => !o && setConfirmGpu(null)}
        danger
        title="Clock out the GPU?"
        description="This destroys the rented instance and stops billing. Work that is using the GPU model will fail."
        confirmLabel="Clock out"
        onConfirm={async () => {
          if (confirmGpu) await stopActivity(confirmGpu.id);
        }}
      />
    </div>
  );
}

// ───────────────────────────── Parts ─────────────────────────────

const COUNT_TONE = { violet: 'text-live', warning: 'text-warn', success: 'text-ok', danger: 'text-err' } as const;

/** One mono stat of the counter strip (reference .recseg): status-coloured label + dot when non-zero, big mono value. */
function Counter({ id, label, value, sub, tone, loaded }: { id: string; label: string; value: number; sub: string; tone: keyof typeof COUNT_TONE; loaded: boolean }) {
  const lit = loaded && value > 0;
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-1.5 px-5 first:pl-0 [&+&]:shadow-[inset_1px_0_0_var(--rule2)]" data-testid={`activity-count-${id}`}>
      <span className={cn('flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.18em]', lit ? COUNT_TONE[tone] : 'text-t3')}>
        {lit ? <StatusDot tone={tone} size={5} pulse={tone === 'violet'} /> : null}
        {label}
      </span>
      <span className={cn('ob-tabular font-mono text-[23px] leading-none tracking-[-0.05em]', lit ? 'text-t1' : 'text-t3')} data-value={value}>
        {loaded ? value : '–'}
      </span>
      <span className="truncate font-mono text-[9px] tracking-[0.02em] text-t3" title={sub}>
        {sub}
      </span>
    </div>
  );
}

/** Shared grid of the column header and the rows: status · name · kind · state · elapsed · actions. */
const COLS = 'grid grid-cols-[10px_minmax(0,1fr)_auto] @min-[760px]:grid-cols-[10px_minmax(0,1fr)_84px_104px_150px_136px] items-center gap-x-3';

function Group({ title, count, children, empty, tone, testId }: { title: string; count: number; children: ReactNode; empty?: string; tone?: 'warning' | 'violet'; testId: string }) {
  return (
    <section className="flex flex-col" aria-label={title} data-testid={testId}>
      <SectionLabel rule action={<span className={cn('ob-tabular', count && tone === 'warning' ? 'text-warn' : count && tone === 'violet' ? 'text-live' : 'text-t3')}>{count}</span>}>
        {title}
      </SectionLabel>
      <div className={cn(COLS, 'ob-label mt-1.5 hidden h-7 border-b border-rule @min-[760px]:grid')} aria-hidden>
        <span />
        <span>Name</span>
        <span>Kind</span>
        <span>Status</span>
        <span>Elapsed</span>
        <span />
      </div>
      {count === 0 ? <div className="flex h-8 items-center border-b border-rule2 text-[11.5px] text-t3">{empty ?? 'Nothing here.'}</div> : <ul className="flex flex-col">{children}</ul>}
    </section>
  );
}

function PendingItem({ row, sessionTitle }: { row: PendingRow; sessionTitle?: string }) {
  const Icon = PENDING_ICON[row.kind];
  return (
    <li
      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule2 bg-hov py-1 pl-3 pr-1 shadow-[inset_2px_0_0_var(--warn)]"
      data-testid="activity-pending-row"
      data-kind={row.kind}
    >
      <Icon size={13} aria-hidden className="shrink-0 text-warn" />
      <Badge tone="warning">{PENDING_LABEL[row.kind]}</Badge>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium tracking-[-0.012em] text-t1" title={row.title}>
        {row.title}
      </span>
      <span className="ob-mn hidden min-w-0 max-w-[260px] truncate @min-[640px]:inline">{sessionTitle ?? 'Unknown session'}</span>
      <span className="ob-tabular w-[92px] shrink-0 text-right font-mono text-[10.5px] tracking-[-0.02em] text-warn" title="Waiting for">
        <LiveDuration since={row.createdAt} format="compact" />
      </span>
      <Button size="sm" variant="secondary" iconRight={SquareArrowOutUpRight} data-testid="activity-pending-open" onClick={() => openSession(row.sessionId)}>
        {row.kind === 'question' ? 'Answer' : 'Review'}
      </Button>
    </li>
  );
}

function Row({ item, parent, sessionTitle, onStop }: { item: ActivityItem; parent?: string; sessionTitle?: string; onStop: () => void }) {
  const Icon = KIND_ICON[item.kind];
  const live = isLive(item);
  const target = openTarget(item);
  const status = item.status;
  const context = item.kind === 'subagent' && parent ? `in ${parent}` : item.kind === 'shell' && sessionTitle ? `from ${sessionTitle}` : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className={cn(COLS, 'ob-transition min-h-8 border-b border-rule2 py-1 hover:bg-hov')} data-testid="activity-row" data-kind={item.kind} data-status={status}>
          <StatusDot status={status} pulse={status === 'running'} size={6} label={STATUS_LABEL[status]} />
          <div className="flex min-w-0 items-center gap-2">
            <Icon size={13} aria-hidden className="shrink-0 text-t3" />
            {target ? (
              <button type="button" onClick={target.run} className="min-w-0 truncate text-left text-[12px] font-medium tracking-[-0.012em] text-t1 hover:underline" title={item.title}>
                {item.title}
              </button>
            ) : (
              <span className="min-w-0 truncate text-[12px] font-medium tracking-[-0.012em] text-t1" title={item.title}>
                {item.title}
              </span>
            )}
            {item.detail || context ? (
              <span className="ob-mn min-w-0 flex-1 truncate" title={[item.detail, context].filter(Boolean).join(' · ')}>
                {item.detail ? <b className={cn('font-normal', item.kind === 'shell' || item.kind === 'subagent' ? 'text-t2' : 'text-t3')}>{item.detail}</b> : null}
                {item.detail && context ? <span className="opacity-[.42]"> / </span> : null}
                {context}
              </span>
            ) : null}
          </div>
          <span className="hidden @min-[760px]:block">
            <Badge tone="neutral">{KIND_LABEL[item.kind]}</Badge>
          </span>
          <span
            className={cn(
              'hidden text-[11.5px] tracking-[-0.01em] @min-[760px]:block',
              status === 'running' ? 'text-live' : status === 'waiting' ? 'text-warn' : status === 'error' ? 'text-err' : 'text-t2',
            )}
          >
            {STATUS_LABEL[status]}
          </span>
          <span className="ob-tabular hidden truncate font-mono text-[10.5px] tracking-[-0.02em] text-t2 @min-[760px]:block">
            {live ? (
              <LiveDuration since={item.startedAt} format="compact" className="text-t1" />
            ) : item.endedAt ? (
              <span title="Total run time">
                {formatDuration(item.endedAt - item.startedAt)} <span className="text-t3">· <RelativeTime ts={item.endedAt} ago /></span>
              </span>
            ) : (
              <RelativeTime ts={item.startedAt} />
            )}
          </span>
          <div className="flex items-center justify-end gap-1.5">
            {live ? (
              <Button size="sm" variant="danger" icon={CircleStop} data-testid="activity-stop" aria-label={`Stop ${item.title}`} onClick={onStop}>
                Stop
              </Button>
            ) : null}
            {target ? (
              <Button size="sm" variant="secondary" data-testid="activity-open" aria-label={`Open ${item.title}`} onClick={target.run}>
                Open
              </Button>
            ) : null}
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="activity-menu">
        {target ? (
          <ContextMenuItem icon={SquareArrowOutUpRight} onSelect={target.run}>
            Open
          </ContextMenuItem>
        ) : null}
        {live ? (
          <ContextMenuItem icon={CircleStop} danger onSelect={onStop}>
            Stop
          </ContextMenuItem>
        ) : null}
        {target || live ? <ContextMenuSeparator /> : null}
        <ContextMenuItem icon={Copy} onSelect={() => void copyToClipboard(item.title, 'Title')}>
          Copy title
        </ContextMenuItem>
        {item.detail ? (
          <ContextMenuItem icon={Copy} onSelect={() => void copyToClipboard(item.detail as string, 'Details')}>
            Copy details
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Where "Open" goes for an item (null when there is nothing to open). */
export function openTarget(item: ActivityItem): { run: () => void } | null {
  if (item.kind === 'gpu') return { run: () => navigate('gpu') };
  if (item.sessionId) return { run: () => openSession(item.sessionId as string) };
  if (item.kind === 'schedule_run') return { run: () => navigate('schedules') };
  return null;
}
