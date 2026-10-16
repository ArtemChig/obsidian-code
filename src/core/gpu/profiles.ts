// Default Vast.ai GPU profiles (owner: gpu). Values from docs/research/vast-api.md §9 (live prices 2026-10-12).
// The settings store (platform) may seed Settings.vast.profiles from DEFAULT_GPU_PROFILES; the GPU manager falls
// back to these when the settings carry no profiles.

import type { GpuProfile } from '../../shared/types';
import { DEFAULT_GPU_PROFILES } from '../../shared/gpu-profiles';

export { DEFAULT_GPU_PROFILES, RTX_PRO_6000_NAMES } from '../../shared/gpu-profiles';

export function defaultProfiles(): GpuProfile[] {
  return DEFAULT_GPU_PROFILES.map((p) => ({ ...p, gpuNames: [...p.gpuNames] }));
}

/** Look a profile up in the settings' profiles, falling back to the defaults. */
export function findProfile(profiles: GpuProfile[] | undefined, id: string): GpuProfile | undefined {
  return (profiles ?? []).find((p) => p.id === id) ?? DEFAULT_GPU_PROFILES.find((p) => p.id === id);
}
