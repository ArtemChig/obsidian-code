// Schedule actions: every call catches its error, toasts it and resolves to null/false on failure. Owner: ui-views.
import type { RpcParams } from '@shared/protocol';
import type { ScheduledTask } from '@shared/types';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { useSchedules } from '@renderer/state/activity';
import { toast } from '@renderer/state/toasts';

export type NewSchedule = RpcParams<'schedules.create'>;

function upsert(task: ScheduledTask): void {
  useSchedules.setState((s) => {
    const exists = s.tasks.some((t) => t.id === task.id);
    return { tasks: exists ? s.tasks.map((t) => (t.id === task.id ? task : t)) : [...s.tasks, task], loaded: true };
  });
}

function fail(title: string, err: unknown): null {
  toast({ title, body: errorMessage(err), level: 'error' });
  return null;
}

export async function createSchedule(params: NewSchedule): Promise<ScheduledTask | null> {
  try {
    const task = await rpc.request('schedules.create', params);
    upsert(task);
    toast({ title: 'Schedule created', body: task.name, level: 'success', durationMs: 2500 });
    return task;
  } catch (err) {
    return fail('Could not create the schedule', err);
  }
}

export async function updateSchedule(id: string, patch: Partial<ScheduledTask>, opts: { quiet?: boolean } = {}): Promise<ScheduledTask | null> {
  try {
    const task = await rpc.request('schedules.update', { id, patch });
    upsert(task);
    if (!opts.quiet) toast({ title: 'Schedule saved', body: task.name, level: 'success', durationMs: 2500 });
    return task;
  } catch (err) {
    return fail('Could not save the schedule', err);
  }
}

/** Toggle with an optimistic update that is rolled back when the call fails. */
export async function setScheduleEnabled(id: string, enabled: boolean): Promise<boolean> {
  const prev = useSchedules.getState().tasks.find((t) => t.id === id);
  if (prev) upsert({ ...prev, enabled });
  const result = await updateSchedule(id, { enabled }, { quiet: true });
  if (!result && prev) upsert(prev);
  return !!result;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  try {
    await rpc.request('schedules.delete', { id });
    useSchedules.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    return true;
  } catch (err) {
    fail('Could not delete the schedule', err);
    return false;
  }
}

export async function runScheduleNow(task: ScheduledTask): Promise<string | null> {
  try {
    const r = await rpc.request('schedules.runNow', { id: task.id });
    toast({ title: 'Started', body: task.name, level: 'success', sessionId: r.sessionId, durationMs: 4000 });
    return r.sessionId;
  } catch (err) {
    fail('Could not start the run', err);
    return null;
  }
}
