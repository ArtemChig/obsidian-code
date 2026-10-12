// Permission-mode labels shared by Settings and the schedule dialog. Owner: ui-views.
import type { PermissionMode } from '@shared/types';

export interface PermissionModeInfo {
  value: PermissionMode;
  label: string;
  description: string;
  /** What happens in an unattended (scheduled) run. */
  unattended: string;
}

export const PERMISSION_MODES: PermissionModeInfo[] = [
  {
    value: 'default',
    label: 'Ask before acting',
    description: 'Asks before edits, commands and network access. Reading is free.',
    unattended: 'Nobody is watching a scheduled run, so every permission prompt is denied automatically.',
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: 'File edits inside the working folder are allowed. Commands and network still ask.',
    unattended: 'Edits in the folder go through. Commands and network access are denied (nobody can approve them).',
  },
  {
    value: 'plan',
    label: 'Plan only',
    description: 'Read-only research. The agent writes a plan and changes nothing.',
    unattended: 'Safe for unattended runs: nothing is modified.',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Never asks. Every tool call runs immediately.',
    unattended: 'Runs every tool without asking, including shell commands. Use only for prompts you trust completely.',
  },
];

export function permissionModeInfo(mode: PermissionMode): PermissionModeInfo {
  return PERMISSION_MODES.find((m) => m.value === mode) ?? PERMISSION_MODES[0];
}

export function permissionModeLabel(mode: PermissionMode): string {
  return permissionModeInfo(mode).label;
}
