// Desktop notification routing (Settings → Notifications): agent-needs-you, long turns, GPU events, gating.
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared/types';
import { createEventBus } from '@core/server/bus';
import { createAttentionRouter, type AttentionNotice } from '../../../src/main/attention';

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    title: 'Fix the reconnect',
    cwd: 'C:\\proj',
    kind: 'chat',
    createdAt: 0,
    updatedAt: 0,
    status: 'idle',
    model: null,
    permissionMode: 'default',
    thinking: false,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    ...over,
  };
}

function setup(opts: { enabled?: boolean; focused?: boolean } = {}) {
  const bus = createEventBus();
  const shown: AttentionNotice[] = [];
  const state = { enabled: opts.enabled ?? true, focused: opts.focused ?? false, now: 1_000_000 };
  const sessions = new Map<string, SessionSummary>([
    ['s1', summary()],
    ['child', summary({ id: 'child', title: 'Explore', kind: 'subagent', parentSessionId: 's1' })],
    ['sched', summary({ id: 'sched', title: 'Nightly audit', kind: 'scheduled' })],
  ]);
  const router = createAttentionRouter({
    bus,
    enabled: () => state.enabled,
    focused: () => state.focused,
    session: (id) => sessions.get(id),
    show: (n) => shown.push(n),
    now: () => state.now,
  });
  return { bus, shown, state, router };
}

const perm = (sessionId = 's1') => ({ requestId: `r-${sessionId}`, sessionId, toolUseId: 't', toolName: 'Bash', input: {}, title: 'Run: npm test', createdAt: 0 });

describe('attention router', () => {
  it('notifies when the agent needs the user, naming the top-level session to open', () => {
    const { bus, shown } = setup();
    bus.emit('permission.requested', perm());
    bus.emit('question.requested', { requestId: 'q', sessionId: 'child', toolUseId: 't', questions: [{ question: 'Which cache?', header: '', multiSelect: false, options: [] }], createdAt: 0 });
    bus.emit('plan.requested', { requestId: 'p', sessionId: 's1', toolUseId: 't', plan: '…', createdAt: 0 });
    expect(shown).toEqual([
      { title: 'Permission needed', body: 'Fix the reconnect — Run: npm test', sessionId: 's1' },
      { title: 'The agent has a question', body: 'Fix the reconnect — Which cache?', sessionId: 's1' },
      { title: 'Plan ready for review', body: 'Fix the reconnect', sessionId: 's1' },
    ]);
  });

  it('is silent while the window is focused, and when the setting is off', () => {
    const a = setup({ focused: true });
    a.bus.emit('permission.requested', perm());
    a.bus.emit('notification', { title: 'GPU ready', body: 'x', level: 'success' });
    expect(a.shown).toEqual([]);
    const b = setup({ enabled: false });
    b.bus.emit('permission.requested', perm());
    b.bus.emit('notification', { title: 'GPU budget reached', body: 'x', level: 'warning' });
    b.router.notify({ title: 'Scheduled run finished', body: 'x' });
    expect(b.shown).toEqual([]);
  });

  it('notifies when a long turn finishes or fails, not for short turns, subagents or scheduled runs', () => {
    const { bus, shown, state } = setup();
    bus.emit('session.updated', summary({ status: 'running' }));
    state.now += 3000;
    bus.emit('session.updated', summary({ status: 'idle' }));
    expect(shown).toEqual([]); // 3 s turn: not worth a notification
    bus.emit('session.updated', summary({ status: 'running' }));
    state.now += 10_000;
    bus.emit('session.updated', summary({ status: 'waiting' }));
    state.now += 10_000;
    bus.emit('session.updated', summary({ status: 'running' }));
    state.now += 10_000;
    bus.emit('session.updated', summary({ status: 'idle' }));
    expect(shown).toEqual([{ title: 'Task finished', body: 'Fix the reconnect', sessionId: 's1' }]);
    bus.emit('session.updated', summary({ status: 'running' }));
    state.now += 60_000;
    bus.emit('session.updated', summary({ status: 'error' }));
    expect(shown[1]).toEqual({ title: 'Task failed', body: 'Fix the reconnect', sessionId: 's1' });
    for (const id of ['child', 'sched'] as const) {
      const kind = id === 'child' ? 'subagent' : 'scheduled';
      bus.emit('session.updated', summary({ id, kind, status: 'running' }));
      state.now += 60_000;
      bus.emit('session.updated', summary({ id, kind, status: 'idle' }));
    }
    expect(shown).toHaveLength(2);
  });

  it('forwards GPU / warning notifications, skips per-session info notes, and de-duplicates direct notifications', () => {
    const { bus, shown, router, state } = setup();
    bus.emit('notification', { title: 'GPU budget reached', body: 'Clocking out.', level: 'warning' });
    bus.emit('notification', { title: 'Context compacted', body: '…', level: 'info', sessionId: 's1' });
    // The scheduler emits on the bus and calls native.notify with the same text: one notification.
    bus.emit('notification', { title: 'Scheduled run finished', body: 'Nightly audit', level: 'success', sessionId: 'sched' });
    router.notify({ title: 'Scheduled run finished', body: 'Nightly audit' });
    expect(shown.map((n) => n.title)).toEqual(['GPU budget reached', 'Scheduled run finished']);
    // Direct notifications (tray errors, scheduler) show even while focused.
    state.focused = true;
    state.now += 10_000;
    router.notify({ title: 'Clock-out failed', body: 'check the console' });
    expect(shown.at(-1)?.title).toBe('Clock-out failed');
  });

  it('dispose stops routing', () => {
    const { bus, shown, router } = setup();
    router.dispose();
    bus.emit('permission.requested', perm());
    expect(shown).toEqual([]);
  });
});
