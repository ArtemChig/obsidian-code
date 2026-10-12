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

// No safeStorage outside Electron: SecretStore falls back to AES-256-GCM with a key file in the data dir.
const native: NativeBridge = {
  isElectron: false,
  notify(title: string, body: string) {
    console.log(`[notification] ${title}: ${body}`);
  },
};

process.on('unhandledRejection', (reason) => {
  console.error('[obsidian-core] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
});

async function main(): Promise<void> {
  const dataDir = defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const portEnv = process.env.OBSIDIAN_CORE_PORT ? Number(process.env.OBSIDIAN_CORE_PORT) : undefined;
  const port = portEnv !== undefined && Number.isInteger(portEnv) && portEnv >= 0 && portEnv < 65536 ? portEnv : undefined;
  process.env.OBSIDIAN_RESOURCES_DIR ??= join(process.cwd(), 'resources');
  const core = await createCore({ dataDir, native, port });
  console.log(`OBSIDIAN_CORE_URL=${core.url}`);
  console.error(`[obsidian-core] data dir: ${dataDir}`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(0), 25_000);
    force.unref();
    try {
      const st = core.ctx.gpu.status();
      if (st.phase !== 'off' && core.ctx.settings.get().vast.clockOutOnQuit) {
        await Promise.race([core.ctx.gpu.clockOut('app_quit'), new Promise((r) => setTimeout(r, 20_000))]);
      }
    } catch (err) {
      console.error('[obsidian-core] clock-out on exit failed:', err instanceof Error ? err.message : err);
    }
    try {
      await core.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGBREAK', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[obsidian-core] failed to start:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
