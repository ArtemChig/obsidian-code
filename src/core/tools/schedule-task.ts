import { Cron } from 'croner';
import type { PermissionMode } from '../../shared/types';
import { defineTool, fail, ok } from './types';
import { displayPath, resolvePath } from './lib/paths';
import fs from 'node:fs/promises';

type ScheduleInput = {
  name: string;
  prompt: string;
  schedule: string;
  cwd?: string;
  permission_mode?: PermissionMode;
};

const MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface ParsedSchedule { schedule: string; oneShot: boolean; next: Date }

/** Validate a cron expression or ISO date-time. Returns the normalised schedule or an error message. */
export function parseSchedule(raw: string, now = Date.now()): ParsedSchedule | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'schedule must not be empty.' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: 'Include a time of day, e.g. 2026-11-01T09:00:00.' };
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return { error: `Could not parse "${text}" as an ISO 8601 date-time (e.g. 2026-11-01T09:00:00).` };
    if (ms <= now) return { error: `The time ${text} is in the past.` };
    return { schedule: new Date(ms).toISOString(), oneShot: true, next: new Date(ms) };
  }
  const fields = text.split(/\s+/).length;
  if (!text.startsWith('@') && fields !== 5 && fields !== 6) {
    return { error: `"${text}" is neither an ISO date-time nor a 5-field cron expression ("minute hour day-of-month month day-of-week", e.g. "0 9 * * 1-5").` };
  }
  try {
    const job = new Cron(text, { paused: true });
    const runs = job.nextRuns(2);
    job.stop();
    if (runs.length === 0) return { error: `The cron expression "${text}" never fires.` };
    if (runs.length === 2 && runs[1].getTime() - runs[0].getTime() < MIN_INTERVAL_MS) {
      return { error: 'Scheduled tasks may run at most once every 5 minutes. Use a less frequent schedule.' };
    }
    return { schedule: text, oneShot: false, next: runs[0] };
  } catch (e) {
    return { error: `Invalid cron expression "${text}": ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const scheduleTaskTool = defineTool<ScheduleInput>(
  {
    name: 'ScheduleTask',
    description:
      'Schedule a prompt to run later, unattended, in a new session. schedule: 5-field cron for recurring (e.g. "0 9 * * 1-5"; min interval 5 min) or a local ISO date-time for one run (e.g. "2026-11-01T09:00:00"). ' +
      'The prompt must be self-contained; the run cannot ask questions and permission prompts are denied unless permission_mode allows the action.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string', description: 'Complete instructions for the run' },
        schedule: { type: 'string', description: 'Cron or ISO date-time' },
        cwd: { type: 'string', description: 'Working directory (default: current)' },
        permission_mode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Default: current mode' },
      },
      required: ['name', 'prompt', 'schedule'],
    },
    concurrencySafe: false,
    permission: () => 'exec',
    title: (i) => `Schedule "${i.name ?? ''}" (${i.schedule ?? ''}${i.permission_mode && i.permission_mode !== 'default' ? `, ${i.permission_mode}` : ''})`,
    ruleFor: () => 'ScheduleTask',

    async run(input, ctx) {
      const parsed = parseSchedule(input.schedule);
      if ('error' in parsed) return fail(parsed.error);
      const cwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : ctx.cwd;
      try {
        if (!(await fs.stat(cwd)).isDirectory()) return fail(`cwd is not a directory: ${displayPath(cwd, ctx.cwd)}`);
      } catch {
        return fail(`cwd does not exist: ${displayPath(cwd, ctx.cwd)}`);
      }
      const task = ctx.scheduler.create({
        name: input.name.trim(),
        prompt: input.prompt,
        cwd,
        schedule: parsed.schedule,
        oneShot: parsed.oneShot,
        enabled: true,
        model: null,
        permissionMode: input.permission_mode ?? ctx.permissionMode,
        allowAutoClockIn: false,
      });
      const next = task.nextRunAt ? new Date(task.nextRunAt) : parsed.next;
      return ok(
        `Scheduled task created: "${task.name}" (id: ${task.id}).\nSchedule: ${task.oneShot ? `once at ${new Date(task.schedule).toLocaleString()}` : `cron "${task.schedule}"`}\nNext run: ${next.toLocaleString()}\nPermission mode: ${task.permissionMode}`,
        { display: { kind: 'markdown', markdown: `**Scheduled** \`${task.name}\` — ${task.oneShot ? 'once' : `\`${task.schedule}\``} — next run ${next.toLocaleString()}` } },
      );
    },
  },
  { aliases: { name: ['title', 'task_name'], prompt: ['task', 'instructions', 'description'], schedule: ['cron', 'when', 'time', 'cron_expression'], permission_mode: ['permissionMode', 'mode'] } },
);
