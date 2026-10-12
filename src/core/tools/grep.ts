import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool, fail, ok, type ToolContext } from './types';
import { runGrepFallback } from './lib/grepJs';
import { displayPath, resolvePath, slash } from './lib/paths';
import { getRipgrepPath, runRipgrep, splitGlobs, type GrepMode, type GrepParams, type GrepRaw } from './lib/ripgrep';
import { truncateEnd } from './lib/text';

type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: GrepMode;
  '-i'?: boolean;
  '-n'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  head_limit?: number;
  multiline?: boolean;
};

const DEFAULT_LIMIT = 250;
const HARD_LIMIT = 5000;

function budget(ctx: ToolContext): number {
  const n = ctx.settings?.maxToolOutputChars;
  return typeof n === 'number' && n > 1000 ? n : 30000;
}

async function sortByMtime(root: string, rels: string[]): Promise<string[]> {
  const stats = await Promise.all(rels.map(async (r) => {
    try { return { r, m: (await fs.stat(path.join(root, r))).mtimeMs }; } catch { return { r, m: 0 }; }
  }));
  return stats.sort((a, b) => b.m - a.m || a.r.localeCompare(b.r)).map((x) => x.r);
}

function formatContentLine(raw: string, root: string, cwd: string, lineNumbers: boolean): string {
  if (raw === '--') return '--';
  const nul = raw.indexOf('\0');
  if (nul < 0) return raw;
  const file = displayPath(path.resolve(root, raw.slice(0, nul)), cwd);
  const rest = raw.slice(nul + 1);
  if (lineNumbers) {
    const m = /^(\d+)([:-])/.exec(rest);
    if (m) return `${file}${m[2]}${m[1]}${m[2]}${rest.slice(m[0].length)}`;
  }
  return `${file}:${rest}`;
}

export const grepTool = defineTool<GrepInput>(
  {
    name: 'Grep',
    description:
      'Search file contents with a ripgrep regex (use this instead of grep/rg in Bash). output_mode: files_with_matches (default), content (matching lines, with -n/-A/-B/-C), or count. ' +
      'Narrow with glob or type. Results are capped by head_limit (default 250).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex' },
        path: { type: 'string', description: 'File or directory (default: working directory)' },
        glob: { type: 'string', description: 'File glob, e.g. "*.tsx"' },
        type: { type: 'string', description: 'File type, e.g. js, py, rust' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        '-i': { type: 'boolean', description: 'Case-insensitive' },
        '-n': { type: 'boolean', description: 'Line numbers (content mode, default true)' },
        '-A': { type: 'integer', description: 'Lines after each match' },
        '-B': { type: 'integer', description: 'Lines before each match' },
        '-C': { type: 'integer', description: 'Lines before and after' },
        head_limit: { type: 'integer', description: 'Max lines/entries (0 = unlimited)' },
        multiline: { type: 'boolean', description: 'Allow matches across lines' },
      },
      required: ['pattern'],
    },
    concurrencySafe: true,
    permission: () => 'read',
    title: (i) => `Grep ${i.pattern ?? ''}`.trim(),
    ruleFor: () => 'Grep',

    async run(input, ctx) {
      const target = input.path ? resolvePath(input.path, ctx.cwd) : ctx.cwd;
      let st;
      try {
        st = await fs.stat(target);
      } catch {
        return fail(`Path does not exist: ${displayPath(target, ctx.cwd)}`);
      }
      const mode: GrepMode = input.output_mode ?? 'files_with_matches';
      const ctxN = input['-C'] ?? 0;
      const limit = input.head_limit === undefined ? DEFAULT_LIMIT : input.head_limit === 0 ? HARD_LIMIT : Math.min(input.head_limit, HARD_LIMIT);
      const globs = splitGlobs(input.glob);
      const skipNodeModules = !slash(target).split('/').includes('node_modules') && !globs.some((g) => g.includes('node_modules'));
      const params: GrepParams = {
        pattern: input.pattern,
        target,
        targetIsFile: st.isFile(),
        mode,
        ignoreCase: input['-i'] === true,
        lineNumbers: input['-n'] !== false,
        after: Math.max(0, input['-A'] ?? ctxN),
        before: Math.max(0, input['-B'] ?? ctxN),
        globs,
        type: input.type?.trim() || undefined,
        multiline: input.multiline === true,
        limit,
        signal: ctx.signal,
        skipNodeModules,
      };

      let raw: GrepRaw;
      const rg = await getRipgrepPath();
      if (rg) {
        raw = await runRipgrep(rg, params);
        if (raw.error?.startsWith('ripgrep failed to start')) raw = await runGrepFallback(params);
      } else {
        raw = await runGrepFallback(params);
      }
      if (raw.error) return fail(`Grep error: ${raw.error}`);

      const notes: string[] = [];
      if (raw.truncated) notes.push(`Output limited to the first ${limit} ${mode === 'content' ? 'lines' : 'entries'}; refine the pattern/path/glob or raise head_limit.`);
      if (raw.timedOut) notes.push('The search timed out after 60s; results are partial.');

      let out: string[];
      let header = '';
      if (mode === 'files_with_matches') {
        const sorted = await sortByMtime(raw.root, raw.lines.filter(Boolean));
        out = sorted.map((r) => displayPath(path.resolve(raw.root, r), ctx.cwd));
        if (out.length) header = `Found ${out.length} file${out.length === 1 ? '' : 's'}${raw.truncated ? '+' : ''}`;
      } else if (mode === 'count') {
        let total = 0;
        out = raw.lines.filter(Boolean).map((l) => {
          const nul = l.indexOf('\0');
          const n = Number(l.slice(nul + 1)) || 0;
          total += n;
          return `${displayPath(path.resolve(raw.root, l.slice(0, nul)), ctx.cwd)}:${n}`;
        });
        if (out.length) header = `Found ${total} match${total === 1 ? '' : 'es'} in ${out.length} file${out.length === 1 ? '' : 's'}`;
      } else {
        out = raw.lines.map((l) => formatContentLine(l, raw.root, ctx.cwd, params.lineNumbers));
        if (out.length === 0) header = '';
      }

      if (out.length === 0) {
        return ok(`No matches found for pattern "${input.pattern}" in ${displayPath(target, ctx.cwd)}.`, {
          display: { kind: 'list', title: `Grep ${input.pattern}`, items: [] },
        });
      }
      let content = (header ? `${header}\n` : '') + out.join('\n');
      content = truncateEnd(content, budget(ctx), '… [output truncated; narrow the search]');
      if (notes.length) content += `\n\n(${notes.join(' ')})`;
      return ok(content, { display: { kind: 'list', title: `Grep ${input.pattern} (${out.length}${raw.truncated ? '+' : ''})`, items: out.slice(0, 300) } });
    },
  },
  {
    aliases: {
      pattern: ['regex', 'query', 'search', 'regexp'],
      path: ['directory', 'dir', 'file', 'folder'],
      '-i': ['case_insensitive', 'ignore_case', 'i', 'insensitive'],
      '-n': ['line_numbers', 'n'],
      '-A': ['after', 'after_context', 'A'],
      '-B': ['before', 'before_context', 'B'],
      '-C': ['context', 'C'],
      output_mode: ['mode'],
      glob: ['include', 'file_pattern'],
    },
  },
);
