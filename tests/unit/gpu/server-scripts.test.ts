// Functional test of resources/server/onstart.sh (+ watchdog + bootstrap startup) under real bash, with /root relocated
// to a temp dir (OC_ROOT) and the Vast API pointed at a local mock (OC_API_BASE). Money-critical: proves the
// watchdog self-destroys the instance via DELETE /api/v0/instances/$CONTAINER_ID/ when the app heartbeat stops.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
});
