// YAML frontmatter parsing for SKILL.md / agent / command files (gray-matter, with the JS engine disabled and a
// lenient fallback for the very common "description: Use when: something" unquoted-colon mistake).

import matter from 'gray-matter';

export interface ParsedMarkdown {
  data: Record<string, unknown>;
  body: string;
}

const refuse = {
  parse(): never {
    throw new Error('executable frontmatter is not allowed');
  },
};

const MATTER_OPTIONS = {
  // Never evaluate ---js / ---javascript frontmatter from files on disk.
  engines: { js: refuse, javascript: refuse },
} as unknown as Parameters<typeof matter>[1];

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function lenient(block: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let lastKey: string | null = null;
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) {
      let v = m[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
      data[m[1]!] = v;
      lastKey = m[1]!;
    } else if (lastKey && /^\s+\S/.test(line) && typeof data[lastKey] === 'string') {
      data[lastKey] = `${data[lastKey] as string} ${line.trim()}`.trim();
    }
  }
  return data;
}

export function parseMarkdown(rawIn: string): ParsedMarkdown {
  const raw = rawIn.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  try {
    const r = matter(raw, MATTER_OPTIONS);
    const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : {};
    return { data, body: r.content };
  } catch {
    const m = FM_RE.exec(raw);
    if (!m) return { data: {}, body: raw };
    return { data: lenient(m[1]!), body: raw.slice(m[0].length) };
  }
}

/** Frontmatter value → trimmed string (arrays are joined with ", "), or undefined. */
export function fmString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const s = v.map((x) => String(x).trim()).filter(Boolean).join(', ');
    return s || undefined;
  }
  if (typeof v === 'object') return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/** Frontmatter list value ("a, b" string or YAML list) → string[] (undefined when empty/absent). */
export function fmList(v: unknown): string[] | undefined {
  if (v === null || v === undefined) return undefined;
  const parts = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(',');
  const out = parts.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** First meaningful line of a markdown body (heading marks stripped) — used as a fallback description. */
export function firstLine(body: string, max = 160): string {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t && !t.startsWith('<!--')) return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
  }
  return '';
}
