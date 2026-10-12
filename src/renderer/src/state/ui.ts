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
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    return {};
  }
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
