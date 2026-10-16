// The built-in catalog stays the default; models the user added join it (lookups, settings validation, config.sh, GPU manager).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG,
  builtinCatalogModels,
  catalogModels,
  defaultModelForProfile,
  experimentalFallback,
  getCatalogModel,
  isUserModel,
  modelsForProfile,
  serverCatalog,
  setUserCatalogModels,
  siblingVariant,
  userCatalogModels,
} from '../../../src/core/gpu/catalog';
import { DEFAULT_GPU_PROFILES } from '../../../src/core/gpu/profiles';
import { renderConfigSh } from '../../../src/core/gpu/server-scripts';
import { createSettingsStore, defaultSettings, validateSettings } from '../../../src/core/store/settings';
import type { CatalogModel } from '../../../src/shared/types';
import { createHarness, type Harness } from '../../fixtures/mock-vast/harness';

const profiles = DEFAULT_GPU_PROFILES.map((p) => ({ id: p.id, numGpus: p.numGpus, minGpuRamGb: p.minGpuRamGb }));

function userModel(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'hf-acme-tiny-q4_k_m',
    label: 'Tiny - Q4_K_M - acme',
    family: 'hf-tiny',
    variant: 'standard',
    repo: 'acme/Tiny-GGUF',
    files: ['Tiny-Q4_K_M.gguf'],
    sizeGb: 0.5,
    minTotalVramGb: 4,
    contextLength: 32768,
    llamaArgs: [],
    profiles: ['light', 'standard', 'max'],
    verifiedAt: '2026-10-16',
    source: 'user',
    quant: 'Q4_K_M',
    ...over,
  };
}

afterEach(() => setUserCatalogModels([]));

describe('dynamic catalog', () => {
  it('without user models nothing changes: the built-ins, tagged builtin', () => {
    const all = catalogModels();
    expect(all).toHaveLength(CATALOG.length);
    expect(all.map((m) => m.id)).toEqual(CATALOG.map((m) => m.id));
    expect(all.every((m) => m.source === 'builtin')).toBe(true);
    // the exported constant itself is untouched (the research JSON test relies on it)
    expect(CATALOG.some((m) => m.source !== undefined)).toBe(false);
    expect(userCatalogModels()).toEqual([]);
  });

  it('every lookup sees user models, after the built-ins', () => {
    setUserCatalogModels([userModel()], profiles);
    const ids = catalogModels().map((m) => m.id);
    expect(ids.slice(0, CATALOG.length)).toEqual(CATALOG.map((m) => m.id));
    expect(ids.at(-1)).toBe('hf-acme-tiny-q4_k_m');
    const m = getCatalogModel('hf-acme-tiny-q4_k_m')!;
    expect(m.source).toBe('user');
    expect(isUserModel(m)).toBe(true);
    expect(isUserModel(getCatalogModel('qwen38-27b-uncensored-hauhau-q5kp')!)).toBe(false);
    expect(modelsForProfile('light').map((x) => x.id)).toContain('hf-acme-tiny-q4_k_m');
    expect(modelsForProfile('light').map((x) => x.id)).toContain('qwen38-27b-uncensored-hauhau-q5kp');
    expect(builtinCatalogModels().some((x) => x.source === 'user')).toBe(false);
  });

  it('a user model can be a profile default', () => {
    setUserCatalogModels([userModel()], profiles);
    expect(defaultModelForProfile('light', 'hf-acme-tiny-q4_k_m', true)?.id).toBe('hf-acme-tiny-q4_k_m');
    expect(defaultModelForProfile('light', 'hf-acme-tiny-q4_k_m', false)?.id).toBe('hf-acme-tiny-q4_k_m');
  });

  it('built-in defaults and the Uncensored/Standard toggle are unaffected by user models', () => {
    const before = [
      defaultModelForProfile('light', 'qwen38-27b-uncensored-hauhau-q5kp', true)?.id,
      defaultModelForProfile('light', 'qwen38-27b-uncensored-hauhau-q5kp', false)?.id,
      defaultModelForProfile('standard', undefined, true)?.id,
      siblingVariant('qwen38-27b-uncensored-hauhau-q5kp', 'standard')?.id,
    ];
    setUserCatalogModels([userModel(), userModel({ id: 'hf-acme-tiny-q8_0', variant: 'uncensored' })], profiles);
    expect([
      defaultModelForProfile('light', 'qwen38-27b-uncensored-hauhau-q5kp', true)?.id,
      defaultModelForProfile('light', 'qwen38-27b-uncensored-hauhau-q5kp', false)?.id,
      defaultModelForProfile('standard', undefined, true)?.id,
      siblingVariant('qwen38-27b-uncensored-hauhau-q5kp', 'standard')?.id,
    ]).toEqual(before);
  });

  it('a user model in the same family can be the toggle sibling, but only within its own family', () => {
    setUserCatalogModels([userModel({ id: 'hf-a-x', variant: 'uncensored' }), userModel({ id: 'hf-a-y', variant: 'standard' })], profiles);
    expect(siblingVariant('hf-a-x', 'standard')?.id).toBe('hf-a-y');
    expect(siblingVariant('hf-a-y', 'uncensored')?.id).toBe('hf-a-x');
  });

  it('the experimental fallback never picks a user model', () => {
    const fits = userModel({ id: 'hf-fits', profiles: ['standard'], minTotalVramGb: 10, variant: 'uncensored' });
    setUserCatalogModels([fits], profiles);
    const fb = experimentalFallback('qwen38-flash-next-uncensored-huihui-v2-q4kxl', 96);
    expect(fb).toBeDefined();
    expect(fb!.id).not.toBe('hf-fits');
    expect(fb!.source).toBe('builtin');
  });

  it('re-validates what it is given: no shadowing of built-in ids, no hostile entries', () => {
    setUserCatalogModels(
      [
        userModel({ id: 'qwen38-27b-uncensored-hauhau-q5kp' }),
        userModel({ id: 'hf-evil', files: ['../../etc/passwd.gguf'] }),
        userModel({ id: 'hf-evil2', repo: 'a/b;touch x' }),
        userModel({ id: 'hf-ok' }),
      ],
      profiles,
    );
    expect(userCatalogModels().map((m) => m.id)).toEqual(['hf-ok']);
    expect(getCatalogModel('qwen38-27b-uncensored-hauhau-q5kp')!.source).toBe('builtin');
    expect(getCatalogModel('qwen38-27b-uncensored-hauhau-q5kp')!.label).toBe(CATALOG[0].label);
  });

  it('recomputes which profiles a model fits from the current profile list', () => {
    const m = userModel({ minTotalVramGb: 40, profiles: ['light'] }); // stale on purpose
    setUserCatalogModels([m], profiles);
    expect(getCatalogModel(m.id)!.profiles).toEqual(['standard', 'max']);
    setUserCatalogModels([m], [...profiles, { id: 'mine', numGpus: 1, minGpuRamGb: 48 }]);
    expect(getCatalogModel(m.id)!.profiles).toEqual(['standard', 'max', 'mine']);
    setUserCatalogModels([m]); // no profile list: keeps what is stored
    expect(getCatalogModel(m.id)!.profiles).toEqual(['light']);
  });

  it('returns copies: mutating a result does not change the catalog', () => {
    setUserCatalogModels([userModel()], profiles);
    const a = getCatalogModel('hf-acme-tiny-q4_k_m')!;
    a.files.push('x.gguf');
    catalogModels().at(-1)!.profiles.length = 0;
    userCatalogModels()[0].llamaArgs.push('--x');
    expect(catalogModels().at(-1)!.files).toEqual(['Tiny-Q4_K_M.gguf']);
    expect(getCatalogModel('hf-acme-tiny-q4_k_m')!.profiles).toEqual(['light', 'standard', 'max']);
  });

  it('serverCatalog = built-ins plus only the model being rented for', () => {
    setUserCatalogModels([userModel(), userModel({ id: 'hf-other' })], profiles);
    expect(serverCatalog().map((m) => m.id)).toEqual(CATALOG.map((m) => m.id));
    expect(serverCatalog('qwen38-27b-uncensored-hauhau-q5kp').map((m) => m.id)).toEqual(CATALOG.map((m) => m.id));
    expect(serverCatalog('hf-acme-tiny-q4_k_m').map((m) => m.id)).toEqual([...CATALOG.map((m) => m.id), 'hf-acme-tiny-q4_k_m']);
  });
});

describe('settings store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'oc-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults: no user models, no favorites', () => {
    const d = defaultSettings();
    expect(d.vast.userModels).toEqual([]);
    expect(d.vast.favoriteRepos).toEqual([]);
  });

  it('an old settings file without the new keys loads with empty lists', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ vast: { monthlyBudget: 55 } }));
    const s = createSettingsStore(dir).get();
    expect(s.vast.monthlyBudget).toBe(55);
    expect(s.vast.userModels).toEqual([]);
    expect(s.vast.favoriteRepos).toEqual([]);
  });

  it('keeps valid models and favorites across a restart', () => {
    const store = createSettingsStore(dir);
    store.update({ vast: { userModels: [userModel()], favoriteRepos: ['acme/Tiny-GGUF'] } } as never);
    const again = createSettingsStore(dir).get();
    expect(again.vast.userModels).toEqual([userModel()]);
    expect(again.vast.favoriteRepos).toEqual(['acme/Tiny-GGUF']);
    // unrelated vast settings survive a later patch that does not mention the lists
    store.update({ vast: { monthlyBudget: 77 } } as never);
    expect(store.get().vast.userModels).toHaveLength(1);
  });

  it('drops hostile or broken entries from settings.update', () => {
    const store = createSettingsStore(dir);
    const evil = [
      userModel({ id: 'hf-1', files: ['a b.gguf'] }),
      userModel({ id: 'hf-2', files: ['$(touch /tmp/pwned).gguf'] }),
      userModel({ id: 'hf-3', repo: "x/y';id;'" }),
      userModel({ id: "hf-4';id;'" }),
      userModel({ id: 'hf-5', sizeGb: -1 }),
      userModel({ id: 'hf-6', mmproj: '../mm.gguf' }),
      userModel({ id: 'qwen38-27b-standard-unsloth-q8' }),
      'a string',
      null,
      userModel({ id: 'hf-fine' }),
    ];
    store.update({ vast: { userModels: evil, favoriteRepos: ['ok/repo', 'bad repo', '../x/y', 42] } } as never);
    expect(store.get().vast.userModels.map((m) => m.id)).toEqual(['hf-fine']);
    expect(store.get().vast.favoriteRepos).toEqual(['ok/repo']);
  });

  it('a hand-edited settings.json is sanitised on load too', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ vast: { userModels: [{ id: 'hf-x', repo: 'a/b', files: ['..\\..\\x.gguf'], sizeGb: 1, minTotalVramGb: 2, contextLength: 4096 }, userModel()], favoriteRepos: 'nope' } }));
    const s = createSettingsStore(dir).get();
    expect(s.vast.userModels.map((m) => m.id)).toEqual(['hf-acme-tiny-q4_k_m']);
    expect(s.vast.favoriteRepos).toEqual([]);
  });

  it('validateSettings repairs wrong types', () => {
    const s = validateSettings({ vast: { userModels: 'x', favoriteRepos: { a: 1 } } });
    expect(s.vast.userModels).toEqual([]);
    expect(s.vast.favoriteRepos).toEqual([]);
  });
});

const bash = (() => {
  for (const c of [process.env.GIT_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash']) {
    if (c && existsSync(c)) return c;
  }
  return null;
})();

describe('config.sh for user models', () => {
  it('lists the model with every file, the projector and the planned numbers', () => {
    const m = userModel({ files: ['Q4/a-00001-of-00002.gguf', 'Q4/a-00002-of-00002.gguf'], mmproj: 'mmproj-F16.gguf', sizeGb: 12.34, contextLength: 65536, llamaArgs: ['--jinja'] });
    const cfg = renderConfigSh([m]);
    expect(cfg).toContain(`'hf-acme-tiny-q4_k_m') M_FAMILY='hf-tiny'; M_REPO='acme/Tiny-GGUF'; M_FILES=('Q4/a-00001-of-00002.gguf' 'Q4/a-00002-of-00002.gguf'); M_MMPROJ='mmproj-F16.gguf'; M_BYTES=12340000000; M_CTX=65536; M_ARGS=('--jinja')`);
  });

  it.skipIf(!bash)('sourced by bash it resolves a user model; a hostile value that skipped validation stays inert text', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-user-'));
    try {
      const marker = path.join(dir, 'pwned').replace(/\\/g, '/');
      const evil = userModel({
        id: 'hf-evil',
        // renderConfigSh is the last line of defence: even values that never went through the sanitizer are only quoted text
        repo: `a/b'; touch ${marker}; echo '`,
        files: [`x'$(touch ${marker})\`touch ${marker}\`.gguf`],
        mmproj: `m"; touch ${marker}; "`,
        family: `f'; touch ${marker}; '`,
        llamaArgs: [`--x=$(touch ${marker})`],
      });
      const good = userModel({ files: ['Q4/a-00001-of-00002.gguf', 'Q4/a-00002-of-00002.gguf'], mmproj: 'mmproj-F16.gguf', llamaArgs: ['--jinja', '{modelDir}/d.gguf'] });
      writeFileSync(path.join(dir, 'config.sh'), renderConfigSh([good, evil], ["--e=$(touch " + marker + ')']));
      writeFileSync(
        path.join(dir, 't.sh'),
        [
          'set -u',
          `. "${path.join(dir, 'config.sh').replace(/\\/g, '/')}"`,
          "oc_model 'hf-acme-tiny-q4_k_m' || exit 9",
          'echo "fam=$M_FAMILY repo=$M_REPO n=${#M_FILES[@]} first=${M_FILES[0]} mm=$M_MMPROJ bytes=$M_BYTES ctx=$M_CTX"',
          'for a in "${M_ARGS[@]}"; do printf "arg=%s\\n" "${a//\\{modelDir\\}/\\/root\\/models\\/x}"; done',
          "oc_model 'hf-evil' || exit 8",
          'echo "evilrepo=$M_REPO"',
          'echo "evilfile=${M_FILES[0]}"',
          'echo ok',
        ].join('\n') + '\n',
      );
      const out = execFileSync(bash!, [path.join(dir, 't.sh')], { encoding: 'utf8' });
      expect(out).toContain('fam=hf-tiny repo=acme/Tiny-GGUF n=2 first=Q4/a-00001-of-00002.gguf mm=mmproj-F16.gguf bytes=500000000 ctx=32768');
      expect(out).toContain('arg=--jinja');
      expect(out).toContain('arg=/root/models/x/d.gguf');
      expect(out).toContain(`evilrepo=a/b'; touch ${marker}; echo '`);
      expect(out.trim().endsWith('ok')).toBe(true);
      expect(existsSync(path.join(dir, 'pwned'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GPU manager with a user model', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const tiny = (id: string, over: Partial<CatalogModel> = {}) => userModel({ id, files: [`${id}.gguf`], sizeGb: 0.4, ...over });

  it('clocks in with a user model: the instance config.sh lists it and the model id is the one rented for', async () => {
    h = await createHarness();
    setUserCatalogModels([tiny('hf-acme-a'), tiny('hf-acme-b')], profiles);
    await h.manager.start();
    const st = await h.manager.clockIn({ profileId: 'light', modelId: 'hf-acme-a' });
    expect(st.modelId).toBe('hf-acme-a');
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().modelId).toBe('hf-acme-a');

    const create = h.vast.requests.find((r) => r.path.startsWith('/api/v0/asks/'))!;
    const env = (create.body as { env: Record<string, string> }).env;
    expect(env.OC_MODEL_ID).toBe('hf-acme-a');
    const cfg = gunzipSync(Buffer.from(env.OC_CONFIG_GZB64, 'base64')).toString('utf8');
    expect(cfg).toContain("'hf-acme-a') M_FAMILY=");
    expect(cfg).toContain("'qwen38-27b-uncensored-hauhau-q5kp') M_FAMILY="); // built-ins stay
    expect(cfg).not.toContain('hf-acme-b'); // other user models are not shipped in the instance env
    const [m] = await h.manager.provider().listModels();
    expect(m.ref).toEqual({ provider: 'vast', model: 'hf-acme-a' });
    expect(m.label).toBe('Tiny - Q4_K_M - acme');
    expect(h.manager.catalog().some((x) => x.id === 'hf-acme-a' && x.source === 'user')).toBe(true);
    await h.manager.clockOut();
    expect(h.manager.history()[0].modelId).toBe('hf-acme-a');
  });

  it('switching a running GPU to a user model uploads the full config.sh first; to a built-in it does not', async () => {
    h = await createHarness();
    setUserCatalogModels([tiny('hf-acme-a'), tiny('hf-acme-b')], profiles);
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: 'test-qwen35-0.8b-q8' });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const box = h.box()!;
    const uploadsBefore = box.uploads.filter((u) => u === 'config.sh').length;

    await h.manager.switchModel('hf-acme-b'); // not in the instance's config.sh
    await h.waitFor(() => h!.manager.status().phase === 'ready', 8000, 'ready after switch');
    expect(h.manager.status().modelId).toBe('hf-acme-b');
    expect(box.uploads.filter((u) => u === 'config.sh').length).toBe(uploadsBefore + 1);
    expect(box.switches).toEqual(['hf-acme-b']);

    await h.manager.switchModel('test-qwen35-0.8b-q8');
    await h.waitFor(() => h!.manager.status().phase === 'ready', 8000, 'ready after switching back');
    expect(box.uploads.filter((u) => u === 'config.sh').length).toBe(uploadsBefore + 1);
    expect(box.switches).toEqual(['hf-acme-b', 'test-qwen35-0.8b-q8']);
    await h.manager.clockOut();
  });

  it('refuses a user model that needs more VRAM than the instance has', async () => {
    h = await createHarness();
    setUserCatalogModels([tiny('hf-acme-huge', { sizeGb: 100, minTotalVramGb: 120, profiles: ['max'] })], profiles);
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: 'test-qwen35-0.8b-q8' });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    await expect(h.manager.switchModel('hf-acme-huge')).rejects.toThrow(/VRAM/);
    await h.manager.clockOut();
  });

  it('clock-in with a user model that needs a bigger profile says so, with nothing rented', async () => {
    h = await createHarness();
    setUserCatalogModels([tiny('hf-acme-huge', { sizeGb: 100, minTotalVramGb: 120, profiles: ['max'] })], profiles);
    await h.manager.start();
    await expect(h.manager.clockIn({ profileId: 'light', modelId: 'hf-acme-huge' })).rejects.toThrow(/120 GB of VRAM/);
    expect(h.vast.requests.filter((r) => r.path.startsWith('/api/v0/asks/'))).toHaveLength(0);
  });

  it('an unknown model id is still an error', async () => {
    h = await createHarness();
    await h.manager.start();
    await expect(h.manager.clockIn({ profileId: 'light', modelId: 'hf-not-added' })).rejects.toThrow(/Unknown model/);
  });
});

