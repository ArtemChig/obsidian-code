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
}

export const useConnection = create<ConnectionStore>(() => ({
  mode: 'none',
  coreUrl: null,
  state: { status: 'idle', attempt: 0, nextRetryAt: null, lastError: null, everConnected: false },
  ready: false,
  lastSyncAt: null,
}));
