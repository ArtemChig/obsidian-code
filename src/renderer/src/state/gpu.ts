// GPU (Vast.ai) store: live status from 'gpu.status' events, plus lazily-loaded catalog. Owner: ui-foundation.
import { create } from 'zustand';
import type { CatalogModel, GpuStatus } from '@shared/types';

export interface GpuStore {
  status: GpuStatus | null;
  catalog: CatalogModel[] | null;
  /** secrets.has('vast.apiKey') — null while unknown. */
  hasApiKey: boolean | null;
  /** A clock-in/out request is in flight from this client. */
  busy: boolean;
}

export const useGpu = create<GpuStore>(() => ({ status: null, catalog: null, hasApiKey: null, busy: false }));

/** Phases during which money is being spent (an instance exists). */
export const GPU_ACTIVE_PHASES = new Set<GpuStatus['phase']>(['renting', 'connecting', 'downloading', 'loading', 'ready', 'switching']);
/** Phases with work in progress (show a spinner / pulse). */
export const GPU_BUSY_PHASES = new Set<GpuStatus['phase']>(['searching', 'renting', 'connecting', 'downloading', 'loading', 'switching', 'stopping']);

export function isGpuClockedIn(s: GpuStatus | null | undefined): boolean {
  return !!s && (GPU_ACTIVE_PHASES.has(s.phase) || s.phase === 'searching');
}
