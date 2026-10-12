// Pure helpers for the Activity view: grouping, counters, pending-request rows. Owner: ui-views.
import type { ActivityItem, PermissionRequest, PlanRequest, QuestionRequest } from '@shared/types';

export type ActivityKind = ActivityItem['kind'];
export type KindFilter = 'all' | ActivityKind;

export const KIND_LABEL: Record<ActivityKind, string> = {
  session: 'Session',
  subagent: 'Subagent',
  shell: 'Shell',
  schedule_run: 'Schedule',
  gpu: 'GPU',
};

export const KIND_PLURAL: Record<ActivityKind, string> = {
  session: 'Sessions',
  subagent: 'Subagents',
  shell: 'Shells',
  schedule_run: 'Schedules',
  gpu: 'GPU',
};

export const KIND_ORDER: ActivityKind[] = ['session', 'subagent', 'shell', 'schedule_run', 'gpu'];

export const isLive = (i: ActivityItem): boolean => i.status === 'running' || i.status === 'waiting';

export interface ActivityGroups {
  running: ActivityItem[];
  waiting: ActivityItem[];
  recent: ActivityItem[];
}

/** Running / Waiting for you / Recent. Live groups: newest first; recent: most recently finished first. */
export function groupActivity(items: readonly ActivityItem[], filter: KindFilter = 'all'): ActivityGroups {
  const list = filter === 'all' ? [...items] : items.filter((i) => i.kind === filter);
  const byStart = (a: ActivityItem, b: ActivityItem) => b.startedAt - a.startedAt;
  return {
    running: list.filter((i) => i.status === 'running').sort(byStart),
    waiting: list.filter((i) => i.status === 'waiting').sort(byStart),
    recent: list.filter((i) => !isLive(i)).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
  };
}

export interface ActivityCounts {
  running: number;
  waiting: number;
  done: number;
  failed: number;
  /** Pending permission / question / plan requests across all sessions. */
  pending: number;
  byKind: Record<ActivityKind, number>;
}

export function activityCounts(items: readonly ActivityItem[], pending = 0): ActivityCounts {
  const byKind = { session: 0, subagent: 0, shell: 0, schedule_run: 0, gpu: 0 } as Record<ActivityKind, number>;
  let running = 0;
  let waiting = 0;
  let done = 0;
  let failed = 0;
  for (const i of items) {
    byKind[i.kind] += 1;
    if (i.status === 'running') running++;
    else if (i.status === 'waiting') waiting++;
    else if (i.status === 'error') failed++;
    else done++;
  }
  return { running, waiting, done, failed, pending, byKind };
}

/** "1 session · 2 subagents · GPU" for the live items. */
export function breakdown(items: readonly ActivityItem[]): string {
  const counts: Partial<Record<ActivityKind, number>> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const part = (k: ActivityKind, one: string, many: string) => {
    const n = counts[k] ?? 0;
    return n ? (k === 'gpu' ? 'GPU' : `${n} ${n === 1 ? one : many}`) : null;
  };
  return [part('session', 'session', 'sessions'), part('subagent', 'subagent', 'subagents'), part('shell', 'shell', 'shells'), part('schedule_run', 'schedule run', 'schedule runs'), part('gpu', 'gpu', 'gpu')]
    .filter(Boolean)
    .join(' · ');
}

export const STATUS_LABEL: Record<ActivityItem['status'], string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Done',
  error: 'Failed',
  stopped: 'Stopped',
};

// ───────────────────────────── Pending requests ─────────────────────────────

export type PendingKind = 'permission' | 'question' | 'plan';

export interface PendingRow {
  requestId: string;
  kind: PendingKind;
  sessionId: string;
  title: string;
  detail?: string;
  createdAt: number;
}

export function pendingRows(permissions: Record<string, PermissionRequest>, questions: Record<string, QuestionRequest>, plans: Record<string, PlanRequest>): PendingRow[] {
  const rows: PendingRow[] = [];
  for (const p of Object.values(permissions)) {
    rows.push({ requestId: p.requestId, kind: 'permission', sessionId: p.sessionId, title: p.title || `Use ${p.toolName}`, detail: p.toolName, createdAt: p.createdAt });
  }
  for (const q of Object.values(questions)) {
    const first = q.questions[0];
    rows.push({
      requestId: q.requestId,
      kind: 'question',
      sessionId: q.sessionId,
      title: first?.question ?? 'The agent has a question',
      detail: q.questions.length > 1 ? `${q.questions.length} questions` : first?.header,
      createdAt: q.createdAt,
    });
  }
  for (const p of Object.values(plans)) {
    const firstLine = p.plan.split(/\r?\n/).find((l) => l.trim().length > 0)?.replace(/^#+\s*/, '') ?? '';
    rows.push({ requestId: p.requestId, kind: 'plan', sessionId: p.sessionId, title: 'Plan ready for approval', detail: firstLine || undefined, createdAt: p.createdAt });
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export const PENDING_LABEL: Record<PendingKind, string> = { permission: 'Permission', question: 'Question', plan: 'Plan' };
