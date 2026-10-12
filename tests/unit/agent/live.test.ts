// Live end-to-end check against the user's local llama-server (http://127.0.0.1:8080).
// Skipped when OFFLINE=1 or the server is unreachable. ONE request at a time, short prompt, thinking off,
// generous timeout (~20 tok/s; the server is shared with another app).

import { afterAll, describe, expect, it } from 'vitest';
import type { ToolDef } from '@core/contracts';
import type { ToolUseBlock } from '@shared/types';
import { createHarness, type Harness } from './helpers';

const LIVE_URL = 'http://127.0.0.1:8080';

async function reachable(): Promise<boolean> {
  if (process.env.OFFLINE === '1') return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${LIVE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const addNumbers: ToolDef = {
  name: 'add_numbers',
  description: 'Add two numbers and return the sum.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  concurrencySafe: true,
  permission: () => 'none',
  title: (i) => `add ${String(i.a)} + ${String(i.b)}`,
  async run(input) {
    return { content: String(Number(input.a) + Number(input.b)) };
  },
};

let h: Harness | undefined;
afterAll(async () => { await h?.close(); });

describe('live local llama-server', () => {
  it('agent loop with native tool calling end-to-end (2 model turns) .live', async (t) => {
    if (!(await reachable())) { t.skip(); return; }
    h = await createHarness({ tools: [addNumbers], localBaseUrl: LIVE_URL, idleTimeoutMs: 180_000 });
    const local = h.registry.providers().find((p) => p.id === 'local');
    if (local?.status !== 'online') { t.skip(); return; }
    // non-default title → no title-generation request; thinking off for speed
    const s = h.createSession({ title: 'live test', thinking: false });
    await h.agent.send(s.id, 'Use the add_numbers tool to add 17 and 25, then reply with just the result.');
    await h.waitIdle(s.id, 280_000);
    const session = h.session(s.id);
    const calls = session.messages.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
    expect(session.status, h.eventsOf('error').map((e) => e.message).join('; ')).toBe('idle');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.name).toBe('add_numbers');
    expect(calls[0]!.status).toBe('done');
    expect(Number(calls[0]!.input.a) + Number(calls[0]!.input.b)).toBe(42);
    expect(calls[0]!.result?.content).toBe('42');
    const final = session.messages.at(-1)!;
    expect(final.role).toBe('assistant');
    const text = final.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    expect(text).toContain('42');
    expect(session.usage.requests).toBeGreaterThanOrEqual(2);
    expect(session.usage.lastPromptTokens).toBeGreaterThan(0);
  }, 300_000);
});
