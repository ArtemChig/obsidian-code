// Sidebar groups as pure functions (unit-tested): which sessions sit in which group, in which order, and where a
// drag-and-drop or a "Move up" puts a session or a group. Owner: ui-foundation.
// A group is Pinned, a project folder (derived from the sessions' cwd) or a user-made category (Settings.ui.sidebar).
import {
  categoryGroupKey,
  defaultSidebarPrefs,
  folderGroupKey,
  PINNED_GROUP,
} from '@shared/sidebar';
import type { SessionSummary, SidebarPrefs } from '@shared/types';
import { basename } from '../lib/format';

export interface SessionGroup {
  /** PINNED_GROUP, "f:<folder>" or "c:<category id>" (see @shared/sidebar). */
  key: string;
  kind: 'pinned' | 'folder' | 'category';
  /** Folder groups: the folder of its sessions. */
  cwd: string | null;
  /** Categories: the category id. */
  categoryId?: string;
  /** What the header shows: the user's name, else the folder name. */
  name: string;
  /** A folder group the user gave a name of their own. */
  renamed: boolean;
  /** The sessions in display order (filtered by the search query). */
  sessions: SessionSummary[];
  /** Newest activity of ALL its sessions (the search query does not move groups around). Empty category: when it was made. */
  updatedAt: number;
}

export interface SidebarModel {
  pinned: SessionSummary[];
  groups: SessionGroup[];
  /** Sessions shown (after the query). */
  total: number;
}

/** Sessions placed by hand keep their order; the ones that are not (new, moved or unpinned) sit above them, newest first. */
export function bySidebarOrder(a: SessionSummary, b: SessionSummary): number {
  const ap = typeof a.order === 'number';
  const bp = typeof b.order === 'number';
  if (ap !== bp) return ap ? 1 : -1;
  if (ap && bp && a.order !== b.order) return (a.order as number) - (b.order as number);
  return b.updatedAt - a.updatedAt;
}

/** Pure: top-level sessions grouped into Pinned + categories + project folders, in the user's order, filtered by query. */
export function groupSessions(all: Record<string, SessionSummary> | SessionSummary[], query = '', prefs: SidebarPrefs = defaultSidebarPrefs()): SidebarModel {
  const list = (Array.isArray(all) ? all : Object.values(all)).filter((s) => s.kind !== 'subagent');
  const q = query.trim().toLowerCase();
  const matches = (s: SessionSummary, groupName = ''): boolean =>
    !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || groupName.toLowerCase().includes(q);

  const categories = new Set(prefs.categories.map((c) => c.id));
  const groups = new Map<string, SessionGroup>();
  for (const c of prefs.categories) {
    const key = categoryGroupKey(c.id);
    groups.set(key, { key, kind: 'category', cwd: null, categoryId: c.id, name: c.name, renamed: false, sessions: [], updatedAt: c.createdAt });
  }

  const pinnedAll: SessionSummary[] = [];
  const members = new Map<string, SessionSummary[]>();
  // Newest first: a folder group is named (and linked) after its most recent session's spelling of the folder.
  for (const s of list.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (s.pinned) {
      pinnedAll.push(s);
      continue;
    }
    // A category that no longer exists (deleted elsewhere) sends its sessions back to their folder.
    const key = s.category && categories.has(s.category) ? categoryGroupKey(s.category) : folderGroupKey(s.cwd);
    let g = groups.get(key);
    if (!g) {
      const custom = prefs.groupNames[key];
      g = { key, kind: 'folder', cwd: s.cwd, name: custom || basename(s.cwd) || s.cwd, renamed: !!custom, sessions: [], updatedAt: 0 };
      groups.set(key, g);
    }
    let m = members.get(key);
    if (!m) members.set(key, (m = []));
    m.push(s);
    g.updatedAt = Math.max(g.updatedAt, s.updatedAt);
  }

  let total = 0;
  const shown: SessionGroup[] = [];
  for (const g of groups.values()) {
    const sessions = (members.get(g.key) ?? []).filter((s) => matches(s, g.name)).sort(bySidebarOrder);
    // While searching, only groups with a hit are listed; otherwise every category is (an empty one is a drop target).
    if (q && !sessions.length) continue;
    total += sessions.length;
    shown.push({ ...g, sessions });
  }
  const pinned = pinnedAll.filter((s) => matches(s)).sort(bySidebarOrder);
  total += pinned.length;

  const rank = new Map(prefs.groupOrder.map((k, i) => [k, i] as const));
  const fresh = shown.filter((g) => !rank.has(g.key)).sort((a, b) => b.updatedAt - a.updatedAt);
  const placed = shown.filter((g) => rank.has(g.key)).sort((a, b) => (rank.get(a.key) as number) - (rank.get(b.key) as number));
  return { pinned, groups: [...fresh, ...placed], total };
}

/** Pinned as a group of its own (null when nothing is pinned). */
export function pinnedGroup(model: SidebarModel): SessionGroup | null {
  return model.pinned.length
    ? { key: PINNED_GROUP, kind: 'pinned', cwd: null, name: 'Pinned', renamed: false, sessions: model.pinned, updatedAt: 0 }
    : null;
}

/** Keys of the groups in display order: what Settings.ui.sidebar.groupOrder stores once the user moves one. */
export const groupKeys = (model: SidebarModel): string[] => model.groups.map((g) => g.key);

// ───────────────────────────── Groups ─────────────────────────────

/** `key` one place up or down (unchanged at the ends or when it is not in the list). */
export function stepKey(order: string[], key: string, delta: -1 | 1): string[] {
  const i = order.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = order.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Drag `dragKey` onto `overKey`: it takes that group's place (the others shift). */
export function dropKey(order: string[], dragKey: string, overKey: string): string[] {
  const from = order.indexOf(dragKey);
  const to = order.indexOf(overKey);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, dragKey);
  return next;
}

/** `order` with a new key placed right after `afterKey` (at the top without one). */
export function insertKey(order: string[], key: string, afterKey?: string): string[] {
  const rest = order.filter((k) => k !== key);
  const i = afterKey ? rest.indexOf(afterKey) : -1;
  rest.splice(i + 1, 0, key);
  return rest;
}

// ───────────────────────────── Sessions ─────────────────────────────

/** Where a moved session goes: the changes to its record (sessions.update) and, when it joins a group of several, that group's order. */
export interface SessionPlacement {
  patch: { category?: string | null; pinned?: boolean };
  /** The target group's session ids in their new order (sessions.reorder); null = nothing to number. */
  order: string[] | null;
}

/** The session record after `patch` (what sessions.update does in the core): category / pinned set, its order dropped when it moved. */
export function applyPlacement(s: SessionSummary, patch: SessionPlacement['patch']): SessionSummary {
  const next = { ...s };
  const moved = (patch.category !== undefined && (patch.category ?? undefined) !== s.category) || (patch.pinned !== undefined && patch.pinned !== !!s.pinned);
  if (patch.category === null) delete next.category;
  else if (patch.category !== undefined) next.category = patch.category;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (moved) delete next.order;
  return next;
}

/** A session never changes folder, so it can only be dropped into Pinned, a category, or its own folder group. */
export function canDropInto(group: Pick<SessionGroup, 'kind' | 'key'>, moving: Pick<SessionSummary, 'cwd'>): boolean {
  return group.kind !== 'folder' || group.key === folderGroupKey(moving.cwd);
}

/** Index to insert at in a group's list once `movingId` is taken out: before or after the row `overId`. */
export function insertionIndex(list: SessionSummary[], movingId: string, overId: string | null, after: boolean): number {
  const rest = list.filter((s) => s.id !== movingId);
  const i = overId ? rest.findIndex((s) => s.id === overId) : -1;
  return i < 0 ? (overId ? rest.length : 0) : i + (after ? 1 : 0);
}

function findSession(model: SidebarModel, id: string): { session: SessionSummary; group: SessionGroup } | null {
  const pinned = pinnedGroup(model);
  for (const g of pinned ? [pinned, ...model.groups] : model.groups) {
    const session = g.sessions.find((s) => s.id === id);
    if (session) return { session, group: g };
  }
  return null;
}

/**
 * Pure: put session `id` into `target` at `index` (counted without the session itself). `model` must be unfiltered.
 * Null = not allowed or nothing would change.
 */
export function planDrop(model: SidebarModel, id: string, target: { groupKey: string; index: number }): SessionPlacement | null {
  const found = findSession(model, id);
  const group = target.groupKey === PINNED_GROUP ? pinnedGroup(model) : model.groups.find((g) => g.key === target.groupKey);
  if (!found || !group || !canDropInto(group, found.session)) return null;
  const { session, group: from } = found;

  const patch: SessionPlacement['patch'] = {};
  if (group.kind === 'pinned') {
    if (from.kind !== 'pinned') patch.pinned = true;
  } else {
    if (from.kind === 'pinned') patch.pinned = false;
    if (from.key !== group.key) {
      // The category follows the target group (a folder group = no category).
      const category = group.kind === 'category' ? (group.categoryId as string) : null;
      if ((session.category ?? null) !== category) patch.category = category;
    }
  }
  const rest = group.sessions.filter((s) => s.id !== id).map((s) => s.id);
  const index = Math.max(0, Math.min(target.index, rest.length));
  const ids = rest.slice();
  ids.splice(index, 0, id);
  const before = group.sessions.map((s) => s.id);
  const sameOrder = from.key === group.key && ids.length === before.length && ids.every((x, i) => x === before[i]);
  const moved = Object.keys(patch).length > 0;
  if (!moved && sameOrder) return null;
  return { patch, order: ids.length > 1 ? ids : null };
}

/** Pure: "Move up" / "Move down" for a session inside its group. Null at the ends. */
export function planStep(model: SidebarModel, id: string, delta: -1 | 1): SessionPlacement | null {
  const found = findSession(model, id);
  if (!found) return null;
  const ids = found.group.sessions.map((s) => s.id);
  const next = stepKey(ids, id, delta);
  return next === ids ? null : { patch: {}, order: next };
}

/** Pure: can the session move one place up / down in its group? */
export function stepAvailability(model: SidebarModel, id: string): { up: boolean; down: boolean } {
  const found = findSession(model, id);
  if (!found) return { up: false, down: false };
  const i = found.group.sessions.findIndex((s) => s.id === id);
  return { up: i > 0, down: i >= 0 && i < found.group.sessions.length - 1 };
}
