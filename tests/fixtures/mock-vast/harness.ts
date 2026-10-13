// Test harness for the GPU manager (owner: gpu): MockVast + one FakeBox (ssh2 server + mock llama) per instance +
// an in-memory CoreContext. Nothing touches the real Vast API, %APPDATA% or the network beyond 127.0.0.1.

import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { CoreContext } from '../../../src/core/contracts';
import type { ActivityItem, GpuStatus, Settings } from '../../../src/shared/types';
import { GpuManagerImpl, type GpuTimings } from '../../../src/core/gpu/manager';
import { DEFAULT_VAST_SETTINGS } from '../../../src/core/gpu/manager';
import { FakeBox, type BoxScenario } from './box';
import { MockVast, type MockVastOptions } from './server';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const RESOURCES_DIR = path.join(REPO_ROOT, 'resources');

export const FAST_TIMINGS: Partial<GpuTimings> = {
  pollIntervalMs: 25,
  bootTimeoutMs: 2000,
  parkStartTimeoutMs: 800,
  parkVerifyTimeoutMs: 800,
  sshConnectTimeoutMs: 1500,
  adoptConnectTimeoutMs: 1500,
  sshRetryMs: 50,
  sshReadyTimeoutMs: 3000,
  sshKeepaliveMs: 2000,
  statusPollMs: 25,
  bootstrapStartTimeoutMs: 400,
  downloadStallMs: 3000,
  downloadBaseTimeoutMs: 6000,
  downloadPerGbMs: 0,
  loadTimeoutMs: 3000,
  healthTimeoutMs: 800,
  heartbeatMs: 80,
  tickMs: 20,
  persistMs: 60,
  reconnectMaxMs: 150,
  destroyRetryMs: 100,
  vastBackoffMs: 5,
  destroyIntervalMs: 5,
  destroyAttempts: 3,
  destroyVerifyPolls: 2,
  creditRefreshMs: 600_000,
  goneConfirmMs: 30,
  watchdogArmTimeoutMs: 1000,
  watchdogGraceMs: 300,
  parkCheckMs: 100,
  reconcileRetryMs: 50,
  evidenceTimeoutMs: 1500,
  sshKeyReattachMs: 100,
  sshAuthGiveUpMs: 600,
};

export interface HarnessOptions {
  scenario?: BoxScenario;
  vast?: MockVastOptions;
  settings?: Partial<Settings['vast']>;
  timings?: Partial<GpuTimings>;
  kv?: Record<string, unknown>;
  secrets?: Record<string, string>;
  noKey?: boolean;
  sshUnreachable?: boolean;
  /** 'attached-only': the box ignores the account keys and accepts only keys attached to the instance (POST /instances/{id}/ssh/). */
  sshAuth?: 'normal' | 'attached-only';
  /** The first N instances reject every key (sshd up, key never accepted). */
  sshRejectFirst?: number;
  now?: () => number;
}

export interface Harness {
  vast: MockVast;
  /** Per-harness temp CoreContext.dataDir (failure logs land in <dataDir>/logs); removed by close(). */
  dataDir: string;
  boxes: Map<number, FakeBox>;
  ctx: CoreContext;
  manager: GpuManagerImpl;
  events: GpuStatus[];
  notifications: { title: string; body: string; level: string }[];
  kv: Map<string, unknown>;
  secrets: Map<string, string>;
  settings: Settings;
  activity: Map<string, ActivityItem>;
  box(): FakeBox | undefined;
  makeManager(timings?: Partial<GpuTimings>): GpuManagerImpl;
  waitFor(pred: () => boolean, timeoutMs?: number, what?: string): Promise<void>;
  close(): Promise<void>;
}

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const boxes = new Map<number, FakeBox>();
  const vast = new MockVast(opts.vast);
  const deadPort = await closedPort();
  let boxCount = 0;
  vast.provision = async (inst, reason) => {
    let box = boxes.get(inst.id);
    if (!box) {
      const rejectAll = ++boxCount <= (opts.sshRejectFirst ?? 0);
      const keys = () => (rejectAll ? [] : opts.sshAuth === 'attached-only' ? [...inst.attachedKeys] : [...vast.sshKeys.map((k) => k.key), ...inst.attachedKeys]);
      box = new FakeBox(inst.id, { ...(opts.scenario ?? {}) }, keys);
      boxes.set(inst.id, box);
      await box.start();
    }
    void reason;
    box.boot(inst.env);
    return { host: '127.0.0.1', port: opts.sshUnreachable ? deadPort : box.sshPort };
  };
  vast.deprovision = (inst, reason) => {
    const box = boxes.get(inst.id);
    if (!box) return;
    if (reason === 'stop') box.stopProcesses();
    else {
      boxes.delete(inst.id);
      void box.close();
    }
  };
  await vast.start();

  const kv = new Map<string, unknown>(Object.entries(opts.kv ?? {}).map(([k, v]) => [k, structuredClone(v)]));
  const secrets = new Map<string, string>(Object.entries(opts.secrets ?? {}));
  if (!opts.noKey && !secrets.has('vast.apiKey')) secrets.set('vast.apiKey', vast.apiKey);
  const settings = {
    preferUncensored: true,
    vast: { ...structuredClone(DEFAULT_VAST_SETTINGS), localPort: 0, ...(opts.settings ?? {}) },
  } as unknown as Settings;
  const events: GpuStatus[] = [];
  const notifications: { title: string; body: string; level: string }[] = [];
  const activity = new Map<string, ActivityItem>();
  const stopFns = new Map<string, () => void>();
  const listeners = new Map<string, Set<(d: unknown) => void>>();

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'oc-gpu-data-'));
  const ctx = {
    dataDir,
    bus: {
      emit(event: string, data: unknown) {
        if (event === 'gpu.status') events.push(data as GpuStatus);
        if (event === 'notification') notifications.push(data as { title: string; body: string; level: string });
        for (const fn of listeners.get(event) ?? []) fn(data);
      },
      on(event: string, fn: (d: unknown) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return () => listeners.get(event)!.delete(fn);
      },
    },
    settings: {
      get: () => settings,
      update: (patch: Partial<Settings>) => Object.assign(settings, patch),
      forProject: () => ({ permissions: { allow: [], deny: [] }, hooks: {} }),
      addProjectAllowRule: () => undefined,
      onChange: () => () => undefined,
    },
    secrets: {
      get: (n: string) => secrets.get(n) ?? null,
      set: (n: string, v: string | null) => (v === null ? secrets.delete(n) : secrets.set(n, v)),
      has: (n: string) => secrets.has(n),
    },
    kv: {
      read: <T,>(k: string, fb: T): T => (kv.has(k) ? (structuredClone(kv.get(k)) as T) : fb),
      write: <T,>(k: string, v: T) => void kv.set(k, structuredClone(v)),
    },
    activity: {
      upsert: (i: ActivityItem) => void activity.set(i.id, i),
      list: () => [...activity.values()],
      onStop: (id: string, fn: () => void) => void stopFns.set(id, fn),
      stop: (id: string) => stopFns.get(id)?.(),
    },
    models: { refresh: async () => ({ providers: [], models: [] }) },
    native: { notify: () => undefined, isElectron: false },
  } as unknown as CoreContext;

  const managers: GpuManagerImpl[] = [];
  const makeManager = (timings?: Partial<GpuTimings>) => {
    const m = new GpuManagerImpl(ctx, {
      vastBaseUrl: vast.url,
      resourcesDir: RESOURCES_DIR,
      timings: { ...FAST_TIMINGS, ...(opts.timings ?? {}), ...(timings ?? {}) },
      now: opts.now,
    });
    managers.push(m);
    return m;
  };
  const manager = makeManager();

  const waitFor = async (pred: () => boolean, timeoutMs = 8000, what = 'condition') => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${what}; last status: ${JSON.stringify(manager.status()).slice(0, 600)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  return {
    vast,
    dataDir,
    boxes,
    ctx,
    manager,
    events,
    notifications,
    kv,
    secrets,
    settings,
    activity,
    box: () => [...boxes.values()].at(-1),
    makeManager,
    waitFor,
    async close() {
      for (const m of managers) await m.dispose().catch(() => undefined);
      for (const b of boxes.values()) await b.close().catch(() => undefined);
      boxes.clear();
      await vast.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
