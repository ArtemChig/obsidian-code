// Action helpers: the ONLY place UI code should mutate core state from. Owner: ui-foundation.
// Every action catches its own errors, shows a toast and resolves to null/false on failure,
// so components can call them from event handlers without try/catch.
import type { RpcResult } from '@shared/protocol';
import type {
  Block,
  EngineId,
  ImageBlock,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  SessionSummary,
  Settings,
} from '@shared/types';
import { errorMessage, rpc } from '../lib/rpc';
import { useActivity } from './activity';
import { clockOutPrompt, useGpu } from './gpu';
import { useModels } from './models';
import { removeRecord, usePending } from './pending';
import { setQueued, useSessions, type QueuedMessage } from './sessions';
import { useSettings } from './settings';
import { toast } from './toasts';
import { loadTranscript } from './sync';
import { useUi, type RightPanelTab, type Route } from './ui';

function fail(title: string, err: unknown): null {
  toast({ title, body: errorMessage(err), level: 'error' });
  return null;
}

function upsert(s: SessionSummary): void {
  useSessions.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
}

// ───────────────────────────── Navigation & layout ─────────────────────────────

export function navigate(route: Route): void {
  useUi.setState({ route, paletteOpen: false });
}

/** Show the home screen (no session selected). */
export function goHome(): void {
  useSessions.setState({ activeSessionId: null });
  useUi.setState({ route: 'session', paletteOpen: false });
}

export function openSession(sessionId: string): void {
  useSessions.setState((st) => {
    if (!st.unread[sessionId]) return { activeSessionId: sessionId };
    const unread = { ...st.unread };
    delete unread[sessionId];
    return { activeSessionId: sessionId, unread };
  });
  useUi.setState({ route: 'session', paletteOpen: false });
  void loadTranscript(sessionId);
}

export function openSettings(section?: string): void {
  useUi.setState({ route: 'settings', settingsSection: section ?? null, paletteOpen: false });
}

export function toggleSidebar(force?: boolean): void {
  useUi.setState((s) => ({ sidebarCollapsed: force === undefined ? !s.sidebarCollapsed : !force }));
}

export function toggleRightPanel(force?: boolean): void {
  useUi.setState((s) => ({ rightPanelOpen: force === undefined ? !s.rightPanelOpen : force }));
}

export function setRightPanelTab(tab: RightPanelTab): void {
  useUi.setState({ rightPanelTab: tab, rightPanelOpen: true });
}

export function openPalette(page: 'root' | 'models' | 'sessions' = 'root'): void {
  useUi.setState({ paletteOpen: true, palettePage: page });
}

export function closePalette(): void {
  useUi.setState({ paletteOpen: false, palettePage: 'root' });
}

export function markRead(sessionId: string): void {
  useSessions.setState((st) => {
    if (!st.unread[sessionId]) return st;
    const unread = { ...st.unread };
    delete unread[sessionId];
    return { unread };
  });
}

// ───────────────────────────── Sessions ─────────────────────────────

export interface CreateSessionOptions {
  cwd?: string;
  title?: string;
  model?: ModelRef | null;
  permissionMode?: PermissionMode;
  /** Agent engine; omitted = settings.engine.default. */
  engine?: EngineId;
  /** Open it right away (default true). */
  open?: boolean;
}

export async function createSession(opts: CreateSessionOptions = {}): Promise<SessionSummary | null> {
  try {
    const settings = useSettings.getState().settings;
    const s = await rpc.request('sessions.create', {
      cwd: opts.cwd ?? (settings?.defaultCwd || undefined),
      title: opts.title,
      model: opts.model,
      permissionMode: opts.permissionMode,
      engine: opts.engine,
    });
    upsert(s);
    if (opts.open !== false) openSession(s.id);
    return s;
  } catch (err) {
    return fail('Could not create a session', err);
  }
}

export async function renameSession(id: string, title: string): Promise<SessionSummary | null> {
  const t = title.trim();
  if (!t) return null;
  const prev = useSessions.getState().sessions[id];
  if (prev) upsert({ ...prev, title: t });
  try {
    const s = await rpc.request('sessions.rename', { id, title: t });
    upsert(s);
    return s;
  } catch (err) {
    if (prev) upsert(prev);
    return fail('Could not rename the session', err);
  }
}

export async function setPinned(id: string, pinned: boolean): Promise<SessionSummary | null> {
  const prev = useSessions.getState().sessions[id];
  if (prev) upsert({ ...prev, pinned });
  try {
    const s = await rpc.request('sessions.setPinned', { id, pinned });
    upsert(s);
    return s;
  } catch (err) {
    if (prev) upsert(prev);
    return fail(pinned ? 'Could not pin the session' : 'Could not unpin the session', err);
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await rpc.request('sessions.delete', { id });
    useSessions.setState((st) => {
      const sessions = { ...st.sessions };
      delete sessions[id];
      const transcripts = { ...st.transcripts };
      delete transcripts[id];
      return { sessions, transcripts, activeSessionId: st.activeSessionId === id ? null : st.activeSessionId };
    });
    return true;
  } catch (err) {
    fail('Could not delete the session', err);
    return false;
  }
}

export async function forkSession(id: string, atMessageId?: string): Promise<SessionSummary | null> {
  try {
    const s = await rpc.request('sessions.fork', { id, atMessageId });
    upsert(s);
    openSession(s.id);
    return s;
  } catch (err) {
    return fail('Could not fork the session', err);
  }
}

export async function searchSessions(query: string): Promise<RpcResult<'sessions.search'>> {
  if (!query.trim()) return [];
  try {
    return await rpc.request('sessions.search', { query });
  } catch {
    return [];
  }
}

// ───────────────────────────── Chat ─────────────────────────────

export async function sendMessage(sessionId: string, text: string, images?: ImageBlock[]): Promise<RpcResult<'chat.send'> | null> {
  try {
    const r = await rpc.request('chat.send', { sessionId, text, images: images && images.length ? images : undefined });
    if (r.queued) {
      useSessions.setState((st) => ({
        queued: { ...st.queued, [sessionId]: [...(st.queued[sessionId] ?? []), { messageId: r.messageId, text, at: Date.now() }] },
      }));
    }
    return r;
  } catch (err) {
    return fail('Message not sent', err);
  }
}

/**
 * Withdraw queued messages that have not started (one chip, or all of the session's). Resolves to the withdrawn
 * messages (oldest first) so the caller can put their text back into the composer.
 */
export async function withdrawQueued(sessionId: string, messageId?: string): Promise<QueuedMessage[]> {
  const chips = useSessions.getState().queued[sessionId] ?? [];
  const targets = messageId ? chips.filter((q) => q.messageId === messageId) : chips;
  if (!targets.length) return [];
  try {
    const r = await rpc.request('chat.dequeue', { sessionId, messageId });
    const removed = new Set(r.removed.map((x) => x.messageId));
    // A chip the core no longer has either started (its message.added follows) or was lost: drop it either way.
    const ids = new Set(targets.map((q) => q.messageId));
    setQueued(sessionId, (useSessions.getState().queued[sessionId] ?? []).filter((q) => !ids.has(q.messageId)));
    return targets.filter((q) => removed.has(q.messageId));
  } catch (err) {
    fail('Could not withdraw the queued message', err);
    return [];
  }
}

export async function interrupt(sessionId: string): Promise<boolean> {
  try {
    await rpc.request('chat.interrupt', { sessionId });
    return true;
  } catch (err) {
    fail('Could not stop the session', err);
    return false;
  }
}

export async function respondPermission(requestId: string, decision: PermissionDecision, message?: string): Promise<boolean> {
  const prev = usePending.getState().permissions[requestId];
  usePending.setState((s) => ({ permissions: removeRecord(s.permissions, requestId) }));
  try {
    await rpc.request('chat.respondPermission', { requestId, decision, message });
    return true;
  } catch (err) {
    if (prev) usePending.setState((s) => ({ permissions: { ...s.permissions, [requestId]: prev } }));
    fail('Could not send the permission decision', err);
    return false;
  }
}

export async function answerQuestion(requestId: string, answers: Record<string, string>): Promise<boolean> {
  const prev = usePending.getState().questions[requestId];
  usePending.setState((s) => ({ questions: removeRecord(s.questions, requestId) }));
  try {
    await rpc.request('chat.answerQuestion', { requestId, answers });
    return true;
  } catch (err) {
    if (prev) usePending.setState((s) => ({ questions: { ...s.questions, [requestId]: prev } }));
    fail('Could not send the answer', err);
    return false;
  }
}

export async function respondPlan(requestId: string, approve: boolean, opts: { mode?: PermissionMode; feedback?: string } = {}): Promise<boolean> {
  const prev = usePending.getState().plans[requestId];
  usePending.setState((s) => ({ plans: removeRecord(s.plans, requestId) }));
  try {
    await rpc.request('chat.respondPlan', { requestId, approve, mode: opts.mode, feedback: opts.feedback });
    return true;
  } catch (err) {
    if (prev) usePending.setState((s) => ({ plans: { ...s.plans, [requestId]: prev } }));
    fail('Could not send the plan decision', err);
    return false;
  }
}

export async function setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary | null> {
  const prev = useSessions.getState().sessions[sessionId];
  if (prev) upsert({ ...prev, permissionMode: mode });
  try {
    const s = await rpc.request('chat.setPermissionMode', { sessionId, mode });
    upsert(s);
    return s;
  } catch (err) {
    if (prev) upsert(prev);
    return fail('Could not change the permission mode', err);
  }
}

export async function setSessionModel(sessionId: string, model: ModelRef): Promise<SessionSummary | null> {
  const prev = useSessions.getState().sessions[sessionId];
  if (prev) upsert({ ...prev, model });
  try {
    const s = await rpc.request('chat.setModel', { sessionId, model });
    upsert(s);
    return s;
  } catch (err) {
    if (prev) upsert(prev);
    return fail('Could not switch the model', err);
  }
}

export async function setEngine(sessionId: string, engine: EngineId): Promise<SessionSummary | null> {
  const prev = useSessions.getState().sessions[sessionId];
  if (prev?.engine === engine || (!prev?.engine && engine === 'builtin')) return prev ?? null;
  if (prev) upsert({ ...prev, engine });
  try {
    const s = await rpc.request('chat.setEngine', { sessionId, engine });
    upsert(s);
    return s;
  } catch (err) {
    if (prev) upsert(prev);
    return fail('Could not switch the engine', err);
  }
}

export async function setThinking(sessionId: string, thinking: boolean): Promise<SessionSummary | null> {
  const prev = useSessions.getState().sessions[sessionId];
  if (prev) upsert({ ...prev, thinking });
  try {
    const s = await rpc.request('chat.setThinking', { sessionId, thinking });
    upsert(s);
    return s;
  } catch (err) {
    if (prev) upsert(prev);
    return fail('Could not toggle thinking', err);
  }
}

export async function rewind(sessionId: string, atMessageId: string, restoreFiles: boolean): Promise<RpcResult<'chat.rewind'> | null> {
  try {
    const r = await rpc.request('chat.rewind', { sessionId, atMessageId, restoreFiles });
    await loadTranscript(sessionId, { force: true });
    if (restoreFiles && r.restoredFiles.length) {
      toast({ title: 'Rewound', body: `Restored ${r.restoredFiles.length} file${r.restoredFiles.length === 1 ? '' : 's'}`, level: 'success' });
    }
    return r;
  } catch (err) {
    return fail('Could not rewind', err);
  }
}

/**
 * Retry a failed turn / regenerate a reply: rewind to the user message (files untouched) and send it again, so the
 * transcript holds the prompt once instead of one copy per click. If the resend fails, the text is returned so the
 * caller can put it back into the composer.
 */
export async function resendFrom(sessionId: string, messageId: string): Promise<{ ok: boolean; text: string }> {
  const m = useSessions.getState().transcripts[sessionId]?.session.messages.find((x) => x.id === messageId);
  if (!m || m.role !== 'user') return { ok: false, text: '' };
  const text = m.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
  const images = m.blocks.filter((b): b is ImageBlock => b.type === 'image');
  if (!(await rewind(sessionId, messageId, false))) return { ok: false, text: '' };
  const sent = await sendMessage(sessionId, text, images.length ? images : undefined);
  return { ok: !!sent, text };
}

/** Switch the model for the active session, or the default model when no session is open. */
export async function switchModel(model: ModelRef): Promise<boolean> {
  const active = useSessions.getState().activeSessionId;
  if (active && useUi.getState().route === 'session') return !!(await setSessionModel(active, model));
  return !!(await updateSettings({ defaultModel: model }));
}

// ───────────────────────────── Models ─────────────────────────────

export async function refreshModels(): Promise<boolean> {
  useModels.setState({ refreshing: true });
  try {
    const r = await rpc.request('models.refresh', {});
    useModels.setState({ providers: r.providers, models: r.models, loaded: true });
    return true;
  } catch (err) {
    fail('Could not refresh models', err);
    return false;
  } finally {
    useModels.setState({ refreshing: false });
  }
}

// ───────────────────────────── GPU ─────────────────────────────

/** Default clock-in profile: the last used one, else the first configured profile, else 'light'. */
export function defaultGpuProfileId(): string {
  const status = useGpu.getState().status;
  const profiles = useSettings.getState().settings?.vast.profiles ?? [];
  if (status?.profileId && profiles.some((p) => p.id === status.profileId)) return status.profileId;
  if (status?.parked?.profileId) return status.parked.profileId;
  return profiles[0]?.id ?? 'light';
}

export async function clockIn(profileId?: string, modelId?: string, offerId?: number): Promise<boolean> {
  useGpu.setState({ busy: true });
  try {
    const status = await rpc.request('gpu.clockIn', { profileId: profileId ?? defaultGpuProfileId(), modelId, offerId });
    useGpu.setState({ status });
    return true;
  } catch (err) {
    fail('Clock in failed', err);
    return false;
  } finally {
    useGpu.setState({ busy: false });
  }
}

export async function clockOut(): Promise<boolean> {
  useGpu.setState({ busy: true });
  try {
    const status = await rpc.request('gpu.clockOut', { reason: 'clock_out' });
    useGpu.setState({ status });
    return true;
  } catch (err) {
    fail('Clock out failed', err);
    return false;
  } finally {
    useGpu.setState({ busy: false });
  }
}

/**
 * Clock out, asking first when that would fail running turns or cancel a clock-in that already rented an instance.
 * Resolves to true when the clock-out ran, false when it failed or waits for the confirmation dialog.
 */
export async function requestClockOut(): Promise<boolean> {
  const prompt = clockOutPrompt(
    useGpu.getState().status,
    Object.values(useSessions.getState().sessions),
    useSettings.getState().settings?.defaultModel?.provider,
  );
  if (prompt) {
    useGpu.setState({ confirm: prompt });
    return false;
  }
  return clockOut();
}

export async function switchGpuModel(modelId: string): Promise<boolean> {
  try {
    const status = await rpc.request('gpu.switchModel', { modelId });
    useGpu.setState({ status });
    return true;
  } catch (err) {
    fail('Could not switch the GPU model', err);
    return false;
  }
}

let catalogInflight: Promise<void> | null = null;

/** Load the GPU model catalog once (force = refetch). `silent` suppresses the error toast. */
export function loadGpuCatalog(force = false, silent = false): Promise<void> {
  if (useGpu.getState().catalog && !force) return Promise.resolve();
  if (catalogInflight) return catalogInflight;
  catalogInflight = rpc
    .request('gpu.catalog', {})
    .then((catalog) => useGpu.setState({ catalog }))
    .catch((err) => {
      if (!silent) fail('Could not load the model catalog', err);
    })
    .finally(() => {
      catalogInflight = null;
    });
  return catalogInflight;
}

// ───────────────────────────── Settings & secrets ─────────────────────────────

export async function updateSettings(patch: Partial<Settings>): Promise<Settings | null> {
  try {
    const settings = await rpc.request('settings.update', { patch });
    useSettings.setState({ settings });
    return settings;
  } catch (err) {
    return fail('Could not save settings', err);
  }
}

export async function setSecret(name: string, value: string | null): Promise<boolean> {
  try {
    await rpc.request('secrets.set', { name, value });
    useSettings.setState((s) => ({ secrets: { ...s.secrets, [name]: !!value } }));
    if (name === 'vast.apiKey') useGpu.setState({ hasApiKey: !!value });
    return true;
  } catch (err) {
    fail('Could not save the secret', err);
    return false;
  }
}

// ───────────────────────────── Activity ─────────────────────────────

export async function stopActivity(id: string): Promise<boolean> {
  try {
    await rpc.request('activity.stop', { id });
    useActivity.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, status: 'stopped' as const } : i)) }));
    return true;
  } catch (err) {
    fail('Could not stop it', err);
    return false;
  }
}
