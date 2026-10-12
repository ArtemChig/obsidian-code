/// <reference types="vite/client" />

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
