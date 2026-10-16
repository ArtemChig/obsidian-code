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
import { FileActions } from './tools/FileActions';
import { FileMenu } from './tools/FileMenu';

function PanelLoading() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="ob-skeleton h-5 w-full" />
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-rule pl-2 pr-4">
        <IconButton label="Back to changed files" icon={ArrowLeft} size="sm" onClick={onBack} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] tracking-[-0.02em] text-t1" title={file.path}>
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
    <div className="flex flex-col" data-testid="changes-panel">
      <div className="flex h-9 items-center justify-between border-b border-rule px-4">
        <span className="ob-cap">
          {pluralize(files.length, 'file')} changed
        </span>
        <DiffStat additions={add} deletions={del} />
      </div>
      <ul className="flex flex-col">
        {files.map((f) => {
          const rel = displayPath(f.path, cwd);
          const dir = dirname(rel.replace(/\\/g, '/'));
          return (
            <FileMenu key={f.path} sessionId={sessionId} path={f.path} cwd={cwd}>
              <li className="ob-transition group/row flex items-center border-b border-rule2 pr-2 hover:bg-hov">
                <button
                  type="button"
                  onClick={() => setSelected(f.path)}
                  data-testid="changed-file"
                  className="group flex h-8 min-w-0 flex-1 items-center gap-2.5 pl-4 text-left"
                  title={f.path}
                >
                  {f.isNew ? <FilePlus size={13} aria-label="New file" className="shrink-0 text-ok" /> : <FileDiff size={13} aria-hidden className="shrink-0 text-t3" />}
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="shrink-0 truncate text-[12px] tracking-[-0.012em] text-t1">{basename(rel)}</span>
                    {dir && dir !== rel ? <span className="min-w-0 truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">{dir}</span> : null}
                  </span>
                  <DiffStat additions={f.additions} deletions={f.deletions} className="shrink-0" />
                  <ChevronRight size={12} aria-hidden className="shrink-0 text-t3 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
                <FileActions path={f.path} cwd={cwd} className="pl-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100" />
              </li>
            </FileMenu>
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
    <div className="flex flex-col" data-testid="todos-panel">
      <div className="flex flex-col gap-2.5 border-b border-rule px-4 pb-3.5 pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="ob-cap">{current ? 'In progress' : done === todos.length ? 'All done' : 'Up next'}</span>
          <span className="ob-tabular font-mono text-[10.5px] tracking-[-0.02em] text-t1">
            {done}
            <span className="text-t3"> / {todos.length}</span>
          </span>
        </div>
        {current ? <span className="text-[12.5px] font-medium tracking-[-0.012em] text-t1">{current.activeForm ?? current.content}</span> : null}
        <ProgressBar
          variant="segments"
          segments={Math.min(24, Math.max(todos.length, 1))}
          value={todos.length ? done / todos.length : 0}
          tone={done === todos.length ? 'success' : 'neutral'}
          label="Todo progress"
        />
      </div>
      <TodoChecklist todos={todos} className="px-4" />
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
    <div className="flex flex-col" data-testid="agents-panel">
      <div className="flex h-9 items-center justify-between border-b border-rule px-4">
        <span className="ob-cap">{pluralize(subagents.length, 'agent')}</span>
        {running ? <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-live">{running} running</span> : null}
      </div>
      <ul className="flex flex-col">
        {[...subagents].reverse().map((s) => {
          const type = types[s.id] ?? (s.parentToolUseId ? types[s.parentToolUseId] : undefined);
          const live = s.status === 'running' || s.status === 'waiting';
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => openSession(s.id)}
                data-testid="agent-row"
                className="ob-transition group flex w-full items-start gap-3 border-b border-rule2 px-4 py-2.5 text-left hover:bg-hov"
              >
                <span className="flex h-[18px] shrink-0 items-center">
                  <StatusDot
                    tone={s.status === 'waiting' ? 'warning' : live ? 'violet' : s.status === 'error' ? 'danger' : 'success'}
                    pulse={live}
                    size={6}
                    label={s.status === 'waiting' ? 'Needs you' : live ? 'Running' : s.status === 'error' ? 'Failed' : 'Done'}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-[12.5px] tracking-[-0.012em] text-t1">{s.title}</span>
                  <span className="flex items-center gap-2 font-mono text-[9.5px] tracking-[0.01em] text-t3">
                    {type ? <span className="uppercase tracking-[0.14em] text-t2">{type}</span> : null}
                    {type ? <span aria-hidden>·</span> : null}
                    {live ? <Elapsed since={s.createdAt} className="text-live" /> : <RelativeTime ts={s.updatedAt} />}
                    {s.status === 'waiting' ? <span className="uppercase tracking-[0.14em] text-warn">needs you</span> : null}
                  </span>
                </span>
                <ArrowUpRight size={13} aria-hidden className="mt-[2px] shrink-0 text-t3 opacity-0 transition-opacity group-hover:opacity-100" />
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

  if (error) return <div className="py-1 text-[11.5px] text-err" style={{ paddingLeft: 16 + depth * 14 }}>{error}</div>;
  if (!entries) {
    return (
      <div className="flex h-7 items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em] text-t3" style={{ paddingLeft: 16 + depth * 14 }}>
        <Spinner size={11} /> Loading…
      </div>
    );
  }
  const hidden = entries.filter((e) => e.isDir && HIDDEN.has(e.name));
  const shown = showHidden ? entries : entries.filter((e) => !(e.isDir && HIDDEN.has(e.name)));
  if (!entries.length) return <div className="flex h-7 items-center font-mono text-[9px] uppercase tracking-[0.14em] text-t3" style={{ paddingLeft: 30 + depth * 14 }}>Empty</div>;
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'Project files' : undefined}>
      {shown.map((e) => {
        const isOpen = !!open[e.path];
        return (
          <li key={e.path} role="treeitem" aria-expanded={e.isDir ? isOpen : undefined} aria-selected={false}>
            <FileMenu sessionId={sessionId} path={e.path} cwd={cwd} isDir={e.isDir} tooltip={{ content: e.isDir ? undefined : 'Insert @mention in the composer', side: 'left', disabled: e.isDir }}>
              <button
                type="button"
                data-testid={e.isDir ? 'file-dir' : 'file-entry'}
                onClick={() => {
                  if (e.isDir) setOpen((o) => ({ ...o, [e.path]: !isOpen }));
                  else insertIntoComposer(sessionId, mentionFor(displayPath(e.path, cwd)));
                }}
                className="ob-transition group flex h-7 w-full items-center gap-2 pr-4 text-left text-[12px] tracking-[-0.012em] text-t2 hover:bg-hov hover:text-t1"
                style={{ paddingLeft: 12 + depth * 14 }}
              >
                {e.isDir ? (
                  <ChevronRight size={11} aria-hidden className={cn('shrink-0 text-t3 transition-transform duration-150', isOpen && 'rotate-90')} />
                ) : (
                  <span className="w-[11px] shrink-0" />
                )}
                {e.isDir ? (
                  isOpen ? (
                    <FolderOpen size={13} aria-hidden className="shrink-0 text-t2" />
                  ) : (
                    <Folder size={13} aria-hidden className="shrink-0 text-t3" />
                  )
                ) : (
                  <File size={13} aria-hidden className="shrink-0 text-t3" />
                )}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {!e.isDir ? <AtSign size={11} aria-hidden className="shrink-0 text-t3 opacity-0 transition-opacity group-hover:opacity-100" /> : null}
              </button>
            </FileMenu>
            {e.isDir && isOpen ? <Dir sessionId={sessionId} cwd={cwd} dir={e.path} depth={depth + 1} /> : null}
          </li>
        );
      })}
      {hidden.length && !showHidden ? (
        <li>
          <button
            type="button"
            onClick={() => setShowHidden(true)}
            className="ob-transition h-6 text-left font-mono text-[9.5px] tracking-[0.01em] text-t3 hover:text-t1"
            style={{ paddingLeft: 31 + depth * 14 }}
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
  if (!files.length) return <div className="px-4 py-4 text-center text-[11.5px] text-t3">No files match “{query}”</div>;
  return (
    <ul className="flex flex-col">
      {files.map((f) => {
        const norm = f.replace(/\\/g, '/');
        return (
          <li key={f}>
            <FileMenu sessionId={sessionId} path={norm} cwd={cwd}>
              <button
                type="button"
                data-testid="file-entry"
                onClick={() => insertIntoComposer(sessionId, mentionFor(norm))}
                className="ob-transition group flex h-7 w-full items-center gap-2.5 border-b border-rule2 px-4 text-left hover:bg-hov"
              >
                <File size={13} aria-hidden className="shrink-0 text-t3" />
                <span className="shrink-0 text-[12px] tracking-[-0.012em] text-t1">{basename(norm)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] tracking-[0.01em] text-t3">{dirname(norm) !== norm ? dirname(norm) : ''}</span>
                <AtSign size={11} aria-hidden className="shrink-0 text-t3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </FileMenu>
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
      <div className="flex flex-col gap-2.5 border-b border-rule px-4 pb-3 pt-3">
        <SectionLabel
          action={
            <span className="max-w-[180px] truncate font-mono text-[9.5px] normal-case tracking-[0.01em] text-t2" title={cwd}>
              {basename(cwd)}
            </span>
          }
        >
          <span className="flex items-center gap-1.5">
            <FolderTree size={11} aria-hidden /> Files
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
      <div className="py-1.5">{query.trim() ? <FileSearch sessionId={sessionId} cwd={cwd} query={query.trim()} /> : <Dir sessionId={sessionId} cwd={cwd} dir={cwd} depth={0} />}</div>
      <div className="flex items-center gap-2 border-t border-rule2 px-4 py-3 font-mono text-[9.5px] tracking-[0.01em] text-t3">
        <AtSign size={11} aria-hidden className="shrink-0" />
        Click a file to mention it in your message.
      </div>
    </div>
  );
}
