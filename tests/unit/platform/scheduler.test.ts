import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreContext } from '@core/contracts';
import {
  CATCH_UP_WINDOW_MS,
  computeNextRun,
  createScheduler,
  isIsoTimestamp,
  SCHEDULES_KV_KEY,
  validateSchedule,
  type SchedulerImpl,
} from '@core/scheduler/index';
import type { CoreEvents } from '@shared/protocol';
import type { ScheduledTask } from '@shared/types';
import { makeCtx, stubGpu, tempDir, type StubGpu } from './helpers';

let tmp: ReturnType<typeof tempDir>;
let ctx: CoreContext;
let gpu: StubGpu;
let sched: SchedulerImpl;
let notifications: CoreEvents['notification'][];

const baseTask = (over: Partial<ScheduledTask> = {}): Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'> => ({
  name: 'Nightly report',
  prompt: 'Summarise the repo',
  cwd: '',
  schedule: '0 9 * * *',
  oneShot: false,
  enabled: true,
  model: null,
  permissionMode: 'default',
  allowAutoClockIn: false,
  ...over,
});

beforeEach(() => {
  tmp = tempDir();
  gpu = stubGpu();
  ctx = makeCtx(tmp.dir, { gpu });
  ctx.settings.update({ defaultCwd: tmp.dir });
  sched = createScheduler(ctx);
  ctx.scheduler = sched;
  notifications = [];
  ctx.bus.on('notification', (n) => notifications.push(n));
});

afterEach(async () => {
  sched.stop();
  await sched.idle();
  await ctx.sessions.flush();
  tmp.cleanup();
});

describe('schedule helpers', () => {
  it('computes cron next runs in local time', () => {
    const from = new Date(2026, 9, 12, 8, 30, 0).getTime();
    expect(new Date(computeNextRun('0 9 * * *', from)!)).toEqual(new Date(2026, 9, 12, 9, 0, 0));
    const after = new Date(2026, 9, 12, 9, 0, 0).getTime();
    expect(new Date(computeNextRun('0 9 * * *', after)!)).toEqual(new Date(2026, 9, 13, 9, 0, 0));
    // weekdays at 07:15 — 2026-10-17 is a Saturday → next is Monday the 19th
    const sat = new Date(2026, 9, 17, 12, 0, 0).getTime();
    expect(new Date(computeNextRun('15 7 * * 1-5', sat)!)).toEqual(new Date(2026, 9, 19, 7, 15, 0));
  });

  it('handles ISO one-shot timestamps and validation', () => {
    expect(isIsoTimestamp('2026-10-12T09:00:00Z')).toBe(true);
    expect(isIsoTimestamp('0 9 * * *')).toBe(false);
    const ts = Date.parse('2026-10-12T09:00:00Z');
    expect(computeNextRun('2026-10-12T09:00:00Z', ts - 1000)).toBe(ts);
    expect(computeNextRun('2026-10-12T09:00:00Z', ts + 1000)).toBeUndefined();
    expect(validateSchedule('0 9 * * *')).toBeNull();
    expect(validateSchedule('not a cron')).toMatch(/Invalid schedule/);
    expect(validateSchedule('')).toMatch(/empty/);
  });
});

describe('scheduler', () => {
  it('creates, persists and lists tasks with nextRunAt', () => {
    const events: ScheduledTask[][] = [];
    ctx.bus.on('schedules.updated', (l) => events.push(l));
    const t = sched.create(baseTask());
    expect(t.id).toMatch(/^sch_/);
    expect(t.nextRunAt).toBe(computeNextRun('0 9 * * *', t.createdAt));
    expect(t.cwd).toBe(tmp.dir);
    expect(ctx.kv.read<ScheduledTask[]>(SCHEDULES_KV_KEY, [])).toHaveLength(1);
    expect(events.at(-1)?.[0].id).toBe(t.id);
    expect(() => sched.create(baseTask({ schedule: 'bogus' }))).toThrow(/Invalid schedule/);
    expect(() => sched.create(baseTask({ schedule: '2020-01-01T00:00:00Z' }))).toThrow(/past/);

    const off = sched.update(t.id, { enabled: false });
    expect(off.nextRunAt).toBeUndefined();
    const on = sched.update(t.id, { enabled: true, schedule: '*/5 * * * *' });
    expect(on.nextRunAt).toBeGreaterThan(Date.now());
    sched.delete(t.id);
    expect(sched.list()).toEqual([]);
  });

  it('runs a due task in a new scheduled session and records the result', async () => {
    const t = sched.create(baseTask());
    const due = t.nextRunAt!;
    await sched.tick(due + 1000);
    expect(ctx.agent.runHeadless).toHaveBeenCalledTimes(1);
    const call = vi.mocked(ctx.agent.runHeadless).mock.calls[0][0];
    expect(call.prompt).toBe('Summarise the repo');
    const session = ctx.sessions.get(call.sessionId)!;
    expect(session.kind).toBe('scheduled');
    expect(session.scheduleId).toBe(t.id);
    expect(session.title).toMatch(/^Nightly report · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(session.model).toEqual({ provider: 'local', model: 'qwen-local' });

    const after = sched.list()[0];
    expect(after.lastRunStatus).toBe('ok');
    expect(after.lastRunSessionId).toBe(call.sessionId);
    expect(after.lastRunMessage).toBe('All done.');
    expect(after.nextRunAt).toBe(computeNextRun('0 9 * * *', due + 1000));
    expect(after.enabled).toBe(true);
    expect(notifications.at(-1)).toMatchObject({ level: 'success', sessionId: call.sessionId });
    expect(ctx.native.notify).toHaveBeenCalled();
    const act = ctx.activity.list().find((i) => i.kind === 'schedule_run');
    expect(act).toMatchObject({ status: 'done', sessionId: call.sessionId, title: 'Nightly report' });
  });

  it('records failures from the agent', async () => {
    vi.mocked(ctx.agent.runHeadless).mockResolvedValueOnce({ ok: false, finalText: 'model offline' });
    const t = sched.create(baseTask());
    await sched.tick(t.nextRunAt! + 10);
    expect(sched.list()[0]).toMatchObject({ lastRunStatus: 'error', lastRunMessage: 'model offline' });
    expect(notifications.at(-1)?.level).toBe('error');
  });

  it('one-shot tasks disable themselves after running', async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const t = sched.create(baseTask({ schedule: at }));
    expect(t.oneShot).toBe(true);
    await sched.tick(Date.parse(at) + 5);
    const after = sched.list()[0];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeUndefined();
    expect(after.lastRunStatus).toBe('ok');
    await sched.tick(Date.parse(at) + 120_000);
    expect(ctx.agent.runHeadless).toHaveBeenCalledTimes(1);
  });

  it('catches up once on start for runs missed ≤ 24 h ago, skips older ones', async () => {
    const now = Date.now();
    const tasks: ScheduledTask[] = [
      { ...baseTask({ name: 'recent' }), id: 'sch_recent', createdAt: now - 1e8, nextRunAt: now - 2 * 3600_000 },
      { ...baseTask({ name: 'stale' }), id: 'sch_stale', createdAt: now - 1e9, nextRunAt: now - CATCH_UP_WINDOW_MS - 3600_000 },
      { ...baseTask({ name: 'future' }), id: 'sch_future', createdAt: now, nextRunAt: now + 3600_000 },
    ];
    ctx.kv.write(SCHEDULES_KV_KEY, tasks);
    const s2 = createScheduler(ctx);
    s2.start();
    await s2.idle();
    s2.stop();
    expect(ctx.agent.runHeadless).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(s2.list().map((t) => [t.id, t]));
    expect(byId.sch_recent.lastRunStatus).toBe('ok');
    expect(byId.sch_recent.nextRunAt).toBeGreaterThan(now);
    expect(byId.sch_stale.lastRunStatus).toBe('skipped');
    expect(byId.sch_stale.lastRunMessage).toMatch(/while the app was closed/);
    expect(byId.sch_stale.nextRunAt).toBeGreaterThan(now);
    expect(byId.sch_future.lastRunStatus).toBeUndefined();
  });

  it('skips a vast task when the GPU is not ready and auto clock-in is off', async () => {
    const t = sched.create(baseTask({ model: { provider: 'vast', model: 'qwen38-27b-uncensored-hauhau-q5kp' } }));
    await sched.tick(t.nextRunAt! + 1);
    expect(ctx.agent.runHeadless).not.toHaveBeenCalled();
    expect(gpu.clockIn).not.toHaveBeenCalled();
    expect(ctx.sessions.list()).toEqual([]);
    expect(sched.list()[0]).toMatchObject({ lastRunStatus: 'skipped' });
    expect(sched.list()[0].lastRunMessage).toMatch(/not clocked in/);
    expect(notifications.at(-1)?.level).toBe('warning');
    await expect(sched.runNow(t.id)).rejects.toThrow(/not clocked in/);
  });

  it('auto clock-in: clocks in (standard), waits, runs, then clocks out', async () => {
    const order: string[] = [];
    vi.mocked(gpu.clockIn).mockImplementation(async (opts) => {
      order.push(`clockIn:${opts.profileId}:${opts.modelId}`);
      gpu.current = { ...gpu.current, phase: 'ready' };
      return gpu.current;
    });
    vi.mocked(ctx.agent.runHeadless).mockImplementation(async () => {
      order.push('run');
      return { ok: true, finalText: 'ok' };
    });
    vi.mocked(gpu.clockOut).mockImplementation(async (reason) => {
      order.push(`clockOut:${reason}`);
      gpu.current = { ...gpu.current, phase: 'off' };
      return gpu.current;
    });
    const t = sched.create(
      baseTask({ model: { provider: 'vast', model: 'qwen38-27b-uncensored-hauhau-q8kp' }, allowAutoClockIn: true }),
    );
    const r = await sched.runNow(t.id);
    expect(r.sessionId).toBeTruthy();
    await sched.idle();
    expect(order).toEqual(['clockIn:standard:qwen38-27b-uncensored-hauhau-q8kp', 'run', 'clockOut:clock_out']);
    expect(gpu.waitUntilReady).toHaveBeenCalledWith(30 * 60 * 1000);
    expect(sched.list()[0].lastRunStatus).toBe('ok');
    expect(ctx.sessions.get(r.sessionId)!.model).toEqual({ provider: 'vast', model: 'qwen38-27b-uncensored-hauhau-q8kp' });
  });

  it('auto clock-in: does not clock out a GPU it did not clock in', async () => {
    gpu.current = { ...gpu.current, phase: 'ready' };
    const t = sched.create(baseTask({ model: { provider: 'vast', model: 'x' }, allowAutoClockIn: true }));
    await sched.tick(t.nextRunAt! + 1);
    expect(gpu.clockIn).not.toHaveBeenCalled();
    expect(gpu.clockOut).not.toHaveBeenCalled();
    expect(ctx.agent.runHeadless).toHaveBeenCalledTimes(1);
  });

  it('auto clock-in: skipped when the monthly budget is exhausted', async () => {
    gpu.current = { ...gpu.current, monthCost: 199, monthlyBudget: 200 };
    const t = sched.create(baseTask({ model: { provider: 'vast', model: 'x' }, allowAutoClockIn: true }));
    await sched.tick(t.nextRunAt! + 1);
    expect(gpu.clockIn).not.toHaveBeenCalled();
    expect(sched.list()[0].lastRunStatus).toBe('skipped');
    expect(sched.list()[0].lastRunMessage).toMatch(/budget/);
  });

  it('auto clock-in: clocks out and reports an error when the GPU never becomes ready', async () => {
    vi.mocked(gpu.clockIn).mockImplementation(async () => {
      gpu.current = { ...gpu.current, phase: 'loading' };
      return gpu.current;
    });
    vi.mocked(gpu.waitUntilReady).mockResolvedValue(false);
    const t = sched.create(baseTask({ model: { provider: 'vast', model: 'x' }, allowAutoClockIn: true }));
    await sched.tick(t.nextRunAt! + 1);
    expect(ctx.agent.runHeadless).not.toHaveBeenCalled();
    expect(gpu.clockOut).toHaveBeenCalledTimes(1);
    expect(sched.list()[0].lastRunStatus).toBe('error');
    expect(sched.list()[0].lastRunMessage).toMatch(/did not become ready/);
  });
});
