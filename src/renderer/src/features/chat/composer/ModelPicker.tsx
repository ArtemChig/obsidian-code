// Model picker: models grouped by provider with status dots, Uncensored/Standard badges, context size and a
// "Clock in GPU" shortcut when the Vast provider is offline. Owner: ui-chat.
import { Box, Check, ChevronDown, Power, RefreshCw } from 'lucide-react';
import type { ModelRef } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { StatusDot } from '@renderer/components/ui/feedback';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/menu';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { gpuPrimaryAction, GPU_PHASE_LABEL } from '@renderer/app/GpuWidget';
import { cn } from '@renderer/lib/cn';
import { formatTokens, sameModel, shortModelName } from '@renderer/lib/format';
import { refreshModels } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useModels } from '@renderer/state/models';
import { findModel, useModelGroups } from '@renderer/state/selectors';

export interface ModelPickerProps {
  value: ModelRef | null;
  onChange: (m: ModelRef) => void;
  className?: string;
}

export function ModelPicker({ value, onChange, className }: ModelPickerProps) {
  const groups = useModelGroups();
  const models = useModels((s) => s.models);
  const refreshing = useModels((s) => s.refreshing);
  const gpu = useGpu((s) => s.status);
  const hasKey = useGpu((s) => s.hasApiKey);
  const info = findModel(models, value);
  const label = info?.label ?? (value ? shortModelName(value.model) : 'Default model');
  const gpuPhase = gpu?.phase ?? 'off';
  // Vast models only serve while clocked in: offer the clock-in right here when the GPU is off.
  const gpuOffline = gpuPhase === 'off' || gpuPhase === 'error';
  const gpuStarting = gpuPhase !== 'off' && gpuPhase !== 'error' && gpuPhase !== 'ready';

  return (
    <DropdownMenu>
      <Tooltip content={info ? `${info.label} · ${formatTokens(info.contextLength)} context` : 'Choose a model'}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="model-picker"
            className={cn(
              'ob-transition flex h-7 min-w-0 max-w-[240px] items-center whitespace-nowrap @max-[600px]:max-w-[170px] gap-1.5 rounded-[6px] px-2 text-small text-ob-text-2 hover:bg-ob-hover hover:text-ob-text data-[state=open]:bg-ob-hover',
              className,
            )}
          >
            {info ? <StatusDot status={info.status} size={6} /> : <Box size={13} aria-hidden className="text-ob-text-3" />}
            <span className="truncate">{label}</span>
            <ChevronDown size={12} aria-hidden className="shrink-0 text-ob-text-3" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="w-[380px]" align="end" side="top" data-testid="model-menu">
        {groups.length === 0 ? <div className="px-2 py-3 text-small text-ob-text-3">No models available — check Settings → Models.</div> : null}
        {groups.map((g, gi) => (
          <div key={g.provider.id}>
            {gi > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="flex items-center gap-2">
              <StatusDot status={g.provider.status} size={6} />
              <span className="flex-1">{g.provider.label}</span>
              {g.provider.detail ? <span className="truncate font-sans text-[11px] normal-case tracking-normal text-ob-text-3">{g.provider.detail}</span> : null}
            </DropdownMenuLabel>
            {g.models.map((m) => (
              <DropdownMenuItem
                key={`${m.ref.provider}::${m.ref.model}`}
                disabled={m.status === 'offline'}
                onSelect={() => onChange(m.ref)}
                leading={<StatusDot status={m.status} size={6} className="mx-1" />}
                hint={formatTokens(m.contextLength)}
                trailing={
                  <>
                    {m.variant ? (
                      <Badge tone={m.variant === 'uncensored' ? 'violet' : 'neutral'} mono>
                        {m.variant === 'uncensored' ? 'Uncensored' : 'Standard'}
                      </Badge>
                    ) : null}
                    {sameModel(m.ref, value) ? <Check size={14} aria-label="Selected" className="text-ob-accent" /> : <span className="w-3.5" />}
                  </>
                }
                data-testid="model-option"
              >
                {m.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {gpuOffline || gpuStarting ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={Power}
              disabled={gpuStarting}
              onSelect={() => void gpuPrimaryAction(gpu, hasKey)}
              hint={gpuStarting ? GPU_PHASE_LABEL[gpuPhase] : 'Rent a GPU on Vast.ai'}
              data-testid="model-clock-in"
            >
              {gpuStarting ? 'GPU starting…' : 'Clock in GPU'}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={RefreshCw}
          onSelect={(e) => {
            e.preventDefault();
            void refreshModels();
          }}
          hint={refreshing ? 'Refreshing…' : undefined}
        >
          Refresh models
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
