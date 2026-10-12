// Right-panel tab contents (container + tab bar live in app/RightPanel.tsx). Owner: ui-chat.
// Contract: export ChangesPanel, TodosPanel, AgentsPanel, FilesPanel — each ({ sessionId }: { sessionId: string }).
import { ArrowLeft, ArrowUpRight, AtSign, Bot, ChevronRight, File, FileDiff, FilePlus, Folder, FolderOpen, FolderTree, ListTodo, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChangedFile } from '@shared/types';
import { IconButton } from '@renderer/components/ui/button';
import { EmptyState, ProgressBar, Spinner, StatusDot } from '@renderer/components/ui/feedback';
import { Input } from '@renderer/components/ui/input';
import { SectionLabel } from '@renderer/components/ui/layout';
import { RelativeTime } from '@renderer/components/ui/time';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { basename, dirname, pluralize } from '@renderer/lib/format';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { openSession } from '@renderer/state/actions';
import { useSessionSummary, useSubagents, useTranscript } from '@renderer/state/selectors';
import { mentionFor } from './lib/composer';
import { displayPath } from './lib/tool-meta';
import { insertIntoComposer } from './state';
import { Elapsed } from './ui';
import { TodoChecklist } from './tools/bodies';
import { DiffStat, DiffView } from './tools/DiffView';

function PanelLoading() {
  return (
    <div className="flex flex-col gap-2.5 p-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="ob-skeleton h-7 w-full" />
      ))}
    </div>
  );
}

// ───────────────────────────── Changes ─────────────────────────────

function DiffPane({ sessionId, file, cwd, onBack }: { sessionId: string; file: ChangedFile; cwd: string; onBack: () => void }) {
  const [state, setState] = useState<{ before: string; after: string } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    rpc
      .request('files.diff', { sessionId, path: file.path })
      .then((r) => alive && setState(r))
      .catch((err) => alive && setState({ error: errorMessage(err) }));
    return () => {
      alive = false;
    };
  }, [sessionId, file.path, file.lastToolUseId, file.additions, file.deletions]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-diff">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ob-border px-2">
        <IconButton label="Back to changed files" icon={ArrowLeft} size="sm" onClick={onBack} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ob-text" title={file.path}>
          {displayPath(file.path, cwd)}
        </span>
        <DiffStat additions={file.additions} deletions={file.deletions} className="shrink-0 pr-1" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!state ? (
          <PanelLoading />
        ) : 'error' in state ? (
          <EmptyState size="sm" icon={FileDiff} title="Diff unavailable" description={state.error} />
        ) : (
          <DiffView before={state.before} after={state.after} path={file.path} isNewFile={file.isNew} className="min-h-full" />
        )}
      </div>
    </div>
  );
}

export function ChangesPanel({ sessionId }: { sessionId: string }) {
  const entry = useTranscript(sessionId);
  const summary = useSessionSummary(sessionId);
  const [selected, setSelected] = useState<string | null>(null);
  const files = useMemo(() => (entry ? [...entry.session.changedFiles].sort((a, b) => a.path.localeCompare(b.path)) : []), [entry]);
  const cwd = summary?.cwd ?? '';
  if (!entry) return <PanelLoading />;
  const file = selected ? files.find((f) => f.path === selected) : undefined;
  if (file) return <DiffPane sessionId={sessionId} file={file} cwd={cwd} onBack={() => setSelected(null)} />;
  if (!files.length) {
    return <EmptyState size="sm" icon={FileDiff} title="No changes yet" description="Files the agent edits or creates in this session show up here." />;
  }
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="flex flex-col p-2" data-testid="changes-panel">
      <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
        <span className="text-small text-ob-text-3">{pluralize(files.length, 'file')} changed</span>
        <DiffStat additions={add} deletions={del} />
      </div>
      <ul className="flex flex-col">
        {files.map((f) => {
          const rel = displayPath(f.path, cwd);
          const dir = dirname(rel.replace(/\\/g, '/'));
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setSelected(f.path)}
                data-testid="changed-file"
                className="ob-transition group flex h-9 w-full items-center gap-2.5 rounded-ctl px-2 text-left hover:bg-ob-hover"
                title={f.path}
              >
                {f.isNew ? <FilePlus size={14} aria-label="New file" className="shrink-0 text-ob-success" /> : <FileDiff size={14} aria-hidden className="shrink-0 text-ob-text-3" />}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="shrink-0 truncate text-ui text-ob-text">{basename(rel)}</span>
                  {dir && dir !== rel ? <span className="min-w-0 truncate font-mono text-[10.5px] text-ob-text-3">{dir}</span> : null}
                </span>
                <DiffStat additions={f.additions} deletions={f.deletions} className="shrink-0" />
                <ChevronRight size={13} aria-hidden className="shrink-0 text-ob-text-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────────────────────── Todos ─────────────────────────────

export function TodosPanel({ sessionId }: { sessionId: string }) {
  const entry = useTranscript(sessionId);
  if (!entry) return <PanelLoading />;
  const todos = entry.session.todos;
  if (!todos.length) {
    return <EmptyState size="sm" icon={ListTodo} title="No todos" description="The agent keeps a checklist here for multi-step tasks." />;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div className="flex flex-col gap-3 p-3.5" data-testid="todos-panel">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-small">
          <span className="text-ob-text-2">{current ? (current.activeForm ?? current.content) : done === todos.length ? 'All done' : 'Up next'}</span>
          <span className="ob-tabular font-mono text-[11px] text-ob-text-3">
            {done}/{todos.length}
          </span>
        </div>
        <ProgressBar value={todos.length ? done / todos.length : 0} tone={done === todos.length ? 'success' : 'accent'} label="Todo progress" />
      </div>
      <TodoChecklist todos={todos} />
    </div>
  );
}

// ───────────────────────────── Agents ─────────────────────────────

export function AgentsPanel({ sessionId }: { sessionId: string }) {
  const subagents = useSubagents(sessionId);
  const entry = useTranscript(sessionId);
  // Agent type per child, from the Task tool calls in the parent transcript.
  const types = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of entry?.session.messages ?? []) {
      for (const b of m.blocks) {
        if (b.type !== 'tool_use' || b.name !== 'Task') continue;
        const d = b.result?.display;
        const t = d?.kind === 'subagent' ? d.agentType : String(b.input.subagent_type ?? '');
        if (d?.kind === 'subagent') out[d.sessionId] = t;
        out[b.id] = t;
      }
    }
    return out;
  }, [entry]);

  if (!subagents.length) {
    return <EmptyState size="sm" icon={Bot} title="No subagents" description="Agents this session delegates to (Explore, Plan, …) appear here." />;
  }
  const running = subagents.filter((s) => s.status === 'running' || s.status === 'waiting').length;
  return (
    <div className="flex flex-col p-2" data-testid="agents-panel">
      <div className="px-1.5 pb-1.5 pt-1 text-small text-ob-text-3">
        {pluralize(subagents.length, 'agent')}
        {running ? ` · ${running} running` : ''}
      </div>
      <ul className="flex flex-col gap-1">
        {[...subagents].reverse().map((s) => {
          const type = types[s.id] ?? (s.parentToolUseId ? types[s.parentToolUseId] : undefined);
          const live = s.status === 'running' || s.status === 'waiting';
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => openSession(s.id)}
                data-testid="agent-row"
                className="ob-transition group flex w-full items-start gap-2.5 rounded-[8px] px-2 py-2 text-left hover:bg-ob-hover"
              >
                <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center">
                  {live ? <Spinner size={13} className="text-ob-violet" /> : <StatusDot status={s.status === 'error' ? 'error' : 'done'} size={7} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-ui text-ob-text">{s.title}</span>
                  <span className="flex items-center gap-1.5 text-small text-ob-text-3">
                    {type ? <span className="font-mono text-[11px] text-ob-violet">{type}</span> : null}
                    {type ? <span aria-hidden>·</span> : null}
                    {live ? (
                      <Elapsed since={s.createdAt} className="font-mono text-[11px]" />
                    ) : (
                      <RelativeTime ts={s.updatedAt} className="font-mono text-[11px]" />
                    )}
                    {s.status === 'waiting' ? <span className="text-ob-warning">needs you</span> : null}
                  </span>
                </span>
                <ArrowUpRight size={14} aria-hidden className="mt-[3px] shrink-0 text-ob-text-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────────────────────── Files ─────────────────────────────

type Entry = { name: string; path: string; isDir: boolean; size?: number };

const HIDDEN = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', '.cache', '.next', '.turbo', 'dist', 'out']);

function sortEntries(list: Entry[]): Entry[] {
  return [...list].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
}

function Dir({ sessionId, cwd, dir, depth }: { sessionId: string; cwd: string; dir: string; depth: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    rpc
      .request('files.list', { cwd, dir })
      .then((r) => alive && setEntries(sortEntries(r)))
      .catch((err) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [cwd, dir]);

  if (error) return <div className="py-1 text-small text-ob-danger" style={{ paddingLeft: 12 + depth * 14 }}>{error}</div>;
  if (!entries) {
    return (
      <div className="flex items-center gap-2 py-1 text-small text-ob-text-3" style={{ paddingLeft: 12 + depth * 14 }}>
        <Spinner size={11} /> Loading…
      </div>
    );
  }
  const hidden = entries.filter((e) => e.isDir && HIDDEN.has(e.name));
  const shown = showHidden ? entries : entries.filter((e) => !(e.isDir && HIDDEN.has(e.name)));
  if (!entries.length) return <div className="py-1 text-small text-ob-text-3" style={{ paddingLeft: 12 + depth * 14 }}>Empty</div>;
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Project files' : undefined}>
      {shown.map((e) => {
        const isOpen = !!open[e.path];
        return (
          <li key={e.path} role="treeitem" aria-expanded={e.isDir ? isOpen : undefined} aria-selected={false}>
            <Tooltip content={e.isDir ? undefined : 'Insert @mention in the composer'} side="left" disabled={e.isDir}>
              <button
                type="button"
                data-testid={e.isDir ? 'file-dir' : 'file-entry'}
                onClick={() => {
                  if (e.isDir) setOpen((o) => ({ ...o, [e.path]: !isOpen }));
                  else insertIntoComposer(sessionId, mentionFor(displayPath(e.path, cwd)));
                }}
                className="ob-transition group flex h-7 w-full items-center gap-1.5 rounded-[5px] pr-2 text-left text-ui text-ob-text-2 hover:bg-ob-hover hover:text-ob-text"
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                {e.isDir ? (
                  <ChevronRight size={12} aria-hidden className={cn('shrink-0 text-ob-text-3 transition-transform duration-150', isOpen && 'rotate-90')} />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                {e.isDir ? (
                  isOpen ? (
                    <FolderOpen size={14} aria-hidden className="shrink-0 text-ob-accent" />
                  ) : (
                    <Folder size={14} aria-hidden className="shrink-0 text-ob-text-3" />
                  )
                ) : (
                  <File size={14} aria-hidden className="shrink-0 text-ob-text-3" />
                )}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {!e.isDir ? <AtSign size={12} aria-hidden className="shrink-0 text-ob-text-3 opacity-0 transition-opacity group-hover:opacity-100" /> : null}
              </button>
            </Tooltip>
            {e.isDir && isOpen ? <Dir sessionId={sessionId} cwd={cwd} dir={e.path} depth={depth + 1} /> : null}
          </li>
        );
      })}
      {hidden.length && !showHidden ? (
        <li>
          <button
            type="button"
            onClick={() => setShowHidden(true)}
            className="h-6 text-left text-meta text-ob-text-3 hover:text-ob-text-2"
            style={{ paddingLeft: 26 + depth * 14 }}
          >
            {pluralize(hidden.length, 'hidden folder')} ({hidden.map((h) => h.name).join(', ')})
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function FileSearch({ sessionId, cwd, query }: { sessionId: string; cwd: string; query: string }) {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    setFiles(null);
    const t = setTimeout(() => {
      rpc
        .request('files.search', { cwd, query, limit: 60 })
        .then((r) => alive && setFiles(r))
        .catch(() => alive && setFiles([]));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [cwd, query]);
  if (!files) return <PanelLoading />;
  if (!files.length) return <div className="px-3 py-4 text-center text-small text-ob-text-3">No files match “{query}”</div>;
  return (
    <ul className="flex flex-col p-1">
      {files.map((f) => {
        const norm = f.replace(/\\/g, '/');
        return (
          <li key={f}>
            <button
              type="button"
              data-testid="file-entry"
              onClick={() => insertIntoComposer(sessionId, mentionFor(norm))}
              className="ob-transition group flex h-8 w-full items-center gap-2 rounded-[5px] px-2 text-left hover:bg-ob-hover"
            >
              <File size={14} aria-hidden className="shrink-0 text-ob-text-3" />
              <span className="shrink-0 text-ui text-ob-text">{basename(norm)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ob-text-3">{dirname(norm) !== norm ? dirname(norm) : ''}</span>
              <AtSign size={12} aria-hidden className="shrink-0 text-ob-text-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function FilesPanel({ sessionId }: { sessionId: string }) {
  const summary = useSessionSummary(sessionId);
  const [query, setQuery] = useState('');
  if (!summary) return <PanelLoading />;
  const cwd = summary.cwd;
  return (
    <div className="flex flex-col" data-testid="files-panel">
      <div className="flex flex-col gap-2 p-2.5 pb-1.5">
        <SectionLabel
          action={
            <span className="max-w-[180px] truncate font-mono text-[10.5px] text-ob-text-3" title={cwd}>
              {basename(cwd)}
            </span>
          }
        >
          <span className="flex items-center gap-1.5">
            <FolderTree size={12} aria-hidden /> Files
          </span>
        </SectionLabel>
        <Input
          size="sm"
          icon={Search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files"
          aria-label="Search files"
          trailing={query ? <IconButton label="Clear search" icon={X} size="xs" onClick={() => setQuery('')} /> : undefined}
        />
      </div>
      <div className="px-1 pb-3">{query.trim() ? <FileSearch sessionId={sessionId} cwd={cwd} query={query.trim()} /> : <Dir sessionId={sessionId} cwd={cwd} dir={cwd} depth={0} />}</div>
      <div className="mx-2.5 mb-3 rounded-[8px] border border-dashed border-ob-border px-3 py-2 text-small text-ob-text-3">
        Click a file to mention it in your message.
      </div>
    </div>
  );
}
