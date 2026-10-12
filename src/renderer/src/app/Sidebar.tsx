// Left sidebar (240 px) + collapsed icon rail. Owner: ui-foundation.
// New session, search, Pinned + project groups (relative time, running spinner, unread dot, context menu),
// nav (Scheduled / Activity / GPU / Settings) and the GPU widget.
import {
  Activity,
  CalendarClock,
  ChevronRight,
  Copy,
  Cpu,
  Ellipsis,
  FolderOpen,
  GitFork,
  House,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary } from '@shared/types';
import { IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { Spinner, StatusDot } from '@renderer/components/ui/feedback';
import { Input } from '@renderer/components/ui/input';
import { Shortcut } from '@renderer/components/ui/kbd';
import { ScrollArea, SectionLabel } from '@renderer/components/ui/layout';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/menu';
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
  navigate,
  openPalette,
  openSession,
  renameSession,
  searchSessions,
  setPinned,
  toggleSidebar,
} from '@renderer/state/actions';
import { useRunningActivityCount, useSidebarModel, useWaitingSessionIds, type SessionGroup } from '@renderer/state/selectors';
import { useSchedules } from '@renderer/state/activity';
import { useSessions } from '@renderer/state/sessions';
import { useUi, type Route } from '@renderer/state/ui';
import { GpuRailButton, GpuWidget } from './GpuWidget';
import { SHORTCUTS } from './shortcuts';

// ───────────────────────────── Session row ─────────────────────────────

interface RowActions {
  onRename: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
}

function SessionIndicator({ s, waiting, unread }: { s: SessionSummary; waiting: boolean; unread: boolean }) {
  if (s.status === 'running') return <Spinner size={12} className="text-ob-accent" label="Running" />;
  if (waiting || s.status === 'waiting') return <StatusDot tone="warning" pulse label="Waiting for you" />;
  if (s.status === 'error') return <StatusDot tone="danger" label="Error" />;
  if (unread) return <StatusDot tone="accent" glow label="Unread" />;
  if (s.kind === 'scheduled') return <CalendarClock size={12} aria-label="Scheduled run" className="text-ob-text-3" />;
  return null;
}

function SessionMenuItems({ s, actions, Item, Sep }: { s: SessionSummary; actions: RowActions; Item: typeof DropdownMenuItem | typeof ContextMenuItem; Sep: typeof DropdownMenuSeparator }) {
  return (
    <>
      <Item icon={Pencil} onSelect={() => actions.onRename(s)}>
        Rename
      </Item>
      <Item icon={s.pinned ? PinOff : Pin} onSelect={() => void setPinned(s.id, !s.pinned)}>
        {s.pinned ? 'Unpin' : 'Pin'}
      </Item>
      <Item icon={GitFork} onSelect={() => void forkSession(s.id)}>
        Fork session
      </Item>
      <Item icon={Copy} onSelect={() => void navigator.clipboard?.writeText(s.cwd)}>
        Copy folder path
      </Item>
      {canRevealFiles() ? (
        <Item icon={FolderOpen} onSelect={() => showItemInFolder(s.cwd)}>
          Reveal folder
        </Item>
      ) : null}
      <Sep />
      <Item icon={Trash2} danger onSelect={() => actions.onDelete(s)}>
        Delete…
      </Item>
    </>
  );
}

function RenameInput({ s, onDone }: { s: SessionSummary; onDone: () => void }) {
  const [value, setValue] = useState(s.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (value.trim() && value.trim() !== s.title) void renameSession(s.id, value);
    onDone();
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Session title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
        e.stopPropagation();
      }}
      className="h-6 min-w-0 flex-1 rounded-[4px] border border-[rgba(143,184,222,0.6)] bg-ob-bg px-1.5 text-ui text-ob-text outline-none"
    />
  );
}

function SessionRow({
  s,
  active,
  unread,
  waiting,
  renaming,
  actions,
  onRenameDone,
}: {
  s: SessionSummary;
  active: boolean;
  unread: boolean;
  waiting: boolean;
  renaming: boolean;
  actions: RowActions;
  onRenameDone: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-current={active ? 'page' : undefined}
          data-testid="session-row"
          title={s.title}
          onClick={() => !renaming && openSession(s.id)}
          onDoubleClick={() => actions.onRename(s)}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openSession(s.id);
            } else if (e.key === 'F2') {
              actions.onRename(s);
            }
          }}
          className={cn(
            'ob-transition group relative flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] pl-2 pr-1 text-ui outline-offset-[-2px]',
            active ? 'bg-[rgba(236,240,241,0.075)] text-ob-text' : 'text-ob-text-2 hover:bg-ob-hover hover:text-ob-text',
          )}
        >
          {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-ob-accent" /> : null}
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            <SessionIndicator s={s} waiting={waiting} unread={unread && !active} />
          </span>
          {renaming ? (
            <RenameInput s={s} onDone={onRenameDone} />
          ) : (
            <span className={cn('min-w-0 flex-1 truncate', unread && !active && 'font-medium text-ob-text')}>{s.title || 'Untitled'}</span>
          )}
          {!renaming ? (
            <>
              <RelativeTime short ts={s.updatedAt} className={cn('shrink-0 pr-1 font-mono text-[10.5px] text-ob-text-3', menuOpen ? 'hidden' : 'group-hover:hidden group-focus-within:hidden')} />
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${s.title}`}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'ob-transition size-6 shrink-0 items-center justify-center rounded-[5px] text-ob-text-3 hover:bg-ob-hover hover:text-ob-text',
                      menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
                    )}
                  >
                    <Ellipsis size={14} aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" sideOffset={6} onClick={(e) => e.stopPropagation()}>
                  <SessionMenuItems s={s} actions={actions} Item={DropdownMenuItem} Sep={DropdownMenuSeparator} />
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionMenuItems s={s} actions={actions} Item={ContextMenuItem as typeof DropdownMenuItem} Sep={ContextMenuSeparator as typeof DropdownMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ───────────────────────────── Groups ─────────────────────────────

function GroupHeader({ label, title, count, collapsed, onToggle, onNew }: { label: ReactNode; title?: string; count: number; collapsed: boolean; onToggle: () => void; onNew?: () => void }) {
  return (
    <div className="group/header flex h-7 items-center gap-1 pl-2 pr-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={title}
        className="ob-section-label ob-transition flex min-w-0 flex-1 items-center gap-1 rounded-[4px] text-left hover:text-ob-text-2"
      >
        <span className="truncate">{label}</span>
        <ChevronRight size={11} aria-hidden className={cn('shrink-0 opacity-0 transition-transform group-hover/header:opacity-100', !collapsed && 'rotate-90')} />
      </button>
      {collapsed ? <span className="font-mono text-[10px] text-ob-text-3">{count}</span> : null}
      {onNew ? (
        <IconButton label="New session in this folder" icon={Plus} size="xs" className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100" onClick={onNew} />
      ) : null}
    </div>
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
        'ob-transition group flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2 text-ui outline-offset-[-2px]',
        active ? 'bg-[rgba(236,240,241,0.075)] text-ob-text' : 'text-ob-text-2 hover:bg-ob-hover hover:text-ob-text',
      )}
    >
      <Icon size={15} aria-hidden className={cn('shrink-0', active ? 'text-ob-accent' : 'text-ob-text-3 group-hover:text-ob-text-2')} />
      <span className="flex-1 truncate text-left">{label}</span>
      {count ? <span className="ob-tabular rounded-pill bg-ob-accent-soft px-1.5 font-mono text-[10px] leading-4 text-ob-accent">{count}</span> : null}
      {shortcut ? <Shortcut keys={shortcut} className="opacity-0 group-hover:opacity-70" /> : null}
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
      <SectionLabel className="px-2">In transcripts</SectionLabel>
      {results.slice(0, 8).map((r) => (
        <button
          key={`${r.sessionId}-${r.snippet.slice(0, 20)}`}
          type="button"
          onClick={() => openSession(r.sessionId)}
          className="ob-transition flex w-full flex-col gap-0.5 rounded-[6px] px-2 py-1.5 text-left hover:bg-ob-hover"
        >
          <span className="truncate text-ui text-ob-text">{r.title}</span>
          <span className="line-clamp-2 text-small text-ob-text-3">{truncate(r.snippet.replace(/\s+/g, ' '), 120)}</span>
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
  const query = useUi((s) => s.sidebarQuery);
  const model = useSidebarModel(query);
  const activeId = useSessions((s) => s.activeSessionId);
  const route = useUi((s) => s.route);
  const unread = useSessions((s) => s.unread);
  const loaded = useSessions((s) => s.loaded);
  const waiting = useWaitingSessionIds();
  const runningActivity = useRunningActivityCount();
  const enabledSchedules = useSchedules((s) => s.tasks.filter((t) => t.enabled).length);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const actions: RowActions = useMemo(
    () => ({
      onRename: (s) => setRenamingId(s.id),
      onDelete: (s) => setDeleteTarget(s),
    }),
    [],
  );

  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderRows = (list: SessionSummary[]) =>
    list.map((s) => (
      <SessionRow
        key={s.id}
        s={s}
        active={route === 'session' && s.id === activeId}
        unread={!!unread[s.id]}
        waiting={waiting.has(s.id)}
        renaming={renamingId === s.id}
        actions={actions}
        onRenameDone={() => setRenamingId(null)}
      />
    ));

  const renderGroup = (g: SessionGroup) => {
    const isCollapsed = collapsedGroups.has(g.key) && !query;
    return (
      <div key={g.key} className="mt-2.5">
        <GroupHeader
          label={g.name}
          title={g.cwd}
          count={g.sessions.length}
          collapsed={isCollapsed}
          onToggle={() => toggleGroup(g.key)}
          onNew={() => void createSession({ cwd: g.cwd })}
        />
        {!isCollapsed ? <div className="flex flex-col gap-px">{renderRows(g.sessions)}</div> : null}
      </div>
    );
  };

  return (
    <aside
      data-testid="sidebar"
      aria-label="Sidebar"
      className="flex h-full w-[var(--ob-sidebar-w)] shrink-0 flex-col border-r border-ob-border bg-ob-surface-1"
    >
      <div className="flex flex-col gap-2 px-2 pb-1.5 pt-2.5">
        <button
          type="button"
          data-testid="new-session"
          onClick={() => void createSession()}
          className="ob-transition group flex h-8 w-full items-center gap-2 rounded-ctl border border-ob-border bg-ob-surface-2 px-2.5 text-ui font-medium text-ob-text hover:border-[#2f404e] hover:bg-ob-surface-3"
        >
          <SquarePen size={15} aria-hidden className="text-ob-accent" />
          New session
          <Shortcut keys={SHORTCUTS.newSession} className="ml-auto opacity-70 group-hover:opacity-100" />
        </button>
        <Input
          size="sm"
          icon={Search}
          value={query}
          placeholder="Search sessions"
          aria-label="Search sessions"
          onChange={(e) => useUi.setState({ sidebarQuery: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') useUi.setState({ sidebarQuery: '' });
          }}
          className="bg-ob-bg/50"
          trailing={
            query ? (
              <IconButton label="Clear search" icon={X} size="xs" noTooltip onClick={() => useUi.setState({ sidebarQuery: '' })} />
            ) : undefined
          }
        />
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={goHome}
            data-testid="nav-home"
            aria-current={route === 'session' && !activeId ? 'page' : undefined}
            className={cn(
              'ob-transition group flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2 text-ui',
              route === 'session' && !activeId ? 'bg-[rgba(236,240,241,0.075)] text-ob-text' : 'text-ob-text-2 hover:bg-ob-hover hover:text-ob-text',
            )}
          >
            <House size={15} aria-hidden className={cn(route === 'session' && !activeId ? 'text-ob-accent' : 'text-ob-text-3')} />
            Home
          </button>

          {model.pinned.length ? (
            <div className="mt-2.5">
              <GroupHeader label="Pinned" count={model.pinned.length} collapsed={collapsedGroups.has('__pinned') && !query} onToggle={() => toggleGroup('__pinned')} />
              {!(collapsedGroups.has('__pinned') && !query) ? <div className="flex flex-col gap-px">{renderRows(model.pinned)}</div> : null}
            </div>
          ) : null}

          {model.groups.map(renderGroup)}

          {loaded && model.total === 0 ? (
            <div className="px-2 py-6 text-center text-small text-ob-text-3">{query ? 'No sessions match.' : 'No sessions yet.'}</div>
          ) : null}
          {!loaded ? (
            <div className="flex flex-col gap-2 px-2 pt-4" aria-hidden>
              {[70, 52, 84, 60].map((w, i) => (
                <div key={i} className="ob-skeleton h-3" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : null}
          {query ? <TranscriptMatches query={query} /> : null}
        </div>
      </ScrollArea>

      <nav aria-label="Views" className="flex flex-col gap-px border-t border-ob-border px-2 py-2">
        <NavRow icon={CalendarClock} label="Scheduled" route="schedules" count={enabledSchedules || undefined} />
        <NavRow icon={Activity} label="Activity" route="activity" count={runningActivity || undefined} />
        <NavRow icon={Cpu} label="GPU" route="gpu" />
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
      className="flex h-full w-[var(--ob-rail-w)] shrink-0 flex-col items-center gap-1 border-r border-ob-border bg-ob-surface-1 py-2"
    >
      <RailButton icon={SquarePen} label="New session" shortcut={SHORTCUTS.newSession} onClick={() => void createSession()} active={false} />
      <RailButton icon={Search} label="Search sessions" shortcut={SHORTCUTS.palette} onClick={() => openPalette('sessions')} active={false} />
      <div className="my-1 h-px w-6 bg-ob-border" />
      <RailButton icon={House} label="Home" onClick={goHome} active={route === 'session' && !activeId} />
      <RailButton icon={CalendarClock} label="Scheduled" route="schedules" />
      <span className="relative">
        <RailButton icon={Activity} label="Activity" route="activity" />
        {runningCount ? (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-pill bg-ob-accent px-1 font-mono text-[9px] font-semibold text-ob-accent-ink">
            {runningCount}
          </span>
        ) : null}
      </span>
      <GpuRailButton />
      <RailButton icon={Settings} label="Settings" route="settings" shortcut={SHORTCUTS.settings} />
      <div className="flex-1" />
      <Tooltip content="Expand sidebar" shortcut={SHORTCUTS.sidebar} side="right">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={() => toggleSidebar(true)}
          className="ob-transition flex size-8 items-center justify-center rounded-ctl text-ob-text-3 hover:bg-ob-hover hover:text-ob-text"
        >
          <PanelLeftOpen size={16} aria-hidden />
        </button>
      </Tooltip>
    </aside>
  );
}
