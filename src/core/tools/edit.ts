import fs from 'node:fs/promises';
import { defineTool, fail, ok } from './types';
import { applyEdit } from './lib/editing';
import { persistFile, prepareExisting, snippetAround } from './lib/fileops';
import { displayPath, resolvePath } from './lib/paths';
import { lineCount } from './lib/diff';

type EditInput = { file_path: string; old_string: string; new_string: string; replace_all?: boolean };

export const editTool = defineTool<EditInput>(
  {
    name: 'Edit',
    description:
      'Replace exact text in a file you have Read. old_string must match exactly, including whitespace (never include Read\'s line-number prefixes), ' +
      'and be unique in the file unless replace_all is true (otherwise add surrounding lines). CRLF/LF endings are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement (must differ)' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    concurrencySafe: false,
    permission: () => 'edit',
    title: (i) => `Edit ${i.file_path ?? ''}`.trim(),
    ruleFor: () => 'Edit',

    async run(input, ctx) {
      const abs = resolvePath(input.file_path, ctx.cwd);
      const shown = displayPath(abs, ctx.cwd);
      if (input.old_string === input.new_string) return fail('No changes to make: old_string and new_string are exactly the same.');

      let exists = true;
      try {
        await fs.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw e;
      }

      if (!exists) {
        if (input.old_string !== '') return fail(`File does not exist: ${shown}. To create a file use Write.`);
        const r = await persistFile({ ctx, abs, text: input.new_string, previous: '', isNew: true, encoding: 'utf8', bom: false });
        if ('error' in r) return r.error;
        return ok(`File created: ${shown} (${lineCount(input.new_string)} lines).`, { display: r.display });
      }

      const prep = await prepareExisting(ctx, abs, shown, 'Edit');
      if (!prep.ok) return prep.result;
      const { file } = prep;

      if (input.old_string === '') {
        if (file.text.trim() !== '') return fail('old_string is empty but the file is not. Provide the text to replace (or use Write to overwrite the file).');
        const r = await persistFile({ ctx, abs, text: input.new_string, previous: file.text, isNew: false, encoding: file.encoding, bom: file.bom });
        if ('error' in r) return r.error;
        return ok(`File updated: ${shown}.`, { display: r.display });
      }

      const res = applyEdit(file.text, { old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }, file.eol);
      if (!res.ok) return fail(res.error);
      const r = await persistFile({ ctx, abs, text: res.text, previous: file.text, isNew: false, encoding: file.encoding, bom: file.bom });
      if ('error' in r) return r.error;
      const what = res.replacements > 1 ? `${res.replacements} replacements` : '1 replacement';
      const snippet = snippetAround(res.text, res.line, res.newLines);
      return ok(`Edited ${shown} (${what}, +${r.additions} -${r.deletions} lines).${res.note ? `\n${res.note}` : ''}\n${snippet}`, { display: r.display });
    },
  },
  { aliases: { file_path: ['path', 'filepath', 'filename', 'file', 'filePath'], old_string: ['old', 'old_text', 'oldString', 'search'], new_string: ['new', 'new_text', 'newString', 'replace', 'replacement'] } },
);
