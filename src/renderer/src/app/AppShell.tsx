// App shell (M13): title bar, menu strip, [sidebar | routed main view | right panel], status bar. One #000 ground;
// regions are separated only by --rule hairlines. Owner: ui-foundation.
import { ActivityView } from '@renderer/features/activity/ActivityView';
import { ChatView } from '@renderer/features/chat/ChatView';
import { GpuView } from '@renderer/features/gpu/GpuView';
import { SchedulesView } from '@renderer/features/schedules/SchedulesView';
import { SettingsView } from '@renderer/features/settings/SettingsView';
import { useSessions } from '@renderer/state/sessions';
import { useUi } from '@renderer/state/ui';
import { ConnectionBanner } from './ConnectionBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { HomeView } from './HomeView';
import { MenuBar } from './MenuBar';
import { RightPanel } from './RightPanel';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';

function MainView() {
  const route = useUi((s) => s.route);
  const activeId = useSessions((s) => s.activeSessionId);
  switch (route) {
    case 'gpu':
      return (
        <ErrorBoundary area="GPU view" resetKey={route}>
          <GpuView />
        </ErrorBoundary>
      );
    case 'activity':
      return (
        <ErrorBoundary area="Activity view" resetKey={route}>
          <ActivityView />
        </ErrorBoundary>
      );
    case 'schedules':
      return (
        <ErrorBoundary area="Scheduled view" resetKey={route}>
          <SchedulesView />
        </ErrorBoundary>
      );
    case 'settings':
      return (
        <ErrorBoundary area="Settings" resetKey={route}>
          <SettingsView />
        </ErrorBoundary>
      );
    case 'session':
    default:
      return activeId ? (
        <ErrorBoundary area="Session" resetKey={activeId}>
          <ChatView key={activeId} sessionId={activeId} />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary area="Home" resetKey="home">
          <HomeView />
        </ErrorBoundary>
      );
  }
}

export function AppShell() {
  const route = useUi((s) => s.route);
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const activeId = useSessions((s) => s.activeSessionId);
  const showRight = route === 'session' && !!activeId && rightOpen;
  return (
    <div className="flex h-full flex-col bg-s0 text-t1" data-testid="app-shell">
      <TitleBar />
      <MenuBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className={showRight ? 'flex min-w-[min(420px,50vw)] flex-1 flex-col' : 'flex min-w-0 flex-1 flex-col'} aria-label="Main">
          <ConnectionBanner />
          <div className="min-h-0 flex-1">
            <MainView />
          </div>
        </main>
        {showRight && activeId ? <RightPanel sessionId={activeId} /> : null}
      </div>
      <StatusBar />
    </div>
  );
}
