# Obsidian UI guide — M13 "Obsidian" (for ui-chat and ui-views)

Owner: ui-foundation. This covers what already exists and how to use it, so your feature folders stay small and consistent.
Source of truth for the look: `docs/design/m-13-obsidian/` (`obsidian.css` recipes, `shots/*.png`, `screens.html`) and SPEC §5.
Dark-only. Lucide icons only (13–16 px, stroke 1.5 is set globally, colour `--t2`/`--t3`). No emoji.

## 0. The rules (read these first)

**Thesis: remove every surface.** Pure `#000` with the chrome removed. Content floats, held in place by space and one hairline.

1. **No fills, no cards, no frames.** Panels, sidebars, transcripts, settings groups and lists sit directly on the `#000`
   ground. Do not wrap content in bordered/filled boxes. Separate regions with a 1 px `--rule` hairline (`border-rule`) and
   rows with the sub-hairline `--rule2` (`border-rule2`). The only tonal fills allowed: input/code wells (`bg-s1`), a
   user-message or thumbnail sliver (`bg-s2`), the active control step (`bg-s3`), tracks (`bg-s4`).
2. **Borders only on actionable things** — buttons, inputs, selects, segmented controls, kbd, tags — in `--line`
   (`border-line`, 3.5:1). Never put a `--line` border around a static block.
3. **One accent:** cold white `--acc` (`#E6EEFF`): primary button fill, selection edge, active tab underline, focus, the
   key word of a label. It is not a colour; don't tint things "blue".
4. **Colour only means status.** `--live` violet = running/streaming/in flight · `--warn` = waiting for the user ·
   `--err` = error/failed/denied/deletions · `--ok` = done/ready/additions · `--rec` = money is being spent (GPU billing).
   Thinking blocks and subagents are NOT coloured (`--t3`/`--t2` text with a hairline left rule; a live one gets a `--live` dot).
5. **Radius 2 px everywhere** (tags 1 px; only dots, switch pills and avatars are round). Tailwind's `rounded-sm…4xl` are
   all flattened to 2 px in `tokens.css`, so they cannot exceed it — but don't write `rounded-[10px]` either.
6. **No shadows on surfaces, no gradients, no blur, no glow.** The only shadow is the menu/dialog separation shadow
   (`shadow-deep` / `ob-popover`). Status dots may use a flat 3 px halo (`StatusDot glow`).
7. **Type:** Chivo (UI) + Chivo Mono (numbers, ids, paths, code, labels, status bar, kbd, tags). Base 12.5 px / 1.5,
   −.004em, tabular numbers. Labels are mono 9 px uppercase `.22em` `--t3` (`ob-cap`). Titles are Chivo 600 with tight
   negative tracking. Text contrast ≥ 4.5:1 — `--t3` is the floor; never dim text below it with opacity.
8. **Geometry:** 28 px rows (lists, table rows, menu items); controls 24/28/32 px; 4 px spacing grid
   (`--spacing: 4px`, so `h-7` = 28 px, `px-4` = 16 px); generous outer gutters (24–32 px) so content floats.
9. **Selected nav item** (sidebar, settings nav) = `ob-nav-on` (`--t1` + a 2 px cold-white bar inset 5 px, no fill).
   **Selected row** in a list/table = `ob-selected` (acc-wash + 2 px cold-white left edge + `--t1`). Hover = `hover:bg-hov`.
10. **Motion** 120–160 ms, opacity/transform only; `prefers-reduced-motion` is honoured globally.
11. **Focus** comes from the global `:focus-visible` (1 px `--acc` outline, 1 px offset). Don't remove outlines.

## 1. File ownership

| Path | Owner |
|---|---|
| `design/`, `components/ui/`, `lib/`, `state/`, `app/`, `main.tsx`, `index.html`, this guide | ui-foundation |
| `features/chat/**` | ui-chat |
| `features/{gpu,activity,schedules,settings}/**` | ui-views |

The shell imports exactly these, so keep the names and props:

```ts
// features/chat/ChatView.tsx
export function ChatView(props: { sessionId: string }): JSX.Element  // fills the main area: use "flex h-full flex-col"
// features/chat/panels.tsx (right panel tabs; the container and tabs bar are already provided)
export function ChangesPanel(p: { sessionId: string }); TodosPanel; AgentsPanel; FilesPanel
// features/gpu/GpuView.tsx, features/activity/ActivityView.tsx, features/schedules/SchedulesView.tsx, features/settings/SettingsView.tsx
export function GpuView(); ActivityView(); SchedulesView(); SettingsView()
```

Shell layout (top → bottom): **title bar** 34 px (brand diamond + `OBSIDIAN CODE`, centred document title) · **menu strip**
27 px (File / View / Session / GPU / Help + mono hints; a solid `UPDATE x.y.z` button there when a release is out) ·
`[sidebar 240 | main | right panel]` · **status bar** 25 px (connection, model + provider, context %, permission mode,
running count, GPU phase + $/h + session cost, month spend, app version).
Views get the full main area. Make the view root `h-full` and scroll inside it (`overflow-y-auto`). Each view is wrapped in an
error boundary. Settings can read `useUi.getState().settingsSection` (set by `openSettings('vast')`) to focus a section.
A view header follows the reference: `h-14 border-b border-rule px-6` with a `text-title font-semibold` heading
(17 px / −.035em); panel/tab headers are 30 px (`TabsList`). The chat header and the right panel's tab bar share
`h-[var(--ob-pane-head-h)]` (44 px) so their hairlines line up — keep using the variable.

## 2. Tokens and Tailwind classes

All tokens are CSS variables in `design/tokens.css`, mapped into Tailwind v4 (`bg-*`, `text-*`, `border-*`, …):

| Token | Value | Class examples | Use |
|---|---|---|---|
| `--s0` | `#000000` | `bg-s0` | the ground — app, sidebar, panels, dialogs |
| `--s1` | `#07070A` | `bg-s1` | wells: inputs, search, code, terminal |
| `--s2` | `#0E0E12` | `bg-s2` | raised sliver: user message, thumbnail, inline code |
| `--s3` | `#17171C` | `bg-s3` | control step: highlighted menu row, open menu-strip item, kbd |
| `--s4` / `--s5` | `#23232A` / `#2E2E36` | `bg-s4` | tracks, meters, scrollbar thumb |
| `--t1` / `--t2` / `--t3` | `#FFF` / `#ADADB6` / `#7A7A85` | `text-t1` `text-t2` `text-t3` | ink 21:1 · secondary 9.4:1 · tertiary 4.95:1 |
| `--acc` / `--acc-ink` | `#E6EEFF` / `#000` | `bg-acc text-acc-ink`, `text-acc` | the single accent |
| `--acc-wash` / `--acc-wash2` | 7 % / 13 % | `bg-acc-wash` | selected / pressed washes |
| `--line` | `#63636E` | `border-line` | functional outline, actionables only |
| `--rule` / `--rule2` | 10 % / 5.5 % white | `border-rule`, `border-rule2`, `bg-rule` | hairline / sub-hairline |
| `--hov` / `--press` | 3.5 % / 6 % white | `hover:bg-hov`, `active:bg-press` | row hover / press |
| status | `--rec` `--live` `--err` `--warn` `--ok` | `text-live`, `bg-ok`, `border-err` | status only |
| status washes | `--{status}-wash`, `--{status}-edge` | `bg-err-wash`, `shadow-[inset_0_0_0_1px_var(--warn-edge)]` | faint status tints / tag edges |
| radius | `--r` = 2 px | `rounded-[2px]` (or any `rounded-*`) | everything |
| shadow | `--shadow-deep` | `shadow-deep` | menus, dialogs, popovers, toasts only |

Type scale (`text-*`): `cap` 9 · `micro` 8.5 · `meta` 10.5 · `small` 11.5 (controls) · `ui` 12.5 (base) · `prose` 13.5/1.62 ·
`lead` 15 · `title` 17 (−.035em) · `display` 23 (−.042em). Fonts: `font-sans`/`font-ui` (Chivo 400/500/600/700),
`font-mono` (Chivo Mono 400/500/600). Tracking: `tracking-cap` .22em · `tracking-label` .15em · `tracking-tag` .16em ·
`tracking-brand` .24em · `tracking-tight` −.03em. Arbitrary px sizes (`text-[11.5px]`) are fine and common in the recipes.

### Utility classes (M13 recipes)

| Class | Recipe |
|---|---|
| `ob-cap` (= `ob-section-label`) | section / meta label: mono 9 px 500 `.22em` uppercase `--t3` (reference `.cap`) |
| `ob-label` | column header: mono 8.5 px `.15em` uppercase `--t3` (reference `.srchd`, `thead th`) |
| `ob-unit` | unit after a number ("MBPS", "GB"): mono 8.5 px `.14em` uppercase `--t3` |
| `ob-mn` | mono meta line 9.5 px `--t3` (put values in `text-t2`) |
| `ob-num` | mono number, −.03em, tabular |
| `ob-nav-on` | selected nav item (reference `.fitem.on`): `--t1` + 2 px `--acc` bar inset 5 px top/bottom, no fill |
| `ob-selected` | selected row: acc-wash + 2 px `--acc` left edge (inset shadow) + `--t1` |
| `ob-row` / `ob-row-hover` | 28 px flex row / `--hov` on hover |
| `ob-tag` | tag/chip: 1 px `--line`, mono 8.5 px uppercase `.16em`, 1 px radius |
| `ob-kbd` | key cap: mono 9.5 px, `--s3`, 1 px `--line` |
| `ob-well` | input well: `--s1` + inset 1 px `--line` + 2 px radius |
| `ob-popover` | floating surface: `--s0` + 1 px `--line` + `--shadow-deep` |
| `ob-skeleton` | flat `--s3` block that breathes (no gradient) |
| `ob-transition` · `ob-tabular` · `ob-hairline` · `ob-selectable` | 120 ms ease-out · tabular numbers · `--rule` border colour · opt into text selection (off by default) |
| `ob-prose` (+ `ob-prose-compact`) | chat markdown: Chivo 13.5/1.62 `--t1`; headings 600 tight; inline code mono on `--s2`; blockquote = hairline left rule; tables with mono uppercase heads and `--rule2` rows; links `--t1` underlined in `--line`. Prefer `<Markdown>`. |
| `ob-codeblock` / `ob-code` | `--s1` well, `--rule` hairline, mono 12 px, monochrome shiki theme (`design/shiki-theme.ts`) |

Common recipes (copy these):

```tsx
// A list row (28 px, sub-hairline, hover, selected)
<div className={cn('flex h-7 items-center gap-[9px] border-b border-rule2 px-4 text-[12px] tracking-[-0.012em]',
  on ? 'ob-selected' : 'text-t2 hover:bg-hov hover:text-t1')}>…</div>
// A key/value line (reference .kv)
<div className="flex items-baseline justify-between py-[5px]"><span className="text-[11.5px] text-t3">Free</span>
  <b className="font-mono text-[11.5px] font-normal tracking-[-0.03em] text-t1">412 GB</b></div>
// A settings row (reference .srow) — or <Field inline>
<div className="grid grid-cols-[1fr_288px] items-center gap-6 border-b border-rule2 py-[9px]">…</div>
// A section: label + hairline, then content on the ground
<SectionLabel rule action={<span className="font-mono text-t3">214</span>}>Markers</SectionLabel>
// A warning/conflict block (reference .kwarn): the one place a status-coloured frame is right
<div className="flex items-center gap-[9px] rounded-[2px] px-3 py-[9px] shadow-[inset_0_0_0_1px_var(--err)]">…</div>
```

### Removed aliases

The pre-M13 colour names (`ob-bg`, `ob-surface-*`, `ob-border*`, `ob-text*`, `ob-accent*`, `ob-violet`, `ob-success`,
`ob-warning`, `ob-danger`, `ob-code-bg`, `ob-diff-*`, `ob-hover`, `ob-press`) and `rounded-ctl` / `rounded-card` /
`shadow-pop` are gone: nothing used them after the re-skin. If you meet one in old code, map it: `ob-bg`/`ob-surface-1`→`s0`,
`ob-surface-2`→`s1`, `ob-surface-3`→`s3`, `ob-border`→`rule`, `ob-border-strong`→`line`, `ob-text/-2/-3`→`t1/t2/t3`,
`ob-accent`→`acc`, `ob-accent-soft`→`acc-wash`, `ob-violet`→`live`, `ob-success`→`ok`, `ob-warning`→`warn`,
`ob-danger`→`err` (each `-soft` → the `*-wash`), `ob-code-bg`→`s1`, `ob-hover`→`hov`, `ob-press`→`press`. The `--ob-*`
variables that remain are layout metrics (`--ob-titlebar-h`, `--ob-pane-head-h`, `--ob-sidebar-w` …).

`cn()` from `@renderer/lib/cn` = clsx plus Tailwind conflict resolution (the later class wins, per variant). It knows the
custom text sizes (`text-cap`, `text-ui`, …), so `cn('text-ui text-t2', 'text-t1')` keeps the size.

## 3. Components (`import { … } from '@renderer/components/ui'`)

Live gallery: `http://localhost:5173/?demo=1&gallery=1`.

| Component | Key props / M13 look |
|---|---|
| `Button` | `variant` primary (solid `--acc`, black text) / secondary (1 px `--line`) / ghost (text only) / danger (`--err` outline + text) / danger-solid · `size` sm 24 / md 28 / lg 32 · `loading` · `icon` / `iconRight` · `fullWidth` |
| `IconButton` | **`label` (required: aria-label and tooltip)** · `icon` · `size` xs/sm/md/lg (20/24/28/32) · `variant` ghost/secondary/danger/primary · `active` (lit: acc-wash + hairline) · `shortcut` · `tooltipSide` · `loading` |
| `Input` | `--s1` well + 1 px `--line`, focus → `--acc` · `size` sm/md/lg (24/28/32) · `icon` · `trailing` · `invalid` · `mono` (technical values) |
| `Textarea` | auto-grow: `minRows` / `maxRows` · `bare` (borderless, for composers) · `mono` · `invalid` · `ref` |
| `Field` | `label` · `description` · `error` · `inline` (the reference settings row: label 12.5/500 + 11 px `--t3` help, control right) |
| `Select` | trigger is an input well · `value` · `onValueChange` · `options` or `groups` · option `{value,label,triggerLabel?,description?,icon?,disabled?}` · `ghost` · `mono` · `size` |
| `Switch` | off: `--line` outline + grey knob; on: white pill + black knob · `checked` · `onCheckedChange` · `label?` · `size` |
| `Checkbox` | 13 px square, on = solid `--acc` + black tick · `checked` (true/false/'indeterminate') · `label?` · `description?` |
| `Tabs`, `TabsList` (`variant` underline/pill), `TabsTrigger` (`count`, `icon`), `TabsContent` | underline: 30 px bar on a hairline, `--t3` → active `--t1` + 1 px `--acc` underline, mono counts. pill = segmented look |
| `Segmented` | single-choice segmented control (reference `.seg`): `value` · `onValueChange` · `options {value,label,icon?,disabled?,ariaLabel?}` · `size` · arrow keys |
| `Dialog`, `DialogTrigger`, `DialogContent` (`title`, `description`, `footer`, `size` sm/md/lg/xl), `DialogClose`, `ConfirmDialog` (`danger`, `onConfirm` async) | `--s0` + `--line` + deep shadow, hairline footer |
| `DropdownMenu*`, `ContextMenu*` | 28 px rows, highlighted on `--s3`; items take `icon`, `shortcut` (quiet mono), `hint`, `danger`, `leading`, `trailing`; plus `…Label` (mono cap), `…Separator`, `…CheckboxItem`, `…RadioItem`, `…Sub*` |
| `Tooltip` | `content` · `shortcut` · `side`; the child must accept a ref |
| `Popover`, `PopoverTrigger`, `PopoverContent` | `ob-popover` surface |
| `Badge` | **the tag**: 1 px border, mono 8.5 px uppercase · `tone` neutral/accent/success/warning/danger/violet (status tones use status colours) · `variant` soft (adds a faint wash) / outline · `size` sm/md · `icon` (`mono`/`pill` are accepted and ignored) |
| `StatusDot` | `tone` or `status` (`statusTone()`: running/in-flight → violet `--live`, waiting → warning, done → success, error → danger) · `pulse` · `glow` (flat halo) · `size` 5–8 |
| `Spinner` (minimal arc), `ProgressBar` (`value` 0..1 or null, `tone`, `size`, **`variant="segments"` + `segments`** = the reference disk meter), `Skeleton` | flat, no rounded ends |
| `EmptyState` | quiet glyph + title + one line · `icon` · `title` · `description` · `action` · `size` |
| `Card` | **not a card any more**: a plain section (no fill, no frame); consecutive Cards are split by one `--rule` hairline. `variant="raised"` = an `--s1` well. `padding` none/sm/md/lg · `interactive` |
| `SectionLabel` | mono 9 px cap label · `action` slot on the right · `rule` draws the trailing hairline |
| `Separator` | `--rule` hairline (`subtle` → `--rule2`), `vertical` |
| `ScrollArea` | 6 px overlay scrollbars; give the root a height; `viewportRef` |
| `Kbd`, `Shortcut keys="Ctrl+Shift+K"` (`plain` = quiet mono text), `shortcutParts()` | key caps |
| `RelativeTime ts` (`short`), `LiveDuration since until? format='clock'/'compact'`, `useNow(ms)` | shared tickers (render them in mono) |
| `CodeBlock` | `code` · `lang` · `title` (path, mono) · `showLineNumbers` + `startLine` · `wrap` · `maxHeight` · `bare` · `actions` · `lineClassName(n, text)` (`ob-line-add` / `ob-line-del`: faint wash + 2 px status edge) |
| `Markdown` | `text` · `compact`. GFM; raw HTML is dropped; code renders through CodeBlock; links open externally |
| `Command*` (cmdk) | `CommandDialog` / `Command` (inline) · `CommandInput` · `CommandList` · `CommandGroup heading` (mono cap) · `CommandItem` (`icon`, `leading`, `hint`, `trailing`, `shortcut`, `keywords`; selected = the selected-row recipe) · `CommandEmpty` |
| `toast({ title, body?, level?, sessionId?, action?, durationMs? })` | `--s0` + `--line`, level shown by the glyph colour + 2 px edge; `<Toaster/>` is mounted |
| `AppMark` | the brand: a rotated square in `--acc` (`size` = bounding box, default 12) |

Highlighting helpers: `langFromPath(path)`, `resolveLang`, `langLabel` in `@renderer/lib/highlighter`.
Formatting: `@renderer/lib/format` has `relativeTime`, `formatDuration`, `formatClock`, `formatMoney`, `formatPerHour`,
`formatTokens`, `formatBytes`, `basename`, `dirname`, `shortenPath`, `relativeToCwd`, `shortModelName`, `providerLabel`,
`sameModel`, `modelKey`, `pluralize` and `truncate`.
Electron bridge (safe in browser mode): `@renderer/lib/bridge` has `pickFolder`, `openExternal`, `openPath`, `showItemInFolder`, `isElectron`.

## 4. State (zustand) — `@renderer/state/*`

Read with selector hooks. Never return a new array or object from a selector: select the raw record, then `useMemo`, or use the
ready-made selectors.

| Store | Shape |
|---|---|
| `useSessions` (`state/sessions`) | `sessions: Record<id, SessionSummary>` (subagents included) · `activeSessionId` · `transcripts: Record<id, TranscriptEntry>` · `loading` · `loadErrors` · `unread` · `queued: Record<id, {messageId,text,at}[]>` |
| `TranscriptEntry` (`state/transcript`) | `session: Session` (messages/todos/changedFiles kept live by events) · `streamingMessageId` · `blockStarts[`${messageId}:${blockIndex}`]` / `blockEnds[…]` epoch ms (live "Thinking 4s" timers) · `stale` |
| `usePending` | `permissions`, `questions`, `plans`: `Record<requestId, …Request>` |
| `useModels` | `providers`, `models`, `loaded`, `refreshing` |
| `useGpu` | `status: GpuStatus`, `catalog` (lazy: `loadGpuCatalog()`), `hasApiKey`, `busy` |
| `useSettings` | `settings`, `system` (system.info), `secrets` (presence map) |
| `useActivity` / `useSchedules` | `items` / `tasks` (live through `activity.updated` / `schedules.updated`) |
| `useConnection` | `mode` 'core'/'demo'/'none' · `state.status` (open/reconnecting/…) · `ready` |
| `useUi` | `route` 'session'/'gpu'/'activity'/'schedules'/'settings' · `sidebarCollapsed` · `rightPanelOpen` · `rightPanelTab` · `paletteOpen` · `settingsSection` · `shortcutsOpen` |
| `useUpdates` (`state/updates`) | `snapshot: UpdateSnapshot \| null` (`@shared/updates`: state idle/checking/available/not-available/downloading/downloaded/installing/error/unsupported, `currentVersion`, `lastCheckedAt`, `tokenSource`, `releaseUrl`) · `source` 'electron'/'demo'. null = no updater (browser) → hide update UI. Actions: `checkForUpdates()`, `installUpdate()`; `useStartUpdate()` (app/UpdateButton) adds the GPU confirm |
| `useToasts` | toast queue |

Selectors (`state/selectors`): `useTranscript(id)` (loads or refetches automatically), `useTranscriptLoading(id)`,
`useSessionSummary(id)`, `useActiveSession()`, `useSubagents(id)`, `useQueued(id)`, `usePendingFor(id)` →
`{permissions, questions, plans, count}`, `useWaitingSessionIds()`, `useModelGroups()`, `useModelInfo(ref)`,
`findModel(models, ref)`, `useRecentSessions(n)`, `useRunningCount()`, `useGpuStatus()`, `useRunningActivityCount()`.

Actions (`state/actions`). They catch their own errors, toast them, and resolve to `null`/`false` on failure:
`createSession({cwd?,title?,model?,permissionMode?,open?})`, `openSession(id)`, `goHome()`, `renameSession`, `setPinned`,
`deleteSession`, `forkSession(id, atMessageId?)`, `searchSessions(q)`, `sendMessage(id, text, images?)` (tracks queued
messages), `interrupt(id)`, `respondPermission(reqId, decision, message?)`, `answerQuestion(reqId, answers)`,
`respondPlan(reqId, approve, {mode?, feedback?})`, `setPermissionMode`, `setSessionModel`, `setThinking`,
`rewind(id, atMessageId, restoreFiles)`, `switchModel(ref)` (active session, else the default model), `refreshModels()`,
`clockIn(profileId?, modelId?, offerId?)`, `clockOut()`, `switchGpuModel`, `loadGpuCatalog()`, `defaultGpuProfileId()`,
`updateSettings(patch)`, `setSecret(name, value)`, `stopActivity(id)`, `navigate(route)`, `openSettings(section?)`,
`toggleSidebar()`, `toggleRightPanel(force?)`, `setRightPanelTab(tab)`, `openPalette(page?)`, `markRead(id)`.
Pending responses are removed optimistically and restored if the call fails.

## 5. RPC

```ts
import { rpc, errorMessage } from '@renderer/lib/rpc';
const offers = await rpc.request('gpu.offers', { profileId: 'light' });   // typed from protocol.ts
const off = rpc.on('gpu.status', (s) => …);                                  // returns an unsubscribe function
```

`rpc` is a facade over the active transport: the WebSocket `RpcClient` or the demo core. Listeners survive reconnects. After every
(re)connect the stores refetch everything (`state/sync.ts`), so views don't need their own reconnect logic. Requests time
out after 30 s (gpu.clockIn/clockOut 180 s, models.refresh/gpu.offers 60 s), or pass `{ timeoutMs }`. Errors are `RpcError`
(`message`, `code`). Prefer the store and the actions above; call `rpc.request` directly only for view-local data (offers,
history, server log, files.list…).

## 6. Demo mode and extending it

Run `npx vite --config vite.web.config.ts --port 5173 --strictPort` and open `http://localhost:5173/?demo=1`. A fake core
answers every RPC method with realistic data and simulates streaming turns. Keywords in your prompt trigger scenarios:
"run", "test" or "build" → Bash permission prompt; "ask", "which" or "choose" → question card; "plan" (or plan mode) → plan approval;
"explore", "agent" or "research" → subagent (Task). Slash commands `/clear`, `/compact`, `/plan`, `/thinking`, `/cost` and `/help` work.
GPU clock-in walks through every phase in about 10 s. In devtools, `__obsidianDemo.simulateDisconnect(4000)` shows the reconnect banner.
Auto-update UI: add `&update=available` (or `downloading`, `installing`, `error`, `failed`, `portable`, `secret`) — the
simulated updater lives in `lib/demo-updates.ts`; clicking UPDATE walks download → restart in a few seconds.

Add demo content **from your own folder**: create `features/<area>/demo.ts`. It is auto-imported in demo mode before the
demo core starts.

```ts
// features/chat/demo.ts
import { registerDemoData, registerDemoHandler } from '@renderer/lib/demo';
registerDemoData((d) => ({ sessions: [{ ...d.sessions[0], id: 's-rich', title: 'Rich transcript', messages: [/* … */] }] }));
registerDemoHandler('files.search', async (params, ctx) => ['src/a.ts', ...(await ctx.fallback() as string[])]);
```

Merge rules: arrays of records merge by `id`, `requestId`, `offerId`, `name` or model ref (same key = replace); objects shallow-merge.
`ctx` has `data` (live, mutable), `emit(event, data)`, `sleep`, `newId`, `getSession`, `updateSession`, `runTurn`, `fallback()`.
Seeded sample: sessions `s-glm` (full transcript with Read/Edit/Bash, todos, changes, pinned), `s-sse` (running, with a
running subagent `s-sse-explore`), `s-perm` (waiting on a Bash permission `perm-demo-1`), plus others. GPU starts `ready`.

## 7. Tests and screenshots

* Unit tests: `tests/unit/<area>/`, run with `npx vitest run tests/unit/<area>`. Import renderer code through `@renderer/*`. The node
  tsconfig sees those imports as `any` (see `tests/unit/ui-foundation/renderer-modules.d.ts`), so annotate callback parameters
  with `@shared` types. A per-folder tsconfig like `tests/unit/ui-foundation/tsconfig.json` gives full type-checking.
  `createDemoTransport({ latencyMs: 0, speed: 0 })` plus `rpc.setTransport(t)` and `bindEvents()` drives the real stores
  (see `tests/unit/ui-foundation/sync.test.ts`).
* Playwright: the dev server above plus `npx playwright test tests/e2e/<your>.spec.ts`. Open `/?demo=1`, wait for
  `getByTestId('session-row')`, then call `page.screenshot({ path: 'tests/e2e/screenshots/<area>-<name>.png' })` at 1440×900 and 1024×700.
  Useful test ids: `app-title`, `titlebar`, `menubar`, `menu-<file|view|session|gpu|help>`, `view-title`, `status-bar`,
  `status-connection`, `status-gpu`, `sidebar` (`data-collapsed`), `session-row`, `new-session`, `nav-<route>`, `gpu-widget`,
  `gpu-clock-button`, `right-panel`, `home`, `quick-start`, `palette-trigger`, `update-button` (`data-status`),
  `update-version`, `status-version`, `settings-updates`.
  Put your screenshots next to the reference shots in `docs/design/m-13-obsidian/shots/` and iterate on spacing, alignment
  and contrast until they read as the same design language before you hand off.
