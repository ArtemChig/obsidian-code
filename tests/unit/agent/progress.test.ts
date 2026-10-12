// Prefill progress: llama.cpp prompt_progress chunks → 'message.progress' events for the pending assistant message.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, toolLog, type Harness } from './helpers';

let h: Harness;
afterEach(async () => { await h?.close(); toolLog.length = 0; });

describe('prefill progress', () => {
  it('emits message.progress for the pending assistant message before its first token', async () => {
    h = await createHarness();
    const s = h.createSession();
    h.mock.enqueue({ progress: true, text: 'Hi.' });
    await h.agent.send(s.id, 'Say hi');
    await h.waitIdle(s.id);
    const progress = h.eventsOf('message.progress');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    const assistant = h.session(s.id).messages.find((m) => m.role === 'assistant')!;
    for (const p of progress) {
      expect(p).toMatchObject({ sessionId: s.id, messageId: assistant.id, phase: 'prefill', total: 100 });
      expect(p.progress).toBeGreaterThanOrEqual(0);
      expect(p.progress).toBeLessThanOrEqual(1);
    }
    // the final (complete) progress is never throttled away
    expect(progress.at(-1)!.progress).toBe(1);
    // and every progress event precedes the first streamed delta
    const order = h.events.map((e) => e.event);
    expect(order.lastIndexOf('message.progress')).toBeLessThan(order.indexOf('message.delta'));
  });
});
