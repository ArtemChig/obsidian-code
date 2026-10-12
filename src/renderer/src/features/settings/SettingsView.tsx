// Settings view: sections nav + one section at a time. Changes save through settings.update; secrets are write-only. Owner: ui-views.
import { Braces, Brain, Cpu, Globe, Info, Plug, ShieldCheck, SlidersHorizontal, Terminal, Webhook, Boxes, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Skeleton } from '@renderer/components/ui/feedback';
import { cn } from '@renderer/lib/cn';
import { useSettings } from '@renderer/state/settings';
import { useUi } from '@renderer/state/ui';
import { CoreMissing, useCoreMissing } from './core-missing';
import { ModelsSection } from './sections/ModelsSection';
import { AboutSection, ContextSection, GeneralSection, HooksSection, McpSection, MemorySection, SearchSection, ShellSection } from './sections/OtherSections';
import { PermissionsSection } from './sections/PermissionsSection';
import { VastSection } from './sections/VastSection';

export type SettingsSectionId = 'models' | 'vast' | 'permissions' | 'search' | 'mcp' | 'hooks' | 'memory' | 'shell' | 'context' | 'general' | 'about';

interface NavItem {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: NavItem[] = [
  { id: 'models', label: 'Models & providers', icon: Boxes },
  { id: 'vast', label: 'Vast.ai', icon: Cpu },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'search', label: 'Web search', icon: Globe },
  { id: 'mcp', label: 'MCP servers', icon: Plug },
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  { id: 'memory', label: 'Memory & import', icon: Brain },
  { id: 'shell', label: 'Shell', icon: Terminal },
  { id: 'context', label: 'Context', icon: Braces },
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'about', label: 'About', icon: Info },
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
  const coreMissing = useCoreMissing();
  const active = resolveSection(requested);

  // Keep the store pointing at a real section id so a later openSettings() round-trips.
  useEffect(() => {
    if (requested && requested !== active) useUi.setState({ settingsSection: active });
  }, [requested, active]);

  return (
    <div className="flex h-full min-h-0" data-testid="settings-view" data-section={active}>
      <nav aria-label="Settings sections" className="flex w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-ob-border px-3 py-6" data-testid="settings-nav">
        <h1 className="mb-3 px-2 text-title font-semibold leading-7 text-ob-text">Settings</h1>
        {SETTINGS_SECTIONS.map((s) => {
          const Icon = s.icon;
          const on = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              data-testid={`settings-nav-${s.id}`}
              aria-current={on ? 'page' : undefined}
              onClick={() => useUi.setState({ settingsSection: s.id })}
              className={cn(
                'ob-transition flex h-8 items-center gap-2.5 rounded-[6px] px-2 text-left text-ui outline-offset-[-2px]',
                on ? 'bg-ob-accent-soft font-medium text-ob-text' : 'text-ob-text-2 hover:bg-ob-hover hover:text-ob-text',
              )}
            >
              <Icon size={15} aria-hidden className={on ? 'text-ob-accent' : 'text-ob-text-3'} />
              <span className="truncate">{s.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto" data-testid="settings-scroll">
        <div className="mx-auto w-full max-w-[760px] px-8 pb-16 pt-7">
          {loaded ? (
            <SectionBody key={active} id={active} />
          ) : coreMissing ? (
            <CoreMissing what="Settings" />
          ) : (
            <div className="flex flex-col gap-4" aria-hidden>
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-4 w-96" />
              <Skeleton className="h-40 w-full rounded-card" />
              <Skeleton className="h-40 w-full rounded-card" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

