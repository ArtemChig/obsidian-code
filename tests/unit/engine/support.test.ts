// claude-code engine support code: the Anthropic shim, the obsidian MCP server, the Claude Code environment and
// executable resolution, the isolated config dir, the lean prompt and the settings defaults.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import type { CoreContext, ToolDef } from '@core/contracts';
import { anthropicBaseUrl, buildClaudeEnv, resolveClaudeExecutable } from '@core/engine/env';
import { AnthropicShim, applyModel, applyThinking, foldSystemMessages, modelAlias } from '@core/engine/shim';
import { createObsidianMcpServer, stableKey } from '@core/engine/claude-code/mcp';
import { leanSystemPrompt, prepareConfigDir } from '@core/engine/claude-code/setup';
import { defaultSettings, validateSettings } from '@core/store/settings';

const tmp = mkdtempSync(join(tmpdir(), 'oc-engine-support-'));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* windows locks */ } });

describe('shim body adaptation', () => {
  it('folds mid-conversation system messages into the neighbouring user turn, tool_results first', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
        { role: 'system', content: [{ type: 'text', text: '# Environment\ncwd: x' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: 'more' }] },
        { role: 'system', content: 'late note' },
      ],
    };
    const out = foldSystemMessages(body) as { messages: { role: string; content: { type: string; text?: string }[] }[] };
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const last = out.messages[2]!.content;
    expect(last[0]!.type).toBe('tool_result');
    expect(last.map((b) => b.text ?? b.type)).toEqual(['tool_result', '<system-reminder>\n# Environment\ncwd: x\n</system-reminder>', 'more', '<system-reminder>\nlate note\n</system-reminder>']);
    const plain = { messages: [{ role: 'user', content: 'x' }] };
    expect(foldSystemMessages(plain)).toBe(plain);
  });

  it('thinking off → enable_thinking false; adaptive/enabled untouched; model alias mapped back', () => {
    expect(applyThinking({ model: 'm' })).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(applyThinking({ thinking: { type: 'disabled' } })).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    const on = { thinking: { type: 'adaptive' } };
    expect(applyThinking(on)).toBe(on);
    expect(modelAlias('org/model:Q4')).toBe('org--model:Q4');
    expect(applyModel({ model: 'org--m' }, { alias: 'org--m', id: 'org/m' })).toEqual({ model: 'org/m' });
    expect(anthropicBaseUrl('http://h:1/v1/')).toBe('http://h:1');
  });

  it('forwards to the route upstream only, injects the key, strips hint headers and pipes the response', async () => {
    const seen: { url?: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {} });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_stop\ndata: {}\n\n');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    const shim = new AnthropicShim();
    const seenByShim: string[] = [];
    shim.onRequest = (i) => seenByShim.push(`${i.requestClass}:${i.status}`);
    try {
      const base = await shim.baseUrl({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: { alias: 'a--b', id: 'a/b' } });
      expect(await shim.baseUrl({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', model: { alias: 'a--b', id: 'a/b' } })).toBe(base);
      const res = await fetch(`${base}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder', 'x-claude-code-request-class': 'main' },
        body: JSON.stringify({ model: 'a--b', messages: [{ role: 'user', content: 'q' }, { role: 'system', content: 'note' }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('message_stop');
      const got = seen[0]!;
      expect(got.url).toBe('/v1/messages?beta=true');
      expect(got.headers.authorization).toBe('Bearer sk-test');
      expect(got.headers['x-api-key']).toBe('sk-test');
      expect(got.headers['x-claude-code-request-class']).toBeUndefined();
      expect(got.body.model).toBe('a/b');
      expect(got.body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect((got.body.messages as unknown[]).length).toBe(1);
      expect(seenByShim).toEqual(['main:200']);
      const bad = await fetch(`${base.replace(/\/r\/.*/, '/r/nope')}/v1/messages`, { method: 'POST', body: '{}' });
      expect(bad.status).toBe(404);
    } finally {
      shim.close();
      upstream.close();
    }
  });
});

describe('Claude Code environment', () => {
  it('routes every model alias to the session model, isolates config and removes inherited credentials', () => {
    const env = buildClaudeEnv({
      baseEnv: { PATH: 'p', ANTHROPIC_API_KEY: 'real', CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude', CLAUDECODE: '1', anthropic_base_url: 'x' },
      baseUrl: 'http://127.0.0.1:5/r/abc', apiKey: 'obsidian-local', model: 'qwen', contextLength: 32768, configDir: 'D:\\data\\claude-code',
      extraEnv: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }, autoCompactPercent: 70,
    });
    expect(env.PATH).toBe('p');
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'anthropic_base_url']) expect(env[k]).toBeUndefined();
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: 'D:\\data\\claude-code', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5/r/abc', ANTHROPIC_AUTH_TOKEN: 'obsidian-local',
      ANTHROPIC_MODEL: 'qwen', ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen', ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192', CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000', DISABLE_LOGIN_COMMAND: '1', CLAUDE_CODE_ENABLE_TASKS: '0',
      CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70', CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    });
  });

  it('resolves the SDK-bundled executable, reports missing custom paths', () => {
    const auto = resolveClaudeExecutable('auto');
    expect(auto.source).toBe('sdk');
    expect(auto.path && existsSync(auto.path)).toBe(true);
    expect(auto.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(auto.version).toMatch(/^\d+\.\d+\.\d+/);
    const missing = resolveClaudeExecutable(join(tmp, 'nope', 'claude.exe'));
    expect(missing).toMatchObject({ path: null, source: 'none' });
    expect(missing.error).toContain('not found');
  });
});

describe('config dir and prompt', () => {
  it('imports skills/agents/commands/CLAUDE.md from ~/.claude (never settings or credentials) and removes them when turned off', async () => {
    const user = join(tmp, 'user-claude');
    mkdirSync(join(user, 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(user, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');
    writeFileSync(join(user, 'CLAUDE.md'), '# mine');
    writeFileSync(join(user, 'settings.json'), '{"env":{"X":"1"}}');
    writeFileSync(join(user, '.credentials.json'), '{}');
    const data = join(tmp, 'data');
    const dir = await prepareConfigDir(data, true, user);
    expect(dir).toBe(join(data, 'claude-code'));
    expect(readFileSync(join(dir, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('deploy');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# mine');
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false);
    await prepareConfigDir(data, false, user);
    expect(existsSync(join(dir, 'skills'))).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(user, 'CLAUDE.md'))).toBe(true);
  });

  it('lean prompt: compact, no environment block (Claude Code adds it), no refusal language', async () => {
    const p = await leanSystemPrompt({ cwd: tmp, shell: 'PowerShell', os: 'Windows', date: '2026-10-13', memory: 'Use tabs.' });
    expect(p).toContain('Claude Code harness');
    expect(p).toContain('Agent tool');
    expect(p).toContain('Use tabs.');
    expect(p).not.toContain('# Environment');
    expect(p).not.toMatch(/refus|malicious|content policy/i);
    expect(p.length).toBeLessThan(5000);
  });
});

describe('obsidian MCP server', () => {
  it('exposes the app tools with their schemas and returns their output + display', async () => {
    const webSearch: ToolDef = {
      name: 'WebSearch', description: 'Search the web.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      concurrencySafe: true, permission: () => 'read', title: () => 'search',
      run: async (input) => ({ content: `results for ${String(input.query)}`, display: { kind: 'search', query: String(input.query), results: [{ title: 'A', url: 'https://a.example' }] } }),
    } as ToolDef;
    const ctx = {
      tools: { all: () => [webSearch], get: (n: string) => (n === 'WebSearch' ? webSearch : undefined) },
      sessions: { get: () => undefined }, settings: { get: () => defaultSettings() }, secrets: { get: () => null }, dataDir: tmp,
    } as unknown as CoreContext;
    const displays: [string, unknown][] = [];
    const server = createObsidianMcpServer({ ctx, sessionId: 's', cwd: tmp, onDisplay: (k, d) => displays.push([k, d]) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['web_search']);
    expect(listed.tools[0]!.inputSchema).toMatchObject({ required: ['query'] });
    const res = await client.callTool({ name: 'web_search', arguments: { query: 'llama' } });
    expect(res.content).toEqual([{ type: 'text', text: 'results for llama' }]);
    expect(displays[0]![0]).toBe(stableKey('mcp__obsidian__web_search', { query: 'llama' }));
    await client.close();
  });
});

describe('settings', () => {
  it('engine defaults and validation', () => {
    const d = defaultSettings();
    expect(d.engine).toEqual({ default: 'builtin', claudeCode: { executable: 'auto', systemPrompt: 'lean', importUserClaudeConfig: true, extraEnv: {} } });
    const v = validateSettings({ engine: { default: 'gpt', claudeCode: { systemPrompt: 'huge', executable: ' ', extraEnv: { OK_1: 'x', 'bad-name': 'y', N: 5 } } } });
    expect(v.engine).toEqual({ default: 'builtin', claudeCode: { executable: 'auto', systemPrompt: 'lean', importUserClaudeConfig: true, extraEnv: { OK_1: 'x' } } });
    expect(validateSettings({ engine: { default: 'claude-code', claudeCode: { systemPrompt: 'claude_code' } } }).engine.claudeCode.systemPrompt).toBe('claude_code');
  });
});
