import { describe, expect, it } from 'vitest';
import type { Session, ToolUseBlock } from '@shared/types';
import { applyDelta, applyToolUpdate, blockKey, createEntry, reduceEntry } from '@renderer/state/transcript';

function session(): Session {
  return {
    id: 's1',
    title: 'T',
    cwd: 'C:\\p',
    kind: 'chat',
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    model: null,
    permissionMode: 'default',
    thinking: true,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    messages: [{ id: 'u1', role: 'user', createdAt: 1, blocks: [{ type: 'text', text: 'hi' }] }],
    todos: [],
    changedFiles: [],
  };
}

const tool = (status: ToolUseBlock['status'], extra: Partial<ToolUseBlock> = {}): ToolUseBlock => ({
  type: 'tool_use',
  id: 'tu1',
  name: 'Read',
  input: { file_path: 'a.ts' },
  status,
  ...extra,
});

describe('transcript reducer', () => {
  it('tracks prefill progress for the pending assistant message and clears it on the first token', () => {
    let e = createEntry(session());
    e = reduceEntry(e, 'message.added', { sessionId: 's1', message: { id: 'a1', role: 'assistant', createdAt: 2, blocks: [] } });
    expect(e.prefill).toBeNull();
    e = reduceEntry(e, 'message.progress', { sessionId: 's1', messageId: 'a1', phase: 'prefill', progress: 0.42, processed: 2048, total: 4906 });
    expect(e.prefill).toEqual({ messageId: 'a1', progress: 0.42, processed: 2048, total: 4906 });
    e = reduceEntry(e, 'message.progress', { sessionId: 's1', messageId: 'a1', phase: 'prefill', progress: 7 });
    expect(e.prefill?.progress).toBe(1);
    e = reduceEntry(e, 'message.delta', { sessionId: 's1', messageId: 'a1', blockIndex: 0, blockType: 'thinking', delta: 'Hm' }, 10);
    expect(e.prefill).toBeNull();
    // late progress after content is ignored
    e = reduceEntry(e, 'message.progress', { sessionId: 's1', messageId: 'a1', phase: 'prefill', progress: 1 });
    expect(e.prefill).toBeNull();
    // a stopped session drops any progress
    e = reduceEntry(e, 'message.added', { sessionId: 's1', message: { id: 'a2', role: 'assistant', createdAt: 3, blocks: [] } });
    e = reduceEntry(e, 'message.progress', { sessionId: 's1', messageId: 'a2', phase: 'prefill', progress: 0.1 });
    expect(e.prefill?.messageId).toBe('a2');
    e = reduceEntry(e, 'session.reset', { sessionId: 's1' });
    expect(e.prefill).toBeNull();
  });

  it('adds messages and replaces duplicates by id', () => {
    let e = createEntry(session());
    e = reduceEntry(e, 'message.added', { sessionId: 's1', message: { id: 'a1', role: 'assistant', createdAt: 2, blocks: [] } });
    expect(e.session.messages).toHaveLength(2);
    expect(e.streamingMessageId).toBe('a1');
    e = reduceEntry(e, 'message.added', { sessionId: 's1', message: { id: 'a1', role: 'assistant', createdAt: 2, blocks: [{ type: 'text', text: 'x' }] } });
    expect(e.session.messages).toHaveLength(2);
    expect(e.session.messages[1].blocks).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('streams deltas into new and existing blocks and tracks block timing', () => {
    let e = createEntry(session());
    e = reduceEntry(e, 'message.added', { sessionId: 's1', message: { id: 'a1', role: 'assistant', createdAt: 2, blocks: [] } });
    e = reduceEntry(e, 'message.delta', { sessionId: 's1', messageId: 'a1', blockIndex: 0, blockType: 'thinking', delta: 'Let me ' }, 100);
    e = reduceEntry(e, 'message.delta', { sessionId: 's1', messageId: 'a1', blockIndex: 0, blockType: 'thinking', delta: 'think' }, 150);
    e = reduceEntry(e, 'message.delta', { sessionId: 's1', messageId: 'a1', blockIndex: 1, blockType: 'text', delta: 'Done' }, 400);
    const blocks = e.session.messages[1].blocks;
    expect(blocks[0]).toEqual({ type: 'thinking', text: 'Let me think' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'Done' });
    expect(e.blockStarts[blockKey('a1', 0)]).toBe(100);
    expect(e.blockEnds[blockKey('a1', 0)]).toBe(400);
    e = reduceEntry(e, 'message.completed', { sessionId: 's1', messageId: 'a1', meta: { durationMs: 900 } }, 500);
    expect(e.blockEnds[blockKey('a1', 1)]).toBe(500);
    expect(e.streamingMessageId).toBeNull();
    expect(e.session.messages[1].meta?.durationMs).toBe(900);
  });

  it('does not clobber a tool block with a text delta at the same index', () => {
    const s = session();
    s.messages.push({ id: 'a1', role: 'assistant', createdAt: 2, blocks: [tool('running')] });
    const next = applyDelta(s, { sessionId: 's1', messageId: 'a1', blockIndex: 0, blockType: 'text', delta: 'x' });
    expect(next.messages[1].blocks[0].type).toBe('tool_use');
    expect(next.messages[1].blocks[1]).toEqual({ type: 'text', text: 'x' });
  });

  it('replaces whole blocks with message.block (gaps filled)', () => {
    let e = createEntry(session());
    e = reduceEntry(e, 'message.added', { sessionId: 's1', message: { id: 'a1', role: 'assistant', createdAt: 2, blocks: [] } });
    e = reduceEntry(e, 'message.block', { sessionId: 's1', messageId: 'a1', blockIndex: 2, block: tool('pending') });
    expect(e.session.messages[1].blocks).toHaveLength(3);
    expect(e.session.messages[1].blocks[2]).toMatchObject({ type: 'tool_use', status: 'pending' });
  });

  it('updates tools by id in the named message, anywhere, or appends', () => {
    const s = session();
    s.messages.push({ id: 'a1', role: 'assistant', createdAt: 2, blocks: [tool('running', { startedAt: 5 })] });
    let n = applyToolUpdate(s, { sessionId: 's1', messageId: 'a1', tool: tool('done', { result: { content: 'ok' } }) });
    expect(n.messages[1].blocks[0]).toMatchObject({ status: 'done', startedAt: 5, result: { content: 'ok' } });
    // wrong message id → found elsewhere
    n = applyToolUpdate(n, { sessionId: 's1', messageId: 'nope', tool: tool('error') });
    expect(n.messages[1].blocks[0]).toMatchObject({ status: 'error' });
    // unseen tool in an existing message → appended
    n = applyToolUpdate(n, { sessionId: 's1', messageId: 'a1', tool: { ...tool('running'), id: 'tu2' } });
    expect(n.messages[1].blocks).toHaveLength(2);
  });

  it('applies todos, changes, summaries and resets', () => {
    let e = createEntry(session());
    e = reduceEntry(e, 'todos.updated', { sessionId: 's1', todos: [{ id: 't', content: 'x', status: 'pending' }] });
    e = reduceEntry(e, 'changes.updated', { sessionId: 's1', changedFiles: [{ path: 'a', additions: 1, deletions: 0, isNew: true, lastToolUseId: 'tu' }] });
    expect(e.session.todos).toHaveLength(1);
    expect(e.session.changedFiles).toHaveLength(1);
    const { messages: _m, todos: _t, changedFiles: _c, ...summary } = e.session;
    e = reduceEntry(e, 'session.updated', { ...summary, title: 'Renamed', status: 'running' });
    expect(e.session.title).toBe('Renamed');
    expect(e.session.messages).toHaveLength(1);
    expect(e.session.todos).toHaveLength(1);
    e = reduceEntry(e, 'session.reset', { sessionId: 's1' });
    expect(e.stale).toBe(true);
  });

  it('returns the same session object for events targeting unknown messages', () => {
    const s = session();
    expect(applyDelta(s, { sessionId: 's1', messageId: 'x', blockIndex: 0, blockType: 'text', delta: 'a' })).toBe(s);
  });
});
