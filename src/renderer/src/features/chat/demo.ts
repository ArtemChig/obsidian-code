// Demo-mode content for the chat UI (auto-imported by app/boot.ts with ?demo=1). Owner: ui-chat.
// Adds sessions that show every card type, a pending Edit permission with a diff preview, a failed turn, a git
// branch for the demo project, and a "fail" keyword that simulates an agent error (for the Retry banner).
import type { ImageBlock, Message, PermissionRequest, Session, ToolUseBlock } from '@shared/types';
import { registerDemoData, registerDemoHandler } from '@renderer/lib/demo';
import { DEMO_PROJECT } from '@renderer/lib/demo-data';
import { useChatLocal } from './state';

const MIN = 60_000;
const now = Date.now();
const P = DEMO_PROJECT;
const VAST = { provider: 'vast' as const, model: 'qwen38-27b-uncensored-hauhau-q5kp' };
const LOCAL = { provider: 'local' as const, model: 'Qwen3.6-35B-A3B-Uncensored-Q4_K_M' };

const SCREENSHOT_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
  '<rect width="640" height="360" rx="10" fill="#0e171c"/>',
  '<rect width="640" height="34" rx="10" fill="#1c2833"/><rect y="24" width="640" height="10" fill="#1c2833"/>',
  '<circle cx="20" cy="17" r="5" fill="#f07178"/><circle cx="38" cy="17" r="5" fill="#e8b85c"/><circle cx="56" cy="17" r="5" fill="#5fd39a"/>',
  '<text x="320" y="21" fill="#7c8b96" font-family="monospace" font-size="12" text-anchor="middle">scheduler.log</text>',
  '<g font-family="monospace" font-size="14">',
  '<text x="22" y="74" fill="#a9b6bf">[02:00:00] run "Weekly benchmark on Vast"</text>',
  '<text x="22" y="100" fill="#a9b6bf">[02:00:00] model vast/qwen38-27b-uncensored</text>',
  '<text x="22" y="126" fill="#f07178">[02:00:01] ERROR provider vast is offline</text>',
  '<text x="22" y="152" fill="#f07178">           (not clocked in) - run skipped</text>',
  '<text x="22" y="190" fill="#7c8b96">[02:00:01] next run: Sat 10:00</text>',
  '<rect x="22" y="214" width="9" height="16" fill="#a9b6bf"/>',
  '</g></svg>',
].join('');

function svgImage(svg: string, name: string): ImageBlock {
  const b64 = typeof btoa === 'function' ? btoa(svg) : '';
  return { type: 'image', mediaType: 'image/svg+xml', data: b64, name };
}

const SCHED_BEFORE = `export async function runTask(ctx: CoreContext, task: ScheduledTask): Promise<RunResult> {
  const model = task.model ?? ctx.settings.get().defaultModel;
  if (!model) return skip(task, 'No model configured');
  const provider = ctx.models.provider(model.provider);
  if (provider?.status !== 'online') {
    return skip(task, \`Provider \${model.provider} is offline\`);
  }
  const session = ctx.sessions.create({ cwd: task.cwd, kind: 'scheduled', scheduleId: task.id, model });
  const result = await ctx.agent.runHeadless({ sessionId: session.id, prompt: task.prompt, permissionMode: task.permissionMode });
  return finish(task, session.id, result);
}`;

const SCHED_AFTER = `export async function runTask(ctx: CoreContext, task: ScheduledTask): Promise<RunResult> {
  const model = task.model ?? ctx.settings.get().defaultModel;
  if (!model) return skip(task, 'No model configured');
  let clockedIn = false;
  if (model.provider === 'vast' && ctx.gpu.status().phase !== 'ready') {
    if (!task.allowAutoClockIn) return skip(task, 'GPU is not clocked in (auto clock-in is off)');
    const guard = budgetGuard(ctx, task);
    if (!guard.ok) return skip(task, guard.reason);
    await ctx.gpu.clockIn({ profileId: guard.profileId, modelId: model.model });
    clockedIn = true;
  }
  const session = ctx.sessions.create({ cwd: task.cwd, kind: 'scheduled', scheduleId: task.id, model });
  try {
    const result = await ctx.agent.runHeadless({ sessionId: session.id, prompt: task.prompt, permissionMode: task.permissionMode });
    return finish(task, session.id, result);
  } finally {
    if (clockedIn) await ctx.gpu.clockOut({ reason: 'clock_out' });
  }
}`;

const TEST_FILE = `import { describe, expect, it } from 'vitest';
import { runTask } from '../../../src/core/scheduler/run';
import { fakeContext, task } from './helpers';

describe('scheduler auto clock-in', () => {
  it('clocks in before and out after a Vast run', async () => {
    const ctx = fakeContext({ gpuPhase: 'off' });
    await runTask(ctx, task({ allowAutoClockIn: true, model: { provider: 'vast', model: 'q' } }));
    expect(ctx.calls).toEqual(['gpu.clockIn', 'agent.runHeadless', 'gpu.clockOut']);
  });

  it('skips when auto clock-in is off', async () => {
    const ctx = fakeContext({ gpuPhase: 'off' });
    const r = await runTask(ctx, task({ allowAutoClockIn: false, model: { provider: 'vast', model: 'q' } }));
    expect(r.status).toBe('skipped');
  });
});
`;

const READ_EXCERPT = `export function createScheduler(ctx: CoreContext): SchedulerApi & { start(): void; stop(): void } {
  const jobs = new Map<string, Cron>();

  function arm(task: ScheduledTask): void {
    jobs.get(task.id)?.stop();
    if (!task.enabled) return;
    const job = task.oneShot
      ? new Cron(new Date(task.schedule), { maxRuns: 1 }, () => void fire(task.id))
      : new Cron(task.schedule, { protect: true }, () => void fire(task.id));
    jobs.set(task.id, job);
  }

  async function fire(id: string): Promise<void> {
    const task = load().find((t) => t.id === id);
    if (!task) return;
    const r = await runTask(ctx, task);
    save(update(task, r));
    ctx.bus.emit('schedules.updated', load());
  }`;

function tool(id: string, name: string, input: Record<string, unknown>, t: number, extra: Partial<ToolUseBlock>): ToolUseBlock {
  return { type: 'tool_use', id, name, input, status: 'done', startedAt: t, endedAt: t + 400, ...extra };
}

function tourMessages(t0: number): Message[] {
  const f = (rel: string) => `${P}\\${rel.replace(/\//g, '\\')}`;
  return [
    {
      id: 'm-tour-0',
      role: 'system',
      tag: 'compact_summary',
      createdAt: t0 - 30 * MIN,
      blocks: [
        {
          type: 'text',
          text: 'Earlier in this session: the Vast provider was registered with the model registry, `gpu.clockIn` gained a `modelId` parameter, and the budget guard moved to `src/core/gpu/budget.ts`. All unit tests passed.',
        },
      ],
    },
    {
      id: 'm-tour-1',
      role: 'user',
      createdAt: t0,
      blocks: [
        svgImage(SCREENSHOT_SVG, 'scheduler-log.svg'),
        {
          type: 'text',
          text: "Scheduled tasks that use the Vast model should clock in automatically when allowAutoClockIn is set, and clock out afterwards. Here's last night's log — the run was just skipped.",
        },
      ],
    },
    {
      id: 'm-tour-2',
      role: 'assistant',
      createdAt: t0 + 3_000,
      meta: { model: VAST.model, durationMs: 312_000, promptTokens: 38_900, completionTokens: 4_812 },
      blocks: [
        {
          type: 'thinking',
          durationMs: 8_200,
          text: 'The log shows the scheduler checks provider status and skips when Vast is offline. I need to find where runTask lives, see how the GPU manager exposes clockIn/clockOut, respect the budget guard, and make sure we always clock out — even if the headless run throws. A try/finally around runHeadless is the simplest way to guarantee that.',
        },
        { type: 'text', text: "I'll find where scheduled runs are started and how the GPU manager is exposed to them." },
        tool('tu-tour-grep', 'Grep', { pattern: 'runHeadless|clockIn', glob: 'src/core/**/*.ts', output_mode: 'content', '-n': true }, t0 + 9_000, {
          result: {
            content: '4 matches',
            display: {
              kind: 'list',
              title: 'Grep runHeadless|clockIn (4)',
              items: [
                'src/core/scheduler/run.ts:9:  const result = await ctx.agent.runHeadless({ sessionId: session.id, prompt: task.prompt });',
                'src/core/agent/manager.ts:352:  async runHeadless(opts: HeadlessRunOptions): Promise<TurnResult> {',
                'src/core/gpu/index.ts:118:  async clockIn(opts: ClockInOptions): Promise<GpuStatus> {',
                'src/core/gpu/index.ts:204:  async clockOut(opts: { reason?: EndReason } = {}): Promise<GpuStatus> {',
              ],
            },
          },
        }),
        tool('tu-tour-glob', 'Glob', { pattern: 'src/core/scheduler/**/*.ts' }, t0 + 10_000, {
          result: {
            content: '4 files',
            display: { kind: 'list', title: 'Glob src/core/scheduler/**/*.ts (4)', items: ['src/core/scheduler/index.ts', 'src/core/scheduler/run.ts', 'src/core/scheduler/human.ts', 'src/core/scheduler/catchup.ts'] },
          },
        }),
        tool('tu-tour-read', 'Read', { file_path: f('src/core/scheduler/index.ts'), offset: 70, limit: 20 }, t0 + 11_000, {
          result: { content: READ_EXCERPT, display: { kind: 'file', path: f('src/core/scheduler/index.ts'), content: READ_EXCERPT, startLine: 70, totalLines: 214 } },
        }),
        tool('tu-tour-ls', 'LS', { path: f('src/core/gpu') }, t0 + 12_000, {
          result: {
            content: '7 entries',
            display: { kind: 'list', title: 'LS src/core/gpu', items: ['budget.ts', 'catalog.ts', 'index.ts', 'ledger.ts', 'ssh.ts', 'tunnel.ts', 'vast.ts'] },
          },
        }),
        tool(
          'tu-tour-task',
          'Task',
          { description: 'Map the GPU clock-in API', subagent_type: 'Explore', prompt: 'Find how clockIn/clockOut are called and what they return. Report call sites and error handling.' },
          t0 + 14_000,
          {
            endedAt: t0 + 58_000,
            result: {
              content:
                '`clockIn({ profileId, modelId })` resolves once the pipeline **starts**; callers must wait for `phase === "ready"` via `waitReady()`. `clockOut()` is idempotent and verifies the instance is destroyed. Two call sites today: the tray menu and the GPU view.',
              display: { kind: 'subagent', sessionId: 's-tour-explore', agentType: 'Explore', description: 'Map the GPU clock-in API' },
            },
          },
        ),
        {
          type: 'text',
          text: 'The scheduler skips Vast runs outright. Before changing behaviour that costs money, one decision from you:',
        },
        tool(
          'tu-tour-ask',
          'AskUserQuestion',
          {
            questions: [
              {
                header: 'Clock out',
                question: 'When should an auto clock-in end?',
                multiSelect: false,
                options: [
                  { label: 'After the run', description: 'Clock out as soon as the task finishes' },
                  { label: 'Keep warm 15 min', description: 'Stay clocked in briefly for follow-up runs' },
                ],
              },
            ],
          },
          t0 + 60_000,
          {
            endedAt: t0 + 95_000,
            result: {
              content: 'User has answered your questions.',
              display: {
                kind: 'questions',
                questions: [
                  {
                    header: 'Clock out',
                    question: 'When should an auto clock-in end?',
                    multiSelect: false,
                    options: [
                      { label: 'After the run', description: 'Clock out as soon as the task finishes' },
                      { label: 'Keep warm 15 min', description: 'Stay clocked in briefly for follow-up runs' },
                    ],
                  },
                ],
                answers: { 'When should an auto clock-in end?': 'After the run' },
              },
            },
          },
        ),
        tool('tu-tour-plan', 'ExitPlanMode', { plan: '…' }, t0 + 96_000, {
          endedAt: t0 + 140_000,
          result: {
            content: 'User has approved your plan. You can now start implementing it.',
            display: {
              kind: 'plan',
              plan: '## Auto clock-in for scheduled runs\n\n1. In `runTask`, when the model is on **Vast** and the GPU is not ready: skip unless `allowAutoClockIn`\n2. Check the **budget guard** before renting\n3. `clockIn` → wait for `ready` → run headless\n4. Always `clockOut` in a `finally` block\n5. Unit tests for both paths',
            },
          },
        }),
        tool(
          'tu-tour-todo',
          'TodoWrite',
          {},
          t0 + 141_000,
          {
            result: {
              content: 'Todos updated',
              display: {
                kind: 'todos',
                todos: [
                  { id: 'a', content: 'Find where scheduled runs start', status: 'completed' },
                  { id: 'b', content: 'Clock in before Vast runs (budget-guarded)', status: 'completed' },
                  { id: 'c', content: 'Always clock out afterwards', status: 'in_progress', activeForm: 'Adding clock-out in a finally block' },
                  { id: 'd', content: 'Unit tests for both paths', status: 'pending' },
                ],
              },
            },
          },
        ),
        tool('tu-tour-edit', 'Edit', { file_path: f('src/core/scheduler/run.ts'), old_string: '…', new_string: '…' }, t0 + 150_000, {
          result: { content: 'Edited src/core/scheduler/run.ts', display: { kind: 'diff', path: f('src/core/scheduler/run.ts'), before: SCHED_BEFORE, after: SCHED_AFTER } },
        }),
        tool('tu-tour-write', 'Write', { file_path: f('tests/unit/platform/scheduler-clockin.test.ts'), content: TEST_FILE }, t0 + 170_000, {
          result: {
            content: 'Created tests/unit/platform/scheduler-clockin.test.ts',
            display: { kind: 'diff', path: f('tests/unit/platform/scheduler-clockin.test.ts'), before: '', after: TEST_FILE, isNewFile: true },
          },
        }),
        tool('tu-tour-tsc', 'Bash', { command: 'npx tsc --noEmit -p tsconfig.node.json', description: 'Typecheck the core' }, t0 + 180_000, {
          endedAt: t0 + 191_000,
          result: {
            content: 'exit 2',
            isError: false,
            display: {
              kind: 'bash',
              command: 'npx tsc --noEmit -p tsconfig.node.json',
              exitCode: 2,
              output: "src/core/scheduler/run.ts(12,22): error TS2554: Expected 1 arguments, but got 0.\n  clockOut() requires { reason }",
            },
          },
        }),
        tool('tu-tour-test', 'Bash', { command: 'npx vitest run tests/unit/platform/scheduler-clockin.test.ts', description: 'Run the new scheduler tests' }, t0 + 200_000, {
          endedAt: t0 + 203_400,
          result: {
            content: 'exit 0',
            display: {
              kind: 'bash',
              command: 'npx vitest run tests/unit/platform/scheduler-clockin.test.ts',
              exitCode: 0,
              output:
                '\u001b[32m RUN \u001b[39m v5.0.4 E:/programming projects/Dedicated LLM/obsidian-code\n\n \u001b[32m✓\u001b[39m tests/unit/platform/scheduler-clockin.test.ts (2 tests) 18ms\n   ✓ clocks in before and out after a Vast run\n   ✓ skips when auto clock-in is off\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  402ms',
            },
          },
        }),
        tool('tu-tour-dev', 'Bash', { command: 'npm run dev:web', run_in_background: true, description: 'Start the web UI' }, t0 + 210_000, {
          result: {
            content: 'Started background shell sh-3',
            display: { kind: 'bash', command: 'npm run dev:web', output: '  VITE v7.3.7  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/', exitCode: null, background: true, shellId: 'sh-3' },
          },
        }),
        tool('tu-tour-ps', 'PowerShell', { command: 'Get-Process llama-server | Select-Object Id, CPU, WS' }, t0 + 215_000, {
          result: {
            content: 'ok',
            display: {
              kind: 'bash',
              command: 'Get-Process llama-server | Select-Object Id, CPU, WS',
              exitCode: 0,
              output: '   Id      CPU         WS\n   --      ---         --\n14208  1840.52 6442450944',
            },
          },
        }),
        tool('tu-tour-search', 'WebSearch', { query: 'vast.ai api instance stop vs destroy billing' }, t0 + 220_000, {
          result: {
            content: '3 results',
            display: {
              kind: 'search',
              query: 'vast.ai api instance stop vs destroy billing',
              results: [
                { title: 'Instances — Vast.ai Documentation', url: 'https://docs.vast.ai/instances', snippet: 'Stopped instances keep their disk and are billed for storage only. Destroying an instance deletes all data and ends all billing.' },
                { title: 'REST API: destroy instance', url: 'https://docs.vast.ai/api/destroy-instance', snippet: 'DELETE /api/v0/instances/{id}/ — permanently destroys the instance.' },
                { title: 'Billing FAQ', url: 'https://docs.vast.ai/billing', snippet: 'GPU time is billed per second while the instance is running.' },
              ],
            },
          },
        }),
        tool('tu-tour-fetch', 'WebFetch', { url: 'https://docs.vast.ai/instances', prompt: 'What does stop cost?' }, t0 + 225_000, {
          result: { content: 'Stopped instances are billed for storage.', display: { kind: 'web', url: 'https://docs.vast.ai/instances', title: 'Instances — Vast.ai Documentation', bytes: 48_213 } },
        }),
        tool('tu-tour-skill', 'Skill', { skill: 'release-checklist' }, t0 + 230_000, {
          result: { content: 'Loaded skill', display: { kind: 'markdown', markdown: 'Loaded skill **release-checklist** — 6 steps for cutting a build and verifying the installer.' } },
        }),
        tool('tu-tour-sched', 'ScheduleTask', { name: 'Weekly benchmark on Vast', prompt: 'Run llama-bench…', schedule: '0 10 * * 6' }, t0 + 235_000, {
          result: { content: 'Scheduled', display: { kind: 'markdown', markdown: '**Scheduled** `Weekly benchmark on Vast` — `0 10 * * 6` — next run Sat 10:00' } },
        }),
        tool('tu-tour-mcp', 'mcp__github__create_pull_request', { owner: 'dev', repo: 'obsidian-code', title: 'Scheduler: auto clock-in for Vast runs', head: 'feat/chat-ui', base: 'main' }, t0 + 240_000, {
          result: { content: '{\n  "number": 42,\n  "url": "https://github.com/dev/obsidian-code/pull/42",\n  "state": "open"\n}' },
        }),
        {
          type: 'text',
          text: [
            'Scheduled Vast runs now clock in and out on their own:',
            '',
            '- **Auto clock-in** happens only when the task has `allowAutoClockIn` and the budget guard passes',
            '- **Clock-out** runs in a `finally`, so a crashed run cannot leave a GPU billing overnight',
            '- Skipped runs record *why* (`GPU is not clocked in (auto clock-in is off)`)',
            '',
            '| Case | Before | After |',
            '|---|---|---|',
            '| Vast offline, auto clock-in on | skipped | clock in → run → clock out |',
            '| Vast offline, auto clock-in off | skipped | skipped (clear reason) |',
            '| Budget would be exceeded | ran anyway | skipped by the guard |',
            '',
            'The guard reuses the GPU module:',
            '',
            '```ts',
            'const guard = budgetGuard(ctx, task);',
            'if (!guard.ok) return skip(task, guard.reason);',
            'await ctx.gpu.clockIn({ profileId: guard.profileId, modelId: model.model });',
            '```',
            '',
            'Both new tests pass. I opened PR #42 for review.',
          ].join('\n'),
        },
      ],
    },
    { id: 'm-tour-3', role: 'user', tag: 'command', createdAt: t0 + 330_000, blocks: [{ type: 'text', text: '/cost' }] },
    {
      id: 'm-tour-4',
      role: 'assistant',
      tag: 'command',
      createdAt: t0 + 330_100,
      meta: { durationMs: 5 },
      blocks: [{ type: 'text', text: '**Usage** — 112,480 input · 9,214 output tokens across 14 requests. GPU time this session: **$0.41**.' }],
    },
    { id: 'm-tour-5', role: 'user', createdAt: t0 + 360_000, blocks: [{ type: 'text', text: 'Also kill the stale SSH tunnel and rename the tunnel helper.' }] },
    {
      id: 'm-tour-6',
      role: 'assistant',
      createdAt: t0 + 362_000,
      meta: { model: VAST.model, durationMs: 41_000, promptTokens: 41_200, completionTokens: 380, interrupted: true },
      blocks: [
        { type: 'text', text: "I'll stop the tunnel process first." },
        tool('tu-tour-kill', 'Bash', { command: 'taskkill /PID 14208 /F', description: 'Kill the stale tunnel' }, t0 + 364_000, {
          status: 'denied',
          endedAt: t0 + 371_000,
          result: { content: 'User denied: keep it running — Hearth uses that port.', isError: true },
        }),
        tool('tu-tour-edit2', 'Edit', { file_path: f('src/core/gpu/tunnel.ts'), old_string: 'export function openTunnel(', new_string: 'export function openPortForward(' }, t0 + 375_000, {
          status: 'error',
          endedAt: t0 + 375_200,
          result: { content: 'old_string not found in src/core/gpu/tunnel.ts. Read the file again before editing — it changed since it was last read.', isError: true },
        }),
        tool('tu-tour-read2', 'Read', { file_path: f('src/core/gpu/tunnel.ts') }, t0 + 380_000, {
          status: 'interrupted',
          endedAt: t0 + 401_000,
          result: { content: 'Interrupted by the user before the tool finished.', isError: true },
        }),
      ],
    },
  ];
}

function exploreMessages(t0: number): Message[] {
  return [
    { id: 'm-tx-1', role: 'user', createdAt: t0, blocks: [{ type: 'text', text: 'Find how clockIn/clockOut are called and what they return. Report call sites and error handling.' }] },
    {
      id: 'm-tx-2',
      role: 'assistant',
      createdAt: t0 + 1_000,
      meta: { model: VAST.model, durationMs: 44_000 },
      blocks: [
        { type: 'text', text: 'Searching for clock-in call sites across main and core.' },
        tool('tu-tx-grep', 'Grep', { pattern: 'clockIn\\(', path: 'src' }, t0 + 4_000, {
          result: {
            content: '3 matches',
            display: { kind: 'list', title: 'Grep clockIn\\( (3)', items: ['src/main/tray.ts:41', 'src/renderer/src/state/actions.ts:336', 'src/core/gpu/index.ts:118'] },
          },
        }),
        tool('tu-tx-read', 'Read', { file_path: `${P}\\src\\core\\gpu\\index.ts`, offset: 110, limit: 40 }, t0 + 8_000, {
          result: { content: '…', display: { kind: 'file', path: `${P}\\src\\core\\gpu\\index.ts`, content: '  async clockIn(opts: ClockInOptions): Promise<GpuStatus> {\n    this.assertIdle();\n    return this.pipeline.start(opts);\n  }', startLine: 118, totalLines: 412 } },
        }),
        { type: 'text', text: 'clockIn resolves when the pipeline starts; callers wait for `ready`. clockOut is idempotent and verifies destruction.' },
      ],
    },
  ];
}

function permMessages(t0: number): Message[] {
  return [
    { id: 'm-tp-1', role: 'user', createdAt: t0, blocks: [{ type: 'text', text: 'Rename the GPU phase label "renting" to "Starting instance" everywhere in the UI.' }] },
    {
      id: 'm-tp-2',
      role: 'assistant',
      createdAt: t0 + 2_000,
      blocks: [
        { type: 'thinking', durationMs: 2_900, text: 'The labels live in GpuWidget.tsx in GPU_PHASE_LABEL. One edit should do it.' },
        { type: 'text', text: 'The phase labels are defined once in `GpuWidget.tsx`. Updating the map:' },
        tool(
          'tu-tp-edit',
          'Edit',
          {
            file_path: `${P}\\src\\renderer\\src\\app\\GpuWidget.tsx`,
            old_string: "  searching: 'Searching offers',\n  renting: 'Renting GPU',\n  connecting: 'Connecting',",
            new_string: "  searching: 'Searching offers',\n  renting: 'Starting instance',\n  connecting: 'Connecting',",
          },
          t0 + 6_000,
          { status: 'awaiting_permission', endedAt: undefined },
        ),
      ],
    },
  ];
}

function errorMessages(t0: number): Message[] {
  return [
    { id: 'm-te-1', role: 'user', createdAt: t0, blocks: [{ type: 'text', text: 'Benchmark GLM-5.3 Flash on the max profile and compare with Qwen3.8 27B.' }] },
    {
      id: 'm-te-2',
      role: 'assistant',
      createdAt: t0 + 2_000,
      meta: { model: LOCAL.model, durationMs: 9_400, interrupted: false },
      blocks: [
        { type: 'thinking', durationMs: 4_100, text: 'I need the max profile clocked in first, then llama-bench with matching settings for both models.' },
        { type: 'text', text: "I'll check whether the max profile is available right now." },
      ],
    },
  ];
}

const PERM_MSGS = permMessages(now - 3 * MIN);

const tourPerm: PermissionRequest = {
  requestId: 'perm-tour-edit',
  sessionId: 's-tour-perm',
  toolUseId: 'tu-tp-edit',
  toolName: 'Edit',
  input: (PERM_MSGS[1].blocks[2] as ToolUseBlock).input,
  title: 'Edit src/renderer/src/app/GpuWidget.tsx',
  suggestedRule: 'Edit(src/renderer/**)',
  createdAt: now - 40_000,
};

function session(p: Partial<Session> & Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>): Session {
  return {
    cwd: P,
    kind: 'chat',
    status: 'idle',
    model: VAST,
    permissionMode: 'default',
    thinking: true,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    messages: [],
    todos: [],
    changedFiles: [],
    ...p,
  };
}

registerDemoData(() => ({
  sessions: [
    session({
      id: 's-tour',
      title: 'Scheduler: auto clock-in for Vast runs',
      createdAt: now - 70 * MIN,
      updatedAt: now - 5 * MIN,
      permissionMode: 'acceptEdits',
      usage: { inputTokens: 112_480, outputTokens: 9_214, lastPromptTokens: 41_200, requests: 14 },
      messages: tourMessages(now - 60 * MIN),
      todos: [
        { id: 'a', content: 'Find where scheduled runs start', status: 'completed' },
        { id: 'b', content: 'Clock in before Vast runs (budget-guarded)', status: 'completed' },
        { id: 'c', content: 'Always clock out afterwards', status: 'in_progress', activeForm: 'Adding clock-out in a finally block' },
        { id: 'd', content: 'Unit tests for both paths', status: 'pending' },
      ],
      changedFiles: [
        { path: `${P}\\src\\core\\scheduler\\run.ts`, additions: 12, deletions: 4, isNew: false, lastToolUseId: 'tu-tour-edit' },
        { path: `${P}\\tests\\unit\\platform\\scheduler-clockin.test.ts`, additions: 19, deletions: 0, isNew: true, lastToolUseId: 'tu-tour-write' },
      ],
    }),
    session({
      id: 's-tour-explore',
      title: 'Map the GPU clock-in API',
      kind: 'subagent',
      parentSessionId: 's-tour',
      parentToolUseId: 'tu-tour-task',
      createdAt: now - 60 * MIN + 14_000,
      updatedAt: now - 60 * MIN + 58_000,
      thinking: false,
      messages: exploreMessages(now - 60 * MIN + 14_000),
    }),
    session({
      id: 's-tour-perm',
      title: 'Rename GPU phase labels',
      createdAt: now - 3 * MIN,
      updatedAt: now - 40_000,
      status: 'waiting',
      model: LOCAL,
      usage: { inputTokens: 9_800, outputTokens: 240, lastPromptTokens: 9_800, requests: 1 },
      messages: PERM_MSGS,
    }),
    session({
      id: 's-tour-error',
      title: 'Benchmark GLM-5.3 Flash vs Qwen3.8',
      createdAt: now - 12 * MIN,
      updatedAt: now - 11 * MIN,
      status: 'error',
      model: LOCAL,
      usage: { inputTokens: 6_100, outputTokens: 180, lastPromptTokens: 58_900, requests: 1 },
      messages: errorMessages(now - 12 * MIN),
    }),
  ],
  pending: { permissions: [tourPerm], questions: [], plans: [] },
}));

registerDemoData((d) => ({
  fileContents: {
    ...d.fileContents,
    [`${P}\\.git\\HEAD`]: 'ref: refs/heads/feat/chat-ui\n',
  },
}));

// The failed turn shows the banner with the core's error text.
useChatLocal.setState((s) => ({
  errors: {
    ...s.errors,
    's-tour-error': { message: 'llama-server: prompt of 66,104 tokens exceeds the context window (65,536). Run /compact or pick a model with a larger context.', at: now - 11 * MIN },
  },
}));

// Resolve the seeded Edit permission with a real diff instead of the generic seeded-Bash follow-up.
registerDemoHandler('chat.respondPermission', async (params, ctx) => {
  if (params.requestId !== 'perm-tour-edit') return (await ctx.fallback()) as { ok: true };
  ctx.data.pending.permissions = ctx.data.pending.permissions.filter((r) => r.requestId !== params.requestId);
  ctx.emit('permission.resolved', { requestId: params.requestId, sessionId: 's-tour-perm', decision: params.decision });
  const s = ctx.getSession('s-tour-perm');
  const m = s.messages.find((x) => x.id === 'm-tp-2');
  if (m) {
    void (async () => {
      ctx.updateSession(s.id, { status: 'running' });
      const t = m.blocks[2] as ToolUseBlock;
      const denied = params.decision === 'deny';
      const before = String(t.input.old_string);
      const after = String(t.input.new_string);
      const next: ToolUseBlock = denied
        ? { ...t, status: 'denied', endedAt: Date.now(), result: { content: `User denied${params.message ? `: ${params.message}` : ''}`, isError: true } }
        : { ...t, status: 'done', endedAt: Date.now(), result: { content: 'Edited', display: { kind: 'diff', path: String(t.input.file_path), before, after } } };
      m.blocks[2] = next;
      ctx.emit('tool.updated', { sessionId: s.id, messageId: m.id, tool: next });
      await ctx.sleep(500);
      const text = denied ? `OK — I left the labels unchanged${params.message ? ` (${params.message})` : ''}.` : 'Renamed. The GPU widget, home card and GPU view all read from this map.';
      m.blocks[3] = { type: 'text', text };
      ctx.emit('message.block', { sessionId: s.id, messageId: m.id, blockIndex: 3, block: m.blocks[3] });
      m.meta = { model: LOCAL.model, durationMs: 9_000 };
      ctx.emit('message.completed', { sessionId: s.id, messageId: m.id, meta: m.meta });
      if (!denied) {
        s.changedFiles = [{ path: String(t.input.file_path), additions: 1, deletions: 1, isNew: false, lastToolUseId: t.id }];
        ctx.emit('changes.updated', { sessionId: s.id, changedFiles: s.changedFiles });
      }
      ctx.updateSession(s.id, { status: 'idle', updatedAt: Date.now() });
    })();
  }
  return { ok: true as const };
});

// "fail" / "crash" in a prompt simulates a turn that errors out (exercises the error banner + Retry).
registerDemoHandler('chat.send', async (params, ctx) => {
  if (!/\b(fail|crash)\b/i.test(params.text)) return (await ctx.fallback()) as { messageId: string; queued: boolean };
  const s = ctx.getSession(params.sessionId);
  if (s.status === 'running' || s.status === 'waiting') return (await ctx.fallback()) as { messageId: string; queued: boolean };
  const messageId = ctx.newId('m');
  const user: Message = { id: messageId, role: 'user', createdAt: Date.now(), blocks: [{ type: 'text', text: params.text }, ...(params.images ?? [])] };
  s.messages.push(user);
  ctx.emit('message.added', { sessionId: s.id, message: user });
  ctx.updateSession(s.id, { status: 'running', updatedAt: Date.now() });
  void (async () => {
    await ctx.sleep(900);
    ctx.emit('error', { sessionId: s.id, message: 'Connection to the model server was reset (ECONNRESET) after 0.9 s.' });
    ctx.updateSession(s.id, { status: 'error', updatedAt: Date.now() });
  })();
  return { messageId, queued: false };
});
