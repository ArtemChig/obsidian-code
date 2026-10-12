// SecretStore (owner: platform): <dataDir>/secrets.json holds encrypted values only.
//   mode 'native' — encrypted by the NativeBridge (Electron safeStorage / DPAPI);
//   mode 'aes'    — AES-256-GCM with a random 32-byte key in <dataDir>/secret.key (standalone fallback).
// Values are decrypted lazily on get(). A 'native' value cannot be read without the native bridge (standalone core
// started against an Electron data dir) — get() then returns null and logs once.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeBridge, SecretStore } from '../contracts';
import { isPlainObject, readJsonSync, writeFileAtomicSync } from './fsutil';

interface SecretEntry {
  m: 'native' | 'aes';
  d: string; // base64
}
interface SecretsFile {
  version: 1;
  values: Record<string, SecretEntry>;
}

export interface SecretStoreImpl extends SecretStore {
  readonly file: string;
  /** Encryption mode used for new values. */
  readonly mode: 'native' | 'aes';
  names(): string[];
}

export function createSecretStore(dataDir: string, native: NativeBridge): SecretStoreImpl {
  const file = join(dataDir, 'secrets.json');
  const keyFile = join(dataDir, 'secret.key');
  const nativeOk = typeof native.encrypt === 'function' && typeof native.decrypt === 'function';
  const mode: 'native' | 'aes' = nativeOk ? 'native' : 'aes';

  const raw = readJsonSync<unknown>(file);
  const values: Record<string, SecretEntry> = {};
  if (isPlainObject(raw) && isPlainObject(raw.values)) {
    for (const [k, v] of Object.entries(raw.values)) {
      if (isPlainObject(v) && (v.m === 'native' || v.m === 'aes') && typeof v.d === 'string') values[k] = { m: v.m, d: v.d };
    }
  }
  const cache = new Map<string, string>();
  const warned = new Set<string>();

  let aesKey: Buffer | null = null;
  const getKey = (create: boolean): Buffer | null => {
    if (aesKey) return aesKey;
    if (existsSync(keyFile)) {
      const buf = readFileSync(keyFile);
      if (buf.length === 32) return (aesKey = buf);
      const fromB64 = Buffer.from(buf.toString('utf8').trim(), 'base64');
      if (fromB64.length === 32) return (aesKey = fromB64);
      console.error('[secrets] secret.key is malformed');
      if (!create) return null;
    }
    if (!create) return null;
    const key = randomBytes(32);
    writeFileAtomicSync(keyFile, key);
    return (aesKey = key);
  };

  const encrypt = (plain: string): SecretEntry => {
    if (nativeOk) return { m: 'native', d: native.encrypt!(plain).toString('base64') };
    const key = getKey(true)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { m: 'aes', d: Buffer.concat([iv, tag, ct]).toString('base64') };
  };

  const decrypt = (name: string, e: SecretEntry): string | null => {
    try {
      const buf = Buffer.from(e.d, 'base64');
      if (e.m === 'native') {
        if (!nativeOk) {
          if (!warned.has(name)) {
            warned.add(name);
            console.error(`[secrets] "${name}" was stored with OS encryption and cannot be read without the desktop app`);
          }
          return null;
        }
        return native.decrypt!(buf);
      }
      const key = getKey(false);
      if (!key || buf.length < 28) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    } catch (err) {
      if (!warned.has(name)) {
        warned.add(name);
        console.error(`[secrets] failed to decrypt "${name}":`, err instanceof Error ? err.message : err);
      }
      return null;
    }
  };

  const persist = (): void => {
    const data: SecretsFile = { version: 1, values };
    writeFileAtomicSync(file, JSON.stringify(data, null, 2));
  };

  return {
    file,
    mode,
    get(name) {
      if (cache.has(name)) return cache.get(name)!;
      const e = values[name];
      if (!e) return null;
      const v = decrypt(name, e);
      if (v !== null) cache.set(name, v);
      return v;
    },
    set(name, value) {
      if (value === null || value === '') {
        if (!(name in values)) return;
        delete values[name];
        cache.delete(name);
      } else {
        values[name] = encrypt(value);
        cache.set(name, value);
      }
      warned.delete(name);
      persist();
    },
    has(name) {
      return name in values;
    },
    names() {
      return Object.keys(values);
    },
  };
}
