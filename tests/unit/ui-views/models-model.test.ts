// Pure helpers of the Models view (features/models/model.ts), run on the recorded Hugging Face responses.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_PROFILES } from '@shared/gpu-profiles';
import type { HubModelDetail, HubModelSummary } from '@shared/hub';
import { parseModelDetail } from '@shared/hub-parse';
import type { CatalogModel, GpuProfile } from '@shared/types';
import { buildUserModel } from '@shared/user-models';
import {
  SORT_OPTIONS,
  TYPE_OPTIONS,
  addState,
  addedCountFor,
  addedModelFor,
  buildVariantRows,
  changedDefaults,
  compactCount,
  defaultTargets,
  detailBadges,
  directRepo,
  fitSummary,
  formatContext,
  formatGb,
  formatParams,
  mergePages,
  parseIso,
  profilesDefaultingTo,
  recommendedVariant,
  repoUrl,
  shippedDefaultId,
  smallestFitting,
  sortLabel,
  splitRepo,
  withDefaultModel,
} from '@renderer/features/models/model';

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, '../../fixtures/hub', name), 'utf8'));
const qwen = (): HubModelDetail => parseModelDetail(fixture('detail-unsloth-qwen38-27b.json'))!;
const glm = (): HubModelDetail => parseModelDetail(fixture('detail-unsloth-glm53-flash.json'))!;
const profiles: GpuProfile[] = DEFAULT_GPU_PROFILES.map((p) => ({ ...p, gpuNames: [...p.gpuNames] }));

describe('formatting', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [25_300, '25k'],
    [999_499, '999k'],
    [999_999, '1M'],
    [6_663_225, '6.7M'],
    [12_010_068, '12M'],
    [2_500_000_000, '2.5B'],
  ])('compactCount(%d) = %s', (n, s) => {
    expect(compactCount(n)).toBe(s);
  });

  it('compactCount tolerates junk', () => {
    expect(compactCount(undefined)).toBe('—');
    expect(compactCount(null)).toBe('—');
    expect(compactCount(Number.NaN)).toBe('—');
    expect(compactCount(-5)).toBe('—');
  });

  it('formatParams / formatContext / formatGb', () => {
    expect(formatParams(27_320_697_856)).toBe('27.3B');
    expect(formatParams(800_000_000)).toBe('0.8B');
    expect(formatParams(1_100_000_000)).toBe('1.1B');
    expect(formatParams(320_759_404_382)).toBe('321B');
    expect(formatParams(undefined)).toBe('—');
    expect(formatParams(0)).toBe('—');
    expect(formatContext(262_144)).toBe('262k');
    expect(formatContext(131_072)).toBe('131k');
    expect(formatContext(1_048_576)).toBe('1M');
    expect(formatContext(undefined)).toBe('—');
    expect(formatGb(17.56)).toBe('17.6 GB');
    expect(formatGb(0.93)).toBe('0.93 GB');
    expect(formatGb(157.99)).toBe('158 GB');
    expect(formatGb(null)).toBe('—');
  });

  it('repo helpers', () => {
    expect(splitRepo('unsloth/Qwen3.8-27B-GGUF')).toEqual({ author: 'unsloth', name: 'Qwen3.8-27B-GGUF' });
    expect(splitRepo('weird')).toEqual({ author: '', name: 'weird' });
    expect(repoUrl('a/b')).toBe('https://huggingface.co/a/b');
    expect(parseIso('2026-08-20T12:04:25.000Z')).toBe(Date.parse('2026-08-20T12:04:25.000Z'));
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso('not a date')).toBeNull();
  });

  it('sort and type options cover what the hub accepts', () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(['downloads', 'likes', 'lastModified', 'trendingScore']);
    expect(sortLabel('lastModified')).toBe('Recently updated');
    expect(TYPE_OPTIONS.map((o) => o.value)).toEqual(['all', 'text-generation', 'image-text-to-text']);
  });

  it('fitSummary reads naturally', () => {
    expect(fitSummary(['light', 'standard', 'max'], profiles)).toBe('Light, Standard and Max');
    expect(fitSummary(['standard', 'max'], profiles)).toBe('Standard and Max');
    expect(fitSummary(['max'], profiles)).toBe('Max');
    expect(fitSummary([], profiles)).toBe('none of your profiles');
    expect(fitSummary(['gone'], profiles)).toBe('gone');
  });
});

describe('directRepo (what the search box can open directly)', () => {
  it.each([
    ['unsloth/Qwen3.8-27B-GGUF', 'unsloth/Qwen3.8-27B-GGUF'],
    ['  https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/tree/main ', 'unsloth/Qwen3.8-27B-GGUF'],
    ['hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL', 'unsloth/Qwen3.8-27B-GGUF'],
  ])('%s', (input, repo) => {
    expect(directRepo(input)?.repo).toBe(repo);
  });

  it('plain words, spaces and foreign hosts are searches, not repos', () => {
    for (const q of ['', '  ', 'qwen', 'qwen coder', 'https://example.com/a/b', 'a/b c', 'qwen3 gguf']) expect(directRepo(q), q).toBeNull();
  });
});

describe('variant rows (recorded unsloth/Qwen3.8-27B-GGUF)', () => {
  const opts = (over: Partial<Parameters<typeof buildVariantRows>[1]> = {}) => ({ profiles, profileId: 'light', withVision: false, userModels: [] as CatalogModel[], ...over });

  it('one row per variant, with the planned fit and the smallest-first order of the hub', () => {
    const d = qwen();
    const rows = buildVariantRows(d, opts());
    expect(rows).toHaveLength(d.variants.length);
    expect(rows.map((r) => r.variant.id)).toEqual(d.variants.map((v) => v.id));
    for (const r of rows) {
      expect(r.fit.contextLength).toBeGreaterThanOrEqual(32768);
      expect(r.addable).toBe(true);
      expect(r.added).toBeNull();
    }
    const bf16 = rows.find((r) => r.variant.label === 'BF16')!;
    expect(bf16.fit.profiles).toEqual(['standard', 'max']);
    expect(bf16.fitsSelected).toBe(false);
    const q4 = rows.find((r) => r.variant.label === 'UD-Q4_K_XL')!;
    expect(q4.fitsSelected).toBe(true);
  });

  it('recommends the sweet-spot quant that fits the selected profile', () => {
    const d = qwen();
    expect(buildVariantRows(d, opts()).find((r) => r.recommended)!.variant.label).toBe('UD-Q4_K_XL');
    expect(buildVariantRows(d, opts({ profileId: 'max' })).find((r) => r.recommended)!.variant.label).toBe('UD-Q4_K_XL');
    // exactly one pick
    expect(buildVariantRows(d, opts()).filter((r) => r.recommended)).toHaveLength(1);
  });

  it('nothing fits a small profile: no pick', () => {
    const tiny: GpuProfile[] = [{ ...profiles[0], id: 'tiny', label: 'Tiny', minGpuRamGb: 8 }];
    const rows = buildVariantRows(qwen(), opts({ profiles: tiny, profileId: 'tiny' }));
    expect(rows.some((r) => r.recommended)).toBe(false);
    expect(rows.every((r) => !r.fitsSelected)).toBe(true);
    expect(recommendedVariant(rows)).toBeUndefined();
  });

  it('vision adds the projector size and headroom to every row', () => {
    const d = qwen();
    const plain = buildVariantRows(d, opts());
    const vis = buildVariantRows(d, opts({ withVision: true }));
    const a = plain.find((r) => r.variant.label === 'Q8_0')!;
    const b = vis.find((r) => r.variant.label === 'Q8_0')!;
    expect(b.sizeGb - a.sizeGb).toBeCloseTo(0.93, 2);
    expect(b.fit.minTotalVramGb).toBeGreaterThanOrEqual(a.fit.minTotalVramGb);
  });

  it('marks variants the user already added (matched on repo + first file) and keeps the pick addable-aware', () => {
    const d = qwen();
    const v = d.variants.find((x) => x.label === 'UD-Q4_K_XL')!;
    const added = buildUserModel({ detail: d, variant: v, profiles });
    const rows = buildVariantRows(d, opts({ userModels: [added] }));
    const row = rows.find((r) => r.variant.id === v.id)!;
    expect(row.added?.id).toBe(added.id);
    expect(addState(row)).toBe('added');
    expect(rows.filter((r) => r.added)).toHaveLength(1);
    expect(addedModelFor([added], 'other/repo', v)).toBeNull();
    expect(addedCountFor([added, { ...added, id: 'x2' }], d.repo)).toBe(2);
    expect(addedCountFor([added], 'other/repo')).toBe(0);
  });

  it('a gated repo cannot be added, whatever the quant', () => {
    const rows = buildVariantRows({ ...qwen(), gated: true }, opts());
    expect(rows.every((r) => !r.addable && addState(r) === 'blocked')).toBe(true);
    expect(rows[0].reason).toMatch(/Gated/);
    expect(rows.some((r) => r.recommended)).toBe(false);
  });

  it('unsupported file names and unknown sizes block that variant only', () => {
    const d = qwen();
    d.variants[0] = { ...d.variants[0], unsupported: 'bad file name' };
    d.variants[1] = { ...d.variants[1], sizeKnown: false };
    const rows = buildVariantRows(d, opts());
    expect(rows[0]).toMatchObject({ addable: false, reason: 'bad file name' });
    expect(rows[1].addable).toBe(false);
    expect(rows[1].reason).toMatch(/sizes/);
    expect(rows[2].addable).toBe(true);
    expect(addState(rows[0])).toBe('blocked');
  });

  it('a huge model: bigger than every profile says so, the biggest profile still lists what fits it', () => {
    const rows = buildVariantRows(glm(), opts({ profileId: 'max' }));
    const iq4 = rows.find((r) => r.variant.label === 'UD-IQ4_XS')!;
    expect(iq4.fit.profiles).toEqual(['max']);
    expect(iq4.fitsSelected).toBe(true);
    const bf16 = rows.find((r) => r.variant.label === 'BF16')!;
    expect(bf16.fit.profiles).toEqual([]);
    expect(bf16.fitsSelected).toBe(false);
    expect(rows.find((r) => r.recommended)!.fit.profiles).toContain('max');
  });

  it('smallestFitting picks the smallest profile by VRAM', () => {
    expect(smallestFitting(['max', 'standard'], profiles)?.id).toBe('standard');
    expect(smallestFitting([], profiles)).toBeUndefined();
  });
});

describe('profile defaults', () => {
  it('knows the shipped default of each profile and which ones were changed', () => {
    expect(shippedDefaultId('light')).toBe('qwen38-27b-uncensored-hauhau-q5kp');
    expect(shippedDefaultId('custom')).toBeUndefined();
    expect(changedDefaults(profiles)).toEqual([]);
    const next = withDefaultModel(profiles, 'light', 'hf-x');
    expect(next.find((p) => p.id === 'light')!.defaultModelId).toBe('hf-x');
    expect(profiles.find((p) => p.id === 'light')!.defaultModelId).toBe('qwen38-27b-uncensored-hauhau-q5kp'); // input untouched
    expect(changedDefaults(next).map((c) => [c.profile.id, c.shippedId])).toEqual([['light', 'qwen38-27b-uncensored-hauhau-q5kp']]);
    // a custom profile has no shipped default, so it never offers a restore
    expect(changedDefaults([{ ...profiles[0], id: 'custom', defaultModelId: 'whatever' }])).toEqual([]);
  });

  it('defaultTargets are the profiles a model fits; profilesDefaultingTo finds who uses it', () => {
    const model = { profiles: ['standard', 'max'] } as CatalogModel;
    expect(defaultTargets(model, profiles).map((p) => p.id)).toEqual(['standard', 'max']);
    const next = withDefaultModel(profiles, 'standard', 'hf-x');
    expect(profilesDefaultingTo(next, 'hf-x').map((p) => p.id)).toEqual(['standard']);
    expect(profilesDefaultingTo(next, 'nope')).toEqual([]);
  });
});

describe('result rows', () => {
  const m = (repo: string): HubModelSummary => ({ repo, author: '', name: repo, downloads: 0, likes: 0, gated: false, baseModels: [], tags: [], quantLabels: [], hasVision: false });

  it('mergePages keeps order and drops repeats from a shifted ranking', () => {
    expect(mergePages([m('a/1'), m('a/2')], [m('a/2'), m('a/3')]).map((x) => x.repo)).toEqual(['a/1', 'a/2', 'a/3']);
    expect(mergePages([], [m('a/1')])).toHaveLength(1);
  });

  it('detailBadges: task, vision, then the repo tags, bounded', () => {
    expect(detailBadges({ pipelineTag: 'text-generation', hasVision: true, gated: false, quantLabels: [], tags: ['unsloth', 'imatrix'] })).toEqual(['text-generation', 'vision', 'unsloth', 'imatrix']);
    expect(detailBadges({ pipelineTag: 'image-text-to-text', hasVision: true, gated: false, quantLabels: [], tags: [] })).toEqual(['image-text-to-text']);
    expect(detailBadges({ hasVision: false, gated: false, quantLabels: [], tags: Array.from({ length: 30 }, (_, i) => `t${i}`) })).toHaveLength(10);
  });
});
