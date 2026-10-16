// Auto-update logic without Electron (owner: platform): token resolution, environment detection, error wording and
// the update state machine. src/main/updater.ts wires it to electron-updater, IPC and the quit sequence; the unit
// tests drive it with fakes (tests/unit/platform/updater.test.ts).
//
// One click = update: update() checks if needed, downloads, then runs the app's graceful quit sequence (session flush,
// GPU clock-out when "clock out on quit" is on, core close) and only THEN starts the installer, which restarts the app.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { releaseUrlFor, UPDATE_REPO, type UpdateSnapshot, type UpdateState, type UpdateTokenSource } from '@shared/updates';

export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 30 * 60_000;
export const GH_TIMEOUT_MS = 5_000;

// ───────────────────────────── redaction ─────────────────────────────

const TOKEN_PATTERNS = [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\b(token|bearer)\s+[A-Za-z0-9_.-]{20,}/gi];

/** Remove known secrets and anything that looks like a GitHub token from a message bound for logs or the renderer. */
export function redact(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('***');
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, (m) => (/^(token|bearer)\s/i.test(m) ? `${m.split(/\s+/)[0]} ***` : '***'));
  return out;
}

// ───────────────────────────── token resolution ─────────────────────────────

export type GhResult = { ok: true; token: string } | { ok: false; reason: 'not-found' | 'timeout' | 'not-signed-in' | 'error'; detail?: string };

export interface TokenResolution {
  token: string | null;
  source: UpdateTokenSource;
  note: string | null;
}

const GH_NOTES: Record<Exclude<GhResult, { ok: true }>['reason'], string> = {
  'not-found': 'GitHub CLI not found',
  timeout: 'GitHub CLI did not answer within 5 s',
  'not-signed-in': 'GitHub CLI is not signed in (run gh auth login)',
  error: 'GitHub CLI failed',
};

/** Optional token for update checks, in order: the saved secret, then `gh auth token`, else none (with why). */
export async function resolveUpdateToken(deps: { getSecret: () => string | null; runGh: () => Promise<GhResult> }): Promise<TokenResolution> {
  let secret: string | null = null;
  try {
    secret = deps.getSecret()?.trim() || null;
  } catch {
    secret = null;
  }
  if (secret) return { token: secret, source: 'secret', note: null };
  let gh: GhResult;
  try {
    gh = await deps.runGh();
  } catch (err) {
    gh = { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (gh.ok) return { token: gh.token, source: 'gh', note: null };
  return { token: null, source: 'none', note: GH_NOTES[gh.reason] };
}

/** Where to look for gh.exe: PATH first, then the MSI and per-user (winget) install folders. */
export function ghCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = ['gh'];
  const pf = env.ProgramFiles || 'C:\\Program Files';
  list.push(join(pf, 'GitHub CLI', 'gh.exe'), 'C:\\Program Files\\GitHub CLI\\gh.exe');
  if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'));
  return [...new Set(list)];
}

export interface RunResult {
  code: number | null;
  stdout: string;
  notFound: boolean;
  timedOut: boolean;
  error?: string;
}

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Run a command without a shell, capped at `timeoutMs` (the process is killed after that). Never throws. */
export const runCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      resolve({ code: null, stdout: '', notFound: (err as NodeJS.ErrnoException).code === 'ENOENT', timedOut: false, error: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done({ code: null, stdout, notFound: false, timedOut: true });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < 4096) stdout += d;
    });
    child.on('error', (err: NodeJS.ErrnoException) => done({ code: null, stdout, notFound: err.code === 'ENOENT', timedOut: false, error: err.message }));
    child.on('close', (code) => done({ code, stdout, notFound: false, timedOut: false }));
  });

/** `gh auth token`, trying each candidate until one exists. The token is returned, never logged. */
export function createGhRunner(opts: { candidates?: string[]; timeoutMs?: number; run?: CommandRunner } = {}): () => Promise<GhResult> {
  const candidates = opts.candidates ?? ghCandidates();
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
  const run = opts.run ?? runCommand;
  return async () => {
    for (const file of candidates) {
      if (file !== 'gh' && !existsSync(file)) continue;
      const r = await run(file, ['auth', 'token'], timeoutMs);
      if (r.notFound) continue;
      if (r.timedOut) return { ok: false, reason: 'timeout' };
      const token = r.stdout.trim();
      if (r.code === 0 && /^\S{20,}$/.test(token)) return { ok: true, token };
      if (r.code !== null && r.code !== 0) return { ok: false, reason: 'not-signed-in' };
      return { ok: false, reason: 'error', detail: r.error };
    }
    return { ok: false, reason: 'not-found' };
  };
}

// ───────────────────────────── where updates can run ─────────────────────────────

export type UpdateFeed = { kind: 'github' } | { kind: 'generic'; url: string };
export type UpdateSupport = { ok: true; feed: UpdateFeed; testMode: boolean } | { ok: false; reason: string };

/**
 * Updates run only in the installed (NSIS) app. Dev runs, an unpacked folder (release/win-unpacked) and the portable
 * exe are reported as unsupported — unless OBSIDIAN_UPDATE_TEST_FEED points at a local feed (tests).
 */
export function detectUpdateSupport(env: {
  platform: string;
  isPackaged: boolean;
  execPath: string;
  productFilename: string;
  portableFile?: string;
  testFeed?: string;
  exists?: (p: string) => boolean;
}): UpdateSupport {
  const feed = env.testFeed?.trim();
  if (feed) {
    if (!/^https?:\/\/[^\s]+$/i.test(feed)) return { ok: false, reason: 'OBSIDIAN_UPDATE_TEST_FEED must be an http(s) URL' };
    return { ok: true, feed: { kind: 'generic', url: feed }, testMode: true };
  }
  if (env.platform !== 'win32') return { ok: false, reason: 'updates are only published for Windows' };
  if (env.portableFile) return { ok: false, reason: 'portable build — use the installer to get automatic updates' };
  if (!env.isPackaged) return { ok: false, reason: 'development build — updates run in the installed app only' };
  const exists = env.exists ?? existsSync;
  if (!exists(join(dirname(env.execPath), `Uninstall ${env.productFilename}.exe`))) {
    return { ok: false, reason: 'unpacked build (not installed) — install it with the Setup exe to get automatic updates' };
  }
  return { ok: true, feed: { kind: 'github' }, testMode: false };
}

// ───────────────────────────── error wording ─────────────────────────────

/** A short, actionable message for an updater error. Tokens are redacted. */
export function friendlyUpdateError(err: unknown, secrets: readonly (string | null | undefined)[] = []): string {
  const e = err as { code?: string; message?: string; statusCode?: number } | null;
  const raw = redact(String(e?.message ?? err ?? 'Unknown error'), secrets);
  const code = e?.code ?? '';
  const status = e?.statusCode ?? Number(/\b(?:HttpError:\s*|status(?:Code)?[ :=]+)(\d{3})\b/i.exec(raw)?.[1] ?? NaN);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(`${code} ${raw}`)) {
    return 'Could not reach the update server (offline?). It will try again later.';
  }
  if (status === 403 || status === 429 || /rate limit/i.test(raw)) {
    return 'GitHub is limiting update checks from this network right now. It will try again later.';
  }
  if (status === 401 || /\b401\b|Bad credentials/i.test(raw)) {
    return 'GitHub rejected the token (401). Sign in again with gh auth login, or save a new token in Settings → About & updates.';
  }
  if (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || status === 404) {
    return `No published release found in ${UPDATE_REPO.owner}/${UPDATE_REPO.repo} (or the token cannot read that repository).`;
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_ASSET_NOT_FOUND') {
    return 'The latest release is missing its update files (latest.yml / installer). It may still be uploading — try again in a minute.';
  }
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'The downloaded installer failed signature verification, so it was not installed.';
  if (/sha512 checksum mismatch/i.test(raw)) return 'The download was corrupted (checksum mismatch). Try again.';
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}…` : firstLine || 'Unknown update error';
}

/** releaseNotes from latest.yml can be a string or a per-version list. */
export function normalizeReleaseNotes(notes: unknown): string | null {
  if (typeof notes === 'string') return notes.trim() || null;
  if (Array.isArray(notes)) {
    const parts = notes
      .map((n) => (n && typeof n === 'object' ? (n as { version?: unknown; note?: unknown }) : null))
      .filter((n): n is { version?: unknown; note?: unknown } => !!n && typeof n.note === 'string' && n.note.trim() !== '')
      .map((n) => (typeof n.version === 'string' ? `### ${n.version}\n\n${String(n.note).trim()}` : String(n.note).trim()));
    return parts.length ? parts.join('\n\n') : null;
  }
  return null;
}

// ───────────────────────────── the state machine ─────────────────────────────

/**
 * The electron-updater NsisUpdater flags (applied in updater.ts). disableDifferentialDownload: for a PRIVATE GitHub repo
 * electron-updater resolves the installer to an api.github.com asset URL and looks for the blockmap at "<that URL>.blockmap",
 * which does not exist ("Cannot parse blockmap … incorrect header check" on every update since v1.0.1, live 2026-10-13); it
 * then falls back to the full download anyway. Skipping the differential attempt saves that failing request and the
 * misleading error in the log.
 */
export function nsisUpdaterFlags(): {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  disableDifferentialDownload: boolean;
} {
  return {
    autoDownload: false,
    // Install only through update() (graceful quit first), never silently when the user quits.
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableWebInstaller: true,
    disableDifferentialDownload: true,
  };
}

export type FeedConfig =
  | { provider: 'github'; owner: string; repo: string; /** Absent = anonymous (public repository). */ token?: string }
  | { provider: 'generic'; url: string };

export interface CheckOutcome {
  available: boolean;
  version: string;
  releaseNotes: string | null;
  releaseDate: string | null;
}

/** The narrow slice of electron-updater the controller needs (src/main/updater.ts adapts NsisUpdater to it). */
export interface UpdaterAdapter {
  setFeed(feed: FeedConfig): void;
  /** Null when the updater is inactive. */
  check(): Promise<CheckOutcome | null>;
  download(onProgress: (p: { percent: number; bytesPerSecond: number }) => void): Promise<void>;
  /** Start the installer (silent, run the app afterwards) and quit. Synchronous like quitAndInstall. */
  install(version: string): void;
}

export interface UpdateControllerDeps {
  currentVersion: string;
  support: UpdateSupport;
  updater: UpdaterAdapter;
  resolveToken: () => Promise<TokenResolution>;
  /** The app's graceful quit sequence; once it resolves the next quit must pass straight through. Never rejects. */
  prepareQuit: () => Promise<void>;
  /** The installer could not be started after prepareQuit (the app is half shut down: the host recovers). */
  onInstallFailed?: (message: string) => void;
  broadcast: (s: UpdateSnapshot) => void;
  /** State to start in (e.g. an install error persisted by the previous run). */
  initialState?: UpdateState;
  now?: () => number;
  log?: (msg: string) => void;
  firstCheckDelayMs?: number;
  intervalMs?: number;
}

export interface UpdateController {
  snapshot(): UpdateSnapshot;
  check(): Promise<UpdateSnapshot>;
  /** One click: check if needed → download → graceful quit → install + restart. Resolves when the flow ends. */
  update(): Promise<UpdateSnapshot>;
  /** The installer failed asynchronously (spawn error) while installing. */
  installFailed(err: unknown): void;
  start(): void;
  stop(): void;
}

const BUSY: ReadonlySet<UpdateState['status']> = new Set(['downloading', 'downloaded', 'installing']);

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  let state: UpdateState = deps.support.ok ? (deps.initialState ?? { status: 'idle' }) : { status: 'unsupported', reason: deps.support.reason };
  let lastCheckedAt: number | null = null;
  let tokenSource: UpdateTokenSource | null = deps.support.ok && deps.support.feed.kind === 'generic' ? 'not-needed' : null;
  let tokenNote: string | null = null;
  let token: string | null = null;
  let checking: Promise<UpdateSnapshot> | null = null;
  let updating: Promise<UpdateSnapshot> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastBroadcastPercent = -1;

  const releaseUrl = (): string | null => {
    if (!deps.support.ok || deps.support.feed.kind !== 'github') return null;
    const v = 'version' in state ? state.version : null;
    return v ? releaseUrlFor(v) : null;
  };

  const snapshot = (): UpdateSnapshot => ({
    state,
    currentVersion: deps.currentVersion,
    lastCheckedAt,
    tokenSource,
    tokenNote,
    releaseUrl: releaseUrl(),
  });

  const set = (next: UpdateState): void => {
    state = next;
    lastBroadcastPercent = next.status === 'downloading' ? Math.floor(next.percent) : -1;
    try {
      deps.broadcast(snapshot());
    } catch (err) {
      log(`broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const fail = (err: unknown, during: 'check' | 'download' | 'install'): void => {
    const message = friendlyUpdateError(err, [token]);
    log(`${during} failed: ${redact(err instanceof Error ? (err.stack ?? err.message) : String(err), [token])}`);
    set({ status: 'error', message, during });
  };

  const doCheck = async (): Promise<UpdateSnapshot> => {
    if (!deps.support.ok) return snapshot();
    set({ status: 'checking' });
    try {
      if (deps.support.feed.kind === 'github') {
        const t = await deps.resolveToken();
        tokenSource = t.source;
        tokenNote = t.note;
        token = t.token;
        // The repository is public: without a token the releases are read anonymously (a token only lifts GitHub's
        // rate limit). Every installed copy, with or without the GitHub CLI, gets updates.
        if (!t.token) {
          tokenSource = 'public';
          deps.updater.setFeed({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo });
        } else {
          deps.updater.setFeed({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo, token: t.token });
        }
      } else {
        deps.updater.setFeed({ provider: 'generic', url: deps.support.feed.url });
      }
      const r = await deps.updater.check();
      lastCheckedAt = now();
      if (!r) set({ status: 'unsupported', reason: 'the updater is inactive in this build' });
      else if (r.available) set({ status: 'available', version: r.version, releaseNotes: r.releaseNotes, releaseDate: r.releaseDate });
      else set({ status: 'not-available', checkedAt: lastCheckedAt });
    } catch (err) {
      lastCheckedAt = now();
      fail(err, 'check');
    }
    return snapshot();
  };

  const check = (): Promise<UpdateSnapshot> => {
    if (!deps.support.ok || BUSY.has(state.status) || updating) return Promise.resolve(snapshot());
    checking ??= doCheck().finally(() => {
      checking = null;
    });
    return checking;
  };

  const install = async (version: string): Promise<void> => {
    set({ status: 'installing', version });
    // Session flush, GPU clock-out (when "clock out on quit" is on) and core close finish BEFORE the installer starts:
    // the NSIS installer force-closes a still-running app after ~2 s, which would cut a clock-out short.
    await deps.prepareQuit().catch((err: unknown) => log(`prepareQuit failed: ${String(err)}`));
    try {
      deps.updater.install(version);
    } catch (err) {
      installFailed(err);
    }
  };

  const installFailed = (err: unknown): void => {
    if (state.status !== 'installing') return;
    fail(err, 'install');
    deps.onInstallFailed?.(friendlyUpdateError(err, [token]));
  };

  const doUpdate = async (): Promise<UpdateSnapshot> => {
    if (state.status === 'downloaded') {
      await install(state.version);
      return snapshot();
    }
    if (state.status !== 'available') {
      if (checking) await checking;
      else await doCheck();
    }
    if (state.status !== 'available') return snapshot();
    const version = state.version;
    set({ status: 'downloading', version, percent: 0, bytesPerSecond: 0 });
    try {
      await deps.updater.download((p) => {
        if (state.status !== 'downloading') return;
        const percent = Math.max(0, Math.min(100, Number.isFinite(p.percent) ? p.percent : 0));
        const next: UpdateState = { status: 'downloading', version, percent, bytesPerSecond: Math.max(0, p.bytesPerSecond || 0) };
        // One broadcast per whole percent; in between only the snapshot is refreshed.
        if (Math.floor(percent) !== lastBroadcastPercent) set(next);
        else state = next;
      });
    } catch (err) {
      fail(err, 'download');
      return snapshot();
    }
    set({ status: 'downloaded', version });
    await install(version);
    return snapshot();
  };

  const update = (): Promise<UpdateSnapshot> => {
    if (!deps.support.ok || state.status === 'installing') return Promise.resolve(snapshot());
    updating ??= doUpdate().finally(() => {
      updating = null;
    });
    return updating;
  };

  return {
    snapshot,
    check,
    update,
    installFailed,
    start() {
      if (!deps.support.ok || firstTimer || interval) return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        void check();
      }, deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
      interval = setInterval(() => void check(), deps.intervalMs ?? CHECK_INTERVAL_MS);
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (interval) clearInterval(interval);
      firstTimer = null;
      interval = null;
    },
  };
}
