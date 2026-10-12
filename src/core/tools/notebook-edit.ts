import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { defineTool, fail, ok } from './types';
import { countChanges, diffDisplay } from './lib/diff';
import { persistFile, prepareExisting } from './lib/fileops';
import { displayPath, resolvePath } from './lib/paths';

type NotebookEditInput = {
  notebook_path: string;
  new_source?: string;
  cell_id?: string;
  cell_number?: number;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
};

type Cell = Record<string, unknown> & { cell_type: string; source: string[] | string; id?: string };

function sourceText(cell: Cell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
}

/** nbformat stores source as lines that keep their trailing newline (except the last). */
function toSourceLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  return parts.map((p, i) => (i < parts.length - 1 ? `${p}\n` : p)).filter((p, i, a) => !(i === a.length - 1 && p === ''));
}

export const notebookEditTool = defineTool<NotebookEditInput>(
  {
    name: 'NotebookEdit',
    description:
      'Edit a cell of a .ipynb notebook you have Read. edit_mode: replace (default; clears outputs), insert (new cell after the given cell, or at the start; needs cell_type), delete. ' +
      'Address cells by cell_id (shown by Read) or 0-based cell_number.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        new_source: { type: 'string', description: 'Cell source (not needed for delete)' },
        cell_id: { type: 'string' },
        cell_number: { type: 'integer', description: '0-based' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['notebook_path'],
    },
    concurrencySafe: false,
    permission: () => 'edit',
    title: (i) => `Edit notebook ${i.notebook_path ?? ''}`.trim(),
    ruleFor: () => 'NotebookEdit',

    async run(input, ctx) {
      const abs = resolvePath(input.notebook_path, ctx.cwd);
      const shown = displayPath(abs, ctx.cwd);
      if (!abs.toLowerCase().endsWith('.ipynb')) return fail(`${shown} is not a .ipynb notebook. Use Edit for other files.`);
      try {
        await fs.stat(abs);
      } catch {
        return fail(`Notebook does not exist: ${shown}`);
      }
      const mode = input.edit_mode ?? 'replace';
      if (mode !== 'delete' && input.new_source === undefined) return fail(`new_source is required for edit_mode "${mode}".`);
      if (mode === 'insert' && !input.cell_type) return fail('cell_type ("code" or "markdown") is required when inserting a cell.');

      const prep = await prepareExisting(ctx, abs, shown, 'NotebookEdit');
      if (!prep.ok) return prep.result;
      const { file } = prep;

      let nb: { cells: Cell[]; nbformat?: number; nbformat_minor?: number } & Record<string, unknown>;
      try {
        nb = JSON.parse(file.text);
      } catch (e) {
        return fail(`${shown} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!Array.isArray(nb.cells)) return fail(`${shown} has no "cells" array.`);

      // locate the target cell
      let index = -1;
      if (input.cell_id !== undefined) {
        index = nb.cells.findIndex((c) => c.id === input.cell_id);
        if (index === -1 && /^\d+$/.test(input.cell_id) && input.cell_number === undefined) index = Number(input.cell_id);
        if (index === -1 || index >= nb.cells.length) return fail(`No cell with id "${input.cell_id}" in ${shown} (${nb.cells.length} cells). Read the notebook to see cell ids.`);
      } else if (input.cell_number !== undefined) {
        index = input.cell_number;
        if (index < 0 || index >= nb.cells.length) {
          if (!(mode === 'insert' && index === nb.cells.length)) return fail(`cell_number ${index} is out of range (notebook has ${nb.cells.length} cells, numbered from 0).`);
        }
      } else if (mode !== 'insert') {
        return fail('Specify cell_id or cell_number to identify the cell.');
      }

      const hasIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
      const newId = () => randomBytes(4).toString('hex');
      let before = '';
      let after = '';
      let message: string;

      if (mode === 'delete') {
        before = sourceText(nb.cells[index]);
        const type = nb.cells[index].cell_type;
        nb.cells.splice(index, 1);
        message = `Deleted ${type} cell ${index} from ${shown}.`;
      } else if (mode === 'insert') {
        const at = input.cell_id !== undefined || input.cell_number !== undefined ? index + 1 : 0;
        const type = input.cell_type!;
        const cell: Cell = { cell_type: type, metadata: {}, source: toSourceLines(input.new_source!) };
        if (type === 'code') {
          cell.execution_count = null;
          cell.outputs = [];
        }
        if (hasIds) cell.id = newId();
        nb.cells.splice(at, 0, cell);
        after = input.new_source!;
        message = `Inserted a new ${type} cell at position ${at} in ${shown}${cell.id ? ` (id: ${cell.id})` : ''}.`;
      } else {
        const cell = nb.cells[index];
        before = sourceText(cell);
        after = input.new_source!;
        cell.source = toSourceLines(after);
        const newType = input.cell_type ?? cell.cell_type;
        if (newType !== cell.cell_type) cell.cell_type = newType;
        if (newType === 'code') {
          cell.execution_count = null;
          cell.outputs = [];
        } else {
          delete cell.execution_count;
          delete cell.outputs;
        }
        message = `Replaced the source of ${newType} cell ${index} in ${shown}.`;
      }

      // serialise, matching the original formatting
      const indent = /^(\s+)"cells"/m.exec(file.text)?.[1].length ?? 1;
      let text = JSON.stringify(nb, null, indent);
      if (/\n$/.test(file.text)) text += '\n';
      if (file.eol === 'crlf') text = text.replace(/\n/g, '\r\n');

      // The Changes panel counts the cell's lines rather than the JSON scaffolding.
      const counts = countChanges(before, after);
      const w = await persistFile({ ctx, abs, text, previous: file.text, isNew: false, encoding: file.encoding, bom: file.bom, counts });
      if ('error' in w) return w.error;
      return ok(message, { display: diffDisplay(abs, before, after) });
    },
  },
  { aliases: { notebook_path: ['path', 'file_path', 'notebook', 'file'], new_source: ['source', 'content', 'new_content'] } },
);
