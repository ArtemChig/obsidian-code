// Resizable panels E2E (demo mode): drag every panel edge, double-click resets, keyboard, sizes survive a reload.
//   npx vite --config vite.web.config.ts --port 5173 --strictPort
//   npx playwright test tests/e2e/ui-resize.spec.ts          (OBSIDIAN_WEB_URL overrides the address)
// Saves screenshots to tests/e2e/screenshots/resize-*.png.
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function openDemo(page: Page, path = '/?demo=1'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}${path}`);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  return errors;
}

const width = async (l: Locator): Promise<number> => Math.round((await l.boundingBox())!.width);

/** Drag a handle horizontally by dx pixels with the mouse. */
async function drag(page: Page, handle: Locator, dx: number): Promise<void> {
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(b.height / 2, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test.describe('resizable panels (demo mode)', () => {
  test.describe.configure({ timeout: 60_000 });
  test.beforeEach(async ({ page }) => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
    // Every test starts from the default sizes.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('resize-spec-started')) {
        localStorage.removeItem('obsidian-code.ui.v1');
        sessionStorage.setItem('resize-spec-started', '1');
      }
    });
  });

  test('sidebar: drag, limits, double-click reset, keyboard, survives a reload', async ({ page }) => {
    const errors = await openDemo(page);
    const sidebar = page.getByTestId('sidebar');
    const handle = page.getByTestId('sidebar-resize');
    expect(await width(sidebar)).toBe(240);

    await drag(page, handle, 80);
    expect(await width(sidebar)).toBe(320);
    await page.screenshot({ path: join(SHOTS, 'resize-sidebar.png') });

    await drag(page, handle, 1000);
    expect(await width(sidebar)).toBe(420); // max
    await drag(page, handle, -1000);
    expect(await width(sidebar)).toBe(200); // min

    await handle.dblclick();
    expect(await width(sidebar)).toBe(240);

    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    expect(await width(sidebar)).toBe(240 + 16 + 64);
    await expect(handle).toHaveAttribute('aria-valuenow', '320');

    await page.reload();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    expect(await width(page.getByTestId('sidebar'))).toBe(320);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('right panel: drag its left edge', async ({ page }) => {
    const errors = await openDemo(page);
    await page.getByTestId('session-row').first().click();
    const panel = page.getByTestId('right-panel');
    if (!(await panel.isVisible())) await page.getByTestId('chat-panel-toggle').click();
    await expect(panel).toBeVisible();
    const before = await width(panel);
    await drag(page, page.getByTestId('right-panel-resize'), -60);
    expect(await width(panel)).toBe(before + 60);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('view splits: Settings navigation, GPU column, Models list, Home status column', async ({ page }) => {
    const errors = await openDemo(page);

    // Home: the status column (left edge)
    const homeAside = page.getByRole('complementary', { name: 'Status' });
    const homeBefore = await width(homeAside);
    await drag(page, page.getByTestId('home-aside-resize'), -60);
    expect(await width(homeAside)).toBe(homeBefore + 60);

    // Settings: the section navigation (right edge)
    await page.getByTestId('nav-settings').click();
    const nav = page.getByTestId('settings-nav');
    expect(await width(nav)).toBe(216);
    await drag(page, page.getByTestId('settings-nav-resize'), 64);
    expect(await width(nav)).toBe(280);
    await page.screenshot({ path: join(SHOTS, 'resize-settings.png') });

    // GPU: the budget and safety column (left edge)
    await page.getByTestId('nav-gpu').click();
    const gpuAside = page.getByRole('complementary', { name: 'Budget and safety' });
    expect(await width(gpuAside)).toBe(298);
    await drag(page, page.getByTestId('gpu-aside-resize'), -82);
    expect(await width(gpuAside)).toBe(380);

    // Models: the result list (right edge)
    await page.getByTestId('nav-models').click();
    const list = page.getByRole('region', { name: 'Search results' });
    await expect(list).toBeVisible();
    expect(await width(list)).toBe(420);
    await drag(page, page.getByTestId('models-list-resize'), 100);
    expect(await width(list)).toBe(520);
    await page.screenshot({ path: join(SHOTS, 'resize-models.png') });

    // All of it is remembered.
    await page.reload();
    await page.getByTestId('nav-models').click();
    expect(await width(page.getByRole('region', { name: 'Search results' }))).toBe(520);
    await page.getByTestId('nav-settings').click();
    expect(await width(page.getByTestId('settings-nav'))).toBe(280);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
