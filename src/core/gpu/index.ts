// GPU / Vast.ai module entry point (owner: gpu). SPEC §2.1:
//   export function createGpuManager(ctx: CoreContext): GpuManager & { start(): Promise<void> };
// start() = reconcile instances (adopt the tracked one, report orphans, expire parked) and begin heartbeats.
// The optional second argument is for tests and tooling (mock Vast base URL, timings, resources dir).

import type { CoreContext, GpuManager } from '../contracts';
import { GpuManagerImpl, type GpuManagerOptions } from './manager';

export function createGpuManager(ctx: CoreContext, opts?: GpuManagerOptions): GpuManager & { start(): Promise<void> } {
  return new GpuManagerImpl(ctx, opts);
}

export { AutoClockOut, createAutoClockOut, REASONING_ONLY_LIMIT } from './auto-clockout';
export type { AutoClockOutOptions } from './auto-clockout';
export { GpuManagerImpl, DEFAULT_TIMINGS, DEFAULT_VAST_SETTINGS, SERVER_KEY_SECRET, VAST_KEY_SECRET } from './manager';
export type { GpuManagerOptions, GpuTimings } from './manager';
export {
  CATALOG, catalogModels, getCatalogModel, siblingVariant, toggleVariant, defaultModelForProfile, experimentalFallback,
  estimateWarmupSeconds, estimateWarmupCost, warmupLabel, diskGbFor, modelsForProfile, isExperimental,
} from './catalog';
export { DEFAULT_GPU_PROFILES, defaultProfiles, findProfile } from './profiles';
export { VastClient, VastError, buildOfferQuery, toGpuOffer, APP_LABEL, VAST_DEFAULT_BASE_URL } from './vast-client';
export { VastProvider } from './provider';
export { HubClient, HubError } from './hub';
export { bindUserCatalog, createModelBrowser, ModelBrowserError } from './model-browser';
export { setUserCatalogModels, userCatalogModels, builtinCatalogModels, serverCatalog, isUserModel } from './catalog';
