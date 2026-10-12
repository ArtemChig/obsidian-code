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
