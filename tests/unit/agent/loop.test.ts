import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@shared/types';
import { TRUNCATED_TOOL_CALL_ERROR } from '@core/llm/parser';
import { qwenXmlToolCall } from '../../fixtures/mock-llm/server';
import { createHarness, toolLog, type Harness } from './helpers';

let h: Harness;
afterEach(async () => { await h?.close(); toolLog.length = 0; });

function tools(h: Harness, sessionId: string): ToolUseBlock[] {
  return h.session(sessionId).messages.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
}

function chatRequests(h: Harness) {
  return h.mock.requests.filter((r) => !String(r.body.messages?.at(-1)?.content ?? '').startsWith('Write a short title'));
}

describe('agent loop', () => {
  it('streams a reply: events, persistence, usage, title, system prompt + tools sent', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ reasoning: 'Let me think.', text: 'Hello there!' });
    const r = await h.agent.send(s.id, 'Say hi');
    expect(r.queued).toBe(false);
    await h.waitIdle(s.id);
    const msgs = h.session(s.id).messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]!.id).toBe(r.messageId);
    expect(msgs[1]!.blocks).toMatchObject([{ type: 'thinking', text: 'Let me think.' }, { type: 'text', text: 'Hello there!' }]);
    expect((msgs[1]!.blocks[0] as { durationMs?: number }).durationMs).toBeTypeOf('number');
    expect(h.eventsOf('message.added')).toHaveLength(2);
    expect(h.eventsOf('message.delta').length).toBeGreaterThan(2);
    expect(h.eventsOf('message.completed')).toHaveLength(1);
    const st = h.session(s.id);
    expect(st.status).toBe('idle');
    expect(st.usage.requests).toBe(1);
    expect(st.usage.lastPromptTokens).toBeGreaterThan(0);
    expect(st.model).toEqual({ provider: 'local', model: 'mock-qwen3-uncensored' });
    await h.until(() => h.session(s.id).title === 'Mock Title', 4000, 'title');
    const body = chatRequests(h)[0]!.body;
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Obsidian Code');
    expect(body.messages[0].content).not.toMatch(/refuse|content policy|harmful/i);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('Read');
    expect(h.activity.get(s.id)?.status).toBe('done');
  });

  it('runs concurrency-safe tools in parallel and keeps call order + reasoning in history', async () => {
    h = await createHarness();
    await fs.writeFile(join(h.cwd, 'a.txt'), 'AAA');
    await fs.writeFile(join(h.cwd, 'b.txt'), 'BBB');
    const s = h.createSession();
    h.mock.enqueue(
      { reasoning: 'read both', toolCalls: [{ name: 'Read', arguments: { file_path: 'a.txt' } }, { name: 'Read', arguments: { file_path: 'b.txt' } }] },
      { text: 'Both read.' },
    );
    await h.agent.send(s.id, 'read a and b');
    await h.waitIdle(s.id);
    const reads = toolLog.filter((t) => t.name === 'Read');
    expect(reads).toHaveLength(2);
    expect(reads[0]!.start < reads[1]!.end && reads[1]!.start < reads[0]!.end).toBe(true); // overlapped
    const ts = tools(h, s.id);
    expect(ts.map((t) => [t.status, t.result?.content])).toEqual([['done', 'AAA'], ['done', 'BBB']]);
    const second = chatRequests(h)[1]!.body.messages;
    const asst = second.find((m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && m.tool_calls);
    expect(asst.reasoning_content).toBe('read both');
    const toolMsgs = second.filter((m: { role: string }) => m.role === 'tool');
    expect(toolMsgs.map((m: { tool_call_id: string; content: string }) => [m.tool_call_id, m.content])).toEqual([[ts[0]!.id, 'AAA'], [ts[1]!.id, 'BBB']]);
    // byte-stable system prompt + tool list across the turn
    expect(second[0]).toEqual(chatRequests(h)[0]!.body.messages[0]);
    expect(chatRequests(h)[1]!.body.tools).toEqual(chatRequests(h)[0]!.body.tools);
    expect(h.eventsOf('tool.updated').some((e) => e.tool.status === 'running')).toBe(true);
  });

  it('runs non-concurrency-safe tools sequentially (acceptEdits auto-allows edits in cwd)', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'acceptEdits' });
    h.mock.enqueue(
      { toolCalls: [{ name: 'Write', arguments: { file_path: 'x.txt', content: '1' } }, { name: 'Write', arguments: { file_path: 'y.txt', content: '2' } }] },
      { text: 'done' },
    );
    await h.agent.send(s.id, 'write files');
    await h.waitIdle(s.id);
    const w = toolLog.filter((t) => t.name === 'Write');
    expect(w).toHaveLength(2);
    expect(w[1]!.start).toBeGreaterThanOrEqual(w[0]!.end);
    expect(h.eventsOf('permission.requested')).toHaveLength(0);
    expect(await fs.readFile(join(h.cwd, 'y.txt'), 'utf8')).toBe('2');
    expect(h.session(s.id).changedFiles.map((f) => f.isNew)).toEqual([true, true]);
  });

  it('acceptEdits still asks for edits outside the cwd', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'acceptEdits' });
    h.mock.enqueue({ toolCalls: [{ name: 'Write', arguments: { file_path: join(h.dir, 'outside.txt'), content: '1' } }] }, { text: 'ok' });
    await h.agent.send(s.id, 'write outside');
    await h.until(() => h.eventsOf('permission.requested').length === 1, 4000, 'permission');
    const req = h.eventsOf('permission.requested')[0]!;
    h.agent.respondPermission(req.requestId, 'allow');
    await h.waitIdle(s.id);
    expect(tools(h, s.id)[0]!.status).toBe('done');
  });

  it('permission ask → allow / deny with feedback / allow_always persists the rule', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue(
      { toolCalls: [{ name: 'Bash', arguments: { command: 'npm test' } }] },
      { toolCalls: [{ name: 'Bash', arguments: { command: 'rm -rf build' } }] },
      { toolCalls: [{ name: 'Bash', arguments: { command: 'npm run lint' } }] },
      { toolCalls: [{ name: 'Bash', arguments: { command: 'npm install' } }] },
      { text: 'All done.' },
    );
    await h.agent.send(s.id, 'do things');
    // 1: allow
    await h.until(() => h.agent.pending(s.id).permissions.length === 1, 4000, 'perm 1');
    let p = h.agent.pending(s.id).permissions[0]!;
    expect(p).toMatchObject({ toolName: 'Bash', title: 'Run: npm test', suggestedRule: 'Bash(npm:*)', sessionId: s.id });
    expect(h.session(s.id).status).toBe('waiting');
    expect(tools(h, s.id)[0]!.status).toBe('awaiting_permission');
    h.agent.respondPermission(p.requestId, 'allow');
    // 2: deny with feedback → loop continues
    await h.until(() => h.agent.pending(s.id).permissions.length === 1 && h.agent.pending(s.id).permissions[0]!.requestId !== p.requestId, 4000, 'perm 2');
    p = h.agent.pending(s.id).permissions[0]!;
    h.agent.respondPermission(p.requestId, 'deny', 'do not delete build');
    // 3: allow_always → rule saved to project
    await h.until(() => h.agent.pending(s.id).permissions.length === 1 && h.agent.pending(s.id).permissions[0]!.title === 'Run: npm run lint', 4000, 'perm 3');
    p = h.agent.pending(s.id).permissions[0]!;
    h.agent.respondPermission(p.requestId, 'allow_always');
    // 4: auto-allowed by the saved rule
    await h.waitIdle(s.id);
    expect(h.projectAllow).toEqual(['Bash(npm:*)']);
    const ts = tools(h, s.id);
    expect(ts.map((t) => t.status)).toEqual(['done', 'denied', 'done', 'done']);
    expect(ts[1]!.result?.content).toContain('do not delete build');
    expect(h.eventsOf('permission.requested')).toHaveLength(3);
    expect(h.eventsOf('permission.resolved').map((e) => e.decision)).toEqual(['allow', 'deny', 'allow_always']);
    expect(h.session(s.id).status).toBe('idle');
  });

  it('deny without feedback stops the turn', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'make' } }] }, { text: 'should not be requested' });
    await h.agent.send(s.id, 'build');
    await h.until(() => h.agent.pending().permissions.length === 1, 4000, 'perm');
    h.agent.respondPermission(h.agent.pending().permissions[0]!.requestId, 'deny');
    await h.waitIdle(s.id);
    expect(chatRequests(h)).toHaveLength(1);
    expect(tools(h, s.id)[0]!.status).toBe('denied');
  });

  it('deny rules win, also in bypassPermissions mode; settings allow rules skip the prompt', async () => {
    h = await createHarness({ settings: { permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm:*)'] } } });
    const s = h.createSession({ permissionMode: 'bypassPermissions' });
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'echo hi && rm -rf /' } }] }, { text: 'ok' });
    await h.agent.send(s.id, 'x');
    await h.waitIdle(s.id);
    expect(tools(h, s.id)[0]).toMatchObject({ status: 'denied' });
    expect(tools(h, s.id)[0]!.result?.content).toContain('Bash(rm:*)');
    const s2 = h.createSession();
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'git status' } }] }, { text: 'ok' });
    await h.agent.send(s2.id, 'y');
    await h.waitIdle(s2.id);
    expect(tools(h, s2.id)[0]!.status).toBe('done');
  });

  it('plan mode: rejects edits at execution, ExitPlanMode approval switches the mode', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'plan' });
    h.mock.enqueue(
      { toolCalls: [{ name: 'Read', arguments: { file_path: 'a.txt' } }, { name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } }] },
      { toolCalls: [{ name: 'ExitPlanMode', arguments: { plan: '1. write a.txt' } }] },
      { toolCalls: [{ name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } }] },
      { text: 'Implemented.' },
    );
    await h.agent.send(s.id, 'plan it');
    await h.until(() => h.agent.pending(s.id).plans.length === 1, 4000, 'plan request');
    const plan = h.agent.pending(s.id).plans[0]!;
    expect(plan.plan).toBe('1. write a.txt');
    h.agent.respondPlan(plan.requestId, true, 'acceptEdits');
    await h.waitIdle(s.id);
    const ts = tools(h, s.id);
    expect(ts.map((t) => t.status)).toEqual(['done', 'error', 'done', 'done']);
    expect(ts[1]!.result?.content).toMatch(/Plan mode is active/);
    expect(ts[2]!.result?.content).toBe('approved (acceptEdits)');
    expect(h.session(s.id).permissionMode).toBe('acceptEdits');
    // the plan-mode reminder rides in the user message; tool list is NOT filtered in plan mode
    const first = chatRequests(h)[0]!.body;
    expect(JSON.stringify(first.messages.at(-1).content)).toContain('Plan mode is active');
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('Write');
    expect(h.eventsOf('plan.resolved')[0]).toMatchObject({ approved: true });
  });

  it('plan rejected without feedback waits for the user', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'plan' });
    h.mock.enqueue({ toolCalls: [{ name: 'ExitPlanMode', arguments: { plan: 'p' } }] }, { text: 'nope' });
    await h.agent.send(s.id, 'plan');
    await h.until(() => h.agent.pending(s.id).plans.length === 1, 4000, 'plan');
    h.agent.respondPlan(h.agent.pending(s.id).plans[0]!.requestId, false);
    await h.waitIdle(s.id);
    expect(chatRequests(h)).toHaveLength(1);
    expect(h.session(s.id).permissionMode).toBe('plan');
  });

  it('AskUserQuestion flow: question.requested → pending() → answerQuestion', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ toolCalls: [{ name: 'AskUserQuestion', arguments: { question: 'Which DB?' } }] }, { text: 'Using B.' });
    await h.agent.send(s.id, 'set up db');
    await h.until(() => h.agent.pending(s.id).questions.length === 1, 4000, 'question');
    const q = h.agent.pending(s.id).questions[0]!;
    expect(q.questions[0]!.question).toBe('Which DB?');
    expect(h.eventsOf('question.requested')).toHaveLength(1);
    h.agent.answerQuestion(q.requestId, { 'Which DB?': 'B' });
    await h.waitIdle(s.id);
    expect(tools(h, s.id)[0]!.result?.content).toBe('Answer: B');
    expect(h.eventsOf('question.resolved')).toHaveLength(1);
    expect(h.agent.pending().questions).toHaveLength(0);
  });

  it('queues messages sent while running and processes them after the turn', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ text: 'first answer', chunkDelayMs: 40 }, { text: 'second answer' });
    const a = await h.agent.send(s.id, 'one');
    const b = await h.agent.send(s.id, 'two');
    expect(a.queued).toBe(false);
    expect(b.queued).toBe(true);
    expect(h.agent.isRunning(s.id)).toBe(true);
    await h.waitIdle(s.id);
    const msgs = h.session(s.id).messages;
    expect(msgs.map((m) => [m.role, m.blocks.map((x) => (x as { text?: string }).text).join('')])).toEqual([
      ['user', 'one'], ['assistant', 'first answer'], ['user', 'two'], ['assistant', 'second answer'],
    ]);
    expect(msgs[2]!.id).toBe(b.messageId);
  });

  it('dequeue withdraws queued messages that have not started (the running turn is untouched)', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ text: 'first answer', chunkDelayMs: 40 }, { text: 'third answer' });
    await h.agent.send(s.id, 'one');
    const b = await h.agent.send(s.id, 'two');
    const c = await h.agent.send(s.id, 'three');
    expect(h.agent.dequeue(s.id, b.messageId)).toEqual([{ messageId: b.messageId, text: 'two' }]);
    expect(h.agent.dequeue(s.id, b.messageId)).toEqual([]); // already gone
    await h.waitIdle(s.id);
    const msgs = h.session(s.id).messages;
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.id)).toEqual([msgs[0]!.id, c.messageId]);
    expect(h.agent.dequeue(s.id)).toEqual([]);
  });

  it('interrupt mid-stream keeps partial text, marks interrupted, closes the HTTP stream', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ text: 'partial answer here', hangAfter: 4 });
    await h.agent.send(s.id, 'long task');
    await h.until(() => h.eventsOf('message.delta').length >= 2, 4000, 'deltas');
    h.agent.interrupt(s.id);
    await h.waitIdle(s.id);
    const last = h.session(s.id).messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.meta?.interrupted).toBe(true);
    expect(last.blocks[0]).toMatchObject({ type: 'text' });
    expect((last.blocks[0] as { text: string }).text.length).toBeGreaterThan(0);
    expect(h.session(s.id).status).toBe('idle');
    await h.until(() => h.mock.aborted >= 1, 2000, 'server saw abort');
    expect(h.activity.get(s.id)?.status).toBe('stopped');
  });

  it('interrupt mid-tool aborts the tool and marks it interrupted', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'bypassPermissions' });
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'sleep 10' } }, { name: 'Bash', arguments: { command: 'echo after' } }] });
    await h.agent.send(s.id, 'sleep');
    await h.until(() => tools(h, s.id)[0]?.status === 'running', 4000, 'tool running');
    await h.until(() => tools(h, s.id)[0]?.progress === 'sleeping…', 2000, 'progress');
    const t0 = Date.now();
    h.agent.interrupt(s.id);
    await h.waitIdle(s.id);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(tools(h, s.id).map((t) => t.status)).toEqual(['interrupted', 'interrupted']);
    expect(chatRequests(h)).toHaveLength(1);
  });

  it('interrupt while awaiting permission resolves the request', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'make' } }] });
    await h.agent.send(s.id, 'build');
    await h.until(() => h.agent.pending().permissions.length === 1, 4000, 'perm');
    h.agent.interrupt(s.id);
    await h.waitIdle(s.id);
    expect(h.agent.pending().permissions).toHaveLength(0);
    expect(tools(h, s.id)[0]!.status).toBe('interrupted');
    expect(h.eventsOf('permission.resolved')).toHaveLength(1);
  });

  it('text-form (Qwen XML) tool calls in content are executed', async () => {
    h = await createHarness();
    await fs.writeFile(join(h.cwd, 'q.txt'), 'QQQ');
    const s = h.createSession();
    h.mock.enqueue({ text: qwenXmlToolCall('Read', { file_path: 'q.txt' }) }, { text: 'read it' });
    await h.agent.send(s.id, 'read q');
    await h.waitIdle(s.id);
    expect(tools(h, s.id)[0]).toMatchObject({ name: 'Read', status: 'done', result: { content: 'QQQ' } });
    expect(h.session(s.id).messages[1]!.blocks.some((b) => b.type === 'text')).toBe(false);
  });

  it('truncated tool call (finish_reason length) is never executed; the model gets an error', async () => {
    h = await createHarness();
    const s = h.createSession({ permissionMode: 'bypassPermissions' });
    h.mock.enqueue({ toolCalls: [{ name: 'Write', arguments: '{"file_path":"big.txt","content":"aaa' }], finishReason: 'length' }, { text: 'retrying smaller' });
    await h.agent.send(s.id, 'write big');
    await h.waitIdle(s.id);
    expect(toolLog.filter((t) => t.name === 'Write')).toHaveLength(0);
    const t = tools(h, s.id)[0]!;
    expect(t.status).toBe('error');
    expect(t.result?.content).toBe(TRUNCATED_TOOL_CALL_ERROR);
    const second = chatRequests(h)[1]!.body.messages;
    const asst = second.find((m: { tool_calls?: unknown[] }) => m.tool_calls);
    expect(asst.tool_calls[0].function.arguments).toBe('{}');
  });

  it('unknown tool and invalid arguments become tool errors', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ toolCalls: [{ name: 'Nope', arguments: {} }, { name: 'Read', arguments: '{bad json' }] }, { text: 'ok' });
    await h.agent.send(s.id, 'x');
    await h.waitIdle(s.id);
    const ts = tools(h, s.id);
    expect(ts[0]!.result?.content).toMatch(/Unknown tool "Nope"/);
    expect(ts[1]!.result?.content).toMatch(/not valid JSON/);
  });

  it('tool output is truncated to maxToolOutputChars with a note', async () => {
    h = await createHarness({ settings: { maxToolOutputChars: 1000 } });
    const s = h.createSession({ permissionMode: 'bypassPermissions' });
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'big' } }] }, { text: 'ok' });
    await h.agent.send(s.id, 'x');
    await h.waitIdle(s.id);
    const c = tools(h, s.id)[0]!.result!.content;
    expect(c.length).toBeLessThan(1300);
    expect(c).toMatch(/output truncated/);
  });

  it('hooks: UserPromptSubmit context → reminder; PreToolUse can block; Stop can continue once', async () => {
    h = await createHarness();
    const seen: string[] = [];
    let stopCount = 0;
    h.hooks.fn = async (event, payload) => {
      seen.push(event);
      if (event === 'UserPromptSubmit') return { block: false, additionalContext: 'Remember the codeword: owl' };
      if (event === 'PreToolUse' && (payload.tool_input as { command?: string }).command === 'blocked') return { block: true, message: 'nope' };
      if (event === 'Stop' && stopCount++ === 0) return { block: true, message: 'also run the tests' };
      return { block: false };
    };
    const s = h.createSession({ permissionMode: 'bypassPermissions' });
    h.mock.enqueue({ toolCalls: [{ name: 'Bash', arguments: { command: 'blocked' } }] }, { text: 'first stop' }, { text: 'tests ran' });
    await h.agent.send(s.id, 'go');
    await h.waitIdle(s.id);
    expect(seen).toContain('SessionStart');
    expect(seen.filter((e) => e === 'Stop')).toHaveLength(2);
    expect(tools(h, s.id)[0]).toMatchObject({ status: 'denied' });
    expect(tools(h, s.id)[0]!.result?.content).toContain('nope');
    const firstUser = chatRequests(h)[0]!.body.messages[1].content;
    expect(JSON.stringify(firstUser)).toContain('codeword: owl');
    expect(JSON.stringify(chatRequests(h)[2]!.body.messages.at(-1).content)).toContain('also run the tests');
  });

  it('headless run: permission prompts auto-denied, questions auto-answered', async () => {
    h = await createHarness();
    const s = h.createSession({ kind: 'scheduled' });
    h.mock.enqueue(
      { toolCalls: [{ name: 'Bash', arguments: { command: 'deploy' } }, { name: 'AskUserQuestion', arguments: { question: 'Sure?' } }] },
      { text: 'Report: could not deploy.' },
    );
    const r = await h.agent.runHeadless({ sessionId: s.id, prompt: 'nightly deploy' });
    expect(r).toEqual({ ok: true, finalText: 'Report: could not deploy.' });
    const ts = tools(h, s.id);
    expect(ts[0]!.status).toBe('denied');
    expect(ts[0]!.result?.content).toMatch(/unattended/);
    expect(ts[1]!.result?.content).toBe('Answer: (no answer — running unattended)');
    expect(h.eventsOf('permission.requested')).toHaveLength(0);
    expect(h.session(s.id).messages[0]!.tag).toBe('scheduled_prompt');
  });

  it('LLM errors set status error and emit an error event', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ httpError: { status: 500, body: { error: { message: 'Jinja Exception: boom', type: 'server_error' } } } });
    await h.agent.send(s.id, 'x');
    await h.waitIdle(s.id);
    expect(h.session(s.id).status).toBe('error');
    expect(h.eventsOf('error')[0]!.message).toMatch(/Jinja Exception: boom/);
    // the empty assistant message is removed
    expect(h.session(s.id).messages.map((m) => m.role)).toEqual(['user']);
  });

  it('friendly error when the model provider is offline', async () => {
    h = await createHarness();
    const s = h.createSession({ model: { provider: 'vast', model: 'x' } });
    await h.agent.send(s.id, 'x');
    await h.waitIdle(s.id);
    expect(h.eventsOf('error')[0]!.message).toBe("Your Vast GPU isn't clocked in — clock in or pick the Local model.");
  });

  it('images are sent as image_url data URLs when the model supports vision, else omitted', async () => {
    h = await createHarness({ vision: false });
    const s = h.createSession();
    h.mock.enqueue({ text: 'cannot see' });
    await h.agent.send(s.id, 'what is this', [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' }]);
    await h.waitIdle(s.id);
    const content = chatRequests(h)[0]!.body.messages[1].content;
    expect(JSON.stringify(content)).toContain('image omitted');
    await h.close();
    h = await createHarness({ vision: true });
    const s2 = h.createSession();
    h.mock.enqueue({ text: 'red' });
    await h.agent.send(s2.id, 'what is this', [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    await h.waitIdle(s2.id);
    const c2 = chatRequests(h)[0]!.body.messages[1].content;
    expect(c2).toEqual([{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }]);
  });
});
