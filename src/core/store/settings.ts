// SettingsStore (owner: platform): <dataDir>/settings.json with complete defaults, deep-merge on load and update,
// light validation, and project-level overrides (.obsidian-code/settings.json, .claude/settings(.local).json).

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { GpuProfile, HookConfig, PermissionMode, Settings } from '../../shared/types';
import type { SettingsStore } from '../contracts';
import { isPlainObject, readJsonSync, writeFileAtomicSync } from './fsutil';
import { defaultProfiles } from '../gpu/profiles';

type HookEvent = keyof Settings['hooks'];
const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'];
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Default GPU profiles: single source of truth is src/core/gpu/profiles.ts (DEFAULT_GPU_PROFILES). */
export function defaultGpuProfiles(): GpuProfile[] {
  return defaultProfiles();
}

export function defaultSettings(): Settings {
  return {
    defaultModel: null,
    defaultPermissionMode: 'default',
    defaultCwd: homedir(),
    thinkingByDefault: true,
    preferUncensored: true,
    local: { enabled: true, baseUrl: 'http://127.0.0.1:8080' },
    custom: [],
    vast: {
      profiles: defaultGpuProfiles(),
      monthlyBudget: 200,
      idleMinutes: 30,
      heartbeatMinutes: 10,
      maxSessionHours: 6,
      clockOutOnQuit: true,
      clockOutMode: 'destroy',
      parkMaxDays: 3,
      image: 'ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561',
      localPort: 18080,
      extraLlamaArgs: [],
    },
    search: { provider: 'duckduckgo' },
    permissions: { allow: [], deny: [] },
    trustedFolders: [],
    projectAllow: {},
    hooks: {},
    mcpServers: {},
    importClaudeConfig: true,
    shell: 'auto',
    maxToolOutputChars: 30000,
    autoCompactPercent: 80,
    notifications: true,
    launchAtLogin: false,
  };
}

/** Keys whose values are replaced wholesale on update (maps / nullable objects), never deep-merged. */
const REPLACE_KEYS = new Set(['defaultModel', 'mcpServers', 'hooks', 'env', 'headers', 'projectAllow']);

/**
 * Deep-merge `patch` into `base` (returns a new object). Plain objects merge recursively, arrays and primitives
 * replace, `undefined` is ignored. Keys in REPLACE_KEYS replace wholesale.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const cur = out[k];
    if (!REPLACE_KEYS.has(k) && isPlainObject(cur) && isPlainObject(v)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out as T;
}

/**
 * Validate a merged settings object against the defaults' shape: values whose type does not match the default's
 * type are reset to the default; enums are checked. Unknown extra keys are preserved.
 */
export function validateSettings(input: unknown): Settings {
  const d = defaultSettings();
  const merged = deepMerge(d, isPlainObject(input) ? input : {});
  const fix = (target: Record<string, unknown>, defaults: Record<string, unknown>): void => {
    for (const [k, dv] of Object.entries(defaults)) {
      const v = target[k];
      if (dv === null || REPLACE_KEYS.has(k)) continue; // validated separately
      if (Array.isArray(dv)) {
        if (!Array.isArray(v)) target[k] = dv;
      } else if (isPlainObject(dv)) {
        if (!isPlainObject(v)) target[k] = dv;
        else fix(v, dv);
      } else if (typeof v !== typeof dv || (typeof v === 'number' && !Number.isFinite(v))) {
        target[k] = dv;
      }
    }
  };
  fix(merged as unknown as Record<string, unknown>, d as unknown as Record<string, unknown>);

  const m = merged;
  const dm = m.defaultModel as unknown;
  if (dm !== null && !(isPlainObject(dm) && typeof dm.provider === 'string' && typeof dm.model === 'string')) {
    m.defaultModel = null;
  }
  if (!PERMISSION_MODES.includes(m.defaultPermissionMode)) m.defaultPermissionMode = d.defaultPermissionMode;
  if (!['auto', 'git-bash', 'powershell', 'cmd'].includes(m.shell)) m.shell = d.shell;
  if (!['destroy', 'park'].includes(m.vast.clockOutMode)) m.vast.clockOutMode = d.vast.clockOutMode;
  if (!['duckduckgo', 'brave', 'tavily', 'searxng'].includes(m.search.provider)) m.search.provider = d.search.provider;
  if (!isPlainObject(m.hooks)) m.hooks = {};
  if (!isPlainObject(m.mcpServers)) m.mcpServers = {};
  m.permissions.allow = m.permissions.allow.filter((r): r is string => typeof r === 'string');
  m.permissions.deny = m.permissions.deny.filter((r): r is string => typeof r === 'string');
  m.trustedFolders = m.trustedFolders.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
  const projectAllow: Record<string, string[]> = {};
  if (isPlainObject(m.projectAllow)) {
    for (const [k, v] of Object.entries(m.projectAllow)) {
      const rules = stringList(v);
      if (k.trim() && rules.length) projectAllow[k] = rules;
    }
  }
  m.projectAllow = projectAllow;
  m.custom = m.custom.filter((c) => isPlainObject(c) && typeof c.id === 'string' && typeof c.baseUrl === 'string');
  m.vast.profiles = m.vast.profiles.filter((p) => isPlainObject(p) && typeof p.id === 'string');
  if (m.vast.profiles.length === 0) m.vast.profiles = defaultGpuProfiles();
  m.vast.extraLlamaArgs = m.vast.extraLlamaArgs.filter((a): a is string => typeof a === 'string');
  m.autoCompactPercent = Math.min(98, Math.max(10, m.autoCompactPercent));
  m.maxToolOutputChars = Math.max(1000, Math.floor(m.maxToolOutputChars));
  if (!m.defaultCwd) m.defaultCwd = d.defaultCwd;
  return m;
}

// ───────────────────────────── project settings ─────────────────────────────

/** Accepts both our HookConfig[] form and Claude Code's `[{ matcher, hooks: [{ type:'command', command, timeout }] }]`. */
export function normalizeHooks(raw: unknown): Settings['hooks'] {
  const out: Settings['hooks'] = {};
  if (!isPlainObject(raw)) return out;
  for (const ev of HOOK_EVENTS) {
    const list = raw[ev];
    if (!Array.isArray(list)) continue;
    const hooks: HookConfig[] = [];
    for (const entry of list) {
      if (!isPlainObject(entry)) continue;
      const matcher = typeof entry.matcher === 'string' && entry.matcher.length > 0 ? entry.matcher : undefined;
      if (typeof entry.command === 'string') {
        const h: HookConfig = { command: entry.command };
        if (matcher) h.matcher = matcher;
        if (typeof entry.timeoutMs === 'number') h.timeoutMs = entry.timeoutMs;
        hooks.push(h);
      } else if (Array.isArray(entry.hooks)) {
        for (const inner of entry.hooks) {
          if (!isPlainObject(inner) || typeof inner.command !== 'string') continue;
          if (inner.type !== undefined && inner.type !== 'command') continue;
          const h: HookConfig = { command: inner.command };
          if (matcher) h.matcher = matcher;
          if (typeof inner.timeout === 'number') h.timeoutMs = inner.timeout * 1000;
          else if (typeof inner.timeoutMs === 'number') h.timeoutMs = inner.timeoutMs;
          hooks.push(h);
        }
      }
    }
    if (hooks.length) out[ev] = hooks;
  }
  return out;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function projectSettingsFile(cwd: string): string {
  return join(cwd, '.obsidian-code', 'settings.json');
}

/** Comparison key for a folder: absolute, no trailing separator, case-folded on Windows. */
export function folderKey(p: string): string {
  let abs = resolve(String(p ?? '').trim() || '.');
  while (abs.length > 1 && (abs.endsWith('/') || abs.endsWith('\\')) && !/^[a-zA-Z]:[\\/]$/.test(abs)) abs = abs.slice(0, -1);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Is `cwd` one of the trusted folders or inside one? (Trust lives only in the global settings, never in a project file.) */
export function isTrustedFolder(trusted: readonly string[], cwd: string): boolean {
  const c = folderKey(cwd);
  return trusted.some((t) => {
    const k = folderKey(t);
    return c === k || c.startsWith(k.endsWith(sep) ? k : k + sep);
  });
}

export interface SettingsStoreImpl extends SettingsStore {
  readonly file: string;
}

export function createSettingsStore(dataDir: string): SettingsStoreImpl {
  const file = join(dataDir, 'settings.json');
  const listeners = new Set<(s: Settings) => void>();
  const loaded = readJsonSync<unknown>(file);
  let current = validateSettings(loaded ?? {});
  if (loaded === undefined) {
    try {
      writeFileAtomicSync(file, JSON.stringify(current, null, 2));
    } catch (err) {
      console.error('[settings] failed to write defaults:', err instanceof Error ? err.message : err);
    }
  }

  const clone = (s: Settings): Settings => structuredClone(s);

  const update = (patch: Partial<Settings> | undefined): Settings => {
    const next = validateSettings(deepMerge(current, patch ?? {}));
    writeFileAtomicSync(file, JSON.stringify(next, null, 2));
    current = next;
    const snapshot = clone(current);
    for (const fn of [...listeners]) {
      try {
        fn(clone(snapshot));
      } catch (err) {
        console.error('[settings] listener threw:', err instanceof Error ? err.message : err);
      }
    }
    return snapshot;
  };

  /** The "Always allow" rules granted for this folder (stored in the global settings, keyed by folder). */
  const grantedFor = (cwd: string): { key: string | undefined; rules: string[] } => {
    const k = folderKey(cwd);
    const key = Object.keys(current.projectAllow ?? {}).find((x) => folderKey(x) === k);
    return { key, rules: key ? [...(current.projectAllow[key] ?? [])] : [] };
  };

  return {
    file,
    get() {
      return clone(current);
    },
    update,
    forProject(cwd) {
      // Project files come with the repository, so their hooks (shell commands) and allow rules only count once the
      // user has trusted the folder in the app; deny rules only restrict and always apply.
      const trusted = isTrustedFolder(current.trustedFolders ?? [], cwd);
      const allow: string[] = grantedFor(cwd).rules;
      const deny: string[] = [];
      const hooks: Settings['hooks'] = {};
      const ignored = { hooks: 0, allow: [] as string[], files: [] as string[] };
      const addHooks = (h: Settings['hooks']): void => {
        for (const ev of HOOK_EVENTS) {
          const list = h[ev];
          if (list?.length) hooks[ev] = [...(hooks[ev] ?? []), ...list];
        }
      };
      const files = [projectSettingsFile(cwd)];
      if (current.importClaudeConfig) {
        files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
      }
      for (const f of files) {
        const raw = readJsonSync<unknown>(f);
        if (!isPlainObject(raw)) continue;
        const perms = raw.permissions;
        const fileAllow = isPlainObject(perms) ? stringList(perms.allow) : [];
        if (isPlainObject(perms)) deny.push(...stringList(perms.deny));
        const fileHooks = normalizeHooks(raw.hooks);
        if (trusted) {
          allow.push(...fileAllow);
          addHooks(fileHooks);
        } else {
          const n = HOOK_EVENTS.reduce((acc, ev) => acc + (fileHooks[ev]?.length ?? 0), 0);
          if (n || fileAllow.length) {
            ignored.hooks += n;
            ignored.allow.push(...fileAllow);
            ignored.files.push(f);
          }
        }
      }
      const out: ReturnType<SettingsStore['forProject']> = { permissions: { allow: uniq(allow), deny: uniq(deny) }, hooks };
      if (ignored.files.length) out.untrusted = { hooks: ignored.hooks, allow: uniq(ignored.allow), files: ignored.files };
      return out;
    },
    addProjectAllowRule(cwd, rule) {
      // Kept in the app's own settings (keyed by folder), never in a file inside the repository.
      const r = rule.trim();
      if (!r) return;
      const { key, rules } = grantedFor(cwd);
      if (rules.includes(r)) return;
      update({ projectAllow: { ...(current.projectAllow ?? {}), [key ?? resolve(cwd)]: [...rules, r] } });
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
