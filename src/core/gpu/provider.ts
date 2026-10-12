// LlmProvider for the rented Vast.ai GPU (owner: gpu). id 'vast'.
// endpoint() = local tunnel URL + per-instance llama-server API key, only while the GPU is 'ready'.
// listModels() = the catalog model loaded on the instance (status follows the clock-in phase).

import type { Endpoint, LlmProvider } from '../contracts';
import type { CatalogModel, GpuPhase, GpuStatus, ModelInfo, ProviderInfo, ProviderStatus } from '../../shared/types';

export interface VastProviderSource {
  status(): GpuStatus;
  apiKey(): string | null;
  currentModel(): CatalogModel | null;
}

export function providerStatusFor(phase: GpuPhase): ProviderStatus {
  switch (phase) {
    case 'ready':
      return 'online';
    case 'off':
    case 'stopping':
      return 'offline';
    case 'error':
      return 'error';
    default:
      return 'starting';
  }
}

export function catalogModelInfo(m: CatalogModel, status: ProviderStatus): ModelInfo {
  return {
    ref: { provider: 'vast', model: m.id },
    label: m.label,
    contextLength: m.contextLength,
    supportsVision: !!m.mmproj,
    supportsTools: true,
    supportsThinking: true,
    variant: m.variant,
    status,
  };
}

export class VastProvider implements LlmProvider {
  readonly id = 'vast';

  constructor(private readonly src: VastProviderSource) {}

  info(): ProviderInfo {
    const s = this.src.status();
    const status = providerStatusFor(s.phase);
    let detail: string | undefined;
    if (s.phase === 'ready') detail = `${s.numGpus ?? 1}x ${s.gpuName ?? 'GPU'} · $${(s.pricePerHour ?? 0).toFixed(2)}/h`;
    else if (s.phase === 'error') detail = s.lastError ?? s.message;
    else if (s.phase === 'off') detail = 'Not clocked in';
    else detail = s.message;
    return {
      id: 'vast',
      label: 'Vast.ai GPU',
      status,
      baseUrl: s.phase === 'ready' && s.endpoint ? s.endpoint : null,
      detail,
    };
  }

  endpoint(): Endpoint | null {
    const s = this.src.status();
    const key = this.src.apiKey();
    if (s.phase !== 'ready' || !s.endpoint || !key) return null;
    return { baseUrl: s.endpoint, apiKey: key };
  }

  async listModels(): Promise<ModelInfo[]> {
    const m = this.src.currentModel();
    if (!m) return [];
    return [catalogModelInfo(m, providerStatusFor(this.src.status().phase))];
  }
}
