// Claude Code tool names / results → the app's ToolUseBlock names and rich ToolDisplay (so the existing tool cards
// render Claude Code's tools unchanged). Shapes: docs/research/claude-agent-sdk.md §"Tool results".

import type { Question, Todo, ToolDisplay } from '../../../shared/types';

/** Claude Code tool name → the name the UI (and the app's permission engine) knows. */
const UI_NAMES: Record<string, string> = {
  Agent: 'Task',
  mcp__obsidian__web_search: 'WebSearch',
  mcp__obsidian__schedule_task: 'ScheduleTask',
  mcp__obsidian__list_scheduled_tasks: 'ListScheduledTasks',
  mcp__obsidian__delete_scheduled_task: 'DeleteScheduledTask',
};

export function uiToolName(name: string): string {
  return UI_NAMES[name] ?? name;
}

export const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  if (typeof v === 'string' && v.startsWith('{')) {
    try { const p = JSON.parse(v) as unknown; return p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : null; } catch { return null; }
  }
  return null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function inputFilePath(input: Obj): string {
  return str(input.file_path) || str(input.notebook_path) || str(input.path);
}

/** Claude Code TodoWrite items → app todos. */
export function toTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t, i): Todo[] => {
    const o = obj(t);
    if (!o) return [];
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    const todo: Todo = { id: str(o.id) || String(i + 1), content: str(o.content), status };
    if (str(o.activeForm)) todo.activeForm = str(o.activeForm);
    return [todo];
  });
}

export function toQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q): Question[] => {
    const o = obj(q);
    if (!o || !str(o.question)) return [];
    const options = Array.isArray(o.options)
      ? o.options.flatMap((x) => { const y = obj(x); return y && str(y.label) ? [{ label: str(y.label), description: str(y.description) }] : []; })
      : [];
    return [{ question: str(o.question), header: str(o.header) || 'Question', multiSelect: o.multiSelect === true, options }];
  });
}

export interface DisplayInput {
  /** Claude Code's tool name (not the UI name). */
  name: string;
  input: Obj;
  /** SDKUserMessage.tool_use_result (structured result; sometimes JSON text). */
  toolUseResult: unknown;
  /** Text content the model saw. */
  content: string;
  isError: boolean;
  /** File content before an edit (PreToolUse snapshot), when captured. */
  before?: { existed: boolean; content: string };
  /** Current file content after an edit, when readable. */
  after?: string | null;
  /** Child session of a Task/Agent call. */
  subagentSessionId?: string;
  /** Display produced by an in-process (obsidian MCP) tool. */
  mcpDisplay?: ToolDisplay;
}

function bashExitCode(content: string, r: Obj | null, isError: boolean): number | null {
  const m = /(?:exit code|exited with code)[:\s]+(-?\d+)/i.exec(content);
  if (m) return Number(m[1]);
  if (r && typeof r.exitCode === 'number') return r.exitCode;
  if (r?.interrupted === true) return null;
  return isError ? 1 : 0;
}

export function toolDisplay(d: DisplayInput): ToolDisplay | undefined {
  const r = obj(d.toolUseResult);
  const input = d.input;
  if (d.mcpDisplay) return d.mcpDisplay;
  switch (d.name) {
    case 'Read': {
      const f = obj(r?.file);
      if (!f || d.isError) return undefined;
      if (typeof f.content !== 'string') return undefined; // images / pdf pages
      return { kind: 'file', path: str(f.filePath) || inputFilePath(input), content: f.content, startLine: num(f.startLine, 1), totalLines: num(f.totalLines, num(f.numLines)) };
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (d.isError) return undefined;
      const path = str(r?.filePath) || inputFilePath(input);
      const original = r && 'originalFile' in r ? (typeof r.originalFile === 'string' ? r.originalFile : null) : undefined;
      const before = d.before ? (d.before.existed ? d.before.content : '') : original ?? '';
      const isNewFile = d.before ? !d.before.existed : r?.type === 'create' || original === null;
      let after = d.after;
      if (after == null) {
        if (d.name === 'Write') after = str(r?.content) || str(input.content);
        else if (d.name === 'Edit' && typeof original === 'string') {
          const oldS = str(input.old_string);
          const newS = str(input.new_string);
          after = input.replace_all === true ? original.split(oldS).join(newS) : original.replace(oldS, () => newS);
        }
      }
      if (after == null) return undefined;
      return { kind: 'diff', path, before, after, isNewFile };
    }
    case 'Bash':
    case 'PowerShell': {
      const out = r ? [str(r.stdout), str(r.stderr)].filter(Boolean).join('\n') : d.content;
      const bg = input.run_in_background === true || !!str(r?.backgroundTaskId);
      return { kind: 'bash', command: str(input.command), output: out || d.content, exitCode: bg ? null : bashExitCode(d.content, r, d.isError), shellId: str(r?.backgroundTaskId) || undefined, background: bg || undefined };
    }
    case 'Grep':
    case 'Glob': {
      if (d.isError) return undefined;
      const files = Array.isArray(r?.filenames) ? (r.filenames as unknown[]).map(str).filter(Boolean) : [];
      const lines = files.length ? files : str(r?.content || d.content).split(/\r?\n/).filter(Boolean);
      const n = num(r?.numFiles, files.length);
      const title = d.name === 'Glob' ? `${n} file${n === 1 ? '' : 's'}` : files.length ? `${n} file${n === 1 ? '' : 's'}` : `${lines.length} line${lines.length === 1 ? '' : 's'}`;
      return { kind: 'list', title, items: lines.slice(0, 500) };
    }
    case 'LS':
      return d.isError ? undefined : { kind: 'list', title: inputFilePath(input) || 'Directory', items: d.content.split(/\r?\n/).filter(Boolean).slice(0, 500) };
    case 'WebFetch':
      if (d.isError) return undefined;
      return { kind: 'web', url: str(r?.url) || str(input.url), bytes: num(r?.bytes, d.content.length) };
    case 'TodoWrite': {
      const todos = toTodos(r?.newTodos ?? input.todos);
      return { kind: 'todos', todos };
    }
    case 'Agent':
    case 'Task':
      if (!d.subagentSessionId) return undefined;
      return { kind: 'subagent', sessionId: d.subagentSessionId, agentType: str(input.subagent_type) || 'general-purpose', description: str(input.description) };
    case 'ExitPlanMode': {
      const plan = str(input.plan) || str(r?.plan);
      return plan ? { kind: 'plan', plan } : undefined;
    }
    case 'AskUserQuestion': {
      const questions = toQuestions(input.questions ?? r?.questions);
      const answersRaw = obj(input.answers) ?? obj(r?.answers);
      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(answersRaw ?? {})) answers[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
      return questions.length ? { kind: 'questions', questions, answers: Object.keys(answers).length ? answers : undefined } : undefined;
    }
    default:
      return undefined;
  }
}
