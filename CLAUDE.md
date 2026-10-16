# Obsidian Code — notes for Claude sessions

Electron 44 + electron-vite + React desktop app (Windows). Spec: `SPEC.md`. UI rules (M13 "Obsidian" design system):
`src/renderer/src/UI-GUIDE.md`. Releases and the auto-updater: `RELEASING.md`.

## Versioning and releases (the user's rule — follow it on every change)

The user's words:

> with each change the version number should change, smaller changes - only last number increments, bigger changes - second, redesigns, giant changes - first number  increments

> never ask me to update manually again, i want to see a button if a newer version exists that i can just click and it will update.

What that means for you:

- **Every change ships as a release** via `npm run release` (scripts/release.mjs) once it is merged to `main`. A change
  that is not released does not reach the user.
- Pick the bump by size:
  - `npm run release -- patch` — small fix (1.2.3 → 1.2.4)
  - `npm run release -- minor` — feature or bigger change (1.2.3 → 1.3.0)
  - `npm run release -- major` — redesign or giant change (1.2.3 → 2.0.0)
  - add `--notes "<markdown>"` for user-facing release notes (default: commit subjects since the last tag);
    `--dry-run` shows the plan without changing anything.
- **Never ask the user to reinstall or update manually.** The installed app checks GitHub releases (20 s after start,
  every 30 min) and shows an UPDATE button in the menu strip; one click downloads, clocks the GPU out (when "clock out
  on quit" is on), installs and restarts. If an update cannot reach the user, fix the updater or the release instead.
- Do not edit `version` in package.json by hand; the release script bumps package.json, package-lock.json and
  CHANGELOG.md, commits "Release vX.Y.Z", tags it and publishes the GitHub release (installer, .blockmap, latest.yml).
- Releases need a clean tree on `main` in sync with `origin/main`, and the GitHub CLI signed in (`gh auth status`).
  The repo (ArtemChig/obsidian-code) is PUBLIC (friends install from its releases): never commit a token, key,
  personal data or anything from %APPDATA%\obsidian-code; never print or log a token.

## Checks before you hand work back

```
npm run typecheck
OFFLINE=1 npx vitest run
npm run build && npx playwright test tests/e2e/electron-smoke.spec.ts
npm run dist                      # installer + portable into release/ (does not publish)
```

UI work: run the demo (`npx vite --config vite.web.config.ts --port 5173 --strictPort`, open `/?demo=1`), take
screenshots and look at them. Updater UI in demo mode: `/?demo=1&update=available` (see `src/renderer/src/lib/demo-updates.ts`).
