// Sidebar groups as pure functions: grouping, order, categories, and where a drag-and-drop / "Move up" puts things.
import { describe, expect, it } from 'vitest';
import { defaultSidebarPrefs, folderGroupKey, PINNED_GROUP } from '@shared/sidebar';
import type { SessionSummary, SidebarPrefs } from '@shared/types';
import {
  applyPlacement,
  bySidebarOrder,
  canDropInto,
  dropKey,
  groupKeys,
  groupSessions,
  insertionIndex,
  insertKey,
  pinnedGroup,
  planDrop,
  planStep,
  stepAvailability,
  stepKey,
} from '@renderer/state/sidebar-model';

function s(id: string, cwd: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    cwd,
    kind: 'chat',
    createdAt: 0,
    updatedAt,
    status: 'idle',
    model: null,
    permissionMode: 'default',
    thinking: true,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    ...extra,
  };
}

const prefs = (over: Partial<SidebarPrefs> = {}): SidebarPrefs => ({ ...defaultSidebarPrefs(), ...over });
const ids = (list: SessionSummary[]): string[] => list.map((x) => x.id);
const X = 'E:\\proj\\x';
const Y = 'E:\\proj\\y';
const KX = folderGroupKey(X);
const KY = folderGroupKey(Y);
const RESEARCH = { id: 'k1', name: 'Research', createdAt: 5 };
const IDEAS = { id: 'k2', name: 'Ideas', createdAt: 6 };

describe('groupSessions: folder groups', () => {
  it('keys a folder case-insensitively, without a trailing slash, "/" = "\\"', () => {
    expect(folderGroupKey('E:\\Proj\\X\\')).toBe(KX);
    expect(folderGroupKey('e:/proj/x')).toBe(KX);
    expect(folderGroupKey(Y)).not.toBe(KX);
  });

  it('lists Pinned apart and groups by folder, newest activity first', () => {
    const m = groupSessions([s('a', X, 10), s('b', Y, 30), s('c', X, 20), s('d', Y, 5, { pinned: true }), s('e', X, 99, { kind: 'subagent' })]);
    expect(ids(m.pinned)).toEqual(['d']);
    expect(groupKeys(m)).toEqual([KY, KX]);
    expect(ids(m.groups[1].sessions)).toEqual(['c', 'a']);
    expect(m.groups.map((g) => g.kind)).toEqual(['folder', 'folder']);
    expect(m.total).toBe(4);
  });

  it('shows the user\'s name for a group, else the folder name', () => {
    const m = groupSessions([s('a', X, 1), s('b', Y, 2)], '', prefs({ groupNames: { [KX]: 'Backend' } }));
    expect(m.groups.map((g) => [g.name, g.renamed])).toEqual([
      ['y', false],
      ['Backend', true],
    ]);
  });
});

describe('groupSessions: categories', () => {
  it('a category holds sessions from any folder; the folder groups keep the rest', () => {
    const m = groupSessions([s('a', X, 10, { category: 'k1' }), s('b', Y, 20, { category: 'k1' }), s('c', X, 30)], '', prefs({ categories: [RESEARCH] }));
    const cat = m.groups.find((g) => g.kind === 'category');
    expect(cat).toMatchObject({ key: 'c:k1', name: 'Research', categoryId: 'k1', cwd: null });
    expect(ids(cat!.sessions)).toEqual(['b', 'a']);
    expect(ids(m.groups.find((g) => g.key === KX)!.sessions)).toEqual(['c']);
    expect(m.groups.find((g) => g.key === KY)).toBeUndefined();
  });

  it('lists an empty category (a drop target) unless a search is running', () => {
    const p = prefs({ categories: [RESEARCH] });
    expect(groupKeys(groupSessions([s('a', X, 1)], '', p))).toContain('c:k1');
    expect(groupKeys(groupSessions([s('a', X, 1)], 'a', p))).not.toContain('c:k1');
  });

  it('sends the sessions of a category that no longer exists back to their folder', () => {
    const m = groupSessions([s('a', X, 1, { category: 'gone' })], '', prefs({ categories: [RESEARCH] }));
    expect(ids(m.groups.find((g) => g.key === KX)!.sessions)).toEqual(['a']);
  });

  it('Pinned wins over a category', () => {
    const m = groupSessions([s('a', X, 1, { category: 'k1', pinned: true })], '', prefs({ categories: [RESEARCH] }));
    expect(ids(m.pinned)).toEqual(['a']);
    expect(m.groups.find((g) => g.key === 'c:k1')!.sessions).toEqual([]);
  });

  it('a new category (never placed) goes on top, then the groups by activity', () => {
    const m = groupSessions([s('a', X, 100), s('b', Y, 50)], '', prefs({ categories: [RESEARCH] }));
    // Research was made at 5: older than the activity in both folders, so it follows them
    expect(groupKeys(m)).toEqual([KX, KY, 'c:k1']);
    const fresh = groupSessions([s('a', X, 1)], '', prefs({ categories: [{ ...RESEARCH, createdAt: 99 }] }));
    expect(groupKeys(fresh)).toEqual(['c:k1', KX]);
  });
});

describe('groupSessions: order', () => {
  it('follows groupOrder; groups it does not list come first, newest first; stale keys are ignored', () => {
    const list = [s('a', X, 10), s('b', Y, 20)];
    expect(groupKeys(groupSessions(list, '', prefs({ groupOrder: [KX, KY] })))).toEqual([KX, KY]);
    expect(groupKeys(groupSessions(list, '', prefs({ groupOrder: [KY, KX] })))).toEqual([KY, KX]);
    expect(groupKeys(groupSessions(list, '', prefs({ groupOrder: ['f:e:\\nowhere', KX] })))).toEqual([KY, KX]);
    const withThird = [...list, s('c', 'E:\\proj\\z', 5)];
    expect(groupKeys(groupSessions(withThird, '', prefs({ groupOrder: [KX, KY] }))).slice(0, 1)).toEqual([folderGroupKey('E:\\proj\\z')]);
  });

  it('sessions placed by hand keep their order; the others sit above them, newest first', () => {
    const list = [s('a', X, 10, { order: 2 }), s('b', X, 50, { order: 1 }), s('c', X, 5), s('d', X, 40), s('e', X, 60, { order: 2 })];
    // unordered: d (40), c (5); then by order: b (1), a (2) vs e (2): the newer first
    expect(ids(groupSessions(list).groups[0].sessions)).toEqual(['d', 'c', 'b', 'e', 'a']);
    expect(list.slice().sort(bySidebarOrder).map((x) => x.id)).toEqual(['d', 'c', 'b', 'e', 'a']);
  });

  it('a search keeps the groups where they are and lists only groups with a hit', () => {
    const list = [s('alpha', X, 10), s('beta', Y, 20), s('gamma', X, 30)];
    const p = prefs({ groupOrder: [KX, KY] });
    expect(groupKeys(groupSessions(list, '', p))).toEqual([KX, KY]);
    const hit = groupSessions(list, 'beta', p);
    expect(groupKeys(hit)).toEqual([KY]);
    expect(hit.total).toBe(1);
    expect(groupSessions(list, 'zzz', p).total).toBe(0);
  });

  it('a search also matches the name of the group', () => {
    const list = [s('alpha', X, 10), s('beta', Y, 20)];
    const m = groupSessions(list, 'backend', prefs({ groupNames: { [KX]: 'Backend' } }));
    expect(groupKeys(m)).toEqual([KX]);
    expect(ids(m.groups[0].sessions)).toEqual(['alpha']);
  });
});

describe('moving groups', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('stepKey moves one place and stops at the ends', () => {
    expect(stepKey(order, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(stepKey(order, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(stepKey(order, 'a', -1)).toBe(order);
    expect(stepKey(order, 'd', 1)).toBe(order);
    expect(stepKey(order, 'zz', 1)).toBe(order);
  });

  it('dropKey puts the dragged group in the place of the one it is dropped on', () => {
    expect(dropKey(order, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(dropKey(order, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(dropKey(order, 'b', 'b')).toBe(order);
    expect(dropKey(order, 'b', 'zz')).toBe(order);
  });

  it('insertKey places a new key under another (on top without one)', () => {
    expect(insertKey(order, 'n', 'b')).toEqual(['a', 'b', 'n', 'c', 'd']);
    expect(insertKey(order, 'n')).toEqual(['n', 'a', 'b', 'c', 'd']);
    expect(insertKey(order, 'n', 'gone')).toEqual(['n', 'a', 'b', 'c', 'd']);
    expect(insertKey(order, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('moving sessions', () => {
  // Group x: a, b, d in that order (all placed by hand); y: c; Research (k1): e; one pinned: p (folder x).
  const list = [
    s('a', X, 10, { order: 1 }),
    s('b', X, 20, { order: 2 }),
    s('d', X, 30, { order: 3 }),
    s('c', Y, 40),
    s('e', Y, 50, { category: 'k1', order: 1 }),
    s('p', X, 60, { pinned: true }),
    s('f', X, 70, { category: 'k1', order: 2 }),
  ];
  const model = groupSessions(list, '', prefs({ categories: [RESEARCH, IDEAS] }));

  it('a session only drops into Pinned, a category, or its own folder group', () => {
    const gx = model.groups.find((g) => g.key === KX)!;
    const gy = model.groups.find((g) => g.key === KY)!;
    const cat = model.groups.find((g) => g.key === 'c:k1')!;
    expect(canDropInto(gx, { cwd: X })).toBe(true);
    expect(canDropInto(gy, { cwd: X })).toBe(false);
    expect(canDropInto(cat, { cwd: X })).toBe(true);
    expect(canDropInto(pinnedGroup(model)!, { cwd: X })).toBe(true);
  });

  it('reorders inside a group', () => {
    expect(planDrop(model, 'd', { groupKey: KX, index: 0 })).toEqual({ patch: {}, order: ['d', 'a', 'b'] });
    expect(planDrop(model, 'a', { groupKey: KX, index: 1 })).toEqual({ patch: {}, order: ['b', 'a', 'd'] });
    expect(planDrop(model, 'a', { groupKey: KX, index: 99 })).toEqual({ patch: {}, order: ['b', 'd', 'a'] });
    expect(planDrop(model, 'a', { groupKey: KX, index: 0 })).toBeNull(); // already there
  });

  it('moves into a category (the category follows, the group is renumbered)', () => {
    expect(planDrop(model, 'a', { groupKey: 'c:k1', index: 1 })).toEqual({ patch: { category: 'k1' }, order: ['e', 'a', 'f'] });
    expect(planDrop(model, 'a', { groupKey: 'c:k2', index: 0 })).toEqual({ patch: { category: 'k2' }, order: null }); // empty category
  });

  it('moves out of a category back to its own folder group, never into another folder', () => {
    expect(planDrop(model, 'f', { groupKey: KX, index: 0 })).toEqual({ patch: { category: null }, order: ['f', 'a', 'b', 'd'] });
    expect(planDrop(model, 'f', { groupKey: KY, index: 0 })).toBeNull();
    expect(planDrop(model, 'a', { groupKey: KY, index: 0 })).toBeNull();
  });

  it('pins and unpins by dropping on Pinned / a group', () => {
    expect(planDrop(model, 'a', { groupKey: PINNED_GROUP, index: 0 })).toEqual({ patch: { pinned: true }, order: ['a', 'p'] });
    expect(planDrop(model, 'p', { groupKey: 'c:k1', index: 0 })).toEqual({ patch: { pinned: false, category: 'k1' }, order: ['p', 'e', 'f'] });
    expect(planDrop(model, 'p', { groupKey: KX, index: 0 })).toEqual({ patch: { pinned: false }, order: ['p', 'a', 'b', 'd'] });
  });

  it('ignores unknown sessions and groups', () => {
    expect(planDrop(model, 'nope', { groupKey: KX, index: 0 })).toBeNull();
    expect(planDrop(model, 'a', { groupKey: 'c:none', index: 0 })).toBeNull();
  });

  it('Move up / Move down numbers the group with the session one place over', () => {
    expect(planStep(model, 'b', -1)).toEqual({ patch: {}, order: ['b', 'a', 'd'] });
    expect(planStep(model, 'b', 1)).toEqual({ patch: {}, order: ['a', 'd', 'b'] });
    expect(planStep(model, 'a', -1)).toBeNull();
    expect(planStep(model, 'd', 1)).toBeNull();
    expect(stepAvailability(model, 'a')).toEqual({ up: false, down: true });
    expect(stepAvailability(model, 'd')).toEqual({ up: true, down: false });
    expect(stepAvailability(model, 'e')).toEqual({ up: false, down: true });
    expect(stepAvailability(model, 'nope')).toEqual({ up: false, down: false });
  });

  it('insertionIndex counts without the moved session', () => {
    const g = model.groups.find((x) => x.key === KX)!.sessions; // a, b, d
    expect(insertionIndex(g, 'a', 'b', false)).toBe(0);
    expect(insertionIndex(g, 'a', 'b', true)).toBe(1);
    expect(insertionIndex(g, 'a', 'd', true)).toBe(2);
    expect(insertionIndex(g, 'x', 'a', false)).toBe(0);
    expect(insertionIndex(g, 'x', null, false)).toBe(0);
    expect(insertionIndex(g, 'x', 'gone', true)).toBe(3);
  });

  it('applyPlacement mirrors sessions.update: category / pinned set, order dropped when it moved', () => {
    const a = s('a', X, 1, { order: 3 });
    expect(applyPlacement(a, { category: 'k1' })).toMatchObject({ category: 'k1' });
    expect(applyPlacement(a, { category: 'k1' }).order).toBeUndefined();
    expect(applyPlacement({ ...a, category: 'k1' }, { category: null }).category).toBeUndefined();
    expect(applyPlacement(a, { pinned: true })).toMatchObject({ pinned: true });
    expect(applyPlacement(a, {}).order).toBe(3);
    expect(applyPlacement({ ...a, category: 'k1' }, { category: 'k1' }).order).toBe(3); // nothing moved
  });
});
