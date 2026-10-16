// Auto clock-out in the UI: the pure helpers behind the menu / status line, the demo core's fake, the store action,
// and the history labels for the two new end reasons.
import { afterEach, describe, expect, it } from 'vitest';
import type { AutoClockOutWatch, GpuStatus } from '@shared/types';
import { AUTO_MODE_SHORT, describeWatch, minutesText, visibleCountdown, watchesOf, watchFor } from '@renderer/features/gpu/AutoClockOut';
import { END_REASON_LABEL, endReasonTone } from '@renderer/features/gpu/model';
import { createDemoTransport, resetDemoRegistry } from '@renderer/lib/demo';
import { rpc } from '@renderer/lib/rpc';
import { setAutoClockOut } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useToasts } from '@renderer/state/toasts';

const watch = (over: Partial<AutoClockOutWatch> = {}): AutoClockOutWatch => ({
  mode: 'unresponsive', armedAt: 1000, source: 'user', stallMinutes: 10, finishGraceMinutes: 2, ...over,
});
const status = (over: Partial<GpuStatus> = {}): GpuStatus => ({ phase: 'ready', message: '', sessionCost: 0, monthCost: 0, monthlyBudget: 100, steps: [], ...over });

describe('helpers', () => {
  it('watchesOf / watchFor read the list, falling back to the single summary of an older core', () => {
    const g = watch({ mode: 'both' });
    const s = watch({ sessionId: 's1', sessionTitle: 'A', mode: 'finished' });
    expect(watchesOf(null)).toEqual([]);
    expect(watchesOf(status())).toEqual([]);
    expect(watchesOf(status({ autoClockOut: g }))).toEqual([g]);
    const st = status({ autoClockOut: g, autoClockOutWatches: [g, s] });
    expect(watchesOf(st)).toEqual([g, s]);
    expect(watchFor(st, null)).toBe(g);
    expect(watchFor(st, 's1')).toBe(s);
    expect(watchFor(st, 's2')).toBeUndefined();
  });

  it('describes a watch in one sentence', () => {
    expect(describeWatch(watch({ mode: 'unresponsive' }))).toBe('The GPU clocks out if the agent stops responding for 10 min.');
    expect(describeWatch(watch({ mode: 'finished', finishGraceMinutes: 0.5, source: 'default' }))).toBe('The GPU clocks out 30 s after the agent finishes (from Settings → Vast.ai).');
    expect(describeWatch(watch({ mode: 'both', sessionId: 's', sessionTitle: 'Fix it' }))).toBe(
      'The GPU clocks out 2 min after “Fix it” finishes, or if “Fix it” stops responding for 10 min.',
    );
    expect(minutesText(10)).toBe('10 min');
    expect(minutesText(1.5)).toBe('1.5 min');
    expect(AUTO_MODE_SHORT.both).toBe('done or stalled');
  });

  it('shows a finish countdown always, but a stall countdown only in its last minute', () => {
    const now = 1_000_000;
    const finishing = watch({ mode: 'finished', pending: { kind: 'finished', at: now + 90_000, reason: 'A finished' } });
    const stalling = watch({ pending: { kind: 'unresponsive', at: now + 300_000, reason: 'B stopped' } });
    expect(visibleCountdown([finishing], now)).toEqual({ at: now + 90_000, reason: 'A finished' });
    expect(visibleCountdown([stalling], now)).toBeNull();
    expect(visibleCountdown([stalling], now + 250_000)).toEqual({ at: now + 300_000, reason: 'B stopped' });
    expect(visibleCountdown([stalling, finishing], now)?.reason).toBe('A finished');
    expect(visibleCountdown([watch()], now)).toBeNull();
  });

  it('labels and tones the two automatic end reasons in the history', () => {
    expect(END_REASON_LABEL.auto_finished).toBe('Auto · finished');
    expect(END_REASON_LABEL.auto_unresponsive).toBe('Auto · unresponsive');
    expect(endReasonTone('auto_finished')).toBe('success');
    expect(endReasonTone('auto_unresponsive')).toBe('warning');
  });
});

describe('demo core + store action', () => {
  let t: ReturnType<typeof createDemoTransport> | null = null;
  afterEach(() => {
    t?.close();
    t = null;
    resetDemoRegistry();
    useToasts.setState({ toasts: [] });
  });

  const open = async () => {
    t = createDemoTransport({ latencyMs: 0, speed: 0 });
    rpc.setTransport(t);
    t.connect();
    await new Promise((r) => setTimeout(r, 5));
    const st = await rpc.request('gpu.status', {});
    useGpu.setState({ status: st });
    return t;
  };

  it('starts with the default watch the demo GPU was clocked in with', async () => {
    await open();
    const list = await rpc.request('gpu.autoClockOut.get', {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ mode: 'unresponsive', source: 'default' });
    expect(list[0].sessionId).toBeUndefined();
  });

  it('set arms, replaces and cancels watches (global first), and mirrors them in gpu.status', async () => {
    await open();
    let list = await rpc.request('gpu.autoClockOut.set', { mode: 'both' });
    expect(list.map((w) => [w.sessionId ?? null, w.mode, w.source])).toEqual([[null, 'both', 'user']]);
    list = await rpc.request('gpu.autoClockOut.set', { sessionId: 's-glm', mode: 'finished' });
    expect(list.map((w) => w.sessionId ?? null)).toEqual([null, 's-glm']);
    expect(list[1].sessionTitle).toBeTruthy();
    const st = await rpc.request('gpu.status', {});
    expect(st.autoClockOut?.mode).toBe('both');
    expect(st.autoClockOutWatches).toHaveLength(2);
    list = await rpc.request('gpu.autoClockOut.set', { sessionId: null, mode: 'off' });
    expect(list.map((w) => w.sessionId)).toEqual(['s-glm']);
    list = await rpc.request('gpu.autoClockOut.set', { sessionId: 's-glm', mode: 'off' });
    expect(list).toEqual([]);
    expect((await rpc.request('gpu.status', {})).autoClockOut).toBeUndefined();
  });

  it('clock-out clears the watches; arming while off is refused; the next clock-in arms the setting default', async () => {
    await open();
    await rpc.request('gpu.clockOut', {});
    await new Promise((r) => setTimeout(r, 1200));
    const off = await rpc.request('gpu.status', {});
    expect(off.phase).toBe('off');
    expect(off.autoClockOut).toBeUndefined();
    await expect(rpc.request('gpu.autoClockOut.set', { mode: 'both' })).rejects.toThrow(/clocked-in GPU/);
    await rpc.request('gpu.autoClockOut.set', { mode: 'off' }); // cancelling is always fine
    await rpc.request('settings.update', { patch: { vast: { autoClockOut: { default: 'finished' } } as never } });
    const settings = await rpc.request('settings.get', {});
    expect(settings.vast.autoClockOut).toEqual({ default: 'finished', stallMinutes: 10, finishGraceMinutes: 2 });
    await rpc.request('gpu.clockIn', { profileId: 'light' });
    expect((await rpc.request('gpu.autoClockOut.get', {}))[0]).toMatchObject({ mode: 'finished', source: 'default' });
  });

  it('the store action arms through the core, patches the status and toasts what it does', async () => {
    await open();
    expect(await setAutoClockOut(null, 'finished')).toBe(true);
    expect(watchFor(useGpu.getState().status, null)?.mode).toBe('finished');
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ title: 'Auto clock-out on', level: 'success' });
    expect(useToasts.getState().toasts.at(-1)?.body).toBe('The GPU clocks out 2 min after the task finishes.');
    expect(await setAutoClockOut(null, 'off')).toBe(true);
    expect(watchesOf(useGpu.getState().status)).toEqual([]);
    expect(useToasts.getState().toasts.at(-1)?.title).toBe('Auto clock-out cancelled');
    await rpc.request('gpu.clockOut', {});
    await new Promise((r) => setTimeout(r, 1200));
    expect(await setAutoClockOut(null, 'both')).toBe(false);
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ title: 'Could not set auto clock-out', level: 'error' });
  });
});
