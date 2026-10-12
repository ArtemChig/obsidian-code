import { defineTool, ok } from './types';

type NoInput = Record<string, never>;

export const listScheduledTasksTool = defineTool<NoInput>(
  {
    name: 'ListScheduledTasks',
    description: 'List scheduled tasks (id, schedule, next run, last result).',
    inputSchema: { type: 'object', properties: {} },
    concurrencySafe: true,
    permission: () => 'exec',
    title: () => 'List scheduled tasks',
    ruleFor: () => 'ListScheduledTasks',

    async run(_input, ctx) {
      const tasks = ctx.scheduler.list();
      if (tasks.length === 0) return ok('No scheduled tasks.', { display: { kind: 'list', title: 'Scheduled tasks', items: [] } });
      const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '—');
      const lines = tasks.map((t) => {
        const sched = t.oneShot ? `once at ${when(Date.parse(t.schedule))}` : `cron "${t.schedule}"`;
        const last = t.lastRunAt ? `${t.lastRunStatus ?? '?'} at ${when(t.lastRunAt)}${t.lastRunMessage ? ` (${t.lastRunMessage.slice(0, 80)})` : ''}` : 'never run';
        return `- ${t.name} [id: ${t.id}] ${t.enabled ? '' : '(disabled) '}${sched}; next: ${t.enabled ? when(t.nextRunAt) : '—'}; last: ${last}; dir: ${t.cwd.replace(/\\/g, '/')}`;
      });
      return ok(lines.join('\n'), { display: { kind: 'list', title: `Scheduled tasks (${tasks.length})`, items: lines.map((l) => l.slice(2)) } });
    },
  },
);
