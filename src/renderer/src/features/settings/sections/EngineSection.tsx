// Settings → Engine: the default agent harness for new sessions and the Claude Code engine's options. Owner: ui-views.
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { EngineId, Settings } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Select } from '@renderer/components/ui/select';
import { Segmented } from '@renderer/components/ui/tabs';
import { Switch } from '@renderer/components/ui/toggles';
import { refreshEngines, useEngines } from '@renderer/state/engines';
import { useSettings } from '@renderer/state/settings';
import { Group, JsonEditor, Row, Section, TextField, saveSettings } from '../components';
import { Notice } from '../view-kit';

type ClaudeCodeSettings = Settings['engine']['claudeCode'];

function patchClaudeCode(patch: Partial<ClaudeCodeSettings>, label?: string): Promise<boolean> {
  return saveSettings({ engine: { claudeCode: patch } as Settings['engine'] }, label);
}

export function validateExtraEnv(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['The top level must be an object: { "NAME": "value" }'];
  const errors: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push(`"${k}": variable names use letters, digits and "_" and do not start with a digit`);
    else if (typeof v !== 'string') errors.push(`"${k}": the value must be a string (wrap numbers in quotes)`);
  }
  return errors;
}

const ENV_EXAMPLE: Record<string, string> = { CLAUDE_CODE_DISABLE_WORKFLOWS: '1', BASH_DEFAULT_TIMEOUT_MS: '300000' };

export function EngineSection() {
  const s = useSettings((x) => x.settings);
  const engines = useEngines();
  const [checking, setChecking] = useState(false);
  if (!s) return null;
  const engine = s.engine ?? { default: 'builtin' as EngineId, claudeCode: { executable: 'auto', systemPrompt: 'lean' as const, importUserClaudeConfig: true, extraEnv: {} } };
  const cc = engine.claudeCode;
  const info = engines.find((e) => e.id === 'claude-code');
  const recheck = async () => {
    setChecking(true);
    try { await refreshEngines(); } finally { setChecking(false); }
  };

  return (
    <Section id="engine" title="Engine" description="Which agent harness runs a session. Each session can switch in the composer toolbar while it is idle; the transcript carries over.">
      <Group testId="settings-engine-default">
        <Row label="Engine for new sessions" htmlFor="engine-default" description="Obsidian = the app's own agent loop. Claude Code = the real Claude Code harness running on the session's model.">
          <Select
            id="engine-default"
            aria-label="Default engine"
            value={engine.default}
            className="w-[220px]"
            align="end"
            options={[
              { value: 'builtin', label: 'Obsidian' },
              { value: 'claude-code', label: 'Claude Code', disabled: info ? !info.available : false },
            ]}
            onValueChange={(v) => void saveSettings({ engine: { default: v as EngineId } as Settings['engine'] }, 'Default engine saved')}
          />
        </Row>
      </Group>

      <Group title="Claude Code" testId="settings-engine-claude">
        <Row label="Status" description="Checked when the app starts; recheck after changing the executable.">
          <span className="flex min-w-0 items-center gap-2">
            <Badge tone={info?.available ? 'success' : 'danger'} variant="outline">{info?.available ? 'Ready' : 'Unavailable'}</Badge>
            <span className="min-w-0 max-w-[300px] truncate font-mono text-[10.5px] tracking-[-0.01em] text-t2" title={info?.detail} data-testid="engine-claude-detail">
              {info?.detail ?? 'Checking…'}
            </span>
            <IconButton label="Check again" icon={RefreshCw} size="sm" loading={checking} onClick={() => void recheck()} />
          </span>
        </Row>
        <Row stacked label="Executable" htmlFor="cc-exe" description={<>Use <code className="font-mono text-t2">auto</code> for the Claude Code binary bundled with the Agent SDK (works in the installed app). Or an absolute path to a <code className="font-mono text-t2">claude</code> executable, e.g. your own install.</>}>
          <TextField
            id="cc-exe"
            testId="cc-exe"
            mono
            value={cc.executable}
            placeholder="auto"
            onCommit={async (v) => { await patchClaudeCode({ executable: v.trim() || 'auto' }, 'Executable saved'); void recheck(); }}
          />
        </Row>
        <Row
          stacked
          label="System prompt"
          description={
            <>
              <b className="font-medium text-t2">Lean</b>: Claude Code&apos;s tools and loop with the app&apos;s compact prompt (~0.6k tokens, no refusal or content-policy language).{' '}
              <b className="font-medium text-t2">Full</b>: Claude Code&apos;s own preset prompt (~1.3k tokens for a non-Claude model), including Anthropic&apos;s security-refusal guidance.
              Measured on the local server, the 26 tool definitions (Claude Code&apos;s 22 + the app&apos;s 4, ~15k tokens) plus Claude Code&apos;s ~2k context block dominate either way: the first turn is ~17.6k
              prompt tokens with Lean and ~18.3k with Full (about 4% apart; 30–60 s before the first token on the local GPU, later turns reuse the prompt cache). Pick by behaviour, not speed.
            </>
          }
        >
          <Segmented
            value={cc.systemPrompt}
            onValueChange={(v) => void patchClaudeCode({ systemPrompt: v as ClaudeCodeSettings['systemPrompt'] }, 'System prompt saved')}
            options={[
              { value: 'lean', label: 'Lean (app prompt)' },
              { value: 'claude_code', label: 'Full (Claude Code)' },
            ]}
            data-testid="cc-system-prompt"
          />
        </Row>
        <Row label="Import ~/.claude" description="Copy your skills, agents, commands and CLAUDE.md from ~/.claude into the engine's own config folder. Your settings.json and login are never copied or used.">
          <Switch
            checked={cc.importUserClaudeConfig}
            onCheckedChange={(on) => void patchClaudeCode({ importUserClaudeConfig: on }, on ? 'Importing ~/.claude' : 'Import off')}
            aria-label="Import ~/.claude"
            data-testid="cc-import"
          />
        </Row>
        <Row stacked label="Extra environment" description="Variables for the Claude Code process, e.g. to turn features off. The engine's own routing variables (base URL, model, config folder) cannot be overridden safely — leave them out.">
          <JsonEditor<Record<string, string>>
            value={cc.extraEnv}
            validate={validateExtraEnv}
            onApply={(v) => patchClaudeCode({ extraEnv: v }, 'Environment saved')}
            example={ENV_EXAMPLE}
            testId="cc-extra-env"
            minRows={4}
          />
        </Row>
      </Group>

      <Notice icon={ShieldCheck} className="mt-6" testId="engine-local-notice">
        <span className="text-[11.5px] text-t2">
          Every model call of the Claude Code engine — main turns, subagents, compaction, titles, WebFetch summaries — goes to the session&apos;s own endpoint (local
          llama-server or your Vast GPU) through a local relay. No Anthropic account, login or API key is used; WebSearch is replaced by the app&apos;s search.
        </span>
      </Notice>
    </Section>
  );
}
