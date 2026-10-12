// ui-views E2E (owner: ui-views). Drives GPU, Activity, Scheduled and Settings in DEMO MODE against the Vite dev server:
//   npx vite --config vite.web.config.ts --port 5175 --strictPort
//   npx playwright test tests/e2e/ui-views.spec.ts
// Saves design-review screenshots to tests/e2e/screenshots/views-*.png.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The node tsconfig has no DOM lib: these globals only exist inside page.evaluate callbacks (the browser).
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;
declare const document: any;
declare const getComputedStyle: any;

const BASE = process.env.OBSIDIAN_WEB_URL ?? 'http://localhost:5175';
const SHOTS = join(__dirname, 'screenshots');

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

interface Demo {
  data: Record<string, any>;
  emit(event: string, data: unknown): void;
  simulateDisconnect(ms: number): void;
}

/** Open the app in demo mode at the given size; returns the collected console / page errors. */
async function openDemo(page: Page, width = 1440, height = 900): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?demo=1`);
  await expect(page.getByTestId('app-title')).toHaveText('Obsidian Code');
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  return errors;
}

async function goto(page: Page, route: 'gpu' | 'activity' | 'schedules' | 'settings') {
  await page.getByTestId(`nav-${route}`).click();
}

/** Run code against the demo transport (window.__obsidianDemo). */
async function demo<T>(page: Page, fn: (t: Demo) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__obsidianDemo)`) as Promise<T>;
}

async function setGpu(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(
    (p) => {
      const t = (window as unknown as { __obsidianDemo: Demo }).__obsidianDemo;
      t.data.gpuStatus = { ...t.data.gpuStatus, ...p };
      t.emit('gpu.status', t.data.gpuStatus);
    },
    patch,
  );
}

const STEPS = [
  ['searching', 'Check budget and find a GPU'],
  ['renting', 'Rent the instance and boot'],
  ['connecting', 'Connect over SSH'],
  ['downloading', 'Download the model'],
  ['loading', 'Load the model into VRAM'],
  ['ready', 'Ready'],
];
const steps = (active: number) => STEPS.map(([id, label], i) => ({ id, label, state: i < active ? 'done' : i === active ? 'active' : 'todo' }));

async function settle(page: Page, ms = 450) {
  await page.waitForTimeout(ms);
  await page.mouse.move(0, 0);
}

test.describe('ui-views (demo mode)', () => {
  test.beforeAll(async () => {
    test.skip(!(await serverUp()), `Vite dev server not reachable at ${BASE}`);
  });

  // ───────────────────────────── GPU ─────────────────────────────

  test('GPU: ready state, profile prices, variant toggle', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'gpu');
    const panel = page.getByTestId('gpu-panel');
    await expect(panel).toHaveAttribute('data-phase', 'ready');
    await expect(page.getByTestId('gpu-timer')).toContainText(':');
    await expect(page.getByTestId('gpu-steps').locator('li[data-state=done]')).toHaveCount(6);
    await expect(page.getByTestId('gpu-main-button')).toHaveText('Clock out');

    // live price range (cheapest - median) and hours left from gpu.offers
    await expect(page.getByTestId('gpu-price-light')).toContainText('$0.52');
    await expect(page.getByTestId('gpu-price-light')).toContainText('$0.61');
    await expect(page.getByTestId('gpu-hours-light')).toContainText('h left');
    await expect(page.getByTestId('gpu-price-standard')).toContainText('$1.19');
    await expect(page.getByTestId('gpu-price-max')).toContainText('$2.64');

    // other profiles are locked while clocked in
    await expect(page.getByTestId('gpu-profile-standard')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('gpu-profile-light')).toContainText('active');

    // the running model is marked, variant toggle is visible
    await expect(page.getByTestId('gpu-model-qwen38-27b-uncensored-hauhau-q5kp')).toContainText('running');
    await expect(page.getByTestId('gpu-variant-toggle')).toBeVisible();
    await expect(page.getByTestId('gpu-spend')).toContainText('$37.42');
    await expect(page.getByTestId('gpu-credit')).toContainText('$84.17');
    await expect(page.getByTestId('gpu-history-row')).toHaveCount(8);

    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-gpu-ready.png') });
    expect(errors).toEqual([]);
  });

  test('GPU: off state, profile + model picker with the Uncensored / Standard toggle', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'gpu');
    await setGpu(page, { phase: 'off', message: 'Off', steps: [], clockedInAt: undefined, readyAt: undefined, pricePerHour: undefined, endpoint: undefined, instanceId: undefined, sessionCost: 0 });
    await expect(page.getByTestId('gpu-panel')).toHaveAttribute('data-phase', 'off');
    await expect(page.getByTestId('gpu-main-button')).toHaveText('Clock in');
    await expect(page.getByTestId('gpu-main-button')).toBeEnabled();
    await expect(page.getByTestId('gpu-summary')).toContainText('Light');

    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-gpu-off.png') });

    // pick the Standard profile: its default model is the experimental Flash-Next
    await page.getByTestId('gpu-profile-standard').click();
    await expect(page.getByTestId('gpu-profile-standard')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('gpu-model-picker')).toContainText('Model for Standard');
    const uncensored = page.getByTestId('gpu-model-qwen38-flash-next-uncensored-huihui-v2-q4kxl');
    await expect(uncensored).toHaveAttribute('data-selected', 'true');
    await expect(uncensored.getByTestId('gpu-experimental-badge')).toBeVisible();
    await expect(page.getByTestId('gpu-summary')).toContainText('Standard');

    // Uncensored -> Standard picks the sibling of the same family
    await page.getByTestId('gpu-variant-standard').click();
    await expect(page.getByTestId('gpu-model-qwen38-flash-next-standard-ggml-iq4nl')).toHaveAttribute('data-selected', 'true');
    // a model of the other family in the same variant is selectable too
    await page.getByTestId('gpu-model-qwen38-27b-standard-unsloth-q8').click();
    await expect(page.getByTestId('gpu-model-qwen38-27b-standard-unsloth-q8')).toHaveAttribute('data-selected', 'true');
    // ... and back: 27B standard -> 27B uncensored
    await page.getByTestId('gpu-variant-uncensored').click();
    await expect(page.getByTestId('gpu-model-qwen38-27b-uncensored-hauhau-q8kp')).toHaveAttribute('data-selected', 'true');

    // Max: GLM-5.3 Flash, uncensored <-> standard
    await page.getByTestId('gpu-profile-max').click();
    await expect(page.getByTestId('gpu-model-glm53-flash-uncensored-huihui-iq4xs')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('gpu-model-glm53-flash-uncensored-huihui-iq4xs')).toContainText('warm-up');
    await page.getByTestId('gpu-variant-standard').click();
    await expect(page.getByTestId('gpu-model-glm53-flash-standard-unsloth-iq4xs')).toHaveAttribute('data-selected', 'true');

    // the choice is what Clock in will start
    await expect(page.getByTestId('gpu-summary')).toContainText('Max');
    await expect(page.getByTestId('gpu-summary')).not.toContainText('uncensored');
    expect(errors).toEqual([]);
  });

  test('GPU: clock in walks the checklist, then clock out (with a confirm only while a session runs)', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'gpu');
    await setGpu(page, { phase: 'off', message: 'Off', steps: [], clockedInAt: undefined, readyAt: undefined, pricePerHour: undefined, endpoint: undefined, instanceId: undefined, sessionCost: 0 });
    await page.getByTestId('gpu-main-button').click();

    // downloading: progress bar + step list with one active step
    await expect(page.getByTestId('gpu-panel')).toHaveAttribute('data-phase', 'downloading', { timeout: 20_000 });
    await expect(page.getByTestId('gpu-steps').locator('li[data-state=active]')).toHaveCount(1);
    await expect(page.getByTestId('gpu-steps').locator('li[data-state=done]').first()).toBeVisible();
    await expect(page.getByTestId('gpu-message')).toContainText('Downloading model');
    await expect(page.getByTestId('gpu-main-button')).toHaveText('Cancel clock-in');
    await settle(page, 200);
    await page.screenshot({ path: join(SHOTS, 'views-gpu-downloading.png') });

    await expect(page.getByTestId('gpu-panel')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 });
    await expect(page.getByTestId('gpu-main-button')).toHaveText('Clock out');

    // a session is running on the GPU model -> confirm first
    await page.evaluate(() => {
      const t = (window as unknown as { __obsidianDemo: Demo }).__obsidianDemo;
      const s = t.data.sessions.find((x: { id: string }) => x.id === 's-bench');
      s.status = 'running';
      const { messages: _m, todos: _t, changedFiles: _c, ...summary } = s;
      t.emit('session.updated', summary);
    });
    await page.getByTestId('gpu-main-button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Clock out while work is running?');
    await expect(page.getByTestId('gpu-confirm-sessions')).toContainText('Benchmark Qwen3.8 27B');
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('gpu-panel')).toHaveAttribute('data-phase', 'ready');

    // nothing running anymore -> clock out goes straight through
    await page.evaluate(() => {
      const t = (window as unknown as { __obsidianDemo: Demo }).__obsidianDemo;
      const s = t.data.sessions.find((x: { id: string }) => x.id === 's-bench');
      s.status = 'idle';
      const { messages: _m, todos: _t, changedFiles: _c, ...summary } = s;
      t.emit('session.updated', summary);
    });
    await page.getByTestId('gpu-main-button').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('gpu-panel')).toHaveAttribute('data-phase', 'off', { timeout: 10_000 });
    // the finished rental shows up in the history
    await expect(page.getByTestId('gpu-history-row').first()).toContainText('Clocked out');
    expect(errors).toEqual([]);
  });

  test('GPU: orphan warning, parked instance, server log, API key missing', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'gpu');
    await setGpu(page, {
      phase: 'off',
      message: 'Off',
      steps: [],
      clockedInAt: undefined,
      pricePerHour: undefined,
      sessionCost: 0,
      orphanInstanceIds: [26500123, 26500456],
      parked: { instanceId: 26418220, profileId: 'light', modelId: 'qwen38-27b-uncensored-hauhau-q5kp', gpuName: 'RTX 5090', storageCostPerHour: 0.012, parkedAt: Date.now() - 3 * 3600_000 },
    });
    await expect(page.getByTestId('gpu-orphan-banner')).toContainText('2 untracked instances');
    await expect(page.getByTestId('gpu-parked')).toContainText('#26418220');
    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-gpu-orphans.png') });

    await page.getByTestId('gpu-orphan-destroy').click();
    await expect(page.getByTestId('gpu-orphan-banner')).toHaveCount(0);

    // destroy the parked instance (confirm first)
    await page.getByTestId('gpu-parked-destroy').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Destroy instance' }).click();
    await expect(page.getByTestId('gpu-parked')).toHaveCount(0);
    await expect(page.getByTestId('gpu-safety')).toBeVisible();

    // server log viewer
    await page.getByTestId('gpu-log-toggle').click();
    await expect(page.getByTestId('gpu-log-text')).toContainText('llama');

    // API key missing: empty state with a button to Settings, clock-in disabled
    await demo(page, (t) => {
      t.data.secrets['vast.apiKey'] = false;
      t.simulateDisconnect(150);
    });
    await expect(page.getByTestId('gpu-no-key')).toBeVisible();
    await expect(page.getByTestId('gpu-main-button')).toBeDisabled();
    await expect(page.getByTestId('gpu-clock-disabled-reason')).toContainText('API key');
    await page.getByTestId('gpu-open-settings').click();
    await expect(page.getByTestId('settings-view')).toHaveAttribute('data-section', 'vast');
    await expect(page.getByTestId('settings-section-vast')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('GPU: 1024px layout has no horizontal overflow', async ({ page }) => {
    await openDemo(page, 1024, 700);
    await goto(page, 'gpu');
    await expect(page.getByTestId('gpu-panel')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=gpu-view]') as any;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-gpu-1024.png') });
  });

  test('every view fits a 1024px window without horizontal overflow', async ({ page }) => {
    const errors = await openDemo(page, 1024, 700);
    const overflow = (testId: string) =>
      page.evaluate((id) => {
        const el = document.querySelector(`[data-testid=${id}]`) as any;
        const wide = [...el.querySelectorAll('*')].filter((n: any) => n.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 && getComputedStyle(n).position !== 'fixed' && !n.closest('table, [data-radix-scroll-area-viewport], pre, textarea'));
        return { scroll: el.scrollWidth - el.clientWidth, wide: wide.slice(0, 3).map((n: any) => n.tagName + '.' + String(n.className).slice(0, 60)) };
      }, testId);
    for (const [route, id] of [['activity', 'activity-view'], ['schedules', 'schedules-view'], ['gpu', 'gpu-view']] as const) {
      await goto(page, route);
      await expect(page.getByTestId(id)).toBeVisible();
      const r = await overflow(id);
      expect(r.scroll, `${route}: ${r.wide.join(', ')}`).toBeLessThanOrEqual(1);
    }
    await goto(page, 'settings');
    for (const section of ['models', 'vast', 'permissions', 'mcp', 'memory']) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
      const r = await overflow('settings-scroll');
      expect(r.scroll, `settings/${section}: ${r.wide.join(', ')}`).toBeLessThanOrEqual(1);
    }
    expect(errors).toEqual([]);
  });

  test('without a core every view explains it instead of loading forever', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE);
    await expect(page.getByTestId('app-title')).toBeVisible();
    for (const route of ['gpu', 'activity', 'schedules', 'settings'] as const) {
      await goto(page, route);
      await expect(page.getByTestId('core-missing')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  // ───────────────────────────── Activity ─────────────────────────────

  test('Activity: counters, groups, pending requests, Stop and Open', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'activity');
    await expect(page.getByTestId('activity-view')).toBeVisible();
    await expect(page.getByTestId('activity-running')).toBeVisible();

    const running = page.locator('[data-testid=activity-row][data-status=running]');
    const n = await running.count();
    expect(n).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId('activity-count-running').locator('[data-value]')).toHaveAttribute('data-value', String(n));
    const waitingRows = await page.getByTestId('activity-waiting').getByTestId('activity-row').count();
    const pendingRows = await page.getByTestId('activity-pending-row').count();
    expect(waitingRows).toBeGreaterThanOrEqual(1);
    expect(pendingRows).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('activity-count-waiting').locator('[data-value]')).toHaveAttribute('data-value', String(Math.max(waitingRows, pendingRows)));
    await expect(page.getByTestId('activity-count-failed').locator('[data-value]')).toHaveAttribute('data-value', '1');
    await expect(page.getByTestId('activity-recent').getByTestId('activity-row').first()).toBeVisible();
    // each kind is represented
    for (const kind of ['session', 'subagent', 'shell', 'schedule_run', 'gpu']) await expect(page.locator(`[data-testid=activity-row][data-kind=${kind}]`).first()).toBeVisible();

    // pending permission across sessions with a jump link
    await expect(page.getByTestId('activity-pending')).toContainText('Run: rm -rf out release');
    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-activity.png') });

    // filter by kind
    await page.getByRole('tab', { name: /Shells/ }).click();
    const kinds = await page.locator('[data-testid=activity-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    expect(new Set(kinds)).toEqual(new Set(['shell']));
    await page.getByRole('tab', { name: /^All/ }).click();

    // Stop a running shell: it leaves the running group
    const shellRow = page.locator('[data-testid=activity-row][data-kind=shell][data-status=running]').first();
    await shellRow.getByTestId('activity-stop').click();
    await expect(page.locator('[data-testid=activity-row][data-status=running]')).toHaveCount(n - 1);
    await expect(page.getByTestId('activity-recent').locator('[data-status=stopped]').first()).toBeVisible();

    // Stopping the GPU asks first
    await page.locator('[data-testid=activity-row][data-kind=gpu]').getByTestId('activity-stop').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Clock out the GPU?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Open jumps to the session; the pending Review link does too
    await page.getByTestId('activity-pending-row').filter({ hasText: 'rm -rf out release' }).getByTestId('activity-pending-open').click();
    await expect(page.getByTestId('chat-title')).toContainText('Clean up stale build artifacts');
    expect(errors).toEqual([]);
  });

  // ───────────────────────────── Schedules ─────────────────────────────

  test('Schedules: list, enable switch, run now, delete', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'schedules');
    const rows = page.getByTestId('schedule-row');
    await expect(rows).toHaveCount(5);
    const audit = page.locator('[data-testid=schedule-row][data-name="Nightly dependency audit"]');
    await expect(audit.getByTestId('schedule-words')).toHaveText('Every day at 02:00');
    await expect(audit.getByTestId('schedule-next')).toContainText('next run in');
    await expect(audit.getByTestId('schedule-status')).toHaveText('Succeeded');
    await expect(page.locator('[data-testid=schedule-row][data-name="Weekday standup summary"]').getByTestId('schedule-words')).toHaveText('Weekdays at 08:30');
    await expect(page.locator('[data-testid=schedule-row][data-name="Weekly benchmark on Vast"]').getByTestId('schedule-status')).toHaveText('Failed');
    await expect(page.locator('[data-testid=schedule-row][data-name="Weekly benchmark on Vast"]')).toContainText('auto clock-in');
    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-schedules.png') });

    // enable switch
    await audit.getByRole('switch').click();
    await expect(audit).toHaveAttribute('data-enabled', 'false');
    await expect(audit.getByTestId('schedule-next')).toContainText('not scheduled');
    await audit.getByRole('switch').click();
    await expect(audit).toHaveAttribute('data-enabled', 'true');
    await expect(audit.getByTestId('schedule-next')).toContainText('next run in');

    // run now starts a session (it shows up in the sidebar)
    const before = await page.getByTestId('session-row').count();
    await audit.getByTestId('schedule-run').click();
    await expect(page.getByTestId('session-row')).toHaveCount(before + 1);

    // delete (with confirmation)
    await audit.getByTestId('schedule-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete schedule' }).click();
    await expect(rows).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test('Schedules: dialog validation, presets, create and edit', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'schedules');
    await page.getByTestId('schedule-new').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('New schedule');

    // submitting an empty form shows inline errors and keeps the dialog open
    await page.getByTestId('schedule-cwd').fill('');
    await page.getByTestId('schedule-save').click();
    await expect(dialog).toContainText('Give the schedule a name');
    await expect(dialog).toContainText('Write the prompt the agent should run');
    await expect(dialog).toContainText('Choose the folder the agent works in');
    await expect(page.getByTestId('schedule-name')).toBeFocused();

    await page.getByTestId('schedule-name').fill('Morning standup');
    await page.getByTestId('schedule-prompt').fill('Summarize yesterday’s commits as standup notes.');
    await page.getByTestId('schedule-cwd').fill('not a path');
    await expect(dialog).toContainText('Use an absolute path');
    await page.getByTestId('schedule-cwd').fill('E:\\programming projects\\hearth');

    // custom cron: invalid, then valid with a plain-words preview and the next runs
    await dialog.getByRole('combobox', { name: 'Schedule type' }).click();
    await page.getByRole('option', { name: 'Custom cron' }).click();
    await page.getByTestId('schedule-cron').fill('every day');
    await page.getByTestId('schedule-save').click();
    await expect(page.getByTestId('schedule-error')).toBeVisible();
    await page.getByTestId('schedule-cron').fill('30 8 * * 1-5');
    await expect(page.getByTestId('schedule-preview')).toContainText('Weekdays at 08:30');
    await expect(page.getByTestId('schedule-preview')).toContainText('Next:');

    // every N hours validates its number
    await dialog.getByRole('combobox', { name: 'Schedule type' }).click();
    await page.getByRole('option', { name: 'Every N hours' }).click();
    await page.getByTestId('schedule-hours').fill('0');
    await expect(page.getByTestId('schedule-error')).toContainText('between 1 and 23');
    await page.getByTestId('schedule-hours').fill('6');
    await expect(page.getByTestId('schedule-preview')).toContainText('Every 6 hours');

    // once at: the past is rejected
    await dialog.getByRole('combobox', { name: 'Schedule type' }).click();
    await page.getByRole('option', { name: 'Once at' }).click();
    await page.getByTestId('schedule-once').fill('2020-01-01T09:00');
    await page.getByTestId('schedule-once').blur();
    await expect(page.getByTestId('schedule-error')).toContainText('future');

    // back to weekdays at HH:MM
    await dialog.getByRole('combobox', { name: 'Schedule type' }).click();
    await page.getByRole('option', { name: 'Weekdays at' }).click();
    await page.getByTestId('schedule-time').fill('08:30');
    await expect(page.getByTestId('schedule-preview')).toContainText('Weekdays at 08:30');

    // auto clock-in needs a Vast model and shows the cost warning
    const auto = dialog.getByRole('switch', { name: 'Allow auto clock-in' });
    await expect(auto).toBeDisabled();
    await dialog.getByRole('combobox', { name: 'Model' }).click();
    await page.getByRole('option', { name: /Qwen3\.8 27B Uncensored/ }).click();
    await expect(auto).toBeEnabled();
    await auto.click();
    await expect(page.getByTestId('schedule-cost-warning')).toContainText('spends real money');
    await expect(page.getByTestId('schedule-cost-warning')).toContainText('$2.50/h');
    await dialog.getByRole('combobox', { name: 'Permission mode' }).click();
    await page.getByRole('option', { name: /Bypass permissions/ }).click();
    await expect(page.getByTestId('schedule-mode-note')).toContainText('without asking');

    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-schedule-dialog.png') });

    await page.getByTestId('schedule-save').click();
    await expect(dialog).toBeHidden();
    const created = page.locator('[data-testid=schedule-row][data-name="Morning standup"]');
    await expect(created).toBeVisible();
    await expect(created.getByTestId('schedule-words')).toHaveText('Weekdays at 08:30');
    await expect(created).toContainText('auto clock-in');
    await expect(created.getByTestId('schedule-next')).toContainText('next run in');

    // edit: presets are recognised, changes save
    await created.getByTestId('schedule-edit').click();
    await expect(page.getByRole('dialog')).toContainText('Edit schedule');
    await expect(page.getByTestId('schedule-time')).toHaveValue('08:30');
    await expect(page.getByTestId('schedule-name')).toHaveValue('Morning standup');
    await page.getByTestId('schedule-time').fill('09:15');
    await page.getByTestId('schedule-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(created.getByTestId('schedule-words')).toHaveText('Weekdays at 09:15');

    // editing a weekly task opens the weekly preset
    await page.locator('[data-testid=schedule-row][data-name="Weekly benchmark on Vast"]').getByTestId('schedule-edit').click();
    await expect(page.getByRole('combobox', { name: 'Schedule type' })).toContainText('Weekly on');
    await expect(page.getByRole('combobox', { name: 'Day of the week' })).toContainText('Saturday');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(errors).toEqual([]);
  });

  // ───────────────────────────── Settings ─────────────────────────────

  test('Settings: every section renders', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'settings');
    for (const id of ['models', 'vast', 'permissions', 'search', 'mcp', 'hooks', 'memory', 'shell', 'context', 'general', 'about']) {
      await page.getByTestId(`settings-nav-${id}`).click();
      await expect(page.getByTestId(`settings-section-${id}`)).toBeVisible();
      await expect(page.getByTestId('settings-view')).toHaveAttribute('data-section', id);
    }
    await expect(page.getByTestId('about-version')).toHaveText('0.1.0');
    expect(errors).toEqual([]);
  });

  test('Settings: models & providers', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'settings');
    await expect(page.getByTestId('settings-section-models')).toBeVisible();
    await expect(page.getByTestId('endpoint-row')).toHaveCount(2);
    await settle(page);
    await page.screenshot({ path: join(SHOTS, 'views-settings-models.png') });

    // local server: URL is validated, saved on blur, and Test refreshes the status
    const url = page.getByTestId('local-url');
    await url.fill('localhost:8080');
    await url.blur();
    await expect(page.getByTestId('settings-local')).toContainText('Enter a full URL');
    await url.fill('http://127.0.0.1:8081');
    await url.blur();
    await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
    await expect(url).toHaveValue('http://127.0.0.1:8081');
    await page.getByTestId('local-test').click();
    await expect(page.getByTestId('provider-status')).toHaveAttribute('data-status', 'online');

    // default model + switches persist
    await page.getByRole('combobox', { name: 'Default model' }).click();
    await page.getByRole('option', { name: /Qwen3\.8 27B Uncensored/ }).click();
    await expect(page.getByRole('combobox', { name: 'Default model' })).toContainText('Qwen3.8 27B Uncensored');
    const prefer = page.getByRole('switch', { name: 'Prefer uncensored models' });
    await expect(prefer).toBeChecked();
    await prefer.click();
    await expect(prefer).not.toBeChecked();

    // custom endpoints: CRUD with the API key kept out of the DOM
    await expect(page.getByTestId('endpoint-row')).toHaveCount(2);
    await page.getByTestId('endpoint-add').click();
    await page.getByTestId('endpoint-save').click();
    await expect(page.getByTestId('endpoint-dialog')).toContainText('Give the endpoint a name');
    await expect(page.getByTestId('endpoint-dialog')).toContainText('Enter a URL');
    await page.getByTestId('endpoint-label').fill('vLLM lab');
    await page.getByTestId('endpoint-url').fill('http://10.0.0.5:8000/v1');
    await page.getByTestId('endpoint-key').fill('sk-secret-123');
    await page.getByTestId('endpoint-models').fill('qwen3-32b\nllama-4');
    await page.getByTestId('endpoint-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const row = page.locator('[data-testid=endpoint-row][data-id=vllm-lab]');
    await expect(row).toContainText('vLLM lab');
    await expect(row).toContainText('2 models');
    await expect(row.getByTestId('secret-present')).toBeVisible();
    expect(await page.content()).not.toContain('sk-secret-123');

    await row.getByTestId('endpoint-edit').click();
    await expect(page.getByTestId('endpoint-label')).toHaveValue('vLLM lab');
    await expect(page.getByTestId('endpoint-key')).toHaveValue('');
    await page.getByTestId('endpoint-label').fill('vLLM lab 2');
    await page.getByTestId('endpoint-save').click();
    await expect(page.locator('[data-testid=endpoint-row][data-id=vllm-lab]')).toContainText('vLLM lab 2');
    await page.locator('[data-testid=endpoint-row][data-id=vllm-lab]').getByTestId('endpoint-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove endpoint' }).click();
    await expect(page.getByTestId('endpoint-row')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('Settings: Vast.ai key, budget, safety nets and profiles', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'settings');
    await page.getByTestId('settings-nav-vast').click();
    await expect(page.getByTestId('secret-vast').getByTestId('secret-present')).toBeVisible();

    // the key is write-only: typed, saved, cleared, never rendered
    const key = page.getByTestId('secret-vast-input');
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill('vast-key-xyz');
    await page.getByTestId('secret-vast-save').click();
    await expect(key).toHaveValue('');
    expect(await page.content()).not.toContain('vast-key-xyz');
    await expect(page.getByTestId('vast-test-result')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('vast-test-result')).toContainText('credit $84.17');
    await page.getByTestId('vast-test-key').click();
    await expect(page.getByTestId('vast-test-result')).toContainText('Key OK');

    // removing the key flips the presence indicator and disables the test
    await page.getByTestId('secret-vast-remove').click();
    await expect(page.getByTestId('secret-vast').getByTestId('secret-missing')).toBeVisible();
    await expect(page.getByTestId('vast-test-key')).toBeDisabled();
    await page.getByTestId('secret-vast-input').fill('another-key');
    await page.getByTestId('secret-vast-save').click();
    await expect(page.getByTestId('secret-vast').getByTestId('secret-present')).toBeVisible();

    // numbers are validated inline and saved on blur
    const budget = page.getByTestId('vast-budget');
    await budget.fill('-5');
    await budget.blur();
    await expect(page.getByTestId('settings-vast-safety')).toContainText('Must be at least 1');
    await budget.fill('200');
    await budget.press('Enter');
    await expect(budget).toHaveValue('200');
    await expect(page.getByTestId('settings-vast-safety')).not.toContainText('Must be at least');
    await page.getByTestId('vast-idle').fill('2.5');
    await page.getByTestId('vast-idle').blur();
    await expect(page.getByTestId('settings-vast-safety')).toContainText('whole number');
    await page.getByTestId('vast-idle').fill('20');
    await page.getByTestId('vast-idle').blur();

    // park mode enables the park-days field
    await expect(page.getByTestId('vast-parkdays')).toBeDisabled();
    await page.getByTestId('vast-mode-park').click();
    await expect(page.getByTestId('vast-parkdays')).toBeEnabled();
    // quick successive edits in one section must not undo each other (idle was saved just before the mode change)
    await expect(page.getByTestId('vast-idle')).toHaveValue('20');
    await expect(page.getByTestId('vast-budget')).toHaveValue('200');
    await page.getByTestId('vast-mode-destroy').click();
    await expect(page.getByTestId('vast-parkdays')).toBeDisabled();

    // the settings page is what gets reviewed
    await page.screenshot({ path: join(SHOTS, 'views-settings-vast.png'), fullPage: false });

    // profiles: table, add (validated), JSON
    await expect(page.getByTestId('profile-row')).toHaveCount(3);
    await page.getByTestId('profile-add').click();
    await page.getByTestId('profile-id').fill('Bad Id');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-errors')).toContainText('id:');
    await expect(page.getByTestId('profile-errors')).toContainText('label');
    await page.getByTestId('profile-id').fill('budget');
    await page.getByTestId('profile-label').fill('Budget');
    await page.getByTestId('profile-gpuNames').fill('RTX 4090');
    await page.getByTestId('profile-minGpuRamGb').fill('22');
    await page.getByTestId('profile-maxPricePerHour').fill('0.5');
    await page.getByRole('dialog').getByRole('combobox', { name: 'Default model' }).click();
    await page.getByRole('option', { name: /Qwen3\.8 27B Uncensored/ }).first().click();
    await page.getByTestId('profile-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('profile-row')).toHaveCount(4);

    await page.getByTestId('profiles-tab-json').click();
    const json = page.getByTestId('profiles-json-text');
    await expect(json).toContainText('"id": "budget"');
    await json.fill('[{"id": "x"');
    await expect(page.getByTestId('profiles-json-errors')).toContainText('line 1');
    await expect(page.getByTestId('profiles-json-save')).toBeDisabled();
    await json.fill('[{"id":"x","label":"X"}]');
    await expect(page.getByTestId('profiles-json-errors')).toContainText('profiles[0].gpuNames');
    // revert to the saved JSON and delete the profile from the table again
    await page.getByRole('button', { name: 'Revert' }).click();
    await page.getByTestId('profiles-tab-table').click();
    await page.locator('[data-testid=profile-row][data-id=budget]').getByTestId('profile-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete profile' }).click();
    await expect(page.getByTestId('profile-row')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('Settings: permissions rules, MCP and hooks JSON editors', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'settings');

    // permissions
    await page.getByTestId('settings-nav-permissions').click();
    await expect(page.getByTestId('rules-allow-rule')).toHaveCount(3);
    await page.getByTestId('rules-allow-input').fill('Bash(');
    await page.getByTestId('rules-allow-add').click();
    await expect(page.getByTestId('rules-allow')).toContainText('Use Tool or Tool(argument)');
    await page.getByTestId('rules-allow-input').fill('Bash(npm test:*)');
    await page.getByTestId('rules-allow-add').click();
    await expect(page.getByTestId('rules-allow')).toContainText('already in the list');
    await page.getByTestId('rules-allow-input').fill('Bash(npm run build:*)');
    await page.getByTestId('rules-allow-add').click();
    await expect(page.getByTestId('rules-allow-rule')).toHaveCount(4);
    await page.getByRole('button', { name: 'Remove Bash(npm run build:*)' }).click();
    await expect(page.getByTestId('rules-allow-rule')).toHaveCount(3);
    await expect(page.getByTestId('rules-deny-rule')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Default permission mode' }).click();
    await page.getByRole('option', { name: /Accept edits/ }).click();
    await expect(page.getByRole('combobox', { name: 'Default permission mode' })).toContainText('Accept edits');

    // MCP servers JSON editor
    await page.getByTestId('settings-nav-mcp').click();
    const mcp = page.getByTestId('mcp-json-text');
    await expect(mcp).toContainText('"filesystem"');
    await mcp.fill('{\n  "fs": { "command": "npx", }\n}');
    await expect(page.getByTestId('mcp-json-errors')).toContainText('Trailing comma');
    await expect(page.getByTestId('mcp-json-errors')).toContainText('line 2');
    await expect(page.getByTestId('mcp-json-save')).toBeDisabled();
    await mcp.fill('{ "fs": { "args": ["x"] } }');
    await expect(page.getByTestId('mcp-json-errors')).toContainText('"command" is required');
    await mcp.fill('{ "fs": { "command": "node", "args": ["server.js"] } }');
    await expect(page.getByTestId('mcp-json-status')).toContainText('Unsaved changes');
    await page.getByTestId('mcp-json-save').click();
    await expect(page.getByTestId('mcp-json-status')).toContainText('Saved and valid');
    await expect(page.getByTestId('mcp-json-text')).toContainText('"server.js"');

    // hooks
    await page.getByTestId('settings-nav-hooks').click();
    const hooks = page.getByTestId('hooks-json-text');
    await hooks.fill('{ "Nope": [] }');
    await expect(page.getByTestId('hooks-json-errors')).toContainText('not a hook event');
    await page.getByTestId('hooks-json-example').click();
    await expect(page.getByTestId('hooks-json-status')).toContainText('Unsaved changes');
    await page.getByTestId('hooks-json-save').click();
    await expect(page.getByTestId('hooks-json-status')).toContainText('Saved and valid');
    expect(errors).toEqual([]);
  });

  test('Settings: web search, memory, shell, context, general', async ({ page }) => {
    const errors = await openDemo(page);
    await goto(page, 'settings');

    await page.getByTestId('settings-nav-search').click();
    await page.getByRole('combobox', { name: 'Search provider' }).click();
    await page.getByRole('option', { name: 'Brave Search' }).click();
    await expect(page.getByTestId('secret-brave')).toBeVisible();
    await page.getByRole('combobox', { name: 'Search provider' }).click();
    await page.getByRole('option', { name: 'SearXNG' }).click();
    await page.getByTestId('searxng-url').fill('nope');
    await page.getByTestId('searxng-url').blur();
    await expect(page.getByTestId('settings-search')).toContainText('Enter a full URL');
    await page.getByTestId('searxng-url').fill('http://127.0.0.1:8888');
    await page.getByTestId('searxng-url').blur();
    await expect(page.getByTestId('searxng-url')).toHaveValue('http://127.0.0.1:8888');

    await page.getByTestId('settings-nav-memory').click();
    await expect(page.getByTestId('memory-path')).toContainText('.obsidian-code');
    await expect(page.getByTestId('memory-path')).toContainText('OBSIDIAN.md');
    const imp = page.getByRole('switch', { name: 'Import my Claude Code setup' });
    await expect(imp).toBeChecked();
    await imp.click();
    await expect(imp).not.toBeChecked();

    await page.getByTestId('settings-nav-shell').click();
    await expect(page.getByTestId('shell-detected')).toContainText('bash');
    await page.getByRole('combobox', { name: 'Shell' }).click();
    await page.getByRole('option', { name: 'PowerShell' }).click();
    await expect(page.getByRole('combobox', { name: 'Shell' })).toContainText('PowerShell');

    await page.getByTestId('settings-nav-context').click();
    await page.getByTestId('ctx-compact').fill('120');
    await page.getByTestId('ctx-compact').blur();
    await expect(page.getByTestId('settings-context')).toContainText('Must be at most 95');
    await page.getByTestId('ctx-compact').fill('70');
    await page.getByTestId('ctx-compact').blur();
    await page.getByTestId('ctx-output').fill('50000');
    await page.getByTestId('ctx-output').blur();
    await expect(page.getByTestId('ctx-output')).toHaveValue('50000');

    await page.getByTestId('settings-nav-general').click();
    const notif = page.getByRole('switch', { name: 'Notifications' });
    await expect(notif).toBeChecked();
    await notif.click();
    await expect(notif).not.toBeChecked();
    // launch at login is desktop-only
    await expect(page.getByRole('switch', { name: 'Launch at login' })).toBeDisabled();

    // everything above persisted in the core: reload the state and look again
    await demo(page, (t) => t.simulateDisconnect(100));
    await page.waitForTimeout(500);
    await page.getByTestId('settings-nav-context').click();
    await expect(page.getByTestId('ctx-compact')).toHaveValue('70');
    expect(errors).toEqual([]);
  });
});
