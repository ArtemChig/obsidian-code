// Root component: providers, shell, palette, toasts, global shortcuts. Owner: ui-foundation.
import { useEffect } from 'react';
import { Toaster } from '@renderer/components/ui/toast';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { GpuClockOutConfirm } from '@renderer/features/gpu/ClockOutConfirm';
import { SetupWizard } from '@renderer/features/setup/SetupWizard';
import { markRead } from '@renderer/state/actions';
import { useSessions } from '@renderer/state/sessions';
import { useUi } from '@renderer/state/ui';
import { AppShell } from './AppShell';
import { boot } from './boot';
import { CommandPalette } from './CommandPalette';
import { Gallery } from './Gallery';
import { useGlobalShortcuts } from './shortcuts';
import { NewCategoryDialog } from './SidebarGroups';
import { ShortcutsDialog } from './ShortcutsDialog';

const SHOW_GALLERY = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('gallery');

export function App() {
  useGlobalShortcuts();
  useEffect(() => {
    void boot();
    // A session that finished while the window was in the background is "unread" until the user looks at it.
    const onFocus = () => {
      const id = useSessions.getState().activeSessionId;
      if (id && useUi.getState().route === 'session') markRead(id);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return (
    <TooltipProvider>
      {SHOW_GALLERY ? <Gallery /> : <AppShell />}
      <CommandPalette />
      <GpuClockOutConfirm />
      <ShortcutsDialog />
      <SetupWizard />
      <NewCategoryDialog />
      <Toaster />
    </TooltipProvider>
  );
}
