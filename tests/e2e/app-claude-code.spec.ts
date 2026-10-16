// Real-app check of the claude-code engine inside Electron: the built app (npm run build → out/) with the REAL core
// spawns the Agent SDK's bundled Claude Code binary and runs a turn on the user's local llama-server. Validates the
// executable strategy (asar-unpacked native binary, dynamic import of the ESM SDK from the CommonJS main bundle).
// Skips itself when the local server is unreachable.
//
//   npm run build && npx playwright test tests/e2e/app-claude-code.spec.ts
//
// Set OBSIDIAN_APP_EXE to drive a packaged build instead (e.g. "release/win-unpacked/Obsidian Code.exe").
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const projectRoot = resolve(__dirname, '../..');
const shots = join(__dirname, 'screenshots');
const LOCAL = 'http://127.0.0.1:8080';
const MODEL_TIMEOUT = 8 * 60_000;

async function localServerUp(): Promise<boolean> {
  try {
    return (await fetch(`${LOCAL}/v1/models`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

async function rpc<T = unknown>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    async ([m, p]) => {
      const url = (globalThis as unknown as { obsidian: { coreUrl: string } }).obsidian.coreUrl;
      const ws = new WebSocket(url);
      await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
      try {
        return await new Promise<unknown>((res, rej) => {
          ws.onmessage = (ev) => {
            const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
            if (msg.id !== 1) return;
            if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
          };
          ws.send(JSON.stringify({ id: 1, method: m, params: p }));
        });
      } finally {
        ws.close();
      }
    },
    [method, params] as const,
  ) as Promise<T>;
}

test('claude-code engine runs a turn inside the Electron app on the local model', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!(await localServerUp()), `local llama-server at ${LOCAL} is unreachable`);
  mkdirSync(shots, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-code-cc-'));
  // A fresh data dir would open the first-run setup over the app: mark it done.
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ setupDone: true }));
  const project = join(mkdtempSync(join(tmpdir(), 'oc cc-')), 'cc project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# cc\n');
  const exe = process.env.OBSIDIAN_APP_EXE;
  const app: ElectronApplication = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [projectRoot] }),
    cwd: projectRoot,
    env: { ...process.env, OBSIDIAN_CODE_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
    timeout: 90_000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, project);
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await rpc<{ providers: { id: string; status: string }[] }>(page, 'models.list')).providers.find((p) => p.id === 'local')?.status, { timeout: 60_000 })
      .toBe('online');

    // the engine resolves inside Electron (bundled claude.exe, unpacked path when packaged)
    const engines = await rpc<{ id: string; available: boolean; detail: string }[]>(page, 'engines.list');
    const cc = engines.find((e) => e.id === 'claude-code');
    expect(cc?.available, cc?.detail).toBe(true);

    // quick start: folder + engine "Claude Code"
    await page.getByTestId('home-folder').click();
    await page.getByTestId('home-engine').click();
    await page.getByTestId('engine-option-claude-code').click();
    await expect(page.getByTestId('home-engine')).toHaveAttribute('data-engine', 'claude-code');
    await page.screenshot({ path: join(shots, 'app-cc-home.png') });
    await page.getByTestId('home-start').click();
    await expect(page.getByTestId('chat-view')).toBeVisible();
    await expect(page.getByTestId('engine-tag')).toBeVisible();
    await expect(page.getByTestId('engine-selector')).toHaveAttribute('data-engine', 'claude-code');
    const sessions = await rpc<{ id: string; cwd: string; engine?: string }[]>(page, 'sessions.list');
    const s = sessions.find((x) => resolve(x.cwd).toLowerCase() === resolve(project).toLowerCase());
    expect(s?.engine).toBe('claude-code');

    const input = page.getByTestId('composer-input');
    await input.fill('Reply with exactly: hello');
    await input.press('Enter');
    await expect(page.getByTestId('msg-user')).toContainText('Reply with exactly: hello');
    await expect(page.getByTestId('assistant-text').last()).toContainText(/hello/i, { timeout: MODEL_TIMEOUT });
    await expect
      .poll(async () => (await rpc<{ status: string }>(page, 'sessions.get', { id: s!.id })).status, { timeout: MODEL_TIMEOUT, intervals: [1000] })
      .toBe('idle');
    await page.screenshot({ path: join(shots, 'app-cc-hello.png') });

    // the slash palette lists Claude Code's own commands for this session
    const cmds = await rpc<{ name: string }[]>(page, 'commands.list', { cwd: project, sessionId: s!.id });
    expect(cmds.map((c) => c.name)).toContain('compact');

    // Settings → Engine
    await page.getByTestId('nav-settings').click();
    await page.getByRole('button', { name: /^Engine$/ }).first().click().catch(() => undefined);
    await page.screenshot({ path: join(shots, 'app-cc-settings.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});
