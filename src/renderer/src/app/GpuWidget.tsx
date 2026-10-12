// Sidebar GPU widget + compact rail dot: status, model, $/h, live timer, Clock in/out. Owner: ui-foundation.
import { Cpu, Power } from 'lucide-react';
import { useEffect } from 'react';
import type { GpuPhase, GpuStatus } from '@shared/types';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ProgressBar, StatusDot, type Tone } from '@renderer/components/ui/feedback';
import { LiveDuration, useNow } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatMoney, formatPerHour } from '@renderer/lib/format';
import { clockIn, clockOut, defaultGpuProfileId, loadGpuCatalog, navigate } from '@renderer/state/actions';
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
  return 'accent';
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

/** Shared click behaviour: clock in with the default profile (or open the GPU view if setup is missing), or clock out. */
export async function gpuPrimaryAction(status: GpuStatus | null, hasApiKey: boolean | null): Promise<void> {
  const phase = status?.phase ?? 'off';
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
  if (phase !== 'stopping') await clockOut();
}

export function GpuWidget() {
  const status = useGpu((s) => s.status);
  const hasApiKey = useGpu((s) => s.hasApiKey);
  const busy = useGpu((s) => s.busy);
  const profiles = useSettings((s) => s.settings?.vast.profiles);
  const phase = status?.phase ?? 'off';
  const cost = useLiveGpuCost(status);
  const modelLabel = useModelLabel(status?.modelId);
  const on = phase !== 'off' && phase !== 'error';
  const inProgress = GPU_BUSY_PHASES.has(phase);
  const profile = profiles?.find((p) => p.id === (status?.profileId ?? defaultGpuProfileId()));
  const budget = status?.monthlyBudget ?? 0;
  const month = (status?.monthCost ?? 0) + (on ? cost : 0);

  return (
    <div
      data-testid="gpu-widget"
      className={cn(
        'mx-2 mb-2 rounded-[10px] border p-2.5 ob-transition',
        phase === 'ready'
          ? 'border-[rgba(95,211,154,0.22)] bg-[linear-gradient(180deg,rgba(95,211,154,0.07),rgba(95,211,154,0.02))]'
          : phase === 'error'
            ? 'border-[rgba(240,113,120,0.3)] bg-ob-danger-soft'
            : 'border-ob-border bg-ob-bg/60',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('gpu')}
          className="ob-transition -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-[6px] p-1 text-left hover:bg-ob-hover"
          aria-label="Open GPU view"
        >
          <StatusDot tone={gpuTone(phase)} pulse={inProgress} glow={phase === 'ready'} />
          <span className="min-w-0 truncate text-small font-medium text-ob-text">
            {phase === 'off' ? 'GPU off' : phase === 'ready' ? (status?.gpuName ?? 'GPU ready') : GPU_PHASE_LABEL[phase]}
          </span>
        </button>
        {on && status?.clockedInAt ? (
          <LiveDuration since={status.clockedInAt} className="font-mono text-[11px] text-ob-text-2" />
        ) : (
          <span className="font-mono text-[11px] text-ob-text-3">{profile?.label ?? ''}</span>
        )}
      </div>

      <div className="mt-1.5 truncate pl-[15px] text-small text-ob-text-3" title={status?.message}>
        {phase === 'off'
          ? `${profile ? profile.description.split('—')[0].trim() : 'Rent a GPU by the hour'}`
          : phase === 'error'
            ? (status?.lastError ?? status?.message ?? 'Clock-in failed')
            : (modelLabel ?? status?.message ?? '')}
      </div>

      {inProgress && phase !== 'stopping' ? (
        <ProgressBar
          className="mt-2"
          size="xs"
          value={phase === 'downloading' || phase === 'loading' ? (status?.progress ?? null) : null}
          label={GPU_PHASE_LABEL[phase]}
        />
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="min-w-0 font-mono text-[11px] leading-4 text-ob-text-2">
          {on ? (
            <span className="ob-tabular">
              {formatPerHour(status?.pricePerHour)} <span className="text-ob-text-3">·</span> {formatMoney(cost)}
            </span>
          ) : (
            <span className="ob-tabular" title="Spent this month / monthly budget">
              {status ? (
                <>
                  {formatMoney(month)} <span className="text-ob-text-3">/ {formatMoney(budget)}</span>
                </>
              ) : (
                <span className="text-ob-text-3">Not connected</span>
              )}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant={on ? 'danger' : 'primary'}
          loading={busy || phase === 'stopping'}
          icon={Power}
          className="h-[26px] px-2"
          data-testid="gpu-clock-button"
          onClick={() => void gpuPrimaryAction(status, hasApiKey)}
        >
          {on ? (inProgress ? 'Cancel' : 'Clock out') : 'Clock in'}
        </Button>
      </div>
    </div>
  );
}

/** Collapsed-rail variant: a status-dotted icon button. */
export function GpuRailButton() {
  const status = useGpu((s) => s.status);
  const phase = status?.phase ?? 'off';
  return (
    <Tooltip content={`GPU · ${GPU_PHASE_LABEL[phase]}${status?.pricePerHour && phase !== 'off' ? ` · ${formatPerHour(status.pricePerHour)}` : ''}`} side="right">
      <span className="relative">
        <IconButton label="GPU" noTooltip icon={Cpu} size="lg" onClick={() => navigate('gpu')} />
        <StatusDot tone={gpuTone(phase)} pulse={GPU_BUSY_PHASES.has(phase)} size={6} className="pointer-events-none absolute right-1 top-1 ring-2 ring-ob-surface-1" />
      </span>
    </Tooltip>
  );
}
