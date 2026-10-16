// Auto clock-out (owner: gpu): clock the GPU out by itself when the agent finished or stopped responding, so going to
// sleep never leaves an idle or hung rented GPU billing. SPEC §3.4a.
//
// A "watch" targets one session (sessionId) or every session that uses the Vast.ai provider (the global watch), with
// a mode:
//   finished      the targets have not been 'running' (idle, error or waiting for the user) for finishGraceMinutes, and
//                 something ran since the watch was armed. A queued message or a new run cancels the countdown.
//   unresponsive  a target is 'running' but produced no progress (deltas, blocks, tools, prefill progress, messages)
//                 for stallMinutes, OR the model ended 3 turns in a row with reasoning only (the agent loop injects a
//                 'hook' message each time), OR a target waits for the user longer than stallMinutes. A tool call that
//                 is running (a silent build) is the tool's silence, not the model's: it gets 10 more minutes (the cap
//                 of the Bash timeout) before the session counts as stuck. A global watch
//                 only fires when EVERY running/waiting target is in that state (one healthy session keeps the GPU).
//   both          either of the above.
// Watches only act while the GPU is 'ready', and are gone when it fires, when the GPU clocks out for any other reason,
// or when cancelled. Settings → Vast.ai → Auto clock-out arms a global watch at every clock-in (`default`).
// Firing = (unresponsive: interrupt the sessions) → gpu.clockOut('auto_*', why) → one `notification` that says why.

import type { AutoClockOutApi, CoreContext } from '../contracts';
import type { CoreEvents } from '../../shared/protocol';
import type {
  AutoClockOutChoice, AutoClockOutMode, AutoClockOutWatch, GpuPhase, GpuSessionRecord, GpuStatus, ProviderId, SessionKind,
  SessionStatus, SessionSummary, ToolUseBlock,
} from '../../shared/types';

/** Reasoning-only turns in a row (without a tool call or an answer in between) that count as "stuck". */
export const REASONING_ONLY_LIMIT = 3;
/** The agent loop's nudge after a reasoning-only turn (src/core/agent/manager.ts CONTINUE_AFTER_THINKING_NOTE). */
export const REASONING_NOTE_MARKER = 'You ended your turn with reasoning but produced no answer';

const DEFAULT_STALL_MINUTES = 10;
const DEFAULT_GRACE_MINUTES = 2;
/** After a failed auto clock-out, wait this long before trying again (no notification spam while the GPU stays up). */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const MAX_PARENT_DEPTH = 8;
/** Extra silence allowed while a tool call is running: the Bash tool's maximum timeout. */
export const TOOL_GRACE_MS = 10 * 60_000;

/** The GPU is rented (or being rented): a watch can be armed. */
const ACTIVE_PHASES: ReadonlySet<GpuPhase> = new Set<GpuPhase>(['searching', 'renting', 'connecting', 'downloading', 'loading', 'ready', 'switching']);

type EndReason = NonNullable<GpuSessionRecord['endReason']>;
type Kind = 'finished' | 'unresponsive';

export interface AutoClockOutOptions {
  now?: () => number;
  /** Evaluation interval while a watch is armed (default 1 s). */
  tickMs?: number;
  /**
   * A gap between two ticks longer than this means the PC slept (or the process stalled): the time is not counted
   * against the agent. Default 30 s; Infinity disables it.
   */
  sleepGapMs?: number;
}

interface Tracked {
  id: string;
  title: string;
  kind: SessionKind;
  parentId?: string;
  provider?: ProviderId;
  status: SessionStatus;
  statusSince: number;
  lastProgress: number;
  /** Consecutive reasoning-only turns (tool call / answer / new user message resets it). */
  reasoningStreak: number;
  /** Tool calls currently executing (also those of its subagents). */
  toolsRunning: Set<string>;
  /** When the streak reached REASONING_ONLY_LIMIT. */
  streakReachedAt?: number;
}

interface Watch {
  /** Watched session; null = the global watch. */
  key: string | null;
  finished: boolean;
  unresponsive: boolean;
  armedAt: number;
  source: 'user' | 'default';
  /** Something ran since arming ('finished' only counts a finish after a run). */
  sawRunning: boolean;
  /** Since when no target has been working (the 'finished' countdown start). */
  inactiveSince: number | null;
  pending?: AutoClockOutWatch['pending'];
  due?: { kind: Kind; reason: string; stalled: Tracked[] };
}

export function modeOf(finished: boolean, unresponsive: boolean): AutoClockOutMode {
  return finished && unresponsive ? 'both' : finished ? 'finished' : 'unresponsive';
}

function minutesLabel(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  return `${Number.isInteger(m) ? m : +m.toFixed(1)} min`;
}

export class AutoClockOut implements AutoClockOutApi {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly sleepGapMs: number;
  private readonly sessions = new Map<string, Tracked>();
  private readonly watches = new Map<string | null, Watch>();
  private offs: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private disposed = false;
  /** The GPU is rented (any active phase): the default watch was armed for this rental. */
  private rental = false;
  private ready = false;
  private readySince = 0;
  private lastTick = 0;
  private firing = false;
  private retryAt = 0;

  constructor(
    private readonly ctx: CoreContext,
    opts: AutoClockOutOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 1000;
    this.sleepGapMs = opts.sleepGapMs ?? 30_000;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const bus = this.ctx.bus;
    const t = this.now();
    try {
      for (const s of this.ctx.sessions.list({ includeSubagents: true })) this.track(s, t);
    } catch {
      /* session store not ready: sessions are tracked from their events */
    }
    this.offs.push(
      bus.on('session.created', (s) => this.onSession(s)),
      bus.on('session.updated', (s) => this.onSession(s)),
      bus.on('session.deleted', (d) => this.onSessionDeleted(d.sessionId)),
      bus.on('message.added', (d) => this.onMessageAdded(d)),
      bus.on('message.delta', (d) => this.touch(d.sessionId, d.blockType === 'text')),
      bus.on('message.block', (d) => this.touch(d.sessionId, d.block.type === 'tool_use', d.block.type === 'tool_use' ? d.block : undefined)),
      bus.on('tool.updated', (d) => this.touch(d.sessionId, true, d.tool)),
      bus.on('message.progress', (d) => this.touch(d.sessionId, false)),
      bus.on('message.completed', (d) => this.touch(d.sessionId, false)),
      bus.on('gpu.status', (st) => this.onGpuStatus(st)),
    );
    try {
      this.ctx.gpu.setStatusExtras?.((st) => this.statusFields(st));
      this.onGpuStatus(this.ctx.gpu.status());
    } catch {
      /* gpu manager not ready: the first gpu.status event catches up */
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.stopTicker();
    this.watches.clear();
    try {
      this.ctx.gpu.setStatusExtras?.(null);
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────────── public API ─────────────────────────────

  list(): AutoClockOutWatch[] {
    const lim = this.limits();
    return [...this.watches.values()]
      .sort((a, b) => (a.key === null ? -1 : b.key === null ? 1 : a.armedAt - b.armedAt))
      .map((w) => this.toPublic(w, lim));
  }

  set(opts: { sessionId?: string | null; mode: AutoClockOutChoice }): AutoClockOutWatch[] {
    const key = opts.sessionId ?? null;
    const mode = opts.mode;
    if (mode === 'off') {
      if (this.watches.delete(key)) this.afterChange();
      return this.list();
    }
    if (mode !== 'finished' && mode !== 'unresponsive' && mode !== 'both') throw new Error(`Unknown auto clock-out mode "${String(mode)}".`);
    if (!this.isClockedIn()) throw new Error('Auto clock-out needs a clocked-in GPU. Clock in first.');
    if (key !== null) {
      const target = this.lookup(key);
      if (!target) throw new Error(`Session not found: ${key}`);
      if (target.kind === 'subagent' || target.parentId) throw new Error('Auto clock-out watches a top-level session, not a subagent.');
    }
    this.arm(key, mode, 'user');
    this.afterChange();
    return this.list();
  }

  /** The status fields (called by the GPU manager for every status()). Watches only exist while a GPU is rented. */
  statusFields(st: Pick<GpuStatus, 'phase'>): Partial<GpuStatus> {
    if (!ACTIVE_PHASES.has(st.phase) || this.watches.size === 0) return {};
    const list = this.list();
    return { autoClockOut: list.find((w) => !w.sessionId) ?? list[0], autoClockOutWatches: list };
  }

  /** Evaluate the armed watches once (runs on a 1 s timer while any is armed; public for tests). */
  tick(): void {
    const t = this.now();
    if (this.lastTick && this.tickMs > 0) {
      const gap = t - this.lastTick - this.tickMs;
      if (gap > this.sleepGapMs) this.shift(gap);
    }
    this.lastTick = t;
    this.refresh(t);
    if (this.firing || t < this.retryAt || !this.ready) return;
    for (const w of this.watches.values()) {
      if (w.due) {
        void this.fire(w, w.due);
        return;
      }
    }
  }

  // ───────────────────────────── arming ─────────────────────────────

  private arm(key: string | null, mode: AutoClockOutMode, source: 'user' | 'default'): Watch {
    const w: Watch = {
      key,
      finished: mode === 'finished' || mode === 'both',
      unresponsive: mode === 'unresponsive' || mode === 'both',
      armedAt: this.now(),
      source,
      sawRunning: false,
      inactiveSince: null,
    };
    this.watches.set(key, w);
    this.refresh(this.now());
    this.ensureTicker();
    return w;
  }

  private armDefault(): void {
    const choice = this.limits().default;
    if (choice === 'off' || this.watches.has(null)) return;
    this.arm(null, choice, 'default');
    // The status event that started this clock-in is still being delivered: publish the watch right after it.
    queueMicrotask(() => this.emitStatus());
  }

  private afterChange(): void {
    if (this.watches.size === 0) this.stopTicker();
    else this.ensureTicker();
    this.emitStatus();
  }

  private isClockedIn(): boolean {
    try {
      return ACTIVE_PHASES.has(this.ctx.gpu.status().phase);
    } catch {
      return false;
    }
  }

  // ───────────────────────────── events ─────────────────────────────

  private onGpuStatus(st: GpuStatus): void {
    const t = this.now();
    const clocked = ACTIVE_PHASES.has(st.phase);
    const ready = st.phase === 'ready';
    if (ready && !this.ready) this.readySince = t;
    this.ready = ready;
    if (clocked && !this.rental) {
      this.rental = true;
      this.armDefault();
    } else if (!clocked && this.rental) {
      // Clocked out (by anyone): watches never outlive the rental.
      this.rental = false;
      this.watches.clear();
      this.stopTicker();
    }
  }

  private onSession(s: SessionSummary): void {
    this.track(s, this.now());
  }

  private onSessionDeleted(id: string): void {
    this.sessions.delete(id);
    if (this.watches.delete(id)) this.afterChange();
  }

  private onMessageAdded(d: CoreEvents['message.added']): void {
    const m = d.message;
    const root = this.rootOf(d.sessionId);
    if (!root) return;
    root.lastProgress = this.now();
    if (m.role === 'assistant') return;
    if (m.tag === 'hook') {
      const text = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (text.includes(REASONING_NOTE_MARKER)) {
        root.reasoningStreak++;
        if (root.reasoningStreak === REASONING_ONLY_LIMIT) root.streakReachedAt = this.now();
      }
    } else if (m.role === 'user') {
      this.resetStreak(root);
    }
  }

  /** Progress of a session (or of a subagent: it also counts for the session it runs in). */
  private touch(sessionId: string, resetStreak: boolean, tool?: Pick<ToolUseBlock, 'id' | 'status'>): void {
    const root = this.rootOf(sessionId);
    if (!root) return;
    root.lastProgress = this.now();
    if (resetStreak) this.resetStreak(root);
    if (tool) {
      if (tool.status === 'running') root.toolsRunning.add(tool.id);
      else root.toolsRunning.delete(tool.id);
    }
  }

  private resetStreak(tr: Tracked): void {
    tr.reasoningStreak = 0;
    tr.streakReachedAt = undefined;
  }

  private track(s: SessionSummary, t: number): Tracked {
    let tr = this.sessions.get(s.id);
    const isNew = !tr;
    if (!tr) {
      tr = { id: s.id, title: s.title, kind: s.kind, status: s.status, statusSince: t, lastProgress: t, reasoningStreak: 0, toolsRunning: new Set() };
      this.sessions.set(s.id, tr);
    }
    tr.title = s.title;
    tr.kind = s.kind;
    tr.parentId = s.parentSessionId;
    tr.provider = s.model?.provider;
    if (!isNew && s.status !== tr.status) {
      const prev = tr.status;
      tr.status = s.status;
      tr.statusSince = t;
      if (s.status === 'running') {
        tr.lastProgress = t;
        if (prev !== 'waiting') this.resetStreak(tr);
        // A run that starts and ends between two ticks still counts as "something ran" for the finished watches.
        for (const w of this.watches.values()) if (w.finished && !w.sawRunning && this.targetsOf(w).includes(tr)) w.sawRunning = true;
      } else if (s.status !== 'waiting') {
        this.resetStreak(tr);
        tr.toolsRunning.clear(); // the turn ended: nothing it started is still running
      }
    }
    return tr;
  }

  /** The top-level session an event belongs to (a subagent's activity counts for the session that spawned it). */
  private rootOf(sessionId: string): Tracked | undefined {
    let tr = this.lookup(sessionId);
    for (let i = 0; tr?.parentId && i < MAX_PARENT_DEPTH; i++) {
      const parent = this.lookup(tr.parentId);
      if (!parent) break;
      tr = parent;
    }
    return tr;
  }

  private lookup(id: string): Tracked | undefined {
    const known = this.sessions.get(id);
    if (known) return known;
    try {
      const s = this.ctx.sessions.get(id);
      return s ? this.track(s, this.now()) : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────── evaluation ─────────────────────────────

  /** The limits in force (one settings read: the store hands out a copy each time). */
  private limits(): { default: AutoClockOutChoice; stallMin: number; graceMin: number; stallMs: number; graceMs: number; defaultProvider?: ProviderId } {
    let a: Partial<{ default: string; stallMinutes: number; finishGraceMinutes: number }> | undefined;
    let defaultProvider: ProviderId | undefined;
    try {
      const s = this.ctx.settings?.get();
      a = s?.vast?.autoClockOut;
      defaultProvider = s?.defaultModel?.provider;
    } catch {
      a = undefined;
    }
    const num = (v: unknown, d: number, min: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : d);
    const stallMin = num(a?.stallMinutes, DEFAULT_STALL_MINUTES, 1 / 60);
    const graceMin = num(a?.finishGraceMinutes, DEFAULT_GRACE_MINUTES, 0);
    const d = a?.default;
    const choice: AutoClockOutChoice = d === 'off' || d === 'finished' || d === 'unresponsive' || d === 'both' ? d : 'unresponsive';
    return { default: choice, stallMin, graceMin, stallMs: stallMin * 60_000, graceMs: graceMin * 60_000, defaultProvider };
  }

  /** What a watch looks at: its session, or every top-level session that uses the Vast.ai provider. */
  private targetsOf(w: Watch, dp: ProviderId | undefined = this.limits().defaultProvider): Tracked[] {
    if (w.key !== null) {
      const s = this.sessions.get(w.key);
      return s ? [s] : [];
    }
    const out: Tracked[] = [];
    for (const s of this.sessions.values()) {
      if (s.kind === 'subagent' || s.parentId) continue;
      if ((s.provider ?? dp) === 'vast') out.push(s);
    }
    return out;
  }

  /** 'running', or between two turns with messages queued (the loop is still busy while status is idle/error). */
  private isWorking(s: Tracked): boolean {
    if (s.status === 'running') return true;
    if (s.status === 'waiting') return false;
    try {
      return !!this.ctx.agent?.isRunning(s.id);
    } catch {
      return false;
    }
  }

  /** When (and why) an active session counts as unresponsive; null = not running/waiting, nothing to judge. */
  private stallOf(s: Tracked, stallMs: number): { at: number; why: 'silent' | 'reasoning' | 'waiting' } | null {
    if (s.status === 'running') {
      if (s.reasoningStreak >= REASONING_ONLY_LIMIT && s.streakReachedAt !== undefined) return { at: s.streakReachedAt, why: 'reasoning' };
      return { at: Math.max(s.lastProgress, this.readySince) + stallMs + (s.toolsRunning.size ? TOOL_GRACE_MS : 0), why: 'silent' };
    }
    if (s.status === 'waiting') return { at: Math.max(s.statusSince, this.readySince) + stallMs, why: 'waiting' };
    return null;
  }

  /** Recompute every watch's counters, countdown and "due" verdict. Pure bookkeeping: it never clocks out. */
  private refresh(t: number): void {
    const lim = this.limits();
    for (const w of this.watches.values()) {
      w.due = undefined;
      w.pending = undefined;
      const targets = this.targetsOf(w, lim.defaultProvider);
      const working = targets.some((s) => this.isWorking(s));
      if (working) {
        w.sawRunning = true;
        w.inactiveSince = null;
      }
      if (!this.ready) {
        // Not serving (clocking in, switching model): nothing counts, and the countdowns restart once it is ready.
        w.inactiveSince = null;
        continue;
      }
      let finishedAt: number | undefined;
      if (w.finished && w.sawRunning && !working) {
        if (w.inactiveSince === null) w.inactiveSince = t;
        finishedAt = w.inactiveSince + lim.graceMs;
      }
      let stallAt: number | undefined;
      let stalled: Tracked[] = [];
      let worst: { at: number; why: 'silent' | 'reasoning' | 'waiting' } | undefined;
      if (w.unresponsive) {
        const live = targets.flatMap((s) => {
          const x = this.stallOf(s, lim.stallMs);
          return x ? [{ s, x }] : [];
        });
        if (live.length) {
          // Every running/waiting target must be stuck: one healthy session keeps the GPU worth its rent.
          for (const l of live) if (!worst || l.x.at > worst.at) worst = l.x;
          stalled = live.map((l) => l.s);
          stallAt = worst!.at;
        }
      }
      const fReason = finishedAt !== undefined ? this.finishedReason(targets, lim.graceMin) : '';
      const uReason = stallAt !== undefined && worst ? this.stalledReason(stalled, worst.why, lim.stallMin) : '';
      if (finishedAt !== undefined && (stallAt === undefined || finishedAt <= stallAt)) w.pending = { kind: 'finished', at: finishedAt, reason: fReason };
      else if (stallAt !== undefined) w.pending = { kind: 'unresponsive', at: stallAt, reason: uReason };
      if (finishedAt !== undefined && t >= finishedAt) w.due = { kind: 'finished', reason: fReason, stalled: [] };
      else if (stallAt !== undefined && t >= stallAt) w.due = { kind: 'unresponsive', reason: uReason, stalled };
    }
  }

  private label(list: Tracked[]): string {
    return list.length === 1 ? list[0].title || 'Untitled session' : `${list.length} sessions`;
  }

  private finishedReason(targets: Tracked[], graceMin: number): string {
    if (targets.length === 1) return `${this.label(targets)} finished (idle for ${minutesLabel(graceMin)})`;
    return `No session has been running on the GPU for ${minutesLabel(graceMin)}`;
  }

  private stalledReason(stalled: Tracked[], why: 'silent' | 'reasoning' | 'waiting', stallMin: number): string {
    const who = this.label(stalled);
    if (why === 'reasoning') return `${who} ended ${REASONING_ONLY_LIMIT} turns in a row with reasoning only and no answer`;
    if (why === 'waiting') return `${who} waited for your input for ${minutesLabel(stallMin)}`;
    return `${who} stopped responding for ${minutesLabel(stallMin)}`;
  }

  // ───────────────────────────── firing ─────────────────────────────

  private async fire(trigger: Watch, due: NonNullable<Watch['due']>): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    const snapshot = [...this.watches.values()];
    const reason: EndReason = due.kind === 'finished' ? 'auto_finished' : 'auto_unresponsive';
    // A watch is gone once it fired (the clock-out also ends the rental the others belong to).
    this.watches.clear();
    this.stopTicker();
    this.emitStatus();
    let failure: string | undefined;
    try {
      if (due.kind === 'unresponsive') {
        // Stop the stuck turns first (the same path as chat.interrupt) so they do not fail on a vanishing endpoint.
        for (const s of due.stalled) {
          try {
            this.ctx.agent.interrupt(s.id);
          } catch {
            /* the session may be gone */
          }
        }
      }
      if (!this.isClockedIn()) return; // somebody clocked out meanwhile: nothing left to do
      await this.ctx.gpu.clockOut(reason, due.reason);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      this.firing = false;
    }
    let phase: GpuPhase | undefined;
    try {
      phase = this.ctx.gpu.status().phase;
    } catch {
      phase = undefined;
    }
    if (failure === undefined && phase === 'off') {
      const only = due.stalled.length === 1 ? due.stalled[0] : undefined;
      this.notify(
        'GPU clocked out',
        `${due.reason}.`,
        due.kind === 'unresponsive' ? 'warning' : 'success',
        only?.id ?? (trigger.key ?? undefined),
      );
      return;
    }
    if (phase !== undefined && ACTIVE_PHASES.has(phase)) {
      // Still rented: put the watches back and retry later, but not in a tight loop.
      this.retryAt = this.now() + RETRY_AFTER_FAILURE_MS;
      for (const w of snapshot) this.watches.set(w.key, w);
      this.ensureTicker();
      this.emitStatus();
    }
    const detail = failure ? ` (${failure})` : phase === 'error' ? ' (the clock-out reported a problem; see the GPU view)' : '';
    this.notify('Auto clock-out failed', `${due.reason}, but the GPU could not be clocked out${detail}. Clock it out manually if you do not need it.`, 'error');
  }

  private notify(title: string, body: string, level: CoreEvents['notification']['level'], sessionId?: string): void {
    try {
      this.ctx.bus.emit('notification', { title, body, level, ...(sessionId ? { sessionId } : {}) });
    } catch {
      /* ignore */
    }
  }

  private emitStatus(): void {
    if (this.disposed) return;
    try {
      this.ctx.bus.emit('gpu.status', this.ctx.gpu.status());
    } catch {
      /* gpu manager not ready */
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private toPublic(w: Watch, lim: ReturnType<AutoClockOut['limits']>): AutoClockOutWatch {
    const tr = w.key !== null ? this.sessions.get(w.key) : undefined;
    const out: AutoClockOutWatch = {
      mode: modeOf(w.finished, w.unresponsive),
      armedAt: w.armedAt,
      source: w.source,
      stallMinutes: lim.stallMin,
      finishGraceMinutes: lim.graceMin,
    };
    if (w.key !== null) {
      out.sessionId = w.key;
      if (tr) out.sessionTitle = tr.title || 'Untitled session';
    }
    if (w.pending) out.pending = { ...w.pending };
    return out;
  }

  private ensureTicker(): void {
    if (this.timer || this.disposed || this.watches.size === 0) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  private stopTicker(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastTick = 0;
  }

  /** The PC slept (or the process stalled) for `gap` ms: that time does not count against the agent. */
  private shift(gap: number): void {
    for (const s of this.sessions.values()) {
      s.statusSince += gap;
      s.lastProgress += gap;
      if (s.streakReachedAt !== undefined) s.streakReachedAt += gap;
    }
    for (const w of this.watches.values()) if (w.inactiveSince !== null) w.inactiveSince += gap;
    this.readySince += gap;
  }
}

export function createAutoClockOut(ctx: CoreContext, opts?: AutoClockOutOptions): AutoClockOut {
  return new AutoClockOut(ctx, opts);
}
