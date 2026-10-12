import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { readTool } from '../../../src/core/tools/read';
import { cleanupTempDirs, makeCtx, makeTempDir, write } from './helpers';

afterAll(cleanupTempDirs);

// minimal 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('Read', () => {
  it('numbers lines cat -n style and records the read (path with spaces)', async () => {
    const dir = makeTempDir();
    const file = write(dir, 'sub dir/hello world.txt', 'alpha\nbeta\ngamma\n');
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'sub dir/hello world.txt' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe('     1\talpha\n     2\tbeta\n     3\tgamma');
    expect(r.display).toMatchObject({ kind: 'file', startLine: 1, totalLines: 3, content: 'alpha\nbeta\ngamma' });
    expect(ctx.readFiles.has(path.resolve(file))).toBe(true);
  });

  it('accepts absolute paths with forward slashes, quotes and aliases', async () => {
    const dir = makeTempDir();
    const file = write(dir, 'a.txt', 'one\n');
    const ctx = makeCtx(path.join(dir, '..'));
    const fwd = file.replace(/\\/g, '/');
    expect((await readTool.run({ file_path: fwd }, ctx)).content).toContain('one');
    expect((await readTool.run({ file_path: `"${file}"` }, ctx)).content).toContain('one');
    expect((await readTool.run({ path: file } as never, ctx)).content).toContain('one');
    expect((await readTool.run({ filePath: file } as never, ctx)).content).toContain('one');
  });

  it('honours offset and limit and tells the model how to continue', async () => {
    const dir = makeTempDir();
    write(dir, 'big.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'big.txt', offset: 10, limit: 5 }, ctx);
    expect(r.content).toContain('    10\tline 10');
    expect(r.content).toContain('    14\tline 14');
    expect(r.content).not.toContain('line 15');
    expect(r.content).toContain('offset=15');
    expect(r.display).toMatchObject({ startLine: 10, totalLines: 50 });
  });

  it('coerces string numbers from the model', async () => {
    const dir = makeTempDir();
    write(dir, 'n.txt', 'a\nb\nc\n');
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'n.txt', offset: '2', limit: '1' } as never, ctx);
    expect(r.content).toBe('     2\tb\n\n[Showing lines 2-2 of 3. Use offset=3 to continue reading.]');
  });

  it('defaults to 2000 lines and truncates very long lines', async () => {
    const dir = makeTempDir();
    write(dir, 'many.txt', Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join('\n'));
    write(dir, 'long.txt', `${'x'.repeat(5000)}\nshort\n`);
    const ctx = makeCtx(dir, { settings: { maxToolOutputChars: 1_000_000 } });
    const many = await readTool.run({ file_path: 'many.txt' }, ctx);
    expect(many.content).toContain('  2000\tl2000');
    expect(many.content).not.toContain('l2001');
    expect(many.content).toContain('offset=2001');
    const long = await readTool.run({ file_path: 'long.txt' }, ctx);
    expect(long.content).toContain('[line truncated');
    expect(long.content).toContain('short');
  });

  it('caps output at maxToolOutputChars on a line boundary', async () => {
    const dir = makeTempDir();
    write(dir, 'w.txt', Array.from({ length: 1000 }, (_, i) => `row-${i + 1}-${'y'.repeat(40)}`).join('\n'));
    const ctx = makeCtx(dir, { settings: { maxToolOutputChars: 2000 } });
    const r = await readTool.run({ file_path: 'w.txt' }, ctx);
    expect(r.content.length).toBeLessThan(2600);
    expect(r.content).toMatch(/Use offset=\d+ to continue/);
  });

  it('strips a UTF-8 BOM and handles CRLF files', async () => {
    const dir = makeTempDir();
    write(dir, 'crlf.txt', Buffer.from('﻿one\r\ntwo\r\n', 'utf8'));
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'crlf.txt' }, ctx);
    expect(r.content).toBe('     1\tone\n     2\ttwo');
  });

  it('warns for empty files and offsets past the end', async () => {
    const dir = makeTempDir();
    write(dir, 'empty.txt', '');
    write(dir, 'two.txt', 'a\nb\n');
    const ctx = makeCtx(dir);
    expect((await readTool.run({ file_path: 'empty.txt' }, ctx)).content).toContain('empty');
    expect((await readTool.run({ file_path: 'two.txt', offset: 10 }, ctx)).content).toContain('only 2 line');
  });

  it('returns images as base64 attachments', async () => {
    const dir = makeTempDir();
    write(dir, 'pic.png', PNG);
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'pic.png' }, ctx);
    expect(r.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    expect(r.content).toContain('pic.png');
  });

  it('refuses binary files and directories, suggests similar names for missing files', async () => {
    const dir = makeTempDir();
    write(dir, 'blob.dat2', Buffer.from([1, 2, 0, 3, 0, 0, 4, 5, 0, 0, 0]));
    write(dir, 'blob.exe', Buffer.from('MZ'));
    write(dir, 'readme.md', '# hi');
    fs.mkdirSync(path.join(dir, 'folder'));
    const ctx = makeCtx(dir);
    expect((await readTool.run({ file_path: 'blob.dat2' }, ctx)).content).toContain('binary');
    expect((await readTool.run({ file_path: 'blob.exe' }, ctx)).isError).toBe(true);
    const d = await readTool.run({ file_path: 'folder' }, ctx);
    expect(d.isError).toBe(true);
    expect(d.content).toContain('directory');
    const missing = await readTool.run({ file_path: 'redme.md' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('Did you mean: readme.md');
  });

  it('renders Jupyter notebooks with cell ids and outputs', async () => {
    const dir = makeTempDir();
    const nb = {
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [
        { cell_type: 'markdown', id: 'md1', metadata: {}, source: ['# Title\n', 'text'] },
        { cell_type: 'code', id: 'c1', metadata: {}, execution_count: 1, source: ['print(1)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }, { output_type: 'display_data', data: { 'image/png': PNG.toString('base64'), 'text/plain': ['<Figure>'] }, metadata: {} }] },
      ],
    };
    write(dir, 'n.ipynb', JSON.stringify(nb, null, 1));
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'n.ipynb' }, ctx);
    expect(r.content).toContain('--- Cell 0 (markdown, id: md1) ---');
    expect(r.content).toContain('# Title\ntext');
    expect(r.content).toContain('--- Cell 1 (code, id: c1) ---');
    expect(r.content).toContain('print(1)');
    expect(r.content).toContain('[output]\n1');
    expect(r.images).toHaveLength(1);
  });

  it('extracts text from simple PDFs (plain and Flate-compressed streams)', async () => {
    const dir = makeTempDir();
    const plain = 'BT /F1 12 Tf 72 720 Td (Hello PDF World, this is page one.) Tj T* (Second line with \\(parens\\) inside.) Tj ET';
    const packed = deflateSync(Buffer.from('BT /F1 12 Tf [(Kerned) -300 (text) -250 (array)] TJ 0 -14 Td <48656C6C6F20686578> Tj ET'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n'),
      Buffer.from(`3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${plain.length} >>\nstream\n${plain}\nendstream\nendobj\n`),
      Buffer.from(`5 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>\nendobj\n6 0 obj\n<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`),
      packed,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
    ]);
    write(dir, 'doc.pdf', pdf);
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'doc.pdf' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('2 page(s)');
    expect(r.content).toContain('Hello PDF World, this is page one.');
    expect(r.content).toContain('Second line with (parens) inside.');
    expect(r.content).toContain('Kerned text array');
    expect(r.content).toContain('Hello hex');
    // a PDF with no extractable text reports that instead of garbage
    write(dir, 'scan.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF'));
    const empty = await readTool.run({ file_path: 'scan.pdf' }, ctx);
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('Could not extract text');
  });

  it('streams very large files with offset/limit', async () => {
    const dir = makeTempDir();
    const p = path.join(dir, 'huge.log');
    const line = `${'z'.repeat(99)}\n`;
    fs.writeFileSync(p, line.repeat(90_000)); // ~9 MB > streaming threshold
    const ctx = makeCtx(dir);
    const r = await readTool.run({ file_path: 'huge.log', offset: 89_999, limit: 5 }, ctx);
    expect(r.content).toContain(' 89999\t');
    expect(r.content).toContain(' 90000\t');
    expect(r.display).toMatchObject({ totalLines: 90_000 });
  });

  it('validates required parameters', async () => {
    const ctx = makeCtx(makeTempDir());
    const r = await readTool.run({} as never, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('file_path');
  });

  it('declares permission, title and concurrency', () => {
    expect(readTool.permission({ file_path: 'x' }, { cwd: '.', settings: makeCtx('.').settings })).toBe('read');
    expect(readTool.title({ file_path: 'src/a.ts' })).toBe('Read src/a.ts');
    expect(readTool.concurrencySafe).toBe(true);
  });
});
