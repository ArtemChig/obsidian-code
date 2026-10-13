// Engine selector in the composer toolbar: which agent harness runs this session — the app's own loop ("Obsidian")
// or the real Claude Code harness on the session's model ("Claude Code"). Switching is only possible while the
// session is idle; the transcript carries over. Owner: ui-chat.
import { Check, ChevronDown, Cpu, SquareTerminal } from 'lucide-react';
import type { EngineId, EngineInfo } from '@shared/types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@renderer/components/ui/menu';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { engineLabel, useEngines } from '@renderer/state/engines';
import { ToolbarValue } from '../ui';

const ICONS: Record<EngineId, typeof Cpu> = { builtin: Cpu, 'claude-code': SquareTerminal };

export const ENGINE_BLURB: Record<EngineId, string> = {
  builtin: 'The app\'s own agent loop — compact prompt and tools tuned for local models',
  'claude-code': 'The real Claude Code harness (tools, subagents, skills, hooks, slash commands) running on this session\'s model',
};

export function EngineMenuItems({ value, engines, onPick }: { value: EngineId; engines: EngineInfo[]; onPick: (id: EngineId) => void }) {
  return (
    <>
      {engines.map((e) => {
        const Icon = ICONS[e.id] ?? Cpu;
        return (
          <DropdownMenuItem
            key={e.id}
            disabled={!e.available && e.id !== value}
            onSelect={() => onPick(e.id)}
            leading={<Icon size={13} aria-hidden className="shrink-0 text-t3" />}
            trailing={e.id === value ? <Check size={13} aria-label="Selected" className="text-acc" /> : <span className="w-3.5" />}
            className="h-auto py-1.5"
            data-testid={`engine-option-${e.id}`}
          >
            <span className="flex min-w-0 flex-col gap-px">
              <span className="text-[12px] text-t1">{e.label}</span>
              <span className="text-[11px] text-t3">{ENGINE_BLURB[e.id] ?? ''}</span>
              <span className={cn('truncate font-mono text-[9.5px] tracking-[-0.01em]', e.available ? 'text-t3' : 'text-err')}>{e.detail}</span>
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export function EngineSelector({ value, disabled, onChange }: { value: EngineId; disabled?: boolean; onChange: (id: EngineId) => void }) {
  const engines = useEngines();
  return (
    <DropdownMenu>
      <Tooltip content={disabled ? 'Stop or wait for the turn to finish to switch engines' : 'Agent engine'}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            data-testid="engine-selector"
            data-engine={value}
            className="ob-transition flex h-6 items-center gap-1.5 rounded-[2px] px-2 hover:bg-hov disabled:pointer-events-none disabled:opacity-100 data-[state=open]:bg-s3"
          >
            <ToolbarValue label="Engine" className={value === 'claude-code' ? 'text-t1' : 'text-t2'}>
              <span className="@max-[560px]:hidden">{engineLabel(value)}</span>
            </ToolbarValue>
            <ChevronDown size={11} aria-hidden className="shrink-0 text-t3" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="w-[340px]" side="top" align="start">
        <DropdownMenuLabel>Agent engine</DropdownMenuLabel>
        <EngineMenuItems value={value} engines={engines} onPick={(id) => { if (id !== value) onChange(id); }} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
