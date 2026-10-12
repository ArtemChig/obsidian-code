// GPU manager (owner: gpu): Vast.ai clock-in / clock-out state machine.
//
// MONEY SAFETY — the invariants this file maintains:
//   1. An instance id is persisted to the ledger (kv 'gpu-ledger'.active) the moment createInstance returns, before
//      anything else can fail. From then on exactly one of these happens: it reaches 'ready' and is later clocked out
//      (destroyed or parked), or ANY failure tears it down (destroyed + verified).
//   2. Destroy is verified with GET; unverified destroys go to ledger.pendingDestroy and are retried in the background
//      and on every start().
//   3. While clocked in: a 1 s ticker enforces the monthly budget and maxSessionHours (auto clock-out); an SSH
//      heartbeat every 60 s keeps the server-side watchdog (onstart.sh) from self-destroying the instance. If the app
//      dies, the watchdog destroys the instance after heartbeatMinutes; on next start the ledger record is closed.
//   4. createInstance is never retried blindly; an ambiguous failure triggers a reconcile that destroys any instance
//      carrying this attempt's nonce (or created during the attempt and not tracked).
//   5. dispose() never destroys (the main process calls clockOut on quit); start() adopts or reports what is left.

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { CoreContext, GpuManager, LlmProvider } from '../contracts';
import type { CatalogModel, GpuOffer, GpuPhase, GpuProfile, GpuSessionRecord, GpuStatus, Settings } from '../../shared/types';
import {
  catalogModels, defaultModelForProfile, diskGbFor, estimateWarmupCost, experimentalFallback, getCatalogModel, CATALOG,
} from './catalog';
import { GpuLedger, costFor, round4, type ActiveInstance, type ParkedInstance } from './ledger';
import { defaultProfiles, findProfile } from './profiles';
import {
  bootMaxMinutesFor, buildInstanceEnv, loadServerScripts, parseEnvFile, parseServerStatus, renderConfigSh, shQuote,
  type ServerScripts, type ServerStatus,
} from './server-scripts';
import { LocalTunnel, SshConnection, ensureAppKey } from './ssh';
import {
  APP_LABEL, VastClient, VastError, buildOfferQuery, instanceIsDead, instanceIsGone, instanceIsRunning, offerTotalVramGb,
  sshTargets, toGpuOffer, type VastInstance, type VastRawOffer,
} from './vast-client';
import { VastProvider } from './provider';

export const SERVER_KEY_SECRET = 'vast.serverApiKey';
export const VAST_KEY_SECRET = 'vast.apiKey';

type EndReason = NonNullable<GpuSessionRecord['endReason']>;

export interface GpuTimings {
  /** Instance status polling while booting. */
  pollIntervalMs: number;
  bootTimeoutMs: number;
  parkStartTimeoutMs: number;
  parkVerifyTimeoutMs: number;
  sshConnectTimeoutMs: number;
  adoptConnectTimeoutMs: number;
  sshRetryMs: number;
  sshReadyTimeoutMs: number;
  sshKeepaliveMs: number;
  statusPollMs: number;
  bootstrapStartTimeoutMs: number;
  downloadStallMs: number;
  downloadBaseTimeoutMs: number;
  downloadPerGbMs: number;
  loadTimeoutMs: number;
  healthTimeoutMs: number;
  heartbeatMs: number;
  tickMs: number;
  persistMs: number;
  reconnectMaxMs: number;
  destroyRetryMs: number;
  vastBackoffMs: number;
  destroyIntervalMs: number;
  destroyAttempts: number;
  destroyVerifyPolls: number;
  creditRefreshMs: number;
}

export const DEFAULT_TIMINGS: GpuTimings = {
  pollIntervalMs: 5000,
  bootTimeoutMs: 15 * 60_000,
  parkStartTimeoutMs: 4 * 60_000,
  parkVerifyTimeoutMs: 90_000,
  sshConnectTimeoutMs: 5 * 60_000,
  adoptConnectTimeoutMs: 3 * 60_000,
  sshRetryMs: 5000,
  sshReadyTimeoutMs: 20_000,
  sshKeepaliveMs: 15_000,
  statusPollMs: 3000,
  bootstrapStartTimeoutMs: 90_000,
  downloadStallMs: 10 * 60_000,
  downloadBaseTimeoutMs: 15 * 60_000,
  downloadPerGbMs: 20_000,
  loadTimeoutMs: 30 * 60_000,
  healthTimeoutMs: 60_000,
  heartbeatMs: 60_000,
  tickMs: 1000,
  persistMs: 30_000,
  reconnectMaxMs: 30_000,
  destroyRetryMs: 30_000,
  vastBackoffMs: 2000,
  destroyIntervalMs: 3000,
  destroyAttempts: 6,
  destroyVerifyPolls: 5,
  creditRefreshMs: 10 * 60_000,
};

export const DEFAULT_VAST_SETTINGS: Settings['vast'] = {
  profiles: defaultProfiles(),
  monthlyBudget: 200,
  idleMinutes: 30,
  heartbeatMinutes: 10,
  maxSessionHours: 6,
  clockOutOnQuit: true,
  clockOutMode: 'destroy',
  parkMaxDays: 3,
  image: 'ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561',
  localPort: 18080,
  extraLlamaArgs: [],
};

export interface GpuManagerOptions {
  /** Vast API base (default env OBSIDIAN_VAST_API_URL or https://console.vast.ai). */
  vastBaseUrl?: string;
  /** Directory containing server/onstart.sh + server/bootstrap.sh. */
  resourcesDir?: string;
  fetch?: typeof fetch;
  timings?: Partial<GpuTimings>;
  now?: () => number;
}

const STEP_DEFS: { id: GpuPhase; label: string }[] = [
  { id: 'searching', label: 'Check budget and find a GPU' },
  { id: 'renting', label: 'Rent the instance and boot' },
  { id: 'connecting', label: 'Connect over SSH' },
  { id: 'downloading', label: 'Download the model' },
  { id: 'loading', label: 'Load the model into VRAM' },
  { id: 'ready', label: 'Ready' },
];
const STEP_INDEX = new Map(STEP_DEFS.map((s, i) => [s.id, i]));

class BootError extends Error {}
class AbortedError extends Error {
  constructor() {
    super('aborted');
  }
}

const HB_MARK = 'OC_HB_OK';

function isStoppedState(inst: VastInstance): boolean {
  return inst.actual_status === 'stopped' || (inst.intended_status === 'stopped' && inst.actual_status !== 'running');
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function httpGetStatus(url: string, apiKey: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: { Authorization: `Bearer ${apiKey}`, Connection: 'close' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        if (body.length < 65536) body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export class GpuManagerImpl implements GpuManager {
  readonly vast: VastClient;
  private readonly t: GpuTimings;
  private readonly now: () => number;
  private ledgerInst: GpuLedger | null = null;
  private readonly providerImpl: VastProvider;

  private phase: GpuPhase = 'off';
  private message = 'Clocked out';
  private progress: number | undefined;
  private lastError: string | undefined;
  private failedStep: GpuPhase | undefined;
  private lastStepIndex = -1;
  private target: { profileId: string; modelId: string } | undefined;
  private orphanIds: number[] = [];
  private creditBalance: number | undefined;
  private lastServerLog = '';
  private lastWatchdogMsg: string | undefined;

  private active: ActiveInstance | null = null;
  private serverApiKey: string | null = null;
  private ssh: SshConnection | null = null;
  private tunnel: LocalTunnel | null = null;
  private endpointUrl: string | undefined;
  private readonly hostKeys = new Map<string, string>();

  private job: { kind: 'clockIn' | 'adopt' | 'switch'; abort: AbortController; promise: Promise<void> } | null = null;
  private tearingDown: Promise<void> | null = null;
  private autoStopping = false;
  private reconnecting = false;
  private hbFailures = 0;
  private lastAliveCheck = 0;
  private disposed = false;
  private started = false;

  private tickTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private destroyRetryTimer: NodeJS.Timeout | null = null;
  private creditTimer: NodeJS.Timeout | null = null;
  private readyWaiters: ((ok: boolean) => void)[] = [];
  /** Counters for tests/diagnostics. */
  readonly stats = { heartbeats: 0, heartbeatFailures: 0, reconnects: 0 };

  constructor(
    private readonly ctx: CoreContext,
    private readonly opts: GpuManagerOptions = {},
  ) {
    this.t = { ...DEFAULT_TIMINGS, ...(opts.timings ?? {}) };
    this.now = opts.now ?? Date.now;
    this.vast = new VastClient({
      apiKey: () => this.secret(VAST_KEY_SECRET),
      baseUrl: opts.vastBaseUrl ?? process.env.OBSIDIAN_VAST_API_URL ?? undefined,
      fetch: opts.fetch,
      backoffMs: this.t.vastBackoffMs,
      destroyIntervalMs: this.t.destroyIntervalMs,
      logPollMs: Math.min(300, this.t.destroyIntervalMs),
    });
    this.providerImpl = new VastProvider({
      status: () => this.status(),
      apiKey: () => this.serverApiKey,
      currentModel: () => {
        const id = this.active?.modelId ?? (this.job ? this.target?.modelId : undefined);
        return id ? getCatalogModel(id) ?? null : null;
      },
    });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Bound lazily to ctx.kv (factories must not touch other modules during construction). */
  private get ledger(): GpuLedger {
    if (!this.ledgerInst) this.ledgerInst = new GpuLedger(this.ctx.kv);
    return this.ledgerInst;
  }

  private secret(name: string): string | null {
    try {
      return this.ctx.secrets?.get(name) ?? null;
    } catch {
      return null;
    }
  }

  private setSecret(name: string, value: string | null): void {
    try {
      this.ctx.secrets?.set(name, value);
    } catch {
      /* ignore */
    }
  }

  private vastSettings(): Settings['vast'] {
    let s: Partial<Settings['vast']> | undefined;
    try {
      s = this.ctx.settings?.get()?.vast;
    } catch {
      s = undefined;
    }
    const merged = { ...DEFAULT_VAST_SETTINGS, ...(s ?? {}) } as Settings['vast'];
    if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) merged.profiles = defaultProfiles();
    if (!Array.isArray(merged.extraLlamaArgs)) merged.extraLlamaArgs = [];
    return merged;
  }

  private preferUncensored(): boolean {
    try {
      return this.ctx.settings?.get()?.preferUncensored !== false;
    } catch {
      return true;
    }
  }

  private emit(): void {
    try {
      this.ctx.bus?.emit('gpu.status', this.status());
    } catch {
      /* bus not ready */
    }
  }

  private notify(title: string, body: string, level: 'info' | 'success' | 'warning' | 'error'): void {
    try {
      this.ctx.bus?.emit('notification', { title, body, level });
    } catch {
      /* ignore */
    }
  }

  private refreshModels(): void {
    setTimeout(() => {
      try {
        void this.ctx.models?.refresh?.().catch(() => undefined);
      } catch {
        /* registry not ready */
      }
    }, 0);
  }

  private updateActivity(): void {
    const act = this.ctx.activity;
    if (!act) return;
    if (this.phase === 'off' && !this.active && !this.lastError) {
      try {
        const existing = act.list().find((i) => i.id === 'gpu');
        if (existing && existing.status === 'running') act.upsert({ ...existing, status: 'done', endedAt: this.now(), detail: this.message });
      } catch {
        /* ignore */
      }
      return;
    }
    const status = this.phase === 'error' ? 'error' : this.phase === 'off' ? 'done' : 'running';
    const a = this.active;
    try {
      act.upsert({
        id: 'gpu',
        kind: 'gpu',
        title: `GPU ${a?.gpuName ?? ''}${a ? ` · ${a.modelId}` : this.target ? ` · ${this.target.modelId}` : ''}`.trim(),
        status,
        startedAt: a?.startedAt ?? this.now(),
        endedAt: status === 'running' ? undefined : this.now(),
        detail: this.message,
      });
    } catch {
      /* ignore */
    }
  }

  private setPhase(phase: GpuPhase, message: string, progress?: number): void {
    const changed = phase !== this.phase;
    this.phase = phase;
    this.message = message;
    this.progress = progress;
    const idx = STEP_INDEX.get(phase);
    if (idx !== undefined) this.lastStepIndex = idx;
    if (phase === 'ready') this.resolveWaiters(true);
    if (phase === 'off' || phase === 'error') this.resolveWaiters(false);
    if (changed) {
      this.updateActivity();
      if (phase === 'ready' || phase === 'off' || phase === 'error') this.refreshModels();
    }
    this.emit();
  }

  private setMessage(message: string, progress?: number): void {
    this.message = message;
    if (progress !== undefined) this.progress = progress;
    this.emit();
  }

  private resolveWaiters(ok: boolean): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const fn of w) fn(ok);
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted || this.disposed) throw new AbortedError();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortedError());
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private liveSessionCost(now = this.now()): number {
    const a = this.active;
    return a ? costFor(a.pricePerHour, a.startedAt, now, a.bandwidthUsd) : 0;
  }

  private monthCost(now = this.now()): number {
    return this.ledger.monthCost(now, this.active ? this.liveSessionCost(now) : undefined);
  }

  private steps(): GpuStatus['steps'] {
    let cur = -1;
    let errorAt = -1;
    switch (this.phase) {
      case 'off':
        cur = -1;
        break;
      case 'error':
        errorAt = this.failedStep !== undefined ? STEP_INDEX.get(this.failedStep) ?? -1 : -1;
        cur = errorAt;
        break;
      case 'switching':
        cur = STEP_INDEX.get('downloading')!;
        break;
      case 'stopping':
        cur = this.lastStepIndex;
        break;
      default:
        cur = STEP_INDEX.get(this.phase) ?? -1;
    }
    return STEP_DEFS.map((s, i) => {
      let state: 'todo' | 'active' | 'done' | 'error' = 'todo';
      if (this.phase === 'ready') state = 'done';
      else if (this.phase === 'stopping') state = i <= cur ? 'done' : 'todo';
      else if (i < cur) state = 'done';
      else if (i === cur) state = this.phase === 'error' ? 'error' : 'active';
      if (this.phase === 'switching' && s.id === 'loading') state = this.progress === 1 ? 'active' : 'todo';
      return { id: s.id, label: s.label, state };
    });
  }

  // ───────────────────────────── GpuManager API ─────────────────────────────

  status(): GpuStatus {
    const now = this.now();
    const a = this.active;
    const vs = this.vastSettings();
    const parked = this.ledger.parked;
    const st: GpuStatus = {
      phase: this.phase,
      message: this.message,
      sessionCost: round4(this.liveSessionCost(now)),
      monthCost: this.monthCost(now),
      monthlyBudget: vs.monthlyBudget,
      steps: this.steps(),
    };
    if (this.progress !== undefined) st.progress = this.progress;
    const profileId = a?.profileId ?? this.target?.profileId;
    const modelId = a?.modelId ?? this.target?.modelId;
    if (profileId) st.profileId = profileId;
    if (modelId) st.modelId = modelId;
    if (a) {
      st.instanceId = a.instanceId;
      st.gpuName = a.gpuName;
      st.numGpus = a.numGpus;
      st.pricePerHour = a.pricePerHour;
      st.location = a.location;
      st.clockedInAt = a.startedAt;
      if (a.readyAt) st.readyAt = a.readyAt;
    }
    if (this.phase === 'ready' && this.endpointUrl) st.endpoint = this.endpointUrl;
    if (this.creditBalance !== undefined) st.creditBalance = this.creditBalance;
    if (this.lastError) st.lastError = this.lastError;
    if (this.orphanIds.length) st.orphanInstanceIds = [...this.orphanIds];
    if (parked) {
      st.parked = {
        instanceId: parked.instanceId,
        profileId: parked.profileId,
        modelId: parked.modelId,
        gpuName: parked.gpuName,
        storageCostPerHour: parked.storageCostPerHour,
        parkedAt: parked.parkedAt,
      };
    }
    return st;
  }

  provider(): LlmProvider {
    return this.providerImpl;
  }

  catalog(): CatalogModel[] {
    return catalogModels();
  }

  history(limit?: number): GpuSessionRecord[] {
    return this.ledger.records(limit);
  }

  async offers(profileId: string, limit = 20): Promise<GpuOffer[]> {
    const vs = this.vastSettings();
    const profile = findProfile(vs.profiles, profileId);
    if (!profile) throw new Error(`Unknown GPU profile "${profileId}"`);
    const model = defaultModelForProfile(profile.id, profile.defaultModelId, this.preferUncensored());
    const diskGb = diskGbFor(model ?? { sizeGb: 0 }, profile.minDiskGb);
    const raw = await this.vast.searchOffers(buildOfferQuery(profile, { diskGb, limit: Math.max(1, Math.min(64, limit)) }));
    return raw
      .filter((o) => !model || offerTotalVramGb(o) >= model.minTotalVramGb)
      .filter((o) => Number(o.dph_total) <= profile.maxPricePerHour)
      .sort((a, b) => a.dph_total - b.dph_total)
      .slice(0, limit)
      .map(toGpuOffer);
  }

  async clockIn(opts: { profileId: string; modelId?: string; offerId?: number }): Promise<GpuStatus> {
    if (this.disposed) throw new Error('The GPU manager is shut down.');
    if (this.tearingDown) throw new Error('A clock-out is still in progress. Try again in a moment.');
    if (this.job || this.active) {
      if (this.phase === 'ready') throw new Error('Already clocked in.');
      throw new Error('A clock-in is already in progress.');
    }
    const vs = this.vastSettings();
    const profile = findProfile(vs.profiles, opts.profileId);
    if (!profile) throw new Error(`Unknown GPU profile "${opts.profileId}".`);
    const model = opts.modelId ? getCatalogModel(opts.modelId) : defaultModelForProfile(profile.id, profile.defaultModelId, this.preferUncensored());
    if (!model) throw new Error(`Unknown model "${opts.modelId ?? profile.defaultModelId}".`);
    const profileVram = profile.numGpus * profile.minGpuRamGb;
    if (!model.profiles.includes(profile.id) && model.minTotalVramGb > profileVram * 1.1) {
      throw new Error(`${model.label} needs about ${model.minTotalVramGb} GB of VRAM; the ${profile.label} profile has ${profileVram} GB. Pick a bigger profile.`);
    }
    if (!this.vast.hasKey()) throw new Error('No Vast.ai API key set. Add it in Settings > Vast.ai.');
    this.assertBudgetHeadroom();
    const scripts = loadServerScripts(this.opts.resourcesDir);

    this.lastError = undefined;
    this.failedStep = undefined;
    this.lastServerLog = '';
    this.autoStopping = false;
    this.target = { profileId: profile.id, modelId: model.id };
    this.setPhase('searching', 'Checking the budget and searching for a GPU…');
    this.runJob('clockIn', (signal) => this.clockInPipeline(profile, model, scripts, opts.offerId, signal));
    return this.status();
  }

  async clockOut(reason: EndReason = 'clock_out'): Promise<GpuStatus> {
    if (this.tearingDown) {
      await this.tearingDown.catch(() => undefined);
      return this.status();
    }
    const job = this.job;
    if (job) {
      job.abort.abort();
      await job.promise.catch(() => undefined);
      if (this.tearingDown) await (this.tearingDown as Promise<void>).catch(() => undefined);
    }
    if (this.active) {
      await this.teardown(reason);
    } else if (job) {
      // Cancelled before anything was rented (or the job already cleaned up after itself).
      if (this.phase !== 'error' && this.phase !== 'off') {
        this.lastError = undefined;
        this.failedStep = undefined;
        this.setPhase('off', 'Clock-in cancelled.');
      }
    } else {
      // Nothing rented. A user clock-out also discards a parked instance (stops its storage billing).
      if (reason === 'clock_out' && this.ledger.parked) await this.destroyParked('clock_out');
      if (this.phase !== 'off') {
        this.lastError = undefined;
        this.failedStep = undefined;
        this.setPhase('off', 'Clocked out');
      } else this.emit();
    }
    return this.status();
  }

  async switchModel(modelId: string): Promise<GpuStatus> {
    // A clock-in job that just reached 'ready' may still be unwinding; let it finish first.
    if (this.job && this.phase === 'ready') await this.job.promise.catch(() => undefined);
    const a = this.active;
    if (!a || this.phase !== 'ready' || this.job) throw new Error('The GPU is not ready. Clock in first.');
    const model = getCatalogModel(modelId);
    if (!model) throw new Error(`Unknown model "${modelId}".`);
    if (model.id === a.modelId) return this.status();
    if (model.minTotalVramGb > a.totalVramGb + 0.5) {
      throw new Error(`${model.label} needs ${model.minTotalVramGb} GB of VRAM; this instance has ${Math.round(a.totalVramGb)} GB.`);
    }
    if (model.sizeGb + 5 > a.diskGb) throw new Error(`${model.label} (${model.sizeGb} GB) does not fit on this instance's ${a.diskGb} GB disk.`);
    this.target = { profileId: a.profileId, modelId: model.id };
    this.setPhase('switching', `Switching to ${model.label}…`, 0);
    this.runJob('switch', async (signal) => {
      await this.runSwitchCommand(model.id);
      this.active!.modelId = model.id;
      this.active!.bandwidthUsd = round4(this.active!.bandwidthUsd + model.sizeGb * this.active!.inetDownCostPerGb);
      this.ledger.updateActive({ modelId: model.id, bandwidthUsd: this.active!.bandwidthUsd, lastSeenAt: this.now() });
      const finalModel = await this.waitServerReady(model, null, signal, true);
      await this.healthCheck(signal);
      this.markReady(finalModel);
    });
    return this.status();
  }

  async destroyOrphans(): Promise<number[]> {
    if (!this.vast.hasKey()) throw new Error('No Vast.ai API key set.');
    const list = await this.vast.listInstances(APP_LABEL);
    const keep = new Set([this.active?.instanceId, this.ledger.parked?.instanceId]);
    const ids = list.filter((i) => !keep.has(i.id) && !instanceIsGone(i)).map((i) => i.id);
    const destroyed: number[] = [];
    for (const id of ids) {
      if (await this.destroyInstanceSafe(id)) {
        destroyed.push(id);
        this.ledger.closeDanglingRecord(id, this.now(), 'orphan_cleanup');
      }
    }
    this.orphanIds = ids.filter((id) => !destroyed.includes(id));
    this.emit();
    return destroyed;
  }

  async serverLog(lines = 200): Promise<string> {
    const n = Math.max(10, Math.min(5000, Math.round(lines)));
    if (this.ssh?.isConnected()) {
      try {
        const r = await this.ssh.exec(`tail -n ${n} /root/oc/server.log 2>/dev/null`, { timeoutMs: 15_000 });
        if (r.stdout.trim()) return r.stdout;
        const r2 = await this.ssh.exec(`tail -n ${n} /root/oc/bootstrap.log /root/oc/watchdog.log 2>/dev/null`, { timeoutMs: 15_000 });
        return r2.stdout;
      } catch {
        /* fall through */
      }
    }
    if (this.active && this.vast.hasKey()) {
      try {
        return await this.vast.requestLogs(this.active.instanceId, n);
      } catch {
        /* fall through */
      }
    }
    return this.lastServerLog;
  }

  async testKey(): Promise<{ ok: boolean; message: string; creditBalance?: number }> {
    if (!this.vast.hasKey()) return { ok: false, message: 'No Vast.ai API key set.' };
    try {
      const u = await this.vast.currentUser();
      this.creditBalance = u.creditBalance;
      this.emit();
      const credit = u.creditBalance !== undefined ? ` Credit: $${u.creditBalance.toFixed(2)}.` : '';
      return { ok: true, message: `Key works${u.email ? ` (${u.email})` : ''}.${credit}`, creditBalance: u.creditBalance };
    } catch (err) {
      return { ok: false, message: errMsg(err) };
    }
  }

  waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.phase === 'ready') return Promise.resolve(true);
    if (!this.job && !this.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.readyWaiters.push(finish);
    });
  }

  /** Startup reconciliation: adopt the tracked instance, account for vanished ones, report orphans, expire parked. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      this.ctx.activity?.onStop('gpu', () => {
        void this.clockOut('clock_out');
      });
    } catch {
      /* activity not available */
    }
    if (this.ledger.pendingDestroy.length) this.scheduleDestroyRetry(true);

    const a = this.ledger.active;
    if (!this.vast.hasKey()) {
      if (a) {
        this.active = a;
        this.target = { profileId: a.profileId, modelId: a.modelId };
        this.startBillingTimers();
        this.lastError = `An instance (#${a.instanceId}) is still tracked but no Vast.ai API key is set; it will self-destroy within ${this.vastSettings().heartbeatMinutes} min. Add the key to manage it.`;
        this.setPhase('error', this.lastError);
      }
      return;
    }

    let instances: VastInstance[] | null = null;
    try {
      instances = await this.vast.listInstances(APP_LABEL);
    } catch (err) {
      this.lastError = `Could not list Vast.ai instances: ${errMsg(err)}`;
    }
    const now = this.now();
    const vs = this.vastSettings();

    if (a) {
      let inst: VastInstance | null | undefined = instances?.find((i) => i.id === a.instanceId);
      if (!inst) {
        try {
          inst = await this.vast.getInstance(a.instanceId);
        } catch {
          inst = undefined; // unknown (network): try to adopt anyway
        }
      }
      const alive = inst !== null && !(inst && instanceIsGone(inst));
      const stopReason: EndReason | undefined = a.stopping ?? (this.ledger.pendingDestroy.includes(a.instanceId) ? 'error' : undefined);
      if (stopReason) {
        // The app exited in the middle of a clock-out/teardown: finish it (never adopt an instance being stopped).
        this.ledger.finalizeActive(stopReason, now);
        if (alive && a.parkIntent && inst && isStoppedState(inst)) {
          this.ledger.setParked(this.parkedFrom(a, now));
        } else {
          this.setSecret(SERVER_KEY_SECRET, null);
          if (alive) await this.destroyInstanceSafe(a.instanceId);
          else this.ledger.removePendingDestroy(a.instanceId);
        }
      } else if (!alive) {
        // Gone while the app was closed: the server watchdog (or Vast) destroyed it.
        const end = Math.min(now, a.lastSeenAt + (vs.heartbeatMinutes + 1) * 60_000);
        this.ledger.finalizeActive('server_watchdog', end);
        this.setSecret(SERVER_KEY_SECRET, null);
        this.notify('GPU instance ended', `Instance #${a.instanceId} was destroyed while the app was closed (server watchdog).`, 'info');
      } else {
        this.active = a;
        for (const [k, v] of Object.entries(a.hostKeys ?? {})) this.hostKeys.set(k, v);
        this.serverApiKey = this.secret(SERVER_KEY_SECRET);
        this.target = { profileId: a.profileId, modelId: a.modelId };
        this.startBillingTimers();
        this.setPhase(inst && instanceIsRunning(inst) ? 'connecting' : 'renting', `Reconnecting to GPU instance #${a.instanceId}…`);
        const known = inst ?? null;
        this.runJob('adopt', (signal) => this.adopt(a.instanceId, known, signal));
      }
    }

    const parked = this.ledger.parked;
    if (parked && instances) {
      const pinst = instances.find((i) => i.id === parked.instanceId);
      if (!pinst || instanceIsGone(pinst)) {
        this.ledger.closeParked(now, 'orphan_cleanup');
      } else if (now - parked.parkedAt > Math.max(0, vs.parkMaxDays) * 86_400_000) {
        await this.destroyParked('orphan_cleanup');
        this.notify('Parked GPU destroyed', `Parked instance #${parked.instanceId} was older than ${vs.parkMaxDays} days and was destroyed.`, 'info');
      }
    }

    if (instances) {
      const pending = new Set(this.ledger.pendingDestroy);
      const keep = new Set([this.active?.instanceId, this.ledger.parked?.instanceId]);
      this.orphanIds = instances.filter((i) => !keep.has(i.id) && !pending.has(i.id) && !instanceIsGone(i)).map((i) => i.id);
      if (this.orphanIds.length) {
        this.notify('Untracked GPU instances', `${this.orphanIds.length} Vast.ai instance(s) labelled "${APP_LABEL}" are still running. Open the GPU view to destroy them.`, 'warning');
      }
    }
    void this.refreshCredit();
    this.creditTimer = setInterval(() => void this.refreshCredit(), this.t.creditRefreshMs);
    this.creditTimer.unref?.();
    this.emit();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const job = this.job;
    if (job) {
      job.abort.abort();
      await Promise.race([job.promise.catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    }
    if (this.active) this.ledger.updateActive({ lastSeenAt: this.now(), hostKeys: Object.fromEntries(this.hostKeys) });
    this.stopHeartbeat();
    this.stopBillingTimers();
    if (this.destroyRetryTimer) clearInterval(this.destroyRetryTimer);
    this.destroyRetryTimer = null;
    if (this.creditTimer) clearInterval(this.creditTimer);
    this.creditTimer = null;
    await this.closeTunnel();
    this.closeSsh();
    this.resolveWaiters(false);
  }

  // ───────────────────────────── jobs ─────────────────────────────

  private runJob(kind: 'clockIn' | 'adopt' | 'switch', fn: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    const promise = (async () => {
      try {
        await fn(abort.signal);
      } catch (err) {
        if (abort.signal.aborted || err instanceof AbortedError || this.disposed) return; // clockOut/dispose own the cleanup
        await this.failAndTeardown(err);
      } finally {
        if (this.job?.abort === abort) this.job = null;
      }
    })();
    this.job = { kind, abort, promise };
  }

  private async failAndTeardown(err: unknown): Promise<void> {
    const msg = errMsg(err);
    if (this.phase !== 'stopping' && this.phase !== 'off' && this.phase !== 'error') this.failedStep = this.phase === 'switching' ? 'downloading' : this.phase;
    await this.teardown('error', { error: msg });
  }

  private assertBudgetHeadroom(): void {
    const vs = this.vastSettings();
    if (!(vs.monthlyBudget > 0)) throw new Error('Set a monthly GPU budget in Settings > Vast.ai before clocking in.');
    const month = this.monthCost();
    if (month >= vs.monthlyBudget) {
      throw new Error(`Monthly GPU budget reached: $${month.toFixed(2)} of $${vs.monthlyBudget.toFixed(2)} spent this month.`);
    }
  }

  private fitsBudget(model: CatalogModel, o: VastRawOffer): boolean {
    const vs = this.vastSettings();
    const warm = estimateWarmupCost(model, Number(o.dph_total), Number(o.inet_down_cost ?? 0));
    return this.monthCost() + warm < vs.monthlyBudget;
  }

  private async clockInPipeline(profile: GpuProfile, model: CatalogModel, scripts: ServerScripts, offerId: number | undefined, signal: AbortSignal): Promise<void> {
    const appKey = ensureAppKey(this.ctx.secrets);
    this.setMessage('Registering the app SSH key on your Vast.ai account…');
    await this.vast.ensureAccountSshKey(appKey.publicKey);
    this.checkAbort(signal);

    // Parked instance: resume it when it suits this clock-in, otherwise drop it (at most one parked machine).
    const parked = this.ledger.parked;
    if (parked) {
      if (parked.profileId === profile.id && parked.totalVramGb + 0.5 >= model.minTotalVramGb && model.sizeGb + 5 <= parked.diskGb) {
        const inst = await this.resumeParked(parked, signal);
        if (inst) {
          await this.bringUp(inst, model, scripts, signal);
          return;
        }
      } else {
        this.setMessage('Destroying the parked instance (different profile)…');
        await this.destroyParked('clock_out');
      }
    }
    this.checkAbort(signal);

    const diskGb = diskGbFor(model, profile.minDiskGb);
    this.setPhase('searching', `Searching ${profile.label} offers (≤ $${profile.maxPricePerHour.toFixed(2)}/h)…`);
    const offers = await this.findOffers(profile, model, diskGb, offerId, signal);
    if (offers.length === 0) {
      throw new Error(`No ${profile.label} GPU offers are available under $${profile.maxPricePerHour.toFixed(2)}/h right now. Try again later or raise the profile's price cap.`);
    }
    const affordable = offers.filter((o) => this.fitsBudget(model, o));
    if (affordable.length === 0) {
      const o = offers[0];
      throw new Error(
        `Budget: warming up ${model.label} on the cheapest offer ($${Number(o.dph_total).toFixed(2)}/h) would exceed the monthly budget ($${this.monthCost().toFixed(2)} of $${this.vastSettings().monthlyBudget.toFixed(2)} spent).`,
      );
    }

    let bootFailures = 0;
    let createFailures = 0;
    let lastErr: unknown = null;
    for (const offer of affordable) {
      if (bootFailures >= 2 || createFailures >= 4) break;
      this.checkAbort(signal);
      if (!this.fitsBudget(model, offer)) continue;
      const r = await this.rentAndBoot(offer, profile, model, diskGb, scripts, signal);
      if (r.kind === 'ok') {
        await this.bringUp(r.inst, model, scripts, signal);
        return;
      }
      lastErr = r.err;
      if (r.kind === 'create_failed') createFailures++;
      else bootFailures++;
    }
    throw new Error(`Could not rent a working GPU: ${errMsg(lastErr ?? 'no offer could be rented')}`);
  }

  private async findOffers(profile: GpuProfile, model: CatalogModel, diskGb: number, offerId: number | undefined, signal: AbortSignal): Promise<VastRawOffer[]> {
    const ok = (o: VastRawOffer) => Number(o.dph_total) > 0 && Number(o.dph_total) <= profile.maxPricePerHour && offerTotalVramGb(o) >= model.minTotalVramGb;
    let raw = (await this.vast.searchOffers(buildOfferQuery(profile, { diskGb, limit: 20 }), signal)).filter(ok);
    raw.sort((a, b) => a.dph_total - b.dph_total);
    if (offerId !== undefined) {
      let explicit = raw.find((o) => o.id === offerId);
      if (!explicit) {
        const r2 = await this.vast.searchOffers(buildOfferQuery(profile, { diskGb, limit: 5, offerId }), signal);
        explicit = r2.filter(ok).find((o) => o.id === offerId);
      }
      if (!explicit) throw new Error(`Offer #${offerId} is no longer available or does not match the ${profile.label} profile.`);
      raw = [explicit, ...raw.filter((o) => o.id !== offerId)];
    }
    return raw;
  }

  private async rentAndBoot(
    offer: VastRawOffer,
    profile: GpuProfile,
    model: CatalogModel,
    diskGb: number,
    scripts: ServerScripts,
    signal: AbortSignal,
  ): Promise<{ kind: 'ok'; inst: VastInstance } | { kind: 'create_failed' | 'boot_failed'; err: unknown }> {
    const vs = this.vastSettings();
    const price = Number(offer.dph_total);
    this.setPhase('renting', `Renting ${offer.num_gpus}x ${offer.gpu_name} for $${price.toFixed(3)}/h…`);
    const apiKey = randomBytes(32).toString('hex');
    const nonce = randomBytes(8).toString('hex');
    const env = buildInstanceEnv({
      modelId: model.id,
      apiKey,
      idleMinutes: vs.idleMinutes,
      heartbeatMinutes: vs.heartbeatMinutes,
      maxSessionHours: vs.maxSessionHours,
      bootMaxMinutes: bootMaxMinutesFor(model),
      nonce,
      bootstrap: scripts.bootstrap,
      configSh: renderConfigSh(CATALOG, vs.extraLlamaArgs),
    });
    const attemptStart = this.now();
    let created: { instanceId: number };
    try {
      created = await this.vast.createInstance(offer.id, {
        image: vs.image,
        disk: diskGb,
        label: APP_LABEL,
        runtype: 'ssh_direc ssh_proxy',
        onstart: scripts.onstart,
        env,
        cancel_unavail: true,
      });
    } catch (err) {
      if (err instanceof VastError && err.isAuth) throw err;
      if (err instanceof VastError && err.ambiguous) await this.reconcileAmbiguousCreate(nonce, attemptStart, offer, profile, model);
      this.setMessage(`Offer #${offer.id} could not be rented (${errMsg(err)}); trying the next one…`);
      return { kind: 'create_failed', err };
    }

    // ── Track IMMEDIATELY (money safety invariant 1) ──
    const now = this.now();
    const storagePerHour = (Number(offer.storage_cost ?? 0) * diskGb) / 720;
    this.active = {
      recordId: randomUUID(),
      instanceId: created.instanceId,
      profileId: profile.id,
      modelId: model.id,
      gpuName: String(offer.gpu_name),
      numGpus: Number(offer.num_gpus) || 1,
      totalVramGb: offerTotalVramGb(offer),
      pricePerHour: price,
      inetDownCostPerGb: Number(offer.inet_down_cost ?? 0),
      storageCostPerHour: round4(storagePerHour),
      diskGb,
      location: String(offer.geolocation ?? ''),
      startedAt: now,
      bandwidthUsd: round4(model.sizeGb * Number(offer.inet_down_cost ?? 0)),
      lastSeenAt: now,
      reachedReady: false,
      nonce,
    };
    this.ledger.beginSession(this.active);
    this.serverApiKey = apiKey;
    this.setSecret(SERVER_KEY_SECRET, apiKey);
    this.hostKeys.clear();
    this.startBillingTimers();
    this.setPhase('renting', `Instance #${created.instanceId} rented (${offer.gpu_name}, $${price.toFixed(3)}/h). Waiting for it to boot…`);
    const appKey = ensureAppKey(this.ctx.secrets);
    void this.vast.attachSshKey(created.instanceId, appKey.publicKey).catch(() => undefined);
    this.checkAbort(signal);

    try {
      const inst = await this.waitRunning(created.instanceId, signal, this.t.bootTimeoutMs);
      return { kind: 'ok', inst };
    } catch (err) {
      if (signal.aborted || err instanceof AbortedError) throw err;
      if (err instanceof BootError) {
        this.setMessage(`${errMsg(err)} Destroying it and trying another offer…`);
        await this.destroyActive('error');
        return { kind: 'boot_failed', err };
      }
      throw err;
    }
  }

  /** After a create whose outcome is unknown: destroy any instance that this attempt may have created. */
  private async reconcileAmbiguousCreate(nonce: string, sinceMs: number, offer: VastRawOffer, profile: GpuProfile, model: CatalogModel): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.sleep(this.t.pollIntervalMs);
      let list: VastInstance[];
      try {
        list = await this.vast.listInstances(APP_LABEL);
      } catch {
        continue;
      }
      const known = new Set<number | undefined>([this.active?.instanceId, this.ledger.parked?.instanceId, ...this.orphanIds]);
      const suspects = list.filter((inst) => {
        if (known.has(inst.id) || instanceIsGone(inst)) return false;
        const env = JSON.stringify(inst.extra_env ?? inst.env ?? '');
        if (env.includes(nonce)) return true;
        return inst.start_date == null || Number(inst.start_date) * 1000 >= sinceMs - 120_000;
      });
      for (const s of suspects) {
        await this.destroyInstanceSafe(s.id);
        const end = this.now();
        this.ledger.addRecord({
          id: randomUUID(),
          instanceId: s.id,
          profileId: profile.id,
          modelId: model.id,
          gpuName: String(offer.gpu_name),
          numGpus: Number(offer.num_gpus) || 1,
          pricePerHour: Number(offer.dph_total),
          startedAt: sinceMs,
          endedAt: end,
          cost: costFor(Number(offer.dph_total), sinceMs, end),
          endReason: 'error',
        });
      }
      if (suspects.length) return;
    }
  }

  private async waitRunning(id: number, signal: AbortSignal, timeoutMs: number): Promise<VastInstance> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      this.checkAbort(signal);
      let inst: VastInstance | null | undefined;
      try {
        inst = await this.vast.getInstance(id, signal);
      } catch (err) {
        if (err instanceof VastError && err.isAuth) throw err;
        if (signal.aborted) throw new AbortedError();
        inst = undefined;
      }
      if (inst === null || (inst && instanceIsGone(inst))) throw new BootError(`Instance #${id} disappeared while booting.`);
      if (inst) {
        if (instanceIsRunning(inst) && sshTargets(inst).length > 0) return inst;
        if (instanceIsDead(inst)) throw new BootError(`Instance #${id} failed to start (${inst.actual_status ?? 'unknown'}${inst.status_msg ? `: ${inst.status_msg}` : ''}).`);
        const s = inst.actual_status ?? 'provisioning';
        this.setMessage(`Waiting for instance #${id}: ${s === 'loading' ? 'pulling the server image (not billed)' : s}…`);
      }
      if (this.now() >= deadline) throw new BootError(`Instance #${id} did not start within ${Math.round(timeoutMs / 60_000)} min.`);
      await this.sleep(this.t.pollIntervalMs, signal);
    }
  }

  private async bringUp(inst: VastInstance, model: CatalogModel, scripts: ServerScripts | null, signal: AbortSignal, connectTimeoutMs = this.t.sshConnectTimeoutMs): Promise<void> {
    this.setPhase('connecting', `Connecting to instance #${inst.id} over SSH…`);
    await this.connectSsh(inst, signal, connectTimeoutMs);
    this.startHeartbeat();
    if (!this.serverApiKey) await this.recoverServerKey();
    const finalModel = await this.waitServerReady(model, scripts, signal, false);
    this.setMessage('Opening the local tunnel…');
    await this.openTunnel();
    await this.healthCheck(signal);
    this.markReady(finalModel);
  }

  private async adopt(id: number, known: VastInstance | null, signal: AbortSignal): Promise<void> {
    let inst = known;
    if (inst && inst.intended_status === 'stopped') {
      throw new Error(`Tracked instance #${id} was found stopped (not parked by the app); destroying it.`);
    }
    if (!inst || !instanceIsRunning(inst)) inst = await this.waitRunning(id, signal, this.t.bootTimeoutMs);
    const a = this.active!;
    const model = getCatalogModel(a.modelId);
    if (!model) throw new Error(`The tracked instance runs an unknown model "${a.modelId}".`);
    let scripts: ServerScripts | null = null;
    try {
      scripts = loadServerScripts(this.opts.resourcesDir);
    } catch {
      scripts = null;
    }
    await this.bringUp(inst, model, scripts, signal, this.t.adoptConnectTimeoutMs);
  }

  private async recoverServerKey(): Promise<void> {
    try {
      const r = await this.ssh!.exec('cat /root/oc/env', { timeoutMs: 15_000 });
      const env = parseEnvFile(r.stdout);
      if (env.OC_API_KEY) {
        this.serverApiKey = env.OC_API_KEY;
        this.setSecret(SERVER_KEY_SECRET, env.OC_API_KEY);
      }
    } catch {
      /* handled below */
    }
    if (!this.serverApiKey) throw new Error('Could not recover the GPU server API key from the instance.');
  }

  private async connectSsh(inst: VastInstance, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const appKey = ensureAppKey(this.ctx.secrets);
    const conn = new SshConnection({
      privateKey: appKey.privateKey,
      readyTimeoutMs: this.t.sshReadyTimeoutMs,
      keepaliveMs: this.t.sshKeepaliveMs,
      hostKeys: this.hostKeys,
    });
    const deadline = this.now() + timeoutMs;
    let current = inst;
    let lastErr: unknown = null;
    for (;;) {
      this.checkAbort(signal);
      const targets = sshTargets(current);
      if (targets.length) {
        try {
          const t = await conn.connect(targets, signal);
          this.closeSsh();
          this.ssh = conn;
          conn.onLost = (err) => this.onSshLost(err);
          if (this.active) this.ledger.updateActive({ hostKeys: Object.fromEntries(this.hostKeys), lastSeenAt: this.now() });
          this.setMessage(`SSH connected (${t.kind} ${t.host}:${t.port}).`);
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      if (this.now() >= deadline) {
        conn.end();
        throw new Error(`Could not reach the instance over SSH within ${Math.round(timeoutMs / 60_000)} min (${errMsg(lastErr ?? 'no SSH endpoint')}).`);
      }
      this.setMessage(`Waiting for SSH on instance #${inst.id}…`);
      await this.sleep(this.t.sshRetryMs, signal);
      try {
        const fresh = await this.vast.getInstance(inst.id, signal);
        if (fresh === null || (fresh && instanceIsGone(fresh))) throw new Error(`Instance #${inst.id} disappeared.`);
        current = fresh;
      } catch (err) {
        if (signal.aborted) throw new AbortedError();
        if (errMsg(err).includes('disappeared')) throw err;
      }
    }
  }

  private onSshLost(err?: Error): void {
    if (!this.active || this.tearingDown || this.disposed) return;
    this.setMessage(`SSH connection lost${err ? ` (${err.message})` : ''}; reconnecting…`);
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = Math.min(2000, this.t.reconnectMaxMs);
    try {
      while (this.active && !this.tearingDown && !this.disposed && this.ssh && !this.ssh.isConnected()) {
        const a = this.active;
        let targets = this.ssh.target ? [this.ssh.target] : [];
        try {
          const inst = await this.vast.getInstance(a.instanceId);
          if (inst === null || (inst && instanceIsGone(inst))) {
            await this.handleInstanceGone();
            return;
          }
          if (inst) targets = sshTargets(inst);
        } catch {
          /* API unreachable: still try the last known target */
        }
        if (!this.active || this.tearingDown || this.disposed || !this.ssh) return;
        try {
          await this.ssh.connect(targets);
          this.stats.reconnects++;
          if (this.phase === 'ready' || this.job) this.setMessage(this.phase === 'ready' ? this.readyMessage() : 'SSH reconnected.');
          void this.heartbeat();
          return;
        } catch {
          /* retry */
        }
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.t.reconnectMaxMs);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private async uploadBootstrap(scripts: ServerScripts): Promise<void> {
    const ssh = this.ssh;
    if (!ssh?.isConnected()) throw new Error('SSH is not connected');
    const vs = this.vastSettings();
    const files: [string, string][] = [
      ['onstart.sh', scripts.onstart],
      ['bootstrap.sh', scripts.bootstrap],
      ['config.sh', renderConfigSh(CATALOG, vs.extraLlamaArgs)],
    ];
    for (const [name, content] of files) {
      const r = await ssh.exec(`mkdir -p /root/oc && base64 -d > /root/oc/${name}.tmp && mv -f /root/oc/${name}.tmp /root/oc/${name}`, {
        stdin: `${Buffer.from(content, 'utf8').toString('base64')}\n`,
        timeoutMs: 60_000,
      });
      if (r.code !== 0) throw new Error(`Uploading ${name} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    await ssh.exec('cd /root/oc && setsid nohup bash /root/oc/onstart.sh >/dev/null 2>&1 </dev/null &', { timeoutMs: 30_000 });
  }

  private async runSwitchCommand(modelId: string): Promise<void> {
    if (!this.ssh?.isConnected()) throw new Error('SSH is not connected');
    const r = await this.ssh.exec(`bash /root/oc/switch.sh ${shQuote(modelId)}`, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`Model switch failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }

  /**
   * Poll /root/oc/status.json until the server reports `ready` for the expected model.
   * Handles: bootstrap upload fallback, download stall/timeout, load timeout, experimental-model fallback on the same
   * instance (catalog.md §6.2) and a parked instance that still serves another model.
   */
  private async waitServerReady(model: CatalogModel, scripts: ServerScripts | null, signal: AbortSignal, switching: boolean): Promise<CatalogModel> {
    let expected = model;
    let fallbackUsed = false;
    let switchIssued = switching;
    let uploaded = false;
    let notStartedSince = this.now();
    let lastBytes = -1;
    let lastProgressAt = this.now();
    let downloadSince: number | null = null;
    let loadingSince: number | null = null;
    let sshDownSince: number | null = null;
    const downloadBudget = () => this.t.downloadBaseTimeoutMs + expected.sizeGb * this.t.downloadPerGbMs;

    for (;;) {
      this.checkAbort(signal);
      const now = this.now();
      let st: ServerStatus | null = null;
      let execOk = false;
      if (this.ssh?.isConnected()) {
        sshDownSince = null;
        try {
          const r = await this.ssh.exec('cat /root/oc/status.json', { timeoutMs: 15_000 });
          execOk = true;
          if (r.code === 0) st = parseServerStatus(r.stdout);
        } catch {
          execOk = false;
        }
      } else {
        sshDownSince ??= now;
        if (now - sshDownSince > this.t.sshConnectTimeoutMs) throw new Error('Lost the SSH connection to the instance and could not reconnect.');
      }
      this.checkAbort(signal);

      if (execOk && (!st || st.phase === 'starting')) {
        // Bootstrap not running (yet). After a while, upload it over SSH once (env decoding may have failed).
        if (now - notStartedSince > this.t.bootstrapStartTimeoutMs) {
          if (!uploaded && scripts) {
            this.setMessage('Server bootstrap did not start; uploading it over SSH…');
            await this.uploadBootstrap(scripts);
            uploaded = true;
            notStartedSince = this.now();
          } else {
            throw new Error('The server bootstrap did not start on the instance (see the server log).');
          }
        } else {
          this.setPhase(switching ? 'switching' : 'connecting', 'Waiting for the server bootstrap to start…');
        }
      } else if (st) {
        notStartedSince = now;
        switch (st.phase) {
          case 'downloading':
          case 'switching': {
            downloadSince ??= now;
            loadingSince = null;
            if (st.bytesDone > lastBytes) {
              lastBytes = st.bytesDone;
              lastProgressAt = now;
            }
            const msg = st.message || `Downloading ${expected.label}…`;
            this.setPhase(switching ? 'switching' : 'downloading', msg, Math.max(0, Math.min(1, st.progress)));
            if (now - lastProgressAt > this.t.downloadStallMs) throw new Error(`The model download stalled (no progress for ${Math.round(this.t.downloadStallMs / 60_000)} min).`);
            if (now - downloadSince > downloadBudget()) throw new Error(`The model download took longer than ${Math.round(downloadBudget() / 60_000)} min.`);
            break;
          }
          case 'loading': {
            loadingSince ??= now;
            this.setPhase(switching ? 'switching' : 'loading', st.message || `Loading ${expected.label}…`, switching ? 1 : undefined);
            if (now - loadingSince > this.t.loadTimeoutMs) throw new Error(`Loading ${expected.label} took longer than ${Math.round(this.t.loadTimeoutMs / 60_000)} min.`);
            break;
          }
          case 'ready': {
            if (!st.modelId || st.modelId === expected.id) return expected;
            if (!switchIssued) {
              // e.g. a resumed parked instance serving another model
              this.setMessage(`Server is running ${st.modelId}; switching to ${expected.label}…`);
              await this.runSwitchCommand(expected.id);
              switchIssued = true;
              const a = this.active;
              if (a) {
                a.modelId = expected.id;
                a.bandwidthUsd = round4(a.bandwidthUsd + expected.sizeGb * a.inetDownCostPerGb);
                this.ledger.updateActive({ modelId: a.modelId, bandwidthUsd: a.bandwidthUsd });
              }
            }
            break;
          }
          case 'error': {
            const fb = !fallbackUsed && this.active ? experimentalFallback(expected.id, this.active.totalVramGb) : undefined;
            if (fb && !/watchdog/i.test(st.message)) {
              this.notify('Experimental model failed', `${expected.label} failed to load (${st.message}). Falling back to ${fb.label} on the same GPU.`, 'warning');
              this.setPhase(switching ? 'switching' : 'downloading', `${expected.label} failed; falling back to ${fb.label}…`, 0);
              await this.runSwitchCommand(fb.id);
              fallbackUsed = true;
              switchIssued = true;
              expected = fb;
              this.target = { profileId: this.target?.profileId ?? this.active!.profileId, modelId: fb.id };
              const a = this.active!;
              a.modelId = fb.id;
              a.bandwidthUsd = round4(a.bandwidthUsd + fb.sizeGb * a.inetDownCostPerGb);
              this.ledger.updateActive({ modelId: a.modelId, bandwidthUsd: a.bandwidthUsd });
              lastBytes = -1;
              lastProgressAt = this.now();
              downloadSince = null;
              loadingSince = null;
              break;
            }
            throw new Error(`GPU server error: ${st.message || 'unknown error'}`);
          }
          default:
            this.setMessage(st.message || `Server: ${st.phase}`);
        }
      }
      await this.sleep(this.t.statusPollMs, signal);
    }
  }

  private async openTunnel(): Promise<void> {
    if (!this.tunnel) this.tunnel = new LocalTunnel(() => this.ssh, '127.0.0.1', 8080);
    const port = await this.tunnel.listen(this.vastSettings().localPort);
    this.endpointUrl = `http://127.0.0.1:${port}`;
  }

  private async healthCheck(signal: AbortSignal): Promise<void> {
    const key = this.serverApiKey;
    if (!key || !this.tunnel) throw new Error('Health check impossible: no tunnel or server key.');
    const url = `http://127.0.0.1:${this.tunnel.port}/v1/models`;
    const deadline = this.now() + this.t.healthTimeoutMs;
    let last = '';
    for (;;) {
      this.checkAbort(signal);
      try {
        const r = await httpGetStatus(url, key, 10_000);
        if (r.status === 200) return;
        if (r.status === 401 || r.status === 403) throw new Error(`The GPU server rejected the API key (HTTP ${r.status}).`);
        last = `HTTP ${r.status}`;
      } catch (err) {
        if (/rejected the API key/.test(errMsg(err))) throw err;
        last = errMsg(err);
      }
      if (this.now() >= deadline) throw new Error(`Health check of /v1/models through the tunnel failed (${last}).`);
      await this.sleep(Math.min(2000, this.t.statusPollMs), signal);
    }
  }

  private readyMessage(): string {
    const a = this.active;
    const m = a ? getCatalogModel(a.modelId) : undefined;
    return `Ready: ${m?.label ?? a?.modelId ?? 'model'} on ${a?.numGpus ?? 1}x ${a?.gpuName ?? 'GPU'}`;
  }

  private markReady(model: CatalogModel): void {
    const a = this.active;
    if (!a) return;
    const now = this.now();
    a.modelId = model.id;
    a.readyAt = a.readyAt ?? now;
    a.reachedReady = true;
    a.lastSeenAt = now;
    this.ledger.updateActive({ modelId: a.modelId, readyAt: a.readyAt, reachedReady: true, lastSeenAt: now });
    this.target = { profileId: a.profileId, modelId: model.id };
    this.failedStep = undefined;
    this.setPhase('ready', this.readyMessage(), 1);
    this.notify('GPU ready', `${model.label} is serving on ${a.numGpus}x ${a.gpuName} ($${a.pricePerHour.toFixed(2)}/h).`, 'success');
  }

  // ───────────────────────────── heartbeat / billing ─────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.hbFailures = 0;
    void this.heartbeat();
    this.hbTimer = setInterval(() => void this.heartbeat(), this.t.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  private async heartbeat(): Promise<void> {
    if (!this.active || this.tearingDown || this.disposed) return;
    const ssh = this.ssh;
    if (!ssh?.isConnected()) {
      this.hbFailures++;
      this.stats.heartbeatFailures++;
      if (this.hbFailures >= 2) void this.verifyInstanceAlive();
      return;
    }
    try {
      const r = await ssh.exec(`touch /root/oc/heartbeat && echo ${HB_MARK}; cat /root/oc/status.json 2>/dev/null`, { timeoutMs: 20_000 });
      if (!r.stdout.startsWith(HB_MARK)) throw new Error(r.stderr || `heartbeat touch failed (exit ${r.code})`);
      this.hbFailures = 0;
      this.stats.heartbeats++;
      if (this.active) {
        this.active.lastSeenAt = this.now();
      }
      const st = parseServerStatus(r.stdout.slice(HB_MARK.length));
      if (st && !this.job) this.onRuntimeStatus(st);
    } catch {
      this.hbFailures++;
      this.stats.heartbeatFailures++;
      if (this.hbFailures >= 2) void this.verifyInstanceAlive();
    }
  }

  private onRuntimeStatus(st: ServerStatus): void {
    if (!this.active || this.tearingDown) return;
    if (this.phase !== 'ready' && this.phase !== 'loading') return;
    if (st.phase === 'error') {
      this.lastWatchdogMsg = /^Watchdog:/.test(st.message) ? st.message : this.lastWatchdogMsg;
      if (/^Watchdog: no inference/.test(st.message)) {
        // The server-side idle watchdog is destroying the instance: a normal (idle) clock-out, not an error.
        void this.teardown('idle').catch(() => undefined);
      } else {
        void this.teardown('error', { error: `GPU server failed: ${st.message || 'unknown error'}` }).catch(() => undefined);
      }
    } else if (st.phase === 'loading' && this.phase === 'ready') {
      this.setPhase('loading', 'llama-server restarted; reloading the model…');
    } else if (st.phase === 'ready' && this.phase === 'loading') {
      const m = getCatalogModel(this.active.modelId);
      if (m) this.markReady(m);
    }
  }

  private async verifyInstanceAlive(): Promise<void> {
    const a = this.active;
    if (!a || this.now() - this.lastAliveCheck < 20_000) return;
    this.lastAliveCheck = this.now();
    try {
      const inst = await this.vast.getInstance(a.instanceId);
      if (inst === null || (inst && instanceIsGone(inst))) await this.handleInstanceGone();
    } catch {
      /* API unreachable; keep trying on the next heartbeat */
    }
  }

  /** The instance vanished under us (server watchdog / Vast). Close the books; nothing left to destroy. */
  private async handleInstanceGone(): Promise<void> {
    const a = this.active;
    if (!a || this.tearingDown) return;
    const job = this.job;
    if (job) job.abort.abort();
    this.stopHeartbeat();
    await this.closeTunnel();
    this.closeSsh();
    const idle = /no inference/.test(this.lastWatchdogMsg ?? '');
    // Upper bound for when it died: the server watchdog fires at most heartbeatMinutes after the last heartbeat we saw
    // (e.g. the PC slept), so do not bill the time after that.
    const hbWindow = (this.vastSettings().heartbeatMinutes + 1) * 60_000;
    this.ledger.finalizeActive(idle ? 'idle' : 'server_watchdog', Math.min(this.now(), a.lastSeenAt + hbWindow));
    this.setSecret(SERVER_KEY_SECRET, null);
    this.serverApiKey = null;
    this.active = null;
    this.stopBillingTimers();
    this.endpointUrl = undefined;
    this.failedStep = undefined;
    if (idle) {
      this.lastError = undefined;
      this.setPhase('off', `Clocked out: the GPU was idle (${this.lastWatchdogMsg}).`);
      this.notify('GPU clocked out (idle)', `Instance #${a.instanceId} destroyed itself after no inference. Billing has stopped.`, 'info');
    } else {
      this.lastError = `GPU instance #${a.instanceId} is gone (destroyed by its server-side watchdog or by Vast.ai). Billing has stopped.`;
      this.setPhase('error', this.lastError);
      this.notify('GPU instance gone', this.lastError, 'warning');
    }
    this.lastWatchdogMsg = undefined;
  }

  private startBillingTimers(): void {
    if (this.disposed) return;
    this.stopBillingTimers();
    this.tickTimer = setInterval(() => this.tick(), this.t.tickMs);
    this.persistTimer = setInterval(() => {
      if (this.active) this.ledger.updateActive({ lastSeenAt: this.active.lastSeenAt });
    }, this.t.persistMs);
  }

  private stopBillingTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.tickTimer = null;
    this.persistTimer = null;
  }

  private tick(): void {
    const a = this.active;
    if (!a) return;
    const now = this.now();
    const vs = this.vastSettings();
    if (!this.autoStopping && !this.tearingDown) {
      const month = this.monthCost(now);
      if (month >= vs.monthlyBudget) {
        this.autoStopping = true;
        this.notify('GPU budget reached', `Monthly GPU spend reached $${month.toFixed(2)} of $${vs.monthlyBudget.toFixed(2)}. Clocking out.`, 'warning');
        void this.clockOut('budget').catch(() => undefined);
      } else if (vs.maxSessionHours > 0 && now - a.startedAt >= vs.maxSessionHours * 3_600_000) {
        this.autoStopping = true;
        this.notify('GPU session limit', `The GPU session reached ${vs.maxSessionHours} h. Clocking out.`, 'warning');
        void this.clockOut('max_hours').catch(() => undefined);
      }
    }
    this.emit();
  }

  // ───────────────────────────── teardown / destroy / park ─────────────────────────────

  private async teardown(reason: EndReason, opts: { error?: string } = {}): Promise<void> {
    if (this.tearingDown) return this.tearingDown;
    const p = (async () => {
      const a = this.active;
      this.setPhase('stopping', a ? `Stopping GPU instance #${a.instanceId}…` : 'Stopping…');
      this.stopHeartbeat();
      if (opts.error && this.ssh?.isConnected()) {
        try {
          const r = await this.ssh.exec('tail -n 200 /root/oc/server.log /root/oc/watchdog.log 2>/dev/null', { timeoutMs: 5000 });
          this.lastServerLog = r.stdout;
        } catch {
          /* ignore */
        }
      }
      await this.closeTunnel();
      this.closeSsh();
      let destroyFailed: number | null = null;
      let parked = false;
      if (a) {
        const vs = this.vastSettings();
        const canPark = (reason === 'clock_out' || reason === 'app_quit') && vs.clockOutMode === 'park' && a.reachedReady && !opts.error;
        // Persist the intent first: if the process dies mid-teardown, start() completes it instead of adopting.
        this.ledger.updateActive({ stopping: reason, parkIntent: canPark, lastSeenAt: this.now() });
        if (canPark) parked = await this.parkActive(a);
        if (!parked) {
          const ok = await this.destroyInstanceSafe(a.instanceId);
          if (!ok) destroyFailed = a.instanceId;
        }
        this.ledger.finalizeActive(reason, this.now());
        if (!parked) this.setSecret(SERVER_KEY_SECRET, null);
        this.serverApiKey = null;
        this.active = null;
      }
      this.stopBillingTimers();
      this.endpointUrl = undefined;
      this.autoStopping = false;
      if (destroyFailed !== null) {
        if (!this.orphanIds.includes(destroyFailed)) this.orphanIds.push(destroyFailed);
        this.lastError = `Could not confirm that instance #${destroyFailed} was destroyed. Retrying in the background; please check console.vast.ai.${opts.error ? ` (Original error: ${opts.error})` : ''}`;
        this.setPhase('error', this.lastError);
        this.notify('GPU destroy not confirmed', this.lastError, 'error');
      } else if (opts.error) {
        this.lastError = opts.error;
        this.setPhase('error', `Clock-in failed: ${opts.error}`);
        this.notify('GPU error', `${opts.error}${a ? ` Instance #${a.instanceId} was destroyed.` : ''}`, 'error');
      } else {
        this.lastError = undefined;
        this.failedStep = undefined;
        const msg = parked
          ? `Clocked out; instance parked (storage ~$${(this.ledger.parked?.storageCostPerHour ?? 0).toFixed(3)}/h).`
          : reason === 'budget'
            ? 'Clocked out: monthly budget reached.'
            : reason === 'max_hours'
              ? 'Clocked out: maximum session length reached.'
              : reason === 'idle'
                ? `Clocked out: the GPU was idle (${this.lastWatchdogMsg ?? 'idle watchdog'}).`
                : 'Clocked out.';
        this.lastWatchdogMsg = undefined;
        this.setPhase('off', msg);
        if (a && reason !== 'app_quit') this.notify('GPU clocked out', msg, 'info');
      }
    })();
    this.tearingDown = p;
    try {
      await p;
    } finally {
      this.tearingDown = null;
    }
  }

  /** Destroy the active instance without changing the phase (used when a boot attempt fails). */
  private async destroyActive(reason: EndReason): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.ledger.updateActive({ stopping: reason, lastSeenAt: this.now() });
    await this.closeTunnel();
    this.closeSsh();
    const ok = await this.destroyInstanceSafe(a.instanceId);
    if (!ok && !this.orphanIds.includes(a.instanceId)) this.orphanIds.push(a.instanceId);
    this.ledger.finalizeActive(reason, this.now());
    this.setSecret(SERVER_KEY_SECRET, null);
    this.serverApiKey = null;
    this.active = null;
    this.stopBillingTimers();
  }

  /** Destroy + verify; on failure remember it in pendingDestroy and keep retrying in the background. */
  private async destroyInstanceSafe(id: number): Promise<boolean> {
    // Recorded before the DELETE goes out, so an app exit mid-destroy is finished by the next start().
    this.ledger.addPendingDestroy(id);
    let ok = false;
    try {
      ok = await this.vast.destroyInstanceVerified(id, { attempts: this.t.destroyAttempts, verifyPolls: this.t.destroyVerifyPolls });
    } catch {
      ok = false;
    }
    if (ok) {
      this.ledger.removePendingDestroy(id);
      this.orphanIds = this.orphanIds.filter((x) => x !== id);
      return true;
    }
    this.scheduleDestroyRetry(false);
    return false;
  }

  private scheduleDestroyRetry(immediate: boolean): void {
    const run = async () => {
      for (const id of this.ledger.pendingDestroy) {
        try {
          if (await this.vast.destroyInstanceVerified(id, { attempts: 1, verifyPolls: 2 })) {
            this.ledger.removePendingDestroy(id);
            this.orphanIds = this.orphanIds.filter((x) => x !== id);
            if (this.phase === 'error' && this.lastError?.includes(`#${id} was destroyed`)) {
              this.lastError = undefined;
              this.setPhase('off', `Instance #${id} destroyed (confirmed).`);
            } else this.emit();
          }
        } catch {
          /* keep it pending */
        }
      }
      if (this.ledger.pendingDestroy.length === 0 && this.destroyRetryTimer) {
        clearInterval(this.destroyRetryTimer);
        this.destroyRetryTimer = null;
      }
    };
    if (!this.destroyRetryTimer && !this.disposed) {
      this.destroyRetryTimer = setInterval(() => void run(), this.t.destroyRetryMs);
      this.destroyRetryTimer.unref?.();
    }
    if (immediate) void run();
  }

  private async parkActive(a: ActiveInstance): Promise<boolean> {
    try {
      this.setMessage(`Parking instance #${a.instanceId} (stopping it, keeping the disk)…`);
      await this.vast.stopInstance(a.instanceId);
      const deadline = this.now() + this.t.parkVerifyTimeoutMs;
      for (;;) {
        const inst = await this.vast.getInstance(a.instanceId).catch(() => undefined);
        if (inst === null) return false;
        if (inst && isStoppedState(inst)) {
          this.ledger.setParked(this.parkedFrom(a, this.now()));
          return true;
        }
        if (this.now() >= deadline) return false;
        await this.sleep(this.t.pollIntervalMs);
      }
    } catch {
      return false;
    }
  }

  private parkedFrom(a: ActiveInstance, parkedAt: number): ParkedInstance {
    return {
      instanceId: a.instanceId,
      profileId: a.profileId,
      modelId: a.modelId,
      gpuName: a.gpuName,
      storageCostPerHour: a.storageCostPerHour,
      parkedAt,
      numGpus: a.numGpus,
      totalVramGb: a.totalVramGb,
      pricePerHour: a.pricePerHour,
      inetDownCostPerGb: a.inetDownCostPerGb,
      diskGb: a.diskGb,
      location: a.location,
      hostKeys: Object.fromEntries(this.hostKeys.size ? this.hostKeys : Object.entries(a.hostKeys ?? {})),
    };
  }

  private async destroyParked(reason: EndReason): Promise<void> {
    const p = this.ledger.parked;
    if (!p) return;
    const ok = await this.destroyInstanceSafe(p.instanceId);
    if (!ok && !this.orphanIds.includes(p.instanceId)) this.orphanIds.push(p.instanceId);
    this.ledger.closeParked(this.now(), reason);
    this.setSecret(SERVER_KEY_SECRET, null);
    this.emit();
  }

  /** Start a parked instance. Returns the running instance, or null after destroying it (caller rents fresh). */
  private async resumeParked(p: ParkedInstance, signal: AbortSignal): Promise<VastInstance | null> {
    this.setPhase('renting', `Resuming parked instance #${p.instanceId} (${p.gpuName})…`);
    try {
      await this.vast.startInstance(p.instanceId);
    } catch (err) {
      if (err instanceof VastError && err.isAuth) throw err;
      this.setMessage(`Could not resume the parked instance (${errMsg(err)}); destroying it and renting a fresh one…`);
      await this.destroyParked('error');
      return null;
    }
    const now = this.now();
    this.ledger.closeParked(now, 'clock_out');
    this.active = {
      recordId: randomUUID(),
      instanceId: p.instanceId,
      profileId: p.profileId,
      modelId: p.modelId,
      gpuName: p.gpuName,
      numGpus: p.numGpus,
      totalVramGb: p.totalVramGb,
      pricePerHour: p.pricePerHour,
      inetDownCostPerGb: p.inetDownCostPerGb,
      storageCostPerHour: p.storageCostPerHour,
      diskGb: p.diskGb,
      location: p.location,
      startedAt: now,
      bandwidthUsd: 0,
      lastSeenAt: now,
      reachedReady: false,
      nonce: 'parked',
    };
    this.ledger.beginSession(this.active);
    this.hostKeys.clear();
    for (const [k, v] of Object.entries(p.hostKeys ?? {})) this.hostKeys.set(k, v);
    this.serverApiKey = this.secret(SERVER_KEY_SECRET);
    this.startBillingTimers();
    try {
      return await this.waitRunning(p.instanceId, signal, this.t.parkStartTimeoutMs);
    } catch (err) {
      if (signal.aborted || err instanceof AbortedError) throw err;
      this.setMessage(`The parked instance did not come back (${errMsg(err)}); destroying it and renting a fresh one…`);
      await this.destroyActive('error');
      return null;
    }
  }

  // ───────────────────────────── misc ─────────────────────────────

  private async closeTunnel(): Promise<void> {
    const t = this.tunnel;
    this.tunnel = null;
    if (t) await t.close().catch(() => undefined);
  }

  private closeSsh(): void {
    const s = this.ssh;
    this.ssh = null;
    if (s) {
      s.onLost = null;
      s.end();
    }
  }

  private async refreshCredit(): Promise<void> {
    if (!this.vast.hasKey() || this.disposed) return;
    try {
      const u = await this.vast.currentUser();
      if (u.creditBalance !== undefined && u.creditBalance !== this.creditBalance) {
        this.creditBalance = u.creditBalance;
        this.emit();
      }
    } catch {
      /* ignore */
    }
  }
}
