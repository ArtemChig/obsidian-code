# Obsidian Code — build spec

A private, desktop "Claude Code" replica for Windows that runs **open-weight models** (uncensored by default,
standard/censored on demand) on (a) the user's own PC (`llama-server` at http://127.0.0.1:8080), (b) a GPU rented
**by the hour on Vast.ai** with one-button **Clock in / Clock out**, or (c) any OpenAI-compatible endpoint.

Owner/user context: Windows 11, Ryzen 7 5800X, 32 GB RAM, RTX 3070 Ti 8 GB. Local server already running:
`C:\llama.cpp\llama-server.exe` with Qwen3.6-35B-A3B uncensored on 127.0.0.1:8080 (OpenAI API + /v1/messages; 4 slots;
~20 tok/s decode, ~480 tok/s prefill — **slow**: keep prompts small). Budget for Vast: $100–200/month, 2–3 h/day.

The app must feel like the Claude Code desktop app: sessions sidebar, streaming transcript with thinking + tool
cards, composer with slash commands/@mentions/images, permission prompts, plan mode, questions, subagents, todos,
changes/diff panel, scheduled tasks, an activity/oversight view, and a GPU clock-in panel.

---------------------------------------------------------------------------------------------------------------------

## 1. Architecture

```
Electron main (src/main)  ──starts──►  Core (src/core, plain Node/TS, no Electron imports)
   │  window, tray, notifications,            │  HTTP + WebSocket server on 127.0.0.1:<random port>, token auth
   │  safeStorage, dialogs                    │  agent loop · tools · llm client · gpu/vast · scheduler · store · ext
   ▼                                          ▼
Preload (src/preload) ──contextBridge──► Renderer (src/renderer, React)  ◄──WebSocket JSON-RPC + events──►  Core
```

* **Core is UI-agnostic** and can run standalone: `npm run core` (tsx `src/core/standalone.ts`) prints
  `OBSIDIAN_CORE_URL=ws://127.0.0.1:PORT/ws?token=…`. The renderer can then run in a normal browser via
  `npm run dev:web` (Vite) with `?core=<url>` — this is how Playwright/browser tests drive the UI.
* In Electron, main calls `createCore({ dataDir, native })` in-process, then loads the renderer with the core URL
  exposed via preload `window.obsidian.coreUrl`.
* Wire protocol: `src/shared/protocol.ts`. Domain types: `src/shared/types.ts`. Internal module contracts:
  `src/core/contracts.ts`. **These three files are the contract. Do not change them casually.** If you truly need a
  change, make the minimal additive change (new optional field / new method), and say so in your final report.
* Data dir: `%APPDATA%/obsidian-code` (Electron `app.getPath('userData')`), overridable with env
  `OBSIDIAN_CODE_DATA_DIR` (tests MUST use a temp dir). Layout: `settings.json`, `secrets.json` (encrypted values),
  `sessions/<id>.json`, `checkpoints/<sessionId>/…`, `kv/<key>.json`, `logs/`, `ssh/` (ed25519 key).

## 2. Directory ownership (parallel build — stay inside your area)

| Area | Path | Owner agent |
|---|---|---|
| Contracts | `src/shared/*`, `src/core/contracts.ts` | lead (read-only for others) |
| Composition root, server, event bus, activity | `src/core/index.ts`, `src/core/server/**`, `src/core/activity/**`, `src/core/standalone.ts` | platform |
| Persistence | `src/core/store/**` | platform |
| Scheduler | `src/core/scheduler/**` | platform |
| Electron | `src/main/**`, `src/preload/**`, `electron-builder.yml`, `resources/icons/**` | platform |
| LLM client, providers, model registry | `src/core/llm/**` | agent-core |
| Agent loop, prompts, permissions, compaction, subagents, checkpoints | `src/core/agent/**` | agent-core |
| Mock OpenAI server for tests | `tests/fixtures/mock-llm/**` | agent-core |
| Tools | `src/core/tools/**` | tools |
| Skills, custom agents, slash commands, memory files, MCP, hooks | `src/core/ext/**` | extensions |
| Vast.ai, SSH tunnel, server bootstrap, catalog, cost/budget | `src/core/gpu/**`, `resources/server/**` | gpu |
| UI foundation: tokens, Tailwind, primitives, layout shell, WS client, store | `src/renderer/src/{design,components/ui,lib,state,app}/**`, `src/renderer/index.html`, `src/renderer/src/main.tsx` | ui-foundation |
| Chat UI: transcript, tool cards, composer, prompts, right panels | `src/renderer/src/features/chat/**` | ui-chat |
| Other views: GPU, Activity, Schedules, Settings, Models | `src/renderer/src/features/{gpu,activity,schedules,settings}/**` | ui-views |
| Tests | `tests/unit/<area>/**` per owner; `tests/e2e/**` integration | each owner / integration |

### 2.1 Module entry points (exact exports — the composition root imports these)

```ts
// src/core/store/index.ts
export function createStores(dataDir: string, native: NativeBridge): { sessions: SessionStore; settings: SettingsStore; secrets: SecretStore; kv: KvStore };
// src/core/activity/index.ts
export function createActivityRegistry(bus: EventBus): ActivityRegistry;
// src/core/llm/index.ts
export function createLlmClient(): LlmClient;
export function createModelRegistry(ctx: CoreContext): ModelRegistry;   // registers 'local' + 'custom:*' providers itself; gpu registers 'vast' via ctx.models.register(ctx.gpu.provider())
// src/core/tools/index.ts
export function createShellRegistry(ctx: CoreContext): ShellRegistry;
export function createToolRegistry(ctx: CoreContext): { all(): ToolDef[]; get(name: string): ToolDef | undefined }; // all() = builtins + ctx.ext.mcpTools()
// src/core/ext/index.ts
export function createExtensions(ctx: CoreContext): ExtensionsApi & { start(): Promise<void>; dispose(): Promise<void> };
// src/core/agent/index.ts
export function createAgentManager(ctx: CoreContext): AgentManager;
// src/core/gpu/index.ts
export function createGpuManager(ctx: CoreContext): GpuManager & { start(): Promise<void> };  // start() = reconcile instances, begin heartbeats
// src/core/scheduler/index.ts
export function createScheduler(ctx: CoreContext): SchedulerApi & { start(): void; stop(): void };
// src/core/index.ts (platform)
export async function createCore(opts: { dataDir: string; native: NativeBridge; port?: number }): Promise<{ url: string; token: string; port: number; ctx: CoreContext; close(): Promise<void> }>;
```

`CoreContext` is created as one mutable object and filled in order (stores → bus → activity → llm → ext → shells →
tools → models → gpu → agent → scheduler); **factories must not call other modules during construction** — only
store the `ctx` reference and use it lazily at call time. Startup side effects belong in `start()`.

**Never edit `package.json`** (deps are pre-installed by the scaffold; if you need a package, use `npm i <pkg>` only if
it is pure-JS and small, and list it in your final report). Never delete other areas' files.

## 3. Tech stack (installed by scaffold)

Electron 44 · electron-vite 5 · Vite · React 19 · TypeScript (strict, ESM, `moduleResolution: bundler`) ·
Tailwind CSS 4 (`@tailwindcss/vite`) · Radix UI primitives · lucide-react icons · zustand · react-markdown + remark-gfm ·
shiki (code highlight) · diff (jsdiff) · ws · ssh2 · croner · @modelcontextprotocol/sdk · @vscode/ripgrep (+ JS fallback) ·
fast-glob · picomatch · turndown · @mozilla/readability · linkedom · gray-matter · nanoid · zod · strip-ansi · tree-kill ·
@fontsource/ibm-plex-sans · @fontsource/jetbrains-mono · vitest · @playwright/test · tsx · electron-builder.

Scripts: `dev` (electron-vite dev) · `dev:web` (vite renderer only) · `core` (standalone core) · `build` · `typecheck`
(`tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json`) · `test` (vitest run) · `e2e` (playwright) ·
`dist` (electron-builder --win).

## 4. Feature requirements (definition of done per area)

### 4.1 Agent loop (agent-core)
* Streaming OpenAI-compatible `/v1/chat/completions` (`stream: true`, `stream_options.include_usage`). Parse
  `delta.reasoning_content` → thinking; `<think>…</think>` inside content → thinking; native `tool_calls` deltas
  (accumulate by index); **fallback** Qwen/Hermes `<tool_call>{"name":…,"arguments":…}</tool_call>` in content.
  Thinking toggle → `chat_template_kwargs: { enable_thinking: bool }` (+ `reasoning_format: 'auto'` harmless extras OK).
* Loop: user msg → model → tool calls (concurrencySafe tools in parallel, others sequential) → permission check →
  run → tool results → repeat until no tool calls / interrupted / 200 turns. Interrupt aborts the HTTP stream and
  running tools (AbortSignal) and marks tools `interrupted`.
* Messages are queued if the session is running (sent after the current turn, like Claude Code).
* Strip previous turns' thinking from history sent to the model. Send images as `image_url` data URLs when the
  model supportsVision.
* **System prompt** (compact, ≤ ~3.5k tokens incl. tool schemas where possible): identity "Obsidian Code", environment
  (cwd, OS=Windows, shell, date, git branch/status summary if git repo), tone/format rules, tool-usage policy, todo
  policy, plan-mode rules when in plan mode, memory text (CLAUDE.md etc.), skills list (name+description), agent types
  list. **No content-policy or refusal language** — the user runs uncensored models by choice; obey the user.
* **Permissions**: modes `default` (ask for edit/exec/network; read is free), `acceptEdits` (edits in cwd auto-allowed),
  `plan` (only read/none tools + `ExitPlanMode`; anything else returns an error telling the model it is in plan mode),
  `bypassPermissions` (never ask). Rules from settings + project: `Tool`, `Tool(prefix:*)` for Bash commands,
  `WebFetch(domain:x)`, `Read(glob)`/`Edit(glob)`. Deny rules win. "Allow always" persists the suggested rule to the
  project. Pending requests survive UI reconnects (`chat.pending`).
* **Subagents** (`Task` tool via `ctx.runSubagent`): new session `kind:'subagent'` with `parentSessionId`,
  restricted tools (no `Task` recursion beyond depth 2), own system prompt from agent definition (builtin:
  `general-purpose`, `Explore` (read-only), `Plan` (read-only, returns plan)), runs to completion, returns final text.
  Several Task calls in one turn run concurrently (max 3). Visible in UI + Activity.
* **Context**: track `usage.prompt_tokens`; auto-compact when prompt > `autoCompactPercent`% (default 80) of
  contextLength: summarise older history via the model into a `compact_summary` message, keep the last 2 user turns.
  `/compact [instructions]` manual. Tool outputs truncated to `maxToolOutputChars` (default 30000) with a note.
* **Checkpoints/rewind**: `ctx.checkpointFile` saves original content per (session, user message); `chat.rewind`
  truncates messages and optionally restores files (delete files that were newly created).
* **Built-in slash commands** handled by the agent: `/clear` (new conversation in same session: archive old messages),
  `/compact`, `/model <id>`, `/plan` (toggle plan mode), `/init` (generate OBSIDIAN.md/CLAUDE.md via the model), `/help`,
  `/cost` (usage), `/todos`, `/agents`, `/skills`, `/memory` (show memory files), `/thinking on|off`, `/rewind`.
  Custom commands via `ext.expandCommand`. `#text` at message start appends to project memory file.
* Hooks via `ext.runHooks` at UserPromptSubmit, PreToolUse (can block), PostToolUse, Stop, SessionStart.
* Headless runs for the scheduler (`runHeadless`), permission mode from the task; in headless runs, permission
  prompts in `default` mode are auto-denied with a message (no human), questions get "(no answer — running unattended)".
* Session title: after the first assistant reply, generate a ≤6-word title with a cheap `complete()` call
  (fallback: first 50 chars of the prompt).
* Mock LLM server (`tests/fixtures/mock-llm/server.ts`): scripted SSE responses incl. reasoning_content, tool_calls
  (native and `<tool_call>` text form), usage; used by unit tests for the loop.

### 4.1b Engines
See §4.7: `ctx.agent` is the `EngineRouter`; each session runs on `builtin` (the loop above) or `claude-code`.

### 4.2 Tools (tools) — Claude Code parity, model-facing names exactly:
`Read` (offset/limit, line numbers `cat -n` style, images → ToolResultPayload.images, PDFs → text if possible, notebooks),
`Write`, `Edit` (old_string/new_string/replace_all, uniqueness check, read-before-edit), `MultiEdit`, `Glob`, `Grep`
(ripgrep via @vscode/ripgrep with JS fallback; output_mode content/files_with_matches/count, -i, -n, -A/-B/-C, glob,
type, head_limit, multiline), `LS`, `Bash` (Git Bash if found at `C:\Program Files\Git\bin\bash.exe` else PowerShell;
`timeout` default 120s max 600s; `run_in_background`; streams progress; kills process tree on abort), `BashOutput`,
`KillShell`, `PowerShell` (explicit PowerShell), `WebFetch` (fetch → Readability → Markdown via turndown; optional
`prompt` → `ctx.complete` extraction when content is long; 15-min cache), `WebSearch` (DuckDuckGo HTML default, Brave /
Tavily / SearXNG when configured; returns title/url/snippet list), `TodoWrite`, `AskUserQuestion`, `Task`
(→ ctx.runSubagent), `ExitPlanMode`, `Skill` (→ ext.loadSkill, returns body + base dir), `NotebookEdit`,
`ScheduleTask` / `ListScheduledTasks` / `DeleteScheduledTask` (→ ctx.scheduler). Each tool: concise description,
JSON schema, `permission()`, `title()`, `ruleFor()`, rich `display`. Paths: accept absolute or cwd-relative; Windows
path normalisation. Unit tests for each (temp dirs).

### 4.3 Extensions (extensions)
Memory files: `~/.obsidian-code/OBSIDIAN.md`, `~/.claude/CLAUDE.md` (if importClaudeConfig), and walking up from cwd:
`OBSIDIAN.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`. Skills: `~/.obsidian-code/skills/*/SKILL.md`,
`<cwd>/.obsidian-code/skills`, plus `~/.claude/skills` and `<cwd>/.claude/skills` when importClaudeConfig (frontmatter
name/description). Agents: `.../agents/*.md` (frontmatter name, description, tools, model; body = system prompt) + builtins.
Commands: `.../commands/*.md` (frontmatter description, argument-hint; `$ARGUMENTS`, `$1..$9`). MCP: connect servers from
settings (`stdio` via @modelcontextprotocol/sdk StdioClientTransport, `http` via StreamableHTTPClientTransport), expose
tools as `mcp__<server>__<tool>` ToolDefs (permission 'exec'), reconnect on settings change. Hooks: run shell command
with JSON payload on stdin, timeout, exit code 2 = block with stderr as message; stdout JSON `{additionalContext}` optional.

### 4.4 GPU / Vast.ai (gpu) — money-safety is the top priority
* Vast REST API (base `https://console.vast.ai/api/v0`, header `Authorization: Bearer <key>`). **Research and verify the
  exact endpoints from docs.vast.ai before coding**: search offers (bundles), create instance from offer (asks),
  list/show instances, destroy, (stop/start), current user (credit), SSH key registration/attach. Unauthenticated offer
  search works and MUST be exercised live in a test. Authenticated calls are unit-tested against a local mock server
  (the user provides the key tomorrow; then we live-test).
* Clock-in pipeline (state machine → `GpuStatus.steps`): budget check → search offers matching profile (gpu_name in list,
  num_gpus, gpu_ram, cpu_ram, disk, inet_down, reliability, verified, rentable, optional datacenter; sort by price;
  respect `maxPricePerHour`) → create instance (image from settings, disk, label `obsidian-code`, onstart = bootstrap
  script with env: model URLs, llama args, API key, idle/heartbeat/max-hours) → poll until running → SSH (ssh2, app's
  ed25519 key registered on the account) → poll `/root/oc/status.json` for download/load progress → open local port
  forward `127.0.0.1:<localPort>` → remote `127.0.0.1:8080` → health check `/v1/models` with API key → `ready`.
  On any failure: **destroy the instance** (retry with backoff, verify it is gone), surface the error.
* Clock-out: destroy instance, verify gone, close tunnel, finalize ledger record. Per-second billing → cost =
  price × elapsed. Ledger in kv `gpu-ledger`; month cost; monthly budget blocks clock-in (and auto clock-out at budget).
* Watchdogs: **server-side** (in bootstrap script): destroy itself via Vast API using `$CONTAINER_API_KEY` /
  `$CONTAINER_ID` (verify the variable names + endpoint in docs) when no inference for `idleMinutes`, or no app heartbeat
  file touch for `heartbeatMinutes`, or `maxSessionHours` exceeded. **App-side**: heartbeat over SSH every 60 s; on
  app quit with `clockOutOnQuit` → clock out (main process awaits it, max 20 s); on startup → list labelled instances,
  adopt the tracked one if still running, else report orphans (`gpu.destroyOrphans`).
* Bootstrap script (`resources/server/bootstrap.sh`, rendered with variables): verify the llama.cpp CUDA docker image tag
  (`ghcr.io/ggml-org/llama.cpp:*` — pick one with CUDA ≥ 12.8 for Blackwell (RTX 5090 / RTX PRO 6000) and a shell +
  python/pip or curl), download model files (prefer `hf download` with hf_xet via pip; fallback parallel curl), write
  status JSON with progress, start `llama-server --host 127.0.0.1 --port 8080 --api-key $KEY -ngl 99 -c <ctx>
  --jinja --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 <model llamaArgs>`, model-switch command
  (`/root/oc/switch.sh <modelId>`), log to `/root/oc/server.log`.
* Catalog (`src/core/gpu/catalog.ts`) with **verified** Hugging Face repos/files (query
  `https://huggingface.co/api/models/<repo>/tree/main`; record `verifiedAt`). Profiles: `light` (1× RTX 5090 32 GB →
  Qwen3.8-27B), `standard` (1× RTX PRO 6000 96 GB → Qwen3.8-Flash-Next if llama.cpp supports it, else Qwen3.8-27B Q8),
  `max` (2× RTX PRO 6000 → GLM-5.3-Flash). Each family must have an **uncensored** and a **standard** variant (uncensored
  preferred: heretic-org / HauhauCS / huihui-ai; standard: unsloth / official GGUF).
* `VastProvider` (id `vast`): endpoint = tunnel URL + API key when ready; models = the loaded catalog model.
* **Model browser** (`src/core/gpu/hub.ts`, `model-browser.ts`; shared pure logic in `src/shared/{hub-parse,model-fit,user-models}.ts`;
  RPC `hub.search/details/addModel/removeModel/setFavorite`; the Models view): the built-in catalog above stays the default
  ("Recommended"); the user can also browse the public Hugging Face API anonymously (`filter=gguf`, sort by downloads / likes /
  updated / trending, cached ~10 min, 15 s timeout, friendly 429/5xx/network errors), star repos (`Settings.vast.favoriteRepos`)
  and add a quant variant (`Settings.vast.userModels`, a `CatalogModel` with `source: 'user'`): split files are grouped
  (`*-00001-of-0000N.gguf`, also in sub-folders), mmproj / MTP / imatrix / LoRA files are never variants, gated repos are
  refused (the rented server has no Hugging Face login), VRAM and context are *estimated* (`model-fit.ts`: weights + overhead +
  q8_0 KV cache, at least a 32k context on the smallest profile offered, capped by the GGUF context length) and `profiles` =
  the GPU profiles whose nominal VRAM fits. `llamaArgs` stay empty. Every lookup (`getCatalogModel`, `modelsForProfile`,
  `gpu.catalog`, the scheduler, the Vast provider) sees built-in + user models; the experimental fallback only ever picks
  built-ins. Whatever is read from settings is re-validated (`sanitizeUserModels`: safe repo and file names, positive sizes, no
  built-in id shadowed) because it lands in `config.sh` (every value shell-quoted) and in download URLs. A clock-in ships the
  built-ins plus the chosen model in the instance env; a live switch to a user model uploads the full `config.sh` over SSH
  first. A model the GPU or a scheduled task is using cannot be removed.
* **Auto clock-out** (`src/core/gpu/auto-clockout.ts`; `gpu.autoClockOut.get/set`; `GpuStatus.autoClockOut` +
  `autoClockOutWatches`; `Settings.vast.autoClockOut`): so nobody pays for an idle or hung GPU overnight. A *watch*
  targets one session or any session using the Vast provider (the global watch) with mode `finished` (no session
  'running' — idle, error or waiting for the user — for `finishGraceMinutes`, default 2, counted only after something ran
  since arming; a queued message or a new run cancels it), `unresponsive` (a running session without progress events for
  `stallMinutes`, default 10; or 3 reasoning-only turns in a row — the agent loop's "You ended your turn with reasoning…"
  hook messages without a tool call between them; or a session waiting for input that long — a global watch needs EVERY
  active session stuck; a tool call that is running gets 10 more minutes; the stuck sessions are interrupted first) or `both`. Only acts while the GPU is `ready`
  (loading/model switches restart the timers; a PC sleep is not counted). `default` (off | finished | unresponsive |
  both; default `unresponsive`) arms a global watch at every clock-in. A watch is cleared when it fires, when the GPU
  clocks out for any reason, or when cancelled. Firing = `gpu.clockOut('auto_unresponsive' | 'auto_finished', why)` (history
  badge "Auto · …", status message "Clocked out automatically: <why>.", parks instead of destroying in park mode) + one
  `notification` saying why. UI: right-click menu (Clock out now / when the current task finishes / if it stops responding /
  Both / Cancel, active one checked) on the sidebar GPU widget, the rail button, the status-bar GPU segment (global) and the
  chat header + composer toolbar (this session); the widget shows the armed watch and the finish countdown.
* Also implement the **Local** provider detection is in llm/ (agent-core), not here.

### 4.5 Platform (platform)
Core composition (`createCore`), HTTP server (`/health`, `/ws`), token auth, JSON-RPC router mapping every method in
`RpcMethods` to modules, event bus fan-out to all clients, activity registry. Stores: sessions (JSON per session, debounced
atomic writes), settings (defaults + deep-merge + validation; default profiles; default model = local if online),
secrets (Electron safeStorage via `native.encrypt/decrypt`; standalone fallback AES-256-GCM with a key file in dataDir),
kv. Scheduler: croner-based, persisted, catch-up policy = run once if missed while app closed (configurable later),
`allowAutoClockIn` path with budget guard, notifications on finish. Electron: single-instance lock, frameless-ish window
with custom title bar (Windows controls overlay), tray icon (Clock in/out, Open, Quit), native notifications, launch
at login setting, graceful quit (clock-out + flush), preload API: `coreUrl`, `pickFolder()`, `openPath()`,
`showItemInFolder()`, `platform`, window controls. electron-builder config: NSIS + portable, `asarUnpack` for ripgrep
binary and `resources/server/**`, app id `com.obsidian.code`, product name "Obsidian Code", icon generated (an obsidian
shard glyph) as .ico/.png.

### 4.6 UI (ui-foundation, ui-chat, ui-views) — design system "Obsidian"
See §5. Layout like the Claude Code desktop app:
* **Left sidebar** (240 px, collapsible): app mark + "New session" (Ctrl+N), search, sessions grouped Pinned / by
  project folder (relative time, running spinner, unread dot), nav items: Scheduled, Activity, GPU, Settings; bottom:
  **GPU widget** (status dot, model, $/h, session timer, Clock in/out button).
* **Main**: header (session title editable, cwd chip with folder picker, git branch, model picker, context meter) →
  transcript → composer.
* **Transcript**: user bubbles (right-aligned subtle surface), assistant text (markdown, GFM tables, shiki code blocks
  with copy), collapsible **Thinking** blocks (live timer while streaming, "Thought for 12s"), **tool cards** per tool
  (header: icon + title + status; body: Read → file excerpt, Edit/Write → unified diff with +/- colours, Bash →
  terminal-styled output with exit code, Grep/Glob → list, WebSearch → result links, WebFetch → url card, TodoWrite →
  checklist, Task → subagent card with live nested transcript preview and "Open", AskUserQuestion → answered
  questions), inline **permission prompt** (Allow once / Always allow `<rule>` / Deny + feedback) with keyboard
  shortcuts (1/2/3, Esc), **question card** (options as selectable rows, multiSelect, "Other" free text, Submit),
  **plan approval card** (rendered plan, Approve → choose mode (acceptEdits/default), Keep planning + feedback), compact
  summary divider, error banners with Retry, "Rewind to here" on user messages (with "also restore files" toggle),
  jump-to-bottom button, virtualised or efficiently rendered long transcripts.
* **Composer**: auto-growing textarea, Enter send / Shift+Enter newline, `/` command palette (builtin + custom,
  fuzzy), `@` file mention palette (files.search), paste/drag images (thumbnails), permission-mode selector (Shift+Tab
  cycles: default → acceptEdits → plan → bypass), thinking toggle, model picker (grouped by provider, with
  uncensored/standard badge, status dot), Stop button while running (Esc), queued-message chip.
* **Right panel** (toggle, tabs): Changes (changed files list → diff viewer), Todos, Agents (subagents of this session
  with status), Files (cwd tree, click to insert @mention).
* **GPU view**: profile cards (Light / Standard / Max with live price range from `gpu.offers`), model picker with
  **Uncensored ↔ Standard** toggle, big Clock in / Clock out button, step checklist with progress bar, session timer +
  live cost, month spend vs budget bar, credit balance, history table, server log viewer, orphan-instance warning banner,
  "API key missing" empty state linking to Settings.
* **Activity view** ("oversee the work"): live list of running/recent sessions, subagents, background shells,
  schedule runs, GPU; status, elapsed, Stop buttons, click to open.
* **Scheduled view**: list (name, schedule in human words + next run, last status), create/edit dialog (name, prompt,
  folder, schedule presets: hourly/daily at/weekdays at/custom cron/once at, model, permission mode, auto clock-in
  toggle with cost warning), Run now, enable toggle.
* **Settings view** (sections): Models & providers (local URL + test, custom endpoints CRUD + keys), Vast.ai (API key
  input → `secrets.set('vast.apiKey')`, Test key, budget, idle/heartbeat/max hours, clock-out on quit, image, profiles
  editor), Permissions (default mode, allow/deny rules), Web search provider + keys, MCP servers (JSON editor),
  Hooks (JSON editor), Engine (default engine, Claude Code executable / system prompt / config import / env; 4.7),
  Memory & Claude import toggle, Shell, Appearance (density), Notifications, Launch at login,
  About & updates (data dir, version, update state, release notes, update token; `RELEASING.md`).
* Global: command palette (Ctrl+K) for navigation/actions, toasts for `notification` events, reconnecting banner when
  the WebSocket drops (auto-reconnect with backoff, refetch state), keyboard focus rings, no emoji icons (lucide only).

### 4.7 Engines (src/core/engine) — a session runs on one agent harness
Binding requirement (user): Claude Code's shell and all its functionality, but **every model call goes to the user's own
local/uncensored model; zero Anthropic traffic**. Research, measurements and gotchas: `docs/research/claude-agent-sdk.md`;
real-model results: `docs/e2e-real-results.md`.

* **Contract.** `EngineId = 'builtin' | 'claude-code'`; `Session.engine` (missing = `builtin`); `settings.engine`
  `{ default, claudeCode: { executable: 'auto'|path, systemPrompt: 'lean'|'claude_code', importUserClaudeConfig, extraEnv } }`;
  RPC `engines.list`, `chat.setEngine` (idle sessions only; the transcript carries over), `sessions.create {engine}`,
  `commands.list {sessionId}`. `ctx.agent` is the `EngineRouter` (`engine/index.ts`): every `AgentManager` call dispatches
  by `session.engine`; `builtin` is the loop of §4.1, shown as "Obsidian". UI: engine selector in the composer, Settings →
  Engine, Home quick start; `claude-code` sessions list Claude Code's own slash commands.
* **Harness.** `claude-code` (`engine/claude-code/engine.ts`) runs one long-lived SDK query per active session
  (`@anthropic-ai/claude-agent-sdk` 0.3.296 → the bundled native `claude.exe` = Claude Code 2.1.296, pinned, auto-update
  off) in streaming-input mode; the app keeps its own queue (one turn at a time, queued messages stay withdrawable).
  `translate.ts`/`display.ts` turn SDK messages into the existing CoreEvents and tool cards (`Agent` → `Task`,
  `mcp__obsidian__*` → `WebSearch`/`ScheduleTask`/…); the UI is unchanged. Resume across restarts, rewind (checkpoints +
  `resumeSessionAt` fork), engine switch (seeded with a transcript), interrupt, headless (scheduled) runs, session titles
  and usage totals work as for `builtin`.
* **Zero Anthropic traffic.** Claude Code gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/r/<route>`: the **relay**
  (`engine/shim.ts`, in the core) forwards only to the session's endpoint (local llama-server or Vast tunnel) and has no
  other upstream, injects the endpoint API key (it never enters Claude Code's environment), maps model ids containing `/`
  to an alias, adds `chat_template_kwargs.enable_thinking=false` when thinking is off, folds mid-conversation
  `role:"system"` entries into the user turn (llama.cpp answers HTTP 500 otherwise), and repairs a tool call the model wrote as
  plain text (`engine/recover.ts`: only a text block that starts with a tool-call opener is held back and, if it parses with
  the shared fallback parser `llm/textToolCalls.ts`, replaced by `tool_use` blocks with `stop_reason: tool_use`). `engine/env.ts` strips every inherited
  `ANTHROPIC_*`/`CLAUDE_CODE_*`/OAuth variable, sets an isolated `CLAUDE_CONFIG_DIR=<dataDir>/claude-code` and disables
  telemetry, error reporting, feature flags, updates, claude.ai connectors, the marketplace, login/account commands and
  WebFetch's api.anthropic.com preflight. Verification: the spike (31 model requests, all to the endpoint) and
  `scripts/net-audit.ps1` (outbound TCP of the core's process tree during a run with a subagent and `/compact`: loopback
  only; with a web scenario: only the sites the web tools fetched).
* **Prompt.** `systemPrompt: 'lean'` (default) = Claude Code's tools/loop with the app's compact prompt (614 tokens, no
  refusal or content-policy language); `'claude_code'` ("full") = Claude Code's preset (1,329 tokens, contains Anthropic's
  refusal guidance). First turn ≈17.6k / ≈18.3k tokens: Claude Code's tool schemas (≈15k) dominate, so the choice is
  behaviour, not speed. Cold first token 30–80 s on the local GPU, cached follow-ups 2–10 s.
* **Tools and permissions.** Claude Code's own tools run unchanged, except: `WebSearch` is disallowed and replaced by the
  in-process MCP server `obsidian` (`mcp.ts`: `web_search`, `schedule_task`, `list_scheduled_tasks`,
  `delete_scheduled_task` run the app's ToolDefs and keep their result cards); session-only cron tools are off (the app's
  persistent scheduler is used). Permissions use the app's rules (`decidePermission`, allow/deny, trusted folders,
  protected paths) via `canUseTool` and a `PreToolUse` hook (which also snapshots edits for the Changes panel/rewind);
  AskUserQuestion and ExitPlanMode use the existing question/plan requests. Plan mode denies every change with the
  app's plan-mode message (never a prompt) except Claude Code's own plan file (`<config dir>/plans/*.md`), which is not
  listed as a changed file. Subagents (`Agent`) default to `run_in_background:false` (one
  request at a time on a single local GPU; the report returns as the tool result); an explicit choice is kept.
* **Local-model details.** `/cost` output shows "local model, not billed" instead of Claude Code's guessed price; local
  command output Claude Code re-emits after `/compact` is dropped; project `.claude` settings/hooks/skills load only for
  trusted folders; `~/.claude` skills/agents/commands/CLAUDE.md are copied into the config dir (toggle), `settings.json`
  and plugins never.
* **Packaging.** The native binary is an optional dependency of the SDK (260 MB); electron-builder unpacks it
  (`asarUnpack: node_modules/@anthropic-ai/claude-agent-sdk-*/**`) and `resolveClaudeExecutable` maps `app.asar` →
  `app.asar.unpacked`. Fallbacks: the user's installed `claude`, or an explicit path (Settings → Engine).
* **Status and limits.** Anthropic does not officially support non-Claude models behind Claude Code; open-weight models
  follow its conventions less reliably (they may skip TodoWrite or ignore a tool), which is model variance, not an engine
  fault. Needs an endpoint with `/v1/messages` (probed once; clear error otherwise). No prefill progress bar for these
  turns; Claude Code's own file checkpointing is unused (the app's checkpoints do not see files changed by Bash).
* **Tests.** `tests/unit/engine/*` (scripted fake SDK, translator on recorded real SDK streams, shim, env, setup),
  `scripts/e2e-real.ts --engine claude-code` (real model: scenarios 1, 2, 3, 5, 7, 8, 9, 11, 12, 14),
  `tests/e2e/app-claude-code.spec.ts` (built and packaged Electron app).

## 5. Design system — "Obsidian" (M13)

**Source of truth: the user's own design, `docs/design/m-13-obsidian/`** — `screens.html` (six full application
screens), `obsidian.css` (its complete stylesheet: tokens + every component recipe) and `shots/*.png` (rendered
1440-px captures). Copy recipes from `obsidian.css` faithfully; when this section and the reference disagree, the
reference wins. (The earlier "Obsidian Dark" ui-ux-pro-max palette is retired.)

**Thesis (verbatim from the reference):** *remove every surface.* Pure `#000` OLED black with the chrome removed.
No cards, no panel fills, no frames — content floats, held in place by space and a single hairline rule. Borders exist
ONLY on things you can act on, held at ≥ 3:1. One cold-white accent marks the live edge; colour appears only for
status (something running, waiting, failing, succeeding). Flat fills and discrete tonal steps only — no gradients,
no colour ramps, no shadows (except a menu/dialog separation shadow), no blur, no glow.

Tokens (CSS variables in `src/renderer/src/design/tokens.css`, mapped into Tailwind v4 `@theme`; names below are the
reference's, the app may alias them as `--ob-*`):

| Token | Value | Use |
|---|---|---|
| `--s0` | `#000000` | ground — the only surface (app, sidebar, panels, transcript, dialogs) |
| `--s1` | `#07070A` | well: search fields, inputs, code/terminal wells, gutters |
| `--s2` | `#0E0E12` | raised sliver: thumbnails, user-message sliver, selected row base |
| `--s3` | `#17171C` | control fill (buttons, segmented, switch track) |
| `--s4` | `#23232A` | track / hover step |
| `--s5` | `#2E2E36` | highest tonal step |
| `--t1` | `#FFFFFF` | ink 21:1 |
| `--t2` | `#ADADB6` | secondary 9.4:1 |
| `--t3` | `#7A7A85` | tertiary 4.95:1 (labels, meta) |
| `--acc` | `#E6EEFF` | the single accent, cold white 18:1 — primary button fill, active tab underline, selection edge, focus |
| `--acc-ink` | `#000000` | text on accent |
| `--acc-wash` / `--acc-wash2` | `rgba(230,238,255,.07)` / `.13` | selected / pressed washes |
| `--line` | `#63636E` | functional outline 3.5:1 — ONLY on actionable things (buttons, inputs, selects, kbd, tags) |
| `--rule` / `--rule2` | `rgba(255,255,255,.10)` / `.055` | the hairline separators (structure) |
| `--hov` | `rgba(255,255,255,.035)` | row hover |
| status | `--rec #FF453A` · `--live #BF6BFF` · `--err #FF6F62` · `--warn #FFD426` · `--ok #3BE07A` | status only |

Mapping to app semantics: running/streaming/live → `--live` (violet) dot; waiting for the user (permission,
question, plan) → `--warn`; error/failed/denied → `--err`; done/ready/additions → `--ok`; GPU billing/recording-like
"money is being spent" indicator → `--rec` dot; diff additions `--ok`, deletions `--err` (thin text colour + very
faint wash, no heavy fills). Thinking blocks and subagents are NOT coloured — they use `--t3`/`--t2` text with a
hairline left rule; a live (streaming) thinking block gets the `--live` dot.

Typography: **Chivo** (UI, 400/500/600/700) + **Chivo Mono** (numbers, ids, paths, code, labels, status bar, kbd,
tags) — bundled locally via `@fontsource/chivo` + `@fontsource/chivo-mono` (the app must work offline). Base UI
12.5 px / 1.5, letter-spacing −.004em, `font-variant-numeric: tabular-nums`. Section/meta labels: Chivo Mono 9 px,
weight 500, `letter-spacing .22em`, UPPERCASE, `--t3` (key word in `--acc`). Titles: Chivo 600 with tight negative
tracking (e.g. 22 px / −.035em for a view title; session title ~17 px / −.03em). Chat prose: Chivo 13.5 px / 1.62,
`--t1`; secondary prose `--t2`.

Geometry: radius **2 px** everywhere (3 px for the outer window only). Row height **28 px** (dense lists, table
rows, menu items); controls 26–30 px. Hairline = 1 px `--rule`; sub-hairline `--rule2`. Spacing on a 4-pt grid with
generous outer gutters (24–32 px) so content floats.

Component recipes (from `obsidian.css`): title bar 34 px with the brand = 9 px rotated-square diamond in `--acc` +
"OBSIDIAN CODE" in Chivo Mono 9.5 px weight 600 tracking .24em, centred document title in `--t2` with `--t3`
separators; slim menu strip (27 px) with text items `--t2`, active item `--t1` on `--s3`; status bar at the bottom
(mono 9 px uppercase tracking, `--t3`, values `--t1`, status dots); **primary button** = solid `--acc` fill, black
text, 2 px radius; **secondary** = transparent with 1 px `--line` border, `--t1` text; **ghost** = text only `--t2`;
**danger** = 1 px `--err` border + `--err` text; tabs = text `--t2`, active `--t1` with a 2 px `--t1` underline,
counts in mono `--t3`; segmented control = 1 px `--line` frame, active segment `--t1` fill with black text; switch =
white pill when on; inputs = `--s1` well with 1 px `--line` border, mono where values are technical; tags/chips =
1 px `--line` (or status colour) border, mono 8.5 px uppercase tracking; kbd = 1 px `--line` box, mono 9.5 px;
lists/tables = no fills, 28 px rows separated by `--rule2`, column headers as mono labels, hover `--hov`, selected row
= `--acc-wash` + 2 px `--acc` left edge; sidebar = same black ground separated by a `--rule` hairline (no fill),
group headings as mono labels, counts mono `--t3`; dialogs/menus/popovers = `--s0` (or `--s1`) with 1 px `--line`
border and `0 16px 48px rgba(0,0,0,.7)`; focus = 1 px `--acc` outline offset 1 px. Icons: lucide-react 14–16 px,
stroke 1.5, `--t2`. Motion: 120–160 ms, opacity/transform only, respect `prefers-reduced-motion`. Contrast ≥ 4.5:1
for all text (t3 is the floor). Scrollbars: 6 px, `--s4` thumb, no track.

## 5b. Decisions from Phase 1 research (binding — read docs/research/*.md for details)

* **Reasoning history (overrides §4.1 "strip thinking")**: for llama.cpp/vLLM dialect endpoints, KEEP `reasoning_content`
  on past assistant messages until compaction (measured: better prompt-cache reuse and the model keeps thinking).
  Strip only for generic endpoints. Keep the system prompt + tool list **byte-identical** across a session's turns
  (plan mode rejects disallowed tools at execution time instead of filtering the schema list) so the server's prompt
  cache keeps hitting. Detect server dialect (llamacpp / vllm / generic) via `/props` or `/version`; send llama.cpp-only
  fields (`reasoning_format`, `return_progress`, `cache_prompt`, `top_k`) only to llamacpp/vllm.
* **Fallback text tool-call parser** must handle Qwen XML (`<tool_call><function=NAME><parameter=P>v</parameter></function></tool_call>`),
  Hermes JSON (`<tool_call>{"name":…,"arguments":…}</tool_call>`) and GLM `arg_key/arg_value` forms, coercing values by schema.
  Never execute a tool call whose arguments are invalid JSON or whose stream ended with `finish_reason: "length"` — return an
  error to the model instead. Tool-call arguments put back into history must be valid JSON (server 500s otherwise).
* Only one system message, first. Use an idle timeout (no bytes for 120 s; use `return_progress:true` on llama.cpp for
  liveness during long prefills) instead of a total timeout; no max_tokens on agent turns.
* The user's local server is shared with another app (Hearth) — don't pin slots; ≤ 2 concurrent requests from us to `local`.
* **Vast**: create = `PUT /asks/{offerId}/`; destroy = `DELETE /instances/{id}/`; runtype `"ssh_direc ssh_proxy"`;
  prefer direct SSH (public_ipaddr + ports['22/tcp']) else proxy (ssh_host:ssh_port); env is a dict; onstart is a small
  stub (< ~4000 chars) that FIRST arms the self-destroy watchdog, then decodes the full bootstrap shipped gzip+base64 in an
  env var (fallback: upload over SSH). Offer filters always add `cuda_max_good >= 12.8`, `inet_down_cost <= 0.01`,
  `direct_port_count >= 4`, `duration >= 1 day`, `allocated_storage = disk`. gpu_name values use spaces (e.g. "RTX 5090").
* **Image**: `ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561` (pinned; CUDA 12.8; has bash/curl/python3/pip).
* **Catalog** (`docs/research/catalog.json`, 11 verified entries): `files[0]` is passed to `-m`; extra non-split files
  (e.g. an MTP head) may follow the split parts; `llamaArgs` may contain a `{modelDir}` placeholder the bootstrap must
  substitute. Flash-Next & GLM-5.3-Flash are `experimental`. Big models download for 15–22 min per clock-in (billed) →
  `clockOutMode: 'park'` (stop instance, keep disk) is offered; default stays `destroy` (no idle storage cost).
* Image download sizes: mention expected warm-up time per model in the GPU UI (sizeGb / ~150 MB/s heuristic).

## 6. Quality bar & verification

* `npm run typecheck`, `npm test`, `npm run build` must pass at the end of every phase.
* Unit tests per area with temp data dirs; no network in unit tests except the explicitly-live Vast offer search
  test and HF catalog verification (mark `.live`, skipped when `OFFLINE=1`).
* Real-model E2E (integration phase): drive the core headlessly against the user's local llama-server
  (127.0.0.1:8080, model id from `/v1/models`) — tasks: read a file, edit a file, run a command, glob/grep, todo list,
  ask-question auto-answer, subagent, web search+fetch, plan mode, schedule creation. It is slow (~20 tok/s): use short
  prompts and generous timeouts; don't run more than 2 concurrent requests (the user's Hearth app may also use it).
* UI E2E: Playwright against `dev:web` + standalone core (and one Electron launch smoke test via `_electron`);
  screenshots saved to `tests/e2e/screenshots/` for design review.
* Windows specifics: paths with spaces (the project lives in `E:\programming projects\…`), CRLF, PowerShell quoting,
  process-tree kill.
* Security: core listens on 127.0.0.1 only, token required for WS/HTTP; secrets never sent to the renderer; renderer has
  `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; markdown rendering never executes raw HTML.
