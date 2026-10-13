// Money-safety regressions (review "money", GPU-1 … GPU-10): double rentals, phantom billing, unarmed watchdogs,
// parked storage that never expires, persistence errors blocking destroys, single-404 "gone", ambiguous creates.
import { afterEach, describe, expect, it } from 'vitest';
import type { GpuSessionRecord } from '../../../src/shared/types';
import { GpuLedger, LEDGER_KV_KEY, type ActiveInstance, type LedgerData, type ParkedInstance } from '../../../src/core/gpu/ledger';
import type { KvStore } from '../../../src/core/contracts';
import { createHarness, type Harness } from '../../fixtures/mock-vast/harness';

const TEST_MODEL = 'test-qwen35-0.8b-q8';
const H = 3_600_000;
let h: Harness | null = null;

afterEach(async () => {
  await h?.close();
  h = null;
});

function ledger(x: Harness): LedgerData {
  return x.kv.get(LEDGER_KV_KEY) as LedgerData;
}

function creates(x: Harness): number {
  return x.vast.requests.filter((r) => r.path.startsWith('/api/v0/asks/')).length;
}

function activeRec(id: number, over: Partial<ActiveInstance> = {}): ActiveInstance {
  const now = Date.now();
  return {
    recordId: `rec-${id}`, instanceId: id, profileId: 'light', modelId: TEST_MODEL, gpuName: 'RTX 5090', numGpus: 1, totalVramGb: 32.6,
    pricePerHour: 1.5, inetDownCostPerGb: 0, storageCostPerHour: 0.05, diskGb: 80, location: 'X', startedAt: now - 64 * H, bandwidthUsd: 0,
    lastSeenAt: now - 63 * H, reachedReady: true, nonce: 'n', ...over,
  };
}

async function readyHarness(opts: Parameters<typeof createHarness>[0] = {}): Promise<{ x: Harness; id: number }> {
  const x = await createHarness(opts);
  h = x;
  await x.manager.start();
  await x.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
  expect(await x.manager.waitUntilReady(10_000)).toBe(true);
  return { x, id: x.manager.status().instanceId! };
}

describe('GPU-1: no second rental while start() reconciles the tracked instance', () => {
  it('claims the tracked instance synchronously; a concurrent clock-in waits and never rents', async () => {
    const { x, id } = await readyHarness();
    await x.manager.dispose(); // crash / reboot while clocked in
    x.vast.fail.listDelayMs = 400; // slow API right after a login autostart
    const m2 = x.makeManager();
    const started = m2.start();
    expect(m2.status()).toMatchObject({ phase: 'connecting', instanceId: id });
    const ready = m2.waitUntilReady(10_000);
    const st = await m2.clockIn({ profileId: 'light', modelId: TEST_MODEL }); // scheduler catch-up / tray
    await started;
    expect(st.instanceId).toBe(id);
    expect(await ready).toBe(true);
    expect(creates(x)).toBe(1);
    expect(m2.status().instanceId).toBe(id);
    x.vast.fail.listDelayMs = 0;
    await m2.clockOut();
    expect(x.vast.instances.size).toBe(0);
    expect(ledger(x).active).toBeUndefined();
    expect(m2.history().every((r) => r.endedAt !== undefined)).toBe(true);
  });

  it('the ledger refuses to track a second instance over a tracked one', () => {
    const store = new Map<string, unknown>();
    const kv: KvStore = { read: <T,>(k: string, fb: T) => (store.has(k) ? (structuredClone(store.get(k)) as T) : fb), write: (k, v) => void store.set(k, structuredClone(v)) };
    const l = new GpuLedger(kv);
    l.beginSession(activeRec(1));
    expect(() => l.beginSession(activeRec(2))).toThrow(/#1 is still tracked/);
    expect(l.active?.instanceId).toBe(1);
    expect(l.records().map((r) => r.instanceId)).toEqual([1]);
  });
});

describe('GPU-2: an interrupted clock-out is not billed until the next launch', () => {
  const hbWindow = 11 * 60_000; // heartbeatMinutes (10) + 1

  it('park intent, instance stopped: GPU billed to lastSeenAt + window, storage from then', async () => {
    const a = activeRec(4242, { stopping: 'app_quit', parkIntent: true });
    h = await createHarness({ kv: { [LEDGER_KV_KEY]: { version: 1, records: [], active: a, pendingDestroy: [] } } });
    h.vast.addInstance({ id: 4242, actual_status: 'stopped', intended_status: 'stopped' });
    await h.manager.start();
    const rec = h.manager.history().find((r) => r.instanceId === 4242)!;
    expect(rec.endedAt).toBe(a.lastSeenAt + hbWindow);
    expect(rec.cost).toBeCloseTo(1.5 * (1 + 11 / 60), 3); // not 63 h × $1.50
    expect(h.manager.status().parked).toMatchObject({ instanceId: 4242, parkedAt: a.lastSeenAt + hbWindow });
  });

  it('destroy intent, instance already gone: bounded the same way', async () => {
    const a = activeRec(4243, { stopping: 'app_quit' });
    h = await createHarness({ kv: { [LEDGER_KV_KEY]: { version: 1, records: [], active: a, pendingDestroy: [4243] } } });
    await h.manager.start();
    const rec = h.manager.history().find((r) => r.instanceId === 4243)!;
    expect(rec).toMatchObject({ endReason: 'app_quit', endedAt: a.lastSeenAt + hbWindow });
    expect(rec.cost).toBeCloseTo(1.775, 3);
    expect(h.manager.status().phase).toBe('off');
    expect(ledger(h).pendingDestroy).toEqual([]);
  });
});

describe('GPU-3: the server watchdog is verified, repaired, or the clock-in fails', () => {
  it('container key missing: repaired with the instance key from create (wd.env + restart) before ready', async () => {
    const { x } = await readyHarness({ scenario: { noContainerKey: true } });
    const box = x.box()!;
    expect(box.uploads).toContain('wd.env');
    expect(box.watchdogAlive).toBe(true);
    expect(box.watchdogStarts).toBeGreaterThanOrEqual(2);
    await x.manager.clockOut();
  });

  it('no key anywhere: the clock-in fails and the instance is destroyed instead of reaching ready', async () => {
    h = await createHarness({ scenario: { noContainerKey: true } });
    h.vast.fail.noInstanceKey = true;
    await h.manager.start();
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    expect(await h.manager.waitUntilReady(10_000)).toBe(false);
    expect(h.manager.status().phase).toBe('error');
    expect(h.manager.status().lastError).toMatch(/watchdog could not be armed/);
    await h.waitFor(() => h!.vast.instances.size === 0, 4000, 'destroyed');
  });

  it('a watchdog that dies after ready is restarted from the heartbeat', async () => {
    const { x } = await readyHarness();
    const box = x.box()!;
    const starts = box.watchdogStarts;
    box.killWatchdog();
    await x.waitFor(() => box.watchdogStarts > starts && box.watchdogAlive, 4000, 'watchdog restarted');
    expect(x.manager.status().phase).toBe('ready');
    await x.manager.clockOut();
  });

  it('a watchdog that cannot be restarted ends the session (destroyed, error)', async () => {
    const { x, id } = await readyHarness();
    const box = x.box()!;
    box.watchdogBroken = true;
    box.killWatchdog();
    await x.waitFor(() => x.manager.status().phase === 'error', 6000, 'session ended');
    expect(x.manager.status().lastError).toMatch(/watchdog/);
    await x.waitFor(() => !x.vast.instances.has(id), 4000, 'destroyed');
  });
});

describe('GPU-4: parked instances expire while the app keeps running', () => {
  const parkedRec = (id: number, ageMs: number): ParkedInstance => ({
    instanceId: id, profileId: 'light', modelId: TEST_MODEL, gpuName: 'RTX 5090', storageCostPerHour: 0.02, parkedAt: Date.now() - ageMs,
    numGpus: 1, totalVramGb: 32.6, pricePerHour: 0.5, inetDownCostPerGb: 0.0026, diskGb: 80, location: 'X',
  });

  it('destroys a parked instance once it passes parkMaxDays, without a restart', async () => {
    let offset = 0;
    h = await createHarness({ settings: { parkMaxDays: 3 }, now: () => Date.now() + offset, kv: { [LEDGER_KV_KEY]: { version: 1, records: [], parked: parkedRec(779, H), pendingDestroy: [] } } });
    h.vast.addInstance({ id: 779, actual_status: 'stopped', intended_status: 'stopped' });
    await h.manager.start();
    expect(h.manager.status().parked?.instanceId).toBe(779);
    offset = 4 * 86_400_000;
    await h.waitFor(() => !h!.vast.instances.has(779), 4000, 'parked expiry while running');
    // the parked record is cleared after the destroy is verified (a follow-up GET), so wait for it too
    await h.waitFor(() => h!.manager.status().parked === undefined, 4000, 'parked record cleared');
    expect(h.manager.status().parked).toBeUndefined();
    expect(h.notifications.some((n) => n.title === 'Parked GPU destroyed')).toBe(true);
  });

  it('expires even when the instance list cannot be read at start', async () => {
    h = await createHarness({ settings: { parkMaxDays: 3 }, kv: { [LEDGER_KV_KEY]: { version: 1, records: [], parked: parkedRec(780, 5 * 86_400_000), pendingDestroy: [] } } });
    h.vast.addInstance({ id: 780, actual_status: 'stopped', intended_status: 'stopped' });
    h.vast.fail.listAlwaysFails = true;
    await h.manager.start();
    await h.waitFor(() => !h!.vast.instances.has(780), 4000, 'expired');
    expect(h.manager.status().parked).toBeUndefined();
  });

  it('destroys parked storage once the monthly budget is used up', async () => {
    const now = Date.now();
    const spent: GpuSessionRecord = { id: 'p', instanceId: 1, profileId: 'light', modelId: TEST_MODEL, gpuName: 'X', numGpus: 1, pricePerHour: 0, startedAt: now - 2000, endedAt: now - 1000, cost: 200, endReason: 'clock_out' };
    h = await createHarness({ kv: { [LEDGER_KV_KEY]: { version: 1, records: [spent], parked: parkedRec(781, 1000), pendingDestroy: [] } } });
    h.vast.addInstance({ id: 781, actual_status: 'stopped', intended_status: 'stopped' });
    await h.manager.start();
    await h.waitFor(() => !h!.vast.instances.has(781), 4000, 'budget expiry');
    expect(h.manager.history().find((r) => r.instanceId === 781)?.endReason).toBe('budget');
  });
});

describe('GPU-5: a failing ledger write never blocks the destroy', () => {
  it('disk full during clock-out: the DELETE still goes out and the phase reaches off', async () => {
    const { x, id } = await readyHarness();
    (x.ctx.kv as { write: KvStore['write'] }).write = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const out = await x.manager.clockOut();
    expect(out.phase).toBe('off');
    expect(x.vast.instances.has(id)).toBe(false);
    expect(x.manager.history()[0]).toMatchObject({ instanceId: id, endReason: 'clock_out' });
    expect(x.notifications.some((n) => n.title === 'GPU ledger not saved')).toBe(true);
  });
});

describe('GPU-6: one null/404 GET does not drop an instance', () => {
  it('a transient null is re-checked: the session survives and reconnects', async () => {
    const { x, id } = await readyHarness();
    x.vast.fail.getNullTimes = 1;
    const reconnects = x.manager.stats.reconnects;
    x.box()!.dropConnections();
    await x.waitFor(() => x.manager.stats.reconnects > reconnects, 6000, 'reconnected');
    expect(x.manager.status()).toMatchObject({ phase: 'ready', instanceId: id });
    expect(x.vast.instances.has(id)).toBe(true);
    expect(ledger(x).active?.instanceId).toBe(id);
    await x.manager.clockOut();
  });

  it('a persistent null still sends a DELETE (the instance may be alive) before reporting it gone', async () => {
    const { x, id } = await readyHarness();
    x.vast.fail.getAlwaysNull = true;
    x.box()!.dropConnections();
    await x.waitFor(() => x.manager.status().phase === 'error', 6000, 'gone handled');
    expect(x.vast.requests.some((r) => r.method === 'DELETE' && r.path === `/api/v0/instances/${id}/`)).toBe(true);
    expect(x.vast.instances.has(id)).toBe(false);
    expect(x.manager.status().lastError).toMatch(/is gone/);
    expect(ledger(x).active).toBeUndefined();
  });
});

describe('GPU-7: an ambiguous create that cannot be reconciled does not rent another offer', () => {
  it('stops the clock-in and destroys the instance from a background reconcile', async () => {
    h = await createHarness();
    await h.manager.start();
    h.vast.fail.createAmbiguousTimes = 1;
    h.vast.fail.listAlwaysFails = true;
    await h.manager.clockIn({ profileId: 'light', modelId: TEST_MODEL });
    await h.waitFor(() => h!.manager.status().phase === 'error', 6000, 'clock-in stopped');
    expect(h.manager.status().lastError).toMatch(/ambiguously/);
    expect(creates(h)).toBe(1);
    expect(h.vast.instances.size).toBe(1); // created on Vast although the API answered 500
    h.vast.fail.listAlwaysFails = false;
    await h.waitFor(() => h!.vast.instances.size === 0, 6000, 'background reconcile destroyed it');
    // The ledger record is written after the destroy is verified (a follow-up GET), so wait for it too.
    await h.waitFor(() => h!.manager.history().some((r) => r.endReason === 'error'), 6000, 'reconcile recorded');
  });
});

describe('GPU-8: unconfirmed destroys stay visible', () => {
  it('a clock-out with nothing active keeps the error while a destroy is unconfirmed', async () => {
    const { x, id } = await readyHarness();
    x.vast.fail.destroyAlwaysFails = true;
    let out = await x.manager.clockOut();
    expect(out.phase).toBe('error');
    out = await x.manager.clockOut(); // scheduler finally / parked card's Destroy / quit
    expect(out.phase).toBe('error');
    expect(out.lastError).toMatch(new RegExp(`Could not confirm that instance #${id} was destroyed`));
    expect(out.orphanInstanceIds).toContain(id);
    x.vast.fail.destroyAlwaysFails = false;
    await x.waitFor(() => x.manager.status().phase === 'off', 4000, 'confirmed');
    expect(x.manager.status().orphanInstanceIds).toBeUndefined();
  });
});

describe('GPU-9: a tracked instance without an API key', () => {
  it('is not billed as adopted, cannot be rented over, and is adopted once a key is added', async () => {
    const { x, id } = await readyHarness();
    await x.manager.dispose();
    x.secrets.delete('vast.apiKey');
    const m2 = x.makeManager();
    await m2.start();
    expect(m2.status()).toMatchObject({ phase: 'error', instanceId: id });
    expect(m2.status().lastError).toMatch(/no Vast\.ai API key/);
    await expect(m2.clockIn({ profileId: 'light', modelId: TEST_MODEL })).rejects.toThrow(/API key/);
    await expect(m2.clockOut()).rejects.toThrow(/Add your Vast\.ai API key/);
    expect(creates(x)).toBe(1);
    x.secrets.set('vast.apiKey', x.vast.apiKey);
    await x.waitFor(() => m2.status().phase === 'ready', 8000, 'adopted after the key was added');
    expect(m2.status().instanceId).toBe(id);
    await m2.clockOut();
    expect(x.vast.instances.size).toBe(0);
  });
});

describe('GPU-10: monthly spend splits sessions across month boundaries', () => {
  const mk = (): GpuLedger => {
    const store = new Map<string, unknown>();
    return new GpuLedger({ read: <T,>(k: string, fb: T) => (store.has(k) ? (structuredClone(store.get(k)) as T) : fb), write: (k, v) => void store.set(k, structuredClone(v)) });
  };

  it('a session from Jan 31 20:00 to Feb 1 02:00 puts 2 h in February and 4 h (+ bandwidth) in January (no DST change)', () => {
    const l = mk();
    const start = new Date(2027, 0, 31, 20).getTime();
    const end = new Date(2027, 1, 1, 2).getTime();
    l.addRecord({ id: 'r', instanceId: 1, profileId: 'light', modelId: TEST_MODEL, gpuName: 'X', numGpus: 1, pricePerHour: 3.2, startedAt: start, endedAt: end, cost: 19.2 + 0.5, endReason: 'max_hours' });
    expect(l.monthCost(new Date(2027, 1, 15).getTime())).toBeCloseTo(6.4, 4);
    expect(l.monthCost(new Date(2027, 0, 31, 23).getTime())).toBeCloseTo(12.8 + 0.5, 4);
  });

  it('the live session does not jump when it ends after midnight', () => {
    const l = mk();
    const start = new Date(2027, 0, 31, 20).getTime();
    l.beginSession(activeRec(7, { pricePerHour: 3.2, startedAt: start, lastSeenAt: start, bandwidthUsd: 0 }));
    const t = new Date(2027, 1, 1, 2).getTime();
    const live = l.monthCost(t);
    l.finalizeActive('max_hours', t);
    expect(live).toBeCloseTo(6.4, 4);
    expect(l.monthCost(t)).toBeCloseTo(6.4, 4);
  });

  it('parked storage that crosses a month boundary is split too', () => {
    const l = mk();
    const parkedAt = new Date(2027, 0, 31, 12).getTime();
    l.setParked({ instanceId: 9, profileId: 'light', modelId: TEST_MODEL, gpuName: 'X', storageCostPerHour: 0.1, parkedAt, numGpus: 1, totalVramGb: 32, pricePerHour: 1, inetDownCostPerGb: 0, diskGb: 80, location: 'X' });
    expect(l.monthCost(new Date(2027, 1, 1, 12).getTime())).toBeCloseTo(1.2, 4);
  });
});
