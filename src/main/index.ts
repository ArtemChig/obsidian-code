// Electron main process (owner: platform).
// Starts the core in-process (createCore + NativeBridge), opens the window (custom title bar with the Windows
// controls overlay), tray (Open / Clock in / Clock out / Quit), IPC for the preload, launch-at-login, and the
// graceful quit sequence (clock out the GPU if configured, flush, close).

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
  type OpenDialogOptions,
} from 'electron';
import { createCore, type CoreHandle } from '@core/index';
import { loadServerScripts, resolveResourcesDir } from '@core/gpu/server-scripts';
import { getRipgrepPath } from '@core/tools/lib/ripgrep';
import { checkOpenPath, checkRevealPath } from './open-path';
import type { NativeBridge } from '@core/contracts';
import type { GpuStatus, Settings } from '@shared/types';
import { createAttentionRouter, type AttentionRouter } from './attention';

const APP_ID = 'com.obsidian.code';
const BG = '#0B1215';
const QUIT_CLOCK_OUT_TIMEOUT_MS = 20_000;
const QUIT_CLOSE_TIMEOUT_MS = 15_000;
const TRAY_CLOCK_IN_PROFILE = 'standard';

// Data dir: %APPDATA%/obsidian-code (not "Obsidian Code"), overridable for tests. userData follows it so the
// single-instance lock and Chromium profile are isolated per data dir.
app.setPath('userData', process.env.OBSIDIAN_CODE_DATA_DIR ?? join(app.getPath('appData'), 'obsidian-code'));
const dataDir = app.getPath('userData');

// Where core finds repo resources (resources/server/bootstrap.sh, icons…). Packaged: unpacked next to app.asar.
process.env.OBSIDIAN_RESOURCES_DIR ??= app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : join(app.getAppPath(), 'resources');
process.env.OBSIDIAN_APP_VERSION ??= app.getVersion();
const resourcesDir = process.env.OBSIDIAN_RESOURCES_DIR;
const iconPng = join(resourcesDir, 'icons', 'icon.png');
const iconIco = join(resourcesDir, 'icons', 'icon.ico');
const trayPng = join(resourcesDir, 'icons', 'tray.png');

if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

let core: CoreHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let attention: AttentionRouter | null = null;
const liveNotifications = new Set<Notification>();

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] || '' : '';
const rendererIndex = join(__dirname, '../renderer/index.html');

function loadImage(path: string): NativeImage | undefined {
  try {
    const img = nativeImage.createFromPath(path);
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ───────────────────────────── notifications / native bridge ─────────────────────────────

function showNotification(title: string, body: string, sessionId?: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: loadImage(iconPng) });
  liveNotifications.add(n);
  const release = (): void => {
    liveNotifications.delete(n);
  };
  n.on('click', () => {
    showWindow();
    // Open the session the notification is about (the preload relays it to the renderer).
    if (sessionId && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('obsidian:openSession', sessionId);
    release();
  });
  n.on('close', release);
  n.show();
}

/** The user is looking at the app (in-app toasts and prompt cards are enough then). */
function windowFocused(): boolean {
  const w = mainWindow;
  return !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused();
}

const native: NativeBridge = {
  isElectron: true,
  notify(title, body) {
    if (attention) {
      attention.notify({ title, body });
      return;
    }
    try {
      if (core && !core.ctx.settings.get().notifications) return;
    } catch {
      /* settings unavailable → notify anyway */
    }
    showNotification(title, body);
  },
  encrypt(plain) {
    return safeStorage.encryptString(plain);
  },
  decrypt(data) {
    return safeStorage.decryptString(data);
  },
};

async function startCore(): Promise<CoreHandle | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      delete native.encrypt;
      delete native.decrypt;
    }
    return await createCore({ dataDir, native });
  } catch (err) {
    console.error('[main] core failed to start:', err instanceof Error ? (err.stack ?? err.message) : err);
    return null;
  }
}

// ───────────────────────────── window ─────────────────────────────

function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (devUrl) return u.origin === new URL(devUrl).origin;
    return u.protocol === 'file:' && u.pathname === pathToFileURL(rendererIndex).pathname;
  } catch {
    return false;
  }
}

function openExternalSafe(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  void shell.openExternal(url);
  return true;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'Obsidian Code',
    backgroundColor: BG,
    show: false,
    autoHideMenuBar: true,
    icon: loadImage(process.platform === 'win32' ? iconIco : iconPng) ?? loadImage(iconPng),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#A9B6BF', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());

  // External links → default browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // Windows logoff / shutdown: try to stop billing before the session ends.
  win.on('session-end', () => {
    void shutdown();
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererIndex);
  return win;
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// ───────────────────────────── tray ─────────────────────────────

function gpuStatus(): GpuStatus | null {
  try {
    return core ? core.ctx.gpu.status() : null;
  } catch {
    return null;
  }
}

function gpuLabel(st: GpuStatus | null): string {
  if (!st) return 'GPU: unavailable';
  switch (st.phase) {
    case 'off':
      return st.orphanInstanceIds?.length ? `GPU: off · ${st.orphanInstanceIds.length} instance(s) to check` : 'GPU: off';
    case 'ready':
      return `GPU: ready${st.gpuName ? ` — ${st.numGpus && st.numGpus > 1 ? `${st.numGpus}× ` : ''}${st.gpuName}` : ''}${
        st.pricePerHour ? ` · $${st.pricePerHour.toFixed(2)}/h` : ''
      }`;
    case 'error':
      return 'GPU: error';
    default:
      return `GPU: ${st.phase}…`;
  }
}

function trayClockIn(): void {
  if (!core) return;
  core.ctx.gpu.clockIn({ profileId: TRAY_CLOCK_IN_PROFILE }).catch((err: unknown) => {
    showNotification('Clock-in failed', errMessage(err));
  });
  setTimeout(updateTray, 200);
}

function trayClockOut(): void {
  if (!core) return;
  core.ctx.gpu.clockOut('clock_out').catch((err: unknown) => {
    showNotification('Clock-out failed', `${errMessage(err)} — check the GPU view or the Vast.ai console.`);
  });
  setTimeout(updateTray, 200);
}

let lastTrayKey = '';
function updateTray(force = false): void {
  if (!tray || tray.isDestroyed()) return;
  const st = gpuStatus();
  const phase = st?.phase ?? 'off';
  const label = gpuLabel(st);
  const key = `${phase}|${label}|${st?.instanceId ?? ''}|${core ? 1 : 0}`;
  tray.setToolTip(`Obsidian Code — ${label}`);
  if (!force && key === lastTrayKey) return;
  lastTrayKey = key;
  // An error with a still-tracked instance offers the clock-out (never a second rental on top of it).
  const trackedInError = phase === 'error' && st?.instanceId != null;
  const gpuItem: MenuItemConstructorOptions =
    (phase === 'off' || phase === 'error') && !trackedInError
      ? { label: 'Clock in (Standard)', enabled: Boolean(core), click: trayClockIn }
      : { label: 'Clock out', enabled: Boolean(core) && phase !== 'stopping', click: trayClockOut };
  const template: MenuItemConstructorOptions[] = [
    { label: 'Open Obsidian Code', click: showWindow },
    { type: 'separator' },
    { label, enabled: false },
    gpuItem,
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  const image = loadImage(process.platform === 'win32' ? iconIco : trayPng) ?? loadImage(trayPng) ?? loadImage(iconPng);
  if (!image) {
    console.error('[main] tray icon missing; tray disabled');
    return;
  }
  tray = new Tray(process.platform === 'win32' ? image : image.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray(true);
}

// ───────────────────────────── launch at login ─────────────────────────────

function applyLoginItem(settings: Settings): void {
  if (!app.isPackaged) return; // never register the dev electron.exe
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const current = app.getLoginItemSettings({ path: exe }).openAtLogin;
    if (current !== settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: exe });
  } catch (err) {
    console.error('[main] launch-at-login update failed:', errMessage(err));
  }
}

// ───────────────────────────── IPC for the preload ─────────────────────────────

function trusted(event: Pick<IpcMainInvokeEvent, 'senderFrame'>): boolean {
  const url = event.senderFrame?.url ?? '';
  return isAppUrl(url);
}

function registerIpc(): void {
  ipcMain.handle('obsidian:pickFolder', async (event, opts?: unknown) => {
    if (!trusted(event)) return null;
    const o = typeof opts === 'string' ? { defaultPath: opts } : ((opts ?? {}) as { defaultPath?: unknown; title?: unknown });
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options: OpenDialogOptions = {
      title: typeof o.title === 'string' ? o.title : 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    if (typeof o.defaultPath === 'string' && o.defaultPath) options.defaultPath = o.defaultPath;
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle('obsidian:openPath', async (event, p: unknown) => {
    if (!trusted(event)) return 'Invalid path';
    // never launch programs (.exe/.bat/.lnk… by association) or touch network shares from a renderer request
    const bad = checkOpenPath(p);
    if (bad) return bad;
    return shell.openPath(p as string);
  });
  ipcMain.handle('obsidian:showItemInFolder', (event, p: unknown) => {
    if (!trusted(event) || checkRevealPath(p)) return;
    shell.showItemInFolder(p as string);
  });
  // The core URL carries the auth token: hand it over IPC (only to the app's own page) instead of the process
  // command line, where other processes could read it.
  ipcMain.on('obsidian:coreUrl', (event) => {
    event.returnValue = trusted(event) ? (core?.url ?? null) : null;
  });
  ipcMain.handle('obsidian:openExternal', (event, url: unknown) => {
    if (!trusted(event) || typeof url !== 'string') return false;
    return openExternalSafe(url);
  });
  ipcMain.handle('obsidian:window', (event, action: unknown) => {
    if (!trusted(event)) return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        break;
      case 'maximize':
        win.maximize();
        break;
      case 'toggleMaximize':
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
      case 'close':
        win.close();
        break;
      case 'isMaximized':
        return win.isMaximized();
      default:
        return false;
    }
    return win.isMaximized();
  });
}

// ───────────────────────────── quit sequence ─────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    // Quitting interrupts running turns: no "Task finished" notifications for those.
    attention?.dispose();
    attention = null;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.hide();
      } catch {
        /* ignore */
      }
    }
    const c = core;
    if (c) {
      try {
        const st = c.ctx.gpu.status();
        if (st.phase !== 'off' && c.ctx.settings.get().vast.clockOutOnQuit) {
          const r = await withTimeout(c.ctx.gpu.clockOut('app_quit'), QUIT_CLOCK_OUT_TIMEOUT_MS);
          if (r === 'timeout') {
            showNotification('GPU may still be running', 'Clock-out did not finish within 20 s. Check the Vast.ai console.');
          }
        }
      } catch (err) {
        showNotification('GPU clock-out failed', `${errMessage(err)} — check the Vast.ai console.`);
      }
      try {
        await withTimeout(c.close(), QUIT_CLOSE_TIMEOUT_MS);
      } catch (err) {
        console.error('[main] core close failed:', errMessage(err));
      }
      core = null;
    }
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  })();
  return shutdownPromise;
}

// ───────────────────────────── app lifecycle ─────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['clipboard-sanitized-write', 'clipboard-read', 'notifications', 'fullscreen'].includes(permission));
    });
    registerIpc();

    core = await startCore();
    showWindow();
    createTray();
    // Read-only introspection for the Playwright _electron tests (main-process global; unreachable from the renderer).
    (globalThis as Record<string, unknown>).__obsidianDebug = {
      trayAlive: (): boolean => Boolean(tray && !tray.isDestroyed()),
      coreUp: (): boolean => Boolean(core),
      resourcesDir: (): string => resolveResourcesDir(),
      /** The ripgrep binary the Grep tool will spawn (null → JS fallback). */
      ripgrepPath: (): Promise<string | null> => getRipgrepPath(),
      /** Whether the GPU bootstrap scripts load from OBSIDIAN_RESOURCES_DIR. */
      serverScripts: (): { ok: boolean; bootstrapChars?: number; error?: string } => {
        try {
          return { ok: true, bootstrapChars: loadServerScripts().bootstrap.length };
        } catch (err) {
          return { ok: false, error: errMessage(err) };
        }
      },
    };

    if (core) {
      const c = core;
      applyLoginItem(c.ctx.settings.get());
      c.ctx.bus.on('settings.updated', (s) => applyLoginItem(s));
      c.ctx.bus.on('gpu.status', () => updateTray());
      // Desktop notifications when the agent needs the user, a long turn ends, or the GPU changes state (window unfocused).
      attention = createAttentionRouter({
        bus: c.ctx.bus,
        enabled: () => c.ctx.settings.get().notifications,
        focused: windowFocused,
        session: (id) => c.ctx.sessions.get(id),
        show: (n) => showNotification(n.title, n.body, n.sessionId),
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showWindow();
    });
  });

  // Closing the window quits (minimize-to-tray is not the default).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitReady = false;
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    void shutdown().finally(() => {
      quitReady = true;
      app.quit();
    });
  });
}
