// Full clock-in pipeline without Vast: mock Vast API + fake instance (ssh2 server + mock llama-server).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GpuSessionRecord } from '../../../src/shared/types';
import { LEDGER_KV_KEY, type LedgerData } from '../../../src/core/gpu/ledger';
import { createHarness, type Harness } from '../../fixtures/mock-vast/harness';
import { makeOffer } from '../../fixtures/mock-vast/server';

const TEST_MODEL = 'test-qwen35-0.8b-q8';
let h: Harness | null = null;

afterEach(async () => {
  await h?.close();
  h = null;
});

function ledger(x: Harness): LedgerData {
  return x.kv.get(LEDGER_KV_KEY) as LedgerData;
}

async function expectAllDestroyed(x: Harness): Promise<void> {
  await x.waitFor(() => x.vast.instances.size === 0, 4000, 'all instances destroyed');
  expect(x.vast.liveInstances()).toEqual([]);
  expect(ledger(x).active).toBeUndefined();
}

async function chat(baseUrl: string, apiKey: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TEST_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
  });
  return { status: r.status, text: await r.text() };
}

describe('GPU clock-in pipeline (mock Vast + fake instance)', () => {
  it('reaches ready, serves a request through the tunnel, heartbeats, and clock-out destroys with a correct ledger', async () => {
    // slow enough steps that the 25 ms status poll observes every phase even on a busy machine
    h = await createHarness({ scenario: { stepMs: 100 } });
    await h.manager.start();
    const first = await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(first.phase).toBe('searching');
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);

    const st = h.manager.status();
    expect(st.phase).toBe('ready');
    expect(st.modelId).toBe(TEST_MODEL);
    expect(st.pricePerHour).toBe(0.52);
    expect(st.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(st.steps.every((s) => s.state === 'done')).toBe(true);
    const seen = [...new Set(h.events.map((e) => e.phase))];
    for (const p of ['searching', 'renting', 'connecting', 'downloading', 'loading', 'ready']) expect(seen).toContain(p);
    expect(seen.indexOf('renting')).toBeLessThan(seen.indexOf('downloading'));
    expect(h.events.some((e) => e.phase === 'downloading' && (e.progress ?? 0) > 0 && (e.progress ?? 0) < 1)).toBe(true);

    // create payload
    const create = h.vast.requests.find((r) => r.path.startsWith('/api/v0/asks/'))!;
    const body = create.body as { label: string; runtype: string; image: string; disk: number; env: Record<string, string>; onstart: string };
    expect(create.path).toBe('/api/v0/asks/1001/');
    expect(body.label).toBe('obsidian-code');
    expect(body.runtype).toBe('ssh_direc ssh_proxy');
    expect(body.image).toBe('ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561');
    expect(body.disk).toBeGreaterThanOrEqual(80);
    expect(body.env.OC_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(body.env.OC_MODEL_ID).toBe(TEST_MODEL);
    expect(body.env.OC_HEARTBEAT_MIN).toBe('10');
    expect(body.onstart.length).toBeLessThan(4000);
    // SSH key registered on the account before renting
    expect(h.vast.sshKeys.length).toBe(1);
    const keyReq = h.vast.requests.findIndex((r) => r.path === '/api/v0/ssh/' && r.method === 'POST');
    expect(keyReq).toBeLessThan(h.vast.requests.indexOf(create));

    // provider
    const provider = h.manager.provider();
    const ep = provider.endpoint()!;
    expect(ep.baseUrl).toBe(st.endpoint);
    expect(ep.apiKey).toBe(body.env.OC_API_KEY);
    expect(provider.info().status).toBe('online');
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ ref: { provider: 'vast', model: TEST_MODEL }, contextLength: 32768, status: 'online', variant: 'standard' });

    // a request through the tunnel
    const r = await chat(ep.baseUrl, ep.apiKey!);
    expect(r.status).toBe(200);
    expect(r.text).toContain('pong');
    const box = h.box()!;
    expect(box.chatRequests).toBe(1);

    // heartbeats
    await h.waitFor(() => box.heartbeats >= 3, 4000, 'heartbeats');
    expect(await h.manager.serverLog(50)).toContain(`ready: ${TEST_MODEL}`);
    expect(h.activity.get('gpu')?.status).toBe('running');

    // clock out
    const instanceId = st.instanceId!;
    const out = await h.manager.clockOut();
    expect(out.phase).toBe('off');
    expect(h.vast.destroyed).toContain(instanceId);
    await expectAllDestroyed(h);
    expect(provider.endpoint()).toBeNull();
    await expect(chat(st.endpoint!, ep.apiKey!)).rejects.toThrow();
    expect(h.secrets.has('vast.serverApiKey')).toBe(false);

    const hist = h.manager.history();
    expect(hist).toHaveLength(1);
    const rec = hist[0] as Required<GpuSessionRecord>;
    expect(rec).toMatchObject({ instanceId, profileId: 'light', modelId: TEST_MODEL, gpuName: 'RTX 5090', pricePerHour: 0.52, endReason: 'clock_out' });
    expect(rec.endedAt).toBeGreaterThan(rec.startedAt);
    // the bandwidth part is stored rounded to 4 decimals (ledger round4)
    expect(rec.cost).toBeCloseTo(0.52 * ((rec.endedAt - rec.startedAt) / 3_600_000) + Math.round(0.81 * 0.0026 * 10_000) / 10_000, 4);
    expect(out.monthCost).toBeCloseTo(rec.cost, 4);
    expect(h.activity.get('gpu')?.status).toBe('done');
  });

  it('switches the model on the running instance', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const s = await h.manager.switchModel('test-qwen35-2b-uncensored-hauhau-q4km');
    expect(s.phase).toBe('switching');
    await h.waitFor(() => h!.manager.status().phase === 'ready', 8000, 'ready after switch');
    expect(h.manager.status().modelId).toBe('test-qwen35-2b-uncensored-hauhau-q4km');
    expect(h.box()!.switches).toEqual(['test-qwen35-2b-uncensored-hauhau-q4km']);
    expect((await h.manager.provider().listModels())[0].variant).toBe('uncensored');
    await expect(h.manager.switchModel('qwen38-27b-uncensored-hauhau-q8kp')).rejects.toThrow(/VRAM/);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
    expect(h.manager.history()[0].modelId).toBe('test-qwen35-2b-uncensored-hauhau-q4km');
  });

  it('reconnects SSH after a network drop and keeps heartbeating', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const box = h.box()!;
    const before = box.sshConnections;
    box.dropConnections();
    await h.waitFor(() => box.sshConnections > before, 5000, 'ssh reconnect');
    const hb = box.heartbeats;
    await h.waitFor(() => box.heartbeats > hb + 1, 4000, 'heartbeats after reconnect');
    expect(h.manager.status().phase).toBe('ready');
    const ep = h.manager.provider().endpoint()!;
    expect((await chat(ep.baseUrl, ep.apiKey!)).status).toBe(200);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });
});

describe('failure injection: the instance is destroyed every time', () => {
  it('create fails for every offer → error, nothing rented', async () => {
    h = await createHarness();
    h.vast.fail.createErrorTimes = 100;
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    const s = h.manager.status();
    expect(s.phase).toBe('error');
    expect(s.lastError).toMatch(/Could not rent/);
    expect(h.vast.instances.size).toBe(0);
    expect(h.manager.history()).toHaveLength(0);
  });

  it('instance never boots → destroyed, next offer tried, max 2 attempts', async () => {
    h = await createHarness({ timings: { bootTimeoutMs: 300 } });
    h.vast.fail.neverBoot = true;
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    expect(h.manager.status().phase).toBe('error');
    expect(h.manager.status().lastError).toMatch(/did not start/);
    expect(h.vast.destroyed).toHaveLength(2);
    await expectAllDestroyed(h);
    expect(h.manager.history().map((r) => r.endReason)).toEqual(['error', 'error']);
  });

  it('a dead first instance is destroyed and the next offer reaches ready', async () => {
    h = await createHarness();
    h.vast.fail.bootDeadTimes = 1;
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.vast.destroyed).toHaveLength(1);
    expect(h.vast.instances.size).toBe(1);
    expect(h.manager.status().pricePerHour).toBe(0.61);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });

  it('asks Vast for a RUNNING instance (target_state) — omitting it leaves the instance stopped forever', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const create = h.vast.requests.find((r) => r.method === 'PUT' && /\/asks\/\d+\/$/.test(r.path));
    expect((create?.body as { target_state?: string } | undefined)?.target_state).toBe('running');
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });

  it('an instance Vast created STOPPED is destroyed quickly and the next offer reaches ready', async () => {
    h = await createHarness();
    h.vast.fail.createStoppedTimes = 1;
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.vast.destroyed).toHaveLength(1);
    expect(h.vast.instances.size).toBe(1);
    expect(h.manager.history().some((r) => r.endReason === 'error')).toBe(true);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });

  it('ambiguous create (500 but created) → the stray instance is found and destroyed', async () => {
    h = await createHarness();
    h.vast.fail.createAmbiguousTimes = 1;
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.vast.destroyed).toHaveLength(1);
    expect(h.vast.instances.size).toBe(1);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });

  it('SSH unreachable → destroyed, error', async () => {
    h = await createHarness({ sshUnreachable: true, timings: { sshConnectTimeoutMs: 400 } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    const s = h.manager.status();
    expect(s.phase).toBe('error');
    expect(s.lastError).toMatch(/SSH/);
    expect(s.steps.find((x) => x.state === 'error')?.id).toBe('connecting');
    await expectAllDestroyed(h);
    expect(h.manager.history()[0].endReason).toBe('error');
  });

  it('download error → destroyed, error', async () => {
    h = await createHarness({ scenario: { failDownload: true } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    expect(h.manager.status().lastError).toMatch(/download failed/i);
    await expectAllDestroyed(h);
    expect(await h.manager.serverLog()).toContain('download failed');
  });

  it('health check fails → destroyed, error', async () => {
    h = await createHarness({ scenario: { healthStatus: 503 } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    expect(h.manager.status().lastError).toMatch(/Health check/);
    await expectAllDestroyed(h);
  });

  it('bootstrap did not start from env → uploaded over SSH → ready', async () => {
    h = await createHarness({ scenario: { noBootstrap: true } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.box()!.uploads).toEqual(expect.arrayContaining(['onstart.sh', 'bootstrap.sh', 'config.sh', 'start']));
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });

  it('experimental model fails to load → same-instance fallback to the stable model', async () => {
    const pro = (id: number, price: number) => makeOffer(id, { gpu_name: 'RTX PRO 6000 WS', gpu_ram: 97887, gpu_total_ram: 97887, cpu_ram: 128000, disk_space: 1000, inet_down: 2000, dph_total: price });
    h = await createHarness({ vast: { offers: [pro(2001, 1.19), pro(2002, 1.3)] }, scenario: { failLoad: ['qwen38-flash-next-uncensored-huihui-v2-q4kxl'] } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'standard', modelId: 'qwen38-flash-next-uncensored-huihui-v2-q4kxl' });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().modelId).toBe('qwen38-27b-uncensored-hauhau-q8kp');
    expect(h.box()!.switches).toEqual(['qwen38-27b-uncensored-hauhau-q8kp']);
    expect(h.notifications.some((n) => /Experimental model failed/.test(n.title))).toBe(true);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
  });

  it('runtime server crash after ready → destroyed, error', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    h.box()!.writeStatus('error', 0, 'llama-server crashed twice (rc=139)');
    await h.waitFor(() => h!.manager.status().phase === 'error', 4000, 'error after crash');
    expect(h.manager.status().lastError).toMatch(/crashed twice/);
    await expectAllDestroyed(h);
  });

  it('server idle watchdog firing → clean idle clock-out (not an error), instance destroyed', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    h.box()!.writeStatus('error', 0, 'Watchdog: no inference for 30 min - destroying instance');
    await h.waitFor(() => h!.manager.status().phase === 'off', 4000, 'idle clock-out');
    expect(h.manager.status().lastError).toBeUndefined();
    expect(h.manager.status().message).toMatch(/idle/);
    expect(h.manager.history()[0].endReason).toBe('idle');
    await expectAllDestroyed(h);
  });

  it('clock-out in the middle of the download aborts and destroys', async () => {
    h = await createHarness({ scenario: { downloadSteps: 50, stepMs: 50 } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    await h.waitFor(() => h!.manager.status().phase === 'downloading', 8000, 'downloading');
    const out = await h.manager.clockOut();
    expect(out.phase).toBe('off');
    await expectAllDestroyed(h);
    expect(h.manager.history()[0].endReason).toBe('clock_out');
  });

  it('instance destroyed behind our back (server watchdog) → detected, ledger closed', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    const box = h.box()!;
    h.vast.instances.delete(id);
    h.boxes.delete(id);
    await box.close();
    await h.waitFor(() => h!.manager.status().phase === 'error', 6000, 'gone detected');
    expect(h.manager.status().lastError).toMatch(/is gone/);
    expect(h.manager.history()[0].endReason).toBe('server_watchdog');
    expect(ledger(h).active).toBeUndefined();
  });

  it('destroy cannot be verified → error + pending retry until it succeeds', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    h.vast.fail.destroyAlwaysFails = true;
    const out = await h.manager.clockOut();
    expect(out.phase).toBe('error');
    expect(out.lastError).toMatch(/Could not confirm/);
    expect(out.orphanInstanceIds).toContain(id);
    expect(ledger(h).pendingDestroy).toContain(id);
    expect(h.manager.history()[0].endReason).toBe('clock_out');
    h.vast.fail.destroyAlwaysFails = false;
    await h.waitFor(() => !h!.vast.instances.has(id), 4000, 'background destroy');
    await h.waitFor(() => (ledger(h!).pendingDestroy ?? []).length === 0, 2000, 'pending cleared');
    expect(h.manager.status().orphanInstanceIds).toBeUndefined();
  });
});

describe('failure evidence: the server log is saved before the instance is destroyed', () => {
  function logs(x: Harness): string[] {
    try {
      return readdirSync(path.join(x.dataDir, 'logs'));
    } catch {
      return [];
    }
  }

  it('load failure → <dataDir>/logs/gpu-<id>-<time>.log with server.log, status, nvidia-smi; no API keys; destroyed', async () => {
    h = await createHarness({ scenario: { failLoad: [TEST_MODEL] } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    const st = h.manager.status();
    expect(st.phase).toBe('error');
    expect(st.lastError).toMatch(/failed to load/);
    await expectAllDestroyed(h);
    const id = h.vast.destroyed[0];
    expect(h.manager.history()[0]).toMatchObject({ instanceId: id, endReason: 'error' });

    const files = logs(h);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^gpu-${id}-\\d{8}-\\d{6}\\.log$`));
    const file = path.join(h.dataDir, 'logs', files[0]);
    expect(st.failureLogPath).toBe(file);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`Instance:  #${id}`);
    expect(text).toContain('GPU server error: llama-server failed to load');
    expect(text).toContain(`ERROR: failed to load ${TEST_MODEL}`); // server.log
    expect(text).toContain('CUDA error: out of memory');
    expect(text).toMatch(/===== status\.json =====\n\{"phase":"error"/);
    expect(text).toContain('NVIDIA-SMI'); // nvidia-smi
    expect(text).toMatch(/armed id=\d+ key=set/); // watchdog.log

    const create = h.vast.requests.find((r) => r.path.startsWith('/api/v0/asks/'))!;
    const serverKey = (create.body as { env: Record<string, string> }).env.OC_API_KEY;
    for (const secret of [serverKey, `ckey-${id}`, h.vast.apiKey]) expect(text).not.toContain(secret);
    expect(text).toContain('--api-key ***');
    expect(text).toContain('Bearer ***');

    // gpu.serverLog returns the saved evidence once no instance runs (also after a restart: read from disk)
    expect(await h.manager.serverLog()).toContain('CUDA error: out of memory');
    const fresh = h.makeManager();
    expect(await fresh.serverLog()).toContain('CUDA error: out of memory');
  });

  it('evidence capture is time-boxed: an instance that never answers is still destroyed', async () => {
    h = await createHarness({ scenario: { failLoad: [TEST_MODEL], evidenceHangs: true }, timings: { evidenceTimeoutMs: 300 } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(8000)).toBe(false);
    await expectAllDestroyed(h);
    expect(h.manager.status().phase).toBe('error');
    const files = logs(h);
    expect(files).toHaveLength(1);
    const text = readFileSync(path.join(h.dataDir, 'logs', files[0]), 'utf8');
    expect(text).toMatch(/did not answer within|timed out/);
    expect(text).toContain('llama-server failed to load');
  });

  it('a crash after ready saves the evidence before the destroy', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(logs(h)).toEqual([]);
    h.box()!.writeStatus('error', 0, 'llama-server crashed twice (rc=139)');
    await h.waitFor(() => h!.manager.status().phase === 'error', 4000, 'error after crash');
    await expectAllDestroyed(h);
    expect(logs(h)).toHaveLength(1);
    expect(readFileSync(h.manager.status().failureLogPath!, 'utf8')).toContain('crashed twice (rc=139)');
  });

  it('safe mode: ready with serverMode/droppedFeatures, the fallback evidence is saved, and the model stays usable', async () => {
    h = await createHarness({ scenario: { readyMode: { mode: 'safe', dropped: ['mtp', 'vision'], ctx: 16384, attempt: 2 } } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const st = h.manager.status();
    expect(st).toMatchObject({ phase: 'ready', serverMode: 'safe', droppedFeatures: ['mtp', 'vision'], serverContextLength: 16384 });
    expect(st.message).toMatch(/safe mode/);
    expect(h.notifications.some((n) => n.title === 'GPU ready (safe mode)')).toBe(true);
    await h.waitFor(() => !!h!.manager.status().failureLogPath, 4000, 'safe-mode evidence saved');
    expect(readFileSync(h.manager.status().failureLogPath!, 'utf8')).toContain('failed to create the MTP draft context');
    expect(await h.manager.serverLog()).toContain('failed load attempts (safe mode is active)');
    const models = await h.manager.provider().listModels();
    expect(models[0]).toMatchObject({ status: 'online', contextLength: 16384, supportsVision: false });
    const ep = h.manager.provider().endpoint()!;
    expect((await chat(ep.baseUrl, ep.apiKey!)).status).toBe(200);
    await h.manager.clockOut();
    await expectAllDestroyed(h);
    expect(h.manager.status().serverMode).toBeUndefined();
  });

  it('a normal clock-in reports serverMode only when the server does (old bootstraps) and saves nothing', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().serverMode).toBeUndefined();
    await h.manager.clockOut();
    await expectAllDestroyed(h);
    expect(logs(h)).toEqual([]);
    expect(h.manager.status().failureLogPath).toBeUndefined();
  });
});
