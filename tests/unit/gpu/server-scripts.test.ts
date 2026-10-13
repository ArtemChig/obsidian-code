// Functional test of resources/server/onstart.sh (+ watchdog + bootstrap startup) under real bash, with /root relocated
// to a temp dir (OC_ROOT) and the Vast API pointed at a local mock (OC_API_BASE). Money-critical: proves the
// watchdog self-destroys the instance via DELETE /api/v0/instances/$CONTAINER_ID/ when the app heartbeat stops.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../src/core/gpu/catalog';
import { gzipBase64, loadServerScripts, renderConfigSh } from '../../../src/core/gpu/server-scripts';
import { RESOURCES_DIR } from '../../fixtures/mock-vast/harness';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' ? (existsSync(GIT_BASH) ? GIT_BASH : null) : existsSync('/bin/bash') ? '/bin/bash' : null;

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function read(f: string): string {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

describe.skipIf(!bash)('onstart.sh + watchdog (real bash)', () => {
  it('arms the watchdog first, unpacks/starts the bootstrap, and self-destroys via the Vast API when heartbeats stop', async () => {
    const reqs: { method: string; url: string; auth: string | undefined }[] = [];
    const srv = http.createServer((req, res) => {
      reqs.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"success":true}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const root = mkdtempSync(path.join(os.tmpdir(), 'oc-root-'));
    const rootPosix = root.replace(/\\/g, '/');
    const oc = path.join(root, 'oc');
    let heartbeat: NodeJS.Timeout | null = null;
    try {
      const scripts = loadServerScripts(RESOURCES_DIR);
      writeFileSync(path.join(root, 'onstart.sh'), scripts.onstart);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OC_ROOT: rootPosix,
        CONTAINER_ID: '4242',
        CONTAINER_API_KEY: 'container-key-xyz',
        OC_API_KEY: 'server-key',
        OC_MODEL_ID: 'no-such-model',
        OC_IDLE_MIN: '30',
        OC_HEARTBEAT_MIN: '3',
        OC_MAX_HOURS: '1',
        OC_BOOT_MAX_MIN: '600',
        OC_API_BASE: `http://127.0.0.1:${port}`,
        OC_WD_TICK: '1',
        OC_WD_MIN: '1',
        OC_BOOTSTRAP_GZB64: gzipBase64(scripts.bootstrap),
        OC_CONFIG_GZB64: gzipBase64(renderConfigSh(CATALOG, [])),
      };
      const code = await new Promise<number | null>((resolve) => {
        const p = spawn(bash!, [`${rootPosix}/onstart.sh`], { env, stdio: 'ignore' });
        p.on('exit', (c) => resolve(c));
      });
      expect(code).toBe(0);

      const envFile = read(path.join(oc, 'env'));
      expect(envFile).toContain("export CONTAINER_ID='4242'");
      expect(envFile).toContain("export CONTAINER_API_KEY='container-key-xyz'");
      expect(envFile).toContain("export OC_API_KEY='server-key'");
      expect(envFile).not.toContain('GZB64');

      // keep the app heartbeat alive while checking startup
      const touch = () => {
        const t = new Date();
        try {
          utimesSync(path.join(oc, 'heartbeat'), t, t);
        } catch {
          /* not yet */
        }
      };
      heartbeat = setInterval(touch, 300);

      await waitFor(() => read(path.join(oc, 'watchdog.log')).includes('armed id=4242 key=set'), 10_000, 'watchdog armed');
      await waitFor(() => read(path.join(oc, 'status.json')).includes('Unknown model id: no-such-model'), 10_000, 'bootstrap ran');
      expect(read(path.join(oc, 'bootstrap.sh'))).toBe(scripts.bootstrap);
      expect(read(path.join(oc, 'switch.sh'))).toContain(`exec bash ${rootPosix}/oc/bootstrap.sh switch`);
      expect(JSON.parse(read(path.join(oc, 'status.json')))).toMatchObject({ phase: 'error', modelId: 'no-such-model' });

      await new Promise((r) => setTimeout(r, 4500));
      expect(reqs).toEqual([]); // heartbeats keep it alive

      clearInterval(heartbeat);
      heartbeat = null;
      await waitFor(() => reqs.some((r) => r.method === 'DELETE'), 12_000, 'self-destroy DELETE');
      const del = reqs.find((r) => r.method === 'DELETE')!;
      expect(del.url).toBe('/api/v0/instances/4242/');
      expect(del.auth).toBe('Bearer container-key-xyz');
      expect(read(path.join(oc, 'watchdog.log'))).toContain('self-destroy: no app heartbeat for 3 min');
      expect(read(path.join(oc, 'status.json'))).toContain('Watchdog: no app heartbeat');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      const pid = read(path.join(oc, 'watchdog.pid')).trim();
      if (pid) spawnSync(bash!, ['-c', `kill -9 ${pid} 2>/dev/null; true`]);
      await new Promise<void>((r) => srv.close(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* a lingering sleep may still hold the dir briefly on Windows */
      }
    }
  }, 45_000);

  it('GPU-3: refuses to arm without the container key (logs NOT armed, no pid) and arms after the app writes wd.env', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oc-root-'));
    const rootPosix = root.replace(/\\/g, '/');
    const oc = path.join(root, 'oc');
    try {
      const scripts = loadServerScripts(RESOURCES_DIR);
      writeFileSync(path.join(root, 'onstart.sh'), scripts.onstart);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OC_ROOT: rootPosix,
        CONTAINER_ID: '4243',
        CONTAINER_API_KEY: '',
        OC_API_KEY: 'server-key',
        OC_MODEL_ID: 'no-such-model',
        OC_HEARTBEAT_MIN: '600',
        OC_API_BASE: 'http://127.0.0.1:9',
        OC_WD_TICK: '1',
        OC_WD_MIN: '1',
      };
      const code = await new Promise<number | null>((resolve) => {
        const p = spawn(bash!, [`${rootPosix}/onstart.sh`], { env, stdio: 'ignore' });
        p.on('exit', (c) => resolve(c));
      });
      expect(code).toBe(0);
      await waitFor(() => read(path.join(oc, 'watchdog.log')).includes('NOT armed: id=4243 key='), 10_000, 'NOT armed');
      expect(read(path.join(oc, 'watchdog.log'))).not.toContain('armed id=');
      expect(existsSync(path.join(oc, 'watchdog.pid'))).toBe(false);

      // the app's repair: wd.env with the instance key from create, then restart watchdog.sh
      writeFileSync(path.join(oc, 'wd.env'), "export CONTAINER_ID='4243'\nexport CONTAINER_API_KEY='ckey-4243'\n");
      spawn(bash!, [`${rootPosix}/oc/watchdog.sh`], { env: { ...process.env }, stdio: 'ignore', detached: true }).unref();
      await waitFor(() => read(path.join(oc, 'watchdog.log')).includes('armed id=4243 key=set'), 10_000, 'armed after repair');
      expect(read(path.join(oc, 'watchdog.pid')).trim()).toMatch(/^\d+$/);
    } finally {
      const pid = read(path.join(oc, 'watchdog.pid')).trim();
      if (pid) spawnSync(bash!, ['-c', `kill -9 ${pid} 2>/dev/null; true`]);
      await new Promise((r) => setTimeout(r, 300));
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* a lingering sleep may still hold the dir briefly on Windows */
      }
    }
  }, 30_000);
});

// ── bootstrap.sh load fallback: full → safe (no MTP, no vision) → safe-minimal (flash-attn off, f16 KV) ──

const INCIDENT_MODEL = 'qwen38-27b-uncensored-hauhau-q5kp'; // the v1.0.0 incident: MTP + mmproj, -c 131072
const FAKE_LLAMA = path.join(__dirname, '../../fixtures/fake-llama-server.cjs');

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface BootRun {
  oc: string;
  status: () => Record<string, unknown>;
  calls: () => string[][];
  cleanup: () => Promise<void>;
}

/**
 * How the fake llama-server binary finds its shared library (the b11561 image: /app/llama-server is a stub with RUNPATH
 * "/app/build/bin:" that needs /app/libllama-server-impl.so — found only from the current directory /app).
 *   plain          always starts
 *   own-dir        starts only from its own directory or with that directory on LD_LIBRARY_PATH (the live incident)
 *   lib-subdir     needs <dir>/lib on LD_LIBRARY_PATH (the library lives elsewhere; the preflight must find it)
 *   unstartable    the library exists nowhere: never starts
 */
type FakeBinary = 'plain' | 'own-dir' | 'lib-subdir' | 'unstartable';

function writeFakeBinary(root: string, kind: FakeBinary, posix: (p: string) => string): string {
  const node = `exec "${posix(process.execPath)}" "${posix(FAKE_LLAMA)}" "$@"`;
  if (kind === 'plain') {
    writeFileSync(path.join(root, 'fake-llama'), `#!/bin/bash\n${node}\n`);
    return `${posix(root)}/fake-llama`;
  }
  const app = path.join(root, 'app');
  mkdirSync(path.join(app, 'lib'), { recursive: true });
  const need = kind === 'own-dir' ? '$d' : kind === 'lib-subdir' ? '$d/lib' : '/nonexistent-oc-lib-dir';
  if (kind === 'lib-subdir') writeFileSync(path.join(app, 'lib', 'libllama-server-impl.so'), '');
  writeFileSync(
    path.join(app, 'llama-server'),
    [
      '#!/bin/bash',
      'd=$(cd "$(dirname "$0")" && pwd)',
      `need="${need}"`,
      'ok=',
      'case ":${LD_LIBRARY_PATH:-}:" in *":$need:"*) ok=1 ;; esac',
      '[ "$(pwd)" = "$need" ] && ok=1',
      'if [ -z "$ok" ]; then echo "$0: error while loading shared libraries: libllama-server-impl.so: cannot open shared object file: No such file or directory" >&2; exit 127; fi',
      node,
      '',
    ].join('\n'),
  );
  return `${posix(app)}/llama-server`;
}

/** Runs the real bootstrap.sh (main) against a model already on disk, with the fake llama-server as LLAMA_BIN. */
async function runBootstrap(rule: string, binary: FakeBinary = 'plain'): Promise<BootRun> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oc-boot-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const oc = path.join(root, 'oc');
  const model = CATALOG.find((m) => m.id === INCIDENT_MODEL)!;
  mkdirSync(path.join(root, 'models', model.id), { recursive: true });
  writeFileSync(path.join(root, 'models', model.id, '.oc_complete'), '');
  mkdirSync(oc, { recursive: true });
  writeFileSync(path.join(oc, 'env'), "export OC_API_KEY='server-key-0123456789'\n");
  writeFileSync(path.join(oc, 'config.sh'), renderConfigSh(CATALOG, [], { loadMaxMin: 2 }));
  writeFileSync(path.join(oc, 'bootstrap.sh'), loadServerScripts(RESOURCES_DIR).bootstrap);
  const llamaBin = writeFakeBinary(root, binary, posix);
  const callsFile = path.join(root, 'calls.jsonl');
  const stopFile = path.join(root, 'stop');
  const p = spawn(bash!, [`${posix(oc)}/bootstrap.sh`, 'main'], {
    env: {
      ...process.env,
      OC_ROOT: posix(root),
      OC_MODEL_ID: model.id,
      OC_LLAMA_BIN: llamaBin,
      // like Vast's onstart environment: no LD_LIBRARY_PATH pointing at the binary's directory
      LD_LIBRARY_PATH: '',
      OC_LLAMA_PORT: String(await freePort()),
      OC_POLL_S: '0.2',
      FAKE_LLAMA_RULE: rule,
      FAKE_LLAMA_CALLS: callsFile,
      FAKE_LLAMA_STOP: stopFile,
    },
    stdio: 'ignore',
  });
  return {
    oc,
    status: () => {
      try {
        return JSON.parse(read(path.join(oc, 'status.json'))) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    calls: () =>
      read(callsFile)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
    cleanup: async () => {
      const sp = read(path.join(oc, 'serve.pid')).trim();
      if (sp) spawnSync(bash!, ['-c', `kill -9 ${sp} 2>/dev/null; true`]);
      p.kill();
      writeFileSync(stopFile, '');
      await new Promise((r) => setTimeout(r, 700));
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* the fake may still hold a handle for a moment on Windows */
      }
    },
  };
}

const flagValue = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe.skipIf(!bash)('bootstrap.sh load fallback (real bash, fake llama-server)', () => {
  it('full config fails (MTP/mmproj) → attempt 2 reaches ready in safe mode with dropped [mtp, vision]', async () => {
    const run = await runBootstrap('no-spec-vision');
    try {
      await waitFor(() => ['ready', 'error'].includes(String(run.status().phase)), 30_000, 'ready or error');
      const st = run.status();
      expect(st).toMatchObject({ phase: 'ready', modelId: INCIDENT_MODEL, mode: 'safe', dropped: ['mtp', 'vision'], attempt: 2, ctx: 65536 });

      const calls = run.calls();
      expect(calls).toHaveLength(2);
      const [full, safe] = calls;
      // attempt 1: the full catalog configuration
      expect(full).toEqual(expect.arrayContaining(['--spec-type', 'draft-mtp', '--spec-draft-n-max', '--mmproj', '--parallel']));
      expect(flagValue(full, '-c')).toBe('131072');
      // attempt 2: no speculative flags (or their values), no projector, -c 65536; q8_0 KV + flash-attn kept
      expect(safe.some((a) => /^--(spec|draft)|^-md$|^--model-draft$|^--mmproj/.test(a))).toBe(false);
      expect(safe).not.toContain('draft-mtp');
      expect(flagValue(safe, '-c')).toBe('65536');
      expect(flagValue(safe, '--flash-attn')).toBe('on');
      expect(flagValue(safe, '--cache-type-k')).toBe('q8_0');
      expect(flagValue(safe, '--cache-type-v')).toBe('q8_0');
      expect(flagValue(safe, '--parallel')).toBe('1');

      // the failed attempt is logged with its flags (key masked) and llama-server's last lines
      const attempts = read(path.join(run.oc, 'attempts.log'));
      expect(attempts).toContain('attempt 1/3 (full) FAILED');
      expect(attempts).toContain('--spec-type draft-mtp');
      expect(attempts).toContain('failed to create the MTP draft context');
      expect(attempts).toContain('--api-key ***');
      expect(attempts).not.toContain('server-key-0123456789');
      await waitFor(() => read(path.join(run.oc, 'server.log')).includes(`ready: ${INCIDENT_MODEL}`), 5000, 'ready log line');
      const log = read(path.join(run.oc, 'server.log'));
      expect(log).toContain('attempt 1/3 (full) FAILED');
      expect(log).toContain(`retrying ${INCIDENT_MODEL} in safe mode`);
      expect(log).toContain(`ready: ${INCIDENT_MODEL} (mode safe; dropped: mtp,vision)`);
    } finally {
      await run.cleanup();
    }
  }, 45_000);

  it('only --flash-attn off loads → attempt 3 reaches ready in safe-minimal mode (f16 KV, -c 32768)', async () => {
    const run = await runBootstrap('fa-off-only');
    try {
      await waitFor(() => ['ready', 'error'].includes(String(run.status().phase)), 30_000, 'ready or error');
      expect(run.status()).toMatchObject({ phase: 'ready', mode: 'safe-minimal', dropped: ['mtp', 'vision', 'flash-attn', 'kv-quant'], attempt: 3, ctx: 32768 });
      const calls = run.calls();
      expect(calls).toHaveLength(3);
      const minimal = calls[2];
      expect(flagValue(minimal, '--flash-attn')).toBe('off');
      expect(minimal).not.toContain('--cache-type-k');
      expect(minimal).not.toContain('--cache-type-v');
      expect(minimal).not.toContain('--mmproj');
      expect(minimal).not.toContain('--spec-type');
      expect(flagValue(minimal, '-c')).toBe('32768');
      const attempts = read(path.join(run.oc, 'attempts.log'));
      expect(attempts).toContain('attempt 1/3 (full) FAILED');
      expect(attempts).toContain('attempt 2/3 (safe) FAILED');
      expect(attempts).toContain('flash attention is not supported');
    } finally {
      await run.cleanup();
    }
  }, 45_000);

  // v1.0.1 live incident (b11561 image): /app/llama-server only finds libllama-server-impl.so from /app, the bootstrap
  // ran it from /root/oc and every attempt died with "error while loading shared libraries" after a 21 GB download.
  it('a llama-server that finds its libraries only from its own directory loads the FULL configuration', async () => {
    const run = await runBootstrap('ok', 'own-dir');
    try {
      await waitFor(() => ['ready', 'error'].includes(String(run.status().phase)), 30_000, 'ready or error');
      expect(run.status()).toMatchObject({ phase: 'ready', modelId: INCIDENT_MODEL, mode: 'full', dropped: [], attempt: 1, ctx: 131072 });
      const calls = run.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.arrayContaining(['--spec-type', 'draft-mtp', '--mmproj']));
      const log = read(path.join(run.oc, 'server.log'));
      expect(log).toContain('llama-server preflight ok');
      expect(log).not.toContain('error while loading shared libraries');
      expect(read(path.join(run.oc, 'attempts.log'))).toBe('');
    } finally {
      await run.cleanup();
    }
  }, 45_000);

  it('a shared library outside the binary directory is found by the preflight and added to LD_LIBRARY_PATH', async () => {
    const run = await runBootstrap('ok', 'lib-subdir');
    try {
      await waitFor(() => ['ready', 'error'].includes(String(run.status().phase)), 30_000, 'ready or error');
      expect(run.status()).toMatchObject({ phase: 'ready', mode: 'full', attempt: 1 });
      const log = read(path.join(run.oc, 'server.log'));
      expect(log).toMatch(/preflight: libllama-server-impl\.so is in \S+\/app\/lib; adding it to LD_LIBRARY_PATH/);
      expect(log).toContain('llama-server preflight ok');
    } finally {
      await run.cleanup();
    }
  }, 45_000);

  it('a llama-server that cannot start fails the bootstrap BEFORE any download or load attempt, with its error', async () => {
    const run = await runBootstrap('ok', 'unstartable');
    try {
      await waitFor(() => ['ready', 'error'].includes(String(run.status().phase)), 30_000, 'ready or error');
      const st = run.status();
      expect(st.phase).toBe('error');
      expect(String(st.message)).toMatch(/llama-server cannot start on this server image: .*libllama-server-impl\.so: cannot open shared object file/);
      expect(run.calls()).toHaveLength(0);
      const log = read(path.join(run.oc, 'server.log'));
      expect(log).toContain('llama-server preflight FAILED');
      expect(log).not.toMatch(/model .* already on disk|hf download|curl download|attempt 1\/3/);
    } finally {
      await run.cleanup();
    }
  }, 45_000);

  it('nothing loads → error after the third attempt (status error, all three attempts logged)', async () => {
    const run = await runBootstrap('never');
    try {
      await waitFor(() => ['ready', 'error'].includes(String(run.status().phase)), 30_000, 'ready or error');
      expect(run.status()).toMatchObject({ phase: 'error', mode: 'safe-minimal' });
      expect(String(run.status().message)).toMatch(/failed to load .*full, safe and safe-minimal/);
      expect(run.calls()).toHaveLength(3);
      expect(read(path.join(run.oc, 'attempts.log'))).toContain('attempt 3/3 (safe-minimal) FAILED');
    } finally {
      await run.cleanup();
    }
  }, 45_000);
});
