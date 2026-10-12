// Smaller cards of the GPU view: spend vs budget, parked instance, banners, empty states. Owner: ui-views.
import { ArrowUpRight, CircleAlert, HardDrive, KeyRound, Play, RefreshCw, ShieldCheck, Trash2, TriangleAlert, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { CatalogModel, GpuStatus } from '@shared/types';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { ProgressBar } from '@renderer/components/ui/feedback';
import { RelativeTime } from '@renderer/components/ui/time';
import { openExternal } from '@renderer/lib/bridge';
import { formatMoney, pluralize } from '@renderer/lib/format';
import { openSettings } from '@renderer/state/actions';
import type { AccountCheck } from './hooks';
import { budgetRatio, budgetTone, hoursLeft, splitModelLabel } from './model';

export const VAST_KEYS_URL = 'https://cloud.vast.ai/manage-keys/';

// ───────────────────────────── Spend ─────────────────────────────

export function SpendCard({
  status,
  liveCost,
  account,
  checking,
  hasApiKey,
  typicalPrice,
  onRecheck,
}: {
  status: GpuStatus;
  /** Live session cost, added to the month total while clocked in. */
  liveCost: number;
  account: AccountCheck | null;
  checking: boolean;
  hasApiKey: boolean | null;
  typicalPrice?: number;
  onRecheck: () => void;
}) {
  const active = status.phase !== 'off' && status.phase !== 'error' && status.clockedInAt != null;
  const spent = status.monthCost + (active ? Math.max(0, liveCost - status.sessionCost) : 0);
  const budget = status.monthlyBudget;
  const ratio = budgetRatio(budget, spent);
  const remaining = Math.max(0, budget - spent);
  const hours = typicalPrice ? hoursLeft(budget, spent, typicalPrice) : null;
  const credit = account?.creditBalance ?? status.creditBalance;
  const lowCredit = credit != null && budget > 0 && credit < remaining;
  return (
    <section className="flex flex-col rounded-card border border-ob-border bg-ob-surface-1 p-4" data-testid="gpu-spend" aria-label="Spend">
      <div className="flex items-center gap-2">
        <Wallet size={15} aria-hidden className="text-ob-text-3" />
        <h3 className="text-ui font-medium text-ob-text">This month</h3>
        <span className="flex-1" />
        <span className="ob-tabular font-mono text-[11.5px] text-ob-text-3">{Math.round(ratio * 100)}% used</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="ob-tabular font-mono text-[22px] font-medium leading-7 text-ob-text" data-testid="gpu-month-spent">
          {formatMoney(spent)}
        </span>
        <span className="ob-tabular font-mono text-ui text-ob-text-3">/ {formatMoney(budget)}</span>
      </div>
      <ProgressBar className="mt-2.5" size="md" value={ratio} tone={budgetTone(ratio)} label="Monthly budget used" />
      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 text-small">
        <div className="flex flex-col gap-0.5">
          <dt className="text-ob-text-3">Remaining</dt>
          <dd className="ob-tabular font-mono text-[12.5px] text-ob-text-2">{formatMoney(remaining)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-ob-text-3">Est. hours left</dt>
          <dd className="ob-tabular font-mono text-[12.5px] text-ob-text-2" data-testid="gpu-hours-left">
            {hours == null ? '—' : `≈ ${hours.toLocaleString('en-US')} h`}
            {typicalPrice && hours != null ? <span className="text-ob-text-3"> @ {formatMoney(typicalPrice)}/h</span> : null}
          </dd>
        </div>
        <div className="col-span-2 flex items-center justify-between gap-2 border-t border-ob-border pt-2.5">
          <div className="flex flex-col gap-0.5">
            <dt className="text-ob-text-3">Vast.ai credit</dt>
            <dd className="ob-tabular font-mono text-[12.5px] text-ob-text-2" data-testid="gpu-credit">
              {hasApiKey === false ? 'no API key' : credit != null ? formatMoney(credit) : account && !account.ok ? 'unavailable' : '—'}
            </dd>
          </div>
          {hasApiKey ? <IconButton label="Re-check account" icon={RefreshCw} size="sm" loading={checking} onClick={onRecheck} /> : null}
        </div>
      </dl>
      {lowCredit ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-ctl bg-ob-warning-soft px-2 py-1.5 text-small text-ob-warning">
          <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
          <span>Your Vast.ai credit ({formatMoney(credit)}) is lower than the budget you have left. Top up before a long session.</span>
        </div>
      ) : null}
    </section>
  );
}

// ───────────────────────────── Parked instance ─────────────────────────────

export function ParkedCard({
  parked,
  catalog,
  disabled,
  busy,
  onResume,
  onDestroy,
  parkMaxDays,
}: {
  parked: NonNullable<GpuStatus['parked']>;
  catalog: CatalogModel[] | null;
  disabled: boolean;
  busy: boolean;
  onResume: () => void;
  onDestroy: () => Promise<unknown>;
  parkMaxDays?: number;
}) {
  const [confirm, setConfirm] = useState(false);
  const model = catalog?.find((m) => m.id === parked.modelId);
  const name = model ? splitModelLabel(model.label).name : parked.modelId;
  return (
    <section className="flex flex-col rounded-card border border-ob-border bg-ob-surface-1 p-4" data-testid="gpu-parked" aria-label="Parked instance">
      <div className="flex items-center gap-2">
        <HardDrive size={15} aria-hidden className="text-ob-text-3" />
        <h3 className="text-ui font-medium text-ob-text">Parked instance</h3>
        <span className="flex-1" />
        <span className="ob-tabular font-mono text-[11.5px] text-ob-text-3">#{parked.instanceId}</span>
      </div>
      <p className="mt-2 text-ui text-ob-text-2">
        {parked.gpuName} <span className="text-ob-text-3">·</span> {name}
      </p>
      <p className="mt-1 text-small text-ob-text-3">
        Stopped <RelativeTime ts={parked.parkedAt} className="text-ob-text-2" /> ago. The model stays on its disk, so the next clock-in skips the download. Storage is billed at{' '}
        <span className="ob-tabular font-mono text-ob-text-2">{formatMoney(parked.storageCostPerHour, { precise: true })}/h</span>
        {parkMaxDays ? `; it is destroyed automatically after ${pluralize(parkMaxDays, 'day')}.` : '.'}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-3.5">
        <Button size="sm" variant="primary" icon={Play} disabled={disabled} loading={busy} data-testid="gpu-parked-resume" onClick={onResume}>
          Resume
        </Button>
        <Button size="sm" variant="danger" icon={Trash2} disabled={disabled} data-testid="gpu-parked-destroy" onClick={() => setConfirm(true)}>
          Destroy
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Destroy the parked instance?"
        description="The model files on its disk are deleted and storage billing stops. The next clock-in downloads the model again."
        confirmLabel="Destroy instance"
        onConfirm={onDestroy}
      />
    </section>
  );
}

// ───────────────────────────── Banners & empty states ─────────────────────────────

export function OrphanBanner({ ids, onDestroy }: { ids: number[]; onDestroy: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="alert"
      data-testid="gpu-orphan-banner"
      className="flex flex-wrap items-center gap-3 rounded-card border border-[rgba(232,184,92,0.35)] bg-ob-warning-soft px-4 py-3"
    >
      <TriangleAlert size={18} aria-hidden className="shrink-0 text-ob-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium text-ob-text">
          {pluralize(ids.length, 'untracked instance')} on your Vast.ai account
        </span>
        <span className="text-small text-ob-text-2">
          Labelled <code className="font-mono text-[11.5px]">obsidian-code</code> but not tracked by this app (e.g. after a crash), so {ids.length === 1 ? 'it' : 'they'} may still be billing you:{' '}
          <span className="ob-tabular font-mono text-[11.5px]">{ids.map((i) => `#${i}`).join(', ')}</span>
        </span>
      </div>
      <Button
        size="md"
        variant="danger-solid"
        icon={Trash2}
        loading={busy}
        data-testid="gpu-orphan-destroy"
        onClick={async () => {
          setBusy(true);
          try {
            await onDestroy();
          } finally {
            setBusy(false);
          }
        }}
      >
        Destroy
      </Button>
    </div>
  );
}

export function NoKeyCard() {
  return (
    <div
      data-testid="gpu-no-key"
      className="flex flex-col items-start gap-4 rounded-card border border-ob-border bg-ob-surface-1 p-5 sm:flex-row sm:items-center"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-ob-border bg-ob-surface-2 text-ob-warning">
        <KeyRound size={18} aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-ob-text">Vast.ai API key missing</span>
        <span className="text-ui text-ob-text-3">
          Add your key to rent a GPU. It is stored encrypted on this PC and never shown again. Price estimates below work without it.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" iconRight={ArrowUpRight} onClick={() => openExternal(VAST_KEYS_URL)}>
          Get a key
        </Button>
        <Button variant="primary" icon={KeyRound} data-testid="gpu-open-settings" onClick={() => openSettings('vast')}>
          Open Settings
        </Button>
      </div>
    </div>
  );
}

export function KeyRejectedBanner({ message }: { message: string }) {
  return (
    <div role="alert" data-testid="gpu-key-rejected" className="flex flex-wrap items-center gap-3 rounded-card border border-[rgba(240,113,120,0.32)] bg-ob-danger-soft px-4 py-3">
      <CircleAlert size={18} aria-hidden className="shrink-0 text-ob-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium text-ob-text">Vast.ai did not accept the API key</span>
        <span className="text-small text-ob-text-2">{message}</span>
      </div>
      <Button variant="secondary" onClick={() => openSettings('vast')}>
        Open Settings
      </Button>
    </div>
  );
}

// ───────────────────────────── Safety nets ─────────────────────────────

export function SafetyCard({
  idleMinutes,
  heartbeatMinutes,
  maxSessionHours,
  clockOutOnQuit,
  clockOutMode,
}: {
  idleMinutes: number;
  heartbeatMinutes: number;
  maxSessionHours: number;
  clockOutOnQuit: boolean;
  clockOutMode: 'destroy' | 'park';
}) {
  const rows: [string, string][] = [
    ['Idle', `destroyed after ${idleMinutes} min without a request`],
    ['No heartbeat', `destroyed after ${heartbeatMinutes} min without this app`],
    ['Max session', `${maxSessionHours} h per clock-in`],
    ['App quit', clockOutOnQuit ? (clockOutMode === 'park' ? 'clocks out and parks the instance' : 'clocks out and destroys the instance') : 'keeps the GPU running'],
  ];
  return (
    <section className="flex flex-col rounded-card border border-ob-border bg-ob-surface-1 p-4" data-testid="gpu-safety" aria-label="Safety nets">
      <div className="flex items-center gap-2">
        <ShieldCheck size={15} aria-hidden className="text-ob-text-3" />
        <h3 className="text-ui font-medium text-ob-text">Safety nets</h3>
        <span className="flex-1" />
        <button type="button" onClick={() => openSettings('vast')} className="ob-transition rounded text-small text-ob-accent hover:underline">
          Edit
        </button>
      </div>
      <dl className="mt-3 flex flex-col gap-2 text-small">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4">
            <dt className="shrink-0 text-ob-text-3">{k}</dt>
            <dd className="min-w-0 text-right text-ob-text-2">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-ob-border pt-2.5 text-small text-ob-text-3">The server destroys itself even if this app crashes.</p>
    </section>
  );
}
