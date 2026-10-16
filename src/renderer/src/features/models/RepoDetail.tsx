// The selected Hugging Face repo: facts, tags, and its quant variants with size / context / which GPU profiles they fit,
// a recommended pick and Add buttons. Owner: ui-views.
import { Check, ExternalLink, Plus, RefreshCw, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import type { HubModelDetail } from '@shared/hub';
import type { GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
import { SectionLabel } from '@renderer/components/ui/layout';
import { Select } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/toggles';
import { RelativeTime } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { openExternal } from '@renderer/lib/bridge';
import { defaultGpuProfileId } from '@renderer/state/actions';
import { useSettings } from '@renderer/state/settings';
import { MetaLine } from '../settings/view-kit';
import {
  addState,
  buildVariantRows,
  compactCount,
  detailBadges,
  fitSummary,
  formatContext,
  formatGb,
  formatParams,
  mmprojFor,
  parseIso,
  repoUrl,
  smallestFitting,
  splitRepo,
  type VariantRow,
} from './model';
import { FavoriteButton } from './parts';
import { addVariant, loadDetails, toggleFavorite, useModels } from './store';

export function RepoDetail({ repo }: { repo: string | null }) {
  if (!repo) {
    return <EmptyState icon={ExternalLink} title="Select a model" description="Pick a repo from the list to see its quantizations and add one for GPU clock-ins." className="h-full" />;
  }
  return <Loaded repo={repo} />;
}

function Loaded({ repo }: { repo: string }) {
  const entry = useModels((s) => s.details[repo]);
  const { author, name } = splitRepo(repo);
  const settings = useSettings((s) => s.settings);
  const favorite = (settings?.vast.favoriteRepos ?? []).includes(repo);
  const detail = entry?.data;

  return (
    <article className="flex flex-col pb-10" data-testid="models-detail" data-repo={repo}>
      <header className="flex items-start gap-3 px-6 pb-3 pt-5">
        <div className="min-w-0 flex-1">
          <div className="ob-cap truncate">{author}</div>
          <h2 className="mt-1 break-words text-title font-semibold leading-[1.2] text-t1">{name}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-1">
          <FavoriteButton on={favorite} size="md" active onToggle={() => void toggleFavorite(repo)} />
          <Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => openExternal(repoUrl(repo))} data-testid="models-open-hf">
            Open on Hugging Face
          </Button>
        </div>
      </header>

      {!entry || (entry.status === 'loading' && !detail) ? <DetailSkeleton /> : null}
      {entry?.status === 'error' && !detail ? (
        <div className="mx-6 flex items-center justify-between gap-3 border-y border-rule py-3 text-[11.5px] text-err" data-testid="models-detail-error">
          <span className="min-w-0">{entry.error}</span>
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void loadDetails(repo, { refresh: true })}>
            Retry
          </Button>
        </div>
      ) : null}
      {detail ? <Body detail={detail} refreshing={entry?.status === 'loading'} /> : null}
    </article>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-6 pt-2" aria-hidden>
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
      <div className="mt-4 flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </div>
  );
}

function Body({ detail, refreshing }: { detail: HubModelDetail; refreshing: boolean }) {
  const settings = useSettings((s) => s.settings);
  const fitProfileId = useModels((s) => s.fitProfileId);
  const withVision = useModels((s) => s.withVision);
  const busy = useModels((s) => s.busy);
  const profiles = useMemo<GpuProfile[]>(() => settings?.vast.profiles ?? [], [settings?.vast.profiles]);
  const userModels = settings?.vast.userModels;
  const profileId = profiles.find((p) => p.id === (fitProfileId ?? defaultGpuProfileId()))?.id ?? profiles[0]?.id ?? '';
  const profile = profiles.find((p) => p.id === profileId);
  const mm = mmprojFor(detail);
  const vision = withVision && !!mm;

  const rows = useMemo(
    () => buildVariantRows(detail, { profiles, profileId, withVision: vision, userModels: userModels ?? [] }),
    [detail, profiles, profileId, vision, userModels],
  );
  const rec = rows.find((r) => r.recommended);
  const updated = parseIso(detail.lastModified);
  const badges = detailBadges(detail);

  const add = (row: VariantRow) => void addVariant(detail.repo, row.variant, vision);

  return (
    <>
      <div className="px-6">
        <MetaLine
          testId="models-detail-meta"
          items={[
            <>
              <b>{compactCount(detail.downloads)}</b> downloads
            </>,
            <>
              <b>{compactCount(detail.likes)}</b> likes
            </>,
            updated ? (
              <>
                updated <b><RelativeTime ts={updated} ago /></b>
              </>
            ) : null,
            detail.license ? <>licence <b>{detail.license}</b></> : null,
            detail.totalParams ? <b>{formatParams(detail.totalParams)} params</b> : null,
            detail.architecture ? <b>{detail.architecture}</b> : null,
            detail.contextLength ? <><b>{formatContext(detail.contextLength)}</b> context</> : null,
          ]}
        />
      </div>

      {detail.gated ? (
        <div className="mx-6 mt-4 flex items-start gap-[9px] rounded-[2px] px-3 py-[9px] shadow-[inset_0_0_0_1px_var(--warn)]" data-testid="models-gated" role="note">
          <TriangleAlert size={13} aria-hidden className="mt-px shrink-0 text-warn" />
          <p className="text-[11.5px] leading-[1.5] text-t2">
            This repo is <b className="font-medium text-warn">gated</b>: Hugging Face asks for a login and an accepted licence before it lets anyone download it, and the rented GPU server has no login. It cannot be added. Look for an open GGUF re-upload of the same model.
          </p>
        </div>
      ) : null}

      {detail.baseModels.length > 0 || badges.length > 0 ? (
        <div className="flex flex-col gap-2.5 px-6 pt-4">
          {detail.baseModels.length > 0 ? (
            <div className="text-[11.5px] text-t3">
              Based on{' '}
              {detail.baseModels.map((b, i) => (
                <span key={b}>
                  {i > 0 ? ', ' : ''}
                  <span className="font-mono text-[10.5px] text-t2">{b}</span>
                </span>
              ))}
            </div>
          ) : null}
          {badges.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="models-tags">
              {badges.map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-3 px-6 pt-6" aria-label="Quantizations">
        <SectionLabel
          rule
          action={
            <>
              {refreshing ? <span className="text-t3">refreshing…</span> : null}
              <span className="text-t3">{detail.variants.length} {detail.variants.length === 1 ? 'quant' : 'quants'}</span>
            </>
          }
        >
          Quantizations
        </SectionLabel>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-testid="models-fit-controls">
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-[11.5px] text-t3">Fit for</span>
            <Select
              size="sm"
              value={profileId}
              onValueChange={(v) => useModels.setState({ fitProfileId: v })}
              options={profiles.map((p) => ({ value: p.id, label: p.label, triggerLabel: p.label, description: undefined }))}
              aria-label="Fit for GPU profile"
              className="min-w-[110px]"
            />
          </div>
          {mm ? (
            <Switch
              size="sm"
              checked={vision}
              onCheckedChange={(v) => useModels.setState({ withVision: v })}
              label={
                <span className="text-[11.5px] text-t2">
                  Include vision <span className="font-mono text-[10px] text-t3">mmproj {mm.label} · +{formatGb(mm.sizeGb)}</span>
                </span>
              }
            />
          ) : (
            <span className="ob-mn">no vision projector in this repo</span>
          )}
        </div>

        {detail.variants.length === 0 ? (
          <div className="border-y border-rule py-5 text-center text-[11.5px] text-t3" data-testid="models-no-variants">
            This repo has no GGUF weight files that can be added{detail.warnings.length ? `: ${detail.warnings.join('; ')}` : '.'}
          </div>
        ) : (
          <>
            <Recommended rec={rec} profile={profile} add={add} busy={busy} repo={detail.repo} gated={detail.gated} />
            <VariantTable rows={rows} profiles={profiles} profileId={profileId} repo={detail.repo} busy={busy} add={add} />
          </>
        )}

        {detail.warnings.length > 0 && detail.variants.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-[10.5px] text-t3" data-testid="models-warnings">
            {detail.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-[10.5px] leading-[1.5] text-t3">
          Context and VRAM are estimates for the q8_0 KV cache the server uses. If a model does not load, the server retries with a smaller setup before giving up. Added models appear in the GPU view next to the recommended ones.
        </p>
      </section>
    </>
  );
}

function Recommended({
  rec,
  profile,
  add,
  busy,
  repo,
  gated,
}: {
  rec: VariantRow | undefined;
  profile: GpuProfile | undefined;
  add: (r: VariantRow) => void;
  busy: Record<string, boolean>;
  repo: string;
  gated: boolean;
}) {
  if (!profile) return null;
  if (!rec) {
    return (
      <div className="border-b border-rule2 py-2 text-[11.5px] text-t3" data-testid="models-recommended">
        {gated ? 'Gated repos cannot be added.' : `No quant of this repo fits ${profile.label}. Pick a bigger profile above to see what does.`}
      </div>
    );
  }
  const state = addState(rec);
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule2 pb-3" data-testid="models-recommended">
      <div className="min-w-0 text-[11.5px] leading-[1.5] text-t3">
        Recommended for <span className="text-t1">{profile.label}</span>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[12px] text-t1">{rec.variant.label}</span>
          <span className="ob-mn">
            <b>{formatGb(rec.sizeGb)}</b> / <b>{formatContext(rec.fit.contextLength)}</b> context / ~<b>{rec.fit.minTotalVramGb}</b> GB VRAM
          </span>
        </div>
      </div>
      {state === 'added' ? (
        <Badge tone="success" icon={Check}>
          added
        </Badge>
      ) : (
        <Button size="md" variant="primary" icon={Plus} loading={!!busy[`add:${repo}:${rec.variant.id}`]} disabled={state === 'blocked'} onClick={() => add(rec)} data-testid="models-add-recommended">
          Add {rec.variant.label}
        </Button>
      )}
    </div>
  );
}

const TABLE_COLS = 'grid grid-cols-[minmax(0,1.25fr)_68px_46px_minmax(0,1fr)_76px] items-center gap-2';

function VariantTable({
  rows,
  profiles,
  profileId,
  repo,
  busy,
  add,
}: {
  rows: VariantRow[];
  profiles: GpuProfile[];
  profileId: string;
  repo: string;
  busy: Record<string, boolean>;
  add: (r: VariantRow) => void;
}) {
  return (
    <div role="table" aria-label="Quantizations" className="-mx-2" data-testid="models-variants">
      <div role="row" className={cn(TABLE_COLS, 'ob-label h-7 border-b border-rule px-2')} aria-hidden>
        <span>Quant</span>
        <span className="text-right">Size</span>
        <span className="text-right">Ctx</span>
        <span>Smallest profile</span>
        <span />
      </div>
      {rows.map((r) => {
        const state = addState(r);
        const fits = r.fitsSelected;
        const need = r.fit.profiles.length === 0 ? smallestHint(r) : null;
        const smallest = smallestFitting(r.fit.profiles, profiles);
        return (
          <div
            key={r.variant.id}
            role="row"
            data-testid="models-variant"
            data-quant={r.variant.label}
            data-fits={fits || undefined}
            data-recommended={r.recommended || undefined}
            className={cn(TABLE_COLS, 'min-h-7 border-b border-rule2 px-2 py-0.5', r.recommended && 'ob-selected')}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn('truncate font-mono text-[11.5px] tracking-[-0.02em]', fits ? 'text-t1' : 'text-t2')} title={r.variant.files[0]}>
                {r.variant.label}
              </span>
              {r.variant.parts > 1 ? <span className="ob-mn shrink-0">{r.variant.parts} parts</span> : null}
              {r.recommended ? <Badge tone="accent">pick</Badge> : null}
            </span>
            <span className={cn('ob-num text-right font-mono text-[10.5px] tracking-[-0.02em]', fits ? 'text-t1' : 'text-t2')}>{r.variant.sizeKnown ? formatGb(r.sizeGb).replace(' GB', '') : '—'}<span className="ob-unit ml-1">gb</span></span>
            <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">{r.fit.profiles.length ? formatContext(r.fit.contextLength) : '—'}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {r.fit.profiles.length > 0 ? (
                <Tooltip content={`Fits ${fitSummary(r.fit.profiles, profiles)} · about ${r.fit.minTotalVramGb} GB of VRAM at ${formatContext(r.fit.contextLength)} context`}>
                  <span className="flex items-center gap-1.5" data-testid="models-fits">
                    {/* The smallest profile that fits; every bigger one fits as well ("+2"). */}
                    <Badge tone={fits ? 'accent' : 'neutral'} variant="outline">
                      {smallest?.label ?? r.fit.profiles[0]}
                    </Badge>
                    {r.fit.profiles.length > 1 ? <span className="ob-mn">+{r.fit.profiles.length - 1}</span> : null}
                  </span>
                </Tooltip>
              ) : (
                <span className="ob-mn" title="Bigger than every GPU profile. It can still be used with a bigger custom profile.">
                  {need}
                </span>
              )}
            </span>
            <span className="flex justify-end">
              {state === 'added' ? (
                <Badge tone="success" icon={Check}>
                  added
                </Badge>
              ) : state === 'blocked' ? (
                <Tooltip content={r.reason ?? 'Cannot be added'}>
                  <span className="flex">
                    <Button size="sm" variant="secondary" disabled data-testid="models-add">
                      Add
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button size="sm" variant={r.recommended ? 'secondary' : 'secondary'} icon={Plus} loading={!!busy[`add:${repo}:${r.variant.id}`]} onClick={() => add(r)} data-testid="models-add">
                  Add
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function smallestHint(r: VariantRow): string {
  return `needs ~${r.fit.minTotalVramGb} GB`;
}
