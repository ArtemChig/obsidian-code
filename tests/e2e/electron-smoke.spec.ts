// Electron launch smoke test: requires a prior `npm run build` (loads out/main/index.js via package.json "main").
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const projectRoot = resolve(__dirname, '../..');

test('electron app launches and shows the Obsidian Code window', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-code-e2e-'));
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, OBSIDIAN_CODE_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
    timeout: 60_000,
  });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await expect(window).toHaveTitle('Obsidian Code');
    await expect(window.getByTestId('app-title')).toHaveText('Obsidian Code');

    const bridge = await window.evaluate(() => {
      const w = window as unknown as { obsidian?: { platform: string; coreUrl: string | null } };
      return w.obsidian ? { platform: w.obsidian.platform, hasCoreUrlKey: 'coreUrl' in w.obsidian } : null;
    });
    expect(bridge).not.toBeNull();
    expect(bridge?.platform).toBe(process.platform);
    expect(bridge?.hasCoreUrlKey).toBe(true);

    const isolated = await window.evaluate(() => typeof (globalThis as { require?: unknown }).require === 'undefined');
    expect(isolated).toBe(true);

    // Auto-update bridge: present, token-free, and off in a dev run (no UPDATE button); the status bar shows the version.
    const version = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { version: string }).version;
    const updates = await window.evaluate(async () => {
      const w = window as unknown as { obsidian?: { updates?: { getState(): Promise<unknown> } } };
      return w.obsidian?.updates ? await w.obsidian.updates.getState() : null;
    });
    expect(updates).toMatchObject({ currentVersion: version, state: { status: 'unsupported', reason: expect.stringContaining('development') } });
    await expect(window.getByTestId('status-version')).toContainText(version);
    await expect(window.getByTestId('update-button')).toHaveCount(0);

    await window.screenshot({ path: join(__dirname, 'screenshots', 'smoke.png') });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
