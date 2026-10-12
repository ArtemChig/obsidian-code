// UI kit gallery + extra design-review screenshots (owner: ui-foundation). Needs the Vite dev server on :5173.
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const BASE = process.env.OBSIDIAN_WEB_URL ?? 'http://localhost:5173';
const SHOTS = join(__dirname, 'screenshots');

test.describe('ui-foundation gallery', () => {
  test.beforeAll(async () => {
    const up = await fetch(BASE, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    test.skip(!up, `Vite dev server not reachable at ${BASE}`);
  });

  test('component gallery renders', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/?demo=1&gallery=1`);
    await expect(page.getByTestId('gallery')).toBeVisible();
    await page.evaluate('document.fonts.ready.then(() => undefined)');
    await page.waitForTimeout(1200); // shiki loads lazily
    await page.screenshot({ path: join(SHOTS, 'foundation-gallery.png'), fullPage: false });
    await page.getByTestId('gallery').evaluate((el) => el.scrollTo(0, 820));
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, 'foundation-gallery-2.png') });
    expect(errors).toEqual([]);
  });

  test('session view with right panel, menu and dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/?demo=1`);
    await page.getByTestId('session-row').filter({ hasText: 'Fix GLM tool-call parsing' }).click();
    await page.keyboard.press('Control+Backslash');
    await expect(page.getByTestId('right-panel')).toBeVisible();
    const row = page.getByTestId('session-row').filter({ hasText: 'Hearth: stream TTS' });
    await row.click({ button: 'right' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'foundation-session-menu.png') });
    await page.keyboard.press('Escape');
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete session?' })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'foundation-dialog.png') });
    await page.keyboard.press('Escape');
    // Toast from a GPU clock-out notification
    await page.getByTestId('gpu-clock-button').click();
    await expect(page.getByText('Clocked out')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'foundation-toast.png') });
  });

  test('connection banners: reconnecting (demo) and no core', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/?demo=1`);
    await expect(page.getByTestId('session-row').first()).toBeVisible();
    await page.evaluate('window.__obsidianDemo.simulateDisconnect(6000)');
    await expect(page.getByTestId('banner-reconnecting')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'foundation-reconnecting.png'), clip: { x: 0, y: 0, width: 1440, height: 300 } });
    await expect(page.getByTestId('banner-reconnecting')).toBeHidden({ timeout: 10_000 });

    await page.goto(`${BASE}/`);
    await expect(page.getByTestId('banner-unavailable')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'foundation-no-core.png') });
  });
});
