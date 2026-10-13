# Claude Code as an engine (Claude Agent SDK on a local model)

Status: implemented as the `claude-code` engine (`src/core/engine/**`), selectable per session next to the app's own
loop (`builtin`, shown as "Obsidian"). Spike: `scripts/claude-code-spike.ts` (fixtures in `tests/fixtures/claude-code/`).
Measured 2026-10-13 against the local llama-server (llama.cpp b11517, Qwen3.6-35B-A3B uncensored Q4_K_M, n_ctx 131072,
4 slots) with `@anthropic-ai/claude-agent-sdk` 0.3.296 (bundles Claude Code 2.1.296).

**Goal (user):** "the shell, all the functionality of Claude Code, but the engine — the model that is running — is a
local uncensored one." Claude Code's harness provides tools, subagents, skills, hooks, slash commands, plan mode,
permissions, compaction and todos; every model call goes to the session's own endpoint; no Anthropic account.

## Architecture

```
renderer ──RPC──▶ core: EngineRouter (src/core/engine/index.ts) ── session.engine ──▶ builtin AgentManagerImpl
                                         │
                                         └─▶ ClaudeCodeEngine (claude-code/engine.ts)
                                               │ one long-lived SDK query per active session (streaming input)
                                               ▼
                                   @anthropic-ai/claude-agent-sdk ──spawn──▶ claude.exe (Claude Code 2.1.296)
                                                                                 │ ANTHROPIC_BASE_URL=http://127.0.0.1:<p>/r/<route>
                                                                                 ▼
                                   AnthropicShim (engine/shim.ts, in the core) ──▶ session endpoint /v1/messages
                                                                                   (local llama-server or Vast tunnel)
```

* `translate.ts` turns SDK messages into the existing CoreEvents (`message.added/delta/block/completed`,
  `tool.updated`, `todos.updated`, `changes.updated`), so the UI is unchanged. `display.ts` maps tool results to
  `ToolDisplay` (Read → file, Write/Edit → diff, Bash → bash, Grep/Glob → list, WebFetch → web, TodoWrite → todos,
  Agent → subagent, ExitPlanMode → plan, AskUserQuestion → questions) and names (`Agent` → `Task`, obsidian MCP tools →
  `WebSearch`/`ScheduleTask`/…) so the existing cards render.
* `canUseTool` → the app's permission/question/plan flow; `PreToolUse` hook → app deny rules, protected reads and
  rewind checkpoints. In-process MCP server `obsidian` (`mcp.ts`): `web_search`, `schedule_task`,
  `list_scheduled_tasks`, `delete_scheduled_task` run the app's own ToolDefs.
* Engine state per session in kv `claude-code.<sessionId>`: Claude session id, last chain uuid, user-message →
  resume point map, pending fork (rewind).

## Zero Anthropic traffic

Checked with two recording proxies in the spike (model traffic: reverse proxy in front of the shim; everything else:
`HTTPS_PROXY` that logs every CONNECT and refuses Anthropic/telemetry hosts). All 11 probes (plain, preset, tools, ask,
plan, task, todo, mcp, webfetch, interrupt, resume + /compact) — 31 model requests, 1 other request
(`tests/fixtures/claude-code/network.json`):

| Request class (x-claude-code-request-class) | Count | Went to |
|---|---|---|
| main | 26 | session endpoint |
| subagent | 3 | session endpoint |
| compaction (`/compact`) | 1 | session endpoint |
| auxiliary (WebFetch summary) | 1 | session endpoint |
| egress | 1 | `example.com:443` (the page WebFetch fetched) |

No CONNECT to `*.anthropic.com`, `claude.ai`, `claude.com`, statsig, sentry or datadog was attempted. What makes that so
(`src/core/engine/env.ts`):

| Variable / option | Why |
|---|---|
| `ANTHROPIC_BASE_URL` = shim route, `ANTHROPIC_AUTH_TOKEN` = placeholder | Anthropic Messages format to our endpoint; a token means no login/OAuth path. Inherited `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, OAuth tokens are stripped. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` = served model, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | every alias, background ("haiku") call and agent definition (`model: opus` …) runs on the session model |
| `CLAUDE_CONFIG_DIR` = `<dataDir>/claude-code` | isolated: no credentials, the user's `~/.claude` is only read (import below) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_GROWTHBOOK`, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_ARTIFACT`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | no telemetry, feature flags, update checks, claude.ai connectors, marketplace |
| settings `skipWebFetchPreflight: true` | WebFetch's domain safety check would call api.anthropic.com |
| `disallowedTools: ['WebSearch']` | server-side Anthropic tool; replaced by `mcp__obsidian__web_search` |
| `DISABLE_LOGIN/LOGOUT/UPGRADE/EXTRA_USAGE/FEEDBACK/INSTALL_GITHUB_APP_COMMAND` | hide account commands that cannot work |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | no per-request attribution block / beta body fields llama.cpp does not know |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` = model context, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` = min(16384, ctx/4), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` = settings.autoCompactPercent | correct window for an unrecognised model id |
| `API_TIMEOUT_MS=1800000`, `API_FORCE_IDLE_TIMEOUT=0`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000` | a 30k-token prefill at ~70 tok/s is silent for minutes; the event/byte watchdogs default to 300 s (the first-byte deadline does not run behind a custom base URL) |
| `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, `CLAUDE_CODE_ENABLE_TASKS=0` | todo tools are only offered to recognised Claude models; the legacy `TodoWrite` maps 1:1 onto the app's todo list |
| `CLAUDE_CODE_DISABLE_CRON=1` | session-only cron tools (~1.9k prompt tokens) duplicate the app's persistent scheduler (`mcp__obsidian__schedule_task`) |

Fast mode's availability check would call api.anthropic.com; nonessential-traffic mode skips it (and fast mode is
irrelevant here).

## The shim (`src/core/engine/shim.ts`) — why it exists

1. **Mid-conversation `role: "system"` messages.** Claude Code 2.1.296 sends its environment/skills context as a
   `{"role":"system"}` entry inside `messages`. llama.cpp's chat templates reject it (HTTP 500 "System message must be
   at the beginning"); Claude Code only retries without them on a 400/422, so every turn failed. The shim folds such
   entries into the neighbouring user turn as `<system-reminder>` text (tool_result blocks stay first).
2. **Thinking off.** Anthropic semantics: no `thinking` field = no extended thinking. llama.cpp ignores the field and
   Qwen3.x thinks by default, so the shim adds `chat_template_kwargs: {enable_thinking: false}` when `thinking` is absent
   or disabled (verified: `/v1/messages` honours it). Main turns with thinking on carry `{type: 'adaptive'}` and are
   untouched; side requests (compaction, WebFetch summaries) run without reasoning.
3. **Model ids with `/`** (Claude Code reads them as a provider prefix): Claude Code gets an alias (`a--b`), the shim
   sends the real id.
4. **Keys and routing.** The endpoint API key (Vast) never enters the Claude Code environment; the shim injects
   `Authorization`/`x-api-key`. The shim has no upstream other than the route's endpoint, and strips the
   `x-claude-code-*` hint headers. Interrupts close the upstream request.

The endpoint is probed once with `POST /v1/messages/count_tokens`; a 404/405/501 gives a clear error ("does not serve
the Anthropic Messages API … switch this session to the Obsidian engine").

## Executable strategy (dev and packaged)

SDK 0.3.x has no JavaScript CLI any more (no `cli.js`, so `executable: 'node'` + `ELECTRON_RUN_AS_NODE` does not
apply): it ships the native Claude Code binary per platform as an optional dependency
(`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, 260 MB, Claude Code 2.1.296). `resolveClaudeExecutable('auto')`
resolves it with `require.resolve`, maps `app.asar` → `app.asar.unpacked` (electron-builder `asarUnpack` now lists
`node_modules/@anthropic-ai/claude-agent-sdk-*/**`), and passes it as `pathToClaudeCodeExecutable`. Fallbacks: the
user's install (`~/.local/bin/claude.exe`, then PATH) or an explicit path (Settings → Engine). The ESM SDK is loaded
with a dynamic `import()` that electron-vite keeps in the CommonJS main bundle.

Verified: `tests/unit/engine/claude-code.live.test.ts` (tsx/vitest, 2 turns incl. Read, ~60 s) and
`tests/e2e/app-claude-code.spec.ts` (built Electron app: quick start with engine "Claude Code" → "hello", 2.5 min;
`OBSIDIAN_APP_EXE=release/win-unpacked/Obsidian Code.exe` runs the same against the packaged build).

## Prompt cost: 'lean' vs 'claude_code' (measured with /v1/messages/count_tokens)

| Part of the first request | Tokens |
|---|---|
| Claude Code's 22 tool definitions (with `canUseTool`: + AskUserQuestion 1,204, EnterPlanMode 1,180, ExitPlanMode 777) | 14,429 |
| the app's 4 obsidian MCP tools | 765 |
| Claude Code's context block (environment, skills list, attribution reminder) | ~2,000–2,100 |
| system prompt `lean` (the SDK's identity line + `leanSystemPrompt`) | 614 |
| system prompt `claude_code` preset (Claude Code uses its shorter "simple" prompt for unrecognised models) | 1,329 |
| **first turn, lean / full** | **~17.6k / ~18.3k** (≈4% apart) |

Largest tools: SendMessage 1,578, Workflow 1,510, ScheduleWakeup 1,411, AskUserQuestion 1,204, EnterPlanMode 1,180,
EnterWorktree 1,162, Bash 1,075, Grep 1,058, Agent 948. (Cron tools were 1,946 more before `CLAUDE_CODE_DISABLE_CRON`.)
Time to first token on the shared local GPU, cold cache: 31–56 s for ~15k prompt tokens; follow-up turns hit the
prompt cache (`cache_read_input_tokens` ≈ the whole prefix, 5–8 s). So 'lean' is not meaningfully faster; the choice
is behaviour: `claude_code` contains Anthropic's rules ("Refuse requests for destructive techniques, DoS attacks …"),
`lean` has no refusal/content-policy language (the user runs uncensored models by choice). Default: `lean`. Note the
SDK always prepends "You are a Claude agent, built on Anthropic's Claude Agent SDK." to a custom prompt.

## Message shapes (SDK → app)

* `system/init` (every turn in streaming mode): `session_id`, `tools`, `slash_commands`, `agents`, `skills`,
  `permissionMode`, `claude_code_version`. `system/status`: `requesting` / `compacting`, optional `permissionMode`.
* `stream_event` (with `includePartialMessages`): `message_start` (`message.id`, `usage.input_tokens` +
  `cache_read_input_tokens`), `content_block_start` (`thinking` / `text` / `tool_use{id,name}`),
  `content_block_delta` (`thinking_delta`, `text_delta`, `input_json_delta`, `signature_delta`), `content_block_stop`,
  `message_delta` (`usage.output_tokens`, `stop_reason`), `message_stop`. `parent_tool_use_id` = the Agent call for
  subagent traffic (with `forwardSubagentText: true`).
* `assistant`: one message **per finished content block**, same `message.id` as the stream; `thinking_duration_ms`.
  `uuid` is a transcript chain entry (resume/fork point).
* `user` tool results: `message.content[].tool_result` + structured `tool_use_result`: Read
  `{type:'text', file:{filePath, content, startLine, numLines, totalLines}}`; Write `{type:'create'|'update', filePath,
  content, originalFile, structuredPatch}`; Edit `{filePath, oldString, newString, originalFile, structuredPatch}`;
  Bash `{stdout, stderr, interrupted}`; TodoWrite `{oldTodos, newTodos}`; ExitPlanMode `{plan, filePath}`; Agent
  `{isAsync: true, status: 'async_launched', agentId, outputFile}`.
* `result`: `subtype` (`success` / `error_during_execution` / `error_max_turns` …), `is_error`, `result`, `usage`
  (whole turn incl. side requests), `errors`. API errors arrive as `subtype: 'success', is_error: true,
  result: 'API Error: 500 …'`. `total_cost_usd` is computed at Anthropic prices — meaningless here, ignored.
* Interrupt (`query.interrupt()`): a synthetic user message `[Request interrupted by user]`, then `result
  error_during_execution` with `errors: ['[ede_diagnostic] …']`.
* `/compact`: `status compacting` → `compact_boundary {trigger, pre_tokens, post_tokens}` → synthetic user summary
  (`isSynthetic`) → replayed `<local-command-stdout>Compacted</local-command-stdout>` (`isReplay`) → `result` with
  `local_command`. Other local commands (/context, /cost) answer through the replayed stdout too.
* **Subagents run in the background by default** in 2.1.296: the Agent tool returns at once (`async_launched`), the
  subagent streams afterwards (`system/task_started`, `task_progress`, `task_updated {patch.status}`,
  `task_notification {status, summary}`), and the main agent may keep working, use `SendMessage` to resume the agent
  (new `task_started` with the SendMessage tool id), or Claude Code may start a new main turn by itself when an agent
  finishes. The engine keeps such child sessions running until the notification and shows self-started turns.
* `conversation_reset {new_conversation_id}` after `/clear`.

## Permissions, questions, plans, hooks

* `canUseTool(name, input, {toolUseID, suggestions, title, decisionReason, signal, agentID})` is only called when
  Claude Code would ask (Read in the working directory, TodoWrite, the plan file etc. are auto-accepted by mode). The
  engine applies the app's rules first (`decidePermission`: allow/deny rules, project "always allow" rules); "allow
  always" stores the app rule and returns Claude Code's `suggestions` re-targeted to `destination: 'session'` (nothing
  is written into the repo's `.claude/settings.local.json`). Deny with feedback → `{behavior:'deny', message}`; deny
  without → `interrupt: true` (wait for the user), like the builtin engine. Headless (scheduled) runs auto-deny.
* AskUserQuestion: `{behavior:'allow', updatedInput: {...input, answers: {[question]: label}}}` (the tools only appear
  when `canUseTool` is set). ExitPlanMode: approve → `updatedPermissions: [{type:'setMode', mode, destination:'session'}]`
  and the session's mode is updated; mode changes made in the UI go to `query.setPermissionMode()`.
* `PreToolUse` hook (`{tool_name, tool_input, tool_use_id}`): app deny rules → `permissionDecision: 'deny'`; reads of
  credential files / the app data folder / UNC paths → `'ask'` (Claude Code would auto-allow them); edits are snapshot
  into the app's CheckpointStore first (Changes panel, diffs, rewind). Plan files Claude Code writes into its config
  dir are not recorded.
* Trust: project settings (`.claude/settings*.json` — hooks, allow rules, apiKeyHelper, env), project skills/agents/
  commands and CLAUDE.md load only for folders in Settings → Permissions → Trusted folders (`settingSources: ['user',
  'project', 'local']`); otherwise `['user']` plus the app's memory text appended to the prompt. The app's own hooks
  (Settings → Hooks) do not run for claude-code sessions (Claude Code runs the `.claude` ones itself; running both would
  execute them twice).

## Sessions, rewind, engine switch

* Resume across app restarts: `resume: <claude session id>` with the same `CLAUDE_CONFIG_DIR` (verified: the resumed
  process answered "You asked me to reply with exactly 'hello'"). A changed endpoint/model/thinking/prompt setting
  restarts the process and resumes the same Claude session. Idle processes close after 10 minutes.
* Rewind: the app restores files from its checkpoints and truncates the transcript; the Claude session continues with
  `resume + resumeSessionAt: <chain uuid before the rewound message> + forkSession: true` (the SDK's truncating resume,
  print/SDK lane). Rewinding the first message starts a fresh Claude session.
* Engine switch (`chat.setEngine`, idle only) and forks: the next claude-code turn starts a fresh Claude session seeded
  with a compact transcript (`renderTranscript`) in a `<system-reminder>`; switching back to builtin needs nothing (it
  rebuilds history from the app transcript).

## Not done / follow-ups

* No prefill progress bar for claude-code turns (llama.cpp's `/v1/messages` stream has no progress events).
* Claude Code's own file checkpointing (`enableFileCheckpointing`/`rewindFiles`) is unused; the app's checkpoints cover
  Edit/Write/MultiEdit/NotebookEdit but not files changed by Bash commands.
* `~/.claude/settings.json` (hooks, permissions, env) and plugins are deliberately not imported.
