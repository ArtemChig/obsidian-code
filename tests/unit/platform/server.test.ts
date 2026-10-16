import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { CoreContext } from '@core/contracts';
import { createActivityRegistry } from '@core/activity/index';
import { createEventBus } from '@core/server/bus';
import { createRpcHandlers, startServer, type ServerHandle } from '@core/server/index';
import { clearFileIndexCache, fuzzyScore } from '@core/server/files';
import type { CoreEventMessage } from '@shared/protocol';
import { makeCtx, stubGpu, tempDir } from './helpers';

interface Client {
  ws: WebSocket;
  events: CoreEventMessage[];
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  waitEvent(name: string, timeoutMs?: number): Promise<CoreEventMessage>;
  close(): void;
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events: CoreEventMessage[] = [];
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const waiters: { name: string; fn: (m: CoreEventMessage) => void }[] = [];
    let nextId = 1;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { message: string; code?: string }; event?: string };
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      } else if (msg.event) {
        const ev = msg as CoreEventMessage;
        events.push(ev);
        for (const w of [...waiters]) {
          if (w.name === ev.event) {
            waiters.splice(waiters.indexOf(w), 1);
            w.fn(ev);
          }
        }
      }
    });
    ws.once('open', () =>
      resolve({
        ws,
        events,
        call(method, params) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params ?? {} }));
          });
        },
        waitEvent(name, timeoutMs = 3000) {
          const existing = events.find((e) => e.event === name);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${name}`)), timeoutMs);
            waiters.push({
              name,
              fn: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

let tmp: ReturnType<typeof tempDir>;
let ctx: CoreContext;
let server: ServerHandle;
let workspace: string;

beforeEach(async () => {
  tmp = tempDir();
  workspace = join(tmp.dir, 'workspace');
  mkdirSync(join(workspace, 'src', 'components'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'components', 'Button.tsx'), 'export const Button = 1;\n');
  writeFileSync(join(workspace, 'src', 'index.ts'), 'import "./components/Button";\n');
  writeFileSync(join(workspace, 'README.md'), '# readme\n' + 'x'.repeat(5000));
  writeFileSync(join(workspace, 'node_modules', 'dep', 'button.js'), '');
  ctx = makeCtx(join(tmp.dir, 'data'));
  ctx.settings.update({ defaultCwd: workspace });
  server = await startServer({ ctx });
  clearFileIndexCache();
});

afterEach(async () => {
  await server.close();
  await ctx.sessions.flush();
  tmp.cleanup();
});

describe('core server', () => {
  it('serves /health without auth and binds to 127.0.0.1', async () => {
    expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/);
    const r = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, name: 'obsidian-code' });
  });

  it('rejects WebSocket connections with a bad or missing token', async () => {
    const base = `ws://127.0.0.1:${server.port}/ws`;
    await expect(connect(`${base}?token=wrong`)).rejects.toThrow(/401/);
    await expect(connect(base)).rejects.toThrow(/401/);
    const r = await fetch(`http://127.0.0.1:${server.port}/rpc`, { method: 'POST', body: JSON.stringify({ method: 'system.info' }) });
    expect(r.status).toBe(401);
  });

  it('dispatches RPC calls and reports errors', async () => {
    const c = await connect(server.url);
    try {
      const info = await c.call<{ platform: string; dataDir: string; electron: boolean }>('system.info');
      expect(info.platform).toBe(process.platform);
      expect(info.dataDir).toBe(ctx.dataDir);
      expect(info.electron).toBe(false);

      await expect(c.call('nope.method')).rejects.toMatchObject({ code: 'method_not_found' });
      await expect(c.call('sessions.get', { id: 42 })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(c.call('sessions.get', { id: 'missing' })).rejects.toThrow(/Session not found/);

      expect(await c.call('commands.list', { cwd: workspace })).toEqual([{ name: 'deploy', description: 'Deploy', source: 'project' }]);
      expect(ctx.ext.slashCommands).toHaveBeenCalledWith(workspace);
      expect(await c.call('files.diff', { sessionId: 's', path: 'a' })).toEqual({ before: 'a', after: 'b' });
      expect(await c.call('gpu.status')).toMatchObject({ phase: 'off' });
      await c.call('gpu.clockIn', { profileId: 'light', modelId: 'm' });
      expect(ctx.gpu.clockIn).toHaveBeenCalledWith({ profileId: 'light', modelId: 'm' });
      expect(await c.call('gpu.serverLog', { lines: 10 })).toEqual({ text: 'log' });
      expect(await c.call('schedules.runNow', { id: 'x' })).toEqual({ sessionId: 's1' });
      expect(await c.call('models.list')).toEqual({ providers: [], models: [] });

      await c.call('secrets.set', { name: 'vast.apiKey', value: 'k-123' });
      expect(await c.call('secrets.has', { names: ['vast.apiKey', 'search.braveKey'] })).toEqual({
        'vast.apiKey': true,
        'search.braveKey': false,
      });
      expect(JSON.stringify(await c.call('settings.get'))).not.toContain('k-123');

      const updated = await c.call<{ vast: { monthlyBudget: number } }>('settings.update', { patch: { vast: { monthlyBudget: 120 } } });
      expect(updated.vast.monthlyBudget).toBe(120);
    } finally {
      c.close();
    }
  });

  it('creates sessions with defaults, emits events and supports session mutations', async () => {
    const c = await connect(server.url);
    try {
      const s = await c.call<{ id: string; cwd: string; model: unknown; permissionMode: string; thinking: boolean; kind: string }>(
        'sessions.create',
        {},
      );
      expect(s.cwd).toBe(workspace);
      expect(s.model).toEqual({ provider: 'local', model: 'qwen-local' });
      expect(s.permissionMode).toBe('default');
      expect(s.thinking).toBe(true);
      expect(s.kind).toBe('chat');
      const created = await c.waitEvent('session.created');
      expect((created.data as { id: string }).id).toBe(s.id);

      await expect(c.call('sessions.create', { cwd: join(tmp.dir, 'does-not-exist') })).rejects.toThrow(/Folder does not exist/);

      const renamed = await c.call<{ title: string }>('sessions.rename', { id: s.id, title: 'Renamed' });
      expect(renamed.title).toBe('Renamed');
      await c.waitEvent('session.updated');
      const mode = await c.call<{ permissionMode: string }>('chat.setPermissionMode', { sessionId: s.id, mode: 'plan' });
      expect(mode.permissionMode).toBe('plan');
      await expect(c.call('chat.setPermissionMode', { sessionId: s.id, mode: 'yolo' })).rejects.toMatchObject({ code: 'invalid_params' });
      const pinned = await c.call<{ pinned: boolean }>('sessions.setPinned', { id: s.id, pinned: true });
      expect(pinned.pinned).toBe(true);

      const sent = await c.call('chat.send', { sessionId: s.id, text: 'hello' });
      expect(sent).toEqual({ messageId: 'm1', queued: false });
      expect(ctx.agent.send).toHaveBeenCalledWith(s.id, 'hello', undefined);

      const live = ctx.sessions.get(s.id)!;
      live.messages.push({ id: 'u1', role: 'user', createdAt: 1, blocks: [{ type: 'text', text: 'first' }] });
      live.messages.push({ id: 'a1', role: 'assistant', createdAt: 2, blocks: [{ type: 'text', text: 'answer' }] });
      ctx.sessions.save(live);
      const fork = await c.call<{ id: string; title: string }>('sessions.fork', { id: s.id, atMessageId: 'u1' });
      expect(fork.title).toBe('Renamed (fork)');
      expect(ctx.sessions.get(fork.id)!.messages.map((m) => m.id)).toEqual(['u1']);

      const list = await c.call<{ id: string }[]>('sessions.list');
      expect(list.map((x) => x.id).sort()).toEqual([s.id, fork.id].sort());

      // delete interrupts a running session first
      vi.mocked(ctx.agent.isRunning).mockImplementation((id: string) => id === s.id);
      expect(await c.call('sessions.delete', { id: s.id })).toEqual({ ok: true });
      expect(ctx.agent.interrupt).toHaveBeenCalledWith(s.id);
      const deleted = await c.waitEvent('session.deleted');
      expect(deleted.data).toEqual({ sessionId: s.id });
      expect(ctx.sessions.get(s.id)).toBeUndefined();
    } finally {
      c.close();
    }
  });

  it('broadcasts every bus event to all connected clients', async () => {
    const a = await connect(server.url);
    const b = await connect(server.url);
    try {
      ctx.bus.emit('notification', { title: 'Hi', body: 'there', level: 'info' });
      ctx.bus.emit('gpu.status', { phase: 'ready', message: '', sessionCost: 0, monthCost: 0, monthlyBudget: 200, steps: [] });
      for (const c of [a, b]) {
        expect((await c.waitEvent('notification')).data).toEqual({ title: 'Hi', body: 'there', level: 'info' });
        expect((await c.waitEvent('gpu.status')).data).toMatchObject({ phase: 'ready' });
      }
      expect(server.clientCount()).toBe(2);
    } finally {
      a.close();
      b.close();
    }
  });

  it('implements files.list / files.search / files.read', async () => {
    const c = await connect(server.url);
    try {
      const entries = await c.call<{ name: string; isDir: boolean; path: string }[]>('files.list', { cwd: workspace });
      expect(entries.map((e) => e.name)).toEqual(['node_modules', 'src', 'README.md']);
      const sub = await c.call<{ name: string }[]>('files.list', { cwd: workspace, dir: 'src' });
      expect(sub.map((e) => e.name)).toEqual(['components', 'index.ts']);

      const found = await c.call<string[]>('files.search', { cwd: workspace, query: 'btn', limit: 10 });
      expect(found).toEqual(['src/components/Button.tsx']); // node_modules is ignored
      const byName = await c.call<string[]>('files.search', { cwd: workspace, query: 'index' });
      expect(byName[0]).toBe('src/index.ts');
      const all = await c.call<string[]>('files.search', { cwd: workspace, query: '', limit: 2 });
      expect(all).toHaveLength(2);

      const read = await c.call<{ content: string; truncated: boolean }>('files.read', { path: join(workspace, 'README.md'), maxBytes: 100 });
      expect(read.truncated).toBe(true);
      expect(read.content.startsWith('# readme')).toBe(true);
      expect(read.content.length).toBe(100);
    } finally {
      c.close();
    }
  });

  it('POST /rpc works with the token', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ method: 'skills.list', params: { cwd: workspace } }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ result: [{ name: 'sk', description: 'a skill', path: '/x', source: 'user' }] });
  });
});

describe('rpc table, bus and activity', () => {
  it('maps every protocol method', () => {
    const handlers = createRpcHandlers(makeCtx(tmp.dir));
    const methods = Object.keys(handlers);
    expect(methods).toContain('system.info');
    expect(methods).toContain('secrets.has');
    expect(methods.length).toBe(59); // 54 + hub.search, hub.details, hub.addModel, hub.removeModel, hub.setFavorite
    for (const m of methods) expect(typeof handlers[m as keyof typeof handlers]).toBe('function');
  });

  it('gpu.autoClockOut.get/set validate params and pass through to the module (errors become RpcErrors)', async () => {
    const ctx = makeCtx(tmp.dir);
    const handlers = createRpcHandlers(ctx);
    // no module in a minimal context
    expect(await handlers['gpu.autoClockOut.get']({})).toEqual([]);
    await expect(async () => handlers['gpu.autoClockOut.set']({ mode: 'both' })).rejects.toThrow(/not available/);
    const watch = { mode: 'both' as const, armedAt: 1, source: 'user' as const, stallMinutes: 10, finishGraceMinutes: 2 };
    const set = vi.fn((o: { sessionId?: string | null; mode: string }) => {
      if (o.sessionId === 'gone') throw new Error('Session not found: gone');
      return o.mode === 'off' ? [] : [watch];
    });
    ctx.autoClockOut = { list: () => [watch], set: set as never, dispose: () => undefined };
    expect(await handlers['gpu.autoClockOut.get']({})).toEqual([watch]);
    expect(await handlers['gpu.autoClockOut.set']({ mode: 'both' })).toEqual([watch]);
    expect(set).toHaveBeenLastCalledWith({ sessionId: null, mode: 'both' });
    await handlers['gpu.autoClockOut.set']({ sessionId: 's1', mode: 'finished' });
    expect(set).toHaveBeenLastCalledWith({ sessionId: 's1', mode: 'finished' });
    expect(await handlers['gpu.autoClockOut.set']({ sessionId: null, mode: 'off' })).toEqual([]);
    await expect(async () => handlers['gpu.autoClockOut.set']({ mode: 'sometimes' as never })).rejects.toThrow(/"mode" must be one of/);
    await expect(async () => handlers['gpu.autoClockOut.set']({ sessionId: 5 as never, mode: 'both' })).rejects.toThrow(/sessionId/);
    await expect(async () => handlers['gpu.autoClockOut.set']({ sessionId: 'gone', mode: 'both' })).rejects.toMatchObject({ code: 'invalid_state', message: 'Session not found: gone' });
  });

  it('gpu.clockOut cannot be used to spoof an automatic clock-out reason', async () => {
    const gpu = stubGpu({ phase: 'ready' });
    const handlers = createRpcHandlers(makeCtx(tmp.dir, { gpu }));
    await handlers['gpu.clockOut']({ reason: 'auto_unresponsive' as never });
    expect(gpu.clockOut).toHaveBeenLastCalledWith('clock_out');
  });

  it('refuses to remove the Vast.ai key while an instance is rented or parked (the app could not stop billing)', async () => {
    const gpu = stubGpu({ phase: 'ready', instanceId: 42 });
    const ctx = makeCtx(tmp.dir, { gpu });
    const handlers = createRpcHandlers(ctx);
    await handlers['secrets.set']({ name: 'vast.apiKey', value: 'k-1' });
    await expect(async () => handlers['secrets.set']({ name: 'vast.apiKey', value: null })).rejects.toThrow(/Clock out first/);
    expect(ctx.secrets.has('vast.apiKey')).toBe(true);
    // Replacing the key stays possible (e.g. the old one was revoked); the UI asks for confirmation.
    await handlers['secrets.set']({ name: 'vast.apiKey', value: 'k-2' });
    gpu.current = { ...gpu.current, phase: 'off', instanceId: undefined, parked: { instanceId: 9, profileId: 'light', modelId: 'm', gpuName: 'RTX 5090', storageCostPerHour: 0.01, parkedAt: 0 } };
    await expect(async () => handlers['secrets.set']({ name: 'vast.apiKey', value: null })).rejects.toThrow(/Clock out first/);
    gpu.current = { ...gpu.current, parked: undefined };
    await handlers['secrets.set']({ name: 'vast.apiKey', value: null });
    expect(ctx.secrets.has('vast.apiKey')).toBe(false);
  });

  it('fuzzy score prefers basename matches', () => {
    expect(fuzzyScore('src/components/button.tsx', 'btn')).toBeGreaterThan(fuzzyScore('lib/b/t/n.ts', 'btn'));
    expect(fuzzyScore('src/a.ts', 'zzz')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('activity registry throttles activity.updated and handles stop', async () => {
    vi.useFakeTimers();
    try {
      const bus = createEventBus();
      const seen: number[] = [];
      bus.on('activity.updated', (items) => seen.push(items.length));
      const act = createActivityRegistry(bus);
      act.upsert({ id: 'a', kind: 'session', title: 'A', status: 'running', startedAt: 1 });
      act.upsert({ id: 'b', kind: 'shell', title: 'B', status: 'running', startedAt: 2 });
      act.upsert({ id: 'c', kind: 'gpu', title: 'C', status: 'running', startedAt: 3 });
      expect(seen).toEqual([1]); // leading emit, rest throttled
      vi.advanceTimersByTime(300);
      expect(seen).toEqual([1, 3]);
      const stop = vi.fn();
      act.onStop('b', stop);
      act.stop('b');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(act.list().find((i) => i.id === 'b')?.status).toBe('stopped');
      act.upsert({ id: 'a', kind: 'session', title: 'A', status: 'done', startedAt: 1 });
      expect(act.list()[0].id).toBe('c'); // active items first
      expect(act.list().find((i) => i.id === 'a')?.endedAt).toBeTypeOf('number');
    } finally {
      vi.useRealTimers();
    }
  });
});
