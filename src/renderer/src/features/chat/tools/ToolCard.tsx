// Tool call card: one-line header (icon · verb · target · meta · status) + rich, collapsible body. Owner: ui-chat.
import {
  Bot,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  MessageCircleQuestionMark,
  NotebookPen,
  Plug,
  Search,
  SquareTerminal,
  TextSearch,
  WandSparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { memo, useContext, useState, type ReactNode } from 'react';
import type { ToolUseBlock } from '@shared/types';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { formatDuration } from '@renderer/lib/format';
import { AwaitingToolsContext } from '../context';
import { previewFromInput } from '../lib/diff';
import { defaultExpanded, STATUS_LABEL, toolFamily, toolSummary } from '../lib/tool-meta';
import { Clamp, Elapsed, ToolStatusIcon } from '../ui';
import {
  FileBody,
  InputJson,
  ListBody,
  MarkdownBody,
  PlanBody,
  QuestionsBody,
  RawBody,
  SearchBody,
  TerminalBody,
  TodoChecklist,
  WebBody,
} from './bodies';
import { DiffView } from './DiffView';
import { SubagentCard } from './SubagentCard';
import { FileActions } from './FileActions';

export function toolIcon(name: string): LucideIcon {
  if (name === 'Grep') return TextSearch;
  if (name === 'Glob') return FileSearch;
  switch (toolFamily(name)) {
    case 'read':
      return FileText;
    case 'edit':
      return FilePen;
    case 'write':
      return FilePlus;
    case 'notebook':
      return NotebookPen;
    case 'list':
      return FolderTree;
    case 'shell':
      return SquareTerminal;
    case 'web':
      return Globe;
    case 'search-web':
      return Search;
    case 'search':
      return TextSearch;
    case 'todo':
      return ListTodo;
    case 'task':
      return Bot;
    case 'question':
      return MessageCircleQuestionMark;
    case 'plan':
      return ClipboardList;
    case 'skill':
      return WandSparkles;
    case 'schedule':
      return CalendarClock;
    case 'mcp':
      return Plug;
    default:
      return Wrench;
  }
}

/** Body for a tool, or null when there is nothing worth showing. */
function toolBody(tool: ToolUseBlock, cwd: string): ReactNode {
  const d = tool.result?.display;
  const family = toolFamily(tool.name);
  const input = tool.input ?? {};
  const live = tool.status === 'running' || tool.status === 'pending' || tool.status === 'awaiting_permission';

  if (live || !tool.result) {
    if (family === 'shell' && (tool.name === 'Bash' || tool.name === 'PowerShell')) {
      return (
        <TerminalBody
          command={String(input.command ?? '')}
          output={tool.progress ?? ''}
          running={tool.status === 'running'}
          preview={tool.status !== 'running'}
          shell={tool.name === 'PowerShell' ? 'powershell' : 'bash'}
        />
      );
    }
    const preview = previewFromInput(tool.name, input);
    if (preview) return <DiffView before={preview.before} after={preview.after} path={preview.path} isNewFile={preview.isNew} maxHeight={360} />;
    if (tool.progress) return <RawBody text={tool.progress} />;
    if (family === 'mcp' || family === 'other') return <InputJson input={input} />;
    return null;
  }

  const content = tool.result.content ?? '';
  const isError = !!tool.result.isError || tool.status === 'error';
  if (tool.status === 'denied' || tool.status === 'interrupted') {
    return content ? <div className="px-3.5 py-2.5 text-small text-ob-text-3">{content}</div> : null;
  }
  if (isError && (!d || d.kind === 'list' || d.kind === 'file')) return <RawBody text={content} error />;

  switch (d?.kind) {
    case 'diff':
      return (
        <Clamp maxHeight={380}>
          <DiffView before={d.before} after={d.after} path={d.path} isNewFile={d.isNewFile} />
        </Clamp>
      );
    case 'file':
      return <FileBody display={d} cwd={cwd} />;
    case 'bash':
      return (
        <TerminalBody
          command={d.command}
          output={d.output}
          exitCode={d.exitCode}
          background={d.background}
          shellId={d.shellId}
          shell={tool.name === 'PowerShell' ? 'powershell' : 'bash'}
        />
      );
    case 'list':
      return <ListBody display={d} cwd={cwd} />;
    case 'search':
      return <SearchBody display={d} />;
    case 'web':
      return <WebBody display={d} />;
    case 'todos':
      return <TodoChecklist todos={d.todos} className="px-3.5 py-3" />;
    case 'questions':
      return <QuestionsBody questions={d.questions} answers={d.answers} />;
    case 'plan':
      return <PlanBody plan={d.plan} />;
    case 'markdown':
      return <MarkdownBody markdown={d.markdown} />;
    default:
      break;
  }
  if (family === 'mcp' || family === 'other') {
    return (
      <>
        <InputJson input={input} />
        <div className="border-t border-ob-border">
          <RawBody text={content} error={isError} />
        </div>
      </>
    );
  }
  return content ? <RawBody text={content} error={isError} /> : null;
}

export interface ToolCardProps {
  tool: ToolUseBlock;
  cwd: string;
  /** Child session id when this is a Task (subagent) call. */
  className?: string;
}

/** Tools whose target is one file (Open / Reveal on the card). */
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export const ToolCard = memo(function ToolCard({ tool, cwd, className }: ToolCardProps) {
  if (tool.name === 'Task') return <SubagentCard tool={tool} className={className} />;
  return <GenericToolCard tool={tool} cwd={cwd} className={className} />;
});

function GenericToolCard({ tool, cwd, className }: ToolCardProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultExpanded(tool);
  const s = toolSummary(tool, cwd);
  const Icon = toolIcon(tool.name);
  // Creating the body elements is cheap (nothing renders until it is mounted) and tells us if there is anything to expand.
  const body = toolBody(tool, cwd);
  const expandable = body !== null;
  const ms = tool.startedAt && tool.endedAt ? tool.endedAt - tool.startedAt : null;
  const awaiting = useContext(AwaitingToolsContext).has(tool.id);
  const live = tool.status === 'running' && !awaiting;
  const flagged = (tool.status !== 'done' && tool.status !== 'running') || awaiting;
  const d = tool.result?.display;
  const filePath = FILE_TOOLS.has(tool.name) ? String(tool.input.file_path ?? tool.input.notebook_path ?? '') : '';
  // A command that ran but exited non-zero is shown as failed (the tool itself "succeeded").
  const iconStatus =
    awaiting && tool.status === 'running'
      ? 'awaiting_permission'
      : tool.status === 'done' && d?.kind === 'bash' && d.exitCode !== null && d.exitCode !== 0
        ? 'error'
        : tool.status;

  return (
    <div
      data-testid="tool-card"
      data-tool={tool.name}
      data-status={tool.status}
      className={cn(
        'overflow-hidden rounded-[9px] border bg-ob-surface-1',
        tool.status === 'awaiting_permission' || awaiting ? 'border-[rgba(232,184,92,0.38)]' : tool.status === 'error' ? 'border-[rgba(240,113,120,0.3)]' : 'border-ob-border',
        className,
      )}
    >
      <div className="group/header flex items-center">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        disabled={!expandable}
        className="ob-transition group flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-3 pr-2.5 text-left hover:bg-ob-hover disabled:hover:bg-transparent"
      >
        <Icon size={15} aria-hidden className={cn('shrink-0', live ? 'text-ob-accent' : 'text-ob-text-3')} />
        <span className="shrink-0 text-ui font-medium text-ob-text">{s.verb}</span>
        {s.target ? (
          <span className={cn('min-w-0 flex-1 truncate', s.mono ? 'font-mono text-[12px] text-ob-text-2' : 'text-ui text-ob-text-2')} title={s.target}>
            {s.target}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {s.meta ? (
          <span
            className={cn(
              'ob-tabular shrink-0 font-mono text-[11px]',
              s.metaTone === 'success' && 'text-ob-success',
              s.metaTone === 'danger' && 'text-ob-danger',
              s.metaTone === 'warning' && 'text-ob-warning',
              (!s.metaTone || s.metaTone === 'neutral') && 'text-ob-text-3',
              /^\+\d+ −\d+$/.test(s.meta) && 'text-ob-text-3',
            )}
          >
            {/^\+\d+ −\d+$/.test(s.meta) ? (
              <>
                <span className="text-ob-success">{s.meta.split(' ')[0]}</span> <span className="text-ob-danger">{s.meta.split(' ')[1]}</span>
              </>
            ) : (
              s.meta
            )}
          </span>
        ) : null}
        {live && tool.startedAt ? <Elapsed since={tool.startedAt} className="shrink-0 font-mono text-[11px] text-ob-text-3" /> : null}
        {!live && ms !== null && ms >= 1000 && !flagged ? <span className="shrink-0 font-mono text-[11px] text-ob-text-3">{formatDuration(ms)}</span> : null}
        {flagged ? (
          <span
            className={cn(
              'shrink-0 text-small',
              awaiting || tool.status === 'awaiting_permission' || tool.status === 'interrupted'
                ? 'text-ob-warning'
                : tool.status === 'pending'
                  ? 'text-ob-text-3'
                  : 'text-ob-danger',
            )}
          >
            {awaiting && tool.status === 'running' ? 'Waiting for you' : STATUS_LABEL[tool.status]}
          </span>
        ) : null}
        <Tooltip content={iconStatus === 'error' && tool.status === 'done' ? 'Exited with an error' : STATUS_LABEL[iconStatus]}>
          <span className="flex shrink-0 items-center">
            <ToolStatusIcon status={iconStatus} size={13} />
          </span>
        </Tooltip>
        <ChevronRight
          size={14}
          aria-hidden
          className={cn('-mr-0.5 shrink-0 text-ob-text-3 transition-transform duration-150', open && 'rotate-90', !expandable && 'opacity-0')}
        />
      </button>
      {filePath && tool.status === 'done' ? (
        <FileActions path={filePath} cwd={cwd} className="pr-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/header:opacity-100" />
      ) : null}
      </div>
      {open && body ? <div className="border-t border-ob-border animate-ob-fade-in">{body}</div> : null}
    </div>
  );
}
