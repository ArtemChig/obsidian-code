# Changelog

Every change to Obsidian Code ships as a release (`npm run release`), and the installed app offers it through the
UPDATE button. Version rule: patch (last number) = small fix · minor (second) = feature or bigger change ·
major (first) = redesign or giant change.

## v1.5.0 — 2026-10-16

New: resize the panels by dragging their edges.

## v1.4.0 — 2026-10-16

Finishing touches across the app.

## v1.3.0 — 2026-10-16

New: a model browser — you are no longer limited to the built-in models.

## v1.2.0 — 2026-10-16

New: the GPU can clock itself out, and the app is ready to share.

## v1.1.3 — 2026-10-14

- GPU clock-in no longer fails when a cheap offer is grabbed by someone else first. The app now skips offers that were just taken ('no_such_ask') and re-searches for a fresh one, instead of giving up. (If it still fails, just press Try again.)

## v1.1.2 — 2026-10-14

Two fixes for long tasks with the uncensored model.

## v1.1.1 — 2026-10-13

- The chat header's context meter no longer shows a red CTX 100% for a Vast model while the GPU is off; it uses the model's real context size (or shows — when unknown).

## v1.1.0 — 2026-10-13

New: the Claude Code engine.

## v1.0.4 — 2026-10-13

- Updates download faster and cleaner: the app no longer tries (and fails) a partial download first for this private repository; it fetches the installer directly.

## v1.0.3 — 2026-10-13

- Fixed: a clock-in failed when the rented machine never accepted the app's SSH key. The app now attaches the key again once the machine runs, gives up on a machine that keeps refusing it after about 2.5 minutes, destroys it and rents the next GPU automatically.

## v1.0.2 — 2026-10-13

- Fixed: clocking in to a Vast GPU failed every time with "llama-server failed to load". The server program could not find its own libraries on the rented machine; it now starts correctly, and a broken server image is detected before the model download instead of after it.

## v1.0.1 — 2026-10-13

- GPU clock-in no longer loses the evidence when the model fails to load: the server log, bootstrap/watchdog logs and nvidia-smi output are saved to your PC before the rented machine is deleted (View server log in the GPU view).

## v1.0.0 — 2026-10-13

First auto-updating release of Obsidian Code.
