import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../src/core/gpu/catalog';
import { DEFAULT_GPU_PROFILES } from '../../../src/core/gpu/profiles';
import { isSafeGgufPath, parseModelDetail } from '../../../src/shared/hub-parse';
import type { HubModelDetail } from '../../../src/shared/hub';
import {
  MAX_FAVORITE_REPOS,
  MAX_USER_MODELS,
  UserModelError,
  buildUserModel,
  guessVariant,
  pickMmproj,
  repoDisplayName,
  sanitizeFavoriteRepos,
  sanitizeUserModel,
  sanitizeUserModels,
  shortHash,
  slug,
  userModelId,
  withCurrentProfiles,
} from '../../../src/shared/user-models';

const fixture = (name: string): any => JSON.parse(readFileSync(path.join(__dirname, '../../fixtures/hub', name), 'utf8'));
const qwen = (): HubModelDetail => parseModelDetail(fixture('detail-unsloth-qwen38-27b.json'))!;
const glm = (): HubModelDetail => parseModelDetail(fixture('detail-unsloth-glm53-flash.json'))!;
const profiles = DEFAULT_GPU_PROFILES.map((p) => ({ id: p.id, numGpus: p.numGpus, minGpuRamGb: p.minGpuRamGb }));
const variant = (d: HubModelDetail, label: string) => d.variants.find((v) => v.label === label)!;
const BUILTIN_IDS = new Set(CATALOG.map((m) => m.id));

describe('isSafeGgufPath', () => {
  it.each(['model.gguf', 'Q4_K_M/model-Q4_K_M-00001-of-00002.gguf', 'Qwen3.8-27B-UD-Q5_K_XL.gguf', 'a/b/c.d-e_f+g=h@i,j(1).GGUF'])('accepts %s', (p) => {
    expect(isSafeGgufPath(p)).toBe(true);
  });

  it.each([
    '',
    'model.bin',
    '../model.gguf',
    'a/../b.gguf',
    '/abs/model.gguf',
    'a//b.gguf',
    '.hidden.gguf',
    'a/.hidden/b.gguf',
    'model name.gguf',
    'model;rm -rf.gguf',
    'model$(id).gguf',
    'model`id`.gguf',
    "model'.gguf",
    'model"x".gguf',
    'model|x.gguf',
    'model&x.gguf',
    'model\n.gguf',
    'model[1].gguf',
    'model*.gguf',
    'ünïcode.gguf',
    'a\\b.gguf',
    'x'.repeat(401) + '.gguf',
  ])('rejects %j', (p) => {
    expect(isSafeGgufPath(p)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isSafeGgufPath(undefined)).toBe(false);
    expect(isSafeGgufPath(null)).toBe(false);
    expect(isSafeGgufPath(5)).toBe(false);
    expect(isSafeGgufPath(['a.gguf'])).toBe(false);
  });
});

describe('ids and names', () => {
  it('slug keeps only safe characters', () => {
    expect(slug('Qwen3.8-27B GGUF/UD Q4_K_XL')).toBe('qwen3.8-27b-gguf-ud-q4_k_xl');
    expect(slug('--A..B--')).toBe('a..b');
    expect(slug('ünï;$(x)')).toBe('n-x');
  });

  it('userModelId is deterministic, safe, prefixed and bounded', () => {
    const id = userModelId('unsloth/Qwen3.8-27B-GGUF', 'UD-Q4_K_XL');
    expect(id).toBe('hf-unsloth-qwen3.8-27b-gguf-ud-q4_k_xl');
    expect(userModelId('unsloth/Qwen3.8-27B-GGUF', 'UD-Q4_K_XL')).toBe(id);
    expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,99}$/);
    expect(BUILTIN_IDS.has(id)).toBe(false);
    const long = userModelId('some-author/' + 'Very-Long-Model-Name-'.repeat(8) + 'GGUF', 'UD-Q4_K_XL');
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    // two long names that share a prefix still differ
    const a = userModelId('x/' + 'a'.repeat(120), 'Q4_K_M');
    const b = userModelId('x/' + 'a'.repeat(120) + 'b', 'Q4_K_M');
    expect(a).not.toBe(b);
  });

  it('a disambiguator separates two variants with the same label', () => {
    const a = userModelId('a/b', 'Q4_K_M', 'x/m-Q4_K_M.gguf');
    const b = userModelId('a/b', 'Q4_K_M', 'y/m-Q4_K_M.gguf');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^hf-a-b-q4_k_m-[a-z0-9]{6}$/);
    expect(shortHash('x')).toBe(shortHash('x'));
    expect(shortHash('x')).not.toBe(shortHash('y'));
  });

  it('display name drops the GGUF suffix; hostile-looking text cannot leave the safe alphabet', () => {
    expect(repoDisplayName('unsloth/Qwen3.8-27B-GGUF')).toBe('Qwen3.8-27B');
    expect(repoDisplayName('a/Model_gguf')).toBe('Model');
    expect(repoDisplayName('a/gguf')).toBe('gguf');
    expect(userModelId('a/b', "q';rm -rf /;'")).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });

  it('guessVariant', () => {
    expect(guessVariant('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF')).toBe('uncensored');
    expect(guessVariant('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF')).toBe('uncensored');
    expect(guessVariant('DavidAU/Qwen3.8-27B-Heretic-NEO-GGUF')).toBe('uncensored');
    expect(guessVariant('unsloth/Qwen3.8-27B-GGUF')).toBe('standard');
  });

  it('pickMmproj prefers F16, then BF16, then the smallest', () => {
    const mm = (file: string, label: string, sizeBytes: number) => ({ file, label, sizeBytes, sizeGb: sizeBytes / 1e9 });
    expect(pickMmproj([mm('a', 'BF16', 5), mm('b', 'F16', 9)])!.file).toBe('b');
    expect(pickMmproj([mm('a', 'BF16', 5), mm('b', 'Q8_0', 1)])!.file).toBe('a');
    expect(pickMmproj([mm('a', 'unknown', 5), mm('b', 'unknown', 3)])!.file).toBe('b');
    expect(pickMmproj([])).toBeUndefined();
  });
});

describe('buildUserModel (recorded unsloth/Qwen3.8-27B-GGUF)', () => {
  it('turns a picked quant into a catalog model', () => {
    const d = qwen();
    const m = buildUserModel({ detail: d, variant: variant(d, 'UD-Q4_K_XL'), profiles, today: '2026-10-16' });
    expect(m).toMatchObject({
      id: 'hf-unsloth-qwen3.8-27b-gguf-ud-q4_k_xl',
      repo: 'unsloth/Qwen3.8-27B-GGUF',
      files: ['Qwen3.8-27B-UD-Q4_K_XL.gguf'],
      sizeGb: 17.56,
      llamaArgs: [],
      variant: 'standard',
      source: 'user',
      quant: 'UD-Q4_K_XL',
      verifiedAt: '2026-10-16',
    });
    expect(m.mmproj).toBeUndefined();
    expect(m.label).toBe('Qwen3.8-27B - UD-Q4_K_XL - unsloth');
    expect(m.family).toBe('hf-qwen3.8-27b');
    expect(m.notes).toContain('huggingface.co/unsloth/Qwen3.8-27B-GGUF');
    expect(m.notes).toContain('apache-2.0');
    // planned against the default profiles, context capped by the header's 262144
    expect(m.profiles).toEqual(['light', 'standard', 'max']);
    expect(m.contextLength).toBeLessThanOrEqual(262144);
    expect(m.minTotalVramGb).toBeGreaterThan(m.sizeGb);
    expect(m.minTotalVramGb).toBeLessThanOrEqual(32);
  });

  it('with vision it downloads the F16 projector too and counts it in sizeGb', () => {
    const d = qwen();
    const v = variant(d, 'UD-Q4_K_XL');
    const m = buildUserModel({ detail: d, variant: v, withVision: true, profiles });
    expect(m.mmproj).toBe('mmproj-F16.gguf');
    expect(m.sizeGb).toBeCloseTo((v.sizeBytes + 927607488) / 1e9, 2);
  });

  it('a split variant keeps every part in order', () => {
    const d = glm();
    const m = buildUserModel({ detail: d, variant: variant(d, 'UD-IQ4_XS'), profiles });
    expect(m.files).toHaveLength(5);
    expect(m.files[0]).toBe('UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00001-of-00005.gguf');
    expect(m.files[4]).toBe('UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00005-of-00005.gguf');
    expect(m.sizeGb).toBeCloseTo(156.82, 2);
    // 157 GB of weights: only the Max profile (192 GB) can hold it, at a reduced context (header says 1M)
    expect(m.profiles).toEqual(['max']);
    expect(m.contextLength).toBeLessThanOrEqual(262144);
  });

  it('a model bigger than every profile is still built, with no profiles', () => {
    const d = glm();
    const m = buildUserModel({ detail: d, variant: variant(d, 'BF16'), profiles });
    expect(m.profiles).toEqual([]);
    expect(m.minTotalVramGb).toBeGreaterThan(192);
  });

  it('results are valid for the sanitizer (what the settings store will keep)', () => {
    const d = qwen();
    for (const v of d.variants) {
      const m = buildUserModel({ detail: d, variant: v, profiles });
      expect(sanitizeUserModel(m, BUILTIN_IDS), v.label).toEqual(m);
    }
  });

  it('refuses gated repos with an explanation', () => {
    const d = { ...qwen(), gated: true };
    const err = (() => {
      try {
        buildUserModel({ detail: d, variant: variant(d, 'Q8_0'), profiles });
      } catch (e) {
        return e as UserModelError;
      }
    })();
    expect(err).toBeInstanceOf(UserModelError);
    expect(err!.code).toBe('gated');
    expect(err!.message).toMatch(/gated/);
    expect(err!.message).toMatch(/login/);
  });

  it('refuses a vision request when the repo has no projector', () => {
    const d = { ...qwen(), mmprojs: [] };
    expect(() => buildUserModel({ detail: d, variant: variant(d, 'Q8_0'), withVision: true, profiles })).toThrow(/no vision projector/);
  });

  it('refuses unknown sizes and unsupported file names', () => {
    const d = qwen();
    const v = { ...variant(d, 'Q8_0'), sizeKnown: false, sizeBytes: 0 };
    expect(() => buildUserModel({ detail: d, variant: v, profiles })).toThrow(/file sizes/);
    const odd = { ...variant(d, 'Q8_0'), files: ['model name.gguf'], unsupported: 'bad name' };
    expect(() => buildUserModel({ detail: d, variant: odd, profiles })).toThrow(/bad name/);
    const odd2 = { ...variant(d, 'Q8_0'), files: ['a;b.gguf'] };
    expect(() => buildUserModel({ detail: d, variant: odd2, profiles })).toThrow(/cannot download/);
  });

  it('refuses a bad repo id', () => {
    const d = { ...qwen(), repo: 'a/b;c' };
    expect(() => buildUserModel({ detail: d, variant: variant(d, 'Q8_0'), profiles })).toThrow(/repo id/);
  });

  it('two variants with the same label get different ids', () => {
    const d = qwen();
    const base = variant(d, 'Q8_0');
    const dup = { ...base, id: 'copy/Qwen3.8-27B-Q8_0.gguf', files: ['copy/Qwen3.8-27B-Q8_0.gguf'], folder: 'copy' };
    const detail = { ...d, variants: [...d.variants, dup] };
    const a = buildUserModel({ detail, variant: base, profiles });
    const b = buildUserModel({ detail, variant: dup, profiles });
    expect(a.id).not.toBe(b.id);
  });
});

describe('sanitizeUserModel / sanitizeUserModels', () => {
  const good = () =>
    buildUserModel({ detail: qwen(), variant: variant(qwen(), 'UD-Q4_K_XL'), withVision: true, profiles, today: '2026-10-16' });

  it('keeps a valid model unchanged and drops unknown keys', () => {
    const m = good();
    expect(sanitizeUserModel(m, BUILTIN_IDS)).toEqual(m);
    const withExtra = { ...m, evil: 'x', __proto__: { polluted: true } } as unknown;
    const clean = sanitizeUserModel(withExtra, BUILTIN_IDS)!;
    expect(clean).toEqual(m);
    expect('evil' in clean).toBe(false);
  });

  it.each<[string, (m: any) => void]>([
    ['id with a space', (m) => (m.id = 'hf a')],
    ['id with a quote', (m) => (m.id = "hf-a'b")],
    ['id with upper case', (m) => (m.id = 'Hf-A')],
    ['id starting with a dash', (m) => (m.id = '-hf-a')],
    ['id too long', (m) => (m.id = 'a'.repeat(121))],
    ['missing id', (m) => delete m.id],
    ['a built-in id', (m) => (m.id = 'qwen38-27b-uncensored-hauhau-q5kp')],
    ['repo with a shell character', (m) => (m.repo = 'a/b;rm -rf /')],
    ['repo without an owner', (m) => (m.repo = 'justname')],
    ['repo with a path', (m) => (m.repo = 'a/b/c')],
    ['empty files', (m) => (m.files = [])],
    ['files not an array', (m) => (m.files = 'x.gguf')],
    ['file with ..', (m) => (m.files = ['../../etc/passwd.gguf'])],
    ['file with a command substitution', (m) => (m.files = ['$(id).gguf'])],
    ['file that is not gguf', (m) => (m.files = ['model.bin'])],
    ['one bad file among good ones', (m) => (m.files = ['ok.gguf', 'x y.gguf'])],
    ['duplicate files', (m) => (m.files = ['a.gguf', 'a.gguf'])],
    ['too many files', (m) => (m.files = Array.from({ length: 201 }, (_, i) => `p${i}.gguf`))],
    ['mmproj with a bad name', (m) => (m.mmproj = 'mm proj.gguf')],
    ['zero size', (m) => (m.sizeGb = 0)],
    ['negative size', (m) => (m.sizeGb = -3)],
    ['NaN size', (m) => (m.sizeGb = Number.NaN)],
    ['Infinity size', (m) => (m.sizeGb = Infinity)],
    ['string size', (m) => (m.sizeGb = '20')],
    ['absurd size', (m) => (m.sizeGb = 1e9)],
    ['zero vram', (m) => (m.minTotalVramGb = 0)],
    ['negative vram', (m) => (m.minTotalVramGb = -1)],
    ['tiny context', (m) => (m.contextLength = 10)],
    ['NaN context', (m) => (m.contextLength = Number.NaN)],
    ['not an object', () => undefined],
  ])('rejects: %s', (_name, mutate) => {
    const m = good() as any;
    mutate(m);
    const input = _name === 'not an object' ? 'string' : m;
    expect(sanitizeUserModel(input, BUILTIN_IDS)).toBeNull();
  });

  it('rejects null, arrays and primitives', () => {
    for (const bad of [null, undefined, 3, 'x', [], true]) expect(sanitizeUserModel(bad, BUILTIN_IDS)).toBeNull();
  });

  it('normalises soft fields instead of rejecting', () => {
    const m = { ...good(), variant: 'weird', family: 'bad family!', profiles: ['light', 'bad id!', 5, 'light'], label: '  x\u0007y\n  ', sizeGb: 20.123456, minTotalVramGb: 23.2, contextLength: 32768.7, source: 'builtin', verifiedAt: 'yesterday', quant: 'bad quant!', experimental: 'yes', notes: 7 };
    const c = sanitizeUserModel(m, BUILTIN_IDS)!;
    expect(c.variant).toBe('standard');
    expect(c.family).toMatch(/^hf-/);
    expect(c.profiles).toEqual(['light']);
    expect(c.label).toBe('x y');
    expect(c.sizeGb).toBe(20.12);
    expect(c.minTotalVramGb).toBe(24);
    expect(c.contextLength).toBe(32769);
    expect(c.source).toBe('user');
    expect(c.verifiedAt).toBeUndefined();
    expect(c.quant).toBeUndefined();
    expect(c.experimental).toBeUndefined();
    expect(c.notes).toBeUndefined();
  });

  it('llama args: strings only, no control characters, bounded', () => {
    const m = { ...good(), llamaArgs: ['--jinja', 5, 'a\nb', '', 'x'.repeat(301), '{modelDir}/mtp.gguf', ...Array.from({ length: 60 }, (_, i) => `--f${i}`)] };
    const c = sanitizeUserModel(m, BUILTIN_IDS)!;
    expect(c.llamaArgs.length).toBe(40);
    expect(c.llamaArgs.slice(0, 2)).toEqual(['--jinja', '{modelDir}/mtp.gguf']);
    expect(c.llamaArgs.every((a) => !/[\u0000-\u001f]/.test(a))).toBe(true);
  });

  it('a list: drops bad entries, dedupes by id (first wins), caps the count, ignores non-arrays', () => {
    const a = good();
    const b = { ...good(), id: 'hf-other', files: ['other-Q8_0.gguf'] };
    const out = sanitizeUserModels([a, { ...a, label: 'dup' }, { ...a, id: 'bad id' }, null, b], BUILTIN_IDS);
    expect(out.map((m) => m.id)).toEqual([a.id, 'hf-other']);
    expect(out[0].label).toBe(a.label);
    expect(sanitizeUserModels('nope')).toEqual([]);
    expect(sanitizeUserModels(undefined)).toEqual([]);
    const many = Array.from({ length: MAX_USER_MODELS + 20 }, (_, i) => ({ ...a, id: `hf-m${i}` }));
    expect(sanitizeUserModels(many, BUILTIN_IDS)).toHaveLength(MAX_USER_MODELS);
  });

  it('favorites: valid unique repo ids, order kept', () => {
    expect(sanitizeFavoriteRepos(['a/b', 'a/b', 'bad', 5, 'c/d;e', 'x/y'])).toEqual(['a/b', 'x/y']);
    expect(sanitizeFavoriteRepos('a/b')).toEqual([]);
    const many = Array.from({ length: MAX_FAVORITE_REPOS + 5 }, (_, i) => `o/m${i}`);
    expect(sanitizeFavoriteRepos(many)).toHaveLength(MAX_FAVORITE_REPOS);
  });

  it('withCurrentProfiles recomputes the fitting profiles, including a newly added one', () => {
    const m = good(); // fits Light and up
    const custom = [...profiles, { id: 'tiny', numGpus: 1, minGpuRamGb: 8 }, { id: 'big', numGpus: 1, minGpuRamGb: 40 }];
    const [r] = withCurrentProfiles([m], custom);
    expect(r.profiles).toEqual(['light', 'standard', 'max', 'big']);
    expect(withCurrentProfiles([m], [])[0].profiles).toEqual([]);
    expect(m.profiles).toEqual(['light', 'standard', 'max']); // input untouched
  });
});
