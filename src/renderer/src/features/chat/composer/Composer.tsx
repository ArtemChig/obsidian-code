// Composer: auto-growing textarea, "/" command palette, "@" file palette, image paste/drop, permission mode,
// thinking toggle, model picker, Send / Stop. Owner: ui-chat.
import { ArrowUp, Brain, Clock, FileCode, Folder, Paperclip, Square, SquareSlash, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { SessionSummary, SlashCommandInfo } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Textarea } from '@renderer/components/ui/input';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { basename, dirname, truncate } from '@renderer/lib/format';
import { rpc } from '@renderer/lib/rpc';
import { sendMessage, setPermissionMode, setSessionModel, setThinking, withdrawQueued } from '@renderer/state/actions';
import { useModelInfo, useQueued } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { fuzzyRank } from '../lib/fuzzy';
import { applyCompletion, detectTrigger, mentionFor, nextPermissionMode, slashInsert, type Trigger } from '../lib/composer';
import { restoreToDraft, setAttachments, setDraft, stopTurn, useChatLocal } from '../state';
import { ImageLightbox, ImageThumb } from '../ui';
import { addImageFiles, filesFrom, removeAttachment } from './attachments';
import { ModeSelector } from './ModeSelector';
import { ModelNotice } from './ModelNotice';
import { ModelPicker } from './ModelPicker';
import { optionId, Palette, type PaletteItem } from './Palette';
import type { ImageBlock } from '@shared/types';

// ───────────────────────────── Data for the palettes ─────────────────────────────

const commandCache = new Map<string, { at: number; list: SlashCommandInfo[] }>();

function useCommands(cwd: string, wanted: boolean): SlashCommandInfo[] {
  const [list, setList] = useState<SlashCommandInfo[]>(() => commandCache.get(cwd)?.list ?? []);
  useEffect(() => {
    if (!wanted) return;
    const hit = commandCache.get(cwd);
    if (hit && Date.now() - hit.at < 30_000) {
      setList(hit.list);
      return;
    }
    let alive = true;
    rpc
      .request('commands.list', { cwd })
      .then((r) => {
        commandCache.set(cwd, { at: Date.now(), list: r });
        if (alive) setList(r);
      })
      .catch(() => {
        /* keep whatever we had */
      });
    return () => {
      alive = false;
    };
  }, [cwd, wanted]);
  return list;
}

function useFileSearch(cwd: string, query: string | null): { files: string[]; loading: boolean } {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query === null) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      rpc
        .request('files.search', { cwd, query, limit: 30 })
        .then((r) => {
          if (alive) setFiles(r);
        })
        .catch(() => {
          if (alive) setFiles([]);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 90);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [cwd, query]);
  return { files, loading };
}

const EMPTY_IMAGES: ImageBlock[] = [];

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width of a single line of composer text (same font as the textarea). */
function textWidth(text: string, el: HTMLElement | null): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 8;
  const cs = el ? window.getComputedStyle(el) : null;
  measureCtx.font = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : '400 14.5px "IBM Plex Sans"';
  return measureCtx.measureText(text).width;
}

/** Ghost argument hint after a completed slash command ("/compact ␣[instructions]"). */
function ArgHint({ text, commands }: { text: string; commands: SlashCommandInfo[] }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const m = /^\/([\w:.-]+) $/.exec(text);
  const cmd = m ? commands.find((c) => c.name === m[1]) : undefined;
  if (!cmd?.argumentHint) return null;
  const left = 16 + textWidth(text, ref.current?.parentElement?.querySelector('textarea') ?? null);
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="arg-hint"
      className="pointer-events-none absolute top-3 truncate font-mono text-[12.5px] leading-[22px] text-ob-text-3"
      style={{ left, maxWidth: `calc(100% - ${left + 16}px)` }}
    >
      {cmd.argumentHint}
    </span>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span className="font-mono text-[10.5px] text-ob-text-2">{k}</span>
      <span>{label}</span>
    </span>
  );
}

// ───────────────────────────── Composer ─────────────────────────────

export interface ComposerProps {
  session: SessionSummary;
  /** Last user message text (ArrowUp in an empty composer recalls it). */
  lastUserText?: string;
  /** Called after a message was sent (the transcript re-pins to the bottom). */
  onSent?: () => void;
  /** Something above (a prompt card) waits for the user. */
  waitingOnUser?: boolean;
}

export function Composer({ session, lastUserText, onSent, waitingOnUser }: ComposerProps) {
  const sessionId = session.id;
  const text = useChatLocal((s) => s.drafts[sessionId] ?? '');
  const images = useChatLocal((s) => s.attachments[sessionId] ?? EMPTY_IMAGES);
  const focusNonce = useChatLocal((s) => s.focusNonce[sessionId] ?? 0);
  const queued = useQueued(sessionId);
  const model = useModelInfo(session.model);
  const running = session.status === 'running' || session.status === 'waiting';
  // Bypass joins the Shift+Tab cycle (and skips its confirmation) only when it is the user's default mode.
  const bypassOptIn = useSettings((s) => s.settings?.defaultPermissionMode === 'bypassPermissions');

  const ta = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [lightbox, setLightbox] = useState<ImageBlock | null>(null);
  const [focused, setFocused] = useState(false);

  const trigger: Trigger | null = useMemo(() => {
    const t = detectTrigger(text, caret);
    if (!t || !focused) return null;
    if (dismissedAt !== null && dismissedAt === t.start) return null;
    return t;
  }, [text, caret, dismissedAt, focused]);

  const commands = useCommands(session.cwd, trigger?.kind === 'slash' || text.startsWith('/'));
  const slashItems = useMemo(() => {
    if (trigger?.kind !== 'slash') return [];
    return fuzzyRank(commands, trigger.query, (c) => [c.name, c.description]).slice(0, 40);
  }, [commands, trigger]);
  const { files, loading: filesLoading } = useFileSearch(session.cwd, trigger?.kind === 'mention' ? trigger.query : null);
  const mentionItems = trigger?.kind === 'mention' ? files : [];
  const count = trigger?.kind === 'slash' ? slashItems.length : mentionItems.length;
  const paletteOpen = !!trigger && (trigger.kind === 'mention' || slashItems.length > 0 || trigger.query.length === 0);

  // Reset the highlighted row when the query changes.
  const queryKey = trigger ? `${trigger.kind}:${trigger.query}` : '';
  useEffect(() => setActive(0), [queryKey]);
  useEffect(() => {
    if (active >= count && count > 0) setActive(count - 1);
  }, [active, count]);

  // External focus requests (Files panel inserted an @mention, rewind restored a draft…).
  useEffect(() => {
    if (!focusNonce) return;
    const el = ta.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    setCaret(end);
  }, [focusNonce]);

  // Focus on mount.
  useEffect(() => {
    ta.current?.focus();
  }, [sessionId]);

  const syncCaret = () => {
    const el = ta.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const setText = (v: string) => setDraft(sessionId, v);

  const placeCaret = (pos: number) => {
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const send = useCallback(
    async (override?: string) => {
      const body = (override ?? text).trim();
      if ((!body && !images.length) || sending) return;
      setSending(true);
      const prevText = text;
      const prevImages = images;
      setDraft(sessionId, '');
      setAttachments(sessionId, []);
      setDismissedAt(null);
      const r = await sendMessage(sessionId, body, prevImages.length ? prevImages : undefined);
      setSending(false);
      if (!r) {
        setDraft(sessionId, prevText);
        setAttachments(sessionId, prevImages);
        return;
      }
      onSent?.();
    },
    [text, images, sending, sessionId, onSent],
  );

  const complete = (index: number, run: boolean) => {
    if (!trigger) return;
    if (trigger.kind === 'slash') {
      const c = slashItems[index];
      if (!c) return;
      const ins = slashInsert(c.name);
      if (run && !c.argumentHint) {
        void send(ins);
        return;
      }
      const r = applyCompletion(text, trigger, ins);
      setText(r.text);
      placeCaret(r.caret);
    } else {
      const f = mentionItems[index];
      if (!f) return;
      const r = applyCompletion(text, trigger, mentionFor(f));
      setText(r.text);
      placeCaret(r.caret);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (paletteOpen && trigger) {
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault();
        if (count) setActive((a) => (a + 1) % count);
        return;
      }
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault();
        if (count) setActive((a) => (a - 1 + count) % count);
        return;
      }
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
        if (count) {
          e.preventDefault();
          // Enter runs the highlighted command only once something was typed ("/" + Enter must not fire /clear).
          complete(active, e.key === 'Enter' && trigger.query.length > 0);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(trigger.start);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      void setPermissionMode(sessionId, nextPermissionMode(session.permissionMode, bypassOptIn));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      void stopTurn(sessionId);
      return;
    }
    if (e.key === 'ArrowUp' && !text && lastUserText) {
      e.preventDefault();
      setText(lastUserText);
      placeCaret(lastUserText.length);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFrom(e.clipboardData).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    void addImageFiles(sessionId, files);
  };

  const canSend = (!!text.trim() || images.length > 0) && !sending;
  const visionWarning = images.length > 0 && model && !model.supportsVision;
  const placeholder = waitingOnUser
    ? 'Answer above, or type to queue a follow-up…'
    : running
      ? 'Queue a follow-up — Enter to queue, Esc to stop'
      : 'Ask Obsidian to build, fix or explain…';

  const listId = `composer-palette-${sessionId}`;

  return (
    <div className="@container relative" data-testid="composer">
      {queued.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid="queued">
          {queued.map((q) => (
            <span
              key={q.messageId}
              className="flex max-w-full items-center gap-1.5 rounded-pill border border-ob-border bg-ob-surface-1 py-0.5 pl-2 pr-1 text-small text-ob-text-2 animate-ob-fade-in"
              data-testid="queued-chip"
            >
              <Tooltip content="Sent automatically after the current turn">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Clock size={12} aria-hidden className="shrink-0 text-ob-accent" />
                  <span className="text-ob-text-3">Queued</span>
                  <span className="min-w-0 truncate">{truncate(q.text.replace(/\s+/g, ' '), 90)}</span>
                </span>
              </Tooltip>
              <IconButton
                label="Withdraw (back to the composer)"
                icon={X}
                size="xs"
                data-testid="queued-withdraw"
                onClick={() =>
                  void withdrawQueued(sessionId, q.messageId).then((r) => {
                    if (r.length) restoreToDraft(sessionId, r.map((x) => x.text));
                  })
                }
              />
            </span>
          ))}
        </div>
      ) : null}

      {paletteOpen && trigger?.kind === 'slash' ? (
        <Palette
          id={listId}
          testId="slash-palette"
          title="Commands"
          active={active}
          onHover={setActive}
          onPick={(i) => complete(i, true)}
          loading={commands.length === 0}
          empty="No matching commands"
          items={slashItems.map(
            (c): PaletteItem => ({
              key: c.name,
              icon: <SquareSlash size={14} aria-hidden />,
              label: <span className="font-mono text-[12.5px]">/{c.name}</span>,
              hint: c.argumentHint,
              description: c.description,
              trailing:
                c.source !== 'builtin' ? (
                  <Badge tone={c.source === 'project' ? 'accent' : 'neutral'} mono>
                    {c.source}
                  </Badge>
                ) : undefined,
            }),
          )}
        />
      ) : null}
      {paletteOpen && trigger?.kind === 'mention' ? (
        <Palette
          id={listId}
          testId="mention-palette"
          title="Files"
          active={active}
          loading={filesLoading}
          onHover={setActive}
          onPick={(i) => complete(i, false)}
          empty="No matching files"
          items={mentionItems.map((f): PaletteItem => {
            const norm = f.replace(/\\/g, '/');
            const isDir = norm.endsWith('/');
            const dir = dirname(norm);
            return {
              key: f,
              icon: isDir ? <Folder size={14} aria-hidden /> : <FileCode size={14} aria-hidden />,
              label: basename(norm),
              hint: dir && dir !== norm ? dir : undefined,
            };
          })}
        />
      ) : null}

      <ModelNotice model={session.model} className="mb-2" />
      <div
        className={cn(
          'ob-transition rounded-[14px] border bg-ob-surface-1',
          focused ? 'border-[rgba(143,184,222,0.42)] shadow-[0_0_0_4px_rgba(143,184,222,0.06)]' : 'border-ob-border',
          session.permissionMode === 'bypassPermissions' && 'border-[rgba(240,113,120,0.35)]',
        )}
      >
        {images.length ? (
          <div className="flex flex-wrap items-center gap-2.5 px-3.5 pt-3" data-testid="attachments">
            {images.map((img, i) => (
              <ImageThumb key={`${img.name}-${i}`} image={img} size={56} onRemove={() => removeAttachment(sessionId, i)} onOpen={() => setLightbox(img)} />
            ))}
            {visionWarning ? (
              <span className="flex items-center gap-1.5 text-small text-ob-warning">
                <TriangleAlert size={13} aria-hidden />
                {model?.label ?? 'This model'} can't see images
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="relative">
        <Textarea
          ref={ta}
          bare
          minRows={2}
          maxRows={14}
          value={text}
          data-composer-input=""
          data-testid="composer-input"
          aria-label="Message"
          role="combobox"
          aria-expanded={paletteOpen}
          aria-controls={paletteOpen ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={paletteOpen && count ? optionId(listId, active) : undefined}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={syncCaret}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncCaret();
          }}
          onClick={syncCaret}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block px-4 pb-1 pt-3 text-[14.5px] leading-[22px]"
        />
        <ArgHint text={text} commands={commands} />
        </div>
        <div className="flex items-center gap-0.5 px-2 pb-2 pt-1">
          <IconButton label="Attach images" icon={Paperclip} size="md" onClick={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = '';
              void addImageFiles(sessionId, list);
            }}
          />
          <ModeSelector mode={session.permissionMode} confirmBypass={!bypassOptIn} onChange={(m) => void setPermissionMode(sessionId, m)} />
          <Tooltip content={session.thinking ? 'Thinking on — click to turn off' : 'Thinking off — click to turn on'}>
            <button
              type="button"
              data-testid="thinking-toggle"
              aria-pressed={session.thinking}
              onClick={() => void setThinking(sessionId, !session.thinking)}
              className={cn(
                'ob-transition flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-small',
                session.thinking ? 'text-ob-violet hover:bg-ob-violet-soft' : 'text-ob-text-3 hover:bg-ob-hover hover:text-ob-text-2',
              )}
            >
              <Brain size={13} aria-hidden />
              <span className="whitespace-nowrap @max-[600px]:hidden">{session.thinking ? 'Thinking' : 'No thinking'}</span>
            </button>
          </Tooltip>
          <span className="flex-1" />
          <ModelPicker value={session.model} onChange={(m) => void setSessionModel(sessionId, m)} />
          {running ? (
            <Tooltip content="Stop" shortcut="Esc">
              <button
                type="button"
                aria-label="Stop"
                data-testid="stop-button"
                onClick={() => void stopTurn(sessionId)}
                className="ob-transition ml-1 flex size-8 items-center justify-center rounded-[8px] border border-ob-border bg-ob-surface-2 text-ob-text hover:border-[rgba(240,113,120,0.4)] hover:bg-ob-danger-soft hover:text-ob-danger"
              >
                <Square size={12} fill="currentColor" aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          {!running || canSend ? (
            <Tooltip content={running ? 'Queue message' : 'Send'} shortcut="Enter">
              <button
                type="button"
                aria-label={running ? 'Queue message' : 'Send'}
                data-testid="send-button"
                disabled={!canSend}
                onClick={() => void send()}
                className="ob-transition ml-1 flex size-8 items-center justify-center rounded-[8px] bg-ob-accent text-ob-accent-ink hover:bg-ob-accent-hover disabled:bg-ob-surface-2 disabled:text-ob-text-3"
              >
                <ArrowUp size={16} strokeWidth={2.25} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="mt-1.5 flex h-4 items-center gap-3 overflow-hidden px-1.5 text-meta text-ob-text-3 @max-[480px]:hidden" data-testid="composer-hints">
        <Hint k="Enter" label={running ? 'queue' : 'send'} />
        <Hint k="Shift+Enter" label="new line" />
        <Hint k="Shift+Tab" label="mode" />
        <Hint k="/" label="commands" />
        <Hint k="@" label="files" />
        {running ? <Hint k="Esc" label="stop" /> : null}
      </div>
      <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
