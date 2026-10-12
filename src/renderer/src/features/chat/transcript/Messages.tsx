// Transcript message renderers: user bubbles, assistant turns, slash-command echoes, compact-summary divider.
// Owner: ui-chat.
import { Check, CircleSlash, Copy, FoldVertical, RotateCcw, SquareSlash, Webhook, CalendarClock } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { Block, ImageBlock, Message, ToolUseBlock } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Markdown } from '@renderer/components/ui/markdown';
import { RelativeTime } from '@renderer/components/ui/time';
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
      icon={done ? <Check size={13} className="text-ob-success" /> : Copy}
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
      <div className="flex justify-end" data-testid="msg-user" data-tag="command">
        <div className="flex max-w-[80%] items-center gap-2 rounded-[10px] border border-ob-border bg-ob-surface-1 px-3 py-1.5 font-mono text-[12.5px] text-ob-text-2">
          <SquareSlash size={13} aria-hidden className="shrink-0 text-ob-accent" />
          <span className="ob-selectable min-w-0 truncate">{text}</span>
        </div>
      </div>
    );
  }

  if (message.tag === 'hook') {
    return (
      <div className="flex items-start gap-2 px-1 text-small text-ob-text-3" data-testid="msg-hook">
        <Webhook size={13} aria-hidden className="mt-[2px] shrink-0" />
        <span className="ob-selectable line-clamp-3 whitespace-pre-wrap">{text.replace(/<\/?system-reminder>/g, '').trim()}</span>
      </div>
    );
  }

  return (
    <div className="group/user flex flex-col items-end gap-1" data-testid="msg-user" data-message-id={message.id}>
      {images.length ? (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {images.map((img, i) => (
            <ImageThumb key={i} image={img} size={120} natural onOpen={() => onOpenImage?.(img)} />
          ))}
        </div>
      ) : null}
      {text ? (
        <div className="ob-selectable max-w-[80%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[5px] border border-[#243443] bg-ob-surface-2 px-4 py-2.5 text-[14.5px] leading-[1.6] text-ob-text">
          {message.tag === 'scheduled_prompt' ? (
            <Badge tone="accent" icon={CalendarClock} className="mb-1.5 mr-1.5 align-[1px]">
              Scheduled
            </Badge>
          ) : null}
          {isLongText(text) ? (
            <Clamp maxHeight={280} fadeFrom="var(--ob-surface-2)" moreLabel={lineCount(text) > 14 ? `${lineCount(text)} lines` : `${text.length.toLocaleString('en-US')} chars`}>
              {text}
            </Clamp>
          ) : (
            text
          )}
        </div>
      ) : null}
      <div className="-mb-2.5 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
        <RelativeTime ts={message.createdAt} className="mr-1.5 font-mono text-[11px] text-ob-text-3" />
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
}

/** "Reading context… 42%" with a thin progress bar — shown in the pending assistant message during a slow prefill. */
export function PrefillProgress({ prefill }: { prefill: PrefillState }) {
  const pct = Math.round(Math.min(1, Math.max(0, prefill.progress)) * 100);
  const tokens = prefill.total ? `${formatTokens(prefill.processed ?? 0)} / ${formatTokens(prefill.total)} tokens` : undefined;
  return (
    <div className="flex max-w-[360px] flex-col gap-1.5 py-0.5" data-testid="prefill-progress" title={tokens}>
      <div className="flex items-baseline gap-2 text-small text-ob-text-3">
        <span>Reading context…</span>
        <span className="ob-tabular font-mono text-[11px] text-ob-text-2">{pct}%</span>
      </div>
      <div
        className="h-[2px] w-full overflow-hidden rounded-full bg-ob-surface-3"
        role="progressbar"
        aria-label="Reading context"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full rounded-full bg-ob-accent transition-[width] duration-200 ease-out" style={{ width: `${pct}%` }} />
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

export const AssistantMessage = memo(function AssistantMessage({ message, cwd, streaming, timing, prefill, onOpenImage }: AssistantMessageProps) {
  const segs = useMemo(() => segments(message.blocks), [message.blocks]);
  const lastIndex = message.blocks.length - 1;
  const text = messageText(message);
  const meta = message.meta;

  if (message.tag === 'command') {
    return (
      <div className="rounded-[10px] border border-ob-border bg-ob-surface-1 px-4 py-3" data-testid="msg-assistant" data-tag="command">
        <Markdown text={text || '(no output)'} compact />
      </div>
    );
  }

  const empty = message.blocks.every((b) => (b.type === 'text' || b.type === 'thinking') && !b.text.trim());
  if (empty && !streaming && !meta?.interrupted) return null;

  return (
    <div className="group/assistant flex min-w-0 flex-col gap-3" data-testid="msg-assistant" data-message-id={message.id}>
      {streaming && prefill && message.blocks.length === 0 ? <PrefillProgress prefill={prefill} /> : null}
      {segs.map((seg) => {
        if (seg.kind === 'tools') {
          return (
            <div key={`t${seg.index}`} className="flex flex-col gap-1.5">
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
      {!streaming && (meta?.durationMs || meta?.interrupted) ? <AssistantFooter message={message} text={text} /> : null}
    </div>
  );
});

function AssistantFooter({ message, text }: { message: Message; text: string }) {
  const meta = message.meta ?? {};
  const parts: ReactNode[] = [];
  if (meta.model) parts.push(<span key="m">{shortModelName(meta.model)}</span>);
  if (meta.durationMs) parts.push(<span key="d">{formatDuration(meta.durationMs)}</span>);
  if (meta.completionTokens) parts.push(<span key="t">{formatTokens(meta.completionTokens)} out</span>);
  return (
    <div className="-mt-1 flex h-6 items-center gap-2 text-meta text-ob-text-3" data-testid="assistant-footer">
      {meta.interrupted ? (
        <span className="flex items-center gap-1 text-ob-warning" data-testid="interrupted">
          <CircleSlash size={12} aria-hidden />
          Interrupted
        </span>
      ) : null}
      <span className="flex items-center gap-2 font-mono opacity-0 transition-opacity duration-150 group-hover/assistant:opacity-100">
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 ? <span aria-hidden>·</span> : null}
            {p}
          </span>
        ))}
      </span>
      {text ? (
        <span className="opacity-0 transition-opacity duration-150 group-hover/assistant:opacity-100 focus-within:opacity-100">
          <CopyButton text={text} label="Copy reply" />
        </span>
      ) : null}
    </div>
  );
}

// ───────────────────────────── System / compact summary ─────────────────────────────

export const CompactDivider = memo(function CompactDivider({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const text = messageText(message);
  return (
    <div className="flex flex-col gap-2" data-testid="compact-divider">
      <button type="button" onClick={() => setOpen((o) => !o)} className="group flex items-center gap-3 text-meta text-ob-text-3" aria-expanded={open}>
        <span className="h-px flex-1 bg-ob-border" />
        <span className="ob-transition flex items-center gap-1.5 rounded-pill border border-ob-border px-2.5 py-0.5 font-mono uppercase tracking-[0.06em] group-hover:border-[#30414f] group-hover:text-ob-text-2">
          <FoldVertical size={12} aria-hidden />
          Conversation compacted
        </span>
        <span className="h-px flex-1 bg-ob-border" />
      </button>
      {open ? (
        <div className="rounded-[10px] border border-ob-border bg-ob-surface-1 px-4 py-3 animate-ob-fade-in">
          <div className="ob-section-label mb-1.5 text-[10px]">Summary</div>
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
    <div className="rounded-[8px] border border-dashed border-ob-border px-3 py-2 text-small text-ob-text-3" data-testid="msg-system">
      <Markdown text={text} compact className="text-ob-text-3" />
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
