// "This model will not answer" notice shown above the composer (and the Home quick start) before the user sends:
// local server down, GPU not clocked in, custom endpoint offline… with the fix as one click. Owner: ui-chat.
import { TriangleAlert } from 'lucide-react';
import type { ModelRef } from '@shared/types';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/cn';
import { navigate, openPalette, openSettings } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useModels } from '@renderer/state/models';
import { modelReadiness, type ModelReadiness } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { gpuPrimaryAction } from '@renderer/app/GpuWidget';

export function useModelReadiness(ref: ModelRef | null | undefined): ModelReadiness | null {
  const models = useModels((s) => s.models);
  const providers = useModels((s) => s.providers);
  const loaded = useModels((s) => s.loaded);
  const defaultModel = useSettings((s) => s.settings?.defaultModel ?? null);
  const phase = useGpu((s) => s.status?.phase);
  return loaded ? modelReadiness(ref, defaultModel, models, providers, phase) : null;
}

const ACTION_LABEL: Record<ModelReadiness['action'], string> = {
  'clock-in': 'Clock in',
  gpu: 'Open GPU',
  settings: 'Model settings',
  switch: 'Switch model',
};

export function ModelNotice({ model, className }: { model: ModelRef | null | undefined; className?: string }) {
  const r = useModelReadiness(model);
  const status = useGpu((s) => s.status);
  const hasKey = useGpu((s) => s.hasApiKey);
  if (!r) return null;
  const act = () => {
    if (r.action === 'clock-in') void gpuPrimaryAction(status, hasKey);
    else if (r.action === 'gpu') navigate('gpu');
    else if (r.action === 'settings') openSettings('models');
    else openPalette('models');
  };
  return (
    <div
      role="status"
      data-testid="model-notice"
      data-action={r.action}
      className={cn('flex items-center gap-2 rounded-[10px] border border-[rgba(232,184,92,0.3)] bg-ob-warning-soft py-1.5 pl-3 pr-1.5 text-small text-ob-text', className)}
    >
      <TriangleAlert size={13} aria-hidden className="shrink-0 text-ob-warning" />
      <span className="min-w-0 flex-1">{r.message}</span>
      <Button size="sm" variant="secondary" className="h-6 shrink-0 px-2" onClick={act} data-testid="model-notice-action">
        {ACTION_LABEL[r.action]}
      </Button>
      {r.action !== 'switch' ? (
        <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2" onClick={() => openPalette('models')}>
          Switch model
        </Button>
      ) : null}
    </div>
  );
}
