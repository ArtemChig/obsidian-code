// Wires core events into the stores and (re)fetches state on every (re)connect. Owner: ui-foundation.
import type { CoreEvents } from '@shared/protocol';
import type { Session, SessionSummary } from '@shared/types';
import { errorMessage, rpc } from '../lib/rpc';
import { useActivity, useSchedules } from './activity';
import { useConnection } from './connection';
import { useGpu } from './gpu';
import { useModels } from './models';
import { addRecord, removeRecord, toRecord, usePending } from './pending';
import { useSessions } from './sessions';
import { useSettings } from './settings';
import { toast } from './toasts';
import { createEntry, reduceEntry, TRANSCRIPT_EVENTS, type TranscriptEventName } from './transcript';

// ───────────────────────────── Transcripts ─────────────────────────────

const inflight = new Map<string, Promise<void>>();

/** Fetch (or refetch) a session's full transcript into the store. Concurrent calls are de-duplicated. */
export function loadTranscript(sessionId: string, opts: { force?: boolean } = {}): Promise<void> {
  const st = useSessions.getState();
  const entry = st.transcripts[sessionId];
  if (entry && !entry.stale && !opts.force) return Promise.resolve();
  const running = inflight.get(sessionId);
  if (running) return running;
  useSessions.setState((s) => ({ loading: { ...s.loading, [sessionId]: true } }));
  const p = rpc
    .request('sessions.get', { id: sessionId })
    .then((session) => {
      useSessions.setState((s) => {
        const prev = s.transcripts[sessionId];
        const next = createEntry(session);
        if (prev) {
          // Keep streaming bookkeeping across refetches.
          next.blockStarts = prev.blockStarts;
          next.blockEnds = prev.blockEnds;
          next.streamingMessageId = session.status === 'running' ? prev.streamingMessageId : null;
          next.prefill = session.status === 'running' ? prev.prefill : null;
        }
        const loadErrors = { ...s.loadErrors };
        delete loadErrors[sessionId];
        const summary = toSummary(session);
        return {
          transcripts: { ...s.transcripts, [sessionId]: next },
          sessions: { ...s.sessions, [sessionId]: summary },
          loading: { ...s.loading, [sessionId]: false },
          loadErrors,
        };
      });
    })
    .catch((err) => {
      useSessions.setState((s) => ({
        loading: { ...s.loading, [sessionId]: false },
        loadErrors: { ...s.loadErrors, [sessionId]: errorMessage(err) },
      }));
    })
    .finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}

function toSummary(session: Session): SessionSummary {
  const { messages: _m, todos: _t, changedFiles: _c, ...summary } = session;
  return summary;
}

function applyTranscriptEvent<E extends TranscriptEventName>(event: E, data: CoreEvents[E]): void {
  const sessionId = (data as { sessionId: string }).sessionId;
  const st = useSessions.getState();
  const entry = st.transcripts[sessionId];
  if (entry) {
    const next = reduceEntry(entry, event, data);
    if (next !== entry) useSessions.setState((s) => ({ transcripts: { ...s.transcripts, [sessionId]: next } }));
  }
  if (event === 'message.added') {
    const msg = (data as CoreEvents['message.added']).message;
    const q = st.queued[sessionId];
    if (q?.some((x) => x.messageId === msg.id)) {
      useSessions.setState((s) => ({ queued: { ...s.queued, [sessionId]: (s.queued[sessionId] ?? []).filter((x) => x.messageId !== msg.id) } }));
    }
  }
  if (event === 'message.completed') markUnread(sessionId);
  if (event === 'session.reset' && entry && sessionId === useSessions.getState().activeSessionId) {
    void loadTranscript(sessionId, { force: true });
  }
}

/** True when the app window is focused (always true outside a browser, e.g. unit tests). */
function windowFocused(): boolean {
  const doc = (globalThis as { document?: { hasFocus(): boolean } }).document;
  return doc ? doc.hasFocus() : true;
}

function markUnread(sessionId: string): void {
  const st = useSessions.getState();
  if (sessionId === st.activeSessionId && windowFocused()) return;
  const summary = st.sessions[sessionId];
  if (summary?.kind === 'subagent') return;
  if (st.unread[sessionId]) return;
  useSessions.setState((s) => ({ unread: { ...s.unread, [sessionId]: true } }));
}

function upsertSummary(s: SessionSummary): void {
  useSessions.setState((st) => {
    const prev = st.sessions[s.id];
    let transcripts = st.transcripts;
    const entry = st.transcripts[s.id];
    if (entry) transcripts = { ...transcripts, [s.id]: reduceEntry(entry, 'session.updated', s) };
    let unread = st.unread;
    if (prev && prev.status === 'running' && s.status !== 'running' && s.id !== st.activeSessionId && s.kind !== 'subagent') {
      unread = { ...unread, [s.id]: true };
    }
    return { sessions: { ...st.sessions, [s.id]: s }, transcripts, unread };
  });
}

function removeSession(sessionId: string): void {
  useSessions.setState((st) => {
    const sessions = { ...st.sessions };
    delete sessions[sessionId];
    const transcripts = { ...st.transcripts };
    delete transcripts[sessionId];
    const unread = { ...st.unread };
    delete unread[sessionId];
    const queued = { ...st.queued };
    delete queued[sessionId];
    return {
      sessions,
      transcripts,
      unread,
      queued,
      activeSessionId: st.activeSessionId === sessionId ? null : st.activeSessionId,
    };
  });
}

// ───────────────────────────── Event binding ─────────────────────────────

let unbindAll: (() => void) | null = null;

/** Subscribe the stores to core events. Idempotent; returns an unbind function. */
export function bindEvents(): () => void {
  if (unbindAll) return unbindAll;
  const offs: (() => void)[] = [];
  const on = <E extends keyof CoreEvents>(e: E, fn: (d: CoreEvents[E]) => void) => offs.push(rpc.on(e, fn));

  on('session.created', upsertSummary);
  on('session.updated', upsertSummary);
  on('session.deleted', (d) => removeSession(d.sessionId));
  for (const ev of TRANSCRIPT_EVENTS) {
    on(ev, (d) => applyTranscriptEvent(ev, d as CoreEvents[typeof ev]));
  }

  on('permission.requested', (r) => usePending.setState((s) => ({ permissions: addRecord(s.permissions, r) })));
  on('permission.resolved', (r) => usePending.setState((s) => ({ permissions: removeRecord(s.permissions, r.requestId) })));
  on('question.requested', (r) => usePending.setState((s) => ({ questions: addRecord(s.questions, r) })));
  on('question.resolved', (r) => usePending.setState((s) => ({ questions: removeRecord(s.questions, r.requestId) })));
  on('plan.requested', (r) => usePending.setState((s) => ({ plans: addRecord(s.plans, r) })));
  on('plan.resolved', (r) => usePending.setState((s) => ({ plans: removeRecord(s.plans, r.requestId) })));

  on('models.updated', (d) => useModels.setState({ providers: d.providers, models: d.models, loaded: true }));
  on('gpu.status', (status) => useGpu.setState({ status }));
  on('schedules.updated', (tasks) => useSchedules.setState({ tasks, loaded: true }));
  on('activity.updated', (items) => useActivity.setState({ items, loaded: true }));
  on('settings.updated', (settings) => useSettings.setState({ settings }));

  on('notification', (n) => toast({ title: n.title, body: n.body, level: n.level, sessionId: n.sessionId }));
  on('error', (e) => toast({ title: 'Error', body: e.message, level: 'error', sessionId: e.sessionId }));

  offs.push(
    rpc.onStatus((state) => useConnection.setState({ state })),
    rpc.onConnected(() => {
      void refetchAll();
    }),
  );

  unbindAll = () => {
    for (const off of offs) off();
    unbindAll = null;
  };
  return unbindAll;
}

// ───────────────────────────── Refetch ─────────────────────────────

/** Fetch the whole client state. Called on every (re)connect; safe to call any time. */
export async function refetchAll(): Promise<void> {
  const [system, list, models, gpu, settings, activity, schedules, pending, secrets] = await Promise.allSettled([
    rpc.request('system.info', {}),
    rpc.request('sessions.list', { includeSubagents: true }),
    rpc.request('models.list', {}),
    rpc.request('gpu.status', {}),
    rpc.request('settings.get', {}),
    rpc.request('activity.list', {}),
    rpc.request('schedules.list', {}),
    rpc.request('chat.pending', {}),
    rpc.request('secrets.has', { names: ['vast.apiKey', 'local.apiKey', 'search.braveKey', 'search.tavilyKey'] }),
  ]);

  if (system.status === 'fulfilled') useSettings.setState({ system: system.value });
  if (settings.status === 'fulfilled') useSettings.setState({ settings: settings.value });
  if (secrets.status === 'fulfilled') {
    useSettings.setState((s) => ({ secrets: { ...s.secrets, ...secrets.value } }));
    useGpu.setState({ hasApiKey: !!secrets.value['vast.apiKey'] });
  }
  if (list.status === 'fulfilled') {
    useSessions.setState((st) => {
      const sessions: Record<string, SessionSummary> = {};
      for (const s of list.value) sessions[s.id] = s;
      // Keep the active session even if the list omitted it (e.g. a subagent opened directly).
      if (st.activeSessionId && !sessions[st.activeSessionId] && st.sessions[st.activeSessionId]) {
        sessions[st.activeSessionId] = st.sessions[st.activeSessionId];
      }
      const transcripts: typeof st.transcripts = {};
      for (const [id, entry] of Object.entries(st.transcripts)) {
        if (sessions[id]) transcripts[id] = { ...entry, stale: true };
      }
      const activeSessionId = st.activeSessionId && sessions[st.activeSessionId] ? st.activeSessionId : null;
      return { sessions, transcripts, loaded: true, activeSessionId };
    });
  }
  if (models.status === 'fulfilled') useModels.setState({ providers: models.value.providers, models: models.value.models, loaded: true });
  if (gpu.status === 'fulfilled') useGpu.setState({ status: gpu.value });
  if (activity.status === 'fulfilled') useActivity.setState({ items: activity.value, loaded: true });
  if (schedules.status === 'fulfilled') useSchedules.setState({ tasks: schedules.value, loaded: true });
  if (pending.status === 'fulfilled') {
    usePending.setState({
      permissions: toRecord(pending.value.permissions),
      questions: toRecord(pending.value.questions),
      plans: toRecord(pending.value.plans),
    });
  }

  const active = useSessions.getState().activeSessionId;
  if (active) await loadTranscript(active, { force: true });

  const failed = [system, list, models, gpu, settings].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length && list.status === 'rejected') {
    toast({ title: 'Could not load state from the core', body: errorMessage(failed[0].reason), level: 'error' });
  }
  useConnection.setState({ ready: true, lastSyncAt: Date.now() });
}
