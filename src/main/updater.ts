// Auto-update (owner: platform): electron-updater against the PRIVATE GitHub repo ArtemChig/obsidian-code, exposed to
// the renderer as window.obsidian.updates (getState / check / update / onState). The state machine lives in
// ./updater-core (unit-tested); this file adapts NsisUpdater, the IPC and the quit sequence to it.
//
// * Token: resolved at every check — the 'github.updateToken' secret, else `gh auth token`, else an actionable error.
//   It is handed to electron-updater in memory only; never to the renderer, never to logs (the logger redacts it).
// * Checks: 20 s after startup, every 30 min, and on demand. autoDownload is off: the user's click downloads, then the
//   graceful quit runs, then the installer starts silently and relaunches the app (quitAndInstall(true, true)).
// * Unsigned builds: electron-updater verifies the downloaded installer's Authenticode signature only when
//   app-update.yml carries a `publisherName`. electron-builder writes one only for signed builds with
//   win.verifyUpdateCodeSignature on; electron-builder.yml sets verifyUpdateCodeSignature: false, so unsigned updates
//   are not rejected (the download is still checked against the sha512 in latest.yml). Remove that line once the app
//   is code-signed.
// * Off in dev runs, unpacked folders and the portable exe — unless OBSIDIAN_UPDATE_TEST_FEED=<http url> switches to a
//   'generic' feed (tests). With OBSIDIAN_UPDATE_TEST_INSTALL=record as well, the install step writes
//   <dataDir>/update-install-record.json and quits instead of running the installer.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { NsisUpdater, type Logger } from 'electron-updater';
import { UPDATE_TOKEN_SECRET, type UpdateSnapshot, type UpdateState } from '@shared/updates';
import {
  createGhRunner,
  createUpdateController,
  detectUpdateSupport,
  normalizeReleaseNotes,
  nsisUpdaterFlags,
  redact,
  resolveUpdateToken,
  type FeedConfig,
  type UpdateController,
  type UpdaterAdapter,
} from './updater-core';

const PRODUCT_FILENAME = 'Obsidian Code';
const INSTALL_WATCHDOG_MS = 30_000;
const STATE_CHANNEL = 'obsidian:updates:state';

export interface UpdaterHost {
  dataDir: string;
  getSecret(name: string): string | null;
  /** The graceful quit sequence; afterwards quits pass straight through (QuitGate.prepareForQuit). */
  prepareQuit(): Promise<void>;
  /** Whether the shutdown finished (recorded by the test install hook). */
  shutdownComplete(): boolean;
  trusted(event: Pick<IpcMainInvokeEvent, 'senderFrame'>): boolean;
}

export interface AppUpdater {
  controller: UpdateController;
  start(): void;
  stop(): void;
}

/** Tokens seen this run, so every log line can be scrubbed. */
const knownTokens = new Set<string>();

function makeLogger(): Logger {
  const scrub = (m: unknown): string => redact(m instanceof Error ? (m.stack ?? m.message) : String(m), [...knownTokens]);
  return {
    info: (m?: unknown) => console.log(`[updater] ${scrub(m)}`),
    warn: (m?: unknown) => console.warn(`[updater] ${scrub(m)}`),
    error: (m?: unknown) => console.error(`[updater] ${scrub(m)}`),
    debug: () => undefined,
  };
}

function broadcast(s: UpdateSnapshot): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(STATE_CHANNEL, s);
  }
}

function errorFile(dataDir: string): string {
  return join(dataDir, 'update-error.json');
}

/** An install that failed after the app had already shut down is reported again on the next start. */
function takePersistedError(dataDir: string): UpdateState | undefined {
  const file = errorFile(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { message?: unknown };
    return typeof v.message === 'string' ? { status: 'error', message: v.message, during: 'install' } : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(file, { force: true });
  }
}

function createNsisAdapter(opts: { logger: Logger; recordFile: string | null; forceDev: boolean; host: UpdaterHost; onError: (e: Error) => void }): UpdaterAdapter {
  const u = new NsisUpdater();
  u.logger = opts.logger;
  // autoDownload off, install only through update(), no differential download (private repo: see nsisUpdaterFlags).
  Object.assign(u, nsisUpdaterFlags());
  // A dev run only reaches here with OBSIDIAN_UPDATE_TEST_FEED (isUpdaterActive() is false for unpackaged apps). It has
  // no resources/app-update.yml (cache dir name, signature settings), so give it one in the data dir.
  u.forceDevUpdateConfig = opts.forceDev;
  if (opts.forceDev) {
    const devConfig = join(opts.host.dataDir, 'dev-app-update.yml');
    writeFileSync(devConfig, 'provider: generic\nurl: http://127.0.0.1/\nupdaterCacheDirName: obsidian-code-updater-dev\n');
    u.updateConfigPath = devConfig;
  }
  u.on('error', (e: Error) => opts.onError(e));

  return {
    setFeed(feed: FeedConfig) {
      if (feed.provider === 'github') {
        if (!feed.token) {
          // Public repository: the anonymous GitHub client (release feed + public download URLs).
          u.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo, private: false, releaseType: 'release' });
          return;
        }
        knownTokens.add(feed.token);
        // electron-updater picks the private-repo client whenever a token is present. `private: false` here only stops
        // it from preferring a GH_TOKEN/GITHUB_TOKEN environment variable over the token we resolved.
        u.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo, private: false, token: feed.token, releaseType: 'release' });
      } else {
        u.setFeedURL({ provider: 'generic', url: feed.url });
      }
    },
    async check() {
      const r = await u.checkForUpdates();
      if (!r) return null;
      return {
        available: r.isUpdateAvailable,
        version: r.updateInfo.version,
        releaseNotes: normalizeReleaseNotes(r.updateInfo.releaseNotes),
        releaseDate: r.updateInfo.releaseDate ?? null,
      };
    },
    async download(onProgress) {
      const listener = (p: { percent: number; bytesPerSecond: number }): void => onProgress(p);
      u.on('download-progress', listener);
      try {
        await u.downloadUpdate();
      } finally {
        u.removeListener('download-progress', listener);
      }
    },
    install(version) {
      if (opts.recordFile) {
        const installerPath = (u as unknown as { installerPath: string | null }).installerPath;
        writeFileSync(
          opts.recordFile,
          JSON.stringify(
            { version, installerPath, isSilent: true, isForceRunAfter: true, shutdownComplete: opts.host.shutdownComplete(), at: Date.now() },
            null,
            2,
          ),
        );
        setImmediate(() => app.quit());
        return;
      }
      u.quitAndInstall(true, true);
    },
  };
}

export function initUpdater(host: UpdaterHost): AppUpdater {
  const testFeed = process.env.OBSIDIAN_UPDATE_TEST_FEED;
  const support = detectUpdateSupport({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    productFilename: PRODUCT_FILENAME,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    testFeed,
  });
  const recordFile = support.ok && support.testMode && process.env.OBSIDIAN_UPDATE_TEST_INSTALL === 'record' ? join(host.dataDir, 'update-install-record.json') : null;
  const logger = makeLogger();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let controller: UpdateController | null = null;

  const adapter: UpdaterAdapter | null = support.ok
    ? createNsisAdapter({
        logger,
        recordFile,
        forceDev: !app.isPackaged,
        host,
        onError: (e) => {
          // Check/download errors reach the controller through their promises; only the installer spawn reports here.
          if (controller?.snapshot().state.status === 'installing') controller.installFailed(e);
        },
      })
    : null;

  const runGh = createGhRunner();
  controller = createUpdateController({
    currentVersion: app.getVersion(),
    support,
    initialState: takePersistedError(host.dataDir),
    updater: adapter ?? {
      setFeed: () => undefined,
      check: async () => null,
      download: async () => undefined,
      install: () => undefined,
    },
    resolveToken: () => resolveUpdateToken({ getSecret: () => host.getSecret(UPDATE_TOKEN_SECRET), runGh }),
    prepareQuit: async () => {
      await host.prepareQuit();
      // If the installer never takes over, do not leave a shut-down app behind.
      watchdog = setTimeout(() => controller?.installFailed(new Error('The installer did not start within 30 s')), INSTALL_WATCHDOG_MS);
    },
    onInstallFailed: (message) => {
      if (watchdog) clearTimeout(watchdog);
      // The core is already closed: restart the current version and show the error there.
      try {
        writeFileSync(errorFile(host.dataDir), JSON.stringify({ message, at: Date.now() }));
      } catch {
        /* best effort */
      }
      app.relaunch();
      app.exit(0);
    },
    broadcast,
    log: (m) => logger.info(m),
    firstCheckDelayMs: support.ok && support.testMode ? 1_500 : undefined,
  });
  const ctl = controller;

  ipcMain.handle('obsidian:updates:getState', (event) => (host.trusted(event) ? ctl.snapshot() : null));
  ipcMain.handle('obsidian:updates:check', (event) => (host.trusted(event) ? ctl.check() : null));
  // Returns at once; progress arrives as state broadcasts (the download can take minutes).
  ipcMain.handle('obsidian:updates:update', (event) => {
    if (!host.trusted(event)) return null;
    void ctl.update();
    return ctl.snapshot();
  });

  if (!support.ok) logger.info(`updates off: ${support.reason}`);
  return {
    controller: ctl,
    start: () => ctl.start(),
    stop: () => ctl.stop(),
  };
}
