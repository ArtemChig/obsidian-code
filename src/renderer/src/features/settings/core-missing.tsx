// Shown by the views in place of their loading skeleton when no core is reachable (so they never skeleton forever). Owner: ui-views.
import { Unplug } from 'lucide-react';
import { EmptyState } from '@renderer/components/ui/feedback';
import { useConnection } from '@renderer/state/connection';

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
