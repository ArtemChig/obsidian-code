// Thinking block (M13): not coloured. Collapsed = a mono "THOUGHT FOR 12S" row with a chevron; expanded = --t2 text on a
// --rule left hairline; while streaming = a --live dot, a mono timer and the tail of the reasoning. Owner: ui-chat.
import { ChevronRight } from 'lucide-react';
import { memo, useState } from 'react';
import { StatusDot } from '@renderer/components/ui/feedback';
import { cn } from '@renderer/lib/cn';
import { formatDuration } from '@renderer/lib/format';
import { Elapsed } from '../ui';

export interface ThinkingBlockProps {
  text: string;
  /** This block is still receiving deltas. */
  streaming: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export const ThinkingBlock = memo(function ThinkingBlock({ text, streaming, startedAt, endedAt, durationMs }: ThinkingBlockProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? false;
  const ms = durationMs ?? (startedAt && endedAt ? endedAt - startedAt : undefined);
  const label = streaming ? 'Thinking' : ms !== undefined ? `Thought for ${formatDuration(Math.max(1000, ms))}` : 'Thought';

  return (
    <div data-testid="thinking-block" data-streaming={streaming || undefined} className="min-w-0">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={streaming || open}
        className="ob-transition group -ml-1 flex h-6 items-center gap-2 rounded-[2px] px-1 font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-t3 hover:text-t1"
      >
        {streaming ? <StatusDot tone="violet" pulse size={6} /> : null}
        <span>{label}</span>
        {streaming && startedAt ? <Elapsed since={startedAt} className="font-mono text-[10px] normal-case tracking-[-0.01em] text-t2" /> : null}
        {!streaming ? <ChevronRight size={11} aria-hidden className={cn('transition-transform duration-150', open && 'rotate-90')} /> : null}
      </button>
      {streaming && !open ? (
        <div className="ml-[2px] mt-1 flex max-h-[6.4em] flex-col justify-end overflow-hidden border-l border-rule pl-4 text-[12px] leading-[1.6] text-t3" aria-live="off">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      ) : null}
      {open ? (
        <div className="ob-selectable ml-[2px] mt-1 border-l border-rule pl-4 text-[12px] leading-[1.6] tracking-[-0.006em] text-t2 animate-ob-fade-in">
          <p className="whitespace-pre-wrap">{text || '(empty)'}</p>
        </div>
      ) : null}
    </div>
  );
});
