// Demo-mode data for the GPU view (loaded automatically with ?demo=1). Owner: ui-views.
// ?gpu=safe  → ready in safe mode (MTP + vision dropped after the full configuration failed to load)
// ?gpu=error → a failed clock-in whose server log was saved before the destroy (View server log)
import type { GpuOffer, GpuSessionRecord, GpuStatus } from '@shared/types';
import { registerDemoData, registerDemoHandler } from '@renderer/lib/demo';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function offer(id: number, gpuName: string, numGpus: number, gpuRamGb: number, price: number, location: string, extra: Partial<GpuOffer> = {}): GpuOffer {
  return { offerId: id, gpuName, numGpus, gpuRamGb, cpuRamGb: 64, diskGb: 120, inetDownMbps: 1500, reliability: 0.99, pricePerHour: price, location, datacenter: false, verified: true, ...extra };
}

const OFFERS: Record<string, GpuOffer[]> = {
  light: [
    offer(54_138_583, 'RTX 5090', 1, 31.8, 0.524, 'Quebec, CA', { datacenter: true, inetDownMbps: 2480, reliability: 0.995 }),
    offer(53_483_881, 'RTX 5090', 1, 31.8, 0.587, 'Oregon, US', { cpuRamGb: 96, diskGb: 200, inetDownMbps: 1210, reliability: 0.991 }),
    offer(54_002_117, 'RTX 5090', 1, 31.8, 0.612, 'Bavaria, DE', { inetDownMbps: 860, reliability: 0.984 }),
    offer(54_220_410, 'RTX 5090', 1, 31.8, 0.649, 'Texas, US', { inetDownMbps: 940, reliability: 0.987 }),
    offer(53_990_226, 'RTX 5090', 1, 31.8, 0.731, 'Sweden, SE', { datacenter: true, inetDownMbps: 3100, reliability: 0.996 }),
  ],
  standard: [
    offer(54_377_120, 'RTX PRO 6000 WS', 1, 95.6, 1.19, 'Texas, US', { cpuRamGb: 128, diskGb: 250, inetDownMbps: 3100, reliability: 0.993, datacenter: true }),
    offer(54_120_334, 'RTX PRO 6000 Max-Q', 1, 95.6, 1.36, 'Ontario, CA', { cpuRamGb: 96, diskGb: 220, inetDownMbps: 1700, reliability: 0.988 }),
    offer(54_301_998, 'RTX PRO 6000 S', 1, 95.6, 1.42, 'Virginia, US', { cpuRamGb: 128, diskGb: 300, inetDownMbps: 2200, reliability: 0.99 }),
  ],
  max: [
    offer(54_377_895, 'RTX PRO 6000 WS', 2, 95.6, 2.644, 'British Columbia, CA', { cpuRamGb: 256, diskGb: 400, inetDownMbps: 4200, reliability: 0.981, datacenter: true }),
    offer(54_390_011, 'RTX PRO 6000 WS', 2, 95.6, 2.89, 'Texas, US', { cpuRamGb: 256, diskGb: 500, inetDownMbps: 3800, reliability: 0.985 }),
  ],
};

function rec(id: string, ago: number, hours: number, profileId: string, modelId: string, gpu: string, n: number, price: number, reason: GpuSessionRecord['endReason'], cost?: number): GpuSessionRecord {
  const endedAt = Date.now() - ago;
  return { id, instanceId: 25_900_000 + Number(id.replace(/\D/g, '')) * 311, profileId, modelId, gpuName: gpu, numGpus: n, pricePerHour: price, startedAt: endedAt - hours * HOUR, endedAt, cost: cost ?? Math.round(hours * price * 100) / 100, endReason: reason };
}

registerDemoData({
  offers: OFFERS,
  history: [
    rec('g1', 9 * DAY, 4.3, 'light', 'qwen38-27b-uncensored-hauhau-q5kp', 'RTX 5090', 1, 0.538, 'idle'),
    rec('g0', 11 * DAY, 0.04, 'standard', 'qwen38-flash-next-uncensored-huihui-v2-q4kxl', 'RTX PRO 6000 WS', 1, 1.22, 'error', 0.05),
    rec('gm', 13 * DAY, 6, 'light', 'qwen38-27b-standard-unsloth-q5kxl', 'RTX 5090', 1, 0.55, 'max_hours'),
    rec('gw', 15 * DAY, 2.2, 'light', 'qwen38-27b-uncensored-hauhau-q5kp', 'RTX 5090', 1, 0.52, 'server_watchdog'),
    rec('gb', 17 * DAY, 1.9, 'max', 'glm53-flash-uncensored-huihui-iq4xs', 'RTX PRO 6000 WS', 2, 2.7, 'budget'),
  ],
});

const SAVED_LOG = 'C:\\Users\\you\\AppData\\Roaming\\obsidian-code\\logs\\gpu-26418220-20261013-110203.log';
const FAILED_MODEL = 'qwen38-27b-uncensored-hauhau-q5kp';

function failureLogText(): string {
  return [
    'Obsidian Code - GPU failure log',
    'Captured:  2026-10-13T11:02:03.000Z',
    `Reason:    GPU server error: llama-server failed to load ${FAILED_MODEL} (full, safe and safe-minimal modes); see server.log`,
    'Instance:  #26418220 (1x RTX 5090)',
    `Model:     ${FAILED_MODEL}`,
    'Image:     ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561',
    '',
    '===== status.json =====',
    `{"phase":"error","progress":0,"message":"llama-server failed to load ${FAILED_MODEL} (full, safe and safe-minimal modes); see server.log","mode":"safe-minimal","dropped":["mtp","vision","flash-attn","kv-quant"],"attempt":3,"ctx":32768}`,
    '',
    '===== attempts.log (failed load attempts) =====',
    `[2026-10-13T11:01:12Z] [oc] attempt 1/3 (full) FAILED to load ${FAILED_MODEL}`,
    '  flags: -m /root/models/…/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf --api-key *** -ngl 99 -c 131072 --jinja --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --mmproj … --spec-type draft-mtp --spec-draft-n-max 2 --parallel 1',
    '  | llama_init_from_model: failed to initialize the context (demo text)',
    '  | main: exiting due to model loading error',
    '',
    '===== server.log (last 400 lines) =====',
    'llama_model_loader: loaded meta data with 52 key-value pairs and 866 tensors',
    'llama_init_from_model: failed to initialize the context (demo text)',
    '',
    '===== nvidia-smi =====',
    '|   0  NVIDIA GeForce RTX 5090   On  |   00000000:01:00.0 Off |   1MiB / 32607MiB |',
  ].join('\n');
}

const scenario = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('gpu') : null;
if (scenario === 'safe') {
  registerDemoData((d) => ({
    gpuStatus: { ...d.gpuStatus, message: `${d.gpuStatus.message} (safe mode)`, serverMode: 'safe', droppedFeatures: ['mtp', 'vision'], serverContextLength: 65536, failureLogPath: SAVED_LOG },
    serverLog: `===== failed load attempts (safe mode is active) =====\n[2026-10-13T11:01:12Z] [oc] attempt 1/3 (full) FAILED to load ${FAILED_MODEL}\n  | llama_init_from_model: failed to create the MTP draft context\n\n===== server.log (last 300 lines) =====\n${d.serverLog}`,
  }));
} else if (scenario === 'error') {
  registerDemoData((d) => {
    const ids = ['searching', 'renting', 'connecting', 'downloading', 'loading', 'ready'] as const;
    const error = `GPU server error: llama-server failed to load ${FAILED_MODEL} (full, safe and safe-minimal modes); see server.log`;
    const g: GpuStatus = {
      ...d.gpuStatus,
      phase: 'error',
      message: `Clock-in failed: ${error}`,
      lastError: error,
      failureLogPath: SAVED_LOG,
      instanceId: undefined,
      endpoint: undefined,
      clockedInAt: undefined,
      readyAt: undefined,
      progress: undefined,
      steps: d.gpuStatus.steps.map((s) => {
        const i = ids.indexOf(s.id as (typeof ids)[number]);
        return { ...s, state: i < 4 ? 'done' : i === 4 ? 'error' : 'todo' };
      }),
    };
    return { gpuStatus: g, serverLog: failureLogText() };
  });
}

// The demo core knows nothing about parked instances: model what the real GpuManager does with them.
registerDemoHandler('gpu.clockOut', async (_p, ctx) => {
  const g = ctx.data.gpuStatus;
  if (g.phase === 'off' && g.parked) {
    // A user clock-out with nothing rented discards the parked instance (stops its storage billing).
    ctx.data.gpuStatus = { ...g, parked: undefined };
    ctx.emit('gpu.status', ctx.data.gpuStatus);
    return ctx.data.gpuStatus;
  }
  return (await ctx.fallback()) as GpuStatus;
});

registerDemoHandler('gpu.clockIn', async (_p, ctx) => {
  const g = ctx.data.gpuStatus;
  // The demo does not simulate a resumed disk: the parked marker just goes away once a rental starts.
  if (g.parked && g.phase === 'off') ctx.data.gpuStatus = { ...g, parked: undefined };
  return (await ctx.fallback()) as GpuStatus;
});
