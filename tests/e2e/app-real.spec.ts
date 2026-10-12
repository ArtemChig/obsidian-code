// Real-app end-to-end: the built Electron app (npm run build → out/) with the REAL core and the user's REAL local
// llama-server (http://127.0.0.1:8080). Skips itself when the local server is unreachable. Slow by design (the local
// model decodes ~20 tok/s and is shared with another app), so timeouts are generous and prompts tiny.
//
//   npm run build && npx playwright test tests/e2e/app-real.spec.ts
//
// Set OBSIDIAN_APP_EXE to drive a packaged build instead (e.g. "release/win-unpacked/Obsidian Code.exe").
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const projectRoot = resolve(__dirname, '../..');
const shots = join(__dirname, 'screenshots');
const LOCAL = 'http://127.0.0.1:8080';
const MODEL_TIMEOUT = 6 * 60_000;

async function localServerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${LOCAL}/v1/models`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** One JSON-RPC call to the core from inside the renderer (same URL + token the app uses). */
async function rpc<T = unknown>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    async ([m, p]) => {
      const url = (globalThis as unknown as { obsidian: { coreUrl: string } }).obsidian.coreUrl;
      const ws = new WebSocket(url);
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

/** PIDs of a process and all its descendants (Windows: CIM; elsewhere: ps). */
function processTree(rootPid: number): number[] {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8' })
        : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map<number, number[]>();
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    const all: number[] = [];
    const queue = [rootPid];
    while (queue.length) {
      const p = queue.shift()!;
      all.push(p);
      queue.push(...(children.get(p) ?? []));
    }
    return all;
  } catch {
    return [rootPid];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(shots, `app-${name}.png`) });
}

async function composer(page: Page) {
  const input = page.getByTestId('composer-input');
  await expect(input).toBeEnabled();
  return input;
}

async function waitIdle(page: Page, sessionId: string, timeout = MODEL_TIMEOUT): Promise<void> {
  await expect
    .poll(async () => (await rpc<{ status: string }>(page, 'sessions.get', { id: sessionId })).status, { timeout, intervals: [1000] })
    .toMatch(/^(idle|error)$/);
}

test.describe.configure({ mode: 'serial' });

test('real app: local model, tools, palettes, views, settings, clean quit', async () => {
  test.setTimeout(30 * 60_000);
  test.skip(!(await localServerUp()), `local llama-server at ${LOCAL} is unreachable`);
  mkdirSync(shots, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-code-real-'));
  // A project folder with spaces and a long-ish path (Windows quoting, truncation in the UI).
  const project = join(mkdtempSync(join(tmpdir(), 'oc proj-')), 'My Project With Spaces', 'feature-branch-workspace');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Demo project\n\nA tiny folder for the Obsidian Code end-to-end test.\n');
  writeFileSync(join(project, 'src', 'greet.js'), "export function greet(name) {\n  return 'hello ' + name;\n}\n");

  const exe = process.env.OBSIDIAN_APP_EXE;
  const app: ElectronApplication = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [projectRoot] }),
    cwd: projectRoot,
    env: { ...process.env, OBSIDIAN_CODE_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
    timeout: 90_000,
  });
  const mainPid = app.process().pid!;
  let closed = false;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);

    // The native folder picker is replaced by one that returns the temp project.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, project);

    await test.step('home screen + core connected', async () => {
      await expect(page).toHaveTitle('Obsidian Code');
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('view-title')).toContainText('Home');
      const info = await rpc<{ dataDir: string; electron: boolean }>(page, 'system.info');
      expect(info.electron).toBe(true);
      expect(resolve(info.dataDir).toLowerCase()).toBe(resolve(dataDir).toLowerCase());
      await shot(page, 'home');
    });

    await test.step('providers: local online, vast offline without a key', async () => {
      await expect
        .poll(async () => (await rpc<{ providers: { id: string; status: string }[] }>(page, 'models.list')).providers.find((p) => p.id === 'local')?.status, {
          timeout: 60_000,
        })
        .toBe('online');
      const { providers, models } = await rpc<{ providers: { id: string; status: string }[]; models: { ref: { provider: string } }[] }>(page, 'models.list');
      expect(models.some((m) => m.ref.provider === 'local')).toBe(true);
      const vast = providers.find((p) => p.id === 'vast');
      expect(vast?.status).not.toBe('online');
      await page.getByTestId('nav-settings').click();
      await expect(page.getByTestId('provider-status').first()).toHaveAttribute('data-status', 'online');
      await shot(page, 'settings-models');
    });

    let sessionId = '';
    await test.step('create a session in the temp project (folder picker)', async () => {
      await page.getByTestId('nav-home').click();
      await expect(page.getByTestId('home')).toBeVisible();
      await page.getByTestId('home-folder').click();
      await expect(page.getByTestId('home-folder')).toContainText('feature-branch-workspace');
      await page.getByTestId('home-start').click();
      await expect(page.getByTestId('chat-view')).toBeVisible();
      await expect(page.getByTestId('cwd-chip')).toContainText('feature-branch-workspace');
      await expect(page.getByTestId('view-title')).toContainText('feature-branch-workspace');
      const sessions = await rpc<{ id: string; cwd: string }[]>(page, 'sessions.list');
      const s = sessions.find((x) => resolve(x.cwd).toLowerCase() === resolve(project).toLowerCase());
      expect(s, JSON.stringify(sessions)).toBeTruthy();
      sessionId = s!.id;
      await shot(page, 'chat-empty');
    });

    await test.step('streamed reply + thinking block', async () => {
      const input = await composer(page);
      await input.fill('Reply with exactly: hello');
      await input.press('Enter');
      await expect(page.getByTestId('msg-user')).toContainText('Reply with exactly: hello');
      await expect(page.getByTestId('running-status')).toBeVisible({ timeout: 30_000 });
      await shot(page, 'chat-pending');
      await expect(page.getByTestId('assistant-text').last()).toContainText(/hello/i, { timeout: MODEL_TIMEOUT });
      await waitIdle(page, sessionId);
      const session = await rpc<{ messages: { role: string; blocks: { type: string }[] }[] }>(page, 'sessions.get', { id: sessionId });
      const assistant = session.messages.filter((m) => m.role === 'assistant').at(-1)!;
      if (assistant.blocks.some((b) => b.type === 'thinking')) await expect(page.getByTestId('thinking-block').first()).toBeVisible();
      await expect(page.getByTestId('running-status')).toBeHidden();
      await shot(page, 'chat-hello');
    });

    await test.step('prefill progress ("Reading context… N%") on an uncached long prompt', async () => {
      // ~4k fresh tokens: llama.cpp reports prompt_progress per 2048-token batch, so at least one partial update.
      const words = Array.from({ length: 800 }, (_, i) => `w${(i * 7919 + Date.now()) % 100000}`).join(' ');
      const input = await composer(page);
      await input.fill(`Ignore this log dump: ${words}\n\nReply with exactly: ok`);
      await input.press('Enter');
      // Long pasted text collapses in the user bubble.
      await expect(page.getByTestId('msg-user').last().getByTestId('show-more')).toBeVisible();
      const progress = page.getByTestId('prefill-progress');
      await expect(progress).toBeVisible({ timeout: 90_000 });
      await expect(progress).toContainText(/Reading context…\s*\d+%/);
      await shot(page, 'prefill');
      await expect(progress).toBeHidden({ timeout: MODEL_TIMEOUT });
      await waitIdle(page, sessionId);
    });

    await test.step('write a file: permission prompt → Allow → diff card → file on disk → Changes panel', async () => {
      const input = await composer(page);
      await input.fill('Create a file named notes.txt in the current folder containing exactly one line: first note');
      await input.press('Enter');
      const prompt = page.getByTestId('permission-prompt');
      await expect(prompt).toBeVisible({ timeout: MODEL_TIMEOUT });
      await expect(prompt).toContainText('notes.txt');
      await shot(page, 'permission');
      await page.getByTestId('perm-allow').click();
      await expect(prompt).toBeHidden({ timeout: 30_000 });
      await expect.poll(() => existsSync(join(project, 'notes.txt')), { timeout: 60_000 }).toBe(true);
      expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toContain('first note');
      await expect(page.getByTestId('diff-view').first()).toBeVisible({ timeout: 30_000 });
      await waitIdle(page, sessionId);
      await shot(page, 'diff-card');
      // Changes panel
      if (!(await page.getByTestId('right-panel').isVisible())) await page.getByTestId('chat-panel-toggle').click();
      await expect(page.getByTestId('right-panel')).toBeVisible();
      await page.getByRole('tab', { name: /changes/i }).click();
      await expect(page.getByTestId('changed-file').filter({ hasText: 'notes.txt' })).toBeVisible();
      await page.getByTestId('changed-file').filter({ hasText: 'notes.txt' }).click();
      await expect(page.getByTestId('changes-diff')).toBeVisible();
      await shot(page, 'changes-panel');
    });

    await test.step('plan mode via Shift+Tab', async () => {
      const input = await composer(page);
      const mode = page.getByTestId('mode-selector');
      await expect(mode).toHaveAttribute('data-mode', 'default');
      await input.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(mode).toHaveAttribute('data-mode', 'acceptEdits');
      await page.keyboard.press('Shift+Tab');
      await expect(mode).toHaveAttribute('data-mode', 'plan');
      await expect.poll(async () => (await rpc<{ permissionMode: string }>(page, 'sessions.get', { id: sessionId })).permissionMode).toBe('plan');
      await shot(page, 'plan-mode');
      // Bypass is not in the Shift+Tab cycle unless it is the default mode: plan → default.
      await page.keyboard.press('Shift+Tab');
      await expect(mode).toHaveAttribute('data-mode', 'default');
    });

    await test.step('"/" palette runs /help', async () => {
      const input = await composer(page);
      await input.fill('/');
      await expect(page.getByTestId('palette-item').first()).toBeVisible();
      await shot(page, 'slash-palette');
      await input.fill('/help');
      await expect(page.getByTestId('palette-item').first()).toContainText('help');
      await input.press('Enter'); // completes "/help "
      const value = await input.inputValue();
      if (value.trim() === '/help') await input.press('Enter');
      await expect(page.locator('[data-testid=msg-assistant][data-tag=command]').last()).toBeVisible({ timeout: 30_000 });
      await shot(page, 'help');
    });

    await test.step('"@" palette lists project files', async () => {
      const input = await composer(page);
      await input.fill('@gre');
      await expect(page.getByTestId('palette-item').filter({ hasText: 'greet.js' })).toBeVisible({ timeout: 15_000 });
      await shot(page, 'mention-palette');
      await input.press('Escape');
      await input.fill('');
    });

    await test.step('Activity view shows the session', async () => {
      await page.getByTestId('nav-activity').click();
      await expect(page.getByTestId('activity-view')).toBeVisible();
      await expect(page.getByTestId('activity-row').first()).toBeVisible();
      await shot(page, 'activity');
    });

    await test.step('Schedules: create a one-shot task 1 day ahead, then delete it', async () => {
      await page.getByTestId('nav-schedules').click();
      await expect(page.getByTestId('schedules-view')).toBeVisible();
      await shot(page, 'schedules-empty');
      await page.getByTestId('schedule-new').first().click();
      const dialog = page.getByTestId('schedule-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('schedule-name').fill('E2E one-shot');
      await dialog.getByTestId('schedule-prompt').fill('Say hi');
      await dialog.getByTestId('schedule-cwd').fill(project);
      await dialog.getByRole('combobox', { name: 'Schedule type' }).click();
      await page.getByRole('option', { name: 'Once at' }).click();
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const local = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`;
      await dialog.getByTestId('schedule-once').fill(local);
      await shot(page, 'schedule-dialog');
      await page.getByTestId('schedule-save').click(); // footer lives outside the form
      await expect(dialog).toBeHidden();
      const row = page.getByTestId('schedule-row').filter({ hasText: 'E2E one-shot' });
      await expect(row).toBeVisible();
      const tasks = await rpc<{ name: string; oneShot: boolean; enabled: boolean; nextRunAt?: number }[]>(page, 'schedules.list');
      const t = tasks.find((x) => x.name === 'E2E one-shot');
      expect(t?.oneShot).toBe(true);
      expect(t?.enabled).toBe(true);
      expect(Math.abs((t?.nextRunAt ?? 0) - tomorrow.getTime())).toBeLessThan(2 * 60_000);
      await shot(page, 'schedules');
      await row.getByTestId('schedule-delete').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete schedule' }).click();
      await expect(row).toBeHidden();
      expect((await rpc<unknown[]>(page, 'schedules.list')).length).toBe(0);
    });

    await test.step('GPU view: missing-key state + live price ranges', async () => {
      await page.getByTestId('nav-gpu').click();
      await expect(page.getByTestId('gpu-view')).toBeVisible();
      await expect(page.getByTestId('gpu-no-key')).toBeVisible();
      await expect(page.getByTestId('gpu-price-light')).toContainText('$', { timeout: 60_000 });
      await shot(page, 'gpu');
    });

    await test.step('Settings save roundtrip (budget 150 → reload → persisted → restore)', async () => {
      const before = (await rpc<{ vast: { monthlyBudget: number } }>(page, 'settings.get')).vast.monthlyBudget;
      await page.getByTestId('nav-settings').click();
      await page.getByTestId('settings-nav-vast').click();
      const budget = page.getByTestId('vast-budget');
      await budget.scrollIntoViewIfNeeded();
      await budget.fill('150');
      await budget.press('Enter');
      await expect.poll(async () => (await rpc<{ vast: { monthlyBudget: number } }>(page, 'settings.get')).vast.monthlyBudget).toBe(150);
      await shot(page, 'settings-vast');
      await page.reload();
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await page.getByTestId('nav-settings').click();
      await page.getByTestId('settings-nav-vast').click();
      await expect(page.getByTestId('vast-budget')).toHaveValue('150');
      const onDisk = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { vast: { monthlyBudget: number } };
      expect(onDisk.vast.monthlyBudget).toBe(150);
      await page.getByTestId('vast-budget').fill(String(before));
      await page.getByTestId('vast-budget').press('Enter');
      await expect.poll(async () => (await rpc<{ vast: { monthlyBudget: number } }>(page, 'settings.get')).vast.monthlyBudget).toBe(before);
    });

    await test.step('tray icon present', async () => {
      const tray = await app.evaluate(() => (globalThis as { __obsidianDebug?: { trayAlive(): boolean } }).__obsidianDebug?.trayAlive() ?? null);
      expect(tray).toBe(true);
    });

    expect(errors.filter((e) => !/ResizeObserver|Download the React DevTools/.test(e)), errors.join('\n')).toEqual([]);

    await test.step('closing the window quits cleanly (no orphan processes)', async () => {
      const tree = processTree(mainPid);
      const exited = new Promise<void>((res) => app.process().once('exit', () => res()));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('app did not exit within 30 s')), 30_000))]);
      closed = true;
      await expect.poll(() => tree.filter(alive), { timeout: 15_000 }).toEqual([]);
    });
  } finally {
    if (!closed) await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    rmSync(resolve(project, '..', '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
