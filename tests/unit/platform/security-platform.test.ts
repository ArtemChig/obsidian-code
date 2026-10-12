// Security regressions (review "security": F8, F9): main-process path IPC validation and core server Origin/Host checks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { checkOpenPath, checkRevealPath } from '../../../src/main/open-path';
import { requestAllowed, startServer } from '@core/server/index';
import type { CoreContext } from '@core/contracts';

const dir = mkdtempSync(join(tmpdir(), 'oc-sec-plat-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('F8: openPath / showItemInFolder validation', () => {
  it('opens folders and plain documents only', () => {
    const md = join(dir, 'OBSIDIAN.md');
    const exe = join(dir, 'x.exe');
    const bat = join(dir, 'x.bat');
    writeFileSync(md, '# memory');
    writeFileSync(exe, 'MZ');
    writeFileSync(bat, 'calc');
    mkdirSync(join(dir, 'folder.exe'));
    expect(checkOpenPath(md)).toBeNull();
    expect(checkOpenPath(dir)).toBeNull();
    expect(checkOpenPath(join(dir, 'folder.exe'))).toBeNull(); // a folder, opened in the file manager
    expect(checkOpenPath(exe)).toMatch(/blocked/);
    expect(checkOpenPath(bat)).toMatch(/blocked/);
    expect(checkOpenPath(join(dir, 'missing.md'))).toMatch(/not found/);
    expect(checkOpenPath('\\\\attacker.example@80\\share\\x.md')).toMatch(/Network/);
    expect(checkOpenPath('//attacker.example/share/x.md')).toMatch(/Network/);
    expect(checkOpenPath('relative.md')).toMatch(/absolute/);
    expect(checkOpenPath(42)).toBe('Invalid path');
  });
  it('reveal accepts local absolute paths only', () => {
    expect(checkRevealPath(dir)).toBeNull();
    expect(checkRevealPath('\\\\host\\share')).toMatch(/Network/);
    expect(checkRevealPath('x')).toMatch(/absolute/);
  });
});

describe('F9: core server Origin/Host checks', () => {
  it('requestAllowed', () => {
    expect(requestAllowed({ host: '127.0.0.1:5000' }, 5000)).toBe(true);
    expect(requestAllowed({ host: 'localhost:5000', origin: 'file://' }, 5000)).toBe(true);
    expect(requestAllowed({ host: '127.0.0.1:5000', origin: 'null' }, 5000)).toBe(true);
    expect(requestAllowed({ host: '127.0.0.1:5000', origin: 'http://localhost:5173' }, 5000)).toBe(true);
    expect(requestAllowed({ host: '127.0.0.1:5000', origin: 'https://evil.example' }, 5000)).toBe(false);
    expect(requestAllowed({ host: 'evil.example:5000' }, 5000)).toBe(false); // DNS rebinding
    expect(requestAllowed({ host: '127.0.0.1:5001' }, 5000)).toBe(false);
    expect(requestAllowed({}, 5000)).toBe(false);
  });

  it('rejects a WebSocket from a foreign origin even with the right token', async () => {
    const ctx = { bus: { emit: () => undefined, on: () => () => undefined } } as unknown as CoreContext;
    const server = await startServer({ ctx, handlers: { ping: async () => 'pong' } as never });
    try {
      const open = (headers?: Record<string, string>) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(server.url, { headers });
          ws.on('open', () => { ws.close(); resolve('open'); });
          ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
          ws.on('error', () => resolve('error'));
        });
      expect(await open()).toBe('open');
      expect(await open({ Origin: 'https://evil.example' })).toBe('403');
      const rpc = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
        method: 'POST', headers: { Authorization: `Bearer ${server.token}`, Origin: 'https://evil.example' }, body: '{"method":"ping"}',
      });
      expect(rpc.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
