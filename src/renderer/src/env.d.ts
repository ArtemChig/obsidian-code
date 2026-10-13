/// <reference types="vite/client" />

import type { UpdateSnapshot } from '@shared/updates';

/** Auto-update bridge (src/main/updater.ts). The GitHub token never reaches the renderer. */
export interface ObsidianUpdatesBridge {
  getState(): Promise<UpdateSnapshot | null>;
  /** Check now; resolves with the state after the check. */
  check(): Promise<UpdateSnapshot | null>;
  /** One click: download, graceful quit (GPU clock-out per settings), install and restart. Resolves at once. */
  update(): Promise<UpdateSnapshot | null>;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onState(cb: (s: UpdateSnapshot) => void): () => void;
}

/** API exposed by the Electron preload (src/preload/index.ts). Undefined in browser mode (npm run dev:web). */
export interface ObsidianBridge {
  /** ws://127.0.0.1:PORT/ws?token=… — null when the core failed to start. */
  coreUrl: string | null;
  /** process.platform of the host ("win32", …). */
  platform: string;
  /** Native folder picker (string = defaultPath). Resolves to the chosen absolute path, or null when cancelled. */
  pickFolder(opts?: string | { defaultPath?: string; title?: string }): Promise<string | null>;
  /** Open a file/folder with the OS default app. Resolves to '' on success, else an error message. */
  openPath(path: string): Promise<string>;
  /** Reveal a file in Explorer. */
  showItemInFolder(path: string): Promise<void>;
  /** Open an http(s) URL in the default browser; resolves false for other schemes. */
  openExternal(url: string): Promise<boolean>;
  /** Subscribe to "open this session" requests (a desktop notification was clicked). Returns an unsubscribe function. */
  onOpenSession(cb: (sessionId: string) => void): () => void;
  /** Auto-update. Absent in browser/demo mode (the UI then hides itself or uses demo data). */
  updates?: ObsidianUpdatesBridge;
  /** Window controls (the title bar uses the native Windows controls overlay; these are for custom UI). */
  window: {
    minimize(): Promise<boolean>;
    maximize(): Promise<boolean>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<boolean>;
    isMaximized(): Promise<boolean>;
  };
}

declare global {
  interface Window {
    obsidian?: ObsidianBridge;
  }
}
