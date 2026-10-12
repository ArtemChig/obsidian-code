// Settings: Permissions (default mode, allow / deny rules). Owner: ui-views.
import type { PermissionMode } from '@shared/types';
import { Select } from '@renderer/components/ui/select';
import { useSettings } from '@renderer/state/settings';
import { Group, Row, RuleList, Section, patchPermissions, saveSettings } from '../components';
import { PERMISSION_MODES, permissionModeInfo } from '../permission-modes';

export function PermissionsSection() {
  const settings = useSettings((s) => s.settings);
  if (!settings) return null;
  const mode = settings.defaultPermissionMode;
  return (
    <Section id="permissions" title="Permissions" description="What the agent may do without asking. Reading files is always free. Deny rules always win over allow rules.">
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
    </Section>
  );
}
