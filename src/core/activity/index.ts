// Activity registry (owner: platform): the "oversee the work" list. Modules upsert items (sessions, subagents,
// shells, schedule runs, gpu); the registry keeps them, registers stop handlers and emits `activity.updated`
// throttled to ~4/s.

import type { ActivityItem } from '../../shared/types';
import type { ActivityRegistry, EventBus } from '../contracts';

const THROTTLE_MS = 250;
/** Finished items kept for the "recent" part of the list. */
const MAX_FINISHED = 200;
/** Finished items older than this are dropped. */
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;

const isActive = (s: ActivityItem['status']): boolean => s === 'running' || s === 'waiting';

export interface ActivityRegistryImpl extends ActivityRegistry {
  /** Emit any pending throttled update now (tests / shutdown). */
  flush(): void;
  dispose(): void;
}

export function createActivityRegistry(bus: EventBus): ActivityRegistryImpl {
  const items = new Map<string, ActivityItem>();
  const stoppers = new Map<string, () => void>();
  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const sorted = (): ActivityItem[] =>
    [...items.values()].sort((a, b) => {
      const aa = isActive(a.status) ? 1 : 0;
      const bb = isActive(b.status) ? 1 : 0;
      if (aa !== bb) return bb - aa;
      return b.startedAt - a.startedAt;
    });

  const prune = (): void => {
    const now = Date.now();
    const finished = [...items.values()]
      .filter((i) => !isActive(i.status))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    finished.forEach((item, idx) => {
      if (idx >= MAX_FINISHED || now - (item.endedAt ?? item.startedAt) > FINISHED_TTL_MS) {
        items.delete(item.id);
        stoppers.delete(item.id);
      }
    });
  };

  const emitNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastEmit = Date.now();
    bus.emit('activity.updated', sorted());
  };

  const scheduleEmit = (): void => {
    if (timer) return;
    const wait = THROTTLE_MS - (Date.now() - lastEmit);
    if (wait <= 0) {
      emitNow();
      return;
    }
    timer = setTimeout(emitNow, wait);
    timer.unref?.();
  };

  return {
    upsert(item) {
      const prev = items.get(item.id);
      const next: ActivityItem = { ...prev, ...item };
      if (!isActive(next.status) && next.endedAt === undefined) next.endedAt = Date.now();
      if (isActive(next.status)) delete next.endedAt;
      items.set(item.id, next);
      if (!isActive(next.status)) {
        stoppers.delete(item.id);
        prune();
      }
      scheduleEmit();
    },
    list() {
      return sorted();
    },
    onStop(id, fn) {
      stoppers.set(id, fn);
    },
    stop(id) {
      const fn = stoppers.get(id);
      stoppers.delete(id);
      if (fn) {
        try {
          fn();
        } catch (err) {
          console.error('[activity] stop handler threw:', err instanceof Error ? err.message : err);
        }
      }
      const item = items.get(id);
      if (item && isActive(item.status)) {
        items.set(id, { ...item, status: 'stopped', endedAt: Date.now() });
        scheduleEmit();
      }
    },
    flush() {
      if (timer) emitNow();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
