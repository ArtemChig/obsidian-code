// Renderer-only dev server ("browser mode"): `npm run dev:web`, then open
//   http://localhost:5173/?core=<ws url printed by `npm run core`>
// Used by Playwright UI tests against a standalone core.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { aliases, devCspPlugin, root } from './vite.shared';

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  resolve: { alias: aliases },
  plugins: [devCspPlugin(), react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(root, 'out/web'),
    emptyOutDir: true,
  },
});
