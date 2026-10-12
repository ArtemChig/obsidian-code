// Line diff model for the diff viewer (tool cards, permission previews, Changes panel). Owner: ui-chat.
// Pure: unit-tested in tests/unit/ui-chat/diff.test.ts.
import { diffLines } from 'diff';

export type DiffRowType = 'add' | 'del' | 'ctx';

export interface DiffRow {
  type: DiffRowType;
  /** 1-based line number in `before` (null for additions). */
  oldNo: number | null;
  /** 1-based line number in `after` (null for deletions). */
  newNo: number | null;
  text: string;
}

export interface DiffModel {
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

/** A visible row, or a run of unchanged rows collapsed into an expandable gap. */
export type DiffItem = { kind: 'row'; row: DiffRow } | { kind: 'gap'; id: string; rows: DiffRow[] };

const EXCERPT_NOTE = /^… \(lines 1-(\d+) not shown\)$/;

/** The core sends excerpts of big files prefixed with "… (lines 1-N not shown)": strip it and return the line offset. */
export function parseExcerpt(text: string): { text: string; offset: number } {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const m = EXCERPT_NOTE.exec(first);
  if (!m) return { text, offset: 0 };
  return { text: nl < 0 ? '' : text.slice(nl + 1), offset: Number(m[1]) || 0 };
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Fallback for huge inputs / diff timeouts: common prefix + suffix, everything in between replaced. */
function trimDiff(a: string[], b: string[]): { value: string[]; added?: boolean; removed?: boolean }[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const parts: { value: string[]; added?: boolean; removed?: boolean }[] = [];
  if (start > 0) parts.push({ value: a.slice(0, start) });
  if (endA > start) parts.push({ value: a.slice(start, endA), removed: true });
  if (endB > start) parts.push({ value: b.slice(start, endB), added: true });
  if (endA < a.length) parts.push({ value: a.slice(endA) });
  return parts;
}

/** Compute diff rows with line numbers. `before === ''` renders the whole file as additions. */
export function computeDiff(beforeRaw: string, afterRaw: string): DiffModel {
  const b = parseExcerpt(beforeRaw);
  const a = parseExcerpt(afterRaw);
  const oldLines = splitLines(b.text);
  const newLines = splitLines(a.text);
  let parts: { value: string[]; added?: boolean; removed?: boolean }[];
  if (oldLines.length + newLines.length > 20_000) {
    parts = trimDiff(oldLines, newLines);
  } else {
    let changes: { value: string; added?: boolean; removed?: boolean }[] | undefined;
    try {
      changes = diffLines(oldLines.join('\n') + (oldLines.length ? '\n' : ''), newLines.join('\n') + (newLines.length ? '\n' : ''), {
        timeout: 1500,
      } as never) as unknown as { value: string; added?: boolean; removed?: boolean }[] | undefined;
    } catch {
      changes = undefined;
    }
    parts = changes ? changes.map((c) => ({ value: splitLines(c.value), added: c.added, removed: c.removed })) : trimDiff(oldLines, newLines);
  }
  const rows: DiffRow[] = [];
  let oldNo = b.offset;
  let newNo = a.offset;
  let additions = 0;
  let deletions = 0;
  for (const p of parts) {
    for (const text of p.value) {
      if (p.added) {
        newNo++;
        additions++;
        rows.push({ type: 'add', oldNo: null, newNo, text });
      } else if (p.removed) {
        oldNo++;
        deletions++;
        rows.push({ type: 'del', oldNo, newNo: null, text });
      } else {
        oldNo++;
        newNo++;
        rows.push({ type: 'ctx', oldNo, newNo, text });
      }
    }
  }
  return { rows, additions, deletions };
}

/**
 * Collapse runs of unchanged rows that are further than `context` lines from a change.
 * Runs shorter than `minGap` stay visible (a "1 hidden line" button is worse than the line).
 */
export function collapseDiff(rows: DiffRow[], context = 3, minGap = 4): DiffItem[] {
  const items: DiffItem[] = [];
  const changed = rows.map((r) => r.type !== 'ctx');
  if (!changed.some(Boolean)) {
    // No changes at all: show the first lines, collapse the rest.
    if (rows.length <= context * 2 + minGap) return rows.map((row) => ({ kind: 'row', row }));
    const head = rows.slice(0, context * 2).map((row): DiffItem => ({ kind: 'row', row }));
    return [...head, { kind: 'gap', id: `g${context * 2}`, rows: rows.slice(context * 2) }];
  }
  // Distance to the nearest change for each row.
  const near = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (!changed[i]) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) near[j] = true;
  }
  let i = 0;
  while (i < rows.length) {
    if (near[i]) {
      items.push({ kind: 'row', row: rows[i] });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !near[j]) j++;
    const run = rows.slice(i, j);
    if (run.length < minGap) for (const row of run) items.push({ kind: 'row', row });
    else items.push({ kind: 'gap', id: `g${i}`, rows: run });
    i = j;
  }
  return items;
}

/** Old/new/sign columns as a unified-diff text (for copy). */
export function toUnifiedText(rows: DiffRow[]): string {
  return rows.map((r) => `${r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}${r.text}`).join('\n');
}

/** Before/after for a tool input that has not run yet (permission preview). */
export function previewFromInput(toolName: string, input: Record<string, unknown>): { path: string; before: string; after: string; isNew?: boolean } | null {
  const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
  if (toolName === 'Write' && typeof input.content === 'string') return { path, before: '', after: input.content, isNew: true };
  if (toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { path, before: input.old_string, after: input.new_string };
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits as { old_string?: unknown; new_string?: unknown }[];
    const before = edits.map((e) => String(e.old_string ?? '')).join('\n…\n');
    const after = edits.map((e) => String(e.new_string ?? '')).join('\n…\n');
    return { path, before, after };
  }
  if (toolName === 'NotebookEdit' && typeof input.new_source === 'string') return { path, before: '', after: input.new_source, isNew: false };
  return null;
}
