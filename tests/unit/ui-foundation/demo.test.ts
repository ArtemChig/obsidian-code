// Demo transport: every RpcMethods method answers; streaming chat simulation; extension registry.
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreEventName, RpcMethod, RpcParams, RpcResult } from '@shared/protocol';
import type { Block, GpuOffer, Session, SessionSummary } from '@shared/types';
import { createDemoTransport, registerDemoData, registerDemoHandler, resetDemoRegistry } from '@renderer/lib/demo';

type DemoTransport = ReturnType<typeof createDemoTransport>;

let t: DemoTransport | null = null;
afterEach(() => {
  t?.close();
  t = null;
  resetDemoRegistry();
});

function record(tr: DemoTransport) {
  const events: { event: CoreEventName; data: unknown }[] = [];
  tr.onAny((event: CoreEventName, data: unknown) => events.push({ event, data }));
  return events;
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// Every RpcMethods entry with plausible params — the satisfies clause makes this list fail to compile if a
// method is added to the protocol without being listed here.
const CALLS = {
  'system.info': {},
  'sessions.list': { includeSubagents: true },
  'sessions.get': { id: 's-glm' },
  'sessions.create': { cwd: 'C:\\x' },
  'sessions.rename': { id: 's-glm', title: 'Renamed' },
  'sessions.delete': { id: 's-notes' },
  'sessions.fork': { id: 's-glm' },
  'sessions.setPinned': { id: 's-bench', pinned: true },
  'sessions.search': { query: 'parser' },
  'chat.send': { sessionId: 's-hearth', text: '/cost' },
  'chat.interrupt': { sessionId: 's-hearth' },
  'chat.dequeue': { sessionId: 's-sse-explore' },
  'chat.respondPermission': { requestId: 'none', decision: 'deny' },
  'chat.answerQuestion': { requestId: 'none', answers: {} },
  'chat.respondPlan': { requestId: 'none', approve: false },
  'chat.setPermissionMode': { sessionId: 's-glm', mode: 'plan' },
  'chat.setModel': { sessionId: 's-glm', model: { provider: 'local', model: 'x' } },
  'chat.setThinking': { sessionId: 's-glm', thinking: false },
  'chat.rewind': { sessionId: 's-glm', atMessageId: 'm-glm-2', restoreFiles: true },
  'chat.pending': {},
  'commands.list': { cwd: 'C:\\x' },
  'skills.list': { cwd: 'C:\\x' },
  'agents.list': { cwd: 'C:\\x' },
  'files.list': { cwd: 'C:\\x' },
  'files.search': { cwd: 'C:\\x', query: 'rpc' },
  'files.read': { path: 'C:\\x\\a.ts' },
  'files.diff': { sessionId: 's-glm', path: 'nope' },
  'models.list': {},
  'models.refresh': {},
  'gpu.status': {},
  'gpu.catalog': {},
  'gpu.offers': { profileId: 'light' },
  'gpu.clockIn': { profileId: 'light' },
  'gpu.clockOut': {},
  'gpu.switchModel': { modelId: 'x' },
  'gpu.history': {},
  'gpu.destroyOrphans': {},
  'gpu.serverLog': {},
  'gpu.testKey': {},
  'schedules.list': {},
  'schedules.create': { name: 'n', prompt: 'p', cwd: 'C:\\x', schedule: '0 * * * *', oneShot: false, enabled: true, model: null, permissionMode: 'default', allowAutoClockIn: false },
  'schedules.update': { id: 'sch-audit', patch: { enabled: false } },
  'schedules.delete': { id: 'sch-standup' },
  'schedules.runNow': { id: 'sch-audit' },
  'activity.list': {},
  'activity.stop': { id: 'a-shell' },
  'settings.get': {},
  'settings.update': { patch: { notifications: false } },
  'secrets.set': { name: 'search.braveKey', value: 'x' },
  'secrets.has': { names: ['vast.apiKey', 'search.braveKey'] },
} satisfies { [M in RpcMethod]: RpcParams<M> };

describe('demo transport', () => {
  it('connects and answers every RpcMethods method', async () => {
    t = createDemoTransport({ latencyMs: 0, speed: 0 });
    const connected: boolean[] = [];
    t.onConnected((i: { reconnect: boolean }) => connected.push(i.reconnect));
    t.connect();
    await waitFor(() => connected.length === 1);
    expect(t.getState().status).toBe('open');
    for (const [method, params] of Object.entries(CALLS)) {
      try {
        await t.request(method as RpcMethod, params as never);
      } catch (err) {
        // Expected domain errors are fine (e.g. switchModel while clocking); "not implemented" is not.
        expect((err as { code?: string }).code, `${method}: ${(err as Error).message}`).not.toBe('not_implemented');
      }
    }
    const has = await t.request('secrets.has', { names: ['search.braveKey'] });
    expect(has['search.braveKey']).toBe(true);
  });

  it('simulates a streaming turn: thinking → text → tools → completion', async () => {
    t = createDemoTransport({ latencyMs: 0, speed: 0 });
    const events = record(t);
    const s = await t.request('sessions.create', { cwd: 'C:\\proj' });
    const r = await t.request('chat.send', { sessionId: s.id, text: 'Add backoff to the client' });
    expect(r.queued).toBe(false);
    await waitFor(() => events.some((e) => e.event === 'session.updated' && (e.data as { status: string; id: string }).status === 'idle' && (e.data as { id: string }).id === s.id));
    const names = events.map((e) => e.event);
    expect(names).toContain('message.added');
    expect(names).toContain('message.delta');
    expect(names).toContain('tool.updated');
    expect(names).toContain('todos.updated');
    expect(names).toContain('changes.updated');
    expect(names).toContain('message.completed');
    const deltas = events.filter((e) => e.event === 'message.delta').map((e) => (e.data as { blockType: string }).blockType);
    expect(deltas[0]).toBe('thinking');
    expect(deltas).toContain('text');
    const full = await t.request('sessions.get', { id: s.id });
    expect(full.title).toBe('Add backoff to the client');
    expect(full.messages[0].role).toBe('user');
    const assistant = full.messages[1];
    expect(assistant.blocks.some((b: Block) => b.type === 'tool_use' && b.status === 'done')).toBe(true);
    expect(assistant.meta?.completionTokens).toBeGreaterThan(0);
  });

  it('waits for permission and resumes after respondPermission; queues while running', async () => {
    t = createDemoTransport({ latencyMs: 0, speed: 0 });
    const events = record(t);
    const s = await t.request('sessions.create', { cwd: 'C:\\proj' });
    await t.request('chat.send', { sessionId: s.id, text: 'run the tests' });
    await waitFor(() => events.some((e) => e.event === 'permission.requested'));
    const queued = await t.request('chat.send', { sessionId: s.id, text: 'and then summarize' });
    expect(queued.queued).toBe(true);
    const pending = await t.request('chat.pending', { sessionId: s.id });
    expect(pending.permissions).toHaveLength(1);
    await t.request('chat.respondPermission', { requestId: pending.permissions[0].requestId, decision: 'allow' });
    await waitFor(() => events.some((e) => e.event === 'message.added' && (e.data as { message: { id: string } }).message.id === queued.messageId));
    expect(events.some((e) => e.event === 'permission.resolved')).toBe(true);
  });

  it('interrupt stops a running turn', async () => {
    t = createDemoTransport({ latencyMs: 0, speed: 1 });
    const events = record(t);
    const s = await t.request('sessions.create', { cwd: 'C:\\proj' });
    await t.request('chat.send', { sessionId: s.id, text: 'Refactor the sidebar' });
    await waitFor(() => events.some((e) => e.event === 'message.delta'));
    await t.request('chat.interrupt', { sessionId: s.id });
    await waitFor(() => events.some((e) => e.event === 'message.completed'));
    const done = events.find((e) => e.event === 'message.completed')?.data as { meta: { interrupted?: boolean } };
    expect(done.meta.interrupted).toBe(true);
  });

  it('extension API: registerDemoData merges by id; registerDemoHandler overrides with fallback', async () => {
    registerDemoData((d: { sessions: Session[] }) => ({ sessions: [{ ...d.sessions[0], id: 'extra', title: 'From ui-chat' }] }));
    registerDemoData({ secrets: { 'search.tavilyKey': true } });
    registerDemoHandler('gpu.offers', async (params: RpcParams<'gpu.offers'>, ctx: { fallback(): Promise<unknown> }) => {
      const base = (await ctx.fallback()) as GpuOffer[];
      return params.profileId === 'light' ? base : [];
    });
    registerDemoHandler('system.info', (_p: unknown, ctx: { data: { system: RpcResult<'system.info'> } }) => ({ ...ctx.data.system, version: '9.9.9' }));
    t = createDemoTransport({ latencyMs: 0, speed: 0 });
    const list = await t.request('sessions.list', {});
    expect(list.find((x: SessionSummary) => x.id === 'extra')?.title).toBe('From ui-chat');
    expect((await t.request('secrets.has', { names: ['search.tavilyKey', 'vast.apiKey'] }))['search.tavilyKey']).toBe(true);
    expect((await t.request('system.info', {})).version).toBe('9.9.9');
    expect((await t.request('gpu.offers', { profileId: 'light' })).length).toBeGreaterThan(0);
    // Patches registered after start apply live.
    registerDemoData({ schedules: [] });
    expect((await t.request('schedules.list', {})).length).toBeGreaterThan(0); // arrays merge, not replace
  });

  it('GPU clock-out then clock-in walks the phases', async () => {
    t = createDemoTransport({ latencyMs: 0, speed: 0 });
    const events = record(t);
    await t.request('gpu.clockOut', {});
    await waitFor(() => events.some((e) => e.event === 'gpu.status' && (e.data as { phase: string }).phase === 'off'));
    const st = await t.request('gpu.clockIn', { profileId: 'light' });
    expect(st.phase).toBe('searching');
    await waitFor(() => events.some((e) => e.event === 'gpu.status' && (e.data as { phase: string }).phase === 'ready'));
    const phases = events.filter((e) => e.event === 'gpu.status').map((e) => (e.data as { phase: string }).phase);
    expect(phases).toEqual(expect.arrayContaining(['renting', 'connecting', 'downloading', 'loading', 'ready']));
  });
});
