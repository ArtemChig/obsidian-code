# Real-model E2E results: local llama-server

Measured on 2026-10-12 against the user's local `llama-server` (b11517, `--jinja`, 4 slots shared with Hearth,
unified KV, 8 GiB `--cache-ram`), model `qwen3.6-35b-a3b-uncensored` (Qwen3.6-35B-A3B Q4_K_M, a hybrid recurrent/attention MoE).

## How to run

```bash
npx tsx scripts/e2e-real.ts                 # all 15 scenarios, thinking off
npx tsx scripts/e2e-real.ts --thinking      # the app's default (thinkingByDefault: true)
npx tsx scripts/e2e-real.ts 3 11 plan       # by number or by name fragment
npx tsx scripts/e2e-real.ts --user-config   # include the user's ~/.claude memory + skills (real-life prompt size)
npx tsx scripts/e2e-real.ts --mock          # harness self-check against tests/fixtures/mock-llm (scenarios 1, 3, 5)
npx tsx scripts/measure-prompt.ts           # first-turn prompt size per tool, via /apply-template + /tokenize
```

The script starts `createCore` in-process with a temp data dir (local provider on, `defaultPermissionMode: 'default'`,
`importClaudeConfig: false` unless `--user-config`) and a fresh sample project per scenario (`package.json`, `src/math.js`,
`src/util/format.js`, `README.md`, `test.js`). It connects over WebSocket the same way the renderer does and answers prompts
the way a user clicking through the UI would: permissions get **allow**, questions get the **first option**, plans are
**approved with acceptEdits**. Scenarios run one after another. All model traffic goes through a small recording proxy
inside the script, which keeps llama-server's `timings` (`prompt_n`, `cache_n`, `predicted_n`), the first-token time, the
finish reason, client aborts and any `<tool_call>` text that leaks into `content`. It also tracks how many requests are in
flight at once: the maximum was **1** in every run. Exit codes: 0 = all pass/skip, 1 = a failure, 3 = server down (the script
then falls back to the mock self-check).

## Final results: 15/15 pass in both modes

Thinking **on** (the app default): `final-think` run.

| # | scenario | result | requests | tools used (all sessions incl. subagents) | prompt / cached / completion tok | 1st token s | wall s |
|---|---|---|---|---|---|---|---|
| 1 | simple reply (+ title generation) | PASS | 2 | – | 4520 / 2479 / 25 | 19.1* | 24.0 |
| 2 | Read + summarise README | PASS | 2 | Read | 9103 / 7002 / 125 | 4.8 | 13.2 |
| 3 | Edit `src/math.js` (add `subtract`, verified with `node -e require`) | PASS | 3 | Read, Edit | 14046 / 11811 / 270 | 4.0 | 24.6 |
| 4 | Write `notes/todo.md` checklist | PASS | 2 | Write | 9093 / 7067 / 145 | 4.2 | 11.9 |
| 5 | Bash `node -v` → reports v26.3.0 | PASS | 2 | Bash | 9030 / 7014 / 96 | 3.9 | 8.7 |
| 6 | find `formatResult` (path + line 3) | PASS | 2 | Grep | 9072 / 7028 / 124 | 3.8 | 11.1 |
| 7 | 3-step task tracked with TodoWrite (all completed) | PASS | 5 | TodoWrite, Write, Write, TodoWrite, LS, TodoWrite | 24643 / 22382 / 750 | 4.5 | 45.0 |
| 8 | AskUserQuestion → answer written to `color.txt` | PASS | 3 | AskUserQuestion, Write | 13863 / 11792 / 229 | 3.8 | 18.5 |
| 9 | Task → Explore subagent locates `multiply` | PASS | 5 | Task, (sub: Grep×4, Read) | 16311 / 12007 / 582 | 4.7 | 49.2 |
| 10 | WebSearch + WebFetch (Python first release → 1991) | PASS | 4 | WebSearch, WebFetch | 32379 / 29378 / 210 | 4.4 | 22.2 |
| 11 | plan mode → ExitPlanMode → approve → `cube` added, no edit before approval | PASS | 4 | Read, ExitPlanMode, Edit | 19241 / 16907 / 403 | 9.9* | 34.5 |
| 12 | "remind me every weekday at 9:00…" → `0 9 * * 1-5`, listed, deleted | PASS | 2 | ScheduleTask | 9175 / 7095 / 209 | 3.9 | 26.1 |
| 13 | 3-turn cache check | PASS | 3 | – | 13589 / 11548 / 105 | 4.0 | 18.4 |
| 14 | `/cost` + `/compact`, facts survive compaction | PASS | 5 | – | 18403 / 16133 / 236 | 5.0 | 22.8 |
| 15 | `chat.interrupt` mid-stream, then resume | PASS | 2 | – | 4494 / 4447 / 25 | 4.6 | 7.3 |

Thinking **off**: `final-nothink` run.

| # | scenario | result | requests | tools | prompt / cached / completion tok | 1st token s | wall s |
|---|---|---|---|---|---|---|---|
| 1 | simple reply | PASS | 2 | – | 4522 / 2479 / 8 | 3.9 | 7.1 |
| 2 | read + summarise | PASS | 2 | Read | 9085 / 6980 / 70 | 4.5 | 9.4 |
| 3 | edit | PASS | 3 | Read, Edit | 13957 / 11716 / 175 | 4.9 | 16.4 |
| 4 | write | PASS | 2 | Write | 9071 / 7041 / 109 | 4.5 | 9.8 |
| 5 | bash | PASS | 2 | Bash | 9015 / 6995 / 59 | 4.0 | 7.0 |
| 6 | glob/grep | PASS | 2 | Grep | 9040 / 7013 / 82 | 3.8 | 9.0 |
| 7 | todowrite | PASS | 5 | TodoWrite, Write, Write, TodoWrite, LS, TodoWrite | 24255 / 21984 / 546 | 4.8 | 33.8 |
| 8 | ask-user-question | PASS | 3 | AskUserQuestion, Write | 13810 / 11733 / 171 | 4.9 | 13.5 |
| 9 | task-subagent | PASS | 5 | Task, (sub: Grep, Grep, Read) | 16028 / 11613 / 424 | 4.5 | 33.5 |
| 10 | web-search-fetch | PASS | 4 | WebSearch, WebFetch | 32527 / 27366 / 147 | 4.7 | 21.2 |
| 11 | plan-mode | PASS | 4 | Read, ExitPlanMode, Edit | 19111 / 16769 / 305 | 5.6 | 23.6 |
| 12 | schedule-task | PASS | 2 | ScheduleTask | 9123 / 7039 / 126 | 4.1 | 11.0 |
| 13 | multi-turn-cache | PASS | 3 | – | 13501 / 11455 / 8 | 3.8 | 5.7 |
| 14 | cost-compact | PASS | 5 | – | 18284 / 16060 / 94 | 4.1 | 15.4 |
| 15 | interrupt | PASS | 2 | – | 4527 / 4475 / 2 | 4.9 | 7.1 |

\* The 19 s and 9.9 s outliers have the same prompt and cache as their neighbours (`prompt_n` ≈ 2000). They happen when the
server first has to page the other app's idle slot (100k+ tokens) out to the RAM cache (`--cache-idle-slots`), or when Hearth
is generating at the same time. We can't control either.

Before the fixes below, the first runs failed scenario 9 (thinking off) and scenario 15 (thinking on). Scenario 15 also only
"passed" with thinking off because the model had written the story into a file.

## Prompt size (first turn)

| | tokens |
|---|---|
| Tool schemas (22 built-ins, as rendered by the Qwen `--jinja` template) | 3,722 |
| System prompt (incl. template framing) | 708 |
| **Total first-turn prompt** (`scripts/measure-prompt.ts`, empty memory/skills) | **4,430** |
| Real sessions in the e2e runs (`prompt_n + cache_n` of request 1) | 4,467–4,530 |
| With the user's real `~/.claude` memory + skills (`--user-config`) | 4,527 |

That is well under the 6k target, so no schema was cut. The largest tools are Grep (285), ScheduleTask (247),
AskUserQuestion (203) and Bash (167). Each is already terse and its parameters are needed. All additions in this pass
together add about 90 tokens.

**Template check.** `/apply-template` shows the server's Qwen3.6 template rendering each tool as one JSON line inside
`<tools>…</tools>`, with name, description and full `parameters` including `required`, followed by the XML
`<tool_call><function=…><parameter=…>` calling convention, and then our system prompt. Across all runs the proxy saw
**50 native `tool_calls`** (26 with thinking on, 24 off) and **0** `<tool_call>`/`<function=` fragments leaking into `content`.
The server's parser handled every call, so the client's text fallback parser was never needed. Every call used the correct
tool name and supplied all required parameters (no "missing parameter" tool errors in any run).

## Latency (this PC, server shared with Hearth)

* **Cold first turn** (no reusable cache): 4,366 tokens in 22.6 s of prefill, so the first token arrived after **22.8 s**.
  This only happens once after a server restart or a cache eviction.
* **New session** (typical): about 2,480 tokens come from a cached checkpoint and about 2,000 are prefilled, so the first token
  arrives after **3.8–5 s** (outliers above).
* **Follow-up turns / tool steps within a session**: only the new tokens are prefilled (23–140 tokens), so the first token
  arrives after **0.45–2.9 s**.
* Subagent first request: the tool list differs from the parent's, so about 2,000 tokens are prefilled (6.5–8.6 s).
* Decode about 20 tok/s. Thinking on adds about 20–150 reasoning tokens per step on these tasks (1–7 s). Qwen3.6 thinks
  briefly here.
* WebFetch with a `prompt` runs an extraction call over up to 48k chars of page Markdown (≈16.8k tokens for a Wikipedia page).
  That took **31.8 s** cold and 1.5 s when the page was already cached.

## Prompt-cache reuse (scenario 13; `timings` from llama-server)

```
thinking off   turn 1: prompt_n=1991 cache_n=2480 → first token 3.8 s
               turn 2: prompt_n=29   cache_n=4472 → 0.51 s
               turn 3: prompt_n=26   cache_n=4503 → 0.60 s
thinking on    turn 1: prompt_n=1990 cache_n=2479 → 4.0 s
               turn 2: prompt_n=27   cache_n=4501 → 2.9 s (prompt_ms 1479: RAM-cache restore)
               turn 3: prompt_n=24   cache_n=4568 → 3.7 s
```

The harness checks that every request in a session has the **same SHA of system prompt + tool list** (1 distinct value). It
also checks that each request's `messages` array starts with the previous request's array, byte for byte, with
`reasoning_content` kept, so the history is never rewritten. And it checks that `cache_n` covers at least 90% of the previous
prompt. All three hold in both modes and across tool steps: for example scenario 7 goes c4666 → c4864 → c5070 → c5303 while
only 41–119 new tokens are prefilled per step. Resuming after an interrupt reuses the partial reply as well (`p47 c4447`).

Why a new session reuses only about 2,480 tokens: the model is hybrid (recurrent layers), so llama.cpp can only resume from
the exact end of a slot or from a **context checkpoint**. We observed checkpoints at the end of each prompt and at
`prompt_len − n_batch(2048)` (≈4,470 − 2,048 ≈ 2,420–2,480). The first divergence between two sessions is the
`Working directory` line about 60 tokens into our system prompt, which comes after the 3.7k-token tool block, so reuse is
capped by that checkpoint. Moving the dynamic lines to the end of the system prompt would not help for the same reason. Only a
smaller server `-b` or denser checkpoints would.

## Model quirks found and the mitigations (all general, none scenario-specific)

1. **Ignored an explicit tool request** (scenario 9, thinking off). "Use the Task tool with an Explore subagent to find…"
   was answered with a direct Grep, because the Task description said "Not for simple lookups" and the model weighted that
   above the user's words.
   *Fix:* the Task description now reads "For a single simple lookup, Grep/Read directly is faster — unless the user asks for a
   subagent", and the system prompt adds "When the user names a tool, subagent or command to use, use it."
   (`src/core/tools/task.ts`, `src/core/agent/prompt.ts`)
2. **Wrote prose into files** (scenario 15, thinking off). "Write a 600-word story… Do not use any tools" produced a
   913-token `Write` call (the model reads "write" as the Write tool, nudged by "act with tools").
   *Fix:* Style rule "Answer questions and write prose (explanations, stories, messages) directly in chat. Create files only
   when the user asks for one or the task needs it." The story now streams as chat text.
3. **Redid the old request after an interrupt** (scenario 15, thinking on). The interrupt landed while only thinking had
   streamed. The history builder drops a thinking-only message, so the next user turn ("Stop the story. Reply with just
   DONE.") was merged into the original request and the model wrote the whole story (856 tokens).
   *Fix:* `buildHistory` now adds `[Request interrupted by user]` (Claude Code's wording) on the user side after every
   assistant message with `meta.interrupted`. The note is derived from stored messages, so it stays byte-stable and
   cache-friendly. Unit test: `tests/unit/agent/units.test.ts` › "marks interrupted replies…". (`src/core/agent/history.ts`)
4. **Unattended reminder prompts.** The model wrote scheduled prompts like "Remind the user… Ask if they want to proceed",
   which a headless run cannot do.
   *Fix:* the ScheduleTask description now says the run's final reply is shown to the user as a notification, and that a plain
   reminder can simply ask to reply with the reminder text. Observed prompt after the fix: "Remind the user: it's 9:00 AM on a
   weekday — time to check the build!" (`src/core/tools/schedule-task.ts`)
5. **Parallel tool calls are reliable.** The model often batches (e.g. `Write`, `Write`, `TodoWrite` in one message, or 2
   Greps in a subagent) and the loop handles them. With thinking on, it sometimes creates the todo list in the same message as
   the first actions rather than strictly before them. That is harmless.
6. **Plan mode works without schema filtering.** The tool list stays identical (cache), and the model researched read-only,
   called ExitPlanMode with a Markdown plan and edited only after approval in every run.

Not changed (documented trade-offs):
* WebFetch extraction input (48k chars) costs about 30 s of prefill on this PC for big pages but keeps the page out of the main
  context. It is fast on a Vast GPU.
* Subagent requests can't share the parent's cache (different tool list and system prompt). Giving them the full tool list
  would not help either, because the reusable checkpoint (~2.4k) sits before the divergence point either way.

## Files

* `scripts/e2e-real.ts`: the harness (recording proxy, WS client, auto-responders, 15 scenarios, `--mock` fallback).
* `scripts/measure-prompt.ts`: prompt-size breakdown via `/apply-template` + `/tokenize`.
* Raw JSON for the final runs (per-request `timings`, details) is written to `<tmp>/oc-e2e-real-*/results.json` or `--out`.

## Claude Code engine (`--engine claude-code`)

Measured on 2026-10-13 against the same server and model, with `@anthropic-ai/claude-agent-sdk` 0.3.296 (Claude Code
2.1.296), lean prompt, thinking off, `~/.claude` import off.

```bash
npx tsx scripts/e2e-real.ts --engine claude-code 1 2 3 5 7 8 9 11 12 14   # scenarios, one at a time
npx tsx scripts/e2e-real.ts --engine claude-code --sysprompt full 1        # Claude Code's own prompt instead of lean
npx tsx scripts/e2e-real.ts --engine claude-code --dump --out r.json 7     # also writes r.json.requests.json (bodies + text)
powershell -NoProfile -File scripts/net-audit.ps1 -Out audit.jsonl         # run next to it: outbound TCP of the process tree
```

The recording proxy now also reads `/v1/messages` (Anthropic SSE: usage, stop reason, first token); the timings
below come from there. The proxy sits in front of the server, upstream of the relay, so it sees the stream as llama.cpp
produced it. Maximum concurrent model requests: **1** in every run.

### Results (final sweep, all scenarios in one run)

| # | scenario | result | requests | tools | prompt / completion tokens | wall s |
|---|---|---|---|---|---|---|
| 1 | simple reply + title | pass | 2 | – | 17,702 / 8 | 105 (cold: 17,649 tokens, first token 79.7 s) |
| 2 | read + summarise | pass | 2 | Read | 35,497 / 93 | 14 |
| 3 | edit a file | pass | 3 | Read, Edit | 53,621 / 240 | 116 |
| 5 | `node -v` in the shell | pass | 2 | Bash | 35,410 / 59 | 20 |
| 7 | todo list | pass | 6 | TodoWrite ×3, Write ×2, Bash | 109,653 / 611 | 60 |
| 8 | ask a question | pass | 3 | AskUserQuestion, Write | 53,492 / 168 | 20 |
| 9 | subagent (Explore) | pass | 5 | Agent (child: Grep, Glob, Read) | 68,766 / 481 | 45 |
| 11 | plan mode | pass | 7 | Glob, Read, Write (plan file), ExitPlanMode, Edit, Bash | 137,653 / 803 | 76 |
| 12 | schedule via the app's MCP tool | **fail** | 3 | schedule_task ×2 | 53,648 / 262 | 26 |
| 14 | `/cost`, `/compact`, facts survive | pass | 5 | – | 89,544 / 525 | 71 |

Scenario 12 failed because the model called `schedule_task` a second time right after a successful result (two
identical schedules). Of 8 repeats, 7 passed (the other miss: the model chose `59 8 * * 1-5`). Scenario 7 (todo list) is
model-dependent: in about half of all runs the model does the work without calling TodoWrite although it was asked to;
it passed in 4 of the 5 runs made with the final code (3 of 6 with an experimental stronger prompt line, which was not kept).
After their fixes, scenario 9 passed 5 of 5 runs and scenario 11 passed 5 of 5; 1, 2, 3, 5, 8 and 14 passed in the final sweep.
Prompt tokens add up over requests; most of each request is the cached prefix.

### Prompt size and latency

* First turn **17.6–17.7k tokens**: tool definitions ≈15k (Claude Code's 22 + 4 `obsidian` MCP tools), context block ≈2k,
  system prompt 614 (lean) / 1,329 (full) → first turn ≈ 17.6k / ≈ 18.3k.
* The full Claude Code prompt (`--sysprompt full`, scenarios 1, 2, 5: all pass) is 18.4k tokens on the first turn and
  starts uncached for every new folder (first token 41 s each time); lean keeps the tool block cached across sessions.
* Cold first token (nothing cached): 30–80 s on the shared local GPU. With the previous session's prefix still in the
  server's cache (15.6k tokens): **4–10 s**. Follow-up requests of a turn: 2–6 s (only the new tokens are processed).
* A subagent starts with its own prompt (different tools and system prompt): 1.7–10.8k uncached tokens, 7–50 s to its first token.
* A WebFetch summary was one 30k-token request (140 s cold).

### Zero Anthropic traffic (`scripts/net-audit.ps1`)

The script reads `netstat -ano -p tcp` every 0.3 s and keeps every connection owned by the core process or any of its
descendants (claude.exe, the shells it starts, git, ...), one row per (process, remote address, port).

| Run | Duration | Samples | Processes in the tree | Remote endpoints |
|---|---|---|---|---|
| scenarios 9 (subagent) + 14 (`/cost`, `/compact`) | 159 s | 223 | 14 | **none** |
| the whole final sweep above | 566 s | 777 | 80 | **none** |
| scenario 10 (WebSearch + WebFetch, as a positive control) | 214 s | – | – | 2, both deliberate |

Only loopback appears: `claude.exe` has exactly one peer, the relay's port on 127.0.0.1; the core talks to the relay,
the recording proxy and `llama-server` on :8080. In the web scenario the two remote endpoints were
`node.exe → 52.149.246.39:443` (duckduckgo.com, the app's own `web_search` tool) and `claude.exe → 208.80.154.224:443`
(en.wikipedia.org, the page WebFetch was asked to read); `api.anthropic.com` and `claude.ai` (160.79.104.10) never
appeared. The WebFetch page summary was generated by the local model. All 38 model requests of the final sweep went to
the local model (`qwen3.6-35b-a3b-uncensored`; 37 via `/v1/messages`, the title via `/v1/chat/completions`). Limits:
TCP only, and a connection that opens and closes between two samples is missed; the earlier spike used a logging
`HTTPS_PROXY` for that (`docs/research/claude-agent-sdk.md`).

### Bugs the real model exposed (fixed, each with a regression test in `tests/unit/engine`)

1. Claude Code 2.1.296 runs subagents in the background by default: two model requests at once on one GPU and a model that
   polled with `SendMessage` (221 s). The `PreToolUse` hook now defaults `run_in_background` to false (45–120 s).
2. In plan mode the engine asked the user instead of denying a change, so one click let the model edit files before
   `ExitPlanMode`; plan-mode denials are enforced now (only Claude Code's own plan file is writable).
3. The plan file (`<config dir>/plans/*.md`) was listed in the Changes panel.
4. `/compact` re-emitted the earlier `/cost` output as a second message.
5. `/cost` showed a dollar price for a local model; it now says "local model, not billed".
6. A tool call the model wrote as text (`<TodoWrite><parameter=todos>…`) ended the turn; the relay now repairs it
   (`engine/recover.ts`; the fallback parser also accepts the tool-name tag).
7. Harness/test: `rmSync` of the sample project could fail while Windows still held the folder; the parked-GPU expiry test
   asserted before the ledger was updated (race under load).
