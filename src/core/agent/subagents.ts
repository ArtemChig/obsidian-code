// Built-in subagent types and tool restriction rules (SPEC §4.1 "Subagents").

import type { AgentTypeInfo } from '../../shared/types';

export interface AgentDefinition { name: string; systemPrompt: string; tools?: string[]; model?: string }

export const MAX_SUBAGENT_DEPTH = 2;
export const MAX_CONCURRENT_SUBAGENTS = 3;

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Bash', 'PowerShell', 'BashOutput', 'WebFetch', 'WebSearch', 'Skill', 'TodoWrite'];

export const BUILTIN_AGENTS: (AgentTypeInfo & { systemPrompt: string })[] = [
  {
    name: 'general-purpose',
    description: 'General agent for multi-step tasks: researching, searching code, and making changes. Use when a task needs several steps or a broad search.',
    source: 'builtin',
    systemPrompt: 'Complete the task fully using your tools. When done, report what you found or changed (files, key facts) concisely.',
  },
  {
    name: 'Explore',
    description: 'Fast read-only agent for exploring a codebase: find files, search code, answer questions about how things work. Say how thorough to be.',
    tools: READ_ONLY_TOOLS,
    source: 'builtin',
    systemPrompt: 'You are read-only: never create, edit or delete files, and only run commands that do not change anything. Search efficiently (Glob/Grep in parallel), read the relevant parts, and answer with precise findings including file paths and line numbers.',
  },
  {
    name: 'Plan',
    description: 'Read-only software architect: researches the code and returns a step-by-step implementation plan (files to change, approach, risks).',
    tools: READ_ONLY_TOOLS,
    source: 'builtin',
    systemPrompt: 'You are read-only: never modify files. Research the relevant code, then return a concrete implementation plan: the files to change and how, the order of steps, and risks or open questions.',
  },
];

export function builtinDefinition(name: string): AgentDefinition | null {
  const b = BUILTIN_AGENTS.find((a) => a.name.toLowerCase() === name.toLowerCase());
  return b ? { name: b.name, systemPrompt: b.systemPrompt, tools: b.tools } : null;
}

/** Tools never given to subagents (they need the human or would recurse). */
const NEVER_FOR_SUBAGENTS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Filter tool names for a subagent at `depth` (1 = direct child of a chat session). */
export function subagentToolNames(all: string[], def: AgentDefinition, depth: number): string[] {
  const allowed = def.tools?.length ? new Set(def.tools.flatMap((t) => (t === '*' ? all : [t]))) : null;
  return all.filter((n) => {
    if (NEVER_FOR_SUBAGENTS.has(n)) return false;
    if (n === 'Task' && depth >= MAX_SUBAGENT_DEPTH) return false;
    if (!allowed) return true;
    if (allowed.has(n)) return true;
    // "mcp__server" in a tools list allows every tool of that server
    return [...allowed].some((a) => a.startsWith('mcp__') && n.startsWith(`${a}__`));
  });
}
