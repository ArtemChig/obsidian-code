// UX review fixes: money/data guards and resilience helpers (pure functions).
import { describe, expect, it } from 'vitest';
import type { GpuStatus, Message, ModelInfo, ProviderInfo, SessionSummary } from '@shared/types';
import { exportFileName, transcriptMarkdown } from '@renderer/features/chat/lib/export';
import { absolutePath, isDisposableSession, REVEAL_STEP, TRANSCRIPT_WINDOW, windowStart } from '@renderer/features/chat/lib/session';
import { clockOutPrompt, gpuHoldsInstance } from '@renderer/state/gpu';
import { modelReadiness } from '@renderer/state/selectors';
import { reconcileQueued } from '@renderer/state/sessions';
import { syncErrorsOf } from '@renderer/state/sync';
import { clampPanelWidth, effectivePanelWidth, MAIN_MIN_W, SIDEBAR_W } from '@renderer/state/ui';

const gpu = (over: Partial<GpuStatus> = {}): GpuStatus => ({ phase: 'off', message: '', sessionCost: 0, monthCost: 0, monthlyBudget: 200, steps: [], ...over });

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    title: 'Bench',
    cwd: 'C:\\proj',
    kind: 'chat',
    createdAt: 0,
    updatedAt: 0,
    status: 'idle',
    model: { provider: 'vast', model: 'qwen' },
    permissionMode: 'default',
    thinking: false,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    ...over,
  };
}

describe('GPU guards', () => {
  it('gpuHoldsInstance: rented (any active phase), a leftover instance id, or parked', () => {
    expect(gpuHoldsInstance(gpu())).toBe(false);
    expect(gpuHoldsInstance(gpu({ phase: 'ready', instanceId: 1 }))).toBe(true);
    expect(gpuHoldsInstance(gpu({ phase: 'downloading' }))).toBe(true);
    expect(gpuHoldsInstance(gpu({ phase: 'error', instanceId: 7 }))).toBe(true); // destroy not confirmed
    expect(gpuHoldsInstance(gpu({ phase: 'error' }))).toBe(false);
    expect(gpuHoldsInstance(gpu({ parked: { instanceId: 3, profileId: 'light', modelId: 'm', gpuName: 'g', storageCostPerHour: 0.01, parkedAt: 0 } }))).toBe(true);
  });

  it('clockOutPrompt: confirm when sessions run on the GPU or a rented clock-in would be cancelled', () => {
    const running = session({ status: 'running' });
    expect(clockOutPrompt(gpu({ phase: 'ready', instanceId: 1 }), [running], undefined)).toEqual({ kind: 'running', sessions: ['Bench'], spent: 0 });
    // the default model counts when the session has none
    expect(clockOutPrompt(gpu({ phase: 'ready' }), [session({ status: 'waiting', model: null })], 'vast')?.kind).toBe('running');
    // nothing on the GPU → straight through
    expect(clockOutPrompt(gpu({ phase: 'ready' }), [session(), session({ status: 'running', model: { provider: 'local', model: 'x' } })], 'vast')).toBeNull();
    expect(clockOutPrompt(gpu({ phase: 'ready' }), [session({ status: 'running', kind: 'subagent' })], undefined)).toBeNull();
    // cancelling a paid-for download / rented instance asks first; a search that rented nothing does not
    expect(clockOutPrompt(gpu({ phase: 'downloading', instanceId: 9, sessionCost: 0.12 }), [], undefined)).toEqual({ kind: 'cancel', sessions: [], spent: 0.12 });
    expect(clockOutPrompt(gpu({ phase: 'connecting', instanceId: 9 }), [], undefined)?.kind).toBe('cancel');
    expect(clockOutPrompt(gpu({ phase: 'searching' }), [], undefined)).toBeNull();
    expect(clockOutPrompt(gpu({ phase: 'renting' }), [], undefined)).toBeNull();
    expect(clockOutPrompt(null, [running], 'vast')).toBeNull();
  });
});

describe('queued follow-up chips', () => {
  const q = [
    { messageId: 'a', text: '/clear', at: 1 },
    { messageId: 'b', text: 'then run the tests', at: 2 },
  ];
  it('drops chips whose message arrived, and all chips once the session is idle', () => {
    expect(reconcileQueued(q, new Set(['a']), true)).toEqual([q[1]]);
    expect(reconcileQueued(q, new Set(), true)).toEqual(q);
    // idle: the core drained its queue (a queued /clear never adds its message; a restarted core has no queue)
    expect(reconcileQueued(q, new Set(), false)).toEqual([]);
    expect(reconcileQueued(undefined, new Set(), true)).toEqual([]);
  });
});

describe('right panel width', () => {
  it('never squeezes the chat column below its minimum', () => {
    expect(effectivePanelWidth(340, 1440, SIDEBAR_W)).toBe(340);
    // 640 px saved on a big monitor, window at the app minimum (960): the chat keeps MAIN_MIN_W
    expect(effectivePanelWidth(640, 960, SIDEBAR_W)).toBe(960 - SIDEBAR_W - MAIN_MIN_W);
    expect(960 - SIDEBAR_W - effectivePanelWidth(640, 960, SIDEBAR_W)).toBeGreaterThanOrEqual(MAIN_MIN_W);
    expect(effectivePanelWidth(640, 600, SIDEBAR_W)).toBe(200); // tiny window: a usable floor
    expect(clampPanelWidth(9999)).toBe(640);
    expect(clampPanelWidth('junk')).toBe(340);
  });
});

describe('state refetch errors', () => {
  it('records every failed resource, not only sessions', () => {
    const ok = { status: 'fulfilled', value: 1 } as const;
    const bad = (m: string) => ({ status: 'rejected', reason: new Error(m) }) as const;
    expect(syncErrorsOf({ sessions: ok, gpu: bad('ledger corrupt'), settings: ok, activity: bad('x'), schedules: ok, models: ok })).toEqual({
      gpu: 'ledger corrupt',
      activity: 'x',
    });
    expect(syncErrorsOf({ sessions: ok })).toEqual({});
  });
});

describe('model readiness before Send', () => {
  const providers: ProviderInfo[] = [
    { id: 'local', label: 'Local', status: 'offline', baseUrl: 'http://127.0.0.1:8080' },
    { id: 'vast', label: 'Vast GPU', status: 'offline', baseUrl: null },
    { id: 'custom:lab', label: 'Lab', status: 'online', baseUrl: 'http://lab' },
  ];
  const model = (provider: ModelInfo['ref']['provider'], id: string, status: ModelInfo['status']): ModelInfo => ({
    ref: { provider, model: id },
    label: id,
    contextLength: 32768,
    supportsVision: false,
    supportsTools: true,
    supportsThinking: true,
    status,
  });
  const models = [model('local', 'qwen-local', 'offline'), model('custom:lab', 'lab-model', 'online')];

  it('warns before sending to an offline model, with the fix to offer', () => {
    expect(modelReadiness({ provider: 'local', model: 'qwen-local' }, null, models, providers, 'off')).toEqual({
      message: "The local model server isn't reachable at http://127.0.0.1:8080.",
      action: 'settings',
    });
    expect(modelReadiness({ provider: 'vast', model: 'q' }, null, models, providers, 'off')?.action).toBe('clock-in');
    expect(modelReadiness({ provider: 'vast', model: 'q' }, null, models, providers, 'downloading')?.action).toBe('gpu');
    expect(modelReadiness({ provider: 'custom:lab', model: 'lab-model' }, null, models, providers, 'off')).toBeNull();
    expect(modelReadiness({ provider: 'custom:lab', model: 'gone' }, null, models, providers, 'off')?.action).toBe('switch');
    // no model on the session → the default model is checked
    expect(modelReadiness(null, { provider: 'local', model: 'qwen-local' }, models, providers, 'off')?.action).toBe('settings');
    // no default either: fine while anything is online
    expect(modelReadiness(null, null, models, providers, 'off')).toBeNull();
    expect(modelReadiness(null, null, [models[0]], providers, 'off')?.message).toBe('No model is online.');
    // nothing loaded yet → no warning
    expect(modelReadiness({ provider: 'local', model: 'x' }, null, [], [], undefined)).toBeNull();
  });
});

describe('chat helpers', () => {
  it('a session is replaced on folder change only when provably empty', () => {
    expect(isDisposableSession(session(), [], 0)).toBe(true);
    // transcript not loaded (or failed to load): never treated as empty
    expect(isDisposableSession(session(), undefined, 0)).toBe(false);
    expect(isDisposableSession(session({ usage: { inputTokens: 1, outputTokens: 1, lastPromptTokens: 1, requests: 3 } }), [], 0)).toBe(false);
    expect(isDisposableSession(session(), [{ id: 'm', role: 'user', createdAt: 0, blocks: [] }], 0)).toBe(false);
    expect(isDisposableSession(session(), [], 1)).toBe(false);
    expect(isDisposableSession(session({ status: 'running' }), [], 0)).toBe(false);
  });

  it('absolutePath joins cwd-relative paths', () => {
    expect(absolutePath('src\\a.ts', 'C:\\proj')).toBe('C:\\proj\\src\\a.ts');
    expect(absolutePath('./src/a.ts', 'C:\\proj\\')).toBe('C:\\proj\\src\\a.ts');
    expect(absolutePath('D:\\x\\b.ts', 'C:\\proj')).toBe('D:\\x\\b.ts');
    expect(absolutePath('lib/c.ts', '/home/u/p')).toBe('/home/u/p/lib/c.ts');
  });

  it('"Show earlier" reveals older messages in chunks', () => {
    expect(windowStart(50, 0)).toBe(0);
    expect(windowStart(1000, 0)).toBe(1000 - TRANSCRIPT_WINDOW);
    expect(windowStart(1000, REVEAL_STEP)).toBe(1000 - TRANSCRIPT_WINDOW - REVEAL_STEP);
    expect(windowStart(1000, 10 * REVEAL_STEP)).toBe(0);
  });

  it('exports a transcript as Markdown', () => {
    const messages: Message[] = [
      { id: 'h', role: 'user', tag: 'hook', createdAt: 0, blocks: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] },
      { id: 'u', role: 'user', createdAt: 0, blocks: [{ type: 'text', text: 'Fix the bug' }] },
      {
        id: 'a',
        role: 'assistant',
        createdAt: 0,
        blocks: [
          { type: 'thinking', text: 'secret musing' },
          { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' }, status: 'done' },
          { type: 'text', text: 'Fixed it.' },
        ],
      },
    ];
    const md = transcriptMarkdown(session({ title: 'Fix: the bug?' }), messages, Date.UTC(2026, 9, 12));
    expect(md).toContain('# Fix: the bug?');
    expect(md).toContain('## You\n\nFix the bug');
    expect(md).toContain('- **Bash** `npm test` — done');
    expect(md).toContain('Fixed it.');
    expect(md).not.toContain('secret musing');
    expect(md).not.toContain('system-reminder');
    expect(exportFileName('Fix: the bug?')).toBe('Fix the bug.md');
  });
});
