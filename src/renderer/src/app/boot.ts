// App boot: pick the transport (core WebSocket, demo, or none) and start syncing. Owner: ui-foundation.
import { isDemoRequested, onOpenSessionRequest, resolveCoreUrl } from '@renderer/lib/bridge';
import { RpcClient, rpc } from '@renderer/lib/rpc';
import { openSession } from '@renderer/state/actions';
import { useConnection } from '@renderer/state/connection';
import { useSessions } from '@renderer/state/sessions';
import { bindEvents } from '@renderer/state/sync';
import { initUpdates } from '@renderer/state/updates';

let booted = false;

/** Feature demo extensions: every src/renderer/src/features/<area>/demo.ts(x) is loaded in demo mode. */
const featureDemoModules = import.meta.glob('../features/*/demo.{ts,tsx}');

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  bindEvents();
  // A clicked desktop notification ("Permission needed", "Task finished") opens its session.
  onOpenSessionRequest((id) => openSession(id));
  // Auto-update state (Electron bridge, or the simulated updater in demo mode).
  void initUpdates();

  if (isDemoRequested()) {
    const demo = await import('@renderer/lib/demo');
    await Promise.all(
      Object.entries(featureDemoModules).map(([path, load]) =>
        load().catch((err) => console.warn(`[demo] could not load ${path}`, err)),
      ),
    );
    useConnection.setState({ mode: 'demo', coreUrl: null });
    const transport = demo.createDemoTransport();
    rpc.setTransport(transport);
    transport.connect();
    // Handy for manual testing in devtools: __obsidianDemo.simulateDisconnect()
    (window as unknown as { __obsidianDemo?: unknown }).__obsidianDemo = transport;
    return;
  }

  const url = resolveCoreUrl();
  if (!url) {
    useConnection.setState({
      mode: 'none',
      coreUrl: null,
      ready: true,
      state: { status: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'No core URL', everConnected: false },
    });
    // Nothing will load: show empty states instead of skeletons.
    useSessions.setState({ loaded: true });
    return;
  }
  useConnection.setState({ mode: 'core', coreUrl: url });
  const client = new RpcClient(url);
  rpc.setTransport(client);
  client.connect();
}

/** Reload the page in demo mode (used by the "core unavailable" banner). */
export function openDemoMode(): void {
  const u = new URL(window.location.href);
  u.searchParams.set('demo', '1');
  u.searchParams.delete('core');
  window.location.href = u.toString();
}
