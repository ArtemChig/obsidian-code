// Translator: real Claude Agent SDK message streams captured by scripts/claude-code-spike.ts (tests/fixtures/claude-code)
// → the app's transcript + CoreEvents.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CoreEventName } from '@shared/protocol';
import type { Message, Session, ToolUseBlock } from '@shared/types';
import { localizeCommandOutput, localizeCostText, toolDisplay, toTodos, uiToolName } from '@core/engine/claude-code/display';
import { Translator, type TranslatorHost } from '@core/engine/claude-code/translate';

const FIX = join(__dirname, '..', '..', 'fixtures', 'claude-code');
type Obj = Record<string, unknown>;

export function fixture(name: string): Obj[] {
  return readFileSync(join(FIX, `${name}.jsonl`), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Obj);
}

function makeSession(id: string, init: Partial<Session> = {}): Session {
  return {
    id, title: 't', cwd: 'C:\\work', kind: 'chat', createdAt: 0, updatedAt: 0, status: 'running', model: null, permissionMode: 'default',
    thinking: true, usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 }, messages: [], todos: [], changedFiles: [], ...init,
  };
}

export function fakeHost(opts: { files?: Record<string, string>; denied?: string[] } = {}) {
  const sessions = new Map<string, Session>([['root', makeSession('root')]]);
  const events: { event: CoreEventName; data: unknown }[] = [];
  const changes: { sessionId: string; path: string }[] = [];
  let n = 0;
  const host: TranslatorHost = {
    session: (id) => sessions.get(id),
    mutate: (id, fn) => fn(sessions.get(id)!),
    emit: (event, data) => { events.push({ event, data }); },
    newId: () => `m${++n}`,
    createSubagent: (parentId, toolUseId, agentType, description) => {
      const id = `child-${toolUseId}`;
      sessions.set(id, makeSession(id, { kind: 'subagent', parentSessionId: parentId, parentToolUseId: toolUseId, title: `${agentType}: ${description}` }));
      return id;
    },
    setStatus: (id, status) => { sessions.get(id)!.status = status; },
    takeBefore: () => undefined,
    readText: (abs) => opts.files?.[abs] ?? null,
    recordChange: (sessionId, _id, path) => { changes.push({ sessionId, path }); },
    takeMcpDisplay: () => undefined,
    wasDenied: (id) => opts.denied?.includes(id) ?? false,
    resolvePath: (_s, p) => p,
  };
  return { host, sessions, events, changes };
}

/** Drive a translator the way the engine does (system task events → onTask; result → endTurn). */
export function drive(t: Translator, msgs: Obj[]): void {
  for (const m of msgs) {
    if (m.type === 'system' && typeof m.subtype === 'string' && m.subtype.startsWith('task_')) t.onTask(m);
    else if (m.type === 'result') t.endTurn(false);
    else t.handle(m);
  }
}

const tools = (msgs: Message[]) => msgs.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
const texts = (msgs: Message[]) => msgs.flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));

describe('Translator (captured SDK streams)', () => {
  it('plain reply: one assistant message per API call, thinking + text streamed then finalized, usage in meta', () => {
    const { host, sessions, events } = fakeHost();
    const t = new Translator(host, 'root');
    t.beginTurn();
    drive(t, fixture('plain'));
    const msgs = sessions.get('root')!.messages;
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m.role).toBe('assistant');
    expect(m.blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(texts(msgs).join('').toLowerCase()).toContain('hello');
    expect(m.meta?.promptTokens).toBeGreaterThan(1000);
    expect(m.meta?.completionTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.event === 'message.delta')).toBe(true);
    expect(events.filter((e) => e.event === 'message.completed')).toHaveLength(1);
    expect(t.usage().requests).toBe(1);
    expect(t.lastText.toLowerCase()).toContain('hello');
  });

  it('Read + Write tool turn: running → done with file and diff displays, change recorded', () => {
    const msgs0 = fixture('tools');
    const write = msgs0.find((m) => m.type === 'assistant' && JSON.stringify(m).includes('"name":"Write"')) as Obj;
    const writePath = ((write.message as Obj).content as Obj[])[0]!.input as Obj;
    const { host, sessions, changes, events } = fakeHost({ files: { [String(writePath.file_path)]: 'ALPHA BETA\n' } });
    const t = new Translator(host, 'root');
    drive(t, msgs0);
    const msgs = sessions.get('root')!.messages;
    expect(msgs).toHaveLength(3); // Read call, Write call, final reply
    const [read, wr] = tools(msgs);
    expect(read!.name).toBe('Read');
    expect(read!.status).toBe('done');
    expect(read!.result?.display).toMatchObject({ kind: 'file', content: 'alpha beta\n', startLine: 1 });
    expect(wr!.name).toBe('Write');
    expect(wr!.status).toBe('done');
    expect(wr!.result?.display).toMatchObject({ kind: 'diff', before: '', after: 'ALPHA BETA\n', isNewFile: true });
    expect(changes).toEqual([{ sessionId: 'root', path: String(writePath.file_path) }]);
    // the tool block was announced while streaming (pending), then running, then done
    const updates = events.filter((e) => e.event === 'tool.updated').map((e) => (e.data as { tool: ToolUseBlock }).tool.status);
    expect(updates).toContain('running');
    expect(updates.at(-1)).toBe('done');
    expect(texts(msgs).at(-1)).toBe('done');
  });

  it('TodoWrite → todos display + todos.updated', () => {
    const { host, sessions, events } = fakeHost();
    const t = new Translator(host, 'root');
    drive(t, fixture('todo'));
    const todo = tools(sessions.get('root')!.messages).find((b) => b.name === 'TodoWrite')!;
    expect(todo.result?.display).toMatchObject({ kind: 'todos' });
    expect(sessions.get('root')!.todos.map((x) => [x.content, x.status])).toEqual([['one', 'in_progress'], ['two', 'pending']]);
    expect(events.some((e) => e.event === 'todos.updated')).toBe(true);
  });

  it('AskUserQuestion result shows the questions and answers', () => {
    const { host, sessions } = fakeHost();
    const t = new Translator(host, 'root');
    const msgs = fixture('ask');
    // the engine returns updatedInput with answers; the SDK echoes the original input in the assistant block
    drive(t, msgs);
    const ask = tools(sessions.get('root')!.messages).find((b) => b.name === 'AskUserQuestion')!;
    expect(ask.status).toBe('done');
    expect(ask.result?.display).toMatchObject({ kind: 'questions' });
    const d = ask.result!.display as { questions: { question: string; options: unknown[] }[]; answers?: Record<string, string> };
    expect(d.questions[0]!.options).toHaveLength(2);
    expect(d.answers?.['Which color do you prefer?']).toBe('Blue');
  });

  it('plan mode: ExitPlanMode → plan display', () => {
    const { host, sessions } = fakeHost();
    const t = new Translator(host, 'root');
    drive(t, fixture('plan'));
    const exit = tools(sessions.get('root')!.messages).find((b) => b.name === 'ExitPlanMode')!;
    expect(exit.result?.display).toMatchObject({ kind: 'plan' });
    expect((exit.result!.display as { plan: string }).plan).toContain('plan.txt');
  });

  it('background Agent subagent: child session mirrors the subagent conversation and ends on task_notification', () => {
    const { host, sessions } = fakeHost();
    const t = new Translator(host, 'root');
    const msgs = fixture('task');
    const agentCall = msgs.find((m) => m.type === 'assistant' && JSON.stringify(m).includes('"name":"Agent"')) as Obj;
    const agentId = String((((agentCall.message as Obj).content as Obj[])[0] as Obj).id);
    // stop before the completion (task_updated, then task_notification): the child still runs although Agent returned
    const notifyAt = msgs.findIndex((m) => m.subtype === 'task_updated' || m.subtype === 'task_notification');
    drive(t, msgs.slice(0, notifyAt));
    const child = sessions.get(`child-${agentId}`)!;
    expect(child.kind).toBe('subagent');
    expect(child.parentToolUseId).toBe(agentId);
    expect(child.status).toBe('running');
    const agent = tools(sessions.get('root')!.messages).find((b) => b.id === agentId)!;
    expect(agent.name).toBe('Task'); // Claude Code's Agent tool renders as the app's subagent card
    expect(agent.result?.display).toMatchObject({ kind: 'subagent', sessionId: child.id, agentType: 'general-purpose' });
    expect(tools(child.messages).map((b) => [b.name, b.status])).toEqual([['Read', 'done']]);
    expect(texts(child.messages).join('')).toContain('alpha beta');
    const resumedAt = msgs.findIndex((m, i) => i > notifyAt && m.subtype === 'task_started');
    drive(t, msgs.slice(notifyAt, resumedAt));
    expect(child.status).toBe('idle');
    // the main agent continued the same agent with SendMessage: it streams into the same child session again
    drive(t, msgs.slice(resumedAt));
    expect(child.status).toBe('running');
    expect(sessions.size).toBe(2);
  });

  it('interrupt: the synthetic "[Request interrupted by user]" message adds nothing; endTurn closes open messages', () => {
    const { host, sessions } = fakeHost();
    const t = new Translator(host, 'root');
    const msgs = fixture('interrupt');
    drive(t, msgs.filter((m) => m.type !== 'result'));
    t.endTurn(true);
    const all = sessions.get('root')!.messages;
    expect(all.every((m) => m.role === 'assistant')).toBe(true);
    for (const m of all) expect(m.meta?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('/compact replays: synthetic summary and local-command stdout are not added as user turns', () => {
    const { host, sessions } = fakeHost();
    const t = new Translator(host, 'root');
    drive(t, fixture('resume'));
    const all = sessions.get('root')!.messages;
    expect(all.some((m) => m.role === 'user')).toBe(false);
    expect(texts(all).join(' ')).toContain('still here');
  });

  it('tracks the last main-chain uuid (resume point for rewinds)', () => {
    const { host } = fakeHost();
    const t = new Translator(host, 'root');
    const msgs = fixture('tools');
    drive(t, msgs);
    const lastAssistant = [...msgs].reverse().find((m) => m.type === 'assistant' && m.parent_tool_use_id == null)!;
    expect(t.lastChainUuid).toBe(lastAssistant.uuid);
  });
});

describe('display mapping', () => {
  it('maps Claude Code / obsidian MCP names onto the app tool names', () => {
    expect(uiToolName('Agent')).toBe('Task');
    expect(uiToolName('mcp__obsidian__web_search')).toBe('WebSearch');
    expect(uiToolName('mcp__obsidian__schedule_task')).toBe('ScheduleTask');
    expect(uiToolName('Bash')).toBe('Bash');
  });

  it('Edit diff from the PreToolUse snapshot + current file', () => {
    const d = toolDisplay({
      name: 'Edit', input: { file_path: 'C:\\w\\a.ts', old_string: 'a', new_string: 'b' }, toolUseResult: { filePath: 'C:\\w\\a.ts', originalFile: 'x a' },
      content: 'ok', isError: false, before: { existed: true, content: 'x a' }, after: 'x b',
    });
    expect(d).toEqual({ kind: 'diff', path: 'C:\\w\\a.ts', before: 'x a', after: 'x b', isNewFile: false });
    // without the snapshot/after: derived from originalFile + the edit
    const d2 = toolDisplay({ name: 'Edit', input: { file_path: 'f', old_string: 'a', new_string: 'b' }, toolUseResult: { originalFile: 'a a' }, content: '', isError: false });
    expect(d2).toMatchObject({ before: 'a a', after: 'b a' });
  });

  it('Bash, Grep/Glob, WebFetch', () => {
    expect(toolDisplay({ name: 'Bash', input: { command: 'ls' }, toolUseResult: { stdout: 'a\nb', stderr: '', interrupted: false }, content: 'a\nb', isError: false }))
      .toMatchObject({ kind: 'bash', command: 'ls', output: 'a\nb', exitCode: 0 });
    expect(toolDisplay({ name: 'Bash', input: { command: 'false' }, toolUseResult: { stdout: '', stderr: 'boom' }, content: 'Exit code 2\nboom', isError: true }))
      .toMatchObject({ exitCode: 2, output: 'boom' });
    expect(toolDisplay({ name: 'Glob', input: { pattern: '*.ts' }, toolUseResult: { filenames: ['a.ts', 'b.ts'], numFiles: 2 }, content: '', isError: false }))
      .toEqual({ kind: 'list', title: '2 files', items: ['a.ts', 'b.ts'] });
    expect(toolDisplay({ name: 'WebFetch', input: { url: 'https://x.y' }, toolUseResult: { bytes: 42, url: 'https://x.y' }, content: '', isError: false }))
      .toEqual({ kind: 'web', url: 'https://x.y', bytes: 42 });
  });

  it('todos keep Claude Code statuses and activeForm', () => {
    expect(toTodos([{ content: 'a', status: 'completed', activeForm: 'Doing a' }, { content: 'b', status: 'weird' }]))
      .toEqual([{ id: '1', content: 'a', status: 'completed', activeForm: 'Doing a' }, { id: '2', content: 'b', status: 'pending' }]);
  });
});

describe('local command output', () => {
  it('shows a local model as not billed instead of the price Claude Code guesses', () => {
    const raw = ['Total cost:            $0.0365 (costs may be inaccurate due to usage of unknown models)', 'Usage by model:', 'qwen3.6:  2.2k input, 9 output, 51.0k cache read ($0.0365)', 'Prompt cache (main):   3 requests'].join(String.fromCharCode(10));
    expect(localizeCostText(raw).split(String.fromCharCode(10))).toEqual([
      'Total cost:            $0.00 (local model, not billed)', 'Usage by model:', 'qwen3.6:  2.2k input, 9 output, 51.0k cache read', 'Prompt cache (main):   3 requests',
    ]);
    expect(localizeCostText('Context usage: 12k / 131k')).toBe('Context usage: 12k / 131k');
  });

  it('rewrites only the text blocks of the synthetic message and leaves other messages untouched', () => {
    const m = { type: 'assistant', uuid: 'u', message: { content: [{ type: 'text', text: 'Total cost: $1.20 (x)' }] } };
    const out = localizeCommandOutput(m) as typeof m;
    expect(out.message.content[0]!.text).toBe('Total cost: $0.00 (local model, not billed)');
    expect(out.uuid).toBe('u');
    expect(m.message.content[0]!.text).toBe('Total cost: $1.20 (x)'); // input not mutated
    const plain = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
    expect(localizeCommandOutput(plain)).toBe(plain);
  });
});
