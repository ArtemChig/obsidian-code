// Sidebar layout state: the saved preferences (Settings.ui.sidebar) and a guard for saves in flight. Owner: ui-foundation.
// The layout is shown at once and saved in the core (state/actions.ts updateSidebarPrefs); the core's echo of an
// earlier save must not undo a later one that is still on its way.
import { useMemo } from 'react';
import { normalizeSidebarPrefs } from '@shared/sidebar';
import type { SidebarPrefs } from '@shared/types';
import { useSessions } from './sessions';
import { useSettings } from './settings';
import { groupKeys, groupSessions } from './sidebar-model';

export function useSidebarPrefs(): SidebarPrefs {
  const raw = useSettings((s) => s.settings?.ui?.sidebar);
  return useMemo(() => normalizeSidebarPrefs(raw), [raw]);
}

/** The layout now (outside React). */
export function currentSidebarPrefs(): SidebarPrefs {
  return normalizeSidebarPrefs(useSettings.getState().settings?.ui?.sidebar);
}

/** Display order of the groups right now, search or not (what groupOrder stores once the user moves one). */
export function currentGroupKeys(): string[] {
  return groupKeys(groupSessions(useSessions.getState().sessions, '', currentSidebarPrefs()));
}

let pendingSaves = 0;

/** A save started; call the result when it settled. */
export function beginSidebarSave(): () => void {
  pendingSaves++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pendingSaves--;
  };
}

export const sidebarSavePending = (): boolean => pendingSaves > 0;
