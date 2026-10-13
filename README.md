# Obsidian Code

Your own private, Claude-Code-style AI coding app for Windows. It runs **open-weight models**: uncensored by
default, standard (censored) when you want. They can run on:

- **this PC**, using your existing `llama-server`;
- **a GPU rented by the hour on Vast.ai**, started with one *Clock in* button and stopped with *Clock out*;
- **any OpenAI-compatible endpoint** you add.

It gives you sessions, streaming replies with visible thinking, tools (files, shell, search, web), permission prompts,
plan mode, questions, subagents, todos, a changes/diff panel, scheduled tasks, an activity overview and a GPU
panel with live cost and budget tracking.

---

## Install / run

| What | Where |
|---|---|
| Installer | `release\Obsidian Code-Setup-0.1.0.exe` (installs, adds Start-menu + desktop shortcuts) |
| Portable (no install) | `release\Obsidian Code-0.1.0-portable.exe` |
| From source | `npm install` → `npm run dev` |

The app keeps its data (sessions, settings, encrypted keys, cost ledger) in `%APPDATA%\obsidian-code`.

## First run

1. **Local model (works immediately):** if your `llama-server` is running on `http://127.0.0.1:8080`, the
   model shows up as *Local* with a green dot. Change the address in **Settings → Models & providers**.
2. **New session** (`Ctrl+N`), pick the project folder in the header, and type.

## Rent a GPU (Vast.ai)

1. Create an API key on Vast.ai (Account → Keys) and add some prepaid credit. Turn **auto-recharge off**:
   prepaid credit is your hard spending cap.
2. **Settings → Vast.ai** → paste the key → **Test key** (shows your credit). The key is stored encrypted and is
   never shown again.
3. **GPU** view → pick a profile and a model → **Clock in**. The checklist shows: finding a GPU → renting →
   connecting → downloading the model → loading → **Ready**. The model then appears in the model picker as
   *Vast*.
4. **Clock out** when you're done. Billing is per second and stops when the instance is destroyed.

| Profile | Hardware | Typical price* | Default model | Warm-up |
|---|---|---|---|---|
| **Light** | 1× RTX 5090 (32 GB) | ~$0.55–0.70/h | Qwen3.8-27B Uncensored (HauhauCS Q5) | ~5 min |
| **Standard** | 1× RTX PRO 6000 (96 GB) | ~$1.30–1.60/h | Qwen3.8 Flash-Next 125B Uncensored *(experimental)*; Qwen3.8-27B Q8 is the stable alternative | ~15 min |
| **Max** | 2× RTX PRO 6000 (192 GB) | ~$2.70–3.20/h | GLM-5.3 Flash 320B Uncensored *(experimental)* | ~20 min |

\* Live prices are shown on each profile card. They are marketplace prices and change daily.

**Uncensored ↔ Standard:** every model family comes in both builds. Flip the toggle in the GPU view (or pick the
other build in the model picker). While you're clocked in, *Switch running GPU to this model* swaps the model
without renting a new machine.

### Money safety (what stops a GPU from running forever)

- **Clock out on quit** (default on): closing the app destroys the instance.
- **Server-side watchdog:** the rented machine deletes itself after **30 min without any model use**, after
  **10 min without hearing from your app** (PC off, crash, network loss), or after **6 hours** total. The app
  checks that this watchdog is armed before a GPU is ready (and on every heartbeat); if it cannot be armed, the
  clock-in fails and the machine is destroyed.
- **Monthly budget** (default $200): clock-in is refused once you reach it, and you are auto-clocked-out when
  you hit it.
- **On every start** the app checks your Vast account for leftover instances and offers to destroy them.
- **Park mode** (Settings → Vast.ai → clock-out mode): keeps the model on the stopped machine's disk so the next
  clock-in skips the download. You pay a small storage fee, and parked machines are deleted after 3 days (or once
  the monthly budget is reached). A stopped machine cannot delete itself, so this is checked while the app runs.

## Everyday use

| Action | How |
|---|---|
| New session / command palette | `Ctrl+N` / `Ctrl+K` |
| Send / new line / stop | `Enter` / `Shift+Enter` / `Esc` |
| Cycle permission mode | `Shift+Tab`: Ask → Accept edits → Plan → Bypass |
| Slash commands | type `/` in the composer |
| Mention a file | type `@` |
| Attach an image | paste, drag & drop, or the paperclip (vision models only) |
| Toggle sidebar / side panel | `Ctrl+B` / `Ctrl+\` |
| Permission prompt | `1` allow once · `2` always allow · `3` deny |

**Slash commands:** `/clear` `/compact [focus]` `/model <id>` `/plan` `/init` `/help` `/cost` `/todos` `/agents`
`/skills` `/memory` `/thinking on|off` `/rewind`. Your own commands go in `.obsidian-code/commands/*.md` (or
`.claude/commands`). Start a message with `#` to save a note to the project's `OBSIDIAN.md` memory.

**Permission modes:**

- **Ask** asks before edits, commands and web access.
- **Accept edits** auto-approves file edits inside the project.
- **Plan** is read-only: the model researches and then presents a plan for you to approve.
- **Bypass** never asks. Use it with care.

**Tools the model can use:** Read, Write, Edit, MultiEdit, Glob, Grep, LS, Bash (Git Bash), PowerShell,
BashOutput/KillShell (background commands), WebSearch (DuckDuckGo by default; Brave, Tavily and SearXNG in
Settings), WebFetch, TodoWrite, AskUserQuestion, Task (subagents: general-purpose, Explore, Plan, plus your own in
`.obsidian-code/agents`), ExitPlanMode, Skill, NotebookEdit, ScheduleTask/ListScheduledTasks/DeleteScheduledTask,
and tools from any MCP servers you configure.

**Compatible with your Claude Code setup:** it reads `CLAUDE.md`, `AGENTS.md`, `.claude/skills`, `.claude/agents`,
`.claude/commands` and `.claude/settings.json` permission rules (Settings → Memory & import). Hooks and allow rules
from a project's own settings files are only used once you add that folder under Settings → Permissions → Trusted
folders (deny rules always apply); "Always allow" choices are saved in the app's settings per project folder.

**Scheduled tasks:** **Scheduled** view → New task: a prompt, a folder and a schedule (hourly, daily, weekdays,
cron, or once). Tasks run while the app is open. A task that was missed while the app was closed runs once at the
next start. *Allow auto clock-in* lets a task rent the GPU for its run and clock out afterwards; it is off by
default and always respects the budget.

**Activity:** everything running across all sessions in one place: sessions, subagents, background shells,
scheduled runs and the GPU. It also lists anything waiting for your answer, with Stop and Open buttons.

## Engines: Obsidian and Claude Code

Every session runs on one **engine**:

- **Obsidian** (default): the app's own agent loop, with a compact prompt and tool set tuned for local models.
- **Claude Code**: the real Claude Code harness (Anthropic's Agent SDK 0.3.296, which bundles Claude Code 2.1.296)
  running inside the app. You get its shell and tool set (Read, Edit, Write, Bash, Grep, Glob, WebFetch, TodoWrite,
  subagents via the Agent tool, skills, slash commands, hooks, plan mode, questions, permissions, compaction), but
  **every model request goes to your own model**: the session's local `llama-server` or Vast.ai GPU. There is no
  Anthropic account, login, telemetry or update check. The app talks to Claude Code through a small local relay that
  only forwards to the session's endpoint (it also keeps the endpoint's API key out of Claude Code's environment).

**How to switch:** use the engine selector in the composer (per session, only while the session is idle; the
transcript carries over), choose a default for new sessions in **Settings → Engine**, or pick it in the quick start on
the Home screen. Claude Code needs an endpoint that serves the Anthropic Messages API (`/v1/messages`); the local
`llama-server` does. Switching a session back to Obsidian works the same way.

**Lean or full prompt** (Settings → Engine):

| | System prompt | First turn (prompt tokens) |
|---|---|---|
| **Lean** (default) | Claude Code's tools and loop with the app's compact prompt: 614 tokens, no refusal or content-policy language | about 17.6k |
| **Full** | Claude Code's own preset prompt: 1,329 tokens, includes Anthropic's refusal guidance | about 18.3k |

The prompt is dominated by Claude Code's tool definitions (about 15k tokens) and its context block (about 2k), so
**Full is only about 4% heavier than Lean**; the real difference is behaviour. Measured on the local GPU: a cold first
turn takes 30–80 s before the first token, and the following turns reuse the prompt cache (first token in 2–10 s).
The Obsidian engine starts with about 4.4k tokens. Use Claude Code when you want its harness, and Obsidian when speed
matters.

**What differs from stock Claude Code:**

- **Web search** is the app's own `web_search` tool (DuckDuckGo by default; Brave, Tavily and SearXNG under
  Settings → Web search). Claude Code's built-in WebSearch is an Anthropic server-side tool and is switched off.
  WebFetch works as usual; the page summary is written by your model.
- **Scheduled tasks** use the app's scheduler (they survive restarts, unlike Claude Code's session-only cron).
- **Subagents** (Agent tool) run in the foreground by default, so a local GPU handles one request at a time and the
  report comes back as the tool result. A call that explicitly asks for the background is respected.
- **Isolated config:** Claude Code runs with its own config folder, `%APPDATA%\obsidian-code\claude-code`, so it never
  sees credentials. Your `~/.claude` skills, agents, commands and `CLAUDE.md` are copied in (switch off with
  *Import ~/.claude* in Settings → Engine); `settings.json`, hooks and plugins are never imported. A project's
  `.claude` settings, hooks and skills load only for trusted folders (Settings → Permissions).
- **Plan mode** rejects every change (the model may only write Claude Code's own plan file), as in the Obsidian engine.
- **Tool calls written as text:** open-weight models occasionally write a tool call as plain text that `llama-server`
  does not recognise; the relay turns it back into a real tool call, so the turn continues instead of ending.
- **Cost:** `/cost` shows token usage and "local model, not billed" instead of the dollar guess Claude Code makes for
  unknown models. The `/` menu lists Claude Code's own commands for these sessions.

**Not officially supported:** Anthropic does not support non-Claude models behind Claude Code. Claude Code is built and
tuned for Claude models; open-weight models follow its tool conventions less reliably (for example they sometimes
skip the todo list or answer without using a tool). The Agent SDK and Claude Code versions are pinned and the
auto-updater is off, so a newer Claude Code can change behaviour only when you update the app.

**Check it yourself:** `scripts/net-audit.ps1` samples the outbound TCP connections of the core and all its child
processes while `npx tsx scripts/e2e-real.ts --engine claude-code 9 14` runs a subagent and `/compact`. Only loopback
(relay and `llama-server`) appears; with a web-tool scenario it adds just the sites that were fetched
(`docs/e2e-real-results.md`).

## Speed notes

- **Local (RTX 3070 Ti):** about 20 tok/s generation. The first message of a session takes about 4–5 s before the
  reply starts (~23 s fully cold). Follow-ups start in 0.5–3 s thanks to prompt caching. A *Reading context… N%*
  bar shows progress on long prompts.
- **Vast:** Light about 6× faster generation. Standard/Max are much smarter and read long prompts far faster.

## For developers

```
npm run dev          # Electron app with hot reload
npm run core         # headless core (prints its ws:// URL)
npm run dev:web      # UI in a browser: http://localhost:5173/?core=<url>  (or ?demo=1)
npm run typecheck && npm test
npm run e2e          # Playwright (UI + real-app tests)
npx tsx scripts/e2e-real.ts            # 15 agent scenarios against the local model (--engine claude-code for that engine)
powershell -File scripts/net-audit.ps1 -Out audit.jsonl   # outbound-TCP audit while an e2e run is going
npm run dist         # Windows installer + portable exe → release/
```

The architecture, contracts and design system are documented in `SPEC.md`. Research notes (Vast API, model
catalog, llama-server behaviour) are in `docs/research/`, and the real-model test results are in
`docs/e2e-real-results.md`.
