// Subagent types: builtins (general-purpose, Explore, Plan) + <root>/agents/*.md (frontmatter name, description,
// tools, model; body = system prompt).

import path from 'node:path';
import type { AgentTypeInfo } from '../../shared/types';
import { firstLine, fmList, fmString, parseMarkdown } from './frontmatter';
import { configRoots } from './roots';
import { FileCache, isFile, readDirSafe, truncate } from './util';

interface AgentDef {
  info: AgentTypeInfo;
  systemPrompt: string;
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Bash'];

const GENERAL_PROMPT = `You are a subagent of Obsidian Code. A parent agent delegated a task to you; complete it fully and autonomously with the tools you have, then reply with a final report.

- Search broadly when you do not know where something lives; read a file before changing it; prefer editing existing files over creating new ones.
- Never ask the user questions. Make reasonable decisions and state them in the report.
- The parent sees ONLY your final message. Make it self-contained: what you found or changed (absolute file paths, line numbers), commands you ran and their outcome, anything unfinished or uncertain. No preamble, no filler.`;

const EXPLORE_PROMPT = `You are Explore, a fast read-only codebase search subagent of Obsidian Code. Find files, search code and read files to answer the question you are given, then report what you found.

READ-ONLY: never create, modify, move or delete files, never redirect output into files, never install or build anything. Use Bash only for read-only commands (ls, dir, cat, head, tail, wc, git status / log / diff / show / blame, find).

How to work:
- Use Glob for file names, Grep for contents, Read for specific files. Start broad, then narrow.
- Issue independent searches in parallel (several tool calls in one turn).
- Match effort to the requested thoroughness (quick / medium / very thorough). Stop as soon as you can answer.

Report: start with the direct answer, then the evidence as absolute paths with line numbers (path:line) and short snippets. Be concise; the parent sees only your final message.`;

const PLAN_PROMPT = `You are Plan, a read-only software architect subagent of Obsidian Code. Research the codebase and produce an implementation plan for the task you are given. Do NOT implement anything.

READ-ONLY: never create, modify, move or delete files. Use Bash only for read-only commands (ls, dir, cat, git log / diff / status).

Process:
1. Understand the requirement and any constraints given.
2. Explore with Glob, Grep and Read: existing patterns, conventions, related code, tests.
3. Design the approach and weigh alternatives briefly.

Final message (the parent sees only this):
- Goal and chosen approach in 2-4 sentences.
- Numbered, ordered steps, each naming the files (absolute paths) and functions to create or change.
- Risks, edge cases, and open questions.
- How to verify: tests to add or run, commands, manual checks.
- "Critical files": the 3-7 files most important to the change.`;

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    info: {
      name: 'general-purpose',
      description:
        'General-purpose agent for researching complex questions, searching code and executing multi-step tasks. Has access to all tools. Use when a task needs several rounds of searching or work.',
      source: 'builtin',
    },
    systemPrompt: GENERAL_PROMPT,
  },
  {
    info: {
      name: 'Explore',
      description:
        'Fast read-only agent for exploring a codebase: find files by pattern, search code for keywords, answer questions about how the code works. State the desired thoroughness: quick, medium or very thorough.',
      tools: READ_ONLY_TOOLS,
      source: 'builtin',
    },
    systemPrompt: EXPLORE_PROMPT,
  },
  {
    info: {
      name: 'Plan',
      description:
        'Read-only software architect agent: researches the codebase and returns a step-by-step implementation plan with critical files, risks and verification steps. Does not modify anything.',
      tools: READ_ONLY_TOOLS,
      source: 'builtin',
    },
    systemPrompt: PLAN_PROMPT,
  },
];

/** Claude model aliases only make sense for Anthropic models; on this app they would fail to resolve. */
const CLAUDE_MODEL_ALIASES = new Set(['inherit', 'sonnet', 'opus', 'haiku', 'default']);

function normalizeModel(v: unknown): string | undefined {
  const s = fmString(v);
  if (!s || CLAUDE_MODEL_ALIASES.has(s.toLowerCase())) return undefined;
  return s;
}

export interface AgentsDeps {
  home: string;
  importClaudeConfig: () => boolean;
}

export function createAgentsIndex(deps: AgentsDeps) {
  const cache = new FileCache<{ name?: string; description: string; tools?: string[]; model?: string; prompt: string }>();

  async function scan(cwd: string): Promise<AgentDef[]> {
    const byName = new Map<string, AgentDef>();
    for (const b of BUILTIN_AGENTS) byName.set(b.info.name.toLowerCase(), b);
    for (const root of configRoots(deps.home, cwd, deps.importClaudeConfig())) {
      const dir = path.join(root.dir, 'agents');
      for (const entry of await readDirSafe(dir)) {
        if (entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md') || !(await isFile(entry, dir))) continue;
        const file = path.join(dir, entry.name);
        const parsed = await cache.get(file, (raw) => {
          const { data, body } = parseMarkdown(raw);
          const description = fmString(data.description) ?? firstLine(body);
          return {
            name: fmString(data.name),
            description,
            tools: fmList(data.tools),
            model: normalizeModel(data.model),
            prompt: body.trim() || description,
          };
        });
        if (!parsed) continue;
        const name = parsed.name ?? entry.name.replace(/\.md$/i, '');
        const info: AgentTypeInfo = { name, description: truncate(parsed.description.replace(/\s+/g, ' '), 400), source: root.level };
        if (parsed.tools) info.tools = parsed.tools;
        if (parsed.model) info.model = parsed.model;
        byName.set(name.toLowerCase(), { info, systemPrompt: parsed.prompt });
      }
    }
    return [...byName.values()];
  }

  async function agentTypes(cwd: string): Promise<AgentTypeInfo[]> {
    return (await scan(cwd)).map((a) => ({ ...a.info, ...(a.info.tools ? { tools: [...a.info.tools] } : {}) }));
  }

  async function agentDefinition(cwd: string, name: string): Promise<{ name: string; systemPrompt: string; tools?: string[]; model?: string } | null> {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    const a = (await scan(cwd)).find((x) => x.info.name.toLowerCase() === want);
    if (!a) return null;
    const def: { name: string; systemPrompt: string; tools?: string[]; model?: string } = { name: a.info.name, systemPrompt: a.systemPrompt };
    if (a.info.tools) def.tools = [...a.info.tools];
    if (a.info.model) def.model = a.info.model;
    return def;
  }

  return { agentTypes, agentDefinition };
}
