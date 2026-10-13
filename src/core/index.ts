// Composition root of the Obsidian Code core (owner: platform). SPEC §2.1.
//
// Rules for core code (it runs both inside Electron main — Electron 44 / Node 24, bundled by electron-vite into a
// single CommonJS file out/main/index.js — and standalone via tsx, also CommonJS mode):
//   * no Electron imports (use the injected NativeBridge);
//   * no top-level await (CommonJS output);
//   * __dirname / import.meta.url point at out/main/ when bundled, NOT at src/core/ — never use them to locate
//     repo files such as resources/server/*. Resolve resources from process.env.OBSIDIAN_RESOURCES_DIR when set,
//     else path.join(process.cwd(), 'resources').
//   * use only Node 24 APIs (@types/node is pinned to 24 to match Electron's runtime).
//
// Construction order (factories only store ctx; they must not call other modules while constructing):
//   stores → bus → activity → llm → ext → shells → tools → models → gpu → agent (engine router) → scheduler
// Startup: models.register(gpu.provider()) → ext.start() → gpu.start() → scheduler.start() → models.refresh() (bg)
//          → HTTP/WS server.

import { mkdirSync } from 'node:fs';
import type { CoreContext, NativeBridge } from './contracts';
import { createActivityRegistry } from './activity/index';
import { createAgentRouter } from './engine/index';
import { createExtensions } from './ext/index';
import { createGpuManager } from './gpu/index';
import { createLlmClient, createModelRegistry } from './llm/index';
import { createScheduler } from './scheduler/index';
import { createEventBus } from './server/bus';
import { startServer } from './server/index';
import { createStores } from './store/index';
import { createShellRegistry, createToolRegistry } from './tools/index';

export interface CreateCoreOptions {
  /** Data directory, e.g. %APPDATA%/obsidian-code (or OBSIDIAN_CODE_DATA_DIR). */
  dataDir: string;
  /** Native integrations (Electron) or no-ops (standalone). */
  native: NativeBridge;
  /** Port for the HTTP/WS server on 127.0.0.1; 0/undefined = random free port. */
  port?: number;
}

export interface CoreHandle {
  /** WebSocket URL including the auth token, e.g. ws://127.0.0.1:PORT/ws?token=… */
  url: string;
  token: string;
  port: number;
  ctx: CoreContext;
  close(): Promise<void>;
}

/** Startup steps that talk to the network / child processes are bounded so the UI never waits forever. */
const START_STEP_TIMEOUT_MS = 10_000;
const CLOSE_STEP_TIMEOUT_MS = 10_000;

function logErr(what: string, err: unknown): void {
  console.error(`[core] ${what}:`, err instanceof Error ? err.message : err);
}

/** Await `p` for at most `ms`; on timeout log and continue (the promise keeps running in the background). */
async function bounded(what: string, p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    const r = await Promise.race([p.then(() => 'ok' as const), timeout]);
    if (r === 'timeout') console.error(`[core] ${what} is taking longer than ${Math.round(ms / 1000)} s — continuing`);
  } catch (err) {
    logErr(`${what} failed`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createCore(opts: CreateCoreOptions): Promise<CoreHandle> {
  const { dataDir, native } = opts;
  mkdirSync(dataDir, { recursive: true });

  // One mutable context, filled in order.
  const ctx = { dataDir, native } as CoreContext;

  const stores = createStores(dataDir, native);
  ctx.sessions = stores.sessions;
  ctx.settings = stores.settings;
  ctx.secrets = stores.secrets;
  ctx.kv = stores.kv;

  const bus = createEventBus();
  ctx.bus = bus;
  const activity = createActivityRegistry(bus);
  ctx.activity = activity;
  ctx.llm = createLlmClient();
  const ext = createExtensions(ctx);
  ctx.ext = ext;
  ctx.shells = createShellRegistry(ctx);
  ctx.tools = createToolRegistry(ctx);
  ctx.models = createModelRegistry(ctx);
  const gpu = createGpuManager(ctx);
  ctx.gpu = gpu;
  ctx.agent = createAgentRouter(ctx);
  const scheduler = createScheduler(ctx);
  ctx.scheduler = scheduler;

  // settings changes → clients; endpoint changes → refresh providers
  let lastEndpoints = JSON.stringify([ctx.settings.get().local, ctx.settings.get().custom]);
  const offSettings = ctx.settings.onChange((s) => {
    bus.emit('settings.updated', s);
    const endpoints = JSON.stringify([s.local, s.custom]);
    if (endpoints !== lastEndpoints) {
      lastEndpoints = endpoints;
      ctx.models.refresh().catch((err: unknown) => logErr('models.refresh after settings change failed', err));
    }
  });

  // ── startup
  try {
    ctx.models.register(gpu.provider());
  } catch (err) {
    logErr('registering the Vast provider failed', err);
  }
  await bounded('extensions start', Promise.resolve().then(() => ext.start()), START_STEP_TIMEOUT_MS);
  await bounded('gpu start', Promise.resolve().then(() => gpu.start()), START_STEP_TIMEOUT_MS);
  try {
    scheduler.start();
  } catch (err) {
    logErr('scheduler start failed', err);
  }
  Promise.resolve()
    .then(() => ctx.models.refresh())
    .then((r) => bus.emit('models.updated', r))
    .catch((err: unknown) => logErr('initial models.refresh failed', err));

  const server = await startServer({ ctx, port: opts.port });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      try {
        scheduler.stop();
      } catch (err) {
        logErr('scheduler stop failed', err);
      }
      try {
        ctx.agent.dispose?.();
      } catch (err) {
        logErr('agent engines dispose failed', err);
      }
      await bounded('extensions dispose', Promise.resolve().then(() => ext.dispose()), CLOSE_STEP_TIMEOUT_MS);
      await bounded('gpu dispose', Promise.resolve().then(() => gpu.dispose()), CLOSE_STEP_TIMEOUT_MS);
      await bounded('session flush', Promise.resolve().then(() => ctx.sessions.flush()), CLOSE_STEP_TIMEOUT_MS);
      offSettings();
      activity.flush();
      activity.dispose();
      await bounded('server close', server.close(), CLOSE_STEP_TIMEOUT_MS);
    })();
    return closing;
  };

  return { url: server.url, token: server.token, port: server.port, ctx, close };
}
