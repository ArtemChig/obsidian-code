// Model picker for the selected GPU profile with an Uncensored <-> Standard segmented toggle. Owner: ui-views.
import { FlaskConical, RefreshCw } from 'lucide-react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { Switch } from '@renderer/components/ui/toggles';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatMoney } from '@renderer/lib/format';
import { availableVariants, contextLabel, formatWarmup, profileModels, siblingModel, splitModelLabel, warmupCost, warmupSeconds } from './model';

type Variant = 'uncensored' | 'standard';

export interface ModelPickerProps {
  profile: GpuProfile;
  catalog: CatalogModel[] | null;
  catalogError?: boolean;
  selectedId: string;
  /** Model the running instance serves (when clocked in). */
  currentId?: string;
  /** Ready and serving: picking another model offers a live switch. */
  canSwitch: boolean;
  switching: boolean;
  showTest: boolean;
  /** Cheapest current price for the warm-up cost estimate. */
  pricePerHour?: number;
  onShowTest: (v: boolean) => void;
  onSelect: (modelId: string) => void;
  onSwitch: (modelId: string) => void;
  onRetryCatalog: () => void;
}

export function ModelPicker({ profile, catalog, catalogError, selectedId, currentId, canSwitch, switching, showTest, pricePerHour, onShowTest, onSelect, onSwitch, onRetryCatalog }: ModelPickerProps) {
  if (!catalog) {
    return (
      <div className="rounded-card border border-ob-border bg-ob-surface-1 p-4" data-testid="gpu-model-picker">
        {catalogError ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-ui text-ob-text-3">The model catalog could not be loaded.</span>
            <Button size="sm" icon={RefreshCw} onClick={onRetryCatalog}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
      </div>
    );
  }

  const opts = { includeTest: showTest };
  const selected = catalog.find((m) => m.id === selectedId);
  const variant: Variant = selected?.variant ?? 'uncensored';
  const variants = availableVariants(catalog, profile, opts);
  const visible = profileModels(catalog, profile, opts).filter((m) => m.variant === variant);
  const hasTest = catalog.some((m) => m.family === 'test');

  const setVariant = (v: Variant) => {
    if (v === variant) return;
    const next = siblingModel(catalog, selected, v, profile, opts);
    if (next) onSelect(next.id);
  };

  return (
    <div className="overflow-hidden rounded-card border border-ob-border bg-ob-surface-1" data-testid="gpu-model-picker">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ob-border px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-ui font-medium text-ob-text">Model for {profile.label}</span>
          <span className="text-small text-ob-text-3">Flip the toggle to get the other build of the same model.</span>
        </div>
        <div role="group" aria-label="Model variant" data-testid="gpu-variant-toggle" className="inline-flex h-8 items-center gap-0.5 rounded-[8px] border border-ob-border bg-ob-bg p-[3px]">
          {(['uncensored', 'standard'] as const).map((v) => {
            const enabled = variants.has(v);
            const btn = (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={variant === v}
                disabled={!enabled}
                data-testid={`gpu-variant-${v}`}
                onClick={() => setVariant(v)}
                className={cn(
                  'ob-transition h-full rounded-[6px] px-3 text-small font-medium capitalize',
                  variant === v ? (v === 'uncensored' ? 'bg-ob-violet-soft text-ob-violet shadow-[0_0_0_1px_rgba(179,166,232,0.25)]' : 'bg-ob-surface-3 text-ob-text') : 'text-ob-text-3 hover:text-ob-text-2',
                  !enabled && 'cursor-not-allowed opacity-40 hover:text-ob-text-3',
                )}
              >
                {v}
              </button>
            );
            return enabled ? btn : (
              <Tooltip key={v} content={`No ${v} build for ${profile.label}`}>
                <span className="h-full">{btn}</span>
              </Tooltip>
            );
          })}
        </div>
      </div>

      <div role="radiogroup" aria-label="GPU model" className="flex flex-col divide-y divide-ob-border">
        {visible.length === 0 ? <div className="px-4 py-6 text-center text-ui text-ob-text-3">No {variant} models for this profile.</div> : null}
        {visible.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            selected={m.id === selectedId}
            isDefault={m.id === profile.defaultModelId}
            isCurrent={m.id === currentId}
            pricePerHour={pricePerHour}
            onSelect={() => onSelect(m.id)}
          />
        ))}
      </div>

      {hasTest || currentId ? (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ob-border bg-[rgba(0,0,0,0.12)] px-4 py-2.5">
        {hasTest ? (
          <Switch size="sm" checked={showTest} onCheckedChange={onShowTest} label={<span className="flex items-center gap-1.5 text-small"><FlaskConical size={13} aria-hidden /> Show tiny test models</span>} />
        ) : (
          <span />
        )}
        {canSwitch && currentId && selectedId !== currentId ? (
          <Button size="sm" variant="primary" loading={switching} data-testid="gpu-switch-model" onClick={() => onSwitch(selectedId)}>
            Switch running GPU to this model
          </Button>
        ) : currentId ? (
          <span className="text-small text-ob-text-3">{canSwitch ? 'Serving this model.' : 'Model switching is available once the GPU is ready.'}</span>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

function ModelRow({
  model,
  selected,
  isDefault,
  isCurrent,
  pricePerHour,
  onSelect,
}: {
  model: CatalogModel;
  selected: boolean;
  isDefault: boolean;
  isCurrent: boolean;
  pricePerHour?: number;
  onSelect: () => void;
}) {
  const { name, detail } = splitModelLabel(model.label);
  const secs = warmupSeconds(model);
  const cost = warmupCost(secs, pricePerHour);
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      data-testid={`gpu-model-${model.id}`}
      data-selected={selected || undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn('ob-transition flex cursor-default items-start gap-3 px-4 py-3 outline-offset-[-2px]', selected ? 'bg-ob-accent-soft' : 'hover:bg-ob-hover')}
    >
      <span
        aria-hidden
        className={cn('mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-ob-accent' : 'border-[#3a4a57]')}
      >
        {selected ? <span className="size-2 rounded-full bg-ob-accent" /> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-ui font-medium text-ob-text">{name}</span>
          {detail ? <span className="truncate text-small text-ob-text-3">{detail}</span> : null}
          {isDefault ? <Badge tone="neutral" mono>default</Badge> : null}
          {isCurrent ? <Badge tone="success" mono>running</Badge> : null}
          {model.experimental ? (
            <Tooltip content="Young llama.cpp support. If it fails to load, the clock-in falls back to a stable model on the same machine.">
              <span>
                <Badge tone="warning" mono data-testid="gpu-experimental-badge">experimental</Badge>
              </span>
            </Tooltip>
          ) : null}
        </div>
        <div className="ob-tabular flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11.5px] text-ob-text-3">
          <span>{model.sizeGb.toFixed(1)} GB</span>
          <span>{contextLabel(model.contextLength)}</span>
          <span title="Download at ~150 MB/s plus boot and load. Billed while it warms up.">
            warm-up {formatWarmup(secs)}
            {cost != null ? ` (≈ ${formatMoney(cost)})` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
