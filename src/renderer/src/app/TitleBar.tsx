// Custom title bar (34 px, draggable) — reference .tbar: brand diamond + "OBSIDIAN CODE" (mono, tracked) on the left,
// the document title centred ("<session> — <project>", or the view name). ~140 px reserved for the Windows
// titleBarOverlay controls in Electron. Menus live in the menu strip below (MenuBar). Owner: ui-foundation.
import { Fragment } from 'react';
import { AppMark } from '@renderer/components/ui/app-mark';
import { isElectron } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { basename } from '@renderer/lib/format';
import { useActiveSession } from '@renderer/state/selectors';
import { ROUTE_TITLES, useUi } from '@renderer/state/ui';

/** Document title parts: [session title, project folder] for an open session, otherwise [view name]. */
function useDocTitle(): { parts: string[]; path: string | null } {
  const route = useUi((s) => s.route);
  const active = useActiveSession();
  if (route === 'session') {
    if (!active) return { parts: ['Home'], path: null };
    return { parts: [active.title || 'Untitled', basename(active.cwd) || active.cwd], path: active.cwd };
  }
  return { parts: [ROUTE_TITLES[route]], path: null };
}

export function TitleBar() {
  const { parts, path } = useDocTitle();
  const electron = isElectron();

  return (
    // In Electron the native controls overlay is exactly --ob-titlebar-h (34 px) tall and paints over everything under
    // it, so the bar is 1 px taller there: its bottom hairline then runs unbroken beneath the window controls.
    <header
      className={cn(
        'ob-drag relative flex shrink-0 select-none items-center border-b border-rule2 pl-[13px]',
        electron ? 'h-[calc(var(--ob-titlebar-h)+1px)] pr-[var(--ob-window-controls-w)]' : 'h-[var(--ob-titlebar-h)] pr-3',
      )}
      data-testid="titlebar"
    >
      <div className="flex shrink-0 items-center gap-2">
        <AppMark size={12} />
        <span data-testid="app-title" className="font-mono text-[9.5px] font-semibold uppercase leading-none tracking-[0.24em] text-t1">
          Obsidian Code
        </span>
      </div>

      {/* Centred document title (the window is the drag region, so this never takes the pointer). */}
      <div className="pointer-events-none absolute inset-x-[220px] flex justify-center">
        <div data-testid="view-title" title={path ?? undefined} className="truncate text-[11.5px] tracking-[-0.008em] text-t2">
          {parts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 ? (
                <span aria-hidden className="mx-[7px] text-t3 opacity-55">
                  —
                </span>
              ) : null}
              {p}
            </Fragment>
          ))}
        </div>
      </div>
    </header>
  );
}
