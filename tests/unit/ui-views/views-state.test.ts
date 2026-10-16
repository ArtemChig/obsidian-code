// ui-views against the demo core: the feature demo extensions load, and the schedule / settings / secret flows work through the stores.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityItem, GpuSessionRecord, GpuStatus, ScheduledTask, Settings } from '@shared/types';
import '@renderer/features/gpu/demo';
import '@renderer/features/activity/demo';
import '@renderer/features/schedules/demo';
import '@renderer/features/settings/demo';
import { createDemoTransport } from '@renderer/lib/demo';
import { rpc } from '@renderer/lib/rpc';
import { setSecret } from '@renderer/state/actions';
import { useActivity, useSchedules } from '@renderer/state/activity';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';
import { useSessions } from '@renderer/state/sessions';
import { useSettings } from '@renderer/state/settings';
import { bindEvents } from '@renderer/state/sync';
import { createSchedule, deleteSchedule, duplicateSchedule, runScheduleNow, setScheduleEnabled, updateSchedule } from '@renderer/features/schedules/actions';
import { nextRunAfter } from '@renderer/features/schedules/cron';
import { patchSearch, patchVast, saveSettings } from '@renderer/features/settings/save';

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// The node type-check sees @renderer/* as `any`; describe the bits of the demo transport this test touches.
interface DemoHandle {
  data: { gpuStatus: GpuStatus };
  emit(event: 'gpu.status', data: GpuStatus): void;
  connect(): void;
}
let transport: DemoHandle;

describe('ui-views with the demo core', () => {
  beforeAll(async () => {
    bindEvents();
    transport = createDemoTransport({ latencyMs: 0, speed: 0 }) as DemoHandle;
    rpc.setTransport(transport as never);
    transport.connect();
    await waitFor(() => useConnection.getState().ready);
  });

  it('loads the demo extensions of every view', async () => {
    const offers = await rpc.request('gpu.offers', { profileId: 'light' });
    expect(offers.length).toBeGreaterThanOrEqual(5);
    const history = await rpc.request('gpu.history', {});
    expect(history.some((r: GpuSessionRecord) => r.endReason === 'budget')).toBe(true);
    expect(history.some((r: GpuSessionRecord) => r.endReason === 'server_watchdog')).toBe(true);
    const kinds = new Set(useActivity.getState().items.map((i: ActivityItem) => i.kind));
    expect(kinds).toEqual(new Set(['session', 'subagent', 'shell', 'schedule_run', 'gpu']));
    expect(useActivity.getState().items.some((i: ActivityItem) => i.status === 'error')).toBe(true);
    const s = useSettings.getState().settings;
    expect(Object.keys(s?.mcpServers ?? {})).toContain('filesystem');
    expect(s?.custom.map((c: Settings['custom'][number]) => c.id)).toContain('lmstudio');
    expect(useSchedules.getState().tasks.some((t: ScheduledTask) => t.oneShot)).toBe(true);
  });

  it('seeded schedules carry real next-run times', () => {
    for (const t of useSchedules.getState().tasks.filter((x: ScheduledTask) => x.enabled)) {
      expect(t.nextRunAt, t.name).toBeGreaterThan(Date.now() - 1000);
    }
  });

  it('creates, edits, toggles and deletes a schedule', async () => {
    const created = await createSchedule({
      name: 'Morning summary',
      prompt: 'Summarize my commits',
      cwd: 'C:\\proj',
      schedule: '0 8 * * 1-5',
      oneShot: false,
      enabled: true,
      model: null,
      permissionMode: 'plan',
      allowAutoClockIn: false,
    });
    expect(created).not.toBeNull();
    const id = (created as ScheduledTask).id;
    const inStore = () => useSchedules.getState().tasks.find((t: ScheduledTask) => t.id === id);
    expect(inStore()?.nextRunAt).toBe(nextRunAfter('0 8 * * 1-5', Date.now()) ?? -1);

    await updateSchedule(id, { schedule: '30 9 * * *' }, { quiet: true });
    expect(inStore()?.schedule).toBe('30 9 * * *');
    expect(new Date(inStore()?.nextRunAt ?? 0).getMinutes()).toBe(30);

    expect(await setScheduleEnabled(id, false)).toBe(true);
    expect(inStore()?.enabled).toBe(false);
    expect(inStore()?.nextRunAt).toBeUndefined();
    expect(await setScheduleEnabled(id, true)).toBe(true);
    expect(inStore()?.nextRunAt).toBeGreaterThan(Date.now());

    expect(await deleteSchedule(id)).toBe(true);
    expect(inStore()).toBeUndefined();
  });

  it('duplicates a schedule as a paused copy without its run history', async () => {
    const source = useSchedules.getState().tasks.find((t: ScheduledTask) => t.id === 'sch-audit') as ScheduledTask;
    expect(source.lastRunAt).toBeDefined();
    const copy = (await duplicateSchedule(source)) as ScheduledTask;
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({ name: 'Nightly dependency audit (copy)', enabled: false, prompt: source.prompt, cwd: source.cwd, schedule: source.schedule, permissionMode: source.permissionMode });
    expect(copy.lastRunAt).toBeUndefined();
    expect(copy.lastRunSessionId).toBeUndefined();
    expect(useSchedules.getState().tasks.some((t: ScheduledTask) => t.id === copy.id)).toBe(true);
    expect(useSchedules.getState().tasks.find((t: ScheduledTask) => t.id === source.id)?.enabled).toBe(source.enabled); // the original is untouched
    await deleteSchedule(copy.id);
  });

  it('run now starts a scheduled session', async () => {
    const task = useSchedules.getState().tasks.find((t: ScheduledTask) => t.id === 'sch-audit') as ScheduledTask;
    const sessionId = await runScheduleNow(task);
    expect(sessionId).toBeTruthy();
    await waitFor(() => !!useSessions.getState().sessions[sessionId as string]);
    expect(useSessions.getState().sessions[sessionId as string]?.kind).toBe('scheduled');
  });

  it('settings patches keep the sibling fields', async () => {
    const before = useSettings.getState().settings;
    expect(await patchVast({ monthlyBudget: 175 })).toBe(true);
    const after = useSettings.getState().settings;
    expect(after?.vast.monthlyBudget).toBe(175);
    expect(after?.vast.profiles).toEqual(before?.vast.profiles);
    expect(after?.vast.idleMinutes).toBe(before?.vast.idleMinutes);

    expect(await patchSearch({ provider: 'searxng', searxngUrl: 'http://127.0.0.1:8888' })).toBe(true);
    expect(useSettings.getState().settings?.search).toEqual({ provider: 'searxng', searxngUrl: 'http://127.0.0.1:8888' });

    // mcpServers / hooks are replaced as a whole
    expect(await saveSettings({ mcpServers: { only: { command: 'node' } } })).toBe(true);
    expect(Object.keys(useSettings.getState().settings?.mcpServers ?? {})).toEqual(['only']);
  });

  it('secrets are write-only: only their presence reaches the store', async () => {
    expect(await setSecret('custom.lmstudio.apiKey', 'sk-test')).toBe(true);
    expect(useSettings.getState().secrets['custom.lmstudio.apiKey']).toBe(true);
    const has = await rpc.request('secrets.has', { names: ['custom.lmstudio.apiKey'] });
    expect(has).toEqual({ 'custom.lmstudio.apiKey': true });
    expect(JSON.stringify(useSettings.getState())).not.toContain('sk-test');
    expect(await setSecret('custom.lmstudio.apiKey', null)).toBe(true);
    expect(useSettings.getState().secrets['custom.lmstudio.apiKey']).toBe(false);
  });

  it('destroying orphans clears them from the GPU status', async () => {
    transport.data.gpuStatus = { ...transport.data.gpuStatus, orphanInstanceIds: [11, 22] };
    transport.emit('gpu.status', transport.data.gpuStatus);
    await waitFor(() => (useGpu.getState().status?.orphanInstanceIds ?? []).length === 2);
    const r = await rpc.request('gpu.destroyOrphans', {});
    expect(r.destroyed).toEqual([11, 22]);
    await waitFor(() => (useGpu.getState().status?.orphanInstanceIds ?? []).length === 0);
  });
});
