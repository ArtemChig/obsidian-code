// Live end-to-end check of the claude-code engine: the real Claude Code harness (Agent SDK → bundled claude.exe)
// against the user's local llama-server (http://127.0.0.1:8080). Skipped when OFFLINE=1 or the server is unreachable.
// Two turns, one request at a time (the server is shared and slow): a plain reply, then one Read tool call.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Message, ToolUseBlock } from '@shared/types';
import { ClaudeCodeEngine } from '@core/engine/claude-code/engine';
import { AnthropicShim } from '@core/engine/shim';
import { createHarness, type Harness } from '../agent/helpers';

const LIVE_URL = 'http://127.0.0.1:8080';

async function reachable(): Promise<boolean> {
  if (process.env.OFFLINE === '1') return false;
  try {
    const res = await fetch(`${LIVE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const live = await reachable();
const text = (m: Message | undefined) => (m?.blocks ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

describe.skipIf(!live)('claude-code engine (live, local llama-server)', () => {
  let h: Harness | undefined;
  let engine: ClaudeCodeEngine | undefined;
  const requests: { path: string; cls?: string; status?: number }[] = [];
  afterAll(async () => {
    engine?.dispose();
    await h?.close();
  });

  it('runs a 2-turn session (reply + Read tool) entirely on the local endpoint', async () => {
    h = await createHarness({ localBaseUrl: LIVE_URL, idleTimeoutMs: 600_000 });
    writeFileSync(join(h.cwd, 'a.txt'), 'alpha beta\n');
    const shim = new AnthropicShim();
    shim.onRequest = (r) => requests.push({ path: r.path, cls: r.requestClass, status: r.status });
    engine = new ClaudeCodeEngine(h.ctx, { shim, idleCloseMs: 60_000 });
    // non-default title: no extra title request (keeps it to one request at a time on the shared server)
    const s = h.createSession({ engine: 'claude-code', thinking: false, title: 'live claude-code', permissionMode: 'default' });

    await engine.send(s.id, 'Reply with exactly: hello');
    await h.until(() => !engine!.isRunning(s.id), 600_000, 'turn 1');
    const s1 = h.session(s.id);
    expect(s1.status).not.toBe('error');
    const reply1 = [...s1.messages].reverse().find((m) => m.role === 'assistant');
    expect(text(reply1).toLowerCase()).toContain('hello');

    await engine.send(s.id, 'Use the Read tool to read the file a.txt in the working directory, then reply with its content only.');
    await h.until(() => !engine!.isRunning(s.id), 600_000, 'turn 2');
    const s2 = h.session(s.id);
    expect(s2.status).not.toBe('error');
    const tools = s2.messages.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
    const read = tools.find((t) => t.name === 'Read');
    expect(read?.status).toBe('done');
    expect(read?.result?.display?.kind).toBe('file');
    const reply2 = [...s2.messages].reverse().find((m) => m.role === 'assistant' && text(m).trim());
    expect(text(reply2).toLowerCase()).toContain('alpha beta');

    // every model call went through the shim to the session's endpoint, and the Claude session was resumed in place
    expect(requests.filter((r) => r.path.startsWith('/v1/messages')).length).toBeGreaterThanOrEqual(3);
    expect(requests.every((r) => (r.status ?? 0) < 500)).toBe(true);
    expect(engine.state(s.id).sdkSessionId).toBeTruthy();
    expect(engine.state(s.id).turns.length).toBe(2);
  }, 1_300_000);
});
