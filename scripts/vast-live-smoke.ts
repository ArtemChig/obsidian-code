// LIVE Vast.ai smoke test — RENTS A REAL GPU AND COSTS REAL MONEY (a few cents).
//
//   VAST_API_KEY=... npx tsx scripts/vast-live-smoke.ts [--profile light] [--model test-qwen35-0.8b-q8]
//
// Full clock-in on the cheapest suitable GPU of the profile with the tiny catalog test model, one chat request
// through the SSH tunnel, then clock-out in a finally block (also on Ctrl+C), verifying no labelled instance is left.
// Prints duration and cost. Safety caps for this run: monthly budget $5 (this run only), max 1 h, server watchdog
// idle 10 min / heartbeat 5 min. The app SSH key for the smoke test is kept in <tmp>/obsidian-code-vast-smoke/.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoreContext } from '../src/core/contracts';
import type { Settings } from '../src/shared/types';
import { GpuManagerImpl, DEFAULT_VAST_SETTINGS } from '../src/core/gpu/manager';
import { APP_LABEL } from '../src/core/gpu/vast-client';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
  const apiKey = process.env.VAST_API_KEY?.trim();
  if (!apiKey) {
    console.error('Set VAST_API_KEY to run the live smoke test.');
    return 2;
  }
  const profileId = arg('profile', 'light');
  const modelId = arg('model', 'test-qwen35-0.8b-q8');

  const stateDir = path.join(os.tmpdir(), 'obsidian-code-vast-smoke');
  mkdirSync(stateDir, { recursive: true });
  const secretsFile = path.join(stateDir, 'secrets.json');
  const kvFile = path.join(stateDir, 'kv.json');
  const secrets = new Map<string, string>(existsSync(secretsFile) ? Object.entries(JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>) : []);
  secrets.set('vast.apiKey', apiKey);
  const persistSecrets = () => {
    const obj = Object.fromEntries([...secrets].filter(([k]) => k !== 'vast.apiKey'));
    writeFileSync(secretsFile, JSON.stringify(obj));
    try {
      chmodSync(secretsFile, 0o600);
    } catch {
      /* windows */
    }
  };
  const kv = new Map<string, unknown>(existsSync(kvFile) ? Object.entries(JSON.parse(readFileSync(kvFile, 'utf8')) as Record<string, unknown>) : []);
  const settings = {
    preferUncensored: true,
    vast: { ...DEFAULT_VAST_SETTINGS, monthlyBudget: 5, maxSessionHours: 1, idleMinutes: 10, heartbeatMinutes: 5, clockOutMode: 'destroy', localPort: 18089 },
  } as unknown as Settings;

  let lastLine = '';
  const ctx = {
    dataDir: stateDir,
    bus: {
      emit(event: string, data: unknown) {
        if (event === 'gpu.status') {
          const s = data as { phase: string; message: string; progress?: number; sessionCost: number };
          const line = `[${s.phase}] ${s.message}${s.progress !== undefined ? ` (${Math.round(s.progress * 100)}%)` : ''}`;
          if (line !== lastLine) console.log(`${new Date().toISOString().slice(11, 19)} ${line}  $${s.sessionCost.toFixed(4)}`);
          lastLine = line;
        } else if (event === 'notification') {
          const n = data as { title: string; body: string };
          console.log(`  >> ${n.title}: ${n.body}`);
        }
      },
      on: () => () => undefined,
    },
    settings: { get: () => settings, update: () => settings, forProject: () => ({ permissions: { allow: [], deny: [] }, hooks: {} }), addProjectAllowRule: () => undefined, onChange: () => () => undefined },
    secrets: {
      get: (n: string) => secrets.get(n) ?? null,
      set: (n: string, v: string | null) => {
        if (v === null) secrets.delete(n);
        else secrets.set(n, v);
        persistSecrets();
      },
      has: (n: string) => secrets.has(n),
    },
    kv: {
      read: <T,>(k: string, fb: T): T => (kv.has(k) ? (kv.get(k) as T) : fb),
      write: <T,>(k: string, v: T) => {
        kv.set(k, JSON.parse(JSON.stringify(v)));
        writeFileSync(kvFile, JSON.stringify(Object.fromEntries(kv)));
      },
    },
    native: { notify: () => undefined, isElectron: false },
  } as unknown as CoreContext;

  const gpu = new GpuManagerImpl(ctx, { resourcesDir: process.env.OBSIDIAN_RESOURCES_DIR ?? path.resolve(process.cwd(), 'resources') });
  const t0 = Date.now();
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    console.log('\nCtrl+C: clocking out…');
    void gpu.clockOut('clock_out').finally(() => process.exit(130));
  };
  process.on('SIGINT', onSigint);

  let exitCode = 1;
  try {
    const key = await gpu.testKey();
    console.log(`Key: ${key.message}`);
    if (!key.ok) return 2;
    await gpu.start();
    const pre = gpu.status();
    if (pre.orphanInstanceIds?.length) console.log(`WARNING: orphan instances on the account: ${pre.orphanInstanceIds.join(', ')}`);

    console.log(`Clocking in: profile=${profileId} model=${modelId}`);
    await gpu.clockIn({ profileId, modelId });
    const ready = await gpu.waitUntilReady(40 * 60_000);
    if (!ready) throw new Error(`Clock-in failed: ${gpu.status().lastError ?? gpu.status().message}`);
    const s = gpu.status();
    console.log(`READY after ${Math.round((Date.now() - t0) / 1000)} s on instance #${s.instanceId} (${s.numGpus}x ${s.gpuName}, $${s.pricePerHour?.toFixed(3)}/h, ${s.location})`);

    const ep = gpu.provider().endpoint();
    if (!ep) throw new Error('No endpoint although ready');
    const tReq = Date.now();
    const res = await fetch(`${ep.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 64, chat_template_kwargs: { enable_thinking: false } }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    console.log(`Chat HTTP ${res.status} in ${Date.now() - tReq} ms: ${JSON.stringify(body.choices?.[0]?.message?.content ?? body).slice(0, 200)}`);
    console.log('--- server log (tail) ---');
    console.log((await gpu.serverLog(15)).trim());
    exitCode = res.ok ? 0 : 1;
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const out = await gpu.clockOut('clock_out');
    const rec = gpu.history(1)[0];
    console.log(`Clocked out: phase=${out.phase}${out.lastError ? ` (${out.lastError})` : ''}`);
    if (rec) console.log(`Duration ${Math.round(((rec.endedAt ?? Date.now()) - rec.startedAt) / 1000)} s, cost $${rec.cost.toFixed(4)} (instance #${rec.instanceId}, ${rec.endReason})`);
    console.log(`Wall time ${Math.round((Date.now() - t0) / 1000)} s, month cost (smoke ledger) $${out.monthCost.toFixed(4)}`);
    try {
      const left = await gpu.vast.listInstances(APP_LABEL);
      if (left.length) {
        console.error(`!!! ${left.length} labelled instance(s) still exist: ${left.map((i) => `#${i.id} ${i.actual_status}`).join(', ')}. Destroying…`);
        await gpu.destroyOrphans();
        exitCode = 1;
      } else console.log('Verified: no labelled instances left on the account.');
    } catch (err) {
      console.error(`Could not verify cleanup: ${err instanceof Error ? err.message : String(err)} — CHECK console.vast.ai NOW`);
      exitCode = 1;
    }
    await gpu.dispose();
    process.off('SIGINT', onSigint);
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
