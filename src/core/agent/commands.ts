// Built-in slash commands handled by the agent (SPEC §4.1). The handlers live in manager.ts.

import type { SlashCommandInfo } from '../../shared/types';

export const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: 'clear', description: 'Start a new conversation in this session (old messages are archived)', source: 'builtin' },
  { name: 'compact', description: 'Summarise the conversation to free context', source: 'builtin', argumentHint: '[instructions]' },
  { name: 'model', description: 'Show or switch the model', source: 'builtin', argumentHint: '[model id]' },
  { name: 'plan', description: 'Toggle plan mode (optionally start planning a task)', source: 'builtin', argumentHint: '[task]' },
  { name: 'init', description: 'Analyse the project and write OBSIDIAN.md', source: 'builtin' },
  { name: 'help', description: 'List commands', source: 'builtin' },
  { name: 'cost', description: 'Token usage of this session', source: 'builtin' },
  { name: 'todos', description: 'Show the todo list', source: 'builtin' },
  { name: 'agents', description: 'List subagent types', source: 'builtin' },
  { name: 'skills', description: 'List available skills', source: 'builtin' },
  { name: 'memory', description: 'Show memory files (add notes with # at the start of a message)', source: 'builtin' },
  { name: 'thinking', description: 'Turn thinking on or off', source: 'builtin', argumentHint: 'on|off' },
  { name: 'rewind', description: 'Rewind the last N turns (add "files" to also restore files)', source: 'builtin', argumentHint: '[n] [files]' },
];

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** "/name args" → { name, args }. Paths like "/usr/bin/x" or "/ text" are not commands. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const t = text.trim();
  const m = /^\/([A-Za-z0-9_:.-]+)(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? '').trim() };
}

export const INIT_PROMPT = [
  'Please analyse this codebase and create an OBSIDIAN.md file in the project root. It is loaded into the system prompt of future sessions, so keep it concise (at most ~60 lines). Include:',
  '1. Commands to build, lint, test and run the project — including how to run a single test.',
  '2. A high-level architecture overview: the parts that require reading several files to understand.',
  '3. Important conventions or gotchas.',
  'If OBSIDIAN.md, CLAUDE.md, AGENTS.md, README.md, .cursorrules or .github/copilot-instructions.md exist, incorporate their important parts. If OBSIDIAN.md already exists, improve it instead of starting over. Do not list every file or add generic advice.',
].join('\n');
