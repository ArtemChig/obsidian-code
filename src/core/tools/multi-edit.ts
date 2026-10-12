import fs from 'node:fs/promises';
import { defineTool, fail, ok } from './types';
import { applyEdit, type EditSpec } from './lib/editing';
import { persistFile, prepareExisting, snippetAround } from './lib/fileops';
import { displayPath, resolvePath } from './lib/paths';
import { lineCount } from './lib/diff';

type MultiEditInput = { file_path: string; edits: EditSpec[] };

export const multiEditTool = defineTool<MultiEditInput>(
  {
    name: 'MultiEdit',
    description:
      'Several Edits to one file, applied in order and atomically (if one fails nothing is written; each sees the previous result). Same rules as Edit; the file must be Read first.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path' },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['file_path', 'edits'],
    },
    concurrencySafe: false,
    permission: () => 'edit',
    title: (i) => `Edit ${i.file_path ?? ''}${Array.isArray(i.edits) ? ` (${i.edits.length} edits)` : ''}`.trim(),
    ruleFor: () => 'MultiEdit',

    async run(input, ctx) {
      const abs = resolvePath(input.file_path, ctx.cwd);
      const shown = displayPath(abs, ctx.cwd);
      const edits = input.edits;
      if (!edits.length) return fail('edits must contain at least one edit.');

      let exists = true;
      try {
        await fs.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw e;
      }

      // Creating a new file: first edit has an empty old_string.
      if (!exists) {
        if (edits[0].old_string !== '') return fail(`File does not exist: ${shown}. To create it, make the first edit's old_string empty, or use Write.`);
        let text = edits[0].new_string;
        for (let i = 1; i < edits.length; i++) {
          const r = applyEdit(text, edits[i], 'lf');
          if (!r.ok) return fail(`Edit ${i + 1} of ${edits.length} failed: ${r.error}\nNo changes were written.`);
          text = r.text;
        }
        const w = await persistFile({ ctx, abs, text, previous: '', isNew: true, encoding: 'utf8', bom: false });
        if ('error' in w) return w.error;
        return ok(`File created: ${shown} (${lineCount(text)} lines).`, { display: w.display });
      }

      const prep = await prepareExisting(ctx, abs, shown, 'MultiEdit');
      if (!prep.ok) return prep.result;
      const { file } = prep;

      let text = file.text;
      let total = 0;
      let lastLine = 1;
      let lastSpan = 1;
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        if (e.old_string === '' && text.trim() === '' && i === 0) {
          text = e.new_string;
          total++;
          continue;
        }
        const r = applyEdit(text, e, file.eol);
        if (!r.ok) return fail(`Edit ${i + 1} of ${edits.length} failed: ${r.error}\nNo changes were written (earlier edits in this call were not applied either).`);
        text = r.text;
        total += r.replacements;
        lastLine = r.line;
        lastSpan = r.newLines;
      }
      if (text === file.text) return fail('The edits result in no change to the file.');
      const w = await persistFile({ ctx, abs, text, previous: file.text, isNew: false, encoding: file.encoding, bom: file.bom });
      if ('error' in w) return w.error;
      return ok(`Applied ${edits.length} edit(s) to ${shown} (${total} replacement(s), +${w.additions} -${w.deletions} lines). Last change:\n${snippetAround(text, lastLine, lastSpan)}`, { display: w.display });
    },
  },
  { aliases: { file_path: ['path', 'filepath', 'filename', 'file', 'filePath'] } },
);
