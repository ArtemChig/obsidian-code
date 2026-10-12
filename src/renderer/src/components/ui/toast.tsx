// Toaster: renders the toast queue from state/toasts.ts (fed by 'notification' / 'error' core events). Owner: ui-foundation.
// M13: --s0 + 1 px --line + separation shadow; the level is carried only by the status-coloured glyph and a 2 px edge.
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@renderer/lib/cn';
import { openSession } from '@renderer/state/actions';
import { dismissToast, useToasts, type Toast, type ToastLevel } from '@renderer/state/toasts';

export { toast, dismissToast } from '@renderer/state/toasts';
export type { Toast, ToastInput, ToastLevel } from '@renderer/state/toasts';

const ICONS: Record<ToastLevel, { icon: LucideIcon; cls: string; edge: string }> = {
  info: { icon: Info, cls: 'text-t2', edge: 'shadow-[inset_2px_0_0_var(--acc),var(--shadow-deep)]' },
  success: { icon: CircleCheck, cls: 'text-ok', edge: 'shadow-[inset_2px_0_0_var(--ok),var(--shadow-deep)]' },
  warning: { icon: TriangleAlert, cls: 'text-warn', edge: 'shadow-[inset_2px_0_0_var(--warn),var(--shadow-deep)]' },
  error: { icon: CircleX, cls: 'text-err', edge: 'shadow-[inset_2px_0_0_var(--err),var(--shadow-deep)]' },
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

  const { icon: Icon, cls, edge } = ICONS[t.level];
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
        'pointer-events-auto relative flex w-[348px] gap-3 overflow-hidden rounded-[2px] border border-line bg-s0 py-3 pl-4 pr-2 animate-ob-slide-up',
        edge,
        clickable && 'cursor-pointer hover:bg-s1',
      )}
    >
      <Icon size={14} aria-hidden className={cn('mt-[2px] shrink-0', cls)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-[12.5px] font-medium tracking-[-0.016em] text-t1">{t.title}</div>
        {t.body ? <div className="line-clamp-3 text-[11.5px] leading-[1.45] text-t2">{t.body}</div> : null}
        {t.action ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              t.action?.onClick();
              dismissToast(t.id);
            }}
            className="ob-transition mt-2 h-6 self-start rounded-[2px] border border-line px-2.5 text-[11px] font-medium text-t2 hover:bg-hov hover:text-t1"
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
        className="ob-transition -mt-1 flex size-6 shrink-0 items-center justify-center rounded-[2px] text-t3 hover:bg-hov hover:text-t1"
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-9 right-4 z-[120] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
