// Real-model end-to-end scenarios against the user's LOCAL llama-server (SPEC §6 "Real-model E2E").
//
//   npx tsx scripts/e2e-real.ts [scenario...] [--engine builtin|claude-code] [--thinking] [--base http://127.0.0.1:8080] [--out results.json] [--keep]
//
// Scenarios are numbers or names (e.g. `3 edit 13`); none = all. Runs the core standalone (createCore) with a temp data
// dir, a temp sample project per scenario, and talks to it over WebSocket exactly like the UI. Permission prompts are
// allowed, questions get the first option, plans are approved with acceptEdits.
//
// All model traffic goes through a small recording proxy in this process (so we can read llama-server's `timings`
// — prompt_n / cache_n — and check that the system prompt + tool list stay byte-identical between turns).
// The local server is slow and shared (Hearth): scenarios run strictly sequentially, one request at a time.
//
// If the server is down, the run says so and exits with code 3 (unit tests cover the loop against tests/fixtures/mock-llm).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createCore, type CoreHandle } from '../src/core/index';
import { lastUserText, startMockLlm, type MockLlm, type MockRequest, type MockTurn } from '../tests/fixtures/mock-llm/server';
import type { NativeBridge } from '../src/core/contracts';
import type { CoreEventName, CoreEvents, RpcMethod, RpcParams, RpcResult } from '../src/shared/protocol';
import type { EngineId, Message, PermissionMode, Session, SessionSummary, ToolUseBlock } from '../src/shared/types';

// ───────────────────────────── args ─────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): boolean { return argv.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const BASE = (opt('base') ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const THINKING = flag('thinking');
const KEEP = flag('keep');
/** Write every recorded model request body next to --out (<out>.requests.json) for debugging. */
const DUMP = flag('dump');
/** claude-code engine system prompt: 'lean' (default, the app's compact prompt) or 'full' (Claude Code's own preset). */
const SYSPROMPT = opt('sysprompt') === 'full' ? 'claude_code' : 'lean';
/** Use the user's real ~/.claude memory + skills (importClaudeConfig) to measure the real-life prompt size. */
const USER_CONFIG = flag('user-config');
const OUT = opt('out');
/** Engine for the scenario sessions (sessions.create {engine}); default = the app default (builtin). */
const ENGINE = opt('engine');
if (ENGINE && ENGINE !== 'builtin' && ENGINE !== 'claude-code') { console.error(`--engine must be builtin or claude-code (got ${ENGINE})`); process.exit(2); }
/** Run the harness against tests/fixtures/mock-llm instead of the real server (self-check). */
const MOCK = flag('mock');
const optValues = new Set(['--base', '--out', '--engine', '--sysprompt'].map((f) => opt(f.slice(2))).filter((v): v is string => !!v));
const selectors = argv.filter((a) => !a.startsWith('--') && !optValues.has(a));

// ───────────────────────────── recording proxy ─────────────────────────────

interface ProxyRecord {
  seq: number;
  startedAt: number;
  /** ms until the first SSE byte / the first generated token (reasoning, text or tool call). */
  firstByteMs?: number;
  firstTokenMs?: number;
  totalMs?: number;
  body: { messages?: { role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown[] }[]; tools?: unknown[]; [k: string]: unknown };
  timings?: { prompt_n?: number; cache_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; predicted_per_second?: number; prompt_per_second?: number };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  finishReason?: string;
  status?: number;
  /** Client (the core) closed the connection before the stream finished — e.g. chat.interrupt. */
  clientAborted?: boolean;
  /** Raw `<tool_call>` / `<function=` text seen in content deltas (template parse failure → fallback parser). */
  textToolCallLeak?: boolean;
  nativeToolCalls: number;
  /** Anthropic Messages request (claude-code engine); body.system / body.messages follow that schema. */
  anthropic?: boolean;
  /** First 1500 chars of generated text (kept for --dump / failure analysis). */
  text?: string;
}

interface Proxy { url: string; records: ProxyRecord[]; active(): number; maxActive(): number; close(): Promise<void> }

async function startProxy(target: string): Promise<Proxy> {
  const records: ProxyRecord[] = [];
  let active = 0;
  let maxActive = 0;
  let seq = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      // OpenAI-style chat (builtin engine) and Anthropic Messages (claude-code engine, via the core's shim)
      const isChat = (req.url ?? '').startsWith('/v1/chat/completions') || /^\/v1\/messages(\?|$)/.test(req.url ?? '');
      const ctrl = new AbortController();
      let finished = false;
      let rec: ProxyRecord | undefined;
      if (isChat) {
        let body: ProxyRecord['body'] = {};
        try { body = JSON.parse(raw.toString('utf8')) as ProxyRecord['body']; } catch { /* keep {} */ }
        rec = { seq: ++seq, startedAt: Date.now(), body, nativeToolCalls: 0, anthropic: (req.url ?? '').startsWith('/v1/messages') };
        records.push(rec);
        active++;
        maxActive = Math.max(maxActive, active);
      }
      res.on('close', () => {
        if (!finished) {
          if (rec) rec.clientAborted = true;
          ctrl.abort();
        }
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k.toLowerCase())) headers[k] = v;
      }
      try {
        const up = await fetch(`${target}${req.url ?? '/'}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw,
          signal: ctrl.signal,
        });
        if (rec) rec.status = up.status;
        const outHeaders: Record<string, string> = {};
        up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v; });
        res.writeHead(up.status, outHeaders);
        if (!up.body) { finished = true; res.end(); return; }
        const reader = up.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (rec && rec.firstByteMs === undefined) rec.firstByteMs = Date.now() - rec.startedAt;
          res.write(Buffer.from(value));
          if (rec) {
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              let j: Record<string, unknown>;
              try { j = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
              if (j.timings) rec.timings = j.timings as ProxyRecord['timings'];
              if (j.usage) rec.usage = j.usage as ProxyRecord['usage'];
              if (rec.anthropic) {
                // Anthropic SSE: message_start{message.usage} · content_block_start/delta · message_delta{delta.stop_reason, usage}
                const type = String(j.type ?? '');
                const mu = (j.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } | undefined)?.usage;
                if (type === 'message_start' && mu) {
                  rec.timings = { ...rec.timings, prompt_n: mu.input_tokens ?? rec.timings?.prompt_n, cache_n: mu.cache_read_input_tokens ?? rec.timings?.cache_n };
                }
                const blk = j.content_block as { type?: string } | undefined;
                const dl = j.delta as { type?: string; text?: string; thinking?: string; stop_reason?: string } | undefined;
                if ((type === 'content_block_start' && blk) || (type === 'content_block_delta' && dl && (dl.text || dl.thinking))) {
                  if (rec.firstTokenMs === undefined) rec.firstTokenMs = Date.now() - rec.startedAt;
                }
                if (type === 'content_block_start' && blk?.type === 'tool_use') rec.nativeToolCalls++;
                if (type === 'content_block_delta' && dl?.type === 'text_delta') {
                  if ((rec.text?.length ?? 0) < 1500) rec.text = (rec.text ?? '') + (dl.text ?? '');
                  if (/<tool_call>|<function=|<parameter=/.test(dl.text ?? '')) rec.textToolCallLeak = true;
                }
                if (type === 'message_delta') {
                  if (dl?.stop_reason) rec.finishReason = dl.stop_reason;
                  const ou = (j.usage as { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number } | undefined);
                  if (ou) rec.timings = { ...rec.timings, predicted_n: ou.output_tokens ?? rec.timings?.predicted_n, prompt_n: ou.input_tokens ?? rec.timings?.prompt_n, cache_n: ou.cache_read_input_tokens ?? rec.timings?.cache_n };
                }
                continue;
              }
              const choice = (j.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined)?.[0];
              if (choice?.finish_reason) rec.finishReason = choice.finish_reason;
              const d = choice?.delta;
              if (d) {
                const content = typeof d.content === 'string' ? d.content : '';
                const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : '';
                const tcs = Array.isArray(d.tool_calls) ? d.tool_calls as { function?: { name?: string } }[] : [];
                if ((content || reasoning || tcs.length) && rec.firstTokenMs === undefined) rec.firstTokenMs = Date.now() - rec.startedAt;
                if (/<tool_call>|<function=/.test(content)) rec.textToolCallLeak = true;
                rec.nativeToolCalls += tcs.filter((t) => t.function?.name).length;
              }
            }
          }
        }
        finished = true;
        res.end();
      } catch (e) {
        finished = true;
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `proxy: ${e instanceof Error ? e.message : String(e)}` } }));
      } finally {
        if (rec) { rec.totalMs = Date.now() - rec.startedAt; active--; }
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    records,
    active: () => active,
    maxActive: () => maxActive,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// ───────────────────────────── WS client (like the renderer) ─────────────────────────────

type Listener = (data: unknown) => void;

class CoreClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  readonly events: { event: string; data: unknown; at: number }[] = [];

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { message: string }; event?: string; data?: unknown };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.event) {
        this.events.push({ event: msg.event, data: msg.data, at: Date.now() });
        for (const l of this.listeners.get(msg.event) ?? []) {
          try { l(msg.data); } catch (e) { console.error('listener failed:', e); }
        }
      }
    });
  }

  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const id = this.nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn as Listener);
    return () => set!.delete(fn as Listener);
  }

  close(): void { this.ws.close(); }
}

// ───────────────────────────── sample project ─────────────────────────────

const MATH_JS = `// Tiny math helpers.
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const FORMAT_JS = `const { add } = require('../math');

function formatResult(label, value) {
  return \`\${label}: \${value}\`;
}

function printSum(a, b) {
  console.log(formatResult('sum', add(a, b)));
}

module.exports = { formatResult, printSum };
`;

const README = `# Sample Calc

A tiny calculator library used for testing the agent. It exports \`add(a, b)\` and \`multiply(a, b)\` from
\`src/math.js\`, plus a small formatting helper in \`src/util/format.js\`.

The project codename is **BLUE-HERON**. Run \`npm test\` to execute the self-check.
`;

function makeProject(dir: string): void {
  mkdirSync(path.join(dir, 'src', 'util'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'sample-calc', version: '1.0.0', main: 'src/math.js', scripts: { test: 'node test.js' } }, null, 2)}\n`);
  writeFileSync(path.join(dir, 'src', 'math.js'), MATH_JS);
  writeFileSync(path.join(dir, 'src', 'util', 'format.js'), FORMAT_JS);
  writeFileSync(path.join(dir, 'README.md'), README);
  writeFileSync(path.join(dir, 'test.js'), "const m = require('./src/math');\nif (m.add(2, 3) !== 5) throw new Error('add');\nconsole.log('ok');\n");
}

// ───────────────────────────── harness ─────────────────────────────

interface ScenarioResult {
  id: number;
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  detail: string[];
  turns: number;
  tools: string[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  wallMs: number;
  errors: string[];
  requests: number;
  firstTokenMs?: number;
  textToolCallLeaks: number;
  /** per request: prompt_n, cache_n, predicted_n, first-token ms, finish reason */
  perRequest: string[];
}

class Skip extends Error {}

class H {
  readonly detail: string[] = [];
  readonly failures: string[] = [];
  readonly sessions: string[] = [];
  readonly errors: string[] = [];
  /** Permission prompts the harness auto-answered (tool + short input), for diagnosing plan/permission behaviour. */
  readonly asked: string[] = [];
  project = '';
  reqStart = 0;
  private offs: (() => void)[] = [];

  constructor(readonly client: CoreClient, readonly proxy: Proxy, readonly root: string, readonly scenarioId: number) {}

  setup(): void {
    this.project = path.join(this.root, `proj-${this.scenarioId}`);
    rmSync(this.project, { recursive: true, force: true });
    makeProject(this.project);
    this.reqStart = this.proxy.records.length;
    this.offs.push(this.client.on('permission.requested', (p) => {
      if (this.sessions.includes(p.sessionId)) this.asked.push(`${p.toolName} ${clip(JSON.stringify(p.input), 90)}`);
    }));
    this.offs.push(this.client.on('error', (e) => {
      if (!e.sessionId || this.sessions.includes(e.sessionId)) this.errors.push(e.message);
    }));
  }

  teardown(): void { this.offs.forEach((o) => o()); }

  check(cond: boolean, msg: string): boolean {
    this.detail.push(`${cond ? 'ok' : 'FAIL'}: ${msg}`);
    if (!cond) this.failures.push(msg);
    return cond;
  }

  note(msg: string): void { this.detail.push(msg); }

  file(rel: string): string | null {
    const p = path.join(this.project, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  /** A fixed title skips the title-generation request (keeps us at one request at a time); autoTitle keeps it. */
  async newSession(opts: { permissionMode?: PermissionMode; thinking?: boolean; autoTitle?: boolean } = {}): Promise<SessionSummary> {
    const s = await this.client.rpc('sessions.create', { cwd: this.project, title: opts.autoTitle ? undefined : `e2e ${this.scenarioId}`, permissionMode: opts.permissionMode, engine: ENGINE as EngineId | undefined });
    this.sessions.push(s.id);
    if (opts.thinking !== undefined && opts.thinking !== s.thinking) await this.client.rpc('chat.setThinking', { sessionId: s.id, thinking: opts.thinking });
    return s;
  }

  get(sessionId: string): Promise<Session> { return this.client.rpc('sessions.get', { id: sessionId }); }

  /** Send a message and wait until the session has processed it and is idle again. */
  async send(sessionId: string, text: string, timeoutMs = 300_000, onStart?: (messageId: string) => void): Promise<Session> {
    const { messageId } = await this.client.rpc('chat.send', { sessionId, text });
    onStart?.(messageId);
    return this.waitIdle(sessionId, messageId, timeoutMs);
  }

  async waitIdle(sessionId: string, messageId: string, timeoutMs: number): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.get(sessionId);
      const present = s.messages.some((m) => m.id === messageId);
      if (present && (s.status === 'idle' || s.status === 'error')) return s;
      if (Date.now() > deadline) {
        await this.client.rpc('chat.interrupt', { sessionId }).catch(() => undefined);
        await sleep(1500);
        throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s (status ${s.status})`);
      }
      await sleep(400);
    }
  }

  /** All sessions of this scenario incl. subagent children. */
  async allSessions(): Promise<Session[]> {
    const list = await this.client.rpc('sessions.list', { includeSubagents: true });
    const ids = new Set(this.sessions);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of list) if (s.parentSessionId && ids.has(s.parentSessionId) && !ids.has(s.id)) { ids.add(s.id); grew = true; }
    }
    const out: Session[] = [];
    for (const id of ids) { try { out.push(await this.get(id)); } catch { /* deleted */ } }
    return out;
  }

  requests(): ProxyRecord[] { return this.proxy.records.slice(this.reqStart); }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function toolBlocks(s: Session): ToolUseBlock[] {
  return s.messages.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
}
function textOf(m: Message | undefined): string {
  return (m?.blocks ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
}
function finalText(s: Session): string {
  const last = [...s.messages].reverse().find((m) => m.role === 'assistant' && textOf(m).trim());
  return textOf(last);
}
function used(s: Session, ...names: string[]): ToolUseBlock[] {
  return toolBlocks(s).filter((b) => names.includes(b.name));
}
function clip(s: string, n = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function sha(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 12); }
function prefixKey(r: ProxyRecord): string {
  const sys = r.body.messages?.[0]?.role === 'system' ? JSON.stringify(r.body.messages[0].content) : '';
  return sha(`${sys}\n${JSON.stringify(r.body.tools ?? [])}`);
}

// ───────────────────────────── scenarios ─────────────────────────────

interface Scenario { id: number; name: string; timeoutMs: number; run(h: H): Promise<void> }

const scenarios: Scenario[] = [
  {
    id: 1, name: 'simple-reply', timeoutMs: 180_000,
    async run(h) {
      const s0 = await h.newSession({ autoTitle: true });
      const prompt = 'Reply with exactly the word PONG and nothing else.';
      const s = await h.send(s0.id, prompt);
      const t = finalText(s);
      h.check(/\bPONG\b/.test(t), `final text contains PONG (got "${clip(t, 60)}")`);
      h.check(toolBlocks(s).length === 0, `no tool calls (got ${toolBlocks(s).map((b) => b.name).join(',') || 'none'})`);
      // the generated title arrives shortly after the reply (one small extra request)
      const provisional = (x: string) => x === 'New session' || x.startsWith(prompt.slice(0, 40));
      let title = s.title;
      for (let i = 0; i < 120 && provisional(title); i++) {
        await sleep(500);
        title = (await h.get(s0.id)).title;
      }
      h.check(!provisional(title) && title.split(/\s+/).length <= 8, `session title generated ("${title}")`);
    },
  },
  {
    id: 2, name: 'read-summarise', timeoutMs: 300_000,
    async run(h) {
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'Read README.md and summarise it in one sentence. Mention the project codename.');
      const reads = used(s, 'Read').filter((b) => /README/i.test(String(b.input.file_path ?? '')));
      h.check(reads.some((b) => b.status === 'done'), 'Read README.md succeeded');
      const t = finalText(s);
      h.check(/BLUE[- ]?HERON/i.test(t), `summary mentions the codename (got "${clip(t)}")`);
    },
  },
  {
    id: 3, name: 'edit-file', timeoutMs: 420_000,
    async run(h) {
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'Add a function subtract(a, b) that returns a - b to src/math.js and export it alongside the others.');
      const edits = used(s, 'Edit', 'MultiEdit', 'Write').filter((b) => /math\.js/.test(String(b.input.file_path ?? '')));
      h.check(edits.some((b) => b.status === 'done'), `math.js changed via ${edits.map((b) => `${b.name}:${b.status}`).join(',') || 'nothing'}`);
      const src = h.file('src/math.js') ?? '';
      h.check(/function\s+subtract|subtract\s*[=:]/.test(src), 'subtract is defined on disk');
      let out = '';
      try {
        out = execSync('node -e "const m=require(\'./src/math.js\');console.log(m.subtract(7,3),m.add(2,3),m.multiply(2,3))"', { cwd: h.project, encoding: 'utf8' }).trim();
      } catch (e) { out = `error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`; }
      h.check(out === '4 5 6', `require('./src/math.js') works: subtract(7,3), add, multiply → "${out}"`);
    },
  },
  {
    id: 4, name: 'write-file', timeoutMs: 300_000,
    async run(h) {
      const s0 = await h.newSession();
      await h.send(s0.id, 'Create notes/todo.md with a Markdown checklist of three unchecked items: buy milk, call Bob, write tests.');
      const s = await h.get(s0.id);
      h.check(used(s, 'Write').some((b) => b.status === 'done'), 'Write tool used');
      const f = h.file('notes/todo.md');
      h.check(f !== null, 'notes/todo.md exists');
      const items = (f ?? '').split(/\r?\n/).filter((l) => /^\s*[-*] \[ \]/.test(l));
      h.check(items.length === 3, `3 unchecked items (got ${items.length})`);
      h.check(/milk/i.test(f ?? '') && /bob/i.test(f ?? '') && /tests/i.test(f ?? ''), 'all three items present');
    },
  },
  {
    id: 5, name: 'bash-node-version', timeoutMs: 300_000,
    async run(h) {
      const expected = execSync('node -v', { encoding: 'utf8' }).trim();
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'Run `node -v` and tell me which Node.js version is installed.');
      const runs = used(s, 'Bash', 'PowerShell');
      h.check(runs.some((b) => b.status === 'done' && /node\s+(-v|--version)/.test(String(b.input.command ?? ''))), `ran node -v via ${runs.map((b) => `${b.name}:${b.status}`).join(',') || 'nothing'}`);
      const t = finalText(s);
      h.check(t.includes(expected) || t.includes(expected.slice(1)), `reply contains ${expected} (got "${clip(t, 100)}")`);
    },
  },
  {
    id: 6, name: 'glob-grep', timeoutMs: 300_000,
    async run(h) {
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'Where is the function formatResult defined? Give the file path and line number.');
      const search = used(s, 'Grep', 'Glob');
      h.check(search.some((b) => b.status === 'done'), `searched with ${search.map((b) => b.name).join(',') || 'nothing'}`);
      const t = finalText(s);
      h.check(/format\.js/.test(t), `answer names src/util/format.js (got "${clip(t, 120)}")`);
      h.check(/\b3\b/.test(t), 'answer gives line 3');
    },
  },
  {
    id: 7, name: 'todowrite', timeoutMs: 480_000,
    async run(h) {
      const s0 = await h.newSession();
      await h.send(s0.id,
        'Do these three steps and track them with a todo list: 1) create hello.txt containing hello, 2) create world.txt containing world, 3) list the files in the project root.');
      const s = await h.get(s0.id);
      const todoCalls = used(s, 'TodoWrite');
      h.check(todoCalls.length >= 2, `TodoWrite called ${todoCalls.length}x (≥2: create + update)`);
      h.check(s.todos.length >= 3, `final todo list has ${s.todos.length} items`);
      h.check(s.todos.length > 0 && s.todos.every((t) => t.status === 'completed'), `all todos completed (${s.todos.map((t) => t.status).join(',')})`);
      h.check((h.file('hello.txt') ?? '').trim() === 'hello' && (h.file('world.txt') ?? '').trim() === 'world', 'hello.txt / world.txt written');
      h.check(used(s, 'LS', 'Glob', 'Bash', 'PowerShell').some((b) => b.status === 'done'), 'listed the files');
    },
  },
  {
    id: 8, name: 'ask-user-question', timeoutMs: 360_000,
    async run(h) {
      const s0 = await h.newSession();
      let picked = '';
      const off = h.client.on('question.requested', (q) => { if (q.sessionId === s0.id) picked = q.questions[0]?.options[0]?.label ?? ''; });
      await h.send(s0.id, 'Ask me which colour I prefer (offer red, green and blue as options), then write my answer into color.txt.');
      off();
      const s = await h.get(s0.id);
      h.check(used(s, 'AskUserQuestion').some((b) => b.status === 'done'), 'AskUserQuestion used');
      h.note(`auto-answer: "${picked}"`);
      const f = (h.file('color.txt') ?? '').trim();
      h.check(!!picked && f.toLowerCase().includes(picked.toLowerCase()), `color.txt contains the answer (got "${clip(f, 40)}")`);
    },
  },
  {
    id: 9, name: 'task-subagent', timeoutMs: 600_000,
    async run(h) {
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'Use the Task tool with an Explore subagent to find which file defines the multiply function. Then tell me the file path.');
      const tasks = used(s, 'Task');
      h.check(tasks.some((b) => b.status === 'done'), `Task used (${tasks.map((b) => `${String(b.input.subagent_type ?? '?')}:${b.status}`).join(',') || 'none'})`);
      const all = await h.allSessions();
      const subs = all.filter((x) => x.kind === 'subagent');
      h.check(subs.length >= 1, `subagent session created (${subs.length})`);
      const subTools = subs.flatMap((x) => toolBlocks(x).map((b) => b.name));
      h.note(`subagent tools: ${subTools.join(',') || 'none'}`);
      h.check(/math\.js/.test(finalText(s)), `answer names src/math.js (got "${clip(finalText(s), 120)}")`);
    },
  },
  {
    id: 10, name: 'web-search-fetch', timeoutMs: 600_000,
    async run(h) {
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'In which year was the Python programming language first released? Use WebSearch, then WebFetch one result to confirm. Answer with the year.');
      const search = used(s, 'WebSearch');
      const fetches = used(s, 'WebFetch');
      const searchOk = search.some((b) => b.status === 'done' && !b.result?.isError);
      if (!searchOk && search.length && search.every((b) => /fetch failed|ENOTFOUND|ECONN|timed out|network|blocked|403|429|captcha/i.test(b.result?.content ?? ''))) {
        throw new Skip(`web search unavailable: ${clip(search[0]?.result?.content ?? '', 120)}`);
      }
      h.check(searchOk, `WebSearch succeeded (${search.map((b) => b.status).join(',') || 'not called'})`);
      h.check(fetches.length > 0, `WebFetch called (${fetches.map((b) => `${b.status}${b.result?.isError ? '!' : ''}`).join(',') || 'not called'})`);
      h.check(/1991/.test(finalText(s)), `answer contains 1991 (got "${clip(finalText(s), 100)}")`);
    },
  },
  {
    id: 11, name: 'plan-mode', timeoutMs: 600_000,
    async run(h) {
      const s0 = await h.newSession();
      await h.client.rpc('chat.setPermissionMode', { sessionId: s0.id, mode: 'plan' });
      let planSeen = '';
      const off = h.client.on('plan.requested', (p) => { if (p.sessionId === s0.id) planSeen = p.plan; });
      await h.send(s0.id, 'Add a function cube(n) that returns n * n * n to src/math.js and export it.');
      off();
      const s = await h.get(s0.id);
      const blocks = toolBlocks(s);
      const exitIdx = blocks.findIndex((b) => b.name === 'ExitPlanMode' && b.status === 'done');
      h.check(exitIdx >= 0, `ExitPlanMode called (${blocks.map((b) => `${b.name}:${b.status}`).join(',')})`);
      h.check(!!planSeen.trim(), `plan presented (${clip(planSeen, 80)})`);
      // Claude Code writes the plan itself to <config dir>/plans/*.md while planning: that file is allowed in plan mode
      const isPlanFile = (b: ToolUseBlock) => /[\\/]plans[\\/][^\\/]+\.md$/i.test(String(b.input.file_path ?? ''));
      const earlyEdits = blocks.slice(0, Math.max(0, exitIdx)).filter((b) => ['Edit', 'Write', 'MultiEdit'].includes(b.name) && b.status === 'done' && !(ENGINE === 'claude-code' && isPlanFile(b)));
      h.check(earlyEdits.length === 0, 'no edits executed before approval');
      h.check(s.permissionMode === 'acceptEdits', `mode switched to acceptEdits (is ${s.permissionMode})`);
      let out = '';
      try { out = execSync('node -e "console.log(require(\'./src/math.js\').cube(3))"', { cwd: h.project, encoding: 'utf8' }).trim(); } catch (e) { out = 'error'; }
      h.check(out === '27', `cube(3) === 27 on disk (got ${out})`);
    },
  },
  {
    id: 12, name: 'schedule-task', timeoutMs: 360_000,
    async run(h) {
      const before = await h.client.rpc('schedules.list', {});
      const s0 = await h.newSession();
      const s = await h.send(s0.id, 'Remind me every weekday at 9:00 to check the build.');
      h.check(used(s, 'ScheduleTask').some((b) => b.status === 'done'), `ScheduleTask used (${used(s, 'ScheduleTask').map((b) => `${b.status}:${String(b.input.schedule)}`).join(',') || 'not called'})`);
      const after = await h.client.rpc('schedules.list', {});
      const created = after.filter((t) => !before.some((b) => b.id === t.id));
      h.check(created.length === 1, `one schedule created (${created.length})`);
      const t = created[0];
      if (t) {
        h.check(/^0 9 \* \* (1-5|MON-FRI)$/i.test(t.schedule.trim()), `cron is weekdays 9:00 ("${t.schedule}")`);
        h.check(/build/i.test(t.prompt), `prompt mentions the build ("${clip(t.prompt, 80)}")`);
        await h.client.rpc('schedules.delete', { id: t.id });
        const left = await h.client.rpc('schedules.list', {});
        h.check(!left.some((x) => x.id === t.id), 'schedule deleted again');
      }
    },
  },
  {
    id: 13, name: 'multi-turn-cache', timeoutMs: 480_000,
    async run(h) {
      const s0 = await h.newSession();
      const first = h.proxy.records.length;
      await h.send(s0.id, 'Remember the number 42. Reply with just OK.');
      await h.send(s0.id, 'What number did I ask you to remember? Reply with just the number.');
      const s = await h.send(s0.id, 'Multiply it by 2 and reply with just the result.');
      const reqs = h.proxy.records.slice(first).filter((r) => (r.body.tools?.length ?? 0) > 0);
      h.check(reqs.length >= 3, `${reqs.length} agent requests`);
      const keys = new Set(reqs.map(prefixKey));
      h.check(keys.size === 1, `system prompt + tools byte-identical across turns (${keys.size} distinct)`);
      // history of request n must be a prefix of request n+1 (no rewriting → cache reuse)
      let prefixOk = true;
      for (let i = 1; i < reqs.length; i++) {
        const a = reqs[i - 1]!.body.messages ?? [];
        const b = reqs[i]!.body.messages ?? [];
        for (let k = 0; k < a.length; k++) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { prefixOk = false; h.note(`request ${i} differs from ${i - 1} at message ${k} (${a[k]?.role})`); break; }
      }
      h.check(prefixOk, 'each request extends the previous one (history not rewritten)');
      for (let i = 0; i < reqs.length; i++) {
        const t = reqs[i]!.timings;
        h.note(`turn ${i + 1}: prompt_n=${t?.prompt_n} cache_n=${t?.cache_n} prompt_ms=${Math.round(t?.prompt_ms ?? 0)} first_token=${reqs[i]!.firstTokenMs}ms`);
      }
      for (let i = 1; i < reqs.length; i++) {
        const prevTotal = (reqs[i - 1]!.timings?.prompt_n ?? 0) + (reqs[i - 1]!.timings?.cache_n ?? 0);
        const cache = reqs[i]!.timings?.cache_n ?? 0;
        h.check(cache >= prevTotal * 0.9, `turn ${i + 1} reuses the cached prefix (cache_n ${cache} ≥ 90% of previous prompt ${prevTotal})`);
      }
      h.check(/\b84\b/.test(finalText(s)), `final answer 84 (got "${clip(finalText(s), 40)}")`);
    },
  },
  {
    id: 14, name: 'cost-compact', timeoutMs: 600_000,
    async run(h) {
      const s0 = await h.newSession();
      await h.send(s0.id, 'My favourite fruit is mango. Reply with just OK.');
      await h.send(s0.id, 'My favourite city is Lisbon. Reply with just OK.');
      await h.send(s0.id, 'My favourite number is 7. Reply with just OK.');
      let s = await h.send(s0.id, '/cost');
      const cost = textOf(s.messages.at(-1));
      // builtin: "Requests: n / Input tokens: …"; Claude Code's own /cost: "Total cost: … Usage by model: … N requests" (local model: not billed)
      const costOk = ENGINE === 'claude-code'
        ? /Total cost:\s+\$0\.00 \(local model, not billed\)/.test(cost) && /Usage by model:/.test(cost) && !/unknown models/.test(cost)
        : Number(/Requests:\s*(\d+)/.exec(cost)?.[1] ?? 0) >= 3 && /Input tokens:/.test(cost);
      h.check(costOk, `/cost reports usage (${clip(cost, 120)})`);
      s = await h.send(s0.id, '/compact');
      const echo = textOf(s.messages.at(-1));
      h.check(/compacted/i.test(echo), `/compact ran (${clip(echo, 80)})`);
      h.check(s.messages.some((m) => m.tag === 'compact_summary'), 'compact_summary message inserted');
      s = await h.send(s0.id, 'What is my favourite fruit, city and number? Answer in one line.');
      const t = finalText(s);
      h.check(/mango/i.test(t) && /lisbon/i.test(t) && /\b7\b/.test(t), `facts survive compaction (got "${clip(t, 100)}")`);
    },
  },
  {
    id: 15, name: 'interrupt', timeoutMs: 420_000,
    async run(h) {
      const s0 = await h.newSession();
      let deltas = 0;
      const off = h.client.on('message.delta', (d) => { if (d.sessionId === s0.id) deltas++; });
      const { messageId } = await h.client.rpc('chat.send', { sessionId: s0.id, text: 'Write a 600-word story about a lighthouse keeper. Do not use any tools.' });
      const t0 = Date.now();
      while (deltas < 15 && Date.now() - t0 < 240_000) await sleep(200);
      h.check(deltas >= 15, `streaming started (${deltas} deltas)`);
      const reqBefore = h.proxy.records.length;
      await h.client.rpc('chat.interrupt', { sessionId: s0.id });
      const ti = Date.now();
      let s = await h.waitIdle(s0.id, messageId, 30_000);
      off();
      h.note(`idle ${Date.now() - ti} ms after interrupt`);
      const rec = h.proxy.records[reqBefore - 1];
      h.check(!!rec?.clientAborted, 'HTTP stream to the server was closed');
      const last = s.messages.at(-1);
      h.check(s.status === 'idle', `session idle (${s.status})`);
      h.check(last?.role === 'assistant' && !!last.meta?.interrupted, 'partial assistant message kept and marked interrupted');
      h.check(toolBlocks(s).length === 0, `story streamed as chat text, no tools (${toolBlocks(s).map((b) => b.name).join(',') || 'none'})`);
      s = await h.send(s0.id, 'Stop the story. Reply with just DONE.');
      h.check(/DONE/.test(finalText(s)), `session resumable (got "${clip(finalText(s), 40)}")`);
      h.check(h.errors.length === 0, `no errors (${h.errors.join('; ')})`);
    },
  },
];

// ───────────────────────────── main ─────────────────────────────

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function runScenario(sc: Scenario, client: CoreClient, proxy: Proxy, root: string): Promise<ScenarioResult> {
  const h = new H(client, proxy, root, sc.id);
  h.setup();
  const t0 = Date.now();
  let status: ScenarioResult['status'] = 'pass';
  try {
    await Promise.race([
      sc.run(h),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`scenario timeout ${sc.timeoutMs / 1000} s`)), sc.timeoutMs + 60_000).unref()),
    ]);
    if (h.failures.length) status = 'fail';
  } catch (e) {
    if (e instanceof Skip) { status = 'skip'; h.note(`skipped: ${e.message}`); } else {
      status = 'error';
      h.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (h.asked.length) h.note(`permission prompts answered: ${h.asked.join(' | ')}`);
  if (status !== 'pass') {
    const main = await h.get(h.sessions[0] ?? '').catch(() => undefined);
    if (main) h.note(`final assistant text: "${clip(finalText(main), 300)}" (session status ${main.status})`);
  }
  for (const id of h.sessions) await client.rpc('chat.interrupt', { sessionId: id }).catch(() => undefined);
  h.teardown();
  const wallMs = Date.now() - t0;
  const sessions = await h.allSessions().catch(() => [] as Session[]);
  const reqs = h.requests();
  const tools = sessions.flatMap((x) => toolBlocks(x).map((b) => `${b.name}${b.status === 'done' ? '' : `(${b.status})`}`));
  for (const x of sessions) {
    for (const b of toolBlocks(x)) if (b.status === 'error' && b.result) h.errors.push(`${b.name}: ${clip(b.result.content, 200)}`);
  }
  return {
    id: sc.id,
    name: sc.name,
    status,
    detail: h.detail,
    turns: reqs.length,
    tools,
    promptTokens: reqs.reduce((a, r) => a + (r.timings?.prompt_n ?? 0) + (r.timings?.cache_n ?? 0), 0),
    completionTokens: reqs.reduce((a, r) => a + (r.timings?.predicted_n ?? r.usage?.completion_tokens ?? 0), 0),
    cachedTokens: reqs.reduce((a, r) => a + (r.timings?.cache_n ?? 0), 0),
    wallMs,
    errors: h.errors,
    requests: reqs.length,
    firstTokenMs: reqs[0]?.firstTokenMs,
    textToolCallLeaks: reqs.filter((r) => r.textToolCallLeak).length,
    perRequest: reqs.map((r) => `p${r.timings?.prompt_n ?? '?'} c${r.timings?.cache_n ?? '?'} g${r.timings?.predicted_n ?? '?'} ft${r.firstTokenMs ?? '?'}ms ${r.finishReason ?? (r.clientAborted ? 'aborted' : '?')}${r.textToolCallLeak ? ' LEAK' : ''}`),
  };
}

/** Scripted stand-in for the real model (harness self-check when the server is down, or with --mock). */
const MOCK_SCENARIOS = [1, 3, 5];
async function startMock(): Promise<MockLlm> {
  const mock = await startMockLlm({ modelId: 'mock-qwen3', nCtx: 131072 });
  mock.setFallback((req: MockRequest): MockTurn => {
    const msgs = (req.body?.messages ?? []) as { role: string; content?: unknown }[];
    const last = msgs[msgs.length - 1];
    const user = lastUserText(req);
    if (!req.body?.tools) return { text: 'Mock session' }; // title / compaction
    if (last?.role === 'tool') {
      const out = String(last.content ?? '');
      if (/^v\d+/.test(out.trim())) return { text: `Node.js ${out.trim()} is installed.` };
      if (out.includes('module.exports = { add, multiply }')) {
        return { toolCalls: [{ name: 'Edit', arguments: { file_path: 'src/math.js', old_string: 'module.exports = { add, multiply };', new_string: 'function subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, multiply, subtract };' } }] };
      }
      return { text: 'Done: added subtract to src/math.js.' };
    }
    if (/PONG/.test(user)) return { text: 'PONG' };
    if (/node -v/.test(user)) return { toolCalls: [{ name: 'Bash', arguments: { command: 'node -v' } }] };
    if (/subtract/.test(user)) return { toolCalls: [{ name: 'Read', arguments: { file_path: 'src/math.js' } }] };
    return { text: 'OK' };
  });
  return mock;
}

async function main(): Promise<number> {
  let base = BASE;
  let mock: MockLlm | undefined;
  let down = false;
  if (MOCK || !(await reachable())) {
    down = !MOCK;
    if (down) {
      console.error(`The local llama-server at ${BASE} is DOWN (no /health). Real-model E2E skipped — falling back to tests/fixtures/mock-llm `
        + `(harness self-check, scenarios ${MOCK_SCENARIOS.join(', ')}); exit code 3.`);
    }
    mock = await startMock();
    base = mock.url;
  }
  const pool = mock ? scenarios.filter((s) => MOCK_SCENARIOS.includes(s.id)) : scenarios;
  const chosen = selectors.length
    ? pool.filter((s) => selectors.some((sel) => sel === String(s.id) || s.name.includes(sel)))
    : pool;
  if (!chosen.length) { console.error(`No scenario matches ${selectors.join(' ')}`); await mock?.close(); return 2; }

  const root = mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-real-'));
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const proxy = await startProxy(base);
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    local: { enabled: true, baseUrl: proxy.url },
    custom: [],
    defaultPermissionMode: 'default',
    thinkingByDefault: THINKING,
    importClaudeConfig: USER_CONFIG,
    // the claude-code engine copies ~/.claude skills/agents/commands/CLAUDE.md by default: off here for reproducible runs
    engine: { default: 'builtin', claudeCode: { systemPrompt: SYSPROMPT, importUserClaudeConfig: USER_CONFIG } },
    defaultCwd: root,
    notifications: false,
  }, null, 2));
  process.env.OBSIDIAN_RESOURCES_DIR ??= path.join(process.cwd(), 'resources');
  const native: NativeBridge = { isElectron: false, notify: () => undefined };
  let core: CoreHandle | undefined;
  const client = new CoreClient();
  const results: ScenarioResult[] = [];
  try {
    core = await createCore({ dataDir, native });
    await client.connect(core.url);
    // auto-responders (what a user clicking through the UI would do)
    client.on('permission.requested', (p) => { void client.rpc('chat.respondPermission', { requestId: p.requestId, decision: 'allow' }); });
    client.on('question.requested', (q) => {
      const answers: Record<string, string> = {};
      for (const x of q.questions) answers[x.question] = x.options[0]?.label ?? 'yes';
      void client.rpc('chat.answerQuestion', { requestId: q.requestId, answers });
    });
    client.on('plan.requested', (p) => { void client.rpc('chat.respondPlan', { requestId: p.requestId, approve: true, mode: 'acceptEdits' }); });

    // wait for the local model to be listed
    let modelId = '';
    for (let i = 0; i < 60 && !modelId; i++) {
      const m = await client.rpc('models.list', {});
      modelId = m.models.find((x) => x.ref.provider === 'local')?.ref.model ?? '';
      if (!modelId) await sleep(500);
    }
    if (!modelId) throw new Error('local model never appeared in models.list');
    console.log(`engine: ${ENGINE ?? 'default'} · model: ${modelId} · thinking ${THINKING ? 'on' : 'off'} · temp dir ${root}`);

    for (const sc of chosen) {
      process.stdout.write(`▶ ${sc.id} ${sc.name} … `);
      const r = await runScenario(sc, client, proxy, root);
      results.push(r);
      console.log(`${r.status.toUpperCase()} (${(r.wallMs / 1000).toFixed(1)} s, ${r.requests} req, ${r.promptTokens}/${r.completionTokens} tok, tools: ${r.tools.join(' ') || '-'})`);
      for (const d of r.detail) console.log(`    ${d}`);
      for (const e of r.errors) console.log(`    error: ${e}`);
      console.log(`    requests: ${r.perRequest.join(' | ')}`);
    }
  } finally {
    client.close();
    await core?.close().catch(() => undefined);
    await proxy.close();
    await mock?.close();
  }

  // first-turn prompt size / latency from the very first agent request of the run
  const firstAgent = proxy.records.find((r) => (r.body.tools?.length ?? 0) > 0);
  const summary = {
    server: mock ? `mock-llm (${mock.url})` : BASE,
    engine: ENGINE ?? 'default',
    thinking: THINKING,
    maxConcurrentRequests: proxy.maxActive(),
    userConfig: USER_CONFIG,
    nativeToolCalls: proxy.records.reduce((a, r) => a + r.nativeToolCalls, 0),
    textToolCallLeaks: proxy.records.filter((r) => r.textToolCallLeak).length,
    firstTurn: firstAgent ? {
      promptTokens: (firstAgent.timings?.prompt_n ?? 0) + (firstAgent.timings?.cache_n ?? 0),
      cacheN: firstAgent.timings?.cache_n,
      promptMs: firstAgent.timings?.prompt_ms,
      firstTokenMs: firstAgent.firstTokenMs,
      systemChars: JSON.stringify(firstAgent.body.messages?.[0]?.content ?? '').length,
      toolsChars: JSON.stringify(firstAgent.body.tools ?? []).length,
    } : null,
    results,
  };
  console.log('\n| # | scenario | result | req | tools | prompt/compl tok | wall s |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.id} | ${r.name} | ${r.status} | ${r.requests} | ${r.tools.join(' ') || '-'} | ${r.promptTokens}/${r.completionTokens} | ${(r.wallMs / 1000).toFixed(0)} |`);
  console.log(`\nmax concurrent model requests: ${proxy.maxActive()} · native tool calls: ${summary.nativeToolCalls} · text tool-call leaks: ${summary.textToolCallLeaks}`);
  if (summary.firstTurn) console.log(`first turn: ${summary.firstTurn.promptTokens} prompt tokens, first token after ${summary.firstTurn.firstTokenMs} ms`);
  const out = OUT ?? path.join(root, 'results.json');
  writeFileSync(out, JSON.stringify(summary, null, 2));
  if (DUMP) writeFileSync(`${out}.requests.json`, JSON.stringify(proxy.records.map((r) => ({ seq: r.seq, anthropic: r.anthropic, finish: r.finishReason, timings: r.timings, text: r.text, body: r.body })), null, 1));
  console.log(`results: ${out}`);
  if (!KEEP && !OUT) { /* keep results.json; remove projects */ }
  if (!KEEP) for (const sc of chosen) { try { rmSync(path.join(root, `proj-${sc.id}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* a just-killed child may still hold the dir on Windows */ } }
  if (down) return 3;
  return results.every((r) => r.status === 'pass' || r.status === 'skip') ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
