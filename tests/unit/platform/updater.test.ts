// Auto-update (src/main/updater-core.ts + quit-gate.ts): token resolution order, gh lookup/timeout, where updates are
// supported, error wording/redaction, the state machine, and the update ↔ graceful-quit interplay.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSnapshot } from '@shared/updates';
import { createQuitGate } from '../../../src/main/quit-gate';
import {
  createGhRunner,
  createUpdateController,
  detectUpdateSupport,
  friendlyUpdateError,
  NO_TOKEN_MESSAGE,
  normalizeReleaseNotes,
  redact,
  resolveUpdateToken,
  runCommand,
  type CheckOutcome,
  type FeedConfig,
  type GhResult,
  type RunResult,
  type UpdateControllerDeps,
  type UpdaterAdapter,
} from '../../../src/main/updater-core';

const TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';

// ───────────────────────────── token resolution ─────────────────────────────

describe('resolveUpdateToken', () => {
  it('uses the saved secret first and never asks gh', async () => {
    const runGh = vi.fn(async (): Promise<GhResult> => ({ ok: true, token: 'from-gh-xxxxxxxxxxxxxxxxxxxx' }));
    const r = await resolveUpdateToken({ getSecret: () => `  ${TOKEN}\n`, runGh });
    expect(r).toEqual({ token: TOKEN, source: 'secret', note: null });
    expect(runGh).not.toHaveBeenCalled();
  });

  it('falls back to gh auth token when no secret is saved (or the store throws)', async () => {
    const runGh = async (): Promise<GhResult> => ({ ok: true, token: TOKEN });
    expect(await resolveUpdateToken({ getSecret: () => null, runGh })).toEqual({ token: TOKEN, source: 'gh', note: null });
    expect(await resolveUpdateToken({ getSecret: () => '   ', runGh })).toMatchObject({ source: 'gh' });
    expect(
      await resolveUpdateToken({
        getSecret: () => {
          throw new Error('locked');
        },
        runGh,
      }),
    ).toMatchObject({ source: 'gh', token: TOKEN });
  });

  it('reports none with the reason when gh is missing, times out, is signed out or crashes', async () => {
    const none = (gh: GhResult | Error) =>
      resolveUpdateToken({ getSecret: () => null, runGh: async () => (gh instanceof Error ? Promise.reject(gh) : gh) });
    expect(await none({ ok: false, reason: 'not-found' })).toEqual({ token: null, source: 'none', note: 'GitHub CLI not found' });
    expect(await none({ ok: false, reason: 'timeout' })).toMatchObject({ source: 'none', note: expect.stringContaining('5 s') });
    expect(await none({ ok: false, reason: 'not-signed-in' })).toMatchObject({ source: 'none', note: expect.stringContaining('gh auth login') });
    expect(await none(new Error('boom'))).toMatchObject({ source: 'none', note: 'GitHub CLI failed' });
  });
});

describe('createGhRunner', () => {
  const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, notFound: false, timedOut: false });

  it('tries PATH first, then the install folders that exist, and runs `auth token`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gh-'));
    const fake = join(dir, 'gh.exe');
    writeFileSync(fake, '');
    const calls: string[] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`);
      return file === 'gh' ? { code: null, stdout: '', notFound: true, timedOut: false } : ok(`${TOKEN}\n`);
    });
    const r = await createGhRunner({ candidates: ['gh', join(dir, 'missing.exe'), fake], run })();
    expect(r).toEqual({ ok: true, token: TOKEN });
    expect(calls).toEqual(['gh auth token', `${fake} auth token`]);
  });

  it('maps timeout, non-zero exit and absence', async () => {
    expect(await createGhRunner({ candidates: ['gh'], run: async () => ({ code: null, stdout: '', notFound: false, timedOut: true }) })()).toEqual({ ok: false, reason: 'timeout' });
    expect(await createGhRunner({ candidates: ['gh'], run: async () => ok('', 1) })()).toEqual({ ok: false, reason: 'not-signed-in' });
    expect(await createGhRunner({ candidates: ['gh'], run: async () => ({ code: null, stdout: '', notFound: true, timedOut: false }) })()).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await createGhRunner({ candidates: [join(tmpdir(), 'nope', 'gh.exe')], run: async () => ok(TOKEN) })()).toEqual({ ok: false, reason: 'not-found' });
  });

  it('passes the 5 s cap to the runner', async () => {
    const run = vi.fn(async () => ok(TOKEN));
    await createGhRunner({ candidates: ['gh'], run })();
    expect(run).toHaveBeenCalledWith('gh', ['auth', 'token'], 5000);
  });

  it('runCommand returns stdout, reports ENOENT and kills a process that exceeds the timeout', async () => {
    const r = await runCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(TOKEN)})`], 10_000);
    expect(r).toMatchObject({ code: 0, stdout: TOKEN, timedOut: false });
    const missing = await runCommand(join(tmpdir(), 'definitely-not-here-gh.exe'), ['auth', 'token'], 2000);
    expect(missing.notFound).toBe(true);
    const t0 = Date.now();
    const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], 300);
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ───────────────────────────── environment ─────────────────────────────

describe('detectUpdateSupport', () => {
  const base = { platform: 'win32', isPackaged: true, execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Obsidian Code\\Obsidian Code.exe', productFilename: 'Obsidian Code' };

  it('enables the GitHub feed only for the installed app (uninstaller next to the exe)', () => {
    const seen: string[] = [];
    const r = detectUpdateSupport({ ...base, exists: (p) => (seen.push(p), true) });
    expect(r).toEqual({ ok: true, feed: { kind: 'github' }, testMode: false });
    expect(seen[0]).toMatch(/Obsidian Code[\\/]Uninstall Obsidian Code\.exe$/);
  });

  it('is unsupported for dev runs, unpacked folders, the portable exe and other platforms', () => {
    expect(detectUpdateSupport({ ...base, isPackaged: false, exists: () => true })).toMatchObject({ ok: false, reason: expect.stringContaining('development') });
    expect(detectUpdateSupport({ ...base, exists: () => false })).toMatchObject({ ok: false, reason: expect.stringContaining('unpacked') });
    expect(detectUpdateSupport({ ...base, portableFile: 'D:\\x\\Obsidian Code-1.0.0-portable.exe', exists: () => true })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('portable build — use the installer'),
    });
    expect(detectUpdateSupport({ ...base, platform: 'linux', exists: () => true })).toMatchObject({ ok: false });
  });

  it('OBSIDIAN_UPDATE_TEST_FEED switches to a generic feed even in dev / unpacked runs', () => {
    expect(detectUpdateSupport({ ...base, isPackaged: false, exists: () => false, testFeed: 'http://127.0.0.1:4567/feed' })).toEqual({
      ok: true,
      feed: { kind: 'generic', url: 'http://127.0.0.1:4567/feed' },
      testMode: true,
    });
    expect(detectUpdateSupport({ ...base, testFeed: 'file:///c:/x' })).toMatchObject({ ok: false });
  });
});

describe('error wording and redaction', () => {
  it('never lets a token through', () => {
    expect(redact(`GET https://api.github.com/x failed, authorization: token ${TOKEN}`, [])).not.toContain(TOKEN);
    expect(redact(`bad github_pat_${'A'.repeat(40)} here`)).toBe('bad *** here');
    expect(redact('the secret s3cr3t-value-123 leaked', ['s3cr3t-value-123'])).toBe('the secret *** leaked');
    expect(friendlyUpdateError(new Error(`HttpError: 500 boom ${TOKEN}`), [TOKEN])).not.toContain(TOKEN);
  });

  it('turns common updater failures into actionable sentences', () => {
    expect(friendlyUpdateError(Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }))).toMatch(/offline/);
    expect(friendlyUpdateError(new Error('HttpError: 401 Unauthorized\n{"message":"Bad credentials"}'))).toMatch(/401/);
    expect(friendlyUpdateError(Object.assign(new Error('Unable to find latest version on GitHub'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }))).toMatch(/No published release/);
    expect(friendlyUpdateError(Object.assign(new Error('x'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }))).toMatch(/latest\.yml/);
    expect(friendlyUpdateError(new Error('sha512 checksum mismatch, expected a, got b'))).toMatch(/corrupted/);
  });

  it('normalizes release notes from latest.yml', () => {
    expect(normalizeReleaseNotes('  - fix  ')).toBe('- fix');
    expect(normalizeReleaseNotes([{ version: '1.0.1', note: 'a' }, { version: '1.0.0', note: '' }])).toBe('### 1.0.1\n\na');
    expect(normalizeReleaseNotes(null)).toBeNull();
  });
});

// ───────────────────────────── state machine ─────────────────────────────

interface Harness {
  deps: UpdateControllerDeps;
  states: string[];
  calls: string[];
  feeds: FeedConfig[];
  adapter: UpdaterAdapter & { outcome: CheckOutcome | null | Error; downloadImpl: (p: (x: { percent: number; bytesPerSecond: number }) => void) => Promise<void> };
  last(): UpdateSnapshot;
}

function harness(over: Partial<UpdateControllerDeps> = {}): Harness {
  const states: string[] = [];
  const calls: string[] = [];
  const feeds: FeedConfig[] = [];
  const snaps: UpdateSnapshot[] = [];
  const adapter: Harness['adapter'] = {
    outcome: { available: true, version: '1.0.1', releaseNotes: '- fix', releaseDate: '2026-10-13T00:00:00.000Z' },
    downloadImpl: async (p) => {
      for (const percent of [0.4, 10.2, 10.9, 55.5, 100]) p({ percent, bytesPerSecond: 1e6 });
    },
    setFeed(f) {
      feeds.push(f);
    },
    async check() {
      calls.push('check');
      if (adapter.outcome instanceof Error) throw adapter.outcome;
      return adapter.outcome;
    },
    async download(onProgress) {
      calls.push('download');
      await adapter.downloadImpl(onProgress);
    },
    install(v) {
      calls.push(`install:${v}`);
    },
  };
  const deps: UpdateControllerDeps = {
    currentVersion: '1.0.0',
    support: { ok: true, feed: { kind: 'github' }, testMode: false },
    updater: adapter,
    resolveToken: async () => ({ token: TOKEN, source: 'gh', note: null }),
    prepareQuit: async () => {
      calls.push('prepareQuit');
    },
    broadcast: (s) => {
      snaps.push(s);
      states.push(s.state.status === 'downloading' ? `downloading:${Math.floor(s.state.percent)}` : s.state.status);
    },
    now: () => 1_000,
    ...over,
  };
  return { deps, states, calls, feeds, adapter, last: () => snaps[snaps.length - 1] };
}

describe('update controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('check: checking → available, with the GitHub feed and token, release URL and token source', async () => {
    const h = harness();
    const c = createUpdateController(h.deps);
    expect(c.snapshot().state).toEqual({ status: 'idle' });
    const s = await c.check();
    expect(h.states).toEqual(['checking', 'available']);
    expect(h.feeds).toEqual([{ provider: 'github', owner: 'ArtemChig', repo: 'obsidian-code', token: TOKEN }]);
    expect(s).toMatchObject({
      state: { status: 'available', version: '1.0.1', releaseNotes: '- fix' },
      tokenSource: 'gh',
      lastCheckedAt: 1000,
      releaseUrl: 'https://github.com/ArtemChig/obsidian-code/releases/tag/v1.0.1',
    });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('check: not-available carries checkedAt', async () => {
    const h = harness();
    h.adapter.outcome = { available: false, version: '1.0.0', releaseNotes: null, releaseDate: null };
    const s = await createUpdateController(h.deps).check();
    expect(s.state).toEqual({ status: 'not-available', checkedAt: 1000 });
    expect(s.releaseUrl).toBeNull();
  });

  it('check without any token → actionable error, no request is made', async () => {
    const h = harness({ resolveToken: async () => ({ token: null, source: 'none', note: 'GitHub CLI not found' }) });
    const s = await createUpdateController(h.deps).check();
    expect(s.state).toEqual({ status: 'error', message: NO_TOKEN_MESSAGE, during: 'check' });
    expect(s).toMatchObject({ tokenSource: 'none', tokenNote: 'GitHub CLI not found' });
    expect(h.calls).toEqual([]);
    expect(h.feeds).toEqual([]);
  });

  it('check errors are worded and redacted', async () => {
    const h = harness();
    h.adapter.outcome = new Error(`HttpError: 404 Not Found authorization: token ${TOKEN}`);
    const s = await createUpdateController(h.deps).check();
    expect(s.state).toMatchObject({ status: 'error', during: 'check' });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('concurrent checks share one request', async () => {
    const h = harness();
    const c = createUpdateController(h.deps);
    await Promise.all([c.check(), c.check(), c.check()]);
    expect(h.calls).toEqual(['check']);
  });

  it('generic test feed: no token, generic provider, no release URL', async () => {
    const resolveToken = vi.fn();
    const h = harness({ support: { ok: true, feed: { kind: 'generic', url: 'http://127.0.0.1:9/f' }, testMode: true }, resolveToken });
    const c = createUpdateController(h.deps);
    expect(c.snapshot().tokenSource).toBe('not-needed');
    const s = await c.check();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(h.feeds).toEqual([{ provider: 'generic', url: 'http://127.0.0.1:9/f' }]);
    expect(s.releaseUrl).toBeNull();
  });

  it('update (one click): download with throttled progress → downloaded → installing → graceful quit BEFORE install', async () => {
    const h = harness();
    const c = createUpdateController(h.deps);
    await c.check();
    h.states.length = 0;
    await c.update();
    expect(h.calls).toEqual(['check', 'download', 'prepareQuit', 'install:1.0.1']);
    // one broadcast per whole percent (10.2 and 10.9 → one)
    expect(h.states).toEqual(['downloading:0', 'downloading:10', 'downloading:55', 'downloading:100', 'downloaded', 'installing']);
    expect(c.snapshot().state).toEqual({ status: 'installing', version: '1.0.1' });
  });

  it('update from idle checks first; nothing to install → no download', async () => {
    const h = harness();
    await createUpdateController(h.deps).update();
    expect(h.calls).toEqual(['check', 'download', 'prepareQuit', 'install:1.0.1']);
    const h2 = harness();
    h2.adapter.outcome = { available: false, version: '1.0.0', releaseNotes: null, releaseDate: null };
    const s = await createUpdateController(h2.deps).update();
    expect(h2.calls).toEqual(['check']);
    expect(s.state.status).toBe('not-available');
  });

  it('a failed download is an error and never shuts the app down', async () => {
    const h = harness();
    h.adapter.downloadImpl = async (p) => {
      p({ percent: 30, bytesPerSecond: 1 });
      throw Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ECONNRESET' });
    };
    const c = createUpdateController(h.deps);
    await c.check();
    const s = await c.update();
    expect(s.state).toMatchObject({ status: 'error', during: 'download' });
    expect(h.calls).not.toContain('prepareQuit');
    // a later click retries (check again, then download)
    h.adapter.downloadImpl = async () => undefined;
    await c.update();
    expect(h.calls.slice(-3)).toEqual(['download', 'prepareQuit', 'install:1.0.1']);
  });

  it('an installer that cannot start → install error + the host recovers', async () => {
    const onInstallFailed = vi.fn();
    const h = harness({ onInstallFailed });
    h.adapter.install = () => {
      throw new Error('spawn EACCES');
    };
    const c = createUpdateController(h.deps);
    const s = await c.update();
    expect(s.state).toMatchObject({ status: 'error', during: 'install' });
    expect(onInstallFailed).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    // async failures (electron-updater 'error' while installing) go through installFailed too
    const h2 = harness({ onInstallFailed });
    const c2 = createUpdateController(h2.deps);
    await c2.update();
    c2.installFailed(new Error('installer exited'));
    expect(c2.snapshot().state).toMatchObject({ status: 'error', during: 'install' });
  });

  it('checks are ignored while an update runs, and update() is not re-entrant', async () => {
    const h = harness();
    let release!: () => void;
    h.adapter.downloadImpl = () => new Promise<void>((r) => (release = r));
    const c = createUpdateController(h.deps);
    await c.check();
    const p1 = c.update();
    const p2 = c.update();
    await c.check();
    expect(h.calls).toEqual(['check', 'download']);
    release();
    await Promise.all([p1, p2]);
    expect(h.calls).toEqual(['check', 'download', 'prepareQuit', 'install:1.0.1']);
  });

  it('starts from a persisted install error (previous run)', () => {
    const h = harness({ initialState: { status: 'error', message: 'x', during: 'install' } });
    expect(createUpdateController(h.deps).snapshot().state).toEqual({ status: 'error', message: 'x', during: 'install' });
  });

  it('unsupported builds never check or update', async () => {
    const h = harness({ support: { ok: false, reason: 'portable build — use the installer to get automatic updates' } });
    const c = createUpdateController(h.deps);
    expect(c.snapshot().state).toEqual({ status: 'unsupported', reason: 'portable build — use the installer to get automatic updates' });
    await c.check();
    await c.update();
    c.start();
    expect(h.calls).toEqual([]);
  });

  it('schedules the first check after 20 s, then every 30 min, until stopped', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.adapter.outcome = { available: false, version: '1.0.0', releaseNotes: null, releaseDate: null };
    const c = createUpdateController(h.deps);
    c.start();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(['check']);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.calls).toEqual(['check', 'check']);
    c.stop();
    await vi.advanceTimersByTimeAsync(2 * 30 * 60_000);
    expect(h.calls).toEqual(['check', 'check']);
  });
});

// ───────────────────────────── quit-sequence interplay ─────────────────────────────

describe('quit gate + updater', () => {
  const event = () => ({ prevented: false, preventDefault() {
    this.prevented = true;
  } });

  it('a normal quit is held until the shutdown finishes, then quits once for real', async () => {
    const log: string[] = [];
    let finish!: () => void;
    const gate = createQuitGate({
      shutdown: () => new Promise<void>((r) => (finish = () => (log.push('shutdown done'), r()))),
      quit: () => log.push('quit'),
    });
    const e1 = event();
    gate.onBeforeQuit(e1);
    expect(e1.prevented).toBe(true);
    const e2 = event(); // a second quit while shutting down shares the same shutdown
    gate.onBeforeQuit(e2);
    expect(e2.prevented).toBe(true);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['shutdown done', 'quit', 'quit']);
    const e3 = event();
    gate.onBeforeQuit(e3);
    expect(e3.prevented).toBe(false);
  });

  it('update: the graceful shutdown (GPU clock-out, flush, core close) completes BEFORE the installer starts, and its quit is not blocked', async () => {
    const log: string[] = [];
    const quitEvents: { prevented: boolean }[] = [];
    let shutdowns = 0;
    const gate = createQuitGate({
      shutdown: async () => {
        shutdowns++;
        log.push('clockOut(app_quit)');
        await new Promise((r) => setTimeout(r, 20));
        log.push('core.close');
      },
      quit: () => log.push('app.quit (gate)'),
    });
    const h = harness({ prepareQuit: () => gate.prepareForQuit() });
    h.adapter.install = (v) => {
      // what electron-updater's quitAndInstall(true, true) does: spawn the installer, then app.quit() → before-quit
      log.push(`spawn installer ${v} --updated /S --force-run`);
      const e = event();
      gate.onBeforeQuit(e);
      quitEvents.push(e);
    };
    const c = createUpdateController(h.deps);
    await c.update();
    expect(log).toEqual(['clockOut(app_quit)', 'core.close', 'spawn installer 1.0.1 --updated /S --force-run']);
    expect(quitEvents).toEqual([{ prevented: false, preventDefault: expect.any(Function) }]);
    expect(shutdowns).toBe(1);
    expect(gate.open).toBe(true);
  });

  it('a shutdown failure still lets the update quit (prepareForQuit never rejects)', async () => {
    const gate = createQuitGate({ shutdown: () => Promise.reject(new Error('core close timed out')), quit: () => undefined });
    await expect(gate.prepareForQuit()).resolves.toBeUndefined();
    const e = event();
    gate.onBeforeQuit(e);
    expect(e.prevented).toBe(false);
  });
});
