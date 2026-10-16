// Selector hooks + pure derivations. Owner: ui-foundation.
// Rule (zustand v5): never return a freshly-built array/object from a store selector — select the raw record and
// derive with useMemo (as below), or use useShallow from 'zustand/react/shallow'.
import { useEffect, useMemo } from 'react';
import type {
  GpuPhase,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  PlanRequest,
  ProviderInfo,
  QuestionRequest,
  SessionSummary,
} from '@shared/types';
import { providerLabel, sameModel } from '../lib/format';
import { useActivity } from './activity';
import { useGpu } from './gpu';
import { useModels } from './models';
import { usePending } from './pending';
import { useSessions } from './sessions';
import { useSidebarPrefs } from './sidebar';
import { groupSessions, type SidebarModel } from './sidebar-model';
import { loadTranscript } from './sync';
import type { TranscriptEntry } from './transcript';

// ───────────────────────────── Sessions ─────────────────────────────

export function useActiveSessionId(): string | null {
  return useSessions((s) => s.activeSessionId);
}

export function useSessionSummary(sessionId: string | null | undefined): SessionSummary | undefined {
  return useSessions((s) => (sessionId ? s.sessions[sessionId] : undefined));
}

export function useActiveSession(): SessionSummary | undefined {
  return useSessions((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));
}

/** Loaded transcript for a session; triggers sessions.get when missing or stale. */
export function useTranscript(sessionId: string | null | undefined): TranscriptEntry | undefined {
  const entry = useSessions((s) => (sessionId ? s.transcripts[sessionId] : undefined));
  const stale = entry?.stale ?? true;
  useEffect(() => {
    if (sessionId && stale) void loadTranscript(sessionId);
  }, [sessionId, stale]);
  return entry;
}

export function useTranscriptLoading(sessionId: string | null | undefined): { loading: boolean; error: string | null } {
  const loading = useSessions((s) => (sessionId ? !!s.loading[sessionId] : false));
  const error = useSessions((s) => (sessionId ? (s.loadErrors[sessionId] ?? null) : null));
  return { loading, error };
}

/** Subagent sessions spawned by a session, oldest first. */
export function useSubagents(sessionId: string | null | undefined): SessionSummary[] {
  const sessions = useSessions((s) => s.sessions);
  return useMemo(
    () =>
      sessionId
        ? Object.values(sessions)
            .filter((s) => s.parentSessionId === sessionId)
            .sort((a, b) => a.createdAt - b.createdAt)
        : [],
    [sessions, sessionId],
  );
}

export function useQueued(sessionId: string | null | undefined) {
  const q = useSessions((s) => (sessionId ? s.queued[sessionId] : undefined));
  return q ?? EMPTY;
}
const EMPTY: never[] = [];

// The sidebar groups (Pinned, categories, project folders) are built by state/sidebar-model.ts.
export { groupSessions, type SessionGroup, type SidebarModel } from './sidebar-model';

export function useSidebarModel(query: string): SidebarModel {
  const sessions = useSessions((s) => s.sessions);
  const prefs = useSidebarPrefs();
  return useMemo(() => groupSessions(sessions, query, prefs), [sessions, query, prefs]);
}

/** Most recently updated top-level sessions. */
export function useRecentSessions(limit = 6): SessionSummary[] {
  const sessions = useSessions((s) => s.sessions);
  return useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.kind !== 'subagent')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit),
    [sessions, limit],
  );
}

export function useRunningCount(): number {
  const sessions = useSessions((s) => s.sessions);
  return useMemo(() => Object.values(sessions).filter((s) => s.status === 'running' && s.kind !== 'subagent').length, [sessions]);
}

// ───────────────────────────── Pending requests ─────────────────────────────

export interface PendingForSession {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  plans: PlanRequest[];
  count: number;
}

export function usePendingFor(sessionId: string | null | undefined): PendingForSession {
  const { permissions, questions, plans } = usePending();
  return useMemo(() => {
    const by = <T extends { sessionId: string; createdAt: number }>(m: Record<string, T>) =>
      Object.values(m)
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt);
    const p = by(permissions);
    const q = by(questions);
    const pl = by(plans);
    return { permissions: p, questions: q, plans: pl, count: p.length + q.length + pl.length };
  }, [permissions, questions, plans, sessionId]);
}

/** Sessions that currently wait for the user (any pending request). */
export function useWaitingSessionIds(): Set<string> {
  const { permissions, questions, plans } = usePending();
  return useMemo(() => {
    const ids = new Set<string>();
    for (const r of Object.values(permissions)) ids.add(r.sessionId);
    for (const r of Object.values(questions)) ids.add(r.sessionId);
    for (const r of Object.values(plans)) ids.add(r.sessionId);
    return ids;
  }, [permissions, questions, plans]);
}

// ───────────────────────────── Models ─────────────────────────────

export function findModel(models: ModelInfo[], ref: ModelRef | null | undefined): ModelInfo | undefined {
  return ref ? models.find((m) => sameModel(m.ref, ref)) : undefined;
}

export function useModelInfo(ref: ModelRef | null | undefined): ModelInfo | undefined {
  const models = useModels((s) => s.models);
  return useMemo(() => findModel(models, ref), [models, ref]);
}

export interface ModelGroup {
  provider: ProviderInfo;
  models: ModelInfo[];
}

/** Pure: models grouped by provider (providers order preserved; unknown providers appended). */
export function groupModels(providers: ProviderInfo[], models: ModelInfo[]): ModelGroup[] {
  const groups: ModelGroup[] = providers.map((p) => ({ provider: p, models: [] }));
  const byId = new Map(groups.map((g) => [g.provider.id, g] as const));
  for (const m of models) {
    let g = byId.get(m.ref.provider);
    if (!g) {
      g = { provider: { id: m.ref.provider, label: m.ref.provider, status: m.status, baseUrl: null }, models: [] };
      byId.set(m.ref.provider, g);
      groups.push(g);
    }
    g.models.push(m);
  }
  return groups.filter((g) => g.models.length > 0 || g.provider.status !== 'offline');
}

export function useModelGroups(): ModelGroup[] {
  const providers = useModels((s) => s.providers);
  const models = useModels((s) => s.models);
  return useMemo(() => groupModels(providers, models), [providers, models]);
}

// ───────────────────────────── GPU / activity ─────────────────────────────

export function useGpuStatus() {
  return useGpu((s) => s.status);
}

export function useRunningActivityCount(): number {
  const items = useActivity((s) => s.items);
  return useMemo(() => items.filter((i) => i.status === 'running' || i.status === 'waiting').length, [items]);
}

// ───────────────────────────── Model readiness (before Send) ─────────────────────────────

export interface ModelReadiness {
  /** One line for the composer, e.g. "The local model server isn't reachable." */
  message: string;
  /** The fix to offer: open the GPU view / clock in, open Settings → Models, or switch to another model. */
  action: 'clock-in' | 'gpu' | 'settings' | 'switch';
}

const GPU_STARTING: ReadonlySet<GpuPhase> = new Set(['searching', 'renting', 'connecting', 'downloading', 'loading', 'switching']);

/**
 * Pure: will a message to this model fail right away? Null when it looks fine (or when nothing is known yet).
 * `ref` null = the session uses the default model; with no default either, the core picks any online model.
 */
export function modelReadiness(
  ref: ModelRef | null | undefined,
  defaultModel: ModelRef | null | undefined,
  models: ModelInfo[],
  providers: ProviderInfo[],
  gpuPhase: GpuPhase | undefined,
): ModelReadiness | null {
  if (!providers.length && !models.length) return null; // not loaded yet
  const eff = ref ?? defaultModel ?? null;
  if (!eff) return models.some((m) => m.status === 'online') ? null : { message: 'No model is online.', action: 'settings' };
  const m = findModel(models, eff);
  if (m?.status === 'online') return null;
  if (eff.provider === 'vast') {
    if (gpuPhase && GPU_STARTING.has(gpuPhase)) return { message: 'The GPU is still starting. Send once it is ready.', action: 'gpu' };
    if (gpuPhase !== 'ready') return { message: 'The GPU is not clocked in.', action: 'clock-in' };
    return { message: `${m?.label ?? eff.model} is not the model loaded on the GPU.`, action: 'switch' };
  }
  const provider = providers.find((p) => p.id === eff.provider);
  const name = provider?.label || providerLabel(eff.provider);
  if (m?.status === 'starting' || provider?.status === 'starting') return { message: `${name} is still starting.`, action: 'settings' };
  if (!provider || provider.status !== 'online') {
    return eff.provider === 'local'
      ? { message: `The local model server isn't reachable${provider?.baseUrl ? ` at ${provider.baseUrl}` : ''}.`, action: 'settings' }
      : { message: `${name} is offline.`, action: 'settings' };
  }
  return { message: `${eff.model} is not available on ${name}.`, action: 'switch' };
}
