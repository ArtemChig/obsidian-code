// Exact-match string replacement with line-ending preservation, shared by Edit and MultiEdit.

import { allIndexes, countOccurrences, lineAt, oneLine, toCrlf, toLf } from './text';

export interface EditSpec { old_string: string; new_string: string; replace_all?: boolean }

export type ApplyResult =
  | { ok: true; text: string; replacements: number; /** 1-based line of the first replacement in the new text */ line: number; /** lines in the inserted text */ newLines: number; note?: string }
  | { ok: false; error: string };

const LINE_PREFIX = /^\s*\d+\t/;

/** Undo accidental "cat -n" prefixes copied from Read output. Returns null when the text is not prefixed. */
function stripLineNumbers(s: string): string | null {
  const lines = s.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => LINE_PREFIX.test(l))) return null;
  return lines.map((l) => l.replace(LINE_PREFIX, '')).join('\n');
}

function matchVariant(raw: string, old: string, dominant: 'crlf' | 'lf'): { needle: string; eol: 'crlf' | 'lf'; count: number } | null {
  const hasCrlf = raw.includes('\r\n');
  const variants: { needle: string; eol: 'crlf' | 'lf' }[] = [];
  if (hasCrlf && old.includes('\n')) {
    const crlf = { needle: toCrlf(old), eol: 'crlf' as const };
    const lf = { needle: old, eol: 'lf' as const };
    variants.push(...(dominant === 'crlf' ? [crlf, lf] : [lf, crlf]));
  } else {
    variants.push({ needle: old, eol: dominant });
  }
  for (const v of variants) {
    const count = countOccurrences(raw, v.needle);
    if (count > 0) return { ...v, count };
  }
  return null;
}

/**
 * Apply one edit to the raw file text (original line endings). old/new strings are interpreted with LF newlines;
 * CRLF files are matched and written back with CRLF.
 */
export function applyEdit(raw: string, edit: EditSpec, dominantEol: 'crlf' | 'lf'): ApplyResult {
  let old = toLf(edit.old_string);
  let neu = toLf(edit.new_string);
  if (old === '') return { ok: false, error: 'old_string must not be empty (use Write to create or replace a whole file).' };
  if (old === neu) return { ok: false, error: 'No changes to make: old_string and new_string are exactly the same.' };

  let note: string | undefined;
  let m = matchVariant(raw, old, dominantEol);
  if (!m) {
    const strippedOld = stripLineNumbers(old);
    if (strippedOld !== null) {
      const alt = matchVariant(raw, strippedOld, dominantEol);
      if (alt) {
        old = strippedOld;
        neu = stripLineNumbers(neu) ?? neu;
        m = alt;
        note = 'Note: removed line-number prefixes from old_string/new_string; do not include them.';
      }
    }
  }
  if (!m) {
    const first = old.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    let hint = '';
    if (first.length >= 4) {
      const idx = raw.indexOf(first);
      if (idx !== -1) hint = `\nHint: the text "${oneLine(first, 60)}" does appear on line ${lineAt(raw, idx)}, but the full old_string does not match there. Check whitespace, indentation and the surrounding lines (Read that region again).`;
    }
    return { ok: false, error: `String to replace not found in file.${hint}\nold_string must match the file contents exactly, including whitespace and indentation, without Read's line-number prefixes.` };
  }
  if (m.count > 1 && !edit.replace_all) {
    const lines = allIndexes(raw, m.needle).slice(0, 8).map((i) => lineAt(raw, i));
    return {
      ok: false,
      error: `Found ${m.count} matches of the string to replace (lines ${lines.join(', ')}${m.count > lines.length ? ', …' : ''}), but replace_all is false. To replace all occurrences set replace_all to true; to replace one, include more surrounding context in old_string so it is unique.`,
    };
  }

  const newEol = old.includes('\n') ? m.eol : dominantEol;
  const replacement = newEol === 'crlf' ? toCrlf(neu) : neu;
  const positions = edit.replace_all ? allIndexes(raw, m.needle) : [raw.indexOf(m.needle)];
  let out = '';
  let last = 0;
  for (const p of positions) {
    out += raw.slice(last, p) + replacement;
    last = p + m.needle.length;
  }
  out += raw.slice(last);
  return {
    ok: true,
    text: out,
    replacements: positions.length,
    line: lineAt(out, positions[0] + 0),
    newLines: neu === '' ? 0 : neu.split('\n').length,
    note,
  };
}
