# Obsidian UI guide (for ui-chat and ui-views)

Owner: ui-foundation. This covers what already exists and how to use it, so your feature folders stay small and consistent.
Dark-only, dense, minimal (SPEC §5). Use lucide icons only (16 px default, 1.75 stroke is set globally). No emoji.

## 1. File ownership

| Path | Owner |
|---|---|
| `design/`, `components/ui/`, `lib/`, `state/`, `app/`, `main.tsx`, `index.html`, this guide | ui-foundation |
| `features/chat/**` | ui-chat (replace the STUB `ChatView.tsx` and `panels.tsx`) |
| `features/{gpu,activity,schedules,settings}/**` | ui-views (replace the STUB views) |

The shell imports exactly these, so keep the names and props:

```ts
// features/chat/ChatView.tsx
export function ChatView(props: { sessionId: string }): JSX.Element  // fills the main area: use "flex h-full flex-col"
// features/chat/panels.tsx (right panel tabs; the container and tabs bar are already provided)
export function ChangesPanel(p: { sessionId: string }); TodosPanel; AgentsPanel; FilesPanel
// features/gpu/GpuView.tsx, features/activity/ActivityView.tsx, features/schedules/SchedulesView.tsx, features/settings/SettingsView.tsx
export function GpuView(); ActivityView(); SchedulesView(); SettingsView()
```

Views get the full main area (title bar, sidebar and the reconnect banner are outside it). Make the view root `h-full` and
scroll inside it (`overflow-y-auto`). Each view is wrapped in an error boundary. Settings can read
`useUi.getState().settingsSection` (set by `openSettings('vast')`) to focus a section.

## 2. Tokens and Tailwind classes

All tokens are CSS variables in `design/tokens.css` and mapped into Tailwind v4:

| Use | Classes |
|---|---|
| Surfaces | `bg-ob-bg` (canvas) · `bg-ob-surface-1` (sidebar, panels, cards) · `bg-ob-surface-2` (inputs, user bubbles, raised cards) · `bg-ob-surface-3` (popovers, menus) · `bg-ob-code-bg` |
| Hover washes | `hover:bg-ob-hover` · `active:bg-ob-press` (they work over any surface) |
| Borders | `border-ob-border` (hairlines) · `border-ob-border-strong` |
| Text | `text-ob-text` · `text-ob-text-2` (secondary) · `text-ob-text-3` (muted/meta) |
| Accent | `text-ob-accent`, `bg-ob-accent`, `bg-ob-accent-soft` (selected rows), `text-ob-accent-ink` (text on accent) |
| Status | `ob-success` / `ob-warning` / `ob-danger` / `ob-violet`, each also `-soft` (12 % wash): `bg-ob-danger-soft text-ob-danger` |
| Diff rows | `bg-ob-diff-add`, `bg-ob-diff-del` (or the `.ob-line-add` / `.ob-line-del` classes inside a CodeBlock) |
| Type scale | `text-meta` 11 · `text-small` 12 · `text-ui` 13 (default) · `text-prose` 14.5/1.65 · `text-lead` 16 · `text-title` 20 |
| Fonts | `font-sans` (IBM Plex Sans 400/500/600), `font-mono` (JetBrains Mono 400/500) |
| Radius | `rounded-ctl` 6 px (controls) · `rounded-card` 10 px · `rounded-pill` |
| Shadow | `shadow-pop` (popovers only, always with a 1 px border) |
| Motion | `ob-transition` (120 ms ease-out on colors/opacity/transform) · `animate-ob-fade-in` · `animate-ob-pop-in` · `animate-ob-slide-up` · `animate-ob-pulse` |
| Helpers | `ob-section-label` (mono uppercase 11 px) · `ob-tabular` (tabular numbers) · `ob-popover` (menu surface) · `ob-skeleton` · `ob-selectable` (opt into text selection, which is off by default) |
| Prose | `ob-prose` (chat markdown, 14.5 px), add `ob-prose-compact` for 13 px. Prefer the `<Markdown>` component. |

Rules: spacing on the 4 px grid (gaps of 8/12/16/24), hit targets of 28 px or more, primary buttons 32 px or taller. Focus rings come from the
global `:focus-visible` style, so don't remove outlines. Wrap anything that should be copyable in `ob-selectable` (transcripts, logs).

`cn()` from `@renderer/lib/cn` = clsx plus Tailwind conflict resolution (the later class wins, per variant). So
`<Button className="h-7 px-2">` reliably overrides the component's own sizing.

## 3. Components (`import { … } from '@renderer/components/ui'`)

Live gallery: `http://localhost:5173/?demo=1&gallery=1`.

| Component | Key props |
|---|---|
| `Button` | `variant` primary/secondary/ghost/danger/danger-solid · `size` sm(28)/md(32)/lg(36) · `loading` · `icon` / `iconRight` (Lucide component or node) · `fullWidth` |
| `IconButton` | **`label` (required: aria-label and tooltip)** · `icon` · `size` xs/sm/md/lg (20/24/28/32) · `variant` ghost/secondary/danger/primary · `active` · `shortcut` · `tooltipSide` · `loading` |
| `Input` | `size` sm/md/lg · `icon` · `trailing` (slot) · `invalid` · `mono` |
| `Textarea` | auto-grow by default: `minRows` / `maxRows` · `bare` (borderless, for composers) · `mono` · `invalid` · `ref` |
| `Field` | `label` · `description` · `error` · `inline` (label left, control right: switches) |
| `Select` | `value` · `onValueChange` · `options` or `groups` (`{label, options}`) · option `{value,label,triggerLabel?,description?,icon?,disabled?}` · `ghost` · `size` |
| `Switch` | `checked` · `onCheckedChange` · `label?` · `size` |
| `Checkbox` | `checked` (true/false/'indeterminate') · `onCheckedChange` · `label?` · `description?` |
| `Tabs`, `TabsList` (`variant` underline/pill), `TabsTrigger` (`count`, `icon`), `TabsContent` | Radix tabs |
| `Dialog`, `DialogTrigger`, `DialogContent` (`title`, `description`, `footer`, `size` sm/md/lg/xl), `DialogClose`, `ConfirmDialog` (`danger`, `onConfirm` async) | Radix dialog |
| `DropdownMenu*`, `ContextMenu*` | items take `icon`, `shortcut`, `hint`, `danger`; plus `…Label`, `…Separator`, `…CheckboxItem`, `…RadioItem`, `…Sub*` |
| `Tooltip` | `content` · `shortcut` · `side`; the child must accept a ref |
| `Popover`, `PopoverTrigger`, `PopoverContent` | Radix popover |
| `Badge` | `tone` neutral/accent/success/warning/danger/violet · `variant` soft/outline · `mono` (uppercase) · `pill` · `icon` |
| `StatusDot` | `tone` or `status` (maps 'online', 'running', 'waiting', 'error'… through `statusTone()`) · `pulse` · `glow` · `size` |
| `Spinner`, `ProgressBar` (`value` 0..1 or null for indeterminate, `tone`, `size`), `Skeleton` | |
| `EmptyState` | `icon` · `title` · `description` · `action` · `size` |
| `Card` | `variant` flat/raised/ghost · `padding` none/sm/md/lg · `interactive` |
| `SectionLabel` | mono uppercase 11 px, `action` slot on the right |
| `ScrollArea` | thin overlay scrollbars; give the root a height; `viewportRef` for scroll control |
| `Kbd`, `Shortcut keys="Ctrl+Shift+K"` | key caps |
| `RelativeTime ts` (`short`), `LiveDuration since until? format='clock'/'compact'`, `useNow(ms)` | shared tickers |
| `CodeBlock` | `code` · `lang` (aliases fine: ts, bash, ps1…) · `title` · `showLineNumbers` + `startLine` · `wrap` · `maxHeight` · `bare` · `actions` · `lineClassName(n, text)` (diff rows) |
| `Markdown` | `text` · `compact`. GFM; raw HTML is dropped; code renders through CodeBlock; links open externally; remote images become links |
| `Command*` (cmdk) | `CommandDialog` / `Command` (inline, for slash and @ palettes) · `CommandInput` · `CommandList` · `CommandGroup heading` · `CommandItem` (`icon`, `leading`, `hint`, `trailing`, `shortcut`, `keywords`) · `CommandEmpty` |
| `toast({ title, body?, level?, sessionId?, action?, durationMs? })` | Imperative; `<Toaster/>` is already mounted |
| `AppMark` | The app's shard logo |

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
| `useUi` | `route` 'session'/'gpu'/'activity'/'schedules'/'settings' · `sidebarCollapsed` · `rightPanelOpen` · `rightPanelTab` · `paletteOpen` · `settingsSection` |
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
  Useful test ids: `app-title`, `titlebar`, `view-title`, `sidebar` (`data-collapsed`), `session-row`, `new-session`,
  `nav-<route>`, `gpu-widget`, `gpu-clock-button`, `right-panel`, `home`, `quick-start`, `palette-trigger`.
  Open the PNGs and iterate on spacing, alignment and contrast before you hand off.
