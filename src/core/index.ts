// Composition root of the Obsidian Code core (owner: platform).
// PLACEHOLDER created by the scaffold — the platform agent replaces this with the real implementation
// (stores, event bus, HTTP/WS server, JSON-RPC router, agent, tools, gpu, scheduler, activity).
//
// Rules for core code (it runs both inside Electron main — Electron 44 / Node 24, bundled by electron-vite into a
// single CommonJS file out/main/index.js — and standalone via tsx on Node 26, also CommonJS mode):
//   * no Electron imports (use the injected NativeBridge);
//   * no top-level await (CommonJS output);
//   * __dirname / import.meta.url point at out/main/ when bundled, NOT at src/core/ — never use them to locate
//     repo files such as resources/server/*. Resolve resources from process.env.OBSIDIAN_RESOURCES_DIR when set,
//     else path.join(process.cwd(), 'resources').
//   * use only Node 24 APIs (@types/node is pinned to 24 to match Electron's runtime).

import type { NativeBridge } from './contracts';

export interface CreateCoreOptions {
  /** Data directory, e.g. %APPDATA%/obsidian-code (or OBSIDIAN_CODE_DATA_DIR). */
  dataDir: string;
  /** Native integrations (Electron) or no-ops (standalone). */
  native: NativeBridge;
  /** Port for the HTTP/WS server on 127.0.0.1; 0/undefined = random free port. */
  port?: number;
}

export interface CoreHandle {
  /** WebSocket URL including the auth token, e.g. ws://127.0.0.1:PORT/ws?token=… */
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export async function createCore(opts: CreateCoreOptions): Promise<CoreHandle> {
  void opts;
  throw new Error('createCore: not implemented yet');
}
