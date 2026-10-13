import { describe, expect, it } from 'vitest';
import type { CatalogModel, GpuOffer, GpuProfile } from '@shared/types';
import {
  availableVariants,
  baseName,
  budgetRatio,
  budgetTone,
  contextLabel,
  formatWarmup,
  gpuSpec,
  hoursLeft,
  isTestModel,
  priceStats,
  profileModels,
  profileVramGb,
  safeModeSummary,
  siblingModel,
  splitModelLabel,
  sumCost,
  warmupCost,
  warmupSeconds,
} from '@renderer/features/gpu/model';

const offer = (price: number, location = 'X'): GpuOffer => ({ offerId: Math.round(price * 1000), gpuName: 'RTX 5090', numGpus: 1, gpuRamGb: 31.8, cpuRamGb: 64, diskGb: 100, inetDownMbps: 1000, reliability: 0.99, pricePerHour: price, location, datacenter: false, verified: true });

const model = (id: string, family: string, variant: 'uncensored' | 'standard', profiles: string[], sizeGb: number, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  label: `${family} ${variant} - quant ${sizeGb}`,
  family,
  variant,
  repo: 'r/x',
  files: ['a.gguf'],
  sizeGb,
  minTotalVramGb: 32,
  contextLength: 131072,
  llamaArgs: [],
  profiles,
  ...extra,
});

const CATALOG: CatalogModel[] = [
  model('q27-u-q5', 'q27', 'uncensored', ['light'], 21),
  model('q27-u-heretic', 'q27', 'uncensored', ['light'], 20.5),
  model('q27-s-q5', 'q27', 'standard', ['light'], 21.8),
  model('q27-u-q8', 'q27', 'uncensored', ['standard'], 32.4),
  model('q27-s-q8', 'q27', 'standard', ['standard'], 30),
  model('flash-u', 'flash', 'uncensored', ['standard'], 111, { experimental: true }),
  model('flash-s', 'flash', 'standard', ['standard'], 106, { experimental: true }),
  model('glm-u', 'glm', 'uncensored', ['max'], 158, { experimental: true }),
  model('test-tiny', 'test', 'standard', ['light', 'standard', 'max'], 0.8),
];

const LIGHT: Pick<GpuProfile, 'id' | 'defaultModelId'> = { id: 'light', defaultModelId: 'q27-u-q5' };
const STANDARD: Pick<GpuProfile, 'id' | 'defaultModelId'> = { id: 'standard', defaultModelId: 'flash-u' };
const MAX: Pick<GpuProfile, 'id' | 'defaultModelId'> = { id: 'max', defaultModelId: 'glm-u' };

describe('price statistics and budget maths', () => {
  it('computes cheapest / median / max', () => {
    expect(priceStats([])).toBeNull();
    expect(priceStats(null)).toBeNull();
    const odd = priceStats([offer(0.7), offer(0.5), offer(0.6)]);
    expect(odd).toMatchObject({ count: 3, min: 0.5, median: 0.6, max: 0.7 });
    expect(odd?.best.pricePerHour).toBe(0.5);
    const even = priceStats([offer(0.5), offer(0.6), offer(0.8), offer(1)]);
    expect(even?.median).toBeCloseTo(0.7);
    expect(priceStats([offer(0.52)])).toMatchObject({ min: 0.52, median: 0.52, max: 0.52 });
  });

  it('hoursLeft = (budget - month) / price, floored and clamped', () => {
    expect(hoursLeft(150, 37.42, 0.524)).toBe(214);
    expect(hoursLeft(150, 200, 0.5)).toBe(0);
    expect(hoursLeft(150, 0, 0)).toBeNull();
    expect(hoursLeft(NaN, 0, 1)).toBeNull();
  });

  it('budget ratio and tone', () => {
    expect(budgetRatio(150, 37.5)).toBeCloseTo(0.25);
    expect(budgetRatio(150, 999)).toBe(1);
    expect(budgetRatio(0, 5)).toBe(0);
    expect(budgetTone(0.5)).toBe('accent');
    expect(budgetTone(0.75)).toBe('warning');
    expect(budgetTone(0.95)).toBe('danger');
  });

  it('sumCost ignores non-finite values', () => {
    expect(sumCost([{ cost: 1.5 }, { cost: 2.25 }, { cost: Number.NaN }])).toBeCloseTo(3.75);
  });
});

describe('warm-up estimate', () => {
  it('scales with the download size', () => {
    const small = warmupSeconds({ sizeGb: 21.15 });
    const huge = warmupSeconds({ sizeGb: 111.33 });
    expect(small).toBeGreaterThan(200);
    expect(small).toBeLessThan(420);
    expect(huge).toBeGreaterThan(900);
    expect(huge).toBeLessThan(1500);
    expect(warmupSeconds(undefined)).toBe(0);
  });

  it('formats minutes and hours', () => {
    expect(formatWarmup(0)).toBe('—');
    expect(formatWarmup(20)).toBe('~1 min');
    expect(formatWarmup(300)).toBe('~5 min');
    expect(formatWarmup(3900)).toBe('~1 h 05 min');
    expect(formatWarmup(7200)).toBe('~2 h');
  });

  it('prices the warm-up', () => {
    expect(warmupCost(1800, 0.6)).toBeCloseTo(0.3);
    expect(warmupCost(1800, undefined)).toBeNull();
  });
});

describe('profiles and catalog', () => {
  it('describes the hardware', () => {
    expect(gpuSpec({ numGpus: 1, gpuNames: ['RTX 5090'] })).toBe('1× RTX 5090');
    expect(gpuSpec({ numGpus: 2, gpuNames: ['RTX PRO 6000 WS', 'RTX PRO 6000 S'] })).toBe('2× RTX PRO 6000');
    expect(profileVramGb({ numGpus: 1, minGpuRamGb: 30 })).toBe(32);
    expect(profileVramGb({ numGpus: 2, minGpuRamGb: 90 })).toBe(192);
  });

  it('lists the models of a profile and hides test models unless asked', () => {
    expect(profileModels(CATALOG, LIGHT).map((m: CatalogModel) => m.id).sort()).toEqual(['q27-s-q5', 'q27-u-heretic', 'q27-u-q5']);
    expect(profileModels(CATALOG, LIGHT, { includeTest: true }).map((m: CatalogModel) => m.id)).toContain('test-tiny');
    expect(isTestModel(CATALOG[8])).toBe(true);
    expect(isTestModel(CATALOG[0])).toBe(false);
    expect(profileModels(CATALOG, MAX).map((m: CatalogModel) => m.id)).toEqual(['glm-u']);
  });

  it('finds the sibling of the same family when the variant toggle flips', () => {
    const q5 = CATALOG[0];
    expect(siblingModel(CATALOG, q5, 'standard', LIGHT)?.id).toBe('q27-s-q5');
    expect(siblingModel(CATALOG, CATALOG[2], 'uncensored', LIGHT)?.id).toBe('q27-u-q5'); // closest size to 21.8 among 21 / 20.5
    // standard profile: the same family wins over another family
    expect(siblingModel(CATALOG, CATALOG[5], 'standard', STANDARD)?.id).toBe('flash-s');
    expect(siblingModel(CATALOG, CATALOG[3], 'standard', STANDARD)?.id).toBe('q27-s-q8');
  });

  it('falls back to any model of the variant, or undefined when none exists', () => {
    // max has no standard build
    expect(siblingModel(CATALOG, CATALOG[7], 'standard', MAX)).toBeUndefined();
    // no current model: prefer the profile default
    expect(siblingModel(CATALOG, undefined, 'uncensored', LIGHT)?.id).toBe('q27-u-q5');
    // current family absent from the variant pool: take any in the pool
    const onlyFlashStd = CATALOG.filter((m) => m.id !== 'q27-s-q8' && m.id !== 'q27-s-q5');
    expect(siblingModel(onlyFlashStd, CATALOG[3], 'standard', STANDARD)?.id).toBe('flash-s');
  });

  it('knows which variants a profile offers', () => {
    expect([...availableVariants(CATALOG, LIGHT)].sort()).toEqual(['standard', 'uncensored']);
    expect([...availableVariants(CATALOG, MAX)]).toEqual(['uncensored']);
  });

  it('formats labels and context sizes', () => {
    expect(splitModelLabel('Qwen3.8 27B Uncensored - HauhauCS Q5_K_P')).toEqual({ name: 'Qwen3.8 27B Uncensored', detail: 'HauhauCS Q5_K_P' });
    expect(splitModelLabel('Qwen3.8 27B Uncensored · HauhauCS Q5_K_P')).toEqual({ name: 'Qwen3.8 27B Uncensored', detail: 'HauhauCS Q5_K_P' });
    expect(splitModelLabel('Plain')).toEqual({ name: 'Plain', detail: '' });
    expect(contextLabel(131072)).toBe('128k ctx');
    expect(contextLabel(1048576)).toBe('1M ctx');
  });
});

describe('safe mode notice', () => {
  it('names what the fallback dropped and the context it runs with', () => {
    expect(safeModeSummary({ droppedFeatures: ['mtp', 'vision'], serverContextLength: 65536 })).toBe('MTP speculative decoding and vision disabled because the full configuration failed to load. Context 64K.');
    expect(safeModeSummary({ droppedFeatures: ['mtp', 'vision', 'flash-attn', 'kv-quant'] })).toBe('MTP speculative decoding, vision, flash attention and the q8_0 KV cache disabled because the full configuration failed to load.');
    expect(safeModeSummary({ droppedFeatures: ['vision'] })).toBe('Vision disabled because the full configuration failed to load.');
    expect(safeModeSummary({})).toMatch(/reduced setup/);
    expect(baseName('C:\\Users\\a\\logs\\gpu-1-20261013-070203.log')).toBe('gpu-1-20261013-070203.log');
    expect(baseName('/home/a/logs/gpu-2.log')).toBe('gpu-2.log');
  });
});
