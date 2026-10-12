// Custom title bar (40 px, draggable). Left block continues the sidebar column; right block shows the current view
// title, palette trigger and panel toggles. ~140 px reserved for the Windows titleBarOverlay controls in Electron.
// Owner: ui-foundation.
import { ChevronRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search } from 'lucide-react';
import { IconButton } from '@renderer/components/ui/button';
import { AppMark } from '@renderer/components/ui/app-mark';
import { Shortcut } from '@renderer/components/ui/kbd';
import { isElectron } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { basename } from '@renderer/lib/format';
import { openPalette, toggleRightPanel, toggleSidebar } from '@renderer/state/actions';
import { useActiveSession } from '@renderer/state/selectors';
import { ROUTE_TITLES, useUi } from '@renderer/state/ui';
import { SHORTCUTS } from './shortcuts';

function useViewTitle(): { title: string; context: string | null } {
  const route = useUi((s) => s.route);
  const active = useActiveSession();
  if (route === 'session') {
    if (!active) return { title: 'Home', context: null };
    return { title: active.title || 'Untitled session', context: basename(active.cwd) };
  }
  return { title: ROUTE_TITLES[route], context: null };
}

export function TitleBar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const route = useUi((s) => s.route);
  const active = useActiveSession();
  const { title, context } = useViewTitle();
  const electron = isElectron();
  const canShowRight = route === 'session' && !!active;

  return (
    <header className="ob-drag flex h-[var(--ob-titlebar-h)] shrink-0 select-none items-stretch" data-testid="titlebar">
      {/* Left: continues the sidebar column */}
      <div
        className={cn(
          'flex shrink-0 items-center border-r border-ob-border bg-ob-surface-1',
          collapsed ? 'w-[var(--ob-rail-w)] justify-center' : 'w-[var(--ob-sidebar-w)] justify-between pl-3.5 pr-1.5',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <AppMark size={collapsed ? 20 : 18} />
          {!collapsed ? (
            <span data-testid="app-title" className="truncate text-[13px] font-semibold tracking-[-0.01em] text-ob-text">
              Obsidian Code
            </span>
          ) : (
            <span data-testid="app-title" className="sr-only">
              Obsidian Code
            </span>
          )}
        </div>
        {!collapsed ? (
          <IconButton
            className="ob-no-drag"
            label="Collapse sidebar"
            shortcut={SHORTCUTS.sidebar}
            icon={PanelLeftClose}
            size="md"
            tooltipSide="bottom"
            onClick={() => toggleSidebar(false)}
          />
        ) : null}
      </div>

      {/* Right: view title + actions */}
      <div className={cn('flex min-w-0 flex-1 items-center gap-3 border-b border-ob-border pl-4', electron ? 'pr-[var(--ob-window-controls-w)]' : 'pr-2')}>
        {collapsed ? (
          <IconButton
            className="ob-no-drag -ml-2"
            label="Expand sidebar"
            shortcut={SHORTCUTS.sidebar}
            icon={PanelLeftOpen}
            size="md"
            tooltipSide="bottom"
            onClick={() => toggleSidebar(true)}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui" data-testid="view-title">
          {context ? (
            <>
              <span className="shrink-0 truncate text-ob-text-3">{context}</span>
              <ChevronRight size={13} aria-hidden className="shrink-0 text-ob-text-3/70" />
            </>
          ) : null}
          <span className="truncate font-medium text-ob-text">{title}</span>
        </div>

        <button
          type="button"
          onClick={() => openPalette()}
          data-testid="palette-trigger"
          className="ob-no-drag ob-transition flex h-7 w-[min(300px,28vw)] shrink-0 items-center gap-2 rounded-[7px] border border-ob-border bg-ob-surface-1 pl-2.5 pr-1.5 text-small text-ob-text-3 hover:border-[#2f404e] hover:text-ob-text-2"
        >
          <Search size={13} aria-hidden />
          <span className="flex-1 truncate text-left">Search or run a command</span>
          <Shortcut keys={SHORTCUTS.palette} />
        </button>

        <IconButton
          className="ob-no-drag"
          label={rightOpen ? 'Hide side panel' : 'Show side panel'}
          shortcut={SHORTCUTS.rightPanel}
          icon={rightOpen && canShowRight ? PanelRightClose : PanelRightOpen}
          active={rightOpen && canShowRight}
          disabled={!canShowRight}
          size="md"
          tooltipSide="bottom"
          onClick={() => toggleRightPanel()}
        />
      </div>
    </header>
  );
}
