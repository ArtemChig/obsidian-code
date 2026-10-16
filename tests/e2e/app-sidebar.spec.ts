// Sidebar groups in the REAL app: the built Electron app (npm run build → out/) with the real core and a temp data dir.
// Checks that the layout survives a restart: category, group name, collapsed groups, group order, a session's category
// and manual order. No model is needed (sessions are created and moved, never run).
//
//   npm run build && npx playwright test tests/e2e/app-sidebar.spec.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

const projectRoot = resolve(__dirname, '../..');
const shots = join(__dirname, 'screenshots');

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, OBSIDIAN_CODE_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('app-title')).toHaveText('Obsidian Code');
  await expect(page.getByTestId('status-connection')).toContainText(/online/i, { timeout: 30_000 });
  return { app, page };
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

const group = (page: Page, name: string): Locator =>
  page.getByTestId('sidebar-group').filter({ has: page.getByTestId('group-toggle').filter({ hasText: name }) });
const groupNames = (page: Page): Promise<string[]> => page.getByTestId('group-toggle').allTextContents();

test('the sidebar layout survives a restart', async () => {
  test.setTimeout(180_000);
  const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-code-e2e-sidebar-'));
  // A fresh data dir would open the first-run setup over the app: mark it done.
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ setupDone: true }));
  const base = mkdtempSync(join(tmpdir(), 'oc-proj-'));
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  mkdirSync(alpha);
  mkdirSync(beta);
  try {
    // ── first run: make sessions in two folders and arrange them through the UI
    let { app, page } = await launch(dataDir);
    try {
      const make = (cwd: string, title: string) => rpc<{ id: string }>(page, 'sessions.create', { cwd, title });
      await make(alpha, 'alpha one');
      await page.waitForTimeout(30); // updatedAt has millisecond resolution: keep the order apart
      await make(alpha, 'alpha two');
      await page.waitForTimeout(30);
      await make(beta, 'beta one');
      await expect(page.getByTestId('session-row')).toHaveCount(3);
      expect(await groupNames(page)).toEqual(expect.arrayContaining(['alpha', 'beta']));

      // a category made from beta's group menu
      await group(page, 'beta').getByTestId('group-header').hover();
      await group(page, 'beta').getByTestId('group-menu-button').click();
      await page.getByRole('menuitem', { name: /^New category/ }).click();
      await page.getByTestId('new-category-name').fill('Research');
      await page.getByTestId('new-category-create').click();
      await expect(group(page, 'Research')).toBeVisible();

      // rename alpha's group (a display name: the folder is unchanged), move a session into the category by menu
      await group(page, 'alpha').getByTestId('group-header').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Rename/ }).click();
      await page.getByTestId('inline-rename').fill('Alpha app');
      await page.getByTestId('inline-rename').press('Enter');
      await expect(group(page, 'Alpha app')).toBeVisible();
      await page.getByTestId('session-row').filter({ hasText: 'beta one' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Move to category/ }).click();
      await page.getByRole('menuitem', { name: 'Research' }).click();
      await expect(group(page, 'Research').getByTestId('session-row')).toHaveCount(1);

      // manual order inside a group: "alpha one" (older) moves above "alpha two"
      const alphaRows = group(page, 'Alpha app').getByTestId('session-row');
      await expect(alphaRows.first()).toContainText('alpha two'); // newest first until placed by hand
      await alphaRows.last().focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(alphaRows.first()).toContainText('alpha one');

      // group order: Research moves to the bottom; a click folds Alpha app
      await group(page, 'Research').getByTestId('group-header').click({ button: 'right' });
      const down = page.getByRole('menuitem', { name: /^Move down/ });
      while ((await down.getAttribute('aria-disabled')) !== 'true') {
        await down.click();
        await group(page, 'Research').getByTestId('group-header').click({ button: 'right' });
      }
      await page.keyboard.press('Escape');
      await group(page, 'Alpha app').getByTestId('group-toggle').click();
      await expect(group(page, 'Alpha app').getByTestId('group-toggle')).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: join(shots, 'app-sidebar-before-restart.png') });
      expect(await groupNames(page)).toEqual(['Alpha app', 'Research']);

      // it is in the core's settings file
      await expect
        .poll(() => {
          const ui = (JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { ui?: { sidebar: { categories: { name: string }[]; collapsed: string[]; groupNames: Record<string, string> } } }).ui;
          return ui ? [ui.sidebar.categories.map((c) => c.name), ui.sidebar.collapsed.length, Object.values(ui.sidebar.groupNames)] : null;
        })
        .toEqual([['Research'], 1, ['Alpha app']]);
    } finally {
      await page.evaluate('document.fonts.ready.then(() => undefined)');
      await app.close();
    }

    // ── second run on the same data dir: everything is where it was
    ({ app, page } = await launch(dataDir));
    try {
      await expect(page.getByTestId('sidebar-group').first()).toBeVisible();
      expect(await groupNames(page)).toEqual(['Alpha app', 'Research']);
      await expect(group(page, 'Alpha app').getByTestId('group-toggle')).toHaveAttribute('aria-expanded', 'false'); // still folded
      await expect(group(page, 'Research').getByTestId('session-row')).toHaveCount(1);
      await expect(group(page, 'Research')).toContainText('beta one');
      await group(page, 'Alpha app').getByTestId('group-toggle').click();
      await expect(group(page, 'Alpha app').getByTestId('group-toggle')).toHaveAttribute('aria-expanded', 'true');
      const rows = group(page, 'Alpha app').getByTestId('session-row');
      await expect(rows.first()).toContainText('alpha one'); // the manual order
      await expect(rows.last()).toContainText('alpha two');
      await page.screenshot({ path: join(shots, 'app-sidebar-after-restart.png') });

      // delete the category and keep its session: it goes back to beta's folder group, the layout forgets the category
      await group(page, 'Research').getByTestId('group-header').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete…/ }).click();
      await page.getByTestId('delete-category-keep').click();
      await expect(group(page, 'Research')).toHaveCount(0);
      await expect(group(page, 'beta')).toContainText('beta one');
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});
