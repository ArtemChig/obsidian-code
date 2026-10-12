// Spike: run the real Claude Code harness (Claude Agent SDK) against the user's local llama-server and capture the
// SDK message shapes the ClaudeCodeEngine has to translate. Results: docs/research/claude-agent-sdk.md, fixtures in
// tests/fixtures/claude-code/*.jsonl.
//
//   npx tsx scripts/claude-code-spike.ts [probe ...]      (default: all probes, one request at a time)
//
// Env: SPIKE_BASE_URL (default http://127.0.0.1:8080), SPIKE_MODEL (default: first /v1/models id).
// Uses an ISOLATED CLAUDE_CONFIG_DIR in the OS temp dir — never the user's ~/.claude.

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClaudeEnv, resolveClaudeExecutable } from '../src/core/engine/env';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage;
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
type Options = import('@anthropic-ai/claude-agent-sdk').Options;

const BASE = process.env.SPIKE_BASE_URL ?? 'http://127.0.0.1:8080';
const OUT = resolve(__dirname, '..', 'tests', 'fixtures', 'claude-code');
mkdirSync(OUT, { recursive: true });

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(text: string): void {
    const m: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false }); else this.items.push(m);
  }
  close(): void { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

interface Probe { name: string; run(ctx: ProbeCtx): Promise<void> }
interface ProbeCtx { sdk: Sdk; model: string; baseOptions: Options; work: string; record(name: string): (m: unknown) => void }

function lean(cwd: string): string {
  return [
    'You are Obsidian Code, an AI agent that works on the user\'s computer through tools.',
    `# Environment\n- Working directory: ${cwd}\n- OS: Windows`,
    '# Style\n- Be concise and direct.',
  ].join('\n\n');
}

/** Run one streaming-input session: send each prompt after the previous turn's result. */
async function session(ctx: ProbeCtx, name: string, prompts: (string | ((q: import('@anthropic-ai/claude-agent-sdk').Query) => Promise<void>))[], extra: Partial<Options> = {}, onMsg?: (m: SDKMessage, q: import('@anthropic-ai/claude-agent-sdk').Query) => void): Promise<{ sessionId: string; timings: Record<string, number>[] }> {
  const rec = ctx.record(name);
  const input = new InputQueue();
  const q = ctx.sdk.query({ prompt: input, options: { ...ctx.baseOptions, ...extra } });
  let sessionId = '';
  const timings: Record<string, number>[] = [];
  let turnStart = 0;
  let firstDelta = 0;
  let promptTokens = 0;
  const it = q[Symbol.asyncIterator]();
  for (const p of prompts) {
    if (typeof p === 'function') { await p(q); continue; }
    turnStart = Date.now(); firstDelta = 0; promptTokens = 0;
    input.push(p);
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      const m = r.value;
      rec(m);
      onMsg?.(m, q);
      if ('session_id' in m && m.session_id) sessionId = m.session_id;
      if (m.type === 'stream_event') {
        const ev = m.event as { type: string; message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } } };
        if (!firstDelta && ev.type === 'content_block_delta') firstDelta = Date.now();
        if (ev.type === 'message_start' && m.parent_tool_use_id === null) promptTokens = (ev.message?.usage?.input_tokens ?? 0) + (ev.message?.usage?.cache_read_input_tokens ?? 0);
      }
      if (m.type === 'result') {
        const t = { totalMs: Date.now() - turnStart, ttftMs: firstDelta ? firstDelta - turnStart : -1, promptTokens, inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens };
        timings.push(t);
        console.log(`[${name}] turn done`, JSON.stringify(t), m.subtype, m.is_error ? 'ERROR' : '', 'result' in m ? String((m as { result?: string }).result ?? '').slice(0, 120) : (m as { errors?: string[] }).errors);
        break;
      }
    }
  }
  input.close();
  try { q.close(); } catch { /* ignore */ }
  return { sessionId, timings };
}

const probes: Probe[] = [
  {
    name: 'plain',
    async run(ctx) {
      const r = await session(ctx, 'plain', ['Reply with exactly: hello'], { systemPrompt: lean(ctx.work), thinking: { type: 'enabled', budgetTokens: 2048 } });
      writeFileSync(join(OUT, 'plain.session.txt'), r.sessionId);
      writeFileSync(join(OUT, 'timing-lean.json'), JSON.stringify(r.timings, null, 2));
    },
  },
  {
    name: 'preset',
    async run(ctx) {
      const r = await session(ctx, 'preset', ['Reply with exactly: hello'], { systemPrompt: { type: 'preset', preset: 'claude_code' }, thinking: { type: 'disabled' } });
      writeFileSync(join(OUT, 'timing-preset.json'), JSON.stringify(r.timings, null, 2));
    },
  },
  {
    name: 'tools',
    async run(ctx) {
      writeFileSync(join(ctx.work, 'a.txt'), 'alpha beta\n');
      const asked: unknown[] = [];
      await session(ctx, 'tools', [`Read the file a.txt, then use the Write tool to create b.txt containing the same text in UPPERCASE. Then reply "done".`], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' },
        canUseTool: async (toolName, input, opts) => {
          asked.push({ toolName, input, opts: { ...opts, signal: undefined } });
          return { behavior: 'allow', updatedInput: input };
        },
        hooks: {
          PreToolUse: [{ hooks: [async (inp) => { asked.push({ hook: 'PreToolUse', inp }); return { continue: true }; }] }],
          PostToolUse: [{ hooks: [async (inp) => { asked.push({ hook: 'PostToolUse', inp }); return { continue: true }; }] }],
        },
      });
      writeFileSync(join(OUT, 'tools.canUseTool.json'), JSON.stringify(asked, null, 2));
    },
  },
  {
    name: 'ask',
    async run(ctx) {
      const asked: unknown[] = [];
      await session(ctx, 'ask', ['Use the AskUserQuestion tool to ask me which color I prefer, with options "Red" and "Blue". After I answer, reply with only the color I chose.'], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' },
        canUseTool: async (toolName, input) => {
          asked.push({ toolName, input });
          if (toolName === 'AskUserQuestion') {
            const qs = (input.questions as { question: string }[]) ?? [];
            const answers: Record<string, string> = {};
            for (const q of qs) answers[q.question] = 'Blue';
            return { behavior: 'allow', updatedInput: { ...input, answers } };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      });
      writeFileSync(join(OUT, 'ask.canUseTool.json'), JSON.stringify(asked, null, 2));
    },
  },
  {
    name: 'plan',
    async run(ctx) {
      const asked: unknown[] = [];
      await session(ctx, 'plan', ['Plan how to create a file plan.txt containing "hi". Keep the plan to two lines, then call ExitPlanMode with it.'], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' }, permissionMode: 'plan',
        canUseTool: async (toolName, input) => {
          asked.push({ toolName, input });
          if (toolName === 'ExitPlanMode') return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
          return { behavior: 'allow', updatedInput: input };
        },
      });
      writeFileSync(join(OUT, 'plan.canUseTool.json'), JSON.stringify(asked, null, 2));
    },
  },
  {
    name: 'task',
    async run(ctx) {
      writeFileSync(join(ctx.work, 'a.txt'), 'alpha beta\n');
      await session(ctx, 'task', ['Use the Task tool (subagent_type "general-purpose") to read a.txt and report its exact content. Then reply with that content.'], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' }, forwardSubagentText: true,
        canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
      });
    },
  },
  {
    name: 'todo',
    async run(ctx) {
      await session(ctx, 'todo', ['Use the TodoWrite tool to create a todo list with two items ("one" in_progress, "two" pending). Then reply "ok".'], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' },
        canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
      });
    },
  },
  {
    name: 'mcp',
    async run(ctx) {
      const { z } = await import('zod');
      const server = ctx.sdk.createSdkMcpServer({
        name: 'obsidian', version: '1.0.0',
        tools: [ctx.sdk.tool('echo_upper', 'Return the text in upper case.', { text: z.string() }, async (args) => ({ content: [{ type: 'text', text: args.text.toUpperCase() }] }))],
      });
      const asked: unknown[] = [];
      await session(ctx, 'mcp', ['Call the echo_upper tool with text "abc" and reply with its result.'], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' }, mcpServers: { obsidian: server },
        canUseTool: async (toolName, input, opts) => { asked.push({ toolName, input, mcpServer: opts.mcpServer }); return { behavior: 'allow', updatedInput: input }; },
      });
      writeFileSync(join(OUT, 'mcp.canUseTool.json'), JSON.stringify(asked, null, 2));
    },
  },
  {
    name: 'interrupt',
    async run(ctx) {
      let fired = false;
      await session(ctx, 'interrupt', ['Count from 1 to 300, one number per line.', 'Reply with exactly: after'], { systemPrompt: lean(ctx.work), thinking: { type: 'disabled' } }, (m, q) => {
        if (!fired && m.type === 'stream_event' && (m.event as { type: string }).type === 'content_block_delta') {
          fired = true;
          setTimeout(() => { void q.interrupt().then((r) => console.log('[interrupt] receipt', JSON.stringify(r))); }, 1500);
        }
      });
    },
  },
  {
    name: 'resume',
    async run(ctx) {
      const sid = readFileSync(join(OUT, 'plain.session.txt'), 'utf8').trim();
      let commands: unknown = null;
      await session(ctx, 'resume', [
        async (q) => { commands = await q.supportedCommands(); },
        'What exactly did I ask you to reply with before? Answer in one line.',
        '/compact',
        'Reply with exactly: still here',
      ], { systemPrompt: lean(ctx.work), thinking: { type: 'disabled' }, resume: sid });
      writeFileSync(join(OUT, 'supported-commands.json'), JSON.stringify(commands, null, 2));
    },
  },
];

async function main(): Promise<void> {
  const sdk: Sdk = await import('@anthropic-ai/claude-agent-sdk');
  const models = await (await fetch(`${BASE}/v1/models`)).json() as { data: { id: string; meta?: { n_ctx?: number } }[] };
  const model = process.env.SPIKE_MODEL ?? models.data[0]!.id;
  const nCtx = models.data[0]?.meta?.n_ctx ?? 32768;
  const configDir = mkdtempSync(join(tmpdir(), 'oc-claude-spike-'));
  const work = mkdtempSync(join(tmpdir(), 'oc-claude-work-'));
  const exe = resolveClaudeExecutable('auto');
  console.log('model', model, 'n_ctx', nCtx, 'config', configDir, 'work', work, 'exe', exe);
  const env = buildClaudeEnv({ baseEnv: process.env, baseUrl: BASE, apiKey: 'local', model, contextLength: nCtx, configDir });
  const baseOptions: Options = {
    cwd: work, model, env, includePartialMessages: true, permissionMode: 'default', settingSources: ['project'],
    disallowedTools: ['WebSearch'], settings: { skipWebFetchPreflight: true }, pathToClaudeCodeExecutable: exe.path ?? undefined,
    stderr: (d) => appendFileSync(join(OUT, 'stderr.log'), d),
  };
  const only = process.argv.slice(2);
  for (const p of probes) {
    if (only.length && !only.includes(p.name)) continue;
    const file = join(OUT, `${p.name}.jsonl`);
    writeFileSync(file, '');
    const t0 = Date.now();
    console.log(`── probe ${p.name}`);
    try {
      await p.run({
        sdk, model, baseOptions, work,
        record: (name) => (m) => appendFileSync(join(OUT, `${name}.jsonl`), `${JSON.stringify(m)}\n`),
      });
    } catch (e) {
      console.error(`[${p.name}] FAILED`, e instanceof Error ? e.stack : e);
    }
    console.log(`── probe ${p.name} took ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

void main();
