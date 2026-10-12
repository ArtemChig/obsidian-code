import { existsSync, promises as fs, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@shared/types';
import { setMaxConcurrent } from '@core/llm/dialect';
import { lastUserText, type MockRequest } from '../../fixtures/mock-llm/server';
import { createHarness, toolLog, type Harness } from './helpers';

let h: Harness;
afterEach(async () => { await h?.close(); toolLog.length = 0; });

const tools = (hh: Harness, id: string) => hh.session(id).messages.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
const isTitle = (r: MockRequest) => lastUserText(r).startsWith('Write a short title');
const isSummary = (r: MockRequest) => String(r.body.messages?.[0]?.content ?? '').startsWith('You compress coding-agent conversations');
const systemOf = (r: MockRequest) => String(r.body.messages?.[0]?.content ?? '');

describe('subagents', () => {
  it('Task runs a child session (kind subagent, parent ids, restricted tools, own prompt) and returns its report', async () => {
    h = await createHarness();
    const s = h.createSession();
    const isChild = (r: MockRequest) => systemOf(r).includes('subagent of Obsidian Code');
    h.mock.enqueue(
      { match: (r) => !isChild(r), toolCalls: [{ name: 'Task', arguments: { description: 'Find config', prompt: 'Find the config file', subagent_type: 'Explore' } }] },
      { match: isChild, toolCalls: [{ name: 'Read', arguments: { file_path: 'cfg.json' } }] },
      { match: isChild, text: 'Config is in cfg.json' },
      { match: (r) => !isChild(r), text: 'The subagent found it.' },
    );
    await fs.writeFile(join(h.cwd, 'cfg.json'), '{}');
    await h.agent.send(s.id, 'where is the config?');
    await h.waitIdle(s.id);
    const task = tools(h, s.id)[0]!;
    expect(task.status).toBe('done');
    expect(task.result?.content).toBe('Config is in cfg.json');
    const created = h.eventsOf('session.created');
    expect(created).toHaveLength(1);
    const child = h.session(created[0]!.id);
    expect(child).toMatchObject({ kind: 'subagent', parentSessionId: s.id, parentToolUseId: task.id, title: 'Find config' });
    expect(child.messages[0]!.blocks[0]).toMatchObject({ type: 'text', text: 'Find the config file' });
    const childReq = h.mock.requests.find(isChild)!;
    const names = childReq.body.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(names).toContain('Read');
    expect(names).not.toContain('Write');          // Explore is read-only
    expect(names).not.toContain('AskUserQuestion'); // never for subagents
    expect(names).not.toContain('ExitPlanMode');
    expect(systemOf(childReq)).toContain('read-only');
    expect(h.activity.get(child.id)).toMatchObject({ kind: 'subagent', status: 'done' });
    // child sessions don't get generated titles
    expect(h.mock.requests.filter(isTitle).length).toBe(1);
  });

  it('several Task calls run concurrently, at most 3 at a time (local endpoint itself capped at 2 requests)', async () => {
    h = await createHarness();
    const s = h.createSession();
    setMaxConcurrent(h.mock.url, undefined); // measure the subagent limit, not the local-server request cap
    const isChild = (r: MockRequest) => systemOf(r).includes('subagent of Obsidian Code');
    let active = 0;
    let maxActive = 0;
    h.mock.route(isChild, () => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; }, 250);
      return { text: 'child done', initialDelayMs: 250 };
    });
    h.mock.enqueue(
      { toolCalls: [1, 2, 3, 4].map((i) => ({ name: 'Task', arguments: { description: `job ${i}`, prompt: `do ${i}` } })) },
      { text: 'all done' },
    );
    await h.agent.send(s.id, 'fan out');
    await h.waitIdle(s.id, 10_000);
    expect(tools(h, s.id).map((t) => t.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(maxActive).toBe(3);
    expect(h.eventsOf('session.created')).toHaveLength(4);
    // with the local cap restored, at most 2 requests hit the server at once
    setMaxConcurrent(h.mock.url, 2);
    maxActive = 0;
    h.mock.enqueue(
      { toolCalls: [1, 2, 3].map((i) => ({ name: 'Task', arguments: { description: `job ${i}`, prompt: `do ${i}` } })) },
      { text: 'all done' },
    );
    await h.agent.send(s.id, 'fan out again');
    await h.waitIdle(s.id, 10_000);
    expect(maxActive).toBe(2);
  });

  it('depth limit: a depth-2 subagent has no Task tool; unknown agent types error', async () => {
    h = await createHarness();
    const s = h.createSession();
    const depthOf = (r: MockRequest) => (systemOf(r).includes('subagent of Obsidian Code') ? (r.body.messages[1] ? lastUserText(r) : '') : 'root');
    h.mock.enqueue(
      { match: (r) => depthOf(r) === 'root', toolCalls: [{ name: 'Task', arguments: { description: 'l1', prompt: 'level1' } }, { name: 'Task', arguments: { description: 'bad', prompt: 'x', subagent_type: 'Nope' } }] },
      { match: (r) => depthOf(r).startsWith('level1'), toolCalls: [{ name: 'Task', arguments: { description: 'l2', prompt: 'level2' } }] },
      { match: (r) => depthOf(r).startsWith('level2'), text: 'deep done' },
      { match: (r) => depthOf(r).startsWith('level1'), text: 'l1 done' },
      { match: (r) => depthOf(r) === 'root', text: 'root done' },
    );
    await h.agent.send(s.id, 'nest');
    await h.waitIdle(s.id, 10_000);
    const ts = tools(h, s.id);
    expect(ts[0]!.result?.content).toBe('l1 done');
    expect(ts[1]!.result?.content).toMatch(/Unknown subagent type "Nope"/);
    const l2 = h.mock.requests.find((r) => depthOf(r).startsWith('level2'))!;
    expect(l2.body.tools.map((t: { function: { name: string } }) => t.function.name)).not.toContain('Task');
    const l1 = h.mock.requests.find((r) => depthOf(r).startsWith('level1'))!;
    expect(l1.body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('Task');
  });

  it('interrupting the parent interrupts running subagents', async () => {
    h = await createHarness();
    const s = h.createSession();
    const isChild = (r: MockRequest) => systemOf(r).includes('subagent of Obsidian Code');
    h.mock.enqueue(
      { match: (r) => !isChild(r), toolCalls: [{ name: 'Task', arguments: { description: 'slow', prompt: 'slow job' } }] },
      { match: isChild, text: 'aaaaaaaaaaaa', hangAfter: 3 },
    );
    await h.agent.send(s.id, 'go');
    await h.until(() => h.eventsOf('session.created').length === 1, 4000, 'child');
    const childId = h.eventsOf('session.created')[0]!.id;
    await h.until(() => h.agent.isRunning(childId) && h.session(childId).messages.length >= 2, 4000, 'child streaming');
    h.agent.interrupt(s.id);
    await h.waitIdle(s.id);
    await h.waitIdle(childId);
    expect(tools(h, s.id)[0]!.status).toBe('interrupted');
    expect(h.session(childId).messages.at(-1)!.meta?.interrupted).toBe(true);
  });
});

describe('context management', () => {
  it('auto-compacts above autoCompactPercent: summary inserted, last 2 user turns kept, session.reset', async () => {
    h = await createHarness({ nCtx: 10_000 });
    const s = h.createSession();
    h.mock.route(isSummary, { text: 'SUMMARY: user asked three things.' });
    h.mock.enqueue({ text: 'a1', usage: { prompt_tokens: 1000, completion_tokens: 5 } });
    await h.agent.send(s.id, 'q1'); await h.waitIdle(s.id);
    h.mock.enqueue({ text: 'a2', usage: { prompt_tokens: 2000, completion_tokens: 5 } });
    await h.agent.send(s.id, 'q2'); await h.waitIdle(s.id);
    h.mock.enqueue({ text: 'a3', usage: { prompt_tokens: 8500, completion_tokens: 5 } });
    await h.agent.send(s.id, 'q3'); await h.waitIdle(s.id);
    expect(h.mock.requests.filter(isSummary)).toHaveLength(0);
    h.mock.enqueue({ text: 'a4' });
    await h.agent.send(s.id, 'q4'); await h.waitIdle(s.id);
    expect(h.mock.requests.filter(isSummary)).toHaveLength(1);
    const msgs = h.session(s.id).messages;
    const idx = msgs.findIndex((m) => m.tag === 'compact_summary');
    expect(idx).toBeGreaterThan(0);
    // kept: the last 2 user turns (q3 + q4) come after the summary; the transcript still holds everything
    expect(msgs.slice(idx + 1).filter((m) => m.role === 'user').map((m) => (m.blocks[0] as { text: string }).text)).toEqual(['q3', 'q4']);
    expect(msgs.filter((m) => m.role === 'user').length).toBe(4);
    expect(h.eventsOf('session.reset').length).toBeGreaterThanOrEqual(1);
    const last = h.mock.requests.filter((r) => !isSummary(r) && !isTitle(r)).at(-1)!;
    const sent = JSON.stringify(last.body.messages);
    expect(sent).toContain('SUMMARY: user asked three things.');
    expect(sent).not.toContain('"q1"');
    expect(last.body.messages[1].role).toBe('user');
    // the summariser saw the old turns
    expect(lastUserText(h.mock.requests.find(isSummary)!)).toContain('USER: q1');
  });

  it('context overflow error → compacts and retries once', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.route(isSummary, { text: 'compressed' });
    for (const q of ['q1', 'q2', 'q3']) {
      h.mock.enqueue({ text: `answer ${q}` });
      await h.agent.send(s.id, q); await h.waitIdle(s.id);
    }
    h.mock.enqueue(
      { httpError: { status: 400, body: { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' } } } },
      { text: 'after compaction' },
    );
    await h.agent.send(s.id, 'q4'); await h.waitIdle(s.id);
    expect(h.session(s.id).status).toBe('idle');
    expect(h.session(s.id).messages.at(-1)!.blocks[0]).toMatchObject({ text: 'after compaction' });
    expect(h.session(s.id).messages.some((m) => m.tag === 'compact_summary')).toBe(true);
  });

  it('/compact on a single long turn keeps the request verbatim in the summary', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'bypassPermissions' });
    h.mock.route(isSummary, { text: 'did 3 steps' });
    h.mock.enqueue(
      { toolCalls: [{ name: 'Bash', arguments: { command: 'one' } }] },
      { toolCalls: [{ name: 'Bash', arguments: { command: 'two' } }] },
      { toolCalls: [{ name: 'Bash', arguments: { command: 'three' } }] },
      { text: 'finished' },
    );
    await h.agent.send(s.id, 'run the three commands'); await h.waitIdle(s.id);
    await h.agent.send(s.id, '/compact focus on commands'); await h.waitIdle(s.id);
    const sumReq = h.mock.requests.find(isSummary)!;
    expect(lastUserText(sumReq)).toContain('focus on commands');
    const msgs = h.session(s.id).messages;
    const summary = msgs.find((m) => m.tag === 'compact_summary')!;
    expect((summary.blocks[0] as { text: string }).text).toContain('run the three commands');
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', tag: 'command' });
  });
});

describe('rewind + checkpoints', () => {
  it('rewind truncates messages and restores files (deleting newly created ones); fileDiff + changes', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'acceptEdits' });
    const a = join(h.cwd, 'a.txt');
    await fs.writeFile(a, 'original\n');
    h.mock.enqueue(
      { toolCalls: [{ name: 'Write', arguments: { file_path: 'a.txt', content: 'changed\nmore\n' } }, { name: 'Write', arguments: { file_path: 'new.txt', content: 'brand new' } }] },
      { text: 'edited' },
    );
    await h.agent.send(s.id, 'edit things'); await h.waitIdle(s.id);
    h.mock.enqueue({ toolCalls: [{ name: 'Write', arguments: { file_path: 'a.txt', content: 'third\n' } }] }, { text: 'again' });
    const second = await h.agent.send(s.id, 'edit again'); await h.waitIdle(s.id);
    expect(await fs.readFile(a, 'utf8')).toBe('third\n');

    const diff = await h.agent.fileDiff(s.id, 'a.txt');
    expect(diff).toEqual({ before: 'original\n', after: 'third\n' });
    await h.until(() => h.session(s.id).changedFiles.find((f) => f.path.endsWith('a.txt'))?.deletions === 1, 2000, 'diff stats');
    const changed = h.session(s.id).changedFiles;
    expect(changed.find((f) => f.path.endsWith('a.txt'))).toMatchObject({ additions: 1, deletions: 1, isNew: false });
    expect(changed.find((f) => f.path.endsWith('new.txt'))).toMatchObject({ isNew: true });

    // rewind only the second turn, without files: transcript truncated, files untouched
    const firstUser = h.session(s.id).messages[0]!.id;
    const restored0 = await h.agent.rewind(s.id, second.messageId, false);
    expect(restored0).toEqual([]);
    expect(h.session(s.id).messages.every((m) => m.id !== second.messageId)).toBe(true);
    expect(await fs.readFile(a, 'utf8')).toBe('third\n');

    // rewind everything with files: a.txt back to original, new.txt deleted
    const restored = await h.agent.rewind(s.id, firstUser, true);
    expect(restored.length).toBe(2);
    expect(await fs.readFile(a, 'utf8')).toBe('original\n');
    expect(existsSync(join(h.cwd, 'new.txt'))).toBe(false);
    expect(h.session(s.id).messages).toHaveLength(0);
    expect(h.session(s.id).changedFiles).toHaveLength(0);
    expect(h.eventsOf('session.reset').length).toBeGreaterThanOrEqual(2);
  });

  it('/rewind files command restores the last turn', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'acceptEdits' });
    h.mock.enqueue({ toolCalls: [{ name: 'Write', arguments: { file_path: 'f.txt', content: 'x' } }] }, { text: 'made f' });
    await h.agent.send(s.id, 'make f'); await h.waitIdle(s.id);
    expect(existsSync(join(h.cwd, 'f.txt'))).toBe(true);
    await h.agent.send(s.id, '/rewind files'); await h.waitIdle(s.id);
    expect(existsSync(join(h.cwd, 'f.txt'))).toBe(false);
    const msgs = h.session(s.id).messages;
    expect(msgs.map((m) => m.tag)).toEqual(['command', 'command']);
    expect((msgs[1]!.blocks[0] as { text: string }).text).toMatch(/Rewound 1 turn\. Restored 1 file/);
  });
});

describe('slash commands', () => {
  const reply = (hh: Harness, id: string) => (hh.session(id).messages.at(-1)!.blocks[0] as { text: string }).text;

  it('/help lists builtin + custom commands; command echoes never reach the model', async () => {
    h = await createHarness();
    const s = h.createSession();
    await h.agent.send(s.id, '/help'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toContain('/compact');
    expect(reply(h, s.id)).toContain('/greet');
    expect(h.session(s.id).messages.map((m) => m.tag)).toEqual(['command', 'command']);
    h.mock.enqueue({ text: 'hello' });
    await h.agent.send(s.id, 'hi'); await h.waitIdle(s.id);
    const req = h.mock.requests.filter((r) => !isTitle(r))[0]!;
    expect(JSON.stringify(req.body.messages)).not.toContain('Built-in commands');
  });

  it('/model, /thinking, /plan toggles, /todos, /cost, /agents, /skills, /memory, unknown', async () => {
    h = await createHarness();
    const s = h.createSession();
    await h.agent.send(s.id, '/model'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toContain('local:mock-qwen3-uncensored');
    await h.agent.send(s.id, '/model mock-qwen3'); await h.waitIdle(s.id);
    expect(h.session(s.id).model).toEqual({ provider: 'local', model: 'mock-qwen3-uncensored' });
    await h.agent.send(s.id, '/thinking off'); await h.waitIdle(s.id);
    expect(h.session(s.id).thinking).toBe(false);
    await h.agent.send(s.id, '/plan'); await h.waitIdle(s.id);
    expect(h.session(s.id).permissionMode).toBe('plan');
    await h.agent.send(s.id, '/plan'); await h.waitIdle(s.id);
    expect(h.session(s.id).permissionMode).toBe('default');
    await h.agent.send(s.id, '/todos'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toBe('No todos yet.');
    await h.agent.send(s.id, '/cost'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toContain('Requests: 0');
    await h.agent.send(s.id, '/agents'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toContain('Explore');
    await h.agent.send(s.id, '/skills'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toMatch(/No skills/);
    await h.agent.send(s.id, '/memory'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toContain('OBSIDIAN.md');
    await h.agent.send(s.id, '/bogus'); await h.waitIdle(s.id);
    expect(reply(h, s.id)).toMatch(/Unknown command/);
    expect(h.mock.requests).toHaveLength(0);
    // a path is not a command
    h.mock.enqueue({ text: 'it is a path' });
    await h.agent.send(s.id, '/usr/bin/env is weird'); await h.waitIdle(s.id);
    expect(h.mock.requests.filter((r) => !isTitle(r))).toHaveLength(1);
  });

  it('custom command via ext.expandCommand; /init sends the init prompt; /plan <task> plans', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ text: 'Hello Bob!' });
    await h.agent.send(s.id, '/greet Bob'); await h.waitIdle(s.id);
    expect(lastUserText(h.mock.requests.filter((r) => !isTitle(r))[0]!)).toBe('Say hello to Bob');
    h.mock.enqueue({ text: 'wrote OBSIDIAN.md' });
    await h.agent.send(s.id, '/init'); await h.waitIdle(s.id);
    expect(lastUserText(h.mock.requests.filter((r) => !isTitle(r))[1]!)).toContain('OBSIDIAN.md');
    h.mock.enqueue({ text: 'planning' });
    await h.agent.send(s.id, '/plan add a feature'); await h.waitIdle(s.id);
    expect(h.session(s.id).permissionMode).toBe('plan');
    expect(lastUserText(h.mock.requests.filter((r) => !isTitle(r))[2]!)).toContain('Plan mode is active');
  });

  it('#note appends to <cwd>/OBSIDIAN.md and tells the model on the next turn', async () => {
    h = await createHarness();
    const s = h.createSession();
    await h.agent.send(s.id, '# always use pnpm'); await h.waitIdle(s.id);
    expect(await fs.readFile(join(h.cwd, 'OBSIDIAN.md'), 'utf8')).toContain('- always use pnpm');
    await h.agent.send(s.id, '#and tabs'); await h.waitIdle(s.id);
    expect(await fs.readFile(join(h.cwd, 'OBSIDIAN.md'), 'utf8')).toMatch(/- always use pnpm\n- and tabs\n/);
    h.mock.enqueue({ text: 'ok' });
    await h.agent.send(s.id, 'install deps'); await h.waitIdle(s.id);
    expect(lastUserText(h.mock.requests.filter((r) => !isTitle(r))[0]!)).toContain('always use pnpm');
  });

  it('/clear archives the conversation and resets the session', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ text: 'one' });
    await h.agent.send(s.id, 'first'); await h.waitIdle(s.id);
    await h.agent.send(s.id, '/clear'); await h.waitIdle(s.id);
    expect(h.session(s.id).messages).toHaveLength(0);
    const archDir = join(h.dir, 'archive', s.id);
    expect(readdirSync(archDir).length).toBe(1);
    h.mock.enqueue({ text: 'fresh' });
    await h.agent.send(s.id, 'second'); await h.waitIdle(s.id);
    const req = h.mock.requests.filter((r) => !isTitle(r)).at(-1)!;
    expect(JSON.stringify(req.body.messages)).not.toContain('first');
  });
});

describe('todos + misc', () => {
  it('TodoWrite updates session todos and emits todos.updated', async () => {
    h = await createHarness();
    const s = h.createSession();
    const todos = [{ id: '1', content: 'Do it', status: 'in_progress' }];
    h.mock.enqueue({ toolCalls: [{ name: 'TodoWrite', arguments: { todos } }] }, { text: 'ok' });
    await h.agent.send(s.id, 'track'); await h.waitIdle(s.id);
    expect(h.session(s.id).todos).toEqual(todos);
    expect(h.eventsOf('todos.updated')[0]!.todos).toEqual(todos);
  });

  it('the activity registry can stop a running session', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ text: 'zzzzzzzzzz', hangAfter: 3 });
    await h.agent.send(s.id, 'x');
    await h.until(() => h.activity.get(s.id)?.status === 'running', 3000, 'activity running');
    h.ctx.activity.stop(s.id);
    await h.waitIdle(s.id);
    expect(h.activity.get(s.id)?.status).toBe('stopped');
  });
});
