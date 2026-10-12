// Settings: Permissions (default mode, allow / deny rules). Owner: ui-views.
import type { PermissionMode } from '@shared/types';
import { Select } from '@renderer/components/ui/select';
import { useSettings } from '@renderer/state/settings';
import { Group, Row, RuleList, Section, patchPermissions, saveSettings } from '../components';
import { PERMISSION_MODES, permissionModeInfo } from '../permission-modes';

/** A trusted folder must be an absolute local path (no UNC / network share). */
function validateFolder(v: string): string | null {
  if (!v.trim()) return 'Enter a folder path';
  if (/^[\\/][\\/]/.test(v)) return 'Network (UNC) paths cannot be trusted';
  return /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/') ? null : 'Use an absolute path, e.g. C:\\code\\project';
}

export function PermissionsSection() {
  const settings = useSettings((s) => s.settings);
  if (!settings) return null;
  const mode = settings.defaultPermissionMode;
  return (
    <Section id="permissions" title="Permissions" description="What the agent may do without asking. Reading files is free (except credential files and network paths). Deny rules always win over allow rules.">
      <Group title="Default mode" testId="settings-permission-mode">
        <Row label="New sessions start in" htmlFor="perm-mode" description={permissionModeInfo(mode).description}>
          <Select
            id="perm-mode"
            aria-label="Default permission mode"
            value={mode}
            className="w-[240px]"
            align="end"
            options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: m.description }))}
            onValueChange={(v) => void saveSettings({ defaultPermissionMode: v as PermissionMode }, 'Default mode saved')}
          />
        </Row>
      </Group>

      <Group
        title="Always allow"
        testId="settings-allow"
        description={
          <>
            Written as <code className="font-mono text-[11px] text-ob-text-2">Tool</code> or <code className="font-mono text-[11px] text-ob-text-2">Tool(argument)</code>: <code className="font-mono text-[11px] text-ob-text-2">Bash(npm test:*)</code>,{' '}
            <code className="font-mono text-[11px] text-ob-text-2">WebFetch(domain:docs.vast.ai)</code>, <code className="font-mono text-[11px] text-ob-text-2">Edit(src/**)</code>.
          </>
        }
        flush
      >
        <RuleList
          testId="rules-allow"
          tone="allow"
          rules={settings.permissions.allow}
          placeholder="Bash(npm run build:*)"
          empty="No allow rules. Every edit, command and network request asks first (unless a mode says otherwise)."
          onChange={(allow) => patchPermissions({ allow }, 'Allow rules saved')}
        />
      </Group>

      <Group title="Always deny" testId="settings-deny" description="Matching tool calls are refused, even when an allow rule matches too." flush>
        <RuleList
          testId="rules-deny"
          tone="deny"
          rules={settings.permissions.deny}
          placeholder="Bash(rm -rf:*)"
          empty="No deny rules."
          onChange={(deny) => patchPermissions({ deny }, 'Deny rules saved')}
        />
      </Group>

      <Group
        title="Trusted folders"
        testId="settings-trusted-folders"
        description="A project's own settings files (.obsidian-code/settings.json, .claude/settings*.json) can define hooks, which are shell commands, and allow rules. They are ignored unless the folder (or a parent) is listed here. Deny rules from project files always apply."
        flush
      >
        <RuleList
          testId="trusted-folders"
          tone="allow"
          itemLabel="folder"
          rules={settings.trustedFolders ?? []}
          placeholder="C:\Users\me\code\my-project"
          empty="No trusted folders. Hooks and allow rules from project files are ignored."
          validate={validateFolder}
          onChange={(trustedFolders) => saveSettings({ trustedFolders }, 'Trusted folders saved')}
        />
      </Group>

      {Object.entries(settings.projectAllow ?? {}).map(([folder, rules]) => (
        <Group key={folder} title={`Always allow in ${folder}`} testId="settings-project-allow" description="Saved from permission prompts for this project." flush>
          <RuleList
            testId="rules-project-allow"
            tone="allow"
            rules={rules}
            placeholder="Bash(npm test:*)"
            empty="No rules."
            onChange={(next) => saveSettings({ projectAllow: { ...settings.projectAllow, [folder]: next } }, 'Project rules saved')}
          />
        </Group>
      ))}
    </Section>
  );
}
