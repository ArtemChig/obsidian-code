// Shared Vite settings for electron.vite.config.ts, vite.web.config.ts and vitest.config.ts.
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export const root = __dirname;

/** Path aliases (keep in sync with tsconfig.node.json / tsconfig.web.json "paths"). */
export const aliases = {
  '@shared': resolve(root, 'src/shared'),
  '@core': resolve(root, 'src/core'),
  '@renderer': resolve(root, 'src/renderer/src'),
};

/**
 * The renderer's index.html ships a strict Content-Security-Policy (no inline scripts).
 * The Vite dev server (and @vitejs/plugin-react's refresh preamble) needs inline scripts,
 * so in `serve` mode only we relax `script-src` with 'unsafe-inline'. Production builds keep the strict policy.
 */
export function devCspPlugin(): Plugin {
  return {
    name: 'obsidian:dev-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/script-src 'self'/, "script-src 'self' 'unsafe-inline'");
      },
    },
  };
}
