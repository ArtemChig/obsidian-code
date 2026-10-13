# Releasing Obsidian Code and how auto-update works

Every change ships as a release. The installed app finds it on GitHub and shows an **UPDATE** button; one click
installs it and restarts. Nobody downloads installers by hand.

## Releasing

```powershell
git checkout main; git pull
npm run release -- patch                 # small fix              1.2.3 -> 1.2.4
npm run release -- minor                 # feature/bigger change  1.2.3 -> 1.3.0
npm run release -- major                 # redesign/giant change  1.2.3 -> 2.0.0
npm run release -- --set 1.0.0           # explicit version (the first release)
npm run release -- patch --notes "- Fixed the reconnect banner"   # release notes (markdown)
npm run release -- minor --dry-run       # print the plan, change nothing
```

Requirements: a clean working tree on `main`, in sync with `origin/main`; the GitHub CLI signed in with `repo` scope
(`gh auth status`). The script takes the publishing token from `gh auth token` and passes it to electron-builder in the
environment only; it is never printed or written to disk.

What `scripts/release.mjs` does:

1. Checks the preconditions (branch, clean tree, `HEAD == origin/main`, tag and GitHub release do not exist yet, gh).
2. Bumps `version` in `package.json` and `package-lock.json`, prepends `## vX.Y.Z — YYYY-MM-DD` + notes to
   `CHANGELOG.md` (`--notes`, or the commit subjects since the previous tag), commits `Release vX.Y.Z`, tags `vX.Y.Z`.
3. Runs `npm run typecheck`, `OFFLINE=1 npx vitest run --retry=2` (a failing test gets two more tries: a few GPU
   tests in `tests/unit/gpu/` are timing-sensitive), `npm run build`.
4. Runs electron-builder (`--win --publish always`, config from `electron-builder.yml`) into a **draft** GitHub release:
   NSIS installer `Obsidian-Code-Setup-X.Y.Z.exe`, its `.blockmap`, `latest.yml`, plus the portable exe.
5. Checks the draft has the installer, the blockmap and `latest.yml`.
6. Pushes `main` and the tag (`git push --atomic origin main refs/tags/vX.Y.Z`).
7. Publishes the release (`gh release edit vX.Y.Z --draft=false --latest`) and verifies it with `gh release view`.

Any failure in steps 2–6 rolls back: the draft is deleted, the tag removed and the version commit reset, so the next run
starts clean. (A flaky test is such a failure: just run the release again.) Why a draft: assets upload one by one, and a
public release without `latest.yml` yet would make every installed app report an error. The tag is pushed before
publishing so GitHub attaches the release to our tag instead of creating one on `main` (which would make the tag push
fail).

`npm run dist` still builds the installer and portable exe into `release/` without publishing anything.

## How the updater works

`src/main/updater.ts` (Electron wiring, IPC) + `src/main/updater-core.ts` (state machine, token lookup, unit-tested) +
`src/main/quit-gate.ts` (quit sequence) use electron-updater's `NsisUpdater` with the GitHub provider
(`ArtemChig/obsidian-code`, private).

- **When**: 20 s after startup, every 30 min, on Help → Check for updates, and Settings → About & updates → Check now.
  It only downloads when the user clicks (autoDownload off).
- **UI**: a solid `UPDATE  X.Y.Z` button at the right of the menu strip when a newer release exists; while it works it
  shows `UPDATING 42%`, then `RESTARTING`. The status bar shows the running version (`V1.0.0`; a warning dot when a check
  fails). Settings → About & updates shows the state, last check, release notes, a link to the GitHub release and where
  the token comes from.
- **One click** = download → the app's normal graceful quit (sessions flushed, the GPU clocked out when *Clock out on
  quit* is on, core closed) → the installer runs silently (`quitAndInstall(isSilent=true, isForceRunAfter=true)`) and
  starts the new version. If a GPU is clocked in the button asks first ("Your GPU will be clocked out first", or, with
  *Clock out on quit* off, that it keeps running and is re-attached). The graceful quit finishes *before* the installer
  starts because the NSIS installer force-closes a still-running app after about two seconds. If the installer cannot
  start, the app relaunches the current version and shows the error.
- **Unsigned builds**: electron-updater checks the Authenticode signature of a downloaded installer only when
  `app-update.yml` has a `publisherName`. `win.verifyUpdateCodeSignature: false` in `electron-builder.yml` keeps it out
  (otherwise unsigned updates would be rejected). Downloads are still verified against the sha512 in `latest.yml`.
  Remove that line once the app is code-signed.
- **Where it runs**: only in the installed app (the NSIS installer puts `Uninstall Obsidian Code.exe` next to the exe).
  Dev runs, `release/win-unpacked` and the portable exe report "unsupported" (portable: *use the installer*).
- **Logs**: `[updater] …` lines on the main-process console (tokens redacted).

### Token sources (the repo is private)

Resolved at every check, in this order — the first that works is used:

1. **Saved token** — Settings → About & updates → *Update token*: a fine-grained personal access token with read-only
   *Contents* access to `ArtemChig/obsidian-code`. Stored encrypted (secret `github.updateToken`).
2. **GitHub CLI** — `gh auth token` (gh on PATH or `C:\Program Files\GitHub CLI\gh.exe`; 5 s timeout).
3. **None** — the check fails with "No GitHub access for update checks…" and Settings explains what to do.

The token stays in the main process: the renderer only sees *where* it came from, and the updater's logger redacts it.

## The first release

The app the user has installed today (0.1.0) was built before the updater existed, so it cannot update itself.
Release 1.0.0 and install `Obsidian-Code-Setup-1.0.0.exe` once; from then on every release arrives through the button.

```powershell
npm run release -- --set 1.0.0 --notes "- One-click updates: an UPDATE button appears when a new version is out."
```

## Testing the updater

- Unit: `OFFLINE=1 npx vitest run tests/unit/platform/updater.test.ts tests/unit/platform/release.test.ts`
- End to end (builds 0.90.0 and 0.90.1 into `%TEMP%\oc-update-e2e`, serves 0.90.1 from a local HTTP feed, runs 0.90.0,
  clicks UPDATE, checks the download and that the install step was triggered — the installer itself is not run):
  `npm run build` then `UPDATE_E2E=1 npx playwright test tests/e2e/update-e2e.spec.ts`
- Test switches (main process): `OBSIDIAN_UPDATE_TEST_FEED=<http url>` uses a generic feed at that URL (works in dev and
  unpacked runs, no token); with `OBSIDIAN_UPDATE_TEST_INSTALL=record` the install step writes
  `<dataDir>/update-install-record.json` and quits instead of running the installer.
- UI in demo mode: `/?demo=1&update=available` (also `downloading`, `installing`, `error`, `failed`, `portable`, `secret`).
