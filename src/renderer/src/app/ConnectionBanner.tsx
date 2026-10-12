// Connection banners: reconnecting (with countdown + Retry now), core unavailable, demo mode. Owner: ui-foundation.
// M13: no fill — a 32 px strip on the ground, a --rule hairline below and a 2 px status edge on the left.
import { FlaskConical, RefreshCw } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Spinner, StatusDot } from '@renderer/components/ui/feedback';
import { useNow } from '@renderer/components/ui/time';
import { rpc } from '@renderer/lib/rpc';
import { useConnection } from '@renderer/state/connection';
import { openDemoMode } from './boot';

const STRIP = 'flex h-8 shrink-0 items-center gap-2.5 border-b border-rule pl-5 pr-3 text-[11.5px] tracking-[-0.008em]';
const CODE = 'rounded-[2px] bg-s2 px-1 font-mono text-[10.5px] text-t1';

export function ConnectionBanner() {
  const mode = useConnection((s) => s.mode);
  const state = useConnection((s) => s.state);
  const now = useNow(state.status === 'reconnecting' ? 1000 : false);

  if (mode === 'none') {
    return (
      <div role="status" data-testid="banner-unavailable" className={`${STRIP} shadow-[inset_2px_0_0_var(--err)]`}>
        <StatusDot tone="danger" size={6} />
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-err">Offline</span>
        <span className="truncate text-t2">
          Not connected to the Obsidian core. Run <code className={CODE}>npm run core</code> and open with <code className={CODE}>?core=&lt;url&gt;</code>.
        </span>
        <Button size="sm" variant="ghost" icon={FlaskConical} className="ml-auto" onClick={openDemoMode}>
          Open demo mode
        </Button>
      </div>
    );
  }

  if (mode === 'core' && (state.status === 'reconnecting' || (state.status === 'connecting' && state.attempt > 0))) {
    const secs = state.nextRetryAt ? Math.max(0, Math.ceil((state.nextRetryAt - now) / 1000)) : 0;
    return (
      <div role="status" data-testid="banner-reconnecting" className={`${STRIP} shadow-[inset_2px_0_0_var(--warn)] animate-ob-fade-in`}>
        <Spinner size={12} className="text-warn" />
        <span className="font-medium text-warn">{state.everConnected ? 'Connection to the core lost' : 'Connecting to the core'}</span>
        <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">
          {secs > 0 ? `reconnecting in ${secs}s` : 'reconnecting…'}
          {state.attempt > 1 ? ` · attempt ${state.attempt}` : ''}
          {state.lastError ? ` · ${state.lastError}` : ''}
        </span>
        <Button size="sm" variant="secondary" icon={RefreshCw} className="ml-auto" onClick={() => rpc.retryNow()}>
          Retry now
        </Button>
      </div>
    );
  }

  if (mode === 'demo' && state.status === 'reconnecting') {
    return (
      <div role="status" data-testid="banner-reconnecting" className={`${STRIP} shadow-[inset_2px_0_0_var(--warn)]`}>
        <Spinner size={12} className="text-warn" />
        <span className="font-medium text-warn">Connection to the core lost</span>
        <span className="font-mono text-[9.5px] tracking-[0.01em] text-t3">reconnecting…</span>
      </div>
    );
  }

  return null;
}
