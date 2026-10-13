// Fallback parser for tool calls written as text (docs/research/llama-server.md §8.5):
//   * Hermes JSON   <tool_call>{"name":…,"arguments":…}</tool_call>
//   * Qwen XML      <tool_call><function=NAME><parameter=P>\nv\n</parameter></function></tool_call>  (also without the wrapper)
//   * GLM 4.5+      <tool_call>NAME\n<arg_key>k</arg_key>\n<arg_value>v</arg_value>…</tool_call>
// Values are coerced by the tool's JSON schema. Arguments are always returned as JSON.stringify(obj).

import { nanoid } from 'nanoid';
import type { ChatToolSpec } from '../contracts';

export interface ParsedTextCall { id: string; name: string; arguments: string }

export interface TextToolParseResult {
  calls: ParsedTextCall[];
  /** Text outside the recognised tool-call blocks (trimmed). */
  rest: string;
}

type Schema = Record<string, unknown>;

function propSchema(tools: ChatToolSpec[] | undefined, toolName: string, param: string): Schema | undefined {
  const tool = tools?.find((t) => t.function.name === toolName);
  const props = (tool?.function.parameters as { properties?: Record<string, Schema> } | undefined)?.properties;
  return props?.[param];
}

function looksLikeJson(v: string): boolean {
  const t = v.trim();
  return /^[[{"]/.test(t) || /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t) || t === 'true' || t === 'false' || t === 'null';
}

/** Coerce a raw parameter string using the JSON schema type of that parameter. */
export function coerceValue(raw: string, schema: Schema | undefined): unknown {
  const type = schema?.type;
  const types: string[] = Array.isArray(type) ? (type as string[]) : typeof type === 'string' ? [type] : [];
  if (types.length === 1) {
    switch (types[0]) {
      case 'string': return raw;
      case 'integer':
      case 'number': {
        const n = Number(raw.trim());
        return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
      }
      case 'boolean': {
        const t = raw.trim().toLowerCase();
        return t === 'true' ? true : t === 'false' ? false : raw;
      }
      case 'array':
      case 'object':
        try { return JSON.parse(raw); } catch { return raw; }
      case 'null':
        return raw.trim() === 'null' ? null : raw;
    }
  }
  if (types.length > 1 && types.includes('string') && !looksLikeJson(raw)) return raw;
  // untyped / union: JSON.parse only if it looks like JSON
  if (looksLikeJson(raw)) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw;
}

function newId(): string {
  return `call_${nanoid(24)}`;
}

function stripOneNewline(v: string): string {
  let s = v;
  if (s.startsWith('\r\n')) s = s.slice(2);
  else if (s.startsWith('\n')) s = s.slice(1);
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}

function parseHermes(body: string): { name: string; args: Record<string, unknown> } | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch {
    // tolerate trailing junk after the last brace
    const last = body.lastIndexOf('}');
    if (last < 0) return null;
    try { j = JSON.parse(body.slice(0, last + 1)); } catch { return null; }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const fn = (o.function && typeof o.function === 'object' ? o.function : o) as Record<string, unknown>;
  const name = typeof fn.name === 'string' ? fn.name : null;
  if (!name) return null;
  let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? {};
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; } catch { return null; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, args: args as Record<string, unknown> };
}

const FUNCTION_RE = /<function=([^>\n]+)>([\s\S]*?)(?:<\/function>|$)/g;
const PARAM_RE = /<parameter=([^>\n]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;

function parseQwenXml(body: string, tools?: ChatToolSpec[]): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  FUNCTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNCTION_RE.exec(body))) {
    const name = m[1]!.trim();
    if (!name) continue;
    const inner = m[2] ?? '';
    const args: Record<string, unknown> = {};
    PARAM_RE.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = PARAM_RE.exec(inner))) {
      const key = p[1]!.trim();
      if (!key) continue;
      args[key] = coerceValue(stripOneNewline(p[2] ?? ''), propSchema(tools, name, key));
    }
    out.push({ name, args });
    if (m[0].length === 0) break;
  }
  return out;
}

const ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|$)/g;

function parseGlm(body: string, tools?: ChatToolSpec[]): { name: string; args: Record<string, unknown> } | null {
  const firstTag = body.indexOf('<');
  const head = (firstTag >= 0 ? body.slice(0, firstTag) : body).trim();
  const name = head.split('\n')[0]!.trim();
  if (!name || /\s/.test(name) || name.startsWith('{')) return null;
  const hasArgs = body.includes('<arg_key>');
  // A bare name without args is only accepted when it is a known tool (avoids false positives on prose).
  if (!hasArgs && !(tools?.some((t) => t.function.name === name))) return null;
  const args: Record<string, unknown> = {};
  ARG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARG_RE.exec(body))) {
    const key = m[1]!.trim();
    if (!key) continue;
    args[key] = coerceValue(stripOneNewline(m[2] ?? ''), propSchema(tools, name, key));
  }
  return { name, args };
}

/** Parse one block body (the text between <tool_call> and </tool_call>, or a bare <function=…> block). */
export function parseToolCallBody(raw: string, tools?: ChatToolSpec[]): { name: string; args: Record<string, unknown> }[] {
  const b = raw.trim();
  if (!b) return [];
  if (b.startsWith('{')) {
    const h = parseHermes(b);
    return h ? [h] : [];
  }
  if (b.includes('<function=')) return parseQwenXml(b, tools);
  const g = parseGlm(b, tools);
  return g ? [g] : [];
}

const BLOCK_RE = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
const BARE_OPEN_RE = /^\s*<([A-Za-z_][\w.-]*)>/;

/**
 * Qwen sometimes drops the `<tool_call><function=` wrapper and writes the tool's own name as the tag:
 *   <TodoWrite>\n<parameter=todos>\n[...]\n</parameter>\n</function>\n</tool_call>
 * llama.cpp's parser does not recognise that, so it arrives as plain text. Accepted only when the text starts with the
 * name of a known tool and carries at least one <parameter=…>.
 */
function parseBareToolTag(text: string, tools?: ChatToolSpec[]): { call: { name: string; args: Record<string, unknown> }; rest: string } | null {
  if (!tools?.length || !text.includes('<parameter=')) return null;
  const open = BARE_OPEN_RE.exec(text);
  const name = open?.[1];
  if (!open || !name || !tools.some((t) => t.function.name === name)) return null;
  const body = text.slice(open[0].length);
  const parsed = parseQwenXml(`<function=${name}>${body}`, tools)[0];
  if (!parsed || !Object.keys(parsed.args).length) return null;
  const lastEnd = body.lastIndexOf('</function>');
  const lastParam = body.lastIndexOf('</parameter>');
  const tail = lastEnd >= 0 ? body.slice(lastEnd + '</function>'.length) : lastParam >= 0 ? body.slice(lastParam + '</parameter>'.length) : '';
  return { call: parsed, rest: tail.replace(/^\s*<\/tool_call>/, '').trim() };
}

/**
 * Extract all text-form tool calls from content. Accepts a missing final </tool_call> and bare
 * <function=…>…</function> blocks without a wrapper. Returns null-equivalent (no calls) when nothing parses.
 */
export function parseTextToolCalls(text: string, tools?: ChatToolSpec[], makeId: () => string = newId): TextToolParseResult {
  const calls: ParsedTextCall[] = [];
  let rest = '';
  if (text.includes('<tool_call>')) {
    let last = 0;
    BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BLOCK_RE.exec(text))) {
      const parsed = parseToolCallBody(m[1] ?? '', tools);
      if (parsed.length) {
        rest += text.slice(last, m.index);
        for (const p of parsed) calls.push({ id: makeId(), name: p.name, arguments: JSON.stringify(p.args) });
        last = m.index + m[0].length;
      }
      if (m[0].length === 0) break;
    }
    rest += text.slice(last);
  } else if (text.includes('<function=')) {
    const start = text.indexOf('<function=');
    const parsed = parseQwenXml(text.slice(start), tools);
    if (parsed.length) {
      rest = text.slice(0, start);
      const lastEnd = text.lastIndexOf('</function>');
      if (lastEnd >= 0) rest += text.slice(lastEnd + '</function>'.length);
      for (const p of parsed) calls.push({ id: makeId(), name: p.name, arguments: JSON.stringify(p.args) });
    } else rest = text;
  } else {
    const bare = parseBareToolTag(text, tools);
    if (bare) {
      calls.push({ id: makeId(), name: bare.call.name, arguments: JSON.stringify(bare.call.args) });
      rest = bare.rest;
    } else rest = text;
  }
  return { calls, rest: calls.length ? rest.trim() : text };
}
