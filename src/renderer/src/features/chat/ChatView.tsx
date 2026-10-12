// Chat view (SPEC §4.6): header → transcript (messages, tool cards, inline prompts, status, errors) → composer.
// Owner: ui-chat. Contract used by app/AppShell.tsx: export function ChatView(props: { sessionId: string }).
import { ArrowDown, Bot, CircleX, ImagePlus, MessageSquareText, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { ImageBlock, Message, PermissionRequest, PlanRequest, QuestionRequest, SessionSummary } from '@shared/types';
import { AppMark } from '@renderer/components/ui/app-mark';
import { Button, IconButton } from '@renderer/components/ui/button';
import { ConfirmDialog } from '@renderer/components/ui/dialog';
import { EmptyState, Spinner } from '@renderer/components/ui/feedback';
import { Checkbox } from '@renderer/components/ui/toggles';
import { Kbd } from '@renderer/components/ui/kbd';
import { cn } from '@renderer/lib/cn';
import { basename, pluralize } from '@renderer/lib/format';
import { interrupt, openSession, rewind, sendMessage } from '@renderer/state/actions';
import { usePending } from '@renderer/state/pending';
import { useSessions } from '@renderer/state/sessions';
import { useSessionSummary, useTranscript, useTranscriptLoading } from '@renderer/state/selectors';
import { loadTranscript } from '@renderer/state/sync';
import type { TranscriptEntry } from '@renderer/state/transcript';
import { ChatHeader } from './ChatHeader';
import { AwaitingToolsContext } from './context';
import { addImageFiles, filesFrom } from './composer/attachments';
import { Composer } from './composer/Composer';
import { activityLabel } from './lib/tool-meta';
import { PermissionPrompt } from './prompts/PermissionPrompt';
import { PlanApproval } from './prompts/PlanApproval';
import { QuestionCard } from './prompts/QuestionCard';
import { bindChatEvents, clearError, focusComposer, setDraft, useChatLocal } from './state';
import { AssistantMessage, CompactDivider, messageImages, messageText, SystemNote, timingFor, UserMessage } from './transcript/Messages';
import { useStickToBottom } from './transcript/useStickToBottom';
import { Elapsed, ImageLightbox, isEditableTarget, overlayOpen } from './ui';

bindChatEvents();

/** Messages rendered before "Show earlier" kicks in. */
const WINDOW = 120;

type PendingItem =
  | { kind: 'permission'; req: PermissionRequest }
  | { kind: 'question'; req: QuestionRequest }
  | { kind: 'plan'; req: PlanRequest };

/**
 * Pending requests for this view: the session's own, plus any that target a tool shown in it (subagent views).
 * The result keeps its identity while the set of requests is unchanged, so streaming deltas do not re-render cards.
 */
function usePendingItems(sessionId: string, entry: TranscriptEntry | undefined): PendingItem[] {
  const { permissions, questions, plans } = usePending();
  const all = useMemo(
    () =>
      [
        ...Object.values(permissions).map((req): PendingItem => ({ kind: 'permission', req })),
        ...Object.values(questions).map((req): PendingItem => ({ kind: 'question', req })),
        ...Object.values(plans).map((req): PendingItem => ({ kind: 'plan', req })),
      ].sort((a, b) => a.req.createdAt - b.req.createdAt),
    [permissions, questions, plans],
  );
  const needsScan = all.some((p) => p.req.sessionId !== sessionId);
  const messages = needsScan ? entry?.session.messages : undefined;
  const items = useMemo(() => {
    if (!messages) return all.filter((p) => p.req.sessionId === sessionId);
    const toolIds = new Set<string>();
    for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_use') toolIds.add(b.id);
    return all.filter((p) => p.req.sessionId === sessionId || toolIds.has(p.req.toolUseId));
  }, [all, sessionId, messages]);
  const prev = useRef<PendingItem[]>(items);
  const same = prev.current.length === items.length && prev.current.every((p, i) => p.req === items[i].req);
  if (!same) prev.current = items;
  return prev.current;
}

function lastUserMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.tag !== 'hook' && m.tag !== 'command') return m;
  }
  return undefined;
}

// ───────────────────────────── Status row ─────────────────────────────

function RunningStatus({ session, entry, waiting }: { session: SessionSummary; entry: TranscriptEntry; waiting: boolean }) {
  const messages = entry.session.messages;
  const since = useMemo(() => {
    const u = lastUserMessage(messages);
    return u?.createdAt ?? Date.now();
  }, [messages]);
  if (session.status !== 'running' && session.status !== 'waiting') return null;

  let label = 'Working';
  const last = messages[messages.length - 1];
  if (waiting || session.status === 'waiting') label = 'Waiting for you';
  else if (last?.role === 'assistant') {
    const running = last.blocks.filter((b) => b.type === 'tool_use' && b.status === 'running');
    const tail = last.blocks[last.blocks.length - 1];
    if (running.length === 1 && running[0].type === 'tool_use') {
      label = activityLabel(running[0], session.cwd);
    } else if (running.length > 1) label = `Running ${running.length} tools`;
    else if (tail?.type === 'thinking' && entry.streamingMessageId === last.id) label = 'Thinking';
    else if (tail?.type === 'text' && entry.streamingMessageId === last.id) label = 'Writing';
  }
  const isWaiting = waiting || session.status === 'waiting';
  return (
    <div className="flex h-7 items-center gap-2.5 text-small text-ob-text-3" data-testid="running-status" aria-live="polite">
      {isWaiting ? <span className="size-2 shrink-0 animate-ob-pulse rounded-full bg-ob-warning" /> : <Spinner size={13} className="shrink-0 text-ob-accent" />}
      <span className={cn('min-w-0 truncate', isWaiting ? 'text-ob-warning' : 'text-ob-text-2')}>{isWaiting ? label : `${label}…`}</span>
      <Elapsed since={since} className="shrink-0 font-mono text-[11px]" />
      <span className="flex shrink-0 items-center gap-1">
        <span aria-hidden>·</span>
        <Kbd>Esc</Kbd>
        <span>to stop</span>
      </span>
    </div>
  );
}

// ───────────────────────────── Error banner ─────────────────────────────

function ErrorBanner({ session, messages }: { session: SessionSummary; messages: Message[] }) {
  const err = useChatLocal((s) => s.errors[session.id]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = err ? String(err.at) : session.status === 'error' ? 'status' : null;
  if (!key || dismissed === key) return null;
  const last = lastUserMessage(messages);
  const retry = async () => {
    if (!last) return;
    clearError(session.id);
    setDismissed(key);
    const images = messageImages(last);
    await sendMessage(session.id, messageText(last), images.length ? images : undefined);
  };
  return (
    <div role="alert" data-testid="error-banner" className="flex items-start gap-3 rounded-[10px] border border-[rgba(240,113,120,0.32)] bg-ob-danger-soft px-3.5 py-2.5 animate-ob-fade-in">
      <CircleX size={16} aria-hidden className="mt-[2px] shrink-0 text-ob-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium text-ob-text">The last turn failed</span>
        <span className="ob-selectable break-words font-mono text-[12px] text-ob-text-2">{err?.message ?? 'The model or a tool returned an error.'}</span>
      </div>
      {last ? (
        <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => void retry()} data-testid="error-retry">
          Retry
        </Button>
      ) : null}
      <IconButton
        label="Dismiss"
        icon={X}
        size="sm"
        onClick={() => {
          setDismissed(key);
          clearError(session.id);
        }}
      />
    </div>
  );
}

// ───────────────────────────── Empty state ─────────────────────────────

const SUGGESTIONS = [
  'Explain how this codebase is organised',
  'Find and fix a bug in…',
  'Write tests for…',
  'Review my uncommitted changes',
];

function EmptyChat({ session }: { session: SessionSummary }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-16 text-center" data-testid="chat-empty">
      <div className="flex size-12 items-center justify-center rounded-[13px] border border-ob-border bg-[radial-gradient(circle_at_30%_20%,rgba(143,184,222,0.16),transparent_70%)]">
        <AppMark size={26} />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ob-text">What should we work on?</h2>
        <p className="text-ui text-ob-text-3">
          in <span className="font-mono text-[12px] text-ob-text-2">{basename(session.cwd)}</span> · type <Kbd>/</Kbd> for commands, <Kbd>@</Kbd> to mention files
        </p>
      </div>
      <div className="flex max-w-[560px] flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setDraft(session.id, s.endsWith('…') ? s.slice(0, -1) : s);
              focusComposer(session.id);
            }}
            className="ob-transition rounded-pill border border-ob-border bg-ob-surface-1 px-3 py-1 text-small text-ob-text-2 hover:border-[#30414f] hover:text-ob-text"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Transcript ─────────────────────────────

function Transcript({
  session,
  entry,
  pending,
  onRewind,
  onOpenImage,
}: {
  session: SessionSummary;
  entry: TranscriptEntry;
  pending: PendingItem[];
  onRewind: (m: Message) => void;
  onOpenImage: (img: ImageBlock) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const messages = entry.session.messages;
  const awaiting = useMemo(() => new Set(pending.map((p) => p.req.toolUseId)), [pending]);
  const start = showAll ? 0 : Math.max(0, messages.length - WINDOW);
  const visible = start > 0 ? messages.slice(start) : messages;
  const streamingId = entry.streamingMessageId;
  const running = session.status === 'running' || session.status === 'waiting';
  const streamingMsg = streamingId ? messages.find((m) => m.id === streamingId) : undefined;
  const timing = useMemo(
    () => (streamingMsg ? timingFor(streamingMsg.id, entry.blockStarts, entry.blockEnds, streamingMsg.blocks.length) : undefined),
    [streamingMsg, entry.blockStarts, entry.blockEnds],
  );
  const rewindable = session.kind !== 'subagent';

  return (
    <AwaitingToolsContext.Provider value={awaiting}>
      {start > 0 ? (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)} data-testid="show-earlier">
            Show {pluralize(start, 'earlier message')}
          </Button>
        </div>
      ) : null}
      {visible.map((m, i) => {
        const old = visible.length - i > 8;
        const style = old ? ({ contentVisibility: 'auto', containIntrinsicSize: 'auto 160px' } as const) : undefined;
        let node: ReactNode = null;
        if (m.role === 'user') {
          node = (
            <UserMessage
              message={m}
              onRewind={rewindable && m.tag !== 'hook' && m.tag !== 'command' ? onRewind : undefined}
              rewindDisabled={running}
              onOpenImage={onOpenImage}
            />
          );
        } else if (m.role === 'assistant') {
          const streaming = m.id === streamingId;
          node = <AssistantMessage message={m} cwd={session.cwd} streaming={streaming} timing={streaming ? timing : undefined} onOpenImage={onOpenImage} />;
        } else if (m.tag === 'compact_summary') {
          node = <CompactDivider message={m} />;
        } else {
          node = <SystemNote message={m} />;
        }
        return (
          <div key={m.id} style={style} className="min-w-0">
            {node}
          </div>
        );
      })}
      {pending.map((p, i) =>
        p.kind === 'permission' ? (
          <PermissionPrompt key={p.req.requestId} request={p.req} cwd={session.cwd} active={i === 0} />
        ) : p.kind === 'question' ? (
          <QuestionCard key={p.req.requestId} request={p.req} active={i === 0} />
        ) : (
          <PlanApproval key={p.req.requestId} request={p.req} active={i === 0} />
        ),
      )}
      <ErrorBanner session={session} messages={messages} />
      <RunningStatus session={session} entry={entry} waiting={pending.length > 0} />
    </AwaitingToolsContext.Provider>
  );
}

// ───────────────────────────── View ─────────────────────────────

export function ChatView({ sessionId }: { sessionId: string }) {
  const summary = useSessionSummary(sessionId);
  const entry = useTranscript(sessionId);
  const { loading, error } = useTranscriptLoading(sessionId);
  const pending = usePendingItems(sessionId, entry);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [rewindTarget, setRewindTarget] = useState<Message | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const [lightbox, setLightbox] = useState<ImageBlock | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const sessionsLoaded = useSessions((s) => s.loaded);

  const session = summary ?? (entry ? entry.session : undefined);
  const messages = entry?.session.messages;
  // The key changes when the scroll container (re)appears or the transcript first loads: re-attach and re-pin.
  const { atBottom, hasNew, scrollToBottom } = useStickToBottom(scrollRef, contentRef, `${sessionId}:${session ? 'known' : 'unknown'}:${entry ? 'loaded' : 'loading'}`);
  const running = session?.status === 'running' || session?.status === 'waiting';
  const lastUser = useMemo(() => (messages ? lastUserMessage(messages) : undefined), [messages]);

  // Esc anywhere in the view (outside text fields and overlays) stops the running turn. Prompt cards handle Esc
  // first in the capture phase and stop propagation, so this bubble-phase listener never sees those.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || overlayOpen() || isEditableTarget(e.target)) return;
      e.preventDefault();
      void interrupt(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, sessionId]);

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void addImageFiles(sessionId, filesFrom(e.dataTransfer)).then((n) => {
        if (n) focusComposer(sessionId);
      });
    },
    [sessionId],
  );

  const confirmRewind = async () => {
    const m = rewindTarget;
    if (!m) return;
    const r = await rewind(sessionId, m.id, restoreFiles);
    if (r) {
      setDraft(sessionId, messageText(m));
      focusComposer(sessionId);
    }
  };

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="chat-view">
        {loading || !sessionsLoaded ? (
          <Spinner size={18} className="text-ob-text-3" label="Loading session" />
        ) : (
          <EmptyState icon={MessageSquareText} title="Session not found" description="It may have been deleted." />
        )}
      </div>
    );
  }

  const isSub = session.kind === 'subagent';
  const rewindIndex = rewindTarget && messages ? messages.findIndex((m) => m.id === rewindTarget.id) : -1;
  const removedCount = rewindIndex >= 0 && messages ? messages.length - rewindIndex : 0;
  const changed = entry?.session.changedFiles.length ?? 0;

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="chat-view"
      data-session-id={sessionId}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ChatHeader session={session} hasMessages={!!messages?.length} />

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto [scrollbar-gutter:stable]" data-testid="transcript" tabIndex={-1}>
          <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-[820px] flex-col gap-5 px-6 pb-8 pt-6">
            {!entry ? (
              error ? (
                <EmptyState
                  icon={CircleX}
                  title="Could not load this session"
                  description={error}
                  action={
                    <Button size="sm" icon={RotateCcw} onClick={() => void loadTranscript(sessionId, { force: true })}>
                      Try again
                    </Button>
                  }
                />
              ) : (
                <div className="flex flex-col gap-6 pt-4" aria-busy={loading} aria-label="Loading transcript">
                  <div className="ob-skeleton ml-auto h-10 w-2/5 rounded-[14px]" />
                  <div className="flex flex-col gap-2">
                    <div className="ob-skeleton h-3.5 w-4/5" />
                    <div className="ob-skeleton h-3.5 w-3/5" />
                    <div className="ob-skeleton h-9 w-full rounded-[9px]" />
                  </div>
                </div>
              )
            ) : entry.session.messages.length === 0 && pending.length === 0 && !running ? (
              <EmptyChat session={session} />
            ) : (
              <Transcript session={session} entry={entry} pending={pending} onRewind={setRewindTarget} onOpenImage={setLightbox} />
            )}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            data-testid="jump-latest"
            className="ob-transition absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-pill border border-ob-border bg-ob-surface-3 pl-2.5 pr-3 text-small text-ob-text-2 shadow-pop hover:text-ob-text animate-ob-fade-in"
          >
            <ArrowDown size={14} aria-hidden />
            Jump to latest
            {hasNew ? <span className="size-1.5 rounded-full bg-ob-accent" aria-label="New messages" /> : null}
          </button>
        ) : null}
      </div>

      <div className="shrink-0 px-6 pb-4 pt-1">
        <div className="mx-auto w-full max-w-[820px]">
          {isSub ? (
            <div className="flex items-center gap-3 rounded-[12px] border border-ob-border bg-ob-surface-1 px-4 py-3 text-ui text-ob-text-3" data-testid="subagent-footer">
              <Bot size={15} aria-hidden className="shrink-0 text-ob-violet" />
              <span className="flex-1">This is a subagent run. It reports back to its parent session.</span>
              {session.parentSessionId ? (
                <Button size="sm" variant="secondary" onClick={() => openSession(session.parentSessionId as string)}>
                  Open parent
                </Button>
              ) : null}
            </div>
          ) : (
            <Composer session={session} lastUserText={lastUser ? messageText(lastUser) : undefined} onSent={() => scrollToBottom()} waitingOnUser={pending.length > 0} />
          )}
        </div>
      </div>

      {dragging && !isSub ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-[14px] border-2 border-dashed border-[rgba(143,184,222,0.55)] bg-[rgba(11,18,21,0.82)] animate-ob-fade-in">
          <div className="flex flex-col items-center gap-2 text-ob-text-2">
            <ImagePlus size={26} aria-hidden className="text-ob-accent" />
            <span className="text-ui">Drop images to attach</span>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={!!rewindTarget}
        onOpenChange={(o) => {
          if (!o) setRewindTarget(null);
        }}
        title="Rewind to this message?"
        description={`${pluralize(removedCount, 'message')} from this point on will be removed. The message goes back into the composer so you can edit and resend it.`}
        confirmLabel="Rewind"
        onConfirm={confirmRewind}
      >
        <div className="flex flex-col gap-3" data-testid="rewind-dialog">
          {rewindTarget ? (
            <div className="line-clamp-3 rounded-[8px] border border-ob-border bg-ob-surface-2 px-3 py-2 text-small text-ob-text-2">{messageText(rewindTarget) || '(image)'}</div>
          ) : null}
          <Checkbox
            checked={restoreFiles}
            onCheckedChange={setRestoreFiles}
            label="Also restore files"
            description={
              changed
                ? `Undo changes to ${pluralize(changed, 'file')} made after this message (new files are deleted).`
                : 'Undo file changes made after this message (new files are deleted).'
            }
          />
        </div>
      </ConfirmDialog>
      <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
