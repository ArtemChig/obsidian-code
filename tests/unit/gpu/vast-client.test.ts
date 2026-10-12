import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VastClient, VastError, buildOfferQuery, toGpuOffer, sshTargets, instanceIsDead } from '../../../src/core/gpu/vast-client';
import { DEFAULT_GPU_PROFILES } from '../../../src/core/gpu/profiles';
import { MockVast, makeOffer } from '../../fixtures/mock-vast/server';

const light = DEFAULT_GPU_PROFILES.find((p) => p.id === 'light')!;
const standard = DEFAULT_GPU_PROFILES.find((p) => p.id === 'standard')!;

describe('VastClient vs mock Vast API', () => {
  let vast: MockVast;
  let key: string | null;
  let client: VastClient;

  beforeEach(async () => {
    vast = new MockVast({
      offers: [
        makeOffer(1, { dph_total: 0.9 }),
        makeOffer(2, { dph_total: 0.52 }),
        makeOffer(3, { dph_total: 1.4 }), // over the light price cap
        makeOffer(4, { gpu_name: 'RTX 4090', gpu_ram: 24564, dph_total: 0.3 }),
        makeOffer(5, { gpu_name: 'RTX PRO 6000 WS', gpu_ram: 97887, dph_total: 1.19, hosting_type: 1 }),
      ],
    });
    await vast.start();
    key = vast.apiKey;
    client = new VastClient({ apiKey: () => key, baseUrl: vast.url, backoffMs: 1, destroyIntervalMs: 1, logPollMs: 1 });
  });
  afterEach(async () => {
    await vast.stop();
  });

  it('builds the offer query with all binding filters', () => {
    const q = buildOfferQuery(standard, { diskGb: 200, limit: 7 });
    expect(q).toMatchObject({
      verified: { eq: true },
      external: { eq: false },
      rentable: { eq: true },
      rented: { eq: false },
      gpu_name: { in: ['RTX PRO 6000 WS', 'RTX PRO 6000 S', 'RTX PRO 6000 Max-Q'] },
      num_gpus: { eq: 1 },
      gpu_ram: { gte: 90000 },
      cpu_ram: { gte: 64000 },
      disk_space: { gte: 200 },
      inet_down: { gte: 1000 },
      reliability: { gte: 0.98 },
      direct_port_count: { gte: 4 },
      cuda_max_good: { gte: 12.8 },
      inet_down_cost: { lte: 0.01 },
      duration: { gte: 86400 },
      dph_total: { lte: 2.5 },
      order: [['dph_total', 'asc']],
      type: 'on-demand',
      limit: 7,
      allocated_storage: 200,
    });
    expect(buildOfferQuery(light, { diskGb: 80 }).gpu_name).toEqual({ eq: 'RTX 5090' });
    expect(buildOfferQuery({ ...light, datacenterOnly: true }, { diskGb: 80, offerId: 9 })).toMatchObject({ datacenter: { eq: true }, id: { eq: 9 } });
  });

  it('searches offers (no key needed), filters by profile and sorts by price', async () => {
    key = null;
    const offers = await client.searchOffers(buildOfferQuery(light, { diskGb: 80 }));
    expect(offers.map((o) => o.id)).toEqual([2, 1]);
    const req = vast.requests.at(-1)!;
    expect(req.path).toBe('/api/v0/bundles/');
    expect(req.auth).toBeNull();
    const g = toGpuOffer(offers[0]);
    expect(g).toMatchObject({ offerId: 2, gpuName: 'RTX 5090', numGpus: 1, pricePerHour: 0.52, verified: true, datacenter: false });
    expect(g.gpuRamGb).toBeCloseTo(31.8, 1);
    const pro = await client.searchOffers(buildOfferQuery(standard, { diskGb: 200 }));
    expect(toGpuOffer(pro[0]).datacenter).toBe(true);
  });

  it('retries 429 and 503 with backoff', async () => {
    vast.fail.rateLimitNext = 2;
    const offers = await client.searchOffers(buildOfferQuery(light, { diskGb: 80 }));
    expect(offers.length).toBe(2);
    vast.fail.bundles503Next = 1;
    expect((await client.searchOffers(buildOfferQuery(light, { diskGb: 80 }))).length).toBe(2);
    vast.fail.rateLimitNext = 50;
    await expect(client.currentUser()).rejects.toThrow(/rate limit/i);
  });

  it('maps auth errors to friendly messages', async () => {
    key = 'wrong-key';
    const err = await client.currentUser().catch((e) => e);
    expect(err).toBeInstanceOf(VastError);
    expect(err.isAuth).toBe(true);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Invalid Vast\.ai API key/);
    key = null;
    const err2 = await client.listInstances().catch((e) => e);
    expect(err2).toBeInstanceOf(VastError);
    expect(err2.code).toBe('no_key');
  });

  it('creates an instance (PUT /asks/{id}/) and does not retry an unavailable offer', async () => {
    const r = await client.createInstance(2, { image: 'img', disk: 80, label: 'obsidian-code', runtype: 'ssh_direc ssh_proxy', onstart: 'echo hi', env: { A: '1' } });
    expect(r.instanceId).toBeGreaterThan(0);
    const req = vast.requests.find((q) => q.path === '/api/v0/asks/2/')!;
    expect(req.method).toBe('PUT');
    expect(req.body).toMatchObject({ client_id: 'me', cancel_unavail: true, label: 'obsidian-code', runtype: 'ssh_direc ssh_proxy', env: { A: '1' }, disk: 80 });
    const before = vast.requests.length;
    const err = await client.createInstance(12345, { image: 'img', disk: 80, label: 'x', runtype: 'ssh', onstart: '', env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(VastError);
    expect(err.status).toBe(404);
    expect(err.ambiguous).toBe(false);
    expect(vast.requests.length).toBe(before + 1);
  });

  it('flags a 5xx on create as ambiguous and never retries it', async () => {
    vast.fail.createAmbiguousTimes = 1;
    const before = vast.requests.length;
    const err = await client.createInstance(1, { image: 'img', disk: 80, label: 'obsidian-code', runtype: 'ssh', onstart: '', env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(VastError);
    expect(err.ambiguous).toBe(true);
    expect(vast.requests.length).toBe(before + 1);
    expect(vast.instances.size).toBe(1); // the instance exists although the call failed
  });

  it('shows, lists (paginated, label-filtered), stops/starts and destroys instances with verification', async () => {
    for (let i = 0; i < 30; i++) vast.addInstance({ id: 100 + i, actual_status: 'running' });
    vast.addInstance({ id: 500, label: 'someone-else', actual_status: 'running' });
    const list = await client.listInstances();
    expect(list.length).toBe(30);
    expect(list.every((i) => i.label === 'obsidian-code')).toBe(true);
    expect(vast.requests.filter((r) => r.path === '/api/v1/instances/').length).toBe(2);

    expect((await client.getInstance(100))?.id).toBe(100);
    expect(await client.getInstance(999)).toBeNull();

    await client.stopInstance(101);
    expect(vast.instances.get(101)!.actual_status).toBe('stopped');
    await client.startInstance(101);
    expect(vast.instances.get(101)!.intended_status).toBe('running');

    expect(await client.destroyInstance(999)).toBe('not_found');

    vast.fail.destroyFailTimes = 1;
    vast.fail.destroyIgnoredTimes = 1;
    expect(await client.destroyInstanceVerified(102, { attempts: 4, verifyPolls: 2 })).toBe(true);
    expect(vast.instances.has(102)).toBe(false);

    vast.fail.destroyAlwaysFails = true;
    expect(await client.destroyInstanceVerified(103, { attempts: 2, verifyPolls: 1 })).toBe(false);
    expect(vast.instances.has(103)).toBe(true);
  });

  it('reads credit, strips the api_key, registers + attaches the SSH key once, fetches logs without the key', async () => {
    const u = await client.currentUser();
    expect(u.creditBalance).toBe(42.5);
    expect((u as Record<string, unknown>).api_key).toBeUndefined();

    const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARAr2Z6lcUYkPy6PkPDESvL8J5SzevLMUj57uJE/0UM obsidian-code';
    expect(await client.ensureAccountSshKey(pub)).toBe('registered');
    expect(await client.ensureAccountSshKey(pub)).toBe('present');
    expect(vast.sshKeys.length).toBe(1);

    const inst = vast.addInstance({ id: 77, actual_status: 'running' });
    await client.attachSshKey(77, pub);
    expect(inst.attachedKeys).toEqual([pub]);

    vast.logs.set(77, 'line1\nline2\n');
    expect(await client.requestLogs(77, 50)).toBe('line1\nline2\n');
    const logFetch = vast.requests.find((r) => r.path === '/logs/77.log')!;
    expect(logFetch.auth).toBeNull();
  });

  it('resolves SSH endpoints direct-first and detects dead instances', () => {
    const t = sshTargets({ id: 1, public_ipaddr: '1.2.3.4', ports: { '22/tcp': [{ HostPort: '20000' }] }, ssh_host: 'ssh5.vast.ai', ssh_port: 12345, image_runtype: 'ssh ssh_direc ssh_proxy' });
    expect(t).toEqual([
      { host: '1.2.3.4', port: 20000, kind: 'direct' },
      { host: 'ssh5.vast.ai', port: 12345, kind: 'proxy' },
    ]);
    expect(sshTargets({ id: 1, ssh_host: 'ssh5.vast.ai', ssh_port: 10, image_runtype: 'jupyter' })).toEqual([{ host: 'ssh5.vast.ai', port: 11, kind: 'proxy' }]);
    expect(instanceIsDead({ id: 1, actual_status: 'exited' })).toBe(true);
    expect(instanceIsDead({ id: 1, actual_status: 'loading', status_msg: 'Error response from daemon' })).toBe(true);
    expect(instanceIsDead({ id: 1, actual_status: 'loading' })).toBe(false);
    expect(instanceIsDead({ id: 1, actual_status: 'stopped', intended_status: 'stopped' })).toBe(false);
  });
});
