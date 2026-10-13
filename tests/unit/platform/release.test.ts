// scripts/release.mjs: version bump rule, package/lock/changelog edits, release-asset check, and a real --dry-run in a
// throwaway git repo (with a local bare "origin") that must not change anything.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changelogEntry,
  CHANGELOG_HEADER,
  checkReleaseAssets,
  compareVersions,
  nextVersion,
  notesFromCommits,
  parseArgs,
  planSteps,
  prependChangelog,
  setLockVersion,
  setPackageVersion,
} from '../../../scripts/release.mjs';

const SCRIPT = resolve(__dirname, '../../../scripts/release.mjs');

describe('release: version rule', () => {
  it('patch = last number, minor = second, major = first', () => {
    expect(nextVersion('1.2.3', { bump: 'patch' })).toBe('1.2.4');
    expect(nextVersion('1.2.3', { bump: 'minor' })).toBe('1.3.0');
    expect(nextVersion('1.2.3', { bump: 'major' })).toBe('2.0.0');
    expect(nextVersion('0.1.0', { set: '1.0.0' })).toBe('1.0.0');
  });

  it('--set must move forward and be X.Y.Z', () => {
    expect(() => nextVersion('1.0.0', { set: '1.0.0' })).toThrow(/greater/);
    expect(() => nextVersion('1.0.0', { set: '0.9.9' })).toThrow(/greater/);
    expect(() => nextVersion('1.0.0', { set: '1.0' })).toThrow();
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
  });

  it('parses arguments', () => {
    expect(parseArgs(['patch'])).toMatchObject({ bump: 'patch', dryRun: false, error: null });
    expect(parseArgs(['--set', '1.0.0', '--dry-run', '--notes', '- first'])).toMatchObject({ set: '1.0.0', dryRun: true, notes: '- first', error: null });
    expect(parseArgs(['--set=2.0.0'])).toMatchObject({ set: '2.0.0' });
    expect(parseArgs([]).error).toMatch(/one of/);
    expect(parseArgs(['patch', 'minor']).error).toMatch(/exactly one/);
    expect(parseArgs(['--set', 'banana']).error).toMatch(/version/);
    expect(parseArgs(['--bogus']).error).toMatch(/Unknown/);
  });
});

describe('release: file edits', () => {
  it('bumps package.json and both versions in package-lock.json', () => {
    const pkg = setPackageVersion('﻿{\n  "name": "obsidian-code",\n  "version": "0.1.0",\n  "private": true\n}\n', '1.0.0');
    expect(pkg).toBe('{\n  "name": "obsidian-code",\n  "version": "1.0.0",\n  "private": true\n}\n');
    const lock = JSON.parse(
      setLockVersion(JSON.stringify({ name: 'obsidian-code', version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/x': { version: '0.1.0' } } }), '1.0.0'),
    );
    expect(lock.version).toBe('1.0.0');
    expect(lock.packages[''].version).toBe('1.0.0');
    expect(lock.packages['node_modules/x'].version).toBe('0.1.0');
  });

  it('builds notes from commit subjects and prepends the changelog entry under the header', () => {
    expect(notesFromCommits(['Fix A', 'Release v1.0.0', '', 'Add B'])).toBe('- Fix A\n- Add B');
    expect(notesFromCommits([])).toBe('- Maintenance release.');
    const e1 = changelogEntry({ version: '1.0.0', date: '2026-10-13', notes: '- first' });
    expect(e1).toBe('## v1.0.0 — 2026-10-13\n\n- first\n');
    const first = prependChangelog('', e1);
    expect(first.startsWith(CHANGELOG_HEADER)).toBe(true);
    const second = prependChangelog(first.replace(/\n/g, '\r\n'), changelogEntry({ version: '1.0.1', date: '2026-10-14', notes: '- fix' }));
    expect(second.indexOf('## v1.0.1')).toBeLessThan(second.indexOf('## v1.0.0'));
    expect(second.indexOf('# Changelog')).toBe(0);
    expect(prependChangelog(CHANGELOG_HEADER, e1)).toBe(`${CHANGELOG_HEADER}\n${e1}`);
  });

  it('checks the update assets of a GitHub release (names with dashes or dots)', () => {
    const ok = checkReleaseAssets(
      [{ name: 'Obsidian-Code-Setup-1.0.0.exe' }, { name: 'Obsidian-Code-Setup-1.0.0.exe.blockmap' }, { name: 'latest.yml' }, { name: 'Obsidian-Code-1.0.0-portable.exe' }],
      '1.0.0',
    );
    expect(ok.missing).toEqual([]);
    expect(ok.setup).toBe('Obsidian-Code-Setup-1.0.0.exe');
    expect(checkReleaseAssets([{ name: 'Obsidian.Code-Setup-1.0.0.exe' }], '1.0.0').missing).toEqual(['blockmap (*Setup-1.0.0.exe.blockmap)', 'latest.yml']);
    expect(checkReleaseAssets([], '1.0.0').missing).toHaveLength(3);
  });

  it('plans every step, publishing only after the push', () => {
    const steps = planSteps({ current: '0.1.0', version: '1.0.0' }).join('\n');
    for (const s of ['npm run typecheck', 'OFFLINE=1 npx vitest run', 'npm run build', 'electron-builder --win --publish always', 'git push --atomic origin main refs/tags/v1.0.0', 'gh release edit v1.0.0 --draft=false'])
      expect(steps).toContain(s);
    expect(steps.indexOf('git push')).toBeLessThan(steps.indexOf('gh release edit'));
  });
});

describe('release: --dry-run', () => {
  it('prints the plan and changes nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'oc-release-'));
    const origin = join(base, 'origin.git');
    const repo = join(base, 'repo');
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'package.json'), '{\n  "name": "obsidian-code",\n  "version": "0.1.0"\n}\n');
    writeFileSync(join(repo, 'package-lock.json'), '{\n  "name": "obsidian-code",\n  "version": "0.1.0",\n  "packages": { "": { "version": "0.1.0" } }\n}\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-m', 'Add the thing');
    g(repo, 'remote', 'add', 'origin', origin);
    g(repo, 'push', '-u', 'origin', 'main');
    const before = { pkg: readFileSync(join(repo, 'package.json'), 'utf8'), head: g(repo, 'rev-parse', 'HEAD') };

    const r = spawnSync(process.execPath, [SCRIPT, 'minor', '--dry-run'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_GH_PATH: join(base, 'no-gh.exe') },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0.1.0 -> 0.2.0');
    expect(r.stdout).toContain('Planned steps:');
    expect(r.stdout).toContain('## v0.2.0');
    expect(r.stdout).toContain('- Add the thing');
    expect(r.stdout).toMatch(/PROBLEM: gh is not signed in or not installed/);
    expect(r.stdout).not.toMatch(/PROBLEM: (current branch|working tree|HEAD)/);

    expect(readFileSync(join(repo, 'package.json'), 'utf8')).toBe(before.pkg);
    expect(g(repo, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(g(repo, 'status', '--porcelain')).toBe('');
    expect(g(repo, 'tag')).toBe('');
  }, 60_000);
});
