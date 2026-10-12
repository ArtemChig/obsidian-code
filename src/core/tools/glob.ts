import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { defineTool, fail, ok } from './types';
import { displayPath, resolvePath, slash } from './lib/paths';

type GlobInput = { pattern: string; path?: string };

const IS_WIN = process.platform === 'win32';
const MAX_RESULTS = 100;
const HARD_CAP = 20000;

/** Split an absolute glob into a static base directory and the remaining relative pattern. */
function splitAbsolute(pattern: string): { base: string; pattern: string } {
  const segs = pattern.split('/');
  const fixed: string[] = [];
  let i = 0;
  for (; i < segs.length - 1; i++) {
    if (/[*?[\]{}()!]/.test(segs[i])) break;
    fixed.push(segs[i]);
  }
  let base = fixed.join('/') || '/';
  if (/^[A-Za-z]:$/.test(base)) base += '/';
  return { base, pattern: segs.slice(i).join('/') || '*' };
}

export async function globFiles(opts: { pattern: string; base: string; signal?: AbortSignal; extraIgnore?: string[] }): Promise<{ files: { abs: string; mtimeMs: number }[]; capped: boolean }> {
  let pat = opts.pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let base = opts.base;
  if (path.isAbsolute(pat) || /^[A-Za-z]:\//.test(pat)) {
    const s = splitAbsolute(pat);
    base = s.base;
    pat = s.pattern;
  }
  const mentionsIgnored = (name: string) => pat.includes(name) || slash(base).split('/').includes(name);
  const ignore = ['node_modules', '.git'].filter((n) => !mentionsIgnored(n)).map((n) => `**/${n}/**`);
  ignore.push(...(opts.extraIgnore ?? []));
  const files: { abs: string; mtimeMs: number }[] = [];
  let capped = false;
  const stream = fg.stream(pat, {
    cwd: base,
    dot: true,
    onlyFiles: true,
    ignore,
    followSymbolicLinks: false,
    suppressErrors: true,
    stats: true,
    caseSensitiveMatch: !IS_WIN,
  });
  for await (const entry of stream as AsyncIterable<{ path: string; stats?: { mtimeMs: number } }>) {
    if (opts.signal?.aborted) break;
    files.push({ abs: path.resolve(base, entry.path), mtimeMs: entry.stats?.mtimeMs ?? 0 });
    if (files.length >= HARD_CAP) {
      capped = true;
      break;
    }
  }
  (stream as unknown as { destroy?: () => void }).destroy?.();
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files, capped };
}

export const globTool = defineTool<GlobInput>(
  {
    name: 'Glob',
    description:
      'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.{js,jsx}". Up to 100 paths, newest first; node_modules and .git are skipped. Use Grep to search contents.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search (default: working directory)' },
      },
      required: ['pattern'],
    },
    concurrencySafe: true,
    permission: () => 'read',
    title: (i) => `Glob ${i.pattern ?? ''}`.trim(),
    ruleFor: () => 'Glob',

    async run(input, ctx) {
      const base = input.path ? resolvePath(input.path, ctx.cwd) : ctx.cwd;
      let st;
      try {
        st = await fs.stat(base);
      } catch {
        return fail(`Directory does not exist: ${displayPath(base, ctx.cwd)}`);
      }
      if (!st.isDirectory()) return fail(`Not a directory: ${displayPath(base, ctx.cwd)}`);

      const { files, capped } = await globFiles({ pattern: input.pattern, base, signal: ctx.signal });
      if (files.length === 0) {
        return ok(`No files found matching "${input.pattern}" in ${displayPath(base, ctx.cwd)}.`, {
          display: { kind: 'list', title: `Glob ${input.pattern}`, items: [] },
        });
      }
      const shown = files.slice(0, MAX_RESULTS).map((f) => displayPath(f.abs, ctx.cwd));
      let content = shown.join('\n');
      if (files.length > MAX_RESULTS || capped) {
        content += `\n\n(${capped ? 'More than ' : ''}${files.length} files matched; showing the ${MAX_RESULTS} most recently modified. Use a more specific pattern or path.)`;
      }
      return ok(content, { display: { kind: 'list', title: `Glob ${input.pattern} (${files.length}${capped ? '+' : ''})`, items: shown } });
    },
  },
  { aliases: { pattern: ['glob', 'glob_pattern', 'query'], path: ['directory', 'dir', 'cwd', 'folder'] } },
);
