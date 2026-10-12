// GPU (Vast.ai) store: live status from 'gpu.status' events, plus lazily-loaded catalog. Owner: ui-foundation.
import { create } from 'zustand';
import type { CatalogModel, GpuStatus, ProviderId, SessionSummary } from '@shared/types';

export interface GpuStore {
  status: GpuStatus | null;
  catalog: CatalogModel[] | null;
  /** secrets.has('vast.apiKey') — null while unknown. */
  hasApiKey: boolean | null;
  /** A clock-in/out request is in flight from this client. */
  busy: boolean;
  /** A clock-out that needs confirmation first (shown by the app-wide GpuClockOutConfirm dialog). */
  confirm: GpuClockOutPrompt | null;
}

export const useGpu = create<GpuStore>(() => ({ status: null, catalog: null, hasApiKey: null, busy: false, confirm: null }));

/** Why a clock-out needs a confirmation. */
export interface GpuClockOutPrompt {
  /** 'running' = sessions are using the GPU model right now; 'cancel' = a clock-in already rented an instance. */
  kind: 'running' | 'cancel';
  /** Titles of the sessions whose turn fails when the instance goes away. */
  sessions: string[];
  /** Money already spent on this rental (lost when a clock-in is cancelled). */
  spent: number;
}

/**
 * Does clocking out now need a confirmation? Every clock-out entry point (sidebar widget, Home card, palette, GPU view)
 * goes through this: a click must not silently fail running turns or throw away a paid-for download.
 */
export function clockOutPrompt(status: GpuStatus | null | undefined, sessions: SessionSummary[], defaultProvider: ProviderId | undefined): GpuClockOutPrompt | null {
  if (!status) return null;
  const running = sessions
    .filter((s) => s.kind !== 'subagent' && (s.status === 'running' || s.status === 'waiting') && (s.model?.provider ?? defaultProvider) === 'vast')
    .map((s) => s.title || 'Untitled session');
  const spent = status.sessionCost ?? 0;
  if ((status.phase === 'ready' || status.phase === 'switching') && running.length) return { kind: 'running', sessions: running, spent };
  const rented = status.instanceId != null && ['renting', 'connecting', 'downloading', 'loading'].includes(status.phase);
  if (rented || status.phase === 'downloading' || status.phase === 'loading') return { kind: 'cancel', sessions: running, spent };
  return null;
}

/** Phases during which money is being spent (an instance exists). */
export const GPU_ACTIVE_PHASES = new Set<GpuStatus['phase']>(['renting', 'connecting', 'downloading', 'loading', 'ready', 'switching']);
/** Phases with work in progress (show a spinner / pulse). */
export const GPU_BUSY_PHASES = new Set<GpuStatus['phase']>(['searching', 'renting', 'connecting', 'downloading', 'loading', 'switching', 'stopping']);

export function isGpuClockedIn(s: GpuStatus | null | undefined): boolean {
  return !!s && (GPU_ACTIVE_PHASES.has(s.phase) || s.phase === 'searching');
}

/**
 * A Vast.ai instance exists that only the API key can stop: rented (any active phase, incl. a failed destroy that left
 * an instance id), or parked. Removing or swapping the key now would leave the app unable to stop the billing.
 */
export function gpuHoldsInstance(s: GpuStatus | null | undefined): boolean {
  return !!s && (s.instanceId != null || (s.phase !== 'off' && s.phase !== 'error') || !!s.parked);
}
