#!/usr/bin/env node
// Release Obsidian Code (owner: platform). Every change ships as a release; the installed app offers it through its
// UPDATE button (src/main/updater.ts). See RELEASING.md.
//
//   npm run release -- patch | minor | major          small fix | feature / bigger change | redesign / giant change
//   npm run release -- --set 1.0.0                    explicit version
//   options: --notes "<markdown>"  (default: commit subjects since the previous tag)   --dry-run  (print the plan only)
//
// Steps: clean tree on main, in sync with origin/main → bump package.json + package-lock.json → prepend CHANGELOG.md →
// commit "Release vX.Y.Z" + tag → typecheck, unit tests (OFFLINE=1, --retry=2), build → electron-builder --win --publish always
// into a DRAFT release (GH_TOKEN from `gh auth token`, env only) → check the draft has the Setup exe, its .blockmap and
// latest.yml → push main + tag → publish the release → verify with `gh release view`.
// Any failure before the release is published undoes the version commit and tag (and deletes the draft).
//
// Why a draft first: electron-builder uploads assets one by one. A release that is already public while latest.yml is
// still missing makes every installed app report an error; a draft is invisible to the updater until it is complete.
// The tag is pushed before publishing so GitHub attaches the release to our tag (publishing a release whose tag does
// not exist yet makes GitHub create it on main, and a later tag push would then be rejected).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO = 'ArtemChig/obsidian-code';
const DEFAULT_GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';

const USAGE = `Usage: npm run release -- <patch|minor|major> | --set X.Y.Z  [--notes "<markdown>"] [--dry-run]

  patch   small fix                      1.2.3 -> 1.2.4
  minor   new feature / bigger change    1.2.3 -> 1.3.0
  major   redesign / giant change        1.2.3 -> 2.0.0`;

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────────────

/** @returns {{ bump: 'patch'|'minor'|'major'|null, set: string|null, notes: string|null, dryRun: boolean, error: string|null }} */
export function parseArgs(argv) {
  const out = { bump: null, set: null, notes: null, dryRun: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'patch' || a === 'minor' || a === 'major') {
      if (out.bump || out.set) return { ...out, error: 'Give exactly one of patch, minor, major or --set X.Y.Z' };
      out.bump = a;
    } else if (a === '--set' || a.startsWith('--set=')) {
      const v = a === '--set' ? argv[++i] : a.slice('--set='.length);
      if (out.bump || out.set) return { ...out, error: 'Give exactly one of patch, minor, major or --set X.Y.Z' };
      if (!v || !isVersion(v)) return { ...out, error: `--set needs a version like 1.0.0 (got ${v ?? 'nothing'})` };
      out.set = v;
    } else if (a === '--notes' || a.startsWith('--notes=')) {
      const v = a === '--notes' ? argv[++i] : a.slice('--notes='.length);
      if (v == null || !v.trim()) return { ...out, error: '--notes needs some markdown text' };
      out.notes = v.trim();
    } else if (a === '--dry-run' || a === '-n') {
      out.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      return { ...out, error: 'help' };
    } else {
      return { ...out, error: `Unknown argument: ${a}` };
    }
  }
  if (!out.bump && !out.set) return { ...out, error: 'Give one of patch, minor, major or --set X.Y.Z' };
  return out;
}

export function isVersion(v) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(v));
}

/** -1 / 0 / 1 for plain X.Y.Z versions. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** The next version: patch = last number, minor = second (patch reset), major = first (rest reset), or --set. */
export function nextVersion(current, { bump = null, set = null } = {}) {
  const base = String(current).split(/[-+]/)[0];
  if (!isVersion(base)) throw new Error(`package.json version is not X.Y.Z: ${current}`);
  if (set) {
    if (!isVersion(set)) throw new Error(`Not a version: ${set}`);
    if (compareVersions(set, base) <= 0) throw new Error(`--set ${set} must be greater than the current version ${base}`);
    return set;
  }
  const [maj, min, pat] = base.split('.').map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error('No bump given');
}

function stripBom(text) {
  return String(text).replace(/^﻿/, '');
}

/** Set "version" in package.json text (keeps 2-space formatting + trailing newline). */
export function setPackageVersion(text, version) {
  const pkg = JSON.parse(stripBom(text));
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Set the root version in package-lock.json text (top-level "version" and packages[""].version). */
export function setLockVersion(text, version) {
  const lock = JSON.parse(stripBom(text));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Commit subjects → markdown bullets (release commits and blanks dropped). */
export function notesFromCommits(subjects) {
  const lines = subjects.map((s) => s.trim()).filter((s) => s && !/^Release v\d+\.\d+\.\d+$/.test(s));
  return lines.length ? lines.map((s) => `- ${s}`).join('\n') : '- Maintenance release.';
}

export function changelogEntry({ version, date, notes }) {
  return `## v${version} — ${date}\n\n${notes.trim()}\n`;
}

export const CHANGELOG_HEADER = `# Changelog

Every change to Obsidian Code ships as a release (\`npm run release\`), and the installed app offers it through the
UPDATE button. Version rule: patch (last number) = small fix · minor (second) = feature or bigger change ·
major (first) = redesign or giant change.
`;

/** Put the new entry above the previous ones (below the header). */
export function prependChangelog(existing, entry) {
  const text = (existing ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return `${CHANGELOG_HEADER}\n${entry}`;
  const idx = text.search(/^## /m);
  if (idx === -1) return `${text.replace(/\n*$/, '\n')}\n${entry}`;
  return `${text.slice(0, idx)}${entry}\n${text.slice(idx)}`;
}

/**
 * Which of the required update assets a GitHub release has. GitHub turns spaces in asset names into dots, and
 * electron-builder uploads "safe" names with dashes, so match by suffix.
 */
export function checkReleaseAssets(assets, version) {
  const names = (assets ?? []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
  const setup = names.find((n) => n.endsWith(`Setup-${version}.exe`)) ?? null;
  const blockmap = names.find((n) => n.endsWith(`Setup-${version}.exe.blockmap`)) ?? null;
  const latestYml = names.find((n) => n === 'latest.yml') ?? null;
  const missing = [];
  if (!setup) missing.push(`installer (*Setup-${version}.exe)`);
  if (!blockmap) missing.push(`blockmap (*Setup-${version}.exe.blockmap)`);
  if (!latestYml) missing.push('latest.yml');
  return { setup, blockmap, latestYml, missing };
}

/** The steps a real run takes, for --dry-run. */
export function planSteps({ current, version, branch = 'main' }) {
  const tag = `v${version}`;
  return [
    `Check: clean working tree, on ${branch}, HEAD == origin/${branch}, tag ${tag} and release ${tag} do not exist, gh is signed in`,
    `Bump package.json + package-lock.json: ${current} -> ${version}`,
    `Prepend CHANGELOG.md: "## ${tag} — ${today()}" + release notes`,
    `git commit -m "Release ${tag}" (package.json, package-lock.json, CHANGELOG.md) && git tag -a ${tag} -m "${tag}"`,
    'npm run typecheck',
    'OFFLINE=1 npx vitest run --retry=2  (retries absorb the known timing-flaky GPU tests)',
    'npm run build',
    `electron-builder --win --publish always  (draft release ${tag}; GH_TOKEN = gh auth token, env only)`,
    `gh release view ${tag}: draft has *Setup-${version}.exe, *Setup-${version}.exe.blockmap, latest.yml`,
    `git push --atomic origin ${branch} refs/tags/${tag}`,
    `gh release edit ${tag} --draft=false --latest  (publishes it: installed apps now see the update)`,
    `gh release view ${tag}: published (not draft), assets present`,
    `On a failure before publishing: delete the draft, git tag -d ${tag}, git reset --hard HEAD~1`,
  ];
}

// ───────────────────────────── process helpers ─────────────────────────────

const root = process.cwd();

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status ?? (r.error ? -1 : 0), stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error };
}

function git(...args) {
  return sh('git', args);
}

function ghPath() {
  if (process.env.RELEASE_GH_PATH) return process.env.RELEASE_GH_PATH;
  const onPath = sh('gh', ['--version']);
  if (onPath.code === 0) return 'gh';
  return existsSync(DEFAULT_GH) ? DEFAULT_GH : null;
}

function gh(args, opts = {}) {
  const exe = ghPath();
  if (!exe) return { code: -1, stdout: '', stderr: 'GitHub CLI (gh) not found', error: new Error('gh not found') };
  return sh(exe, args, opts);
}

/** Run a visible step (npm scripts need a shell on Windows). */
function step(title, cmd, args, env = {}) {
  console.log(`\n=== ${title}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${title} failed (exit ${r.status ?? r.error?.message})`);
}

function fail(msg) {
  console.error(`\nrelease: ${msg}`);
  process.exit(1);
}

/** Read-only checks. Returns a list of problems (empty = ready). */
function preflight(version) {
  const problems = [];
  const tag = `v${version}`;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout;
  if (branch !== 'main') problems.push(`current branch is "${branch}", not main`);
  const dirty = git('status', '--porcelain').stdout;
  if (dirty) problems.push(`working tree is not clean:\n${dirty.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n')}`);
  const head = git('rev-parse', 'HEAD').stdout;
  const remote = git('ls-remote', 'origin', 'refs/heads/main');
  if (remote.code !== 0) problems.push(`cannot reach origin (${remote.stderr.split('\n')[0] || 'git ls-remote failed'})`);
  else {
    const remoteMain = remote.stdout.split(/\s+/)[0] ?? '';
    if (!remoteMain) problems.push('origin has no main branch');
    else if (remoteMain !== head) problems.push(`HEAD (${head.slice(0, 7)}) is not origin/main (${remoteMain.slice(0, 7)}) — pull or push first`);
  }
  if (git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).code === 0) problems.push(`tag ${tag} already exists locally`);
  const remoteTag = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (remoteTag.code === 0 && remoteTag.stdout) problems.push(`tag ${tag} already exists on origin`);
  const auth = gh(['auth', 'status']);
  if (auth.code !== 0) problems.push(`gh is not signed in or not installed (${(auth.stderr || auth.stdout).split('\n')[0]})`);
  else {
    const rel = gh(['release', 'view', tag, '--repo', REPO, '--json', 'tagName']);
    if (rel.code === 0) problems.push(`GitHub release ${tag} already exists`);
  }
  return problems;
}

function releaseNotes(explicit) {
  if (explicit) return explicit;
  const prev = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  const range = prev.code === 0 && prev.stdout ? [`${prev.stdout}..HEAD`] : ['-n', '30'];
  const log = git('log', '--no-merges', '--format=%s', ...range);
  return notesFromCommits(log.stdout ? log.stdout.split('\n') : []);
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error === 'help') {
    console.log(USAGE);
    return;
  }
  if (args.error) {
    console.error(`release: ${args.error}\n\n${USAGE}`);
    process.exit(2);
  }

  const pkgPath = join(root, 'package.json');
  const lockPath = join(root, 'package-lock.json');
  const changelogPath = join(root, 'CHANGELOG.md');
  const pkgText = readFileSync(pkgPath, 'utf8');
  const current = JSON.parse(stripBom(pkgText)).version;
  let version;
  try {
    version = nextVersion(current, args);
  } catch (err) {
    fail(err.message);
  }
  const tag = `v${version}`;
  const notes = releaseNotes(args.notes);
  const entry = changelogEntry({ version, date: today(), notes });

  console.log(`Obsidian Code release: ${current} -> ${version}${args.dryRun ? '  (dry run: nothing is changed)' : ''}`);
  const problems = preflight(version);

  if (args.dryRun) {
    console.log('\nPreconditions:');
    if (!problems.length) console.log('  ok — ready to release');
    else for (const p of problems) console.log(`  PROBLEM: ${p}`);
    console.log('\nPlanned steps:');
    planSteps({ current, version }).forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s}`));
    console.log(`\nCHANGELOG.md entry:\n\n${entry.replace(/^/gm, '    ')}`);
    if (problems.length) console.log(`A real run would stop at the preconditions (${problems.length} problem${problems.length > 1 ? 's' : ''}).`);
    return;
  }
  if (problems.length) fail(`not ready to release:\n  - ${problems.join('\n  - ')}`);

  // From here on, undo everything on a failure until the release is published.
  const undo = { committed: false, tagged: false, draft: false, wrote: false, hadChangelog: existsSync(changelogPath) };
  const notesDir = mkdtempSync(join(tmpdir(), 'oc-release-'));
  const notesFile = join(notesDir, 'notes.md');
  writeFileSync(notesFile, `${notes.trim()}\n`);
  const rollback = (why) => {
    console.error(`\nrelease: ${why}\nrelease: rolling back ${tag}…`);
    if (undo.draft) {
      const d = gh(['release', 'delete', tag, '--repo', REPO, '--yes']);
      console.error(d.code === 0 ? `  deleted draft release ${tag}` : `  could not delete the draft release ${tag}: ${d.stderr} — delete it on GitHub`);
    }
    if (undo.tagged) git('tag', '-d', tag);
    if (undo.committed && git('log', '-1', '--format=%s').stdout === `Release ${tag}`) git('reset', '--hard', 'HEAD~1');
    else if (undo.wrote) {
      git('checkout', '--', 'package.json', 'package-lock.json');
      if (undo.hadChangelog) git('checkout', '--', 'CHANGELOG.md');
      else rmSync(changelogPath, { force: true });
    }
    console.error(`  version is back to ${current}; nothing was pushed or published.`);
    rmSync(notesDir, { recursive: true, force: true });
    process.exit(1);
  };

  try {
    writeFileSync(pkgPath, setPackageVersion(pkgText, version));
    writeFileSync(lockPath, setLockVersion(readFileSync(lockPath, 'utf8'), version));
    writeFileSync(changelogPath, prependChangelog(undo.hadChangelog ? readFileSync(changelogPath, 'utf8') : '', entry));
    undo.wrote = true;
    let r = git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md');
    if (r.code !== 0) throw new Error(`git add failed: ${r.stderr}`);
    r = git('commit', '-m', `Release ${tag}`);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr || r.stdout}`);
    undo.committed = true;
    r = git('tag', '-a', tag, '-m', tag);
    if (r.code !== 0) throw new Error(`git tag failed: ${r.stderr}`);
    undo.tagged = true;

    step('Typecheck', 'npm', ['run', 'typecheck']);
    step('Unit tests', 'npx', ['vitest', 'run', '--retry=2'], { OFFLINE: '1' });
    step('Build', 'npm', ['run', 'build']);

    const token = gh(['auth', 'token']).stdout;
    if (!/^\S{20,}$/.test(token)) throw new Error('gh auth token returned no token (run gh auth login)');
    console.log(`\n=== electron-builder --win --publish always (draft ${tag})`);
    const saved = { GH_TOKEN: process.env.GH_TOKEN, EP_DRAFT: process.env.EP_DRAFT };
    process.env.GH_TOKEN = token;
    process.env.EP_DRAFT = 'true';
    undo.draft = true; // electron-builder may create the draft before failing
    try {
      const { build } = await import('electron-builder');
      await build({ win: [], publish: 'always', projectDir: root, config: { releaseInfo: { releaseNotes: notes.trim() } } });
    } finally {
      if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.GH_TOKEN;
      if (saved.EP_DRAFT === undefined) delete process.env.EP_DRAFT;
      else process.env.EP_DRAFT = saved.EP_DRAFT;
    }

    const view = gh(['release', 'view', tag, '--repo', REPO, '--json', 'isDraft,assets,url']);
    if (view.code !== 0) throw new Error(`gh release view ${tag} failed: ${view.stderr}`);
    const draftInfo = JSON.parse(view.stdout);
    const assets = checkReleaseAssets(draftInfo.assets, version);
    if (assets.missing.length) throw new Error(`the draft release is missing: ${assets.missing.join(', ')}`);
    console.log(`\nDraft ${tag} has ${assets.setup}, ${assets.blockmap}, ${assets.latestYml}`);

    console.log(`\n=== git push --atomic origin main ${tag}`);
    r = git('push', '--atomic', 'origin', 'main', `refs/tags/${tag}`);
    if (r.code !== 0) throw new Error(`git push failed: ${r.stderr}`);
    undo.committed = false;
    undo.tagged = false;
  } catch (err) {
    rollback(err instanceof Error ? err.message : String(err));
  }

  // Pushed: from here a failure cannot be undone automatically, only finished.
  console.log(`\n=== Publishing ${tag}`);
  const pub = gh(['release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest', '--title', tag, '--notes-file', notesFile]);
  rmSync(notesDir, { recursive: true, force: true });
  if (pub.code !== 0) {
    fail(`publishing failed: ${pub.stderr}\nThe commit and tag are pushed and the draft is complete. Finish with:\n  gh release edit ${tag} --repo ${REPO} --draft=false --latest`);
  }
  const final = gh(['release', 'view', tag, '--repo', REPO, '--json', 'isDraft,assets,url,tagName']);
  if (final.code !== 0) fail(`gh release view ${tag} failed: ${final.stderr}`);
  const info = JSON.parse(final.stdout);
  const check = checkReleaseAssets(info.assets, version);
  if (info.isDraft) fail(`release ${tag} is still a draft — publish it on GitHub: ${info.url}`);
  if (check.missing.length) fail(`release ${tag} is missing: ${check.missing.join(', ')} (${info.url})`);
  console.log(`\nReleased ${tag}: ${info.url}\n  ${check.setup}\n  ${check.blockmap}\n  ${check.latestYml}\nInstalled apps show the UPDATE button within 30 minutes (or after Help → Check for updates).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
}
