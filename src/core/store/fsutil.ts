// Small file helpers shared by the stores (owner: platform): atomic writes (tmp file + rename, with retries for
// transient Windows locks from antivirus / indexers) and tolerant JSON reads.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RETRIES = 8;

const tmpName = (file: string): string => `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomicSync(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RETRIES || !RETRY_CODES.has(code)) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
        throw err;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RETRIES || !RETRY_CODES.has(code)) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

/** Read and parse a JSON file; returns `undefined` when missing or unparsable (logged). */
export function readJsonSync<T = unknown>(file: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch (err) {
    console.error(`[store] invalid JSON in ${file}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
