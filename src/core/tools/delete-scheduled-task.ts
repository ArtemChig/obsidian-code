import { defineTool, fail, ok } from './types';

type DeleteInput = { id: string };

export const deleteScheduledTaskTool = defineTool<DeleteInput>(
  {
    name: 'DeleteScheduledTask',
    description: 'Delete a scheduled task by id (or unambiguous name).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    concurrencySafe: false,
    permission: () => 'exec',
    title: (i) => `Delete scheduled task ${i.id ?? ''}`.trim(),
    ruleFor: () => 'DeleteScheduledTask',

    async run(input, ctx) {
      const tasks = ctx.scheduler.list();
      let task = tasks.find((t) => t.id === input.id);
      if (!task) {
        const byName = tasks.filter((t) => t.name.toLowerCase() === input.id.trim().toLowerCase());
        if (byName.length > 1) return fail(`Several scheduled tasks are named "${input.id}". Use one of these ids: ${byName.map((t) => t.id).join(', ')}.`);
        task = byName[0];
      }
      if (!task) {
        return fail(`No scheduled task with id "${input.id}".${tasks.length ? ` Existing: ${tasks.map((t) => `${t.name} (${t.id})`).join(', ')}.` : ' There are no scheduled tasks.'}`);
      }
      ctx.scheduler.delete(task.id);
      return ok(`Deleted scheduled task "${task.name}" (${task.id}).`);
    },
  },
  { aliases: { id: ['task_id', 'taskId', 'name', 'job_id'] } },
);
