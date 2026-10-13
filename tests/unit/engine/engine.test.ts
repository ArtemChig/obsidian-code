// ClaudeCodeEngine bridging with a scripted fake Agent SDK: permissions, questions, plans, headless runs, hooks
// (app deny rules, checkpoints), rewind/fork, interrupt, engine switch seeding, restarts, commands, errors.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionRequest, PlanRequest, QuestionRequest, ToolUseBlock } from '@shared/types';
import { ClaudeCodeEngine, HEADLESS_NO_ANSWER } from '@core/engine/claude-code/engine';
import { EngineRouter } from '@core/engine/index';
import { createHarness, until, type Harness } from '../agent/helpers';

type Obj = Record<string, unknown>;
type Turn = (user: Obj, q: FakeQuery) => Promise<void>;

class FakeQuery implements AsyncIterable<Obj> {
  private items: Obj[] = [];
  private waiters: ((r: IteratorResult<Obj>) => void)[] = [];
  private ended = false;
  interrupts = 0;
  modes: string[] = [];
  closed = false;
  interrupted = false;
  private onInterrupt: (() => void) | null = null;
  constructor(readonly prompt: AsyncIterable<Obj>, readonly options: Obj, private readonly turn: Turn, readonly sdkSessionId: string) {
    void this.run();
  }
  emit(m: Obj): void {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false }); else this.items.push(m);
  }
  private end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  private async run(): Promise<void> {
    for await (const u of this.prompt) {
      this.emit({ type: 'system', subtype: 'init', session_id: this.sdkSessionId });
      this.interrupted = false;
      await this.turn(u, this);
      if (this.closed) break;
    }
    this.end();
  }
  /** Resolves when interrupt() is called (for turns that block until stopped). */
  untilInterrupted(): Promise<void> {
    return new Promise((r) => { this.onInterrupt = r; });
  }
  async interrupt(): Promise<undefined> {
    this.interrupts++;
    this.interrupted = true;
    this.onInterrupt?.();
    return undefined;
  }
  async setPermissionMode(m: string): Promise<void> { this.modes.push(m); }
  async supportedCommands(): Promise<{ name: string; description: string; argumentHint: string }[]> {
    return [{ name: 'compact', description: 'Compact', argumentHint: '' }, { name: 'review', description: 'Review a PR', argumentHint: '<pr>' }];
  }
  close(): void { this.closed = true; this.end(); }
  [Symbol.asyncIterator](): AsyncIterator<Obj> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

// ── helpers for scripted turns
let uuidN = 0;
const say = (q: FakeQuery, text: string, apiId = `api-${++uuidN}`) => q.emit({
  type: 'assistant', uuid: `uuid-${uuidN}`, parent_tool_use_id: null, message: { id: apiId, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 100 } },
});
const callTool = (q: FakeQuery, id: string, name: string, input: Obj) => q.emit({
  type: 'assistant', uuid: `uuid-${++uuidN}`, parent_tool_use_id: null, message: { id: `api-${uuidN}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (q: FakeQuery, id: string, content: string, isError = false, toolUseResult?: unknown) => q.emit({
  type: 'user', uuid: `uuid-${++uuidN}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, tool_use_result: toolUseResult,
});
const result = (q: FakeQuery, text = 'ok', extra: Obj = {}) => q.emit({
  type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 }, ...extra,
});
const canUse = (q: FakeQuery, name: string, input: Obj, opts: Obj = {}) =>
  (q.options.canUseTool as (n: string, i: Obj, o: Obj) => Promise<Obj>)(name, input, { signal: new AbortController().signal, toolUseID: opts.toolUseID ?? 'tu', ...opts });
const preToolUse = (q: FakeQuery, name: string, input: Obj, id: string) =>
  ((q.options.hooks as Obj).PreToolUse as { hooks: ((i: Obj) => Promise<Obj>)[] }[])[0]!.hooks[0]!({ tool_name: name, tool_input: input, tool_use_id: id });
const textOf = (q: Obj) => {
  const c = (q.message as Obj).content;
  return typeof c === 'string' ? c : (c as Obj[]).map((b) => String(b.text ?? '')).join('');
};

interface Rig { h: Harness; engine: ClaudeCodeEngine; queries: FakeQuery[]; setTurn(t: Turn): void; probe: { reason: string | null } }

async function rig(turn: Turn = async (_u, q) => { say(q, 'hi'); result(q, 'hi'); }): Promise<Rig> {
  const h = await createHarness();
  let current = turn;
  const queries: FakeQuery[] = [];
  const probe = { reason: null as string | null };
  const engine = new ClaudeCodeEngine(h.ctx, {
    loadSdk: async () => ({
      query: ((args: { prompt: AsyncIterable<Obj>; options: Obj }) => {
        const q = new FakeQuery(args.prompt, args.options, (u, qq) => current(u, qq), `sdk-${queries.length + 1}`);
        queries.push(q);
        return q;
      }) as never,
    }),
    probeMessagesApi: async () => probe.reason,
    resolveExecutable: () => ({ path: process.execPath, source: 'custom' }),
    idleCloseMs: 60_000,
    userClaudeDir: join(h.dir, 'no-user-claude'),
  });
  return { h, engine, queries, setTurn: (t) => { current = t; }, probe };
}

let active: Rig | undefined;
afterEach(async () => {
  active?.engine.dispose();
  await active?.h.close();
  active = undefined;
});

async function newRig(turn?: Turn): Promise<Rig> {
  active = await rig(turn);
  return active;
}

const idle = (r: Rig, id: string) => until(() => !r.engine.isRunning(id), 8000, 'engine idle');

describe('ClaudeCodeEngine', () => {
  it('starts the harness on the session endpoint with the expected options, and reuses it for the next turn', async () => {
    const r = await newRig();
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'hello');
    await idle(r, s.id);
    await r.engine.send(s.id, 'again');
    await idle(r, s.id);
    expect(r.queries).toHaveLength(1);
    const o = r.queries[0]!.options;
    expect(o.cwd).toBe(r.h.cwd);
    expect(o.includePartialMessages).toBe(true);
    expect(o.disallowedTools).toEqual(['WebSearch']);
    expect(o.settingSources).toEqual(['user']); // untrusted folder: no project settings/hooks
    expect(Object.keys(o.mcpServers as Obj)).toEqual(['obsidian']);
    const env = o.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\//);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(r.h.dir, 'claude-code'));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(typeof o.systemPrompt).toBe('string'); // lean by default
    expect(String(o.systemPrompt)).not.toMatch(/refus/i);
    const sess = r.h.session(s.id);
    expect(sess.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(sess.usage.inputTokens).toBe(300);
    expect(r.engine.state(s.id).sdkSessionId).toBe('sdk-1');
    expect(r.engine.state(s.id).turns).toHaveLength(2);
  });

  it('permission: prompt → allow always persists the app rule and returns a session-scoped Claude Code update', async () => {
    let decision: Obj | undefined;
    const r = await newRig(async (_u, q) => {
      callTool(q, 't1', 'Bash', { command: 'npm install' });
      decision = await canUse(q, 'Bash', { command: 'npm install' }, {
        toolUseID: 't1', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'localSettings' }],
      });
      toolResult(q, 't1', 'added 1 package', false, { stdout: 'added 1 package', stderr: '' });
      result(q);
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'install');
    await until(() => r.h.eventsOf('permission.requested').length > 0, 8000, 'permission prompt');
    const req = r.h.eventsOf('permission.requested')[0] as PermissionRequest;
    expect(req.toolName).toBe('Bash');
    expect(req.suggestedRule).toMatch(/^Bash\(npm/);
    expect(r.h.session(s.id).status).toBe('waiting');
    expect(r.engine.pending(s.id).permissions).toHaveLength(1);
    const blk = r.h.session(s.id).messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(blk.status).toBe('awaiting_permission');
    r.engine.respondPermission(req.requestId, 'allow_always');
    await idle(r, s.id);
    expect(decision).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', destination: 'session' }] });
    expect(r.h.projectAllow).toContain(req.suggestedRule);
    const done = r.h.session(s.id).messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(done.status).toBe('done');
    expect(done.result?.display).toMatchObject({ kind: 'bash', command: 'npm install', output: 'added 1 package' });
  });

  it('permission: deny with feedback continues, deny without feedback interrupts; denied tool shows as denied', async () => {
    const decisions: Obj[] = [];
    const r = await newRig(async (_u, q) => {
      callTool(q, 'd1', 'Bash', { command: 'curl x' });
      const d = await canUse(q, 'Bash', { command: 'curl x' }, { toolUseID: 'd1' });
      decisions.push(d);
      toolResult(q, 'd1', String(d.message), true);
      result(q);
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'a');
    await until(() => r.h.eventsOf('permission.requested').length === 1, 8000, 'prompt 1');
    r.engine.respondPermission((r.h.eventsOf('permission.requested')[0] as PermissionRequest).requestId, 'deny', 'use wget');
    await idle(r, s.id);
    await r.engine.send(s.id, 'b');
    await until(() => r.h.eventsOf('permission.requested').length === 2, 8000, 'prompt 2');
    r.engine.respondPermission((r.h.eventsOf('permission.requested')[1] as PermissionRequest).requestId, 'deny');
    await idle(r, s.id);
    expect(decisions[0]).toMatchObject({ behavior: 'deny', message: expect.stringContaining('use wget') });
    expect(decisions[0]!.interrupt).toBeUndefined();
    expect(decisions[1]).toMatchObject({ behavior: 'deny', interrupt: true });
    const blocks = r.h.session(s.id).messages.flatMap((m) => m.blocks).filter((b): b is ToolUseBlock => b.type === 'tool_use');
    expect(blocks.map((b) => b.status)).toEqual(['denied', 'denied']);
  });

  it('app allow rules skip the prompt; app deny rules block in PreToolUse; reads of credential files must ask', async () => {
    const out: Obj[] = [];
    const r = await newRig(async (_u, q) => {
      out.push(await canUse(q, 'Bash', { command: 'git status' }));
      out.push(await preToolUse(q, 'Bash', { command: 'rm -rf build' }, 'p2'));
      out.push(await preToolUse(q, 'Read', { file_path: join(r.h.cwd, '.env') }, 'p3'));
      out.push(await preToolUse(q, 'Read', { file_path: join(r.h.cwd, 'a.txt') }, 'p4'));
      result(q);
    });
    r.h.settings.permissions = { allow: ['Bash(git status:*)'], deny: ['Bash(rm:*)'] };
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'go');
    await idle(r, s.id);
    expect(out[0]).toMatchObject({ behavior: 'allow' });
    expect(out[1]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(out[2]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    expect(out[3]).toEqual({ continue: true });
    expect(r.h.eventsOf('permission.requested')).toHaveLength(0);
  });

  it('plan mode rejects changes instead of asking, except the plan file Claude Code writes into its config dir', async () => {
    const out: Obj[] = [];
    const r = await newRig(async (_u, q) => {
      const planFile = join(r.h.dir, 'claude-code', 'plans', 'x-y-z.md');
      out.push(await canUse(q, 'Write', { file_path: join(r.h.cwd, 'src.js'), content: 'x' }));
      out.push(await canUse(q, 'Edit', { file_path: join(r.h.cwd, 'src.js'), old_string: 'a', new_string: 'b' }));
      out.push(await canUse(q, 'Bash', { command: 'echo hi > out.txt' }));
      out.push(await canUse(q, 'Write', { file_path: planFile, content: '# plan' }));
      out.push(await canUse(q, 'Read', { file_path: join(r.h.cwd, 'src.js') }));
      result(q);
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x', permissionMode: 'plan' });
    await r.engine.send(s.id, 'plan it');
    await idle(r, s.id);
    for (const i of [0, 1, 2]) {
      expect(out[i]).toMatchObject({ behavior: 'deny' });
      expect(String(out[i]!.message)).toMatch(/Plan mode is active/);
      expect(out[i]!.interrupt).toBeUndefined();
    }
    expect(out[3]).toMatchObject({ behavior: 'allow' });
    expect(out[4]).toMatchObject({ behavior: 'allow' });
    expect(r.h.eventsOf('permission.requested')).toHaveLength(0);
  });

  it('AskUserQuestion → question card → answers in updatedInput', async () => {
    let d: Obj | undefined;
    const questions = [{ question: 'Color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }];
    const r = await newRig(async (_u, q) => { d = await canUse(q, 'AskUserQuestion', { questions }, { toolUseID: 'q1' }); result(q); });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'ask me');
    await until(() => r.h.eventsOf('question.requested').length > 0, 8000, 'question');
    const req = r.h.eventsOf('question.requested')[0] as QuestionRequest;
    expect(req.questions[0]!.options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(r.engine.owns(req.requestId)).toBe(true);
    r.engine.answerQuestion(req.requestId, { 'Color?': 'Blue' });
    await idle(r, s.id);
    expect(d).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Color?': 'Blue' } } });
  });

  it('ExitPlanMode → plan card → approve switches the session mode (setMode update)', async () => {
    let d: Obj | undefined;
    const r = await newRig(async (_u, q) => { d = await canUse(q, 'ExitPlanMode', { plan: '1. do it' }, { toolUseID: 'p1' }); result(q); });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x', permissionMode: 'plan' });
    await r.engine.send(s.id, 'plan it');
    await until(() => r.h.eventsOf('plan.requested').length > 0, 8000, 'plan');
    const req = r.h.eventsOf('plan.requested')[0] as PlanRequest;
    expect(req.plan).toBe('1. do it');
    r.engine.respondPlan(req.requestId, true, 'acceptEdits');
    await idle(r, s.id);
    expect(d).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(r.h.session(s.id).permissionMode).toBe('acceptEdits');
    expect(r.queries[0]!.options.permissionMode).toBe('plan');
  });

  it('headless runs auto-deny permissions and answer questions with the unattended marker', async () => {
    const out: Obj[] = [];
    const r = await newRig(async (_u, q) => {
      out.push(await canUse(q, 'Bash', { command: 'npm publish' }));
      out.push(await canUse(q, 'AskUserQuestion', { questions: [{ question: 'Q?', header: 'Q', options: [] }] }));
      say(q, 'done');
      result(q, 'done');
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x', kind: 'scheduled' });
    const res = await r.engine.runHeadless({ sessionId: s.id, prompt: 'nightly' });
    expect(res).toEqual({ ok: true, finalText: 'done' });
    expect(out[0]).toMatchObject({ behavior: 'deny', message: expect.stringContaining('unattended') });
    expect(out[1]).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Q?': HEADLESS_NO_ANSWER } } });
    expect(r.h.eventsOf('permission.requested')).toHaveLength(0);
    expect(r.h.session(s.id).messages[0]!.tag).toBe('scheduled_prompt');
  });

  it('interrupt → SDK interrupt → the turn ends as stopped (no error)', async () => {
    const r = await newRig(async (_u, q) => {
      q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'live', usage: { input_tokens: 5 } } } });
      q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1\n2\n' } } });
      await q.untilInterrupted();
      q.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      q.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'], usage: {} });
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'count');
    await until(() => r.h.eventsOf('message.delta').length > 0, 8000, 'streaming');
    r.engine.interrupt(s.id);
    await idle(r, s.id);
    expect(r.queries[0]!.interrupts).toBe(1);
    const sess = r.h.session(s.id);
    expect(sess.status).toBe('idle');
    expect(r.h.eventsOf('error')).toHaveLength(0);
    const last = sess.messages.at(-1)!;
    expect(last.meta?.interrupted).toBe(true);
    expect(last.blocks[0]).toMatchObject({ type: 'text', text: '1\n2\n' });
  });

  it('PreToolUse checkpoints edits; rewind restores files and forks the Claude session at the previous turn', async () => {
    const r = await newRig();
    const file = join(r.h.cwd, 'a.txt');
    writeFileSync(file, 'old\n');
    r.setTurn(async (u, q) => {
      if (textOf(u).includes('edit')) {
        expect(await preToolUse(q, 'Write', { file_path: file, content: 'new\n' }, 'w1')).toEqual({ continue: true });
        callTool(q, 'w1', 'Write', { file_path: file, content: 'new\n' });
        writeFileSync(file, 'new\n');
        toolResult(q, 'w1', 'ok', false, { type: 'update', filePath: file, content: 'new\n', originalFile: 'old\n' });
      }
      say(q, 'ok');
      result(q);
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'first');
    await idle(r, s.id);
    const firstReplyUuid = r.engine.state(s.id).lastUuid;
    expect(firstReplyUuid).toBeTruthy();
    const { messageId } = await r.engine.send(s.id, 'now edit');
    await idle(r, s.id);
    await until(() => r.h.session(s.id).changedFiles.length === 1, 8000, 'change recorded');
    const w = r.h.session(s.id).messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(w.result?.display).toMatchObject({ kind: 'diff', before: 'old\n', after: 'new\n', isNewFile: false });
    expect(await r.engine.fileDiff(s.id, file)).toEqual({ before: 'old\n', after: 'new\n' });

    const restored = await r.engine.rewind(s.id, messageId, true);
    expect(restored.map((p) => p.toLowerCase())).toEqual([file.toLowerCase()]);
    expect(readFileSync(file, 'utf8')).toBe('old\n');
    expect(r.h.session(s.id).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(r.engine.state(s.id).fork).toEqual({ resumeAt: firstReplyUuid });
    await r.engine.send(s.id, 'again');
    await idle(r, s.id);
    expect(r.queries).toHaveLength(2);
    expect(r.queries[1]!.options).toMatchObject({ resume: 'sdk-1', resumeSessionAt: firstReplyUuid, forkSession: true });
    expect(r.engine.state(s.id).sdkSessionId).toBe('sdk-2');
    expect(r.engine.state(s.id).fork).toBeUndefined();
  });

  it('the Claude Code plan file (<config dir>/plans) is not listed as a changed file', async () => {
    const r = await newRig();
    const planFile = join(r.h.dir, 'claude-code', 'plans', 'add-a-function-staged-lemur.md');
    const real = join(r.h.cwd, 'real.txt');
    r.setTurn(async (_u, q) => {
      mkdirSync(join(r.h.dir, 'claude-code', 'plans'), { recursive: true });
      for (const [id, file] of [['p1', planFile], ['p2', real]] as const) {
        expect(await preToolUse(q, 'Write', { file_path: file, content: 'x\n' }, id)).toEqual({ continue: true });
        callTool(q, id, 'Write', { file_path: file, content: 'x\n' });
        writeFileSync(file, 'x\n');
        toolResult(q, id, 'ok', false, { type: 'create', filePath: file, content: 'x\n' });
      }
      say(q, 'ok');
      result(q);
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'plan it');
    await idle(r, s.id);
    await until(() => r.h.session(s.id).changedFiles.length >= 1, 8000, 'change recorded');
    await new Promise((res) => setTimeout(res, 150)); // the plan file would have been recorded by now
    expect(r.h.session(s.id).changedFiles.map((f) => f.path.toLowerCase())).toEqual([real.toLowerCase()]);
    // both Write cards are still in the transcript
    const writes = r.h.session(s.id).messages.flatMap((m) => m.blocks).filter((b): b is ToolUseBlock => b.type === 'tool_use' && b.name === 'Write');
    expect(writes).toHaveLength(2);
  });

  it('subagents (Agent tool) run in the foreground unless the call asks for the background', async () => {
    const r = await newRig();
    let hook: Obj[] = [];
    r.setTurn(async (_u, q) => {
      hook = [
        await preToolUse(q, 'Agent', { prompt: 'find it', description: 'find', subagent_type: 'Explore' }, 'a1'),
        await preToolUse(q, 'Agent', { prompt: 'find it', run_in_background: true }, 'a2'),
        await preToolUse(q, 'Agent', { prompt: 'find it', run_in_background: false }, 'a3'),
        await preToolUse(q, 'Read', { file_path: join(r.h.cwd, 'a.txt') }, 'a4'),
      ];
      say(q, 'ok');
      result(q);
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'go');
    await idle(r, s.id);
    expect(hook[0]).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { prompt: 'find it', description: 'find', subagent_type: 'Explore', run_in_background: false } } });
    expect(hook[1]).toEqual({ continue: true }); // explicit background request is honoured
    expect(hook[2]).toEqual({ continue: true });
    expect(hook[3]).toEqual({ continue: true });
  });

  it('a changed model/thinking setting restarts the harness and resumes the same Claude session', async () => {
    const r = await newRig();
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'one');
    await idle(r, s.id);
    r.h.session(s.id).thinking = false;
    await r.engine.send(s.id, 'two');
    await idle(r, s.id);
    expect(r.queries).toHaveLength(2);
    expect(r.queries[0]!.closed).toBe(true);
    expect(r.queries[0]!.options.thinking).toEqual({ type: 'adaptive' });
    expect(r.queries[1]!.options).toMatchObject({ resume: 'sdk-1', thinking: { type: 'disabled' } });
  });

  it('an endpoint without /v1/messages fails the turn with a clear error', async () => {
    const r = await newRig();
    r.probe.reason = 'This model endpoint does not serve the Anthropic Messages API (/v1/messages)';
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'hi');
    await idle(r, s.id);
    expect(r.h.session(s.id).status).toBe('error');
    expect((r.h.eventsOf('error')[0] as { message: string }).message).toContain('/v1/messages');
    expect(r.queries).toHaveLength(0);
  });

  it('API errors reported in the result become an error event', async () => {
    const r = await newRig(async (_u, q) => { q.emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 boom', usage: {} }); });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, 'hi');
    await idle(r, s.id);
    expect(r.h.session(s.id).status).toBe('error');
    expect((r.h.eventsOf('error')[0] as { message: string }).message).toContain('API Error: 500');
  });

  it('slash commands: Claude Code\'s live list; /commands pass through as command-tagged messages', async () => {
    let sent = '';
    const r = await newRig(async (u, q) => { sent = textOf(u); q.emit({ type: 'user', isReplay: true, parent_tool_use_id: null, message: { role: 'user', content: `<local-command-stdout>${sent} output</local-command-stdout>` } }); result(q, '', { local_command: 'cost' }); });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    expect((await r.engine.commands(s.id)).map((c) => c.name)).toContain('compact'); // static fallback before a process runs
    await r.engine.send(s.id, '/cost');
    await idle(r, s.id);
    expect((await r.engine.commands(s.id)).map((c) => c.name)).toEqual(['compact', 'review']);
    const msgs = r.h.session(s.id).messages;
    expect(msgs[0]).toMatchObject({ role: 'user', tag: 'command' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', tag: 'command', blocks: [{ type: 'text', text: '/cost output' }] });
    expect(sent).toBe('/cost');
  });

  it('/cost output is shown once (not billed) and not re-emitted after /compact', async () => {
    const cost = ['Total cost:            $0.0365 (costs may be inaccurate due to usage of unknown models)', 'Total duration (API):  15s', 'Usage by model:', 'qwen3:  2.2k input, 9 output ($0.0365)'].join(String.fromCharCode(10));
    const synthetic = (q: FakeQuery) => q.emit({
      type: 'assistant', uuid: `uuid-${++uuidN}`, parent_tool_use_id: null, local_command_source: `<local-command-stdout>${cost}</local-command-stdout>`,
      message: { id: `syn-${uuidN}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: cost }] },
    });
    const r = await newRig(async (u, q) => {
      const t = textOf(u);
      if (t === '/cost') synthetic(q);
      if (t === '/compact') {
        q.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 17854 } });
        synthetic(q); // Claude Code carries the earlier local command output into the new context and emits it again
        q.emit({ type: 'user', isReplay: true, parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } });
      }
      result(q, '');
    });
    const s = r.h.createSession({ engine: 'claude-code', title: 'x' });
    await r.engine.send(s.id, '/cost');
    await idle(r, s.id);
    await r.engine.send(s.id, '/compact');
    await idle(r, s.id);
    const msgs = r.h.session(s.id).messages;
    const texts = msgs.map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));
    expect(msgs.map((m) => m.tag ?? m.role)).toEqual(['command', 'assistant', 'command', 'compact_summary']);
    expect(texts[1]).toContain('Total cost:            $0.00 (local model, not billed)');
    expect(texts[1]).toContain('qwen3:  2.2k input, 9 output');
    expect(texts[1]).not.toMatch(/\$0\.0365|unknown models/);
  });
});

describe('EngineRouter', () => {
  it('routes by session.engine, switches engines only when idle and seeds Claude Code with the transcript', async () => {
    const r = await newRig();
    let firstPrompt = '';
    r.setTurn(async (u, q) => { firstPrompt ||= textOf(u); say(q, 'ok'); result(q); });
    const router = new EngineRouter(r.h.ctx, { builtin: r.h.agent });
    (router as unknown as { claude: ClaudeCodeEngine }).claude.dispose();
    Object.defineProperty(router, 'claude', { value: r.engine });
    const s = r.h.createSession({ title: 'x' });
    s.messages.push(
      { id: 'u0', role: 'user', createdAt: 1, blocks: [{ type: 'text', text: 'What is 6*7?' }] },
      { id: 'a0', role: 'assistant', createdAt: 2, blocks: [{ type: 'text', text: 'It is 42.' }] },
    );
    expect(router.engineOf(s.id)).toBe('builtin');
    r.h.session(s.id).status = 'running';
    expect(() => router.setEngine(s.id, 'claude-code')).toThrow(/turn to finish/);
    r.h.session(s.id).status = 'idle';
    expect(router.setEngine(s.id, 'claude-code').engine).toBe('claude-code');
    expect(router.engineOf(s.id)).toBe('claude-code');
    await router.send(s.id, 'And doubled?');
    await idle(r, s.id);
    expect(firstPrompt).toContain('Transcript so far');
    expect(firstPrompt).toContain('It is 42.');
    expect(firstPrompt.trim().endsWith('And doubled?')).toBe(true);
    expect(router.isRunning(s.id)).toBe(false);
    expect((await router.engines()).map((e) => [e.id, e.available])).toEqual([['builtin', true], ['claude-code', true]]);
    expect((await router.commands(r.h.cwd, s.id)).map((c) => c.name)).toEqual(['compact', 'review']);
    expect((await router.commands(r.h.cwd)).map((c) => c.name)).toEqual(['greet']);
    expect(existsSync(join(r.h.dir, 'claude-code'))).toBe(true);
  });
});
