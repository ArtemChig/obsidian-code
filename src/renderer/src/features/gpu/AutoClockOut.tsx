// Auto clock-out in the UI: the right-click menu (sidebar GPU widget, rail button, status bar, chat header, composer
// buttons) and the one-line status of the armed watches. The core does the work (src/core/gpu/auto-clockout.ts); this
// file only arms/cancels watches (gpu.autoClockOut.set) and shows them (GpuStatus.autoClockOut*). Owner: ui-views.
import { Check, CircleCheck, Power, Timer, TimerOff, X } from 'lucide-react';
import type { MouseEvent, ReactElement } from 'react';
import type { AutoClockOutMode, AutoClockOutWatch, GpuStatus } from '@shared/types';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@renderer/components/ui/menu';
import { useNow } from '@renderer/components/ui/time';
import { Tooltip, type TooltipProps } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatClock } from '@renderer/lib/format';
import { requestClockOut, setAutoClockOut } from '@renderer/state/actions';
import { isGpuClockedIn, useGpu } from '@renderer/state/gpu';
import { useSettings } from '@renderer/state/settings';

// ───────────────────────────── Model ─────────────────────────────

/** The armed watches in the status (older cores only report the single `autoClockOut`). */
export function watchesOf(status: GpuStatus | null | undefined): AutoClockOutWatch[] {
  if (!status) return [];
  if (status.autoClockOutWatches?.length) return status.autoClockOutWatches;
  return status.autoClockOut ? [status.autoClockOut] : [];
}

/** The watch of one session, or (sessionId null) the global one that covers every session on the GPU. */
export function watchFor(status: GpuStatus | null | undefined, sessionId: string | null): AutoClockOutWatch | undefined {
  return watchesOf(status).find((w) => (w.sessionId ?? null) === sessionId);
}

export const AUTO_MODE_SHORT: Record<AutoClockOutMode, string> = {
  finished: 'when done',
  unresponsive: 'if stalled',
  both: 'done or stalled',
};

export function minutesText(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  return `${Number.isInteger(m) ? m : +m.toFixed(1)} min`;
}

/** One sentence for a tooltip / toast: what the watch does. */
export function describeWatch(w: AutoClockOutWatch): string {
  const who = w.sessionId ? `“${w.sessionTitle || 'Untitled session'}”` : 'the agent';
  const done = `${minutesText(w.finishGraceMinutes)} after ${who} finishes`;
  const stall = `if ${who} stops responding for ${minutesText(w.stallMinutes)}`;
  const src = w.source === 'default' ? ' (from Settings → Vast.ai)' : '';
  if (w.mode === 'finished') return `The GPU clocks out ${done}${src}.`;
  if (w.mode === 'unresponsive') return `The GPU clocks out ${stall}${src}.`;
  return `The GPU clocks out ${done}, or ${stall}${src}.`;
}

/** The nearest countdown worth showing: a finish grace period always, a stall only in its last minute. */
export function visibleCountdown(watches: AutoClockOutWatch[], now: number): { at: number; reason: string } | null {
  let best: { at: number; reason: string } | null = null;
  for (const w of watches) {
    const p = w.pending;
    if (!p) continue;
    if (p.kind === 'unresponsive' && p.at - now > 60_000) continue;
    if (!best || p.at < best.at) best = { at: p.at, reason: p.reason };
  }
  return best;
}

function summaryText(watches: AutoClockOutWatch[]): string {
  const global = watches.find((w) => !w.sessionId);
  const sessions = watches.filter((w) => w.sessionId);
  const parts: string[] = [];
  if (global) parts.push(AUTO_MODE_SHORT[global.mode]);
  if (sessions.length === 1 && !global) parts.push(`${AUTO_MODE_SHORT[sessions[0].mode]} · 1 session`);
  else if (sessions.length) parts.push(`${global ? '+' : ''}${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** True while a GPU is rented (or being rented): the only time a watch can be armed. */
export function useAutoClockOutAvailable(): boolean {
  return useGpu((s) => isGpuClockedIn(s.status));
}

// ───────────────────────────── Status line ─────────────────────────────

/** "Auto · if stalled" (or the live countdown once one is running). Renders nothing when nothing is armed. */
export function AutoClockOutLine({ status, className }: { status: GpuStatus | null | undefined; className?: string }) {
  const watches = watchesOf(status);
  const anyPending = watches.some((w) => w.pending);
  const now = useNow(anyPending ? 1000 : false);
  if (!watches.length) return null;
  const countdown = visibleCountdown(watches, now);
  const tip = [...watches.map(describeWatch), countdown ? countdown.reason : ''].filter(Boolean).join('\n');
  return (
    <div
      data-testid="gpu-auto-clockout"
      data-armed={watches.length}
      title={tip}
      className={cn('flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] leading-[14px] tracking-[0.01em] text-t3', className)}
    >
      <Timer size={10} aria-hidden className="shrink-0" />
      {countdown ? (
        <span className="ob-tabular truncate" data-testid="gpu-auto-clockout-countdown">
          Clocking out in <span className="text-t1">{formatClock(Math.max(0, countdown.at - now))}</span>
        </span>
      ) : (
        <span className="truncate">
          Auto <span className="text-t2">· {summaryText(watches)}</span>
        </span>
      )}
    </div>
  );
}

/** Small marker for the status bar: nothing when no watch is armed. */
export function AutoClockOutMarker({ status }: { status: GpuStatus | null | undefined }) {
  const watches = watchesOf(status);
  if (!watches.length) return null;
  return <Timer size={10} aria-label="Auto clock-out armed" data-testid="status-gpu-auto" className="shrink-0 text-t2" />;
}

// ───────────────────────────── Menu ─────────────────────────────

/** The rows are shared by the right-click menu and a dropdown (the menu strip's GPU menu): same props, other Radix parts. */
const PARTS = {
  context: { Item: ContextMenuItem, Sep: ContextMenuSeparator, Label: ContextMenuLabel },
  dropdown: {
    Item: DropdownMenuItem as unknown as typeof ContextMenuItem,
    Sep: DropdownMenuSeparator as unknown as typeof ContextMenuSeparator,
    Label: DropdownMenuLabel as unknown as typeof ContextMenuLabel,
  },
} as const;

function Choice({ Item, active, icon, hint, onPick, children }: { Item: typeof ContextMenuItem; active: boolean; icon: typeof Timer; hint?: string; onPick: () => void; children: string }) {
  return (
    <Item
      icon={icon}
      hint={hint}
      role="menuitemradio"
      aria-checked={active}
      data-active={active || undefined}
      trailing={active ? <Check size={13} aria-hidden className="text-t1" /> : undefined}
      className={cn(active && 'text-t1')}
      onSelect={onPick}
    >
      {children}
    </Item>
  );
}

/**
 * The menu rows. `sessionId` scopes the watch to one session; null/omitted = any session using the Vast.ai provider.
 * `kind` picks the Radix parts: 'context' inside a ContextMenuContent (default), 'dropdown' inside a DropdownMenuContent.
 */
export function AutoClockOutMenuItems({ sessionId = null, kind = 'context' }: { sessionId?: string | null; kind?: 'context' | 'dropdown' }) {
  const { Item, Sep, Label } = PARTS[kind];
  const watch = useGpu((s) => watchFor(s.status, sessionId));
  const limits = useSettings((s) => s.settings?.vast.autoClockOut);
  const mode = watch?.mode;
  const stall = minutesText(limits?.stallMinutes ?? watch?.stallMinutes ?? 10);
  const grace = minutesText(limits?.finishGraceMinutes ?? watch?.finishGraceMinutes ?? 2);
  const set = (m: AutoClockOutMode) => () => void setAutoClockOut(sessionId, m);
  const scoped = sessionId !== null;
  return (
    <>
      <Label>{scoped ? 'GPU · this session' : kind === 'dropdown' ? 'Auto clock-out' : 'GPU'}</Label>
      {kind === 'context' ? (
        <>
          <Item icon={Power} danger onSelect={() => void requestClockOut()} data-testid="auto-clockout-now">
            Clock out now
          </Item>
          <Sep />
        </>
      ) : null}
      <Choice Item={Item} active={mode === 'finished'} icon={CircleCheck} hint={grace} onPick={set('finished')}>
        {scoped ? 'Clock out when this task finishes' : 'Clock out when the current task finishes'}
      </Choice>
      <Choice Item={Item} active={mode === 'unresponsive'} icon={TimerOff} hint={stall} onPick={set('unresponsive')}>
        Clock out if it stops responding
      </Choice>
      <Choice Item={Item} active={mode === 'both'} icon={Timer} onPick={set('both')}>
        Both
      </Choice>
      <Sep />
      <Item icon={X} disabled={!watch} onSelect={() => void setAutoClockOut(sessionId, 'off')} data-testid="auto-clockout-cancel">
        Cancel auto clock-out
      </Item>
    </>
  );
}

/** A right-click inside a text field is not ours (a rename box in the trigger's area). */
function skipTextFields(e: MouseEvent<HTMLElement>): void {
  if (e.target instanceof Element && e.target.closest('input, textarea')) e.preventDefault();
}

/**
 * Right-click menu around one element (the trigger). Only opens while a GPU is clocked in. Pass `tooltip` when the
 * element also has a tooltip: the two Radix triggers must be nested in this order to both work.
 */
export function AutoClockOutMenu({
  sessionId = null,
  children,
  tooltip,
  disabled,
}: {
  sessionId?: string | null;
  children: ReactElement;
  tooltip?: Omit<TooltipProps, 'children'>;
  /** Never open (e.g. a subagent's view: only top-level sessions are watched). */
  disabled?: boolean;
}) {
  const available = useAutoClockOutAvailable() && !disabled;
  const trigger = (
    <ContextMenuTrigger asChild disabled={!available} onContextMenu={skipTextFields}>
      {children}
    </ContextMenuTrigger>
  );
  return (
    <ContextMenu>
      {tooltip ? <Tooltip {...tooltip}>{trigger}</Tooltip> : trigger}
      <ContextMenuContent className="min-w-[268px]" data-testid="auto-clockout-menu">
        <AutoClockOutMenuItems sessionId={sessionId} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
