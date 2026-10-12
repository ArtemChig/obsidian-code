// Preload (owner: platform). Runs sandboxed with contextIsolation: only 'electron' may be required.
// PLACEHOLDER created by the scaffold: exposes window.obsidian = { coreUrl, platform }.
// The platform agent extends it (pickFolder, openPath, showItemInFolder, window controls…) — keep the shape
// in sync with src/renderer/src/env.d.ts.

import { contextBridge } from 'electron';

const CORE_URL_ARG = '--obsidian-core-url=';

function readCoreUrl(): string | null {
  const arg = process.argv.find((a) => a.startsWith(CORE_URL_ARG));
  const value = arg ? arg.slice(CORE_URL_ARG.length) : '';
  return value.length > 0 ? value : null;
}

const api = {
  coreUrl: readCoreUrl(),
  platform: process.platform as string,
};

contextBridge.exposeInMainWorld('obsidian', api);
