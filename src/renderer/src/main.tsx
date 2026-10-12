// Renderer entry (owner: ui-foundation).
// PLACEHOLDER created by the scaffold: renders a static "Obsidian Code" screen and reports the core URL source.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/jetbrains-mono/400.css';
import './index.css';

/** Core URL: Electron preload, or ?core=<ws url> in browser mode (npm run dev:web). */
function resolveCoreUrl(): string | null {
  const fromBridge = window.obsidian?.coreUrl ?? null;
  if (fromBridge) return fromBridge;
  return new URLSearchParams(window.location.search).get('core');
}

function App() {
  const coreUrl = resolveCoreUrl();
  const host = window.obsidian ? `Electron (${window.obsidian.platform})` : 'Browser';
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3">
      <h1 className="text-[20px] font-semibold tracking-tight" data-testid="app-title">
        Obsidian Code
      </h1>
      <p className="font-mono text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--ob-text-3)' }}>
        {host} · core {coreUrl ? 'url received' : 'not running'}
      </p>
    </main>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
