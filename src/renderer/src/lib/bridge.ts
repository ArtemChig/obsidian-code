// Typed, defensive access to the Electron preload bridge (window.obsidian). Owner: ui-foundation.
// In browser mode (npm run dev:web) window.obsidian is undefined and every helper degrades gracefully.
// The platform agent owns the preload; this file only declares the OPTIONAL methods the renderer may use.
import type { UpdateSnapshot } from '@shared/updates';

export interface BridgeApi {
  coreUrl: string | null;
  platform: string;
  pickFolder?: (opts?: { defaultPath?: string; title?: string }) => Promise<string | null>;
  openPath?: (path: string) => Promise<unknown> | unknown;
  showItemInFolder?: (path: string) => unknown;
  openExternal?: (url: string) => Promise<unknown> | unknown;
  onOpenSession?: (cb: (sessionId: string) => void) => () => void;
  /** Auto-update (see ObsidianUpdatesBridge in env.d.ts); absent in browser mode. */
  updates?: {
    getState: () => Promise<UpdateSnapshot | null>;
    check: () => Promise<UpdateSnapshot | null>;
    update: () => Promise<UpdateSnapshot | null>;
    onState: (cb: (s: UpdateSnapshot) => void) => () => void;
  };
  window?: {
    minimize?: () => void;
    maximize?: () => void;
    toggleMaximize?: () => void;
    close?: () => void;
    isMaximized?: () => Promise<boolean> | boolean;
  };
  [key: string]: unknown;
}

export function getBridge(): BridgeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { obsidian?: BridgeApi }).obsidian;
}

export const isElectron = (): boolean => !!getBridge();

/** Core URL: Electron preload first, then ?core=<ws url> (browser mode). */
export function resolveCoreUrl(search: string = typeof window !== 'undefined' ? window.location.search : ''): string | null {
  const fromBridge = getBridge()?.coreUrl ?? null;
  if (fromBridge) return fromBridge;
  const q = new URLSearchParams(search).get('core');
  return q && q.length > 0 ? q : null;
}

/** ?demo / ?demo=1 / ?demo=true (but not ?demo=0). */
export function isDemoRequested(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  const params = new URLSearchParams(search);
  if (!params.has('demo')) return false;
  const v = params.get('demo');
  return v !== '0' && v !== 'false';
}

const SAFE_EXTERNAL = /^(https?:|mailto:)/i;

/** Open a URL in the user's browser (never inside the app window). */
export function openExternal(url: string): void {
  if (!SAFE_EXTERNAL.test(url)) return;
  const b = getBridge();
  if (b?.openExternal) {
    void b.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Native folder picker; falls back to a prompt() in browser mode. Returns null when cancelled. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const b = getBridge();
  if (b?.pickFolder) {
    const r = await b.pickFolder({ defaultPath });
    return typeof r === 'string' && r ? r : null;
  }
  const v = window.prompt('Folder path', defaultPath ?? '');
  return v && v.trim() ? v.trim() : null;
}

export function openPath(path: string): void {
  const b = getBridge();
  if (b?.openPath) void b.openPath(path);
}

export function showItemInFolder(path: string): void {
  const b = getBridge();
  if (b?.showItemInFolder) void b.showItemInFolder(path);
}

export function canRevealFiles(): boolean {
  return !!getBridge()?.showItemInFolder;
}

/** Run `cb` when the main process asks to open a session (a desktop notification was clicked). */
export function onOpenSessionRequest(cb: (sessionId: string) => void): () => void {
  const b = getBridge();
  return b?.onOpenSession ? b.onOpenSession(cb) : () => undefined;
}

/** Save text as a file through the browser download flow (Electron shows a Save dialog). */
export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
