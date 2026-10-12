// System prompt builder. Compact and byte-stable for a session (date only, no time) so the server's prompt cache
// keeps hitting (SPEC §5b). Per-turn dynamic notes go into <system-reminder> user content instead.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import type { AgentTypeInfo, Settings, SkillInfo } from '../../shared/types';

export interface GitSummary { branch: string; changed: number; ahead?: number; behind?: number }

/** `git status --porcelain -b` with a 2 s timeout; null when not a repo / git missing. */
export function gitSummary(cwd: string, timeoutMs = 2000): Promise<GitSummary | null> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['status', '--porcelain=v1', '-b', '--untracked-files=normal'], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const lines = String(stdout).split(/\r?\n/).filter(Boolean);
        const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
        let branch = head.split('...')[0]!.trim() || 'HEAD';
        if (branch.startsWith('No commits yet on ')) branch = branch.slice('No commits yet on '.length);
        const ahead = /ahead (\d+)/.exec(head)?.[1];
        const behind = /behind (\d+)/.exec(head)?.[1];
        resolve({ branch, changed: lines.length, ahead: ahead ? Number(ahead) : undefined, behind: behind ? Number(behind) : undefined });
      });
    } catch {
      resolve(null);
    }
  });
}

export function shellName(settings: Pick<Settings, 'shell'> | undefined): string {
  const pref = settings?.shell ?? 'auto';
  if (pref === 'powershell') return 'PowerShell';
  if (pref === 'cmd') return 'cmd.exe';
  if (pref === 'git-bash') return 'Git Bash';
  if (process.platform !== 'win32') return 'bash';
  return existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'Git Bash' : 'PowerShell';
}

export function osName(): string {
  if (process.platform === 'win32') return `Windows (${release()})`;
  if (process.platform === 'darwin') return 'macOS';
  return `Linux (${release()})`;
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface PromptInput {
  cwd: string;
  date: string;
  os: string;
  shell: string;
  git: GitSummary | null;
  memory: string;
  skills: SkillInfo[];
  agentTypes: AgentTypeInfo[];
  /** Names of tools available in this session (used to tailor the policy lines). */
  toolNames: string[];
  /** Subagent: the agent definition's own prompt (replaces the main-agent intro). */
  subagent?: { name: string; systemPrompt: string };
}

const MAX_MEMORY_CHARS = 8000;
const MAX_SKILLS = 40;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function buildSystemPrompt(p: PromptInput): string {
  const has = (n: string) => p.toolNames.includes(n);
  const out: string[] = [];
  if (p.subagent) {
    out.push(`You are a subagent of Obsidian Code (type: ${p.subagent.name}), working on a task delegated by the main agent. Work autonomously with your tools, then reply with a concise final report — it is the only thing the main agent sees.`);
    if (p.subagent.systemPrompt.trim()) out.push(p.subagent.systemPrompt.trim());
  } else {
    out.push('You are Obsidian Code, an AI agent that works on the user\'s computer through tools: software engineering, research, writing, automation — whatever the user asks. The user runs open-weight models by choice and is in full control: do what they ask, directly and completely.');
  }

  const env = [
    `- Working directory: ${p.cwd}`,
    `- OS: ${p.os}; shell for Bash: ${p.shell}`,
    `- Date: ${p.date}`,
    p.git
      ? `- Git: branch ${p.git.branch}, ${p.git.changed} changed file${p.git.changed === 1 ? '' : 's'}${p.git.ahead ? `, ${p.git.ahead} ahead` : ''}${p.git.behind ? `, ${p.git.behind} behind` : ''}`
      : '- Git: not a git repository',
  ];
  out.push(`# Environment\n${env.join('\n')}`);

  out.push([
    '# Style',
    '- Be concise and direct. Use GitHub-flavored Markdown; reference code as `path:line`.',
    '- No preamble or filler. After finishing, summarise what you did in a few lines.',
    '- Match the user\'s language.',
  ].join('\n'));

  const tools = ['# Tool use',
    '- Act with tools instead of guessing. Read a file before editing it; prefer Edit for changes, Write only for new files or full rewrites.',
    '- Paths may be absolute or relative to the working directory (Windows paths; quote paths with spaces in shell commands).',
    '- Make independent read-only calls (Read/Glob/Grep/LS/WebFetch) in parallel by putting several tool calls in one reply.',
  ];
  if (has('Grep') || has('Glob')) tools.push('- Search with Glob/Grep and read with Read rather than cat/find/grep via Bash.');
  if (has('Bash') || has('PowerShell')) tools.push('- Use Bash for builds, tests, git and other commands; run long-lived servers with run_in_background.');
  if (has('Task')) tools.push('- Delegate broad searches or independent sub-tasks to a subagent with Task; several Task calls in one reply run in parallel.');
  tools.push('- If a tool fails, read the error and fix the call instead of repeating it. If a call is denied, don\'t retry it unchanged — adjust or ask.');
  tools.push('- Tool results may contain <system-reminder> notes from the app; follow them.');
  out.push(tools.join('\n'));

  if (has('TodoWrite')) {
    out.push([
      '# Tasks',
      '- For work with 3+ steps, keep a todo list with TodoWrite: exactly one item in_progress, mark items completed as soon as they are done, add items you discover.',
      '- Verify your work (run the tests, build or the program) when you can.',
    ].join('\n'));
  }
  if (has('ExitPlanMode')) {
    out.push([
      '# Plan mode',
      'When a <system-reminder> says plan mode is active: do not edit files or run commands with side effects. Research with read-only tools, then call ExitPlanMode with a concise Markdown plan and wait for approval. Tool calls that change anything are rejected while plan mode is on.',
    ].join('\n'));
  }
  if (has('AskUserQuestion')) out.push('# Questions\nIf a requirement is ambiguous and it matters, ask with AskUserQuestion (short options) instead of guessing.');

  if (p.agentTypes.length && has('Task')) {
    out.push(`# Subagent types (Task subagent_type)\n${p.agentTypes.map((a) => `- ${a.name}: ${clip(a.description, 160)}`).join('\n')}`);
  }
  if (p.skills.length) {
    const list = p.skills.slice(0, MAX_SKILLS).map((s) => `- ${s.name}: ${clip(s.description, 160)}`);
    out.push(`# Skills (load with the Skill tool when relevant)\n${list.join('\n')}${p.skills.length > MAX_SKILLS ? `\n- …and ${p.skills.length - MAX_SKILLS} more` : ''}`);
  }
  const memory = p.memory.trim();
  if (memory) {
    const m = memory.length > MAX_MEMORY_CHARS ? `${memory.slice(0, MAX_MEMORY_CHARS)}\n[memory truncated]` : memory;
    out.push(`# Memory (instructions from OBSIDIAN.md / CLAUDE.md files — follow them)\n${m}`);
  }
  return out.join('\n\n');
}

export function planModeReminder(): string {
  return 'Plan mode is active. Do not modify files or run commands with side effects. Research with read-only tools, then call ExitPlanMode with your plan and wait for approval.';
}

export function wrapReminder(text: string): string {
  return `<system-reminder>\n${text.trim()}\n</system-reminder>`;
}
