// UI store: routing, layout toggles, palette. Owner: ui-foundation.
// Layout preferences persist to localStorage (best-effort).
import { create } from 'zustand';

export type Route = 'session' | 'gpu' | 'models' | 'activity' | 'schedules' | 'settings';
export type RightPanelTab = 'changes' | 'todos' | 'agents' | 'files';

export interface UiStore {
  route: Route;
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  rightPanelWidth: number;
  /** Widths the user dragged (sidebar, view splits); absent = the panel's default. */
  panelSizes: Partial<Record<PanelId, number>>;
  paletteOpen: boolean;
  /** Optional initial page for the palette ('models' opens the model switcher directly). */
  palettePage: 'root' | 'models' | 'sessions';
  /** Sidebar search text. */
  sidebarQuery: string;
  /** Settings section to focus when opening Settings (ui-views reads it). */
  settingsSection: string | null;
  /** Keyboard shortcuts reference dialog. */
  shortcutsOpen: boolean;
  /** The "New category" dialog: open while set (afterKey = the group it goes under, sessionId = a session to put in it). */
  newCategory: { afterKey?: string; sessionId?: string } | null;
  /** Ask the chat header to start editing this session's title (menu strip / palette "Rename"). */
  renameRequest: { sessionId: string; at: number } | null;
}

const STORAGE_KEY = 'obsidian-code.ui.v1';

type Persisted = Pick<UiStore, 'sidebarCollapsed' | 'rightPanelOpen' | 'rightPanelTab' | 'rightPanelWidth' | 'panelSizes'>;

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
    p.panelSizes = sanitizePanelSizes(p.panelSizes);
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
/** Default width of the left sidebar (it is resizable: PANEL_LIMITS.sidebar) and of the collapsed rail (--ob-rail-w). */
export const SIDEBAR_W = 240;
export const RAIL_W = 52;

// ───────────────────────────── Resizable panels ─────────────────────────────

/** Every other panel with a draggable edge (the right panel keeps its own rightPanelWidth). */
export type PanelId = 'sidebar' | 'settingsNav' | 'gpuAside' | 'modelsList' | 'homeAside';

export const PANEL_LIMITS: Record<PanelId, { min: number; max: number; default: number }> = {
  sidebar: { min: 200, max: 420, default: SIDEBAR_W },
  settingsNav: { min: 160, max: 360, default: 216 },
  gpuAside: { min: 240, max: 480, default: 298 },
  modelsList: { min: 320, max: 640, default: 420 },
  homeAside: { min: 220, max: 440, default: 288 },
};

/** A saved/dragged size within the panel's limits (junk → default). */
export function clampPanelSize(id: PanelId, v: unknown): number {
  const l = PANEL_LIMITS[id];
  const n = typeof v === 'number' && Number.isFinite(v) ? v : l.default;
  return Math.round(Math.max(l.min, Math.min(l.max, n)));
}

/** Saved sizes from storage: known ids only, each clamped. */
export function sanitizePanelSizes(raw: unknown): Partial<Record<PanelId, number>> {
  const out: Partial<Record<PanelId, number>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of Object.keys(PANEL_LIMITS) as PanelId[]) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === 'number' && Number.isFinite(v)) out[id] = clampPanelSize(id, v);
  }
  return out;
}

/** The sidebar width actually used: the saved one, but never more than a third of a small window. */
export function effectiveSidebarWidth(saved: number, viewportWidth: number): number {
  const l = PANEL_LIMITS.sidebar;
  return Math.max(l.min, Math.min(clampPanelSize('sidebar', saved), Math.floor(viewportWidth / 3)));
}

/** A panel's current size (default until dragged) and its setter (undefined = back to the default). */
export function usePanelSize(id: PanelId): [number, (v: number | undefined) => void] {
  const size = useUi((s) => s.panelSizes[id]);
  const set = (v: number | undefined) =>
    useUi.setState((s) => {
      const next = { ...s.panelSizes };
      if (v === undefined) delete next[id];
      else next[id] = clampPanelSize(id, v);
      return { panelSizes: next };
    });
  return [size ?? PANEL_LIMITS[id].default, set];
}

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
  panelSizes: {},
  paletteOpen: false,
  palettePage: 'root',
  sidebarQuery: '',
  settingsSection: null,
  shortcutsOpen: false,
  newCategory: null,
  renameRequest: null,
  ...loadPersisted(),
}));

useUi.subscribe((s, prev) => {
  if (
    s.sidebarCollapsed === prev.sidebarCollapsed &&
    s.rightPanelOpen === prev.rightPanelOpen &&
    s.rightPanelTab === prev.rightPanelTab &&
    s.rightPanelWidth === prev.rightPanelWidth &&
    s.panelSizes === prev.panelSizes
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
      panelSizes: s.panelSizes,
    };
    ls.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
});

export const ROUTE_TITLES: Record<Route, string> = {
  session: 'Sessions',
  gpu: 'GPU',
  models: 'Models',
  activity: 'Activity',
  schedules: 'Scheduled',
  settings: 'Settings',
};
