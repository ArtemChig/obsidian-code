// Scheduled view: list of scheduled tasks with enable switch, Run now, edit, delete, and the create/edit dialog. Owner: ui-views.
import { Box, CalendarClock, Cpu, Folder, Pencil, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ScheduledTask } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
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
import { CoreMissing, useCoreMissing } from '../settings/core-missing';
import { permissionModeLabel } from '../settings/permission-modes';
import { deleteSchedule, runScheduleNow, setScheduleEnabled } from './actions';
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

  return (
    <div className="h-full overflow-y-auto" data-testid="schedules-view">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-8 pb-12 pt-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-title font-semibold leading-7 text-ob-text">Scheduled</h1>
            <p className="max-w-[640px] text-ui text-ob-text-3">Run a prompt on a schedule, in its own session. Missed runs happen once when the app opens again.</p>
          </div>
          <Button variant="primary" icon={Plus} data-testid="schedule-new" onClick={openNew}>
            New schedule
          </Button>
        </header>

        {!loaded && coreMissing ? (
          <div className="h-[320px] rounded-card border border-ob-border bg-ob-surface-1">
            <CoreMissing what="Scheduled tasks" />
          </div>
        ) : !loaded ? (
          <div className="flex flex-col gap-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[92px] w-full rounded-card" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-card border border-ob-border bg-ob-surface-1" data-testid="schedules-empty">
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
          <ul className="flex flex-col gap-3" data-testid="schedules-list" aria-label="Scheduled tasks">
            {sorted.map((t) => (
              <TaskRow key={t.id} task={t} running={!!running[t.id]} onEdit={() => openEdit(t)} onDelete={() => setDeleting(t)} onRun={() => void runNow(t)} />
            ))}
          </ul>
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

const STATUS_TONE = { ok: 'success', error: 'danger', skipped: 'warning' } as const;
const STATUS_LABEL = { ok: 'Succeeded', error: 'Failed', skipped: 'Skipped' } as const;

function TaskRow({ task: t, running, onEdit, onDelete, onRun }: { task: ScheduledTask; running: boolean; onEdit: () => void; onDelete: () => void; onRun: () => void }) {
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
    <li
      data-testid="schedule-row"
      data-enabled={t.enabled}
      data-name={t.name}
      className={cn('ob-transition flex gap-4 rounded-card border border-ob-border bg-ob-surface-1 p-4 hover:border-[#30414f]', !t.enabled && 'bg-[rgba(16,26,31,0.6)]')}
    >
      <div className="pt-0.5">
        <Switch aria-label={`${t.enabled ? 'Disable' : 'Enable'} ${t.name}`} checked={t.enabled} onCheckedChange={(v) => void setScheduleEnabled(t.id, v)} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className={cn('truncate text-[14px] font-medium', t.enabled ? 'text-ob-text' : 'text-ob-text-2')} title={t.name}>
            {t.name}
          </span>
          {t.lastRunStatus ? (
            <Tooltip content={t.lastRunMessage ?? undefined} disabled={!t.lastRunMessage}>
              <span>
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
          {!t.enabled ? <Badge tone="neutral" mono>{oneShotDone ? 'done' : 'paused'}</Badge> : null}
          {t.oneShot && t.enabled ? <Badge tone="accent" mono>once</Badge> : null}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui">
          <span className="text-ob-text-2" data-testid="schedule-words">
            {words}
          </span>
          {showCron ? <code className="rounded bg-[rgba(236,240,241,0.06)] px-1.5 font-mono text-[11px] text-ob-text-3">{t.schedule}</code> : null}
          <span aria-hidden className="text-ob-text-3">
            ·
          </span>
          {next ? (
            <span className="text-ob-text-2" data-testid="schedule-next" title={formatDateTime(next)}>
              next run <span className="text-ob-accent">{relativeFuture(next - now)}</span>
            </span>
          ) : (
            <span className="text-ob-text-3" data-testid="schedule-next">
              {t.enabled ? 'no upcoming run' : 'not scheduled'}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-small text-ob-text-3">
          <span className="flex min-w-0 items-center gap-1.5" title={t.cwd}>
            <Folder size={12} aria-hidden />
            <span className="truncate">{basename(t.cwd)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <Box size={12} aria-hidden />
            <span className="max-w-[240px] truncate">{modelLabel}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={12} aria-hidden />
            {permissionModeLabel(t.permissionMode)}
          </span>
          {t.allowAutoClockIn ? (
            <Tooltip content="Rents the GPU automatically when it is off">
              <span>
                <Badge tone="warning" icon={Cpu}>
                  auto clock-in
                </Badge>
              </span>
            </Tooltip>
          ) : null}
        </div>

        <div className="flex min-w-0 items-center gap-1.5 text-small text-ob-text-3">
          {t.lastRunAt ? (
            <>
              <span>
                Last run <RelativeTime ts={t.lastRunAt} className="text-ob-text-2" /> ago
              </span>
              {t.lastRunMessage ? (
                <>
                  <span aria-hidden>·</span>
                  <span className={cn('truncate', t.lastRunStatus === 'error' ? 'text-ob-danger' : t.lastRunStatus === 'skipped' ? 'text-ob-warning' : '')} title={t.lastRunMessage}>
                    {t.lastRunMessage}
                  </span>
                </>
              ) : null}
              {hasLastSession && t.lastRunSessionId ? (
                <button type="button" className="ml-1 shrink-0 text-ob-accent hover:underline" onClick={() => openSession(t.lastRunSessionId as string)}>
                  Open session
                </button>
              ) : null}
            </>
          ) : (
            <span>Has not run yet.</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-start gap-0.5">
        <IconButton label="Run now" icon={Play} size="lg" loading={running} data-testid="schedule-run" onClick={onRun} />
        <IconButton label="Edit" icon={Pencil} size="lg" data-testid="schedule-edit" onClick={onEdit} />
        <IconButton label="Delete" icon={Trash2} size="lg" variant="danger" data-testid="schedule-delete" onClick={onDelete} />
      </div>
    </li>
  );
}

