// Shared steps for Write / Edit / MultiEdit / NotebookEdit: validate the target, checkpoint, write, bookkeeping.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '../../contracts';
import type { ToolResultPayload } from '../../../shared/types';
import { countChanges, diffDisplay } from './diff';
import { checkFresh, markRead } from './fileState';
import { BinaryFileError, lossyForEncoding, readTextFile, writeTextFile, type TextFile } from './textfile';
import { toLf } from './text';
import { fail } from '../types';

export type Prepared = { ok: true; file: TextFile } | { ok: false; result: ToolResultPayload };

/** Load an existing file for modification, enforcing read-before-write and freshness. */
export async function prepareExisting(ctx: ToolContext, abs: string, shown: string, toolName: string): Promise<Prepared> {
  const st = await fs.stat(abs);
  if (st.isDirectory()) return { ok: false, result: fail(`${shown} is a directory, not a file.`) };
  if (abs.toLowerCase().endsWith('.ipynb') && (toolName === 'Edit' || toolName === 'MultiEdit')) {
    return { ok: false, result: fail(`${shown} is a Jupyter notebook. Use the NotebookEdit tool to edit it.`) };
  }
  let file: TextFile;
  try {
    file = await readTextFile(abs);
  } catch (e) {
    if (e instanceof BinaryFileError) return { ok: false, result: fail(`Cannot modify ${shown}: the file appears to be binary.`) };
    throw e;
  }
  const fresh = await checkFresh(ctx, abs, shown, file.mtimeMs, file.hash);
  if (!fresh.ok) return { ok: false, result: fail(fresh.error) };
  return { ok: true, file };
}

export interface PersistArgs {
  ctx: ToolContext;
  abs: string;
  /** Raw new text (final line endings applied). */
  text: string;
  /** Previous raw text ('' for new files). */
  previous: string;
  isNew: boolean;
  encoding: 'utf8' | 'utf16le' | 'latin1';
  bom: boolean;
  /** Override the +/- counts recorded for the Changes panel (e.g. notebooks count cell lines, not JSON). */
  counts?: { additions: number; deletions: number };
}

/** Checkpoint → write → mark read → record change. Returns the diff display. */
export async function persistFile(a: PersistArgs): Promise<{ display: ReturnType<typeof diffDisplay>; additions: number; deletions: number } | { error: ToolResultPayload }> {
  if (lossyForEncoding(a.text, a.encoding)) {
    return { error: fail('This file is not UTF-8 (it is a single-byte legacy encoding) and the new text contains characters that cannot be stored in it. Remove those characters or rewrite the file with Write after reading it.') };
  }
  await a.ctx.checkpointFile(a.abs);
  if (a.isNew) await fs.mkdir(path.dirname(a.abs), { recursive: true });
  const w = await writeTextFile(a.abs, a.text, { encoding: a.encoding, bom: a.bom });
  markRead(a.ctx, a.abs, w.mtimeMs, w.hash);
  const before = toLf(a.previous);
  const after = toLf(a.text);
  const { additions, deletions } = a.counts ?? countChanges(before, after);
  a.ctx.recordChange({ path: a.abs, additions, deletions, isNew: a.isNew });
  return { display: diffDisplay(a.abs, before, after, a.isNew), additions, deletions };
}

/** A small cat -n excerpt around `line` (1-based) for confirming an edit to the model. */
export function snippetAround(text: string, line: number, spanLines: number, context = 3, maxLines = 24): string {
  const lines = toLf(text).split('\n');
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + Math.max(1, spanLines) - 1 + context, from + maxLines - 1);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const l = lines[n - 1];
    out.push(`${String(n).padStart(6)}\t${l.length > 300 ? `${l.slice(0, 300)}…` : l}`);
  }
  return out.join('\n');
}
