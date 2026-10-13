// Menu-strip update button (owner: ui-foundation). Appears only when there is something to do: a solid-accent
// "UPDATE 1.0.1" when a newer release exists → one click (after a GPU confirm when the GPU is clocked in) downloads,
// shuts down gracefully, installs and restarts. While that runs it shows "UPDATING 42%" / "RESTARTING". A failed
// download/install shows "UPDATE FAILED", which opens Settings → About & updates.
import { useState, type ReactElement } from 'react';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { Spinner } from '@renderer/components/ui/feedback';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { openSettings } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { installUpdate, useUpdates } from '@renderer/state/updates';

const BASE =
  'ob-transition relative flex h-5 shrink-0 items-center gap-[7px] overflow-hidden rounded-[2px] px-2 font-mono text-[9px] uppercase leading-none tracking-[0.14em] outline-offset-1';

/** The confirm text when an update would also stop (or leave running) a rented GPU. */
export function updateGpuNotice(clockOutOnQuit: boolean): string {
  return clockOutOnQuit
    ? 'Updating restarts Obsidian Code. Your GPU will be clocked out first.'
    : 'Updating restarts Obsidian Code. Your GPU keeps running and will be re-attached after the restart.';
}

/** Start the one-click update, asking first when a GPU is clocked in. Shared by the button and Settings. */
export function useStartUpdate(): { start: () => void; dialog: ReactElement } {
  const phase = useGpu((s) => s.status?.phase ?? 'off');
  const clockOutOnQuit = useSettings((s) => s.settings?.vast.clockOutOnQuit ?? true);
  const [confirm, setConfirm] = useState(false);
  const start = () => {
    if (phase !== 'off') setConfirm(true);
    else void installUpdate();
  };
  const dialog = (
    <ConfirmDialog
      open={confirm}
      onOpenChange={setConfirm}
      title="Update and restart?"
      description={updateGpuNotice(clockOutOnQuit)}
      confirmLabel="Update & restart"
      onConfirm={() => installUpdate()}
    />
  );
  return { start, dialog };
}

export function UpdateButton() {
  const snap = useUpdates((s) => s.snapshot);
  const { start, dialog } = useStartUpdate();
  if (!snap) return null;
  const st = snap.state;

  if (st.status === 'available') {
    return (
      <>
        <Tooltip content={`Obsidian Code ${st.version} is available — download, install and restart`}>
          <button
            type="button"
            data-testid="update-button"
            data-status="available"
            onClick={start}
            className={cn(BASE, 'bg-acc font-semibold text-acc-ink hover:bg-acc-hi active:bg-acc-press')}
          >
            Update
            <span className="font-medium normal-case tracking-[0.02em]" data-testid="update-version">
              {st.version}
            </span>
          </button>
        </Tooltip>
        {dialog}
      </>
    );
  }

  if (st.status === 'downloading') {
    const pct = Math.floor(st.percent);
    return (
      <span
        role="progressbar"
        aria-label={`Downloading ${st.version}`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        data-testid="update-button"
        data-status="downloading"
        className={cn(BASE, 'cursor-default bg-acc font-semibold text-acc-ink')}
      >
        Updating
        <span className="ob-tabular w-[3.2ch] text-right font-medium normal-case tracking-[0.02em]" data-testid="update-percent">
          {pct}%
        </span>
        {/* 2 px progress track along the bottom edge (ink on the accent fill) */}
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-acc-ink/15">
          <span className="block h-full bg-acc-ink/70 transition-[width] duration-150 ease-out" style={{ width: `${pct}%` }} />
        </span>
      </span>
    );
  }

  if (st.status === 'downloaded' || st.status === 'installing') {
    return (
      <span data-testid="update-button" data-status={st.status} className={cn(BASE, 'cursor-default bg-acc font-semibold text-acc-ink')}>
        <Spinner size={9} />
        Restarting
      </span>
    );
  }

  if (st.status === 'error' && st.during !== 'check') {
    return (
      <Tooltip content={st.message}>
        <button
          type="button"
          data-testid="update-button"
          data-status="error"
          onClick={() => openSettings('about')}
          className={cn(BASE, 'text-err shadow-[inset_0_0_0_1px_var(--err)] hover:bg-err-wash')}
        >
          Update failed
        </button>
      </Tooltip>
    );
  }

  return null;
}
