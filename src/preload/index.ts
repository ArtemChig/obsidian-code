// Preload (owner: platform): exposes window.obsidian to the sandboxed renderer. Keep the shape in sync with
// src/renderer/src/env.d.ts. Sandboxed preloads may only require 'electron', so this file stays dependency-free.

import { contextBridge, ipcRenderer } from 'electron';

const CORE_URL_ARG = '--obsidian-core-url=';

function readCoreUrl(): string | null {
  const arg = process.argv.find((a) => a.startsWith(CORE_URL_ARG));
  const value = arg ? arg.slice(CORE_URL_ARG.length) : '';
  return value.length > 0 ? value : null;
}

type PickFolderOptions = { defaultPath?: string; title?: string };

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
