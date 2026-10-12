// Default Vast.ai GPU profiles (owner: gpu). Values from docs/research/vast-api.md §9 (live prices 2026-10-12).
// The settings store (platform) may seed Settings.vast.profiles from DEFAULT_GPU_PROFILES; the GPU manager falls
// back to these when the settings carry no profiles.

import type { GpuProfile } from '../../shared/types';

export const RTX_PRO_6000_NAMES = ['RTX PRO 6000 WS', 'RTX PRO 6000 S', 'RTX PRO 6000 Max-Q'];

export const DEFAULT_GPU_PROFILES: readonly GpuProfile[] = [
  {
    id: 'light',
    label: 'Light',
    description: '1x RTX 5090 (32 GB) - Qwen3.8 27B, 128k context, vision. About $0.50/h.',
    gpuNames: ['RTX 5090'],
    numGpus: 1,
    minGpuRamGb: 30,
    minCpuRamGb: 32,
    minDiskGb: 80,
    minInetDownMbps: 500,
    minReliability: 0.98,
    maxPricePerHour: 1.0,
    datacenterOnly: false,
    defaultModelId: 'qwen38-27b-uncensored-hauhau-q5kp',
  },
  {
    id: 'standard',
    label: 'Standard',
    description: '1x RTX PRO 6000 (96 GB) - Qwen3.8 Flash-Next 125B-A6B (experimental; falls back to 27B Q8). About $1.20/h.',
    gpuNames: [...RTX_PRO_6000_NAMES],
    numGpus: 1,
    minGpuRamGb: 90,
    minCpuRamGb: 64,
    minDiskGb: 200,
    minInetDownMbps: 1000,
    minReliability: 0.98,
    maxPricePerHour: 2.2,
    datacenterOnly: false,
    defaultModelId: 'qwen38-flash-next-uncensored-huihui-v2-q4kxl',
  },
  {
    id: 'max',
    label: 'Max',
    description: '2x RTX PRO 6000 (192 GB) - GLM-5.3 Flash 320B-A18B (experimental). About $2.60/h.',
    gpuNames: [...RTX_PRO_6000_NAMES],
    numGpus: 2,
    minGpuRamGb: 90,
    minCpuRamGb: 128,
    minDiskGb: 250,
    minInetDownMbps: 1000,
    minReliability: 0.97,
    maxPricePerHour: 4.0,
    datacenterOnly: false,
    defaultModelId: 'glm53-flash-uncensored-huihui-iq4xs',
  },
];

export function defaultProfiles(): GpuProfile[] {
  return DEFAULT_GPU_PROFILES.map((p) => ({ ...p, gpuNames: [...p.gpuNames] }));
}

/** Look a profile up in the settings' profiles, falling back to the defaults. */
export function findProfile(profiles: GpuProfile[] | undefined, id: string): GpuProfile | undefined {
  return (profiles ?? []).find((p) => p.id === id) ?? DEFAULT_GPU_PROFILES.find((p) => p.id === id);
}
