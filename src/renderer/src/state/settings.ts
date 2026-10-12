// Settings + system info store. Owner: ui-foundation.
import { create } from 'zustand';
import type { RpcResult } from '@shared/protocol';
import type { Settings } from '@shared/types';

export type SystemInfo = RpcResult<'system.info'>;

export interface SettingsStore {
  settings: Settings | null;
  system: SystemInfo | null;
  /** Presence of named secrets (values never reach the renderer). */
  secrets: Record<string, boolean>;
}

export const useSettings = create<SettingsStore>(() => ({ settings: null, system: null, secrets: {} }));
