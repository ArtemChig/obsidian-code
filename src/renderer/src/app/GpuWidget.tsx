// Sidebar GPU widget + compact rail dot: status, model, $/h, live timer, Clock in/out. Owner: ui-foundation.
// M13: no card — a hairline-separated block with a status dot, mono numbers and a --rec dot while money is being spent.
import { Cpu, Power } from 'lucide-react';
import { useEffect } from 'react';
import type { GpuPhase, GpuStatus } from '@shared/types';
import { Button, IconButton } from '@renderer/components/ui/button';
import { AutoClockOutLine, AutoClockOutMenu } from '@renderer/features/gpu/AutoClockOut';
import { ProgressBar, StatusDot, type Tone } from '@renderer/components/ui/feedback';
import { LiveDuration, useNow } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { formatMoney, formatPerHour } from '@renderer/lib/format';
import { clockIn, clockOut, defaultGpuProfileId, loadGpuCatalog, navigate, requestClockOut } from '@renderer/state/actions';
import { useConnection } from '@renderer/state/connection';
import { GPU_BUSY_PHASES, useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { toast } from '@renderer/state/toasts';

export const GPU_PHASE_LABEL: Record<GpuPhase, string> = {
  off: 'Off',
  searching: 'Finding a GPU',
  renting: 'Renting',
  connecting: 'Connecting',
  downloading: 'Downloading model',
  loading: 'Loading model',
  ready: 'Ready',
  switching: 'Switching model',
  stopping: 'Clocking out',
  error: 'Error',
};

export function gpuTone(phase: GpuPhase | undefined): Tone {
  if (!phase || phase === 'off') return 'neutral';
  if (phase === 'ready') return 'success';
  if (phase === 'error') return 'danger';
  if (phase === 'stopping') return 'warning';
  return 'violet'; // in flight = live
}

/** Live session cost: price × elapsed (per-second billing), falling back to the reported value. */
export function useLiveGpuCost(status: GpuStatus | null): number {
  const now = useNow(status?.clockedInAt && status.phase !== 'off' ? 5000 : false);
  if (!status?.clockedInAt || !status.pricePerHour || status.phase === 'off') return status?.sessionCost ?? 0;
  return Math.max(status.sessionCost, ((now - status.clockedInAt) / 3_600_000) * status.pricePerHour);
}

export function useModelLabel(modelId: string | undefined): string | null {
  const catalog = useGpu((s) => s.catalog);
  const connected = useConnection((s) => s.state.status === 'open');
  useEffect(() => {
    if (modelId && !catalog && connected) void loadGpuCatalog(false, true);
  }, [modelId, catalog, connected]);
  if (!modelId) return null;
  const hit = catalog?.find((c) => c.id === modelId);
  if (hit) return hit.label.replace(/\s+[·-]\s+.*$/, '');
  return modelId;
}

/**
 * Shared click behaviour: clock in with the default profile (or open the GPU view if setup is missing), or clock out
 * (asking first when sessions are using the GPU or a rented clock-in would be cancelled — see clockOutPrompt).
 */
export async function gpuPrimaryAction(status: GpuStatus | null, hasApiKey: boolean | null): Promise<void> {
  const phase = status?.phase ?? 'off';
  // Error with a tracked instance (e.g. from the last run): offer the clock-out, never a second rental.
  if (phase === 'error' && status?.instanceId != null) {
    await clockOut();
    return;
  }
  if (phase === 'off' || phase === 'error') {
    const profiles = useSettings.getState().settings?.vast.profiles ?? [];
    if (hasApiKey === false || profiles.length === 0) {
      navigate('gpu');
      if (hasApiKey === false) toast({ title: 'Vast.ai API key missing', body: 'Add your key in Settings → Vast.ai to clock in.', level: 'warning' });
      return;
    }
    await clockIn(defaultGpuProfileId());
    return;
  }
  if (phase !== 'stopping') await requestClockOut();
}

export function GpuWidget() {
  const status = useGpu((s) => s.status);
  const hasApiKey = useGpu((s) => s.hasApiKey);
  const busy = useGpu((s) => s.busy);
  const gpuLoadFailed = useConnection((c) => !!c.syncErrors.gpu);
  const profiles = useSettings((s) => s.settings?.vast.profiles);
  const phase = status?.phase ?? 'off';
  const cost = useLiveGpuCost(status);
  const modelLabel = useModelLabel(status?.modelId);
  const on = phase !== 'off' && phase !== 'error';
  const trackedInError = phase === 'error' && status?.instanceId != null;
  const inProgress = GPU_BUSY_PHASES.has(phase);
  const profile = profiles?.find((p) => p.id === (status?.profileId ?? defaultGpuProfileId()));
  const budget = status?.monthlyBudget ?? 0;
  const month = (status?.monthCost ?? 0) + (on ? Math.max(0, cost - (status?.sessionCost ?? 0)) : 0);

  return (
    <AutoClockOutMenu>
      <div data-testid="gpu-widget" className="border-t border-rule2 px-4 pb-3.5 pt-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => navigate('gpu')}
            className="ob-transition -mx-1 flex min-w-0 items-center gap-2 rounded-[2px] px-1 py-0.5 text-left hover:bg-hov"
            aria-label="Open GPU view"
          >
            <StatusDot tone={gpuTone(phase)} pulse={inProgress} glow={phase === 'ready'} />
            <span className="min-w-0 truncate text-[12.5px] font-medium tracking-[-0.016em] text-t1">
              {phase === 'off' ? 'GPU off' : phase === 'ready' ? (status?.gpuName ?? 'GPU ready') : GPU_PHASE_LABEL[phase]}
            </span>
          </button>
          {on && status?.clockedInAt ? (
            <LiveDuration since={status.clockedInAt} className="shrink-0 font-mono text-[11px] tracking-[-0.02em] text-t1" />
          ) : (
            <span className="ob-cap truncate">{profile?.label ?? 'GPU'}</span>
          )}
        </div>

        <div className="mt-1 truncate pl-[14px] font-mono text-[9.5px] leading-[14px] tracking-[0.01em] text-t3" title={status?.message}>
          {phase === 'off' && status?.orphanInstanceIds?.length
            ? `${status.orphanInstanceIds.length} instance${status.orphanInstanceIds.length === 1 ? '' : 's'} may still be billing — open the GPU view`
            : phase === 'off' && status?.message?.startsWith('Clocked out automatically')
            ? status.message
            : phase === 'off'
            ? `${profile ? profile.description.split('—')[0].trim() : 'Rent a GPU by the hour'}`
            : phase === 'error'
              ? (status?.lastError ?? status?.message ?? 'Clock-in failed')
              : (modelLabel ?? status?.message ?? '')}
        </div>

        {on ? <AutoClockOutLine status={status} className="mt-1 pl-[14px]" /> : null}

        {inProgress && phase !== 'stopping' ? (
          <ProgressBar
            className="mt-2.5"
            size="xs"
            tone="violet"
            value={phase === 'downloading' || phase === 'loading' ? (status?.progress ?? null) : null}
            label={GPU_PHASE_LABEL[phase]}
          />
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-4 tracking-[-0.01em] text-t2">
            {on ? (
              <>
                <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-rec" title="Billing" />
                <span className="ob-tabular truncate">
                  <span className="text-t1">{formatPerHour(status?.pricePerHour)}</span> <span className="text-t3">·</span>{' '}
                  <span className="text-t1">{formatMoney(cost)}</span>
                </span>
              </>
            ) : (
              <span className="ob-tabular truncate" title="Spent this month / monthly budget">
                {status ? (
                  <>
                    <span className="text-t1">{formatMoney(month)}</span> <span className="text-t3">/ {formatMoney(budget)}</span>
                  </>
                ) : (
                  <span className="text-t3">{gpuLoadFailed ? 'Status unavailable' : 'Not connected'}</span>
                )}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant={on || trackedInError ? 'danger' : 'primary'}
            loading={busy || phase === 'stopping'}
            icon={Power}
            data-testid="gpu-clock-button"
            onClick={() => void gpuPrimaryAction(status, hasApiKey)}
          >
            {on ? (inProgress ? 'Cancel' : 'Clock out') : trackedInError ? 'Clock out' : 'Clock in'}
          </Button>
        </div>
      </div>
    </AutoClockOutMenu>
  );
}

/** Collapsed-rail variant: a status-dotted icon button. */
export function GpuRailButton() {
  const status = useGpu((s) => s.status);
  const phase = status?.phase ?? 'off';
  return (
    <AutoClockOutMenu
      tooltip={{ content: `GPU · ${GPU_PHASE_LABEL[phase]}${status?.pricePerHour && phase !== 'off' ? ` · ${formatPerHour(status.pricePerHour)}` : ''}`, side: 'right' }}
    >
      <span className="relative">
        <IconButton label="GPU" noTooltip icon={Cpu} size="lg" onClick={() => navigate('gpu')} />
        <StatusDot tone={gpuTone(phase)} pulse={GPU_BUSY_PHASES.has(phase)} size={6} className="pointer-events-none absolute right-1 top-1 ring-2 ring-s0" />
      </span>
    </AutoClockOutMenu>
  );
}
