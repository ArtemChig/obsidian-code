// UI foundation E2E (owner: ui-foundation). Drives the renderer in DEMO MODE against the Vite dev server:
//   npx vite --config vite.web.config.ts --port 5173 --strictPort
//   npx playwright test tests/e2e/ui-foundation.spec.ts
// Saves design-review screenshots to tests/e2e/screenshots/foundation-*.png.
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

async function openDemo(page: Page, width: number, height: number): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?demo=1`);
  await expect(page.getByTestId('app-title')).toHaveText('Obsidian Code');
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await expect(page.getByTestId('gpu-widget')).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  // Let entrance animations settle.
  await page.waitForTimeout(400);
  return errors;
}

test.describe('ui-foundation (demo mode)', () => {
  test.beforeAll(async () => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
  });

  test('home, collapsed sidebar, palette and 1024 layout', async ({ page }) => {
    const errors = await openDemo(page, 1440, 900);

    // Home
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByTestId('quick-start')).toBeVisible();
    await expect(page.getByTestId('home-session').first()).toBeVisible();
    await expect(page.getByTestId('view-title')).toContainText('Home');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(SHOTS, 'foundation-home.png') });

    // Collapse the sidebar (Ctrl+B) → icon rail
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'foundation-sidebar-collapsed.png') });
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('sidebar')).not.toHaveAttribute('data-collapsed', 'true');

    // Command palette (Ctrl+K)
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.getByText('New session')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, 'foundation-palette.png') });
    await page.keyboard.type('gpu');
    await expect(palette.getByText('Clock out GPU')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // 1024 × 700
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'foundation-1024.png') });

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('sessions: create, open, navigate, toggle panel', async ({ page }) => {
    const errors = await openDemo(page, 1440, 900);
    const before = await page.getByTestId('session-row').count();

    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('session-row')).toHaveCount(before + 1);
    await expect(page.getByTestId('chat-title')).toContainText('New session');

    // Right panel toggles with Ctrl+\ when a session is open
    await page.keyboard.press('Control+Backslash');
    await expect(page.getByTestId('right-panel')).toBeVisible();
    await page.keyboard.press('Control+Backslash');
    await expect(page.getByTestId('right-panel')).toBeHidden();

    // Nav
    await page.getByTestId('nav-gpu').click();
    await expect(page.getByTestId('view-title')).toContainText('GPU');
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('view-title')).toContainText('Settings');

    // Open an existing session from the sidebar
    await page.getByTestId('session-row').filter({ hasText: 'Fix GLM tool-call parsing' }).click();
    await expect(page.getByTestId('chat-title')).toContainText('Fix GLM tool-call parsing');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('GPU widget clocks out and back in', async ({ page }) => {
    const errors = await openDemo(page, 1440, 900);
    const widget = page.getByTestId('gpu-widget');
    await expect(widget).toContainText('RTX 5090');
    await page.getByTestId('gpu-clock-button').click();
    await expect(widget).toContainText('GPU off', { timeout: 10_000 });
    await page.getByTestId('gpu-clock-button').click();
    await expect(widget).toContainText(/Finding a GPU|Renting|Connecting|Downloading|Loading|RTX 5090/, { timeout: 10_000 });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('ui-foundation: session commands and status bar (demo mode)', () => {
  test.beforeAll(async () => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
  });

  test('Session menu and palette: rename, pin, fork, delete; status bar opens Activity and GPU', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await openDemo(page, 1440, 900);
    await page.getByTestId('session-row').filter({ hasText: 'Nightly dependency audit' }).click();
    await expect(page.getByTestId('chat-title')).toContainText('Nightly dependency audit');

    // Session > Rename puts the title in edit mode
    await page.getByTestId('menu-session').click();
    await page.getByRole('menuitem', { name: /^Rename/ }).click();
    const input = page.getByTestId('chat-title-input');
    await expect(input).toBeFocused();
    await input.fill('Audit deps');
    await input.press('Enter');
    await expect(page.getByTestId('chat-title')).toContainText('Audit deps');
    await expect(page.getByTestId('session-row').filter({ hasText: 'Audit deps' })).toHaveCount(1);

    // Session > Pin / Unpin
    await page.getByTestId('menu-session').click();
    await page.getByRole('menuitem', { name: /^Pin$/ }).click();
    await expect(page.getByTestId('sidebar-group').first()).toContainText('Audit deps');
    await page.getByTestId('menu-session').click();
    await expect(page.getByRole('menuitem', { name: /^Unpin/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // Session > Fork session
    const before = await page.getByTestId('session-row').count();
    await page.getByTestId('menu-session').click();
    await page.getByRole('menuitem', { name: /^Fork session/ }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(before + 1);
    await expect(page.getByTestId('chat-title')).toContainText('(fork)');

    // Session > Delete session… asks first
    await page.getByTestId('menu-session').click();
    await page.getByRole('menuitem', { name: /^Delete session/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete session?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(before + 1);
    await page.getByTestId('menu-session').click();
    await page.getByRole('menuitem', { name: /^Delete session/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(before);
    await expect(page.getByTestId('home')).toBeVisible(); // the deleted session was open: back to Home

    // palette: New category…, Rename session / Pin session for the open session
    await page.keyboard.press('Control+k');
    await page.keyboard.type('new cat');
    await page.getByRole('option', { name: /New category/ }).click();
    await expect(page.getByRole('dialog', { name: 'New category' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('session-row').filter({ hasText: 'Audit deps' }).click();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('rename');
    await page.getByRole('option', { name: /Rename session/ }).click();
    await expect(page.getByTestId('chat-title-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('unpin');
    await page.getByRole('option', { name: /Unpin session/ }).click();
    await expect(page.getByTestId('sidebar-group').first()).not.toContainText('Audit deps');

    // status bar: Running → Activity, Month → GPU
    await page.getByTestId('status-running').click();
    await expect(page.getByTestId('view-title')).toContainText('Activity');
    await page.getByTestId('status-month').click();
    await expect(page.getByTestId('view-title')).toContainText('GPU');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Home: right-click a recent session', async ({ page }) => {
    const errors = await openDemo(page, 1440, 900);
    const line = page.getByTestId('home-session').filter({ hasText: 'Hearth: stream TTS in chunks' });
    await line.click({ button: 'right' });
    const menu = page.getByTestId('home-session-menu');
    await expect(menu).toBeVisible();
    for (const name of [/^Rename/, /^Pin/, /^Fork session/, /^Move to category/, /^Copy folder path/, /^Delete/]) await expect(page.getByRole('menuitem', { name })).toBeVisible();
    await page.getByRole('menuitem', { name: /^Pin$/ }).click();
    await expect(page.getByTestId('sidebar-group').first()).toContainText('Hearth: stream TTS in chunks');
    // Rename opens the session with its title ready to edit
    await line.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Rename/ }).click();
    await expect(page.getByTestId('chat-title-input')).toBeFocused();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the shortcuts dialog lists the sidebar keys', async ({ page }) => {
    const errors = await openDemo(page, 1440, 900);
    await page.keyboard.press('Control+/');
    const dlg = page.getByTestId('shortcuts-dialog');
    await expect(dlg).toContainText('Sidebar');
    await expect(dlg).toContainText('Rename');
    await expect(dlg).toContainText('Move up');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
