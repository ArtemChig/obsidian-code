// Preload (owner: platform): exposes window.obsidian to the sandboxed renderer. Keep the shape in sync with
// src/renderer/src/env.d.ts. Sandboxed preloads may only require 'electron', so this file stays dependency-free.

import { contextBridge, ipcRenderer } from 'electron';

/** The core URL (with its auth token) comes over IPC, not the process command line where other processes can read it. */
function readCoreUrl(): string | null {
  try {
    const value: unknown = ipcRenderer.sendSync('obsidian:coreUrl');
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

type PickFolderOptions = { defaultPath?: string; title?: string };

/** Mirrors UpdateSnapshot in src/shared/updates.ts (the preload stays dependency-free, so it is not imported). */
type UpdateSnapshot = Record<string, unknown> & { state: { status: string } };

const api = {
  coreUrl: readCoreUrl(),
  platform: process.platform as string,
  /** Native folder picker; resolves to the chosen absolute path or null when cancelled. */
  pickFolder(opts?: string | PickFolderOptions): Promise<string | null> {
    const o: PickFolderOptions =
      typeof opts === 'string'
        ? { defaultPath: opts }
        : {
            defaultPath: typeof opts?.defaultPath === 'string' ? opts.defaultPath : undefined,
            title: typeof opts?.title === 'string' ? opts.title : undefined,
          };
    return ipcRenderer.invoke('obsidian:pickFolder', o) as Promise<string | null>;
  },
  /** Open a file/folder with the OS default app. Resolves to '' on success, else an error message. */
  openPath(path: string): Promise<string> {
    return ipcRenderer.invoke('obsidian:openPath', String(path)) as Promise<string>;
  },
  /** Reveal a file in Explorer. */
  showItemInFolder(path: string): Promise<void> {
    return ipcRenderer.invoke('obsidian:showItemInFolder', String(path)) as Promise<void>;
  },
  /** Open an http(s) URL in the default browser. Resolves false for other schemes. */
  openExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke('obsidian:openExternal', String(url)) as Promise<boolean>;
  },
  /** Subscribe to "open this session" requests (a desktop notification was clicked). Returns an unsubscribe function. */
  onOpenSession(cb: (sessionId: string) => void): () => void {
    const listener = (_e: unknown, id: unknown): void => {
      if (typeof id === 'string' && id) cb(id);
    };
    ipcRenderer.on('obsidian:openSession', listener);
    return () => {
      ipcRenderer.removeListener('obsidian:openSession', listener);
    };
  },
  /** Auto-update (src/main/updater.ts). update() = download, graceful quit, install and restart. */
  updates: {
    getState: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('obsidian:updates:getState') as Promise<UpdateSnapshot | null>,
    check: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('obsidian:updates:check') as Promise<UpdateSnapshot | null>,
    update: (): Promise<UpdateSnapshot | null> => ipcRenderer.invoke('obsidian:updates:update') as Promise<UpdateSnapshot | null>,
    /** Subscribe to state changes. Returns an unsubscribe function. */
    onState(cb: (s: UpdateSnapshot) => void): () => void {
      const listener = (_e: unknown, s: unknown): void => {
        if (s && typeof s === 'object') cb(s as UpdateSnapshot);
      };
      ipcRenderer.on('obsidian:updates:state', listener);
      return () => {
        ipcRenderer.removeListener('obsidian:updates:state', listener);
      };
    },
  },
  /** Window controls (the title bar uses the native Windows controls overlay; these are for custom UI). */
  window: {
    minimize: (): Promise<boolean> => ipcRenderer.invoke('obsidian:window', 'minimize') as Promise<boolean>,
    maximize: (): Promise<boolean> => ipcRenderer.invoke('obsidian:window', 'maximize') as Promise<boolean>,
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('obsidian:window', 'toggleMaximize') as Promise<boolean>,
    close: (): Promise<boolean> => ipcRenderer.invoke('obsidian:window', 'close') as Promise<boolean>,
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('obsidian:window', 'isMaximized') as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld('obsidian', api);
