// Right panel container: tabs Changes / Todos / Agents / Files (contents from features/chat/panels.tsx). Owner: ui-foundation.
import { X } from 'lucide-react';
import { useCallback, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { AgentsPanel, ChangesPanel, FilesPanel, TodosPanel } from '@renderer/features/chat/panels';
import { IconButton } from '@renderer/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { toggleRightPanel } from '@renderer/state/actions';
import { useSubagents, useTranscript } from '@renderer/state/selectors';
import { clampPanelWidth, effectivePanelWidth, RAIL_W, RIGHT_PANEL_DEFAULT_W, RIGHT_PANEL_MAX_W, SIDEBAR_W, useUi, type RightPanelTab } from '@renderer/state/ui';
import { ErrorBoundary } from './ErrorBoundary';
import { SHORTCUTS } from './shortcuts';

/** Window width, live. */
function useViewportWidth(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    () => window.innerWidth,
  );
}

function ResizeHandle({ width, max }: { width: number; max: number }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      start.current = { x: e.clientX, w: width };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!start.current) return;
      // Never wider than the window allows (the chat column keeps MAIN_MIN_W).
      const w = Math.min(max, clampPanelWidth(start.current.w + (start.current.x - e.clientX)));
      useUi.setState({ rightPanelWidth: Math.round(w) });
    },
    [max],
  );
  const onPointerUp = useCallback(() => {
    start.current = null;
  }, []);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => useUi.setState({ rightPanelWidth: RIGHT_PANEL_DEFAULT_W })}
      className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-ob-accent/50" />
    </div>
  );
}

export function RightPanel({ sessionId }: { sessionId: string }) {
  const tab = useUi((s) => s.rightPanelTab);
  const saved = useUi((s) => s.rightPanelWidth);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);
  const viewport = useViewportWidth();
  const sidebarW = sidebarCollapsed ? RAIL_W : SIDEBAR_W;
  const width = effectivePanelWidth(saved, viewport, sidebarW);
  const maxW = effectivePanelWidth(RIGHT_PANEL_MAX_W, viewport, sidebarW);
  const entry = useTranscript(sessionId);
  const subagents = useSubagents(sessionId);
  const changes = entry?.session.changedFiles.length ?? 0;
  const todosOpen = entry?.session.todos.filter((t) => t.status !== 'completed').length ?? 0;
  const runningAgents = subagents.filter((s) => s.status === 'running').length;

  return (
    <aside
      data-testid="right-panel"
      aria-label="Session panel"
      className="relative flex h-full shrink-0 flex-col border-l border-ob-border bg-ob-surface-1 animate-ob-fade-in"
      style={{ width }}
    >
      <ResizeHandle width={width} max={maxW} />
      <Tabs value={tab} onValueChange={(v) => useUi.setState({ rightPanelTab: v as RightPanelTab })} className="h-full">
        <div className="flex items-stretch border-b border-ob-border pr-1.5">
          <TabsList className="flex-1 border-b-0">
            <TabsTrigger value="changes" count={changes || undefined}>
              Changes
            </TabsTrigger>
            <TabsTrigger value="todos" count={todosOpen || undefined}>
              Todos
            </TabsTrigger>
            <TabsTrigger value="agents" count={runningAgents || subagents.length || undefined}>
              Agents
            </TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <div className="flex items-center">
            <IconButton label="Close panel" shortcut={SHORTCUTS.rightPanel} icon={X} size="sm" onClick={() => toggleRightPanel(false)} />
          </div>
        </div>
        <ErrorBoundary area="Side panel" resetKey={`${sessionId}:${tab}`}>
          <TabsContent value="changes" className="overflow-auto">
            <ChangesPanel sessionId={sessionId} />
          </TabsContent>
          <TabsContent value="todos" className="overflow-auto">
            <TodosPanel sessionId={sessionId} />
          </TabsContent>
          <TabsContent value="agents" className="overflow-auto">
            <AgentsPanel sessionId={sessionId} />
          </TabsContent>
          <TabsContent value="files" className="overflow-auto">
            <FilesPanel sessionId={sessionId} />
          </TabsContent>
        </ErrorBoundary>
      </Tabs>
    </aside>
  );
}
