// UI store: routing, layout toggles, palette. Owner: ui-foundation.
// Layout preferences persist to localStorage (best-effort).
import { create } from 'zustand';

export type Route = 'session' | 'gpu' | 'activity' | 'schedules' | 'settings';
export type RightPanelTab = 'changes' | 'todos' | 'agents' | 'files';

export interface UiStore {
  route: Route;
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  rightPanelWidth: number;
  paletteOpen: boolean;
  /** Optional initial page for the palette ('models' opens the model switcher directly). */
  palettePage: 'root' | 'models' | 'sessions';
  /** Sidebar search text. */
  sidebarQuery: string;
  /** Settings section to focus when opening Settings (ui-views reads it). */
  settingsSection: string | null;
  /** Keyboard shortcuts reference dialog. */
  shortcutsOpen: boolean;
}

const STORAGE_KEY = 'obsidian-code.ui.v1';

type Persisted = Pick<UiStore, 'sidebarCollapsed' | 'rightPanelOpen' | 'rightPanelTab' | 'rightPanelWidth'>;

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** window.localStorage in the renderer; undefined elsewhere (unit tests). */
function storage(): KeyValueStorage | undefined {
  const w = (globalThis as { window?: { localStorage?: KeyValueStorage } }).window;
  try {
    return w?.localStorage;
  } catch {
    return undefined;
  }
}

function loadPersisted(): Partial<Persisted> {
  try {
    const ls = storage();
    if (!ls) return {};
    const raw = ls.getItem(STORAGE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    if (p.rightPanelWidth !== undefined) p.rightPanelWidth = clampPanelWidth(p.rightPanelWidth);
    return p;
  } catch {
    return {};
  }
}

// ───────────────────────────── Right panel width ─────────────────────────────

export const RIGHT_PANEL_MIN_W = 280;
export const RIGHT_PANEL_MAX_W = 640;
export const RIGHT_PANEL_DEFAULT_W = 340;
/** The chat column never gets narrower than this because of the side panel. */
export const MAIN_MIN_W = 420;
/** Width of the left sidebar (full / collapsed rail), matching --ob-sidebar-w / --ob-rail-w. */
export const SIDEBAR_W = 240;
export const RAIL_W = 52;

/** A saved/dragged width within the panel's own limits (junk → default). */
export function clampPanelWidth(w: unknown): number {
  const n = typeof w === 'number' && Number.isFinite(w) ? w : RIGHT_PANEL_DEFAULT_W;
  return Math.round(Math.max(RIGHT_PANEL_MIN_W, Math.min(RIGHT_PANEL_MAX_W, n)));
}

/**
 * The width actually used for the side panel in a window this wide: the saved width, but never so wide that the chat
 * column drops below MAIN_MIN_W (a width saved on a big monitor must not squeeze the chat on a laptop).
 */
export function effectivePanelWidth(saved: number, viewportWidth: number, sidebarWidth: number): number {
  const room = viewportWidth - sidebarWidth - MAIN_MIN_W;
  return Math.max(200, Math.min(clampPanelWidth(saved), room));
}

export const useUi = create<UiStore>(() => ({
  route: 'session',
  sidebarCollapsed: false,
  rightPanelOpen: false,
  rightPanelTab: 'changes',
  rightPanelWidth: 340,
  paletteOpen: false,
  palettePage: 'root',
  sidebarQuery: '',
  settingsSection: null,
  shortcutsOpen: false,
  ...loadPersisted(),
}));

useUi.subscribe((s, prev) => {
  if (
    s.sidebarCollapsed === prev.sidebarCollapsed &&
    s.rightPanelOpen === prev.rightPanelOpen &&
    s.rightPanelTab === prev.rightPanelTab &&
    s.rightPanelWidth === prev.rightPanelWidth
  )
    return;
  try {
    const ls = storage();
    if (!ls) return;
    const data: Persisted = {
      sidebarCollapsed: s.sidebarCollapsed,
      rightPanelOpen: s.rightPanelOpen,
      rightPanelTab: s.rightPanelTab,
      rightPanelWidth: s.rightPanelWidth,
    };
    ls.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
});

export const ROUTE_TITLES: Record<Route, string> = {
  session: 'Sessions',
  gpu: 'GPU',
  activity: 'Activity',
  schedules: 'Scheduled',
  settings: 'Settings',
};
