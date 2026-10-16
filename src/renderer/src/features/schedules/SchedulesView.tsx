// Scheduled view: list of scheduled tasks with enable switch, Run now, edit, delete, and the create/edit dialog. Owner: ui-views.
import { CalendarClock, Copy, Cpu, Folder, MessageSquare, Pause, Pencil, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ScheduledTask } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/components/ui/menu';
import { Switch } from '@renderer/components/ui/toggles';
import { RelativeTime, useNow } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { basename, formatDateTime, relativeFuture, shortModelName } from '@renderer/lib/format';
import { openSession } from '@renderer/state/actions';
import { useSchedules } from '@renderer/state/activity';
import { useModels } from '@renderer/state/models';
import { findModel } from '@renderer/state/selectors';
import { useSessions } from '@renderer/state/sessions';
import { copyToClipboard } from '../chat/session-actions';
import { CoreMissing, SyncFailed, useCoreMissing, useSyncError } from '../settings/core-missing';
import { permissionModeLabel } from '../settings/permission-modes';
import { MetaLine, ViewHeader } from '../settings/view-kit';
import { deleteSchedule, duplicateSchedule, runScheduleNow, setScheduleEnabled } from './actions';
import { describeSchedule, isDescribed, isIsoTimestamp } from './cron';
import { ScheduleDialog } from './ScheduleDialog';

export function SchedulesView() {
  const tasks = useSchedules((s) => s.tasks);
  const loaded = useSchedules((s) => s.loaded);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const coreMissing = useCoreMissing();
  const syncError = useSyncError('schedules');

  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
      }),
    [tasks],
  );

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (t: ScheduledTask) => {
    setEditing(t);
    setDialogOpen(true);
  };
  const runNow = async (t: ScheduledTask) => {
    setRunning((r) => ({ ...r, [t.id]: true }));
    try {
      await runScheduleNow(t);
    } finally {
      setRunning((r) => ({ ...r, [t.id]: false }));
    }
  };
  // A paused copy opens right away so it can be changed before it is switched on.
  const duplicate = async (t: ScheduledTask) => {
    const copy = await duplicateSchedule(t);
    if (copy) openEdit(copy);
  };

  const enabledCount = tasks.filter((t) => t.enabled).length;

  return (
    <div className="@container flex h-full flex-col overflow-y-auto" data-testid="schedules-view">
      <ViewHeader
        title="Scheduled"
        description="Run a prompt on a schedule, in its own session. Missed runs happen once when the app opens again."
        actions={
          <Button variant="primary" icon={Plus} data-testid="schedule-new" onClick={openNew}>
            New schedule
          </Button>
        }
      >
        {loaded && tasks.length ? (
          <MetaLine
            className="ml-2"
            items={[
              <>
                <b>{tasks.length}</b> {tasks.length === 1 ? 'schedule' : 'schedules'}
              </>,
              <>
                <b>{enabledCount}</b> enabled
              </>,
            ]}
          />
        ) : null}
      </ViewHeader>

      <div className="flex flex-col px-6 pb-12 pt-5">
        {!loaded && coreMissing ? (
          <div className="h-[320px]">
            <CoreMissing what="Scheduled tasks" />
          </div>
        ) : !loaded && syncError ? (
          <div className="h-[320px]">
            <SyncFailed what="scheduled tasks" error={syncError} />
          </div>
        ) : !loaded ? (
          <div className="flex flex-col" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-14 items-center gap-4 border-b border-rule2">
                <Skeleton className="h-[18px] w-[34px]" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-2.5 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div data-testid="schedules-empty">
            <EmptyState
              icon={CalendarClock}
              title="No scheduled tasks yet"
              description="Have the agent audit dependencies every night, summarize your commits each morning, or run a benchmark on the GPU once a week."
              action={
                <Button variant="primary" icon={Plus} onClick={openNew}>
                  New schedule
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <div className={cn(COLS, 'ob-label h-7 border-b border-rule')} aria-hidden>
              <span>On</span>
              <span>Name</span>
              <span>Schedule</span>
              <span className="@min-[900px]:hidden">Next · last run</span>
              <span className="hidden @min-[900px]:block">Next run</span>
              <span className="hidden @min-[900px]:block">Last run</span>
              <span />
            </div>
            <ul className="flex flex-col" data-testid="schedules-list" aria-label="Scheduled tasks">
              {sorted.map((t) => (
                <TaskRow key={t.id} task={t} running={!!running[t.id]} onEdit={() => openEdit(t)} onDelete={() => setDeleting(t)} onRun={() => void runNow(t)} onDuplicate={() => void duplicate(t)} />
              ))}
            </ul>
          </>
        )}
      </div>

      <ScheduleDialog open={dialogOpen} onOpenChange={setDialogOpen} task={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title="Delete this schedule?"
        description={deleting ? `"${deleting.name}" will stop running. Sessions it already created are kept.` : undefined}
        confirmLabel="Delete schedule"
        onConfirm={async () => {
          if (deleting) await deleteSchedule(deleting.id);
        }}
      />
    </div>
  );
}

// ───────────────────────────── Row ─────────────────────────────

/** Shared grid of the column header and the rows: switch · name · schedule · next run · last run · actions. */
const COLS =
  'grid grid-cols-[34px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(132px,0.9fr)_92px] items-center gap-x-3 @min-[900px]:grid-cols-[34px_minmax(0,1.4fr)_minmax(0,1fr)_112px_minmax(120px,0.8fr)_92px]';

const STATUS_TONE = { ok: 'success', error: 'danger', skipped: 'warning' } as const;
const STATUS_LABEL = { ok: 'Succeeded', error: 'Failed', skipped: 'Skipped' } as const;

function TaskRow({
  task: t,
  running,
  onEdit,
  onDelete,
  onRun,
  onDuplicate,
}: {
  task: ScheduledTask;
  running: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
  onDuplicate: () => void;
}) {
  const now = useNow(30_000);
  const models = useModels((s) => s.models);
  const hasLastSession = useSessions((s) => (t.lastRunSessionId ? !!s.sessions[t.lastRunSessionId] : false));
  const info = findModel(models, t.model);
  const modelLabel = t.model ? (info?.label ?? shortModelName(t.model.model)) : 'Default model';
  const words = describeSchedule(t.schedule, t.oneShot);
  const showCron = !isIsoTimestamp(t.schedule) && (!isDescribed(t.schedule) || t.oneShot);
  const next = t.enabled && t.nextRunAt ? t.nextRunAt : undefined;
  const oneShotDone = t.oneShot && !t.enabled && t.lastRunAt;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-testid="schedule-row"
          data-enabled={t.enabled}
          data-name={t.name}
          // a double click edits (not when it was the switch or a button)
          onDoubleClick={(e) => !(e.target as Element).closest('button, [role="switch"]') && onEdit()}
          className={cn(COLS, 'ob-transition min-h-[52px] border-b border-rule2 py-2 hover:bg-hov')}
        >
          <div className="flex items-center">
            <Switch aria-label={`${t.enabled ? 'Disable' : 'Enable'} ${t.name}`} checked={t.enabled} onCheckedChange={(v) => void setScheduleEnabled(t.id, v)} />
          </div>

          {/* name + where / what / how */}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn('max-w-full truncate text-[12.5px] font-medium tracking-[-0.016em]', t.enabled ? 'text-t1' : 'text-t2')} title={t.name}>
                {t.name}
              </span>
              {!t.enabled ? <Badge tone="neutral">{oneShotDone ? 'done' : 'paused'}</Badge> : null}
              {t.oneShot && t.enabled ? <Badge tone="accent">once</Badge> : null}
              {t.allowAutoClockIn ? (
                <Tooltip content="Rents the GPU automatically when it is off">
                  <span className="flex">
                    <Badge tone="warning" icon={Cpu}>
                      auto clock-in
                    </Badge>
                  </span>
                </Tooltip>
              ) : null}
            </div>
            <MetaLine
              className="flex-nowrap overflow-hidden whitespace-nowrap [&>span]:truncate"
              items={[
                <span key="cwd" className="flex min-w-0 items-center gap-1" title={t.cwd}>
                  <Folder size={10} aria-hidden className="shrink-0" />
                  <b className="truncate">{basename(t.cwd)}</b>
                </span>,
                <span key="model" className="truncate" title={modelLabel}>
                  {modelLabel}
                </span>,
                <span key="mode" className="flex min-w-0 items-center gap-1" title={permissionModeLabel(t.permissionMode)}>
                  <ShieldCheck size={10} aria-hidden className="shrink-0" />
                  <span className="truncate">{permissionModeLabel(t.permissionMode)}</span>
                </span>,
              ]}
            />
          </div>

          {/* schedule in words (+ the raw cron when the words cannot say it all) */}
          <div className="flex min-w-0 flex-col gap-1">
            <span className={cn('truncate text-[12px] tracking-[-0.012em]', t.enabled ? 'text-t1' : 'text-t2')} data-testid="schedule-words" title={words}>
              {words}
            </span>
            {showCron ? <code className="ob-mn truncate text-t3">{t.schedule}</code> : null}
          </div>

          {/* next run (mono) and last run: two columns when wide, stacked in one when narrow */}
          <div className="flex min-w-0 flex-col items-start gap-1.5 @min-[900px]:contents">
            {next ? (
              <span className="ob-tabular max-w-full truncate font-mono text-[10.5px] tracking-[-0.02em] text-t1" data-testid="schedule-next" title={formatDateTime(next)}>
                <span className="sr-only">next run </span>
                {relativeFuture(next - now)}
              </span>
            ) : (
              <span className="max-w-full truncate font-mono text-[10.5px] tracking-[-0.02em] text-t3" data-testid="schedule-next">
                {t.enabled ? 'no upcoming run' : 'not scheduled'}
              </span>
            )}

            {/* last run: status tag + when, then its message */}
            <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
              <div className="flex min-w-0 max-w-full items-center gap-2">
                {t.lastRunStatus ? (
                  <Tooltip content={t.lastRunMessage ?? undefined} disabled={!t.lastRunMessage}>
                    <span className="flex">
                      <Badge tone={STATUS_TONE[t.lastRunStatus]} data-testid="schedule-status">
                        {STATUS_LABEL[t.lastRunStatus]}
                      </Badge>
                    </span>
                  </Tooltip>
                ) : (
                  <Badge tone="neutral" data-testid="schedule-status">
                    Never run
                  </Badge>
                )}
                {t.lastRunAt ? <RelativeTime ts={t.lastRunAt} ago className="ob-tabular truncate font-mono text-[9.5px] text-t3" /> : null}
              </div>
              {t.lastRunAt && (t.lastRunMessage || (hasLastSession && t.lastRunSessionId)) ? (
                <div className="flex min-w-0 max-w-full items-center gap-1.5 font-mono text-[9.5px] tracking-[0.01em]">
                  {t.lastRunMessage ? (
                    <span className={cn('min-w-0 truncate', t.lastRunStatus === 'error' ? 'text-err' : t.lastRunStatus === 'skipped' ? 'text-warn' : 'text-t3')} title={t.lastRunMessage}>
                      {t.lastRunMessage}
                    </span>
                  ) : null}
                  {hasLastSession && t.lastRunSessionId ? (
                    <button type="button" className="shrink-0 font-sans text-[11px] text-acc hover:underline" onClick={() => openSession(t.lastRunSessionId as string)}>
                      Open session
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-0.5">
            <IconButton label="Run now" icon={Play} size="md" loading={running} data-testid="schedule-run" onClick={onRun} />
            <IconButton label="Edit" icon={Pencil} size="md" data-testid="schedule-edit" onClick={onEdit} />
            <IconButton label="Delete" icon={Trash2} size="md" variant="danger" data-testid="schedule-delete" onClick={onDelete} />
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="schedule-menu">
        <ContextMenuItem icon={Play} disabled={running} onSelect={onRun}>
          Run now
        </ContextMenuItem>
        <ContextMenuItem icon={Pencil} onSelect={onEdit}>
          Edit…
        </ContextMenuItem>
        <ContextMenuItem icon={t.enabled ? Pause : Play} onSelect={() => void setScheduleEnabled(t.id, !t.enabled)}>
          {t.enabled ? 'Pause' : 'Resume'}
        </ContextMenuItem>
        <ContextMenuItem icon={Copy} onSelect={onDuplicate}>
          Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        {hasLastSession && t.lastRunSessionId ? (
          <ContextMenuItem icon={MessageSquare} onSelect={() => openSession(t.lastRunSessionId as string)}>
            Open last session
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem icon={Copy} onSelect={() => void copyToClipboard(t.prompt, 'Prompt')}>
          Copy prompt
        </ContextMenuItem>
        {!isIsoTimestamp(t.schedule) ? (
          <ContextMenuItem icon={Copy} onSelect={() => void copyToClipboard(t.schedule, 'Cron expression')}>
            Copy cron expression
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem icon={Trash2} danger onSelect={onDelete}>
          Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
