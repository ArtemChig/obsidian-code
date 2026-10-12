import { defineConfig } from 'vitest/config';
import { aliases } from './vite.shared';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
