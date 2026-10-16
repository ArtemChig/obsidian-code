// Right panel container: tabs Changes / Todos / Agents / Files (contents from features/chat/panels.tsx). Owner: ui-foundation.
// M13: no fill — the #000 ground with a --rule hairline on the left; underline tabs (reference .phd).
import { X } from 'lucide-react';
import { AgentsPanel, ChangesPanel, FilesPanel, TodosPanel } from '@renderer/features/chat/panels';
import { IconButton } from '@renderer/components/ui/button';
import { ResizeHandle, useViewportWidth } from '@renderer/components/ui/resize-handle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { toggleRightPanel } from '@renderer/state/actions';
import { useSubagents, useTranscript } from '@renderer/state/selectors';
import { effectivePanelWidth, effectiveSidebarWidth, RAIL_W, RIGHT_PANEL_DEFAULT_W, RIGHT_PANEL_MAX_W, RIGHT_PANEL_MIN_W, usePanelSize, useUi, type RightPanelTab } from '@renderer/state/ui';
import { ErrorBoundary } from './ErrorBoundary';
import { SHORTCUTS } from './shortcuts';

export function RightPanel({ sessionId }: { sessionId: string }) {
  const tab = useUi((s) => s.rightPanelTab);
  const saved = useUi((s) => s.rightPanelWidth);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);
  const viewport = useViewportWidth();
  const [sidebarSaved] = usePanelSize('sidebar');
  const sidebarW = sidebarCollapsed ? RAIL_W : effectiveSidebarWidth(sidebarSaved, viewport);
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
      className="relative flex h-full shrink-0 flex-col border-l border-rule bg-s0 animate-ob-fade-in"
      style={{ width }}
    >
      <ResizeHandle
        edge="left"
        value={width}
        min={Math.min(RIGHT_PANEL_MIN_W, maxW)}
        max={maxW}
        defaultValue={RIGHT_PANEL_DEFAULT_W}
        onChange={(w) => useUi.setState({ rightPanelWidth: w })}
        label="Resize side panel"
        testId="right-panel-resize"
      />
      <Tabs value={tab} onValueChange={(v) => useUi.setState({ rightPanelTab: v as RightPanelTab })} className="h-full">
        <div className="flex h-[var(--ob-pane-head-h)] shrink-0 items-stretch border-b border-rule pr-1.5">
          <TabsList className="h-full flex-1 border-b-0">
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
            <IconButton label="Close panel" shortcut={SHORTCUTS.rightPanel} icon={X} size="sm" tooltipSide="bottom" onClick={() => toggleRightPanel(false)} />
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
