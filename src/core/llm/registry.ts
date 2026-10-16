// Model registry: 'local' (llama-server on this PC), 'custom:<id>' (settings.custom) and externally registered
// providers ('vast' from the gpu module). Polls every 15 s and emits models.updated on change.

import type { CoreContext, Endpoint, LlmProvider, ModelRegistry } from '../contracts';
import type { CustomEndpoint, ModelInfo, ModelRef, ProviderInfo, ProviderStatus, Settings } from '../../shared/types';
import { authHeaders, detectDialect, fetchJson, normalizeBaseUrl, setDialect, setMaxConcurrent, type Dialect } from './dialect';

export const DEFAULT_CONTEXT_LENGTH = 32768;
const UNCENSORED_RE = /uncensored|abliterat|heretic/i;
const THINKING_RE = /qwen|glm|qwq/i;

export function variantFromName(name: string): 'uncensored' | 'standard' {
  return UNCENSORED_RE.test(name) ? 'uncensored' : 'standard';
}

export function supportsThinkingFromName(name: string): boolean {
  return THINKING_RE.test(name);
}

export function prettyLabel(id: string): string {
  const base = id.split(/[\\/]/).pop() ?? id;
  return base.replace(/\.gguf$/i, '');
}

export interface RegistryOptions {
  pollMs?: number;
  fetchImpl?: typeof fetch;
  /** Disable the background poller (tests). */
  autoPoll?: boolean;
}

interface ProbeResult { status: ProviderStatus; detail?: string; models: ModelInfo[] }

/** Probe a llama.cpp / vLLM / generic server and describe its models. */
async function probeServer(
  providerId: ModelRef['provider'],
  baseUrl: string,
  apiKey: string | undefined,
  opts: { fetchImpl?: typeof fetch; configuredModels?: string[]; assumeLlamacpp?: boolean },
): Promise<ProbeResult & { dialect?: Dialect }> {
  const root = normalizeBaseUrl(baseUrl);
  const endpoint: Endpoint = { baseUrl: root, apiKey };
  const headers = authHeaders(endpoint);
  const fetchImpl = opts.fetchImpl;

  if (opts.assumeLlamacpp) {
    const health = await fetchJson(`${root}/health`, { headers, timeoutMs: 4000, fetchImpl });
    if (!health) return { status: 'offline', detail: `Not reachable at ${root}`, models: [] };
    if (health.status === 503) return { status: 'starting', detail: 'Loading model…', models: [] };
    if (health.status === 401 || health.status === 403) return { status: 'error', detail: 'API key rejected', models: [] };
    if (health.status !== 200) return { status: 'error', detail: `Health check failed (HTTP ${health.status})`, models: [] };
  }

  const [modelsRes, propsRes] = await Promise.all([
    fetchJson(`${root}/v1/models`, { headers, timeoutMs: 5000, fetchImpl }),
    opts.assumeLlamacpp ? fetchJson(`${root}/props`, { headers, timeoutMs: 5000, fetchImpl }) : Promise.resolve(null),
  ]);
  if (!modelsRes) {
    if (opts.configuredModels?.length && propsRes) {
      // fall through with configured models
    } else {
      return { status: 'offline', detail: `Not reachable at ${root}`, models: [] };
    }
  }
  if (modelsRes && (modelsRes.status === 401 || modelsRes.status === 403)) {
    return { status: 'error', detail: 'API key rejected (HTTP ' + modelsRes.status + ')', models: [] };
  }

  const props = propsRes && propsRes.status === 200 ? (propsRes.json as Record<string, unknown> | null) : null;
  let dialect: Dialect | undefined;
  if (props && (props.build_info !== undefined || props.default_generation_settings !== undefined)) dialect = 'llamacpp';
  else if (opts.assumeLlamacpp) dialect = 'llamacpp';

  type ModelEntry = { id: string; owned_by?: string; max_model_len?: number; meta?: { n_ctx?: number; n_ctx_train?: number }; architecture?: { input_modalities?: string[] } };
  const data: ModelEntry[] = modelsRes && modelsRes.status === 200 && Array.isArray((modelsRes.json as { data?: unknown })?.data)
    ? ((modelsRes.json as { data: ModelEntry[] }).data).filter((m) => m && typeof m.id === 'string')
    : [];
  if (!dialect) {
    if (data.some((m) => m.owned_by === 'llamacpp')) dialect = 'llamacpp';
    else if (data.some((m) => m.owned_by === 'vllm' || typeof m.max_model_len === 'number')) dialect = 'vllm';
  }
  if (!dialect && providerId !== 'local') {
    dialect = await detectDialect(endpoint, fetchImpl);
  }

  const dgs = props?.default_generation_settings as { n_ctx?: number } | undefined;
  const modalities = props?.modalities as { vision?: boolean } | undefined;
  const caps = props?.chat_template_caps as { supports_tools?: boolean } | undefined;
  const template = typeof props?.chat_template === 'string' ? (props.chat_template as string) : '';
  const modelPath = typeof props?.model_path === 'string' ? (props.model_path as string) : '';

  let ids = data.map((m) => m.id);
  if (opts.configuredModels?.length) ids = opts.configuredModels;
  if (!ids.length) {
    if (modelsRes && modelsRes.status !== 200 && modelsRes.status !== 404) {
      return { status: 'error', detail: `Model list failed (HTTP ${modelsRes.status})`, models: [] };
    }
    return { status: 'error', detail: 'The server lists no models', models: [] };
  }

  const models: ModelInfo[] = ids.map((id) => {
    const entry = data.find((m) => m.id === id);
    const contextLength = entry?.meta?.n_ctx ?? dgs?.n_ctx ?? entry?.max_model_len ?? DEFAULT_CONTEXT_LENGTH;
    const vision = modalities?.vision ?? entry?.architecture?.input_modalities?.includes('image') ?? false;
    const nameHay = `${id} ${modelPath}`;
    return {
      ref: { provider: providerId, model: id },
      label: prettyLabel(id),
      contextLength,
      supportsVision: !!vision,
      supportsTools: caps?.supports_tools ?? true,
      supportsThinking: supportsThinkingFromName(nameHay) || /enable_thinking|<think>/.test(template),
      variant: variantFromName(nameHay),
      status: 'online' as ProviderStatus,
    };
  });
  return { status: 'online', models, dialect };
}

/** When a provider goes offline keep its last known models (marked with the new status) so pickers don't empty out. */
function keepLastKnown(prev: ModelInfo[], r: ProbeResult, base: string, lastBase: string | undefined): ModelInfo[] {
  if (r.models.length) return r.models.map((m) => ({ ...m, status: r.status }));
  if (base !== lastBase) return [];
  return prev.map((m) => ({ ...m, status: r.status }));
}

class LocalProvider implements LlmProvider {
  readonly id = 'local';
  private lastBase: string | undefined;
  status: ProviderStatus = 'offline';
  detail: string | undefined = 'Not checked yet';
  models: ModelInfo[] = [];
  checked = false;
  constructor(private readonly ctx: CoreContext, private readonly fetchImpl?: typeof fetch) {}

  private cfg(): Settings['local'] {
    const s = this.ctx.settings?.get?.();
    return s?.local ?? { enabled: true, baseUrl: 'http://127.0.0.1:8080' };
  }
  private apiKey(): string | undefined {
    const name = this.cfg().apiKeySecret ?? 'local.apiKey';
    try { return this.ctx.secrets?.get(name) ?? undefined; } catch { return undefined; }
  }
  baseUrl(): string { return normalizeBaseUrl(this.cfg().baseUrl || 'http://127.0.0.1:8080'); }

  info(): ProviderInfo {
    return { id: 'local', label: 'Local (this PC)', status: this.status, baseUrl: this.baseUrl(), detail: this.detail };
  }
  endpoint(): Endpoint | null {
    if (this.status !== 'online') return null;
    return { baseUrl: this.baseUrl(), apiKey: this.apiKey() };
  }
  async listModels(): Promise<ModelInfo[]> {
    const cfg = this.cfg();
    this.checked = true;
    if (cfg.enabled === false) {
      this.status = 'offline'; this.detail = 'Disabled in Settings'; this.models = [];
      return [];
    }
    const base = this.baseUrl();
    const r = await probeServer('local', base, this.apiKey(), { fetchImpl: this.fetchImpl, assumeLlamacpp: true });
    this.status = r.status; this.detail = r.status === 'online' ? undefined : r.detail;
    this.models = keepLastKnown(this.models, r, base, this.lastBase);
    this.lastBase = base;
    setDialect(base, r.dialect ?? 'llamacpp');
    // The local server is shared with another app: at most 2 concurrent requests from us (SPEC §5b).
    setMaxConcurrent(base, 2);
    return this.models;
  }
}

class CustomProvider implements LlmProvider {
  readonly id: `custom:${string}`;
  private lastBase: string | undefined;
  status: ProviderStatus = 'offline';
  detail: string | undefined = 'Not checked yet';
  models: ModelInfo[] = [];
  checked = false;
  constructor(private readonly ctx: CoreContext, public cfg: CustomEndpoint, private readonly fetchImpl?: typeof fetch) {
    this.id = `custom:${cfg.id}`;
  }
  private apiKey(): string | undefined {
    const name = this.cfg.apiKeySecret || `custom.${this.cfg.id}.apiKey`;
    try { return this.ctx.secrets?.get(name) ?? undefined; } catch { return undefined; }
  }
  info(): ProviderInfo {
    return { id: this.id, label: this.cfg.label || this.cfg.id, status: this.status, baseUrl: normalizeBaseUrl(this.cfg.baseUrl), detail: this.detail };
  }
  endpoint(): Endpoint | null {
    if (this.status !== 'online') return null;
    return { baseUrl: normalizeBaseUrl(this.cfg.baseUrl), apiKey: this.apiKey() };
  }
  async listModels(): Promise<ModelInfo[]> {
    this.checked = true;
    if (!this.cfg.baseUrl) { this.status = 'error'; this.detail = 'No base URL configured'; this.models = []; return []; }
    const r = await probeServer(this.id, this.cfg.baseUrl, this.apiKey(), { fetchImpl: this.fetchImpl, configuredModels: this.cfg.models });
    this.status = r.status; this.detail = r.status === 'online' ? undefined : r.detail;
    const base = normalizeBaseUrl(this.cfg.baseUrl);
    this.models = keepLastKnown(this.models, r, base, this.lastBase);
    this.lastBase = base;
    if (r.dialect) setDialect(this.cfg.baseUrl, r.dialect);
    return this.models;
  }
}

export type ModelRegistryImpl = ModelRegistry & { dispose(): void };

export function createModelRegistry(ctx: CoreContext, options: RegistryOptions = {}): ModelRegistryImpl {
  const pollMs = options.pollMs ?? 15_000;
  const local = new LocalProvider(ctx, options.fetchImpl);
  const customs = new Map<string, CustomProvider>();
  const external = new Map<string, LlmProvider>();
  const externalModels = new Map<string, ModelInfo[]>();
  let lastSnapshot = '';
  let inflight: Promise<{ providers: ProviderInfo[]; models: ModelInfo[] }> | null = null;
  let settingsUnsub: (() => void) | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let kick: ReturnType<typeof setTimeout> | undefined;

  function syncCustoms(): void {
    const list = ctx.settings?.get?.().custom ?? [];
    const ids = new Set(list.map((c) => c.id));
    for (const id of [...customs.keys()]) if (!ids.has(id)) customs.delete(id);
    for (const c of list) {
      const existing = customs.get(c.id);
      if (existing) existing.cfg = c;
      else customs.set(c.id, new CustomProvider(ctx, c, options.fetchImpl));
    }
  }

  function allProviders(): LlmProvider[] {
    return [...external.values(), local, ...customs.values()];
  }

  function providers(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const p of allProviders()) {
      try { out.push(p.info()); } catch { /* provider broken */ }
    }
    return out;
  }

  function models(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const [id, list] of externalModels) {
      const p = external.get(id);
      let status: ProviderStatus = 'offline';
      try { status = p?.info().status ?? 'offline'; } catch { /* ignore */ }
      for (const m of list) out.push({ ...m, status: m.status === 'online' && status !== 'online' ? status : m.status });
    }
    out.push(...local.models);
    for (const c of customs.values()) out.push(...c.models);
    return out;
  }

  function snapshot(): { providers: ProviderInfo[]; models: ModelInfo[] } {
    return { providers: providers(), models: models() };
  }

  function emitIfChanged(): void {
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (key !== lastSnapshot) {
      lastSnapshot = key;
      try { ctx.bus?.emit('models.updated', snap); } catch { /* bus not ready */ }
    }
  }

  function ensureSettingsSub(): void {
    if (settingsUnsub || !ctx.settings?.onChange) return;
    try {
      // The sidebar layout (Settings.ui) changes on every collapse / drag and affects no provider: no re-probe for it.
      const withoutUi = (s: Settings | undefined): string => (s ? JSON.stringify({ ...s, ui: undefined }) : '');
      let last = withoutUi(ctx.settings.get?.());
      settingsUnsub = ctx.settings.onChange((s) => {
        const key = withoutUi(s);
        if (s && key === last) return;
        last = key;
        scheduleRefresh(50);
      });
    } catch { /* ignore */ }
  }

  function scheduleRefresh(ms: number): void {
    if (disposed) return;
    if (kick) clearTimeout(kick);
    kick = setTimeout(() => { kick = undefined; void refresh().catch(() => {}); }, ms);
    kick.unref?.();
  }

  async function refresh(): Promise<{ providers: ProviderInfo[]; models: ModelInfo[] }> {
    if (inflight) return inflight;
    inflight = (async () => {
      if (!ctx.settings) return snapshot();
      ensureSettingsSub();
      syncCustoms();
      const tasks: Promise<unknown>[] = [local.listModels().catch(() => { local.status = 'error'; })];
      for (const c of customs.values()) tasks.push(c.listModels().catch(() => { c.status = 'error'; }));
      for (const [id, p] of external) {
        tasks.push(p.listModels().then((list) => { externalModels.set(id, list); }).catch(() => { externalModels.set(id, []); }));
      }
      await Promise.all(tasks);
      emitIfChanged();
      return snapshot();
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  function register(provider: LlmProvider): void {
    external.set(provider.id, provider);
    scheduleRefresh(0);
  }

  function isOnline(ref: ModelRef): boolean {
    return models().some((m) => m.ref.provider === ref.provider && m.ref.model === ref.model && m.status === 'online');
  }

  function preferred(list: ModelInfo[]): ModelInfo | undefined {
    const preferUncensored = ctx.settings?.get?.().preferUncensored ?? true;
    const sorted = [...list].sort((a, b) => {
      const va = a.variant === 'uncensored' ? 0 : 1;
      const vb = b.variant === 'uncensored' ? 0 : 1;
      return preferUncensored ? va - vb : vb - va;
    });
    return sorted[0];
  }

  function pickDefault(): ModelRef | null {
    const s = ctx.settings?.get?.();
    const all = models();
    if (s?.defaultModel && isOnline(s.defaultModel)) return s.defaultModel;
    const online = all.filter((m) => m.status === 'online');
    const vast = preferred(online.filter((m) => m.ref.provider === 'vast'));
    if (vast) return vast.ref;
    const loc = preferred(online.filter((m) => m.ref.provider === 'local'));
    if (loc) return loc.ref;
    const custom = online.find((m) => m.ref.provider.startsWith('custom:'));
    if (custom) return custom.ref;
    return s?.defaultModel ?? null;
  }

  function providerFor(id: string): LlmProvider | undefined {
    if (id === 'local') return local;
    if (id.startsWith('custom:')) { syncCustoms(); return customs.get(id.slice(7)); }
    return external.get(id);
  }

  function unavailable(ref: ModelRef, info: ProviderInfo | undefined): Error {
    if (ref.provider === 'vast') return new Error("Your Vast GPU isn't clocked in — clock in or pick the Local model.");
    if (ref.provider === 'local') {
      if (info?.status === 'starting') return new Error('The local model server is still loading the model — try again in a moment.');
      if (info?.detail === 'Disabled in Settings') return new Error('The Local provider is disabled in Settings — enable it or pick another model.');
      return new Error(`The local model server (${info?.baseUrl ?? 'http://127.0.0.1:8080'}) isn't reachable — start llama-server or pick another model.`);
    }
    return new Error(`${info?.label ?? ref.provider} is ${info?.status ?? 'offline'}${info?.detail ? ` (${info.detail})` : ''} — check Settings → Models or pick another model.`);
  }

  function resolve(ref: ModelRef | null): { endpoint: Endpoint; model: ModelInfo } {
    const r = ref ?? pickDefault();
    if (!r) throw new Error('No model is available — start the local llama-server or clock in a Vast GPU.');
    const p = providerFor(r.provider);
    if (!p) {
      if (r.provider === 'vast') throw unavailable(r, undefined);
      if (r.provider.startsWith('custom:')) throw new Error(`The custom endpoint "${r.provider.slice(7)}" no longer exists — pick another model.`);
      throw new Error(`Unknown model provider "${r.provider}".`);
    }
    let info: ProviderInfo | undefined;
    try { info = p.info(); } catch { info = undefined; }
    const endpoint = info?.status === 'online' ? p.endpoint() : null;
    if (!endpoint) throw unavailable(r, info);
    const list = models().filter((m) => m.ref.provider === r.provider);
    const exact = list.find((m) => m.ref.model === r.model);
    if (exact) return { endpoint, model: { ...exact, status: 'online' } };
    // single-model servers (local / vast) ignore the model name: use what is loaded
    if ((r.provider === 'local' || r.provider === 'vast') && list.length) return { endpoint, model: { ...list[0]!, status: 'online' } };
    const name = `${r.model}`;
    return {
      endpoint,
      model: {
        ref: r,
        label: prettyLabel(name),
        contextLength: DEFAULT_CONTEXT_LENGTH,
        supportsVision: false,
        supportsTools: true,
        supportsThinking: supportsThinkingFromName(name),
        variant: variantFromName(name),
        status: 'online',
      },
    };
  }

  if (options.autoPoll !== false) {
    scheduleRefresh(0);
    timer = setInterval(() => { void refresh().catch(() => {}); }, pollMs);
    timer.unref?.();
  }

  return {
    providers,
    models,
    refresh,
    register,
    resolve,
    pickDefault,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      if (kick) clearTimeout(kick);
      settingsUnsub?.();
    },
  };
}
