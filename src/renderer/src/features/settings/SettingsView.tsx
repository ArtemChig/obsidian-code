// Settings view: sections nav + one section at a time. Changes save through settings.update; secrets are write-only. Owner: ui-views.
import { Braces, Brain, Cpu, Globe, Info, Plug, Search, ShieldCheck, SlidersHorizontal, Terminal, Webhook, Boxes, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@renderer/components/ui/feedback';
import { Input } from '@renderer/components/ui/input';
import { cn } from '@renderer/lib/cn';
import { useConnection } from '@renderer/state/connection';
import { useSettings } from '@renderer/state/settings';
import { useUi } from '@renderer/state/ui';
import { SettingsHeaderSlot } from './components';
import { CoreMissing, SyncFailed, useCoreMissing, useSyncError } from './core-missing';
import { ModelsSection } from './sections/ModelsSection';
import { AboutSection, ContextSection, GeneralSection, HooksSection, McpSection, MemorySection, SearchSection, ShellSection } from './sections/OtherSections';
import { PermissionsSection } from './sections/PermissionsSection';
import { VastSection } from './sections/VastSection';

export type SettingsSectionId = 'models' | 'vast' | 'permissions' | 'search' | 'mcp' | 'hooks' | 'memory' | 'shell' | 'context' | 'general' | 'about';

/** Nav groups (reference .s6-nav: mono cap group labels). */
const NAV_GROUPS = ['Models', 'Agent', 'System'] as const;

interface NavItem {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  group: (typeof NAV_GROUPS)[number];
  /** Extra words the settings search matches. */
  keywords: string;
}

export const SETTINGS_SECTIONS: NavItem[] = [
  { id: 'models', label: 'Models & providers', icon: Boxes, group: 'Models', keywords: 'llama local endpoint openai provider api key default model' },
  { id: 'vast', label: 'Vast.ai', icon: Cpu, group: 'Models', keywords: 'gpu rent budget idle heartbeat park profiles api key clock' },
  { id: 'context', label: 'Context', icon: Braces, group: 'Models', keywords: 'compact tokens window output trim' },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck, group: 'Agent', keywords: 'allow deny rules mode bypass plan' },
  { id: 'search', label: 'Web search', icon: Globe, group: 'Agent', keywords: 'searxng brave tavily websearch webfetch' },
  { id: 'mcp', label: 'MCP servers', icon: Plug, group: 'Agent', keywords: 'model context protocol tools json' },
  { id: 'hooks', label: 'Hooks', icon: Webhook, group: 'Agent', keywords: 'pre post tool use json' },
  { id: 'shell', label: 'Shell', icon: Terminal, group: 'Agent', keywords: 'bash powershell git cmd' },
  { id: 'memory', label: 'Memory & import', icon: Brain, group: 'System', keywords: 'claude.md instructions skills import' },
  { id: 'general', label: 'General', icon: SlidersHorizontal, group: 'System', keywords: 'folder notifications startup appearance' },
  { id: 'about', label: 'About & updates', icon: Info, group: 'System', keywords: 'version platform data folder update upgrade release github token changelog' },
];

/** Other areas call openSettings('vast') etc.; accept a few aliases. */
const ALIASES: Record<string, SettingsSectionId> = {
  providers: 'models',
  model: 'models',
  gpu: 'vast',
  'vast.ai': 'vast',
  permission: 'permissions',
  websearch: 'search',
  'web-search': 'search',
  memory: 'memory',
  import: 'memory',
  notifications: 'general',
  startup: 'general',
  appearance: 'general',
  version: 'about',
  update: 'about',
  updates: 'about',
};

export function resolveSection(raw: string | null | undefined): SettingsSectionId {
  if (!raw) return 'models';
  const key = raw.toLowerCase();
  if (SETTINGS_SECTIONS.some((s) => s.id === key)) return key as SettingsSectionId;
  return ALIASES[key] ?? 'models';
}

function SectionBody({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case 'models':
      return <ModelsSection />;
    case 'vast':
      return <VastSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'search':
      return <SearchSection />;
    case 'mcp':
      return <McpSection />;
    case 'hooks':
      return <HooksSection />;
    case 'memory':
      return <MemorySection />;
    case 'shell':
      return <ShellSection />;
    case 'context':
      return <ContextSection />;
    case 'general':
      return <GeneralSection />;
    case 'about':
      return <AboutSection />;
  }
}

export function SettingsView() {
  const requested = useUi((s) => s.settingsSection);
  const loaded = useSettings((s) => s.settings !== null);
  const version = useSettings((s) => s.system?.version);
  const mode = useConnection((c) => c.mode);
  const coreMissing = useCoreMissing();
  const syncError = useSyncError('settings');
  const active = resolveSection(requested);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');

  // Keep the store pointing at a real section id so a later openSettings() round-trips.
  useEffect(() => {
    if (requested && requested !== active) useUi.setState({ settingsSection: active });
  }, [requested, active]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? SETTINGS_SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(q)) : SETTINGS_SECTIONS), [q]);
  const open = (id: SettingsSectionId) => useUi.setState({ settingsSection: id });

  return (
    <div className="flex h-full min-h-0" data-testid="settings-view" data-section={active}>
      <nav aria-label="Settings sections" className="flex w-[216px] shrink-0 flex-col overflow-y-auto shadow-[inset_-1px_0_0_var(--rule)]" data-testid="settings-nav">
        <h1 className="sr-only">Settings</h1>
        <div className="flex flex-col pb-2 pt-4">
          {NAV_GROUPS.map((g, gi) => {
            const items = matches.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="flex flex-col">
                {gi > 0 && matches.some((s) => NAV_GROUPS.indexOf(s.group) < gi) ? <div aria-hidden className="mx-4 my-3 h-px bg-rule2" /> : null}
                <div className="ob-cap px-4 pb-[11px]">{g}</div>
                {items.map((s) => {
                  const Icon = s.icon;
                  const on = s.id === active;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      data-testid={`settings-nav-${s.id}`}
                      aria-current={on ? 'page' : undefined}
                      onClick={() => open(s.id)}
                      className={cn(
                        'ob-transition flex h-[29px] shrink-0 items-center gap-[9px] px-4 text-left text-[12px] tracking-[-0.012em] outline-offset-[-2px]',
                        on ? 'ob-nav-on' : 'text-t2 hover:bg-hov hover:text-t1',
                      )}
                    >
                      <Icon size={13} aria-hidden className={cn('shrink-0', on ? 'text-acc' : 'text-t3')} />
                      <span className="truncate">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {matches.length === 0 ? <div className="px-4 py-2 text-[11.5px] text-t3">No section matches “{query.trim()}”.</div> : null}
        </div>
        <dl className="mt-auto border-t border-rule2 px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-2 py-[3px]">
            <dt className="text-[11px] text-t3">Version</dt>
            <dd className="ob-tabular font-mono text-[11px] tracking-[-0.02em] text-t1">{version ?? '—'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2 py-[3px]">
            <dt className="text-[11px] text-t3">Core</dt>
            <dd className="font-mono text-[11px] tracking-[-0.02em] text-t1">{mode === 'demo' ? 'demo' : mode === 'core' ? 'connected' : 'offline'}</dd>
          </div>
        </dl>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* reference .s6-hd: the section title + description (portalled in by <Section>), then the search field */}
        <header className="flex min-h-14 shrink-0 items-center gap-4 border-b border-rule px-6 py-2">
          <div ref={setSlot} className="@container flex min-w-0 flex-1 items-center" />
          <Input
            size="md"
            icon={Search}
            aria-label="Search settings"
            data-testid="settings-filter"
            placeholder="Search settings"
            wrapperClassName="w-[200px] shrink-0"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) open(matches[0].id);
              if (e.key === 'Escape') setQuery('');
            }}
          />
        </header>
        <div className="min-w-0 flex-1 overflow-y-auto" data-testid="settings-scroll">
          <div className="w-full max-w-[880px] px-6 pb-16 pt-1">
            {loaded ? (
              <SettingsHeaderSlot.Provider value={slot}>
                <SectionBody key={active} id={active} />
              </SettingsHeaderSlot.Provider>
            ) : coreMissing ? (
              <CoreMissing what="Settings" />
            ) : syncError ? (
              <SyncFailed what="settings" error={syncError} />
            ) : (
              <div className="flex flex-col gap-3 pt-5" aria-hidden>
                <Skeleton className="h-2.5 w-24" />
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center justify-between gap-6 border-b border-rule2 py-3">
                    <div className="flex flex-col gap-2">
                      <Skeleton className="h-3 w-48" />
                      <Skeleton className="h-2.5 w-72" />
                    </div>
                    <Skeleton className="h-7 w-32" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
