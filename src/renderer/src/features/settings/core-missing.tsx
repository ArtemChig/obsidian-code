// Shown by the views in place of their loading skeleton when no core is reachable (so they never skeleton forever). Owner: ui-views.
import { CircleX, RotateCcw, Unplug } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/components/ui/button';
import { EmptyState } from '@renderer/components/ui/feedback';
import { useConnection, type SyncResource } from '@renderer/state/connection';
import { refetchAll } from '@renderer/state/sync';

/** True when there is no core to load from (no core URL, or the connection was given up on). */
export function useCoreMissing(): boolean {
  return useConnection((c) => c.mode === 'none' || c.state.status === 'unavailable' || c.state.status === 'closed');
}

export function CoreMissing({ what }: { what: string }) {
  return (
    <div className="flex h-full items-center justify-center" data-testid="core-missing">
      <EmptyState icon={Unplug} title="Not connected to the core" description={`${what} appear once the app is connected. Start the core, or open the demo with ?demo=1.`} />
    </div>
  );
}

/** The first load error among `resources` from the last state refetch (null when they loaded, or none was tried). */
export function useSyncError(...resources: SyncResource[]): string | null {
  return useConnection((c) => {
    for (const r of resources) if (c.syncErrors[r]) return c.syncErrors[r] ?? null;
    return null;
  });
}

/** "Couldn't load X" with a Retry that refetches the whole state (shown instead of a skeleton that would never end). */
export function SyncFailed({ what, error, compact }: { what: string; error: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await refetchAll();
    } finally {
      setBusy(false);
    }
  };
  if (compact) {
    return (
      <div className="flex flex-col items-start gap-2 px-2 py-3 text-small text-t3" data-testid="sync-failed">
        <span>Couldn&rsquo;t load {what}.</span>
        <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy} onClick={() => void retry()}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center" data-testid="sync-failed">
      <EmptyState
        icon={CircleX}
        title={`Couldn't load ${what}`}
        description={error}
        action={
          <Button size="sm" icon={RotateCcw} loading={busy} onClick={() => void retry()}>
            Retry
          </Button>
        }
      />
    </div>
  );
}
