// Model list for the selected GPU profile: 28 px table rows with an Uncensored <-> Standard segmented control. Owner: ui-views.
import { FlaskConical, RefreshCw } from 'lucide-react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { Switch } from '@renderer/components/ui/toggles';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatMoney } from '@renderer/lib/format';
import { RadioMark } from '../settings/view-kit';
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

/** Shared grid of the header and the rows: mark · model · build · size · context · warm-up. */
const COLS = 'grid grid-cols-[12px_minmax(0,1.5fr)_minmax(0,1fr)_64px_52px_112px] items-center gap-3 px-2';

export function ModelPicker({ profile, catalog, catalogError, selectedId, currentId, canSwitch, switching, showTest, pricePerHour, onShowTest, onSelect, onSwitch, onRetryCatalog }: ModelPickerProps) {
  if (!catalog) {
    return (
      <div className="py-3" data-testid="gpu-model-picker">
        {catalogError ? (
          <div className="flex items-center justify-between gap-3 border-b border-rule2 py-2">
            <span className="text-[11.5px] text-t3">The model catalog could not be loaded.</span>
            <Button size="sm" icon={RefreshCw} onClick={onRetryCatalog}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5" aria-hidden>
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
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
    <div data-testid="gpu-model-picker">
      <div className="flex min-h-[42px] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="text-[12.5px] font-medium tracking-[-0.016em] text-t1">Model for {profile.label}</span>
          <span className="truncate text-[11px] text-t3">Flip the toggle to get the other build of the same model.</span>
        </div>
        <VariantToggle variant={variant} enabled={variants} profileLabel={profile.label} onChange={setVariant} />
      </div>

      <div role="radiogroup" aria-label="GPU model" className="-mx-2">
        <div className={cn(COLS, 'ob-label h-7 border-b border-rule')} aria-hidden>
          <span />
          <span>Model</span>
          <span>Build</span>
          <span className="text-right">Size</span>
          <span className="text-right">Context</span>
          <span className="text-right">Warm-up</span>
        </div>
        {visible.length === 0 ? <div className="border-b border-rule2 px-2 py-3 text-[11.5px] text-t3">No {variant} models for this profile.</div> : null}
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
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-3 py-1.5">
          {hasTest ? (
            <Switch
              size="sm"
              checked={showTest}
              onCheckedChange={onShowTest}
              label={
                <span className="flex items-center gap-1.5 text-[11.5px] text-t2">
                  <FlaskConical size={12} aria-hidden className="text-t3" /> Show tiny test models
                </span>
              }
            />
          ) : (
            <span />
          )}
          {canSwitch && currentId && selectedId !== currentId ? (
            <Button size="sm" variant="primary" loading={switching} data-testid="gpu-switch-model" onClick={() => onSwitch(selectedId)}>
              Switch running GPU to this model
            </Button>
          ) : currentId ? (
            <span className="ob-mn">{canSwitch ? 'serving this model' : 'model switching is available once the GPU is ready'}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Uncensored | Standard (reference .seg): 1 px --line frame, the chosen side solid cold white. */
function VariantToggle({ variant, enabled, profileLabel, onChange }: { variant: Variant; enabled: Set<Variant>; profileLabel: string; onChange: (v: Variant) => void }) {
  return (
    <div role="group" aria-label="Model variant" data-testid="gpu-variant-toggle" className="inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-[2px] shadow-[inset_0_0_0_1px_var(--line)]">
      {(['uncensored', 'standard'] as const).map((v, i) => {
        const on = variant === v;
        const ok = enabled.has(v);
        const btn = (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!ok}
            data-testid={`gpu-variant-${v}`}
            onClick={() => onChange(v)}
            className={cn(
              'ob-transition flex h-full items-center px-[11px] text-[11px] capitalize tracking-[-0.008em] outline-offset-[-2px]',
              i > 0 && !on && 'shadow-[inset_1px_0_0_var(--line)]',
              on ? 'bg-acc font-semibold text-acc-ink' : 'text-t3 hover:text-t1',
              !ok && 'cursor-not-allowed hover:text-t3',
            )}
          >
            {v}
          </button>
        );
        return ok ? (
          btn
        ) : (
          <Tooltip key={v} content={`No ${v} build for ${profileLabel}`}>
            <span className="flex h-full">{btn}</span>
          </Tooltip>
        );
      })}
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
      className={cn(COLS, 'ob-transition min-h-7 cursor-default border-b border-rule2 py-1 outline-offset-[-2px]', selected ? 'ob-selected' : 'hover:bg-hov')}
    >
      <RadioMark on={selected} />
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('truncate text-[12px] tracking-[-0.012em]', selected ? 'font-medium text-t1' : 'text-t1')}>{name}</span>
        {isDefault ? <Badge tone="neutral">default</Badge> : null}
        {isCurrent ? <Badge tone="success">running</Badge> : null}
        {model.experimental ? (
          <Tooltip content="Young llama.cpp support. If it fails to load, the clock-in falls back to a stable model on the same machine.">
            <span className="flex">
              <Badge tone="warning" data-testid="gpu-experimental-badge">
                experimental
              </Badge>
            </span>
          </Tooltip>
        ) : null}
      </div>
      <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3" title={detail || undefined}>
        {detail || '—'}
      </span>
      <span className="ob-tabular text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">
        {model.sizeGb.toFixed(1)}
        <span className="ob-unit ml-1">gb</span>
      </span>
      <span className="ob-tabular text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">{contextLabel(model.contextLength)}</span>
      <span className="ob-tabular truncate text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2" title="Download at ~150 MB/s plus boot and load. Billed while it warms up.">
        <span className="sr-only">warm-up </span>
        {formatWarmup(secs)}
        {cost != null ? <span className="text-t3"> ≈ {formatMoney(cost)}</span> : ''}
      </span>
    </div>
  );
}
