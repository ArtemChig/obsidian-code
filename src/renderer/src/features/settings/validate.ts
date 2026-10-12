// Pure validation / parsing helpers for the Settings view (unit-tested). Owner: ui-views.
import type { GpuProfile, HookConfig, McpServerConfig, Settings } from '@shared/types';

// ───────────────────────────── JSON ─────────────────────────────

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string; line?: number; column?: number };

/** Locate the first syntax error of a JSON text (engine independent). Returns null when the text is valid JSON. */
export function locateJsonError(text: string): { pos: number; message: string } | null {
  let i = 0;
  const n = text.length;
  const fail = (message: string, pos = i): never => {
    throw Object.assign(new Error(message), { pos });
  };
  const ws = () => {
    while (i < n && /[ \t\r\n]/.test(text[i])) i++;
  };
  const show = (c: string | undefined) => (c === undefined ? 'end of text' : c === '\n' ? 'a line break' : `"${c}"`);
  const str = () => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\n') fail('Unterminated string (missing closing quote)', start);
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('Invalid \\u escape in string', i);
          i += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) fail(`Invalid escape "\\${e ?? ''}" in string (backslashes must be doubled, e.g. C:\\\\Projects)`, i);
        i += 2;
        continue;
      }
      i++;
    }
    fail('Unterminated string (missing closing quote)', start);
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === '}' ? 'Trailing comma: remove it' : `Expected a property name in double quotes, found ${show(text[i])}`);
        str();
        ws();
        if (text[i] !== ':') fail(`Expected ":" after the property name, found ${show(text[i])}`);
        i++;
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail(`Expected "," or "}", found ${show(text[i])}`);
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] === ']') fail('Trailing comma: remove it');
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail(`Expected "," or "]", found ${show(text[i])}`);
      }
    } else if (c === '"') {
      str();
    } else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fail('Invalid number');
      i += (m as RegExpExecArray)[0].length;
    } else if (text.startsWith('true', i)) i += 4;
    else if (text.startsWith('false', i)) i += 5;
    else if (text.startsWith('null', i)) i += 4;
    else fail(c === undefined ? 'Unexpected end of text: something is not closed' : `Unexpected ${show(c)}: expected a value`);
  };
  try {
    value();
    ws();
    if (i < n) fail(`Unexpected ${show(text[i])} after the end of the JSON`);
    return null;
  } catch (err) {
    const e = err as Error & { pos?: number };
    return { pos: e.pos ?? i, message: e.message };
  }
}

/** JSON.parse with a friendly "line N, column M" location. Empty text parses to `{}`. */
export function parseJson(text: string): JsonParse {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    const found = locateJsonError(text);
    if (found) {
      const upto = text.slice(0, Math.min(found.pos, text.length));
      const line = upto.split('\n').length;
      const column = upto.length - upto.lastIndexOf('\n');
      return { ok: false, error: `${found.message} (line ${line}, column ${column})`, line, column };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStringRecord = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/** Error message, or null when `v` is an http(s) URL (or empty and allowEmpty). */
export function validateUrl(v: string, opts: { allowEmpty?: boolean } = {}): string | null {
  const t = v.trim();
  if (!t) return opts.allowEmpty ? null : 'Enter a URL';
  return isHttpUrl(t) ? null : 'Enter a full URL starting with http:// or https://';
}

// ───────────────────────────── MCP servers ─────────────────────────────

/** Validates the `mcpServers` object. Returns a list of problems (empty = valid). */
export function validateMcpServers(value: unknown): string[] {
  if (!isObject(value)) return ['The top level must be an object: { "server-name": { … } }'];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) errors.push(`"${name}": server names may only use letters, digits, "-", "_" and "."`);
    else if (name.includes('__')) errors.push(`"${name}": avoid "__" in a server name (it separates server and tool in mcp__server__tool)`);
    if (!isObject(raw)) {
      errors.push(`${name}: must be an object`);
      continue;
    }
    const cfg = raw as Partial<McpServerConfig>;
    const type = cfg.type ?? (typeof cfg.url === 'string' ? 'http' : 'stdio');
    if (!['stdio', 'http', 'sse'].includes(type)) errors.push(`${name}: "type" must be "stdio", "http" or "sse"`);
    if (type === 'stdio') {
      if (typeof cfg.command !== 'string' || !cfg.command.trim()) errors.push(`${name}: "command" is required for stdio servers`);
      if (cfg.args !== undefined && !isStringArray(cfg.args)) errors.push(`${name}: "args" must be an array of strings`);
      if (cfg.env !== undefined && !isStringRecord(cfg.env)) errors.push(`${name}: "env" must be an object with string values`);
    } else if (type === 'http' || type === 'sse') {
      if (typeof cfg.url !== 'string' || !isHttpUrl(cfg.url)) errors.push(`${name}: "url" must be an http(s) URL for ${type} servers`);
      if (cfg.headers !== undefined && !isStringRecord(cfg.headers)) errors.push(`${name}: "headers" must be an object with string values`);
    }
    if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') errors.push(`${name}: "enabled" must be true or false`);
  }
  return errors;
}

export const MCP_EXAMPLE = {
  filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Projects'] },
  docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer <token>' }, enabled: false },
} satisfies Record<string, McpServerConfig>;

// ───────────────────────────── Hooks ─────────────────────────────

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'] as const;

export function validateHooks(value: unknown): string[] {
  if (!isObject(value)) return ['The top level must be an object: { "PreToolUse": [ … ] }'];
  const errors: string[] = [];
  for (const [event, list] of Object.entries(value)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      errors.push(`"${event}" is not a hook event (use ${HOOK_EVENTS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${event}: must be an array of hooks`);
      continue;
    }
    list.forEach((h, i) => {
      const at = `${event}[${i}]`;
      if (!isObject(h)) {
        errors.push(`${at}: must be an object`);
        return;
      }
      const hook = h as Partial<HookConfig>;
      if (typeof hook.command !== 'string' || !hook.command.trim()) errors.push(`${at}: "command" is required`);
      if (hook.matcher !== undefined && typeof hook.matcher !== 'string') errors.push(`${at}: "matcher" must be a string (a tool name or pattern)`);
      if (hook.timeoutMs !== undefined && (typeof hook.timeoutMs !== 'number' || !(hook.timeoutMs > 0))) errors.push(`${at}: "timeoutMs" must be a positive number`);
    });
  }
  return errors;
}

export const HOOKS_EXAMPLE: Settings['hooks'] = {
  PreToolUse: [{ matcher: 'Bash', command: 'node scripts/check-command.mjs', timeoutMs: 5000 }],
  Stop: [{ command: 'powershell -NoProfile -Command "[console]::beep(800,200)"' }],
};

// ───────────────────────────── GPU profiles ─────────────────────────────

export interface ProfilesValidation {
  errors: string[];
  profiles?: GpuProfile[];
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validateProfiles(value: unknown): ProfilesValidation {
  if (!Array.isArray(value)) return { errors: ['The top level must be an array of profiles: [ { "id": "light", … } ]'] };
  if (value.length === 0) return { errors: ['Add at least one profile'] };
  const errors: string[] = [];
  const out: GpuProfile[] = [];
  const ids = new Set<string>();
  value.forEach((raw, i) => {
    const at = `profiles[${i}]`;
    if (!isObject(raw)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) errors.push(`${at}.id: use lowercase letters, digits, "-" or "_"`);
    else if (ids.has(id)) errors.push(`${at}.id: "${id}" is used twice`);
    ids.add(id);
    if (typeof p.label !== 'string' || !p.label.trim()) errors.push(`${at}.label: required`);
    if (p.description !== undefined && typeof p.description !== 'string') errors.push(`${at}.description: must be text`);
    if (!isStringArray(p.gpuNames) || p.gpuNames.length === 0 || p.gpuNames.some((n) => !n.trim())) errors.push(`${at}.gpuNames: list at least one Vast GPU name, e.g. ["RTX 5090"]`);
    if (!num(p.numGpus) || !Number.isInteger(p.numGpus) || p.numGpus < 1 || p.numGpus > 8) errors.push(`${at}.numGpus: a whole number from 1 to 8`);
    if (!num(p.minGpuRamGb) || p.minGpuRamGb <= 0) errors.push(`${at}.minGpuRamGb: must be greater than 0`);
    if (!num(p.minCpuRamGb) || p.minCpuRamGb < 0) errors.push(`${at}.minCpuRamGb: must be 0 or more`);
    if (!num(p.minDiskGb) || p.minDiskGb <= 0) errors.push(`${at}.minDiskGb: must be greater than 0`);
    if (!num(p.minInetDownMbps) || p.minInetDownMbps < 0) errors.push(`${at}.minInetDownMbps: must be 0 or more`);
    if (!num(p.minReliability) || p.minReliability < 0 || p.minReliability > 1) errors.push(`${at}.minReliability: a fraction between 0 and 1`);
    if (!num(p.maxPricePerHour) || p.maxPricePerHour <= 0) errors.push(`${at}.maxPricePerHour: must be greater than 0 (it caps what you can be charged per hour)`);
    if (typeof p.datacenterOnly !== 'boolean') errors.push(`${at}.datacenterOnly: true or false`);
    if (typeof p.defaultModelId !== 'string' || !p.defaultModelId.trim()) errors.push(`${at}.defaultModelId: required (a catalog model id)`);
    if (errors.length === 0) {
      out.push({
        id,
        label: (p.label as string).trim(),
        description: typeof p.description === 'string' ? p.description : '',
        gpuNames: (p.gpuNames as string[]).map((n) => n.trim()),
        numGpus: p.numGpus as number,
        minGpuRamGb: p.minGpuRamGb as number,
        minCpuRamGb: p.minCpuRamGb as number,
        minDiskGb: p.minDiskGb as number,
        minInetDownMbps: p.minInetDownMbps as number,
        minReliability: p.minReliability as number,
        maxPricePerHour: p.maxPricePerHour as number,
        datacenterOnly: p.datacenterOnly as boolean,
        defaultModelId: (p.defaultModelId as string).trim(),
      });
    }
  });
  return errors.length ? { errors } : { errors, profiles: out };
}

// ───────────────────────────── Permission rules ─────────────────────────────

/** Rules look like `Tool` or `Tool(argument)`, e.g. Bash(npm test:*), WebFetch(domain:x.com), Read(src/**). */
export function validateRule(rule: string): string | null {
  const r = rule.trim();
  if (!r) return 'Enter a rule';
  const m = /^([A-Za-z_][\w.-]*)(?:\((.*)\))?$/.exec(r);
  if (!m) return 'Use Tool or Tool(argument), e.g. Bash(npm test:*)';
  if (m[2] !== undefined && m[2].trim() === '') return 'The argument in parentheses is empty';
  return null;
}

// ───────────────────────────── Small parsers ─────────────────────────────

export type NumberCheck = { ok: true; value: number } | { ok: false; error: string };

export function validateNumber(raw: string, opts: { min?: number; max?: number; integer?: boolean }): NumberCheck {
  const t = raw.trim();
  if (t === '') return { ok: false, error: 'Enter a number' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number' };
  if (opts.integer && !Number.isInteger(n)) return { ok: false, error: 'Use a whole number' };
  if (opts.min !== undefined && n < opts.min) return { ok: false, error: `Must be at least ${opts.min}` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, error: `Must be at most ${opts.max}` };
  return { ok: true, value: n };
}

/** "my-label" id from a label, unique among `existing`. */
export function slugify(label: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'endpoint';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Split a command-line-ish string into arguments, honouring "double" and 'single' quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** Model ids separated by commas or newlines. */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}
