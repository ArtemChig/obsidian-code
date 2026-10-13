// Mock of the Vast.ai REST API (docs/research/vast-api.md) for unit tests (owner: gpu).
// Emulates: POST /api/v0/bundles/, PUT /api/v0/asks/{id}/, GET/PUT/DELETE /api/v0/instances/{id}/,
// GET /api/v1/instances/, GET /api/v0/users/current/, GET/POST /api/v0/ssh/, POST /api/v0/instances/{id}/ssh/,
// PUT /api/v0/instances/request_logs/{id}/ (+ the result URL), with auth errors, 429s and failure injection.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOffer {
  id: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number;
  gpu_total_ram?: number;
  cpu_ram: number;
  disk_space: number;
  inet_down: number;
  inet_down_cost: number;
  reliability: number;
  verification: string;
  hosting_type: number;
  dph_total: number;
  storage_cost: number;
  geolocation: string;
  cuda_max_good: number;
  direct_port_count: number;
}

export interface MockInstance {
  id: number;
  offerId: number;
  label: string | null;
  actual_status: string | null;
  intended_status: string;
  cur_state: string;
  status_msg: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
  public_ipaddr: string | null;
  ports: Record<string, { HostIp: string; HostPort: string }[]> | null;
  dph_total: number;
  storage_cost: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number;
  geolocation: string;
  start_date: number | null;
  image_runtype: string;
  extra_env: [string, string][];
  env: Record<string, string>;
  onstart: string;
  image: string;
  disk: number;
  runtype: string;
  attachedKeys: string[];
}

export interface ProvisionResult { host: string; port: number; proxyHost?: string; proxyPort?: number }

export interface MockVastOptions {
  apiKey?: string;
  offers?: MockOffer[];
  /** Delay between create/start and "running". */
  bootDelayMs?: number;
  /** Called when an instance becomes running (create or start). Returns the SSH endpoint for it. */
  provision?: (inst: MockInstance, reason: 'create' | 'start') => Promise<ProvisionResult> | ProvisionResult;
  /** Called when an instance is stopped or destroyed. */
  deprovision?: (inst: MockInstance, reason: 'stop' | 'destroy') => void;
}

export interface RecordedRequest { method: string; path: string; query: URLSearchParams; body: unknown; auth: string | null }

export function makeOffer(id: number, over: Partial<MockOffer> = {}): MockOffer {
  return {
    id,
    gpu_name: 'RTX 5090',
    num_gpus: 1,
    gpu_ram: 32607,
    gpu_total_ram: 32607 * (over.num_gpus ?? 1),
    cpu_ram: 64000,
    disk_space: 500,
    inet_down: 1000,
    inet_down_cost: 0.0026,
    reliability: 0.99,
    verification: 'verified',
    hosting_type: 0,
    dph_total: 0.5,
    storage_cost: 0.2,
    geolocation: 'Testland, TL',
    cuda_max_good: 13.0,
    direct_port_count: 100,
    ...over,
  };
}

function cmp(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'notin':
      return Array.isArray(expected) && !expected.includes(actual);
    default:
      return true;
  }
}

export class MockVast {
  url = '';
  readonly apiKey: string;
  offers: MockOffer[];
  readonly instances = new Map<number, MockInstance>();
  readonly requests: RecordedRequest[] = [];
  readonly sshKeys: { id: number; key: string }[] = [];
  readonly destroyed: number[] = [];
  readonly logs = new Map<number, string>();
  credit = 42.5;
  bootDelayMs: number;
  provision?: MockVastOptions['provision'];
  deprovision?: MockVastOptions['deprovision'];
  /** Failure injection. */
  readonly fail = {
    /** Next N requests (any endpoint) answer 429. */
    rateLimitNext: 0,
    /** Next N bundles requests answer 503. */
    bundles503Next: 0,
    /** Next N creates fail with this status/body (offer gone etc.). */
    createErrorTimes: 0,
    createError: { status: 404, body: { success: false, error: 'not_found', msg: 'Offer no longer available' } as unknown },
    /** Next N creates create the instance but answer 500 (ambiguous). */
    createAmbiguousTimes: 0,
    /** Instances never leave 'loading'. */
    neverBoot: false,
    /** Next N created instances go to 'exited' instead of running. */
    bootDeadTimes: 0,
    /** Next N creates (even with target_state running) leave the instance created-but-stopped (GPU just taken). */
    createStoppedTimes: 0,
    /** Next N DELETEs answer 500. */
    destroyFailTimes: 0,
    /** Next N DELETEs answer success but leave the instance alive. */
    destroyIgnoredTimes: 0,
    /** All DELETEs fail (destroy impossible). */
    destroyAlwaysFails: false,
    /** Stop requests fail. */
    stopFails: false,
    /** Start (resume) leaves the instance 'scheduling' forever. */
    startNeverRuns: false,
    /** Every instance list request answers 500. */
    listAlwaysFails: false,
    /** Delay (ms) before answering instance list requests (a slow API right after login). */
    listDelayMs: 0,
    /** Next N GET /instances/{id}/ answer {"instances": null} although the instance exists. */
    getNullTimes: 0,
    /** Every GET /instances/{id}/ answers {"instances": null} (e.g. a key of another account). */
    getAlwaysNull: false,
    /** Create answers without instance_api_key. */
    noInstanceKey: false,
    /** POST /instances/{id}/ssh/ answers success but drops the key while the instance is not running yet. */
    attachLostBeforeRunning: false,
  };
  private server: http.Server | null = null;
  private nextId = 9_000_001;
  private timers = new Set<NodeJS.Timeout>();

  constructor(opts: MockVastOptions = {}) {
    this.apiKey = opts.apiKey ?? 'test-vast-key';
    this.offers = opts.offers ?? [makeOffer(1001, { dph_total: 0.52 }), makeOffer(1002, { dph_total: 0.61 }), makeOffer(1003, { dph_total: 0.75 })];
    this.bootDelayMs = opts.bootDelayMs ?? 50;
    this.provision = opts.provision;
    this.deprovision = opts.deprovision;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        void this.handle(req, res, body).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'mock_error', msg: String(err) }));
        });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const s = this.server;
    this.server = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  liveInstances(): MockInstance[] {
    return [...this.instances.values()];
  }

  /** Add an instance directly (e.g. an orphan left by a previous app run). */
  addInstance(over: Partial<MockInstance> & { id: number }): MockInstance {
    const inst = this.newInstance(over.id, makeOffer(over.offerId ?? 1), {}, '', 'img', 50, 'ssh_direc ssh_proxy');
    Object.assign(inst, over);
    this.instances.set(inst.id, inst);
    return inst;
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private newInstance(id: number, offer: MockOffer, env: Record<string, string>, onstart: string, image: string, disk: number, runtype: string): MockInstance {
    return {
      id,
      offerId: offer.id,
      label: 'obsidian-code',
      actual_status: null,
      intended_status: 'running',
      cur_state: 'running',
      status_msg: null,
      ssh_host: null,
      ssh_port: null,
      public_ipaddr: null,
      ports: null,
      dph_total: offer.dph_total,
      storage_cost: offer.storage_cost,
      gpu_name: offer.gpu_name,
      num_gpus: offer.num_gpus,
      gpu_ram: offer.gpu_ram,
      geolocation: offer.geolocation,
      start_date: Date.now() / 1000,
      image_runtype: `ssh ${runtype}`,
      extra_env: Object.entries(env),
      env,
      onstart,
      image,
      disk,
      runtype,
      attachedKeys: [],
    };
  }

  private bootInstance(inst: MockInstance, reason: 'create' | 'start'): void {
    inst.actual_status = 'loading';
    if (this.fail.neverBoot) return;
    if (reason === 'start' && this.fail.startNeverRuns) {
      inst.actual_status = 'scheduling';
      return;
    }
    this.later(this.bootDelayMs, () => {
      if (!this.instances.has(inst.id) || inst.intended_status !== 'running') return;
      if (reason === 'create' && this.fail.bootDeadTimes > 0) {
        this.fail.bootDeadTimes--;
        inst.actual_status = 'exited';
        inst.status_msg = 'Error response from daemon: container exited';
        return;
      }
      void Promise.resolve(this.provision ? this.provision(inst, reason) : { host: '127.0.0.1', port: 1 }).then((p) => {
        if (!this.instances.has(inst.id) || inst.intended_status !== 'running') return;
        inst.public_ipaddr = p.host;
        inst.ports = { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: String(p.port) }] };
        inst.ssh_host = p.proxyHost ?? p.host;
        inst.ssh_port = p.proxyPort ?? p.port;
        inst.actual_status = 'running';
        inst.status_msg = `success, running ${inst.image}/ssh`;
      });
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, rawBody: string): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    const p = u.pathname;
    let body: unknown = undefined;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const auth = (req.headers.authorization as string | undefined) ?? null;
    this.requests.push({ method, path: p, query: u.searchParams, body, auth });

    // Log result URLs (no auth; like S3).
    const logM = /^\/logs\/(\d+)\.log$/.exec(p);
    if (logM && method === 'GET') return this.send(res, 200, this.logs.get(Number(logM[1])) ?? `log of ${logM[1]}\n`);

    if (this.fail.rateLimitNext > 0) {
      this.fail.rateLimitNext--;
      return this.send(res, 429, 'API requests too frequent endpoint threshold=2.0');
    }

    const authed = auth === `Bearer ${this.apiKey}`;
    const authError = (): void => {
      if (!auth) return this.send(res, 403, { success: false, error: 'auth_error', msg: 'This action requires login.' });
      return this.send(res, 404, { success: false, error: 'auth_error', msg: 'Invalid user key' });
    };

    // ── offers (auth optional)
    if (p === '/api/v0/bundles/' && method === 'POST') {
      if (auth && !authed) return authError();
      if (this.fail.bundles503Next > 0) {
        this.fail.bundles503Next--;
        return this.send(res, 503, { success: false, error: 'unavailable', msg: 'try later' });
      }
      const q = (body ?? {}) as Record<string, unknown>;
      const control = new Set(['order', 'limit', 'type', 'allocated_storage']);
      const mapped = (o: MockOffer, k: string): unknown => {
        if (k === 'verified') return o.verification === 'verified';
        if (k === 'rentable') return true;
        if (k === 'rented') return false;
        if (k === 'external') return false;
        if (k === 'datacenter') return o.hosting_type === 1;
        if (k === 'duration') return 10 * 86400;
        return (o as unknown as Record<string, unknown>)[k];
      };
      let list = this.offers.filter((o) =>
        Object.entries(q).every(([k, v]) => {
          if (control.has(k) || !v || typeof v !== 'object' || Array.isArray(v)) return true;
          return Object.entries(v as Record<string, unknown>).every(([op, val]) => cmp(op, mapped(o, k), val));
        }),
      );
      list = [...list].sort((a, b) => a.dph_total - b.dph_total).slice(0, Number(q.limit ?? 64));
      return this.send(res, 200, { offers: list, truncated: false });
    }

    if (!authed) return authError();

    // ── create
    const askM = /^\/api\/v0\/asks\/(\d+)\/$/.exec(p);
    if (askM && method === 'PUT') {
      const offerId = Number(askM[1]);
      if (this.fail.createErrorTimes > 0) {
        this.fail.createErrorTimes--;
        return this.send(res, this.fail.createError.status, this.fail.createError.body);
      }
      const offer = this.offers.find((o) => o.id === offerId);
      if (!offer) return this.send(res, 404, { success: false, error: 'not_found', msg: 'Offer not found', ask_id: offerId });
      const b = (body ?? {}) as { env?: Record<string, string>; onstart?: string; image?: string; disk?: number; label?: string; runtype?: string; target_state?: string };
      const id = this.nextId++;
      const inst = this.newInstance(id, offer, b.env ?? {}, b.onstart ?? '', b.image ?? '', Number(b.disk ?? 0), b.runtype ?? '');
      inst.label = b.label ?? null;
      this.instances.set(id, inst);
      this.offers = this.offers.filter((o) => o.id !== offerId);
      // Real Vast (observed 2026-10-13): without target_state 'running' the instance is created STOPPED and never boots.
      const stopped = b.target_state !== 'running' || this.fail.createStoppedTimes > 0;
      if (b.target_state === 'running' && this.fail.createStoppedTimes > 0) this.fail.createStoppedTimes--;
      if (stopped) {
        inst.intended_status = 'stopped';
        inst.cur_state = 'stopped';
        inst.actual_status = 'created';
        inst.status_msg = 'Successfully loaded img';
      } else {
        this.bootInstance(inst, 'create');
      }
      if (this.fail.createAmbiguousTimes > 0) {
        this.fail.createAmbiguousTimes--;
        return this.send(res, 500, { success: false, error: 'server_error', msg: 'Internal error' });
      }
      if (this.fail.noInstanceKey) return this.send(res, 200, { success: true, new_contract: id });
      return this.send(res, 200, { success: true, new_contract: id, instance_api_key: `ckey-${id}` });
    }

    // ── list (v1)
    if (p === '/api/v1/instances/' && method === 'GET') {
      if (this.fail.listDelayMs > 0) await new Promise((r) => setTimeout(r, this.fail.listDelayMs));
      if (this.fail.listAlwaysFails) return this.send(res, 500, { success: false, error: 'server_error', msg: 'list failed' });
      let list = this.liveInstances();
      const sf = u.searchParams.get('select_filters');
      if (sf) {
        const f = JSON.parse(sf) as Record<string, Record<string, unknown>>;
        list = list.filter((i) => Object.entries(f).every(([k, cond]) => Object.entries(cond).every(([op, v]) => cmp(op, (i as unknown as Record<string, unknown>)[k], v))));
      }
      list.sort((a, b) => a.id - b.id);
      const limit = Number(u.searchParams.get('limit') ?? 25);
      const after = Number(u.searchParams.get('after_token') ?? 0);
      const page = list.slice(after, after + limit);
      const next = after + limit < list.length ? String(after + limit) : null;
      return this.send(res, 200, { success: true, instances: page, instances_found: list.length, total_instances: list.length, next_token: next });
    }

    // ── request logs
    const logsM = /^\/api\/v0\/instances\/request_logs\/(\d+)\/$/.exec(p);
    if (logsM && method === 'PUT') {
      return this.send(res, 200, { success: true, result_url: `${this.url}/logs/${logsM[1]}.log` });
    }

    // ── attach ssh key
    const attachM = /^\/api\/v0\/instances\/(\d+)\/ssh\/$/.exec(p);
    if (attachM && method === 'POST') {
      const inst = this.instances.get(Number(attachM[1]));
      if (!inst) return this.send(res, 404, { success: false, error: 'not_found', msg: 'no such instance' });
      if (!(this.fail.attachLostBeforeRunning && inst.actual_status !== 'running')) inst.attachedKeys.push(String((body as { ssh_key?: string })?.ssh_key ?? ''));
      return this.send(res, 200, { success: true, msg: 'attached' });
    }

    // ── instance show / manage / destroy
    const instM = /^\/api\/v0\/instances\/(\d+)\/$/.exec(p);
    if (instM) {
      const id = Number(instM[1]);
      const inst = this.instances.get(id);
      if (method === 'GET') {
        if (this.fail.getAlwaysNull) return this.send(res, 200, { instances: null });
        if (this.fail.getNullTimes > 0) {
          this.fail.getNullTimes--;
          return this.send(res, 200, { instances: null });
        }
        return this.send(res, 200, { instances: inst ?? null });
      }
      if (method === 'DELETE') {
        if (!inst) return this.send(res, 404, { success: false, error: 'not_found', msg: 'Instance not found' });
        if (this.fail.destroyAlwaysFails) return this.send(res, 500, { success: false, error: 'server_error', msg: 'destroy failed' });
        if (this.fail.destroyFailTimes > 0) {
          this.fail.destroyFailTimes--;
          return this.send(res, 500, { success: false, error: 'server_error', msg: 'destroy failed' });
        }
        if (this.fail.destroyIgnoredTimes > 0) {
          this.fail.destroyIgnoredTimes--;
          return this.send(res, 200, { success: true });
        }
        this.instances.delete(id);
        this.destroyed.push(id);
        this.deprovision?.(inst, 'destroy');
        return this.send(res, 200, { success: true });
      }
      if (method === 'PUT') {
        if (!inst) return this.send(res, 404, { success: false, error: 'not_found', msg: 'Instance not found' });
        const b = (body ?? {}) as { state?: string; label?: string };
        if (b.label !== undefined) inst.label = b.label;
        if (b.state === 'stopped') {
          if (this.fail.stopFails) return this.send(res, 500, { success: false, error: 'server_error', msg: 'stop failed' });
          inst.intended_status = 'stopped';
          inst.cur_state = 'stopped';
          inst.actual_status = 'stopped';
          inst.ports = null;
          this.deprovision?.(inst, 'stop');
        } else if (b.state === 'running') {
          inst.intended_status = 'running';
          inst.cur_state = 'running';
          this.bootInstance(inst, 'start');
        }
        return this.send(res, 200, { success: true });
      }
    }

    // ── account
    if (p === '/api/v0/users/current/' && method === 'GET') {
      return this.send(res, 200, { id: 1, email: 'tester@example.com', credit: this.credit, balance: -this.credit, api_key: 'should-be-stripped' });
    }
    if (p === '/api/v0/ssh/' && method === 'GET') {
      return this.send(res, 200, this.sshKeys.map((k) => ({ id: k.id, user_id: 1, key: k.key, created_at: 0, deleted_at: null })));
    }
    if (p === '/api/v0/ssh/' && method === 'POST') {
      const key = String((body as { ssh_key?: string })?.ssh_key ?? '');
      const k = { id: this.sshKeys.length + 1, key };
      this.sshKeys.push(k);
      return this.send(res, 200, { success: true, key: { id: k.id, user_id: 1, public_key: key } });
    }

    return this.send(res, 404, { success: false, error: 'not_found', msg: `mock: no route ${method} ${p}` });
  }
}
