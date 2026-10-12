// Electron main process (owner: platform).
// PLACEHOLDER created by the scaffold: starts the core in-process, opens the window, passes the core URL
// to the preload via a command-line switch. The platform agent extends this (tray, title bar, IPC, quit flow…).

import { join } from 'node:path';
import { app, BrowserWindow, Notification, safeStorage, shell } from 'electron';
import { createCore } from '@core/index';
import type { NativeBridge } from '@core/contracts';

type CoreHandle = Awaited<ReturnType<typeof createCore>>;

// Data dir: %APPDATA%/obsidian-code (not "Obsidian Code"), overridable for tests.
const dataDir = process.env.OBSIDIAN_CODE_DATA_DIR ?? join(app.getPath('appData'), 'obsidian-code');
app.setPath('userData', dataDir);

// Where core finds repo resources (resources/server/bootstrap.sh, icons…). Packaged: unpacked next to app.asar.
process.env.OBSIDIAN_RESOURCES_DIR ??= app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : join(app.getAppPath(), 'resources');

let core: CoreHandle | null = null;
let mainWindow: BrowserWindow | null = null;

const native: NativeBridge = {
  isElectron: true,
  notify(title, body) {
    if (Notification.isSupported()) new Notification({ title, body }).show();
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
    console.error('[main] core failed to start:', err instanceof Error ? err.message : err);
    return null;
  }
}

function createWindow(coreUrl: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Obsidian Code',
    backgroundColor: '#0B1215',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--obsidian-core-url=${coreUrl ?? ''}`],
    },
  });

  win.once('ready-to-show', () => win.show());

  // Open external links in the default browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    core = await startCore();
    mainWindow = createWindow(core?.url ?? null);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(core?.url ?? null);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !core) return;
    event.preventDefault();
    quitting = true;
    const c = core;
    core = null;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 20_000));
    void Promise.race([c.close(), timeout])
      .catch((err: unknown) => console.error('[main] core close failed:', err))
      .finally(() => app.quit());
  });
}
