// Chat UI E2E (owner: ui-chat). Drives the renderer in DEMO MODE against a Vite dev server:
//   npx vite --config vite.web.config.ts --port 5174 --strictPort     (or set OBSIDIAN_WEB_URL)
//   npx playwright test tests/e2e/ui-chat.spec.ts
// Covers: send + stream, permission allow/deny by keyboard, question submit, plan approval, "/" and "@" palettes,
// rewind dialog, error banner + retry, queued messages, interrupt, images, right panels. Saves design-review
// screenshots (M13 re-skin) to tests/e2e/screenshots/m13-chat-*.png.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = join(__dirname, 'screenshots');
const CANDIDATES = [process.env.OBSIDIAN_WEB_URL, 'http://localhost:5174', 'http://localhost:5173'].filter(Boolean) as string[];
let BASE = '';

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Opens the demo app and returns the list of console errors / page errors seen so far (live array). */
async function openDemo(page: Page, width = 1440, height = 900): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?demo=1`);
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  return errors;
}

async function openSessionByTitle(page: Page, title: string): Promise<void> {
  await page.getByTestId('session-row').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('chat-view')).toBeVisible();
  await expect(page.getByTestId('chat-title')).toContainText(title.slice(0, 20));
}

async function newSession(page: Page): Promise<void> {
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

async function waitIdle(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('running-status')).toHaveCount(0, { timeout });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `m13-chat-${name}.png`) });
}

test.describe('ui-chat (demo mode)', () => {
  test.beforeAll(async () => {
    for (const c of CANDIDATES) {
      if (await reachable(c)) {
        BASE = c;
        break;
      }
    }
    test.skip(!BASE, `No Vite dev server at ${CANDIDATES.join(' or ')}`);
  });

  test('transcript renders every card type', async ({ page }) => {
    const errors = await openDemo(page);
    await openSessionByTitle(page, 'Scheduler: auto clock-in');
    const view = page.getByTestId('chat-view');

    for (const name of ['Grep', 'Glob', 'Read', 'LS', 'Edit', 'Write', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Skill', 'ScheduleTask']) {
      await expect(view.locator(`[data-testid="tool-card"][data-tool="${name}"]`).first()).toBeVisible();
    }
    await expect(view.locator('[data-testid="tool-card"][data-tool^="mcp__"]')).toHaveCount(1);
    await expect(view.getByTestId('subagent-card')).toBeVisible();
    // A finished subagent loads its steps only when expanded (a running one shows them live).
    const steps = view.getByTestId('subagent-steps-toggle');
    if (await steps.count()) await steps.first().click();
    await expect(view.getByTestId('subagent-preview')).toBeVisible();
    await expect(view.getByTestId('compact-divider')).toBeVisible();
    await expect(view.getByTestId('thinking-block').first()).toContainText('Thought for 8');
    await expect(view.getByTestId('image-thumb').first()).toBeVisible();
    await expect(view.getByTestId('diff-view').first()).toBeVisible();
    await expect(view.getByTestId('terminal').first()).toBeVisible();
    await expect(view.getByTestId('search-results')).toBeVisible();
    await expect(view.getByTestId('web-card')).toBeVisible();
    await expect(view.getByTestId('todo-list').first()).toBeVisible();
    await expect(view.locator('[data-tool="Bash"][data-status="denied"]')).toBeVisible();
    await expect(view.locator('[data-tool="Edit"][data-status="error"]')).toBeVisible();
    await expect(view.locator('[data-tool="Read"][data-status="interrupted"]')).toBeVisible();
    await expect(view.getByTestId('interrupted')).toBeVisible();
    await expect(page.getByTestId('git-branch')).toHaveText('feat/chat-ui');
    await expect(page.getByTestId('context-meter')).toContainText('31%');

    // Thinking expands on click.
    const thinking = view.getByTestId('thinking-block').first();
    await thinking.getByRole('button').click();
    await expect(thinking).toContainText('try/finally');

    await shot(page, 'transcript');

    // Scrolling up unpins auto-scroll and shows "Jump to latest".
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);
    await page.getByTestId('transcript').hover();
    await page.mouse.wheel(0, -1600);
    await expect(page.getByTestId('jump-latest')).toBeVisible();
    await page.getByTestId('jump-latest').click();
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);

    // Full transcript in one image (tall viewport so nothing scrolls).
    const h = (await page.evaluate(`document.querySelector('[data-testid="transcript"]').scrollHeight`)) as number;
    await page.setViewportSize({ width: 1440, height: Math.min(9000, h + 260) });
    await page.waitForTimeout(500);
    await shot(page, 'transcript-full');
    await page.setViewportSize({ width: 1440, height: 900 });

    // The subagent card opens the child session; its header links back.
    await view.getByTestId('subagent-open').click();
    await expect(page.getByTestId('subagent-footer')).toBeVisible();
    await expect(page.getByTestId('parent-link')).toBeVisible();
    await page.getByTestId('parent-link').click();
    await expect(page.getByTestId('composer')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('send, stream and finish a turn', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);
    await shot(page, 'empty');
    await send(page, 'Explain the reconnect logic in the renderer');
    await expect(page.getByTestId('msg-user')).toContainText('Explain the reconnect logic');
    await expect(page.locator('[data-testid="thinking-block"][data-streaming]')).toBeVisible();
    await expect(page.getByTestId('running-status')).toBeVisible();
    await expect(page.getByTestId('stop-button')).toBeVisible();
    await shot(page, 'streaming');
    await waitIdle(page);
    await expect(page.getByTestId('assistant-text').last()).toContainText('back off exponentially');
    await expect(page.getByTestId('thinking-block').first()).toContainText('Thought for');
    await expect(page.getByTestId('send-button')).toBeVisible();
    await expect(page.getByTestId('chat-title')).toContainText('Explain the reconnect logic');
    expect(errors).toEqual([]);
  });

  test('permission prompt: allow with 1, queued follow-up', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);
    await send(page, 'Fix the flaky reconnect and run the tests');
    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toContainText('Run this command?');
    await expect(prompt).toContainText('Bash(npm test:*)');
    await shot(page, 'permission');

    // A message typed while the agent waits is queued.
    const input = page.getByTestId('composer-input');
    await input.fill('then summarize what changed');
    await input.press('Enter');
    await expect(page.getByTestId('queued-chip')).toContainText('then summarize');

    // Keys typed into the composer never answer the prompt, even when it is empty.
    await input.focus();
    await page.keyboard.press('1');
    await expect(prompt).toBeVisible();
    await expect(input).toHaveValue('1');
    await input.fill('');
    // With focus on the card, number keys answer it.
    await prompt.focus();
    await page.keyboard.press('1');
    await expect(prompt).toHaveCount(0);
    await expect(page.locator('[data-tool="Bash"][data-status="done"]')).toBeVisible({ timeout: 20_000 });
    // The queued message runs after the turn.
    await expect(page.getByTestId('queued-chip')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('msg-user').filter({ hasText: 'then summarize' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('permission prompt: deny with Esc and with 3 + feedback', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);
    await send(page, 'Install the deps and run the build');
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('permission-prompt').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('permission-prompt')).toHaveCount(0);
    await expect(page.locator('[data-tool="Bash"][data-status="denied"]')).toBeVisible();
    await waitIdle(page);

    // Seeded Edit permission: diff preview, feedback + deny.
    await openSessionByTitle(page, 'Rename GPU phase labels');
    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByTestId('diff-view')).toBeVisible();
    await shot(page, 'permission-edit');
    await prompt.getByTestId('perm-feedback').fill('keep "Renting GPU", it is clearer');
    await prompt.getByTestId('perm-feedback').press('Enter');
    await expect(prompt).toHaveCount(0);
    await expect(page.locator('[data-tool="Edit"][data-status="denied"]')).toBeVisible();
    await expect(page.getByTestId('assistant-text').last()).toContainText('left the labels unchanged');
    expect(errors).toEqual([]);
  });

  test('question card: pick with keys and submit', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);
    await send(page, 'Which approach should we choose for the cache?');
    const card = page.getByTestId('question-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('question-submit')).toBeDisabled();
    await card.focus();
    await page.keyboard.press('2');
    await expect(card.getByTestId('question-option').nth(1)).toHaveAttribute('data-selected', 'true');
    await shot(page, 'question');
    // "Other…" reveals a free-text field.
    await card.getByTestId('question-other').click();
    await expect(card.getByTestId('question-other-input')).toBeFocused();
    await card.getByTestId('question-other-input').fill('Refactor, but keep the API');
    await card.getByTestId('question-submit').click();
    await expect(card).toHaveCount(0);
    const answered = page.locator('[data-testid="tool-card"][data-tool="AskUserQuestion"]');
    await expect(answered).toContainText('Refactor, but keep the API');
    await waitIdle(page);
    expect(errors).toEqual([]);
  });

  test('plan approval: Shift+Tab to plan mode, approve with auto-accept', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);
    const input = page.getByTestId('composer-input');
    await input.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('mode-selector')).toHaveAttribute('data-mode', 'acceptEdits');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('mode-selector')).toHaveAttribute('data-mode', 'plan');
    await send(page, 'Add jittered backoff to the WebSocket client');
    const card = page.getByTestId('plan-approval');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('plan-body')).toContainText('backoffDelay');
    await shot(page, 'plan');
    await card.focus();
    await page.keyboard.press('1');
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('mode-selector')).toHaveAttribute('data-mode', 'acceptEdits');
    await expect(page.locator('[data-tool="ExitPlanMode"]')).toContainText('approved');
    await waitIdle(page);
    expect(errors).toEqual([]);
  });

  test('plan approval: keep planning with feedback', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);
    await send(page, 'Make a plan for caching model lists');
    const card = page.getByTestId('plan-approval');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.focus();
    await page.keyboard.press('3');
    await expect(card.getByTestId('plan-feedback')).toBeFocused();
    await card.getByTestId('plan-feedback').fill('Cover cache invalidation on settings change');
    await card.getByTestId('plan-feedback').press('Enter');
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('assistant-text').last()).toContainText('keep refining the plan');
    expect(errors).toEqual([]);
  });

  test('slash and @ palettes', async ({ page }) => {
    const errors = await openDemo(page);
    await openSessionByTitle(page, 'Scheduler: auto clock-in');
    const input = page.getByTestId('composer-input');
    await input.click();
    await input.pressSequentially('/');
    const slash = page.getByTestId('slash-palette');
    await expect(slash).toBeVisible();
    await expect(slash.getByTestId('palette-item').first()).toBeVisible();
    expect(await slash.getByTestId('palette-item').count()).toBeGreaterThan(8);
    await shot(page, 'slash');
    await input.pressSequentially('comp');
    await expect(slash.getByTestId('palette-item').first()).toContainText('/compact');
    await expect(slash.getByTestId('palette-item').first()).toContainText('[instructions]');
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('/compact ');
    await expect(slash).toHaveCount(0);
    await expect(page.getByTestId('arg-hint')).toHaveText('[instructions]');
    await shot(page, 'slash-args');

    // Arrow keys move the highlight; Escape closes.
    await input.fill('');
    await input.pressSequentially('/');
    await page.keyboard.press('ArrowDown');
    await expect(slash.locator('[aria-selected="true"]')).toHaveAttribute('data-index', '1');
    await page.keyboard.press('Escape');
    await expect(slash).toHaveCount(0);

    await input.fill('');
    await input.pressSequentially('look at @');
    const mention = page.getByTestId('mention-palette');
    await expect(mention).toBeVisible();
    await expect(mention.getByTestId('palette-item').nth(3)).toBeVisible();
    await shot(page, 'mention');
    await input.pressSequentially('rpc');
    await expect(mention.getByTestId('palette-item').first()).toContainText('rpc.ts');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('look at @src/renderer/src/lib/rpc.ts ');
    await expect(mention).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('rewind dialog restores the draft', async ({ page }) => {
    const errors = await openDemo(page);
    await openSessionByTitle(page, 'Scheduler: auto clock-in');
    const target = page.getByTestId('msg-user').filter({ hasText: 'kill the stale SSH tunnel' });
    await target.hover();
    await target.getByTestId('rewind-button').click();
    const dialog = page.getByTestId('rewind-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'rewind');
    await page.getByRole('button', { name: 'Rewind', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('msg-user').filter({ hasText: 'kill the stale SSH tunnel' })).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toHaveValue('Also kill the stale SSH tunnel and rename the tunnel helper.');
    expect(errors).toEqual([]);
  });

  test('error banner and retry', async ({ page }) => {
    const errors = await openDemo(page);
    await openSessionByTitle(page, 'Benchmark GLM-5.3 Flash');
    await expect(page.getByTestId('error-banner')).toContainText('context window');
    await shot(page, 'error');

    await newSession(page);
    await send(page, 'This will fail on purpose');
    const banner = page.getByTestId('error-banner');
    await expect(banner).toContainText('ECONNRESET', { timeout: 10_000 });
    // Retry rewinds to the failed prompt and sends it again: one copy in the transcript, not one per click.
    await banner.getByTestId('error-retry').click();
    await expect(banner).toContainText('ECONNRESET', { timeout: 10_000 });
    await banner.getByTestId('error-retry').click();
    await expect(banner).toContainText('ECONNRESET', { timeout: 10_000 });
    await expect(page.getByTestId('msg-user')).toHaveCount(1);
    await expect(page.getByTestId('msg-user')).toContainText('This will fail on purpose');
    expect(errors.filter((e) => !e.includes('ECONNRESET'))).toEqual([]);
  });

  test('interrupt with Esc, images, model picker, panels', async ({ page }) => {
    const errors = await openDemo(page);
    await newSession(page);

    // Attach an image via the file input.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAABD0lEQVR42u3YsUrDUBQG4Jvi3NUlD6DgZmaX0qEP0ElEOohrfQLxCXQVh1JKJx/AQVycMwp9BifBJ3AIXC5BXUJLuP3OdJop/fjPzUmK8ug0qL9rgABQpzpo/f6YjJvm5OU1Xqwfjpummm/ixdHzddO8TR/3JUFRJ+2jTtpHnVZvxJxB6h+g9NyJfXruxD49d/I+gwp7kBHr9pj//vqkIEGAAAEClMfLagjhbvne//u+vTyTICMGKId3seFhSUGCAAHq0R70tFjl/Z+vZhcSZMQA2YMkCBAg9dsetL6v+3Bn5zeVBBkxQPYgCVKAAPkeFLb4xUeCAAGyB0kQIECAFCBAgAABAgQIkAIECNCO6gcoISw79EjobgAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.locator('[data-testid="composer"] input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('attachments').getByTestId('image-thumb')).toHaveCount(1);
    // Drag-and-drop onto the chat view attaches too.
    await page.evaluate(`(() => {
      const bin = atob('${png.toString('base64')}');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
      const el = document.querySelector('[data-testid="chat-view"]');
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await expect(page.getByTestId('attachments').getByTestId('image-thumb')).toHaveCount(2);
    await page.getByTestId('attachments').getByTestId('image-thumb').nth(1).hover();
    await page.getByRole('button', { name: 'Remove drop.png' }).click();
    await expect(page.getByTestId('attachments').getByTestId('image-thumb')).toHaveCount(1);
    await page.getByTestId('composer-input').fill('Describe this screenshot');

    // Thinking toggle.
    await expect(page.getByTestId('thinking-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('thinking-toggle').click();
    await expect(page.getByTestId('thinking-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('thinking-toggle').click();
    await expect(page.getByTestId('thinking-toggle')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'composer-image');

    // Model picker menu.
    await page.getByTestId('model-picker').click();
    await expect(page.getByTestId('model-menu')).toBeVisible();
    await expect(page.getByTestId('model-option').first()).toBeVisible();
    await shot(page, 'model-picker');
    await page.keyboard.press('Escape');

    // With the GPU clocked out, the picker offers "Clock in GPU".
    await page.getByTestId('gpu-clock-button').click();
    await expect(page.getByTestId('gpu-widget')).toContainText(/Clock in/, { timeout: 10_000 });
    await page.getByTestId('model-picker').click();
    await expect(page.getByTestId('model-clock-in')).toContainText('Clock in GPU');
    await page.keyboard.press('Escape');

    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('msg-user')).toBeVisible();
    await expect(page.getByTestId('running-status')).toBeVisible();
    await page.getByTestId('transcript').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await waitIdle(page);
    await expect(page.getByTestId('interrupted')).toBeVisible();

    // Right panels on the rich session.
    await openSessionByTitle(page, 'Scheduler: auto clock-in');
    await page.getByTestId('chat-panel-toggle').click();
    const panel = page.getByTestId('right-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('tab', { name: /Changes/ }).click();
    await expect(panel.getByTestId('changed-file')).toHaveCount(2);
    await panel.getByTestId('changed-file').first().click();
    await expect(panel.getByTestId('diff-view')).toBeVisible();
    await shot(page, 'panel-changes');
    await panel.getByRole('tab', { name: /Todos/ }).click();
    await expect(panel.getByTestId('todos-panel')).toContainText('Adding clock-out');
    await shot(page, 'panel-todos');
    await panel.getByRole('tab', { name: /Agents/ }).click();
    await expect(panel.getByTestId('agent-row')).toHaveCount(1);
    await panel.getByRole('tab', { name: /Files/ }).click();
    await panel.getByTestId('file-entry').filter({ hasText: 'package.json' }).click();
    await expect(page.getByTestId('composer-input')).toHaveValue('@package.json ');
    await shot(page, 'panel-files');

    // Narrow layout.
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(300);
    await shot(page, '1024');
    expect(errors).toEqual([]);
  });
});
