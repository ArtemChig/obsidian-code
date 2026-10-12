import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CATALOG, defaultModelForProfile, diskGbFor, estimateWarmupSeconds, experimentalFallback, getCatalogModel, siblingVariant, toggleVariant, warmupLabel,
} from '../../../src/core/gpu/catalog';
import { DEFAULT_GPU_PROFILES } from '../../../src/core/gpu/profiles';
import {
  ONSTART_MAX_CHARS, buildInstanceEnv, compactShell, loadServerScripts, parseEnvFile, parseServerStatus, renderConfigSh, shQuote,
} from '../../../src/core/gpu/server-scripts';
import { RESOURCES_DIR, REPO_ROOT } from '../../fixtures/mock-vast/harness';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' ? (existsSync(GIT_BASH) ? GIT_BASH : null) : '/bin/bash';

describe('catalog', () => {
  it('matches docs/research/catalog.json exactly', () => {
    const json = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/research/catalog.json'), 'utf8'));
    expect(CATALOG).toEqual(json);
    expect(CATALOG.length).toBe(11);
    expect(CATALOG.every((m) => m.verifiedAt && m.files.length > 0 && m.sizeGb > 0)).toBe(true);
  });

  it('every family has an uncensored and a standard variant', () => {
    const fams = new Map<string, Set<string>>();
    for (const m of CATALOG) fams.set(m.family, (fams.get(m.family) ?? new Set()).add(m.variant));
    for (const [fam, vars] of fams) expect([fam, [...vars].sort()]).toEqual([fam, ['standard', 'uncensored']]);
  });

  it('marks Flash-Next and GLM-5.3 experimental', () => {
    for (const m of CATALOG) {
      const exp = m.family === 'qwen3.8-flash-next' || m.family === 'glm-5.3-flash';
      expect([m.id, m.experimental === true]).toEqual([m.id, exp]);
    }
  });

  it('uncensored <-> standard toggle picks the same family sibling', () => {
    expect(toggleVariant('qwen38-27b-uncensored-hauhau-q5kp')?.id).toBe('qwen38-27b-standard-unsloth-q5kxl');
    expect(toggleVariant('qwen38-27b-uncensored-hauhau-q8kp')?.id).toBe('qwen38-27b-standard-unsloth-q8');
    expect(toggleVariant('qwen38-27b-standard-unsloth-q8')?.id).toBe('qwen38-27b-uncensored-hauhau-q8kp');
    expect(toggleVariant('qwen38-flash-next-uncensored-huihui-v2-q4kxl')?.id).toBe('qwen38-flash-next-standard-ggml-iq4nl');
    expect(toggleVariant('glm53-flash-standard-unsloth-iq4xs')?.id).toBe('glm53-flash-uncensored-huihui-iq4xs');
    expect(siblingVariant('test-qwen35-0.8b-q8', 'uncensored')?.id).toBe('test-qwen35-2b-uncensored-hauhau-q4km');
    expect(siblingVariant('qwen38-27b-uncensored-hauhau-q5kp', 'uncensored')?.id).toBe('qwen38-27b-uncensored-hauhau-q5kp');
    expect(toggleVariant('nope')).toBeUndefined();
  });

  it('profile defaults, experimental fallback, warm-up estimate and disk sizing', () => {
    for (const p of DEFAULT_GPU_PROFILES) expect(getCatalogModel(p.defaultModelId), p.id).toBeTruthy();
    expect(defaultModelForProfile('light', 'qwen38-27b-uncensored-hauhau-q5kp', false)?.id).toBe('qwen38-27b-standard-unsloth-q5kxl');
    expect(defaultModelForProfile('standard', undefined, true)?.id).toBe('qwen38-27b-uncensored-hauhau-q8kp');
    expect(experimentalFallback('qwen38-flash-next-uncensored-huihui-v2-q4kxl', 95.6)?.id).toBe('qwen38-27b-uncensored-hauhau-q8kp');
    expect(experimentalFallback('qwen38-flash-next-standard-ggml-iq4nl', 95.6)?.id).toBe('qwen38-27b-standard-unsloth-q8');
    expect(experimentalFallback('glm53-flash-uncensored-huihui-iq4xs', 191)).toBeUndefined();
    expect(experimentalFallback('qwen38-27b-uncensored-hauhau-q5kp', 32)).toBeUndefined();
    const flash = getCatalogModel('qwen38-flash-next-uncensored-huihui-v2-q4kxl')!;
    expect(estimateWarmupSeconds(flash)).toBe(Math.round((111.33 * 1000) / 150 + 180));
    expect(warmupLabel(flash)).toBe('~15 min');
    expect(diskGbFor(flash, 200)).toBe(170 > 200 ? 170 : 200);
    expect(diskGbFor(getCatalogModel('glm53-flash-uncensored-huihui-iq4xs')!, 250)).toBe(230 > 250 ? 230 : 250);
    expect(diskGbFor({ sizeGb: 158 }, 0)).toBeGreaterThanOrEqual(158 * 1.3 + 20);
  });
});

describe('server scripts', () => {
  it('onstart stub is LF, compact and below the Vast onstart limit; watchdog comes first', () => {
    const s = loadServerScripts(RESOURCES_DIR);
    expect(s.onstart.includes('\r')).toBe(false);
    expect(s.bootstrap.includes('\r')).toBe(false);
    expect(s.onstart.length).toBeLessThan(ONSTART_MAX_CHARS);
    const wd = s.onstart.indexOf('watchdog.sh');
    const bs = s.onstart.indexOf('bootstrap.sh main');
    expect(wd).toBeGreaterThan(0);
    expect(bs).toBeGreaterThan(wd);
    expect(s.onstart).toContain('DELETE');
    expect(s.onstart).toContain('${OC_API_BASE:-https://console.vast.ai}/api/v0/instances/$CONTAINER_ID/');
    expect(s.onstart).not.toMatch(/\bpkill\b/); // procps is not in the base image
    expect(s.onstart).toContain('Authorization: Bearer $CONTAINER_API_KEY');
    expect(s.bootstrap).toContain('/app/llama-server');
    expect(s.bootstrap).toContain('--flash-attn on');
    expect(s.bootstrap).toContain('--cache-type-k q8_0');
    expect(s.bootstrap).toContain('huggingface_hub[hf_xet]');
    // raw resource files must be LF on disk too
    for (const f of ['onstart.sh', 'bootstrap.sh']) expect(readFileSync(path.join(RESOURCES_DIR, 'server', f), 'utf8').includes('\r')).toBe(false);
  });

  it('compactShell keeps shebangs and code, drops comments', () => {
    expect(compactShell('#!/bin/bash\n# comment\n\necho hi # trailing\n  # indented\r\n')).toBe('#!/bin/bash\necho hi # trailing\n');
  });

  it('renders config.sh with safe quoting and ships env as gzip+base64', () => {
    const cfg = renderConfigSh(CATALOG, ['--foo', "it's"]);
    expect(cfg).toContain(`OC_EXTRA=('--foo' 'it'\\''s')`);
    expect(cfg).toContain("'qwen38-flash-next-standard-ggml-iq4nl')");
    expect(cfg).toContain("'{modelDir}/mtp-Qwen3.8-Flash-Next-Q8_0.gguf'");
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    const env = buildInstanceEnv({ modelId: 'm', apiKey: 'k', idleMinutes: 1, heartbeatMinutes: 1, maxSessionHours: 0.5, bootMaxMinutes: 5, nonce: 'n', bootstrap: 'echo b', configSh: cfg });
    expect(env).toMatchObject({ OC_MODEL_ID: 'm', OC_API_KEY: 'k', OC_IDLE_MIN: '5', OC_HEARTBEAT_MIN: '3', OC_MAX_HOURS: '1', OC_BOOT_MAX_MIN: '15', OC_NONCE: 'n' });
    expect(gunzipSync(Buffer.from(env.OC_CONFIG_GZB64, 'base64')).toString('utf8')).toBe(cfg);
    expect(gunzipSync(Buffer.from(env.OC_BOOTSTRAP_GZB64, 'base64')).toString('utf8')).toBe('echo b');
  });

  it('parses status.json and the env file', () => {
    expect(parseServerStatus('{"phase":"downloading","progress":0.5,"message":"x","modelId":"m","bytesDone":5,"bytesTotal":10}\n')).toMatchObject({ phase: 'downloading', progress: 0.5, bytesDone: 5 });
    expect(parseServerStatus('garbage')).toBeNull();
    expect(parseEnvFile("export OC_API_KEY='abc'\nexport X='1'\nnoise")).toEqual({ OC_API_KEY: 'abc', X: '1' });
  });

  it.skipIf(!bash)('scripts pass bash -n and config.sh resolves models with {modelDir} substitution', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oc-cfg-'));
    try {
      for (const f of ['onstart.sh', 'bootstrap.sh']) execFileSync(bash!, ['-n', path.join(RESOURCES_DIR, 'server', f)]);
      const s = loadServerScripts(RESOURCES_DIR);
      writeFileSync(path.join(dir, 'onstart.compact.sh'), s.onstart);
      execFileSync(bash!, ['-n', path.join(dir, 'onstart.compact.sh')]);
      writeFileSync(path.join(dir, 'config.sh'), renderConfigSh(CATALOG, ['--metrics']));
      writeFileSync(
        path.join(dir, 't.sh'),
        [
          'set -u',
          `. "${path.join(dir, 'config.sh').replace(/\\/g, '/')}"`,
          "oc_model 'qwen38-flash-next-standard-ggml-iq4nl' || exit 9",
          'd=/root/models/x',
          'for a in "${M_ARGS[@]}" "${OC_EXTRA[@]}"; do printf "%s\\n" "${a//\\{modelDir\\}/$d}"; done',
          'echo "files=${#M_FILES[@]} first=${M_FILES[0]} bytes=$M_BYTES ctx=$M_CTX fam=$M_FAMILY"',
          "oc_model 'nope' && exit 8",
          'echo ok',
        ].join('\n') + '\n',
      );
      const out = execFileSync(bash!, [path.join(dir, 't.sh')], { encoding: 'utf8' });
      expect(out).toContain('/root/models/x/mtp-Qwen3.8-Flash-Next-Q8_0.gguf');
      expect(out).toContain('--metrics');
      expect(out).toContain('files=3 first=Qwen3.8-Flash-Next-IQ4_NL-00001-of-00002.gguf bytes=106190000000 ctx=131072 fam=qwen3.8-flash-next');
      expect(out.trim().endsWith('ok')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
