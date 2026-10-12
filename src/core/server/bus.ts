// In-process event bus (owner: platform). Every module emits CoreEvents here; the server fans them out to all
// connected clients via onAny().

import type { CoreEventName, CoreEvents } from '../../shared/protocol';
import type { EventBus } from '../contracts';

export type AnyEventListener = (event: CoreEventName, data: CoreEvents[CoreEventName]) => void;

export interface EventBusImpl extends EventBus {
  /** Subscribe to every event (used by the server to broadcast). */
  onAny(fn: AnyEventListener): () => void;
  /** Number of listeners (diagnostics / tests). */
  listenerCount(event?: CoreEventName): number;
}

/** Compile-time complete list of event names (fallback for buses without onAny). */
const EVENT_NAME_MAP: Record<CoreEventName, true> = {
  'session.created': true,
  'session.updated': true,
  'session.deleted': true,
  'message.added': true,
  'message.delta': true,
  'message.block': true,
  'message.completed': true,
  'session.reset': true,
  'tool.updated': true,
  'todos.updated': true,
  'changes.updated': true,
  'permission.requested': true,
  'permission.resolved': true,
  'question.requested': true,
  'question.resolved': true,
  'plan.requested': true,
  'plan.resolved': true,
  'models.updated': true,
  'gpu.status': true,
  'schedules.updated': true,
  'activity.updated': true,
  'settings.updated': true,
  notification: true,
  error: true,
};
export const ALL_EVENT_NAMES = Object.keys(EVENT_NAME_MAP) as CoreEventName[];

export function createEventBus(): EventBusImpl {
  const listeners = new Map<CoreEventName, Set<(data: never) => void>>();
  const anyListeners = new Set<AnyEventListener>();

  const safeCall = (fn: () => void, event: string): void => {
    try {
      fn();
    } catch (err) {
      console.error(`[bus] listener for "${event}" threw:`, err instanceof Error ? err.message : err);
    }
  };

  return {
    emit(event, data) {
      const set = listeners.get(event);
      if (set) {
        for (const fn of [...set]) safeCall(() => (fn as (d: typeof data) => void)(data), event);
      }
      for (const fn of [...anyListeners]) safeCall(() => fn(event, data as CoreEvents[CoreEventName]), event);
    },
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const f = fn as (data: never) => void;
      set.add(f);
      return () => {
        set.delete(f);
      };
    },
    onAny(fn) {
      anyListeners.add(fn);
      return () => {
        anyListeners.delete(fn);
      };
    },
    listenerCount(event) {
      if (event) return listeners.get(event)?.size ?? 0;
      let n = anyListeners.size;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
  };
}

/** Subscribe to every event of any EventBus (uses onAny when available). */
export function subscribeAll(bus: EventBus, fn: AnyEventListener): () => void {
  const impl = bus as Partial<EventBusImpl>;
  if (typeof impl.onAny === 'function') return impl.onAny(fn);
  const offs = ALL_EVENT_NAMES.map((name) => bus.on(name, (data) => fn(name, data as CoreEvents[CoreEventName])));
  return () => offs.forEach((off) => off());
}
