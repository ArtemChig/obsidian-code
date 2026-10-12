// Toaster: renders the toast queue from state/toasts.ts (fed by 'notification' / 'error' core events). Owner: ui-foundation.
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@renderer/lib/cn';
import { openSession } from '@renderer/state/actions';
import { dismissToast, useToasts, type Toast, type ToastLevel } from '@renderer/state/toasts';

export { toast, dismissToast } from '@renderer/state/toasts';
export type { Toast, ToastInput, ToastLevel } from '@renderer/state/toasts';

const ICONS: Record<ToastLevel, { icon: LucideIcon; cls: string; bar: string }> = {
  info: { icon: Info, cls: 'text-ob-accent', bar: 'bg-ob-accent' },
  success: { icon: CircleCheck, cls: 'text-ob-success', bar: 'bg-ob-success' },
  warning: { icon: TriangleAlert, cls: 'text-ob-warning', bar: 'bg-ob-warning' },
  error: { icon: CircleX, cls: 'text-ob-danger', bar: 'bg-ob-danger' },
};

function ToastItem({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.durationMs);
  const started = useRef(Date.now());

  useEffect(() => {
    if (!t.durationMs || paused) return;
    started.current = Date.now();
    const timer = setTimeout(() => dismissToast(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started.current;
    };
  }, [t.id, t.durationMs, paused]);

  const { icon: Icon, cls } = ICONS[t.level];
  const clickable = !!t.sessionId;
  return (
    <div
      role={t.level === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => {
        if (t.sessionId) {
          openSession(t.sessionId);
          dismissToast(t.id);
        }
      }}
      className={cn(
        'pointer-events-auto relative flex w-[348px] gap-3 overflow-hidden rounded-[10px] border border-ob-border bg-ob-surface-3 py-3 pl-3.5 pr-2.5 shadow-pop animate-ob-slide-up',
        clickable && 'cursor-pointer hover:border-[#33444f]',
      )}
    >
      <Icon size={16} aria-hidden className={cn('mt-px shrink-0', cls)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-ui font-medium text-ob-text">{t.title}</div>
        {t.body ? <div className="line-clamp-3 text-small text-ob-text-2">{t.body}</div> : null}
        {t.action ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              t.action?.onClick();
              dismissToast(t.id);
            }}
            className="ob-transition mt-1.5 self-start rounded-[5px] text-small font-medium text-ob-accent hover:text-ob-accent-hover"
          >
            {t.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={(e) => {
          e.stopPropagation();
          dismissToast(t.id);
        }}
        className="ob-transition -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ob-text-3 hover:bg-ob-hover hover:text-ob-text"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[120] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
