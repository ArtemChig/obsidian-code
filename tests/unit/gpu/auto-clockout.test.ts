// Auto clock-out: arming (default at clock-in, RPC set), the 'unresponsive' and 'finished' rules, and what happens when
// a watch fires. All fakes: a bus, in-memory sessions, a stub GPU manager and a manual clock (nothing touches Vast).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreContext } from '../../../src/core/contracts';
import { AutoClockOut, REASONING_NOTE_MARKER, REASONING_ONLY_LIMIT } from '../../../src/core/gpu/auto-clockout';
import { CONTINUE_AFTER_THINKING_NOTE } from '../../../src/core/agent/manager';
import { wrapReminder } from '../../../src/core/agent/prompt';
import { createEventBus } from '../../../src/core/server/bus';
import type { CoreEvents } from '../../../src/shared/protocol';
import type { AutoClockOutChoice, GpuPhase, GpuSessionRecord, GpuStatus, Message, SessionStatus, SessionSummary, ToolUseBlock } from '../../../src/shared/types';

const MIN = 60_000;
const STEP = 10_000;
type EndReason = NonNullable<GpuSessionRecord['endReason']>;

interface Env {
  ac: AutoClockOut;
  ctx: CoreContext;
  bus: ReturnType<typeof createEventBus>;
  clock: { t: number };
  gpu: { phase: GpuPhase; clockOut: ReturnType<typeof vi.fn>; extras: ((s: GpuStatus) => Partial<GpuStatus>) | null };
  agent: { interrupt: ReturnType<typeof vi.fn>; busy: Set<string> };
  notifications: CoreEvents['notification'][];
  statuses: GpuStatus[];
  sessions: Map<string, SessionSummary>;
  limits: { default: AutoClockOutChoice; stallMinutes: number; finishGraceMinutes: number };
  addSession(id: string, over?: Partial<SessionSummary>): SessionSummary;
  setStatus(id: string, status: SessionStatus): void;
  setPhase(phase: GpuPhase): void;
  /** Advance the clock in 10 s ticks (the evaluation interval), calling tick() each time. */
  advance(ms: number): Promise<void>;
  /** Same, but let microtasks (a fired clock-out) settle afterwards. */
  settle(): Promise<void>;
}

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, title: `Session ${id}`, cwd: '/p', kind: 'chat', createdAt: 0, updatedAt: 0, status: 'idle', model: { provider: 'vast', model: 'm' },
    permissionMode: 'default', thinking: true, usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 }, ...over,
  };
}

function makeEnv(opts: { phase?: GpuPhase; limits?: Partial<Env['limits']>; clockOutFails?: boolean } = {}): Env {
  const bus = createEventBus();
  const clock = { t: 1_000_000_000 };
  const sessions = new Map<string, SessionSummary>();
  const limits: Env['limits'] = { default: 'unresponsive', stallMinutes: 10, finishGraceMinutes: 2, ...(opts.limits ?? {}) };
  const notifications: CoreEvents['notification'][] = [];
  const statuses: GpuStatus[] = [];
  bus.on('notification', (n) => notifications.push(n));
  bus.on('gpu.status', (s) => statuses.push(s));
  const gpu: Env['gpu'] = { phase: opts.phase ?? 'off', extras: null, clockOut: vi.fn() };
  const status = (): GpuStatus => {
    const st: GpuStatus = { phase: gpu.phase, message: '', sessionCost: 0, monthCost: 0, monthlyBudget: 100, steps: [] };
    return gpu.extras ? { ...st, ...gpu.extras(st) } : st;
  };
  const env = {} as Env;
  const setPhase = (phase: GpuPhase): void => {
    gpu.phase = phase;
    bus.emit('gpu.status', status());
  };
  gpu.clockOut.mockImplementation(async (reason: EndReason, note?: string) => {
    void reason;
    void note;
    if (opts.clockOutFails) throw new Error('boom');
    setPhase('stopping');
    setPhase('off');
    return status();
  });
  const agent: Env['agent'] = { interrupt: vi.fn(), busy: new Set() };
  const ctx = {
    bus,
    sessions: { list: () => [...sessions.values()], get: (id: string) => sessions.get(id) },
    settings: { get: () => ({ defaultModel: null, vast: { autoClockOut: limits } }) },
    gpu: { status, clockOut: gpu.clockOut, setStatusExtras: (fn: Env['gpu']['extras']) => void (gpu.extras = fn) },
    agent: { interrupt: agent.interrupt, isRunning: (id: string) => agent.busy.has(id) },
  } as unknown as CoreContext;
  const ac = new AutoClockOut(ctx, { now: () => clock.t, tickMs: STEP, sleepGapMs: Infinity });
  Object.assign(env, {
    ac, ctx, bus, clock, gpu, agent, notifications, statuses, sessions, limits, setPhase,
    addSession(id: string, over: Partial<SessionSummary> = {}) {
      const s = summary(id, over);
      sessions.set(id, s);
      bus.emit('session.created', s);
      return s;
    },
    setStatus(id: string, st: SessionStatus) {
      const s = { ...sessions.get(id)!, status: st };
      sessions.set(id, s);
      bus.emit('session.updated', s);
    },
    async advance(ms: number) {
      for (let left = ms; left > 0; left -= STEP) {
        clock.t += Math.min(STEP, left);
        ac.tick();
      }
      await env.settle();
    },
    async settle() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  });
  ac.start();
  return env;
}

let live: Env | null = null;
function env(opts?: Parameters<typeof makeEnv>[0]): Env {
  live?.ac.dispose();
  live = makeEnv(opts);
  return live;
}
afterEach(() => {
  live?.ac.dispose();
  live = null;
});

/** A clocked-in, ready GPU. */
function ready(e: Env): void {
  e.setPhase('searching');
  e.setPhase('ready');
}

const progress = (e: Env, id: string) => e.bus.emit('message.delta', { sessionId: id, messageId: 'm', blockIndex: 0, blockType: 'text', delta: 'x' });
const thinking = (e: Env, id: string) => e.bus.emit('message.delta', { sessionId: id, messageId: 'm', blockIndex: 0, blockType: 'thinking', delta: 'hmm' });
const hookMessage = (e: Env, id: string, text = CONTINUE_AFTER_THINKING_NOTE) => {
  const message: Message = { id: `h${Math.random()}`, role: 'user', tag: 'hook', createdAt: 0, blocks: [{ type: 'text', text: wrapReminder(text) }] };
  e.bus.emit('message.added', { sessionId: id, message });
};
const toolRan = (e: Env, id: string, status: ToolUseBlock['status'] = 'done', toolId = 't') =>
  e.bus.emit('tool.updated', { sessionId: id, messageId: 'm', tool: { type: 'tool_use', id: toolId, name: 'Bash', input: {}, status } as ToolUseBlock });

describe('arming', () => {
  it('arms the default watch at clock-in, shows it in the status, and clears it when the GPU clocks out', () => {
    const e = env();
    expect(e.ac.list()).toEqual([]);
    e.setPhase('searching');
    expect(e.ac.list()).toHaveLength(1);
    expect(e.ac.list()[0]).toMatchObject({ mode: 'unresponsive', source: 'default', stallMinutes: 10, finishGraceMinutes: 2 });
    expect(e.ac.list()[0].sessionId).toBeUndefined();
    // the status that carries the clock-in is delivered first; the watch follows right after it
    return Promise.resolve().then(() => {
      const last = e.statuses[e.statuses.length - 1];
      expect(last.autoClockOut?.mode).toBe('unresponsive');
      expect(last.autoClockOutWatches).toHaveLength(1);
      e.setPhase('stopping');
      expect(e.ac.list()).toEqual([]);
      // never reported for a GPU that is not rented
      expect(e.gpu.extras!({ phase: 'off' } as GpuStatus)).toEqual({});
      expect(e.gpu.extras!({ phase: 'stopping' } as GpuStatus)).toEqual({});
      e.setPhase('off');
      e.setPhase('searching');
      expect(e.ac.list()).toHaveLength(1); // armed again for the next clock-in
    });
  });

  it('arms nothing when the default is off, and honours both/finished', () => {
    const e1 = env({ limits: { default: 'off' } });
    e1.setPhase('searching');
    expect(e1.ac.list()).toEqual([]);
    const e2 = env({ limits: { default: 'both' } });
    e2.setPhase('searching');
    expect(e2.ac.list()[0].mode).toBe('both');
  });

  it('adopts a GPU that is already rented when the module starts (app restart)', () => {
    const e = env({ phase: 'connecting' });
    expect(e.ac.list()).toHaveLength(1);
  });

  it('set(): needs a clocked-in GPU, validates, replaces, and off cancels', () => {
    const e = env();
    expect(() => e.ac.set({ mode: 'both' })).toThrow(/clocked-in GPU/);
    expect(e.ac.set({ mode: 'off' })).toEqual([]);
    ready(e);
    e.addSession('a');
    e.ac.set({ mode: 'finished' });
    expect(e.ac.list()).toHaveLength(1); // replaced the default global watch
    expect(e.ac.list()[0]).toMatchObject({ mode: 'finished', source: 'user' });
    e.ac.set({ sessionId: 'a', mode: 'both' });
    expect(e.ac.list().map((w) => [w.sessionId ?? null, w.mode])).toEqual([[null, 'finished'], ['a', 'both']]);
    expect(e.ac.list()[1].sessionTitle).toBe('Session a');
    expect(() => e.ac.set({ sessionId: 'nope', mode: 'both' })).toThrow(/not found/);
    expect(() => e.ac.set({ mode: 'sometimes' as AutoClockOutChoice })).toThrow(/Unknown/);
    e.ac.set({ sessionId: 'a', mode: 'off' });
    expect(e.ac.list().map((w) => w.sessionId ?? null)).toEqual([null]);
    e.ac.set({ sessionId: null, mode: 'off' });
    expect(e.ac.list()).toEqual([]);
  });

  it('refuses to watch a subagent, and drops a session watch when the session is deleted', () => {
    const e = env();
    ready(e);
    e.addSession('p');
    e.addSession('sub', { kind: 'subagent', parentSessionId: 'p' });
    expect(() => e.ac.set({ sessionId: 'sub', mode: 'both' })).toThrow(/subagent/);
    e.ac.set({ sessionId: 'p', mode: 'both' });
    e.bus.emit('session.deleted', { sessionId: 'p' });
    expect(e.ac.list().some((w) => w.sessionId === 'p')).toBe(false);
  });
});

describe("'unresponsive'", () => {
  it('interrupts the stuck session and clocks out after 10 min without progress, saying why', async () => {
    const e = env();
    ready(e);
    e.addSession('a', { title: 'Fix the parser' });
    e.setStatus('a', 'running');
    await e.advance(9 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(MIN + STEP);
    expect(e.agent.interrupt).toHaveBeenCalledWith('a');
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_unresponsive', 'Fix the parser stopped responding for 10 min');
    // interrupt first, then clock out
    expect(e.agent.interrupt.mock.invocationCallOrder[0]).toBeLessThan(e.gpu.clockOut.mock.invocationCallOrder[0]);
    const n = e.notifications.filter((x) => x.title === 'GPU clocked out');
    expect(n).toHaveLength(1);
    expect(n[0].body).toBe('Fix the parser stopped responding for 10 min.');
    expect(n[0].level).toBe('warning');
    expect(n[0].sessionId).toBe('a');
    expect(e.ac.list()).toEqual([]); // gone after it fired
  });

  it('counts every kind of progress (deltas, blocks, tools, prefill, new messages) and restarts the timer', async () => {
    const e = env();
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    const kinds: (() => void)[] = [
      () => progress(e, 'a'),
      () => thinking(e, 'a'),
      () => toolRan(e, 'a'),
      () => e.bus.emit('message.progress', { sessionId: 'a', messageId: 'm', phase: 'prefill', progress: 0.5 }),
      () => e.bus.emit('message.block', { sessionId: 'a', messageId: 'm', blockIndex: 0, block: { type: 'text', text: 'x' } }),
      () => e.bus.emit('message.added', { sessionId: 'a', message: { id: 'z', role: 'assistant', createdAt: 0, blocks: [] } }),
    ];
    for (const kind of kinds) {
      await e.advance(8 * MIN);
      kind();
    }
    await e.advance(8 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(3 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it("a subagent's activity counts as progress of the session it runs in", async () => {
    const e = env();
    ready(e);
    e.addSession('a');
    e.addSession('sub', { kind: 'subagent', parentSessionId: 'a' });
    e.setStatus('a', 'running');
    for (let i = 0; i < 4; i++) {
      await e.advance(8 * MIN);
      progress(e, 'sub');
    }
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
  });

  it('three reasoning-only turns in a row (the loop injects a hook message each time) = stuck, at once', async () => {
    const e = env();
    ready(e);
    e.addSession('a', { title: 'Loop' });
    e.setStatus('a', 'running');
    for (let i = 0; i < REASONING_ONLY_LIMIT - 1; i++) {
      thinking(e, 'a');
      hookMessage(e, 'a');
      await e.advance(STEP);
    }
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    thinking(e, 'a');
    hookMessage(e, 'a');
    await e.advance(STEP);
    expect(e.agent.interrupt).toHaveBeenCalledWith('a');
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_unresponsive', 'Loop ended 3 turns in a row with reasoning only and no answer');
  });

  it('a tool call, an answer or a new user message between the reasoning-only turns resets the count', async () => {
    const e = env();
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    hookMessage(e, 'a');
    hookMessage(e, 'a');
    toolRan(e, 'a'); // the model recovered
    hookMessage(e, 'a');
    hookMessage(e, 'a');
    progress(e, 'a'); // an answer started streaming
    hookMessage(e, 'a');
    hookMessage(e, 'a');
    e.bus.emit('message.added', { sessionId: 'a', message: { id: 'u', role: 'user', createdAt: 0, blocks: [{ type: 'text', text: 'keep going' }] } });
    hookMessage(e, 'a');
    hookMessage(e, 'a');
    await e.advance(30 * STEP);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
  });

  it('only counts the loop\'s own reminder: other hook messages are ignored', async () => {
    const e = env();
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    for (let i = 0; i < 5; i++) hookMessage(e, 'a', 'A Stop hook asked you to continue: run the tests');
    await e.advance(3 * STEP);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    expect(CONTINUE_AFTER_THINKING_NOTE).toContain(REASONING_NOTE_MARKER);
  });

  it('a tool call that is running gets 10 more minutes (a silent build is not a hung model)', async () => {
    const e = env();
    ready(e);
    e.addSession('a', { title: 'Builder' });
    e.setStatus('a', 'running');
    toolRan(e, 'a', 'running', 'build');
    await e.advance(19 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    toolRan(e, 'a', 'done', 'build'); // it finished at 19 min: the normal limit counts from here
    await e.advance(9 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(2 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_unresponsive', 'Builder stopped responding for 10 min');
    // ...but a tool that never comes back is stuck too
    const e2 = env();
    ready(e2);
    e2.addSession('a');
    e2.setStatus('a', 'running');
    toolRan(e2, 'a', 'running', 'hang');
    await e2.advance(21 * MIN);
    expect(e2.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it('a tool left running by a turn that ended does not extend the next turn', async () => {
    const e = env();
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    toolRan(e, 'a', 'running', 'x'); // never reported done (interrupted)
    e.setStatus('a', 'idle');
    e.setStatus('a', 'running');
    await e.advance(11 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it('a session waiting for the user longer than the limit counts too', async () => {
    const e = env();
    ready(e);
    e.addSession('a', { title: 'Needs OK' });
    e.setStatus('a', 'running');
    await e.advance(MIN);
    e.setStatus('a', 'waiting');
    await e.advance(9 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(MIN + STEP);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_unresponsive', 'Needs OK waited for your input for 10 min');
    expect(e.agent.interrupt).toHaveBeenCalledWith('a');
  });

  it('an idle session is not unresponsive, and the stall limit follows the setting', async () => {
    const e = env({ limits: { stallMinutes: 1 } });
    ready(e);
    e.addSession('a');
    await e.advance(30 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.setStatus('a', 'running');
    await e.advance(MIN + STEP);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_unresponsive', 'Session a stopped responding for 1 min');
  });

  it('a global watch needs EVERY active session stuck: one healthy session keeps the GPU', async () => {
    const e = env();
    ready(e);
    e.addSession('stuck');
    e.addSession('busy');
    e.setStatus('stuck', 'running');
    e.setStatus('busy', 'running');
    for (let i = 0; i < 6; i++) {
      await e.advance(4 * MIN);
      progress(e, 'busy');
    }
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(11 * MIN); // busy stops too
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
    expect(e.gpu.clockOut.mock.calls[0][1]).toBe('2 sessions stopped responding for 10 min');
    expect(e.agent.interrupt).toHaveBeenCalledWith('stuck');
    expect(e.agent.interrupt).toHaveBeenCalledWith('busy');
  });

  it('a global watch ignores sessions that do not use the Vast.ai provider; a session watch does not care', async () => {
    const e = env();
    ready(e);
    e.addSession('local', { model: { provider: 'local', model: 'x' } });
    e.setStatus('local', 'running');
    await e.advance(30 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.ac.set({ sessionId: 'local', mode: 'unresponsive' });
    await e.advance(11 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it('does not count time while the GPU is not serving (loading, switching model): the timers restart at ready', async () => {
    const e = env();
    e.setPhase('searching');
    e.addSession('a');
    e.setStatus('a', 'running');
    e.setPhase('loading');
    await e.advance(30 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.setPhase('ready');
    await e.advance(9 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.setPhase('switching');
    await e.advance(20 * MIN);
    e.setPhase('ready');
    await e.advance(9 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(2 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it('does not count the time the PC slept', async () => {
    const e = env();
    // fresh module with the sleep detection on
    e.ac.dispose();
    const clock = e.clock;
    const ac = new AutoClockOut(e.ctx, { now: () => clock.t, tickMs: STEP, sleepGapMs: 30_000 });
    ac.start();
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    clock.t += STEP;
    ac.tick();
    clock.t += 8 * 3_600_000; // the PC slept for 8 hours
    ac.tick();
    await e.settle();
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    for (let i = 0; i < 30; i++) {
      clock.t += STEP;
      ac.tick();
    }
    expect(e.gpu.clockOut).not.toHaveBeenCalled(); // 5 min since waking
    for (let i = 0; i < 33; i++) {
      clock.t += STEP;
      ac.tick();
    }
    await e.settle();
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
    ac.dispose();
  });
});

describe("'finished'", () => {
  it('clocks out 2 min after the watched session stopped running', async () => {
    const e = env({ limits: { default: 'off' } });
    ready(e);
    e.addSession('a', { title: 'Refactor' });
    e.setStatus('a', 'running');
    e.ac.set({ sessionId: 'a', mode: 'finished' });
    await e.advance(30 * MIN); // running for a long time: not finished
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.setStatus('a', 'idle');
    await e.advance(MIN + 40_000);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    await e.advance(30_000);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_finished', 'Refactor finished (idle for 2 min)');
    expect(e.agent.interrupt).not.toHaveBeenCalled();
    const n = e.notifications.find((x) => x.title === 'GPU clocked out')!;
    expect(n.body).toBe('Refactor finished (idle for 2 min).');
    expect(n.level).toBe('success');
  });

  it('idle, error and waiting-for-input all count as "not running"', async () => {
    for (const end of ['idle', 'error', 'waiting'] as const) {
      const e = env({ limits: { default: 'finished' } });
      ready(e);
      e.addSession('a');
      e.setStatus('a', 'running');
      await e.advance(STEP);
      e.setStatus('a', end);
      await e.advance(2 * MIN + STEP);
      expect(e.gpu.clockOut, end).toHaveBeenCalledTimes(1);
    }
  });

  it('starts counting only after something ran: a freshly clocked-in GPU is not clocked out for being idle', async () => {
    const e = env({ limits: { default: 'finished' } });
    ready(e);
    e.addSession('a');
    await e.advance(30 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    expect(e.ac.list()[0].pending).toBeUndefined();
    e.setStatus('a', 'running');
    await e.advance(MIN);
    e.setStatus('a', 'idle');
    await e.advance(2 * MIN + STEP);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it('a new run, or a queued message, cancels the countdown', async () => {
    const e = env({ limits: { default: 'finished' } });
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    e.setStatus('a', 'idle');
    await e.advance(100_000);
    e.setStatus('a', 'running'); // started again
    await e.advance(5 * MIN);
    e.setStatus('a', 'idle');
    await e.advance(100_000);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.agent.busy.add('a'); // the loop is still busy: messages are queued
    await e.advance(10 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    e.agent.busy.delete('a');
    await e.advance(2 * MIN + STEP);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
  });

  it('a global watch waits until no Vast session is running', async () => {
    const e = env({ limits: { default: 'finished' } });
    ready(e);
    e.addSession('a');
    e.addSession('b');
    e.addSession('local', { model: { provider: 'local', model: 'x' } });
    e.setStatus('a', 'running');
    e.setStatus('b', 'running');
    e.setStatus('local', 'running');
    await e.advance(MIN);
    e.setStatus('a', 'idle');
    await e.advance(10 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled(); // b still runs (the local one does not matter)
    e.setStatus('b', 'idle');
    await e.advance(2 * MIN + STEP);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_finished', 'No session has been running on the GPU for 2 min');
  });

  it('exposes the countdown while it runs', async () => {
    const e = env({ limits: { default: 'finished' } });
    ready(e);
    e.addSession('a', { title: 'T' });
    e.setStatus('a', 'running');
    e.setStatus('a', 'idle');
    await e.advance(30_000);
    const w = e.ac.list()[0];
    expect(w.pending?.kind).toBe('finished');
    expect(w.pending!.at - e.clock.t).toBe(100_000); // counted from the first tick that saw it idle
    expect(e.gpu.extras!({ phase: 'ready' } as GpuStatus).autoClockOut?.pending?.kind).toBe('finished');
  });
});

describe('both modes together, and when a clock-out cannot happen', () => {
  it('whichever comes first wins', async () => {
    const e = env({ limits: { default: 'both' } });
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    e.setStatus('a', 'idle'); // finished
    await e.advance(2 * MIN + STEP);
    expect(e.gpu.clockOut).toHaveBeenCalledWith('auto_finished', expect.any(String));
    const e2 = env({ limits: { default: 'both' } });
    ready(e2);
    e2.addSession('a');
    e2.setStatus('a', 'running');
    await e2.advance(10 * MIN + STEP); // stuck
    expect(e2.gpu.clockOut).toHaveBeenCalledWith('auto_unresponsive', expect.any(String));
  });

  it('never acts when the GPU is not ready', async () => {
    const e = env({ limits: { default: 'both' } });
    e.setPhase('searching');
    e.addSession('a');
    e.setStatus('a', 'running');
    e.setStatus('a', 'idle');
    await e.advance(10 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
  });

  it('a failed clock-out is reported, the watch is restored, and it does not retry in a tight loop', async () => {
    const e = env({ clockOutFails: true });
    ready(e);
    e.addSession('a', { title: 'Hung' });
    e.setStatus('a', 'running');
    await e.advance(11 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
    const fail = e.notifications.find((x) => x.title === 'Auto clock-out failed')!;
    expect(fail.level).toBe('error');
    expect(fail.body).toContain('Hung stopped responding for 10 min');
    expect(fail.body).toContain('boom');
    expect(e.notifications.some((x) => x.title === 'GPU clocked out')).toBe(false);
    expect(e.ac.list()).toHaveLength(1); // still guarding the (still rented) GPU
    await e.advance(3 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(1);
    await e.advance(3 * MIN);
    expect(e.gpu.clockOut).toHaveBeenCalledTimes(2); // retried after the back-off
  });

  it('a clock-out by someone else cancels everything (and nothing is clocked out twice)', async () => {
    const e = env({ limits: { default: 'both' } });
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    e.setPhase('stopping');
    e.setPhase('off');
    await e.advance(30 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    expect(e.ac.list()).toEqual([]);
  });

  it('dispose() stops it without clocking out', async () => {
    const e = env();
    ready(e);
    e.addSession('a');
    e.setStatus('a', 'running');
    e.ac.dispose();
    await e.advance(60 * MIN);
    expect(e.gpu.clockOut).not.toHaveBeenCalled();
    expect(e.gpu.extras).toBeNull();
  });
});
