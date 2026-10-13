// End-to-end auto-update (owner: platform). Builds the app twice with electron-builder into temp dirs — version A
// (0.90.0) and a newer B (0.90.1), both NSIS like a real release — serves B's latest.yml + installer + blockmap from a
// local HTTP server, then runs A's packaged win-unpacked exe with OBSIDIAN_UPDATE_TEST_FEED pointing at that server:
//   UPDATE button shows B's version → click → download (progress) → graceful quit → install step.
// OBSIDIAN_UPDATE_TEST_INSTALL=record makes the install step write update-install-record.json and quit instead of
// running the installer, and LOCALAPPDATA points at a temp dir, so nothing touches the real install or its updater cache.
//
// Slow (two installer builds, ~3–6 min), so opt-in:
//   npm run build
//   UPDATE_E2E=1 npx playwright test tests/e2e/update-e2e.spec.ts        (UPDATE_E2E_REUSE=1 keeps/reuses the builds)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const projectRoot = resolve(__dirname, '../..');
const shots = join(__dirname, 'screenshots');
const A = '0.90.0';
const B = '0.90.1';
const work = join(tmpdir(), 'oc-update-e2e');
const outA = join(work, `v${A}`);
const outB = join(work, `v${B}`);
const exeA = join(outA, 'win-unpacked', 'Obsidian Code.exe');

test.skip(process.env.UPDATE_E2E !== '1', 'set UPDATE_E2E=1 (builds two installers; slow)');
test.skip(process.platform !== 'win32', 'Windows only (NSIS)');

function buildVersion(version: string, out: string): void {
  if (process.env.UPDATE_E2E_REUSE === '1' && existsSync(join(out, 'latest.yml')) && existsSync(join(out, 'win-unpacked'))) return;
  rmSync(out, { recursive: true, force: true });
  const cli = join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
  const r = spawnSync(
    process.execPath,
    [cli, '--win', 'nsis', '--x64', '--publish', 'never', `--config.extraMetadata.version=${version}`, `--config.directories.output=${out}`],
    { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } },
  );
  if (r.status !== 0) throw new Error(`electron-builder ${version} failed (exit ${r.status})`);
}

/** latest.yml fields we check (tiny parser: top-level scalars + the first files[] entry). */
function readLatestYml(dir: string): { version: string; path: string; sha512: string } {
  const text = readFileSync(join(dir, 'latest.yml'), 'utf8');
  const get = (k: string) => new RegExp(`^${k}:\\s*'?([^'\\n]+)'?$`, 'm').exec(text)?.[1].trim() ?? '';
  return { version: get('version'), path: get('path'), sha512: get('sha512') };
}

/**
 * Serves `dir` like a GitHub release: electron-builder names the uploaded assets with dashes ("Obsidian-Code-Setup-…")
 * and writes those names into latest.yml, while the local files keep the space. Bandwidth is capped so the progress
 * state is visible.
 */
function serveFeed(dir: string, log: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/+/, ''));
    log.push(`${req.method} /${name}`);
    const candidates = [name, name.replace(/^Obsidian-Code/, 'Obsidian Code')].map((n) => join(dir, basename(n)));
    const file = candidates.find((f) => existsSync(f) && statSync(f).isFile());
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    const size = statSync(file).size;
    res.writeHead(200, { 'content-length': String(size), 'content-type': file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' });
    if (req.method === 'HEAD') return void res.end();
    // ~40 MB/s: a ~100 MB installer takes a few seconds, enough to see "UPDATING n%".
    const stream = createReadStream(file, { highWaterMark: 1 << 20 });
    stream.on('data', (chunk) => {
      stream.pause();
      // wait for both: the socket buffer to drain (listen now, it may drain within the delay) and the pacing delay
      const drained = res.write(chunk) ? Promise.resolve() : new Promise<void>((r) => res.once('drain', () => r()));
      void Promise.all([drained, new Promise((r) => setTimeout(r, 25))]).then(() => stream.resume());
    });
    stream.on('end', () => res.end());
    stream.on('error', () => res.destroy());
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  expect(existsSync(join(projectRoot, 'out', 'main', 'index.js')), 'run npm run build first').toBe(true);
  mkdirSync(work, { recursive: true });
  mkdirSync(shots, { recursive: true });
  buildVersion(A, outA);
  buildVersion(B, outB);
});

test('packaged build: update feed config is the private GitHub repo, unsigned (no publisherName)', async () => {
  const yml = readFileSync(join(outA, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
  expect(yml).toMatch(/provider: github/);
  expect(yml).toMatch(/owner: ArtemChig/);
  expect(yml).toMatch(/repo: obsidian-code/);
  expect(yml).toMatch(/private: true/);
  expect(yml).toMatch(/updaterCacheDirName: obsidian-code-updater/);
  // electron-updater verifies installer signatures only when publisherName is present (see electron-builder.yml)
  expect(yml).not.toMatch(/publisherName/);
  const latest = readLatestYml(outB);
  expect(latest.version).toBe(B);
  expect(latest.path).toBe(`Obsidian-Code-Setup-${B}.exe`);
  expect(existsSync(join(outB, `Obsidian Code-Setup-${B}.exe.blockmap`))).toBe(true);
});

test('unpacked build without a test feed: updates are off and no button shows', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-upd-off-'));
  const app = await electron.launch({ executablePath: exeA, args: [], env: { ...process.env, OBSIDIAN_CODE_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', OBSIDIAN_UPDATE_TEST_FEED: '' }, timeout: 90_000 });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('status-version')).toContainText(A, { timeout: 30_000 });
    const s = await page.evaluate(() => (globalThis as unknown as { obsidian: { updates: { getState(): Promise<{ state: { status: string; reason?: string } }> } } }).obsidian.updates.getState());
    expect(s.state).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('unpacked') });
    await expect(page.getByTestId('update-button')).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

test('A finds B, one click downloads it, shuts down gracefully and triggers the install (recorded)', async () => {
  test.setTimeout(5 * 60_000);
  const log: string[] = [];
  const { server, url } = await serveFeed(outB, log);
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-upd-data-'));
  const localAppData = mkdtempSync(join(tmpdir(), 'oc-upd-local-'));
  const app = await electron.launch({
    executablePath: exeA,
    args: [],
    env: {
      ...process.env,
      OBSIDIAN_CODE_DATA_DIR: dataDir,
      ELECTRON_RENDERER_URL: '',
      OBSIDIAN_UPDATE_TEST_FEED: url,
      OBSIDIAN_UPDATE_TEST_INSTALL: 'record',
      // electron-updater caches downloads in %LOCALAPPDATA%\obsidian-code-updater: keep the real one untouched
      LOCALAPPDATA: localAppData,
    },
    timeout: 90_000,
  });
  let exited = false;
  const exitedP = new Promise<number | null>((r) => app.process().once('exit', (code) => ((exited = true), r(code))));
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
    await expect(page.getByTestId('status-version')).toContainText(A, { timeout: 30_000 });

    // The first check runs ~1.5 s after startup in test mode.
    const button = page.getByTestId('update-button');
    await expect(button).toHaveAttribute('data-status', 'available', { timeout: 30_000 });
    await expect(page.getByTestId('update-version')).toHaveText(B);
    await expect(button).toContainText('Update');
    await page.screenshot({ path: join(shots, 'update-e2e-available.png') });
    expect(log).toContain('GET /latest.yml');

    // No GPU is clocked in → no confirmation; the click starts the download right away.
    await button.click();
    await expect(button).toHaveAttribute('data-status', /downloading|downloaded|installing/, { timeout: 15_000 });
    await page.screenshot({ path: join(shots, 'update-e2e-progress.png') }).catch(() => undefined);

    // Download → graceful quit (core closed) → install step → the app quits by itself.
    const code = await Promise.race([exitedP, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 120_000))]);
    expect(code, 'the app should quit after triggering the install').not.toBe('timeout');

    const record = JSON.parse(readFileSync(join(dataDir, 'update-install-record.json'), 'utf8')) as {
      version: string;
      installerPath: string;
      isSilent: boolean;
      isForceRunAfter: boolean;
      shutdownComplete: boolean;
    };
    expect(record).toMatchObject({ version: B, isSilent: true, isForceRunAfter: true, shutdownComplete: true });
    // The installer was downloaded into the temp LOCALAPPDATA cache and matches latest.yml.
    expect(resolve(record.installerPath).toLowerCase().startsWith(resolve(localAppData).toLowerCase())).toBe(true);
    const sha512 = createHash('sha512').update(readFileSync(record.installerPath)).digest('base64');
    expect(sha512).toBe(readLatestYml(outB).sha512);
    expect(log.some((l) => l === `GET /Obsidian-Code-Setup-${B}.exe`)).toBe(true);
    console.log('[update-e2e] feed requests:', log.join(', '));
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    server.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    rmSync(localAppData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

test.afterAll(() => {
  if (process.env.UPDATE_E2E_REUSE !== '1') rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});
