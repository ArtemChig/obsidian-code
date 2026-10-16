// Auto clock-out against the real GpuManager (mock Vast + fake instance): the watch rides on the status, the fired
// clock-out destroys the instance with the right ledger reason and says why exactly once.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoClockOut } from '../../../src/core/gpu/auto-clockout';
import type { SessionSummary } from '../../../src/shared/types';
import { createHarness, type Harness } from '../../fixtures/mock-vast/harness';

const TEST_MODEL = 'test-qwen35-0.8b-q8';
let h: Harness | null = null;
let ac: AutoClockOut | null = null;

afterEach(async () => {
  ac?.dispose();
  ac = null;
  await h?.close();
  h = null;
});

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', title: 'Fix it', cwd: '/p', kind: 'chat', createdAt: 0, updatedAt: 0, status: 'idle', model: { provider: 'vast', model: TEST_MODEL },
  permissionMode: 'default', thinking: true, usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 }, ...over,
});

function wire(x: Harness, clock: { t: number }) {
  const sessions = new Map<string, SessionSummary>();
  const interrupt = vi.fn();
  Object.assign(x.ctx, {
    gpu: x.manager,
    sessions: { list: () => [...sessions.values()], get: (id: string) => sessions.get(id) },
    agent: { interrupt, isRunning: () => false },
  });
  ac = new AutoClockOut(x.ctx, { now: () => clock.t, tickMs: 10_000, sleepGapMs: Infinity });
  ac.start();
  const put = (s: SessionSummary, event: 'session.created' | 'session.updated') => {
    sessions.set(s.id, s);
    x.ctx.bus.emit(event, s);
  };
  return { interrupt, put, tickFor: (ms: number) => { for (let left = ms; left > 0; left -= 10_000) { clock.t += 10_000; ac!.tick(); } } };
}

describe('auto clock-out with the real GPU manager', () => {
  it('shows the default watch in the status while rented, fires on a stalled session, and records why', async () => {
    h = await createHarness();
    const clock = { t: 5_000_000_000 };
    const w = wire(h, clock);
    await h.manager.start();
    expect(h.manager.status().autoClockOut).toBeUndefined();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().autoClockOut).toMatchObject({ mode: 'unresponsive', source: 'default' });
    expect(h.manager.status().autoClockOutWatches).toHaveLength(1);
    // the status events the UI receives carry it too
    await h.waitFor(() => h!.events.some((e) => e.phase === 'ready' && e.autoClockOut?.mode === 'unresponsive'), 2000, 'ready status with the watch');

    w.put(session(), 'session.created');
    w.put(session({ status: 'running' }), 'session.updated');
    w.tickFor(9 * 60_000);
    expect(h.manager.status().phase).toBe('ready');
    w.tickFor(2 * 60_000);
    await h.waitFor(() => h!.manager.status().phase === 'off', 8000, 'auto clock-out');

    expect(h.vast.instances.size).toBe(0); // destroyed: billing stopped
    expect(w.interrupt).toHaveBeenCalledWith('s1');
    const rec = h.manager.history()[0];
    expect(rec.endReason).toBe('auto_unresponsive');
    const st = h.manager.status();
    expect(st.message).toBe('Clocked out automatically: Fix it stopped responding for 10 min.');
    expect(st.autoClockOut).toBeUndefined();
    expect(st.autoClockOutWatches).toBeUndefined();
    // exactly one "GPU clocked out" notification, and it says why
    const out = h.notifications.filter((n) => n.title === 'GPU clocked out');
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('Fix it stopped responding for 10 min.');
    expect(h.notifications.some((n) => /clock-out problem/i.test(n.title))).toBe(false);
  });

  it("'finished' clocks out with reason auto_finished after the grace period", async () => {
    h = await createHarness({ settings: { autoClockOut: { default: 'finished', stallMinutes: 10, finishGraceMinutes: 2 } } });
    const clock = { t: 5_000_000_000 };
    const w = wire(h, clock);
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    w.put(session({ status: 'running' }), 'session.created');
    w.tickFor(30_000);
    w.put(session({ status: 'idle' }), 'session.updated');
    w.tickFor(60_000);
    expect(h.manager.status().phase).toBe('ready');
    expect(h.manager.status().autoClockOut?.pending?.kind).toBe('finished');
    w.tickFor(90_000);
    await h.waitFor(() => h!.manager.status().phase === 'off', 8000, 'auto clock-out');
    expect(h.manager.history()[0].endReason).toBe('auto_finished');
    expect(h.manager.status().message).toBe('Clocked out automatically: Fix it finished (idle for 2 min).');
    expect(w.interrupt).not.toHaveBeenCalled();
  });

  it('parks instead of destroying when the clock-out mode is park (an auto clock-out is a normal clock-out)', async () => {
    h = await createHarness({ settings: { clockOutMode: 'park' } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    const out = await h.manager.clockOut('auto_finished', 'Fix it finished (idle for 2 min)');
    expect(out.phase).toBe('off');
    expect(out.parked?.instanceId).toBe(id);
    expect(out.message).toBe('Clocked out automatically (Fix it finished (idle for 2 min)); instance parked (storage ~$' + out.parked!.storageCostPerHour.toFixed(3) + '/h).');
    expect(h.manager.history()[0].endReason).toBe('auto_finished');
  });

  it('a plain clock-out still says "Clocked out." and notifies as before', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const out = await h.manager.clockOut();
    expect(out.message).toBe('Clocked out.');
    expect(h.notifications.filter((n) => n.title === 'GPU clocked out')).toHaveLength(1);
  });
});
