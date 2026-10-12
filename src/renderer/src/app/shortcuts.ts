// Global keyboard shortcuts: Ctrl+N new session, Ctrl+K palette, Ctrl+B sidebar, Ctrl+\ right panel, Ctrl+, settings.
// Owner: ui-foundation.
import { useEffect } from 'react';
import { createSession, openSettings, toggleRightPanel, toggleSidebar } from '@renderer/state/actions';
import { useUi } from '@renderer/state/ui';

export const SHORTCUTS = {
  newSession: 'Ctrl+N',
  palette: 'Ctrl+K',
  sidebar: 'Ctrl+B',
  rightPanel: 'Ctrl+\\',
  settings: 'Ctrl+,',
} as const;

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k' && !e.shiftKey) {
        e.preventDefault();
        useUi.setState((s) => ({ paletteOpen: !s.paletteOpen, palettePage: 'root' }));
        return;
      }
      if (e.repeat) return;
      if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        void createSession();
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.code === 'Backslash' || key === '\\') {
        e.preventDefault();
        toggleRightPanel();
      } else if (key === ',') {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);
}
