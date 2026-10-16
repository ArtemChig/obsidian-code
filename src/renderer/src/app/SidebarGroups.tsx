// Sidebar groups (Pinned, categories, project folders): the header with collapse / rename / menu, drag and drop onto a
// group, and the dialogs that delete one. Owner: ui-foundation. The grouping itself is state/sidebar-model.ts.
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Ellipsis,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  RotateCcw,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { categoryIdOf, cleanName, MAX_NAME_LENGTH } from '@shared/sidebar';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent } from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/menu';
import { canRevealFiles, showItemInFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { pluralize, truncate } from '@renderer/lib/format';
import {
  createCategory,
  createSession,
  deleteCategory,
  deleteSessions,
  dropGroup,
  dropSession,
  moveGroup,
  moveSessionToCategory,
  renameGroup,
  setAllGroupsCollapsed,
  toggleGroupCollapsed,
} from '@renderer/state/actions';
import { useSessions } from '@renderer/state/sessions';
import { canDropInto, insertionIndex, type SessionGroup } from '@renderer/state/sidebar-model';
import { currentGroupKeys } from '@renderer/state/sidebar';
import { useUi } from '@renderer/state/ui';
import { dragItem, endDrag, setMark, startDrag, useSidebarDrag } from './sidebar-dnd';

// ───────────────────────────── Menu parts ─────────────────────────────
// The same rows serve the right-click menu and the "…" dropdown: same props, other Radix parts.

export const DROPDOWN_PARTS = {
  Item: DropdownMenuItem,
  Sep: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};
export type MenuParts = typeof DROPDOWN_PARTS;
export const CONTEXT_PARTS = {
  Item: ContextMenuItem,
  Sep: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
} as unknown as MenuParts;

/** A right-click inside a text field (a rename box) is the field's own menu. */
export function skipTextFields(e: MouseEvent<HTMLElement>): void {
  if (e.target instanceof Element && e.target.closest('input, textarea')) e.preventDefault();
}

/** Give keyboard focus back to the element that carries `selector` once the list has re-rendered (a moved row loses it). */
export function refocus(selector: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

// ───────────────────────────── Inline rename ─────────────────────────────

/** A text box in place of a title: Enter / blur save, Escape cancels (sessions and groups). */
export function InlineRename({ value, label, onCommit, onDone }: { value: string; label: string; onCommit: (v: string) => void; onDone: () => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const born = useRef(Date.now());
  // The menu that started the rename still holds focus for a moment and hands it back to where it came from: keep
  // taking it for the first instants instead of ending the rename.
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    const grab = () => {
      const el = ref.current;
      if (!el || finished.current) return;
      el.focus();
      if (document.activeElement === el) el.select();
      else if (frames++ < 20) raf = requestAnimationFrame(grab);
    };
    grab();
    return () => cancelAnimationFrame(raf);
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save && text.trim() !== value.trim()) onCommit(text);
    onDone();
  };
  return (
    <input
      ref={ref}
      value={text}
      aria-label={label}
      data-testid="inline-rename"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (Date.now() - born.current < 150) requestAnimationFrame(() => ref.current?.focus());
        else finish(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
        e.stopPropagation();
      }}
      className="h-[22px] min-w-0 flex-1 rounded-[2px] border border-acc bg-s1 px-1.5 text-[12px] text-t1 outline-none"
    />
  );
}

// ───────────────────────────── Menu rows ─────────────────────────────

interface GroupMenuProps {
  group: SessionGroup;
  index: number;
  groupCount: number;
  searching: boolean;
  allCollapsed: boolean;
  anyCollapsed: boolean;
  onRename: () => void;
  onDelete: () => void;
  onNewCategory: () => void;
}

export function newSessionHere(group: SessionGroup): void {
  if (group.kind === 'category') void createSession({ category: group.categoryId });
  else if (group.kind === 'folder') void createSession({ cwd: group.cwd ?? undefined });
}

function GroupMenuItems({ parts, ...p }: GroupMenuProps & { parts: MenuParts }) {
  const { Item, Sep } = parts;
  const { group } = p;
  const pinned = group.kind === 'pinned';
  return (
    <>
      {!pinned ? (
        <Item icon={SquarePen} onSelect={() => newSessionHere(group)}>
          New session here
        </Item>
      ) : null}
      {!pinned ? (
        <Item icon={Pencil} shortcut="F2" onSelect={p.onRename}>
          Rename
        </Item>
      ) : null}
      {group.kind === 'folder' && group.renamed ? (
        <Item icon={RotateCcw} onSelect={() => void renameGroup(group, '')}>
          Reset name
        </Item>
      ) : null}
      <Item icon={FolderPlus} onSelect={p.onNewCategory}>
        New category
      </Item>
      {!pinned ? (
        <>
          <Sep />
          <Item icon={ArrowUp} shortcut="Alt+Up" disabled={p.searching || p.index <= 0} onSelect={() => void moveGroup(group.key, -1)}>
            Move up
          </Item>
          <Item icon={ArrowDown} shortcut="Alt+Down" disabled={p.searching || p.index >= p.groupCount - 1} onSelect={() => void moveGroup(group.key, 1)}>
            Move down
          </Item>
        </>
      ) : null}
      <Sep />
      <Item icon={ChevronsDownUp} disabled={p.allCollapsed} onSelect={() => void setAllGroupsCollapsed(true)}>
        Collapse all
      </Item>
      <Item icon={ChevronsUpDown} disabled={!p.anyCollapsed} onSelect={() => void setAllGroupsCollapsed(false)}>
        Expand all
      </Item>
      {group.kind === 'folder' && group.cwd ? (
        <>
          <Sep />
          <Item icon={Copy} onSelect={() => void navigator.clipboard?.writeText(group.cwd as string)}>
            Copy folder path
          </Item>
          {canRevealFiles() ? (
            <Item icon={FolderOpen} onSelect={() => showItemInFolder(group.cwd as string)}>
              Reveal folder
            </Item>
          ) : null}
        </>
      ) : null}
      {!pinned ? (
        <>
          <Sep />
          <Item icon={Trash2} danger onSelect={p.onDelete}>
            Delete…
          </Item>
        </>
      ) : null}
    </>
  );
}

// ───────────────────────────── Group ─────────────────────────────

export interface GroupBlockProps {
  group: SessionGroup;
  /** Position among the groups below Pinned (-1 for Pinned) and how many there are. */
  index: number;
  groupCount: number;
  /** What is shown: the saved state, except that a search opens every group. */
  collapsed: boolean;
  searching: boolean;
  renaming: boolean;
  allCollapsed: boolean;
  anyCollapsed: boolean;
  onRenameStart: () => void;
  onRenameDone: () => void;
  onDelete: () => void;
  onNewCategory: () => void;
  /** The session rows. */
  children: ReactNode;
}

export function GroupBlock(p: GroupBlockProps) {
  const { group, searching, renaming } = p;
  const pinned = group.kind === 'pinned';
  const lit = useSidebarDrag((s) => s.mark?.kind === 'group' && s.mark.key === group.key);
  const slot = useSidebarDrag((s) => (s.mark?.kind === 'slot' && s.mark.key === group.key ? s.mark.edge : null));
  const dragging = useSidebarDrag((s) => s.item?.kind === 'group' && s.item.key === group.key);
  const [menuOpen, setMenuOpen] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const selector = `[data-group-key="${CSS.escape(group.key)}"] [data-testid="group-toggle"]`;

  // A click folds the group; a double click renames it (so the fold waits a moment to see whether a second click follows).
  const onToggleClick = (e: MouseEvent) => {
    if (pinned || e.detail === 0) return void toggleGroupCollapsed(group.key);
    if (e.detail > 1) return;
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => void toggleGroupCollapsed(group.key), 200);
  };
  const onToggleKey = (e: KeyboardEvent) => {
    if (pinned) return;
    if (e.key === 'F2') {
      e.preventDefault();
      p.onRenameStart();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !searching) {
      e.preventDefault();
      void moveGroup(group.key, e.key === 'ArrowUp' ? -1 : 1).then(() => refocus(selector));
    }
  };

  const onDragOver = (e: DragEvent) => {
    const d = dragItem();
    if (!d) return;
    if (d.kind === 'session') {
      const moving = useSessions.getState().sessions[d.id];
      if (!moving || !canDropInto(group, moving)) return setMark(null);
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const row = (e.target as Element).closest<HTMLElement>('[data-session-id]');
      if (!row) return setMark({ kind: 'group', key: group.key });
      const r = row.getBoundingClientRect();
      setMark(row.dataset.sessionId === d.id ? null : { kind: 'row', id: row.dataset.sessionId as string, after: e.clientY > r.top + r.height / 2 });
    } else {
      if (pinned || d.key === group.key) return setMark(null);
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setMark({ kind: 'slot', key: group.key, edge: d.order.indexOf(d.key) < d.order.indexOf(group.key) ? 'bottom' : 'top' });
    }
  };
  const onDrop = (e: DragEvent) => {
    const d = dragItem();
    if (!d) return;
    e.preventDefault();
    if (d.kind === 'session') {
      const row = (e.target as Element).closest<HTMLElement>('[data-session-id]');
      const r = row?.getBoundingClientRect();
      const index = row && r ? insertionIndex(group.sessions, d.id, row.dataset.sessionId ?? null, e.clientY > r.top + r.height / 2) : 0;
      void dropSession(d.id, group.key, index);
    } else if (!pinned) {
      void dropGroup(d.key, group.key);
    }
    endDrag();
  };

  const menu: GroupMenuProps = {
    group,
    index: p.index,
    groupCount: p.groupCount,
    searching,
    allCollapsed: p.allCollapsed,
    anyCollapsed: p.anyCollapsed,
    onRename: p.onRenameStart,
    onDelete: p.onDelete,
    onNewCategory: p.onNewCategory,
  };
  const draggable = !pinned && !searching && !renaming;

  return (
    <div
      data-testid="sidebar-group"
      data-group-key={group.key}
      data-group-kind={group.kind}
      className={cn('relative mt-3', dragging && 'opacity-40')}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {slot ? <span aria-hidden className={cn('pointer-events-none absolute inset-x-4 z-10 h-[2px] bg-acc', slot === 'top' ? '-top-[7px]' : '-bottom-[7px]')} /> : null}
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenu={skipTextFields}>
          <div
            data-testid="group-header"
            draggable={draggable}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', group.name);
              startDrag({ kind: 'group', key: group.key, order: currentGroupKeys() });
            }}
            onDragEnd={endDrag}
            className={cn('group/header flex h-7 items-center gap-1 pl-4 pr-2', lit && 'ob-selected')}
          >
            {renaming ? (
              <InlineRename
                value={group.name}
                label={group.kind === 'category' ? 'Category name' : 'Group name'}
                onCommit={(v) => void renameGroup(group, v)}
                onDone={p.onRenameDone}
              />
            ) : (
              <button
                type="button"
                data-testid="group-toggle"
                onClick={onToggleClick}
                onDoubleClick={() => {
                  if (pinned) return;
                  clearTimeout(clickTimer.current);
                  p.onRenameStart();
                }}
                onKeyDown={onToggleKey}
                aria-expanded={!p.collapsed}
                title={group.kind === 'folder' ? (group.cwd ?? undefined) : undefined}
                className="ob-cap ob-transition flex min-w-0 flex-1 items-center gap-1 rounded-[2px] text-left hover:text-t2"
              >
                <span className="truncate">{group.name}</span>
                <ChevronRight size={10} aria-hidden className={cn('shrink-0 opacity-0 transition-transform group-hover/header:opacity-100', !p.collapsed && 'rotate-90')} />
              </button>
            )}
            {p.collapsed && !renaming ? <span className="font-mono text-[9.5px] tracking-[0.02em] text-t3">{group.sessions.length}</span> : null}
            {!pinned && !renaming ? (
              <IconButton
                label={group.kind === 'category' ? 'New session in this category' : 'New session in this folder'}
                icon={Plus}
                size="xs"
                className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
                onClick={() => newSessionHere(group)}
              />
            ) : null}
            {!renaming ? (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${group.name}`}
                    data-testid="group-menu-button"
                    className={cn(
                      'ob-transition size-5 shrink-0 items-center justify-center rounded-[2px] text-t3 hover:bg-s3 hover:text-t1',
                      menuOpen ? 'flex' : 'hidden group-hover/header:flex group-focus-within/header:flex',
                    )}
                  >
                    <Ellipsis size={13} aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right" sideOffset={6} data-testid="group-menu">
                  <GroupMenuItems parts={DROPDOWN_PARTS} {...menu} />
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="group-menu">
          <GroupMenuItems parts={CONTEXT_PARTS} {...menu} />
        </ContextMenuContent>
      </ContextMenu>
      {!p.collapsed ? (
        <div className="flex flex-col gap-px">
          {p.children}
          {group.kind === 'category' && !group.sessions.length && !searching ? (
            <div data-testid="group-empty" className="flex h-7 items-center pl-[38px] pr-2 text-[11.5px] text-t3">
              Empty — drag sessions here
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Delete dialogs ─────────────────────────────

/**
 * Deleting a group: a folder group deletes its sessions (after a confirmation naming the count); a category asks
 * whether its sessions stay (back in their folder groups) or go with it. Files on disk are never touched.
 */
export function DeleteGroupDialog({ group, onClose }: { group: SessionGroup | null; onClose: () => void }) {
  const [busy, setBusy] = useState<'keep' | 'delete' | null>(null);
  // Keep the last group while the dialog fades out.
  const last = useRef(group);
  if (group) last.current = group;
  const g = last.current;
  if (!g) return null;
  const n = g.sessions.length;
  const ids = g.sessions.map((s) => s.id);

  if (g.kind === 'folder') {
    return (
      <ConfirmDialog
        open={!!group}
        onOpenChange={(o) => !o && onClose()}
        title={`Delete ${pluralize(n, 'session')}?`}
        description={`Every session in “${truncate(g.name, 40)}” and its transcript will be deleted. The files in the folder are not touched. This can’t be undone.`}
        confirmLabel={`Delete ${pluralize(n, 'session')}`}
        danger
        onConfirm={async () => {
          await deleteSessions(ids);
        }}
      />
    );
  }

  const run = async (deleteSessionsToo: boolean) => {
    setBusy(deleteSessionsToo ? 'delete' : 'keep');
    try {
      if (await deleteCategory(g.categoryId as string, deleteSessionsToo)) onClose();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        size="sm"
        title={`Delete the category “${truncate(g.name, 40)}”?`}
        description={n ? `It holds ${pluralize(n, 'session')}.` : 'It is empty.'}
        footer={
          <>
            <Button variant="ghost" disabled={!!busy} onClick={onClose}>
              Cancel
            </Button>
            {n ? (
              <>
                <Button variant="secondary" autoFocus loading={busy === 'keep'} disabled={!!busy} onClick={() => void run(false)} data-testid="delete-category-keep">
                  Keep sessions
                </Button>
                <Button variant="danger-solid" loading={busy === 'delete'} disabled={!!busy} onClick={() => void run(true)} data-testid="delete-category-all">
                  Delete {pluralize(n, 'session')}
                </Button>
              </>
            ) : (
              <Button variant="danger-solid" autoFocus loading={busy === 'delete'} onClick={() => void run(false)} data-testid="delete-category-all">
                Delete
              </Button>
            )}
          </>
        }
      >
        {n ? (
          <dl className="flex flex-col gap-2 pb-1 text-[11.5px] leading-[1.5] text-t3">
            <div>
              <dt className="inline text-t2">Keep sessions</dt> — they go back to their folder groups.
            </div>
            <div>
              <dt className="inline text-t2">Delete sessions</dt> — they and their transcripts are deleted. Files on disk are not touched.
            </div>
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────── New category ─────────────────────────────

/** "New category": asks for a name, then makes an empty group (and moves a session into it when it was asked for from a session). */
export function NewCategoryDialog() {
  const request = useUi((s) => s.newCategory);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (request) setName('');
  }, [request]);
  const close = () => useUi.setState({ newCategory: null });
  const create = async () => {
    if (!request || !cleanName(name) || busy) return;
    setBusy(true);
    try {
      const key = await createCategory({ name, afterKey: request.afterKey });
      if (key && request.sessionId) await moveSessionToCategory(request.sessionId, categoryIdOf(key));
      if (key) close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && close()}>
      <DialogContent
        size="sm"
        title="New category"
        description="A group of your own. It can hold sessions from any folder."
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!cleanName(name)} onClick={() => void create()} data-testid="new-category-create">
              Create
            </Button>
          </>
        }
      >
        <Input
          ref={input}
          value={name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Category name"
          aria-label="Category name"
          data-testid="new-category-name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
