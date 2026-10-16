// Recommended: the built-in catalog, read-only, grouped by GPU profile, with "Restore default" for a profile whose default
// model was changed. This list always ships with the app and keeps working whatever the user added. Owner: ui-views.
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Skeleton } from '@renderer/components/ui/feedback';
import { SectionLabel } from '@renderer/components/ui/layout';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { loadGpuCatalog } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';
import { contextLabel, gpuSpec, profileModels, splitModelLabel } from '../gpu/model';
import { shippedDefaultId } from './model';
import { formatGb } from './model';
import { restoreProfileDefault } from './store';

const COLS = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_64px_62px] items-center gap-3 px-6';

export function Recommended() {
  const settings = useSettings((s) => s.settings);
  const catalog = useGpu((s) => s.catalog);

  useEffect(() => {
    if (!catalog) void loadGpuCatalog(false, true);
  }, [catalog]);

  const builtin = useMemo(() => (catalog ?? []).filter((m) => m.source !== 'user'), [catalog]);
  const profiles = settings?.vast.profiles;

  if (!catalog || !settings) {
    return (
      <div className="flex flex-col gap-2 px-6 py-5" aria-hidden>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pb-10" data-testid="models-recommended-tab">
      <p className="max-w-[78ch] px-6 pt-4 text-[11.5px] leading-[1.55] text-t3">
        These models ship with the app and were checked against Hugging Face. They stay available whatever you add, and cannot be edited or removed.
        Pick a profile's model in the GPU view, or change which one it clocks in with by default from My models.
      </p>
      {(profiles ?? []).map((profile) => (
        <ProfileSection key={profile.id} profile={profile} catalog={builtin} />
      ))}
    </div>
  );
}

function ProfileSection({ profile, catalog }: { profile: GpuProfile; catalog: CatalogModel[] }) {
  const all = useGpu((s) => s.catalog) ?? [];
  const models = profileModels(catalog, profile);
  const shipped = shippedDefaultId(profile.id);
  const changed = !!shipped && profile.defaultModelId !== shipped;
  const current = all.find((m) => m.id === profile.defaultModelId);
  const shippedModel = catalog.find((m) => m.id === shipped);

  return (
    <section className="pt-6" aria-label={`${profile.label} profile`} data-testid={`models-profile-${profile.id}`}>
      <div className="px-6">
        <SectionLabel
          rule
          action={
            changed ? (
              <Tooltip content={shippedModel ? `Back to ${shippedModel.label}` : 'Back to the recommended default'}>
                <Button size="sm" variant="ghost" icon={RotateCcw} className="-mr-2.5" onClick={() => void restoreProfileDefault(profile.id)} data-testid="models-restore-default">
                  Restore default
                </Button>
              </Tooltip>
            ) : (
              <span className="text-t3">default is the recommended one</span>
            )
          }
        >
          {profile.label}
          <span className="ml-2 normal-case tracking-normal text-t3">{gpuSpec(profile)}</span>
        </SectionLabel>
        {changed && current ? (
          <div className="mt-2 text-[11px] text-t3" data-testid="models-default-changed">
            Clocks in with <span className="text-t1">{splitModelLabel(current.label).name}</span>
            {current.quant ? <span className="font-mono"> {current.quant}</span> : null} instead of the recommended default.
          </div>
        ) : null}
      </div>
      <div role="table" aria-label={`${profile.label} models`} className="mt-1">
        {models.length === 0 ? <div className="px-6 py-3 text-[11.5px] text-t3">No recommended models for this profile.</div> : null}
        {models.map((m) => {
          const { name, detail } = splitModelLabel(m.label);
          const isDefault = m.id === profile.defaultModelId;
          return (
            <div key={m.id} role="row" className={cn(COLS, 'min-h-7 border-b border-rule2 py-1')} data-testid="models-recommended-row" data-id={m.id}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[12px] tracking-[-0.012em] text-t1" title={m.label}>
                  {name}
                </span>
                {isDefault ? <Badge tone="accent">default</Badge> : null}
                {m.id === shipped && !isDefault ? <Badge tone="neutral">recommended</Badge> : null}
                {m.experimental ? <Badge tone="warning">experimental</Badge> : null}
              </span>
              <span className="truncate font-mono text-[9.5px] tracking-[0.01em] text-t3" title={detail || undefined}>
                {detail || '—'}
              </span>
              <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">
                {formatGb(m.sizeGb).replace(' GB', '')}
                <span className="ob-unit ml-1">gb</span>
              </span>
              <span className="ob-num text-right font-mono text-[10.5px] tracking-[-0.02em] text-t2">{contextLabel(m.contextLength)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
