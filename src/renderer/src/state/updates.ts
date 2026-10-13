// Auto-update store (owner: ui-foundation): the main process's UpdateSnapshot through window.obsidian.updates, or a
// simulated updater in demo mode (lib/demo-updates.ts). Browser mode without demo: snapshot stays null → the update
// UI hides itself.
import { create } from 'zustand';
import type { UpdateSnapshot } from '@shared/updates';
import { getBridge, isDemoRequested } from '@renderer/lib/bridge';
import { toast } from './toasts';

export interface UpdatesApi {
  getState(): Promise<UpdateSnapshot | null>;
  check(): Promise<UpdateSnapshot | null>;
  update(): Promise<UpdateSnapshot | null>;
  onState(cb: (s: UpdateSnapshot) => void): () => void;
}

export interface UpdatesStore {
  /** Null = no updater in this window (browser mode). */
  snapshot: UpdateSnapshot | null;
  source: 'electron' | 'demo' | null;
}

export const useUpdates = create<UpdatesStore>(() => ({ snapshot: null, source: null }));

let api: UpdatesApi | null = null;

/** Wire the store to the preload bridge (or the demo updater). Idempotent; called from boot(). */
export async function initUpdates(search: string = typeof window !== 'undefined' ? window.location.search : ''): Promise<void> {
  if (api) return;
  const bridge = getBridge()?.updates;
  if (bridge) {
    api = bridge;
    useUpdates.setState({ source: 'electron' });
  } else if (isDemoRequested(search)) {
    const { createDemoUpdates } = await import('@renderer/lib/demo-updates');
    api = createDemoUpdates(new URLSearchParams(search).get('update'));
    useUpdates.setState({ source: 'demo' });
  } else {
    return;
  }
  api.onState((s) => useUpdates.setState({ snapshot: s }));
  try {
    const s = await api.getState();
    if (s) useUpdates.setState({ snapshot: s });
  } catch {
    /* the bridge is optional */
  }
}

/** "Check now". Resolves with the state after the check. */
export async function checkForUpdates(): Promise<UpdateSnapshot | null> {
  if (!api) return null;
  try {
    const s = await api.check();
    if (s) useUpdates.setState({ snapshot: s });
    return s;
  } catch (err) {
    toast({ title: 'Update check failed', body: err instanceof Error ? err.message : String(err), level: 'error' });
    return null;
  }
}

/** One click: download, graceful quit, install, restart. Progress arrives through the store. */
export async function installUpdate(): Promise<void> {
  if (!api) return;
  try {
    const s = await api.update();
    if (s) useUpdates.setState({ snapshot: s });
  } catch (err) {
    toast({ title: 'Update failed', body: err instanceof Error ? err.message : String(err), level: 'error' });
  }
}
