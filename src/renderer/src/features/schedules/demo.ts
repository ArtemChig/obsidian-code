// Demo-mode data and handlers for the Scheduled view (loaded automatically with ?demo=1). Owner: ui-views.
import type { ScheduledTask } from '@shared/types';
import { registerDemoData, registerDemoHandler } from '@renderer/lib/demo';
import { nextRunAfter, toLocalInput } from './cron';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

registerDemoData((d) => {
  const now = Date.now();
  const cwd = d.settings.defaultCwd;
  const fresh = (t: ScheduledTask): ScheduledTask => ({ ...t, nextRunAt: t.enabled ? nextRunAfter(t.schedule, now) : undefined });
  const tasks: ScheduledTask[] = [
    // Keep next-run times consistent with the cron the seeded tasks carry.
    ...d.schedules.map(fresh),
    {
      id: 'sch-hourly',
      name: 'Check the build server',
      prompt: 'Fetch http://localhost:5173 and report if the dev server is down.',
      cwd,
      schedule: '0 */6 * * *',
      oneShot: false,
      enabled: true,
      model: null,
      permissionMode: 'plan',
      allowAutoClockIn: false,
      createdAt: now - 3 * DAY,
      lastRunAt: now - 2 * HOUR,
      lastRunStatus: 'skipped',
      lastRunMessage: 'Local model was offline',
      nextRunAt: nextRunAfter('0 */6 * * *', now),
    },
    {
      id: 'sch-release',
      name: 'Release notes draft',
      prompt: 'Draft release notes from the git log since the last tag.',
      cwd,
      schedule: toLocalInput(now + 2 * DAY + 3 * HOUR),
      oneShot: true,
      enabled: true,
      model: null,
      permissionMode: 'acceptEdits',
      allowAutoClockIn: false,
      createdAt: now - HOUR,
      nextRunAt: Date.parse(toLocalInput(now + 2 * DAY + 3 * HOUR)),
    },
  ];
  return { schedules: tasks };
});

/** Real next-run times for tasks created or edited in the demo (the built-in handler uses "now + 1 h"). */
registerDemoHandler('schedules.create', async (_p, ctx) => {
  const t = (await ctx.fallback()) as ScheduledTask;
  const live = ctx.data.schedules.find((x) => x.id === t.id);
  const next = t.enabled ? nextRunAfter(t.schedule, Date.now()) : undefined;
  if (live) live.nextRunAt = next;
  ctx.emit('schedules.updated', ctx.data.schedules);
  return { ...t, nextRunAt: next };
});

registerDemoHandler('schedules.update', async (p, ctx) => {
  const t = (await ctx.fallback()) as ScheduledTask;
  const live = ctx.data.schedules.find((x) => x.id === t.id);
  const next = t.enabled ? nextRunAfter(t.schedule, Date.now()) : undefined;
  if (live) live.nextRunAt = next;
  ctx.emit('schedules.updated', ctx.data.schedules);
  void p;
  return { ...t, nextRunAt: next };
});
