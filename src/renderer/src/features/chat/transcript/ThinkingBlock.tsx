// Thinking block: violet accent, live timer + tail of the reasoning while streaming, collapsed "Thought for Ns" after.
// Owner: ui-chat.
import { Brain, ChevronRight } from 'lucide-react';
import { memo, useState } from 'react';
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
        className="ob-transition group -ml-1.5 flex h-7 items-center gap-1.5 rounded-ctl px-1.5 text-ui text-ob-text-3 hover:bg-ob-hover hover:text-ob-text-2"
      >
        <Brain size={14} aria-hidden className={cn('text-ob-violet', streaming && 'animate-ob-pulse')} />
        <span className={cn(streaming && 'text-ob-violet')}>{label}</span>
        {streaming && startedAt ? <Elapsed since={startedAt} className="font-mono text-[11.5px] text-ob-violet/80" /> : null}
        {!streaming ? (
          <ChevronRight size={13} aria-hidden className={cn('transition-transform duration-150', open && 'rotate-90')} />
        ) : null}
      </button>
      {streaming && !open ? (
        <div
          className="ml-[5px] mt-1 flex max-h-[6.6em] flex-col justify-end overflow-hidden border-l-2 border-[rgba(179,166,232,0.35)] pl-3.5 text-small leading-[1.65] text-ob-text-3 [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
          aria-live="off"
        >
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      ) : null}
      {open ? (
        <div className="ob-selectable ml-[5px] mt-1 border-l-2 border-[rgba(179,166,232,0.35)] pl-3.5 text-small leading-[1.65] text-ob-text-2 animate-ob-fade-in">
          <p className="whitespace-pre-wrap">{text || '(empty)'}</p>
        </div>
      ) : null}
    </div>
  );
});
