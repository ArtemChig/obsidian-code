import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtensions } from '@core/ext';
import type { Extensions } from '@core/ext';
import { convertCallToolResult, mcpToolName, sanitizeName } from '@core/ext/mcp';
import type { McpServerConfig } from '@shared/types';
import { startHttpFixture } from '../../fixtures/mcp/http-server';
import { alive, cleanupTmp, fwd, makeCtx, tmpDir, toolContext, waitFor, write } from './helpers';
import type { FakeCtx } from './helpers';

const FIXTURE = path.resolve(__dirname, '../../fixtures/mcp/server.mjs');

const toDispose: Extensions[] = [];
const toClose: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const e of toDispose.splice(0)) await e.dispose();
  for (const c of toClose.splice(0)) await c.close();
  cleanupTmp();
});

function stdioServer(env: Record<string, string> = {}): McpServerConfig {
  return { type: 'stdio', command: process.execPath, args: [FIXTURE], env };
}

function setup(servers: Record<string, McpServerConfig>, opts: Parameters<typeof createExtensions>[1] = {}) {
  const root = tmpDir();
  const fake: FakeCtx = makeCtx(path.join(root, 'data'), { mcpServers: servers });
  const ext = createExtensions(fake.ctx, { homeDir: path.join(root, 'home'), mcpStartupWaitMs: 30_000, mcpConnectTimeoutMs: 20_000, mcpReconcileDebounceMs: 20, ...opts });
  toDispose.push(ext);
  return { root, fake, ext };
}

const names = (ext: Extensions): string[] => ext.mcpTools().map((t) => t.name).sort();

describe('naming', () => {
  it('sanitises server and tool names and keeps them within 64 chars', () => {
    expect(sanitizeName('my server.v2')).toBe('my_server_v2');
    expect(mcpToolName('github', 'search_repos')).toBe('mcp__github__search_repos');
    expect(mcpToolName('my server', 'a b')).toBe('mcp__my_server__a_b');
    const long = mcpToolName('server', 'x'.repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.startsWith('mcp__server__x')).toBe(true);
    expect(mcpToolName('server', 'x'.repeat(100) + 'a')).not.toBe(long); // hash keeps distinct tools distinct
  });
});

describe('convertCallToolResult', () => {
  it('converts text, image, audio, resource and resource_link content', () => {
    const r = convertCallToolResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'QUJD' },
        { type: 'audio', mimeType: 'audio/wav', data: 'QUJDREVG' },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'file text' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', mimeType: 'application/octet-stream', blob: 'QUJD' } },
        { type: 'resource', resource: { uri: 'file:///c.png', mimeType: 'image/png', blob: 'WFla' } },
        { type: 'resource_link', uri: 'https://x/y', name: 'Y', description: 'a link' },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('hello');
    expect(r.content).toContain('[Resource file:///a.txt (text/plain)]\nfile text');
    expect(r.content).toContain('Binary resource file:///b.bin');
    expect(r.content).toContain('Resource link: Y -> https://x/y');
    expect(r.images).toEqual([
      { mediaType: 'image/png', data: 'QUJD' },
      { mediaType: 'image/png', data: 'WFla' },
    ]);
    expect(r.display).toMatchObject({ kind: 'markdown' });
  });

  it('maps isError, structuredContent and empty results', () => {
    expect(convertCallToolResult({ content: [{ type: 'text', text: 'bad' }], isError: true })).toEqual({ content: 'bad', isError: true });
    expect(convertCallToolResult({ content: [], structuredContent: { a: 1 } }).content).toBe('{\n  "a": 1\n}');
    expect(convertCallToolResult({ content: [] }).content).toBe('(no output)');
    expect(convertCallToolResult(undefined).content).toBe('(no output)');
  });
});

describe('stdio MCP server', () => {
  it('connects, lists tools, and converts them to ToolDefs; calls return ToolResultPayloads', async () => {
    const { ext } = setup({ fixture: stdioServer() });
    await ext.start();

    expect(names(ext)).toEqual(['mcp__fixture__add', 'mcp__fixture__echo']);
    expect(ext.mcpStatus()).toMatchObject([{ name: 'fixture', status: 'connected', transport: 'stdio', toolCount: 2 }]);

    const echo = ext.mcpTools().find((t) => t.name === 'mcp__fixture__echo')!;
    expect(echo.concurrencySafe).toBe(false);
    expect(echo.permission({}, { cwd: '.', settings: makeCtx('x').ctx.settings.get() })).toBe('exec');
    expect(echo.description).toContain('Echo the given text');
    expect(echo.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' }, fail: { type: 'boolean' } }, required: ['text'] });
    expect(echo.inputSchema).not.toHaveProperty('$schema');
    expect(echo.title({ text: 'hello there' })).toBe('fixture: echo "hello there"');
    expect(echo.ruleFor?.({})).toBe('mcp__fixture__echo');

    const res = await echo.run({ text: 'hi' }, toolContext());
    expect(res.content).toBe('echo: hi');
    expect(res.isError).toBeUndefined();

    const add = ext.mcpTools().find((t) => t.name === 'mcp__fixture__add')!;
    expect((await add.run({ a: 2, b: 3 }, toolContext())).content).toBe('5');
  });

  it('surfaces server-side tool errors and argument validation errors as error results', async () => {
    const { ext } = setup({ fixture: stdioServer() });
    await ext.start();
    const echo = ext.mcpTools().find((t) => t.name === 'mcp__fixture__echo')!;
    const failed = await echo.run({ text: 'nope', fail: true }, toolContext());
    expect(failed).toMatchObject({ content: 'failed: nope', isError: true });
    const add = ext.mcpTools().find((t) => t.name === 'mcp__fixture__add')!;
    const invalid = await add.run({ a: 'not a number' }, toolContext());
    expect(invalid.isError).toBe(true);
    expect(invalid.content.length).toBeGreaterThan(0);
  });

  it('works through a .cmd shim (non-.exe command on Windows)', async () => {
    if (process.platform !== 'win32') return;
    const root = tmpDir();
    const shim = write(path.join(root, 'run fixture.cmd'), `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`);
    const { ext } = setup({ shim: { command: shim } });
    await ext.start();
    expect(names(ext)).toEqual(['mcp__shim__add', 'mcp__shim__echo']);
    const echo = ext.mcpTools().find((t) => t.name === 'mcp__shim__echo')!;
    expect((await echo.run({ text: 'via cmd' }, toolContext())).content).toBe('echo: via cmd');
  });

  it('expands ${VAR}, ${VAR:-default} and ${secret:NAME} in args/env', async () => {
    const root = tmpDir();
    const pidFile = path.join(root, 'pid.txt');
    const { ext, fake } = setup({
      fixture: { command: process.execPath, args: ['${SCRIPT_PATH_TEST:-' + FIXTURE + '}'], env: { FIXTURE_PIDFILE: '${secret:pidfile}' } },
    });
    fake.secrets.set('pidfile', pidFile);
    await ext.start();
    expect(names(ext)).toHaveLength(2);
    expect(existsSync(pidFile)).toBe(true);
  });

  it('reports connection failures as status "error" without throwing; other servers still work', async () => {
    const { ext } = setup({
      broken: { command: path.join(tmpDir(), 'no-such-binary-xyz') },
      fixture: stdioServer(),
      empty: { type: 'stdio' },
    });
    await ext.start();
    const status = ext.mcpStatus();
    expect(status.find((s) => s.name === 'broken')).toMatchObject({ status: 'error', toolCount: 0 });
    expect(status.find((s) => s.name === 'broken')!.error).toBeTruthy();
    expect(status.find((s) => s.name === 'empty')!.error).toMatch(/command/);
    expect(status.find((s) => s.name === 'fixture')!.status).toBe('connected');
    expect(names(ext)).toEqual(['mcp__fixture__add', 'mcp__fixture__echo']);
  });

  it('does not connect disabled servers', async () => {
    const { ext } = setup({ off: { ...stdioServer(), enabled: false }, on: stdioServer() });
    await ext.start();
    expect(ext.mcpStatus().map((s) => s.name)).toEqual(['on']);
    expect(names(ext).every((n) => n.startsWith('mcp__on__'))).toBe(true);
  });

  it('start() returns after the startup wait while a slow server keeps connecting in the background', async () => {
    // A server that never speaks MCP: connect would hang until the connect timeout.
    const { ext } = setup(
      { silent: { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'] } },
      { mcpStartupWaitMs: 300, mcpConnectTimeoutMs: 1500 },
    );
    const t0 = Date.now();
    await ext.start();
    expect(Date.now() - t0).toBeLessThan(1400);
    expect(ext.mcpStatus()[0]!.status).toBe('connecting');
    await waitFor(() => ext.mcpStatus()[0]!.status === 'error', 8000);
    expect(ext.mcpStatus()[0]!.error).toMatch(/timed out/);
  });

  it('reconnects when settings change: adds, removes and restarts servers', async () => {
    const { ext, fake } = setup({ one: stdioServer() });
    await ext.start();
    expect(names(ext)).toEqual(['mcp__one__add', 'mcp__one__echo']);

    fake.update({ mcpServers: { one: stdioServer(), two: stdioServer() } });
    await waitFor(() => names(ext).length === 4);
    expect(names(ext)).toEqual(['mcp__one__add', 'mcp__one__echo', 'mcp__two__add', 'mcp__two__echo']);

    fake.update({ mcpServers: { two: stdioServer() } });
    await waitFor(() => names(ext).length === 2);
    expect(names(ext)).toEqual(['mcp__two__add', 'mcp__two__echo']);

    // config change on an existing server → it is relaunched (extra tools appear with FIXTURE_EXTRA)
    fake.update({ mcpServers: { two: stdioServer({ FIXTURE_EXTRA: '1' }) } });
    await waitFor(() => names(ext).includes('mcp__two__sleep'));
    expect(names(ext)).toHaveLength(6);

    // disabling removes the tools
    fake.update({ mcpServers: { two: { ...stdioServer(), enabled: false } } });
    await waitFor(() => names(ext).length === 0);
    expect(ext.mcpStatus()).toEqual([]);
  });

  it('ignores unrelated settings changes (no reconnect churn)', async () => {
    const { ext, fake } = setup({ one: stdioServer({ FIXTURE_EXTRA: '1' }) });
    await ext.start();
    const before = ext.mcpTools().find((t) => t.name === 'mcp__one__add_tool')!;
    fake.update({ thinkingByDefault: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(ext.mcpTools().find((t) => t.name === 'mcp__one__add_tool')).toBe(before); // same ToolDef instance
  });

  it('picks up tools/list_changed notifications', async () => {
    const { ext } = setup({ fixture: stdioServer({ FIXTURE_EXTRA: '1' }) });
    await ext.start();
    expect(names(ext)).not.toContain('mcp__fixture__dynamic');
    const addTool = ext.mcpTools().find((t) => t.name === 'mcp__fixture__add_tool')!;
    expect((await addTool.run({}, toolContext())).content).toBe('registered');
    await waitFor(() => names(ext).includes('mcp__fixture__dynamic'));
    const dyn = ext.mcpTools().find((t) => t.name === 'mcp__fixture__dynamic')!;
    expect((await dyn.run({}, toolContext())).content).toBe('dynamic ok');
  });

  it('converts image and resource results from a real server', async () => {
    const { ext } = setup({ fixture: stdioServer({ FIXTURE_EXTRA: '1' }) });
    await ext.start();
    const img = await ext.mcpTools().find((t) => t.name === 'mcp__fixture__image')!.run({}, toolContext());
    expect(img.content).toContain('here is the image');
    expect(img.images).toHaveLength(1);
    expect(img.images![0]!.mediaType).toBe('image/png');
    const res = await ext.mcpTools().find((t) => t.name === 'mcp__fixture__resource')!.run({}, toolContext());
    expect(res.content).toContain('resource body');
    expect(res.content).toContain('file:///other.txt');
  });

  it('times out slow tool calls and reports an error result', async () => {
    const { ext } = setup({ fixture: stdioServer({ FIXTURE_EXTRA: '1' }) }, { mcpToolTimeoutMs: 400 });
    await ext.start();
    const sleep = ext.mcpTools().find((t) => t.name === 'mcp__fixture__sleep')!;
    const t0 = Date.now();
    const r = await sleep.run({ ms: 5000 }, toolContext());
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/timed out/i);
  });

  it('aborting the tool signal interrupts the call', async () => {
    const { ext } = setup({ fixture: stdioServer({ FIXTURE_EXTRA: '1' }) });
    await ext.start();
    const sleep = ext.mcpTools().find((t) => t.name === 'mcp__fixture__sleep')!;
    const ac = new AbortController();
    const p = sleep.run({ ms: 8000 }, toolContext({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/interrupted/i);
  });

  it('dispose() closes every server process', async () => {
    const root = tmpDir();
    const pidFile = path.join(root, 'pid.txt');
    const { ext } = setup({ fixture: stdioServer({ FIXTURE_PIDFILE: pidFile }) });
    await ext.start();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    await ext.dispose();
    await waitFor(() => !alive(pid), 8000);
    expect(ext.mcpTools()).toEqual([]);
  });

  it('a tool whose server died reports a clear error and the server is reconnected', async () => {
    const root = tmpDir();
    const pidFile = path.join(root, 'pid.txt');
    const { ext } = setup({ fixture: stdioServer({ FIXTURE_PIDFILE: pidFile }) });
    await ext.start();
    const echo = ext.mcpTools().find((t) => t.name === 'mcp__fixture__echo')!;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    process.kill(pid);
    await waitFor(() => ext.mcpStatus()[0]!.status !== 'connected', 8000);
    const r = await echo.run({ text: 'x' }, toolContext());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not connected|closed/i);
    // auto-reconnect (first retry after ~2 s) brings it back
    await waitFor(() => ext.mcpStatus()[0]!.status === 'connected', 10_000);
    const again = ext.mcpTools().find((t) => t.name === 'mcp__fixture__echo')!;
    expect((await again.run({ text: 'back' }, toolContext())).content).toBe('echo: back');
  }, 30_000);
});

describe('http MCP server', () => {
  it('connects over streamable HTTP and forwards configured headers (with ${secret:...} expansion)', async () => {
    const http = await startHttpFixture({ mode: 'streamable', requireAuth: 'Bearer secret-token' });
    toClose.push(http);
    const { ext, fake } = setup({ remote: { type: 'http', url: http.url, headers: { Authorization: 'Bearer ${secret:remote.token}' } } });
    fake.secrets.set('remote.token', 'secret-token');
    await ext.start();
    expect(names(ext)).toEqual(['mcp__remote__whoami']);
    expect((await ext.mcpTools()[0]!.run({}, toolContext())).content).toBe('auth=Bearer secret-token');
    expect(http.rejected()).toBe(0);
  });

  it('falls back to SSE when the server does not speak streamable HTTP', async () => {
    const http = await startHttpFixture({ mode: 'sse' });
    toClose.push(http);
    const { ext } = setup({ legacy: { type: 'http', url: http.url } });
    await ext.start();
    expect(names(ext)).toEqual(['mcp__legacy__whoami']);
    const r = await ext.mcpTools()[0]!.run({}, toolContext());
    expect(r.content).toBe('auth=none');
  });

  it('explicit type "sse" connects with the SSE transport and headers', async () => {
    const http = await startHttpFixture({ mode: 'sse', requireAuth: 'Bearer abc' });
    toClose.push(http);
    const { ext } = setup({ legacy: { type: 'sse', url: http.url, headers: { Authorization: 'Bearer abc' } } });
    await ext.start();
    expect(names(ext)).toEqual(['mcp__legacy__whoami']);
    expect((await ext.mcpTools()[0]!.run({}, toolContext())).content).toBe('auth=Bearer abc');
  });

  it('reports an unreachable URL as an error status', async () => {
    const { ext } = setup({ dead: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }, { mcpConnectTimeoutMs: 5000 });
    await ext.start();
    expect(ext.mcpStatus()[0]).toMatchObject({ name: 'dead', status: 'error' });
    expect(ext.mcpTools()).toEqual([]);
  });
});

describe('stdio command forms', () => {
  it('accepts "command" written as one string with arguments when args are absent', async () => {
    const { ext } = setup({ fixture: { command: `"${fwd(process.execPath)}" "${fwd(FIXTURE)}"` } });
    await ext.start();
    expect(names(ext)).toEqual(['mcp__fixture__add', 'mcp__fixture__echo']);
  });

  it('resolves a bare command name through PATH (node)', async () => {
    const { ext } = setup({ fixture: { command: 'node', args: [FIXTURE] } });
    await ext.start();
    expect(names(ext)).toEqual(['mcp__fixture__add', 'mcp__fixture__echo']);
  });

  it('dispose() during a pending connect kills the half-started server process', async () => {
    const root = tmpDir();
    const pidFile = path.join(root, 'pid.txt');
    const script = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)";
    const { ext } = setup({ silent: { command: process.execPath, args: ['-e', script, pidFile] } }, { mcpStartupWaitMs: 200, mcpConnectTimeoutMs: 30_000 });
    await ext.start();
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    expect(ext.mcpStatus()[0]!.status).toBe('connecting');
    await ext.dispose();
    await waitFor(() => !alive(pid), 8000);
  });
});
