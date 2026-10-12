// Connection banners: reconnecting (with countdown + Retry now), core unavailable, demo mode. Owner: ui-foundation.
import { FlaskConical, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Spinner } from '@renderer/components/ui/feedback';
import { useNow } from '@renderer/components/ui/time';
import { rpc } from '@renderer/lib/rpc';
import { useConnection } from '@renderer/state/connection';
import { openDemoMode } from './boot';

export function ConnectionBanner() {
  const mode = useConnection((s) => s.mode);
  const state = useConnection((s) => s.state);
  const now = useNow(state.status === 'reconnecting' ? 1000 : false);

  if (mode === 'none') {
    return (
      <div role="status" data-testid="banner-unavailable" className="flex h-9 shrink-0 items-center gap-2.5 border-b border-ob-border bg-ob-surface-1 px-4 text-small">
        <Unplug size={14} aria-hidden className="text-ob-text-3" />
        <span className="text-ob-text-2">
          Not connected to the Obsidian core. Run <code className="rounded-[4px] bg-ob-surface-2 px-1 font-mono text-[11px]">npm run core</code> and open with{' '}
          <code className="rounded-[4px] bg-ob-surface-2 px-1 font-mono text-[11px]">?core=&lt;url&gt;</code>.
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
      <div
        role="status"
        data-testid="banner-reconnecting"
        className="flex h-9 shrink-0 items-center gap-2.5 border-b border-[rgba(232,184,92,0.25)] bg-[rgba(232,184,92,0.08)] px-4 text-small animate-ob-fade-in"
      >
        <Spinner size={13} className="text-ob-warning" />
        <span className="font-medium text-ob-warning">{state.everConnected ? 'Connection to the core lost' : 'Connecting to the core'}</span>
        <span className="text-ob-text-2">
          {secs > 0 ? `Reconnecting in ${secs}s` : 'Reconnecting…'}
          {state.attempt > 1 ? ` · attempt ${state.attempt}` : ''}
          {state.lastError ? ` · ${state.lastError}` : ''}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} className="ml-auto" onClick={() => rpc.retryNow()}>
          Retry now
        </Button>
      </div>
    );
  }

  if (mode === 'demo' && state.status === 'reconnecting') {
    return (
      <div role="status" data-testid="banner-reconnecting" className="flex h-9 shrink-0 items-center gap-2.5 border-b border-[rgba(232,184,92,0.25)] bg-[rgba(232,184,92,0.08)] px-4 text-small">
        <Spinner size={13} className="text-ob-warning" />
        <span className="font-medium text-ob-warning">Connection to the core lost</span>
        <span className="text-ob-text-2">Reconnecting…</span>
      </div>
    );
  }

  return null;
}
