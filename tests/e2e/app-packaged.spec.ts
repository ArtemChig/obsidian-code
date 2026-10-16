// Packaged-build smoke test: launches release/win-unpacked/Obsidian Code.exe (produced by `npm run dist`) with a temp
// data dir and checks what only breaks once packaged: the renderer loads from app.asar, the core starts, ripgrep is
// resolved from app.asar.unpacked, the GPU bootstrap scripts load from OBSIDIAN_RESOURCES_DIR, and — when the local
// llama-server is up — a real Grep tool call made by the model succeeds. Skips when the unpacked build is missing.
//
//   npm run dist && npx playwright test tests/e2e/app-packaged.spec.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const projectRoot = resolve(__dirname, '../..');
const exe = process.env.OBSIDIAN_APP_EXE ?? join(projectRoot, 'release', 'win-unpacked', 'Obsidian Code.exe');
const shots = join(__dirname, 'screenshots');
const LOCAL = 'http://127.0.0.1:8080';

type Debug = {
  trayAlive(): boolean;
  coreUp(): boolean;
  resourcesDir(): string;
  ripgrepPath(): Promise<string | null>;
  serverScripts(): { ok: boolean; bootstrapChars?: number; error?: string };
};

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
      const ws = new WebSocket((globalThis as unknown as { obsidian: { coreUrl: string } }).obsidian.coreUrl);
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error('ws error'));
      });
      try {
        return await new Promise<unknown>((res, rej) => {
          ws.onmessage = (ev) => {
            const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
            if (msg.id !== 1) return;
            if (msg.error) rej(new Error(msg.error.message));
            else res(msg.result);
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

test('packaged build: renders, core, ripgrep from app.asar.unpacked, bootstrap scripts, real Grep call', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!existsSync(exe), `packaged build not found at ${exe} (run npm run dist)`);
  mkdirSync(shots, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-code-pkg-'));
  // A fresh data dir would open the first-run setup over the app: mark it done.
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ setupDone: true }));
  const project = join(mkdtempSync(join(tmpdir(), 'oc pkg-')), 'grep target');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'nothing to see\nsay hello to the world\n');
  writeFileSync(join(project, 'b.md'), '# b\nno match here\n');

  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: { ...process.env, OBSIDIAN_CODE_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
    timeout: 90_000,
  });
  const mainPid = app.process().pid!;
  let exited = false;
  app.process().once('exit', () => (exited = true));
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveTitle('Obsidian Code');
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 30_000 });

    // Core connected over the WebSocket the renderer uses.
    const info = await rpc<{ version: string; electron: boolean; dataDir: string }>(page, 'system.info');
    expect(info.electron).toBe(true);
    expect(resolve(info.dataDir).toLowerCase()).toBe(resolve(dataDir).toLowerCase());

    // Main-process introspection (packaged paths).
    const dbg = await app.evaluate(async () => {
      const d = (globalThis as unknown as { __obsidianDebug: Debug }).__obsidianDebug;
      return { resourcesDir: d.resourcesDir(), rg: await d.ripgrepPath(), scripts: d.serverScripts(), tray: d.trayAlive(), core: d.coreUp(), env: process.env.OBSIDIAN_RESOURCES_DIR ?? null };
    });
    console.log('[packaged]', JSON.stringify(dbg));
    expect(dbg.core).toBe(true);
    expect(dbg.tray).toBe(true);
    expect(dbg.env).toBe(dbg.resourcesDir);
    expect(dbg.resourcesDir).toMatch(/app\.asar\.unpacked[\\/]resources$/);
    expect(existsSync(join(dbg.resourcesDir, 'server', 'bootstrap.sh'))).toBe(true);
    expect(dbg.scripts.ok, dbg.scripts.error).toBe(true);
    // @vscode/ripgrep resolves the binary from its platform package (@vscode/ripgrep-win32-x64).
    expect(dbg.rg).toMatch(/app\.asar\.unpacked[\\/]node_modules[\\/]@vscode[\\/]ripgrep(-[a-z0-9]+-[a-z0-9]+)?[\\/]bin[\\/]rg\.exe$/);
    expect(execFileSync(dbg.rg!, ['--version'], { encoding: 'utf8' })).toMatch(/^ripgrep \d+/);
    await page.screenshot({ path: join(shots, 'app-packaged-home.png') });

    if (!(await localServerUp())) {
      test.info().annotations.push({ type: 'skipped-part', description: 'local llama-server unreachable: real Grep call not exercised' });
      return;
    }

    // A real model turn that calls Grep (read-only → no permission prompt in default mode).
    const session = await rpc<{ id: string }>(page, 'sessions.create', { cwd: project });
    await page.getByTestId(`session-row`).first().click();
    const input = page.getByTestId('composer-input');
    await input.fill('Use the Grep tool to find the word hello in this folder, then tell me which file contains it.');
    await input.press('Enter');
    const grepCard = page.locator('[data-testid=tool-card][data-tool=Grep]').first();
    await expect(grepCard).toBeVisible({ timeout: 6 * 60_000 });
    await expect
      .poll(async () => (await rpc<{ status: string }>(page, 'sessions.get', { id: session.id })).status, { timeout: 6 * 60_000, intervals: [1000] })
      .toMatch(/^(idle|error)$/);
    const full = await rpc<{ messages: { role: string; blocks: { type: string; name?: string; status?: string; result?: { content?: unknown } }[] }[] }>(page, 'sessions.get', { id: session.id });
    const grep = full.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_use' && b.name === 'Grep');
    expect(grep?.status).toBe('done');
    expect(JSON.stringify(grep?.result ?? {})).toContain('a.txt');
    await page.screenshot({ path: join(shots, 'app-packaged-grep.png') });
  } finally {
    const tree = (() => {
      try {
        return execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | % ProcessId`], { encoding: 'utf8' })
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
      } catch {
        return [] as number[];
      }
    })();
    if (!exited) await app.close().catch(() => undefined);
    for (const pid of tree) {
      try {
        process.kill(pid, 0);
        console.warn(`[packaged] child ${pid} still alive after close`);
      } catch {
        /* gone */
      }
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    rmSync(resolve(project, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
