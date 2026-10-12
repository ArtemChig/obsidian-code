// createCore smoke test: real modules from every area, temp data dir, local provider disabled (no network).
// Skipped automatically while another area's entry point does not exist yet (parallel build).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { NativeBridge } from '@core/contracts';
import { tempDir } from './helpers';

const root = resolve(__dirname, '../../..');
const entryPoints = ['llm', 'ext', 'tools', 'gpu', 'agent'].map((m) => join(root, 'src', 'core', m, 'index.ts'));
const allModulesPresent = entryPoints.every((p) => existsSync(p));

function rpc(ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((res) => {
    const onMsg = (raw: Buffer): void => {
      const msg = JSON.parse(raw.toString()) as { id?: number };
      if (msg.id === id) {
        ws.off('message', onMsg);
        res(msg as { result?: unknown; error?: { message: string } });
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

describe.skipIf(!allModulesPresent)('createCore (composition root)', () => {
  it('starts every module, serves RPC over WebSocket and closes cleanly', async () => {
    const tmp = tempDir('oc-core-');
    const dataDir = join(tmp.dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({ local: { enabled: false, baseUrl: 'http://127.0.0.1:9' }, defaultCwd: tmp.dir, importClaudeConfig: false }),
    );
    const native: NativeBridge = { isElectron: false, notify: () => undefined };
    const { createCore } = await import('@core/index');
    const core = await createCore({ dataDir, native });
    try {
      expect(core.url).toBe(`ws://127.0.0.1:${core.port}/ws?token=${core.token}`);
      for (const key of ['bus', 'sessions', 'settings', 'secrets', 'kv', 'llm', 'models', 'tools', 'ext', 'shells', 'agent', 'gpu', 'scheduler', 'activity'] as const) {
        expect(core.ctx[key], key).toBeTruthy();
      }
      const ws = new WebSocket(core.url);
      await new Promise((r, j) => {
        ws.once('open', r);
        ws.once('error', j);
      });
      const info = await rpc(ws, 1, 'system.info');
      expect(info.result).toMatchObject({ dataDir, electron: false });
      const created = await rpc(ws, 2, 'sessions.create', { cwd: tmp.dir });
      expect(created.result).toMatchObject({ cwd: tmp.dir, kind: 'chat' });
      const settings = await rpc(ws, 3, 'settings.update', { patch: { notifications: false } });
      expect(settings.result).toMatchObject({ notifications: false });
      const gpu = await rpc(ws, 4, 'gpu.status');
      expect(gpu.result).toMatchObject({ phase: 'off' });
      ws.close();
    } finally {
      await core.close();
      tmp.cleanup();
    }
  }, 60_000);
});
