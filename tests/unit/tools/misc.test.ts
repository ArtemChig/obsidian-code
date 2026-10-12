import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { askUserQuestionTool } from '../../../src/core/tools/ask-user-question';
import { deleteScheduledTaskTool } from '../../../src/core/tools/delete-scheduled-task';
import { exitPlanModeTool } from '../../../src/core/tools/exit-plan-mode';
import { listScheduledTasksTool } from '../../../src/core/tools/list-scheduled-tasks';
import { notebookEditTool } from '../../../src/core/tools/notebook-edit';
import { readTool } from '../../../src/core/tools/read';
import { parseSchedule, scheduleTaskTool } from '../../../src/core/tools/schedule-task';
import { skillTool } from '../../../src/core/tools/skill';
import { taskTool } from '../../../src/core/tools/task';
import { todoWriteTool } from '../../../src/core/tools/todo-write';
import { cleanupTempDirs, makeCtx, makeTempDir, write } from './helpers';

afterAll(cleanupTempDirs);

const perm = (tool: { permission: (i: never, c: never) => string }, input: unknown = {}) =>
  tool.permission(input as never, { cwd: '.', settings: makeCtx('.').settings } as never);

describe('TodoWrite', () => {
  it('stores todos via ctx.todos and displays them', async () => {
    const ctx = makeCtx(makeTempDir());
    const r = await todoWriteTool.run({
      todos: [
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Ship it', status: 'pending' },
        { content: 'Plan', status: 'completed', id: 'x' },
      ],
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(ctx.todoList).toEqual([
      { id: '1', content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { id: '2', content: 'Ship it', status: 'pending' },
      { id: 'x', content: 'Plan', status: 'completed' },
    ]);
    expect(r.content).toContain('3 items: 1 completed, 1 in progress, 1 pending');
    expect(r.display).toMatchObject({ kind: 'todos' });
  });

  it('repairs sloppy model input (string items, synonyms, JSON string, missing status)', async () => {
    const ctx = makeCtx(makeTempDir());
    const r = await todoWriteTool.run({
      todos: JSON.stringify([{ task: 'A', status: 'In-Progress' }, { content: 'B', status: 'done' }, 'C', { content: 'D' }]),
    } as never, ctx);
    expect(r.isError).toBeFalsy();
    expect(ctx.todoList.map((t) => [t.content, t.status])).toEqual([['A', 'in_progress'], ['B', 'completed'], ['C', 'pending'], ['D', 'pending']]);
  });

  it('validates and de-duplicates ids; an empty list clears; warns about multiple in_progress', async () => {
    const ctx = makeCtx(makeTempDir());
    expect((await todoWriteTool.run({ todos: [{ content: ' ', status: 'pending' }] }, ctx)).isError).toBe(true);
    expect((await todoWriteTool.run({ todos: [{ content: 'a', status: 'weird' }] } as never, ctx)).isError).toBe(true);
    expect((await todoWriteTool.run({} as never, ctx)).isError).toBe(true);
    const dup = await todoWriteTool.run({ todos: [{ id: 'a', content: 'x', status: 'in_progress' }, { id: 'a', content: 'y', status: 'in_progress' }] }, ctx);
    expect(new Set(ctx.todoList.map((t) => t.id)).size).toBe(2);
    expect(dup.content).toContain('only one task');
    await todoWriteTool.run({ todos: [] }, ctx);
    expect(ctx.todoList).toEqual([]);
    expect(perm(todoWriteTool)).toBe('none');
  });
});

describe('AskUserQuestion', () => {
  const q = (over: Record<string, unknown> = {}) => ({
    question: 'Which database?', header: 'Database',
    options: [{ label: 'SQLite', description: 'file based' }, { label: 'Postgres', description: 'server' }], multiSelect: false, ...over,
  });

  it('asks via ctx.askUser and formats the answers', async () => {
    const ctx = makeCtx(makeTempDir());
    ctx.answers = { 'Which database?': 'SQLite', 'Which color?': 'Red, Blue' };
    const r = await askUserQuestionTool.run({ questions: [q(), q({ question: 'Which color?', header: 'A very long header name', multiSelect: true })] } as never, ctx);
    expect(r.isError).toBeFalsy();
    expect(ctx.asked[0]).toHaveLength(2);
    expect(ctx.asked[0][1].header).toBe('A very long');
    expect(r.content).toContain('"Which database?"="SQLite", "Which color?"="Red, Blue"');
    expect(r.display).toMatchObject({ kind: 'questions', answers: ctx.answers });
  });

  it('enforces 1-4 questions and 2-4 options; accepts string options and snake_case multi_select', async () => {
    const ctx = makeCtx(makeTempDir());
    expect((await askUserQuestionTool.run({ questions: [] } as never, ctx)).isError).toBe(true);
    expect((await askUserQuestionTool.run({ questions: [q(), q(), q(), q(), q()] } as never, ctx)).isError).toBe(true);
    expect((await askUserQuestionTool.run({ questions: [q({ options: [{ label: 'only one' }] })] } as never, ctx)).isError).toBe(true);
    expect((await askUserQuestionTool.run({ questions: [q({ options: ['a', 'b', 'c', 'd', 'e'] })] } as never, ctx)).isError).toBe(true);
    ctx.answers = { 'Pick?': 'a' };
    const ok = await askUserQuestionTool.run({ questions: [{ question: 'Pick?', options: ['a', 'b'], multi_select: 'true' }] } as never, ctx);
    expect(ok.isError).toBeFalsy();
    expect(ctx.asked.at(-1)![0]).toMatchObject({ header: 'Q1', multiSelect: true, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] });
    expect(perm(askUserQuestionTool)).toBe('none');
  });

  it('passes through unattended placeholder answers', async () => {
    const ctx = makeCtx(makeTempDir());
    ctx.answers = { 'Which database?': '(no answer — running unattended)' };
    const r = await askUserQuestionTool.run({ questions: [q()] } as never, ctx);
    expect(r.content).toContain('running unattended');
  });
});

describe('Task', () => {
  it('delegates to ctx.runSubagent and returns the report with a subagent display', async () => {
    const ctx = makeCtx(makeTempDir());
    const r = await taskTool.run({ description: 'Find usages', prompt: 'Look for foo()', subagent_type: 'Explore' }, ctx);
    expect(ctx.subagentCalls).toEqual([{ agentType: 'Explore', description: 'Find usages', prompt: 'Look for foo()' }]);
    expect(r.content).toBe('report for Find usages');
    expect(r.display).toEqual({ kind: 'subagent', sessionId: 'sub-1', agentType: 'Explore', description: 'Find usages' });
  });

  it('defaults to general-purpose, accepts alias names, reports failures', async () => {
    const ctx = makeCtx(makeTempDir());
    await taskTool.run({ description: 'd', prompt: 'p' }, ctx);
    expect(ctx.subagentCalls[0].agentType).toBe('general-purpose');
    await taskTool.run({ description: 'd', prompt: 'p', agent_type: 'Plan' } as never, ctx);
    expect(ctx.subagentCalls[1].agentType).toBe('Plan');
    ctx.runSubagent = async () => { throw new Error('unknown agent type'); };
    const bad = await taskTool.run({ description: 'd', prompt: 'p', subagent_type: 'nope' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('unknown agent type');
    expect(perm(taskTool)).toBe('none');
    expect(taskTool.concurrencySafe).toBe(true);
  });
});

describe('ExitPlanMode', () => {
  it('returns approval text and a plan display', async () => {
    const ctx = makeCtx(makeTempDir());
    const r = await exitPlanModeTool.run({ plan: '1. do it' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('approved');
    expect(r.content).toContain('auto-accepted');
    expect(r.display).toEqual({ kind: 'plan', plan: '1. do it' });
    expect(perm(exitPlanModeTool)).toBe('none');
  });

  it('returns feedback when the plan is rejected', async () => {
    const ctx = makeCtx(makeTempDir());
    ctx.planDecision = { approved: false, mode: 'plan', feedback: 'Use Postgres instead' };
    const r = await exitPlanModeTool.run({ plan: 'p' }, ctx);
    expect(r.content).toContain('did not approve');
    expect(r.content).toContain('Use Postgres instead');
    expect((await exitPlanModeTool.run({ plan: '  ' }, ctx)).isError).toBe(true);
  });
});

describe('Skill', () => {
  it('returns the body and base directory, substitutes $ARGUMENTS', async () => {
    const ctx = makeCtx(makeTempDir());
    ctx.skillTable.pdf = { name: 'pdf', body: 'Use pdftotext on $ARGUMENTS.', dir: 'C:\\Users\\me\\.obsidian-code\\skills\\pdf' };
    ctx.skillTable.plain = { name: 'plain', body: 'Just do it.', dir: '/x/plain' };
    const r = await skillTool.run({ skill: '/pdf', args: 'a.pdf' }, ctx);
    expect(r.content).toContain('Base directory for this skill: C:/Users/me/.obsidian-code/skills/pdf');
    expect(r.content).toContain('Use pdftotext on a.pdf.');
    const plain = await skillTool.run({ skill: 'plain', args: 'extra' }, ctx);
    expect(plain.content).toContain('Just do it.\n\nARGUMENTS: extra');
    expect(perm(skillTool)).toBe('none');
  });

  it('lists available skills for unknown names', async () => {
    const ctx = makeCtx(makeTempDir());
    ctx.skillTable.pdf = { name: 'pdf', body: 'b', dir: 'd' };
    const r = await skillTool.run({ skill: 'nope' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Available skills: pdf');
  });
});

describe('NotebookEdit', () => {
  const nb = () => ({
    nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' } },
    cells: [
      { cell_type: 'markdown', id: 'm1', metadata: {}, source: ['# Title'] },
      { cell_type: 'code', id: 'c1', metadata: {}, execution_count: 3, outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }], source: ['print("hi")\n', 'x = 1'] },
    ],
  });
  const setup = async (raw?: string) => {
    const dir = makeTempDir();
    const file = write(dir, 'notebooks/my nb.ipynb', raw ?? `${JSON.stringify(nb(), null, 1)}\n`);
    const ctx = makeCtx(dir);
    await readTool.run({ file_path: 'notebooks/my nb.ipynb' }, ctx);
    return { dir, file, ctx };
  };
  const load = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('replaces a cell source by id, clears outputs, preserves formatting', async () => {
    const { file, ctx } = await setup();
    const r = await notebookEditTool.run({ notebook_path: 'notebooks/my nb.ipynb', cell_id: 'c1', new_source: 'print("bye")\ny = 2' }, ctx);
    expect(r.isError).toBeFalsy();
    const out = load(file);
    expect(out.cells[1].source).toEqual(['print("bye")\n', 'y = 2']);
    expect(out.cells[1].outputs).toEqual([]);
    expect(out.cells[1].execution_count).toBeNull();
    expect(out.cells[0].source).toEqual(['# Title']);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.startsWith('{\n "nbformat"')).toBe(true); // 1-space indent kept
    expect(raw.endsWith('}\n')).toBe(true);
    expect(ctx.checkpoints).toEqual([file]);
    expect(ctx.changes).toHaveLength(1);
    expect(ctx.changes[0]).toMatchObject({ path: file, isNew: false });
    expect(r.display).toMatchObject({ kind: 'diff', before: 'print("hi")\nx = 1', after: 'print("bye")\ny = 2' });
  });

  it('inserts after a cell (with a new id), at the start, and deletes by number', async () => {
    const { file, ctx } = await setup();
    const ins = await notebookEditTool.run({ notebook_path: file, cell_number: 0, new_source: 'import os', cell_type: 'code', edit_mode: 'insert' }, ctx);
    expect(ins.isError).toBeFalsy();
    let out = load(file);
    expect(out.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(['markdown', 'code', 'code']);
    expect(out.cells[1].source).toEqual(['import os']);
    expect(out.cells[1].id).toMatch(/^[0-9a-f]{8}$/);
    expect(out.cells[1].outputs).toEqual([]);

    await notebookEditTool.run({ notebook_path: file, new_source: '## first', cell_type: 'markdown', edit_mode: 'insert' }, ctx);
    out = load(file);
    expect(out.cells[0].source).toEqual(['## first']);
    expect(out.cells[0].outputs).toBeUndefined();

    const del = await notebookEditTool.run({ notebook_path: file, cell_number: 0, edit_mode: 'delete' }, ctx);
    expect(del.isError).toBeFalsy();
    expect(load(file).cells).toHaveLength(3);
  });

  it('can change a cell type and keeps CRLF notebooks CRLF', async () => {
    const crlf = `${JSON.stringify(nb(), null, 1)}\n`.replace(/\n/g, '\r\n');
    const { file, ctx } = await setup(crlf);
    const r = await notebookEditTool.run({ notebook_path: file, cell_id: 'c1', new_source: 'now text', cell_type: 'markdown' }, ctx);
    expect(r.isError).toBeFalsy();
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.includes('\r\n')).toBe(true);
    expect(raw.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const out = JSON.parse(raw);
    expect(out.cells[1].cell_type).toBe('markdown');
    expect(out.cells[1].outputs).toBeUndefined();
  });

  it('requires Read first, valid cells and parameters', async () => {
    const dir = makeTempDir();
    const file = write(dir, 'a.ipynb', JSON.stringify(nb()));
    const ctx = makeCtx(dir);
    const unread = await notebookEditTool.run({ notebook_path: file, cell_id: 'c1', new_source: 'x' }, ctx);
    expect(unread.isError).toBe(true);
    expect(unread.content).toMatch(/Read tool/);
    await readTool.run({ file_path: file }, ctx);
    expect((await notebookEditTool.run({ notebook_path: file, cell_id: 'zzz', new_source: 'x' }, ctx)).content).toContain('No cell with id');
    expect((await notebookEditTool.run({ notebook_path: file, cell_number: 9, new_source: 'x' }, ctx)).content).toContain('out of range');
    expect((await notebookEditTool.run({ notebook_path: file, new_source: 'x' }, ctx)).content).toContain('cell_id or cell_number');
    expect((await notebookEditTool.run({ notebook_path: file, cell_id: 'c1' }, ctx)).content).toContain('new_source is required');
    expect((await notebookEditTool.run({ notebook_path: file, new_source: 'x', edit_mode: 'insert' }, ctx)).content).toContain('cell_type');
    expect((await notebookEditTool.run({ notebook_path: path.join(dir, 'x.txt'), new_source: 'x' }, ctx)).content).toContain('not a .ipynb');
    expect(perm(notebookEditTool)).toBe('edit');
  });
});

describe('Schedule tools', () => {
  it('parseSchedule validates cron, ISO date-times and minimum interval', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(parseSchedule('0 9 * * 1-5', now)).toMatchObject({ schedule: '0 9 * * 1-5', oneShot: false });
    expect(parseSchedule('*/30 * * * *', now)).toMatchObject({ oneShot: false });
    expect(parseSchedule('2026-11-01T09:00:00Z', now)).toMatchObject({ schedule: '2026-11-01T09:00:00.000Z', oneShot: true });
    expect(parseSchedule('2026-10-01T09:00:00Z', now)).toHaveProperty('error');
    expect(parseSchedule('2026-11-01', now)).toHaveProperty('error');
    expect(parseSchedule('* * * * *', now)).toHaveProperty('error');
    expect(parseSchedule('61 * * * *', now)).toHaveProperty('error');
    expect(parseSchedule('every day', now)).toHaveProperty('error');
    expect(parseSchedule('', now)).toHaveProperty('error');
  });

  it('creates, lists and deletes tasks through ctx.scheduler', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir);
    const created = await scheduleTaskTool.run({ name: 'Nightly report', prompt: 'Summarise the git log', schedule: '0 2 * * *', permission_mode: 'acceptEdits' }, ctx);
    expect(created.isError).toBeFalsy();
    expect(ctx.scheduled).toHaveLength(1);
    expect(ctx.scheduled[0]).toMatchObject({ name: 'Nightly report', schedule: '0 2 * * *', oneShot: false, enabled: true, cwd: dir, permissionMode: 'acceptEdits', allowAutoClockIn: false, model: null });
    expect(created.content).toContain('task_1');

    const once = await scheduleTaskTool.run({ name: 'One off', prompt: 'p', schedule: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19), cwd: '.' }, ctx);
    expect(once.isError).toBeFalsy();
    expect(ctx.scheduled[1].oneShot).toBe(true);
    expect(ctx.scheduled[1].permissionMode).toBe('default');

    const list = await listScheduledTasksTool.run({}, ctx);
    expect(list.content).toContain('Nightly report [id: task_1]');
    expect(list.content).toContain('cron "0 2 * * *"');
    expect(list.content).toContain('One off [id: task_2]');

    const del = await deleteScheduledTaskTool.run({ id: 'task_1' }, ctx);
    expect(del.content).toContain('Nightly report');
    expect(ctx.scheduled.map((t) => t.id)).toEqual(['task_2']);
    expect((await deleteScheduledTaskTool.run({ id: 'one off' }, ctx)).isError).toBeFalsy();
    expect((await deleteScheduledTaskTool.run({ id: 'ghost' }, ctx)).isError).toBe(true);
    expect((await listScheduledTasksTool.run({}, ctx)).content).toBe('No scheduled tasks.');
  });

  it('rejects bad schedules and directories; all Schedule tools need exec permission', async () => {
    const ctx = makeCtx(makeTempDir());
    expect((await scheduleTaskTool.run({ name: 'n', prompt: 'p', schedule: 'nonsense' }, ctx)).isError).toBe(true);
    expect((await scheduleTaskTool.run({ name: 'n', prompt: 'p', schedule: '* * * * *' }, ctx)).content).toContain('5 minutes');
    expect((await scheduleTaskTool.run({ name: 'n', prompt: 'p', schedule: '0 9 * * *', cwd: 'does-not-exist' }, ctx)).isError).toBe(true);
    expect((await scheduleTaskTool.run({ name: 'n', schedule: '0 9 * * *' } as never, ctx)).content).toContain('prompt');
    expect(ctx.scheduled).toHaveLength(0);
    for (const t of [scheduleTaskTool, listScheduledTasksTool, deleteScheduledTaskTool]) expect(perm(t)).toBe('exec');
    expect(scheduleTaskTool.title({ name: 'Nightly', prompt: 'p', schedule: '0 2 * * *', permission_mode: 'bypassPermissions' })).toContain('bypassPermissions');
  });
});
