// Models view E2E (owner: ui-views). Drives the renderer in DEMO MODE against the Vite dev server:
//   npx vite --config vite.web.config.ts --port 5173 --strictPort
//   npx playwright test tests/e2e/ui-models.spec.ts           (OBSIDIAN_WEB_URL=http://localhost:5191 for another port)
// The demo answers hub.* from recorded Hugging Face responses, so this runs offline. Screenshots: tests/e2e/screenshots/models-*.png.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

declare const document: any;
declare const getComputedStyle: any;

const BASE = process.env.OBSIDIAN_WEB_URL ?? 'http://localhost:5173';
const SHOTS = join(__dirname, 'screenshots');

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(BASE, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function openDemo(page: Page, query = '', width = 1440, height = 900): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?demo=1${query}`);
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  return errors;
}

/** The GPU menu → Browse models… (the entry point in the menu strip). */
async function openModels(page: Page): Promise<void> {
  await page.getByTestId('menu-gpu').click();
  await page.getByRole('menuitem', { name: /Browse models/ }).click();
  await expect(page.getByTestId('models-view')).toBeVisible();
}

const rows = (page: Page) => page.getByTestId('models-row');

test.describe('models view (demo mode)', () => {
  test.beforeAll(async () => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
  });

  test('browse, search, sort and open a repo', async ({ page }) => {
    const errors = await openModels0(page);
    await expect(page.getByTestId('view-title')).toHaveText(/Models/);
    await expect(rows(page).first()).toBeVisible();
    await expect(rows(page)).toHaveCount(9);
    // seeded favorites carry a lit star
    await expect(page.locator('[data-testid="models-row"][data-repo="unsloth/Qwen3.8-27B-GGUF"] [data-testid="models-favorite"]')).toHaveAttribute('data-on', 'true');
    await page.screenshot({ path: join(SHOTS, 'models-browse.png') });

    // search (debounced) narrows the list
    await page.getByTestId('models-search').fill('gemma');
    await expect(rows(page)).toHaveCount(2);
    await page.getByTestId('models-search').fill('');
    await expect(rows(page)).toHaveCount(9);

    // sort by likes puts the most liked first
    await page.getByRole('combobox', { name: 'Sort by' }).click();
    await page.getByRole('option', { name: 'Most likes' }).click();
    await expect(rows(page).first()).toHaveAttribute('data-repo', 'unsloth/Qwen3.8-27B-GGUF');

    // a pasted link opens the repo directly
    await page.getByTestId('models-search').fill('https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF');
    await expect(page.getByTestId('models-open-direct')).toBeVisible();
    await page.getByTestId('models-open-direct').click();
    await expect(page.getByTestId('models-detail')).toHaveAttribute('data-repo', 'unsloth/gemma-4-E4B-it-GGUF');
    await expect(page.getByTestId('models-variants')).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('details: quants fit the profile, a pick is recommended, add and remove', async ({ page }) => {
    const errors = await openModels0(page);
    await rows(page).first().click();
    const detail = page.getByTestId('models-detail');
    await expect(detail).toHaveAttribute('data-repo', 'unsloth/Qwen3.8-27B-GGUF');
    await expect(page.getByTestId('models-variant').first()).toBeVisible();
    await expect(page.getByTestId('models-detail-meta')).toContainText('downloads');
    await expect(page.getByTestId('models-detail-meta')).toContainText('apache-2.0');
    await expect(page.getByTestId('models-recommended')).toContainText('Recommended for Light');
    await expect(page.locator('[data-testid="models-variant"][data-recommended]')).toHaveCount(1);
    // the BF16 file is bigger than the Light profile: not marked as fitting it
    await expect(page.locator('[data-testid="models-variant"][data-quant="BF16"]')).not.toHaveAttribute('data-fits', 'true');
    await page.screenshot({ path: join(SHOTS, 'models-detail.png') });

    // add the recommended quant
    await page.getByTestId('models-add-recommended').click();
    await expect(page.locator('[data-testid="models-variant"][data-recommended]')).toContainText('added');
    await expect(page.getByTestId('models-tab-mine')).toContainText('1');

    // My models lists it and can make it a profile default
    await page.getByTestId('models-tab-mine').click();
    const mine = page.getByTestId('models-mine-row');
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText('Qwen3.8-27B');
    await expect(mine).toContainText('Light');
    await page.getByTestId('models-use-default').click();
    await page.getByRole('menuitem', { name: 'Light' }).click();
    await expect(mine.getByTestId('models-default-badge')).toHaveText('Light');
    await page.screenshot({ path: join(SHOTS, 'models-mine.png') });

    // Recommended tab: the default of Light changed, so it offers to restore it
    await page.getByTestId('models-tab-recommended').click();
    await expect(page.getByTestId('models-default-changed')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'models-recommended.png') });
    await page.getByTestId('models-restore-default').click();
    await expect(page.getByTestId('models-default-changed')).toHaveCount(0);
    await expect(page.getByTestId('models-restore-default')).toHaveCount(0);

    // the GPU view's picker lists the added model (marked "added") and links back here
    await page.getByTestId('menu-gpu').click();
    await page.getByRole('menuitem', { name: 'Open GPU view' }).click();
    await expect(page.getByTestId('gpu-model-picker')).toBeVisible();
    // the picker groups models by the Uncensored / Standard toggle; the added model is a standard build
    await page.getByTestId('gpu-variant-standard').click();
    await expect(page.getByTestId('gpu-model-picker')).toContainText('Qwen3.8-27B');
    await expect(page.getByTestId('gpu-model-picker').getByText('added', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'models-gpu-picker.png') });
    await page.getByTestId('gpu-browse-models').click();
    await expect(page.getByTestId('models-view')).toBeVisible();

    // remove it again (confirm dialog)
    await page.getByTestId('models-tab-mine').click();
    await page.getByTestId('models-remove').click();
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
    await expect(page.getByText('No added models yet')).toBeVisible();
    await expect(page.getByTestId('models-tab-mine')).not.toContainText('1');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('favorites: star a repo, see it in the Favorites tab, unstar', async ({ page }) => {
    const errors = await openModels0(page);
    await expect(page.getByTestId('models-tab-favorites')).toContainText('2');
    const star = page.locator('[data-testid="models-row"][data-repo="unsloth/gemma-4-12b-it-GGUF"] [data-testid="models-favorite"]');
    await star.click();
    await expect(page.getByTestId('models-tab-favorites')).toContainText('3');
    await page.getByTestId('models-tab-favorites').click();
    await expect(page.getByTestId('models-favorites-list')).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).first()).toHaveAttribute('data-repo', 'unsloth/gemma-4-12b-it-GGUF'); // newest first
    // rows fill in downloads, likes and the update age once the details arrive (until then they show "—")
    await expect(rows(page).first()).toContainText('1.6M');
    await expect(page.getByTestId('models-favorites-list').getByText('—')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'models-favorites.png') });
    await page.locator('[data-testid="models-row"][data-repo="unsloth/gemma-4-12b-it-GGUF"] [data-testid="models-favorite"]').click();
    await expect(rows(page)).toHaveCount(2);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the recommended tab shows the built-in catalog per profile, read-only', async ({ page }) => {
    const errors = await openModels0(page);
    await page.getByTestId('models-tab-recommended').click();
    await expect(page.getByTestId('models-profile-light')).toBeVisible();
    await expect(page.getByTestId('models-profile-light').getByTestId('models-recommended-row').first()).toBeVisible();
    await expect(page.getByTestId('models-recommended-tab').getByRole('button', { name: /remove|add/i })).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('every tab fits a 1024px window without horizontal overflow', async ({ page }) => {
    await openDemo(page, '', 1024, 700);
    await openModels(page);
    const overflow = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid=models-view]');
        const right = el.getBoundingClientRect().right;
        const wide = ([...el.querySelectorAll('*')] as any[]).filter((n: any) => n.getBoundingClientRect().right > right + 1 && getComputedStyle(n).position !== 'fixed' && !n.closest('[role=listbox], [data-radix-scroll-area-viewport]'));
        return { scroll: el.scrollWidth - el.clientWidth, wide: wide.slice(0, 3).map((n: any) => n.tagName + '.' + String(n.className).slice(0, 60)) };
      });
    const check = async (name: string) => {
      const r = await overflow();
      expect(r.scroll, `${name}: ${r.wide.join(', ')}`).toBeLessThanOrEqual(1);
    };
    await expect(rows(page).first()).toBeVisible();
    await check('browse');
    await rows(page).first().click();
    await expect(page.getByTestId('models-variants')).toBeVisible();
    await check('browse + detail');
    await page.getByTestId('models-add-recommended').click();
    await expect(page.getByTestId('models-tab-mine')).toContainText('1');
    await page.getByTestId('models-tab-favorites').click();
    await expect(page.getByTestId('models-favorites-list')).toBeVisible();
    await check('favorites');
    await page.getByTestId('models-tab-mine').click();
    await expect(page.getByTestId('models-mine-row')).toHaveCount(1);
    await check('my models');
    await page.screenshot({ path: join(SHOTS, 'models-mine-1024.png') });
    await page.getByTestId('models-tab-recommended').click();
    await expect(page.getByTestId('models-profile-light')).toBeVisible();
    await check('recommended');
  });

  test('the command palette opens it', async ({ page }) => {
    const errors = await openDemo(page);
    await page.getByTestId('palette-trigger').click();
    await page.getByRole('option', { name: /Browse models/ }).click();
    await expect(page.getByTestId('models-view')).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Hugging Face trouble shows a friendly error with Retry', async ({ page }) => {
    await openDemo(page, '&hub=error');
    await openModels(page);
    await expect(page.getByTestId('models-error')).toContainText('limiting requests');
    await expect(page.getByTestId('models-error').getByRole('button', { name: 'Retry' })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'models-error.png') });
  });

  test('narrow window: the list and the detail take turns', async ({ page }) => {
    await openDemo(page, '', 980, 720);
    await openModels(page);
    await expect(rows(page).first()).toBeVisible();
    await rows(page).first().click();
    await expect(page.getByTestId('models-variants')).toBeVisible();
    await expect(page.getByTestId('models-results')).toBeHidden();
    await page.screenshot({ path: join(SHOTS, 'models-narrow.png') });
    await page.getByRole('button', { name: 'Back to the list' }).click();
    await expect(page.getByTestId('models-results')).toBeVisible();
  });
});

/** openDemo + open the Models view through the GPU menu. */
async function openModels0(page: Page): Promise<string[]> {
  const errors = await openDemo(page);
  await openModels(page);
  return errors;
}
