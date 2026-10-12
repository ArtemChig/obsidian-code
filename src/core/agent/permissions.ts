// Permission engine: modes + allow/deny rules (SPEC §4.1 "Permissions").
//
// Rule syntax:
//   "Tool"                    any call of Tool (also "mcp__server" = every tool of that MCP server)
//   "Bash(npm test:*)"        Bash/PowerShell command prefix  ("Bash(npm test)" = exact command)
//   "WebFetch(domain:x.com)"  URL host is x.com or a subdomain
//   "Edit(src/**)"            path glob (relative to cwd, absolute, or ~/…); Edit rules cover every edit tool,
//   "Read(glob)"              Read rules cover read-only file tools
//   "Tool(anything)"          equals Tool.ruleFor(input)
// Deny rules win over everything (also in bypassPermissions mode).

import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { PermissionKind, ToolDef } from '../contracts';
import type { PermissionMode } from '../../shared/types';

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

/** Pull the most relevant path/command/url out of a tool input. */
export function inputPath(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function inputCommand(input: Record<string, unknown>): string | undefined {
  const v = input.command;
  return typeof v === 'string' ? v : undefined;
}

function inputUrl(input: Record<string, unknown>): string | undefined {
  const v = input.url;
  return typeof v === 'string' ? v : undefined;
}

const WIN = process.platform === 'win32';

function normSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

export function resolvePath(cwd: string, p: string): string {
  let s = p.trim();
  if (s.startsWith('~/') || s.startsWith('~\\') || s === '~') s = homedir() + s.slice(1);
  return resolve(cwd, s);
}

export function isInside(cwd: string, absPath: string): boolean {
  const rel = relative(resolve(cwd), resolve(absPath));
  if (rel === '') return true;
  if (WIN && /^[a-zA-Z]:/.test(rel)) return false; // different drive
  return !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

/** Split a shell command into its sub-commands (&&, ||, ;, |, newlines) outside quotes. */
export function splitShellCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && cmd[i - 1] !== '\\') quote = null;
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

function matchDomain(spec: string, url: string): boolean {
  const m = /^domain:(.+)$/i.exec(spec.trim());
  if (!m) return false;
  const want = m[1]!.trim().toLowerCase().replace(/^\*\./, '');
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return host === want || host.endsWith(`.${want}`);
}

function matchGlob(spec: string, cwd: string, p: string): boolean {
  let pattern = spec.trim();
  if (!pattern) return false;
  if (pattern.startsWith('//')) pattern = pattern.slice(1); // "//abs/path" → absolute
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) pattern = homedir() + pattern.slice(1);
  const absPattern = isAbsolute(pattern) || /^[a-zA-Z]:[\\/]/.test(pattern) ? pattern : `${normSlashes(resolve(cwd))}/${pattern.replace(/^\.\//, '')}`;
  const target = normSlashes(resolvePath(cwd, p));
  const isMatch = picomatch(normSlashes(absPattern), { dot: true, nocase: WIN });
  if (isMatch(target)) return true;
  // a directory pattern ("src" or "src/") covers everything below it
  const dirMatch = picomatch(`${normSlashes(absPattern).replace(/\/+$/, '')}/**`, { dot: true, nocase: WIN });
  return dirMatch(target);
}

/** Does `rule` match this call? */
export function ruleMatches(rule: ParsedRule, tool: ToolDef, input: Record<string, unknown>, cwd: string, kind: PermissionKind): boolean {
  const name = tool.name;
  // MCP server-wide rule
  if (rule.tool.startsWith('mcp__') && !rule.spec && name.startsWith(`${rule.tool}__`)) return true;
  const family = (rule.tool === 'Edit' && (EDIT_TOOLS.has(name) || kind === 'edit'))
    || (rule.tool === 'Read' && READ_FILE_TOOLS.has(name))
    || (rule.tool === 'Bash' && name === 'PowerShell' && rule.spec !== undefined);
  if (rule.tool !== name && !family) return false;
  if (rule.spec === undefined || rule.spec === '' || rule.spec === '*') return true;
  const spec = rule.spec;
  if (SHELL_TOOLS.has(name)) {
    const cmd = inputCommand(input);
    if (cmd === undefined) return false;
    return matchCommand(spec, cmd);
  }
  if (/^domain:/i.test(spec)) {
    const url = inputUrl(input);
    return url ? matchDomain(spec, url) : false;
  }
  const p = inputPath(input);
  if (p && (EDIT_TOOLS.has(name) || READ_FILE_TOOLS.has(name) || kind === 'edit' || kind === 'read')) {
    if (matchGlob(spec, cwd, p)) return true;
  }
  try {
    const own = tool.ruleFor?.(input);
    if (own && own === rule.raw) return true;
  } catch { /* ignore */ }
  return false;
}

/** For shell commands every sub-command must be covered by an allow rule. */
function allowedByRules(rules: ParsedRule[], tool: ToolDef, input: Record<string, unknown>, cwd: string, kind: PermissionKind): ParsedRule | null {
  if (SHELL_TOOLS.has(tool.name)) {
    const cmd = inputCommand(input);
    const whole = rules.find((r) => r.tool === tool.name && (r.spec === undefined || r.spec === '*'));
    if (whole) return whole;
    if (cmd === undefined) return null;
    const parts = splitShellCommand(cmd);
    if (!parts.length) return null;
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

function deniedByRules(rules: ParsedRule[], tool: ToolDef, input: Record<string, unknown>, cwd: string, kind: PermissionKind): ParsedRule | null {
  if (SHELL_TOOLS.has(tool.name)) {
    const cmd = inputCommand(input);
    const whole = rules.find((r) => r.tool === tool.name && (r.spec === undefined || r.spec === '*'));
    if (whole) return whole;
    if (cmd === undefined) return null;
    for (const part of [cmd, ...splitShellCommand(cmd)]) {
      const hit = rules.find((r) => ruleMatches(r, tool, { ...input, command: part }, cwd, kind));
      if (hit) return hit;
    }
    return null;
  }
  return rules.find((r) => ruleMatches(r, tool, input, cwd, kind)) ?? null;
}

export function suggestedRuleFor(tool: ToolDef, input: Record<string, unknown>): string {
  try {
    const r = tool.ruleFor?.(input);
    if (r) return r;
  } catch { /* ignore */ }
  return tool.name;
}

export function planModeMessage(toolName: string): string {
  return `Plan mode is active, so ${toolName} was not run. In plan mode you may only use read-only tools (Read, Glob, Grep, LS, WebFetch, WebSearch, …) to research. When your plan is ready, call ExitPlanMode with the plan and wait for the user's approval before making any changes.`;
}

export interface DecideInput {
  tool: ToolDef;
  input: Record<string, unknown>;
  cwd: string;
  mode: PermissionMode;
  kind: PermissionKind;
  allow: string[];
  deny: string[];
}

/** Decide what to do with a tool call (pure; the agent performs the ask). */
export function decidePermission(d: DecideInput): PermissionOutcome {
  const { tool, input, cwd, mode, kind } = d;
  const deny = d.deny.map(parseRule).filter((r): r is ParsedRule => !!r);
  const allow = d.allow.map(parseRule).filter((r): r is ParsedRule => !!r);

  const denied = deniedByRules(deny, tool, input, cwd, kind);
  if (denied) {
    return { action: 'deny', reason: `deny rule ${denied.raw}`, message: `Permission to use ${tool.name} was denied by the rule "${denied.raw}". Don't retry this call; choose another approach or ask the user.` };
  }
  if (mode === 'plan' && kind !== 'read' && kind !== 'none' && tool.name !== 'ExitPlanMode') {
    return { action: 'deny', reason: 'plan mode', message: planModeMessage(tool.name) };
  }
  if (mode === 'bypassPermissions') return { action: 'allow', reason: 'bypassPermissions mode' };
  if (kind === 'read' || kind === 'none') return { action: 'allow', reason: `${kind} tool` };
  const allowed = allowedByRules(allow, tool, input, cwd, kind);
  if (allowed) return { action: 'allow', reason: `allow rule ${allowed.raw}` };
  if (mode === 'acceptEdits' && kind === 'edit') {
    const p = inputPath(input);
    if (!p || isInside(cwd, resolvePath(cwd, p))) return { action: 'allow', reason: 'acceptEdits (inside cwd)' };
  }
  return { action: 'ask', reason: `${kind} needs approval`, suggestedRule: suggestedRuleFor(tool, input) };
}
