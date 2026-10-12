// Slash commands: builtin list (handled by the agent) + custom <root>/commands/**/*.md (subdirectories → "dir:name").

import path from 'node:path';
import type { SlashCommandInfo } from '../../shared/types';
import { firstLine, fmString, parseMarkdown } from './frontmatter';
import { configRoots } from './roots';
import { FileCache, isDirectory, isFile, readDirSafe, splitArgs, truncate } from './util';

export const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: 'clear', description: 'Start a fresh conversation in this session (the old messages are archived)', source: 'builtin' },
  { name: 'compact', description: 'Summarise older history to free up context', source: 'builtin', argumentHint: '[what to keep]' },
  { name: 'model', description: 'Switch the model for this session', source: 'builtin', argumentHint: '<model id>' },
  { name: 'plan', description: 'Toggle plan mode (read-only research, then approve a plan)', source: 'builtin' },
  { name: 'init', description: 'Generate an OBSIDIAN.md for this project', source: 'builtin' },
  { name: 'help', description: 'Show available commands and shortcuts', source: 'builtin' },
  { name: 'cost', description: 'Show token usage for this session', source: 'builtin' },
  { name: 'todos', description: 'Show the current todo list', source: 'builtin' },
  { name: 'agents', description: 'List available subagent types', source: 'builtin' },
  { name: 'skills', description: 'List available skills', source: 'builtin' },
  { name: 'memory', description: 'Show the loaded memory files (OBSIDIAN.md / CLAUDE.md)', source: 'builtin' },
  { name: 'thinking', description: 'Turn model thinking on or off', source: 'builtin', argumentHint: 'on|off' },
  { name: 'rewind', description: 'Rewind the conversation (and optionally files) to an earlier message', source: 'builtin' },
];

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

interface CommandRecord {
  info: SlashCommandInfo;
  body: string;
}

export interface CommandsDeps {
  home: string;
  importClaudeConfig: () => boolean;
}

/** Replace $ARGUMENTS and $1..$9 in a command body. If the body references no argument, args are appended. */
export function substituteArguments(body: string, args: string): string {
  const trimmed = args.trim();
  const words = splitArgs(trimmed);
  let used = false;
  const out = body.replace(/\$ARGUMENTS|\$([1-9])(?![0-9])/g, (_m, d: string | undefined) => {
    used = true;
    if (d === undefined) return trimmed;
    return words[Number(d) - 1] ?? '';
  });
  if (!used && trimmed) return `${out.trimEnd()}\n\nARGUMENTS: ${trimmed}`;
  return out;
}

export function createCommandsIndex(deps: CommandsDeps) {
  const cache = new FileCache<{ description: string; argumentHint?: string; body: string }>();

  async function walk(dir: string, prefix: string, depth: number, out: { name: string; file: string }[]): Promise<void> {
    for (const entry of await readDirSafe(dir)) {
      if (entry.name.startsWith('.')) continue;
      if (await isDirectory(entry, dir)) {
        if (depth < 5) await walk(path.join(dir, entry.name), `${prefix}${entry.name}:`, depth + 1, out);
      } else if (entry.name.toLowerCase().endsWith('.md') && (await isFile(entry, dir))) {
        out.push({ name: prefix + entry.name.slice(0, -3), file: path.join(dir, entry.name) });
      }
    }
  }

  async function scan(cwd: string): Promise<CommandRecord[]> {
    const byName = new Map<string, CommandRecord>();
    for (const root of configRoots(deps.home, cwd, deps.importClaudeConfig())) {
      const found: { name: string; file: string }[] = [];
      await walk(path.join(root.dir, 'commands'), '', 0, found);
      for (const { name, file } of found) {
        if (BUILTIN_NAMES.has(name)) continue; // builtins always win
        const parsed = await cache.get(file, (raw) => {
          const { data, body } = parseMarkdown(raw);
          const hint = fmString(data['argument-hint'] ?? data.argumentHint ?? data.argument_hint);
          return { description: fmString(data.description) ?? firstLine(body, 120), argumentHint: hint, body: body.trim() };
        });
        if (!parsed) continue;
        const info: SlashCommandInfo = { name, description: truncate(parsed.description.replace(/\s+/g, ' '), 200), source: root.level };
        if (parsed.argumentHint) info.argumentHint = parsed.argumentHint;
        byName.set(name, { info, body: parsed.body });
      }
    }
    return [...byName.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }

  async function slashCommands(cwd: string): Promise<SlashCommandInfo[]> {
    const custom = (await scan(cwd)).map((r) => r.info);
    return [...BUILTIN_COMMANDS.map((c) => ({ ...c })), ...custom];
  }

  async function expandCommand(cwd: string, nameIn: string, args: string): Promise<string | null> {
    const name = nameIn.trim().replace(/^\//, '');
    if (!name || BUILTIN_NAMES.has(name)) return null;
    const all = await scan(cwd);
    const rec = all.find((r) => r.info.name === name) ?? all.find((r) => r.info.name.toLowerCase() === name.toLowerCase());
    if (!rec) return null;
    return substituteArguments(rec.body, args);
  }

  return { slashCommands, expandCommand };
}
