import fs from 'node:fs/promises';
import { defineTool, fail, ok } from './types';
import { persistFile, prepareExisting } from './lib/fileops';
import { displayPath, resolvePath } from './lib/paths';
import { applyEol } from './lib/textfile';
import { lineCount } from './lib/diff';

type WriteInput = { file_path: string; content: string };

export const writeTool = defineTool<WriteInput>(
  {
    name: 'Write',
    description:
      'Create a file or overwrite it completely (parent directories are created). Overwriting requires reading the file first; prefer Edit for changes to existing files. ' +
      'Do not create documentation files unless asked.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['file_path', 'content'],
    },
    concurrencySafe: false,
    permission: () => 'edit',
    title: (i) => `Write ${i.file_path ?? ''}`.trim(),
    ruleFor: () => 'Write',

    async run(input, ctx) {
      const abs = resolvePath(input.file_path, ctx.cwd);
      const shown = displayPath(abs, ctx.cwd);
      let exists = true;
      try {
        await fs.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw e;
      }

      if (!exists) {
        const r = await persistFile({ ctx, abs, text: input.content, previous: '', isNew: true, encoding: 'utf8', bom: false });
        if ('error' in r) return r.error;
        return ok(`File created successfully: ${shown} (${lineCount(input.content)} lines).`, { display: r.display });
      }

      const prep = await prepareExisting(ctx, abs, shown, 'Write');
      if (!prep.ok) return prep.result;
      const { file } = prep;
      const text = applyEol(input.content, file.eol);
      if (text === file.text) return fail(`No changes: ${shown} already has exactly this content.`);
      const r = await persistFile({ ctx, abs, text, previous: file.text, isNew: false, encoding: file.encoding, bom: file.bom });
      if ('error' in r) return r.error;
      return ok(`File updated: ${shown} (+${r.additions} -${r.deletions} lines).`, { display: r.display });
    },
  },
  { aliases: { file_path: ['path', 'filepath', 'filename', 'file', 'filePath'], content: ['text', 'contents', 'data', 'file_content'] } },
);
