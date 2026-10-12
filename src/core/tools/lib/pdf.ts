// Best-effort PDF text extraction without native dependencies: inflate content streams and pull text-showing
// operators (Tj, TJ, ', "). Works for most text PDFs with simple font encodings; scanned/CID-encoded PDFs yield little.

import { inflateSync, inflateRawSync } from 'node:zlib';

export interface PdfText { pages: string[]; text: string; pageCount: number; usable: boolean }

// Hostile PDFs (a few MB of FlateDecode zeros inflate to GBs) must not exhaust memory in the main process.
/** Max inflated size of one stream. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** Max inflated bytes across all streams of one document. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Max content streams examined per document. */
const MAX_STREAMS = 5000;
/** Max extracted text (characters) per document. */
const MAX_TEXT_CHARS = 4 * 1024 * 1024;

function unescapePdfString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    switch (n) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '(': case ')': case '\\': out += n; break;
      case '\r': if (s[i + 1] === '\n') i++; break;
      case '\n': break;
      default:
        if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else out += n;
    }
  }
  return out;
}

function decodeHexString(h: string): string {
  const hex = h.replace(/\s+/g, '');
  const padded = hex.length % 2 ? `${hex}0` : hex;
  const bytes = Buffer.from(padded, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  // Two-byte glyph ids can't be mapped without the font; treat as latin1 only when it looks like text.
  return bytes.toString('latin1');
}

function extractFromContent(content: string): string {
  const out: string[] = [];
  const bt = /BT([\s\S]*?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = bt.exec(content))) {
    const block = m[1];
    const tokens = /\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^)\\])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]+)>\s*Tj|(T\*|Td|TD|Tm)/g;
    let t: RegExpExecArray | null;
    let line = '';
    while ((t = tokens.exec(block))) {
      if (t[1] !== undefined) {
        const parts = /\(((?:\\.|[^)\\])*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g;
        let p: RegExpExecArray | null;
        while ((p = parts.exec(t[1]))) {
          if (p[1] !== undefined) line += unescapePdfString(p[1]);
          else if (p[2] !== undefined) line += decodeHexString(p[2]);
          else if (p[3] !== undefined && Number(p[3]) < -200) line += ' ';
        }
      } else if (t[2] !== undefined) line += unescapePdfString(t[2]);
      else if (t[3] !== undefined) line += decodeHexString(t[3]);
      else if (t[4] !== undefined) {
        if (line.trim()) out.push(line);
        line = '';
      }
    }
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}

function inflateStream(data: Buffer, maxOutputLength: number): Buffer | null {
  if (maxOutputLength <= 0) return null;
  // over the limit → RangeError → stream skipped
  try { return inflateSync(data, { maxOutputLength }); } catch { /* try raw */ }
  try { return inflateRawSync(data, { maxOutputLength }); } catch { return null; }
}

export function extractPdfText(buf: Buffer): PdfText {
  const src = buf.toString('latin1');
  const pageCount = (src.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const pages: string[] = [];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let streams = 0;
  let inflatedTotal = 0;
  let textChars = 0;
  while ((m = streamRe.exec(src))) {
    if (++streams > MAX_STREAMS || inflatedTotal >= MAX_TOTAL_BYTES || textChars >= MAX_TEXT_CHARS) break;
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end === -1) break;
    const dictStart = src.lastIndexOf('obj', m.index);
    const dict = src.slice(dictStart === -1 ? Math.max(0, m.index - 300) : dictStart, m.index);
    streamRe.lastIndex = end + 9;
    if (/\/Subtype\s*\/(Image|Form|Type1C|CIDFontType0C|OpenType)/.test(dict) || /\/Type\s*\/(XRef|ObjStm|Metadata|EmbeddedFile)/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      const inflated = inflateStream(data, Math.min(MAX_STREAM_BYTES, MAX_TOTAL_BYTES - inflatedTotal));
      if (!inflated) continue;
      inflatedTotal += inflated.length;
      data = inflated;
    } else if (/\/Filter/.test(dict)) continue;
    const content = data.toString('latin1');
    if (!content.includes('BT')) continue;
    const text = extractFromContent(content);
    if (text.trim()) {
      pages.push(text);
      textChars += text.length;
    }
  }
  const text = pages.join('\n\n');
  const printable = text.replace(/[^\x20-\x7e -￿\n]/g, '').length;
  return { pages, text, pageCount, usable: text.trim().length >= 20 && printable / Math.max(1, text.length) > 0.8 };
}
