// LIVE end-to-end driver for the INSTALLED Obsidian Code app — RENTS REAL Vast.ai GPUs AND COSTS REAL MONEY.
//
//   npx tsx scripts/live/vast-live.ts <scenario> [--budget 2.50] [--campaign-start <epoch ms>] [--no-update]
//
// Scenarios
//   status   launch the installed app, print GPU status / credit / campaign spend, make sure nothing runs, close
//   update   only the updater test: if GitHub has a newer release, click UPDATE, let it install + restart, relaunch, check
//   cleanup  launch, clock out and destroy any labelled instance left on the account, close
//   phase1   update test (unless --no-update), settings sanity, clock in Light with the default model, wait for ready
//            (<= 25 min), record serverMode/droppedFeatures, create a session on the vast model in a temp folder, send
//            "Reply with exactly: pong" and a Bash tool turn (node -v, runs on this PC), measure TTFT / decode speed,
//            screenshots, clock out, verify that nothing is left running.
//
// How it drives the app
//   * Closes the user's running Obsidian Code gracefully first (taskkill without /F, waits for the exit; /F only when it
//     refuses AND the GPU ledger shows no active instance).
//   * Launches the installed exe (default user data: the encrypted Vast key only decrypts inside that Electron app) with
//     Playwright's _electron. Control goes over the core's WebSocket RPC (src/shared/protocol.ts) from Node; the UI is
//     used for screenshots and for the UPDATE button.
//
// Money safety (non-negotiable)
//   * Before a clock-in: campaign spend + 0.60 <= budget (default 2.50) and Vast credit >= 19. Campaign spend = cost of the
//     gpu-ledger records that started at/after the campaign start (scripts/live/out/campaign.json) + an active session.
//   * Every run clocks out in `finally`; SIGINT / uncaught errors clock out first; a process 'exit' handler makes a
//     synchronous last-resort clock-out over the core's HTTP RPC. After each run: gpu.status phase 'off', no
//     orphanInstanceIds, gpu.destroyOrphans() destroyed nothing, ledger.active absent — else it cleans up and fails.
//   * Never park, never raise budgets or price caps.
//
// Output: scripts/live/out/<runId>/ (driver.log, main.log, screenshots, result.json, server/failure logs). Gitignored.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import WebSocket from 'ws';
import type { CoreEventName, CoreEvents, RpcMethod, RpcParams, RpcResult } from '../../src/shared/protocol';
import type { GpuStatus, Message, Settings, ToolUseBlock } from '../../src/shared/types';

// ───────────────────────────── config ─────────────────────────────

const REPO = path.resolve(__dirname, '..', '..');
const EXE = process.env.OC_LIVE_EXE ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Obsidian Code', 'Obsidian Code.exe');
const IMAGE = 'Obsidian Code.exe';
const DATA_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian-code');
const LEDGER_FILE = path.join(DATA_DIR, 'kv', 'gpu-ledger.json');
const OUT_ROOT = path.join(REPO, 'scripts', 'live', 'out');
const CAMPAIGN_FILE = path.join(OUT_ROOT, 'campaign.json');

const PROFILE_ID = 'light';
const MODEL_ID = 'qwen38-27b-uncensored-hauhau-q5kp';
const RESERVE_USD = 0.6;
const MIN_CREDIT_USD = 19;
const READY_TIMEOUT_MS = 25 * 60_000;
const POLL_MS = 5000;
const RUN_HARD_LIMIT_MS = 50 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const SCENARIO = process.argv[2] ?? 'status';
const BUDGET_USD = Number(arg('budget') ?? '2.50');
const NO_UPDATE = process.argv.includes('--no-update');

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-') + `-${SCENARIO}`;
const OUT = path.join(OUT_ROOT, runId);
mkdirSync(OUT, { recursive: true });
const runStart = Date.now();

// ───────────────────────────── logging ─────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
function log(msg: string): void {
  const line = `${ts()} ${msg}`;
  console.log(line);
  try {
    appendFileSync(path.join(OUT, 'driver.log'), line + '\n');
  } catch {
    /* ignore */
  }
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const result: Record<string, unknown> = { runId, scenario: SCENARIO, startedAt: new Date(runStart).toISOString(), exe: EXE, steps: [] as string[] };
function step(s: string): void {
  (result.steps as string[]).push(`${ts()} ${s}`);
  log(`== ${s}`);
}
function saveResult(): void {
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

// ───────────────────────────── campaign / ledger ─────────────────────────────

interface LedgerRecord { instanceId: number; startedAt: number; endedAt?: number; cost: number; endReason?: string; modelId: string; gpuName: string; pricePerHour: number }
interface LedgerFile { records: LedgerRecord[]; active?: { instanceId: number; startedAt: number } | null; pendingDestroy?: number[]; parked?: unknown }

function readLedger(): LedgerFile {
  try {
    return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as LedgerFile;
  } catch {
    return { records: [] };
  }
}

function campaignStart(): number {
  const given = arg('campaign-start');
  if (given) return Number(given);
  if (existsSync(CAMPAIGN_FILE)) return (JSON.parse(readFileSync(CAMPAIGN_FILE, 'utf8')) as { campaignStart: number }).campaignStart;
  const now = Date.now();
  writeFileSync(CAMPAIGN_FILE, JSON.stringify({ campaignStart: now, iso: new Date(now).toISOString() }, null, 2));
  return now;
}

/** Ledger records of this campaign (+ the active session's live cost when known). */
function campaignSpend(liveSessionCost = 0): { spend: number; records: LedgerRecord[] } {
  const start = campaignStart();
  const l = readLedger();
  const records = l.records.filter((r) => r.startedAt >= start);
  const closed = records.reduce((s, r) => s + (r.endedAt ? r.cost : 0), 0);
  const openRec = records.find((r) => !r.endedAt);
  const live = l.active || openRec ? Math.max(liveSessionCost, openRec?.cost ?? 0) : 0;
  return { spend: Math.round((closed + live) * 10_000) / 10_000, records };
}

// ───────────────────────────── processes ─────────────────────────────

function appPids(): number[] {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && m[1].toLowerCase() === IMAGE.toLowerCase()) pids.push(Number(m[2]));
  }
  return pids;
}

async function waitNoApp(timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (appPids().length === 0) return true;
    await sleep(1000);
  }
  return appPids().length === 0;
}

/** Close every running Obsidian Code gracefully (WM_CLOSE → the app's own quit: GPU clock-out on quit, flush). */
async function closeAppGracefully(label: string): Promise<void> {
  if (appPids().length === 0) return;
  log(`closing ${label} gracefully (taskkill without /F)…`);
  for (let i = 0; i < 3 && appPids().length; i++) {
    spawnSync('taskkill', ['/IM', IMAGE], { encoding: 'utf8' });
    if (await waitNoApp(30_000)) break;
  }
  if (appPids().length === 0) {
    log(`${label} exited`);
    return;
  }
  const l = readLedger();
  if (l.active) throw new Error(`${label} refused to close and the ledger shows active GPU instance #${l.active.instanceId}; not forcing it.`);
  log(`${label} refused to close; ledger shows no active GPU → taskkill /F`);
  spawnSync('taskkill', ['/F', '/IM', IMAGE], { encoding: 'utf8' });
  if (!(await waitNoApp(20_000))) throw new Error(`could not close ${label}`);
}

function exeVersion(): string {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${EXE.replace(/'/g, "''")}').VersionInfo.FileVersion`], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().split('.').slice(0, 3).join('.');
}

function latestReleaseVersion(): string | null {
  const r = spawnSync('gh', ['release', 'view', '--repo', 'ArtemChig/obsidian-code', '--json', 'tagName', '-q', '.tagName'], { encoding: 'utf8' });
  const v = (r.stdout ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ───────────────────────────── RPC client ─────────────────────────────

type Listener = (data: unknown) => void;

class Rpc {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<Listener>>();
  private closedByUs = false;

  constructor(readonly url: string) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
    });
    this.ws = ws;
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('error', () => undefined);
    ws.on('close', () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('RPC connection closed'));
      }
      this.pending.clear();
      if (!this.closedByUs) log('[rpc] connection closed');
    });
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; event?: string; data?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.event === 'string') {
      for (const fn of this.listeners.get(msg.event) ?? []) {
        try {
          fn(msg.data);
        } catch (e) {
          log(`[rpc] listener for ${msg.event} threw: ${errMsg(e)}`);
        }
      }
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>, timeoutMs = 120_000): Promise<RpcResult<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`RPC not connected (${method})`));
    const id = this.nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on<E extends CoreEventName>(event: E, fn: (data: CoreEvents[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const l = fn as Listener;
    set.add(l);
    return () => set.delete(l);
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────────── app session ─────────────────────────────

interface AppHandle {
  app: ElectronApplication;
  page: Page;
  rpc: Rpc;
  coreUrl: string;
  exited: Promise<void>;
  isExited(): boolean;
}

/** Last-resort safety state for the exit handler. */
const safety = { coreUrl: null as string | null, gpuMayBeOn: false };
let current: AppHandle | null = null;

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['OBSIDIAN_CODE_DATA_DIR', 'OBSIDIAN_UPDATE_TEST_FEED', 'OBSIDIAN_UPDATE_TEST_INSTALL', 'OBSIDIAN_RESOURCES_DIR', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'VAST_API_KEY']) delete env[k];
  return env;
}

async function launchApp(label: string): Promise<AppHandle> {
  if (appPids().length) await closeAppGracefully('running Obsidian Code');
  log(`launching ${label}: ${EXE}`);
  const app = await electron.launch({ executablePath: EXE, args: [], env: cleanEnv() as Record<string, string>, timeout: 120_000 });
  const proc = app.process();
  const mainLog = path.join(OUT, 'main.log');
  appendFileSync(mainLog, `\n===== ${new Date().toISOString()} launch ${label} (pid ${proc.pid}) =====\n`);
  proc.stdout?.on('data', (d: Buffer) => appendFileSync(mainLog, d));
  proc.stderr?.on('data', (d: Buffer) => appendFileSync(mainLog, d));
  let exited = false;
  const exitedP = new Promise<void>((r) =>
    proc.once('exit', (code) => {
      exited = true;
      log(`[app] process exited (code ${code})`);
      r();
    }),
  );
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForSelector('[data-testid=app-shell]', { timeout: 120_000 });
  let coreUrl: string | null = null;
  for (let i = 0; i < 60 && !coreUrl; i++) {
    coreUrl = await page.evaluate(() => (globalThis as unknown as { obsidian?: { coreUrl: string | null } }).obsidian?.coreUrl ?? null);
    if (!coreUrl) await sleep(1000);
  }
  if (!coreUrl) throw new Error('window.obsidian.coreUrl is not available');
  const rpc = new Rpc(coreUrl);
  await rpc.connect();
  const info = await rpc.call('system.info', {});
  log(`app up: version ${info.version}, dataDir ${info.dataDir}, electron ${info.electron}`);
  if (path.resolve(info.dataDir).toLowerCase() !== path.resolve(DATA_DIR).toLowerCase()) throw new Error(`unexpected data dir ${info.dataDir}`);
  safety.coreUrl = coreUrl;
  current = { app, page, rpc, coreUrl, exited: exitedP, isExited: () => exited };
  return current;
}

async function closeApp(h: AppHandle, label = 'the app'): Promise<void> {
  h.rpc.close();
  if (h.isExited()) return;
  log(`closing ${label} (window close → graceful quit)…`);
  try {
    await h.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close();
    });
  } catch {
    /* the process may already be quitting */
  }
  const done = await Promise.race([h.exited.then(() => true), sleep(60_000).then(() => false)]);
  if (!done) {
    log('app did not exit within 60 s after window close; taskkill (graceful)');
    await closeAppGracefully('the app');
  }
  if (current === h) current = null;
  safety.coreUrl = null;
}

async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  } catch (e) {
    log(`screenshot ${name} failed: ${errMsg(e)}`);
  }
}

async function gotoGpuView(page: Page): Promise<void> {
  try {
    await page.getByTestId('status-gpu').click({ timeout: 5000 });
    await sleep(500);
  } catch (e) {
    log(`could not open the GPU view: ${errMsg(e)}`);
  }
}

// ───────────────────────────── GPU safety ─────────────────────────────

function fmtStatus(s: GpuStatus): string {
  const p = s.progress !== undefined ? ` ${Math.round(s.progress * 100)}%` : '';
  return `[${s.phase}]${p} ${s.message} | $${s.sessionCost.toFixed(4)}${s.instanceId ? ` #${s.instanceId}` : ''}${s.serverMode ? ` mode=${s.serverMode}` : ''}`;
}

/** Clock out, destroy anything labelled that is left, and verify. Retries; throws when it cannot prove "nothing runs". */
async function ensureNothingRunning(rpc: Rpc, why: string): Promise<{ ok: boolean; detail: string }> {
  let detail = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    let st = await rpc.call('gpu.status', {});
    if (st.phase !== 'off' || st.instanceId || readLedger().active) {
      log(`[safety] ${why}: phase ${st.phase}${st.instanceId ? ` instance #${st.instanceId}` : ''} → gpu.clockOut`);
      try {
        st = await rpc.call('gpu.clockOut', { reason: 'clock_out' }, 300_000);
      } catch (e) {
        log(`[safety] clockOut failed: ${errMsg(e)}`);
      }
    }
    let destroyed: number[] = [];
    try {
      destroyed = (await rpc.call('gpu.destroyOrphans', {}, 300_000)).destroyed;
    } catch (e) {
      log(`[safety] destroyOrphans failed: ${errMsg(e)}`);
    }
    if (destroyed.length) log(`[safety] destroyed leftover instance(s): ${destroyed.join(', ')}`);
    st = await rpc.call('gpu.status', {});
    const ledger = readLedger();
    const orphans = st.orphanInstanceIds ?? [];
    detail = `phase=${st.phase} orphanInstanceIds=[${orphans.join(',')}] ledger.active=${ledger.active ? `#${ledger.active.instanceId}` : 'null'} pendingDestroy=[${(ledger.pendingDestroy ?? []).join(',')}] destroyedNow=[${destroyed.join(',')}]`;
    if (st.phase === 'off' && orphans.length === 0 && !ledger.active && (ledger.pendingDestroy ?? []).length === 0 && destroyed.length === 0) {
      log(`[safety] verified nothing running (${why}): ${detail}`);
      return { ok: true, detail };
    }
    log(`[safety] not clean yet (attempt ${attempt}): ${detail}`);
    await sleep(10_000);
  }
  return { ok: false, detail };
}

/** Synchronous last-resort clock-out over the core's HTTP RPC (used from the 'exit' handler). */
function emergencyClockOutSync(reason: string): void {
  if (!safety.gpuMayBeOn || !safety.coreUrl) return;
  try {
    const u = new URL(safety.coreUrl);
    const token = u.searchParams.get('token') ?? '';
    const rpcUrl = `http://${u.host}/rpc`;
    const code =
      "fetch(process.env.OC_RPC,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.OC_TOKEN}," +
      "body:JSON.stringify({method:'gpu.clockOut',params:{reason:'clock_out'}})}).then(r=>r.json()).then(j=>console.log('emergency clockOut ->',JSON.stringify(j).slice(0,200)),e=>{console.error('emergency clockOut failed',String(e));process.exitCode=1})";
    console.error(`${ts()} [safety] ${reason}: synchronous emergency clock-out…`);
    execFileSync(process.execPath, ['-e', code], { env: { ...process.env, OC_RPC: rpcUrl, OC_TOKEN: token }, timeout: 240_000, stdio: 'inherit' });
    safety.gpuMayBeOn = false;
  } catch (e) {
    console.error(`[safety] emergency clock-out failed: ${errMsg(e)} — the server watchdog destroys the instance within 10 min without heartbeats; CHECK console.vast.ai`);
  }
}

let shuttingDown = false;
async function abortRun(reason: string, code: number): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  log(`[safety] ${reason}`);
  try {
    if (current && current.rpc.open) {
      const r = await ensureNothingRunning(current.rpc, reason);
      if (r.ok) safety.gpuMayBeOn = false;
    }
  } catch (e) {
    log(`[safety] cleanup failed: ${errMsg(e)}`);
  }
  emergencyClockOutSync(reason);
  process.exit(code);
}

// Registered before Playwright launches anything, so these run before Playwright's own handlers kill the app.
process.on('exit', () => emergencyClockOutSync('driver exiting with the GPU possibly on'));
process.on('SIGINT', () => void abortRun('SIGINT', 130));
process.on('SIGTERM', () => void abortRun('SIGTERM', 143));
process.on('uncaughtException', (e) => void abortRun(`uncaught exception: ${e.stack ?? e.message}`, 1));
process.on('unhandledRejection', (e) => void abortRun(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 1));
setTimeout(() => void abortRun(`run exceeded the hard limit of ${RUN_HARD_LIMIT_MS / 60_000} min`, 1), RUN_HARD_LIMIT_MS).unref();

// ───────────────────────────── evidence ─────────────────────────────

async function collectEvidence(h: AppHandle | null, tag: string): Promise<void> {
  try {
    if (h?.rpc.open) {
      const text = (await h.rpc.call('gpu.serverLog', { lines: 600 }, 60_000)).text;
      writeFileSync(path.join(OUT, `server-log-${tag}.txt`), text);
      log(`saved gpu.serverLog (${text.length} chars) → server-log-${tag}.txt`);
      const st = await h.rpc.call('gpu.status', {});
      if (st.failureLogPath && existsSync(st.failureLogPath)) {
        copyFileSync(st.failureLogPath, path.join(OUT, path.basename(st.failureLogPath)));
        log(`copied failure log ${st.failureLogPath}`);
      }
    }
  } catch (e) {
    log(`gpu.serverLog failed: ${errMsg(e)}`);
  }
  const logsDir = path.join(DATA_DIR, 'logs');
  if (existsSync(logsDir)) {
    for (const f of readdirSync(logsDir)) {
      const p = path.join(logsDir, f);
      if (/^gpu-.*\.log$/.test(f) && statSync(p).mtimeMs >= runStart - 1000 && !existsSync(path.join(OUT, f))) {
        copyFileSync(p, path.join(OUT, f));
        log(`copied ${p}`);
      }
    }
  }
}

// ───────────────────────────── update test ─────────────────────────────

type UpdateSnap = { state: { status: string; version?: string; percent?: number; message?: string }; currentVersion: string; tokenSource?: string | null };

async function updateTest(): Promise<AppHandle> {
  step('update test');
  const before = exeVersion();
  const latest = latestReleaseVersion();
  const upd: Record<string, unknown> = { installedBefore: before, latestRelease: latest };
  result.update = upd;
  log(`installed exe version ${before}; latest GitHub release ${latest ?? '?'}`);
  let h = await launchApp('installed app (update test)');
  const status0 = await h.rpc.call('gpu.status', {});
  if (status0.phase !== 'off') {
    const r = await ensureNothingRunning(h.rpc, 'GPU on before the update');
    if (!r.ok) throw new Error(`GPU not off before the update: ${r.detail}`);
  }
  if (!latest || cmpSemver(latest, before) <= 0) {
    upd.outcome = 'already latest';
    log('no newer release: skipping the update');
    return h;
  }
  const evalUpdates = <T>(fn: 'getState' | 'check'): Promise<T> =>
    h.page.evaluate((f) => (globalThis as unknown as { obsidian: { updates: Record<string, () => Promise<unknown>> } }).obsidian.updates[f](), fn) as Promise<T>;
  const snap = await evalUpdates<UpdateSnap>('check');
  log(`updates.check → ${JSON.stringify(snap.state)} (current ${snap.currentVersion}, token ${snap.tokenSource ?? '?'})`);
  upd.check = snap.state;
  if (snap.state.status !== 'available') throw new Error(`update check did not offer ${latest}: ${JSON.stringify(snap.state)}`);
  const btn = h.page.locator('[data-testid=update-button][data-status=available]');
  await btn.waitFor({ timeout: 30_000 });
  const label = (await btn.innerText()).replace(/\s+/g, ' ').trim();
  log(`UPDATE button visible: "${label}"`);
  upd.button = label;
  await shot(h.page, '10-update-button');
  const tClick = Date.now();
  await btn.click();
  log('clicked UPDATE');
  const seen: string[] = [];
  let lastKey = '';
  while (!h.isExited()) {
    try {
      const s = await evalUpdates<UpdateSnap>('getState');
      const key = `${s.state.status}${s.state.percent !== undefined ? ` ${Math.floor(s.state.percent / 10) * 10}%` : ''}`;
      if (key !== lastKey) {
        lastKey = key;
        seen.push(`${Math.round((Date.now() - tClick) / 1000)}s ${key}${s.state.message ? `: ${s.state.message}` : ''}`);
        log(`[update] ${key}${s.state.message ? `: ${s.state.message}` : ''}`);
        if (s.state.status === 'downloading' && (s.state.percent ?? 0) > 40 && !seen.some((x) => x.includes('shot'))) {
          await shot(h.page, '11-update-progress');
          seen.push('shot');
        }
        if (s.state.status === 'error') {
          upd.states = seen;
          throw new Error(`update failed: ${s.state.message}`);
        }
      }
    } catch (e) {
      if (h.isExited() || /closed|Target|destroyed/i.test(errMsg(e))) break;
      throw e;
    }
    if (Date.now() - tClick > 10 * 60_000) throw new Error('update did not finish within 10 min');
    await sleep(700);
  }
  await h.exited;
  h.rpc.close();
  current = null;
  safety.coreUrl = null;
  upd.states = seen.filter((s) => s !== 'shot');
  upd.appExitedAfterMs = Date.now() - tClick;
  log(`app quit for the install after ${Math.round((Date.now() - tClick) / 1000)} s; waiting for the installer to relaunch it…`);
  // The NSIS installer (silent, --force-run) replaces the files and starts the new version on its own.
  let relaunchedAt = 0;
  let after = '';
  const tWait = Date.now();
  while (Date.now() - tWait < 6 * 60_000) {
    after = exeVersion();
    if (appPids().length && cmpSemver(after || '0.0.0', before) > 0) {
      relaunchedAt ||= Date.now();
      if (Date.now() - relaunchedAt > 15_000) break;
    } else relaunchedAt = 0;
    await sleep(2000);
  }
  upd.installedAfter = after;
  upd.relaunchedByInstaller = relaunchedAt > 0;
  upd.relaunchAfterMs = relaunchedAt ? relaunchedAt - tClick : null;
  log(`installed exe version now ${after}; installer relaunched the app: ${relaunchedAt > 0}`);
  if (relaunchedAt) await closeAppGracefully('the instance the installer relaunched');
  if (cmpSemver(after || '0.0.0', before) <= 0) throw new Error(`the update did not install (exe still ${after || before})`);
  h = await launchApp('updated app');
  const info = await h.rpc.call('system.info', {});
  await h.page.getByTestId('status-version').waitFor({ timeout: 30_000 });
  const statusText = (await h.page.getByTestId('status-version').innerText()).replace(/\s+/g, ' ').trim();
  upd.runningVersion = info.version;
  upd.statusBar = statusText;
  await shot(h.page, '12-after-update');
  log(`running version ${info.version}; status bar "${statusText}"`);
  if (info.version !== after || !statusText.toUpperCase().includes(after.toUpperCase())) throw new Error(`version mismatch after update: core ${info.version}, exe ${after}, status bar "${statusText}"`);
  upd.outcome = `updated ${before} → ${after} via the UPDATE button`;
  saveResult();
  return h;
}

// ───────────────────────────── chat helpers ─────────────────────────────

interface TurnMetrics {
  prompt: string;
  sentAt: number;
  firstTokenAt?: number;
  ttftMs?: number;
  doneAt?: number;
  assistantMessages: { id: string; firstDeltaAt?: number; completedAt?: number; meta?: Message['meta']; decodeTokPerSec?: number }[];
  tools: { name: string; status: string; input: Record<string, unknown>; result?: string }[];
  permissions: { toolName: string; title: string; decision: string }[];
  finalText?: string;
  error?: string;
}

async function runTurn(h: AppHandle, sessionId: string, prompt: string, timeoutMs: number, allowTool: (toolName: string, input: Record<string, unknown>) => boolean): Promise<TurnMetrics> {
  const m: TurnMetrics = { prompt, sentAt: 0, assistantMessages: [], tools: [], permissions: [] };
  const byId = new Map<string, TurnMetrics['assistantMessages'][number]>();
  const offs: (() => void)[] = [];
  let status: string = 'running';
  let sawRunning = false;
  offs.push(
    h.rpc.on('message.added', (d) => {
      if (d.sessionId !== sessionId || d.message.role !== 'assistant') return;
      const e = { id: d.message.id };
      byId.set(e.id, e);
      m.assistantMessages.push(e);
    }),
    h.rpc.on('message.delta', (d) => {
      if (d.sessionId !== sessionId) return;
      const e = byId.get(d.messageId);
      const now = Date.now();
      if (e && !e.firstDeltaAt) e.firstDeltaAt = now;
      if (!m.firstTokenAt) {
        m.firstTokenAt = now;
        m.ttftMs = now - m.sentAt;
        log(`  first token after ${m.ttftMs} ms (${d.blockType})`);
      }
    }),
    h.rpc.on('message.completed', (d) => {
      if (d.sessionId !== sessionId) return;
      const e = byId.get(d.messageId);
      if (!e) return;
      e.completedAt = Date.now();
      e.meta = d.meta;
      const ct = d.meta?.completionTokens;
      if (ct && e.firstDeltaAt && e.completedAt > e.firstDeltaAt) e.decodeTokPerSec = Math.round((ct / ((e.completedAt - e.firstDeltaAt) / 1000)) * 10) / 10;
      log(`  assistant message done: ${JSON.stringify(d.meta)}${e.decodeTokPerSec ? ` → ${e.decodeTokPerSec} tok/s` : ''}`);
    }),
    h.rpc.on('tool.updated', (d) => {
      if (d.sessionId !== sessionId) return;
      const t: ToolUseBlock = d.tool;
      if (['done', 'error', 'denied', 'interrupted'].includes(t.status)) {
        m.tools.push({ name: t.name, status: t.status, input: t.input, result: t.result?.content?.slice(0, 500) });
        log(`  tool ${t.name} ${t.status}: ${JSON.stringify(t.input).slice(0, 120)} → ${(t.result?.content ?? '').slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }),
    h.rpc.on('permission.requested', (p) => {
      if (p.sessionId !== sessionId) return;
      const ok = allowTool(p.toolName, p.input);
      m.permissions.push({ toolName: p.toolName, title: p.title, decision: ok ? 'allow' : 'deny' });
      log(`  permission ${p.toolName} "${p.title}" → ${ok ? 'allow' : 'deny'}`);
      void shot(h.page, `perm-${p.toolName}-${Date.now()}`).then(() =>
        h.rpc.call('chat.respondPermission', { requestId: p.requestId, decision: ok ? 'allow' : 'deny' }).catch((e) => log(`  respondPermission failed: ${errMsg(e)}`)),
      );
    }),
    h.rpc.on('session.updated', (s) => {
      if (s.id !== sessionId) return;
      status = s.status;
      if (s.status === 'running') sawRunning = true;
    }),
    h.rpc.on('error', (e) => {
      if (e.sessionId === sessionId) {
        m.error = e.message;
        log(`  session error: ${e.message}`);
      }
    }),
  );
  try {
    m.sentAt = Date.now();
    log(`> ${prompt}`);
    await h.rpc.call('chat.send', { sessionId, text: prompt });
    const end = Date.now() + timeoutMs;
    for (;;) {
      await sleep(500);
      if ((sawRunning || Date.now() - m.sentAt > 3000) && status !== 'running') {
        const s = await h.rpc.call('sessions.get', { id: sessionId });
        if (s.status !== 'running') {
          status = s.status;
          break;
        }
      }
      if (Date.now() > end) {
        m.error = `turn timed out after ${Math.round(timeoutMs / 1000)} s`;
        await h.rpc.call('chat.interrupt', { sessionId }).catch(() => undefined);
        break;
      }
      if (h.isExited()) throw new Error('the app exited during the turn');
    }
    m.doneAt = Date.now();
    const s = await h.rpc.call('sessions.get', { id: sessionId });
    const last = [...s.messages].reverse().find((x) => x.role === 'assistant');
    m.finalText = last?.blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim();
    log(`< ${JSON.stringify(m.finalText ?? '').slice(0, 300)} (session ${status}, ${Math.round((m.doneAt - m.sentAt) / 1000)} s)`);
  } finally {
    for (const off of offs) off();
  }
  return m;
}

// ───────────────────────────── phase 1 ─────────────────────────────

async function phase1(h: AppHandle): Promise<boolean> {
  const rpc = h.rpc;
  const p1: Record<string, unknown> = {};
  result.phase1 = p1;

  step('settings sanity');
  let settings = await rpc.call('settings.get', {});
  const v = settings.vast;
  const fix: Partial<Settings['vast']> = {};
  if (v.clockOutMode !== 'destroy') fix.clockOutMode = 'destroy';
  if (!v.clockOutOnQuit) fix.clockOutOnQuit = true;
  if (v.monthlyBudget > 25) fix.monthlyBudget = 25; // only ever lowered
  if (Object.keys(fix).length) {
    log(`settings fix: ${JSON.stringify(fix)}`);
    settings = await rpc.call('settings.update', { patch: { vast: { ...v, ...fix } } });
  }
  const sv = settings.vast;
  const light = sv.profiles.find((p) => p.id === PROFILE_ID);
  p1.settings = { monthlyBudget: sv.monthlyBudget, clockOutMode: sv.clockOutMode, clockOutOnQuit: sv.clockOutOnQuit, image: sv.image, idleMinutes: sv.idleMinutes, heartbeatMinutes: sv.heartbeatMinutes, lightMaxPrice: light?.maxPricePerHour, lightDefaultModel: light?.defaultModelId };
  log(`settings: ${JSON.stringify(p1.settings)}`);
  if (sv.clockOutMode !== 'destroy' || !sv.clockOutOnQuit) throw new Error('settings sanity failed');
  if (sv.monthlyBudget !== 25) log(`note: monthlyBudget is ${sv.monthlyBudget} (not raised)`);

  step('pre-flight: GPU off, budget, credit');
  const pre = await ensureNothingRunning(rpc, 'pre-flight');
  if (!pre.ok) throw new Error(`GPU not clean before clock-in: ${pre.detail}`);
  const key = await rpc.call('gpu.testKey', {}, 60_000);
  const credit = key.creditBalance ?? 0;
  const { spend } = campaignSpend();
  p1.preflight = { credit, campaignSpend: spend, budget: BUDGET_USD };
  log(`Vast key: ${key.ok ? 'ok' : key.message}; credit $${credit.toFixed(2)}; campaign spend $${spend.toFixed(4)} of $${BUDGET_USD.toFixed(2)}`);
  if (!key.ok) throw new Error(`Vast key check failed: ${key.message}`);
  if (credit < MIN_CREDIT_USD) throw new Error(`BUDGET STOP: Vast credit $${credit.toFixed(2)} < $${MIN_CREDIT_USD}`);
  if (spend + RESERVE_USD > BUDGET_USD) throw new Error(`BUDGET STOP: campaign spend $${spend.toFixed(4)} + $${RESERVE_USD} reserve > $${BUDGET_USD}`);

  await gotoGpuView(h.page);
  await shot(h.page, '20-gpu-before');

  step(`clock in ${PROFILE_ID} / ${MODEL_ID}`);
  const tClock = Date.now();
  const phases: { phase: string; atSec: number; message: string }[] = [];
  p1.phases = phases;
  let lastPhase = '';
  let lastLine = '';
  let ready: GpuStatus | null = null;
  const offEvt = rpc.on('gpu.status', (s) => {
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      phases.push({ phase: s.phase, atSec: Math.round((Date.now() - tClock) / 1000), message: s.message });
      log(`[gpu] → ${fmtStatus(s)}`);
      void shot(h.page, `3${phases.length}-gpu-${s.phase}`);
    }
  });
  safety.gpuMayBeOn = true;
  let outcome: 'ready' | 'error' | 'timeout' | 'budget' = 'timeout';
  try {
    const st0 = await rpc.call('gpu.clockIn', { profileId: PROFILE_ID, modelId: MODEL_ID }, 120_000);
    log(`clockIn → ${fmtStatus(st0)}`);
    while (Date.now() - tClock < READY_TIMEOUT_MS) {
      await sleep(POLL_MS);
      if (h.isExited()) throw new Error('the app exited while clocking in');
      const s = await rpc.call('gpu.status', {});
      const line = fmtStatus(s);
      if (line !== lastLine) {
        log(`[poll ${Math.round((Date.now() - tClock) / 1000)}s] ${line}`);
        lastLine = line;
      }
      if (s.phase !== lastPhase) {
        lastPhase = s.phase;
        phases.push({ phase: s.phase, atSec: Math.round((Date.now() - tClock) / 1000), message: s.message });
        await shot(h.page, `3${phases.length}-gpu-${s.phase}`);
      }
      if (s.instanceId && !p1.instance) {
        p1.instance = { id: s.instanceId, gpu: `${s.numGpus}x ${s.gpuName}`, pricePerHour: s.pricePerHour, location: s.location };
        log(`instance #${s.instanceId}: ${s.numGpus}x ${s.gpuName} $${s.pricePerHour?.toFixed(3)}/h ${s.location}`);
      }
      const live = campaignSpend(s.sessionCost).spend;
      if (live > BUDGET_USD) {
        outcome = 'budget';
        log(`BUDGET STOP during clock-in: campaign spend $${live.toFixed(4)} > $${BUDGET_USD}`);
        break;
      }
      if (s.phase === 'ready') {
        ready = s;
        outcome = 'ready';
        break;
      }
      if (s.phase === 'error' || s.phase === 'off') {
        outcome = 'error';
        p1.error = s.lastError ?? s.message;
        log(`clock-in FAILED: ${s.lastError ?? s.message}`);
        break;
      }
    }
  } finally {
    offEvt();
  }
  p1.outcome = outcome;
  p1.secondsToOutcome = Math.round((Date.now() - tClock) / 1000);
  saveResult();
  if (!ready) {
    await gotoGpuView(h.page);
    await shot(h.page, '39-gpu-failed');
    await collectEvidence(h, 'clockin-failed');
    return false;
  }

  step('ready');
  p1.ready = { secondsToReady: Math.round((Date.now() - tClock) / 1000), serverMode: ready.serverMode ?? null, droppedFeatures: ready.droppedFeatures ?? [], serverContextLength: ready.serverContextLength ?? null, endpoint: ready.endpoint ? 'tunnel up' : null, sessionCostAtReady: ready.sessionCost };
  log(`READY in ${p1.secondsToOutcome} s: serverMode=${ready.serverMode ?? '?'} dropped=[${(ready.droppedFeatures ?? []).join(',')}] ctx=${ready.serverContextLength ?? '?'}`);
  await gotoGpuView(h.page);
  await shot(h.page, '40-gpu-ready');
  // Always keep the live server log (in a safe mode it starts with the failed full-config attempts).
  await collectEvidence(h, ready.serverMode && ready.serverMode !== 'full' ? 'ready-safe-mode' : 'ready');

  step('chat session on the vast model');
  const models = await rpc.call('models.list', {});
  const vm = models.models.find((x) => x.ref.provider === 'vast');
  p1.vastModel = vm ? { ref: vm.ref, status: vm.status, contextLength: vm.contextLength, vision: vm.supportsVision } : null;
  log(`vast model in models.list: ${JSON.stringify(p1.vastModel)}`);
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'oc-live-'));
  writeFileSync(path.join(cwd, 'README.txt'), 'Obsidian Code live test folder.\n');
  const title = `Live ${runId}`;
  const sess = await rpc.call('sessions.create', { cwd, title, model: { provider: 'vast', model: ready.modelId ?? MODEL_ID }, permissionMode: 'default' });
  log(`session ${sess.id} in ${cwd} (thinking ${sess.thinking})`);
  p1.session = { id: sess.id, cwd, thinking: sess.thinking };
  try {
    await h.page.locator(`[data-testid=session-row][title="${title}"]`).first().click({ timeout: 10_000 });
  } catch (e) {
    log(`could not open the session in the UI: ${errMsg(e)}`);
  }
  await sleep(800);

  step('turn 1: pong');
  const t1 = await runTurn(h, sess.id, 'Reply with exactly: pong', 5 * 60_000, () => false);
  p1.turn1 = t1;
  await shot(h.page, '50-chat-pong');
  const pongOk = /\bpong\b/i.test(t1.finalText ?? '') && !t1.error;

  step('turn 2: Bash tool (node -v on this PC)');
  const localNode = execFileSync('node', ['-v'], { encoding: 'utf8' }).trim();
  const t2 = await runTurn(h, sess.id, 'Use the Bash tool to run: node -v, then tell me the version', 8 * 60_000, (name, input) => name === 'Bash' && /node\s+(-v|--version)/.test(String(input.command ?? '')));
  p1.turn2 = t2;
  p1.localNodeVersion = localNode;
  await shot(h.page, '51-chat-tool');
  const bash = t2.tools.find((t) => t.name === 'Bash' && t.status === 'done');
  const toolOk = !!bash && (bash.result ?? '').includes(localNode) && (t2.finalText ?? '').includes(localNode.replace(/^v/, '')) && !t2.error;
  p1.checks = { pongOk, toolOk, bashResult: bash?.result ?? null };
  log(`checks: pong ${pongOk ? 'OK' : 'FAIL'}; tool ${toolOk ? 'OK' : 'FAIL'} (local node ${localNode})`);
  const statusAfter = await rpc.call('gpu.status', {});
  p1.sessionCostBeforeClockOut = statusAfter.sessionCost;
  saveResult();
  return pongOk && toolOk;
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<number> {
  log(`run ${runId}: scenario ${SCENARIO}, budget $${BUDGET_USD}, campaign start ${new Date(campaignStart()).toISOString()}, out ${OUT}`);
  if (!existsSync(EXE)) throw new Error(`installed app not found: ${EXE}`);
  result.campaignSpendBefore = campaignSpend().spend;
  step('close the user\'s running Obsidian Code');
  await closeAppGracefully('the user\'s Obsidian Code');

  let h: AppHandle | null = null;
  let ok = false;
  try {
    if ((SCENARIO === 'update' || SCENARIO === 'phase1') && !NO_UPDATE) h = await updateTest();
    else h = await launchApp('installed app');
    result.appVersion = (await h.rpc.call('system.info', {})).version;

    switch (SCENARIO) {
      case 'status': {
        const st = await h.rpc.call('gpu.status', {});
        const key = await h.rpc.call('gpu.testKey', {}, 60_000);
        const hist = await h.rpc.call('gpu.history', { limit: 5 });
        log(`status: ${fmtStatus(st)}; credit $${key.creditBalance?.toFixed(2) ?? '?'}; month $${st.monthCost.toFixed(4)} / $${st.monthlyBudget}`);
        for (const r of hist) log(`  history: #${r.instanceId} ${r.modelId} ${r.gpuName} $${r.cost.toFixed(4)} ${r.endReason ?? 'open'} ${new Date(r.startedAt).toISOString()}`);
        result.status = { phase: st.phase, credit: key.creditBalance, monthCost: st.monthCost };
        ok = (await ensureNothingRunning(h.rpc, 'status check')).ok;
        break;
      }
      case 'cleanup':
        ok = (await ensureNothingRunning(h.rpc, 'cleanup')).ok;
        break;
      case 'update':
        ok = true;
        break;
      case 'phase1':
        ok = await phase1(h);
        break;
      default:
        throw new Error(`unknown scenario ${SCENARIO}`);
    }
  } catch (e) {
    ok = false;
    result.error = errMsg(e);
    log(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    if (h && !h.isExited()) await collectEvidence(h, 'driver-error');
  } finally {
    if (h && !h.isExited() && h.rpc.open) {
      step('clock out + verify nothing is running');
      const tOut = Date.now();
      const clean = await ensureNothingRunning(h.rpc, 'end of run').catch((e) => ({ ok: false, detail: errMsg(e) }));
      result.finalState = clean.detail;
      result.clockOutSeconds = Math.round((Date.now() - tOut) / 1000);
      if (clean.ok) safety.gpuMayBeOn = false;
      else ok = false;
      try {
        await gotoGpuView(h.page);
        await shot(h.page, '90-gpu-after');
        const hist = await h.rpc.call('gpu.history', { limit: 1 });
        if (hist[0] && hist[0].startedAt >= runStart) {
          result.runRecord = hist[0];
          log(`run record: #${hist[0].instanceId} ${hist[0].gpuName} $${hist[0].pricePerHour.toFixed(3)}/h cost $${hist[0].cost.toFixed(4)} (${hist[0].endReason})`);
        }
      } catch {
        /* ignore */
      }
      await closeApp(h);
    }
    const s = campaignSpend();
    result.campaignSpendAfter = s.spend;
    result.ok = ok;
    result.finishedAt = new Date().toISOString();
    saveResult();
    log(`campaign spend now $${s.spend.toFixed(4)} (${s.records.length} record(s) since the campaign start). Result: ${ok ? 'PASS' : 'FAIL'} → ${path.join(OUT, 'result.json')}`);
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
    // Playwright / ws handles may keep the loop alive.
    setTimeout(() => process.exit(code), 500).unref();
  },
  (e) => void abortRun(`main crashed: ${errMsg(e)}`, 1),
);
