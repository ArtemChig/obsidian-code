// Connection store: mirrors the rpc facade state. Owner: ui-foundation.
import { create } from 'zustand';
import type { ConnectionState } from '../lib/rpc';

export type ConnectionMode = 'core' | 'demo' | 'none';

export interface ConnectionStore {
  mode: ConnectionMode;
  coreUrl: string | null;
  state: ConnectionState;
  /** True after the first full state fetch completed. */
  ready: boolean;
  /** Epoch ms of the last successful state refetch. */
  lastSyncAt: number | null;
  /** Resources the last refetch could not load (message per resource); views show "Couldn't load — Retry". */
  syncErrors: Partial<Record<SyncResource, string>>;
}

/** The pieces of client state refetchAll loads. */
export type SyncResource = 'sessions' | 'models' | 'gpu' | 'settings' | 'activity' | 'schedules';

export const SYNC_RESOURCE_LABEL: Record<SyncResource, string> = {
  sessions: 'sessions',
  models: 'models',
  gpu: 'GPU status',
  settings: 'settings',
  activity: 'activity',
  schedules: 'scheduled tasks',
};

export const useConnection = create<ConnectionStore>(() => ({
  mode: 'none',
  coreUrl: null,
  state: { status: 'idle', attempt: 0, nextRetryAt: null, lastError: null, everConnected: false },
  ready: false,
  lastSyncAt: null,
  syncErrors: {},
}));
