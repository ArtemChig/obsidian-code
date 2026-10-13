// Chat header (M13): Chivo 600 title, cwd + branch as mono tags (cwd = folder picker → new session in that folder),
// mono "CTX %" meter, right-panel toggle. Shares --ob-pane-head-h with the right panel's tab bar. Owner: ui-chat.
import { Bot, ChevronRight, Folder, GitBranch, PanelRightClose, PanelRightOpen, Pencil, ShieldOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { pickFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { basename, formatTokens } from '@renderer/lib/format';
import { createSession, deleteSession, loadGpuCatalog, openSession, renameSession, toggleRightPanel } from '@renderer/state/actions';
import { useGpu } from '@renderer/state/gpu';
import { useModelInfo, useSessionSummary } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { useUi } from '@renderer/state/ui';
import { contextUsage, knownContextLength } from './lib/context';
import { useGitBranch } from './lib/git';

function EditableTitle({ session }: { session: SessionSummary }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.title);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!editing) setValue(session.title);
  }, [session.title, editing]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = value.trim();
    if (v && v !== session.title) void renameSession(session.id, v);
    else setValue(session.title);
  };

  if (editing) {
    return (
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setValue(session.title);
            setEditing(false);
          }
        }}
        aria-label="Session title"
        data-testid="chat-title-input"
        className="h-7 min-w-[200px] max-w-[480px] flex-1 rounded-[2px] bg-s1 px-2 text-title font-semibold text-t1 shadow-[inset_0_0_0_1px_var(--acc)] outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename session"
      data-testid="chat-title"
      className="ob-transition group -ml-2 flex h-7 min-w-0 items-center gap-2 rounded-[2px] px-2 text-left hover:bg-hov"
    >
      <span className="truncate text-title font-semibold text-t1">{session.title || 'Untitled session'}</span>
      <Pencil size={11} aria-hidden className="shrink-0 text-t3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/** Context window usage: mono "CTX 31%" + a thin flat bar (last prompt tokens vs the model's context length). */
export function ContextMeter({ session }: { session: SessionSummary }) {
  const model = useModelInfo(session.model);
  const catalog = useGpu((s) => s.catalog);
  const compactAt = useSettings((s) => s.settings?.autoCompactPercent ?? 80) / 100;
  const used = session.usage.lastPromptTokens;
  const offlineVast = !model && session.model?.provider === 'vast';
  // A Vast model is not listed while the GPU is off: measure against the catalog's context length (loaded once).
  useEffect(() => {
    if (offlineVast) void loadGpuCatalog(false, true);
  }, [offlineVast]);
  const total = knownContextLength(model, session.model, catalog);
  const { pct, tone } = contextUsage(used, total, compactAt);
  // Colour only means status: near the auto-compact line the bar warns, past it it is an error.
  const fill = tone === 'error' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-t2';
  const value = tone === 'error' ? 'text-err' : tone === 'warn' ? 'text-warn' : 'text-t1';
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          <span>{total ? `${formatTokens(used)} of ${formatTokens(total)} tokens used` : `${formatTokens(used)} tokens used · context size unknown while the model is offline`}</span>
          <span className="text-t3">
            {model?.label ?? 'Unknown model'} · auto-compacts at {Math.round(compactAt * 100)}%
          </span>
        </span>
      }
    >
      <span
        className="flex h-7 shrink-0 items-center gap-2.5 px-1.5 font-mono"
        data-testid="context-meter"
        aria-label={pct !== null ? `Context ${pct}% used` : 'Context usage unknown'}
        role="meter"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-t3">Ctx</span>
          <span className={cn('ob-tabular text-[10.5px] tracking-[-0.02em]', value)}>{pct !== null ? `${pct}%` : '—'}</span>
        </span>
        <span aria-hidden className="relative h-[2px] w-12 overflow-hidden bg-s4 @max-[560px]:hidden">
          <span className={cn('absolute inset-y-0 left-0 transition-[width] duration-300 ease-out', fill)} style={{ width: `${pct === null ? 0 : Math.max(used ? 2 : 0, pct)}%` }} />
        </span>
      </span>
    </Tooltip>
  );
}

async function changeFolder(session: SessionSummary, disposable: boolean): Promise<void> {
  const picked = await pickFolder(session.cwd);
  if (!picked || picked.replace(/[\\/]+$/, '').toLowerCase() === session.cwd.replace(/[\\/]+$/, '').toLowerCase()) return;
  // Sessions cannot move between folders (tools, memory and checkpoints are rooted at cwd), so a new folder means a
  // new session with the same model and mode. A provably empty session is replaced instead of left behind (see
  // isDisposableSession: an unloaded transcript is never treated as empty).
  const next = await createSession({ cwd: picked, model: session.model, permissionMode: session.permissionMode, engine: session.engine });
  if (next && disposable) void deleteSession(session.id);
}

export function ChatHeader({ session, disposable }: { session: SessionSummary; disposable: boolean }) {
  const branch = useGitBranch(session.cwd);
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const parent = useSessionSummary(session.parentSessionId);
  const homeDir = useSettings((s) => s.system?.homeDir ?? null);
  const isSub = session.kind === 'subagent';

  return (
    <div className="@container flex h-[var(--ob-pane-head-h)] shrink-0 items-center gap-3 border-b border-rule pl-8 pr-3" data-testid="chat-header">
      {isSub && parent ? (
        <>
          <button
            type="button"
            onClick={() => openSession(parent.id)}
            className="ob-transition -ml-2 flex h-7 min-w-0 max-w-[220px] shrink items-center gap-1.5 rounded-[2px] px-2 text-[12.5px] tracking-[-0.012em] text-t3 hover:bg-hov hover:text-t1"
            data-testid="parent-link"
          >
            <span className="truncate">{parent.title}</span>
          </button>
          <ChevronRight size={12} aria-hidden className="-mx-1.5 shrink-0 text-t3" />
          <Bot size={13} aria-hidden className="shrink-0 text-t3" />
        </>
      ) : null}
      <div className="flex min-w-0 shrink items-center">
        <EditableTitle session={session} />
      </div>
      {session.kind === 'scheduled' ? (
        <Badge tone="accent" variant="outline" className="shrink-0">
          Scheduled
        </Badge>
      ) : null}
      {session.engine === 'claude-code' ? (
        <Tooltip content="Engine: the Claude Code harness runs this session on its model (switch in the composer toolbar)">
          <span className="flex shrink-0" data-testid="engine-tag">
            <Badge tone="neutral" variant="outline">
              Claude Code
            </Badge>
          </span>
        </Tooltip>
      ) : null}
      {session.permissionMode === 'bypassPermissions' ? (
        <Tooltip content="Bypass permissions: every tool runs without asking. Shift+Tab or the mode menu to change.">
          <span className="flex shrink-0" data-testid="bypass-badge">
            <Badge tone="danger" variant="outline" icon={ShieldOff}>
              Bypass
            </Badge>
          </span>
        </Tooltip>
      ) : null}
      <Tooltip content={`${session.cwd} — click to start a session in another folder`}>
        <button
          type="button"
          onClick={() => void changeFolder(session, disposable)}
          disabled={isSub}
          data-testid="cwd-chip"
          className={cn(
            'ob-transition flex h-[22px] min-w-0 max-w-[260px] shrink items-center gap-1.5 rounded-[1px] px-2 font-mono text-[10.5px] tracking-[-0.01em] text-t2 shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hov hover:text-t1',
            'disabled:pointer-events-none',
          )}
        >
          <Folder size={11} aria-hidden className="shrink-0 text-t3" />
          <span className="truncate @max-[600px]:hidden">{basename(session.cwd) || (homeDir && session.cwd) || session.cwd}</span>
        </button>
      </Tooltip>
      {branch ? (
        <Tooltip content={`Git branch: ${branch}`}>
          <span
            className="flex h-[22px] min-w-0 max-w-[200px] shrink items-center gap-1.5 rounded-[1px] px-2 font-mono text-[10.5px] tracking-[-0.01em] text-t2 shadow-[inset_0_0_0_1px_var(--line)] @max-[680px]:hidden"
            data-testid="git-branch"
          >
            <GitBranch size={11} aria-hidden className="shrink-0 text-t3" />
            <span className="truncate">{branch}</span>
          </span>
        </Tooltip>
      ) : null}
      <span className="flex-1" />
      <ContextMeter session={session} />
      <IconButton
        label={rightOpen ? 'Hide side panel' : 'Show side panel'}
        shortcut="Ctrl+\"
        icon={rightOpen ? PanelRightClose : PanelRightOpen}
        active={rightOpen}
        size="md"
        tooltipSide="bottom"
        onClick={() => toggleRightPanel()}
        data-testid="chat-panel-toggle"
      />
    </div>
  );
}
