// Store integration: the rpc facade + demo transport drive the zustand stores through state/sync.ts and actions.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Block, PermissionRequest, QuestionRequest } from '@shared/types';
import { createDemoTransport } from '@renderer/lib/demo';
import { rpc } from '@renderer/lib/rpc';
import {
  answerQuestion,
  clockOut,
  createSession,
  deleteSession,
  openSession,
  renameSession,
  respondPermission,
  sendMessage,
  setPinned,
  toggleRightPanel,
  toggleSidebar,
} from '@renderer/state/actions';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';
import { useModels } from '@renderer/state/models';
import { usePending } from '@renderer/state/pending';
import { useSessions } from '@renderer/state/sessions';
import { useSettings } from '@renderer/state/settings';
import { bindEvents } from '@renderer/state/sync';
import { useToasts } from '@renderer/state/toasts';
import { useUi } from '@renderer/state/ui';

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('state sync with the demo core', () => {
  beforeAll(async () => {
    bindEvents();
    const t = createDemoTransport({ latencyMs: 0, speed: 0 });
    rpc.setTransport(t);
    t.connect();
    await waitFor(() => useConnection.getState().ready);
  });

  it('fetches the full state on connect', () => {
    expect(useConnection.getState().state.status).toBe('open');
    expect(Object.keys(useSessions.getState().sessions).length).toBeGreaterThan(5);
    expect(useSessions.getState().sessions['s-sse-explore']?.kind).toBe('subagent');
    expect(useModels.getState().models.length).toBeGreaterThan(0);
    expect(useGpu.getState().status?.phase).toBe('ready');
    expect(useGpu.getState().hasApiKey).toBe(true);
    expect(useSettings.getState().settings?.vast.profiles.length).toBe(3);
    expect(Object.keys(usePending.getState().permissions)).toContain('perm-demo-1');
  });

  it('creates, opens and streams a session into the transcript store', async () => {
    const s = await createSession({ cwd: 'C:\\proj' });
    expect(s).not.toBeNull();
    expect(useSessions.getState().activeSessionId).toBe(s!.id);
    await waitFor(() => !!useSessions.getState().transcripts[s!.id]);
    const r = await sendMessage(s!.id, 'Add backoff to the client');
    expect(r?.queued).toBe(false);
    await waitFor(() => useSessions.getState().sessions[s!.id]?.status === 'idle' && (useSessions.getState().transcripts[s!.id]?.session.messages.length ?? 0) >= 2);
    const entry = useSessions.getState().transcripts[s!.id];
    const assistant = entry.session.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.blocks.find((b: Block) => b.type === 'thinking')).toBeTruthy();
    expect(assistant.blocks.some((b: Block) => b.type === 'tool_use' && b.status === 'done')).toBe(true);
    expect(entry.session.todos.length).toBe(3);
    expect(entry.session.changedFiles.length).toBe(1);
    expect(entry.streamingMessageId).toBeNull();
    expect(useSessions.getState().sessions[s!.id].title).toBe('Add backoff to the client');
  });

  it('marks background sessions unread and clears on open', async () => {
    const bg = await createSession({ cwd: 'C:\\bg', open: false });
    await sendMessage(bg!.id, '/cost');
    await waitFor(() => !!useSessions.getState().unread[bg!.id]);
    openSession(bg!.id);
    expect(useSessions.getState().unread[bg!.id]).toBeUndefined();
  });

  it('pending requests are added by events and removed optimistically', async () => {
    const s = await createSession({ cwd: 'C:\\q' });
    await sendMessage(s!.id, 'which approach do you prefer? ask me');
    const questions = () => Object.values(usePending.getState().questions as Record<string, QuestionRequest>);
    await waitFor(() => questions().some((q) => q.sessionId === s!.id));
    const q = questions().find((x) => x.sessionId === s!.id)!;
    expect(await answerQuestion(q.requestId, { 'Which approach should I take?': 'Minimal fix' })).toBe(true);
    expect(usePending.getState().questions[q.requestId]).toBeUndefined();
    await waitFor(() => Object.values(usePending.getState().permissions as Record<string, PermissionRequest>).some((p) => p.sessionId === s!.id) || useSessions.getState().sessions[s!.id]?.status === 'idle');
    await respondPermission('perm-demo-1', 'deny');
    expect(usePending.getState().permissions['perm-demo-1']).toBeUndefined();
  });

  it('rename / pin / delete update the store', async () => {
    const s = await createSession({ cwd: 'C:\\r', open: false });
    await renameSession(s!.id, '  Better title ');
    expect(useSessions.getState().sessions[s!.id].title).toBe('Better title');
    await setPinned(s!.id, true);
    expect(useSessions.getState().sessions[s!.id].pinned).toBe(true);
    expect(await deleteSession(s!.id)).toBe(true);
    await waitFor(() => !useSessions.getState().sessions[s!.id]);
  });

  it('gpu status events update the store; notifications become toasts', async () => {
    await clockOut();
    await waitFor(() => useGpu.getState().status?.phase === 'off');
    await waitFor(() => useToasts.getState().toasts.some((t: { title: string }) => t.title === 'Clocked out'));
  });

  it('ui actions toggle layout state', () => {
    const before = useUi.getState().sidebarCollapsed;
    toggleSidebar();
    expect(useUi.getState().sidebarCollapsed).toBe(!before);
    toggleRightPanel(true);
    expect(useUi.getState().rightPanelOpen).toBe(true);
  });

  it('failed actions resolve to null and show an error toast', async () => {
    const r = await renameSession('does-not-exist', 'x');
    expect(r).toBeNull();
    expect(useToasts.getState().toasts.some((t: { level: string }) => t.level === 'error')).toBe(true);
  });
});
