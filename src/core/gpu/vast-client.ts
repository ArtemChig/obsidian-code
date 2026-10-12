// Vast.ai REST client (owner: gpu). Endpoints and payloads verified in docs/research/vast-api.md.
//
// Money-safety notes:
//   * createInstance is NOT retried on 5xx/network errors (a retry could rent a second machine); only on 429,
//     which Vast returns before doing any work. Callers treat an ambiguous create failure by reconciling the
//     labelled instance list (see GpuManager).
//   * destroyInstance treats 404 as "already gone"; destroyInstanceVerified re-issues DELETE until a GET confirms.
//   * The account API key is only ever sent to the configured Vast base URL (never to log result URLs).

import type { GpuOffer, GpuProfile } from '../../shared/types';

export const VAST_DEFAULT_BASE_URL = 'https://console.vast.ai';
export const APP_LABEL = 'obsidian-code';

// ───────────────────────────── Raw API shapes ─────────────────────────────

export interface VastRawOffer {
  id: number;
  ask_contract_id?: number;
  machine_id?: number;
  gpu_name: string;
  num_gpus: number;
  /** MiB per GPU */
  gpu_ram: number;
  gpu_total_ram?: number;
  /** MiB */
  cpu_ram: number;
  disk_space: number;
  inet_down: number;
  inet_down_cost?: number;
  reliability?: number;
  reliability2?: number;
  verification?: string;
  hosting_type?: number;
  dph_total: number;
  dph_base?: number;
  storage_cost?: number;
  geolocation?: string | null;
  cuda_max_good?: number;
  direct_port_count?: number;
  [k: string]: unknown;
}

export interface VastPortMapping { HostIp?: string; HostPort: string }

export interface VastInstance {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  intended_status?: string | null;
  cur_state?: string | null;
  next_state?: string | null;
  status_msg?: string | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  public_ipaddr?: string | null;
  ports?: Record<string, VastPortMapping[] | null> | null;
  dph_total?: number | null;
  storage_cost?: number | null;
  disk_space?: number | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  gpu_ram?: number | null;
  geolocation?: string | null;
  start_date?: number | null;
  image_runtype?: string | null;
  extra_env?: [string, string][] | null;
  inet_down_cost?: number | null;
  [k: string]: unknown;
}

export interface VastUser {
  id?: number;
  email?: string;
  username?: string;
  credit?: number;
  balance?: number;
  [k: string]: unknown;
}

export interface VastSshKey { id: number; key?: string; public_key?: string; ssh_key?: string; deleted_at?: unknown }

export interface CreateInstanceBody {
  image: string;
  disk: number;
  label: string;
  runtype: string;
  onstart: string;
  env: Record<string, string>;
  cancel_unavail?: boolean;
  target_state?: 'running' | 'stopped';
  client_id?: string;
}

// ───────────────────────────── Errors ─────────────────────────────

export class VastError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly vastMsg?: string;
  /** True when the request may have been processed by Vast (network error / 5xx on a non-idempotent call). */
  readonly ambiguous: boolean;
  constructor(message: string, opts: { status: number; code?: string; vastMsg?: string; ambiguous?: boolean }) {
    super(message);
    this.name = 'VastError';
    this.status = opts.status;
    this.code = opts.code;
    this.vastMsg = opts.vastMsg;
    this.ambiguous = opts.ambiguous ?? false;
  }
  get isAuth(): boolean {
    return this.code === 'auth_error' || this.code === 'no_key';
  }
  get isNotFound(): boolean {
    return this.status === 404 && this.code !== 'auth_error';
  }
}

function friendlyMessage(status: number, code: string | undefined, msg: string | undefined): string {
  if (code === 'auth_error') {
    if (msg && /invalid user key/i.test(msg)) return 'Invalid Vast.ai API key (Vast says "Invalid user key"). Check Settings > Vast.ai.';
    return `Vast.ai rejected the API key${msg ? `: ${msg}` : ''}. Check the key and its permissions in Settings > Vast.ai.`;
  }
  if (status === 429) return 'Vast.ai rate limit hit (API requests too frequent). Try again in a few seconds.';
  if (status >= 500) return `Vast.ai server error (HTTP ${status})${msg ? `: ${msg}` : ''}.`;
  if (code === 'insufficient_credit' || (msg && /credit|balance/i.test(msg) && status === 400)) return `Vast.ai: ${msg ?? 'insufficient credit'}. Add credit on console.vast.ai.`;
  return `Vast.ai: ${msg || code || `HTTP ${status}`}`;
}

// ───────────────────────────── Client ─────────────────────────────

export interface VastClientOptions {
  /** Returns the account API key (ctx.secrets 'vast.apiKey'), or null when none is set. */
  apiKey: () => string | null | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for 429/502/503/504 (and network errors on idempotent calls). Default 4. */
  maxRetries?: number;
  /** First backoff delay; multiplied by 1.5 each retry. Default 2000 ms. */
  backoffMs?: number;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Spacing between destroy attempts / verification polls. Default 3000 ms. */
  destroyIntervalMs?: number;
  /** Interval for polling the log result URL. Default 300 ms. */
  logPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type RetryPolicy = 'idempotent' | 'rate-limit-only';

interface RequestOpts {
  body?: unknown;
  query?: Record<string, string>;
  auth?: 'required' | 'optional';
  retry?: RetryPolicy;
  signal?: AbortSignal;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export class VastClient {
  readonly baseUrl: string;
  private readonly opts: Required<Omit<VastClientOptions, 'baseUrl' | 'fetch' | 'apiKey' | 'sleep'>>;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKeyFn: () => string | null | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: VastClientOptions) {
    this.baseUrl = (options.baseUrl ?? VAST_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.apiKeyFn = options.apiKey;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.opts = {
      maxRetries: options.maxRetries ?? 4,
      backoffMs: options.backoffMs ?? 2000,
      timeoutMs: options.timeoutMs ?? 30_000,
      destroyIntervalMs: options.destroyIntervalMs ?? 3000,
      logPollMs: options.logPollMs ?? 300,
    };
  }

  hasKey(): boolean {
    return !!this.apiKeyFn();
  }

  private async request<T>(method: string, path: string, ro: RequestOpts = {}): Promise<T> {
    const key = this.apiKeyFn() || null;
    if (ro.auth === 'required' && !key) {
      throw new VastError('No Vast.ai API key set. Add it in Settings > Vast.ai.', { status: 0, code: 'no_key' });
    }
    let url = `${this.baseUrl}${path}`;
    if (ro.query) {
      const qs = new URLSearchParams(ro.query).toString();
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (ro.body !== undefined) headers['Content-Type'] = 'application/json';
    const policy = ro.retry ?? 'idempotent';

    let delay = this.opts.backoffMs;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const signal = ro.signal ? AbortSignal.any([ro.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
          signal,
        });
      } catch (err) {
        if (ro.signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (policy === 'idempotent' && attempt < this.opts.maxRetries) {
          await this.sleep(delay);
          delay = Math.round(delay * 1.5);
          continue;
        }
        throw new VastError(`Cannot reach Vast.ai (${msg}).`, { status: 0, code: 'network', ambiguous: policy !== 'idempotent' });
      }

      const text = await res.text().catch(() => '');
      let json: unknown = undefined;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      if (res.ok) {
        const obj = json as { success?: boolean; error?: string; msg?: string } | undefined;
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.success === false) {
          throw new VastError(friendlyMessage(res.status, obj.error, obj.msg), { status: res.status, code: obj.error, vastMsg: obj.msg });
        }
        return (json ?? {}) as T;
      }

      const retryable = res.status === 429 || (policy === 'idempotent' && RETRY_STATUSES.has(res.status));
      if (retryable && attempt < this.opts.maxRetries) {
        await this.sleep(delay);
        delay = Math.round(delay * 1.5);
        continue;
      }
      const obj = (json && typeof json === 'object' ? json : {}) as { error?: string; msg?: string; detail?: string };
      const vastMsg = obj.msg ?? obj.detail ?? (json === undefined && text ? text.slice(0, 200) : undefined);
      let code = obj.error;
      if (!code && (res.status === 401 || res.status === 403) && vastMsg && /login|key|auth/i.test(vastMsg)) code = 'auth_error';
      throw new VastError(friendlyMessage(res.status, code, vastMsg), {
        status: res.status,
        code,
        vastMsg,
        ambiguous: policy !== 'idempotent' && res.status >= 500,
      });
    }
  }

  // ── offers ──────────────────────────────────────────────────────────────

  /** POST /api/v0/bundles/ — works without a key (the key is sent when present). */
  async searchOffers(query: Record<string, unknown>, signal?: AbortSignal): Promise<VastRawOffer[]> {
    const res = await this.request<{ offers?: VastRawOffer[] }>('POST', '/api/v0/bundles/', { body: query, auth: 'optional', signal });
    return Array.isArray(res.offers) ? res.offers : [];
  }

  // ── instances ───────────────────────────────────────────────────────────

  /** PUT /api/v0/asks/{offerId}/ → the new instance id (`new_contract`). Never retried except on 429. */
  async createInstance(offerId: number, body: CreateInstanceBody): Promise<{ instanceId: number; instanceApiKey?: string }> {
    const res = await this.request<{ success?: boolean; new_contract?: number; instance_api_key?: string }>('PUT', `/api/v0/asks/${offerId}/`, {
      body: { client_id: 'me', cancel_unavail: true, ...body },
      auth: 'required',
      retry: 'rate-limit-only',
    });
    const id = Number(res.new_contract);
    if (!Number.isFinite(id) || id <= 0) {
      throw new VastError('Vast.ai did not return an instance id for the rental.', { status: 200, code: 'bad_response', ambiguous: true });
    }
    return { instanceId: id, instanceApiKey: res.instance_api_key };
  }

  /** GET /api/v0/instances/{id}/ → the instance, or null when it no longer exists. */
  async getInstance(id: number, signal?: AbortSignal): Promise<VastInstance | null> {
    try {
      const res = await this.request<{ instances?: VastInstance | VastInstance[] | null }>('GET', `/api/v0/instances/${id}/`, {
        query: { owner: 'me' },
        auth: 'required',
        signal,
      });
      const inst = res.instances;
      if (!inst) return null;
      if (Array.isArray(inst)) return inst.find((i) => i.id === id) ?? null;
      return inst;
    } catch (err) {
      if (err instanceof VastError && err.isNotFound) return null;
      throw err;
    }
  }

  /** GET /api/v1/instances/ filtered by label, following next_token pages. */
  async listInstances(label: string | null = APP_LABEL): Promise<VastInstance[]> {
    const out: VastInstance[] = [];
    let after: string | null = null;
    for (let page = 0; page < 40; page++) {
      const query: Record<string, string> = {
        order_by: JSON.stringify([{ col: 'id', dir: 'asc' }]),
        limit: '25',
        select_cols: JSON.stringify(['*']),
      };
      if (label) query.select_filters = JSON.stringify({ label: { eq: label } });
      if (after) query.after_token = after;
      const res = await this.request<{ instances?: VastInstance[]; next_token?: string | null }>('GET', '/api/v1/instances/', { query, auth: 'required' });
      const list = Array.isArray(res.instances) ? res.instances : [];
      // Defensive: only ever report instances that carry our exact label (never touch the user's other rentals),
      // even if the server ignored the filter.
      out.push(...list.filter((i) => !label || i.label === label));
      after = res.next_token ?? null;
      if (!after || list.length === 0) break;
    }
    return out;
  }

  /** DELETE /api/v0/instances/{id}/ — 404 means already gone. */
  async destroyInstance(id: number): Promise<'destroyed' | 'not_found'> {
    try {
      await this.request('DELETE', `/api/v0/instances/${id}/`, { body: {}, auth: 'required' });
      return 'destroyed';
    } catch (err) {
      if (err instanceof VastError && (err.isNotFound || err.code === 'not_found')) return 'not_found';
      throw err;
    }
  }

  /**
   * Destroy and verify with GET until the instance is gone. Re-issues DELETE on every round.
   * Returns true when verified gone, false if still present after all attempts (caller keeps retrying in background).
   */
  async destroyInstanceVerified(id: number, opts: { attempts?: number; verifyPolls?: number } = {}): Promise<boolean> {
    const attempts = opts.attempts ?? 6;
    const verifyPolls = opts.verifyPolls ?? 5;
    for (let a = 0; a < attempts; a++) {
      try {
        await this.destroyInstance(id);
      } catch (err) {
        if (err instanceof VastError && err.code === 'no_key') throw err;
        await this.sleep(this.opts.destroyIntervalMs);
        continue;
      }
      for (let p = 0; p < verifyPolls; p++) {
        try {
          const inst = await this.getInstance(id);
          if (!inst || instanceIsGone(inst)) return true;
        } catch {
          /* verification failed this round; poll again */
        }
        await this.sleep(this.opts.destroyIntervalMs);
      }
    }
    return false;
  }

  /** PUT /api/v0/instances/{id}/ {state} — stop (park) or start. */
  async setInstanceState(id: number, state: 'stopped' | 'running'): Promise<void> {
    await this.request('PUT', `/api/v0/instances/${id}/`, { body: { state }, auth: 'required' });
  }

  async stopInstance(id: number): Promise<void> {
    await this.setInstanceState(id, 'stopped');
  }

  async startInstance(id: number): Promise<void> {
    await this.setInstanceState(id, 'running');
  }

  // ── account ─────────────────────────────────────────────────────────────

  async currentUser(): Promise<VastUser & { creditBalance?: number }> {
    const u = await this.request<VastUser>('GET', '/api/v0/users/current/', { auth: 'required' });
    const credit = typeof u.credit === 'number' ? u.credit : typeof u.balance === 'number' ? u.balance : undefined;
    const { api_key: _omit, ...rest } = u as VastUser & { api_key?: unknown };
    void _omit;
    return { ...rest, creditBalance: credit };
  }

  async listSshKeys(): Promise<VastSshKey[]> {
    const res = await this.request<VastSshKey[] | { keys?: VastSshKey[]; ssh_keys?: VastSshKey[] }>('GET', '/api/v0/ssh/', { auth: 'required' });
    if (Array.isArray(res)) return res;
    return res.keys ?? res.ssh_keys ?? [];
  }

  async registerSshKey(publicKey: string): Promise<void> {
    await this.request('POST', '/api/v0/ssh/', { body: { ssh_key: publicKey }, auth: 'required' });
  }

  /** Register the app's public key on the account unless an identical key (same base64 blob) is already there. */
  async ensureAccountSshKey(publicKey: string): Promise<'present' | 'registered'> {
    const blob = publicKey.trim().split(/\s+/)[1] ?? publicKey;
    const keys = await this.listSshKeys();
    const present = keys.some((k) => !k.deleted_at && [k.key, k.public_key, k.ssh_key].some((v) => typeof v === 'string' && v.includes(blob)));
    if (present) return 'present';
    await this.registerSshKey(publicKey);
    return 'registered';
  }

  /** POST /api/v0/instances/{id}/ssh/ — belt-and-braces attach after create. */
  async attachSshKey(instanceId: number, publicKey: string): Promise<void> {
    await this.request('POST', `/api/v0/instances/${instanceId}/ssh/`, { body: { ssh_key: publicKey }, auth: 'required' });
  }

  /** Container logs via PUT /instances/request_logs/{id}/ → poll result_url (fetched WITHOUT the API key). */
  async requestLogs(instanceId: number, tail = 200): Promise<string> {
    const res = await this.request<{ result_url?: string }>('PUT', `/api/v0/instances/request_logs/${instanceId}/`, {
      body: { tail: String(tail) },
      auth: 'required',
    });
    const resultUrl = res.result_url;
    if (!resultUrl) return '';
    let parsed: URL;
    try {
      parsed = new URL(resultUrl);
    } catch {
      return '';
    }
    const sameOrigin = parsed.origin === new URL(this.baseUrl).origin;
    if (parsed.protocol !== 'https:' && !sameOrigin) return '';
    for (let i = 0; i < 30; i++) {
      try {
        const r = await this.fetchImpl(parsed.toString(), { signal: AbortSignal.timeout(this.opts.timeoutMs) });
        if (r.ok) return await r.text();
      } catch {
        /* not ready yet */
      }
      await this.sleep(this.opts.logPollMs);
    }
    return '';
  }
}

// ───────────────────────────── Helpers ─────────────────────────────

/** Fixed offer filters from SPEC §5b / vast-api.md §9, always applied. */
export const ALWAYS_OFFER_FILTERS = {
  verified: { eq: true },
  external: { eq: false },
  rentable: { eq: true },
  rented: { eq: false },
  direct_port_count: { gte: 4 },
  cuda_max_good: { gte: 12.8 },
  inet_down_cost: { lte: 0.01 },
  duration: { gte: 86400 },
} as const;

/** Build the POST /bundles/ query for a profile. GB→MB conversions use ×1000 like the CLI (conservative vs MiB). */
export function buildOfferQuery(
  profile: GpuProfile,
  opts: { diskGb: number; limit?: number; offerId?: number; maxPricePerHour?: number },
): Record<string, unknown> {
  const names = profile.gpuNames.length ? profile.gpuNames : ['RTX 5090'];
  const maxPrice = Math.min(profile.maxPricePerHour, opts.maxPricePerHour ?? Number.POSITIVE_INFINITY);
  const q: Record<string, unknown> = {
    ...ALWAYS_OFFER_FILTERS,
    gpu_name: names.length === 1 ? { eq: names[0] } : { in: names },
    num_gpus: { eq: profile.numGpus },
    gpu_ram: { gte: Math.round(profile.minGpuRamGb * 1000) },
    cpu_ram: { gte: Math.round(profile.minCpuRamGb * 1000) },
    disk_space: { gte: opts.diskGb },
    inet_down: { gte: profile.minInetDownMbps },
    reliability: { gte: profile.minReliability },
    dph_total: { lte: maxPrice },
    order: [['dph_total', 'asc']],
    type: 'on-demand',
    limit: opts.limit ?? 20,
    allocated_storage: opts.diskGb,
  };
  if (profile.datacenterOnly) q.datacenter = { eq: true };
  if (opts.offerId !== undefined) q.id = { eq: opts.offerId };
  return q;
}

/** vast-api.md §2.6 mapping. */
export function toGpuOffer(o: VastRawOffer): GpuOffer {
  return {
    offerId: Number(o.id ?? o.ask_contract_id),
    gpuName: String(o.gpu_name ?? ''),
    numGpus: Number(o.num_gpus ?? 1),
    gpuRamGb: round1(Number(o.gpu_ram ?? 0) / 1024),
    cpuRamGb: round1(Number(o.cpu_ram ?? 0) / 1024),
    diskGb: round1(Number(o.disk_space ?? 0)),
    inetDownMbps: Math.round(Number(o.inet_down ?? 0)),
    reliability: Number(o.reliability ?? o.reliability2 ?? 0),
    pricePerHour: Number(o.dph_total ?? 0),
    location: String(o.geolocation ?? ''),
    datacenter: o.hosting_type === 1,
    verified: o.verification === undefined ? true : o.verification === 'verified',
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Total GPU RAM of an offer in (decimal-ish) GB as used for catalog minTotalVramGb checks (MiB / 1000). */
export function offerTotalVramGb(o: VastRawOffer): number {
  const total = typeof o.gpu_total_ram === 'number' && o.gpu_total_ram > 0 ? o.gpu_total_ram : o.gpu_ram * o.num_gpus;
  return total / 1000;
}

export interface SshTarget { host: string; port: number; kind: 'direct' | 'proxy' }

/** SSH endpoints for an instance, direct first (vast-api.md §4.1, mirrors the CLI's _ssh_url). */
export function sshTargets(inst: VastInstance): SshTarget[] {
  const out: SshTarget[] = [];
  const direct = inst.ports?.['22/tcp']?.[0]?.HostPort;
  if (direct && inst.public_ipaddr) {
    const port = Number(direct);
    if (Number.isFinite(port) && port > 0) out.push({ host: String(inst.public_ipaddr).trim(), port, kind: 'direct' });
  }
  if (inst.ssh_host && inst.ssh_port) {
    const port = Number(inst.ssh_port) + (String(inst.image_runtype ?? '').includes('jupyter') ? 1 : 0);
    out.push({ host: String(inst.ssh_host), port, kind: 'proxy' });
  }
  return out;
}

export function instanceIsRunning(inst: VastInstance): boolean {
  return inst.actual_status === 'running';
}

export function instanceIsStopped(inst: VastInstance): boolean {
  return inst.actual_status === 'stopped' || (inst.actual_status === 'exited' && inst.intended_status === 'stopped');
}

/** Poll trap (vast-api.md §4.1): these states never become running → destroy and try another offer. */
export function instanceIsDead(inst: VastInstance): boolean {
  const s = inst.actual_status ?? '';
  if (inst.intended_status === 'stopped') return false;
  return s === 'exited' || s === 'unknown' || s === 'offline' || /error/i.test(String(inst.status_msg ?? ''));
}

export function instanceIsGone(inst: VastInstance): boolean {
  return inst.cur_state === 'destroyed' || inst.actual_status === 'destroyed' || inst.intended_status === 'destroyed';
}
