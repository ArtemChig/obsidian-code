import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_PROFILES } from '../../../src/core/gpu/profiles';
import {
  DEFAULT_CONTEXT_CAP,
  MAX_PLANNED_CONTEXT,
  estimateParamsB,
  estimateVramGb,
  kvCacheGb,
  planFit,
  profileCapacityGb,
  profilesFitting,
} from '../../../src/shared/model-fit';

const profiles = DEFAULT_GPU_PROFILES.map((p) => ({ id: p.id, numGpus: p.numGpus, minGpuRamGb: p.minGpuRamGb }));

describe('profile capacity', () => {
  it('is the nominal card size: Vast reports 30 for a 32 GB card, 90 for a 96 GB one', () => {
    expect(profiles.map(profileCapacityGb)).toEqual([32, 96, 192]);
    expect(profileCapacityGb({ numGpus: 1, minGpuRamGb: 22 })).toBe(24);
    expect(profileCapacityGb({ numGpus: 4, minGpuRamGb: 78 })).toBe(320);
  });

  it('profilesFitting keeps the input order and compares against the nominal size', () => {
    expect(profilesFitting(32, profiles)).toEqual(['light', 'standard', 'max']);
    expect(profilesFitting(33, profiles)).toEqual(['standard', 'max']);
    expect(profilesFitting(96, profiles)).toEqual(['standard', 'max']);
    expect(profilesFitting(97, profiles)).toEqual(['max']);
    expect(profilesFitting(500, profiles)).toEqual([]);
  });
});

describe('VRAM estimate', () => {
  it('weights + overhead + KV cache', () => {
    // 20 GB, 8k context, 27B params: overhead 1.5 + 0.4, KV 8 x (0.045 + 0.0022 x 27.3)
    const est = estimateVramGb({ sizeGb: 20, contextLength: 8192, totalParams: 27.3e9 });
    expect(est).toBeCloseTo(20 + 1.9 + 8 * (0.045 + 0.0022 * 27.3), 3);
  });

  it('vision adds compute-buffer headroom', () => {
    const a = estimateVramGb({ sizeGb: 10, contextLength: 8192, totalParams: 8e9 });
    const b = estimateVramGb({ sizeGb: 10, contextLength: 8192, totalParams: 8e9, vision: true });
    expect(b - a).toBeCloseTo(0.6, 5);
  });

  it('KV grows with context and is capped per 1k tokens', () => {
    expect(kvCacheGb(65536, 27)).toBeCloseTo(2 * kvCacheGb(32768, 27), 6);
    expect(kvCacheGb(1024, 5000)).toBeCloseTo(0.4, 6);
  });

  it('guesses the parameter count from the size when the header has none (~4.8 bits/weight)', () => {
    expect(estimateParamsB(24, undefined)).toBeCloseTo(40, 3);
    expect(estimateParamsB(24, 27e9)).toBe(27);
    expect(estimateParamsB(0, undefined)).toBeGreaterThan(0);
  });
});

describe('planFit', () => {
  it('a 27B Q5 fits the Light profile with a long-enough context, and the bigger profiles too', () => {
    const fit = planFit({ sizeGb: 21.15, ggufContext: 262144, totalParams: 27.3e9, profiles });
    expect(fit.profiles).toEqual(['light', 'standard', 'max']);
    expect(fit.minTotalVramGb).toBeLessThanOrEqual(32);
    expect(fit.contextLength).toBeGreaterThanOrEqual(32768);
    expect(fit.contextLength).toBeLessThanOrEqual(131072);
    // the estimate at the chosen context is what is stored, rounded up
    expect(fit.minTotalVramGb).toBe(Math.ceil(estimateVramGb({ sizeGb: 21.15, contextLength: fit.contextLength, totalParams: 27.3e9 })));
  });

  it('never picks a context the smallest fitting profile cannot hold', () => {
    for (const sizeGb of [4, 9, 15, 21, 28, 40, 70, 120, 160]) {
      const fit = planFit({ sizeGb, ggufContext: 131072, profiles });
      if (fit.profiles.length === 0) continue;
      const smallest = Math.min(...profiles.filter((p) => fit.profiles.includes(p.id)).map(profileCapacityGb));
      expect(fit.minTotalVramGb, `size ${sizeGb}`).toBeLessThanOrEqual(smallest);
    }
  });

  it('a tiny model gets the full GGUF context on every profile', () => {
    const fit = planFit({ sizeGb: 0.8, ggufContext: 32768, totalParams: 0.8e9, profiles });
    expect(fit.contextLength).toBe(32768);
    expect(fit.profiles).toEqual(['light', 'standard', 'max']);
  });

  it('an unusual GGUF context length is used as it is when it fits (40960)', () => {
    expect(planFit({ sizeGb: 4.5, ggufContext: 40960, totalParams: 8e9, profiles }).contextLength).toBe(40960);
  });

  it('caps the context: 1M-token models stop at 262144, unknown context at 131072', () => {
    expect(planFit({ sizeGb: 1, ggufContext: 1_048_576, totalParams: 1e9, profiles }).contextLength).toBe(MAX_PLANNED_CONTEXT);
    expect(planFit({ sizeGb: 1, totalParams: 1e9, profiles }).contextLength).toBe(DEFAULT_CONTEXT_CAP);
  });

  it('a model that only fits a bigger profile does not list the smaller ones', () => {
    const fit = planFit({ sizeGb: 60, ggufContext: 131072, totalParams: 70e9, profiles });
    expect(fit.profiles).toEqual(['standard', 'max']);
    expect(fit.minTotalVramGb).toBeGreaterThan(32);
    expect(fit.minTotalVramGb).toBeLessThanOrEqual(96);
  });

  it('a model bigger than every profile: no profiles, 32k context, honest VRAM figure', () => {
    const fit = planFit({ sizeGb: 400, ggufContext: 131072, totalParams: 600e9, profiles });
    expect(fit.profiles).toEqual([]);
    expect(fit.contextLength).toBe(32768);
    expect(fit.minTotalVramGb).toBeGreaterThan(400);
  });

  it('works with custom profiles and with none at all', () => {
    const custom = [{ id: 'c4090', numGpus: 1, minGpuRamGb: 22 }];
    const fit = planFit({ sizeGb: 14, ggufContext: 32768, totalParams: 14e9, profiles: custom });
    expect(fit.profiles).toEqual(['c4090']);
    expect(planFit({ sizeGb: 14, ggufContext: 32768, profiles: [] }).profiles).toEqual([]);
  });

  it('ignores a nonsense GGUF context', () => {
    expect(planFit({ sizeGb: 1, ggufContext: -5, totalParams: 1e9, profiles }).contextLength).toBe(DEFAULT_CONTEXT_CAP);
    expect(planFit({ sizeGb: 1, ggufContext: Number.NaN, totalParams: 1e9, profiles }).contextLength).toBe(DEFAULT_CONTEXT_CAP);
    expect(planFit({ sizeGb: 1, ggufContext: 100, totalParams: 1e9, profiles }).contextLength).toBeGreaterThanOrEqual(2048);
  });
});
