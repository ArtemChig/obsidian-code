// Diff statistics and compact diff displays for the Changes panel / tool cards.

import { diffLines } from 'diff';
import type { ToolDisplay } from '../../../shared/types';

export function countChanges(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  if (before === '') return { additions: lineCount(after), deletions: 0 };
  if (after === '') return { additions: 0, deletions: lineCount(before) };
  try {
    const parts = diffLines(before, after, { timeout: 2000 } as never) as unknown as { added?: boolean; removed?: boolean; count?: number; value: string }[] | undefined;
    if (Array.isArray(parts)) {
      let additions = 0;
      let deletions = 0;
      for (const p of parts) {
        const n = p.count ?? lineCount(p.value);
        if (p.added) additions += n;
        else if (p.removed) deletions += n;
      }
      return { additions, deletions };
    }
  } catch { /* fall through to estimate */ }
  const a = lineCount(after);
  const b = lineCount(before);
  return { additions: Math.max(0, a - b), deletions: Math.max(0, b - a) };
}

export function lineCount(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const FULL_DISPLAY_MAX = 40_000; // chars per side; larger files show only the changed region
const CONTEXT_LINES = 5;

/** Diff display payload. Whole-file for small files, otherwise the changed region ± a few lines. */
export function diffDisplay(path: string, before: string, after: string, isNewFile = false): ToolDisplay {
  if (isNewFile) {
    const shown = after.length > FULL_DISPLAY_MAX * 2 ? `${after.slice(0, FULL_DISPLAY_MAX * 2)}\n… (truncated for display)` : after;
    return { kind: 'diff', path, before: '', after: shown, isNewFile: true };
  }
  if (before.length <= FULL_DISPLAY_MAX && after.length <= FULL_DISPLAY_MAX) {
    return { kind: 'diff', path, before, after };
  }
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const from = Math.max(0, start - CONTEXT_LINES);
  const sliceA = a.slice(from, Math.min(a.length, endA + 1 + CONTEXT_LINES)).join('\n');
  const sliceB = b.slice(from, Math.min(b.length, endB + 1 + CONTEXT_LINES)).join('\n');
  const note = from > 0 ? `… (lines 1-${from} not shown)\n` : '';
  return { kind: 'diff', path, before: note + sliceA, after: note + sliceB };
}
