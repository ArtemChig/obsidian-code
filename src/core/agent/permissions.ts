// Permission engine: modes + allow/deny rules (SPEC §4.1 "Permissions").
//
// Rule syntax:
//   "Tool"                    any call of Tool (also "mcp__server" = every tool of that MCP server). A bare edit rule
//                             ("Edit", "Write", …) only covers files inside the project.
//   "Bash(npm test:*)"        Bash/PowerShell command prefix  ("Bash(npm test)" = exact command line)
//   "WebFetch(domain:x.com)"  URL host is x.com or a subdomain
//   "Edit(src/**)"            path glob (relative to cwd, absolute, or ~/…); Edit rules cover every edit tool,
//   "Read(glob)"              Read rules cover read-only file tools
//   "Tool(anything)"          equals Tool.ruleFor(input)
// Deny rules win over everything (also in bypassPermissions mode).
//
// The caller must pass the tool's *normalised* input (ToolDef.normalize) so the engine judges exactly what runs.
// Paths go through the tools' own resolver (quotes, file:// URLs, /c/… msys paths, ~) and are also checked after
// resolving symlinks/junctions. Edits to protected paths (agent/project configuration, hooks, git internals, memory
// files) always ask: they could otherwise turn edit permission into command execution.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import type { PermissionKind, ToolDef } from '../contracts';
import type { PermissionMode } from '../../shared/types';
import { resolvePath as resolveToolPath } from '../tools/lib/paths';
import { isRemotePathLike, isSensitivePathLike, splitSegments, type ShellKind } from '../tools/lib/shell';
import { canonicalHost, fetchHost } from '../tools/lib/url';

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const READ_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export type PermissionOutcome =
  | { action: 'allow'; reason: string }
  | { action: 'deny'; reason: string; message: string }
  | { action: 'ask'; reason: string; suggestedRule: string };

export interface ParsedRule { tool: string; spec?: string; raw: string }

export function parseRule(raw: string): ParsedRule | null {
  const r = raw.trim();
  if (!r) return null;
  const m = /^([^()\s]+)\s*(?:\((.*)\))?$/s.exec(r);
  if (!m) return null;
  return { tool: m[1]!, spec: m[2]?.trim(), raw: r };
}

/** Pull the most relevant path out of a tool input (aliases only as a fallback for un-normalised input). */
export function inputPath(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path', 'filePath', 'notebookPath', 'filepath', 'filename', 'file']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function inputCommand(input: Record<string, unknown>): string | undefined {
  for (const k of ['command', 'cmd', 'script']) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function inputUrl(input: Record<string, unknown>): string | undefined {
  for (const k of ['url', 'uri', 'link', 'href', 'website', 'page']) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

const WIN = process.platform === 'win32';

function normSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Same resolution as the tools use (quotes, file:// URLs, /c/… msys paths, ~). */
export function resolvePath(cwd: string, p: string): string {
  return resolveToolPath(p, cwd);
}

/** Resolve symlinks/junctions: real path of the nearest existing ancestor + the part that does not exist yet. */
export function realPathOf(abs: string): string {
  let cur = resolve(abs);
  const rest: string[] = [];
  for (let i = 0; i < 512; i++) {
    try {
      const real = realpathSync.native(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch { /* missing (or unreadable): try the parent */ }
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.push(basename(cur));
    cur = parent;
  }
  return resolve(abs);
}

function lexInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Inside cwd both lexically and after resolving symlinks/junctions. */
export function isInside(cwd: string, absPath: string): boolean {
  return lexInside(resolve(cwd), resolve(absPath)) && lexInside(realPathOf(cwd), realPathOf(absPath));
}

interface Target { lex: string; real: string; cwdLex: string; cwdReal: string }

function targetOf(cwd: string, p: string): Target {
  const lex = resolvePath(cwd, p);
  return { lex, real: realPathOf(lex), cwdLex: resolve(cwd), cwdReal: realPathOf(cwd) };
}

function targetInside(t: Target): boolean {
  return lexInside(t.cwdLex, t.lex) && lexInside(t.cwdReal, t.real);
}

// ───────────────────────────── protected paths ─────────────────────────────

/** Directories whose contents configure the agent/hooks/git (writing them can lead to command execution). */
const PROTECTED_DIRS = new Set(['.obsidian-code', '.claude', '.git', '.vscode', '.husky', '.ssh']);
/** Shell start-up / credential files: writing them runs code in the user's next shell or hands out credentials. */
const PROTECTED_DOTFILES = new Set([
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.envrc', '.gitconfig',
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.gitmodules',
]);
/** Memory files loaded into every system prompt. */
const PROTECTED_FILES = new Set(['obsidian.md', 'claude.md', 'claude.local.md', 'agents.md']);

export function isProtectedPath(absPaths: string[], extraDirs: string[] = []): boolean {
  for (const p of absPaths) {
    const segs = normSlashes(p).split('/').filter(Boolean).map((s) => (WIN ? s.toLowerCase() : s));
    if (segs.some((s) => PROTECTED_DIRS.has(s))) return true;
    const base = segs[segs.length - 1];
    if (base && PROTECTED_FILES.has(base.toLowerCase())) return true;
    if (base && (PROTECTED_DOTFILES.has(base.toLowerCase()) || /profile\.ps1$/i.test(base))) return true;
    if (normSlashes(p).toLowerCase().includes('/start menu/programs/startup')) return true;
    for (const d of extraDirs) {
      if (d && (lexInside(resolve(d), p) || lexInside(realPathOf(d), p))) return true;
    }
  }
  return false;
}

// ───────────────────────────── shell commands ─────────────────────────────

/** Split a shell command into its sub-commands (&&, ||, ;, |, &, newlines) outside quotes (lenient; deny matching only). */
export function splitShellCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      cur += ch;
      // a backslash escapes the closing quote only inside double quotes (bash single quotes have no escapes)
      if (ch === quote && !(quote === '"' && cmd[i - 1] === '\\')) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '&') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'doas', 'xargs']);

/** Variants of one sub-command for deny matching: without grouping chars, env assignments, wrappers and binary paths. */
function denyVariants(part: string): string[] {
  const out = new Set<string>();
  let s = part.trim();
  for (let i = 0; i < 8 && s; i++) {
    out.add(s);
    s = s.replace(/^[\s({!]+/, '').replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(/^\\/, '');
    const tokens = s.split(/\s+/);
    tokens[0] = basename(normSlashes(tokens[0] ?? '')).replace(/\.exe$/i, '');
    s = tokens.join(' ').trim();
    out.add(s);
    if (!WRAPPERS.has(tokens[0]!.toLowerCase())) break;
    // drop the wrapper and its options ("sudo -n rm …" → "rm …")
    let j = 1;
    while (j < tokens.length && tokens[j]!.startsWith('-')) j++;
    s = tokens.slice(j).join(' ').trim();
  }
  return [...out].filter(Boolean);
}

/** Every command a shell line might run, over-approximated (deny rules must not be bypassable by quoting tricks). */
export function denyCandidates(cmd: string, kind: ShellKind): string[] {
  const strict = splitSegments(cmd, kind);
  // unparseable ($(), backticks, redirections, odd quoting): split on every separator/substitution char, ignoring quotes
  const loose = strict ?? cmd.split(/\$\(|[;&|\n\r()`{}<>]/);
  const out = new Set<string>();
  for (const p of [cmd, ...loose, ...splitShellCommand(cmd)]) for (const v of denyVariants(p)) out.add(v);
  return [...out];
}

function matchCommand(spec: string, command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, ' ');
  let s = spec.trim();
  if (s.endsWith(':*')) {
    s = s.slice(0, -2).trim().replace(/\s+/g, ' ');
    return cmd === s || cmd.startsWith(`${s} `);
  }
  if (s.endsWith('*')) return cmd.startsWith(s.slice(0, -1).replace(/\s+/g, ' '));
  return cmd === s.replace(/\s+/g, ' ');
}

function isPrefixSpec(spec: string | undefined): boolean {
  return !!spec && spec.trim().endsWith('*');
}

/** Host rule match on exactly the host WebFetch will contact (scheme-less input, trailing dot, IDN, brackets).
 *  A URL the fetcher's normaliser cannot parse matches every deny rule (fail closed) and no allow rule. */
function matchDomain(spec: string, url: string, purpose: 'allow' | 'deny'): boolean {
  const m = /^domain:(.+)$/i.exec(spec.trim());
  if (!m) return false;
  const want = canonicalHost(m[1]!.trim().replace(/^\*\./, ''));
  const host = fetchHost(url);
  if (!host || !want) return purpose === 'deny';
  return host === want || host.endsWith(`.${want}`);
}

// ───────────────────────────── path globs ─────────────────────────────

/** Match one glob spec against one resolved path. Relative and ~/ patterns are matched against the path relative to
 *  their base, so special characters in cwd/home (e.g. "app (copy)") never leak into the glob. */
function globMatchOne(spec: string, cwd: string, target: string, home: string): boolean {
  let pattern = normSlashes(spec.trim());
  if (!pattern) return false;
  let candidate: string;
  if (pattern.startsWith('//')) pattern = pattern.slice(1); // "//abs/path" → absolute
  if (/^\/[a-zA-Z]:\//.test(pattern)) pattern = pattern.slice(1); // "//C:/x" → "C:/x"
  if (pattern === '~' || pattern.startsWith('~/')) {
    const rel = relative(home, target);
    if (isAbsolute(rel)) return false;
    candidate = normSlashes(rel);
    pattern = pattern === '~' ? '**' : pattern.slice(2);
  } else if (pattern.startsWith('/') || /^[a-zA-Z]:\//.test(pattern)) {
    candidate = normSlashes(target);
  } else {
    const rel = relative(cwd, target);
    if (isAbsolute(rel)) return false;
    candidate = normSlashes(rel);
    pattern = pattern.replace(/^\.\//, '');
  }
  if (!candidate) return false;
  const opts = { dot: true, nocase: WIN };
  try {
    if (picomatch(pattern, opts)(candidate)) return true;
    // a directory pattern ("src" or "src/") covers everything below it
    return picomatch(`${pattern.replace(/\/+$/, '')}/**`, opts)(candidate);
  } catch {
    return false;
  }
}

/** Allow rules must match both the lexical and the symlink-resolved path; deny rules either. */
function matchGlob(spec: string, t: Target, purpose: 'allow' | 'deny'): boolean {
  const lex = globMatchOne(spec, t.cwdLex, t.lex, homedir());
  const real = globMatchOne(spec, t.cwdReal, t.real, realPathOf(homedir()));
  return purpose === 'allow' ? lex && real : lex || real;
}

/** Does `rule` match this call? */
export function ruleMatches(rule: ParsedRule, tool: ToolDef, input: Record<string, unknown>, cwd: string, kind: PermissionKind, purpose: 'allow' | 'deny' = 'allow'): boolean {
  const name = tool.name;
  // MCP server-wide rule
  if (rule.tool.startsWith('mcp__') && !rule.spec && name.startsWith(`${rule.tool}__`)) return true;
  const isEdit = EDIT_TOOLS.has(name) || kind === 'edit';
  const family = (rule.tool === 'Edit' && isEdit)
    || (rule.tool === 'Read' && READ_FILE_TOOLS.has(name))
    || (rule.tool === 'Bash' && name === 'PowerShell' && rule.spec !== undefined);
  if (rule.tool !== name && !family) return false;
  const bare = rule.spec === undefined || rule.spec === '' || rule.spec === '*';
  if (bare) {
    // a bare allow rule for an edit tool only covers files inside the project
    if (purpose === 'allow' && isEdit) {
      const p = inputPath(input);
      return !!p && targetInside(targetOf(cwd, p));
    }
    return true;
  }
  const spec = rule.spec!;
  if (SHELL_TOOLS.has(name)) {
    const cmd = inputCommand(input);
    if (cmd === undefined) return false;
    return matchCommand(spec, cmd);
  }
  if (/^domain:/i.test(spec)) {
    const url = inputUrl(input);
    return url !== undefined ? matchDomain(spec, url, purpose) : purpose === 'deny' && name === 'WebFetch';
  }
  const p = inputPath(input);
  if (p && (isEdit || READ_FILE_TOOLS.has(name) || kind === 'read')) {
    if (matchGlob(spec, targetOf(cwd, p), purpose)) return true;
  }
  if (isEdit) return false; // edit tools are only ever matched by path
  try {
    const own = tool.ruleFor?.(input);
    if (own && own === rule.raw) return true;
  } catch { /* ignore */ }
  return false;
}

function shellKindFor(tool: ToolDef, shellKind: ShellKind | undefined): ShellKind {
  return tool.name === 'PowerShell' ? 'powershell' : shellKind ?? 'bash';
}

/** For shell commands every sub-command must be covered by an allow rule (or an exact rule covers the whole line). */
function allowedByRules(rules: ParsedRule[], tool: ToolDef, input: Record<string, unknown>, cwd: string, kind: PermissionKind, shellKind: ShellKind | undefined): ParsedRule | null {
  if (SHELL_TOOLS.has(tool.name)) {
    const cmd = inputCommand(input);
    const whole = rules.find((r) => r.tool === tool.name && (r.spec === undefined || r.spec === '*'));
    if (whole) return whole;
    if (cmd === undefined) return null;
    const exact = rules.find((r) => r.spec && !isPrefixSpec(r.spec) && ruleMatches(r, tool, { ...input, command: cmd }, cwd, kind));
    if (exact) return exact;
    // strict parse: null for $(), backticks, redirections, bare & … — then no prefix rule can vouch for the line
    const parts = splitSegments(cmd, shellKindFor(tool, shellKind));
    if (!parts?.length) return null;
    let first: ParsedRule | null = null;
    for (const part of parts) {
      const hit = rules.find((r) => ruleMatches(r, tool, { ...input, command: part }, cwd, kind));
      if (!hit) return null;
      first ??= hit;
    }
    return first;
  }
  return rules.find((r) => ruleMatches(r, tool, input, cwd, kind)) ?? null;
}

function deniedByRules(rules: ParsedRule[], tool: ToolDef, input: Record<string, unknown>, cwd: string, kind: PermissionKind, shellKind: ShellKind | undefined): ParsedRule | null {
  if (SHELL_TOOLS.has(tool.name)) {
    const cmd = inputCommand(input);
    const whole = rules.find((r) => r.tool === tool.name && (r.spec === undefined || r.spec === '*'));
    if (whole) return whole;
    if (cmd === undefined) return null;
    for (const part of denyCandidates(cmd, shellKindFor(tool, shellKind))) {
      const hit = rules.find((r) => ruleMatches(r, tool, { ...input, command: part }, cwd, kind, 'deny'));
      if (hit) return hit;
    }
    return null;
  }
  return rules.find((r) => ruleMatches(r, tool, input, cwd, kind, 'deny')) ?? null;
}

const GLOB_SPECIAL = /[*?[\]{}()!+@|\\]/;

/** "Always allow" for an edit: the file's directory inside the project (never a bare tool rule, never outside cwd). */
function editRuleFor(t: Target): string {
  if (!targetInside(t)) return '';
  const segs = normSlashes(relative(t.cwdLex, t.lex)).split('/').filter(Boolean);
  if (!segs.length) return '';
  const dirs = segs.slice(0, -1);
  const cut = dirs.findIndex((s) => GLOB_SPECIAL.test(s));
  const safe = cut === -1 ? dirs : dirs.slice(0, cut);
  if (safe.length) return `Edit(${safe.join('/')}/**)`;
  const file = segs[segs.length - 1]!;
  return cut === -1 && !GLOB_SPECIAL.test(file) ? `Edit(${file})` : '';
}

export function suggestedRuleFor(tool: ToolDef, input: Record<string, unknown>, cwd?: string, kind?: PermissionKind): string {
  if (EDIT_TOOLS.has(tool.name) || kind === 'edit') {
    const p = inputPath(input);
    return p && cwd ? editRuleFor(targetOf(cwd, p)) : '';
  }
  try {
    const r = tool.ruleFor?.(input);
    if (typeof r === 'string') return r; // '' = no safe "always" rule
  } catch { return ''; }
  return tool.name;
}

export function planModeMessage(toolName: string): string {
  return `Plan mode is active, so ${toolName} was not run. In plan mode you may only use read-only tools (Read, Glob, Grep, LS, WebFetch, WebSearch, …) to research. When your plan is ready, call ExitPlanMode with the plan and wait for the user's approval before making any changes.`;
}

/** Reads that must not be free: UNC/device paths (NTLM credential leak) and credential files / the app's data dir. */
function readTargetProblem(tool: ToolDef, input: Record<string, unknown>, cwd: string, protectedDirs: string[] = []): { reason: string; remote: boolean } | null {
  const raws = [inputPath(input), tool.name === 'Glob' && typeof input.pattern === 'string' ? input.pattern : undefined];
  for (const raw of raws) {
    if (!raw?.trim()) continue;
    const lex = resolvePath(cwd, raw);
    if (/^[\\/][\\/]/.test(lex) || isRemotePathLike(raw.trim())) return { reason: 'read of a network (UNC) path', remote: true };
    if (raw !== raws[0]) continue;
    const real = realPathOf(lex);
    if (isSensitivePathLike(lex) || isSensitivePathLike(real)) return { reason: 'read of a credential file', remote: false };
    const cwdReal = realPathOf(cwd);
    for (const dir of protectedDirs) {
      // (a session working inside that dir, e.g. a test sandbox, may read it)
      if (dir && lexInside(realPathOf(dir), real) && !lexInside(realPathOf(dir), cwdReal)) return { reason: "read of the app's data folder", remote: false };
    }
  }
  return null;
}

export interface DecideInput {
  tool: ToolDef;
  /** The tool's normalised input (ToolDef.normalize), i.e. exactly what run() will see. */
  input: Record<string, unknown>;
  cwd: string;
  mode: PermissionMode;
  kind: PermissionKind;
  allow: string[];
  deny: string[];
  /** Shell the Bash tool runs in (decides how command lines are split). Default 'bash'. */
  shellKind?: ShellKind;
  /** Extra directories whose files always need approval to edit (e.g. the app's data dir with user settings). */
  protectedDirs?: string[];
}

/** Decide what to do with a tool call (pure apart from path resolution; the agent performs the ask). */
export function decidePermission(d: DecideInput): PermissionOutcome {
  const { tool, input, cwd, mode, kind } = d;
  const deny = d.deny.map(parseRule).filter((r): r is ParsedRule => !!r);
  const allow = d.allow.map(parseRule).filter((r): r is ParsedRule => !!r);

  const denied = deniedByRules(deny, tool, input, cwd, kind, d.shellKind);
  if (denied) {
    return { action: 'deny', reason: `deny rule ${denied.raw}`, message: `Permission to use ${tool.name} was denied by the rule "${denied.raw}". Don't retry this call; choose another approach or ask the user.` };
  }
  if (mode === 'plan' && kind !== 'read' && kind !== 'none' && tool.name !== 'ExitPlanMode') {
    return { action: 'deny', reason: 'plan mode', message: planModeMessage(tool.name) };
  }
  if (mode === 'bypassPermissions') return { action: 'allow', reason: 'bypassPermissions mode' };
  if (kind === 'read' && READ_FILE_TOOLS.has(tool.name)) {
    const reads = readTargetProblem(tool, input, cwd, d.protectedDirs);
    if (reads) {
      // a credential file can still be allowed by an explicit path rule (never by a bare "Read"); UNC paths always ask
      const ruled = reads.remote ? null : allowedByRules(allow.filter((r) => r.spec && r.spec !== '*'), tool, input, cwd, kind, d.shellKind);
      if (ruled) return { action: 'allow', reason: `allow rule ${ruled.raw}` };
      return { action: 'ask', reason: reads.reason, suggestedRule: '' };
    }
  }
  if (kind === 'read' || kind === 'none') return { action: 'allow', reason: `${kind} tool` };
  if (kind === 'edit' || EDIT_TOOLS.has(tool.name)) {
    const p = inputPath(input);
    if (!p) return { action: 'ask', reason: 'edit without a resolvable path', suggestedRule: '' };
    const t = targetOf(cwd, p);
    if (isProtectedPath([t.lex, t.real], d.protectedDirs)) {
      return { action: 'ask', reason: 'protected path (agent/project configuration)', suggestedRule: '' };
    }
    const allowed = allowedByRules(allow, tool, input, cwd, kind, d.shellKind);
    if (allowed) return { action: 'allow', reason: `allow rule ${allowed.raw}` };
    if (mode === 'acceptEdits' && targetInside(t)) return { action: 'allow', reason: 'acceptEdits (inside cwd)' };
    return { action: 'ask', reason: 'edit needs approval', suggestedRule: editRuleFor(t) };
  }
  const allowed = allowedByRules(allow, tool, input, cwd, kind, d.shellKind);
  if (allowed) return { action: 'allow', reason: `allow rule ${allowed.raw}` };
  return { action: 'ask', reason: `${kind} needs approval`, suggestedRule: suggestedRuleFor(tool, input, cwd, kind) };
}
