// Pure-JS fallback for Grep when ripgrep is unavailable. Produces the same raw line format as runRipgrep():
// content lines are "relpath\0N:text" (match) / "relpath\0N-text" (context), count lines "relpath\0N", file lines "relpath".

import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import type { GrepParams, GrepRaw } from './ripgrep';
import { looksBinary } from './textfile';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const TYPE_EXTENSIONS: Record<string, string[]> = {
  js: ['js', 'mjs', 'cjs', 'jsx'],
  ts: ['ts', 'tsx', 'mts', 'cts'],
  py: ['py', 'pyi'],
  python: ['py', 'pyi'],
  rust: ['rs'],
  go: ['go'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
  cs: ['cs'],
  csharp: ['cs'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  sh: ['sh', 'bash', 'zsh'],
  ps: ['ps1', 'psm1'],
  md: ['md', 'markdown'],
  markdown: ['md', 'markdown'],
  json: ['json', 'jsonc'],
  yaml: ['yml', 'yaml'],
  toml: ['toml'],
  xml: ['xml'],
  html: ['html', 'htm'],
  css: ['css', 'scss', 'sass', 'less'],
  sql: ['sql'],
  txt: ['txt'],
  lua: ['lua'],
  dart: ['dart'],
  scala: ['scala'],
  vue: ['vue'],
  svelte: ['svelte'],
};

export function fallbackKnowsType(type: string): boolean {
  return type in TYPE_EXTENSIONS;
}

function gitignoreGlobs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/');
    let pat = line.replace(/^\//, '').replace(/\/$/, '');
    if (!pat) continue;
    if (!anchored && !pat.includes('/')) pat = `**/${pat}`;
    out.push(pat, `${pat}/**`);
  }
  return out;
}

function compile(p: GrepParams): RegExp | string {
  let pattern = p.pattern;
  if (!p.multiline && (pattern.includes('\\n') || pattern.includes('\n'))) {
    return 'the literal "\\n" is not allowed in a regex. Consider enabling multiline mode (multiline: true) so patterns can match across lines.';
  }
  let ignoreCase = p.ignoreCase;
  const inline = /^\(\?([a-z]+)\)/.exec(pattern);
  if (inline) {
    if (inline[1].includes('i')) ignoreCase = true;
    pattern = pattern.slice(inline[0].length);
  }
  try {
    return new RegExp(pattern, `${ignoreCase ? 'i' : ''}${p.multiline ? 'gs' : ''}m`);
  } catch (e) {
    return `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runGrepFallback(p: GrepParams): Promise<GrepRaw> {
  const re = compile(p);
  const root = p.targetIsFile ? path.dirname(p.target) : p.target;
  if (typeof re === 'string') return { lines: [], root, truncated: false, error: re };
  if (p.type && !(p.type in TYPE_EXTENSIONS)) {
    return { lines: [], root, truncated: false, error: `unrecognized file type: ${p.type}` };
  }

  // 1. enumerate candidate files
  let rels: string[];
  if (p.targetIsFile) {
    rels = [path.basename(p.target)];
  } else {
    const ignore = ['**/.git/**'];
    if (p.skipNodeModules) ignore.push('**/node_modules/**');
    try {
      ignore.push(...gitignoreGlobs(await fs.readFile(path.join(root, '.gitignore'), 'utf8')));
    } catch { /* no .gitignore */ }
    rels = await fg('**/*', { cwd: root, dot: true, onlyFiles: true, ignore, followSymbolicLinks: false, suppressErrors: true, caseSensitiveMatch: process.platform !== 'win32' });
  }
  if (p.type) {
    const exts = new Set(TYPE_EXTENSIONS[p.type]);
    rels = rels.filter((r) => exts.has(path.extname(r).slice(1).toLowerCase()));
  }
  if (p.globs.length) {
    const pos = p.globs.filter((g) => !g.startsWith('!'));
    const neg = p.globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    const opts = { dot: true, nocase: process.platform === 'win32' };
    // gitignore-style: a glob without a slash matches at any depth; otherwise it is anchored at the search root
    const expand = (gs: string[]) =>
      gs.flatMap((g) => {
        const t = g.replace(/^\.\//, '').replace(/^\//, '');
        return t.includes('/') ? [t, `${t}/**`] : [`**/${t}`, `**/${t}/**`];
      });
    const isPos = pos.length ? picomatch(expand(pos), opts) : () => true;
    const isNeg = neg.length ? picomatch(expand(neg), opts) : () => false;
    rels = rels.filter((r) => isPos(r) && !isNeg(r));
  }
  rels.sort();

  // 2. scan
  const lines: string[] = [];
  let truncated = false;
  const full = () => p.limit > 0 && lines.length >= p.limit;

  for (const rel of rels) {
    if (p.signal?.aborted || full()) break;
    const abs = path.join(root, rel);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const fileLines = text.split(/\r?\n/);
    if (fileLines.length && fileLines[fileLines.length - 1] === '' && /\n$/.test(text)) fileLines.pop();

    // matching line numbers (1-based)
    const hits = new Set<number>();
    if (p.multiline) {
      const starts: number[] = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      const lineOf = (idx: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= idx) lo = mid;
          else hi = mid - 1;
        }
        return lo + 1;
      };
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const a = lineOf(m.index);
        const b = lineOf(Math.max(m.index, m.index + m[0].length - (m[0].endsWith('\n') ? 1 : 0)));
        for (let n = a; n <= b; n++) hits.add(n);
        if (m[0].length === 0) re.lastIndex++;
      }
    } else {
      for (let i = 0; i < fileLines.length; i++) if (re.test(fileLines[i])) hits.add(i + 1);
    }
    if (hits.size === 0) continue;

    if (p.mode === 'files_with_matches') {
      lines.push(rel);
      continue;
    }
    if (p.mode === 'count') {
      lines.push(`${rel}\0${hits.size}`);
      continue;
    }
    // content with context
    const show = new Map<number, boolean>(); // line → isMatch
    for (const n of [...hits].sort((a, b) => a - b)) {
      for (let k = Math.max(1, n - p.before); k <= Math.min(fileLines.length, n + p.after); k++) {
        if (!show.has(k) || hits.has(k)) show.set(k, hits.has(k));
      }
    }
    let prev = 0;
    for (const n of [...show.keys()].sort((a, b) => a - b)) {
      if (prev && n > prev + 1 && (p.before > 0 || p.after > 0)) lines.push('--');
      const isMatch = show.get(n)!;
      const sep = isMatch ? ':' : '-';
      const t = fileLines[n - 1];
      const clipped = t.length > 500 ? `${t.slice(0, 500)} [... omitted end of long line]` : t;
      lines.push(p.lineNumbers ? `${rel}\0${n}${sep}${clipped}` : `${rel}\0${clipped}`);
      prev = n;
      if (full()) break;
    }
  }
  if (full()) {
    truncated = true;
    lines.length = p.limit;
  }
  return { lines, root, truncated };
}
