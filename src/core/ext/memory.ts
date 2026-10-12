// Memory files (OBSIDIAN.md / CLAUDE.md / AGENTS.md): user-level files first, then the project hierarchy from the
// filesystem root down to the cwd (most specific last). `@path` imports are followed one level deep.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { FileCache, pathKey } from './util';

export const MEMORY_CAP_CHARS = 12_000;
const PER_FILE_CAP_CHARS = 8_000;
const IMPORT_MAX_CHARS = 20_000;

export interface MemoryDeps {
  home: string;
  importClaudeConfig: () => boolean;
}

interface Candidate {
  file: string;
  label: string;
}

interface Entry {
  file: string;
  text: string;
}

const PROJECT_FILES = ['OBSIDIAN.md', 'CLAUDE.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md')];

/** Directories from the filesystem root down to (and including) `cwd`. */
export function ancestorsRootFirst(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = path.resolve(cwd);
  for (;;) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs.reverse();
}

/** `@path` references outside fenced/inline code. Returns the raw reference strings. */
export function findImports(content: string): string[] {
  const refs: string[] = [];
  let fenced = false;
  for (const rawLine of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = rawLine.replace(/`[^`]*`/g, '');
    const re = /(?:^|[\s(])@([^\s)<>"']+)/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const ref = m[1]!.replace(/[.,;:!?]+$/, '');
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

export function createMemoryReader(deps: MemoryDeps) {
  const cache = new FileCache<string>();
  const read = (file: string) => cache.get(file, (raw) => raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n'));

  function candidates(cwd: string): Candidate[] {
    const out: Candidate[] = [{ file: path.join(deps.home, '.obsidian-code', 'OBSIDIAN.md'), label: "user's global instructions" }];
    const claudeUser = path.join(deps.home, '.claude', 'CLAUDE.md');
    const imp = deps.importClaudeConfig();
    if (imp) out.push({ file: claudeUser, label: "user's global instructions (~/.claude)" });
    const claudeUserKey = pathKey(claudeUser);
    for (const dir of ancestorsRootFirst(cwd)) {
      for (const name of PROJECT_FILES) {
        const file = path.join(dir, name);
        // ~/.claude/CLAUDE.md is a user-level file: only loaded when importing Claude config (and then already listed above).
        if (pathKey(file) === claudeUserKey) continue;
        out.push({ file, label: dir === path.resolve(cwd) ? 'project instructions' : 'instructions inherited from a parent directory' });
      }
    }
    return out;
  }

  async function resolveImport(ref: string, fromFile: string): Promise<string | null> {
    let target: string;
    if (ref === '~' || ref.startsWith('~/') || ref.startsWith('~\\')) target = path.join(deps.home, ref.slice(1));
    else if (path.isAbsolute(ref)) target = ref;
    else target = path.resolve(path.dirname(fromFile), ref);
    return (await read(target)) !== null ? target : null;
  }

  async function memoryText(cwd: string): Promise<string> {
    const seenFiles = new Set<string>();
    const seenContent = new Set<string>();
    const entries: Entry[] = [];

    const add = (file: string, label: string, content: string): boolean => {
      const body = content.trim();
      if (!body) return false;
      const hash = createHash('sha1').update(body).digest('hex');
      if (seenContent.has(hash)) return false;
      seenContent.add(hash);
      let text = body;
      if (text.length > PER_FILE_CAP_CHARS) text = text.slice(0, PER_FILE_CAP_CHARS).trimEnd() + '\n…[file truncated]';
      entries.push({ file, text: `Contents of ${file} (${label}):\n\n${text}` });
      return true;
    };

    for (const cand of candidates(cwd)) {
      const key = pathKey(cand.file);
      if (seenFiles.has(key)) continue;
      const content = await read(cand.file);
      if (content === null) continue;
      seenFiles.add(key);
      if (!add(cand.file, cand.label, content)) continue;

      // One level of @imports (imports of imports are intentionally not followed).
      const seenRefs = new Set<string>();
      for (const ref of findImports(content)) {
        if (seenRefs.has(ref)) continue;
        seenRefs.add(ref);
        const target = await resolveImport(ref, cand.file);
        if (!target) continue;
        const tkey = pathKey(target);
        if (seenFiles.has(tkey)) continue;
        const imported = await read(target);
        if (imported === null) continue;
        seenFiles.add(tkey);
        add(target, `imported from ${cand.file} via @${ref}`, imported.slice(0, IMPORT_MAX_CHARS));
      }
    }

    if (!entries.length) return '';
    return fit(entries);
  }

  return { memoryText, candidates };
}

/** Keep the most specific (last) entries within the cap; shorten or drop earlier ones and say so. */
function fit(entries: Entry[]): string {
  const total = entries.reduce((n, e) => n + e.text.length + 2, 0);
  if (total <= MEMORY_CAP_CHARS) return entries.map((e) => e.text).join('\n\n');

  let budget = MEMORY_CAP_CHARS;
  const kept: string[] = [];
  let shortened = 0;
  let omitted = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = entries[i]!.text;
    if (t.length + 2 <= budget) {
      kept.push(t);
      budget -= t.length + 2;
    } else if (budget >= 500) {
      kept.push(t.slice(0, budget - 40).trimEnd() + '\n…[truncated]');
      shortened++;
      budget = 0;
    } else {
      omitted++;
    }
  }
  kept.reverse();
  const note = `[Memory truncated to ~${Math.round(MEMORY_CAP_CHARS / 1000)}k characters: ${shortened} file(s) shortened, ${omitted} omitted. Use /memory to view the full files.]`;
  return kept.join('\n\n') + '\n\n' + note;
}
