// Left sidebar (240 px by default; drag its right edge to resize) + collapsed icon rail. Owner: ui-foundation.
// M13 (reference .s2-rail): same #000 ground, a single --rule hairline on the right, no fills. Mono cap section labels,
// 28 px rows, selected row = acc-wash + 2 px cold-white left edge, counts/times in mono --t3.
// New session, search, Pinned + categories + project groups (collapse, rename, reorder by drag and drop, context menus),
// session rows (relative time, live dot, unread dot, context menu),
// nav (Scheduled / Activity / GPU / Models / Settings) and the GPU widget. The grouping is state/sidebar-model.ts.
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Boxes,
  CalendarClock,
  Check,
  Copy,
  Cpu,
  Ellipsis,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitFork,
  House,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '@shared/types';
import { IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { StatusDot } from '@renderer/components/ui/feedback';
import { Input } from '@renderer/components/ui/input';
import { ResizeHandle, useViewportWidth } from '@renderer/components/ui/resize-handle';
import { Shortcut } from '@renderer/components/ui/kbd';
import { ScrollArea, SectionLabel } from '@renderer/components/ui/layout';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@renderer/components/ui/menu';
import { RelativeTime } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { canRevealFiles, showItemInFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { truncate } from '@renderer/lib/format';
import {
  createSession,
  deleteSession,
  forkSession,
  goHome,
  moveSessionToCategory,
  navigate,
  openNewCategory,
  openPalette,
  openSession,
  renameSession,
  searchSessions,
  setPinned,
  stepSession,
  toggleSidebar,
} from '@renderer/state/actions';
import { AutoClockOutMenuItems, useAutoClockOutAvailable } from '@renderer/features/gpu/AutoClockOut';
import { useRunningActivityCount, useSidebarModel, useWaitingSessionIds } from '@renderer/state/selectors';
import { SyncFailed, useSyncError } from '@renderer/features/settings/core-missing';
import { useSchedules } from '@renderer/state/activity';
import { useSessions } from '@renderer/state/sessions';
import { useSidebarPrefs } from '@renderer/state/sidebar';
import { groupSessions, pinnedGroup, stepAvailability, type SessionGroup } from '@renderer/state/sidebar-model';
import { effectiveSidebarWidth, PANEL_LIMITS, usePanelSize, useUi, type Route } from '@renderer/state/ui';
import { GpuRailButton, GpuWidget } from './GpuWidget';
import { SHORTCUTS } from './shortcuts';
import { endDrag, startDrag, useSidebarDrag } from './sidebar-dnd';
import {
  CONTEXT_PARTS,
  DeleteGroupDialog,
  DROPDOWN_PARTS,
  GroupBlock,
  InlineRename,
  refocus,
  type MenuParts,
} from './SidebarGroups';

// ───────────────────────────── Session row ─────────────────────────────

export interface RowActions {
  onRename: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
}

function SessionIndicator({ s, waiting, unread }: { s: SessionSummary; waiting: boolean; unread: boolean }) {
  if (s.status === 'running') return <StatusDot tone="violet" pulse glow label="Running" />;
  if (waiting || s.status === 'waiting') return <StatusDot tone="warning" pulse label="Waiting for you" />;
  if (s.status === 'error') return <StatusDot tone="danger" label="Error" />;
  if (unread) return <StatusDot tone="accent" label="Unread" />;
  if (s.kind === 'scheduled') return <CalendarClock size={11} aria-label="Scheduled run" className="text-t3" />;
  return null;
}

/** The rows of a session's menu (the sidebar's right-click and "..." menus, and Home's recent list). */
export function SessionMenuItems({ s, actions, parts, kind }: { s: SessionSummary; actions: RowActions; parts: MenuParts; kind: 'context' | 'dropdown' }) {
  const { Item, Sep, Sub, SubTrigger, SubContent } = parts;
  const prefs = useSidebarPrefs();
  const clockedIn = useAutoClockOutAvailable();
  // Menus mount when they open, so this is computed once per opening.
  const steps = useMemo(() => stepAvailability(groupSessions(useSessions.getState().sessions, '', prefs), s.id), [prefs, s.id]);
  const current = s.category && prefs.categories.some((c) => c.id === s.category) ? s.category : null;
  return (
    <>
      <Item icon={Pencil} shortcut="F2" onSelect={() => actions.onRename(s)}>
        Rename
      </Item>
      <Item icon={s.pinned ? PinOff : Pin} onSelect={() => void setPinned(s.id, !s.pinned)}>
        {s.pinned ? 'Unpin' : 'Pin'}
      </Item>
      <Item icon={GitFork} onSelect={() => void forkSession(s.id)}>
        Fork session
      </Item>
      <Sep />
      <Sub>
        <SubTrigger icon={FolderInput}>Move to category</SubTrigger>
        <SubContent data-testid="move-to-category-menu">
          {prefs.categories.map((c) => (
            <Item key={c.id} trailing={c.id === current ? <Check size={13} aria-hidden className="text-t1" /> : undefined} onSelect={() => void moveSessionToCategory(s.id, c.id)}>
              {c.name}
            </Item>
          ))}
          {prefs.categories.length ? <Sep /> : null}
          <Item icon={FolderPlus} onSelect={() => openNewCategory({ sessionId: s.id })}>
            New category…
          </Item>
          {current ? (
            <Item icon={Undo2} onSelect={() => void moveSessionToCategory(s.id, null)}>
              Back to its folder group
            </Item>
          ) : null}
        </SubContent>
      </Sub>
      <Item icon={ArrowUp} shortcut="Alt+Up" disabled={!steps.up} onSelect={() => void stepSession(s.id, -1)}>
        Move up
      </Item>
      <Item icon={ArrowDown} shortcut="Alt+Down" disabled={!steps.down} onSelect={() => void stepSession(s.id, 1)}>
        Move down
      </Item>
      <Sep />
      <Item icon={Copy} onSelect={() => void navigator.clipboard?.writeText(s.cwd)}>
        Copy folder path
      </Item>
      {canRevealFiles() ? (
        <Item icon={FolderOpen} onSelect={() => showItemInFolder(s.cwd)}>
          Reveal folder
        </Item>
      ) : null}
      {clockedIn && s.kind !== 'subagent' ? (
        <>
          <Sep />
          <AutoClockOutMenuItems sessionId={s.id} kind={kind} />
        </>
      ) : null}
      <Sep />
      <Item icon={Trash2} danger shortcut="Del" onSelect={() => actions.onDelete(s)}>
        Delete…
      </Item>
    </>
  );
}

function SessionRow({
  s,
  active,
  unread,
  waiting,
  renaming,
  draggable,
  actions,
  onRenameDone,
}: {
  s: SessionSummary;
  active: boolean;
  unread: boolean;
  waiting: boolean;
  renaming: boolean;
  /** Drag and drop reorders / moves rows (off while searching or renaming). */
  draggable: boolean;
  actions: RowActions;
  onRenameDone: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dragging = useSidebarDrag((st) => st.item?.kind === 'session' && st.item.id === s.id);
  const mark = useSidebarDrag((st) => (st.mark?.kind === 'row' && st.mark.id === s.id ? (st.mark.after ? 'after' : 'before') : null));
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-current={active ? 'page' : undefined}
          data-testid="session-row"
          data-session-id={s.id}
          title={s.title}
          draggable={draggable && !renaming}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', s.title);
            startDrag({ kind: 'session', id: s.id });
          }}
          onDragEnd={endDrag}
          onClick={() => !renaming && openSession(s.id)}
          onDoubleClick={() => actions.onRename(s)}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openSession(s.id);
            } else if (e.key === 'F2') {
              actions.onRename(s);
            } else if (e.key === 'Delete') {
              actions.onDelete(s);
            } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && draggable) {
              e.preventDefault();
              void stepSession(s.id, e.key === 'ArrowUp' ? -1 : 1).then(() => refocus(`[data-session-id="${CSS.escape(s.id)}"]`));
            }
          }}
          className={cn(
            'ob-transition group relative flex h-7 cursor-default select-none items-center gap-[9px] pl-4 pr-2 text-[12px] tracking-[-0.012em] outline-offset-[-1px]',
            active ? 'ob-nav-on' : 'text-t2 hover:bg-hov hover:text-t1',
            dragging && 'opacity-40',
          )}
        >
          {mark ? <span aria-hidden className={cn('pointer-events-none absolute inset-x-4 z-10 h-[2px] bg-acc', mark === 'before' ? 'top-0' : 'bottom-0')} /> : null}
          <span className="flex w-[9px] shrink-0 items-center justify-center">
            <SessionIndicator s={s} waiting={waiting} unread={unread && !active} />
          </span>
          {renaming ? (
            <InlineRename value={s.title} label="Session title" onCommit={(v) => void renameSession(s.id, v)} onDone={onRenameDone} />
          ) : (
            <span className={cn('min-w-0 flex-1 truncate', unread && !active && 'font-medium text-t1')}>{s.title || 'Untitled'}</span>
          )}
          {!renaming ? (
            <>
              <RelativeTime short ts={s.updatedAt} className={cn('shrink-0 pr-1 font-mono text-[9.5px] tracking-[0.02em]', active ? 'text-acc' : 'text-t3', menuOpen ? 'hidden' : 'group-hover:hidden group-focus-within:hidden')} />
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${s.title}`}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'ob-transition size-5 shrink-0 items-center justify-center rounded-[2px] text-t3 hover:bg-s3 hover:text-t1',
                      menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
                    )}
                  >
                    <Ellipsis size={13} aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" sideOffset={6} onClick={(e) => e.stopPropagation()}>
                  <SessionMenuItems s={s} actions={actions} parts={DROPDOWN_PARTS} kind="dropdown" />
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionMenuItems s={s} actions={actions} parts={CONTEXT_PARTS} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ───────────────────────────── Nav ─────────────────────────────

function NavRow({ icon: Icon, label, route, count, shortcut }: { icon: LucideIcon; label: string; route: Route; count?: number; shortcut?: string }) {
  const active = useUi((s) => s.route === route);
  return (
    <button
      type="button"
      onClick={() => navigate(route)}
      aria-current={active ? 'page' : undefined}
      data-testid={`nav-${route}`}
      className={cn(
        'ob-transition group flex h-7 w-full items-center gap-[9px] px-4 text-[12px] tracking-[-0.012em] outline-offset-[-1px]',
        active ? 'ob-nav-on' : 'text-t2 hover:bg-hov hover:text-t1',
      )}
    >
      <Icon size={13} aria-hidden className={cn('shrink-0', active ? 'text-acc' : 'text-t3 group-hover:text-t2')} />
      <span className="flex-1 truncate text-left">{label}</span>
      {count ? <span className={cn('ob-tabular font-mono text-[9.5px] tracking-[0.02em]', active ? 'text-acc' : 'text-t3')}>{count}</span> : null}
      {shortcut ? <Shortcut keys={shortcut} plain className="opacity-0 group-hover:opacity-100" /> : null}
    </button>
  );
}

// ───────────────────────────── Transcript search ─────────────────────────────

function TranscriptMatches({ query }: { query: string }) {
  const [results, setResults] = useState<{ sessionId: string; title: string; snippet: string }[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void searchSessions(q).then((r) => alive && setResults(r));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);
  if (!results.length) return null;
  return (
    <div className="mt-2">
      <SectionLabel className="px-4">In transcripts</SectionLabel>
      {results.slice(0, 8).map((r) => (
        <button
          key={`${r.sessionId}-${r.snippet.slice(0, 20)}`}
          type="button"
          onClick={() => openSession(r.sessionId)}
          className="ob-transition flex w-full flex-col gap-0.5 px-4 py-1.5 text-left hover:bg-hov"
        >
          <span className="truncate text-[12px] text-t1">{r.title}</span>
          <span className="line-clamp-2 font-mono text-[9.5px] leading-[14px] text-t3">{truncate(r.snippet.replace(/\s+/g, ' '), 120)}</span>
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────── Sidebar ─────────────────────────────

export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  return collapsed ? <SidebarRail /> : <SidebarFull />;
}

function SidebarFull() {
  const [savedWidth, setWidth] = usePanelSize('sidebar');
  const viewport = useViewportWidth();
  const width = effectiveSidebarWidth(savedWidth, viewport);
  const query = useUi((s) => s.sidebarQuery);
  const searching = query.trim().length > 0;
  const model = useSidebarModel(query);
  const prefs = useSidebarPrefs();
  const activeId = useSessions((s) => s.activeSessionId);
  const route = useUi((s) => s.route);
  const unread = useSessions((s) => s.unread);
  const loaded = useSessions((s) => s.loaded);
  const sessionsError = useSyncError('sessions');
  const waiting = useWaitingSessionIds();
  const runningActivity = useRunningActivityCount();
  const enabledSchedules = useSchedules((s) => s.tasks.filter((t) => t.enabled).length);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<SessionGroup | null>(null);
  const collapsedKeys = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);

  // A drag that ends outside any group (or whose row was re-rendered away) must not leave a marker behind.
  useEffect(() => {
    window.addEventListener('dragend', endDrag);
    window.addEventListener('drop', endDrag);
    return () => {
      window.removeEventListener('dragend', endDrag);
      window.removeEventListener('drop', endDrag);
    };
  }, []);

  const actions: RowActions = useMemo(
    () => ({
      onRename: (s) => setRenamingId(s.id),
      onDelete: (s) => setDeleteTarget(s),
    }),
    [],
  );

  const groups: SessionGroup[] = useMemo(() => {
    const pinned = pinnedGroup(model);
    return pinned ? [pinned, ...model.groups] : model.groups;
  }, [model]);
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedKeys.has(g.key));
  const anyCollapsed = groups.some((g) => collapsedKeys.has(g.key));

  const renderRows = (list: SessionSummary[]) =>
    list.map((s) => (
      <SessionRow
        key={s.id}
        s={s}
        active={route === 'session' && s.id === activeId}
        unread={!!unread[s.id]}
        waiting={waiting.has(s.id)}
        renaming={renamingId === s.id}
        draggable={!searching}
        actions={actions}
        onRenameDone={() => setRenamingId(null)}
      />
    ));

  // The delete dialog works on the group's sessions as stored, not as a search shows them.
  const askDeleteGroup = (g: SessionGroup) => {
    const full = groupSessions(useSessions.getState().sessions, '', prefs).groups.find((x) => x.key === g.key);
    setDeleteGroup(full ?? g);
  };

  const renderGroup = (g: SessionGroup) => (
    <GroupBlock
      key={g.key}
      group={g}
      index={g.kind === 'pinned' ? -1 : model.groups.findIndex((x) => x.key === g.key)}
      groupCount={model.groups.length}
      collapsed={collapsedKeys.has(g.key) && !searching}
      searching={searching}
      renaming={renamingGroup === g.key}
      allCollapsed={allCollapsed}
      anyCollapsed={anyCollapsed}
      onRenameStart={() => setRenamingGroup(g.key)}
      onRenameDone={() => setRenamingGroup(null)}
      onDelete={() => askDeleteGroup(g)}
      onNewCategory={() => openNewCategory({ afterKey: g.kind === 'pinned' ? undefined : g.key })}
    >
      {renderRows(g.sessions)}
    </GroupBlock>
  );

  return (
    <aside
      data-testid="sidebar"
      aria-label="Sidebar"
      className="relative flex h-full shrink-0 flex-col border-r border-rule bg-s0"
      style={{ width }}
    >
      <ResizeHandle
        edge="right"
        value={width}
        min={PANEL_LIMITS.sidebar.min}
        max={effectiveSidebarWidth(PANEL_LIMITS.sidebar.max, viewport)}
        defaultValue={PANEL_LIMITS.sidebar.default}
        onChange={setWidth}
        label="Resize sidebar"
        testId="sidebar-resize"
      />
      <div className="flex flex-col gap-2 px-4 pb-2 pt-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="new-session"
            onClick={() => void createSession()}
            className="ob-transition group flex h-7 min-w-0 flex-1 items-center gap-[7px] rounded-[2px] bg-acc px-2.5 text-[11.5px] font-semibold tracking-[-0.008em] text-acc-ink hover:bg-white"
          >
            <SquarePen size={12} aria-hidden />
            New session
            <Shortcut keys={SHORTCUTS.newSession} plain className="ml-auto text-acc-ink opacity-60" />
          </button>
          <IconButton label="Collapse sidebar" shortcut={SHORTCUTS.sidebar} icon={PanelLeftClose} size="md" tooltipSide="bottom" onClick={() => toggleSidebar(false)} />
        </div>
        <Input
          size="md"
          icon={Search}
          value={query}
          placeholder="Search sessions"
          aria-label="Search sessions"
          onChange={(e) => useUi.setState({ sidebarQuery: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') useUi.setState({ sidebarQuery: '' });
          }}
          trailing={
            query ? (
              <IconButton label="Clear search" icon={X} size="xs" noTooltip onClick={() => useUi.setState({ sidebarQuery: '' })} />
            ) : undefined
          }
        />
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="pb-3">
        <div
          className="flex flex-col"
          onDragOver={(e) => {
            // Between groups there is nothing to drop on: no marker.
            if (!(e.target as Element).closest('[data-group-key]')) useSidebarDrag.setState({ mark: null });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) useSidebarDrag.setState({ mark: null });
          }}
        >
          <button
            type="button"
            onClick={goHome}
            data-testid="nav-home"
            aria-current={route === 'session' && !activeId ? 'page' : undefined}
            className={cn(
              'ob-transition group flex h-7 w-full items-center gap-[9px] px-4 text-[12px] tracking-[-0.012em] outline-offset-[-1px]',
              route === 'session' && !activeId ? 'ob-nav-on' : 'text-t2 hover:bg-hov hover:text-t1',
            )}
          >
            <House size={13} aria-hidden className={cn(route === 'session' && !activeId ? 'text-acc' : 'text-t3 group-hover:text-t2')} />
            Home
          </button>

          {groups.map(renderGroup)}

          {loaded && model.total === 0 ? (
            <div className="px-4 py-6 text-center text-[11.5px] text-t3">{query ? 'No sessions match.' : 'No sessions yet.'}</div>
          ) : null}
          {!loaded && sessionsError ? <SyncFailed what="sessions" error={sessionsError} compact /> : null}
          {!loaded && !sessionsError ? (
            <div className="flex flex-col gap-2.5 px-4 pt-4" aria-hidden>
              {[70, 52, 84, 60].map((w, i) => (
                <div key={i} className="ob-skeleton h-3" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : null}
          {query ? <TranscriptMatches query={query} /> : null}
        </div>
      </ScrollArea>

      <nav aria-label="Views" className="flex flex-col border-t border-rule2 py-2">
        <NavRow icon={CalendarClock} label="Scheduled" route="schedules" count={enabledSchedules || undefined} />
        <NavRow icon={Activity} label="Activity" route="activity" count={runningActivity || undefined} />
        <NavRow icon={Cpu} label="GPU" route="gpu" />
        <NavRow icon={Boxes} label="Models" route="models" />
        <NavRow icon={Settings} label="Settings" route="settings" shortcut={SHORTCUTS.settings} />
      </nav>
      <GpuWidget />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete session?"
        description={deleteTarget ? `“${truncate(deleteTarget.title, 60)}” and its transcript will be deleted. This can’t be undone.` : undefined}
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (deleteTarget) await deleteSession(deleteTarget.id);
        }}
      />
      <DeleteGroupDialog group={deleteGroup} onClose={() => setDeleteGroup(null)} />
    </aside>
  );
}

function RailButton({ icon, label, route, onClick, active, shortcut }: { icon: LucideIcon; label: string; route?: Route; onClick?: () => void; active?: boolean; shortcut?: string }) {
  const isRoute = useUi((s) => (route ? s.route === route : false));
  return (
    <IconButton
      label={label}
      icon={icon}
      size="lg"
      tooltipSide="right"
      shortcut={shortcut}
      active={active ?? isRoute}
      onClick={onClick ?? (() => route && navigate(route))}
    />
  );
}

function SidebarRail() {
  const activeId = useSessions((s) => s.activeSessionId);
  const route = useUi((s) => s.route);
  const runningCount = useRunningActivityCount();
  return (
    <aside
      data-testid="sidebar"
      data-collapsed="true"
      aria-label="Sidebar"
      className="flex h-full w-[var(--ob-rail-w)] shrink-0 flex-col items-center gap-1 border-r border-rule bg-s0 py-2.5"
    >
      <RailButton icon={SquarePen} label="New session" shortcut={SHORTCUTS.newSession} onClick={() => void createSession()} active={false} />
      <RailButton icon={Search} label="Search sessions" shortcut={SHORTCUTS.palette} onClick={() => openPalette('sessions')} active={false} />
      <div className="my-1 h-px w-6 bg-rule2" />
      <RailButton icon={House} label="Home" onClick={goHome} active={route === 'session' && !activeId} />
      <RailButton icon={CalendarClock} label="Scheduled" route="schedules" />
      <span className="relative">
        <RailButton icon={Activity} label="Activity" route="activity" />
        {runningCount ? (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-[2px] bg-acc px-1 font-mono text-[8.5px] font-semibold text-acc-ink">
            {runningCount}
          </span>
        ) : null}
      </span>
      <GpuRailButton />
      <RailButton icon={Boxes} label="Models" route="models" />
      <RailButton icon={Settings} label="Settings" route="settings" shortcut={SHORTCUTS.settings} />
      <div className="flex-1" />
      <Tooltip content="Expand sidebar" shortcut={SHORTCUTS.sidebar} side="right">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={() => toggleSidebar(true)}
          className="ob-transition flex size-8 items-center justify-center rounded-[2px] text-t3 hover:bg-hov hover:text-t1"
        >
          <PanelLeftOpen size={15} aria-hidden />
        </button>
      </Tooltip>
    </aside>
  );
}
