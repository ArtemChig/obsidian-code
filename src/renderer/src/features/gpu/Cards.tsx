// Smaller parts of the GPU view: the side-rail blocks (spend vs budget, parked instance, safety nets) and the
// status-framed notices (untracked instances, missing / rejected API key). Owner: ui-views.
import { ArrowUpRight, CircleAlert, HardDrive, KeyRound, Play, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { CatalogModel, GpuStatus } from '@shared/types';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { ProgressBar } from '@renderer/components/ui/feedback';
import { RelativeTime } from '@renderer/components/ui/time';
import { openExternal } from '@renderer/lib/bridge';
import { formatMoney, pluralize } from '@renderer/lib/format';
import { openSettings } from '@renderer/state/actions';
import { Kv, Notice, RailBlock } from '../settings/view-kit';
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
  const tone = budgetTone(ratio);
  return (
    <RailBlock
      testId="gpu-spend"
      ariaLabel="Spend"
      label="This month"
      aside={
        <span className={tone === 'danger' ? 'text-err' : tone === 'warning' ? 'text-warn' : 'text-t1'}>
          <span className="ob-tabular">{Math.round(ratio * 100)}%</span> used
        </span>
      }
    >
      <div className="flex items-baseline gap-1.5">
        <span className="ob-tabular font-mono text-[19px] leading-6 tracking-[-0.045em] text-t1" data-testid="gpu-month-spent">
          {formatMoney(spent)}
        </span>
        <span className="ob-tabular font-mono text-[11px] tracking-[-0.02em] text-t3">/ {formatMoney(budget)}</span>
      </div>
      <ProgressBar className="mb-2 mt-[11px]" variant="segments" segments={20} size="sm" value={ratio} tone={tone} label="Monthly budget used" />
      <dl>
        <Kv label="Remaining" tone={ratio >= 1 ? 'err' : ratio >= 0.8 ? 'warn' : 'ok'}>
          {formatMoney(remaining)}
        </Kv>
        <Kv label="Est. hours left" testId="gpu-hours-left" title={typicalPrice ? `at ${formatMoney(typicalPrice)}/h` : undefined}>
          {hours == null ? '—' : `≈ ${hours.toLocaleString('en-US')} h`}
          {typicalPrice && hours != null ? <span className="text-t3"> @ {formatMoney(typicalPrice)}/h</span> : null}
        </Kv>
        <div className="flex items-center justify-between gap-2.5 py-[3px]">
          <dt className="text-[11.5px] tracking-[-0.008em] text-t3">Vast.ai credit</dt>
          <dd className="flex min-w-0 items-center gap-1">
            {hasApiKey ? <IconButton label="Re-check account" icon={RefreshCw} size="xs" loading={checking} onClick={onRecheck} /> : null}
            <span className={'ob-tabular truncate font-mono text-[11.5px] tracking-[-0.03em] ' + (hasApiKey === false ? 'text-t3' : lowCredit ? 'text-warn' : 'text-t1')} data-testid="gpu-credit">
              {hasApiKey === false ? 'no API key' : credit != null ? formatMoney(credit) : account && !account.ok ? 'unavailable' : '—'}
            </span>
          </dd>
        </div>
      </dl>
      {lowCredit ? (
        <Notice tone="warn" icon={TriangleAlert} className="mt-2.5">
          Your Vast.ai credit ({formatMoney(credit)}) is lower than the budget you have left. Top up before a long session.
        </Notice>
      ) : null}
    </RailBlock>
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
    <RailBlock testId="gpu-parked" ariaLabel="Parked instance" label="Parked instance" aside={<span className="ob-tabular normal-case tracking-[0.02em]">#{parked.instanceId}</span>}>
      <dl>
        <Kv label="GPU">{parked.gpuName}</Kv>
        <Kv label="Model" className="[&_dd]:font-sans [&_dd]:tracking-[-0.01em]" title={name}>
          {name}
        </Kv>
        <Kv label="Stopped" tone="dim">
          <RelativeTime ts={parked.parkedAt} ago />
        </Kv>
        <Kv label="Storage" tone="warn">
          {formatMoney(parked.storageCostPerHour, { precise: true })}/h
        </Kv>
      </dl>
      <Notice tone="warn" icon={HardDrive} className="mt-2.5" title="Storage is billed while parked.">
        The model stays on its disk, so the next clock-in skips the download.
        {parkMaxDays ? ` Destroyed automatically after ${pluralize(parkMaxDays, 'day')} (checked while the app is running).` : ''}
      </Notice>
      <div className="mt-3 flex items-center gap-2">
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
    </RailBlock>
  );
}

// ───────────────────────────── Notices ─────────────────────────────

export function OrphanBanner({ ids, onDestroy }: { ids: number[]; onDestroy: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Notice
        tone="err"
        alert
        icon={TriangleAlert}
        testId="gpu-orphan-banner"
        title={`${pluralize(ids.length, 'untracked instance')} on your Vast.ai account`}
        action={
          <Button size="sm" variant="danger" icon={Trash2} loading={busy} data-testid="gpu-orphan-destroy" onClick={() => setConfirm(true)}>
            Destroy
          </Button>
        }
      >
        Labelled <code className="font-mono text-[10.5px] text-t1">obsidian-code</code> but not tracked by this app (e.g. after a crash), or a destroy that was not confirmed yet, so{' '}
        {ids.length === 1 ? 'it' : 'they'} may still be billing you: <span className="ob-tabular font-mono text-[10.5px] text-t1">{ids.map((i) => `#${i}`).join(', ')}</span>
      </Notice>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title={`Destroy ${pluralize(ids.length, 'untracked instance')}?`}
        description={`${ids.map((i) => `#${i}`).join(', ')} ${ids.length === 1 ? 'is' : 'are'} deleted on Vast.ai, with ${ids.length === 1 ? 'its' : 'their'} disk. If another copy of this app (or a script) is using ${ids.length === 1 ? 'it' : 'them'}, that work stops. Check the Vast.ai console first if you are unsure.`}
        confirmLabel="Destroy instances"
        onConfirm={async () => {
          setBusy(true);
          try {
            await onDestroy();
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

export function NoKeyCard() {
  return (
    <Notice
      tone="warn"
      icon={KeyRound}
      testId="gpu-no-key"
      title="Vast.ai API key missing."
      action={
        <>
          <Button size="sm" variant="ghost" iconRight={ArrowUpRight} onClick={() => openExternal(VAST_KEYS_URL)}>
            Get a key
          </Button>
          <Button size="sm" variant="primary" icon={KeyRound} data-testid="gpu-open-settings" onClick={() => openSettings('vast')}>
            Open Settings
          </Button>
        </>
      }
    >
      Add your key to rent a GPU. It is stored encrypted on this PC and never shown again. Price estimates work without it.
    </Notice>
  );
}

export function KeyRejectedBanner({ message }: { message: string }) {
  return (
    <Notice
      tone="err"
      alert
      icon={CircleAlert}
      testId="gpu-key-rejected"
      title="Vast.ai did not accept the API key."
      action={
        <Button size="sm" variant="secondary" onClick={() => openSettings('vast')}>
          Open Settings
        </Button>
      }
    >
      {message}
    </Notice>
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
  return (
    <RailBlock
      testId="gpu-safety"
      ariaLabel="Safety nets"
      label="Safety nets"
      aside={
        <button type="button" onClick={() => openSettings('vast')} className="ob-transition rounded-[2px] text-acc hover:text-t1 hover:underline">
          Edit
        </button>
      }
    >
      <dl>
        <Kv label="Idle" title="Destroyed after this long without a request">
          {idleMinutes} min
        </Kv>
        <Kv label="No heartbeat" title="Destroyed after this long without this app">
          {heartbeatMinutes} min
        </Kv>
        <Kv label="Max session">{maxSessionHours} h</Kv>
        <Kv label="App quit" tone={clockOutOnQuit ? 'default' : 'warn'}>
          {clockOutOnQuit ? (clockOutMode === 'park' ? 'clock out + park' : 'clock out + destroy') : 'keeps running'}
        </Kv>
      </dl>
      <p className="mt-2 text-[11px] leading-[1.45] text-t3">The server destroys itself even if this app crashes.</p>
    </RailBlock>
  );
}
