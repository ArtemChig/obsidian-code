import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { globTool } from '../../../src/core/tools/glob';
import { grepTool } from '../../../src/core/tools/grep';
import { lsTool } from '../../../src/core/tools/ls';
import { fixAsarPath, getRipgrepPath, setRipgrepPathForTests, splitGlobs } from '../../../src/core/tools/lib/ripgrep';
import { cleanupTempDirs, makeCtx, makeTempDir, write } from './helpers';

afterAll(cleanupTempDirs);
afterEach(() => setRipgrepPathForTests(undefined));

function fixture(): string {
  const dir = makeTempDir();
  write(dir, 'src/a.ts', "export function alpha() {\n  return 'Alpha';\n}\n");
  write(dir, 'src/b.ts', 'const beta = 1;\n// TODO fix alpha\nconst gamma = 3;\n');
  write(dir, 'src/sub dir/c.py', 'def gamma():\n    pass  # todo\n');
  write(dir, 'README.md', '# Readme\nalpha beta\n');
  write(dir, 'node_modules/pkg/index.js', 'alpha\n');
  write(dir, '.git/config', 'alpha\n');
  write(dir, '.hidden/h.txt', 'alpha hidden\n');
  write(dir, 'crlf.txt', 'first alpha\r\nsecond\r\n');
  return dir;
}

describe('ripgrep availability', () => {
  it('finds the bundled ripgrep binary', async () => {
    const rg = await getRipgrepPath();
    expect(rg).toBeTruthy();
    expect(fs.existsSync(rg!)).toBe(true);
  });
});

describe.each([
  ['ripgrep', undefined],
  ['JS fallback', null],
] as const)('Grep (%s)', (_name, rgSetting) => {
  const run = async (dir: string, input: Record<string, unknown>) => {
    setRipgrepPathForTests(rgSetting);
    return grepTool.run(input as never, makeCtx(dir));
  };

  it('lists matching files by default, skipping node_modules and .git, including hidden dirs', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'alpha' });
    expect(r.isError).toBeFalsy();
    const lines = r.content.split('\n');
    expect(lines[0]).toBe('Found 5 files');
    const files = lines.slice(1, 6).sort();
    expect(files).toEqual(['.hidden/h.txt', 'README.md', 'crlf.txt', 'src/a.ts', 'src/b.ts']);
    expect(r.content).not.toContain('node_modules');
    expect(r.content).not.toContain('.git/');
  });

  it('supports -i, glob and type filters', async () => {
    const dir = fixture();
    const cs = await run(dir, { pattern: 'ALPHA' });
    expect(cs.content).toContain('No matches');
    const ci = await run(dir, { pattern: 'ALPHA', '-i': true, glob: '*.ts' });
    expect(ci.content.split('\n').slice(1).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const py = await run(dir, { pattern: 'todo', type: 'py', '-i': true });
    expect(py.content).toContain('src/sub dir/c.py');
    expect(py.content).not.toContain('b.ts');
  });

  it('content mode prints path:line:text with -n and context lines', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'TODO', output_mode: 'content' });
    expect(r.content).toBe('src/b.ts:2:// TODO fix alpha');
    const noN = await run(dir, { pattern: 'TODO', output_mode: 'content', '-n': false });
    expect(noN.content).toBe('src/b.ts:// TODO fix alpha');
    const ctxR = await run(dir, { pattern: 'TODO', output_mode: 'content', '-C': 1, glob: 'src/*.ts' });
    expect(ctxR.content.split('\n')).toEqual(['src/b.ts-1-const beta = 1;', 'src/b.ts:2:// TODO fix alpha', 'src/b.ts-3-const gamma = 3;']);
    const ab = await run(dir, { pattern: 'beta', output_mode: 'content', '-A': 1, '-B': 0, glob: 'src/*.ts' });
    expect(ab.content.split('\n')).toEqual(['src/b.ts:1:const beta = 1;', 'src/b.ts-2-// TODO fix alpha']);
  });

  it('count mode reports matches per file', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'gamma', output_mode: 'count' });
    const lines = r.content.split('\n');
    expect(lines[0]).toBe('Found 2 matches in 2 files');
    expect(lines.slice(1).sort()).toEqual(['src/b.ts:1', 'src/sub dir/c.py:1']);
  });

  it('applies head_limit', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'alpha', output_mode: 'content', head_limit: 2 });
    const body = r.content.split('\n\n(')[0].split('\n');
    expect(body).toHaveLength(2);
    expect(r.content).toContain('limited to the first 2');
  });

  it('supports multiline patterns', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'function alpha\\(\\) \\{\\n  return', multiline: true, output_mode: 'content' });
    expect(r.content.split('\n')).toEqual(['src/a.ts:1:export function alpha() {', 'src/a.ts:2:  return \'Alpha\';']);
    const single = await run(dir, { pattern: 'function alpha\\(\\) \\{\\n  return', output_mode: 'files_with_matches' });
    expect(single.isError).toBe(true);
    expect(single.content).toMatch(/multiline/i);
  });

  it('searches a single file path and handles CRLF files', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'alpha', path: 'crlf.txt', output_mode: 'content' });
    expect(r.content).toBe('crlf.txt:1:first alpha');
    const abs = await run(dir, { pattern: 'beta', path: path.join(dir, 'src'), output_mode: 'content' });
    expect(abs.content).toBe('src/b.ts:1:const beta = 1;');
  });

  it('reports invalid regex, unknown type and missing path as errors', async () => {
    const dir = fixture();
    const bad = await run(dir, { pattern: '(unclosed' });
    expect(bad.isError).toBe(true);
    const type = await run(dir, { pattern: 'x', type: 'nonsense-type' });
    expect(type.isError).toBe(true);
    const path_ = await run(dir, { pattern: 'x', path: 'does/not/exist' });
    expect(path_.isError).toBe(true);
  });

  it('accepts string booleans/numbers and alias names from the model', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'TODO', output_mode: 'content', '-C': '1', '-n': 'true', glob: 'src/*.ts' });
    expect(r.content.split('\n')).toHaveLength(3);
    const alias = await run(dir, { regex: 'ALPHA', case_insensitive: 'true', mode: 'count', glob: '*.ts' });
    expect(alias.content).toContain('src/a.ts:');
  });

  it('searches inside node_modules when asked to', async () => {
    const dir = fixture();
    const r = await run(dir, { pattern: 'alpha', path: 'node_modules' });
    expect(r.content).toContain('node_modules/pkg/index.js');
  });
});

describe('Grep helpers', () => {
  it('redirects ripgrep out of app.asar', () => {
    expect(fixAsarPath('C:\\Program Files\\Obsidian Code\\resources\\app.asar\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe'))
      .toBe('C:\\Program Files\\Obsidian Code\\resources\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe');
    expect(fixAsarPath('C:\\x\\app.asar.unpacked\\rg.exe')).toBe('C:\\x\\app.asar.unpacked\\rg.exe');
    expect(fixAsarPath('C:\\x\\node_modules\\rg.exe')).toBe('C:\\x\\node_modules\\rg.exe');
  });

  it('splits glob lists but not brace groups', () => {
    expect(splitGlobs('*.ts *.tsx')).toEqual(['*.ts', '*.tsx']);
    expect(splitGlobs('*.{ts,tsx}')).toEqual(['*.{ts,tsx}']);
    expect(splitGlobs('a/**/*.js,!b')).toEqual(['a/**/*.js', '!b']);
    expect(splitGlobs(undefined)).toEqual([]);
  });
});

describe('Glob', () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTempDir();
    write(dir, 'src/old.ts', 'a');
    write(dir, 'src/new.ts', 'b');
    write(dir, 'src/deep/x y.tsx', 'c');
    write(dir, 'node_modules/m/i.ts', 'd');
    write(dir, '.git/hook.ts', 'e');
    write(dir, 'readme.md', 'f');
    const now = Date.now();
    fs.utimesSync(path.join(dir, 'src/old.ts'), new Date(now - 100_000), new Date(now - 100_000));
    fs.utimesSync(path.join(dir, 'src/new.ts'), new Date(now), new Date(now));
    fs.utimesSync(path.join(dir, 'src/deep/x y.tsx'), new Date(now - 50_000), new Date(now - 50_000));
  });

  it('matches recursively, sorted by mtime (newest first), ignoring node_modules/.git', async () => {
    const r = await globTool.run({ pattern: '**/*.ts' }, makeCtx(dir));
    expect(r.content.split('\n')).toEqual(['src/new.ts', 'src/old.ts']);
    expect(r.display).toMatchObject({ kind: 'list' });
  });

  it('supports braces, spaces in names, backslashes and the path parameter', async () => {
    const ctx = makeCtx(dir);
    const braces = await globTool.run({ pattern: '**/*.{ts,tsx}' }, ctx);
    expect(braces.content.split('\n')).toEqual(['src/new.ts', 'src/deep/x y.tsx', 'src/old.ts']);
    const back = await globTool.run({ pattern: 'src\\deep\\*.tsx' }, ctx);
    expect(back.content).toBe('src/deep/x y.tsx');
    const scoped = await globTool.run({ pattern: '*.ts', path: 'src' }, ctx);
    expect(scoped.content.split('\n').sort()).toEqual(['src/new.ts', 'src/old.ts']);
  });

  it('accepts absolute patterns and shows outside-cwd matches as absolute paths', async () => {
    const other = makeCtx(path.join(dir, 'src'));
    const abs = (dir + '/src/**/*.ts').replace(/\\/g, '/');
    const r = await globTool.run({ pattern: abs }, other);
    expect(r.content.split('\n').sort()).toEqual(['new.ts', 'old.ts']);
    const up = await globTool.run({ pattern: '*.md', path: dir }, other);
    expect(up.content.replace(/\\/g, '/')).toBe(path.join(dir, 'readme.md').replace(/\\/g, '/'));
  });

  it('can search node_modules when the pattern asks for it', async () => {
    const r = await globTool.run({ pattern: 'node_modules/**/*.ts' }, makeCtx(dir));
    expect(r.content).toBe('node_modules/m/i.ts');
  });

  it('reports no matches and bad directories', async () => {
    const ctx = makeCtx(dir);
    expect((await globTool.run({ pattern: '**/*.zzz' }, ctx)).content).toContain('No files found');
    expect((await globTool.run({ pattern: '*', path: 'nope' }, ctx)).isError).toBe(true);
  });

  it('truncates to 100 results with a note', async () => {
    const big = makeTempDir();
    for (let i = 0; i < 130; i++) write(big, `f/${i}.txt`, 'x');
    const r = await globTool.run({ pattern: '**/*.txt' }, makeCtx(big));
    expect(r.content.split('\n\n')[0].split('\n')).toHaveLength(100);
    expect(r.content).toContain('130 files matched');
  });
});

describe('LS', () => {
  it('prints an indented tree, dirs first, without expanding node_modules', async () => {
    const dir = makeTempDir();
    write(dir, 'zeta.txt', '');
    write(dir, 'src/app/main.ts', '');
    write(dir, 'src/readme.md', '');
    write(dir, 'node_modules/pkg/index.js', '');
    write(dir, 'a b/c d.txt', '');
    const r = await lsTool.run({}, makeCtx(dir));
    const lines = r.content.split('\n');
    expect(lines[0]).toBe(`- ${dir.replace(/\\/g, '/')}/`);
    expect(lines.slice(1)).toEqual([
      '  - a b/',
      '    - c d.txt',
      '  - node_modules/ (not expanded)',
      '  - src/',
      '    - app/',
      '      - main.ts',
      '    - readme.md',
      '  - zeta.txt',
    ]);
  });

  it('honours ignore globs, explicit paths and error cases', async () => {
    const dir = makeTempDir();
    write(dir, 'keep.txt', '');
    write(dir, 'skip.log', '');
    write(dir, 'sub/inner.log', '');
    write(dir, 'sub/inner.txt', '');
    fs.mkdirSync(path.join(dir, 'empty'));
    const ctx = makeCtx(dir);
    const r = await lsTool.run({ ignore: ['*.log'] }, ctx);
    expect(r.content).not.toContain('.log');
    expect(r.content).toContain('keep.txt');
    const sub = await lsTool.run({ path: 'sub' }, ctx);
    expect(sub.content).toContain('inner.txt');
    const empty = await lsTool.run({ path: 'empty' }, ctx);
    expect(empty.content).toContain('empty directory');
    expect((await lsTool.run({ path: 'keep.txt' }, ctx)).isError).toBe(true);
    expect((await lsTool.run({ path: 'missing' }, ctx)).isError).toBe(true);
  });

  it('caps very large directories', async () => {
    const dir = makeTempDir();
    for (let i = 0; i < 400; i++) write(dir, `f${String(i).padStart(3, '0')}.txt`, '');
    const r = await lsTool.run({}, makeCtx(dir));
    expect(r.content.split('\n').length).toBeLessThan(310);
    expect(r.content).toContain('not shown');
  });
});
