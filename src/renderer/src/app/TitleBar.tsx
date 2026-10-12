// Custom title bar (40 px, draggable). Left block continues the sidebar column (app mark); right block shows only the
// current view, or the current project (cwd folder) for a session — the session title and the right-panel toggle live
// in the ChatHeader. ~140 px reserved for the Windows titleBarOverlay controls in Electron. Owner: ui-foundation.
import { Folder, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { IconButton } from '@renderer/components/ui/button';
import { AppMark } from '@renderer/components/ui/app-mark';
import { Shortcut } from '@renderer/components/ui/kbd';
import { isElectron } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { basename } from '@renderer/lib/format';
import { openPalette, toggleSidebar } from '@renderer/state/actions';
import { useActiveSession } from '@renderer/state/selectors';
import { ROUTE_TITLES, useUi } from '@renderer/state/ui';
import { SHORTCUTS } from './shortcuts';

/** The view name, or for an open session its project folder (full path in `path`). */
function useViewTitle(): { title: string; path: string | null } {
  const route = useUi((s) => s.route);
  const active = useActiveSession();
  if (route === 'session') {
    if (!active) return { title: 'Home', path: null };
    return { title: basename(active.cwd) || active.cwd, path: active.cwd };
  }
  return { title: ROUTE_TITLES[route], path: null };
}

export function TitleBar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const { title, path } = useViewTitle();
  const electron = isElectron();

  return (
    // In Electron the native controls overlay is exactly --ob-titlebar-h (40 px) tall and paints over everything under
    // it, so the bar is 1 px taller there: its bottom hairline then runs unbroken beneath the window controls.
    <header
      className={cn('ob-drag flex shrink-0 select-none items-stretch', electron ? 'h-[calc(var(--ob-titlebar-h)+1px)]' : 'h-[var(--ob-titlebar-h)]')}
      data-testid="titlebar"
    >
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui" data-testid="view-title" title={path ?? undefined}>
          {path ? <Folder size={13} aria-hidden className="shrink-0 text-ob-text-3" /> : null}
          <span className={cn('truncate', path ? 'text-ob-text-2' : 'font-medium text-ob-text')}>{title}</span>
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
      </div>
    </header>
  );
}
