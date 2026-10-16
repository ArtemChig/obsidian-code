// My models: the models added from Hugging Face. Use one as a profile's default model, open its repo, or remove it. Owner: ui-views.
import { Boxes, ChevronDown, Check, ExternalLink, Eye, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button, IconButton } from '@renderer/components/ui/button';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { EmptyState, Skeleton } from '@renderer/components/ui/feedback';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@renderer/components/ui/menu';
import { openExternal } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { loadGpuCatalog } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { useEffect } from 'react';
import { splitModelLabel } from '../gpu/model';
import { defaultTargets, fitSummary, formatContext, formatGb, profilesDefaultingTo, repoUrl } from './model';
import { removeAdded, setProfileDefault, setTab, useModels } from './store';

// Narrow containers drop the Source and Ctx columns (the repo is in the name's tooltip) so the name and its tags keep room.
const COLS =
  'grid items-center gap-3 px-6 grid-cols-[minmax(0,2fr)_64px_minmax(0,1fr)_minmax(0,1fr)_190px] ' +
  '@min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_64px_46px_minmax(0,1fr)_minmax(0,1fr)_190px]';
const WIDE_ONLY = '@max-[899px]:hidden';

export function MyModels() {
  const settings = useSettings((s) => s.settings);
  const catalog = useGpu((s) => s.catalog);
  const busy = useModels((s) => s.busy);
  const [removing, setRemoving] = useState<CatalogModel | null>(null);

  useEffect(() => {
    if (!catalog) void loadGpuCatalog(false, true);
  }, [catalog]);

  const profiles = useMemo<GpuProfile[]>(() => settings?.vast.profiles ?? [], [settings?.vast.profiles]);
  // The catalog carries the live `profiles` of each model; the settings are the fallback until it has loaded.
  const models = useMemo(() => {
    const fromCatalog = catalog?.filter((m) => m.source === 'user');
    return fromCatalog ?? settings?.vast.userModels ?? [];
  }, [catalog, settings?.vast.userModels]);

  if (!settings) return <MySkeleton />;

  if (models.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={Boxes}
        title="No added models yet"
        description="Browse Hugging Face, pick a quantization and add it. It then shows up in the GPU view next to the recommended models."
        action={
          <Button size="md" variant="primary" onClick={() => setTab('browse')} data-testid="models-browse-cta">
            Browse models
          </Button>
        }
      />
    );
  }

  const using = removing ? profilesDefaultingTo(profiles, removing.id) : [];

  return (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="models-mine">
      <div className={cn(COLS, 'ob-label h-7 shrink-0 border-b border-rule')} aria-hidden>
        <span>Model</span>
        <span className={WIDE_ONLY}>Source</span>
        <span className="text-right">Size</span>
        <span className={cn('text-right', WIDE_ONLY)}>Ctx</span>
        <span>Fits</span>
        <span>Default for</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        {models.map((m) => {
          const { name } = splitModelLabel(m.label);
          const targets = defaultTargets(m, profiles);
          const defaults = profilesDefaultingTo(profiles, m.id);
          return (
            <div key={m.id} className={cn(COLS, 'ob-transition min-h-8 border-b border-rule2 py-1 hover:bg-hov')} data-testid="models-mine-row" data-id={m.id}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-[48px] truncate text-[12px] tracking-[-0.012em] text-t1" title={`${m.label} · ${m.repo}`}>
                  {name}
                </span>
                {m.quant ? <Badge tone="neutral">{m.quant}</Badge> : null}
                {m.mmproj ? (
                  <Tooltip content="Vision projector included">
                    <span className="flex shrink-0 text-t3" data-testid="models-vision">
                      <Eye size={12} aria-label="Vision projector included" />
                    </span>
                  </Tooltip>
                ) : null}
              </span>
              <span className={cn('truncate font-mono text-[10px] tracking-[0.01em] text-t3', WIDE_ONLY)} title={m.repo}>
                {m.repo}
              </span>
              <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">{formatGb(m.sizeGb).replace(' GB', '')}<span className="ob-unit ml-1">gb</span></span>
              <span className={cn('ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2', WIDE_ONLY)}>{formatContext(m.contextLength)}</span>
              <span className="truncate text-[11px] text-t2" title={m.profiles.length ? undefined : `Needs about ${m.minTotalVramGb} GB of VRAM`}>
                {m.profiles.length ? fitSummary(m.profiles, profiles) : <span className="text-t3">needs ~{m.minTotalVramGb} GB</span>}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {defaults.length ? defaults.map((p) => <Badge key={p.id} tone="accent" data-testid="models-default-badge">{p.label}</Badge>) : <span className="ob-mn">—</span>}
              </span>
              <span className="flex items-center justify-end gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="secondary" iconRight={ChevronDown} disabled={targets.length === 0} data-testid="models-use-default">
                      Use as default
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Default model for</DropdownMenuLabel>
                    {targets.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        icon={p.defaultModelId === m.id ? Check : undefined}
                        disabled={p.defaultModelId === m.id}
                        onSelect={() => void setProfileDefault(p.id, m.id)}
                      >
                        {p.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <IconButton label="Open on Hugging Face" size="sm" icon={ExternalLink} onClick={() => openExternal(repoUrl(m.repo))} />
                <IconButton label="Remove" size="sm" variant="danger" icon={Trash2} loading={!!busy[`rm:${m.id}`]} onClick={() => setRemoving(m)} data-testid="models-remove" />
              </span>
            </div>
          );
        })}
        <p className="px-6 pt-4 text-[10.5px] leading-[1.5] text-t3">
          Removing a model only takes it off this list. Nothing is deleted on Hugging Face, and a rented GPU is not touched.
        </p>
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
        title={removing ? `Remove ${splitModelLabel(removing.label).name} ${removing.quant ?? ''}?`.replace(/\s+\?$/, '?') : 'Remove model?'}
        description={
          using.length
            ? `${using.map((p) => p.label).join(' and ')} use${using.length === 1 ? 's' : ''} it as the default model. ${using.length === 1 ? 'It goes' : 'They go'} back to the recommended default.`
            : 'It disappears from the GPU view. You can add it again from Browse.'
        }
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (removing) await removeAdded(removing.id);
        }}
      />
    </div>
  );
}

function MySkeleton() {
  return (
    <div className="flex flex-col gap-2 px-6 py-5" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}
