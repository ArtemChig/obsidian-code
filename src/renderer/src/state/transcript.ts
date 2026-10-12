// Pure, immutable transcript reducer: applies core events to a loaded Session. Owner: ui-foundation.
// Unit-tested in tests/unit/ui-foundation/transcript.test.ts.
import type { CoreEvents } from '@shared/protocol';
import type { Block, Message, Session, SessionSummary, ToolUseBlock } from '@shared/types';

/** A loaded transcript plus streaming bookkeeping for live UI (timers, cursors). */
export interface TranscriptEntry {
  session: Session;
  /** Set by 'session.reset' — the UI should refetch (the store does it automatically for the active session). */
  stale: boolean;
  /** Assistant message currently streaming (from its message.added until message.completed). */
  streamingMessageId: string | null;
  /** Epoch ms when each streamed block started: key `${messageId}:${blockIndex}`. Used for live "Thinking 4s" timers. */
  blockStarts: Record<string, number>;
  /** Epoch ms when each streamed block ended (next block started or message completed). */
  blockEnds: Record<string, number>;
}

export function blockKey(messageId: string, blockIndex: number): string {
  return `${messageId}:${blockIndex}`;
}

export function createEntry(session: Session): TranscriptEntry {
  return { session, stale: false, streamingMessageId: null, blockStarts: {}, blockEnds: {} };
}

function updateMessage(session: Session, messageId: string, fn: (m: Message) => Message): Session {
  // Search from the end: events almost always target the latest message.
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].id === messageId) {
      const next = fn(session.messages[i]);
      if (next === session.messages[i]) return session;
      const messages = session.messages.slice();
      messages[i] = next;
      return { ...session, messages };
    }
  }
  return session;
}

export function addMessage(session: Session, message: Message): Session {
  const idx = session.messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const messages = session.messages.slice();
    messages[idx] = message;
    return { ...session, messages };
  }
  return { ...session, messages: [...session.messages, message] };
}

export function applyDelta(session: Session, ev: CoreEvents['message.delta']): Session {
  return updateMessage(session, ev.messageId, (m) => {
    const blocks = m.blocks.slice();
    const existing = blocks[ev.blockIndex];
    if (existing && (existing.type === 'text' || existing.type === 'thinking')) {
      if (existing.type === ev.blockType) {
        blocks[ev.blockIndex] = { ...existing, text: existing.text + ev.delta };
      } else {
        // Type changed (unexpected) — replace with the new type.
        blocks[ev.blockIndex] = { type: ev.blockType, text: ev.delta } as Block;
      }
    } else if (existing) {
      // A non-text block sits at this index: never clobber tool_use/image blocks; append instead.
      blocks.push({ type: ev.blockType, text: ev.delta } as Block);
    } else {
      // New block (fill any gap defensively with empty text blocks so indices line up).
      while (blocks.length < ev.blockIndex) blocks.push({ type: 'text', text: '' });
      blocks[ev.blockIndex] = { type: ev.blockType, text: ev.delta } as Block;
    }
    return { ...m, blocks };
  });
}

export function applyBlock(session: Session, ev: CoreEvents['message.block']): Session {
  return updateMessage(session, ev.messageId, (m) => {
    const blocks = m.blocks.slice();
    while (blocks.length < ev.blockIndex) blocks.push({ type: 'text', text: '' });
    blocks[ev.blockIndex] = ev.block;
    return { ...m, blocks };
  });
}

export function applyCompleted(session: Session, ev: CoreEvents['message.completed']): Session {
  return updateMessage(session, ev.messageId, (m) => ({ ...m, meta: { ...(m.meta ?? {}), ...(ev.meta ?? {}) } }));
}

/** Replace a tool_use block by id. Looks in the named message first, then everywhere; appends if unseen. */
export function applyToolUpdate(session: Session, ev: CoreEvents['tool.updated']): Session {
  const replaceIn = (m: Message): Message | null => {
    const i = m.blocks.findIndex((b) => b.type === 'tool_use' && b.id === ev.tool.id);
    if (i < 0) return null;
    const blocks = m.blocks.slice();
    blocks[i] = mergeTool(blocks[i] as ToolUseBlock, ev.tool);
    return { ...m, blocks };
  };
  const target = session.messages.findIndex((m) => m.id === ev.messageId);
  if (target >= 0) {
    const replaced = replaceIn(session.messages[target]);
    const messages = session.messages.slice();
    if (replaced) {
      messages[target] = replaced;
    } else {
      const m = messages[target];
      messages[target] = { ...m, blocks: [...m.blocks, ev.tool] };
    }
    return { ...session, messages };
  }
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const replaced = replaceIn(session.messages[i]);
    if (replaced) {
      const messages = session.messages.slice();
      messages[i] = replaced;
      return { ...session, messages };
    }
  }
  return session;
}

function mergeTool(prev: ToolUseBlock, next: ToolUseBlock): ToolUseBlock {
  // Keep fields the update omitted (e.g. startedAt) while taking everything new.
  return { ...prev, ...next, input: next.input ?? prev.input };
}

export function applySummary(session: Session, s: SessionSummary): Session {
  return { ...session, ...s, messages: session.messages, todos: session.todos, changedFiles: session.changedFiles };
}

/** Bookkeeping for streaming timers. Returns a new entry. */
export function reduceEntry<E extends keyof CoreEvents>(entry: TranscriptEntry, event: E, data: CoreEvents[E], now: number = Date.now()): TranscriptEntry {
  switch (event) {
    case 'message.added': {
      const ev = data as CoreEvents['message.added'];
      const session = addMessage(entry.session, ev.message);
      const streaming = ev.message.role === 'assistant' && !ev.message.meta?.durationMs ? ev.message.id : entry.streamingMessageId;
      return { ...entry, session, streamingMessageId: streaming };
    }
    case 'message.delta': {
      const ev = data as CoreEvents['message.delta'];
      const key = blockKey(ev.messageId, ev.blockIndex);
      let blockStarts = entry.blockStarts;
      let blockEnds = entry.blockEnds;
      if (blockStarts[key] === undefined) {
        blockStarts = { ...blockStarts, [key]: now };
        if (ev.blockIndex > 0) {
          const prevKey = blockKey(ev.messageId, ev.blockIndex - 1);
          if (blockStarts[prevKey] !== undefined && blockEnds[prevKey] === undefined) blockEnds = { ...blockEnds, [prevKey]: now };
        }
      }
      return { ...entry, session: applyDelta(entry.session, ev), blockStarts, blockEnds, streamingMessageId: entry.streamingMessageId ?? ev.messageId };
    }
    case 'message.block': {
      const ev = data as CoreEvents['message.block'];
      let blockEnds = entry.blockEnds;
      if (ev.blockIndex > 0) {
        const prevKey = blockKey(ev.messageId, ev.blockIndex - 1);
        if (entry.blockStarts[prevKey] !== undefined && blockEnds[prevKey] === undefined) blockEnds = { ...blockEnds, [prevKey]: now };
      }
      return { ...entry, session: applyBlock(entry.session, ev), blockEnds };
    }
    case 'message.completed': {
      const ev = data as CoreEvents['message.completed'];
      let blockEnds = entry.blockEnds;
      const prefix = `${ev.messageId}:`;
      for (const key of Object.keys(entry.blockStarts)) {
        if (key.startsWith(prefix) && blockEnds[key] === undefined) blockEnds = { ...blockEnds, [key]: now };
      }
      return {
        ...entry,
        session: applyCompleted(entry.session, ev),
        blockEnds,
        streamingMessageId: entry.streamingMessageId === ev.messageId ? null : entry.streamingMessageId,
      };
    }
    case 'tool.updated':
      return { ...entry, session: applyToolUpdate(entry.session, data as CoreEvents['tool.updated']) };
    case 'todos.updated':
      return { ...entry, session: { ...entry.session, todos: (data as CoreEvents['todos.updated']).todos } };
    case 'changes.updated':
      return { ...entry, session: { ...entry.session, changedFiles: (data as CoreEvents['changes.updated']).changedFiles } };
    case 'session.updated': {
      const s = data as CoreEvents['session.updated'];
      const session = applySummary(entry.session, s);
      // A session that stopped running has no streaming message any more.
      const streamingMessageId = s.status === 'running' ? entry.streamingMessageId : null;
      return { ...entry, session, streamingMessageId };
    }
    case 'session.reset':
      return { ...entry, stale: true, streamingMessageId: null };
    default:
      return entry;
  }
}

/** Events that carry a sessionId and mutate a transcript. */
export const TRANSCRIPT_EVENTS = [
  'message.added',
  'message.delta',
  'message.block',
  'message.completed',
  'tool.updated',
  'todos.updated',
  'changes.updated',
  'session.reset',
] as const satisfies readonly (keyof CoreEvents)[];

export type TranscriptEventName = (typeof TRANSCRIPT_EVENTS)[number];
