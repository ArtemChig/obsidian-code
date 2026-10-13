import { describe, expect, it } from 'vitest';
import type { CatalogModel, ModelInfo } from '@shared/types';
import { contextUsage, knownContextLength } from '@renderer/features/chat/lib/context';

const catalog = [{ id: 'qwen38-27b-uncensored-hauhau-q5kp', contextLength: 131072 }] as unknown as CatalogModel[];
const listed = { contextLength: 131072 } as unknown as ModelInfo;

describe('context meter', () => {
  it('measures against the listed model', () => {
    expect(knownContextLength(listed, { provider: 'vast', model: 'qwen38-27b-uncensored-hauhau-q5kp' }, null)).toBe(131072);
    expect(contextUsage(48131, 131072, 0.8)).toMatchObject({ pct: 37, tone: 'normal' });
  });

  // Regression (final live test, v1.1.0): after clock-out the Vast model is no longer listed and the header fell back
  // to a 32,768-token window, so a 48k-token session showed a red "CTX 100%".
  it('uses the catalog for an offline Vast model instead of a 32k guess', () => {
    const total = knownContextLength(undefined, { provider: 'vast', model: 'qwen38-27b-uncensored-hauhau-q5kp' }, catalog);
    expect(total).toBe(131072);
    expect(contextUsage(48131, total, 0.8)).toMatchObject({ pct: 37, tone: 'normal' });
  });

  it('shows unknown (not 100%) when the context size cannot be known', () => {
    expect(knownContextLength(undefined, { provider: 'vast', model: 'qwen38-27b-uncensored-hauhau-q5kp' }, null)).toBeNull();
    expect(knownContextLength(undefined, { provider: 'local', model: 'x' }, catalog)).toBeNull();
    expect(contextUsage(48131, null, 0.8)).toEqual({ pct: null, ratio: 0, tone: 'normal' });
  });

  it('warns near and errors past the auto-compact line', () => {
    expect(contextUsage(65_000, 100_000, 0.8).tone).toBe('warn');
    expect(contextUsage(85_000, 100_000, 0.8).tone).toBe('error');
    expect(contextUsage(500_000, 100_000, 0.8).pct).toBe(100);
  });
});
