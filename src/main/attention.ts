// Desktop notifications for "the agent needs you" / "a long task finished" / GPU events (Settings → Notifications).
// Routes core bus events to native notifications while the app window is not focused (when it is, the in-app toasts
// and prompt cards are enough). No electron import, so it is unit-tested (tests/unit/platform/attention.test.ts).
// Owner: platform.
import type { EventBus } from '@core/contracts';
import type { SessionStatus, SessionSummary } from '@shared/types';

export interface AttentionNotice {
  title: string;
  body: string;
  /** Session to open when the notification is clicked. */
  sessionId?: string;
}

export interface AttentionDeps {
  bus: EventBus;
  /** settings.notifications */
  enabled(): boolean;
  /** True while the user is looking at the app window (focused and visible). */
  focused(): boolean;
  session(id: string): SessionSummary | undefined;
  show(n: AttentionNotice): void;
  now?(): number;
  /** Turns shorter than this finish silently (default 15 s). */
  minTurnMs?: number;
}

export interface AttentionRouter {
  /** Direct notification (scheduler, tray errors): shown whenever notifications are on, de-duplicated against the bus. */
  notify(n: AttentionNotice): void;
  dispose(): void;
}

const DEDUPE_MS = 5000;
const BUSY: ReadonlySet<SessionStatus> = new Set(['running', 'waiting']);

export function createAttentionRouter(deps: AttentionDeps): AttentionRouter {
  const now = deps.now ?? Date.now;
  const minTurnMs = deps.minTurnMs ?? 15_000;
  const recent = new Map<string, number>();
  const turns = new Map<string, { status: SessionStatus; since: number | null }>();

  const enabled = (): boolean => {
    try {
      return deps.enabled();
    } catch {
      return true;
    }
  };

  const deliver = (n: AttentionNotice, onlyWhenAway: boolean): void => {
    if (!enabled()) return;
    if (onlyWhenAway && deps.focused()) return;
    const key = `${n.title}\n${n.body}`;
    const t = now();
    const last = recent.get(key);
    if (last !== undefined && t - last < DEDUPE_MS) return;
    recent.set(key, t);
    if (recent.size > 50) for (const [k, at] of recent) if (t - at >= DEDUPE_MS) recent.delete(k);
    try {
      deps.show(n);
    } catch {
      /* notifications unsupported */
    }
  };

  /** The top-level session a (subagent) session belongs to — the one worth opening. */
  const rootOf = (id: string): SessionSummary | undefined => {
    let s = deps.session(id);
    for (let i = 0; s?.parentSessionId && i < 5; i++) s = deps.session(s.parentSessionId) ?? s;
    return s;
  };
  const titleOf = (s: SessionSummary | undefined): string => s?.title?.trim() || 'Untitled session';

  const needsYou = (title: string, sessionId: string, detail: string): void => {
    const root = rootOf(sessionId);
    if (root?.kind === 'scheduled') return; // unattended runs never wait for a human
    deliver({ title, body: detail ? `${titleOf(root)} — ${detail}` : titleOf(root), sessionId: root?.id ?? sessionId }, true);
  };

  const offs = [
    deps.bus.on('permission.requested', (r) => needsYou('Permission needed', r.sessionId, r.title)),
    deps.bus.on('question.requested', (r) => needsYou('The agent has a question', r.sessionId, r.questions[0]?.question ?? '')),
    deps.bus.on('plan.requested', (r) => needsYou('Plan ready for review', r.sessionId, '')),
    deps.bus.on('notification', (n) => {
      // Per-session info notes ("Context compacted") are not worth interrupting for; GPU and warnings are.
      if (n.level === 'info' && n.sessionId) return;
      deliver({ title: n.title, body: n.body, sessionId: n.sessionId }, true);
    }),
    deps.bus.on('session.updated', (s) => {
      const prev = turns.get(s.id);
      const busy = BUSY.has(s.status);
      if (busy) {
        turns.set(s.id, { status: s.status, since: prev && BUSY.has(prev.status) ? prev.since : now() });
        return;
      }
      turns.set(s.id, { status: s.status, since: null });
      if (!prev || !BUSY.has(prev.status) || prev.since === null) return;
      if (s.kind !== 'chat') return; // subagents report to their parent; the scheduler notifies its own runs
      if (now() - prev.since < minTurnMs) return;
      deliver(
        s.status === 'error'
          ? { title: 'Task failed', body: titleOf(s), sessionId: s.id }
          : { title: 'Task finished', body: titleOf(s), sessionId: s.id },
        true,
      );
    }),
    deps.bus.on('session.deleted', ({ sessionId }) => {
      turns.delete(sessionId);
    }),
  ];

  return {
    notify: (n) => deliver(n, false),
    dispose: () => {
      for (const off of offs) off();
      turns.clear();
      recent.clear();
    },
  };
}
