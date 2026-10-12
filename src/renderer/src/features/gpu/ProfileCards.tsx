// Profile cards (Light / Standard / Max) with live price ranges from gpu.offers. Owner: ui-views.
import { Check, RefreshCw, TriangleAlert } from 'lucide-react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { useNow } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatMoney, relativeTime } from '@renderer/lib/format';
import type { OfferState } from './hooks';
import { gpuSpec, hoursLeft, priceStats, profileVramGb, splitModelLabel } from './model';

export interface ProfileCardsProps {
  profiles: GpuProfile[];
  catalog: CatalogModel[] | null;
  offers: Record<string, OfferState>;
  selectedId: string;
  /** Profile of the current clock-in (cards of other profiles are locked). */
  activeId?: string;
  locked: boolean;
  budget: number;
  monthCost: number;
  onSelect: (id: string) => void;
  onRefresh: (id: string) => void;
}

export function ProfileCards({ profiles, catalog, offers, selectedId, activeId, locked, budget, monthCost, onSelect, onRefresh }: ProfileCardsProps) {
  return (
    <div role="radiogroup" aria-label="GPU profile" className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {profiles.map((p) => (
        <ProfileCard
          key={p.id}
          profile={p}
          model={catalog?.find((m) => m.id === p.defaultModelId)}
          offer={offers[p.id]}
          selected={p.id === selectedId}
          active={p.id === activeId}
          disabled={locked && p.id !== activeId}
          budget={budget}
          monthCost={monthCost}
          onSelect={() => onSelect(p.id)}
          onRefresh={() => onRefresh(p.id)}
        />
      ))}
    </div>
  );
}

function ProfileCard({
  profile,
  model,
  offer,
  selected,
  active,
  disabled,
  budget,
  monthCost,
  onSelect,
  onRefresh,
}: {
  profile: GpuProfile;
  model?: CatalogModel;
  offer?: OfferState;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  budget: number;
  monthCost: number;
  onSelect: () => void;
  onRefresh: () => void;
}) {
  const stats = priceStats(offer?.offers);
  const loading = !offer || offer.state === 'idle' || (offer.state === 'loading' && !stats);
  const hours = stats ? hoursLeft(budget, monthCost, stats.median) : null;
  const overCap = !!stats && stats.min > profile.maxPricePerHour;
  const modelName = model ? splitModelLabel(model.label).name : profile.defaultModelId;
  const card = (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-testid={`gpu-profile-${profile.id}`}
      data-selected={selected || undefined}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === ' ' || e.key === 'Enter')) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'ob-transition group relative flex min-w-0 cursor-default flex-col rounded-card border p-4 outline-offset-2',
        selected ? 'border-[rgba(143,184,222,0.55)] bg-[linear-gradient(180deg,rgba(143,184,222,0.10),rgba(143,184,222,0.03))]' : 'border-ob-border bg-ob-surface-1 hover:border-[#30414f] hover:bg-[#121e24]',
        disabled && 'pointer-events-auto opacity-50 hover:border-ob-border hover:bg-ob-surface-1',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ob-text">{profile.label}</span>
            {active ? (
              <Badge tone="success" mono>
                active
              </Badge>
            ) : null}
          </div>
          <span className="mt-0.5 truncate text-small text-ob-text-2">
            {gpuSpec(profile)} <span className="text-ob-text-3">·</span> {profileVramGb(profile)} GB
          </span>
        </div>
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
            selected ? 'border-ob-accent bg-ob-accent text-ob-accent-ink' : 'border-[#3a4a57]',
          )}
        >
          {selected ? <Check size={11} strokeWidth={3} /> : null}
        </span>
      </div>

      <div className="mt-4 min-h-[44px]">
        {loading ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        ) : offer?.state === 'error' && !stats ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-ui text-ob-warning">
              <TriangleAlert size={14} aria-hidden /> Prices unavailable
            </span>
            <span className="line-clamp-2 text-small text-ob-text-3" title={offer.error}>
              {offer.error}
            </span>
          </div>
        ) : !stats ? (
          <div className="flex flex-col gap-1">
            <span className="text-ui font-medium text-ob-warning">No offers right now</span>
            <span className="text-small text-ob-text-3">Nothing matches this profile at the moment.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="ob-tabular flex items-baseline gap-1 font-mono">
              <span className="text-[19px] font-medium leading-6 text-ob-text" data-testid={`gpu-price-${profile.id}`}>
                {stats.count > 1 && stats.median > stats.min ? `${formatMoney(stats.min)} – ${formatMoney(stats.median)}` : formatMoney(stats.min)}
              </span>
              <span className="text-small text-ob-text-3">/h</span>
            </div>
            <span className="truncate text-small text-ob-text-3">
              {stats.count} offer{stats.count === 1 ? '' : 's'} · best in {stats.best.location || 'unknown'}
            </span>
          </div>
        )}
      </div>

      <dl className="mt-3 flex flex-col gap-1.5 border-t border-ob-border pt-3 text-small">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ob-text-3">This month</dt>
          <dd className="ob-tabular truncate text-right font-mono text-[11.5px] text-ob-text-2" data-testid={`gpu-hours-${profile.id}`}>
            {hours == null ? '—' : `≈ ${hours.toLocaleString('en-US')} h left`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-ob-text-3">Default model</dt>
          <dd className="min-w-0 truncate text-right text-ob-text-2" title={model?.label ?? profile.defaultModelId}>
            {modelName}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ob-text-3">Price cap</dt>
          <dd className="ob-tabular font-mono text-[11.5px] text-ob-text-2">{formatMoney(profile.maxPricePerHour)}/h</dd>
        </div>
      </dl>

      {overCap ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-ctl bg-ob-warning-soft px-2 py-1.5 text-small text-ob-warning">
          <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
          <span>Cheapest offer is above your {formatMoney(profile.maxPricePerHour)}/h cap — clock-in will fail until prices drop or you raise the cap.</span>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-ob-text-3">
        <span className="truncate">{offer?.at ? <PricesAge at={offer.at} /> : ' '}</span>
        <IconButton
          label={`Refresh ${profile.label} prices`}
          icon={RefreshCw}
          size="sm"
          loading={offer?.state === 'loading'}
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
        />
      </div>
    </div>
  );
  return disabled ? (
    <Tooltip content="Clock out to switch profile" side="top">
      {card}
    </Tooltip>
  ) : (
    card
  );
}

function PricesAge({ at }: { at: number }) {
  const now = useNow(15_000);
  const t = relativeTime(at, Math.max(now, at));
  return <span>{t === 'now' ? 'prices just now' : `prices ${t} ago`}</span>;
}
