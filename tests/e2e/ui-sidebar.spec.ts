// Sidebar groups E2E (demo mode): the group menu, rename, categories, move/reorder by menu and by drag and drop, delete.
//   npx vite --config vite.web.config.ts --port 5173 --strictPort
//   npx playwright test tests/e2e/ui-sidebar.spec.ts          (OBSIDIAN_WEB_URL overrides the address)
// Saves screenshots to tests/e2e/screenshots/sidebar-*.png.
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

async function openDemo(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/?demo=1`);
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  await page.waitForTimeout(300);
  return errors;
}

const group = (page: Page, name: string): Locator =>
  page.getByTestId('sidebar-group').filter({ has: page.getByTestId('group-toggle').filter({ hasText: name }) });
const header = (page: Page, name: string): Locator => group(page, name).getByTestId('group-header');
const row = (page: Page, title: string): Locator => page.getByTestId('session-row').filter({ hasText: title });
const groupNames = (page: Page): Promise<string[]> => page.getByTestId('group-toggle').allTextContents();
const menuItem = (page: Page, name: RegExp | string): Locator => page.getByRole('menuitem', { name });

/** The "…" button of a group header only shows while the pointer is over it. */
async function openGroupMenu(page: Page, name: string): Promise<void> {
  await header(page, name).hover();
  await header(page, name).getByTestId('group-menu-button').click();
}

async function rowTitles(g: Locator): Promise<string[]> {
  return (await g.getByTestId('session-row').allInnerTexts()).map((t) => t.split('\n')[0].trim());
}

test.describe('sidebar groups (demo mode)', () => {
  test.describe.configure({ timeout: 60_000 });
  test.beforeAll(async () => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
  });

  test('group menu: rename, move, collapse, reset', async ({ page }) => {
    const errors = await openDemo(page);
    expect(await groupNames(page)).toEqual(['Pinned', 'obsidian-code', 'hearth', 'llama-bench', 'notes']);

    // right-click → the menu
    await header(page, 'hearth').click({ button: 'right' });
    const menu = page.getByTestId('group-menu');
    await expect(menu).toBeVisible();
    for (const label of [/^New session here/, /^Rename/, /^New category/, /^Move up/, /^Move down/, /^Collapse all/, /^Expand all/, /^Copy folder path/, /^Delete…/]) {
      await expect(menuItem(page, label)).toBeVisible();
    }
    await page.mouse.move(700, 500);
    await page.screenshot({ path: join(SHOTS, 'sidebar-group-menu.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });

    // Rename → inline box; Enter saves (the folder itself is unchanged: the tooltip still names it)
    await menuItem(page, /^Rename/).click();
    const input = page.getByTestId('inline-rename');
    await expect(input).toBeFocused();
    await input.fill('Hearth app');
    await page.screenshot({ path: join(SHOTS, 'sidebar-group-rename.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });
    await input.press('Enter');
    await expect(page.getByTestId('group-toggle').filter({ hasText: 'Hearth app' })).toBeVisible();
    await expect(page.getByTestId('group-toggle').filter({ hasText: 'Hearth app' })).toHaveAttribute('title', /hearth$/i);

    // F2 opens it, Escape cancels
    await page.getByTestId('group-toggle').filter({ hasText: 'Hearth app' }).focus();
    await page.keyboard.press('F2');
    await page.getByTestId('inline-rename').fill('Nope');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inline-rename')).toHaveCount(0);
    await expect(page.getByTestId('group-toggle').filter({ hasText: 'Hearth app' })).toBeVisible();

    // double click renames; leaving the box saves
    await page.getByTestId('group-toggle').filter({ hasText: 'Hearth app' }).dblclick();
    await page.getByTestId('inline-rename').fill('Hearth');
    await page.waitForTimeout(250); // the box ignores a blur in its first instants (a menu handing focus back)
    await page.locator('[data-testid="sidebar"]').getByText('Home').click();
    await expect(page.getByTestId('group-toggle').filter({ hasText: /^Hearth$/ })).toBeVisible();
    // ...and the double click did not leave the group folded
    await expect(page.getByTestId('group-toggle').filter({ hasText: /^Hearth$/ })).toHaveAttribute('aria-expanded', 'true');

    // Move down / up by menu, Alt+arrow on the header
    await header(page, 'Hearth').click({ button: 'right' });
    await menuItem(page, /^Move down/).click();
    await expect.poll(() => groupNames(page)).toEqual(['Pinned', 'obsidian-code', 'llama-bench', 'Hearth', 'notes']);
    await page.getByTestId('group-toggle').filter({ hasText: /^Hearth$/ }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => groupNames(page)).toEqual(['Pinned', 'obsidian-code', 'Hearth', 'llama-bench', 'notes']);
    await expect(page.getByTestId('group-toggle').filter({ hasText: /^Hearth$/ })).toBeFocused();
    await header(page, 'obsidian-code').click({ button: 'right' });
    await expect(menuItem(page, /^Move up/)).toHaveAttribute('aria-disabled', 'true'); // first group
    await page.keyboard.press('Escape');

    // collapse / expand: a click folds the group (and remembers it), Collapse all / Expand all do the rest
    await page.getByTestId('group-toggle').filter({ hasText: /^Hearth$/ }).click();
    await expect(page.getByTestId('group-toggle').filter({ hasText: /^Hearth$/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(group(page, 'Hearth').getByTestId('session-row')).toHaveCount(0);
    await header(page, 'llama-bench').click({ button: 'right' });
    await menuItem(page, /^Collapse all/).click();
    await expect(page.locator('[data-testid="group-toggle"][aria-expanded="true"]')).toHaveCount(0);
    await header(page, 'llama-bench').click({ button: 'right' });
    await expect(menuItem(page, /^Collapse all/)).toHaveAttribute('aria-disabled', 'true');
    await menuItem(page, /^Expand all/).click();
    await expect(page.locator('[data-testid="group-toggle"][aria-expanded="false"]')).toHaveCount(0);

    // Reset name
    await header(page, 'Hearth').click({ button: 'right' });
    await menuItem(page, /^Reset name/).click();
    await expect(page.getByTestId('group-toggle').filter({ hasText: /^hearth$/ })).toBeVisible();
    await header(page, 'hearth').hover();
    await page.screenshot({ path: join(SHOTS, 'sidebar-group-hover.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });

    // the "…" button on the header opens the same menu
    await openGroupMenu(page, 'hearth');
    await expect(menuItem(page, /^Move up/)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'sidebar-group-dropdown.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });
    await page.keyboard.press('Escape');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('categories: create, move sessions in and out, new session here, delete', async ({ page }) => {
    const errors = await openDemo(page);

    // New category (from the group menu): asks for a name; it goes under that group and is empty
    await openGroupMenu(page, 'obsidian-code');
    await menuItem(page, /^New category/).click();
    const dialog = page.getByRole('dialog', { name: 'New category' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('new-category-name')).toBeFocused(); // type right away
    await expect(dialog.getByTestId('new-category-create')).toBeDisabled();
    await page.screenshot({ path: join(SHOTS, 'sidebar-new-category.png') });
    await dialog.getByTestId('new-category-name').fill('Research');
    await dialog.getByTestId('new-category-name').press('Enter');
    await expect(dialog).toBeHidden();
    await expect.poll(() => groupNames(page)).toEqual(['Pinned', 'obsidian-code', 'Research', 'hearth', 'llama-bench', 'notes']);
    await expect(group(page, 'Research').getByTestId('group-empty')).toBeVisible();

    // Move to category ▸ (session menu): the session leaves its folder group and joins the category
    await row(page, 'Profile memory usage').click({ button: 'right' });
    await menuItem(page, /^Move to category/).click();
    await expect(page.getByTestId('move-to-category-menu')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'sidebar-session-menu.png'), clip: { x: 0, y: 0, width: 760, height: 900 } });
    await page.getByRole('menuitem', { name: 'Research' }).click();
    await expect(group(page, 'Research').getByTestId('session-row')).toHaveCount(1);
    await expect(group(page, 'Research').getByTestId('group-empty')).toHaveCount(0);
    await expect(group(page, 'hearth').getByTestId('session-row')).toHaveCount(1);
    // a category holds sessions from any folder
    await row(page, 'Benchmark Qwen3.8 27B').click({ button: 'right' });
    await menuItem(page, /^Move to category/).click();
    await page.getByRole('menuitem', { name: 'Research' }).click();
    await expect(group(page, 'Research').getByTestId('session-row')).toHaveCount(2);
    await expect(group(page, 'llama-bench')).toHaveCount(0); // its last session left: the folder group is gone
    await page.screenshot({ path: join(SHOTS, 'sidebar-categories.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });

    // Back to its folder group
    await row(page, 'Benchmark Qwen3.8 27B').click({ button: 'right' });
    await menuItem(page, /^Move to category/).click();
    await page.getByRole('menuitem', { name: /^Back to its folder group/ }).click();
    await expect(group(page, 'Research').getByTestId('session-row')).toHaveCount(1);
    await expect(group(page, 'llama-bench').getByTestId('session-row')).toHaveCount(1);

    // New session here in a category: it starts in the category (in the default folder)
    await header(page, 'Research').click({ button: 'right' });
    await menuItem(page, /^New session here/).click();
    await expect(group(page, 'Research').getByTestId('session-row')).toHaveCount(2);
    await expect(page.getByTestId('chat-title')).toContainText('New session');
    expect(await rowTitles(group(page, 'Research'))).toContain('New session');

    // New category from a session's menu puts the session in it
    await row(page, 'Nightly dependency audit').click({ button: 'right' });
    await menuItem(page, /^Move to category/).click();
    await page.getByRole('menuitem', { name: /^New category/ }).click();
    await page.getByTestId('new-category-name').fill('Ops');
    await page.getByTestId('new-category-create').click();
    await expect(group(page, 'Ops').getByTestId('session-row')).toHaveCount(1);
    await expect(group(page, 'Ops').getByTestId('session-row')).toContainText('Nightly dependency audit');

    // Rename a category (double click)
    await group(page, 'Ops').getByTestId('group-toggle').dblclick();
    await page.getByTestId('inline-rename').fill('Operations');
    await page.getByTestId('inline-rename').press('Enter');
    await expect(group(page, 'Operations')).toHaveCount(1);

    // Delete a category: keep its sessions (they return to their folder groups)
    await header(page, 'Operations').click({ button: 'right' });
    await menuItem(page, /^Delete…/).click();
    const del = page.getByRole('dialog', { name: /Delete the category/ });
    await expect(del).toContainText('It holds 1 session.');
    await page.screenshot({ path: join(SHOTS, 'sidebar-delete-category.png') });
    await del.getByTestId('delete-category-keep').click();
    await expect(del).toBeHidden();
    await expect(group(page, 'Operations')).toHaveCount(0);
    await expect(row(page, 'Nightly dependency audit')).toHaveCount(1); // back in its folder group
    await expect(group(page, 'obsidian-code')).toContainText('Nightly dependency audit');

    // ...or delete them with it
    await header(page, 'Research').click({ button: 'right' });
    await menuItem(page, /^Delete…/).click();
    await del.getByTestId('delete-category-all').click();
    await expect(group(page, 'Research')).toHaveCount(0);
    await expect(row(page, 'Profile memory usage')).toHaveCount(0);
    await expect(row(page, 'Rename GPU phase labels')).toHaveCount(1); // others are untouched

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('deleting a folder group asks first and deletes only its sessions', async ({ page }) => {
    const errors = await openDemo(page);
    const before = await page.getByTestId('session-row').count();
    await header(page, 'hearth').click({ button: 'right' });
    await menuItem(page, /^Delete…/).click();
    const dlg = page.getByRole('dialog', { name: 'Delete 2 sessions?' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('files in the folder are not touched');
    await page.screenshot({ path: join(SHOTS, 'sidebar-delete-folder-group.png') });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(before);
    await header(page, 'hearth').click({ button: 'right' });
    await menuItem(page, /^Delete…/).click();
    await page.getByRole('dialog', { name: 'Delete 2 sessions?' }).getByRole('button', { name: 'Delete 2 sessions' }).click();
    await expect(group(page, 'hearth')).toHaveCount(0);
    await expect(page.getByTestId('session-row')).toHaveCount(before - 2);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('sessions: Move up / Move down and Alt+arrows, the menu shows the GPU choices while clocked in', async ({ page }) => {
    const errors = await openDemo(page);
    const hearth = group(page, 'hearth');
    expect(await rowTitles(hearth)).toEqual(['Hearth: stream TTS in chunks', 'Profile memory usage on long sessions'].map((t) => expect.stringContaining(t.slice(0, 12))));
    const first = await rowTitles(hearth);

    await hearth.getByTestId('session-row').first().click({ button: 'right' });
    await expect(menuItem(page, /^Move up/)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menuitemradio', { name: /Clock out if it stops responding/ })).toBeVisible(); // GPU clocked in
    await menuItem(page, /^Move down/).click();
    await expect.poll(() => rowTitles(hearth)).toEqual([first[1], first[0]]);

    await hearth.getByTestId('session-row').last().focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => rowTitles(hearth)).toEqual([first[0], first[1]]);
    await expect(hearth.getByTestId('session-row').first()).toBeFocused(); // the moved row keeps the keyboard focus

    // the Delete key asks to delete the focused session / group (and Cancel keeps it)
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('dialog', { name: 'Delete session?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(hearth.getByTestId('session-row')).toHaveCount(2);
    await header(page, 'hearth').getByTestId('group-toggle').focus();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog', { name: 'Delete 2 sessions?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(hearth.getByTestId('session-row')).toHaveCount(2);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('drag and drop: reorder sessions, move them into a category, reorder groups', async ({ page }) => {
    const errors = await openDemo(page);

    // a category to drop into
    await openGroupMenu(page, 'obsidian-code');
    await menuItem(page, /^New category/).click();
    await page.getByTestId('new-category-name').fill('Drops');
    await page.getByTestId('new-category-create').click();
    await expect(group(page, 'Drops')).toBeVisible();

    // drag a session onto the (empty) category
    await row(page, 'Profile memory usage').dragTo(header(page, 'Drops'));
    await expect(group(page, 'Drops').getByTestId('session-row')).toHaveCount(1);
    await expect(group(page, 'Drops')).toContainText('Profile memory usage');

    // reorder inside a group: the last row dropped on the first one's upper half goes to the top
    const code = group(page, 'obsidian-code');
    const titles = await rowTitles(code);
    const lastRow = code.getByTestId('session-row').last();
    const firstRow = code.getByTestId('session-row').first();
    await lastRow.dragTo(firstRow, { targetPosition: { x: 80, y: 3 } });
    await expect.poll(() => rowTitles(code)).toEqual([titles[titles.length - 1], ...titles.slice(0, -1)]);

    // ...onto a row of a category: below it (lower half), then above it (upper half)
    await row(page, 'Nightly dependency audit').dragTo(group(page, 'Drops').getByTestId('session-row').first(), { targetPosition: { x: 80, y: 24 } });
    await expect.poll(() => rowTitles(group(page, 'Drops'))).toEqual([expect.stringContaining('Profile memory usage'), expect.stringContaining('Nightly dependency audit')]);
    await page.screenshot({ path: join(SHOTS, 'sidebar-dnd-category.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });
    await row(page, 'Nightly dependency audit').dragTo(row(page, 'Profile memory usage'), { targetPosition: { x: 80, y: 3 } });
    await expect.poll(() => rowTitles(group(page, 'Drops'))).toEqual([expect.stringContaining('Nightly dependency audit'), expect.stringContaining('Profile memory usage')]);

    // a session never changes folder: another folder's group refuses it
    await row(page, 'Benchmark Qwen3.8 27B').dragTo(header(page, 'notes'));
    await expect(group(page, 'llama-bench').getByTestId('session-row')).toHaveCount(1);
    await expect(group(page, 'notes').getByTestId('session-row')).toHaveCount(1);

    // back to its own folder group by dropping on the folder's header
    await row(page, 'Profile memory usage').dragTo(header(page, 'hearth'));
    await expect(group(page, 'hearth')).toContainText('Profile memory usage');
    await expect(group(page, 'Drops').getByTestId('session-row')).toHaveCount(1);
    await expect(group(page, 'Drops')).toContainText('Nightly dependency audit');

    // reorder the groups: drag a header onto another one
    const order = await groupNames(page);
    await header(page, 'llama-bench').dragTo(header(page, 'obsidian-code'));
    await expect.poll(() => groupNames(page)).toEqual(['Pinned', 'llama-bench', ...order.filter((n) => n !== 'Pinned' && n !== 'llama-bench')]);

    // dropping on Pinned pins
    await row(page, 'Nightly dependency audit').dragTo(page.getByTestId('sidebar-group').first().getByTestId('group-header'));
    await expect(page.getByTestId('sidebar-group').first()).toContainText('Nightly dependency audit');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('while a session is dragged, the place it would land is marked', async ({ page }) => {
    const errors = await openDemo(page);
    const code = group(page, 'obsidian-code');
    const from = (await code.getByTestId('session-row').nth(3).boundingBox())!;
    const over = (await code.getByTestId('session-row').nth(1).boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + 14);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 4, { steps: 3 });
    await page.mouse.move(over.x + 60, over.y + 5, { steps: 8 });
    await expect(page.locator('[data-testid="session-row"] > span.bg-acc')).toHaveCount(1); // a line above the row
    await page.screenshot({ path: join(SHOTS, 'sidebar-dnd-marker.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });
    // over a category / folder header: the header is lit
    const hearth = (await header(page, 'hearth').boundingBox())!;
    await page.mouse.move(hearth.x + 60, hearth.y + 10, { steps: 6 });
    await expect(page.locator('[data-testid="group-header"].ob-selected')).toHaveCount(0); // another folder: not allowed, no marker
    await page.mouse.move(over.x + 60, over.y + 5, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('[data-testid="session-row"] > span.bg-acc')).toHaveCount(0); // marker gone after the drop
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('searching still filters across all groups (and moving is off while it runs)', async ({ page }) => {
    const errors = await openDemo(page);
    await header(page, 'hearth').click({ button: 'right' });
    await menuItem(page, /^Rename/).click();
    await page.getByTestId('inline-rename').fill('Frontend');
    await page.getByTestId('inline-rename').press('Enter');
    await page.getByLabel('Search sessions').fill('stream');
    await expect(page.getByTestId('session-row')).toHaveCount(1); // only "Hearth: stream TTS in chunks" matches
    expect(await groupNames(page)).toEqual(['Frontend']);
    // the name of a group is searchable too
    await page.getByLabel('Search sessions').fill('frontend');
    await expect(group(page, 'Frontend').getByTestId('session-row')).toHaveCount(2);
    await header(page, 'Frontend').click({ button: 'right' });
    await expect(menuItem(page, /^Move up/)).toHaveAttribute('aria-disabled', 'true');
    await expect(menuItem(page, /^Move down/)).toHaveAttribute('aria-disabled', 'true');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
