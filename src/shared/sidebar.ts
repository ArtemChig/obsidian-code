// Sidebar groups, shared by the core (validates Settings.ui.sidebar and the category of a session) and the renderer
// (builds the groups). A group is addressed by a key: "pinned", "f:<folder>" or "c:<category id>".

import type { SidebarCategory, SidebarPrefs } from './types';

export const PINNED_GROUP = 'pinned';
const FOLDER_PREFIX = 'f:';
const CATEGORY_PREFIX = 'c:';

export const MAX_CATEGORIES = 100;
export const MAX_NAME_LENGTH = 60;
const MAX_GROUP_NAMES = 500;
const MAX_KEYS = 1000;
const MAX_KEY_LENGTH = 600;
const CATEGORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultSidebarPrefs(): SidebarPrefs {
  return { groupOrder: [], groupNames: {}, categories: [], collapsed: [] };
}

/** Key of a folder's group: case-insensitive, no trailing separator, "/" = "\" (the same folder typed two ways is one group). */
export function folderGroupKey(cwd: string): string {
  return FOLDER_PREFIX + String(cwd ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export const categoryGroupKey = (id: string): string => CATEGORY_PREFIX + id;
export const isCategoryKey = (key: string): boolean => key.startsWith(CATEGORY_PREFIX);
export const isFolderKey = (key: string): boolean => key.startsWith(FOLDER_PREFIX);
export const categoryIdOf = (key: string): string => (isCategoryKey(key) ? key.slice(CATEGORY_PREFIX.length) : '');

export function isCategoryId(id: unknown): id is string {
  return typeof id === 'string' && CATEGORY_ID.test(id);
}

/** A display name: trimmed, one line, at most MAX_NAME_LENGTH characters. '' when nothing is left. */
export function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim() : '';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function keyList(v: unknown, keep: (key: string) => boolean): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of v) {
    if (typeof k !== 'string' || k.length > MAX_KEY_LENGTH || seen.has(k) || !keep(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

/**
 * Pure: a Settings.ui.sidebar value read from disk or sent by a client, made safe. Junk (wrong types, bad ids,
 * duplicates, keys of categories that do not exist) is dropped; missing fields get their defaults.
 */
export function normalizeSidebarPrefs(raw: unknown): SidebarPrefs {
  const src = isObject(raw) ? raw : {};
  const categories: SidebarCategory[] = [];
  const ids = new Set<string>();
  if (Array.isArray(src.categories)) {
    for (const c of src.categories) {
      if (!isObject(c) || !isCategoryId(c.id) || ids.has(c.id)) continue;
      const name = cleanName(c.name);
      if (!name) continue;
      ids.add(c.id);
      categories.push({ id: c.id, name, createdAt: typeof c.createdAt === 'number' && Number.isFinite(c.createdAt) ? c.createdAt : 0 });
      if (categories.length >= MAX_CATEGORIES) break;
    }
  }
  const known = (key: string): boolean => (isCategoryKey(key) ? ids.has(categoryIdOf(key)) : isFolderKey(key));
  const groupNames: Record<string, string> = {};
  if (isObject(src.groupNames)) {
    for (const [k, v] of Object.entries(src.groupNames)) {
      const name = cleanName(v);
      if (!isFolderKey(k) || k.length > MAX_KEY_LENGTH || !name) continue;
      groupNames[k] = name;
      if (Object.keys(groupNames).length >= MAX_GROUP_NAMES) break;
    }
  }
  return {
    groupOrder: keyList(src.groupOrder, known),
    groupNames,
    categories,
    collapsed: keyList(src.collapsed, (k) => k === PINNED_GROUP || known(k)),
  };
}
