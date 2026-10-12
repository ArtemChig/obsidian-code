// Pending interactive requests (permission prompts, questions, plan approvals). Owner: ui-foundation.
// Keyed by requestId; filled by 'permission.requested' / 'question.requested' / 'plan.requested' events and by
// chat.pending on (re)connect, removed by the matching '*.resolved' events or optimistic responses.
import { create } from 'zustand';
import type { PermissionRequest, PlanRequest, QuestionRequest } from '@shared/types';

export interface PendingStore {
  permissions: Record<string, PermissionRequest>;
  questions: Record<string, QuestionRequest>;
  plans: Record<string, PlanRequest>;
}

export const usePending = create<PendingStore>(() => ({ permissions: {}, questions: {}, plans: {} }));

export function addRecord<T extends { requestId: string }>(map: Record<string, T>, item: T): Record<string, T> {
  return { ...map, [item.requestId]: item };
}

export function removeRecord<T>(map: Record<string, T>, requestId: string): Record<string, T> {
  if (!(requestId in map)) return map;
  const next = { ...map };
  delete next[requestId];
  return next;
}

export function toRecord<T extends { requestId: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const i of items) out[i.requestId] = i;
  return out;
}
