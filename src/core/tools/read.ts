import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { defineTool, fail, ok, type ToolContext, type ToolResultPayload } from './types';
import { markRead, hashBuffer } from './lib/fileState';
import { displayPath, resolvePath } from './lib/paths';
import { extractPdfText } from './lib/pdf';
import { BinaryFileError, decodeBuffer, hasBinaryExtension, looksBinary } from './lib/textfile';
import { catN, splitLines, truncateLine, truncateEnd } from './lib/text';

type ReadInput = { file_path: string; offset?: number; limit?: number };

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const STREAM_THRESHOLD = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function maxChars(ctx: ToolContext): number {
  const n = ctx.settings?.maxToolOutputChars;
  return typeof n === 'number' && n > 1000 ? n : 30000;
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

async function notFound(abs: string, shown: string, cwd: string): Promise<ToolResultPayload> {
  const dir = path.dirname(abs);
  const base = path.basename(abs).toLowerCase();
  let hint = '';
  try {
    const entries = await fs.readdir(dir);
    const stem = base.replace(/\.[^.]+$/, '');
    const similar = entries
      .map((e) => ({ e, d: lev(e.toLowerCase(), base), stemEq: e.toLowerCase().replace(/\.[^.]+$/, '') === stem }))
      .filter((x) => x.stemEq || x.d <= Math.max(2, Math.floor(base.length / 4)))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.e);
    if (similar.length) hint = ` Did you mean: ${similar.join(', ')}?`;
  } catch {
    hint = ` The directory ${displayPath(dir, cwd)} does not exist.`;
  }
  return fail(`File does not exist: ${shown}.${hint} (working directory: ${cwd.replace(/\\/g, '/')})`);
}

function renderNotebook(raw: string): { text: string; images: { mediaType: string; data: string }[] } {
  let nb: { cells?: Record<string, unknown>[] };
  try {
    nb = JSON.parse(raw);
  } catch {
    return { text: '(invalid notebook JSON)\n' + raw.slice(0, 2000), images: [] };
  }
  const images: { mediaType: string; data: string }[] = [];
  const src = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
  const parts: string[] = [];
  (nb.cells ?? []).forEach((cell, i) => {
    const type = String(cell.cell_type ?? 'code');
    const id = cell.id ? `, id: ${String(cell.id)}` : '';
    let block = `--- Cell ${i} (${type}${id}) ---\n${src(cell.source)}`;
    const outputs = Array.isArray(cell.outputs) ? (cell.outputs as Record<string, unknown>[]) : [];
    for (const o of outputs) {
      const ot = String(o.output_type ?? '');
      if (ot === 'stream') block += `\n[output]\n${truncateEnd(src(o.text), 3000)}`;
      else if (ot === 'error') block += `\n[error] ${String(o.ename ?? '')}: ${String(o.evalue ?? '')}`;
      else {
        const data = (o.data ?? {}) as Record<string, unknown>;
        if (data['text/plain']) block += `\n[output]\n${truncateEnd(src(data['text/plain']), 3000)}`;
        for (const mt of ['image/png', 'image/jpeg']) {
          if (typeof data[mt] === 'string' && images.length < 4) {
            images.push({ mediaType: mt, data: String(data[mt]).replace(/\s+/g, '') });
            block += `\n[image output ${images.length}]`;
          }
        }
      }
    }
    parts.push(block);
  });
  return { text: parts.join('\n\n') || '(notebook has no cells)', images };
}

async function readLinesStreaming(abs: string, start: number, limit: number): Promise<{ lines: string[]; total: number }> {
  const rl = readline.createInterface({ input: createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines: string[] = [];
  let n = 0;
  for await (const line of rl) {
    n++;
    if (n >= start && lines.length < limit) lines.push(line);
  }
  return { lines, total: n };
}

export const readTool = defineTool<ReadInput>(
  {
    name: 'Read',
    description:
      'Read a file (lines numbered cat -n style, up to 2000 per call; use offset/limit for more). Also reads images, PDFs and .ipynb notebooks. ' +
      'Paths: absolute or relative to the working directory. Read a file before you Edit or overwrite it.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path' },
        offset: { type: 'integer', description: 'First line to read (1-based)' },
        limit: { type: 'integer', description: 'Number of lines (default 2000)' },
      },
      required: ['file_path'],
    },
    concurrencySafe: true,
    permission: () => 'read',
    title: (i) => `Read ${i.file_path ?? ''}`.trim(),
    ruleFor: () => 'Read',

    async run(input, ctx) {
      const abs = resolvePath(input.file_path, ctx.cwd);
      const shown = displayPath(abs, ctx.cwd);
      let st;
      try {
        st = await fs.stat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return notFound(abs, shown, ctx.cwd);
        throw e;
      }
      if (st.isDirectory()) return fail(`${shown} is a directory, not a file. Use the LS tool to list it.`);
      const ext = path.extname(abs).slice(1).toLowerCase();
      const budget = maxChars(ctx);

      // images
      if (IMAGE_TYPES[ext]) {
        if (st.size > MAX_IMAGE_BYTES) return fail(`Image is too large (${(st.size / 1048576).toFixed(1)} MB, max 5 MB): ${shown}`);
        const buf = await fs.readFile(abs);
        markRead(ctx, abs, st.mtimeMs, hashBuffer(buf));
        return ok(`Image file ${shown} (${IMAGE_TYPES[ext]}, ${buf.length} bytes) attached below.`, {
          images: [{ mediaType: IMAGE_TYPES[ext], data: buf.toString('base64') }],
          display: { kind: 'markdown', markdown: `Image: \`${shown}\` (${(buf.length / 1024).toFixed(0)} KB)` },
        });
      }

      // PDF
      if (ext === 'pdf') {
        if (st.size > MAX_PDF_BYTES) return fail(`PDF is too large (${(st.size / 1048576).toFixed(1)} MB): ${shown}`);
        const buf = await fs.readFile(abs);
        markRead(ctx, abs, st.mtimeMs, hashBuffer(buf));
        const pdf = extractPdfText(buf);
        if (!pdf.usable) {
          return fail(`Could not extract text from ${shown} (${pdf.pageCount || '?'} pages). It may be scanned images or use embedded font encodings. Try a command-line tool such as pdftotext via Bash.`);
        }
        const text = truncateEnd(pdf.text, budget, '… [PDF text truncated]');
        return ok(`PDF ${shown}: ${pdf.pageCount || pdf.pages.length} page(s), best-effort text extraction.\n\n${text}`, {
          display: { kind: 'file', path: abs, content: text, startLine: 1, totalLines: text.split('\n').length },
        });
      }

      // notebooks
      if (ext === 'ipynb') {
        const buf = await fs.readFile(abs);
        markRead(ctx, abs, st.mtimeMs, hashBuffer(buf));
        const nb = renderNotebook(buf.toString('utf8').replace(/^﻿/, ''));
        const text = truncateEnd(nb.text, budget, '… [notebook output truncated]');
        return ok(text, {
          images: nb.images.length ? nb.images : undefined,
          display: { kind: 'file', path: abs, content: text, startLine: 1, totalLines: text.split('\n').length },
        });
      }

      if (hasBinaryExtension(abs)) {
        return fail(`Cannot read ${shown}: .${ext} is a binary file type. Use Bash to inspect it (e.g. file, strings, hexdump) if needed.`);
      }

      const start = Math.max(1, input.offset ?? 1);
      const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 20000) : DEFAULT_LIMIT;
      let lines: string[];
      let total: number;
      if (st.size > STREAM_THRESHOLD) {
        const fh = await fs.open(abs, 'r');
        try {
          const head = Buffer.alloc(8192);
          const { bytesRead } = await fh.read(head, 0, 8192, 0);
          if (looksBinary(head.subarray(0, bytesRead))) return fail(`Cannot read ${shown}: the file appears to be binary.`);
        } finally {
          await fh.close();
        }
        ({ lines, total } = await readLinesStreaming(abs, start, limit));
        markRead(ctx, abs, st.mtimeMs);
      } else {
        const buf = await fs.readFile(abs);
        let text: string;
        try {
          text = decodeBuffer(buf).text;
        } catch (e) {
          if (e instanceof BinaryFileError) return fail(`Cannot read ${shown}: the file appears to be binary.`);
          throw e;
        }
        markRead(ctx, abs, st.mtimeMs, hashBuffer(buf));
        const all = splitLines(text);
        total = all.length;
        lines = all.slice(start - 1, start - 1 + limit);
      }

      if (total === 0) {
        return ok('<system-reminder>Warning: the file exists but its contents are empty.</system-reminder>', {
          display: { kind: 'file', path: abs, content: '', startLine: 1, totalLines: 0 },
        });
      }
      if (lines.length === 0) {
        return ok(`<system-reminder>Warning: the file has only ${total} line(s); offset ${start} is past the end.</system-reminder>`);
      }

      // Cap the rendered size, cutting at a line boundary so the model can continue with offset.
      const rendered: string[] = [];
      let used = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = truncateLine(lines[i], MAX_LINE_CHARS);
        const cost = line.length + 8;
        if (used + cost > budget && rendered.length > 0) break;
        rendered.push(line);
        used += cost;
      }
      const lastShown = start + rendered.length - 1;
      let content = catN(rendered, start);
      if (lastShown < total) {
        content += `\n\n[Showing lines ${start}-${lastShown} of ${total}. Use offset=${lastShown + 1} to continue reading.]`;
      }
      return ok(content, {
        display: { kind: 'file', path: abs, content: rendered.join('\n'), startLine: start, totalLines: total },
      });
    },
  },
  { aliases: { file_path: ['path', 'filepath', 'filename', 'file', 'filePath', 'absolute_path'] } },
);
