import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { aliases, devCspPlugin, root } from './vite.shared';

// Packages that are ESM-only and tiny: bundle them into main instead of require()-ing them at runtime.
// Everything else in "dependencies" stays external (loaded from node_modules; Electron 44 / Node 24 supports require(esm)).
const BUNDLED_ESM_DEPS = ['nanoid', 'strip-ansi', 'ansi-regex'];

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    build: {
      externalizeDeps: { exclude: BUNDLED_ESM_DEPS },
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: { alias: aliases },
    build: {
      // Sandboxed preload: must be a single CommonJS file that only requires 'electron'.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: { alias: aliases },
    plugins: [devCspPlugin(), react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
});
