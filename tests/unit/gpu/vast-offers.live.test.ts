// LIVE: real Vast.ai API, unauthenticated offer search (no key, no rental, no cost). Skipped when OFFLINE=1.
import { describe, expect, it } from 'vitest';
import { VastClient, buildOfferQuery, toGpuOffer, offerTotalVramGb } from '../../../src/core/gpu/vast-client';
import { DEFAULT_GPU_PROFILES } from '../../../src/core/gpu/profiles';
import { diskGbFor, getCatalogModel } from '../../../src/core/gpu/catalog';

const offline = process.env.OFFLINE === '1';

describe.skipIf(offline)('Vast.ai offers .live', () => {
  it('.live unauthenticated search for the light profile returns sane RTX 5090 offers', async () => {
    const light = DEFAULT_GPU_PROFILES.find((p) => p.id === 'light')!;
    const model = getCatalogModel(light.defaultModelId)!;
    const client = new VastClient({ apiKey: () => null, backoffMs: 2000, timeoutMs: 30_000 });
    const raw = await client.searchOffers(buildOfferQuery(light, { diskGb: diskGbFor(model, light.minDiskGb), limit: 10 }));
    expect(raw.length).toBeGreaterThanOrEqual(1);
    const offers = raw.map(toGpuOffer);
    for (const o of offers) {
      expect(o.gpuName).toBe('RTX 5090');
      expect(o.numGpus).toBe(1);
      expect(o.offerId).toBeGreaterThan(0);
      expect(o.pricePerHour).toBeGreaterThan(0.05);
      expect(o.pricePerHour).toBeLessThanOrEqual(light.maxPricePerHour);
      expect(o.gpuRamGb).toBeGreaterThan(29);
      expect(o.reliability).toBeGreaterThanOrEqual(light.minReliability);
      expect(o.inetDownMbps).toBeGreaterThanOrEqual(light.minInetDownMbps);
      expect(o.verified).toBe(true);
    }
    for (const r of raw) {
      expect(offerTotalVramGb(r)).toBeGreaterThanOrEqual(model.minTotalVramGb);
      expect(Number(r.cuda_max_good)).toBeGreaterThanOrEqual(12.8);
      expect(Number(r.inet_down_cost)).toBeLessThanOrEqual(0.01);
    }
    const prices = offers.map((o) => o.pricePerHour);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  }, 90_000);
});
