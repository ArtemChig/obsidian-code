// Claude Code process setup for the claude-code engine: the isolated config dir and the system prompt.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, gitSummary } from '../../agent/prompt';

/** What is imported from ~/.claude (never settings.json, credentials, history, projects or plugins). */
export const IMPORTED_ENTRIES = ['skills', 'agents', 'commands', 'CLAUDE.md'] as const;
const MARKER = '.obsidian-imported.json';

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

/**
 * Prepare <dataDir>/claude-code (CLAUDE_CONFIG_DIR of every claude-code session). When `importUser` is on, mirror
 * ~/.claude/{skills,agents,commands,CLAUDE.md} into it (read-only access to the user's folder); when off, remove
 * what an earlier import copied. Returns the directory.
 */
export async function prepareConfigDir(dataDir: string, importUser: boolean, userClaudeDir = join(homedir(), '.claude')): Promise<string> {
  const dir = join(dataDir, 'claude-code');
  await fs.mkdir(dir, { recursive: true });
  let imported: string[] = [];
  try { imported = JSON.parse(await fs.readFile(join(dir, MARKER), 'utf8')) as string[]; } catch { imported = []; }
  for (const name of imported) {
    if ((IMPORTED_ENTRIES as readonly string[]).includes(name)) await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
  }
  const now: string[] = [];
  if (importUser && userClaudeDir !== dir) {
    for (const name of IMPORTED_ENTRIES) {
      const src = join(userClaudeDir, name);
      if (!(await exists(src))) continue;
      try {
        await fs.cp(src, join(dir, name), { recursive: true, force: true, dereference: true, errorOnExist: false });
        now.push(name);
      } catch { /* unreadable entry: skip */ }
    }
  }
  await fs.writeFile(join(dir, MARKER), JSON.stringify(now));
  return dir;
}

/**
 * 'lean' system prompt: the builtin engine's compact prompt without its environment block (Claude Code adds the
 * environment, git status, skills and CLAUDE.md itself) — no refusal or content-policy language.
 */
export async function leanSystemPrompt(opts: { cwd: string; shell: string; os: string; date: string; memory?: string }): Promise<string> {
  const git = await gitSummary(opts.cwd).catch(() => null);
  const text = buildSystemPrompt({
    cwd: opts.cwd, date: opts.date, os: opts.os, shell: opts.shell, git, memory: opts.memory ?? '', skills: [], agentTypes: [],
    toolNames: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Task', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion', 'WebFetch', 'Skill'],
  });
  const sections = text.split('\n\n').filter((s) => !s.startsWith('# Environment'));
  sections.splice(1, 0, 'You run inside the Claude Code harness: its tools, subagents (Agent tool), skills, slash commands, hooks, plan mode and permission system are available. Web search is the mcp__obsidian__web_search tool; scheduled tasks are mcp__obsidian__schedule_task / list_scheduled_tasks / delete_scheduled_task.');
  return sections.join('\n\n')
    .replace('subagent with Task; several Task calls', 'subagent with the Agent tool; several Agent calls');
}
