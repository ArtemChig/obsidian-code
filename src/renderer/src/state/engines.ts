// Agent engines (engines.list): which harness a session runs on. Fetched once per app run (refetch on demand,
// e.g. after the Claude Code executable setting changes). Owner: ui-chat.
import { useEffect, useSyncExternalStore } from 'react';
import type { EngineId, EngineInfo } from '@shared/types';
import { rpc } from '@renderer/lib/rpc';

export const ENGINE_LABEL: Record<EngineId, string> = { builtin: 'Obsidian', 'claude-code': 'Claude Code' };

export function engineLabel(id: EngineId | undefined): string {
  return ENGINE_LABEL[id ?? 'builtin'] ?? 'Obsidian';
}

const FALLBACK: EngineInfo[] = [
  { id: 'builtin', label: 'Obsidian', available: true, detail: 'The app\'s own agent loop.' },
  // selectable until the core answered (the first turn reports a missing executable clearly)
  { id: 'claude-code', label: 'Claude Code', available: true, detail: 'Checking…' },
];

let list: EngineInfo[] = FALLBACK;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function refreshEngines(): Promise<void> {
  inflight ??= rpc
    .request('engines.list', {}, { timeoutMs: 45_000 })
    .then((r) => {
      list = r.length ? r : FALLBACK;
      loaded = true;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      /* keep the fallback */
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useEngines(): EngineInfo[] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => list,
  );
  useEffect(() => {
    if (loaded) return;
    // the core may not be connected yet on first paint: retry until it answers
    void refreshEngines();
    const t = setInterval(() => { if (loaded) clearInterval(t); else void refreshEngines(); }, 3000);
    return () => clearInterval(t);
  }, []);
  return value;
}
