// Scheduler (owner: platform). Tasks persist in kv 'schedules'. croner is used to compute next run times; a single
// re-armed timer (≤ 60 s) fires due tasks, which also covers system sleep and clock changes.
//
// Policy
// * Each due task runs in a new session (kind 'scheduled', scheduleId, title "<name> · <date>") via
//   ctx.agent.runHeadless.
// * Catch-up: a task whose nextRunAt passed while the app was closed (or asleep) runs ONCE if it was due ≤ 24 h ago,
//   otherwise that occurrence is recorded as skipped. The next run is then computed from now.
// * One-shot tasks (ISO timestamp, or oneShot: true with a cron expression) disable themselves after firing.
// * Vast models: if the GPU is not ready → with allowAutoClockIn and enough monthly budget, the scheduler clocks in
//   (profile 'standard', the task's catalog model), waits up to 30 min for ready, runs, and clocks out afterwards —
//   ONLY when the scheduler itself clocked in (shared by concurrent scheduled runs, ref-counted). Otherwise the run is
//   recorded as 'skipped' with the reason.
// * Every run appears in Activity (kind 'schedule_run', stoppable) and ends with a notification.

import { randomBytes } from 'node:crypto';
import { Cron } from 'croner';
import type { GpuPhase, ScheduledTask } from '../../shared/types';
import type { CoreContext, SchedulerApi } from '../contracts';
import { toSummary } from '../store/sessions';

export const SCHEDULES_KV_KEY = 'schedules';
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GPU_READY_TIMEOUT_MS = 30 * 60 * 1000;
export const AUTO_CLOCK_IN_PROFILE = 'standard';
const MAX_TIMER_MS = 60_000;
const TRANSITIONAL: GpuPhase[] = ['searching', 'renting', 'connecting', 'downloading', 'loading', 'switching'];

// ───────────────────────────── schedule helpers ─────────────────────────────

/** True for an ISO-like timestamp ("2026-10-12T09:00", with optional seconds / zone). Cron strings contain spaces. */
export function isIsoTimestamp(schedule: string): boolean {
  const s = schedule.trim();
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Returns an error message, or null when the schedule string is valid. */
export function validateSchedule(schedule: string): string | null {
  const s = (schedule ?? '').trim();
  if (!s) return 'Schedule is empty';
  if (isIsoTimestamp(s)) return null;
  try {
    new Cron(s);
    return null;
  } catch (err) {
    return `Invalid schedule "${s}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Next run strictly after `from` (ms epoch), or undefined (past one-shot / invalid / no future match). */
export function computeNextRun(schedule: string, from: number): number | undefined {
  const s = (schedule ?? '').trim();
  if (!s) return undefined;
  if (isIsoTimestamp(s)) {
    const ts = Date.parse(s);
    return ts > from ? ts : undefined;
  }
  try {
    const next = new Cron(s).nextRun(new Date(from));
    return next ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ───────────────────────────── scheduler ─────────────────────────────

export interface SchedulerImpl extends SchedulerApi {
  start(): void;
  stop(): void;
  /** Fire every due task as of `now` (default Date.now()); resolves when the runs it started have finished. */
  tick(now?: number): Promise<void>;
  /** Resolves when all in-flight runs have finished (tests / shutdown). */
  idle(): Promise<void>;
}

type StartResult = { sessionId: string; done: Promise<void> } | { skipped: string };

export function createScheduler(ctx: CoreContext): SchedulerImpl {
  let tasks: ScheduledTask[] | null = null; // loaded lazily (factories must not touch other modules at construction)
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  const running = new Map<string, Promise<void>>(); // taskId → run
  // GPU auto clock-in bookkeeping (shared by concurrent scheduled runs)
  let gpuUsers = 0;
  let gpuOwned = false;
  let clockInPromise: Promise<unknown> | null = null;

  const load = (): ScheduledTask[] => {
    if (!tasks) {
      const raw = ctx.kv.read<ScheduledTask[]>(SCHEDULES_KV_KEY, []);
      tasks = Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === 'string') : [];
    }
    return tasks;
  };

  const persist = (): void => {
    const list = load();
    ctx.kv.write(SCHEDULES_KV_KEY, list);
    ctx.bus.emit('schedules.updated', structuredClone(list));
  };

  const find = (id: string): ScheduledTask => {
    const t = load().find((x) => x.id === id);
    if (!t) throw new Error(`Scheduled task not found: ${id}`);
    return t;
  };

  const notify = (title: string, body: string, level: 'info' | 'success' | 'warning' | 'error', sessionId?: string): void => {
    ctx.bus.emit('notification', sessionId ? { title, body, level, sessionId } : { title, body, level });
    let enabled = true;
    try {
      enabled = ctx.settings.get().notifications;
    } catch {
      /* ignore */
    }
    if (enabled) {
      try {
        ctx.native.notify(title, body);
      } catch {
        /* ignore */
      }
    }
  };

  // ── timer
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!started) return;
    let next: number | undefined;
    for (const t of load()) {
      if (t.enabled && t.nextRunAt !== undefined && (next === undefined || t.nextRunAt < next)) next = t.nextRunAt;
    }
    const delay = next === undefined ? MAX_TIMER_MS : Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS);
    timer = setTimeout(() => {
      timer = null;
      void tick().catch((err: unknown) => console.error('[scheduler] tick failed:', err));
      arm();
    }, delay);
    timer.unref?.();
  };

  // ── GPU helpers
  const gpuPhase = (): GpuPhase => {
    try {
      return ctx.gpu.status().phase;
    } catch {
      return 'off';
    }
  };

  const profileFor = (modelId: string | undefined): string => {
    const profiles = ctx.settings.get().vast.profiles;
    let candidates: string[] = [];
    try {
      const entry = modelId ? ctx.gpu.catalog().find((m) => m.id === modelId) : undefined;
      if (entry) candidates = entry.profiles;
    } catch {
      /* catalog unavailable */
    }
    const exists = (id: string): boolean => profiles.some((p) => p.id === id);
    if (exists(AUTO_CLOCK_IN_PROFILE) && (candidates.length === 0 || candidates.includes(AUTO_CLOCK_IN_PROFILE))) {
      return AUTO_CLOCK_IN_PROFILE;
    }
    const fromCatalog = candidates.find(exists);
    if (fromCatalog) return fromCatalog;
    if (exists(AUTO_CLOCK_IN_PROFILE)) return AUTO_CLOCK_IN_PROFILE;
    return profiles[0]?.id ?? AUTO_CLOCK_IN_PROFILE;
  };

  /** null = OK to clock in, else the reason it is not allowed. */
  const budgetProblem = (profileId: string): string | null => {
    const st = ctx.gpu.status();
    const settings = ctx.settings.get();
    const budget = st.monthlyBudget > 0 ? st.monthlyBudget : settings.vast.monthlyBudget;
    const spent = st.monthCost ?? 0;
    const cap = settings.vast.profiles.find((p) => p.id === profileId)?.maxPricePerHour ?? 0;
    const remaining = budget - spent;
    if (remaining <= 0 || remaining < cap) {
      return `Monthly GPU budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)} spent)`;
    }
    return null;
  };

  const waitWhileStopping = async (): Promise<void> => {
    const deadline = Date.now() + 120_000;
    while (gpuPhase() === 'stopping' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  };

  // ── runs
  const startRun = (task: ScheduledTask, trigger: 'schedule' | 'manual'): StartResult => {
    if (running.has(task.id)) return { skipped: 'The previous run of this task is still in progress' };

    const needsGpu = task.model?.provider === 'vast';
    let willClockIn = false;
    let recheckAfterGpuStart = false;
    let profileId = AUTO_CLOCK_IN_PROFILE;
    if (needsGpu) {
      const phase = gpuPhase();
      if (phase !== 'ready' && !TRANSITIONAL.includes(phase) && !clockInPromise) {
        if (!task.allowAutoClockIn) return { skipped: 'Vast GPU is not clocked in and auto clock-in is off for this task' };
        profileId = profileFor(task.model?.model);
        const problem = budgetProblem(profileId);
        if (problem) return { skipped: problem };
        willClockIn = true;
      } else if (phase !== 'ready' && task.allowAutoClockIn) {
        // Possibly just the GPU manager's startup check of the instance tracked from the last run (phase
        // 'connecting'): never clock in on top of it; decide again once that check has finished.
        recheckAfterGpuStart = true;
      }
    }

    const settings = ctx.settings.get();
    const startedAt = Date.now();
    let model = task.model;
    if (!model) {
      try {
        model = ctx.models.pickDefault();
      } catch {
        model = null;
      }
    }
    const session = ctx.sessions.create({
      cwd: task.cwd || settings.defaultCwd,
      kind: 'scheduled',
      scheduleId: task.id,
      title: `${task.name} · ${fmtDate(startedAt)}`,
      model,
      permissionMode: task.permissionMode ?? settings.defaultPermissionMode,
      thinking: settings.thinkingByDefault,
    });
    ctx.bus.emit('session.created', toSummary(session));

    const activityId = `schedule:${task.id}:${startedAt}`;
    let stopped = false;
    const activity = (status: 'running' | 'done' | 'error' | 'stopped', detail: string): void => {
      ctx.activity.upsert({
        id: activityId,
        kind: 'schedule_run',
        title: task.name,
        sessionId: session.id,
        status,
        startedAt,
        detail,
      });
    };
    activity('running', trigger === 'manual' ? 'Started manually' : 'Starting');
    ctx.activity.onStop(activityId, () => {
      stopped = true;
      try {
        if (ctx.agent.isRunning(session.id)) ctx.agent.interrupt(session.id);
      } catch {
        /* ignore */
      }
      // Stopped while the scheduler's own clock-in is still booting → stop paying right away.
      if (needsGpu && gpuOwned && gpuUsers <= 1 && gpuPhase() !== 'ready') {
        ctx.gpu.clockOut('clock_out').catch(() => undefined);
      }
    });

    const done = (async () => {
      let status: 'ok' | 'error' = 'error';
      let message = '';
      let usedGpu = false;
      try {
        if (needsGpu) {
          gpuUsers++;
          usedGpu = true;
          if (recheckAfterGpuStart) {
            await ctx.gpu.whenStarted?.();
            const ph = gpuPhase();
            if (ph !== 'ready' && !TRANSITIONAL.includes(ph) && !clockInPromise) {
              profileId = profileFor(task.model?.model);
              const problem = budgetProblem(profileId);
              if (problem) throw new Error(problem);
              willClockIn = true;
            }
          }
          if (gpuPhase() !== 'ready') {
            if (willClockIn && !clockInPromise && !TRANSITIONAL.includes(gpuPhase())) {
              await waitWhileStopping();
              activity('running', `Clocking in GPU (${profileId})…`);
              const p = ctx.gpu.clockIn({ profileId, modelId: task.model?.model });
              clockInPromise = p;
              try {
                await p;
                // Owned only once our clock-in was accepted: a rejected one (e.g. someone else's session is up) must
                // not make the finally block below clock out a GPU this task did not start.
                gpuOwned = true;
              } finally {
                if (clockInPromise === p) clockInPromise = null;
              }
            } else if (clockInPromise) {
              activity('running', 'Waiting for the GPU clock-in…');
              await clockInPromise.catch(() => undefined);
            }
            activity('running', 'Waiting for the GPU to be ready…');
            const ready = await ctx.gpu.waitUntilReady(GPU_READY_TIMEOUT_MS);
            if (!ready) {
              const st = ctx.gpu.status();
              throw new Error(`GPU did not become ready${st.lastError ? `: ${st.lastError}` : ' within 30 minutes'}`);
            }
          }
        }
        if (stopped) throw new Error('Stopped');
        activity('running', 'Running');
        const res = await ctx.agent.runHeadless({ sessionId: session.id, prompt: task.prompt });
        status = res.ok && !stopped ? 'ok' : 'error';
        message = stopped ? 'Stopped' : truncate((res.finalText ?? '').trim(), 300);
      } catch (err) {
        status = 'error';
        message = stopped ? 'Stopped' : err instanceof Error ? err.message : String(err);
      } finally {
        if (usedGpu) {
          gpuUsers--;
          if (gpuUsers <= 0 && gpuOwned) {
            gpuUsers = 0;
            gpuOwned = false;
            try {
              await ctx.gpu.clockOut('clock_out');
            } catch (err) {
              notify(
                'GPU clock-out failed',
                `Scheduled task "${task.name}" could not clock out: ${err instanceof Error ? err.message : String(err)}. Check the GPU view.`,
                'error',
              );
            }
          }
        }
      }

      running.delete(task.id);
      const t = load().find((x) => x.id === task.id);
      if (t) {
        t.lastRunAt = startedAt;
        t.lastRunSessionId = session.id;
        t.lastRunStatus = status;
        t.lastRunMessage = message;
        persist();
      }
      activity(stopped ? 'stopped' : status === 'ok' ? 'done' : 'error', stopped ? 'Stopped' : status === 'ok' ? 'Finished' : message);
      if (!stopped) {
        notify(
          status === 'ok' ? `Scheduled task finished: ${task.name}` : `Scheduled task failed: ${task.name}`,
          message || (status === 'ok' ? 'Done' : 'Unknown error'),
          status === 'ok' ? 'success' : 'error',
          session.id,
        );
      }
    })();
    running.set(task.id, done);
    return { sessionId: session.id, done };
  };

  const recordSkip = (t: ScheduledTask, reason: string, at: number): void => {
    t.lastRunAt = at;
    t.lastRunStatus = 'skipped';
    t.lastRunMessage = reason;
    delete t.lastRunSessionId;
  };

  const tick = async (now: number = Date.now()): Promise<void> => {
    const fired: Promise<void>[] = [];
    let changed = false;
    for (const t of load()) {
      if (!t.enabled) continue;
      if (t.nextRunAt === undefined) {
        const next = computeNextRun(t.schedule, now);
        if (next !== undefined) {
          t.nextRunAt = next;
          changed = true;
        }
        continue;
      }
      if (t.nextRunAt > now) continue;
      const due = t.nextRunAt;
      if (t.oneShot || isIsoTimestamp(t.schedule)) {
        t.enabled = false;
        delete t.nextRunAt;
      } else {
        const next = computeNextRun(t.schedule, now);
        if (next === undefined) delete t.nextRunAt;
        else t.nextRunAt = next;
      }
      changed = true;
      if (now - due > CATCH_UP_WINDOW_MS) {
        recordSkip(t, `Missed the run at ${fmtDate(due)} while the app was closed`, now);
        continue;
      }
      let r: StartResult;
      try {
        r = startRun(t, 'schedule');
      } catch (err) {
        r = { skipped: `Could not start: ${err instanceof Error ? err.message : String(err)}` };
      }
      if ('skipped' in r) {
        if (running.has(t.id)) continue; // overlap: keep the in-flight run's status
        recordSkip(t, r.skipped, now);
        notify(`Scheduled task skipped: ${t.name}`, r.skipped, 'warning');
      } else {
        fired.push(r.done);
      }
    }
    if (changed) persist();
    arm();
    await Promise.all(fired);
  };

  const sanitizeNew = (input: Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'>): ScheduledTask => {
    const settings = ctx.settings.get();
    const name = String(input.name ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    const schedule = String(input.schedule ?? '').trim();
    if (!name) throw new Error('Task name is required');
    if (!prompt) throw new Error('Task prompt is required');
    const err = validateSchedule(schedule);
    if (err) throw new Error(err);
    const now = Date.now();
    const task: ScheduledTask = {
      ...input,
      id: `sch_${randomBytes(6).toString('hex')}`,
      name,
      prompt,
      schedule,
      cwd: input.cwd || settings.defaultCwd,
      oneShot: Boolean(input.oneShot) || isIsoTimestamp(schedule),
      enabled: input.enabled ?? true,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? settings.defaultPermissionMode,
      allowAutoClockIn: Boolean(input.allowAutoClockIn),
      createdAt: now,
    };
    if (task.enabled) {
      // 60 s grace so "once at <now>" from the UI still fires.
      const next = computeNextRun(schedule, isIsoTimestamp(schedule) ? now - 60_000 : now);
      if (next === undefined) throw new Error('The scheduled time is in the past');
      task.nextRunAt = next;
    }
    return task;
  };

  const api: SchedulerImpl = {
    list() {
      return structuredClone(load());
    },
    create(input) {
      const task = sanitizeNew(input);
      load().push(task);
      persist();
      arm();
      return structuredClone(task);
    },
    update(id, patch) {
      const t = find(id);
      const { id: _id, createdAt: _c, nextRunAt: _n, ...rest } = patch ?? {};
      void _id;
      void _c;
      void _n;
      const scheduleChanged = rest.schedule !== undefined && rest.schedule !== t.schedule;
      const enabledChanged = rest.enabled !== undefined && rest.enabled !== t.enabled;
      const next: ScheduledTask = { ...t, ...rest };
      if (rest.name !== undefined && !String(rest.name).trim()) throw new Error('Task name is required');
      if (rest.prompt !== undefined && !String(rest.prompt).trim()) throw new Error('Task prompt is required');
      if (scheduleChanged) {
        next.schedule = String(next.schedule).trim();
        const err = validateSchedule(next.schedule);
        if (err) throw new Error(err);
        if (isIsoTimestamp(next.schedule)) next.oneShot = true;
      }
      if (scheduleChanged || enabledChanged || (next.enabled && next.nextRunAt === undefined)) {
        if (next.enabled) {
          const n = computeNextRun(next.schedule, Date.now());
          if (n === undefined) throw new Error('The scheduled time is in the past');
          next.nextRunAt = n;
        } else {
          delete next.nextRunAt;
        }
      }
      const list = load();
      list[list.indexOf(t)] = next;
      persist();
      arm();
      return structuredClone(next);
    },
    delete(id) {
      const list = load();
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) throw new Error(`Scheduled task not found: ${id}`);
      list.splice(idx, 1);
      persist();
      arm();
    },
    async runNow(id) {
      const t = find(id);
      const r = startRun(t, 'manual');
      if ('skipped' in r) {
        if (!running.has(t.id)) {
          recordSkip(t, r.skipped, Date.now());
          persist();
        }
        throw new Error(r.skipped);
      }
      return { sessionId: r.sessionId };
    },
    start() {
      if (started) return;
      started = true;
      load();
      void tick().catch((err: unknown) => console.error('[scheduler] startup tick failed:', err));
    },
    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick,
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
  return api;
}
