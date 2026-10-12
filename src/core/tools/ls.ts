import fs from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { defineTool, fail, ok } from './types';
import { displayPath, resolvePath, slash } from './lib/paths';

type LsInput = { path?: string; ignore?: string[] };

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.cache', 'target', '.gradle']);
const MAX_DEPTH = 3;
const MAX_LINES = 300;
const MAX_PER_SUBDIR = 40;

export const lsTool = defineTool<LsInput>(
  {
    name: 'LS',
    description:
      'List a directory as an indented tree (3 levels; node_modules, .git etc. are not expanded). Prefer Glob/Grep when searching.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (default: working directory)' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to hide' },
      },
    },
    concurrencySafe: true,
    permission: () => 'read',
    title: (i) => `List ${i.path ?? '.'}`,
    ruleFor: () => 'LS',

    async run(input, ctx) {
      const root = input.path ? resolvePath(input.path, ctx.cwd) : ctx.cwd;
      let st;
      try {
        st = await fs.stat(root);
      } catch {
        return fail(`Directory does not exist: ${displayPath(root, ctx.cwd)}`);
      }
      if (!st.isDirectory()) return fail(`Not a directory: ${displayPath(root, ctx.cwd)}. Use Read for files.`);

      const ignoreMatch = input.ignore?.length ? picomatch(input.ignore, { dot: true }) : () => false;
      const lines: string[] = [];
      let hidden = 0;
      let capped = false;

      async function walk(dir: string, depth: number): Promise<void> {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          lines.push(`${'  '.repeat(depth)}- (cannot read directory)`);
          return;
        }
        const visible = entries.filter((e) => !ignoreMatch(e.name) && !ignoreMatch(slash(path.relative(root, path.join(dir, e.name)))));
        visible.sort((a, b) => {
          const da = a.isDirectory() ? 0 : 1;
          const db = b.isDirectory() ? 0 : 1;
          return da - db || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        const perDirCap = depth === 0 ? MAX_LINES : MAX_PER_SUBDIR;
        let shownHere = 0;
        for (const e of visible) {
          if (lines.length >= MAX_LINES) {
            capped = true;
            hidden += visible.length - shownHere;
            return;
          }
          if (shownHere >= perDirCap) {
            hidden += visible.length - shownHere;
            lines.push(`${'  '.repeat(depth + 1)}- … ${visible.length - shownHere} more entries`);
            return;
          }
          shownHere++;
          const indent = '  '.repeat(depth + 1);
          if (e.isDirectory()) {
            const skipped = SKIP_DIRS.has(e.name);
            lines.push(`${indent}- ${e.name}/${skipped ? ' (not expanded)' : ''}`);
            if (!skipped && depth + 1 < MAX_DEPTH) await walk(path.join(dir, e.name), depth + 1);
          } else {
            lines.push(`${indent}- ${e.name}`);
          }
        }
      }

      await walk(root, 0);
      const header = `- ${slash(root)}/`;
      let content = [header, ...lines].join('\n');
      if (lines.length === 0) content += '\n  (empty directory)';
      if (capped || hidden > 0) content += `\n\n(Some entries are not shown${capped ? ' (output limit reached)' : ''}. LS a subdirectory, or use Glob/Grep, to see more.)`;
      return ok(content, { display: { kind: 'list', title: `LS ${displayPath(root, ctx.cwd)}`, items: lines } });
    },
  },
  { aliases: { path: ['directory', 'dir', 'folder', 'directory_path'] } },
);
