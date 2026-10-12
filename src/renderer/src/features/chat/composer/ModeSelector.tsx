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

export const MODE_META: Record<PermissionMode, { label: string; short: string; description: string; icon: LucideIcon; tone: string }> = {
  default: {
    label: 'Ask permissions',
    short: 'Ask',
    description: 'Ask before edits, commands and network access',
    icon: ShieldCheck,
    tone: 'text-ob-text-2',
  },
  acceptEdits: {
    label: 'Accept edits',
    short: 'Accept edits',
    description: 'Edit files in this folder without asking',
    icon: FilePen,
    tone: 'text-ob-accent',
  },
  plan: {
    label: 'Plan mode',
    short: 'Plan',
    description: 'Research and propose a plan; no edits',
    icon: ClipboardList,
    tone: 'text-ob-violet',
  },
  bypassPermissions: {
    label: 'Bypass permissions',
    short: 'Bypass',
    description: 'Never ask. Every tool runs immediately',
    icon: ShieldOff,
    tone: 'text-ob-danger',
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
              'ob-transition flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-small hover:bg-ob-hover data-[state=open]:bg-ob-hover',
              meta.tone,
              mode === 'bypassPermissions' && 'bg-ob-danger-soft hover:bg-[rgba(240,113,120,0.18)]',
              mode === 'plan' && 'bg-ob-violet-soft hover:bg-[rgba(179,166,232,0.18)]',
              mode === 'acceptEdits' && 'bg-ob-accent-soft hover:bg-[rgba(143,184,222,0.18)]',
            )}
          >
            <Icon size={13} aria-hidden />
            <span className="whitespace-nowrap @max-[520px]:hidden">{meta.short}</span>
            <ChevronDown size={12} aria-hidden className="opacity-70" />
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
              leading={<MIcon size={14} aria-hidden className={cn('shrink-0', mm.tone)} />}
              trailing={m === mode ? <Check size={14} aria-label="Selected" className="text-ob-accent" /> : <span className="w-3.5" />}
              className="h-auto py-1.5"
              data-testid={`mode-option-${m}`}
            >
              <span className="flex flex-col">
                <span className={cn(m === 'bypassPermissions' ? 'text-ob-danger' : 'text-ob-text')}>{mm.label}</span>
                <span className="text-small text-ob-text-3">{mm.description}</span>
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
