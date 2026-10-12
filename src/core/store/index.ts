// Persistence entry point (owner: platform). See SPEC §2.1.

import { mkdirSync } from 'node:fs';
import type { KvStore, NativeBridge, SecretStore, SessionStore, SettingsStore } from '../contracts';
import { createKvStore } from './kv';
import { createSecretStore } from './secrets';
import { createSessionStore } from './sessions';
import { createSettingsStore } from './settings';

export { createKvStore, kvFileName } from './kv';
export { createSecretStore } from './secrets';
export { createSessionStore, toSummary, SESSION_WRITE_DEBOUNCE_MS } from './sessions';
export {
  createSettingsStore,
  deepMerge,
  defaultGpuProfiles,
  defaultSettings,
  normalizeHooks,
  projectSettingsFile,
  validateSettings,
} from './settings';
export { writeFileAtomic, writeFileAtomicSync } from './fsutil';

export function createStores(
  dataDir: string,
  native: NativeBridge,
): { sessions: SessionStore; settings: SettingsStore; secrets: SecretStore; kv: KvStore } {
  mkdirSync(dataDir, { recursive: true });
  return {
    sessions: createSessionStore(dataDir),
    settings: createSettingsStore(dataDir),
    secrets: createSecretStore(dataDir, native),
    kv: createKvStore(dataDir),
  };
}
