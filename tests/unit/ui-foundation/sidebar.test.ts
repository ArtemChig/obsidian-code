// The sidebar layout actions against the demo core: collapse, rename, categories, group order, moving sessions.
// What the user sees (the stores) and what the core keeps (Settings.ui.sidebar, the sessions' category / order).
import { beforeAll, describe, expect, it } from 'vitest';
import { categoryGroupKey, folderGroupKey } from '@shared/sidebar';
import { createDemoTransport } from '@renderer/lib/demo';
import { rpc } from '@renderer/lib/rpc';
import {
  createCategory,
  createSession,
  deleteCategory,
  dropGroup,
  dropSession,
  moveGroup,
  moveSessionToCategory,
  placeSession,
  renameGroup,
  setAllGroupsCollapsed,
  stepSession,
  toggleGroupCollapsed,
  updateSidebarPrefs,
} from '@renderer/state/actions';
import { useConnection } from '@renderer/state/connection';
import { useSessions } from '@renderer/state/sessions';
import { useSettings } from '@renderer/state/settings';
import { currentGroupKeys, currentSidebarPrefs } from '@renderer/state/sidebar';
import { groupSessions } from '@renderer/state/sidebar-model';
import { bindEvents } from '@renderer/state/sync';
import { useToasts } from '@renderer/state/toasts';

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** The core's copy (not the store's). */
const coreSidebar = async () => (await rpc.request('settings.get', {})).ui.sidebar;
const coreSession = async (id: string) => (await rpc.request('sessions.list', {})).find((x) => x.id === id);
const model = () => groupSessions(useSessions.getState().sessions, '', currentSidebarPrefs());
const idsIn = (key: string) => (model().groups.find((g) => g.key === key)?.sessions ?? []).map((x) => x.id);

const KH = folderGroupKey('E:\\programming projects\\hearth');
const KO = folderGroupKey('E:\\programming projects\\Dedicated LLM\\obsidian-code');

describe('sidebar layout actions (demo core)', () => {
  beforeAll(async () => {
    bindEvents();
    const t = createDemoTransport({ latencyMs: 0, speed: 0 });
    rpc.setTransport(t);
    t.connect();
    await waitFor(() => useConnection.getState().ready);
  });

  it('starts with the default layout', () => {
    expect(currentSidebarPrefs()).toEqual({ groupOrder: [], groupNames: {}, categories: [], collapsed: [] });
    expect(model().groups.map((g) => g.key)).toContain(KH);
  });

  it('remembers the collapsed groups in the core', async () => {
    expect(await toggleGroupCollapsed(KH)).toBe(true);
    expect(currentSidebarPrefs().collapsed).toEqual([KH]);
    expect((await coreSidebar()).collapsed).toEqual([KH]);
    await toggleGroupCollapsed('pinned');
    expect((await coreSidebar()).collapsed).toEqual([KH, 'pinned']);
    await toggleGroupCollapsed(KH);
    expect((await coreSidebar()).collapsed).toEqual(['pinned']);
    await setAllGroupsCollapsed(true);
    const all = (await coreSidebar()).collapsed;
    expect(all).toEqual(expect.arrayContaining(['pinned', KH, KO]));
    await setAllGroupsCollapsed(false);
    expect((await coreSidebar()).collapsed).toEqual([]);
  });

  it('renames a folder group (a display name only) and gives the folder name back on an empty name', async () => {
    await renameGroup({ key: KH, kind: 'folder' }, '  Hearth   app ');
    expect(model().groups.find((g) => g.key === KH)).toMatchObject({ name: 'Hearth app', renamed: true });
    expect((await coreSidebar()).groupNames).toEqual({ [KH]: 'Hearth app' });
    await renameGroup({ key: KH, kind: 'folder' }, '');
    expect(model().groups.find((g) => g.key === KH)).toMatchObject({ name: 'hearth', renamed: false });
    expect((await coreSidebar()).groupNames).toEqual({});
  });

  it('creates categories under a group, with unique names, and renames them', async () => {
    const k1 = await createCategory({ name: 'Research', afterKey: KO });
    const k2 = await createCategory({ name: 'research' });
    expect(k1).toMatch(/^c:cat-/);
    const prefs = await coreSidebar();
    expect(prefs.categories.map((c) => c.name)).toEqual(['Research', 'research 2']);
    expect(prefs.groupOrder.indexOf(k1!)).toBe(prefs.groupOrder.indexOf(KO) + 1);
    expect(prefs.groupOrder[0]).toBe(k2); // no group given: on top
    const id = k1!.slice(2);
    await renameGroup({ key: k1!, kind: 'category', categoryId: id }, 'Reading');
    expect((await coreSidebar()).categories.find((c) => c.id === id)?.name).toBe('Reading');
    expect(await renameGroup({ key: k1!, kind: 'category', categoryId: id }, '   ')).toBe(false); // a category keeps a name
    expect(model().groups.find((g) => g.key === k1)?.name).toBe('Reading');
  });

  it('moves and drops groups, keeping the order in the core', async () => {
    const keys = currentGroupKeys();
    const last = keys[keys.length - 1];
    expect(await moveGroup(last, -1)).toBe(true);
    expect((await coreSidebar()).groupOrder).toEqual([...keys.slice(0, -2), last, keys[keys.length - 2]]);
    expect(await moveGroup(currentGroupKeys()[0], -1)).toBe(false); // already first
    const now = currentGroupKeys();
    expect(await dropGroup(now[0], now[now.length - 1])).toBe(true);
    expect((await coreSidebar()).groupOrder).toEqual([...now.slice(1), now[0]]);
  });

  it('moves a session into a category and back, and the core keeps it', async () => {
    const [cat] = (await coreSidebar()).categories;
    const s = await createSession({ cwd: 'E:\\programming projects\\hearth', open: false });
    expect(await moveSessionToCategory(s!.id, cat.id)).toBe(true);
    expect(useSessions.getState().sessions[s!.id].category).toBe(cat.id);
    expect((await coreSession(s!.id))?.category).toBe(cat.id);
    expect(idsIn(categoryGroupKey(cat.id))).toEqual([s!.id]);
    expect(idsIn(KH)).not.toContain(s!.id);
    await moveSessionToCategory(s!.id, null);
    expect((await coreSession(s!.id))?.category).toBeUndefined();
    expect(idsIn(KH)).toContain(s!.id);
  });

  it('drops a session at a place; the group is numbered in the core', async () => {
    const [cat] = (await coreSidebar()).categories;
    const tick = () => new Promise((r) => setTimeout(r, 4)); // updatedAt has millisecond resolution
    const a = await createSession({ cwd: 'E:\\programming projects\\hearth', title: 'drop-a', open: false });
    await tick();
    const b = await createSession({ cwd: 'E:\\programming projects\\hearth', title: 'drop-b', open: false });
    await tick();
    const c = await createSession({ cwd: 'E:\\programming projects\\hearth', title: 'drop-c', open: false });
    for (const x of [a, b, c]) await moveSessionToCategory(x!.id, cat.id);
    const key = categoryGroupKey(cat.id);
    expect(idsIn(key)).toEqual([c!.id, b!.id, a!.id]); // not placed by hand: newest first
    expect(await dropSession(a!.id, key, 0)).toBe(true);
    expect(idsIn(key)).toEqual([a!.id, c!.id, b!.id]);
    expect((await coreSession(a!.id))?.order).toBe(1);
    expect((await coreSession(c!.id))?.order).toBe(2);
    expect((await coreSession(b!.id))?.order).toBe(3);
    expect(await stepSession(b!.id, -1)).toBe(true);
    expect(idsIn(key)).toEqual([a!.id, b!.id, c!.id]);
    expect(await stepSession(a!.id, -1)).toBe(false); // already on top
    // a session never changes folder: another folder's group refuses it
    expect(await dropSession(a!.id, KO, 0)).toBe(false);
    // a new session goes on top of the hand-placed ones
    await tick();
    const d = await createSession({ cwd: 'E:\\programming projects\\hearth', title: 'drop-d', open: false, category: cat.id });
    expect(idsIn(key)[0]).toBe(d!.id);
  });

  it('puts the old layout back (and says so) when the core refuses a move', async () => {
    const s = await createSession({ cwd: 'E:\\programming projects\\hearth', open: false });
    const before = useSessions.getState().sessions[s!.id];
    useToasts.setState({ toasts: [] });
    expect(await placeSession(s!.id, { patch: { category: 'no-such-category' }, order: null })).toBe(false);
    expect(useSessions.getState().sessions[s!.id]).toEqual(before);
    expect(useToasts.getState().toasts.some((t: { title: string }) => t.title === 'Could not move the session')).toBe(true);
  });

  it('puts the old preferences back when saving them fails', async () => {
    const before = currentSidebarPrefs();
    const original = rpc.request.bind(rpc);
    (rpc as { request: unknown }).request = async (method: string, params: unknown, opts?: unknown) => {
      if (method === 'settings.update') throw new Error('disk full');
      return original(method as never, params as never, opts as never);
    };
    try {
      expect(await updateSidebarPrefs({ collapsed: ['pinned'] })).toBe(false);
    } finally {
      (rpc as { request: unknown }).request = original;
    }
    expect(currentSidebarPrefs()).toEqual(before);
    expect(useSettings.getState().settings?.ui.sidebar).toEqual(before);
  });

  it('deleting a category keeps its sessions (back in their folders), or deletes them with it', async () => {
    const k = await createCategory({ name: 'Temp' });
    const id = k!.slice(2);
    const keep = await createSession({ cwd: 'E:\\programming projects\\hearth', title: 'keep-me', open: false, category: id });
    expect(idsIn(k!)).toEqual([keep!.id]);
    expect(await deleteCategory(id, false)).toBe(true);
    expect((await coreSidebar()).categories.some((c) => c.id === id)).toBe(false);
    expect(currentGroupKeys()).not.toContain(k);
    expect((await coreSession(keep!.id))?.category).toBeUndefined();
    expect(idsIn(KH)).toContain(keep!.id);

    const k2 = await createCategory({ name: 'Doomed' });
    const id2 = k2!.slice(2);
    const gone = await createSession({ cwd: 'E:\\programming projects\\hearth', title: 'goes-too', open: false, category: id2 });
    expect(await deleteCategory(id2, true)).toBe(true);
    expect(await coreSession(gone!.id)).toBeUndefined();
    await waitFor(() => !useSessions.getState().sessions[gone!.id]);
    // the folder group's other sessions are untouched
    expect(idsIn(KH)).toContain(keep!.id);
  });
});
