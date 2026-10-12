// GPU cost ledger (owner: gpu), persisted in ctx.kv under 'gpu-ledger'.
//
// One kv key holds everything that must survive an app crash, written on every state change:
//   * records        — GpuSessionRecord history (the active session's record is present while clocked in, without endedAt)
//   * active         — the instance currently rented (so start() can adopt it or account for it after a crash)
//   * parked         — a stopped instance kept for a fast next clock-in (storage is billed)
//   * pendingDestroy — instances whose destroy could not be verified; retried in the background and on start()

import type { KvStore } from '../contracts';
import type { GpuSessionRecord, GpuStatus } from '../../shared/types';

export const LEDGER_KV_KEY = 'gpu-ledger';
const MAX_RECORDS = 1000;

export interface ActiveInstance {
  recordId: string;
  instanceId: number;
  profileId: string;
  modelId: string;
  gpuName: string;
  numGpus: number;
  totalVramGb: number;
  pricePerHour: number;
  inetDownCostPerGb: number;
  storageCostPerHour: number;
  diskGb: number;
  location: string;
  /** Instance created (billing assumed from here — conservative). */
  startedAt: number;
  /** Estimated bandwidth charges (model downloads × inet_down_cost). */
  bandwidthUsd: number;
  /** Last time the app saw the instance alive (persisted periodically). */
  lastSeenAt: number;
  readyAt?: number;
  reachedReady: boolean;
  nonce: string;
  hostKeys?: Record<string, string>;
  /** Set when a clock-out started: if the app dies mid-teardown, start() finishes it instead of adopting. */
  stopping?: NonNullable<GpuSessionRecord['endReason']>;
  /** The interrupted clock-out intended to park (stop) rather than destroy. */
  parkIntent?: boolean;
  /** Per-instance API key returned by create (what the server watchdog needs to self-destroy); used to repair it. */
  instanceApiKey?: string;
}

export type ParkedInstance = NonNullable<GpuStatus['parked']> & {
  numGpus: number;
  totalVramGb: number;
  pricePerHour: number;
  inetDownCostPerGb: number;
  diskGb: number;
  location: string;
  hostKeys?: Record<string, string>;
  instanceApiKey?: string;
};

export interface LedgerData {
  version: 1;
  records: GpuSessionRecord[];
  active?: ActiveInstance;
  parked?: ParkedInstance;
  pendingDestroy?: number[];
}

export function costFor(pricePerHour: number, fromMs: number, toMs: number, extraUsd = 0): number {
  const hours = Math.max(0, toMs - fromMs) / 3_600_000;
  return round4(pricePerHour * hours + extraUsd);
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** [start, end) of the local calendar month containing `t`. */
export function monthBounds(t: number): [number, number] {
  const d = new Date(t);
  return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
}

/**
 * The part of a time-billed amount that falls in [ms, me): the time cost is spread over [from, to) by overlap, fixed
 * extras (bandwidth, rounding) count in the month the record started. Summed over all months it equals `total`.
 */
function costInMonth(pricePerHour: number, from: number, to: number, total: number, ms: number, me: number): number {
  const startsHere = from >= ms && from < me;
  const dur = Math.max(0, to - from);
  if (!(pricePerHour > 0) || dur === 0) return startsHere ? total : 0;
  const timeCost = Math.min(total, (pricePerHour * dur) / 3_600_000);
  const overlap = Math.max(0, Math.min(to, me) - Math.max(from, ms));
  return timeCost * (overlap / dur) + (startsHere ? total - timeCost : 0);
}

export class GpuLedger {
  private d: LedgerData;

  /** True while the last kv write failed (the in-memory state stays authoritative and is written on the next save). */
  saveFailed = false;

  constructor(
    private readonly kv: KvStore,
    private readonly onSaveError?: (err: unknown) => void,
  ) {
    this.d = GpuLedger.normalize(kv.read<unknown>(LEDGER_KV_KEY, null));
  }

  private static normalize(raw: unknown): LedgerData {
    if (Array.isArray(raw)) return { version: 1, records: raw as GpuSessionRecord[] };
    if (raw && typeof raw === 'object') {
      const r = raw as Partial<LedgerData>;
      return {
        version: 1,
        records: Array.isArray(r.records) ? r.records : [],
        active: r.active && typeof r.active.instanceId === 'number' ? r.active : undefined,
        parked: r.parked && typeof r.parked.instanceId === 'number' ? r.parked : undefined,
        pendingDestroy: Array.isArray(r.pendingDestroy) ? r.pendingDestroy.filter((n) => typeof n === 'number') : [],
      };
    }
    return { version: 1, records: [], pendingDestroy: [] };
  }

  /**
   * Persist. Never throws: a failed write (disk full, locked file) must not stop a destroy or a clock-out half way, so
   * the in-memory state stays authoritative (pendingDestroy etc. keep working) and the next save writes it all.
   */
  save(): void {
    if (this.d.records.length > MAX_RECORDS) this.d.records = this.d.records.slice(-MAX_RECORDS);
    try {
      this.kv.write(LEDGER_KV_KEY, this.d);
      this.saveFailed = false;
    } catch (err) {
      this.saveFailed = true;
      try {
        this.onSaveError?.(err);
      } catch {
        /* ignore */
      }
    }
  }

  get active(): ActiveInstance | undefined {
    return this.d.active;
  }

  get parked(): ParkedInstance | undefined {
    return this.d.parked;
  }

  get pendingDestroy(): number[] {
    return [...(this.d.pendingDestroy ?? [])];
  }

  /** Newest first. */
  records(limit?: number): GpuSessionRecord[] {
    const list = [...this.d.records].sort((a, b) => b.startedAt - a.startedAt);
    return limit && limit > 0 ? list.slice(0, limit) : list;
  }

  /**
   * Start tracking a freshly rented (or resumed) instance and open its ledger record. Persists immediately.
   * Throws (before changing anything) when another instance is still tracked: overwriting it would lose track of a
   * billed machine.
   */
  beginSession(a: ActiveInstance): void {
    const cur = this.d.active;
    if (cur && cur.instanceId !== a.instanceId) {
      throw new Error(`GPU instance #${cur.instanceId} is still tracked; refusing to track #${a.instanceId} over it.`);
    }
    this.d.active = a;
    this.d.records.push({
      id: a.recordId,
      instanceId: a.instanceId,
      profileId: a.profileId,
      modelId: a.modelId,
      gpuName: a.gpuName,
      numGpus: a.numGpus,
      pricePerHour: a.pricePerHour,
      startedAt: a.startedAt,
      cost: round4(a.bandwidthUsd),
    });
    this.save();
  }

  updateActive(patch: Partial<ActiveInstance>, persist = true): void {
    if (!this.d.active) return;
    Object.assign(this.d.active, patch);
    const rec = this.d.records.find((r) => r.id === this.d.active!.recordId);
    if (rec) {
      rec.modelId = this.d.active.modelId;
      rec.cost = this.activeCost(this.d.active.lastSeenAt);
    }
    if (persist) this.save();
  }

  activeCost(now: number): number {
    const a = this.d.active;
    if (!a) return 0;
    return costFor(a.pricePerHour, a.startedAt, now, a.bandwidthUsd);
  }

  /** Close the active record. Returns it (or undefined when nothing was active). */
  finalizeActive(endReason: NonNullable<GpuSessionRecord['endReason']>, endedAt: number): GpuSessionRecord | undefined {
    const a = this.d.active;
    if (!a) return undefined;
    const end = Math.max(endedAt, a.startedAt);
    let rec = this.d.records.find((r) => r.id === a.recordId);
    if (!rec) {
      rec = { id: a.recordId, instanceId: a.instanceId, profileId: a.profileId, modelId: a.modelId, gpuName: a.gpuName, numGpus: a.numGpus, pricePerHour: a.pricePerHour, startedAt: a.startedAt, cost: 0 };
      this.d.records.push(rec);
    }
    rec.modelId = a.modelId;
    rec.endedAt = end;
    rec.cost = costFor(a.pricePerHour, a.startedAt, end, a.bandwidthUsd);
    rec.endReason = endReason;
    this.d.active = undefined;
    this.save();
    return rec;
  }

  /** Append a finished record (e.g. an instance destroyed during ambiguous-create reconciliation). */
  addRecord(r: GpuSessionRecord): void {
    this.d.records.push(r);
    this.save();
  }

  setParked(p: ParkedInstance | undefined): void {
    this.d.parked = p;
    this.save();
  }

  /** Close a parking period: storage cost record from parkedAt to now. */
  closeParked(endedAt: number, endReason: NonNullable<GpuSessionRecord['endReason']>): GpuSessionRecord | undefined {
    const p = this.d.parked;
    if (!p) return undefined;
    const rec: GpuSessionRecord = {
      id: `park-${p.instanceId}-${p.parkedAt}`,
      instanceId: p.instanceId,
      profileId: p.profileId,
      modelId: p.modelId,
      gpuName: `${p.gpuName} (parked storage)`,
      numGpus: 0,
      pricePerHour: p.storageCostPerHour,
      startedAt: p.parkedAt,
      endedAt: Math.max(endedAt, p.parkedAt),
      cost: costFor(p.storageCostPerHour, p.parkedAt, endedAt),
      endReason,
    };
    this.d.records.push(rec);
    this.d.parked = undefined;
    this.save();
    return rec;
  }

  parkedCost(now: number): number {
    const p = this.d.parked;
    return p ? costFor(p.storageCostPerHour, p.parkedAt, now) : 0;
  }

  addPendingDestroy(id: number): void {
    const s = new Set(this.d.pendingDestroy ?? []);
    s.add(id);
    this.d.pendingDestroy = [...s];
    this.save();
  }

  removePendingDestroy(id: number): void {
    this.d.pendingDestroy = (this.d.pendingDestroy ?? []).filter((x) => x !== id);
    this.save();
  }

  /** Close a dangling (unfinished) record for an instance that is not the active one, e.g. orphan cleanup. */
  closeDanglingRecord(instanceId: number, endedAt: number, endReason: NonNullable<GpuSessionRecord['endReason']>): void {
    let changed = false;
    for (const r of this.d.records) {
      if (r.instanceId === instanceId && r.endedAt === undefined && r.id !== this.d.active?.recordId) {
        r.endedAt = Math.max(endedAt, r.startedAt);
        r.cost = costFor(r.pricePerHour, r.startedAt, r.endedAt, 0) > r.cost ? costFor(r.pricePerHour, r.startedAt, r.endedAt, 0) : r.cost;
        r.endReason = endReason;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * Spend this calendar month (local time): finished records + the live active session (to `now`) + live parked
   * storage. Time-billed costs are split across months by overlap (a session from Oct 31 20:00 to Nov 1 02:00 puts
   * 2 h in November), so the figure does not jump when a session that crossed midnight ends.
   */
  monthCost(now: number): number {
    const [ms, me] = monthBounds(now);
    const activeId = this.d.active?.recordId;
    let sum = 0;
    for (const r of this.d.records) {
      if (r.id === activeId) continue;
      const cost = r.cost || 0;
      if (r.endedAt === undefined) {
        if (r.startedAt >= ms && r.startedAt < me) sum += cost;
        continue;
      }
      sum += costInMonth(r.pricePerHour, r.startedAt, r.endedAt, cost, ms, me);
    }
    const a = this.d.active;
    if (a) sum += costInMonth(a.pricePerHour, a.startedAt, Math.max(now, a.startedAt), this.activeCost(now), ms, me);
    const p = this.d.parked;
    if (p) sum += costInMonth(p.storageCostPerHour, p.parkedAt, Math.max(now, p.parkedAt), this.parkedCost(now), ms, me);
    return round4(sum);
  }
}
