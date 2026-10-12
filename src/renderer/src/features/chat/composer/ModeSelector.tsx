// Permission-mode selector (Shift+Tab in the composer cycles default → acceptEdits → plan; bypass only when opted in).
// Picking "Bypass permissions" asks for confirmation unless the user made it their default. Owner: ui-chat.
import { Check, ChevronDown, ClipboardList, FilePen, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { PermissionMode } from '@shared/types';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@renderer/components/ui/menu';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { PERMISSION_MODES } from '../lib/composer';
import { ToolbarValue } from '../ui';

export const MODE_META: Record<PermissionMode, { label: string; short: string; description: string; icon: LucideIcon; tone: string }> = {
  default: {
    label: 'Ask permissions',
    short: 'Ask',
    description: 'Ask before edits, commands and network access',
    icon: ShieldCheck,
    tone: 'text-t2',
  },
  acceptEdits: {
    label: 'Accept edits',
    short: 'Accept edits',
    description: 'Edit files in this folder without asking',
    icon: FilePen,
    tone: 'text-t1',
  },
  plan: {
    label: 'Plan mode',
    short: 'Plan',
    description: 'Research and propose a plan; no edits',
    icon: ClipboardList,
    tone: 'text-t1',
  },
  bypassPermissions: {
    label: 'Bypass permissions',
    short: 'Bypass',
    description: 'Never ask. Every tool runs immediately',
    icon: ShieldOff,
    tone: 'text-err',
  },
};

export function ModeSelector({ mode, onChange, confirmBypass = true }: { mode: PermissionMode; onChange: (m: PermissionMode) => void; confirmBypass?: boolean }) {
  const meta = MODE_META[mode];
  const Icon = meta.icon;
  const [asking, setAsking] = useState(false);
  const pick = (m: PermissionMode) => {
    if (m === 'bypassPermissions' && mode !== m && confirmBypass) setAsking(true);
    else onChange(m);
  };
  return (
    <>
    <DropdownMenu>
      <Tooltip content="Permission mode" shortcut="Shift+Tab">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="mode-selector"
            data-mode={mode}
            className={cn(
              'ob-transition flex h-6 items-center gap-1.5 rounded-[2px] px-2 hover:bg-hov data-[state=open]:bg-s3',
              mode === 'bypassPermissions' && 'bg-err-wash hover:bg-err-wash',
            )}
          >
            <Icon size={12} aria-hidden className={cn('shrink-0', mode === 'bypassPermissions' ? 'text-err' : 'text-t3')} />
            <ToolbarValue label="Mode" className={meta.tone}>
              <span className="@max-[520px]:hidden">{meta.short}</span>
            </ToolbarValue>
            <ChevronDown size={11} aria-hidden className="shrink-0 text-t3" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="w-[300px]" side="top" align="start">
        <DropdownMenuLabel>Permission mode</DropdownMenuLabel>
        {PERMISSION_MODES.map((m) => {
          const mm = MODE_META[m];
          const MIcon = mm.icon;
          return (
            <DropdownMenuItem
              key={m}
              onSelect={() => pick(m)}
              leading={<MIcon size={13} aria-hidden className={cn('shrink-0', m === 'bypassPermissions' ? 'text-err' : 'text-t3')} />}
              trailing={m === mode ? <Check size={13} aria-label="Selected" className="text-acc" /> : <span className="w-3.5" />}
              className="h-auto py-1.5"
              data-testid={`mode-option-${m}`}
            >
              <span className="flex flex-col gap-px">
                <span className={cn('text-[12px]', m === 'bypassPermissions' ? 'text-err' : 'text-t1')}>{mm.label}</span>
                <span className="text-[11px] text-t3">{mm.description}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    <ConfirmDialog
      open={asking}
      onOpenChange={setAsking}
      danger
      title="Bypass all permission prompts?"
      description="Every tool runs immediately in this session — shell commands, file writes and deletes, web requests — without asking. Open-weight models make mistakes; use this only in a folder you can afford to lose or have under version control."
      confirmLabel="Bypass permissions"
      cancelLabel="Keep asking"
      onConfirm={() => onChange('bypassPermissions')}
    />
    </>
  );
}
