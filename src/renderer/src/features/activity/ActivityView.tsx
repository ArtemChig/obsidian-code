// Activity view ("oversee the work"): live list of sessions, subagents, shells, schedule runs and the GPU, with Stop and Open. Owner: ui-views.
import {
  Activity as ActivityIcon,
  Bot,
  CalendarClock,
  CircleStop,
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
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { LiveDuration, RelativeTime } from '@renderer/components/ui/time';
import { cn } from '@renderer/lib/cn';
import { formatDuration, pluralize } from '@renderer/lib/format';
import { navigate, openSession, stopActivity } from '@renderer/state/actions';
import { useActivity } from '@renderer/state/activity';
import { usePending } from '@renderer/state/pending';
import { useSessions } from '@renderer/state/sessions';
import { CoreMissing, useCoreMissing } from '../settings/core-missing';
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
    <div className="h-full overflow-y-auto" data-testid="activity-view">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-8 pb-12 pt-7">
        <header className="flex flex-col gap-1">
          <h1 className="text-title font-semibold leading-7 text-ob-text">Activity</h1>
          <p className="max-w-[680px] text-ui text-ob-text-3">Everything running on this machine: sessions, subagents, background shells, scheduled runs and the rented GPU. Stop anything from here.</p>
        </header>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="activity-counters">
          <Counter id="running" label="Running" value={counts.running} tone="accent" sub={counts.running ? breakdown(liveItems.filter((i) => i.status === 'running')) : 'nothing active'} loaded={loaded} />
          <Counter id="waiting" label="Waiting for you" value={Math.max(counts.waiting, counts.pending)} tone="warning" sub={counts.pending ? pluralize(counts.pending, 'request') : counts.waiting ? 'needs input' : 'all clear'} loaded={loaded} />
          <Counter id="done" label="Finished" value={counts.done} tone="success" sub="recent runs" loaded={loaded} />
          <Counter id="failed" label="Failed" value={counts.failed} tone={counts.failed ? 'danger' : 'neutral'} sub={counts.failed ? 'check the details' : 'no failures'} loaded={loaded} />
        </div>

        {pending.length > 0 ? (
          <section className="flex flex-col gap-2.5" aria-label="Needs your attention" data-testid="activity-pending">
            <SectionLabel action={<span className="ob-tabular font-mono text-[11px] text-ob-warning">{pending.length}</span>}>Needs your attention</SectionLabel>
            <div className="overflow-hidden rounded-card border border-[rgba(232,184,92,0.3)] bg-ob-surface-1">
              <ul className="flex flex-col divide-y divide-ob-border">
                {pending.map((p) => (
                  <PendingItem key={p.requestId} row={p} sessionTitle={sessionTitle(p.sessionId)} />
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
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
        </div>

        {!loaded && coreMissing ? (
          <div className="h-[320px] rounded-card border border-ob-border bg-ob-surface-1">
            <CoreMissing what="Activity" />
          </div>
        ) : !loaded ? (
          <div className="flex flex-col gap-3 rounded-card border border-ob-border bg-ob-surface-1 p-4" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-card border border-ob-border bg-ob-surface-1">
            <EmptyState icon={ActivityIcon} title="Nothing has run yet" description="Sessions, subagents, shells and scheduled runs show up here while they work." />
          </div>
        ) : (
          <>
            <Group testId="activity-running" title="Running" count={groups.running.length} empty={filter === 'all' ? 'Nothing is running right now.' : `No running ${KIND_PLURAL[filter as keyof typeof KIND_PLURAL].toLowerCase()}.`}>
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
                <li className="px-4 py-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)} data-testid="activity-show-all">
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

const TILE_TONE = {
  accent: 'text-ob-accent',
  warning: 'text-ob-warning',
  success: 'text-ob-success',
  danger: 'text-ob-danger',
  neutral: 'text-ob-text-3',
} as const;

function Counter({ id, label, value, sub, tone, loaded }: { id: string; label: string; value: number; sub: string; tone: keyof typeof TILE_TONE; loaded: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-ob-border bg-ob-surface-1 px-4 py-3" data-testid={`activity-count-${id}`}>
      <span className="ob-section-label text-[10px]">{label}</span>
      <span className={cn('ob-tabular font-mono text-[26px] font-medium leading-8', value > 0 ? TILE_TONE[tone] : 'text-ob-text-3')} data-value={value}>
        {loaded ? value : '–'}
      </span>
      <span className="truncate text-small text-ob-text-3" title={sub}>{sub}</span>
    </div>
  );
}

function Group({ title, count, children, empty, tone, testId }: { title: string; count: number; children: ReactNode; empty?: string; tone?: 'warning'; testId: string }) {
  return (
    <section className="flex flex-col gap-2.5" aria-label={title} data-testid={testId}>
      <SectionLabel action={<span className={cn('ob-tabular font-mono text-[11px]', tone === 'warning' ? 'text-ob-warning' : 'text-ob-text-3')}>{count}</span>}>{title}</SectionLabel>
      <div className="overflow-hidden rounded-card border border-ob-border bg-ob-surface-1">
        {count === 0 ? <div className="px-4 py-4 text-ui text-ob-text-3">{empty ?? 'Nothing here.'}</div> : <ul className="flex flex-col divide-y divide-ob-border">{children}</ul>}
      </div>
    </section>
  );
}

function PendingItem({ row, sessionTitle }: { row: PendingRow; sessionTitle?: string }) {
  const Icon = PENDING_ICON[row.kind];
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-testid="activity-pending-row" data-kind={row.kind}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-ob-warning-soft text-ob-warning">
        <Icon size={16} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="warning" mono>
            {PENDING_LABEL[row.kind]}
          </Badge>
          <span className="truncate text-ui font-medium text-ob-text" title={row.title}>
            {row.title}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-small text-ob-text-3">
          <span className="truncate">{sessionTitle ?? 'Unknown session'}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            waiting <LiveDuration since={row.createdAt} format="compact" />
          </span>
        </div>
      </div>
      <Button size="sm" variant="secondary" iconRight={SquareArrowOutUpRight} data-testid="activity-pending-open" onClick={() => openSession(row.sessionId)}>
        {row.kind === 'plan' ? 'Review' : row.kind === 'question' ? 'Answer' : 'Review'}
      </Button>
    </li>
  );
}

function Row({ item, parent, sessionTitle, onStop }: { item: ActivityItem; parent?: string; sessionTitle?: string; onStop: () => void }) {
  const Icon = KIND_ICON[item.kind];
  const live = isLive(item);
  const target = openTarget(item);
  const status = item.status;
  return (
    <li className="group flex items-center gap-3 px-4 py-3 hover:bg-ob-hover" data-testid="activity-row" data-kind={item.kind} data-status={status}>
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-[8px] border',
          status === 'running' && 'border-[rgba(143,184,222,0.25)] bg-ob-accent-soft text-ob-accent',
          status === 'waiting' && 'border-[rgba(232,184,92,0.25)] bg-ob-warning-soft text-ob-warning',
          status === 'error' && 'border-[rgba(240,113,120,0.25)] bg-ob-danger-soft text-ob-danger',
          (status === 'done' || status === 'stopped') && 'border-ob-border bg-ob-surface-2 text-ob-text-3',
        )}
      >
        <Icon size={15} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {target ? (
            <button type="button" onClick={target.run} className="min-w-0 truncate text-left text-ui font-medium text-ob-text hover:underline" title={item.title}>
              {item.title}
            </button>
          ) : (
            <span className="min-w-0 truncate text-ui font-medium text-ob-text" title={item.title}>
              {item.title}
            </span>
          )}
          <Badge tone={item.kind === 'subagent' ? 'violet' : 'neutral'} mono>
            {KIND_LABEL[item.kind]}
          </Badge>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-small text-ob-text-3">
          {item.detail ? (
            <span className={cn('truncate', item.kind === 'shell' || item.kind === 'subagent' ? 'font-mono text-[11.5px]' : '')} title={item.detail}>
              {item.detail}
            </span>
          ) : null}
          {item.kind === 'subagent' && parent ? (
            <>
              {item.detail ? <span aria-hidden>·</span> : null}
              <span className="shrink-0 truncate">in {parent}</span>
            </>
          ) : item.kind === 'shell' && sessionTitle ? (
            <>
              {item.detail ? <span aria-hidden>·</span> : null}
              <span className="shrink-0 truncate">from {sessionTitle}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="hidden w-[150px] shrink-0 flex-col items-end gap-0.5 sm:flex">
        <span className="flex items-center gap-1.5 text-small text-ob-text-2">
          <StatusDot status={status} pulse={status === 'running'} size={6} />
          {STATUS_LABEL[status]}
        </span>
        <span className="ob-tabular font-mono text-[11.5px] text-ob-text-3">
          {live ? (
            <LiveDuration since={item.startedAt} format="compact" />
          ) : item.endedAt ? (
            <span title="Total run time">
              {formatDuration(item.endedAt - item.startedAt)} · <RelativeTime ts={item.endedAt} ago />
            </span>
          ) : (
            <RelativeTime ts={item.startedAt} />
          )}
        </span>
      </div>

      <div className="flex w-[128px] shrink-0 items-center justify-end gap-1.5">
        {live ? (
          <Button size="sm" variant="danger" icon={CircleStop} data-testid="activity-stop" aria-label={`Stop ${item.title}`} onClick={onStop}>
            Stop
          </Button>
        ) : null}
        {target ? (
          <Button size="sm" variant="ghost" data-testid="activity-open" aria-label={`Open ${item.title}`} onClick={target.run}>
            Open
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Where "Open" goes for an item (null when there is nothing to open). */
export function openTarget(item: ActivityItem): { run: () => void } | null {
  if (item.kind === 'gpu') return { run: () => navigate('gpu') };
  if (item.sessionId) return { run: () => openSession(item.sessionId as string) };
  if (item.kind === 'schedule_run') return { run: () => navigate('schedules') };
  return null;
}
