// Settings: Web search, MCP, Hooks, Memory & import, Shell, Context, General, About. Owner: ui-views.
import { Copy, ExternalLink, FolderOpen } from 'lucide-react';
import type { Settings } from '@shared/types';
import { AppMark } from '@renderer/components/ui/app-mark';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Select } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/toggles';
import { canRevealFiles, isElectron, openPath, pickFolder, showItemInFolder } from '@renderer/lib/bridge';
import { useConnection } from '@renderer/state/connection';
import { useSettings } from '@renderer/state/settings';
import { toast } from '@renderer/state/toasts';
import { Group, JsonEditor, NumberField, Row, SecretField, Section, TextField, patchSearch, saveSettings } from '../components';
import { HOOKS_EXAMPLE, MCP_EXAMPLE, validateHooks, validateMcpServers, validateUrl } from '../validate';

// ───────────────────────────── Web search ─────────────────────────────

const SEARCH_PROVIDERS: { value: Settings['search']['provider']; label: string; description: string }[] = [
  { value: 'duckduckgo', label: 'DuckDuckGo', description: 'No key needed. HTML results, good enough for most lookups.' },
  { value: 'brave', label: 'Brave Search', description: 'Needs an API key. Cleaner results with snippets.' },
  { value: 'tavily', label: 'Tavily', description: 'Needs an API key. Built for AI agents.' },
  { value: 'searxng', label: 'SearXNG', description: 'Your own instance. Private, no key.' },
];

export function SearchSection() {
  const search = useSettings((s) => s.settings?.search);
  if (!search) return null;
  const info = SEARCH_PROVIDERS.find((p) => p.value === search.provider);
  return (
    <Section id="search" title="Web search" description="What the WebSearch tool uses. WebFetch (opening a URL) needs no setup.">
      <Group testId="settings-search">
        <Row label="Search provider" htmlFor="search-provider" description={info?.description}>
          <Select
            id="search-provider"
            aria-label="Search provider"
            value={search.provider}
            className="w-[220px]"
            align="end"
            options={SEARCH_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            onValueChange={(v) => void patchSearch({ provider: v as Settings['search']['provider'] }, 'Search provider saved')}
          />
        </Row>
        {search.provider === 'brave' ? (
          <Row stacked label="Brave Search API key" description="From api.search.brave.com. Stored encrypted, never shown again.">
            <SecretField name="search.braveKey" testId="secret-brave" placeholder="Paste your Brave API key…" />
          </Row>
        ) : null}
        {search.provider === 'tavily' ? (
          <Row stacked label="Tavily API key" description="From app.tavily.com. Stored encrypted, never shown again.">
            <SecretField name="search.tavilyKey" testId="secret-tavily" placeholder="tvly-…" />
          </Row>
        ) : null}
        {search.provider === 'searxng' ? (
          <Row stacked label="SearXNG URL" htmlFor="searxng-url" description="The instance must have the JSON format enabled (search.formats in settings.yml).">
            <TextField id="searxng-url" testId="searxng-url" mono value={search.searxngUrl ?? ''} placeholder="http://127.0.0.1:8888" validate={(v) => validateUrl(v)} onCommit={(v) => patchSearch({ searxngUrl: v })} />
          </Row>
        ) : null}
      </Group>
    </Section>
  );
}

// ───────────────────────────── MCP servers ─────────────────────────────

export function McpSection() {
  const servers = useSettings((s) => s.settings?.mcpServers);
  if (!servers) return null;
  return (
    <Section id="mcp" title="MCP servers" description="Model Context Protocol servers add tools for the agent. They connect when you save, and their tools show up as mcp__server__tool.">
      <Group flush testId="settings-mcp">
        <div className="p-4">
          <JsonEditor<Settings['mcpServers']>
            testId="mcp-json"
            value={servers}
            example={MCP_EXAMPLE}
            minRows={12}
            validate={validateMcpServers}
            onApply={(v) => saveSettings({ mcpServers: v }, 'MCP servers saved')}
            hint={
              <>
                An object of servers. Local servers use <code className="font-mono text-[11px] text-ob-text-2">command</code> and <code className="font-mono text-[11px] text-ob-text-2">args</code>; remote ones use{' '}
                <code className="font-mono text-[11px] text-ob-text-2">"type": "http"</code> and a <code className="font-mono text-[11px] text-ob-text-2">url</code>. Every MCP tool asks before it runs. Windows paths need doubled backslashes.
              </>
            }
          />
        </div>
      </Group>
    </Section>
  );
}

// ───────────────────────────── Hooks ─────────────────────────────

export function HooksSection() {
  const hooks = useSettings((s) => s.settings?.hooks);
  if (!hooks) return null;
  return (
    <Section id="hooks" title="Hooks" description="Shell commands that run at points in a session. The command receives a JSON payload on stdin; exit code 2 blocks the action and shows stderr to the agent.">
      <Group flush testId="settings-hooks">
        <div className="p-4">
          <JsonEditor<Settings['hooks']>
            testId="hooks-json"
            value={hooks}
            example={HOOKS_EXAMPLE}
            minRows={12}
            validate={validateHooks}
            onApply={(v) => saveSettings({ hooks: v }, 'Hooks saved')}
            hint={
              <>
                Events: <code className="font-mono text-[11px] text-ob-text-2">UserPromptSubmit</code>, <code className="font-mono text-[11px] text-ob-text-2">PreToolUse</code> (can block), <code className="font-mono text-[11px] text-ob-text-2">PostToolUse</code>,{' '}
                <code className="font-mono text-[11px] text-ob-text-2">Stop</code>, <code className="font-mono text-[11px] text-ob-text-2">SessionStart</code>. Each hook: <code className="font-mono text-[11px] text-ob-text-2">command</code>, optional{' '}
                <code className="font-mono text-[11px] text-ob-text-2">matcher</code> (tool name) and <code className="font-mono text-[11px] text-ob-text-2">timeoutMs</code>.
              </>
            }
          />
        </div>
      </Group>
    </Section>
  );
}

// ───────────────────────────── Memory & import ─────────────────────────────

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast({ title: `${what} copied`, level: 'success', durationMs: 1500 }),
    () => toast({ title: 'Could not copy', level: 'error' }),
  );
}

export function MemorySection() {
  const settings = useSettings((s) => s.settings);
  const system = useSettings((s) => s.system);
  if (!settings) return null;
  const home = system?.homeDir ?? '';
  const sep = home.includes('/') && !home.includes('\\') ? '/' : '\\';
  const memoryPath = home ? `${home}${sep}.obsidian-code${sep}OBSIDIAN.md` : '';
  return (
    <Section id="memory" title="Memory & import" description="Instructions the agent reads at the start of every session, and whether it also reads your Claude Code setup.">
      <Group testId="settings-memory">
        <Row label="Import my Claude Code setup" description="Also read CLAUDE.md, skills, agents, commands and permission rules from ~/.claude and each project's .claude folder.">
          <Switch aria-label="Import my Claude Code setup" checked={settings.importClaudeConfig} onCheckedChange={(v) => void saveSettings({ importClaudeConfig: v }, v ? 'Claude import on' : 'Claude import off')} />
        </Row>
        <Row stacked label="Your memory file" description="Instructions that apply to every project. Create it if it does not exist yet; changes take effect in the next session.">
          <div className="flex flex-col gap-2.5">
            <code className="ob-selectable block truncate rounded-ctl border border-ob-border bg-ob-code-bg px-3 py-2 font-mono text-[12px] text-ob-text-2" title={memoryPath} data-testid="memory-path">
              {memoryPath || 'Unknown (not connected)'}
            </code>
            <div className="flex flex-wrap items-center gap-2">
              {isElectron() ? (
                <Button variant="secondary" icon={ExternalLink} disabled={!memoryPath} data-testid="memory-open" onClick={() => openPath(memoryPath)}>
                  Open file
                </Button>
              ) : null}
              {canRevealFiles() ? (
                <Button variant="ghost" icon={FolderOpen} disabled={!memoryPath} onClick={() => showItemInFolder(memoryPath)}>
                  Show in folder
                </Button>
              ) : null}
              <Button variant="ghost" icon={Copy} disabled={!memoryPath} data-testid="memory-copy" onClick={() => copy(memoryPath, 'Path')}>
                Copy path
              </Button>
            </div>
          </div>
        </Row>
        <Row stacked label="Where it looks" description="In order, from the project folder upwards, then your home folder.">
          <ul className="flex flex-col gap-1.5 text-small text-ob-text-2">
            {['OBSIDIAN.md', 'CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', '~/.obsidian-code/OBSIDIAN.md', settings.importClaudeConfig ? '~/.claude/CLAUDE.md' : null].filter(Boolean).map((f) => (
              <li key={f as string} className="flex items-center gap-2">
                <span className="size-1 rounded-full bg-ob-text-3" aria-hidden />
                <code className="font-mono text-[11.5px]">{f}</code>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-small text-ob-text-3">
            Start a message with <code className="font-mono text-[11px] text-ob-text-2">#</code> to add a note to the project's memory file.
          </p>
        </Row>
      </Group>
    </Section>
  );
}

// ───────────────────────────── Shell ─────────────────────────────

const SHELLS: { value: Settings['shell']; label: string; description: string }[] = [
  { value: 'auto', label: 'Automatic', description: 'Git Bash if installed, otherwise PowerShell.' },
  { value: 'git-bash', label: 'Git Bash', description: 'POSIX commands (ls, grep, sed). Best match for what models expect.' },
  { value: 'powershell', label: 'PowerShell', description: 'Native Windows scripting.' },
  { value: 'cmd', label: 'Command Prompt', description: 'Legacy cmd.exe.' },
];

export function ShellSection() {
  const shell = useSettings((s) => s.settings?.shell);
  const detected = useSettings((s) => s.system?.shell);
  if (!shell) return null;
  const info = SHELLS.find((s) => s.value === shell);
  return (
    <Section id="shell" title="Shell" description="Which shell the Bash tool runs commands in.">
      <Group testId="settings-shell">
        <Row label="Shell for commands" htmlFor="shell-select" description={info?.description}>
          <Select
            id="shell-select"
            aria-label="Shell"
            value={shell}
            className="w-[220px]"
            align="end"
            options={SHELLS.map((s) => ({ value: s.value, label: s.label }))}
            onValueChange={(v) => void saveSettings({ shell: v as Settings['shell'] }, 'Shell saved')}
          />
        </Row>
        <Row label="Detected" description="What “Automatic” resolves to on this PC.">
          <code className="ob-selectable max-w-[320px] truncate font-mono text-[11.5px] text-ob-text-2" title={detected} data-testid="shell-detected">
            {detected ?? 'unknown'}
          </code>
        </Row>
      </Group>
    </Section>
  );
}

// ───────────────────────────── Context ─────────────────────────────

export function ContextSection() {
  const s = useSettings((x) => x.settings);
  if (!s) return null;
  return (
    <Section id="context" title="Context" description="The local model has a limited context window (and ~20 tokens/s), so long sessions are compacted and tool output is trimmed.">
      <Group testId="settings-context">
        <Row label="Auto-compact at" htmlFor="ctx-compact" description="When a request fills this share of the model's context window, older messages are summarised and the last two turns are kept.">
          <NumberField id="ctx-compact" testId="ctx-compact" value={s.autoCompactPercent} min={10} max={95} integer unit="%" onCommit={(n) => saveSettings({ autoCompactPercent: n })} />
        </Row>
        <Row label="Longest tool output" htmlFor="ctx-output" description="Longer results from a command or file read are cut to this many characters, with a note, before the model sees them.">
          <NumberField id="ctx-output" testId="ctx-output" value={s.maxToolOutputChars} min={1000} max={500000} integer unit="chars" width="w-[104px]" onCommit={(n) => saveSettings({ maxToolOutputChars: n })} />
        </Row>
      </Group>
    </Section>
  );
}

// ───────────────────────────── General (notifications, startup) ─────────────────────────────

export function GeneralSection() {
  const s = useSettings((x) => x.settings);
  const system = useSettings((x) => x.system);
  if (!s) return null;
  return (
    <Section id="general" title="General" description="Folders, notifications and startup.">
      <Group testId="settings-general">
        <Row stacked label="Default folder" htmlFor="default-cwd" description="Where new sessions start when you do not pick a folder.">
          <TextField
            id="default-cwd"
            testId="default-cwd"
            mono
            value={s.defaultCwd}
            placeholder="C:\Projects"
            onCommit={(v) => saveSettings({ defaultCwd: v })}
            trailing={
              <Button
                variant="secondary"
                icon={FolderOpen}
                data-testid="default-cwd-browse"
                onClick={async () => {
                  const dir = await pickFolder(s.defaultCwd || undefined);
                  if (dir) await saveSettings({ defaultCwd: dir });
                }}
              >
                Browse
              </Button>
            }
          />
        </Row>
        <Row label="Notifications" description="Desktop notifications while the app is in the background: the agent needs you, a long task finished or failed, a scheduled run ended, and GPU events (ready, clocked out, budget reached).">
          <Switch aria-label="Notifications" checked={s.notifications} onCheckedChange={(v) => void saveSettings({ notifications: v })} />
        </Row>
        <Row label="Launch at login" description={system && !system.electron ? 'Only available in the desktop app.' : 'Start Obsidian Code in the tray when you sign in, so scheduled tasks keep running.'}>
          <Switch aria-label="Launch at login" checked={s.launchAtLogin} disabled={!!system && !system.electron} onCheckedChange={(v) => void saveSettings({ launchAtLogin: v })} />
        </Row>
      </Group>
    </Section>
  );
}

// ───────────────────────────── About ─────────────────────────────

export function AboutSection() {
  const system = useSettings((s) => s.system);
  const mode = useConnection((c) => c.mode);
  const rows: [string, string | undefined][] = [
    ['Version', system?.version],
    ['Platform', system?.platform],
    ['Data folder', system?.dataDir],
    ['Home folder', system?.homeDir],
    ['Shell', system?.shell],
  ];
  return (
    <Section id="about" title="About" description="Obsidian Code runs open-weight models on this PC, on a GPU you rent by the hour, or on any OpenAI-compatible endpoint.">
      <Group testId="settings-about">
        <div className="flex items-center gap-4 px-4 py-4">
          <AppMark size={40} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-ob-text">Obsidian Code</span>
            <span className="text-small text-ob-text-3">
              Version <span className="font-mono text-ob-text-2" data-testid="about-version">{system?.version ?? '—'}</span>
            </span>
          </div>
          <span className="flex-1" />
          <Badge tone={mode === 'demo' ? 'warning' : 'neutral'} mono>
            {mode === 'demo' ? 'demo data' : system?.electron ? 'desktop' : 'browser'}
          </Badge>
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-6 px-4 py-2.5">
            <span className="text-ui text-ob-text-3">{k}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <code className="ob-selectable truncate font-mono text-[12px] text-ob-text-2" title={v} data-testid={`about-row-${k.toLowerCase().replace(/\s+/g, '-')}`}>
                {v ?? '—'}
              </code>
              {v && (k === 'Data folder' || k === 'Home folder') ? (
                <button type="button" aria-label={`Copy ${k.toLowerCase()}`} className="ob-transition flex size-6 shrink-0 items-center justify-center rounded text-ob-text-3 hover:bg-ob-hover hover:text-ob-text" onClick={() => copy(v, k)}>
                  <Copy size={12} aria-hidden />
                </button>
              ) : null}
            </span>
          </div>
        ))}
      </Group>
    </Section>
  );
}
