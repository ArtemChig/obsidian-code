// Profile choice (Light / Standard / Max) as three hairline-separated columns with live price ranges from gpu.offers.
// No card fills: the selected column gets the acc-wash and a 2 px cold-white top edge. Owner: ui-views.
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { useNow } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatMoney, relativeTime } from '@renderer/lib/format';
import { Kv, MetaLine, RadioMark } from '../settings/view-kit';
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
    <div
      role="radiogroup"
      aria-label="GPU profile"
      className="grid grid-cols-1 divide-y divide-rule2 border-y border-rule @min-[720px]:grid-cols-3 @min-[720px]:divide-x @min-[720px]:divide-y-0 @min-[720px]:divide-rule"
    >
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
        'ob-transition group relative flex min-w-0 cursor-default flex-col px-5 pb-3 pt-4 outline-offset-[-2px]',
        selected ? 'bg-acc-wash shadow-[inset_0_2px_0_var(--acc)]' : !disabled && 'hover:bg-hov',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('text-[13.5px] font-semibold tracking-[-0.028em]', disabled ? 'text-t3' : 'text-t1')}>{profile.label}</span>
        {active ? <Badge tone="success">active</Badge> : null}
        <RadioMark on={selected} className="ml-auto" />
      </div>
      <MetaLine className="mt-1" items={[gpuSpec(profile), `${profileVramGb(profile)} GB`]} />

      <div className="mt-4 min-h-[40px]">
        {loading ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        ) : offer?.state === 'error' && !stats ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[12px] text-warn">
              <TriangleAlert size={13} aria-hidden /> Prices unavailable
            </span>
            <span className="line-clamp-2 text-[11px] text-t3" title={offer.error}>
              {offer.error}
            </span>
          </div>
        ) : !stats ? (
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-warn">No offers right now</span>
            <span className="text-[11px] text-t3">Nothing matches this profile at the moment.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className={cn('ob-tabular font-mono text-[19px] leading-6 tracking-[-0.045em]', disabled ? 'text-t2' : 'text-t1')} data-testid={`gpu-price-${profile.id}`}>
                {stats.count > 1 && stats.median > stats.min ? `${formatMoney(stats.min)} – ${formatMoney(stats.median)}` : formatMoney(stats.min)}
              </span>
              <span className="ob-unit">/h</span>
            </div>
            <span className="ob-mn truncate">
              <b className="font-normal text-t2">{stats.count}</b> offer{stats.count === 1 ? '' : 's'} · best in {stats.best.location || 'unknown'}
            </span>
          </div>
        )}
      </div>

      <dl className="mt-3 border-t border-rule2 pt-1.5">
        <Kv label="This month" tone={hours === 0 ? 'err' : disabled ? 'dim' : 'default'} testId={`gpu-hours-${profile.id}`} className="[&_dd]:uppercase [&_dd]:tracking-[0.06em]">
          {hours == null ? '—' : `≈ ${hours.toLocaleString('en-US')} h left`}
        </Kv>
        <Kv label="Default model" tone="dim" title={model?.label ?? profile.defaultModelId} className="[&_dd]:font-sans [&_dd]:tracking-[-0.01em]">
          {modelName}
        </Kv>
        <Kv label="Price cap" tone="dim">
          {formatMoney(profile.maxPricePerHour)}/h
        </Kv>
      </dl>

      {overCap ? (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-[1.45] text-warn">
          <TriangleAlert size={12} aria-hidden className="mt-[2px] shrink-0" />
          <span>Cheapest offer is above your {formatMoney(profile.maxPricePerHour)}/h cap — clock-in will fail until prices drop or you raise the cap.</span>
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <span className="ob-mn truncate">{offer?.at ? <PricesAge at={offer.at} /> : ' '}</span>
        <IconButton
          label={`Refresh ${profile.label} prices`}
          icon={RefreshCw}
          size="xs"
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
