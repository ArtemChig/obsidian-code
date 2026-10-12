// Toast queue (rendered by components/ui/toast.tsx <Toaster/>). Owner: ui-foundation.
// 'notification' and 'error' core events are turned into toasts by state/sync.ts.
import { create } from 'zustand';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  title: string;
  body?: string;
  level: ToastLevel;
  /** Clicking the toast opens this session. */
  sessionId?: string;
  action?: ToastAction;
  /** 0 = sticky. */
  durationMs: number;
  createdAt: number;
}

export interface ToastInput {
  title: string;
  body?: string;
  level?: ToastLevel;
  sessionId?: string;
  action?: ToastAction;
  durationMs?: number;
  /** Replace an existing toast with the same id (e.g. progress updates). */
  id?: string;
}

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

const MAX_TOASTS = 5;
let seq = 0;

export function toast(input: ToastInput): string {
  const level = input.level ?? 'info';
  const id = input.id ?? `t${Date.now().toString(36)}${(seq++).toString(36)}`;
  const t: Toast = {
    id,
    title: input.title,
    body: input.body,
    level,
    sessionId: input.sessionId,
    action: input.action,
    durationMs: input.durationMs ?? (level === 'error' ? 8000 : 5000),
    createdAt: Date.now(),
  };
  useToasts.setState((s) => {
    const rest = s.toasts.filter((x) => x.id !== id);
    return { toasts: [...rest, t].slice(-MAX_TOASTS) };
  });
  return id;
}

export function dismissToast(id: string): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function clearToasts(): void {
  useToasts.setState({ toasts: [] });
}
