// UX review fixes, end to end through the stores and the demo core: shared clock-out confirmation, withdrawing
// queued follow-ups, Retry/Regenerate without duplicate prompts, and per-resource refetch errors.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RpcMethod } from '@shared/protocol';
import { createDemoTransport } from '@renderer/lib/demo';
import { rpc, type RpcTransport } from '@renderer/lib/rpc';
import { createSession, requestClockOut, resendFrom, sendMessage, withdrawQueued } from '@renderer/state/actions';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';
import { useSessions } from '@renderer/state/sessions';
import { bindEvents, refetchAll } from '@renderer/state/sync';
import { useToasts } from '@renderer/state/toasts';

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let demo: ReturnType<typeof createDemoTransport>;
const failing = new Set<RpcMethod>();

describe('UX flows with the demo core', () => {
  beforeAll(async () => {
    bindEvents();
    demo = createDemoTransport({ latencyMs: 0, speed: 0 });
    // Same transport, but chosen methods can be made to fail.
    const wrapped = new Proxy(demo, {
      get(target, prop, receiver) {
        if (prop === 'request') {
          return (method: RpcMethod, params: never, opts?: never) =>
            failing.has(method) ? Promise.reject(new Error(`${method} failed: corrupt file`)) : target.request(method, params, opts);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as RpcTransport;
    rpc.setTransport(wrapped);
    demo.connect();
    await waitFor(() => useConnection.getState().ready);
  });

  it('clock-out from any entry point asks first while a session runs on the GPU', async () => {
    expect(useGpu.getState().status?.phase).toBe('ready');
    const bench = Object.values(useSessions.getState().sessions).find((s) => s.model?.provider === 'vast' && s.kind === 'chat');
    expect(bench).toBeTruthy();
    useSessions.setState((st) => ({ sessions: { ...st.sessions, [bench!.id]: { ...bench!, status: 'running' } } }));
    expect(await requestClockOut()).toBe(false);
    expect(useGpu.getState().confirm?.kind).toBe('running');
    expect(useGpu.getState().confirm?.sessions).toContain(bench!.title);
    expect(useGpu.getState().status?.phase).toBe('ready'); // nothing happened yet
    useGpu.setState({ confirm: null });
    useSessions.setState((st) => ({ sessions: { ...st.sessions, [bench!.id]: { ...bench!, status: 'idle' } } }));
  });

  it('a queued follow-up can be withdrawn and never runs', async () => {
    const s = await createSession({ cwd: 'C:\\proj' });
    await waitFor(() => !!useSessions.getState().transcripts[s!.id]);
    await sendMessage(s!.id, 'Add backoff to the client');
    await waitFor(() => useSessions.getState().sessions[s!.id]?.status === 'running');
    const q = await sendMessage(s!.id, 'then delete the old client');
    expect(q?.queued).toBe(true);
    expect(useSessions.getState().queued[s!.id]).toHaveLength(1);
    const withdrawn = await withdrawQueued(s!.id, q!.messageId);
    expect(withdrawn.map((w) => w.text)).toEqual(['then delete the old client']);
    expect(useSessions.getState().queued[s!.id]).toBeUndefined();
    await waitFor(() => useSessions.getState().sessions[s!.id]?.status === 'idle');
    await new Promise((r) => setTimeout(r, 50));
    const users = useSessions.getState().transcripts[s!.id].session.messages.filter((m) => m.role === 'user');
    expect(users.map((m) => m.id)).not.toContain(q!.messageId);
  });

  it('Retry / Regenerate re-sends the prompt once instead of appending a duplicate', async () => {
    const s = await createSession({ cwd: 'C:\\proj' });
    await waitFor(() => !!useSessions.getState().transcripts[s!.id]);
    await sendMessage(s!.id, '/cost');
    await waitFor(() => (useSessions.getState().transcripts[s!.id]?.session.messages.length ?? 0) >= 2 && useSessions.getState().sessions[s!.id]?.status === 'idle');
    const first = useSessions.getState().transcripts[s!.id].session.messages.find((m) => m.role === 'user')!;
    for (let i = 0; i < 2; i++) {
      const r = await resendFrom(s!.id, useSessions.getState().transcripts[s!.id].session.messages.find((m) => m.role === 'user')!.id);
      expect(r.ok).toBe(true);
      await waitFor(() => useSessions.getState().sessions[s!.id]?.status === 'idle' && (useSessions.getState().transcripts[s!.id]?.session.messages.length ?? 0) >= 2);
    }
    const users = useSessions.getState().transcripts[s!.id].session.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].blocks).toEqual(first.blocks);
  });

  it('a refetch that cannot load some resources records them and says so', async () => {
    failing.add('gpu.status');
    failing.add('schedules.list');
    try {
      await refetchAll();
      expect(useConnection.getState().syncErrors).toEqual({ gpu: 'gpu.status failed: corrupt file', schedules: 'schedules.list failed: corrupt file' });
      expect(useToasts.getState().toasts.some((t) => t.title === 'Could not load GPU status, scheduled tasks')).toBe(true);
    } finally {
      failing.clear();
    }
    await refetchAll();
    expect(useConnection.getState().syncErrors).toEqual({});
  });
});
