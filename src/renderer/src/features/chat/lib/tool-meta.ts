// Tool card titles, summaries and defaults derived from ToolUseBlock (the core sends name/input/result only).
// Owner: ui-chat. Pure (unit-tested).
import type { ToolStatus, ToolUseBlock } from '@shared/types';
import { relativeToCwd, truncate } from '@renderer/lib/format';
import { computeDiff } from './diff';

export type ToolFamily =
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'list'
  | 'shell'
  | 'web'
  | 'search-web'
  | 'todo'
  | 'task'
  | 'question'
  | 'plan'
  | 'skill'
  | 'schedule'
  | 'notebook'
  | 'mcp'
  | 'other';

export function toolFamily(name: string): ToolFamily {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Read':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
      return 'edit';
    case 'Write':
      return 'write';
    case 'NotebookEdit':
      return 'notebook';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'LS':
      return 'list';
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput':
    case 'KillShell':
      return 'shell';
    case 'WebFetch':
      return 'web';
    case 'WebSearch':
      return 'search-web';
    case 'TodoWrite':
      return 'todo';
    case 'Task':
      return 'task';
    case 'AskUserQuestion':
      return 'question';
    case 'ExitPlanMode':
      return 'plan';
    case 'Skill':
      return 'skill';
    case 'ScheduleTask':
    case 'ListScheduledTasks':
    case 'DeleteScheduledTask':
      return 'schedule';
    default:
      return 'other';
  }
}

export interface ToolSummary {
  /** Short bold verb shown first ("Edit", "Run", "Search"). */
  verb: string;
  /** Main argument (path, command, pattern, url…). */
  target: string;
  /** Render the target in the mono font. */
  mono: boolean;
  /** Right-aligned result meta ("+4 −1", "exit 0", "12 files"). */
  meta?: string;
  metaTone?: 'neutral' | 'success' | 'danger' | 'warning';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function displayPath(path: string, cwd: string): string {
  if (!path) return '';
  const rel = relativeToCwd(path, cwd);
  return rel === path ? path.replace(/\\/g, '/') : rel;
}

/** Bash-like command one-liner: first line, collapsed whitespace. */
export function oneLine(cmd: string, max = 140): string {
  const first = cmd.split('\n')[0] ?? '';
  const more = cmd.includes('\n') ? ' …' : '';
  return truncate(first.replace(/\s+/g, ' ').trim(), max) + more;
}

export function toolSummary(tool: ToolUseBlock, cwd: string): ToolSummary {
  const i = tool.input ?? {};
  const d = tool.result?.display;
  const done = tool.status === 'done';
  switch (tool.name) {
    case 'Read': {
      const path = displayPath(str(i.file_path ?? i.path), cwd);
      let meta: string | undefined;
      if (d?.kind === 'file' && done) {
        const lines = d.content ? d.content.split('\n').length : 0;
        meta = d.totalLines > lines && lines > 0 ? `lines ${d.startLine}–${d.startLine + lines - 1} of ${d.totalLines}` : `${d.totalLines} lines`;
      }
      return { verb: 'Read', target: path, mono: true, meta };
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const path = displayPath(str(i.file_path ?? i.path), cwd);
      let meta: string | undefined;
      if (d?.kind === 'diff') {
        const m = computeDiff(d.before, d.after);
        meta = d.isNewFile ? `new · +${m.additions}` : `+${m.additions} −${m.deletions}`;
      }
      const verb = tool.name === 'Write' ? (d?.kind === 'diff' && !d.isNewFile ? 'Overwrite' : 'Write') : tool.name === 'MultiEdit' ? 'Edit' : 'Edit';
      const count = tool.name === 'MultiEdit' && Array.isArray(i.edits) ? ` (${(i.edits as unknown[]).length} edits)` : '';
      return { verb, target: path + count, mono: true, meta };
    }
    case 'NotebookEdit':
      return { verb: 'Edit notebook', target: displayPath(str(i.notebook_path ?? i.file_path), cwd), mono: true };
    case 'Grep': {
      const where = str(i.glob) || (i.path ? displayPath(str(i.path), cwd) : '') || str(i.type);
      const meta = d?.kind === 'list' && done ? countMeta(d.items.length, d.title, 'result') : undefined;
      return { verb: 'Search', target: `${str(i.pattern)}${where ? `  in ${where}` : ''}`, mono: true, meta };
    }
    case 'Glob': {
      const meta = d?.kind === 'list' && done ? countMeta(d.items.length, d.title, 'file') : undefined;
      return { verb: 'Find', target: str(i.pattern) + (i.path ? `  in ${displayPath(str(i.path), cwd)}` : ''), mono: true, meta };
    }
    case 'LS': {
      const meta = d?.kind === 'list' && done ? countMeta(d.items.length, undefined, 'entry', 'entries') : undefined;
      return { verb: 'List', target: displayPath(str(i.path), cwd) || '.', mono: true, meta };
    }
    case 'Bash':
    case 'PowerShell': {
      const command = str(i.command);
      const desc = str(i.description);
      let meta: string | undefined;
      let metaTone: ToolSummary['metaTone'];
      if (d?.kind === 'bash') {
        if (d.background || i.run_in_background) {
          meta = 'background';
        } else if (d.exitCode !== null && d.exitCode !== undefined) {
          meta = `exit ${d.exitCode}`;
          metaTone = d.exitCode === 0 ? 'success' : 'danger';
        }
      }
      return { verb: tool.name === 'PowerShell' ? 'PowerShell' : 'Run', target: desc || oneLine(command), mono: !desc, meta, metaTone };
    }
    case 'BashOutput':
      return { verb: 'Shell output', target: str(i.bash_id ?? i.shell_id ?? i.id), mono: true };
    case 'KillShell':
      return { verb: 'Kill shell', target: str(i.shell_id ?? i.bash_id ?? i.id), mono: true };
    case 'WebFetch': {
      const url = str(i.url);
      return { verb: 'Fetch', target: hostOf(url) + safePath(url), mono: true, meta: d?.kind === 'web' && done ? formatKb(d.bytes) : undefined };
    }
    case 'WebSearch': {
      const n = d?.kind === 'search' && done ? d.results.length : undefined;
      return { verb: 'Web search', target: str(i.query), mono: false, meta: n !== undefined ? `${n} result${n === 1 ? '' : 's'}` : undefined };
    }
    case 'TodoWrite': {
      const todos = d?.kind === 'todos' ? d.todos : Array.isArray(i.todos) ? (i.todos as { status?: string }[]) : [];
      const doneCount = todos.filter((t) => t.status === 'completed').length;
      return { verb: 'Update todos', target: '', mono: false, meta: todos.length ? `${doneCount}/${todos.length} done` : undefined };
    }
    case 'Task':
      return { verb: 'Agent', target: str(i.description) || str(i.subagent_type), mono: false };
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? (i.questions as { question?: string }[]) : [];
      return { verb: 'Ask', target: str(qs[0]?.question), mono: false, meta: qs.length > 1 ? `${qs.length} questions` : undefined };
    }
    case 'ExitPlanMode': {
      const outcome = planOutcome(tool.result?.content);
      return {
        verb: 'Plan',
        target: 'Implementation plan',
        mono: false,
        meta: outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'changes requested' : undefined,
        metaTone: outcome === 'approved' ? 'success' : outcome === 'rejected' ? 'warning' : undefined,
      };
    }
    case 'Skill':
      return { verb: 'Skill', target: str(i.skill ?? i.name ?? i.command), mono: true };
    case 'ScheduleTask':
      return { verb: 'Schedule', target: str(i.name) || oneLine(str(i.prompt), 80), mono: false };
    case 'ListScheduledTasks':
      return { verb: 'List schedules', target: '', mono: false };
    case 'DeleteScheduledTask':
      return { verb: 'Delete schedule', target: str(i.id ?? i.name), mono: true };
    default: {
      if (tool.name.startsWith('mcp__')) {
        const [, server, ...rest] = tool.name.split('__');
        return { verb: rest.join('__') || tool.name, target: server ? `${server} · MCP` : 'MCP', mono: true };
      }
      const firstStr = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
      return { verb: tool.name, target: firstStr ? oneLine(firstStr, 100) : '', mono: true };
    }
  }
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname;
    return truncate(p, 60);
  } catch {
    return '';
  }
}

function formatKb(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function countMeta(n: number, title: string | undefined, one: string, many = `${one}s`): string {
  const plus = title && /\(\d+\+\)/.test(title) ? '+' : '';
  return `${n}${plus} ${n === 1 ? one : many}`;
}

/** Plan approval outcome from the ExitPlanMode tool result text. */
export function planOutcome(content: string | undefined): 'approved' | 'rejected' | null {
  if (!content) return null;
  if (/did not approve|keep planning|keep refining/i.test(content)) return 'rejected';
  if (/approved/i.test(content)) return 'approved';
  return null;
}

/** Present-tense activity line for the running-status row ("Editing src/a.ts", "Agent working: …"). */
export function activityLabel(tool: ToolUseBlock, cwd: string): string {
  const s = toolSummary(tool, cwd);
  const t = s.target;
  switch (toolFamily(tool.name)) {
    case 'read':
      return `Reading ${t}`;
    case 'edit':
    case 'notebook':
      return `Editing ${t}`;
    case 'write':
      return `Writing ${t}`;
    case 'search':
      return `Searching ${str(tool.input.pattern) || t}`;
    case 'list':
      return `Listing ${t}`;
    case 'shell':
      return tool.name === 'Bash' || tool.name === 'PowerShell' ? (str(tool.input.description) || `Running ${oneLine(str(tool.input.command), 70)}`) : `${s.verb} ${t}`.trim();
    case 'web':
      return `Fetching ${t}`;
    case 'search-web':
      return `Searching the web for “${truncate(t, 60)}”`;
    case 'todo':
      return 'Updating the todo list';
    case 'task':
      return `Agent working: ${t}`;
    case 'question':
      return 'Asking you a question';
    case 'plan':
      return 'Presenting the plan';
    case 'skill':
      return `Loading skill ${t}`;
    case 'schedule':
      return `${s.verb} ${t}`.trim();
    default:
      return `${s.verb}${t ? ` · ${t}` : ''}`;
  }
}

export const STATUS_LABEL: Record<ToolStatus, string> = {
  pending: 'Queued',
  awaiting_permission: 'Needs permission',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  denied: 'Denied',
  interrupted: 'Interrupted',
};

/** Whether a finished tool card starts expanded. */
export function defaultExpanded(tool: ToolUseBlock): boolean {
  if (tool.status === 'error' && tool.name !== 'Read') return true;
  if (tool.status === 'awaiting_permission' || tool.status === 'pending') return false;
  if (tool.status === 'running') return toolFamily(tool.name) === 'shell';
  switch (toolFamily(tool.name)) {
    case 'edit':
    case 'write':
    case 'notebook':
    case 'todo':
    case 'question':
    case 'plan':
    case 'task':
      return true;
    case 'shell': {
      const d = tool.result?.display;
      if (d?.kind === 'bash') return d.output.trim().length > 0 && (d.exitCode !== 0 || d.output.split('\n').length <= 14);
      return false;
    }
    case 'search-web':
    case 'web':
      return true;
    default:
      return false;
  }
}

/** Number of lines in a string (for "Show more" thresholds). */
export function lineCount(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}
