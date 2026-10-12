// Renderer entry. Owner: ui-foundation.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// M13 "Obsidian" type: Chivo (UI) + Chivo Mono (numbers, labels, code). Bundled by Vite, so they work offline.
import '@fontsource/chivo/400.css';
import '@fontsource/chivo/500.css';
import '@fontsource/chivo/600.css';
import '@fontsource/chivo/700.css';
import '@fontsource/chivo-mono/400.css';
import '@fontsource/chivo-mono/500.css';
import '@fontsource/chivo-mono/600.css';
import './design/tokens.css';
import { App } from './app/App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
