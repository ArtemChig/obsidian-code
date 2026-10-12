import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { editTool } from '../../../src/core/tools/edit';
import { multiEditTool } from '../../../src/core/tools/multi-edit';
import { readTool } from '../../../src/core/tools/read';
import { writeTool } from '../../../src/core/tools/write';
import { cleanupTempDirs, lf, makeCtx, makeTempDir, sleep, write } from './helpers';

afterAll(cleanupTempDirs);

async function setup(files: Record<string, string | Buffer>) {
  const dir = makeTempDir();
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return { dir, ctx: makeCtx(dir) };
}

describe('Write', () => {
  it('creates a new file (with parent dirs), checkpoints first and records the change', async () => {
    const { dir, ctx } = await setup({});
    const r = await writeTool.run({ file_path: 'new dir/sub/file.txt', content: 'a\nb\n' }, ctx);
    expect(r.isError).toBeFalsy();
    const abs = path.join(dir, 'new dir', 'sub', 'file.txt');
    expect(fs.readFileSync(abs, 'utf8')).toBe('a\nb\n');
    expect(ctx.checkpoints).toEqual([abs]);
    expect(ctx.changes).toEqual([{ path: abs, additions: 2, deletions: 0, isNew: true }]);
    expect(r.display).toMatchObject({ kind: 'diff', isNewFile: true, before: '', after: 'a\nb\n' });
  });

  it('requires a prior Read before overwriting an existing file', async () => {
    const { dir, ctx } = await setup({ 'f.txt': 'old\n' });
    const r = await writeTool.run({ file_path: 'f.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not been read/i);
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('old\n');
    expect(ctx.checkpoints).toHaveLength(0);

    await readTool.run({ file_path: 'f.txt' }, ctx);
    const ok = await writeTool.run({ file_path: 'f.txt', content: 'new\n' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('new\n');
    expect(ctx.changes.at(-1)).toMatchObject({ additions: 1, deletions: 1, isNew: false });
  });

  it('preserves CRLF line endings and the BOM of the original file', async () => {
    const { dir, ctx } = await setup({ 'crlf.txt': Buffer.from('﻿one\r\ntwo\r\n', 'utf8') });
    await readTool.run({ file_path: 'crlf.txt' }, ctx);
    await writeTool.run({ file_path: 'crlf.txt', content: 'one\ntwo\nthree\n' }, ctx);
    const buf = fs.readFileSync(path.join(dir, 'crlf.txt'));
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buf.subarray(3).toString('utf8')).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('detects files modified after the Read', async () => {
    const { dir, ctx } = await setup({ 'm.txt': 'v1\n' });
    await readTool.run({ file_path: 'm.txt' }, ctx);
    await sleep(30);
    fs.writeFileSync(path.join(dir, 'm.txt'), 'changed by someone else\n');
    const r = await writeTool.run({ file_path: 'm.txt', content: 'mine\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/modified since/i);
    expect(fs.readFileSync(path.join(dir, 'm.txt'), 'utf8')).toBe('changed by someone else\n');
  });

  it('tolerates a touched file whose content did not change', async () => {
    const { dir, ctx } = await setup({ 't.txt': 'same\n' });
    await readTool.run({ file_path: 't.txt' }, ctx);
    await sleep(30);
    const p = path.join(dir, 't.txt');
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000));
    const r = await writeTool.run({ file_path: 't.txt', content: 'different\n' }, ctx);
    expect(r.isError).toBeFalsy();
  });

  it('allows consecutive writes without re-reading (mtime is refreshed)', async () => {
    const { ctx } = await setup({ 'c.txt': 'a\n' });
    await readTool.run({ file_path: 'c.txt' }, ctx);
    expect((await writeTool.run({ file_path: 'c.txt', content: 'b\n' }, ctx)).isError).toBeFalsy();
    expect((await writeTool.run({ file_path: 'c.txt', content: 'c\n' }, ctx)).isError).toBeFalsy();
  });

  it('declares edit permission and a rule', () => {
    const c = { cwd: '.', settings: makeCtx('.').settings };
    expect(writeTool.permission({ file_path: 'a', content: '' }, c)).toBe('edit');
    expect(writeTool.ruleFor?.({ file_path: 'a', content: '' })).toBe('Write');
    expect(writeTool.concurrencySafe).toBe(false);
  });
});

describe('Edit', () => {
  it('replaces a unique string and shows a numbered snippet', async () => {
    const { dir, ctx } = await setup({ 'src/app.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' });
    await readTool.run({ file_path: 'src/app.ts' }, ctx);
    const r = await editTool.run({ file_path: 'src/app.ts', old_string: 'const b = 2;', new_string: 'const b = 42;' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('1 replacement');
    expect(r.content).toContain('     2\tconst b = 42;');
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('const a = 1;\nconst b = 42;\nconst c = 3;\n');
    expect(ctx.checkpoints).toEqual([path.join(dir, 'src', 'app.ts')]);
    expect(ctx.changes.at(-1)).toMatchObject({ additions: 1, deletions: 1, isNew: false });
    expect(r.display).toMatchObject({ kind: 'diff' });
  });

  it('refuses to edit a file that was never read', async () => {
    const { dir, ctx } = await setup({ 'x.txt': 'hello\n' });
    const r = await editTool.run({ file_path: 'x.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Read tool/);
    expect(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8')).toBe('hello\n');
  });

  it('errors with the match count and line numbers when old_string is not unique', async () => {
    const { dir, ctx } = await setup({ 'dup.txt': 'foo\nbar\nfoo\nbaz\nfoo\n' });
    await readTool.run({ file_path: 'dup.txt' }, ctx);
    const r = await editTool.run({ file_path: 'dup.txt', old_string: 'foo', new_string: 'qux' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Found 3 matches');
    expect(r.content).toContain('1, 3, 5');
    expect(r.content).toContain('replace_all');
    expect(fs.readFileSync(path.join(dir, 'dup.txt'), 'utf8')).toBe('foo\nbar\nfoo\nbaz\nfoo\n');
  });

  it('replace_all replaces every occurrence (and treats $ literally)', async () => {
    const { dir, ctx } = await setup({ 'dup.txt': 'foo\nbar\nfoo\n' });
    await readTool.run({ file_path: 'dup.txt' }, ctx);
    const r = await editTool.run({ file_path: 'dup.txt', old_string: 'foo', new_string: '$& $1', replace_all: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('2 replacements');
    expect(fs.readFileSync(path.join(dir, 'dup.txt'), 'utf8')).toBe('$& $1\nbar\n$& $1\n');
  });

  it('reports not-found with a helpful hint', async () => {
    const { ctx } = await setup({ 'h.txt': 'function  greet() {\n  return 1;\n}\n' });
    await readTool.run({ file_path: 'h.txt' }, ctx);
    const miss = await editTool.run({ file_path: 'h.txt', old_string: 'nothing like this', new_string: 'x' }, ctx);
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain('not found');
    const near = await editTool.run({ file_path: 'h.txt', old_string: 'function  greet() {\n    return 2;\n}', new_string: 'x' }, ctx);
    expect(near.content).toMatch(/does appear on line 1/);
  });

  it('rejects identical old/new strings and empty old_string on non-empty files', async () => {
    const { ctx } = await setup({ 'i.txt': 'abc\n' });
    await readTool.run({ file_path: 'i.txt' }, ctx);
    expect((await editTool.run({ file_path: 'i.txt', old_string: 'abc', new_string: 'abc' }, ctx)).content).toMatch(/No changes/);
    expect((await editTool.run({ file_path: 'i.txt', old_string: '', new_string: 'zzz' }, ctx)).isError).toBe(true);
  });

  it('preserves CRLF in multi-line edits made with LF strings', async () => {
    const { dir, ctx } = await setup({ 'win.txt': 'line1\r\nline2\r\nline3\r\n' });
    await readTool.run({ file_path: 'win.txt' }, ctx);
    const r = await editTool.run({ file_path: 'win.txt', old_string: 'line1\nline2', new_string: 'LINE1\nNEW\nLINE2' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'win.txt'), 'utf8')).toBe('LINE1\r\nNEW\r\nLINE2\r\nline3\r\n');
    // single-line old_string with multi-line replacement also gets CRLF
    const r2 = await editTool.run({ file_path: 'win.txt', old_string: 'line3', new_string: 'a\nb' }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'win.txt'), 'utf8')).toBe('LINE1\r\nNEW\r\nLINE2\r\na\r\nb\r\n');
  });

  it('preserves LF in LF files and mixed endings elsewhere in the file', async () => {
    const { dir, ctx } = await setup({ 'mixed.txt': 'a\r\nb\r\nc\nd\ne\n' });
    await readTool.run({ file_path: 'mixed.txt' }, ctx);
    const r = await editTool.run({ file_path: 'mixed.txt', old_string: 'd\ne', new_string: 'D\nE' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'mixed.txt'), 'utf8')).toBe('a\r\nb\r\nc\nD\nE\n');
  });

  it('accepts old_string copied with Read line-number prefixes', async () => {
    const { dir, ctx } = await setup({ 'p.txt': 'alpha\nbeta\n' });
    await readTool.run({ file_path: 'p.txt' }, ctx);
    const r = await editTool.run({ file_path: 'p.txt', old_string: '     2\tbeta', new_string: '     2\tgamma' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'p.txt'), 'utf8')).toBe('alpha\ngamma\n');
  });

  it('creates a file when old_string is empty and the file does not exist', async () => {
    const { dir, ctx } = await setup({});
    const r = await editTool.run({ file_path: 'created.txt', old_string: '', new_string: 'hi\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'created.txt'), 'utf8')).toBe('hi\n');
    const missing = await editTool.run({ file_path: 'nope.txt', old_string: 'a', new_string: 'b' }, ctx);
    expect(missing.isError).toBe(true);
  });

  it('works on legacy single-byte (latin1) files without corrupting bytes', async () => {
    const { dir, ctx } = await setup({ 'l1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]) }); // "café\nx\n" in latin1
    await readTool.run({ file_path: 'l1.txt' }, ctx);
    const r = await editTool.run({ file_path: 'l1.txt', old_string: 'x', new_string: 'y' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'l1.txt'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x79, 0x0a]));
    const bad = await editTool.run({ file_path: 'l1.txt', old_string: 'y', new_string: '日本' }, ctx);
    expect(bad.isError).toBe(true);
  });

  it('redirects notebooks to NotebookEdit and rejects directories', async () => {
    const { dir, ctx } = await setup({ 'n.ipynb': '{}' });
    fs.mkdirSync(path.join(dir, 'd'));
    await readTool.run({ file_path: 'n.ipynb' }, ctx);
    expect((await editTool.run({ file_path: 'n.ipynb', old_string: '{}', new_string: '{ }' }, ctx)).content).toMatch(/NotebookEdit/);
    expect((await editTool.run({ file_path: 'd', old_string: 'a', new_string: 'b' }, ctx)).isError).toBe(true);
  });

  it('works through Windows backslash paths and large files (excerpt display)', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line number ${i + 1} with some padding text`).join('\n') + '\n';
    const { dir, ctx } = await setup({ 'deep dir/big file.txt': big });
    const p = path.join(dir, 'deep dir', 'big file.txt');
    await readTool.run({ file_path: p }, ctx);
    const r = await editTool.run({ file_path: p, old_string: 'line number 1500 with', new_string: 'LINE 1500 with' }, ctx);
    expect(r.isError).toBeFalsy();
    const d = r.display as { before: string; after: string };
    expect(d.before.length).toBeLessThan(2000);
    expect(d.after).toContain('LINE 1500');
  });

  it('declares edit permission, title and rule', () => {
    const c = { cwd: '.', settings: makeCtx('.').settings };
    const input = { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' };
    expect(editTool.permission(input, c)).toBe('edit');
    expect(editTool.title(input)).toBe('Edit src/app.ts');
    expect(editTool.ruleFor?.(input)).toBe('Edit');
  });
});

describe('MultiEdit', () => {
  it('applies edits sequentially and atomically', async () => {
    const { dir, ctx } = await setup({ 'm.ts': 'let a = 1;\nlet b = 2;\nlet c = 3;\n' });
    await readTool.run({ file_path: 'm.ts' }, ctx);
    const r = await multiEditTool.run({
      file_path: 'm.ts',
      edits: [
        { old_string: 'let a = 1;', new_string: 'let a = 10;' },
        { old_string: 'let a = 10;\nlet b = 2;', new_string: 'let a = 10;\nlet b = 20;' }, // depends on edit 1
        { old_string: 'let c', new_string: 'const c' },
      ],
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'm.ts'), 'utf8')).toBe('let a = 10;\nlet b = 20;\nconst c = 3;\n');
    expect(ctx.checkpoints).toHaveLength(1);
    expect(ctx.changes).toHaveLength(1);
  });

  it('writes nothing when any edit fails and says which one', async () => {
    const { dir, ctx } = await setup({ 'm.ts': 'one\ntwo\n' });
    await readTool.run({ file_path: 'm.ts' }, ctx);
    const r = await multiEditTool.run({
      file_path: 'm.ts',
      edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'missing', new_string: 'x' }],
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Edit 2 of 2 failed');
    expect(fs.readFileSync(path.join(dir, 'm.ts'), 'utf8')).toBe('one\ntwo\n');
    expect(ctx.checkpoints).toHaveLength(0);
  });

  it('requires a prior Read, keeps CRLF, and accepts a JSON-string edits array', async () => {
    const { dir, ctx } = await setup({ 'w.txt': 'a\r\nb\r\n' });
    const unread = await multiEditTool.run({ file_path: 'w.txt', edits: [{ old_string: 'a', new_string: 'A' }] }, ctx);
    expect(unread.isError).toBe(true);
    await readTool.run({ file_path: 'w.txt' }, ctx);
    const r = await multiEditTool.run({ file_path: 'w.txt', edits: JSON.stringify([{ old_string: 'a\nb', new_string: 'x\ny\nz' }]) } as never, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8')).toBe('x\r\ny\r\nz\r\n');
  });

  it('creates a file when the first edit has an empty old_string', async () => {
    const { dir, ctx } = await setup({});
    const r = await multiEditTool.run({
      file_path: 'new.txt',
      edits: [{ old_string: '', new_string: 'hello world\n' }, { old_string: 'world', new_string: 'there' }],
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(lf(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'))).toBe('hello there\n');
  });

  it('enforces uniqueness per edit unless replace_all', async () => {
    const { ctx } = await setup({ 'u.txt': 'x x\n' });
    await readTool.run({ file_path: 'u.txt' }, ctx);
    const r = await multiEditTool.run({ file_path: 'u.txt', edits: [{ old_string: 'x', new_string: 'y' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Found 2 matches');
    const ok = await multiEditTool.run({ file_path: 'u.txt', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] }, ctx);
    expect(ok.isError).toBeFalsy();
  });
});
