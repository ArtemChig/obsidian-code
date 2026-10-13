// Auto-update UI in DEMO MODE (owner: platform/ui): menu-strip UPDATE button, GPU confirm, progress, restart, status-bar
// version and Settings → About & updates. Needs the Vite dev server:
//   npx vite --config vite.web.config.ts --port 5173 --strictPort     (or 5174/5175, or set OBSIDIAN_WEB_URL)
//   npx playwright test tests/e2e/update-ui.spec.ts
// Screenshots: tests/e2e/screenshots/update-*.png
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;
declare const getComputedStyle: any;

const CANDIDATES = [process.env.OBSIDIAN_WEB_URL, 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'].filter(Boolean) as string[];
let BASE = CANDIDATES[0];
const SHOTS = join(__dirname, 'screenshots');

async function serverUp(): Promise<boolean> {
  for (const url of CANDIDATES) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) {
        BASE = url;
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

async function open(page: Page, update: string | null, width = 1440, height = 900): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?demo=1${update ? `&update=${update}` : ''}`);
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  return errors;
}

async function setGpuPhase(page: Page, phase: string) {
  await page.evaluate((p) => {
    const t = window.__obsidianDemo;
    t.data.gpuStatus = { ...t.data.gpuStatus, phase: p };
    t.emit('gpu.status', t.data.gpuStatus);
  }, phase);
}

test.beforeAll(async () => {
  test.skip(!(await serverUp()), 'Vite dev server not running (npx vite --config vite.web.config.ts --port 5173 --strictPort)');
});

test('no update: no button, status bar shows the version, Settings says up to date', async ({ page }) => {
  const errors = await open(page, null);
  await expect(page.getByTestId('update-button')).toHaveCount(0);
  await expect(page.getByTestId('status-version')).toHaveText(/v0\.1\.0/i);
  await page.getByTestId('status-version').click();
  await expect(page.getByTestId('settings-view')).toHaveAttribute('data-section', 'about');
  await expect(page.getByTestId('updates-state')).toHaveAttribute('data-status', 'not-available');
  await expect(page.getByTestId('updates-token-badge')).toHaveText(/GitHub CLI login/i);
  await page.screenshot({ path: join(SHOTS, 'update-settings-uptodate.png') });
  // Check now finds the demo release
  await page.getByTestId('updates-check').click();
  await expect(page.getByTestId('update-button')).toHaveAttribute('data-status', 'available');
  expect(errors).toEqual([]);
});

test('available: solid UPDATE x.y.z in the menu strip; GPU clocked in → confirm; progress → restart into the new version', async ({ page }) => {
  const errors = await open(page, 'available');
  const button = page.getByTestId('update-button');
  await expect(button).toHaveAttribute('data-status', 'available');
  await expect(button).toContainText(/update/i);
  await expect(page.getByTestId('update-version')).toHaveText('0.1.1');
  // solid accent fill, black ink, 2 px radius (M13)
  const style = await button.evaluate((el: any) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color, radius: s.borderTopLeftRadius, height: el.getBoundingClientRect().height };
  });
  expect(style).toMatchObject({ bg: 'rgb(230, 238, 255)', color: 'rgb(0, 0, 0)', radius: '2px' });
  expect(style.height).toBeLessThanOrEqual(20);
  await expect(page.getByTestId('status-version')).toHaveAttribute('title', /0\.1\.1 is available/);
  await page.screenshot({ path: join(SHOTS, 'update-menubar-available.png') });
  await page.getByTestId('menubar').screenshot({ path: join(SHOTS, 'update-menubar-strip.png') });

  // The demo GPU is clocked in → the click asks first.
  await setGpuPhase(page, 'ready');
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Updating restarts Obsidian Code. Your GPU will be clocked out first.');
  await page.screenshot({ path: join(SHOTS, 'update-confirm-gpu.png') });
  await dialog.getByRole('button', { name: 'Update & restart' }).click();

  await expect(button).toHaveAttribute('data-status', 'downloading');
  await expect(page.getByTestId('update-percent')).toHaveText(/\d+%/);
  await page.getByTestId('menubar').screenshot({ path: join(SHOTS, 'update-menubar-progress.png') });
  await expect(button).toHaveAttribute('data-status', /downloaded|installing/, { timeout: 15_000 });
  await expect(button).toContainText(/restarting/i);
  await page.getByTestId('menubar').screenshot({ path: join(SHOTS, 'update-menubar-restarting.png') });
  // demo "restart": the new version is running, the button is gone
  await expect(button).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('status-version')).toHaveText(/v0\.1\.1/i);
  expect(errors).toEqual([]);
});

test('clock out on quit off → the confirm says the GPU keeps running', async ({ page }) => {
  await open(page, 'available');
  await page.evaluate(() => {
    const t = window.__obsidianDemo;
    t.data.settings = { ...t.data.settings, vast: { ...t.data.settings.vast, clockOutOnQuit: false } };
    t.emit('settings.updated', t.data.settings);
  });
  await setGpuPhase(page, 'ready');
  await page.getByTestId('update-button').click();
  await expect(page.getByRole('dialog')).toContainText('keeps running and will be re-attached');
});

test('Settings → About & updates with an available release: notes, GitHub link, token source, token field', async ({ page }) => {
  const errors = await open(page, 'available');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-about').click();
  await expect(page.getByTestId('settings-nav-about')).toHaveText('About & updates');
  await expect(page.getByTestId('updates-state')).toHaveAttribute('data-status', 'available');
  await expect(page.getByTestId('updates-notes')).toContainText('One-click updates');
  await expect(page.getByTestId('updates-release-link')).toBeVisible();
  await expect(page.getByTestId('updates-install')).toBeVisible();
  await expect(page.getByTestId('secret-update-token-input')).toHaveAttribute('type', 'password');
  await page.screenshot({ path: join(SHOTS, 'update-settings-available.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('no GitHub access: Settings explains, status bar warns, no button', async ({ page }) => {
  await open(page, 'error');
  await expect(page.getByTestId('update-button')).toHaveCount(0);
  await expect(page.getByTestId('status-version')).toHaveAttribute('title', /Update problem/);
  await page.getByTestId('status-version').click();
  await expect(page.getByTestId('updates-state')).toContainText('gh auth login');
  await expect(page.getByTestId('updates-token-badge')).toHaveText(/No token/i);
  await page.screenshot({ path: join(SHOTS, 'update-settings-error.png') });
});

test('portable build: unsupported, no Check now', async ({ page }) => {
  await open(page, 'portable');
  await page.getByTestId('status-version').click();
  await expect(page.getByTestId('updates-state')).toContainText('portable build — use the installer');
  await expect(page.getByTestId('updates-check')).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, 'update-settings-portable.png') });
});

test('narrow window (1024×700) keeps the button and hints on one line', async ({ page }) => {
  await open(page, 'downloading', 1024, 700);
  const button = page.getByTestId('update-button');
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  const bar = await page.getByTestId('menubar').boundingBox();
  expect(box && bar && box.y >= bar.y && box.y + box.height <= bar.y + bar.height).toBe(true);
  await page.screenshot({ path: join(SHOTS, 'update-narrow-progress.png') });
});
