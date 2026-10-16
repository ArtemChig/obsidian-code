// Auto clock-out E2E (owner: ui-views). Drives the renderer in DEMO MODE against the Vite dev server:
//   npx vite --config vite.web.config.ts --port 5173 --strictPort
//   npx playwright test tests/e2e/ui-autoclockout.spec.ts
// The right-click menu on the GPU widget, the status bar and a chat, the armed-watch line, and the Settings group.
// Saves screenshots to tests/e2e/screenshots/autoclockout-*.png.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.OBSIDIAN_WEB_URL ?? 'http://localhost:5173';
const SHOTS = join(__dirname, 'screenshots');

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function openDemo(page: Page, width = 1440, height = 900): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?demo=1`);
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await expect(page.getByTestId('gpu-widget')).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  await page.waitForTimeout(400);
  return errors;
}

const menu = (page: Page) => page.getByTestId('auto-clockout-menu');
const item = (page: Page, name: RegExp | string) => menu(page).getByRole('menuitemradio', { name });

test.describe('auto clock-out (demo mode)', () => {
  test.beforeAll(async () => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
  });

  test('right-click the sidebar Clock out button: arm, switch, cancel', async ({ page }) => {
    const errors = await openDemo(page);
    const widget = page.getByTestId('gpu-widget');
    // the demo GPU was clocked in with the default watch (Settings → Vast.ai: "If it stops responding")
    await expect(page.getByTestId('gpu-auto-clockout').first()).toContainText('if stalled');

    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Clock out now' })).toBeVisible();
    await expect(item(page, /when the current task finishes/)).toHaveAttribute('aria-checked', 'false');
    await expect(item(page, /if it stops responding/)).toHaveAttribute('aria-checked', 'true');
    await expect(item(page, 'Both')).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Cancel auto clock-out' })).toBeEnabled();
    await page.screenshot({ path: join(SHOTS, 'autoclockout-widget-menu.png') });

    await item(page, 'Both').click();
    await expect(menu(page)).toBeHidden();
    await expect(widget.getByTestId('gpu-auto-clockout')).toContainText('done or stalled');

    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await item(page, /when the current task finishes/).click();
    await expect(widget.getByTestId('gpu-auto-clockout')).toContainText('when done');

    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Cancel auto clock-out' }).click();
    await expect(widget.getByTestId('gpu-auto-clockout')).toHaveCount(0);
    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Cancel auto clock-out' })).toBeDisabled();
    await page.keyboard.press('Escape');
    // wait out the close animation, or the closing menu's items still match below
    await expect(menu(page)).toHaveCount(0);

    // the menu strip's GPU menu offers the same choices (without a second "Clock out now")
    await page.getByTestId('menu-gpu').click();
    await expect(page.getByRole('menuitemradio', { name: /if it stops responding/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Clock out', exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('"Clock out now" from the menu clocks out; the menu does not open while the GPU is off', async ({ page }) => {
    const errors = await openDemo(page);
    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Clock out now' }).click();
    // sessions are running on the demo GPU: the app-wide confirmation comes first
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /Clock out/ }).click();
    await expect(page.getByTestId('gpu-widget')).toContainText('GPU off', { timeout: 10_000 });
    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await expect(menu(page)).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('status bar: right-click the GPU segment; a chat: header and composer menus are per session', async ({ page }) => {
    const errors = await openDemo(page);
    await page.getByTestId('status-gpu').click({ button: 'right' });
    await expect(menu(page).getByText('GPU', { exact: true })).toBeVisible();
    await expect(item(page, /when the current task finishes/)).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('session-row').first().click();
    await expect(page.getByTestId('chat-header')).toBeVisible();
    await page.getByTestId('chat-header').click({ button: 'right', position: { x: 600, y: 10 } });
    await expect(menu(page).getByText('GPU · this session')).toBeVisible();
    await expect(item(page, /when this task finishes/)).toHaveAttribute('aria-checked', 'false');
    await item(page, /when this task finishes/).click();
    await expect(page.getByTestId('auto-clockout-tag')).toBeVisible();
    await expect(page.getByTestId('gpu-widget').getByTestId('gpu-auto-clockout')).toContainText('+1 session');

    // the same session menu from the composer toolbar
    await page.getByTestId('composer').locator('.h-10').click({ button: 'right', position: { x: 300, y: 10 } });
    await expect(item(page, /when this task finishes/)).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: join(SHOTS, 'autoclockout-session-menu.png') });
    await menu(page).getByRole('menuitem', { name: 'Cancel auto clock-out' }).click();
    await expect(page.getByTestId('auto-clockout-tag')).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Settings → Vast.ai: the default mode and the two limits', async ({ page }) => {
    const errors = await openDemo(page);
    await page.getByTestId('nav-settings').click();
    await page.getByRole('button', { name: 'Vast.ai' }).first().click();
    const group = page.getByTestId('settings-vast-autoclockout');
    await group.scrollIntoViewIfNeeded();
    await expect(group.getByRole('radio', { name: 'If it stops responding' })).toHaveAttribute('aria-checked', 'true');
    await group.getByRole('radio', { name: 'Both' }).click();
    await expect(group.getByRole('radio', { name: 'Both' })).toHaveAttribute('aria-checked', 'true');
    await expect(group).toContainText('whichever happens first');
    await group.getByTestId('vast-autoclockout-stall').fill('15');
    await group.getByTestId('vast-autoclockout-stall').press('Enter');
    await group.getByTestId('vast-autoclockout-grace').fill('3');
    await group.getByTestId('vast-autoclockout-grace').press('Enter');
    await expect(group.getByTestId('vast-autoclockout-stall')).toHaveValue('15');
    await page.screenshot({ path: join(SHOTS, 'autoclockout-settings.png') });
    // the limits show up in the menu hints
    await page.getByTestId('gpu-clock-button').click({ button: 'right' });
    await expect(item(page, /when the current task finishes/)).toContainText('3 min');
    await expect(item(page, /if it stops responding/)).toContainText('15 min');
    await page.keyboard.press('Escape');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
