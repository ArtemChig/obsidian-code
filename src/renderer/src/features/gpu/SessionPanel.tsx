// The hero card of the GPU view: clock-in summary when off; steps, progress, timer and live cost when clocked in. Owner: ui-views.
import { Check, CircleX, Copy, Power, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CatalogModel, GpuProfile, GpuStatus } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ProgressBar, Spinner, StatusDot } from '@renderer/components/ui/feedback';
import { LiveDuration } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { GPU_PHASE_LABEL, gpuTone, useLiveGpuCost } from '@renderer/app/GpuWidget';
import { cn } from '@renderer/lib/cn';
import { formatMoney, formatPerHour } from '@renderer/lib/format';
import { toast } from '@renderer/state/toasts';
import { GPU_BUSY_PHASES } from '@renderer/state/gpu';
import { formatWarmup, gpuSpec, splitModelLabel, warmupCost, warmupSeconds, type PriceStats } from './model';

export interface SessionPanelProps {
  status: GpuStatus;
  profile?: GpuProfile;
  /** Model the user has picked (what Clock in would start). */
  pickedModel?: CatalogModel;
  /** Label of the model the instance serves (when clocked in). */
  runningModelLabel?: string | null;
  stats: PriceStats | null;
  hasApiKey: boolean | null;
  busy: boolean;
  /** Titles of chat sessions currently running on the GPU model. */
  runningSessions: string[];
  idleMinutes: number;
  maxSessionHours: number;
  parkedElsewhere: boolean;
  onClockIn: () => void;
  onClockOut: () => Promise<unknown> | void;
}

export function SessionPanel(p: SessionPanelProps) {
  const { status } = p;
  const phase = status.phase;
  if (phase === 'off') return <OffPanel {...p} />;
  return <ActivePanel {...p} />;
}

// ───────────────────────────── Off: clock-in summary ─────────────────────────────

function OffPanel({ status, profile, pickedModel, stats, hasApiKey, busy, idleMinutes, maxSessionHours, parkedElsewhere, onClockIn }: SessionPanelProps) {
  const budgetLeft = status.monthlyBudget - status.monthCost;
  const exhausted = status.monthlyBudget > 0 && budgetLeft <= 0;
  const noProfile = !profile;
  const disabledReason = noProfile ? 'No GPU profile configured' : hasApiKey === false ? 'Add your Vast.ai API key first' : exhausted ? 'Monthly budget reached' : null;
  const secs = warmupSeconds(pickedModel);
  const wCost = warmupCost(secs, stats?.median);
  const model = pickedModel ? splitModelLabel(pickedModel.label) : null;
  return (
    <section className="overflow-hidden rounded-card border border-ob-border bg-ob-surface-1" data-testid="gpu-panel" data-phase="off" aria-label="Clock in">
      <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <StatusDot tone="neutral" size={8} />
            <span className="text-[15px] font-semibold text-ob-text">GPU is off</span>
            <span className="text-ui text-ob-text-3">nothing is being billed</span>
          </div>
          {profile ? (
            <div className="text-ui text-ob-text-2" data-testid="gpu-summary">
              <span className="font-medium text-ob-text">{profile.label}</span> <span className="text-ob-text-3">·</span> {gpuSpec(profile)}
              {model ? (
                <>
                  {' '}
                  <span className="text-ob-text-3">·</span> {model.name}
                  {pickedModel?.variant === 'uncensored' ? (
                    <Badge tone="violet" mono className="ml-2 align-[1px]">
                      uncensored
                    </Badge>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : (
            <div className="text-ui text-ob-text-3">Add a GPU profile in Settings → Vast.ai to get started.</div>
          )}
          <div className="ob-tabular flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11.5px] text-ob-text-3">
            <span>{stats ? `${formatPerHour(stats.min)} cheapest · ${formatPerHour(stats.median)} typical` : 'prices loading…'}</span>
            <span>warm-up {formatWarmup(secs)}{wCost != null ? ` (≈ ${formatMoney(wCost)})` : ''}</span>
            <span>auto clock-out after {idleMinutes} min idle · max {maxSessionHours} h</span>
          </div>
          {parkedElsewhere ? (
            <div className="flex items-start gap-1.5 text-small text-ob-warning">
              <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
              <span>Another profile is parked. Clocking in with this profile destroys the parked instance.</span>
            </div>
          ) : null}
          {disabledReason ? (
            <div className="text-small text-ob-warning" data-testid="gpu-clock-disabled-reason">
              {disabledReason}
              {exhausted ? ` (${formatMoney(status.monthCost)} of ${formatMoney(status.monthlyBudget)} spent). Raise the budget in Settings → Vast.ai.` : '.'}
            </div>
          ) : null}
        </div>
        <Button
          size="lg"
          variant="primary"
          icon={Power}
          loading={busy}
          disabled={!!disabledReason}
          data-testid="gpu-main-button"
          className="h-11 min-w-[168px] px-6 text-[14px]"
          onClick={onClockIn}
        >
          Clock in
        </Button>
      </div>
      {status.phase === 'off' && status.message && status.message !== 'Off' ? (
        <div className="border-t border-ob-border bg-[rgba(0,0,0,0.12)] px-5 py-2 text-small text-ob-text-3">{status.message}</div>
      ) : null}
    </section>
  );
}

// ───────────────────────────── Active: steps, timer, cost ─────────────────────────────

function StepIcon({ state }: { state: GpuStatus['steps'][number]['state'] }) {
  if (state === 'done') return <Check size={14} strokeWidth={2.5} aria-hidden className="text-ob-success" />;
  if (state === 'active') return <Spinner size={14} className="text-ob-accent" />;
  if (state === 'error') return <CircleX size={14} aria-hidden className="text-ob-danger" />;
  return <span aria-hidden className="size-1.5 rounded-full bg-[#3a4a57]" />;
}

function ActivePanel({ status, profile, runningModelLabel, hasApiKey, busy, onClockIn, onClockOut }: SessionPanelProps) {
  const phase = status.phase;
  const cost = useLiveGpuCost(status);
  const inProgress = GPU_BUSY_PHASES.has(phase) && phase !== 'stopping';
  const steps = status.steps ?? [];
  const done = steps.filter((s) => s.state === 'done').length;
  const activeIdx = steps.findIndex((s) => s.state === 'active');
  const frac = steps.length ? (done + (activeIdx >= 0 && status.progress != null ? status.progress : 0)) / steps.length : null;
  const determinate = phase === 'downloading' || phase === 'loading';
  const barValue = phase === 'ready' ? 1 : determinate && status.progress != null ? frac : phase === 'error' || phase === 'stopping' ? frac : steps.length ? frac : null;
  const rental = status.clockedInAt != null && phase !== 'error';
  const label = [status.numGpus && status.numGpus > 1 ? `${status.numGpus}×` : null, status.gpuName].filter(Boolean).join(' ');
  // The confirmation (running sessions / a rented clock-in) is app-wide: see requestClockOut + GpuClockOutConfirm.
  const out = async () => {
    await onClockOut();
  };
  return (
    <section
      className={cn(
        'overflow-hidden rounded-card border',
        phase === 'ready' ? 'border-[rgba(95,211,154,0.28)] bg-[linear-gradient(180deg,rgba(95,211,154,0.07),rgba(95,211,154,0.015))]' : phase === 'error' ? 'border-[rgba(240,113,120,0.32)] bg-ob-danger-soft' : 'border-ob-border bg-ob-surface-1',
      )}
      data-testid="gpu-panel"
      data-phase={phase}
      aria-label="GPU session"
    >
      <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_260px]">
        {/* left: status + steps */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot tone={gpuTone(phase)} size={8} pulse={GPU_BUSY_PHASES.has(phase)} glow={phase === 'ready'} />
              <span className="text-[15px] font-semibold text-ob-text" data-testid="gpu-phase">
                {GPU_PHASE_LABEL[phase]}
              </span>
              {label ? <span className="text-ui text-ob-text-2">{label}</span> : null}
              {status.location ? <span className="text-ui text-ob-text-3">· {status.location}</span> : null}
              {phase === 'ready' ? <Badge tone="success" mono>serving</Badge> : null}
            </div>
            <div className="text-ui text-ob-text-2" data-testid="gpu-message" aria-live="polite">
              {status.message}
              {determinate && status.progress != null ? <span className="ob-tabular ml-1 font-mono text-ob-text">{Math.round(status.progress * 100)}%</span> : null}
            </div>
            {runningModelLabel ? <div className="text-small text-ob-text-3">{runningModelLabel}</div> : null}
          </div>

          {steps.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <ProgressBar
                  value={barValue}
                  tone={phase === 'error' ? 'danger' : phase === 'ready' ? 'success' : phase === 'stopping' ? 'warning' : 'accent'}
                  size="md"
                  label="Clock-in progress"
                />
                <span className="ob-tabular shrink-0 font-mono text-[11px] text-ob-text-3">
                  {done}/{steps.length}
                </span>
              </div>
              <ol className="flex flex-col gap-1.5" data-testid="gpu-steps">
                {steps.map((s) => (
                  <li
                    key={s.id}
                    data-state={s.state}
                    className={cn(
                      'flex items-center gap-2.5 text-ui',
                      s.state === 'todo' ? 'text-ob-text-3' : s.state === 'error' ? 'text-ob-danger' : s.state === 'active' ? 'font-medium text-ob-text' : 'text-ob-text-2',
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <StepIcon state={s.state} />
                    </span>
                    {s.label}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {phase === 'error' && (status.lastError || status.message) ? (
            <div role="alert" className="ob-selectable flex items-start gap-2 rounded-ctl border border-[rgba(240,113,120,0.3)] bg-[rgba(240,113,120,0.08)] px-3 py-2 text-ui text-ob-text" data-testid="gpu-error">
              <TriangleAlert size={15} aria-hidden className="mt-0.5 shrink-0 text-ob-danger" />
              <span className="min-w-0 break-words">{status.lastError ?? status.message}</span>
              <IconButton
                label="Copy error"
                icon={Copy}
                size="sm"
                className="ml-auto"
                onClick={() => {
                  void navigator.clipboard?.writeText(status.lastError ?? status.message).then(() => toast({ title: 'Copied', level: 'success', durationMs: 1500 }));
                }}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {phase === 'error' && status.instanceId != null ? (
              // An instance is still tracked (e.g. from the last run): stopping it comes first, never a second rental.
              <Button size="lg" variant="danger" icon={Power} loading={busy} data-testid="gpu-main-button" className="h-11 min-w-[168px] px-6 text-[14px]" onClick={() => void onClockOut()}>
                Clock out
              </Button>
            ) : phase === 'error' ? (
              <Button size="lg" variant="primary" icon={Power} loading={busy} disabled={hasApiKey === false} data-testid="gpu-main-button" className="h-11 min-w-[168px] px-6 text-[14px]" onClick={onClockIn}>
                Try again
              </Button>
            ) : (
              <Button
                size="lg"
                variant="danger"
                icon={Power}
                loading={busy || phase === 'stopping'}
                data-testid="gpu-main-button"
                className="h-11 min-w-[168px] px-6 text-[14px]"
                onClick={() => void out()}
              >
                {phase === 'stopping' ? 'Clocking out…' : inProgress ? 'Cancel clock-in' : 'Clock out'}
              </Button>
            )}
            {phase === 'ready' ? <span className="text-small text-ob-text-3">Destroys the instance; billing stops.</span> : null}
            {inProgress ? <span className="text-small text-ob-text-3">Cancelling destroys the instance if one was rented.</span> : null}
          </div>
        </div>

        {/* right: metrics */}
        <dl className="grid grid-cols-2 content-start gap-x-4 gap-y-4 border-t border-ob-border pt-4 md:grid-cols-1 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <Metric label="Session time" testId="gpu-timer">
            {rental && status.clockedInAt ? <LiveDuration since={status.clockedInAt} className="text-[22px] font-medium leading-7 text-ob-text" /> : <span className="text-[22px] leading-7 text-ob-text-3">—</span>}
          </Metric>
          <Metric label="Session cost" testId="gpu-cost">
            <span className="text-[22px] font-medium leading-7 text-ob-text">{rental ? formatMoney(cost) : '—'}</span>
          </Metric>
          <Metric label="Rate">
            <span className="text-[13px] text-ob-text-2">{status.pricePerHour ? formatPerHour(status.pricePerHour) : '—'}</span>
          </Metric>
          <Metric label="Instance">
            <span className="text-[13px] text-ob-text-2">{status.instanceId ? `#${status.instanceId}` : '—'}</span>
          </Metric>
          {status.endpoint ? (
            <div className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1">
              <dt className="ob-section-label text-[10px]">Endpoint</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <code className="ob-selectable min-w-0 truncate font-mono text-[11.5px] text-ob-text-2" title={status.endpoint}>
                  {status.endpoint}
                </code>
                <Tooltip content="Copy endpoint">
                  <button
                    type="button"
                    aria-label="Copy endpoint"
                    className="ob-transition flex size-5 shrink-0 items-center justify-center rounded text-ob-text-3 hover:bg-ob-hover hover:text-ob-text"
                    onClick={() => void navigator.clipboard?.writeText(status.endpoint ?? '').then(() => toast({ title: 'Endpoint copied', level: 'success', durationMs: 1500 }))}
                  >
                    <Copy size={12} aria-hidden />
                  </button>
                </Tooltip>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

    </section>
  );
}

function Metric({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <dt className="ob-section-label text-[10px]">{label}</dt>
      <dd className="ob-tabular font-mono">{children}</dd>
    </div>
  );
}
