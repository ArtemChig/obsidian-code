// Platform shell resolution for hook commands: Git Bash if present, else PowerShell on Windows; bash/sh elsewhere.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../shared/types';

export type ShellKind = 'git-bash' | 'powershell' | 'cmd' | 'sh';

export interface ShellSpec {
  kind: ShellKind;
  file: string;
  /** Arguments that make the shell run `command`. */
  args(command: string): string[];
  /** Pass arguments to CreateProcess unquoted (cmd.exe /s /c "..."). */
  verbatim?: boolean;
}

let gitBashCache: string | null | undefined;

export function findGitBash(): string | null {
  if (process.platform !== 'win32') return null;
  if (gitBashCache !== undefined) return gitBashCache;
  const env = process.env;
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : '',
  ].filter(Boolean);
  // Derive from git.exe on PATH (<root>\cmd\git.exe → <root>\bin\bash.exe). Never use System32\bash.exe (that is WSL).
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, 'git.exe'))) candidates.push(path.join(dir, '..', 'bin', 'bash.exe'));
  }
  gitBashCache = candidates.find((c) => existsSync(c)) ?? null;
  return gitBashCache;
}

export function resolveShell(pref: Settings['shell'] | undefined): ShellSpec {
  if (process.platform !== 'win32') {
    const file = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    return { kind: 'sh', file, args: (c) => ['-c', c] };
  }
  const bash = findGitBash();
  const ps: ShellSpec = {
    kind: 'powershell',
    file: 'powershell.exe',
    // UTF-8 both ways, and propagate a native command's exit code (plain -Command reports 1 for any failure, which would
    // hide the "exit 2 = block" convention).
    args: (c) => [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${c}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
    ],
  };
  const cmd: ShellSpec = {
    kind: 'cmd',
    file: process.env.ComSpec || 'cmd.exe',
    args: (c) => ['/d', '/s', '/c', `"${c}"`],
    verbatim: true,
  };
  const gitBash: ShellSpec | null = bash ? { kind: 'git-bash', file: bash, args: (c) => ['-c', c] } : null;
  switch (pref) {
    case 'powershell':
      return ps;
    case 'cmd':
      return cmd;
    case 'git-bash':
      return gitBash ?? ps;
    default:
      return gitBash ?? ps;
  }
}
