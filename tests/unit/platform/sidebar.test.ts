// Sidebar groups in the core: Settings.ui.sidebar (validation, persistence, older files) and the session fields
// category / order behind sessions.update, sessions.reorder, sessions.deleteCategory, sessions.create and sessions.fork.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreContext } from '@core/contracts';
import { createRpcHandlers, type RpcHandlers } from '@core/server/index';
import { dispatchRpc } from '@core/server/rpc';
import { createSessionStore } from '@core/store/sessions';
import { createSettingsStore } from '@core/store/settings';
import { defaultSidebarPrefs, normalizeSidebarPrefs } from '@shared/sidebar';
import type { SessionSummary, SidebarPrefs } from '@shared/types';
import { makeCtx, tempDir } from './helpers';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir('oc-sidebar-');
});
afterEach(() => tmp.cleanup());

const cat = (id: string, name = id, createdAt = 1) => ({ id, name, createdAt });

describe('normalizeSidebarPrefs', () => {
  it('gives every field its default for junk', () => {
    expect(normalizeSidebarPrefs(undefined)).toEqual(defaultSidebarPrefs());
    expect(normalizeSidebarPrefs('x')).toEqual(defaultSidebarPrefs());
    expect(normalizeSidebarPrefs({ groupOrder: 3, groupNames: [], categories: {}, collapsed: 'no' })).toEqual(defaultSidebarPrefs());
  });

  it('keeps good values and drops bad ones', () => {
    const p = normalizeSidebarPrefs({
      groupOrder: ['f:e:\\a', 'c:k1', 'c:gone', 'f:e:\\a', 'nonsense', 7],
      groupNames: { 'f:e:\\a': '  Backend  ', 'f:e:\\b': '   ', 'c:k1': 'not for categories', __proto__: 'x' },
      categories: [cat('k1', '  Research '), cat('k1', 'dup'), cat('bad id!', 'x'), cat('k2', '   '), { id: 'k3', name: 'No date' }, 'junk'],
      collapsed: ['pinned', 'f:e:\\a', 'c:k1', 'c:gone', 'zzz'],
    });
    expect(p.categories).toEqual([cat('k1', 'Research'), { id: 'k3', name: 'No date', createdAt: 0 }]);
    expect(p.groupOrder).toEqual(['f:e:\\a', 'c:k1']); // c:gone (no such category) and the rest are gone
    expect(p.groupNames).toEqual({ 'f:e:\\a': 'Backend' });
    expect(p.collapsed).toEqual(['pinned', 'f:e:\\a', 'c:k1']);
  });

  it('caps the names and the number of categories', () => {
    const p = normalizeSidebarPrefs({ categories: Array.from({ length: 150 }, (_, i) => cat(`k${i}`, 'n'.repeat(100))) });
    expect(p.categories).toHaveLength(100);
    expect(p.categories[0].name).toHaveLength(60);
  });
});

describe('Settings.ui.sidebar', () => {
  it('older settings files get the default layout', () => {
    writeFileSync(join(tmp.dir, 'settings.json'), JSON.stringify({ vast: { monthlyBudget: 300 } }));
    expect(createSettingsStore(tmp.dir).get().ui).toEqual({ sidebar: defaultSidebarPrefs() });
  });

  it('a partial patch changes only what it names; groupNames is replaced as a whole', () => {
    const store = createSettingsStore(tmp.dir);
    store.update({ ui: { sidebar: { categories: [cat('k1', 'Research')], groupNames: { 'f:e:\\a': 'A', 'f:e:\\b': 'B' } } } } as never);
    let s = store.update({ ui: { sidebar: { collapsed: ['pinned'] } } } as never);
    expect(s.ui.sidebar).toEqual({ groupOrder: [], groupNames: { 'f:e:\\a': 'A', 'f:e:\\b': 'B' }, categories: [cat('k1', 'Research')], collapsed: ['pinned'] });
    s = store.update({ ui: { sidebar: { groupNames: { 'f:e:\\b': 'Only B' } } } } as never);
    expect(s.ui.sidebar.groupNames).toEqual({ 'f:e:\\b': 'Only B' });
    expect(s.ui.sidebar.collapsed).toEqual(['pinned']);
  });

  it('is saved to settings.json and survives a restart', () => {
    const store = createSettingsStore(tmp.dir);
    const sidebar: SidebarPrefs = {
      groupOrder: ['c:k1', 'f:e:\\a'],
      groupNames: { 'f:e:\\a': 'Backend' },
      categories: [cat('k1', 'Research', 42)],
      collapsed: ['c:k1'],
    };
    store.update({ ui: { sidebar } });
    expect(JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')).ui.sidebar).toEqual(sidebar);
    expect(createSettingsStore(tmp.dir).get().ui.sidebar).toEqual(sidebar);
  });

  it('repairs a hand-edited or broken section', () => {
    writeFileSync(join(tmp.dir, 'settings.json'), JSON.stringify({ ui: 'oops' }));
    expect(createSettingsStore(tmp.dir).get().ui.sidebar).toEqual(defaultSidebarPrefs());
    writeFileSync(join(tmp.dir, 'settings.json'), JSON.stringify({ ui: { sidebar: { collapsed: ['pinned', 5], categories: [cat('k1')], groupOrder: ['c:k2'] } } }));
    expect(createSettingsStore(tmp.dir).get().ui.sidebar).toEqual({ groupOrder: [], groupNames: {}, categories: [cat('k1')], collapsed: ['pinned'] });
  });
});

describe('session category and order', () => {
  it('are kept in the summary and in the session file', async () => {
    const store = createSessionStore(tmp.dir);
    const s = store.create({ cwd: tmp.dir, title: 'one', category: 'k1', order: 4 });
    expect(store.list()[0]).toMatchObject({ id: s.id, category: 'k1', order: 4 });
    await store.flush();
    const again = createSessionStore(tmp.dir);
    expect(again.list()[0]).toMatchObject({ id: s.id, category: 'k1', order: 4 });
    // sessions saved before the fields existed have neither
    const old = join(tmp.dir, 'sessions', 'legacy.json');
    writeFileSync(old, JSON.stringify({ id: 'legacy', title: 'old', cwd: tmp.dir, kind: 'chat', createdAt: 1, updatedAt: 2 }));
    const legacy = createSessionStore(tmp.dir).list().find((x) => x.id === 'legacy') as SessionSummary;
    expect(legacy.category).toBeUndefined();
    expect(legacy.order).toBeUndefined();
  });
});

describe('sidebar RPCs', () => {
  let ctx: CoreContext;
  let handlers: RpcHandlers;
  const call = <T>(method: string, params: unknown) => dispatchRpc(handlers, method, params) as Promise<T>;
  const dir = () => {
    const d = join(tmp.dir, 'proj');
    mkdirSync(d, { recursive: true });
    return d;
  };
  const make = async (title: string, extra: Record<string, unknown> = {}) => call<SessionSummary>('sessions.create', { cwd: dir(), title, ...extra });
  const prefs = () => ctx.settings.get().ui.sidebar;

  beforeEach(() => {
    ctx = makeCtx(tmp.dir);
    handlers = createRpcHandlers(ctx);
    ctx.settings.update({ ui: { sidebar: { ...defaultSidebarPrefs(), categories: [cat('k1', 'Research'), cat('k2', 'Ideas')], groupOrder: ['c:k1', 'c:k2'], collapsed: ['c:k1'] } } });
  });

  it('sessions.update sets and clears the category and the order, and checks them', async () => {
    const a = await make('a');
    expect(await call<SessionSummary>('sessions.update', { id: a.id, patch: { category: 'k1' } })).toMatchObject({ category: 'k1' });
    expect(await call<SessionSummary>('sessions.update', { id: a.id, patch: { order: 3 } })).toMatchObject({ category: 'k1', order: 3 });
    const back = await call<SessionSummary>('sessions.update', { id: a.id, patch: { category: null, order: null } });
    expect(back.category).toBeUndefined();
    expect(back.order).toBeUndefined();
    await expect(call('sessions.update', { id: a.id, patch: { category: 'nope' } })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.update', { id: a.id, patch: { order: 'first' } })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.update', { id: a.id, patch: { order: Infinity } })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.update', { id: a.id, patch: { title: 'x' } })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.update', { id: a.id, patch: { pinned: 'yes' } })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.update', { id: 'ghost', patch: { order: 1 } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call('sessions.update', { id: a.id })).resolves.toMatchObject({ id: a.id }); // empty patch = nothing to do
    const sub = ctx.sessions.create({ cwd: tmp.dir, kind: 'subagent', parentSessionId: a.id });
    await expect(call('sessions.update', { id: sub.id, patch: { category: 'k1' } })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('a move drops the manual order (it lands on top of its new group) unless the patch gives one', async () => {
    const a = await make('a');
    await call('sessions.update', { id: a.id, patch: { order: 5 } });
    expect((await call<SessionSummary>('sessions.update', { id: a.id, patch: { category: 'k1' } })).order).toBeUndefined();
    await call('sessions.update', { id: a.id, patch: { order: 2 } });
    expect((await call<SessionSummary>('sessions.update', { id: a.id, patch: { category: 'k1' } })).order).toBe(2); // not moved: same category
    expect(await call<SessionSummary>('sessions.update', { id: a.id, patch: { category: 'k2', order: 9 } })).toMatchObject({ category: 'k2', order: 9 });
    expect((await call<SessionSummary>('sessions.update', { id: a.id, patch: { pinned: true } })).order).toBeUndefined();
    await call('sessions.update', { id: a.id, patch: { order: 1 } });
    expect((await call<SessionSummary>('sessions.setPinned', { id: a.id, pinned: false })).order).toBeUndefined();
    expect(await call<SessionSummary>('sessions.update', { id: a.id, patch: { pinned: true, category: 'k1' } })).toMatchObject({ pinned: true, category: 'k1' });
  });

  it('a change does not touch updatedAt and tells the clients', async () => {
    const a = await make('a');
    const seen: SessionSummary[] = [];
    ctx.bus.on('session.updated', (s) => seen.push(s));
    const before = a.updatedAt;
    await call('sessions.update', { id: a.id, patch: { category: 'k1' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: a.id, category: 'k1', updatedAt: before });
  });

  it('sessions.reorder numbers the given sessions and skips the ones that are already right', async () => {
    const [a, b, c] = [await make('a'), await make('b'), await make('c')];
    const seen: string[] = [];
    ctx.bus.on('session.updated', (s) => seen.push(s.id));
    await call('sessions.reorder', { ids: [c.id, a.id, b.id] });
    expect([c, a, b].map((s) => ctx.sessions.get(s.id)?.order)).toEqual([1, 2, 3]);
    expect(seen).toEqual([c.id, a.id, b.id]);
    seen.length = 0;
    await call('sessions.reorder', { ids: [c.id, b.id, a.id, 'ghost', c.id] });
    expect(seen).toEqual([b.id, a.id]); // c stays at 1; the unknown id and the repeat are skipped
    expect([c, b, a].map((s) => ctx.sessions.get(s.id)?.order)).toEqual([1, 2, 3]);
    await expect(call('sessions.reorder', { ids: 'a' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.reorder', { ids: [1] })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('sessions.create starts in a category; a fork stays in its source\'s category', async () => {
    const a = await make('a', { category: 'k2' });
    expect(a.category).toBe('k2');
    await expect(make('b', { category: 'nope' })).rejects.toMatchObject({ code: 'invalid_params' });
    const plain = await make('c');
    expect(plain.category).toBeUndefined();
    const fork = await call<SessionSummary>('sessions.fork', { id: a.id });
    expect(fork.category).toBe('k2');
    expect(fork.order).toBeUndefined();
    ctx.settings.update({ ui: { sidebar: { ...prefs(), categories: [cat('k1', 'Research')] } } }); // k2 deleted behind its back
    expect((await call<SessionSummary>('sessions.fork', { id: a.id })).category).toBeUndefined();
  });

  it('sessions.deleteCategory with keep: the sessions go back to their folders, the category and its keys are gone', async () => {
    const a = await make('a', { category: 'k1' });
    await call('sessions.update', { id: a.id, patch: { order: 2 } });
    const b = await make('b', { category: 'k2' });
    const r = await call<{ released: number; deleted: number }>('sessions.deleteCategory', { id: 'k1', deleteSessions: false });
    expect(r).toEqual({ ok: true, released: 1, deleted: 0 });
    expect(ctx.sessions.get(a.id)).toMatchObject({ title: 'a' });
    expect(ctx.sessions.get(a.id)?.category).toBeUndefined();
    expect(ctx.sessions.get(a.id)?.order).toBeUndefined();
    expect(ctx.sessions.get(b.id)?.category).toBe('k2');
    expect(prefs().categories.map((c) => c.id)).toEqual(['k2']);
    expect(prefs().groupOrder).toEqual(['c:k2']);
    expect(prefs().collapsed).toEqual([]); // 'c:k1' was collapsed
    await expect(call('sessions.deleteCategory', { id: 'k1', deleteSessions: false })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('sessions.deleteCategory with delete: the sessions (and their subagents) go too, nothing else does', async () => {
    const a = await make('a', { category: 'k1' });
    const sub = ctx.sessions.create({ cwd: tmp.dir, kind: 'subagent', parentSessionId: a.id });
    const keep = await make('keep');
    const other = await make('other', { category: 'k2' });
    const gone: string[] = [];
    ctx.bus.on('session.deleted', (e) => gone.push(e.sessionId));
    const r = await call('sessions.deleteCategory', { id: 'k1', deleteSessions: true });
    expect(r).toEqual({ ok: true, released: 0, deleted: 1 });
    expect(ctx.sessions.get(a.id)).toBeUndefined();
    expect(ctx.sessions.get(sub.id)).toBeUndefined();
    expect(gone.sort()).toEqual([a.id, sub.id].sort());
    expect(ctx.sessions.get(keep.id)).toBeDefined();
    expect(ctx.sessions.get(other.id)).toBeDefined();
    await expect(call('sessions.deleteCategory', { id: 'k2', deleteSessions: 'yes' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('never touches files on disk', async () => {
    const d = dir();
    writeFileSync(join(d, 'keep.txt'), 'x');
    const a = await make('a', { category: 'k1' });
    await call('sessions.deleteCategory', { id: 'k1', deleteSessions: true });
    expect(ctx.sessions.get(a.id)).toBeUndefined();
    expect(readFileSync(join(d, 'keep.txt'), 'utf8')).toBe('x');
  });
});
