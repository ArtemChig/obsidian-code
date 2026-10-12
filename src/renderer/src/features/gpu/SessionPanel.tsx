// The top of the GPU view, modelled on the M13 recorder screen: a hero (title, mono meta, REC-style billing label, the big
// session clock and Clock in / Clock out), a strip of mono figures, and the clock-in checklist with a segmented meter. Owner: ui-views.
import { Copy, Power, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CatalogModel, GpuProfile, GpuStatus } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ProgressBar, StatusDot } from '@renderer/components/ui/feedback';
import { useNow } from '@renderer/components/ui/time';
import { GPU_PHASE_LABEL, gpuTone, useLiveGpuCost } from '@renderer/app/GpuWidget';
import { cn } from '@renderer/lib/cn';
import { formatMoney, formatPerHour } from '@renderer/lib/format';
import { toast } from '@renderer/state/toasts';
import { GPU_BUSY_PHASES } from '@renderer/state/gpu';
import { MetaLine, Notice } from '../settings/view-kit';
import { formatWarmup, gpuSpec, profileVramGb, splitModelLabel, warmupCost, warmupSeconds, type PriceStats } from './model';

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

/** The main button: 34 px (reference .btn.lg). */
const MAIN_BTN = 'h-[34px] min-w-[128px] px-4 text-[12px]';

export function SessionPanel(p: SessionPanelProps) {
  const { status } = p;
  const phase = status.phase;
  return (
    <section data-testid="gpu-panel" data-phase={phase} aria-label={phase === 'off' ? 'Clock in' : 'GPU session'}>
      {phase === 'off' ? <OffHero {...p} /> : <ActiveHero {...p} />}
      {phase === 'off' ? <OffStrip {...p} /> : <ActiveStrip {...p} />}
      {phase !== 'off' ? <Checklist status={status} /> : null}
    </section>
  );
}

// ───────────────────────────── Shared bits ─────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "00:47:12" — the session clock is always hh:mm:ss, like the reference. */
export function padClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function SessionClock({ since }: { since?: number }) {
  const now = useNow(since ? 1000 : false);
  return (
    <span
      className={cn('ob-tabular whitespace-nowrap font-mono text-[27px] leading-none tracking-[-0.055em]', since ? 'text-t1' : 'text-t3')}
      data-testid="gpu-timer"
      aria-label="Session time"
    >
      {since ? padClock(Math.max(now, since) - since) : '00:00:00'}
    </span>
  );
}

/** Hero scaffold (reference .s1-hero): title + meta left; billing label + clock + buttons right. */
function Hero({ meta, notes, label, since, actions }: { meta: ReactNode; notes?: ReactNode; label: ReactNode; since?: number; actions: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-[26px] gap-y-4 border-b border-rule2 px-[26px] pb-[17px] pt-[19px]">
      <div className="flex min-w-[260px] flex-1 flex-col">
        <h1 className="text-[23px] font-semibold leading-[1.05] tracking-[-0.042em] text-t1">GPU</h1>
        <div className="mt-[9px] flex min-w-0 flex-wrap items-center gap-[9px]">{meta}</div>
        {notes ? <div className="mt-2.5 flex flex-col gap-1.5">{notes}</div> : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-5 pt-[2px]">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">{label}</div>
          <SessionClock since={since} />
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

/** REC-style label: dot + mono 9 px .2em caps (reference .recdot + .reclab). */
function BillingLabel({ tone, children }: { tone: 'rec' | 'off' | 'err'; children: ReactNode }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'size-[9px] shrink-0 rounded-full',
          tone === 'rec' && 'bg-rec shadow-[0_0_0_3px_var(--rec-wash)]',
          tone === 'err' && 'bg-err',
          tone === 'off' && 'shadow-[inset_0_0_0_1px_var(--line)]',
        )}
      />
      <span className={cn('whitespace-nowrap font-mono text-[9px] font-semibold uppercase tracking-[0.2em]', tone === 'rec' ? 'text-rec' : tone === 'err' ? 'text-err' : 'text-t3')}>
        {children}
      </span>
    </>
  );
}

/** One figure of the strip (reference .recseg): mono label, value, meta, optional 2 px bar. */
function Seg({ label, children, meta, on, bar, testId, className }: { label: ReactNode; children: ReactNode; meta?: ReactNode; on?: boolean; bar?: boolean; testId?: string; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 px-5 first:pl-0 [&+&]:shadow-[inset_1px_0_0_var(--rule2)]', className)} data-testid={testId}>
      <span className={cn('flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.18em]', on ? 'text-rec' : 'text-t3')}>{label}</span>
      <span className={cn('ob-tabular flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-[12px] tracking-[-0.028em]', on ? 'text-t1' : 'text-t2')}>{children}</span>
      {meta ? <span className="truncate font-mono text-[9px] tracking-[0.02em] text-t3">{meta}</span> : null}
      {bar ? <span aria-hidden className={cn('mt-[2px] block h-[2px]', on ? 'bg-rec' : 'bg-s4')} /> : null}
    </div>
  );
}

function Strip({ children, total }: { children: ReactNode; total?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-stretch gap-y-3 border-b border-rule px-[26px] pb-[13px] pt-3">
      {children}
      {total ? <div className="ml-auto flex min-w-0 flex-col items-end justify-center gap-1.5 pl-5 shadow-[inset_1px_0_0_var(--rule2)]">{total}</div> : null}
    </div>
  );
}

function Total({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <>
      <span className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-t3">{label}</span>
      <b className="max-w-[320px] truncate font-mono text-[14px] font-normal tracking-[-0.04em] text-t1" title={title}>
        {children}
      </b>
    </>
  );
}

// ───────────────────────────── Off: clock-in summary ─────────────────────────────

function OffHero({ status, profile, pickedModel, hasApiKey, busy, parkedElsewhere, onClockIn }: SessionPanelProps) {
  const budgetLeft = status.monthlyBudget - status.monthCost;
  const exhausted = status.monthlyBudget > 0 && budgetLeft <= 0;
  const disabledReason = !profile ? 'No GPU profile configured' : hasApiKey === false ? 'Add your Vast.ai API key first' : exhausted ? 'Monthly budget reached' : null;
  const model = pickedModel ? splitModelLabel(pickedModel.label) : null;
  const meta = profile ? (
    <span className="flex min-w-0 flex-wrap items-center gap-[9px]" data-testid="gpu-summary">
      <MetaLine items={[<b key="p">{profile.label}</b>, gpuSpec(profile), `${profileVramGb(profile)} GB`, model ? <b key="m">{model.name}</b> : null]} />
      {pickedModel?.variant === 'uncensored' ? <Badge tone="neutral">uncensored</Badge> : null}
    </span>
  ) : (
    <span className="text-[11.5px] text-t3">Add a GPU profile in Settings → Vast.ai to get started.</span>
  );
  const notes = (
    <>
      {parkedElsewhere ? (
        <span className="flex items-start gap-1.5 text-[11px] text-warn">
          <TriangleAlert size={12} aria-hidden className="mt-[2px] shrink-0" />
          Another profile is parked. Clocking in with this profile destroys the parked instance.
        </span>
      ) : null}
      {disabledReason ? (
        <span className="flex items-start gap-1.5 text-[11px] text-warn" data-testid="gpu-clock-disabled-reason">
          <TriangleAlert size={12} aria-hidden className="mt-[2px] shrink-0" />
          <span>
            {disabledReason}
            {exhausted ? ` (${formatMoney(status.monthCost)} of ${formatMoney(status.monthlyBudget)} spent). Raise the budget in Settings → Vast.ai.` : '.'}
          </span>
        </span>
      ) : null}
      {status.message && status.message !== 'Off' ? <span className="text-[11px] text-t3">{status.message}</span> : null}
    </>
  );
  return (
    <Hero
      meta={meta}
      notes={parkedElsewhere || disabledReason || (status.message && status.message !== 'Off') ? notes : undefined}
      label={<BillingLabel tone="off">Off · not billing</BillingLabel>}
      actions={
        <Button size="lg" variant="primary" icon={Power} loading={busy} disabled={!!disabledReason} data-testid="gpu-main-button" className={MAIN_BTN} onClick={onClockIn}>
          Clock in
        </Button>
      }
    />
  );
}

function OffStrip({ pickedModel, stats, idleMinutes, maxSessionHours }: SessionPanelProps) {
  const secs = warmupSeconds(pickedModel);
  const wCost = warmupCost(secs, stats?.median);
  const model = pickedModel ? splitModelLabel(pickedModel.label) : null;
  return (
    <Strip total={model ? <Total label="Model" title={pickedModel?.label}>{model.name}</Total> : undefined}>
      <Seg label="Cheapest" meta={stats ? `${stats.count} offer${stats.count === 1 ? '' : 's'} now` : 'prices loading…'}>
        {stats ? formatPerHour(stats.min) : '—'}
      </Seg>
      <Seg label="Typical" meta="median offer">
        {stats ? formatPerHour(stats.median) : '—'}
      </Seg>
      <Seg label="Warm-up" meta={wCost != null ? `≈ ${formatMoney(wCost)} billed` : 'download + load'}>
        {formatWarmup(secs)}
      </Seg>
      <Seg label="Auto clock-out" meta={`max ${maxSessionHours} h per clock-in`}>
        {idleMinutes} min idle
      </Seg>
    </Strip>
  );
}

// ───────────────────────────── Active: billing, figures, checklist ─────────────────────────────

function ActiveHero({ status, profile, hasApiKey, busy, onClockIn, onClockOut }: SessionPanelProps) {
  const phase = status.phase;
  const inProgress = GPU_BUSY_PHASES.has(phase) && phase !== 'stopping';
  const rental = status.clockedInAt != null && phase !== 'error';
  const gpu = [status.numGpus && status.numGpus > 1 ? `${status.numGpus}×` : null, status.gpuName].filter(Boolean).join(' ');
  const meta = (
    <>
      <MetaLine items={[profile ? <b key="p">{profile.label}</b> : null, gpu ? <b key="g">{gpu}</b> : null, status.location, status.instanceId ? `#${status.instanceId}` : null]} />
      {phase === 'ready' ? <Badge tone="success">serving</Badge> : phase === 'error' ? <Badge tone="danger">failed</Badge> : <Badge tone="violet">{GPU_PHASE_LABEL[phase]}</Badge>}
    </>
  );
  const hint = phase === 'ready' ? 'Clock out destroys the instance; billing stops.' : inProgress ? 'Cancelling destroys the instance if one was rented.' : null;
  return (
    <Hero
      meta={meta}
      notes={hint ? <span className="text-[11px] text-t3">{hint}</span> : undefined}
      since={rental ? status.clockedInAt : undefined}
      label={
        rental ? (
          <BillingLabel tone="rec">Billing · {status.pricePerHour ? formatPerHour(status.pricePerHour) : 'per second'}</BillingLabel>
        ) : phase === 'error' ? (
          <BillingLabel tone="err">Error</BillingLabel>
        ) : (
          <BillingLabel tone="off">Not billing</BillingLabel>
        )
      }
      actions={
        phase === 'error' && status.instanceId != null ? (
          // An instance is still tracked (e.g. from the last run): stopping it comes first, never a second rental.
          <Button size="lg" variant="danger" icon={Power} loading={busy} data-testid="gpu-main-button" className={MAIN_BTN} onClick={() => void onClockOut()}>
            Clock out
          </Button>
        ) : phase === 'error' ? (
          <Button size="lg" variant="primary" icon={Power} loading={busy} disabled={hasApiKey === false} data-testid="gpu-main-button" className={MAIN_BTN} onClick={onClockIn}>
            Try again
          </Button>
        ) : (
          // The confirmation (running sessions / a rented clock-in) is app-wide: see requestClockOut + GpuClockOutConfirm.
          <Button size="lg" variant="danger" icon={Power} loading={busy || phase === 'stopping'} data-testid="gpu-main-button" className={MAIN_BTN} onClick={() => void onClockOut()}>
            {phase === 'stopping' ? 'Clocking out…' : inProgress ? 'Cancel clock-in' : 'Clock out'}
          </Button>
        )
      }
    />
  );
}

function ActiveStrip({ status, runningModelLabel }: SessionPanelProps) {
  const cost = useLiveGpuCost(status);
  const rental = status.clockedInAt != null && status.phase !== 'error';
  const label = runningModelLabel ? splitModelLabel(runningModelLabel).name : null;
  return (
    <Strip total={label ? <Total label="Model" title={runningModelLabel ?? undefined}>{label}</Total> : undefined}>
      <Seg label={rental ? 'Session cost · live' : 'Session cost'} on={rental} bar testId="gpu-cost" meta={status.pricePerHour ? `at ${formatPerHour(status.pricePerHour)}` : 'billed per second'}>
        {rental ? formatMoney(cost) : '—'}
      </Seg>
      <Seg label="Rate" meta={status.location || 'Vast.ai'}>
        {status.pricePerHour ? formatPerHour(status.pricePerHour) : '—'}
      </Seg>
      <Seg label="Instance" meta={status.gpuName ?? 'not rented yet'}>
        {status.instanceId ? `#${status.instanceId}` : '—'}
      </Seg>
      <Seg label="Endpoint" meta={status.endpoint ? 'OpenAI-compatible' : 'once the model is loaded'}>
        {status.endpoint ? (
          <>
            <code className="ob-selectable min-w-0 max-w-[220px] truncate" title={status.endpoint}>
              {status.endpoint}
            </code>
            <IconButton
              label="Copy endpoint"
              icon={Copy}
              size="xs"
              onClick={() => void navigator.clipboard?.writeText(status.endpoint ?? '').then(() => toast({ title: 'Endpoint copied', level: 'success', durationMs: 1500 }))}
            />
          </>
        ) : (
          '—'
        )}
      </Seg>
    </Strip>
  );
}

const STATE_TEXT: Record<GpuStatus['steps'][number]['state'], string> = { done: 'done', active: 'now', todo: '—', error: 'failed' };

function Checklist({ status }: { status: GpuStatus }) {
  const phase = status.phase;
  const steps = status.steps ?? [];
  const done = steps.filter((s) => s.state === 'done').length;
  const activeIdx = steps.findIndex((s) => s.state === 'active');
  const frac = steps.length ? (done + (activeIdx >= 0 && status.progress != null ? status.progress : 0)) / steps.length : null;
  const determinate = phase === 'downloading' || phase === 'loading';
  const barValue = phase === 'ready' ? 1 : determinate && status.progress != null ? frac : steps.length ? frac : null;
  return (
    <div className="flex flex-col gap-3 border-b border-rule px-[26px] pb-4 pt-[14px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1">
        <StatusDot tone={gpuTone(phase)} size={6} pulse={GPU_BUSY_PHASES.has(phase)} />
        <span className="text-[12.5px] font-medium tracking-[-0.016em] text-t1" data-testid="gpu-phase">
          {GPU_PHASE_LABEL[phase]}
        </span>
        <span className="min-w-0 text-[11.5px] tracking-[-0.01em] text-t2" data-testid="gpu-message" aria-live="polite">
          {status.message}
          {determinate && status.progress != null ? <span className="ob-tabular ml-1.5 font-mono text-t1">{Math.round(status.progress * 100)}%</span> : null}
        </span>
        {steps.length ? (
          <span className="ob-cap ml-auto">
            <span className="text-t1">{done}</span> / {steps.length} steps
          </span>
        ) : null}
      </div>

      {steps.length > 0 ? (
        <>
          <ProgressBar
            variant="segments"
            segments={36}
            size="sm"
            value={barValue}
            tone={phase === 'error' ? 'danger' : phase === 'ready' ? 'success' : phase === 'stopping' ? 'warning' : 'violet'}
            label="Clock-in progress"
          />
          <ol className="grid grid-cols-1 gap-x-6 @min-[640px]:grid-cols-2 @min-[900px]:grid-cols-3" data-testid="gpu-steps">
            {steps.map((s, i) => (
              <li
                key={s.id}
                data-state={s.state}
                className={cn(
                  'flex h-7 min-w-0 items-center gap-[9px] border-b border-rule2 font-mono text-[10.5px] tracking-[-0.01em]',
                  s.state === 'todo' ? 'text-t3' : s.state === 'error' ? 'text-err' : s.state === 'active' ? 'text-t1' : 'text-t2',
                )}
              >
                <span className="w-4 shrink-0 text-[9.5px] text-t3">{pad2(i + 1)}</span>
                <StatusDot size={6} tone={s.state === 'done' ? 'success' : s.state === 'active' ? 'violet' : s.state === 'error' ? 'danger' : 'neutral'} pulse={s.state === 'active'} />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className={cn('shrink-0 text-[8.5px] uppercase tracking-[0.15em]', s.state === 'active' ? 'text-live' : s.state === 'error' ? 'text-err' : 'text-t3')}>{STATE_TEXT[s.state]}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {phase === 'error' && (status.lastError || status.message) ? (
        <Notice
          tone="err"
          alert
          icon={TriangleAlert}
          testId="gpu-error"
          className="ob-selectable"
          title="Clock-in failed"
          action={
            <IconButton
              label="Copy error"
              icon={Copy}
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(status.lastError ?? status.message).then(() => toast({ title: 'Copied', level: 'success', durationMs: 1500 }));
              }}
            />
          }
        >
          <span className="break-words">{status.lastError ?? status.message}</span>
        </Notice>
      ) : null}
    </div>
  );
}
