// Menu strip (27 px) under the title bar — reference .mbar: text menus in --t2 (open menu --t1 on --s3) wired to the
// existing actions, plus right-aligned mono hints that double as buttons. Hovering across the strip while a menu is
// open switches menus, and ←/→ inside an open menu moves to the neighbour (menubar behaviour). Owner: ui-foundation.
import {
  ClipboardCopy,
  Cpu,
  Download,
  FolderOpen,
  Info,
  Keyboard,
  LogOut,
  Minimize2,
  PanelLeft,
  PanelRight,
  Power,
  RefreshCw,
  Search,
  Settings,
  Square,
  SquarePen,
  Undo2,
} from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/menu';
import { shortcutParts } from '@renderer/components/ui/kbd';
import { getBridge, isElectron, pickFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { copySessionMarkdown, exportSessionMarkdown } from '@renderer/features/chat/session-actions';
import { insertIntoComposer, stopTurn } from '@renderer/features/chat/state';
import { createSession, navigate, openPalette, openSettings, sendMessage, setPermissionMode, toggleRightPanel, toggleSidebar } from '@renderer/state/actions';
import { GPU_BUSY_PHASES, useGpu } from '@renderer/state/gpu';
import { useActiveSession } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { toast } from '@renderer/state/toasts';
import { useUi } from '@renderer/state/ui';
import { checkForUpdates, useUpdates } from '@renderer/state/updates';
import { gpuPrimaryAction } from './GpuWidget';
import { SHORTCUTS } from './shortcuts';
import { UpdateButton } from './UpdateButton';

/** Help → Check for updates: says what it found (the UPDATE button appears by itself when there is one). */
async function checkNow(): Promise<void> {
  const s = await checkForUpdates();
  if (!s) return;
  const st = s.state;
  if (st.status === 'available') toast({ title: `Version ${st.version} is available`, body: 'Click UPDATE in the menu bar to install it.', level: 'info' });
  else if (st.status === 'not-available') toast({ title: 'Obsidian Code is up to date', body: `Version ${s.currentVersion}`, level: 'success', durationMs: 2500 });
  else if (st.status === 'error') toast({ title: 'Update check failed', body: st.message, level: 'error' });
}

const MENUS = ['file', 'view', 'session', 'gpu', 'help'] as const;
type MenuId = (typeof MENUS)[number];
const LABELS: Record<MenuId, string> = { file: 'File', view: 'View', session: 'Session', gpu: 'GPU', help: 'Help' };

/** A right-aligned strip hint: "LABEL [Ctrl K]" (reference .mright). */
function Hint({ label, keys, onClick, testId }: { label: string; keys: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="ob-transition group flex h-5 items-center gap-2 rounded-[2px] px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-t3 hover:text-t1"
    >
      {label}
      <span className="rounded-[2px] px-[5px] py-[2px] normal-case leading-none tracking-[0.05em] text-t2 shadow-[inset_0_0_0_1px_var(--rule)] group-hover:text-t1 group-hover:shadow-[inset_0_0_0_1px_var(--line)]">
        {shortcutParts(keys).join(' ')}
      </span>
    </button>
  );
}

function Menu({
  id,
  open,
  setOpen,
  children,
  width = 236,
}: {
  id: MenuId;
  open: MenuId | null;
  setOpen: (fn: (cur: MenuId | null) => MenuId | null) => void;
  children: ReactNode;
  width?: number;
}) {
  const isOpen = open === id;
  const step = (dir: 1 | -1) => setOpen(() => MENUS[(MENUS.indexOf(id) + dir + MENUS.length) % MENUS.length]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    }
  };
  return (
    <DropdownMenu modal={false} open={isOpen} onOpenChange={(o) => setOpen((cur) => (o ? id : cur === id ? null : cur))}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={`menu-${id}`}
          onPointerEnter={() => setOpen((cur) => (cur && cur !== id ? id : cur))}
          className={cn(
            'ob-transition h-[19px] rounded-[2px] px-[9px] text-[11.5px] leading-[19px] tracking-[-0.008em] outline-offset-0',
            isOpen ? 'bg-s3 text-t1' : 'text-t2 hover:text-t1',
          )}
        >
          {LABELS[id]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent sideOffset={4} onKeyDown={onKeyDown} style={{ minWidth: width }} onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MenuBar() {
  const [open, setOpenState] = useState<MenuId | null>(null);
  const setOpen = (fn: (cur: MenuId | null) => MenuId | null) => setOpenState(fn);
  const route = useUi((s) => s.route);
  const active = useActiveSession();
  const session = route === 'session' ? active : undefined;
  const busy = session?.status === 'running' || session?.status === 'waiting';
  const gpu = useGpu((s) => s.status);
  const hasKey = useGpu((s) => s.hasApiKey);
  const system = useSettings((s) => s.system);
  const phase = gpu?.phase ?? 'off';
  const gpuOn = phase !== 'off' && phase !== 'error';
  const electron = isElectron();
  const updatesOn = useUpdates((s) => s.snapshot !== null && s.snapshot.state.status !== 'unsupported');

  return (
    <nav aria-label="Application menu" data-testid="menubar" className="flex h-[var(--ob-menubar-h)] shrink-0 items-center gap-px border-b border-rule px-2">
      <Menu id="file" open={open} setOpen={setOpen}>
        <DropdownMenuItem icon={SquarePen} shortcut={SHORTCUTS.newSession} onSelect={() => void createSession()}>
          New session
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={FolderOpen}
          onSelect={async () => {
            const dir = await pickFolder();
            if (dir) await createSession({ cwd: dir });
          }}
        >
          Open folder…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={Settings} shortcut={SHORTCUTS.settings} onSelect={() => openSettings()}>
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={LogOut} disabled={!electron} hint={electron ? undefined : 'desktop app'} onSelect={() => getBridge()?.window?.close?.()}>
          Quit
        </DropdownMenuItem>
      </Menu>

      <Menu id="view" open={open} setOpen={setOpen}>
        <DropdownMenuItem icon={PanelLeft} shortcut={SHORTCUTS.sidebar} onSelect={() => toggleSidebar()}>
          Toggle sidebar
        </DropdownMenuItem>
        <DropdownMenuItem icon={PanelRight} shortcut={SHORTCUTS.rightPanel} disabled={!session} onSelect={() => toggleRightPanel()}>
          Toggle side panel
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={Search} shortcut={SHORTCUTS.palette} onSelect={() => openPalette()}>
          Command palette
        </DropdownMenuItem>
        <DropdownMenuItem icon={Keyboard} shortcut={SHORTCUTS.help} onSelect={() => useUi.setState({ shortcutsOpen: true })}>
          Keyboard shortcuts
        </DropdownMenuItem>
      </Menu>

      <Menu id="session" open={open} setOpen={setOpen} width={248}>
        {!session ? <DropdownMenuLabel>No session open</DropdownMenuLabel> : null}
        <DropdownMenuItem icon={Square} shortcut="Esc" disabled={!session || !busy} onSelect={() => session && void stopTurn(session.id)}>
          Stop
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          disabled={!session}
          checked={session?.permissionMode === 'plan'}
          onCheckedChange={(on) => session && void setPermissionMode(session.id, on ? 'plan' : 'default')}
        >
          Plan mode
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem icon={Minimize2} disabled={!session} hint="/compact" onSelect={() => session && void sendMessage(session.id, '/compact')}>
          Compact
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={Download} disabled={!session} onSelect={() => session && void exportSessionMarkdown(session.id)}>
          Export as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem icon={ClipboardCopy} disabled={!session} onSelect={() => session && void copySessionMarkdown(session.id)}>
          Copy as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem icon={Undo2} disabled={!session || busy} hint="/rewind" onSelect={() => session && insertIntoComposer(session.id, '/rewind')}>
          Rewind…
        </DropdownMenuItem>
      </Menu>

      <Menu id="gpu" open={open} setOpen={setOpen}>
        <DropdownMenuItem icon={Power} danger={gpuOn} onSelect={() => void gpuPrimaryAction(gpu, hasKey)} disabled={phase === 'stopping'}>
          {gpuOn ? (GPU_BUSY_PHASES.has(phase) ? 'Cancel clock-in' : 'Clock out') : 'Clock in'}
        </DropdownMenuItem>
        <DropdownMenuItem icon={Cpu} onSelect={() => navigate('gpu')}>
          Open GPU view
        </DropdownMenuItem>
      </Menu>

      <Menu id="help" open={open} setOpen={setOpen}>
        <DropdownMenuItem icon={Keyboard} shortcut={SHORTCUTS.help} onSelect={() => useUi.setState({ shortcutsOpen: true })}>
          Keyboard shortcuts
        </DropdownMenuItem>
        {updatesOn ? (
          <DropdownMenuItem icon={RefreshCw} onSelect={() => void checkNow()}>
            Check for updates
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon={Info} hint={system?.version ? `v${system.version}` : undefined} onSelect={() => openSettings('about')}>
          About &amp; updates
        </DropdownMenuItem>
      </Menu>

      <div className="ml-auto flex items-center gap-3 pr-[5px]">
        <UpdateButton />
        <Hint label="New session" keys={SHORTCUTS.newSession} onClick={() => void createSession()} />
        <Hint label="Command" keys={SHORTCUTS.palette} onClick={() => openPalette()} testId="palette-trigger" />
      </div>
    </nav>
  );
}
