// KvStore (owner: platform): small JSON records in <dataDir>/kv/<key>.json (gpu ledger, schedules, …).
// Writes are synchronous + atomic; reads are cached and returned as deep clones.

import { join } from 'node:path';
import type { KvStore } from '../contracts';
import { readJsonSync, writeFileAtomicSync } from './fsutil';

export function kvFileName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${safe || '_'}.json`;
}

export function createKvStore(dataDir: string): KvStore & { readonly dir: string } {
  const dir = join(dataDir, 'kv');
  const cache = new Map<string, unknown>();
  return {
    dir,
    read<T>(key: string, fallback: T): T {
      if (cache.has(key)) return structuredClone(cache.get(key)) as T;
      const v = readJsonSync<T>(join(dir, kvFileName(key)));
      if (v === undefined) return fallback;
      cache.set(key, v);
      return structuredClone(v);
    },
    write<T>(key: string, value: T): void {
      const json = JSON.stringify(value ?? null, null, 1);
      writeFileAtomicSync(join(dir, kvFileName(key)), json);
      cache.set(key, JSON.parse(json));
    },
  };
}
