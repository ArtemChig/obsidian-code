// Transcript message renderers (M13): user slivers, assistant prose on black, slash-command echoes, compact divider.
// Owner: ui-chat.
import { CalendarClock, Check, ChevronRight, CircleSlash, Copy, FoldVertical, RotateCcw, Terminal, Webhook } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { Block, ImageBlock, Message, ToolUseBlock } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { StatusDot } from '@renderer/components/ui/feedback';
import { Markdown } from '@renderer/components/ui/markdown';
import { RelativeTime } from '@renderer/components/ui/time';
import { cn } from '@renderer/lib/cn';
import { formatDuration, formatTokens, shortModelName } from '@renderer/lib/format';
import { blockKey, type PrefillState } from '@renderer/state/transcript';
import { ToolCard } from '../tools/ToolCard';
import { Clamp, ImageThumb } from '../ui';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ThinkingBlock } from './ThinkingBlock';

export function messageText(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

/** Pasted logs / long prompts collapse to a few lines in the user bubble (Show more expands). */
function isLongText(text: string): boolean {
  return text.length > 1200 || lineCount(text) > 14;
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length;
}

export function messageImages(m: Message): ImageBlock[] {
  return m.blocks.filter((b): b is ImageBlock => b.type === 'image');
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      size="sm"
      icon={done ? <Check size={13} className="text-ok" /> : Copy}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard unavailable */
        }
      }}
    />
  );
}

// ───────────────────────────── User ─────────────────────────────

export interface UserMessageProps {
  message: Message;
  onRewind?: (m: Message) => void;
  onOpenImage?: (img: ImageBlock) => void;
  /** Rewind is unavailable while a turn runs. */
  rewindDisabled?: boolean;
}

export const UserMessage = memo(function UserMessage({ message, onRewind, onOpenImage, rewindDisabled }: UserMessageProps) {
  const text = messageText(message);
  const images = messageImages(message);

  if (message.tag === 'command') {
    return (
      <div className="flex" data-testid="msg-user" data-tag="command">
        <div className="flex h-7 max-w-[80%] items-center gap-2 rounded-[2px] bg-s2 px-2.5 font-mono text-[11.5px] tracking-[-0.02em] text-t1">
          <Terminal size={12} aria-hidden className="shrink-0 text-t3" />
          <span className="ob-selectable min-w-0 truncate">{text}</span>
        </div>
      </div>
    );
  }

  if (message.tag === 'hook') {
    return (
      <div className="flex items-start gap-2 font-mono text-[10.5px] tracking-[-0.01em] text-t3" data-testid="msg-hook">
        <Webhook size={12} aria-hidden className="mt-[2px] shrink-0" />
        <span className="ob-selectable line-clamp-3 whitespace-pre-wrap">{text.replace(/<\/?system-reminder>/g, '').trim()}</span>
      </div>
    );
  }

  // M13: the user's turn is a flat --s2 sliver held by a 2 px ink edge (no bubble), with a mono meta line under it.
  return (
    <div className="group/user flex flex-col gap-1.5" data-testid="msg-user" data-message-id={message.id}>
      {images.length ? (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <ImageThumb key={i} image={img} size={120} natural onOpen={() => onOpenImage?.(img)} />
          ))}
        </div>
      ) : null}
      {text ? (
        <div className="ob-selectable whitespace-pre-wrap break-words rounded-[2px] bg-s2 px-4 py-2.5 text-[13.5px] leading-[1.6] tracking-[-0.008em] text-t1 shadow-[inset_2px_0_0_var(--t1)]">
          {message.tag === 'scheduled_prompt' ? (
            <Badge tone="accent" variant="outline" icon={CalendarClock} className="mb-1.5 mr-2 align-[1px]">
              Scheduled
            </Badge>
          ) : null}
          {isLongText(text) ? (
            <Clamp maxHeight={280} moreLabel={lineCount(text) > 14 ? `${lineCount(text)} lines` : `${text.length.toLocaleString('en-US')} chars`}>
              {text}
            </Clamp>
          ) : (
            text
          )}
        </div>
      ) : null}
      <div className="-mb-1 flex h-5 items-center gap-0.5">
        <span className="mr-2 font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-t3">You</span>
        <RelativeTime ts={message.createdAt} className="mr-2 font-mono text-[9.5px] tracking-[0.01em] text-t3" />
        <span className="flex items-center opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
          {text ? <CopyButton text={text} label="Copy message" /> : null}
          {onRewind ? (
            <IconButton
              label="Rewind to here"
              size="sm"
              icon={RotateCcw}
              disabled={rewindDisabled}
              onClick={() => onRewind(message)}
              data-testid="rewind-button"
            />
          ) : null}
        </span>
      </div>
    </div>
  );
});

// ───────────────────────────── Assistant ─────────────────────────────

export interface BlockTiming {
  starts: Record<number, number>;
  ends: Record<number, number>;
}

export interface AssistantMessageProps {
  message: Message;
  cwd: string;
  /** This message is still streaming. */
  streaming: boolean;
  /** Block start/end times (only for the streaming message — keeps memo stable for the rest). */
  timing?: BlockTiming;
  /** Prompt-processing progress while the model has not produced its first token yet (streaming message only). */
  prefill?: PrefillState | null;
  onOpenImage?: (img: ImageBlock) => void;
  /** Offered on the last finished reply: rewind to its prompt and send it again. */
  onRegenerate?: () => void;
}

/** "Reading context… 42%" with a thin progress bar — shown in the pending assistant message during a slow prefill. */
export function PrefillProgress({ prefill }: { prefill: PrefillState }) {
  const pct = Math.round(Math.min(1, Math.max(0, prefill.progress)) * 100);
  const tokens = prefill.total ? `${formatTokens(prefill.processed ?? 0)} / ${formatTokens(prefill.total)} tokens` : undefined;
  return (
    <div className="flex max-w-[360px] flex-col gap-2 py-0.5" data-testid="prefill-progress" title={tokens}>
      <div className="flex items-center gap-2.5">
        <StatusDot tone="violet" pulse size={6} />
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-t3">Reading context…</span>
        <span className="ob-tabular font-mono text-[10.5px] tracking-[-0.02em] text-t1">{pct}%</span>
      </div>
      <div className="h-[2px] w-full overflow-hidden bg-s4" role="progressbar" aria-label="Reading context" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full bg-live transition-[width] duration-200 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

type Segment = { kind: 'block'; index: number; block: Block } | { kind: 'tools'; index: number; tools: ToolUseBlock[] };

function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  blocks.forEach((b, index) => {
    if (b.type === 'tool_use') {
      const last = out[out.length - 1];
      if (last && last.kind === 'tools') last.tools.push(b);
      else out.push({ kind: 'tools', index, tools: [b] });
    } else {
      out.push({ kind: 'block', index, block: b });
    }
  });
  return out;
}

export const AssistantMessage = memo(function AssistantMessage({ message, cwd, streaming, timing, prefill, onOpenImage, onRegenerate }: AssistantMessageProps) {
  const segs = useMemo(() => segments(message.blocks), [message.blocks]);
  const lastIndex = message.blocks.length - 1;
  const text = messageText(message);
  const meta = message.meta;

  if (message.tag === 'command') {
    return (
      <div className="border-l border-rule py-0.5 pl-4" data-testid="msg-assistant" data-tag="command">
        <Markdown text={text || '(no output)'} compact />
      </div>
    );
  }

  const empty = message.blocks.every((b) => (b.type === 'text' || b.type === 'thinking') && !b.text.trim());
  if (empty && !streaming && !meta?.interrupted) return null;

  return (
    <div className="group/assistant flex min-w-0 flex-col gap-3.5" data-testid="msg-assistant" data-message-id={message.id}>
      {streaming && prefill && message.blocks.length === 0 ? <PrefillProgress prefill={prefill} /> : null}
      {segs.map((seg) => {
        if (seg.kind === 'tools') {
          return (
            <div key={`t${seg.index}`} className="flex flex-col border-t border-rule2">
              {seg.tools.map((t) => (
                <ToolCard key={t.id} tool={t} cwd={cwd} />
              ))}
            </div>
          );
        }
        const b = seg.block;
        if (b.type === 'thinking') {
          const isLive = streaming && seg.index === lastIndex && timing?.ends[seg.index] === undefined;
          return (
            <ThinkingBlock
              key={`k${seg.index}`}
              text={b.text}
              streaming={isLive}
              durationMs={b.durationMs}
              startedAt={timing?.starts[seg.index]}
              endedAt={timing?.ends[seg.index]}
            />
          );
        }
        if (b.type === 'text') {
          if (!b.text.trim()) return null;
          return <StreamingMarkdown key={`x${seg.index}`} text={b.text} />;
        }
        if (b.type === 'image') {
          return <ImageThumb key={`i${seg.index}`} image={b} size={160} natural onOpen={() => onOpenImage?.(b)} />;
        }
        return null;
      })}
      {!streaming && (meta?.durationMs || meta?.interrupted || onRegenerate) ? <AssistantFooter message={message} text={text} onRegenerate={onRegenerate} /> : null}
    </div>
  );
});

function AssistantFooter({ message, text, onRegenerate }: { message: Message; text: string; onRegenerate?: () => void }) {
  const meta = message.meta ?? {};
  const parts: ReactNode[] = [];
  if (meta.model) parts.push(<span key="m">{shortModelName(meta.model)}</span>);
  if (meta.durationMs) parts.push(<span key="d">{formatDuration(meta.durationMs)}</span>);
  if (meta.completionTokens) parts.push(<span key="t">{formatTokens(meta.completionTokens)} out</span>);
  return (
    <div className="-mt-1.5 flex h-6 items-center gap-2.5" data-testid="assistant-footer">
      {meta.interrupted ? (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-warn" data-testid="interrupted">
          <CircleSlash size={11} aria-hidden />
          Interrupted
        </span>
      ) : null}
      {parts.length ? (
        <span className="flex min-w-0 items-center gap-2 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.12em] text-t3">
          {parts.map((p, i) => (
            <span key={i} className={i === 0 ? 'flex min-w-0 items-center gap-2' : 'flex shrink-0 items-center gap-2'}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <span className={i === 0 ? 'truncate' : undefined}>{p}</span>
            </span>
          ))}
        </span>
      ) : null}
      <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/assistant:opacity-100 focus-within:opacity-100">
        {text ? <CopyButton text={text} label="Copy reply" /> : null}
        {onRegenerate ? <IconButton label="Regenerate (send the prompt again)" icon={RotateCcw} size="sm" onClick={onRegenerate} data-testid="regenerate" /> : null}
      </span>
    </div>
  );
}

// ───────────────────────────── System / compact summary ─────────────────────────────

export const CompactDivider = memo(function CompactDivider({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const text = messageText(message);
  return (
    <div className="flex flex-col gap-3" data-testid="compact-divider">
      <button type="button" onClick={() => setOpen((o) => !o)} className="group flex h-6 items-center gap-3" aria-expanded={open}>
        <span className="h-px flex-1 bg-rule" />
        <span className="ob-transition flex items-center gap-2 font-mono text-[9px] font-medium uppercase tracking-[0.22em] text-t3 group-hover:text-t1">
          <FoldVertical size={11} aria-hidden />
          Conversation compacted
          <ChevronRight size={11} aria-hidden className={cn('transition-transform duration-150', open && 'rotate-90')} />
        </span>
        <span className="h-px flex-1 bg-rule" />
      </button>
      {open ? (
        <div className="border-l border-rule py-0.5 pl-4 animate-ob-fade-in">
          <div className="ob-cap mb-2">Summary</div>
          <Markdown text={text} compact />
        </div>
      ) : null}
    </div>
  );
});

export const SystemNote = memo(function SystemNote({ message }: { message: Message }) {
  const text = messageText(message);
  if (!text) return null;
  return (
    <div className="border-l border-rule py-0.5 pl-4 text-[11.5px] text-t3" data-testid="msg-system">
      <Markdown text={text} compact className="text-t3" />
    </div>
  );
});

/** Timing maps for one message, keyed by block index. */
export function timingFor(messageId: string, starts: Record<string, number>, ends: Record<string, number>, count: number): BlockTiming {
  const s: Record<number, number> = {};
  const e: Record<number, number> = {};
  for (let i = 0; i < count; i++) {
    const k = blockKey(messageId, i);
    if (starts[k] !== undefined) s[i] = starts[k];
    if (ends[k] !== undefined) e[i] = ends[k];
  }
  return { starts: s, ends: e };
}
