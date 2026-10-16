import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HubClient,
  HubError,
  detectQuantLabel,
  isValidRepoId,
  parseGgufSiblings,
  parseModelDetail,
  parseModelSummary,
  parseRepoRef,
  quantBits,
  recommendVariant,
} from '../../../src/core/gpu/hub';
import type { HubQuantVariant } from '../../../src/shared/hub';

// Trimmed real responses of the public Hugging Face API (recorded 2026-10-16, see tests/fixtures/hub).
const fixture = (name: string): any => JSON.parse(readFileSync(path.join(__dirname, '../../fixtures/hub', name), 'utf8'));
const searchQwen = () => fixture('search-qwen.json');
const searchQwenLink = () => readFileSync(path.join(__dirname, '../../fixtures/hub/search-qwen.link.txt'), 'utf8').trim();
const detailQwen = () => fixture('detail-unsloth-qwen38-27b.json');
const detailGlm = () => fixture('detail-unsloth-glm53-flash.json');

const sib = (rfilename: string, size?: number) => (size === undefined ? { rfilename } : { rfilename, size });

describe('detectQuantLabel', () => {
  it.each([
    ['Qwen3.8-27B-UD-Q5_K_XL', 'UD-Q5_K_XL'],
    ['Qwen3.8-27B-UD-IQ4_XS', 'UD-IQ4_XS'],
    ['Qwen3.8-27B-Q8_0', 'Q8_0'],
    ['Qwen3.8-27B-BF16', 'BF16'],
    ['Meta-Llama-3.1-8B-Instruct.Q4_K_M', 'Q4_K_M'],
    ['llama-3-8b-instruct-q4_k_m', 'Q4_K_M'],
    ['Qwen3.8-27B-heretic-ara.i1-Q4_K_M', 'i1-Q4_K_M'],
    ['Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q5_K_P', 'Q5_K_P'],
    ['Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P', 'Q8_K_P'],
    ['gpt-oss-20b-mxfp4', 'MXFP4'],
    ['Foo-MXFP4_MOE', 'MXFP4_MOE'],
    ['phi-3-mini-4k-instruct-q4', 'Q4'],
    ['phi-3-mini-4k-instruct-fp16', 'F16'],
    ['model-f32', 'F32'],
    ['Llama-3.2-3B-Instruct-Q4_0_4_8', 'Q4_0_4_8'],
    ['Qwen3.8-Flash-Next-IQ4_NL', 'IQ4_NL'],
    ['tiny-TQ1_0', 'TQ1_0'],
    ['Model-Q4_K_M_instruct', 'Q4_K_M'],
  ])('%s -> %s', (stem, label) => {
    expect(detectQuantLabel(stem)).toBe(label);
  });

  it('finds nothing in names without a quant, and does not read model names as quants', () => {
    expect(detectQuantLabel('model')).toBeNull();
    expect(detectQuantLabel('imatrix_unsloth')).toBeNull();
    expect(detectQuantLabel('QwQ-32B')).toBeNull();
    expect(detectQuantLabel('Qwen3.8-27B')).toBeNull();
    expect(detectQuantLabel('SmolLM3-3B')).toBeNull();
  });

  it('quantBits ranks labels', () => {
    expect(quantBits('UD-Q5_K_XL')).toBe(5);
    expect(quantBits('IQ3_XXS')).toBe(3);
    expect(quantBits('BF16')).toBe(16);
    expect(quantBits('MXFP4')).toBe(4);
    expect(quantBits('unknown')).toBeNull();
  });
});

describe('parseGgufSiblings on real responses', () => {
  it('Qwen3.8-27B: single files, split BF16, mmproj and MTP head kept out of the variants', () => {
    const p = parseGgufSiblings(detailQwen().siblings);
    expect(p.warnings).toEqual([]);
    expect(p.variants).toHaveLength(25);
    // no mmproj, mtp or imatrix file became a variant
    expect(p.variants.some((v) => v.files.some((f) => /mmproj|mtp|imatrix/i.test(f)))).toBe(false);

    const bf16 = p.variants.find((v) => v.label === 'BF16')!;
    expect(bf16.parts).toBe(2);
    expect(bf16.files).toEqual(['BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf', 'BF16/Qwen3.8-27B-BF16-00002-of-00002.gguf']);
    expect(bf16.sizeBytes).toBe(49986159616 + 4671576000);
    expect(bf16.sizeGb).toBe(54.66);
    expect(bf16.sizeKnown).toBe(true);
    expect(bf16.folder).toBe('BF16');
    expect(bf16.id).toBe(bf16.files[0]);

    const q5 = p.variants.find((v) => v.label === 'UD-Q5_K_XL')!;
    expect(q5).toMatchObject({ files: ['Qwen3.8-27B-UD-Q5_K_XL.gguf'], sizeBytes: 20876938144, sizeGb: 20.88, parts: 1 });
    expect(q5.folder).toBeUndefined();

    expect(p.mmprojs.map((m) => [m.file, m.label])).toEqual([
      ['mmproj-F16.gguf', 'F16'],
      ['mmproj-BF16.gguf', 'BF16'],
    ]);
    expect(p.mmprojs[0].sizeBytes).toBe(927607488);
    expect(p.drafts).toEqual([{ file: 'MTP/mtp-Qwen3.8-27B-Q4_0.gguf', sizeBytes: 1369590656, sizeGb: 1.37, label: 'Q4_0' }]);
  });

  it('variants come smallest first', () => {
    const p = parseGgufSiblings(detailQwen().siblings);
    const sizes = p.variants.map((v) => v.sizeBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(p.variants[0].label).toBe('UD-IQ1_S');
    expect(p.variants.at(-1)!.label).toBe('BF16');
  });

  it('GLM-5.3-Flash: every quant lives in its own folder as a multi-part set (sizes summed, order kept)', () => {
    const p = parseGgufSiblings(detailGlm().siblings);
    expect(p.warnings).toEqual([]);
    const labels = p.variants.map((v) => v.label).sort();
    expect(labels).toEqual(['BF16', 'Q8_0', 'UD-IQ1_M', 'UD-IQ1_S', 'UD-IQ2_XXS', 'UD-IQ3_XXS', 'UD-IQ4_XS', 'UD-Q2_K_XL', 'UD-Q3_K_XL', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL']);

    const iq4 = p.variants.find((v) => v.label === 'UD-IQ4_XS')!;
    expect(iq4.parts).toBe(5);
    expect(iq4.folder).toBe('UD-IQ4_XS');
    expect(iq4.files[0]).toBe('UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00001-of-00005.gguf');
    expect(iq4.files[4]).toBe('UD-IQ4_XS/GLM-5.3-Flash-UD-IQ4_XS-00005-of-00005.gguf');
    expect(iq4.sizeBytes).toBe(9429984 + 49989334176 + 49607025280 + 49486530144 + 7729791616);
    expect(iq4.sizeGb).toBe(156.82);

    const bf16 = p.variants.find((v) => v.label === 'BF16')!;
    expect(bf16.parts).toBe(14);
    expect(p.mmprojs.map((m) => m.label).sort()).toEqual(['BF16', 'F16']);
  });

  it('puts parts in order even when the API lists them shuffled', () => {
    const p = parseGgufSiblings([
      sib('Q4_K_M/m-Q4_K_M-00003-of-00003.gguf', 3),
      sib('Q4_K_M/m-Q4_K_M-00001-of-00003.gguf', 1),
      sib('Q4_K_M/m-Q4_K_M-00002-of-00003.gguf', 2),
    ]);
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].files).toEqual([
      'Q4_K_M/m-Q4_K_M-00001-of-00003.gguf',
      'Q4_K_M/m-Q4_K_M-00002-of-00003.gguf',
      'Q4_K_M/m-Q4_K_M-00003-of-00003.gguf',
    ]);
    expect(p.variants[0].sizeBytes).toBe(6);
  });
});

describe('parseGgufSiblings edge cases', () => {
  it('leaves out an incomplete split set with a warning, keeps the rest', () => {
    const p = parseGgufSiblings([
      sib('m-Q4_K_M-00001-of-00003.gguf', 10),
      sib('m-Q4_K_M-00003-of-00003.gguf', 10),
      sib('m-Q8_0.gguf', 100),
    ]);
    expect(p.variants.map((v) => v.label)).toEqual(['Q8_0']);
    expect(p.warnings).toEqual(['Q4_K_M: 1 of 3 parts missing, left out']);
  });

  it('keeps two sets with the same label in different folders apart', () => {
    const p = parseGgufSiblings([
      sib('a/m-Q4_K_M-00001-of-00002.gguf', 5),
      sib('a/m-Q4_K_M-00002-of-00002.gguf', 5),
      sib('b/m-Q4_K_M-00001-of-00002.gguf', 7),
      sib('b/m-Q4_K_M-00002-of-00002.gguf', 7),
    ]);
    expect(p.variants.map((v) => [v.id, v.sizeBytes])).toEqual([
      ['a/m-Q4_K_M-00001-of-00002.gguf', 10],
      ['b/m-Q4_K_M-00001-of-00002.gguf', 14],
    ]);
  });

  it('a split set whose total differs is a different set; a non-5-digit "of" name is a plain file', () => {
    const p = parseGgufSiblings([sib('m-1-of-2.gguf', 4), sib('n-Q4_K_M-00001-of-00001.gguf', 9)]);
    expect(p.variants.map((v) => [v.files[0], v.parts])).toEqual([
      ['m-1-of-2.gguf', 1],
      ['n-Q4_K_M-00001-of-00001.gguf', 1],
    ]);
  });

  it('takes the label from the folder when the file name has none, and prefers the more specific folder label', () => {
    const p = parseGgufSiblings([
      sib('Q6_K/model-00001-of-00002.gguf', 1),
      sib('Q6_K/model-00002-of-00002.gguf', 1),
      sib('UD-Q4_K_XL/x-Q4_K_XL.gguf', 3),
      sib('weights.gguf', 4),
    ]);
    expect(p.variants.map((v) => v.label).sort()).toEqual(['Q6_K', 'UD-Q4_K_XL', 'unknown']);
  });

  it('ignores imatrix data, vocab files, LoRA adapters and non-gguf files, but not a model with imatrix in its name', () => {
    const p = parseGgufSiblings([
      sib('imatrix.gguf', 1),
      sib('imatrix_unsloth.gguf', 1),
      sib('ggml-vocab-llama.gguf', 1),
      sib('my-lora-F16.gguf', 1),
      sib('README.md', 1),
      sib('model.safetensors', 1),
      sib('.gitattributes', 1),
      sib('llama-imatrix-Q4_K_M.gguf', 8),
    ]);
    expect(p.variants.map((v) => v.files[0])).toEqual(['llama-imatrix-Q4_K_M.gguf']);
  });

  it('detects mmproj anywhere in the name and MTP heads by prefix or folder', () => {
    const p = parseGgufSiblings([
      sib('Qwen3.8-27B-heretic-ara.mmproj-f16.gguf', 5),
      sib('mmproj-model-bf16.gguf', 6),
      sib('mtp-Qwen3.8-Flash-Next-Q8_0.gguf', 7),
      sib('MTP/head.gguf', 8),
      sib('Qwen3.8-27B-heretic-ara.Q5_K_M.gguf', 9),
    ]);
    expect(p.variants.map((v) => v.label)).toEqual(['Q5_K_M']);
    expect(p.mmprojs.map((m) => [m.file, m.label])).toEqual([
      ['Qwen3.8-27B-heretic-ara.mmproj-f16.gguf', 'F16'],
      ['mmproj-model-bf16.gguf', 'BF16'],
    ]);
    expect(p.drafts.map((d) => d.file)).toEqual(['MTP/head.gguf', 'mtp-Qwen3.8-Flash-Next-Q8_0.gguf']);
  });

  it('without sizes (search results) variants still list, flagged sizeKnown=false', () => {
    const p = parseGgufSiblings([sib('a-Q4_K_M.gguf'), sib('a-Q8_0.gguf')]);
    expect(p.variants).toHaveLength(2);
    expect(p.variants.every((v) => !v.sizeKnown && v.sizeBytes === 0)).toBe(true);
  });

  it('falls back to lfs.size and survives garbage', () => {
    const p = parseGgufSiblings([{ rfilename: 'a-Q4_K_M.gguf', lfs: { size: 42 } }, null, 7, { size: 3 }, { rfilename: 5 }]);
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].sizeBytes).toBe(42);
    expect(parseGgufSiblings(undefined).variants).toEqual([]);
    expect(parseGgufSiblings('x').variants).toEqual([]);
  });
});

describe('parseModelSummary / parseModelDetail', () => {
  it('reads a real search hit', () => {
    const s = parseModelSummary(searchQwen()[0])!;
    expect(s).toMatchObject({
      repo: 'unsloth/Qwen3.8-27B-GGUF',
      author: 'unsloth',
      name: 'Qwen3.8-27B-GGUF',
      downloads: 6663225,
      likes: 5128,
      gated: false,
      license: 'apache-2.0',
      baseModels: ['Qwen/Qwen3.8-27B'],
      hasVision: true,
    });
    expect(s.quantLabels).toContain('UD-Q4_K_XL');
    expect(s.quantLabels).toContain('BF16');
    // sorted by bit width
    expect(quantBits(s.quantLabels[0])!).toBeLessThanOrEqual(quantBits(s.quantLabels.at(-1)!)!);
    // noise tags are gone, informative ones stay
    expect(s.tags).toEqual(expect.arrayContaining(['qwen3_5', 'unsloth', 'imatrix', 'conversational']));
    expect(s.tags.some((t) => t === 'gguf' || t.startsWith('license:') || t.startsWith('base_model:') || t.startsWith('region:'))).toBe(false);
  });

  it('reads every hit of the search fixture', () => {
    const models = searchQwen().map(parseModelSummary);
    expect(models.every((m: unknown) => m !== null)).toBe(true);
    expect(models).toHaveLength(3);
  });

  it('flags gated repos and rejects hits without a repo id', () => {
    expect(parseModelSummary({ id: 'a/b', gated: 'manual' })!.gated).toBe(true);
    expect(parseModelSummary({ id: 'a/b', gated: 'auto' })!.gated).toBe(true);
    expect(parseModelSummary({ id: 'a/b', gated: false })!.gated).toBe(false);
    expect(parseModelSummary({ downloads: 3 })).toBeNull();
    expect(parseModelSummary({ id: 'noslash' })).toBeNull();
    // ids end up in URLs and the catalog: malformed ones are not listed at all
    for (const bad of ['a/b/c', 'a/b;rm', '../x/y', 'a b/c', '/b', 'a/']) expect(parseModelSummary({ id: bad }), bad).toBeNull();
    expect(parseModelSummary(null)).toBeNull();
    expect(parseModelSummary([])).toBeNull();
  });

  it('license: tag first, then cardData; "other" shows the license name; base model relations are unwrapped', () => {
    expect(parseModelSummary({ id: 'a/b', cardData: { license: 'mit' } })!.license).toBe('mit');
    expect(parseModelSummary({ id: 'a/b', cardData: { license: 'other', license_name: 'qwen' } })!.license).toBe('qwen');
    const s = parseModelSummary({
      id: 'a/b',
      tags: ['base_model:quantized:x/y', 'base_model:finetune:x/z', 'base_model:x/y', 'license:apache-2.0'],
      cardData: { base_model: 'x/w' },
    })!;
    expect(s.baseModels).toEqual(['x/y', 'x/z', 'x/w']);
    expect(s.license).toBe('apache-2.0');
  });

  it('detail adds sizes, GGUF header facts and bits per weight (no chat template needed)', () => {
    const d = parseModelDetail(detailQwen())!;
    expect(d).toMatchObject({
      repo: 'unsloth/Qwen3.8-27B-GGUF',
      architecture: 'qwen35',
      contextLength: 262144,
      totalParams: 27320697856,
      license: 'apache-2.0',
    });
    expect(d.variants).toHaveLength(25);
    const q8 = d.variants.find((v) => v.label === 'Q8_0')!;
    expect(q8.bitsPerWeight).toBeCloseTo((29047086048 * 8) / 27320697856, 2);
    expect(q8.bitsPerWeight).toBeGreaterThan(8);
    expect(d.mmprojs).toHaveLength(2);
    expect(d.drafts).toHaveLength(1);
    expect(d.warnings).toEqual([]);
  });

  it('detail of a repo without a parsed GGUF header still works', () => {
    const d = parseModelDetail({ id: 'a/b', siblings: [sib('b-Q4_K_M.gguf', 100)] })!;
    expect(d.architecture).toBeUndefined();
    expect(d.totalParams).toBeUndefined();
    expect(d.variants[0].bitsPerWeight).toBeUndefined();
  });
});

describe('repo references', () => {
  it.each([
    ['unsloth/Qwen3.8-27B-GGUF', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
    ['  unsloth/Qwen3.8-27B-GGUF  ', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
    ['unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL', { repo: 'unsloth/Qwen3.8-27B-GGUF', quant: 'UD-Q4_K_XL' }],
    ['https://huggingface.co/unsloth/Qwen3.8-27B-GGUF', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
    ['https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/tree/main', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
    ['https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-Q8_0.gguf', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
    ['huggingface.co/unsloth/Qwen3.8-27B-GGUF?show_file_info=x.gguf', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
    ['hf.co/unsloth/Qwen3.8-27B-GGUF', { repo: 'unsloth/Qwen3.8-27B-GGUF' }],
  ])('%s', (input, want) => {
    expect(parseRepoRef(input)).toEqual(want);
  });

  it.each([
    '',
    'just-a-name',
    'a/b/c',
    'https://example.com/unsloth/Qwen3.8-27B-GGUF',
    'https://huggingface.co.evil.com/a/b',
    'https://huggingface.co/datasets/a/b',
    'https://huggingface.co/spaces/a/b',
    'https://huggingface.co/unsloth',
    '../etc/passwd',
    'a/b:bad quant',
    'a/b?x=1',
  ])('rejects %j', (input) => {
    expect(parseRepoRef(input)).toBeNull();
  });

  it('isValidRepoId', () => {
    expect(isValidRepoId('a/b')).toBe(true);
    expect(isValidRepoId('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF')).toBe(true);
    expect(isValidRepoId('a/b/c')).toBe(false);
    expect(isValidRepoId('a/..')).toBe(false);
    expect(isValidRepoId('/b')).toBe(false);
    expect(isValidRepoId('a b/c')).toBe(false);
  });
});

describe('recommendVariant', () => {
  const v = (label: string, gb: number): HubQuantVariant => ({
    id: `${label}.gguf`,
    label,
    files: [`${label}.gguf`],
    sizeBytes: gb * 1e9,
    sizeGb: gb,
    sizeKnown: true,
    parts: 1,
  });
  const set = [v('Q2_K', 10), v('Q4_K_M', 16), v('Q5_K_M', 19), v('Q8_0', 29), v('BF16', 54)];

  it('prefers the sweet spot', () => {
    expect(recommendVariant(set)!.label).toBe('Q4_K_M');
    expect(recommendVariant([v('UD-Q4_K_XL', 17), v('Q4_K_M', 16)])!.label).toBe('UD-Q4_K_XL');
    expect(recommendVariant([v('i1-Q4_K_M', 16), v('Q8_0', 29)])!.label).toBe('i1-Q4_K_M');
  });

  it('respects a size budget and says so when nothing fits', () => {
    expect(recommendVariant(set, { maxBytes: 12e9 })!.label).toBe('Q2_K');
    expect(recommendVariant(set, { maxBytes: 20e9 })!.label).toBe('Q4_K_M');
    expect(recommendVariant(set, { maxBytes: 5e9 })).toBeUndefined();
    expect(recommendVariant([{ ...v('Q4_K_M', 0), sizeKnown: false }], { maxBytes: 100e9 })).toBeUndefined();
  });

  it('falls back to the biggest quantised variant, then to the only float one', () => {
    expect(recommendVariant([v('Q3_K_S', 8), v('IQ3_M', 9), v('BF16', 50)])!.label).toBe('IQ3_M');
    expect(recommendVariant([v('BF16', 50), v('F16', 49)])!.label).toBe('F16');
    expect(recommendVariant([])).toBeUndefined();
  });
});

// ───────────────────────────── HubClient ─────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) }, ...init });
}

function mockFetch(handler: (url: string, n: number, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    calls.push(String(input));
    inits.push(init);
    return handler(String(input), calls.length, init);
  }) as unknown as typeof fetch;
  return { fn, calls, inits };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('HubClient.search', () => {
  it('builds the documented query and parses hits, cursor included', async () => {
    const link = searchQwenLink();
    const f = mockFetch(() => json(searchQwen(), { headers: { link: link.replace(/^Link:\s*/i, '') } }));
    const hub = new HubClient({ fetch: f.fn });
    const r = await hub.search({ query: ' qwen ', sort: 'likes', limit: 3 });

    const url = new URL(f.calls[0]);
    expect(url.origin + url.pathname).toBe('https://huggingface.co/api/models');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'qwen',
      filter: 'gguf',
      sort: 'likes',
      direction: '-1',
      limit: '3',
      full: 'true',
    });
    expect(f.inits[0]!.headers).toMatchObject({ Accept: 'application/json' });
    // an anonymous call: never an Authorization header
    expect(JSON.stringify(f.inits[0]!.headers)).not.toMatch(/authorization/i);

    expect(r.models).toHaveLength(3);
    expect(r.models[0].repo).toBe('unsloth/Qwen3.8-27B-GGUF');
    expect(r.cached).toBe(false);
    expect(r.stale).toBeUndefined();
    expect(typeof r.nextCursor).toBe('string');
    expect(r.nextCursor!.length).toBeGreaterThan(20);
  });

  it('sends the cursor back, defaults to downloads/30, clamps the limit and drops an empty query', async () => {
    const f = mockFetch(() => json([]));
    const hub = new HubClient({ fetch: f.fn });
    await hub.search({ cursor: 'abc/def==' });
    await hub.search({ limit: 5000, sort: 'bogus' as never, query: '   ' });
    await hub.search({ limit: 0 });
    const p = (i: number) => Object.fromEntries(new URL(f.calls[i]).searchParams);
    expect(p(0)).toEqual({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: '30', full: 'true', cursor: 'abc/def==' });
    expect(p(1)).toMatchObject({ sort: 'downloads', limit: '100' });
    expect(p(1).search).toBeUndefined();
    expect(p(2).limit).toBe('1');
  });

  it('no Link header = last page; a Link without a usable cursor is ignored', async () => {
    const hub1 = new HubClient({ fetch: mockFetch(() => json([])).fn });
    expect((await hub1.search()).nextCursor).toBeUndefined();
    const hub2 = new HubClient({ fetch: mockFetch(() => json([], { headers: { link: '<https://huggingface.co/api/models?x=1>; rel="next"' } })).fn });
    expect((await hub2.search()).nextCursor).toBeUndefined();
    const hub3 = new HubClient({ fetch: mockFetch(() => json([], { headers: { link: '<not a url>; rel="next"' } })).fn });
    expect((await hub3.search()).nextCursor).toBeUndefined();
  });

  it('skips hits it cannot read instead of failing the page', async () => {
    const f = mockFetch(() => json([{ id: 'a/b' }, { nonsense: true }, null, { id: 'e/f g' }, { id: 'c/d' }]));
    const r = await new HubClient({ fetch: f.fn }).search();
    expect(r.models.map((m) => m.repo)).toEqual(['a/b', 'c/d']);
  });

  it('a non-array body is a bad_response', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => json({ error: 'x' })).fn });
    await expect(hub.search()).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('HubClient.details', () => {
  it('requests blobs=true for the repo and returns the parsed detail', async () => {
    const f = mockFetch(() => json(detailQwen()));
    const hub = new HubClient({ fetch: f.fn });
    const d = await hub.details('unsloth/Qwen3.8-27B-GGUF');
    expect(f.calls).toEqual(['https://huggingface.co/api/models/unsloth/Qwen3.8-27B-GGUF?blobs=true']);
    expect(d.variants).toHaveLength(25);
    expect(d.contextLength).toBe(262144);
  });

  it('refuses a malformed repo id without calling the network', async () => {
    const f = mockFetch(() => json({}));
    const hub = new HubClient({ fetch: f.fn });
    for (const bad of ['', 'nope', 'a/b/c', '../../x', 'a/b?x=1', 'a/b#frag']) {
      await expect(hub.details(bad)).rejects.toMatchObject({ code: 'invalid_repo' });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('an anonymous 401 (what Hugging Face sends for a missing or private repo) reads as not found', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => json({ error: 'Invalid username or password.' }, { status: 401 })).fn });
    const e = await hub.details('nobody/nothing-GGUF').catch((x) => x);
    expect(e).toBeInstanceOf(HubError);
    expect(e).toMatchObject({ code: 'not_found', status: 401 });
    expect(e.message).toContain('nobody/nothing-GGUF');
    expect(e.message).toMatch(/private|gated/);
  });

  it('404 and 403 are not found too', async () => {
    for (const status of [404, 403]) {
      const hub = new HubClient({ fetch: mockFetch(() => new Response('no', { status })).fn });
      await expect(hub.details('a/b')).rejects.toMatchObject({ code: 'not_found', status });
    }
  });
});

describe('HubClient caching', () => {
  it('serves a repeated request from memory for 10 minutes, then refetches', async () => {
    const c = clock();
    const f = mockFetch(() => json(searchQwen()));
    const hub = new HubClient({ fetch: f.fn, now: c.now });
    const a = await hub.search({ query: 'qwen' });
    c.advance(9 * 60_000);
    const b = await hub.search({ query: 'qwen' });
    expect(f.calls).toHaveLength(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.fetchedAt).toBe(a.fetchedAt);
    expect(b.models).toEqual(a.models);
    c.advance(2 * 60_000);
    const d = await hub.search({ query: 'qwen' });
    expect(f.calls).toHaveLength(2);
    expect(d.cached).toBe(false);
    expect(d.fetchedAt).toBeGreaterThan(a.fetchedAt);
  });

  it('different queries, sorts, cursors and repos are cached separately', async () => {
    const f = mockFetch((url) => (url.includes('/api/models/') ? json(detailQwen()) : json([])));
    const hub = new HubClient({ fetch: f.fn });
    await hub.search({ query: 'a' });
    await hub.search({ query: 'b' });
    await hub.search({ query: 'a', sort: 'likes' });
    await hub.search({ query: 'a', cursor: 'x' });
    await hub.details('unsloth/Qwen3.8-27B-GGUF');
    await hub.details('unsloth/Qwen3.8-27B-GGUF');
    await hub.search({ query: 'a' });
    expect(f.calls).toHaveLength(5);
  });

  it('refresh bypasses a fresh entry; clearCache drops everything', async () => {
    const f = mockFetch(() => json([]));
    const hub = new HubClient({ fetch: f.fn });
    await hub.search({ query: 'a' });
    await hub.search({ query: 'a' }, { refresh: true });
    expect(f.calls).toHaveLength(2);
    hub.clearCache();
    await hub.search({ query: 'a' });
    expect(f.calls).toHaveLength(3);
  });

  it('concurrent identical requests share one fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = mockFetch(async () => {
      await gate;
      return json(searchQwen());
    });
    const hub = new HubClient({ fetch: f.fn });
    const [p1, p2, p3] = [hub.search({ query: 'q' }), hub.search({ query: 'q' }), hub.search({ query: 'q' }, { refresh: true })];
    release();
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(f.calls).toHaveLength(1);
    expect(a.models).toEqual(b.models);
    expect(c.models).toEqual(a.models);
  });

  it('callers cannot corrupt the cache by mutating a result', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => json(searchQwen())).fn });
    const a = await hub.search();
    a.models.length = 0;
    a.models.push({} as never);
    const b = await hub.search();
    expect(b.models).toHaveLength(3);
    expect(b.models[0].repo).toBe('unsloth/Qwen3.8-27B-GGUF');
  });

  it('evicts the oldest entries beyond the limit', async () => {
    const f = mockFetch(() => json([]));
    const hub = new HubClient({ fetch: f.fn, maxCacheEntries: 2 });
    await hub.search({ query: 'a' });
    await hub.search({ query: 'b' });
    await hub.search({ query: 'c' });
    expect(f.calls).toHaveLength(3);
    await hub.search({ query: 'c' });
    await hub.search({ query: 'b' });
    expect(f.calls).toHaveLength(3);
    await hub.search({ query: 'a' }); // was evicted
    expect(f.calls).toHaveLength(4);
  });

  it('errors are not cached', async () => {
    let fail = true;
    const f = mockFetch(() => (fail ? new Response('x', { status: 503 }) : json(searchQwen())));
    const hub = new HubClient({ fetch: f.fn });
    await expect(hub.search()).rejects.toMatchObject({ code: 'server' });
    fail = false;
    expect((await hub.search()).models).toHaveLength(3);
    expect(f.calls).toHaveLength(2);
  });
});

describe('HubClient errors', () => {
  it('429 with Retry-After', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '42' } })).fn });
    const e = await hub.search().catch((x) => x);
    expect(e).toMatchObject({ code: 'rate_limited', status: 429, retryAfterSec: 42 });
    expect(e.message).toBe('Hugging Face is limiting requests right now. Try again in 42 s.');
  });

  it('429 falls back to the RateLimit reset time, then to a generic hint', async () => {
    const a = new HubClient({ fetch: mockFetch(() => new Response('', { status: 429, headers: { ratelimit: '"api";r=0;t=28' } })).fn });
    expect(await a.search().catch((x) => x)).toMatchObject({ retryAfterSec: 28 });
    const b = new HubClient({ fetch: mockFetch(() => new Response('', { status: 429, headers: { 'retry-after': '300' } })).fn });
    expect((await b.search().catch((x) => x)).message).toContain('5 min');
    const c = new HubClient({ fetch: mockFetch(() => new Response('', { status: 429 })).fn });
    const e = await c.search().catch((x) => x);
    expect(e.retryAfterSec).toBeUndefined();
    expect(e.message).toContain('Try again in a minute');
  });

  it.each([500, 502, 503, 504])('HTTP %i is a friendly server error', async (status) => {
    const hub = new HubClient({ fetch: mockFetch(() => new Response('<html>oops</html>', { status })).fn });
    const e = await hub.search().catch((x) => x);
    expect(e).toMatchObject({ code: 'server', status });
    expect(e.message).toBe(`Hugging Face is having trouble right now (HTTP ${status}). Try again in a moment.`);
    expect(e.message).not.toContain('<html>');
  });

  it('other 4xx on search is bad_response', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => new Response('', { status: 400 })).fn });
    await expect(hub.search()).rejects.toMatchObject({ code: 'bad_response', status: 400 });
  });

  it('network failure keeps the cause but not its jargon in the message', async () => {
    const cause = new TypeError('fetch failed');
    const hub = new HubClient({
      fetch: mockFetch(() => {
        throw cause;
      }).fn,
    });
    const e = await hub.search().catch((x) => x);
    expect(e).toMatchObject({ code: 'network' });
    expect(e.cause).toBe(cause);
    expect(e.message).toBe("Can't reach Hugging Face. Check your internet connection and try again.");
  });

  it('unparseable body is bad_response', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => new Response('<!doctype html>', { status: 200 })).fn });
    await expect(hub.search()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('times out a request that honours the abort signal', async () => {
    const f = mockFetch(
      (_u, _n, init) =>
        new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const hub = new HubClient({ fetch: f.fn, timeoutMs: 30 });
    const t0 = Date.now();
    const e = await hub.search().catch((x) => x);
    expect(e).toMatchObject({ code: 'timeout' });
    expect(e.message).toContain('did not answer');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('times out even when the fetch ignores the abort signal and never settles', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => new Promise<Response>(() => undefined)).fn, timeoutMs: 30 });
    await expect(hub.details('a/b')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('times out a body that stalls after the headers', async () => {
    const f = mockFetch((_u, _n, init) => {
      const body = new ReadableStream({
        start(ctrl) {
          init!.signal!.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const hub = new HubClient({ fetch: f.fn, timeoutMs: 30 });
    await expect(hub.search()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a timeout is not cached and the next call can succeed', async () => {
    let stall = true;
    const f = mockFetch(() => (stall ? new Promise<Response>(() => undefined) : json(searchQwen())));
    const hub = new HubClient({ fetch: f.fn, timeoutMs: 20 });
    await expect(hub.search()).rejects.toMatchObject({ code: 'timeout' });
    stall = false;
    expect((await hub.search()).models).toHaveLength(3);
  });
});

describe('HubClient stale answers', () => {
  it('a failed refresh returns the older answer flagged stale', async () => {
    const c = clock();
    let down = false;
    const f = mockFetch(() => (down ? new Response('', { status: 503 }) : json(searchQwen())));
    const hub = new HubClient({ fetch: f.fn, now: c.now });
    const fresh = await hub.search({ query: 'qwen' });
    c.advance(30 * 60_000);
    down = true;
    const r = await hub.search({ query: 'qwen' });
    expect(r.stale).toBe(true);
    expect(r.cached).toBe(true);
    expect(r.fetchedAt).toBe(fresh.fetchedAt);
    expect(r.models).toEqual(fresh.models);
    // also for an explicit refresh, and for a rate limit
    expect((await hub.search({ query: 'qwen' }, { refresh: true })).stale).toBe(true);
  });

  it('never hides a not-found or invalid answer behind old data', async () => {
    const c = clock();
    let status = 200;
    const f = mockFetch(() => (status === 200 ? json(detailQwen()) : new Response('', { status })));
    const hub = new HubClient({ fetch: f.fn, now: c.now });
    await hub.details('a/b');
    c.advance(60 * 60_000);
    status = 404;
    await expect(hub.details('a/b')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('with nothing cached the error surfaces', async () => {
    const hub = new HubClient({ fetch: mockFetch(() => new Response('', { status: 503 })).fn });
    await expect(hub.search()).rejects.toMatchObject({ code: 'server' });
  });
});
