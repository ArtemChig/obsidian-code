/// <reference types="vite/client" />

/** API exposed by the Electron preload (src/preload/index.ts). Undefined in browser mode (npm run dev:web). */
export interface ObsidianBridge {
  /** ws://127.0.0.1:PORT/ws?token=… — null when the core failed to start. */
  coreUrl: string | null;
  /** process.platform of the host ("win32", …). */
  platform: string;
}

declare global {
  interface Window {
    obsidian?: ObsidianBridge;
  }
}
