// Global command palette (Ctrl+K): actions, navigation, sessions, model switcher. Owner: ui-foundation.
import {
  Activity,
  ArrowLeft,
  Box,
  CalendarClock,
  Check,
  Cpu,
  House,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Power,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@renderer/components/ui/badge';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@renderer/components/ui/command';
import { StatusDot } from '@renderer/components/ui/feedback';
import { RelativeTime } from '@renderer/components/ui/time';
import { basename, providerLabel, sameModel } from '@renderer/lib/format';
import {
  closePalette,
  createSession,
  goHome,
  navigate,
  openSession,
  refreshModels,
  switchModel,
  toggleRightPanel,
  toggleSidebar,
} from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useActiveSession, useModelGroups, useRecentSessions } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { useUi } from '@renderer/state/ui';
import { gpuPrimaryAction } from './GpuWidget';
import { SHORTCUTS } from './shortcuts';

type Page = 'root' | 'models' | 'sessions';

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const initialPage = useUi((s) => s.palettePage);
  const [page, setPage] = useState<Page>('root');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      setPage(initialPage);
      setSearch('');
    }
  }, [open, initialPage]);

  const go = (p: Page) => {
    setPage(p);
    setSearch('');
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => (o ? useUi.setState({ paletteOpen: true }) : closePalette())}
      label="Command palette"
      commandProps={{
        onKeyDown: (e) => {
          if (page !== 'root' && e.key === 'Backspace' && !search) {
            e.preventDefault();
            go('root');
          }
        },
      }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        autoFocus
        placeholder={page === 'models' ? 'Switch model…' : page === 'sessions' ? 'Search sessions…' : 'Type a command or search…'}
        leading={
          page !== 'root' ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() => go('root')}
              className="ob-transition -ml-1 flex size-6 items-center justify-center rounded-[5px] text-ob-text-3 hover:bg-ob-hover hover:text-ob-text"
            >
              <ArrowLeft size={15} aria-hidden />
            </button>
          ) : undefined
        }
      />
      <CommandList>
        <CommandEmpty>No matching commands</CommandEmpty>
        {page === 'root' ? <RootPage go={go} /> : null}
        {page === 'models' ? <ModelsPage /> : null}
        {page === 'sessions' ? <SessionsPage limit={200} /> : null}
      </CommandList>
    </CommandDialog>
  );
}

function RootPage({ go }: { go: (p: Page) => void }) {
  const gpu = useGpu((s) => s.status);
  const hasKey = useGpu((s) => s.hasApiKey);
  const active = useActiveSession();
  const gpuOn = !!gpu && gpu.phase !== 'off' && gpu.phase !== 'error';
  const run = (fn: () => void) => () => {
    closePalette();
    fn();
  };
  return (
    <>
      <CommandGroup heading="Actions">
        <CommandItem icon={SquarePen} shortcut={SHORTCUTS.newSession} onSelect={run(() => void createSession())} keywords={['create', 'chat', 'start']}>
          New session
        </CommandItem>
        <CommandItem
          icon={Power}
          onSelect={run(() => void gpuPrimaryAction(gpu, hasKey))}
          keywords={['gpu', 'vast', 'rent', 'clock']}
          hint={gpu?.phase === 'ready' && gpu.gpuName ? gpu.gpuName : undefined}
        >
          {gpuOn ? 'Clock out GPU' : 'Clock in GPU'}
        </CommandItem>
        <CommandItem icon={Box} onSelect={() => go('models')} keywords={['model', 'switch', 'llm']} hint={active ? 'for this session' : 'default model'}>
          Switch model…
        </CommandItem>
        <CommandItem icon={Search} onSelect={() => go('sessions')} keywords={['find', 'open', 'session']}>
          Search sessions…
        </CommandItem>
        <CommandItem icon={PanelLeft} shortcut={SHORTCUTS.sidebar} onSelect={run(() => toggleSidebar())} keywords={['sidebar', 'collapse']}>
          Toggle sidebar
        </CommandItem>
        <CommandItem icon={PanelRight} shortcut={SHORTCUTS.rightPanel} onSelect={run(() => toggleRightPanel())} keywords={['panel', 'changes', 'todos']}>
          Toggle side panel
        </CommandItem>
        <CommandItem icon={RefreshCw} onSelect={run(() => void refreshModels())} keywords={['reload', 'providers']}>
          Refresh models
        </CommandItem>
      </CommandGroup>
      <CommandGroup heading="Go to">
        <CommandItem icon={House} onSelect={run(goHome)}>
          Home
        </CommandItem>
        <CommandItem icon={CalendarClock} onSelect={run(() => navigate('schedules'))} keywords={['schedule', 'cron']}>
          Scheduled tasks
        </CommandItem>
        <CommandItem icon={Activity} onSelect={run(() => navigate('activity'))} keywords={['oversight', 'running']}>
          Activity
        </CommandItem>
        <CommandItem icon={Cpu} onSelect={run(() => navigate('gpu'))} keywords={['vast', 'gpu']}>
          GPU
        </CommandItem>
        <CommandItem icon={Settings} shortcut={SHORTCUTS.settings} onSelect={run(() => navigate('settings'))} keywords={['preferences']}>
          Settings
        </CommandItem>
      </CommandGroup>
      <SessionsPage limit={6} heading="Recent sessions" />
    </>
  );
}

function SessionsPage({ limit, heading = 'Sessions' }: { limit: number; heading?: string }) {
  const sessions = useRecentSessions(limit);
  if (!sessions.length) return null;
  return (
    <CommandGroup heading={heading}>
      {sessions.map((s) => (
        <CommandItem
          key={s.id}
          value={`session ${s.id} ${s.title}`}
          keywords={[basename(s.cwd)]}
          icon={MessageSquare}
          hint={basename(s.cwd)}
          trailing={<RelativeTime ts={s.updatedAt} className="w-14 text-right font-mono text-[10.5px] text-ob-text-3" />}
          onSelect={() => openSession(s.id)}
        >
          {s.title || 'Untitled'}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function ModelsPage() {
  const groups = useModelGroups();
  const active = useActiveSession();
  const route = useUi((s) => s.route);
  const defaultModel = useSettings((s) => s.settings?.defaultModel ?? null);
  const current = route === 'session' && active ? active.model : defaultModel;
  if (!groups.length) {
    return <div className="px-3 py-8 text-center text-ui text-ob-text-3">No models available — check Settings → Models.</div>;
  }
  return (
    <>
      {groups.map((g) => (
        <CommandGroup key={g.provider.id} heading={g.provider.label || providerLabel(g.provider.id)}>
          {g.models.map((m) => (
            <CommandItem
              key={`${m.ref.provider}::${m.ref.model}`}
              value={`model ${m.ref.provider} ${m.ref.model} ${m.label}`}
              disabled={m.status === 'offline'}
              leading={<StatusDot status={m.status} />}
              hint={m.ref.model !== m.label ? m.ref.model : undefined}
              trailing={
                <span className="flex items-center gap-1.5">
                  {m.variant ? (
                    <Badge tone={m.variant === 'uncensored' ? 'violet' : 'neutral'} mono>
                      {m.variant}
                    </Badge>
                  ) : null}
                  {sameModel(current, m.ref) ? <Check size={14} aria-label="Current" className="text-ob-accent" /> : <span className="w-3.5" />}
                </span>
              }
              onSelect={() => {
                closePalette();
                void switchModel(m.ref);
              }}
            >
              {m.label}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  );
}
