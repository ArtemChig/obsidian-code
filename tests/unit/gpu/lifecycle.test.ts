// Budget guard, orphan detection/adoption on start, park mode, key test, offers.
import { afterEach, describe, expect, it } from 'vitest';
import type { GpuSessionRecord } from '../../../src/shared/types';
import { LEDGER_KV_KEY, type LedgerData, type ParkedInstance } from '../../../src/core/gpu/ledger';
import { createHarness, type Harness } from '../../fixtures/mock-vast/harness';

const TEST_MODEL = 'test-qwen35-0.8b-q8';
const TEST_MODEL_2 = 'test-qwen35-2b-uncensored-hauhau-q4km';
let h: Harness | null = null;

afterEach(async () => {
  await h?.close();
  h = null;
});

function ledger(x: Harness): LedgerData {
  return x.kv.get(LEDGER_KV_KEY) as LedgerData;
}

function spent(cost: number): Record<string, unknown> {
  const now = Date.now();
  const rec: GpuSessionRecord = { id: 'prior', instanceId: 1, profileId: 'light', modelId: TEST_MODEL, gpuName: 'RTX 5090', numGpus: 1, pricePerHour: 1, startedAt: now - 2000, endedAt: now - 1000, cost, endReason: 'clock_out' };
  return { [LEDGER_KV_KEY]: { version: 1, records: [rec], pendingDestroy: [] } };
}

function creates(x: Harness): number {
  return x.vast.requests.filter((r) => r.path.startsWith('/api/v0/asks/')).length;
}

describe('budget guard', () => {
  it('blocks clock-in when the month budget is used up', async () => {
    h = await createHarness({ kv: spent(200) });
    await h.manager.start();
    await expect(h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL })).rejects.toThrow(/budget reached/i);
    expect(creates(h)).toBe(0);
    expect(h.manager.status().monthCost).toBe(200);
  });

  it('blocks when month cost + estimated warm-up would exceed the budget (nothing rented)', async () => {
    h = await createHarness({ kv: spent(199.99) });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(5000)).toBe(false);
    expect(h.manager.status().lastError).toMatch(/^Budget: warming up/);
    expect(creates(h)).toBe(0);
  });

  it('refuses to clock in without a positive monthly budget', async () => {
    h = await createHarness({ settings: { monthlyBudget: 0 } });
    await expect(h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL })).rejects.toThrow(/monthly GPU budget/);
  });

  it('auto clock-out when the month cost reaches the budget', async () => {
    let offset = 0;
    h = await createHarness({ kv: spent(199), now: () => Date.now() + offset });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    offset = 2 * 3_600_000; // two billed hours later: 199 + 2 x $0.52 > $200
    await h.waitFor(() => h!.manager.status().phase === 'off', 6000, 'budget clock-out');
    expect(h.vast.instances.size).toBe(0);
    const rec = h.manager.history()[0];
    expect(rec.endReason).toBe('budget');
    expect(rec.cost).toBeGreaterThan(1.04);
    expect(h.notifications.some((n) => n.title === 'GPU budget reached')).toBe(true);
  });

  it('auto clock-out after maxSessionHours', async () => {
    let offset = 0;
    h = await createHarness({ settings: { maxSessionHours: 1 }, now: () => Date.now() + offset });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    offset = 3_700_000;
    await h.waitFor(() => h!.manager.status().phase === 'off', 6000, 'max-hours clock-out');
    expect(h.vast.instances.size).toBe(0);
    expect(h.manager.history()[0].endReason).toBe('max_hours');
    // server-side watchdog gets the same cap
    const env = (h.vast.requests.find((r) => r.path.startsWith('/api/v0/asks/'))!.body as { env: Record<string, string> }).env;
    expect(env.OC_MAX_HOURS).toBe('1');
  });
});

describe('start(): orphans and adoption', () => {
  it('reports labelled untracked instances as orphans and destroys them on request (never touches other labels)', async () => {
    h = await createHarness();
    h.vast.addInstance({ id: 555, actual_status: 'running' });
    h.vast.addInstance({ id: 556, label: 'my-other-project', actual_status: 'running' });
    await h.manager.start();
    expect(h.manager.status().orphanInstanceIds).toEqual([555]);
    expect(h.notifications.some((n) => /Untracked GPU instances/.test(n.title))).toBe(true);
    expect(await h.manager.destroyOrphans()).toEqual([555]);
    expect(h.vast.instances.has(555)).toBe(false);
    expect(h.vast.instances.has(556)).toBe(true);
    expect(h.manager.status().orphanInstanceIds).toBeUndefined();
  });

  it('adopts the tracked running instance after an app restart (key recovered over SSH)', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    const startedAt = h.manager.status().clockedInAt;
    await h.manager.dispose(); // app quit/crash without clock-out: nothing is destroyed
    expect(h.vast.instances.has(id)).toBe(true);
    expect(ledger(h).active?.instanceId).toBe(id);
    h.secrets.delete('vast.serverApiKey');

    const m2 = h.makeManager();
    await m2.start();
    expect(['connecting', 'renting', 'ready']).toContain(m2.status().phase);
    expect(await m2.waitUntilReady(10_000)).toBe(true);
    const s = m2.status();
    expect(s.instanceId).toBe(id);
    expect(s.clockedInAt).toBe(startedAt);
    expect(s.orphanInstanceIds).toBeUndefined();
    const ep = m2.provider().endpoint()!;
    const r = await fetch(`${ep.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${ep.apiKey}` } });
    expect(r.status).toBe(200);
    const hb = h.box()!.heartbeats;
    await h.waitFor(() => h!.box()!.heartbeats > hb + 1, 4000, 'heartbeats from the adopting manager');
    await m2.clockOut();
    expect(h.vast.instances.size).toBe(0);
    const hist = m2.history();
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ instanceId: id, endReason: 'clock_out', startedAt });
  });

  it('closes the books when the tracked instance vanished while the app was closed', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    await h.manager.dispose();
    h.vast.instances.delete(id); // destroyed by the server-side watchdog meanwhile
    const m2 = h.makeManager();
    await m2.start();
    expect(m2.status().phase).toBe('off');
    expect(m2.history()[0]).toMatchObject({ instanceId: id, endReason: 'server_watchdog' });
    expect(ledger(h).active).toBeUndefined();
  });

  it('destroys the tracked instance when adoption cannot reconnect', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    await h.manager.dispose();
    await h.boxes.get(id)!.close(); // SSH no longer reachable
    const m2 = h.makeManager({ adoptConnectTimeoutMs: 300 });
    await m2.start();
    expect(await m2.waitUntilReady(6000)).toBe(false);
    expect(m2.status().phase).toBe('error');
    expect(h.vast.instances.has(id)).toBe(false);
    expect(m2.history()[0].endReason).toBe('error');
  });

  it('finishes an interrupted clock-out on start instead of adopting (destroy, or park when stopped)', async () => {
    h = await createHarness();
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    await h.manager.dispose();
    // the process died right after the clock-out started (main gives it only 20 s on quit)
    const l = ledger(h);
    l.active!.stopping = 'app_quit';
    h.kv.set(LEDGER_KV_KEY, l);
    const m2 = h.makeManager();
    await m2.start();
    expect(m2.status().phase).toBe('off');
    expect(h.vast.instances.has(id)).toBe(false);
    expect(m2.history()[0]).toMatchObject({ instanceId: id, endReason: 'app_quit' });
    expect(ledger(h).active).toBeUndefined();
    expect(ledger(h).pendingDestroy).toEqual([]);

    // park variant: the stop went through before the process died
    await m2.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await m2.waitUntilReady(10_000)).toBe(true);
    const id2 = m2.status().instanceId!;
    await m2.dispose();
    const l2 = ledger(h);
    l2.active!.stopping = 'app_quit';
    l2.active!.parkIntent = true;
    h.kv.set(LEDGER_KV_KEY, l2);
    const inst = h.vast.instances.get(id2)!;
    inst.intended_status = 'stopped';
    inst.actual_status = 'stopped';
    const m3 = h.makeManager();
    await m3.start();
    expect(m3.status().phase).toBe('off');
    expect(m3.status().parked?.instanceId).toBe(id2);
    expect(h.vast.instances.has(id2)).toBe(true);
    expect(m3.status().orphanInstanceIds).toBeUndefined();
  });

  it('retries pending destroys from a previous run on start', async () => {
    h = await createHarness({ kv: { [LEDGER_KV_KEY]: { version: 1, records: [], pendingDestroy: [888] } } });
    h.vast.addInstance({ id: 888, actual_status: 'running' });
    await h.manager.start();
    // GPU-8: an unconfirmed destroy is shown (it may still bill) until the retry confirms it
    expect(h.manager.status().orphanInstanceIds).toEqual([888]);
    await h.waitFor(() => !h!.vast.instances.has(888), 3000, 'pending destroy');
    await h.waitFor(() => (ledger(h!).pendingDestroy ?? []).length === 0, 2000, 'pending cleared');
    expect(h.manager.status().orphanInstanceIds).toBeUndefined();
  });
});

describe('park mode', () => {
  it('parks on clock-out, resumes the same instance (no new rental), switches model on resume, destroys when asked', async () => {
    h = await createHarness({ settings: { clockOutMode: 'park' } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;

    let out = await h.manager.clockOut();
    expect(out.phase).toBe('off');
    expect(out.parked).toMatchObject({ instanceId: id, profileId: 'light', modelId: TEST_MODEL, gpuName: 'RTX 5090' });
    expect(out.parked!.storageCostPerHour).toBeGreaterThan(0);
    expect(h.vast.instances.get(id)!.actual_status).toBe('stopped');
    expect(h.manager.history()[0].endReason).toBe('clock_out');
    expect(creates(h)).toBe(1);

    // resume: same machine, model already on disk
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().instanceId).toBe(id);
    expect(h.manager.status().parked).toBeUndefined();
    expect(creates(h)).toBe(1);
    expect(h.box()!.switches).toEqual([]);
    expect(h.manager.history().some((r) => r.gpuName.includes('parked storage'))).toBe(true);

    // park again, resume with another model → switch on the resumed instance
    out = await h.manager.clockOut();
    expect(out.parked?.instanceId).toBe(id);
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL_2 });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().modelId).toBe(TEST_MODEL_2);
    expect(h.box()!.switches).toEqual([TEST_MODEL_2]);
    expect(creates(h)).toBe(1);

    // budget/max-hours/errors never park; destroy mode destroys
    h.settings.vast.clockOutMode = 'destroy';
    out = await h.manager.clockOut();
    expect(out.parked).toBeUndefined();
    expect(h.vast.instances.size).toBe(0);
  });

  it('falls back to destroy when stopping cannot be verified', async () => {
    h = await createHarness({ settings: { clockOutMode: 'park' } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    h.vast.fail.stopFails = true;
    const out = await h.manager.clockOut();
    expect(out.parked).toBeUndefined();
    expect(h.vast.instances.size).toBe(0);
  });

  it('a resumed instance that never runs again is destroyed and a fresh one rented', async () => {
    h = await createHarness({ settings: { clockOutMode: 'park' } });
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    const id = h.manager.status().instanceId!;
    await h.manager.clockOut();
    h.vast.fail.startNeverRuns = true;
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(true);
    expect(h.manager.status().instanceId).not.toBe(id);
    expect(h.vast.instances.has(id)).toBe(false);
    h.settings.vast.clockOutMode = 'destroy';
    await h.manager.clockOut();
    expect(h.vast.instances.size).toBe(0);
  });

  it('destroys parked instances older than parkMaxDays on start, and on a user clock-out while off', async () => {
    const old: ParkedInstance = {
      instanceId: 777, profileId: 'light', modelId: TEST_MODEL, gpuName: 'RTX 5090', storageCostPerHour: 0.02, parkedAt: Date.now() - 5 * 86_400_000,
      numGpus: 1, totalVramGb: 32.6, pricePerHour: 0.5, inetDownCostPerGb: 0.0026, diskGb: 80, location: 'X',
    };
    h = await createHarness({ settings: { parkMaxDays: 3 }, kv: { [LEDGER_KV_KEY]: { version: 1, records: [], parked: old, pendingDestroy: [] } } });
    h.vast.addInstance({ id: 777, actual_status: 'stopped', intended_status: 'stopped' });
    await h.manager.start();
    expect(h.vast.instances.has(777)).toBe(false);
    expect(h.manager.status().parked).toBeUndefined();
    const rec = h.manager.history()[0];
    expect(rec).toMatchObject({ instanceId: 777, endReason: 'orphan_cleanup' });
    expect(rec.cost).toBeCloseTo(0.02 * 5 * 24, 1);

    await h.close();
    const fresh = { ...old, instanceId: 778, parkedAt: Date.now() - 3_600_000 };
    h = await createHarness({ settings: { parkMaxDays: 3 }, kv: { [LEDGER_KV_KEY]: { version: 1, records: [], parked: fresh, pendingDestroy: [] } } });
    h.vast.addInstance({ id: 778, actual_status: 'stopped', intended_status: 'stopped' });
    await h.manager.start();
    expect(h.manager.status().parked?.instanceId).toBe(778);
    expect(h.manager.status().orphanInstanceIds).toBeUndefined();
    await h.manager.clockOut('clock_out');
    expect(h.vast.instances.has(778)).toBe(false);
    expect(h.manager.status().parked).toBeUndefined();
  });
});

describe('key test, offers, provider when off', () => {
  it('testKey reports credit or a friendly invalid-key message', async () => {
    h = await createHarness();
    expect(await h.manager.testKey()).toMatchObject({ ok: true, creditBalance: 42.5 });
    h.secrets.set('vast.apiKey', 'bogus');
    const bad = await h.manager.testKey();
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Invalid Vast\.ai API key/);
    h.secrets.delete('vast.apiKey');
    expect((await h.manager.testKey()).ok).toBe(false);
    await expect(h.manager.clockIn({ profileId: 'light' })).rejects.toThrow(/No Vast\.ai API key/);
  });

  it('rejects a model that cannot fit the profile before renting anything', async () => {
    h = await createHarness();
    await expect(h.manager.clockIn({ profileId: 'light', modelId: 'glm53-flash-uncensored-huihui-iq4xs' })).rejects.toThrow(/needs about 192 GB/);
    await expect(h.manager.clockIn({ profileId: 'light', modelId: 'no-such-model' })).rejects.toThrow(/Unknown model/);
    await expect(h.manager.clockIn({ profileId: 'nope' })).rejects.toThrow(/Unknown GPU profile/);
    expect(h.vast.requests.filter((r) => r.path.startsWith('/api/v0/asks/'))).toHaveLength(0);
  });

  it('offers() maps and sorts offers for a profile; provider is offline when not clocked in', async () => {
    h = await createHarness({ noKey: true });
    const offers = await h.manager.offers('light', 2);
    expect(offers.map((o) => o.pricePerHour)).toEqual([0.52, 0.61]);
    expect(offers[0]).toMatchObject({ gpuName: 'RTX 5090', numGpus: 1, verified: true });
    await expect(h.manager.offers('nope')).rejects.toThrow(/Unknown GPU profile/);
    const p = h.manager.provider();
    expect(p.id).toBe('vast');
    expect(p.info()).toMatchObject({ id: 'vast', status: 'offline', baseUrl: null });
    expect(p.endpoint()).toBeNull();
    expect(await p.listModels()).toEqual([]);
    expect(h.manager.catalog()).toHaveLength(11);
    const st = h.manager.status();
    expect(st).toMatchObject({ phase: 'off', sessionCost: 0, monthCost: 0, monthlyBudget: 200 });
    expect(st.steps.map((s) => s.id)).toEqual(['searching', 'renting', 'connecting', 'downloading', 'loading', 'ready']);
  });
});
