// Chat header: editable title, cwd chip (folder picker → new session in that folder), git branch, context meter,
// right-panel toggle. Owner: ui-chat.
import { Bot, ChevronRight, Folder, GitBranch, PanelRightClose, PanelRightOpen, Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { IconButton } from '@renderer/components/ui/button';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { pickFolder } from '@renderer/lib/bridge';
import { cn } from '@renderer/lib/cn';
import { basename, formatTokens } from '@renderer/lib/format';
import { createSession, deleteSession, openSession, renameSession, toggleRightPanel } from '@renderer/state/actions';
import { useModelInfo, useSessionSummary } from '@renderer/state/selectors';
import { useSettings } from '@renderer/state/settings';
import { useUi } from '@renderer/state/ui';
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
        className="h-7 min-w-[200px] max-w-[480px] flex-1 rounded-ctl border border-[rgba(143,184,222,0.5)] bg-ob-surface-2 px-2 text-[14px] font-medium text-ob-text outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename session"
      data-testid="chat-title"
      className="ob-transition group -ml-1.5 flex h-7 min-w-0 items-center gap-1.5 rounded-ctl px-1.5 text-left hover:bg-ob-hover"
    >
      <span className="truncate text-[14px] font-medium text-ob-text">{session.title || 'Untitled session'}</span>
      <Pencil size={12} aria-hidden className="shrink-0 text-ob-text-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/** Context window usage ring: last prompt tokens vs the model's context length. */
export function ContextMeter({ session }: { session: SessionSummary }) {
  const model = useModelInfo(session.model);
  const compactAt = useSettings((s) => s.settings?.autoCompactPercent ?? 80) / 100;
  const used = session.usage.lastPromptTokens;
  const total = model?.contextLength ?? 32_768;
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const pct = Math.round(ratio * 100);
  const tone = ratio >= compactAt ? 'var(--ob-danger)' : ratio >= compactAt * 0.75 ? 'var(--ob-warning)' : 'var(--ob-accent)';
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          <span>
            {formatTokens(used)} of {formatTokens(total)} tokens used
          </span>
          <span className="text-ob-text-3">
            {model?.label ?? 'Unknown model'} · auto-compacts at {Math.round(compactAt * 100)}%
          </span>
        </span>
      }
    >
      <span
        className="flex h-7 items-center gap-1.5 rounded-ctl px-1.5 font-mono text-[11px] text-ob-text-3"
        data-testid="context-meter"
        aria-label={`Context ${pct}% used`}
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--ob-border)" strokeWidth="2.25" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(used ? 1.5 : 0, ratio * c)} ${c}`}
            style={{ transition: 'stroke-dasharray 300ms ease-out' }}
          />
        </svg>
        <span className="ob-tabular">{pct}%</span>
      </span>
    </Tooltip>
  );
}

async function changeFolder(session: SessionSummary, hasMessages: boolean): Promise<void> {
  const picked = await pickFolder(session.cwd);
  if (!picked || picked.replace(/[\\/]+$/, '').toLowerCase() === session.cwd.replace(/[\\/]+$/, '').toLowerCase()) return;
  // Sessions cannot move between folders (tools, memory and checkpoints are rooted at cwd), so a new folder means a
  // new session with the same model and mode. An empty session is replaced instead of left behind.
  const next = await createSession({ cwd: picked, model: session.model, permissionMode: session.permissionMode });
  if (next && !hasMessages) void deleteSession(session.id);
}

export function ChatHeader({ session, hasMessages }: { session: SessionSummary; hasMessages: boolean }) {
  const branch = useGitBranch(session.cwd);
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const parent = useSessionSummary(session.parentSessionId);
  const homeDir = useSettings((s) => s.system?.homeDir ?? null);
  const isSub = session.kind === 'subagent';

  return (
    <div className="@container flex h-11 shrink-0 items-center gap-2 border-b border-ob-border pl-5 pr-2.5" data-testid="chat-header">
      {isSub && parent ? (
        <>
          <button
            type="button"
            onClick={() => openSession(parent.id)}
            className="ob-transition flex h-7 min-w-0 max-w-[220px] shrink items-center gap-1.5 rounded-ctl px-1.5 text-ui text-ob-text-3 hover:bg-ob-hover hover:text-ob-text-2"
            data-testid="parent-link"
          >
            <span className="truncate">{parent.title}</span>
          </button>
          <ChevronRight size={13} aria-hidden className="shrink-0 text-ob-text-3" />
          <Bot size={14} aria-hidden className="shrink-0 text-ob-violet" />
        </>
      ) : null}
      <div className="flex min-w-0 shrink items-center">
        <EditableTitle session={session} />
      </div>
      {session.kind === 'scheduled' ? (
        <Badge tone="accent" className="shrink-0">
          Scheduled
        </Badge>
      ) : null}
      <span className="mx-1 h-4 w-px shrink-0 bg-ob-border" aria-hidden />
      <Tooltip content={`${session.cwd} — click to start a session in another folder`}>
        <button
          type="button"
          onClick={() => void changeFolder(session, hasMessages)}
          disabled={isSub}
          data-testid="cwd-chip"
          className={cn(
            'ob-transition flex h-7 min-w-0 max-w-[260px] shrink items-center gap-1.5 rounded-ctl border border-ob-border bg-ob-surface-1 px-2 font-mono text-[11.5px] text-ob-text-2 hover:border-[#30414f] hover:text-ob-text',
            'disabled:pointer-events-none',
          )}
        >
          <Folder size={12} aria-hidden className="shrink-0 text-ob-text-3" />
          <span className="truncate @max-[600px]:hidden">{basename(session.cwd) || (homeDir && session.cwd) || session.cwd}</span>
        </button>
      </Tooltip>
      {branch ? (
        <Tooltip content={`Git branch: ${branch}`}>
          <span className="flex h-7 min-w-0 max-w-[200px] shrink items-center gap-1.5 px-1 font-mono text-[11.5px] text-ob-text-3 @max-[680px]:hidden" data-testid="git-branch">
            <GitBranch size={12} aria-hidden className="shrink-0" />
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
