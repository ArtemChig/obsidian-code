// ui-chat: diff model (line numbers, add/del rows, collapsed hunks, excerpts, permission previews).
import { describe, expect, it } from 'vitest';
import { collapseDiff, computeDiff, parseExcerpt, previewFromInput, splitLines, toUnifiedText } from '@renderer/features/chat/lib/diff';

// Local mirrors of the module's types (the node type-check sees @renderer/* as untyped).
type DiffRow = { type: 'add' | 'del' | 'ctx'; oldNo: number | null; newNo: number | null; text: string };
type DiffItem = { kind: 'row'; row: DiffRow } | { kind: 'gap'; id: string; rows: DiffRow[] };

describe('computeDiff', () => {
  it('numbers old and new lines and counts changes', () => {
    const m = computeDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(m.additions).toBe(2);
    expect(m.deletions).toBe(1);
    const rows = m.rows.map((r: DiffRow) => [r.type, r.oldNo, r.newNo, r.text]);
    expect(rows).toEqual([
      ['ctx', 1, 1, 'a'],
      ['del', 2, null, 'b'],
      ['add', null, 2, 'B'],
      ['ctx', 3, 3, 'c'],
      ['add', null, 4, 'd'],
    ]);
  });

  it('treats an empty "before" as a new file', () => {
    const m = computeDiff('', 'x\ny');
    expect(m.rows.every((r: DiffRow) => r.type === 'add')).toBe(true);
    expect(m.additions).toBe(2);
    expect(m.deletions).toBe(0);
  });

  it('handles CRLF and a missing trailing newline the same way', () => {
    const m = computeDiff('one\r\ntwo\r\n', 'one\ntwo');
    expect(m.additions + m.deletions).toBe(0);
  });

  it('offsets line numbers for core excerpts ("… (lines 1-N not shown)")', () => {
    const before = '… (lines 1-40 not shown)\nfoo\nbar';
    const after = '… (lines 1-40 not shown)\nfoo\nbaz';
    const m = computeDiff(before, after);
    expect(m.rows[0]).toMatchObject({ type: 'ctx', oldNo: 41, newNo: 41, text: 'foo' });
    expect(m.rows.find((r: DiffRow) => r.type === 'add')).toMatchObject({ newNo: 42, text: 'baz' });
  });

  it('falls back to a prefix/suffix diff for huge inputs', () => {
    const big = Array.from({ length: 12_000 }, (_, i) => `line ${i}`);
    const changed = big.slice();
    changed[6000] = 'CHANGED';
    const m = computeDiff(big.join('\n'), changed.join('\n'));
    expect(m.additions).toBe(1);
    expect(m.deletions).toBe(1);
  });
});

describe('collapseDiff', () => {
  const rows = computeDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'X' : `l${i}`)).join('\n')).rows;

  it('keeps context around changes and collapses the rest into gaps', () => {
    const items = collapseDiff(rows, 3);
    const gaps = items.filter((i: DiffItem) => i.kind === 'gap');
    expect(gaps).toHaveLength(2);
    const visible = items.filter((i: DiffItem) => i.kind === 'row') as Extract<DiffItem, { kind: 'row' }>[];
    // 3 context + del + add + 3 context
    expect(visible).toHaveLength(8);
    expect(visible[0].row.text).toBe('l12');
    const hidden = gaps.reduce((n: number, g: DiffItem) => n + (g.kind === 'gap' ? g.rows.length : 0), 0);
    expect(hidden + visible.length).toBe(rows.length);
  });

  it('does not create tiny gaps', () => {
    const small = computeDiff('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne').rows;
    expect(collapseDiff(small, 1, 4).every((i: DiffItem) => i.kind === 'row')).toBe(true);
  });

  it('shows the head of an unchanged file and collapses the tail', () => {
    const same = computeDiff('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12').rows;
    const items = collapseDiff(same, 3);
    expect(items[items.length - 1].kind).toBe('gap');
  });
});

describe('helpers', () => {
  it('splitLines drops one trailing newline only', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual([]);
  });

  it('parseExcerpt leaves normal text alone', () => {
    expect(parseExcerpt('hello\nworld')).toEqual({ text: 'hello\nworld', offset: 0 });
  });

  it('toUnifiedText prefixes rows', () => {
    expect(toUnifiedText(computeDiff('a', 'b').rows)).toBe('-a\n+b');
  });

  it('previewFromInput builds before/after for edit tools', () => {
    expect(previewFromInput('Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' })).toEqual({ path: 'x.ts', before: 'a', after: 'b' });
    expect(previewFromInput('Write', { file_path: 'n.ts', content: 'new' })).toEqual({ path: 'n.ts', before: '', after: 'new', isNew: true });
    const multi = previewFromInput('MultiEdit', { file_path: 'm.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] });
    expect(multi?.before).toContain('1');
    expect(multi?.after).toContain('4');
    expect(previewFromInput('Bash', { command: 'ls' })).toBeNull();
  });
});
