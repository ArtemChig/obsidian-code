import { describe, expect, it } from 'vitest';
import type { ActivityItem, PermissionRequest, PlanRequest, QuestionRequest } from '@shared/types';
import { activityCounts, breakdown, groupActivity, pendingRows } from '@renderer/features/activity/model';

const item = (id: string, kind: ActivityItem['kind'], status: ActivityItem['status'], startedAt: number, endedAt?: number): ActivityItem => ({ id, kind, status, startedAt, endedAt, title: id });

const ITEMS: ActivityItem[] = [
  item('s1', 'session', 'running', 1000),
  item('sub1', 'subagent', 'running', 3000),
  item('sh1', 'shell', 'running', 2000),
  item('w1', 'session', 'waiting', 500),
  item('g1', 'gpu', 'running', 100),
  item('d1', 'session', 'done', 10, 400),
  item('d2', 'schedule_run', 'done', 20, 900),
  item('e1', 'schedule_run', 'error', 30, 300),
  item('x1', 'shell', 'stopped', 40, 350),
];

describe('groupActivity', () => {
  it('splits into running / waiting / recent, newest first', () => {
    const g = groupActivity(ITEMS);
    expect(g.running.map((i: ActivityItem) => i.id)).toEqual(['sub1', 'sh1', 's1', 'g1']);
    expect(g.waiting.map((i: ActivityItem) => i.id)).toEqual(['w1']);
    expect(g.recent.map((i: ActivityItem) => i.id)).toEqual(['d2', 'd1', 'x1', 'e1']);
  });

  it('filters by kind', () => {
    const g = groupActivity(ITEMS, 'shell');
    expect(g.running.map((i: ActivityItem) => i.id)).toEqual(['sh1']);
    expect(g.recent.map((i: ActivityItem) => i.id)).toEqual(['x1']);
    expect(groupActivity(ITEMS, 'gpu').recent).toEqual([]);
  });
});

describe('activityCounts and breakdown', () => {
  it('counts statuses and kinds', () => {
    const c = activityCounts(ITEMS, 2);
    expect(c).toMatchObject({ running: 4, waiting: 1, done: 3, failed: 1, pending: 2 });
    expect(c.byKind).toEqual({ session: 3, subagent: 1, shell: 2, schedule_run: 2, gpu: 1 });
  });

  it('describes live items in words', () => {
    expect(breakdown(ITEMS.filter((i) => i.status === 'running'))).toBe('1 session · 1 subagent · 1 shell · GPU');
    expect(breakdown([item('a', 'session', 'running', 1), item('b', 'session', 'running', 2)])).toBe('2 sessions');
    expect(breakdown([])).toBe('');
  });
});

describe('pendingRows', () => {
  const perm: PermissionRequest = { requestId: 'p1', sessionId: 's1', toolUseId: 't', toolName: 'Bash', input: {}, title: 'Run: npm test', createdAt: 300 };
  const question: QuestionRequest = {
    requestId: 'q1',
    sessionId: 's2',
    toolUseId: 't',
    createdAt: 100,
    questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [] }],
  };
  const plan: PlanRequest = { requestId: 'pl1', sessionId: 's3', toolUseId: 't', plan: '# Refactor the parser\n\n1. Split it', createdAt: 200 };

  it('merges permissions, questions and plans, oldest first', () => {
    const rows = pendingRows({ p1: perm }, { q1: question }, { pl1: plan });
    expect(rows.map((r: { requestId: string }) => r.requestId)).toEqual(['q1', 'pl1', 'p1']);
    expect(rows[0]).toMatchObject({ kind: 'question', title: 'Which database?', detail: 'DB' });
    expect(rows[1]).toMatchObject({ kind: 'plan', detail: 'Refactor the parser' });
    expect(rows[2]).toMatchObject({ kind: 'permission', title: 'Run: npm test', detail: 'Bash' });
  });

  it('handles empty maps', () => {
    expect(pendingRows({}, {}, {})).toEqual([]);
  });
});
