// Spike: run the real Claude Code harness (Claude Agent SDK) against the user's local llama-server and capture the
// SDK message shapes the ClaudeCodeEngine has to translate. Results: docs/research/claude-agent-sdk.md, fixtures in
// tests/fixtures/claude-code/*.jsonl.
//
//   npx tsx scripts/claude-code-spike.ts [probe ...]      (default: all probes, one request at a time)
//
// Env: SPIKE_BASE_URL (default http://127.0.0.1:8080), SPIKE_MODEL (default: first /v1/models id).
// Uses an ISOLATED CLAUDE_CONFIG_DIR in the OS temp dir — never the user's ~/.claude.

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClaudeEnv, resolveClaudeExecutable } from '../src/core/engine/env';
import { AnthropicShim } from '../src/core/engine/shim';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage;
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
type Options = import('@anthropic-ai/claude-agent-sdk').Options;

const BASE = process.env.SPIKE_BASE_URL ?? 'http://127.0.0.1:8080';
const OUT = resolve(__dirname, '..', 'tests', 'fixtures', 'claude-code');
/** Raw request bodies Claude Code sent (large; not fixtures). */
const REQ_DIR = process.env.SPIKE_REQ_DIR ?? join(tmpdir(), 'oc-claude-spike-requests');
mkdirSync(OUT, { recursive: true });
mkdirSync(REQ_DIR, { recursive: true });

let currentProbe = 'init';
let reqSeq = 0;
const network: { probe: string; kind: 'model' | 'other-local' | 'egress'; target: string; cls?: string; blocked?: boolean }[] = [];
const BLOCK = /(^|\.)(anthropic\.com|claude\.ai|claude\.com|claudeusercontent\.com|statsig\.com|statsig\.anthropic\.com|sentry\.io|datadoghq\.com|growthbook\.io)$/i;

/** Recording reverse proxy in front of the model server: every model call Claude Code makes passes through here. */
function startModelProxy(upstream: string): Promise<string> {
  return new Promise((ok) => {
    const target = new URL(upstream);
    const srv = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const cls = String(req.headers['x-claude-code-request-class'] ?? '');
        network.push({ probe: currentProbe, kind: 'model', target: `${req.method} ${req.url}`, cls });
        if (req.url?.startsWith('/v1/messages') && body.length) writeFileSync(join(REQ_DIR, `${currentProbe}-${String(++reqSeq).padStart(3, '0')}-${cls || 'x'}${req.url.includes('count_tokens') ? '-count' : ''}.json`), body);
        const headers = { ...req.headers, host: target.host, 'content-length': String(body.length) };
        const up = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname + (req.url ?? ''), method: req.method, headers }, (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        });
        up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
        up.end(body);
      });
    });
    srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
  });
}

/** HTTPS_PROXY for the Claude Code process: records every egress host, refuses Anthropic/telemetry hosts, tunnels the rest. */
function startEgressProxy(): Promise<string> {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      const host = (() => { try { return new URL(req.url ?? '').hostname; } catch { return String(req.headers.host ?? ''); } })();
      network.push({ probe: currentProbe, kind: 'egress', target: `http ${host}`, blocked: true });
      res.writeHead(403); res.end();
    });
    srv.on('connect', (req: IncomingMessage, sock, head: Buffer) => {
      const [host = '', port = '443'] = String(req.url ?? '').split(':');
      const blocked = BLOCK.test(host);
      network.push({ probe: currentProbe, kind: 'egress', target: `${host}:${port}`, blocked });
      if (blocked) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const up = netConnect(Number(port), host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    });
    srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
  });
}

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
      await session(ctx, 'task', ['You MUST delegate this to a subagent: call the Agent tool with subagent_type "general-purpose", description "Read a.txt" and a prompt asking it to read a.txt in the current directory and report its exact content. Do not read the file yourself. Then reply with what the subagent reported.'], {
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
    name: 'webfetch',
    async run(ctx) {
      await session(ctx, 'webfetch', ['Use the WebFetch tool on https://example.com with the prompt "What is the page title?" and reply with the title only.'], {
        systemPrompt: lean(ctx.work), thinking: { type: 'disabled' },
        canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
      });
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
  // Claude Code → recording proxy → the engine's compatibility shim → llama-server
  const shimUrl = await new AnthropicShim().baseUrl({ baseUrl: BASE });
  const modelProxy = await startModelProxy(shimUrl);
  const egress = await startEgressProxy();
  const env = buildClaudeEnv({ baseEnv: process.env, baseUrl: modelProxy, apiKey: 'local', model, contextLength: nCtx, configDir });
  Object.assign(env, { HTTPS_PROXY: egress, HTTP_PROXY: egress, https_proxy: egress, http_proxy: egress, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' });
  const baseOptions: Options = {
    cwd: work, model, env, includePartialMessages: true, permissionMode: 'default', settingSources: ['project'],
    disallowedTools: ['WebSearch'], settings: { skipWebFetchPreflight: true }, pathToClaudeCodeExecutable: exe.path ?? undefined,
    stderr: (d) => appendFileSync(join(REQ_DIR, 'stderr.log'), d),
  };
  const only = process.argv.slice(2);
  for (const p of probes) {
    if (only.length && !only.includes(p.name)) continue;
    const file = join(OUT, `${p.name}.jsonl`);
    writeFileSync(file, '');
    const t0 = Date.now();
    currentProbe = p.name;
    console.log(`── probe ${p.name}`);
    try {
      await p.run({
        sdk, model, baseOptions, work,
        // thinking_tokens progress messages are noise for the fixtures
        record: (name) => (m) => { if ((m as { subtype?: string }).subtype !== 'thinking_tokens') appendFileSync(join(OUT, `${name}.jsonl`), `${JSON.stringify(m)}\n`); },
      });
    } catch (e) {
      console.error(`[${p.name}] FAILED`, e instanceof Error ? e.stack : e);
    }
    console.log(`── probe ${p.name} took ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  const netFile = join(OUT, 'network.json');
  let prev: typeof network = [];
  try { prev = JSON.parse(readFileSync(netFile, 'utf8')) as typeof network; } catch { /* first run */ }
  const ran = new Set(network.map((n) => n.probe));
  writeFileSync(netFile, JSON.stringify([...prev.filter((n) => !ran.has(n.probe)), ...network], null, 2));
  console.log('network', JSON.stringify(network.reduce<Record<string, number>>((a, n) => { const k = `${n.kind} ${n.kind === 'model' ? n.cls : n.target}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})));
  process.exit(0);
}

void main();
