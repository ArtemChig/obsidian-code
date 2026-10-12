// Reading/writing text files while preserving encoding, BOM and line endings.

import fs from 'node:fs/promises';
import { hashBuffer } from './fileState';
import { detectEol, toCrlf, toLf } from './text';

export type TextEncoding = 'utf8' | 'utf16le' | 'latin1';

export interface TextFile {
  /** Decoded text with its original line endings. */
  text: string;
  encoding: TextEncoding;
  bom: boolean;
  /** Dominant line ending. */
  eol: 'crlf' | 'lf';
  mtimeMs: number;
  size: number;
  /** sha1 of the raw bytes on disk (see fileState.hashBuffer). */
  hash: string;
}

export class BinaryFileError extends Error {
  constructor(message = 'File appears to be binary') {
    super(message);
    this.name = 'BinaryFileError';
  }
}

const BINARY_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'obj', 'a', 'lib', 'class', 'jar', 'war', 'pyc', 'pyo', 'wasm',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'iso', 'dmg', 'msi', 'cab',
  'mp3', 'mp4', 'mkv', 'avi', 'mov', 'wav', 'flac', 'ogg', 'webm', 'm4a',
  'ico', 'bmp', 'tiff', 'tif', 'psd', 'heic', 'avif',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'mdb', 'dat', 'pak', 'node', 'gguf', 'safetensors', 'pt', 'pth', 'onnx', 'npy', 'npz',
  'doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx', 'odt', 'ods',
]);

export function hasBinaryExtension(file: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  return !!m && BINARY_EXTENSIONS.has(m[1].toLowerCase());
}

/** Heuristic: NUL bytes or many control characters in the first 8 KB. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  }
  return ctrl / n > 0.3;
}

export function decodeBuffer(buf: Buffer): { text: string; encoding: TextEncoding; bom: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
  }
  if (looksBinary(buf)) throw new BinaryFileError();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf8', bom: false };
  } catch {
    // Not valid UTF-8 (e.g. Windows-1252 source). latin1 round-trips every byte losslessly.
    return { text: buf.toString('latin1'), encoding: 'latin1', bom: false };
  }
}

export function encodeText(text: string, encoding: TextEncoding, bom: boolean): Buffer {
  if (encoding === 'utf16le') {
    const body = Buffer.from(text, 'utf16le');
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
  }
  if (encoding === 'latin1') return Buffer.from(text, 'latin1');
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/** True when `text` cannot be represented in the encoding without loss. */
export function lossyForEncoding(text: string, encoding: TextEncoding): boolean {
  if (encoding !== 'latin1') return false;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) return true;
  return false;
}

export async function readTextFile(abs: string): Promise<TextFile> {
  const st = await fs.stat(abs);
  const buf = await fs.readFile(abs);
  const d = decodeBuffer(buf);
  return { ...d, eol: detectEol(d.text), mtimeMs: st.mtimeMs, size: st.size, hash: hashBuffer(buf) };
}

export async function writeTextFile(abs: string, text: string, meta: { encoding: TextEncoding; bom: boolean }): Promise<{ mtimeMs: number; hash: string }> {
  const buf = encodeText(text, meta.encoding, meta.bom);
  await fs.writeFile(abs, buf);
  const st = await fs.stat(abs);
  return { mtimeMs: st.mtimeMs, hash: hashBuffer(buf) };
}

/** Convert model-provided text to the line ending convention of an existing file. */
export function applyEol(text: string, eol: 'crlf' | 'lf'): string {
  return eol === 'crlf' ? toCrlf(text) : toLf(text);
}
