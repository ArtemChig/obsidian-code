// Standalone core (no Electron): `npm run core`.
// Prints OBSIDIAN_CORE_URL=ws://127.0.0.1:PORT/ws?token=… so a browser renderer (npm run dev:web, ?core=<url>)
// or a test harness can connect. Env: OBSIDIAN_CODE_DATA_DIR (data dir), OBSIDIAN_CORE_PORT (fixed port).

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeBridge } from './contracts';
import { createCore } from './index';

function defaultDataDir(): string {
  if (process.env.OBSIDIAN_CODE_DATA_DIR) return process.env.OBSIDIAN_CODE_DATA_DIR;
  const appData =
    process.env.APPDATA ??
    (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config'));
  return join(appData, 'obsidian-code');
}

const native: NativeBridge = {
  isElectron: false,
  notify(title: string, body: string) {
    console.log(`[notification] ${title}: ${body}`);
  },
};

async function main(): Promise<void> {
  const dataDir = defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const port = process.env.OBSIDIAN_CORE_PORT ? Number(process.env.OBSIDIAN_CORE_PORT) : undefined;
  const core = await createCore({ dataDir, native, port });
  console.log(`OBSIDIAN_CORE_URL=${core.url}`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await core.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[obsidian-core] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
