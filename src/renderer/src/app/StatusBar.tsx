// Status bar (25 px) — reference .sbar: Chivo Mono 9 px uppercase, --t3 labels, --t1 values, status dots, segments
// split by --rule2. Left: connection · model + provider · context · permission mode · running sessions.
// Right: GPU phase + $/h + session cost · month spend / budget. Owner: ui-foundation.
import type { ReactNode } from 'react';
import type { PermissionMode } from '@shared/types';
import { StatusDot, type Tone } from '@renderer/components/ui/feedback';
import { cn } from '@renderer/lib/cn';
import { formatMoney, formatPerHour, providerLabel, shortModelName } from '@renderer/lib/format';
import { navigate, openPalette, openSettings } from '@renderer/state/actions';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';
import { useModels } from '@renderer/state/models';
import { useActiveSession, useModelInfo, useRunningCount } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { useUi } from '@renderer/state/ui';
import { useUpdates } from '@renderer/state/updates';
import { GPU_PHASE_LABEL, useLiveGpuCost } from './GpuWidget';

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
};

function Seg({ children, className, title, onClick, testId }: { children: ReactNode; className?: string; title?: string; onClick?: () => void; testId?: string }) {
  const cls = cn(
    'flex h-full shrink-0 items-center gap-[7px] whitespace-nowrap px-[13px] uppercase tracking-[0.1em] [&+&]:shadow-[inset_1px_0_0_var(--rule2)] first:pl-0',
    onClick && 'ob-transition hover:text-t2',
    className,
  );
  return onClick ? (
    <button type="button" className={cls} title={title} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  ) : (
    <span className={cls} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

/** A value inside a segment: --t1, regular weight. */
function V({ children, className }: { children: ReactNode; className?: string }) {
  return <b className={cn('font-normal text-t1', className)}>{children}</b>;
}

function useConnectionSummary(): { tone: Tone; label: string; value: string } {
  const mode = useConnection((s) => s.mode);
  const status = useConnection((s) => s.state.status);
  if (mode === 'none') return { tone: 'danger', label: 'Core', value: 'Offline' };
  const who = mode === 'demo' ? 'Demo' : 'Core';
  if (status === 'open') return { tone: 'success', label: who, value: 'Online' };
  if (status === 'reconnecting' || status === 'connecting' || status === 'idle') return { tone: 'warning', label: who, value: 'Reconnecting' };
  return { tone: 'danger', label: who, value: 'Offline' };
}

/** The running version ("V1.0.0"); a status dot when an update is offered (accent) or checking failed (warning). */
function VersionSeg() {
  const snap = useUpdates((s) => s.snapshot);
  const systemVersion = useSettings((s) => s.system?.version ?? null);
  const version = snap?.currentVersion ?? systemVersion;
  if (!version) return null;
  const st = snap?.state;
  const failed = st?.status === 'error';
  const offered = st?.status === 'available';
  const title = failed ? `Update problem: ${st.message}` : offered ? `Version ${st.version} is available` : 'About & updates';
  return (
    <Seg onClick={() => openSettings('about')} title={title} testId="status-version">
      {failed ? <StatusDot tone="warning" size={5} /> : offered ? <StatusDot tone="accent" size={5} /> : null}
      <V className="normal-case tracking-[0.04em]">
        <span className="uppercase">v</span>
        {version}
      </V>
    </Seg>
  );
}

export function StatusBar() {
  const conn = useConnectionSummary();
  const route = useUi((s) => s.route);
  const active = useActiveSession();
  const session = route === 'session' ? active : undefined;
  const defaultModel = useSettings((s) => s.settings?.defaultModel ?? null);
  const modelRef = session ? session.model : defaultModel;
  const info = useModelInfo(modelRef);
  const providers = useModels((s) => s.providers);
  const running = useRunningCount();
  const gpu = useGpu((s) => s.status);
  const cost = useLiveGpuCost(gpu);

  const providerName = modelRef ? (providers.find((p) => p.id === modelRef.provider)?.label ?? providerLabel(modelRef.provider)) : null;
  const modelName = info?.label ?? (modelRef ? shortModelName(modelRef.model) : null);
  const ctxPct =
    session && info?.contextLength && session.usage.lastPromptTokens ? Math.min(100, Math.round((session.usage.lastPromptTokens / info.contextLength) * 100)) : null;

  const phase = gpu?.phase ?? 'off';
  const gpuOn = phase !== 'off' && phase !== 'error';
  const budget = gpu?.monthlyBudget ?? 0;
  const month = (gpu?.monthCost ?? 0) + (gpuOn ? Math.max(0, cost - (gpu?.sessionCost ?? 0)) : 0);
  const overBudget = budget > 0 && month / budget > 0.9;

  return (
    <footer
      data-testid="status-bar"
      aria-label="Status"
      className="flex h-[var(--ob-statusbar-h)] shrink-0 items-center overflow-hidden border-t border-rule px-[13px] font-mono text-[9px] uppercase leading-none tracking-[0.1em] text-t3"
    >
      <Seg testId="status-connection">
        <StatusDot tone={conn.tone} size={5} pulse={conn.tone === 'warning'} />
        {conn.label} <V>{conn.value}</V>
      </Seg>
      {modelName ? (
        <Seg title={modelRef ? `${modelRef.provider} · ${modelRef.model}` : undefined} onClick={() => openPalette('models')} className="min-w-0 shrink">
          Model <V className="truncate">{modelName}</V>
          {providerName ? <span className="truncate">· {providerName}</span> : null}
        </Seg>
      ) : null}
      {session ? (
        <Seg title="Context used by the last request">
          Ctx <V className={cn(ctxPct != null && ctxPct >= 85 && 'text-warn')}>{ctxPct != null ? `${ctxPct}%` : '—'}</V>
        </Seg>
      ) : null}
      {session ? (
        <Seg title="Permission mode">
          Mode <V className={cn(session.permissionMode === 'bypassPermissions' && 'text-err')}>{MODE_LABEL[session.permissionMode] ?? session.permissionMode}</V>
        </Seg>
      ) : null}
      <Seg>
        {running ? <StatusDot tone="violet" size={5} pulse /> : null}
        <V>{running}</V> Running
      </Seg>

      <span aria-hidden className="ml-auto" />

      <Seg onClick={() => navigate('gpu')} title="Open the GPU view" testId="status-gpu">
        <StatusDot tone={phase === 'error' ? 'danger' : gpuOn ? (phase === 'ready' ? 'success' : 'violet') : 'neutral'} size={5} pulse={gpuOn && phase !== 'ready'} />
        GPU <V>{GPU_PHASE_LABEL[phase]}</V>
        {gpuOn ? (
          <>
            <span className="text-t2">· {formatPerHour(gpu?.pricePerHour)}</span>
            <span className="flex items-center gap-[7px]">
              · <span aria-hidden className="size-[5px] rounded-full bg-rec" />
              <V>{formatMoney(cost)}</V>
            </span>
          </>
        ) : null}
      </Seg>
      <Seg title="Spent this month / monthly budget">
        Month <V className={cn(overBudget && 'text-warn')}>{gpu ? formatMoney(month) : '—'}</V>
        {gpu && budget > 0 ? <span>/ {formatMoney(budget)}</span> : null}
      </Seg>
      <VersionSeg />
    </footer>
  );
}
