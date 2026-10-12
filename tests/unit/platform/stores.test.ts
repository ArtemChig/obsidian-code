import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeBridge } from '@core/contracts';
import {
  createKvStore,
  createSecretStore,
  createSessionStore,
  createSettingsStore,
  defaultSettings,
  SESSION_WRITE_DEBOUNCE_MS,
} from '@core/store/index';
import { tempDir } from './helpers';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('SessionStore', () => {
  it('debounces writes and writes atomically', async () => {
    const store = createSessionStore(tmp.dir);
    const s = store.create({ cwd: tmp.dir, title: 'First' });
    const file = join(tmp.dir, 'sessions', `${s.id}.json`);
    for (let i = 0; i < 5; i++) {
      s.title = `Title ${i}`;
      store.save(s);
    }
    expect(store.pendingWrites()).toBe(1);
    expect(existsSync(file)).toBe(false);
    await sleep(SESSION_WRITE_DEBOUNCE_MS + 250);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).title).toBe('Title 4');
    // no temp files left behind
    expect(readdirSync(join(tmp.dir, 'sessions')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('flush() forces pending writes and a new store reloads the index', async () => {
    const store = createSessionStore(tmp.dir);
    const s = store.create({ cwd: tmp.dir, title: 'Persist me' });
    s.status = 'running';
    s.messages.push({ id: 'u1', role: 'user', createdAt: 1, blocks: [{ type: 'text', text: 'hello world' }] });
    store.save(s);
    await store.flush();
    expect(store.pendingWrites()).toBe(0);

    const again = createSessionStore(tmp.dir);
    const list = again.list();
    expect(list.map((x) => x.id)).toEqual([s.id]);
    expect(list[0].status).toBe('idle'); // running sessions are reset after a restart
    const loaded = again.get(s.id)!;
    expect(loaded.messages[0].blocks[0]).toEqual({ type: 'text', text: 'hello world' });
    // live object identity: get() returns the same object every time
    expect(again.get(s.id)).toBe(loaded);
  });

  it('lists sorted by updatedAt desc and hides subagents unless asked', async () => {
    const store = createSessionStore(tmp.dir);
    const a = store.create({ cwd: tmp.dir, title: 'A', updatedAt: 1000 });
    const b = store.create({ cwd: tmp.dir, title: 'B', updatedAt: 3000 });
    const c = store.create({ cwd: tmp.dir, title: 'C', updatedAt: 2000, kind: 'subagent', parentSessionId: a.id });
    expect(store.list().map((x) => x.title)).toEqual(['B', 'A']);
    expect(store.list({ includeSubagents: true }).map((x) => x.id)).toEqual([b.id, c.id, a.id]);
    await store.flush();
  });

  it('searches titles and message text with snippets', async () => {
    const store = createSessionStore(tmp.dir);
    const a = store.create({ cwd: tmp.dir, title: 'Refactor the parser' });
    const b = store.create({ cwd: tmp.dir, title: 'Other' });
    b.messages.push({
      id: 'm',
      role: 'assistant',
      createdAt: 1,
      blocks: [{ type: 'text', text: 'Lorem ipsum dolor sit amet, the PARSER tokenizer was rewritten yesterday.' }],
    });
    store.save(b);
    const hits = store.search('parser');
    expect(hits.map((h) => h.sessionId)).toEqual([a.id, b.id]);
    expect(hits[1].snippet.toLowerCase()).toContain('parser tokenizer');
    expect(store.search('nothing-matches')).toEqual([]);
    await store.flush();
    // works after reload too (search text built from disk)
    const again = createSessionStore(tmp.dir);
    expect(again.search('tokenizer').map((h) => h.sessionId)).toEqual([b.id]);
  });

  it('delete removes the file and the index entry', async () => {
    const store = createSessionStore(tmp.dir);
    const s = store.create({ cwd: tmp.dir });
    await store.flush();
    const file = join(tmp.dir, 'sessions', `${s.id}.json`);
    expect(existsSync(file)).toBe(true);
    store.delete(s.id);
    expect(store.get(s.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    await sleep(50);
    expect(existsSync(file)).toBe(false);
  });
});

describe('SettingsStore', () => {
  it('has complete defaults and writes settings.json', () => {
    const store = createSettingsStore(tmp.dir);
    const s = store.get();
    expect(s).toEqual(defaultSettings());
    expect(s.local).toEqual({ enabled: true, baseUrl: 'http://127.0.0.1:8080' });
    expect(s.vast.profiles.map((p) => p.id)).toEqual(['light', 'standard', 'max']);
    expect(s.vast.profiles.map((p) => p.maxPricePerHour)).toEqual([1.0, 2.2, 4.0]);
    expect(s.vast.profiles.find((p) => p.id === 'standard')?.defaultModelId).toBe('qwen38-flash-next-uncensored-huihui-v2-q4kxl');
    expect(s.vast.image).toBe('ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561');
    expect(s.vast.clockOutMode).toBe('destroy');
    expect(s.defaultPermissionMode).toBe('default');
    expect(s.maxToolOutputChars).toBe(30000);
    expect(existsSync(join(tmp.dir, 'settings.json'))).toBe(true);
  });

  it('deep-merges a partial file with defaults and resets invalid values', () => {
    writeFileSync(
      join(tmp.dir, 'settings.json'),
      JSON.stringify({ vast: { monthlyBudget: 300 }, shell: 'zsh', autoCompactPercent: 'lots', extraKey: 1 }),
    );
    const s = createSettingsStore(tmp.dir).get();
    expect(s.vast.monthlyBudget).toBe(300);
    expect(s.vast.idleMinutes).toBe(30);
    expect(s.vast.profiles).toHaveLength(3);
    expect(s.shell).toBe('auto');
    expect(s.autoCompactPercent).toBe(80);
    expect((s as unknown as Record<string, unknown>).extraKey).toBe(1);
  });

  it('update() deep-merges, replaces maps, persists and notifies', () => {
    const store = createSettingsStore(tmp.dir);
    const seen = vi.fn();
    store.onChange(seen);
    store.update({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
    let s = store.update({ vast: { monthlyBudget: 150 } as never, permissions: { allow: ['Bash(npm test:*)'] } as never });
    expect(s.vast.monthlyBudget).toBe(150);
    expect(s.vast.idleMinutes).toBe(30);
    expect(s.permissions).toEqual({ allow: ['Bash(npm test:*)'], deny: [] });
    s = store.update({ mcpServers: { b: { command: 'y' } } });
    expect(Object.keys(s.mcpServers)).toEqual(['b']); // maps are replaced, not merged
    expect(seen).toHaveBeenCalledTimes(3);
    const reloaded = createSettingsStore(tmp.dir).get();
    expect(reloaded.vast.monthlyBudget).toBe(150);
    expect(Object.keys(reloaded.mcpServers)).toEqual(['b']);
    // get() returns copies
    reloaded.vast.monthlyBudget = 1;
    expect(createSettingsStore(tmp.dir).get().vast.monthlyBudget).toBe(150);
  });

  it('forProject() merges .obsidian-code and .claude settings (permissions + hooks) of a trusted folder', () => {
    const proj = join(tmp.dir, 'proj');
    mkdirSync(join(proj, '.obsidian-code'), { recursive: true });
    mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(
      join(proj, '.obsidian-code', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'], deny: [] }, hooks: { Stop: [{ command: 'echo stop' }] } }),
    );
    writeFileSync(
      join(proj, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh', timeout: 5 }] }] },
      }),
    );
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read', 'WebFetch(domain:x.com)'] } }));
    const store = createSettingsStore(tmp.dir);
    // untrusted: only deny rules apply; hooks and allow rules are reported, not used
    const u = store.forProject(proj);
    expect(u.permissions).toEqual({ allow: [], deny: ['Bash(rm:*)'] });
    expect(u.hooks).toEqual({});
    expect(u.untrusted).toMatchObject({ hooks: 2, allow: ['Read', 'Bash(npm test:*)', 'WebFetch(domain:x.com)'] });
    store.update({ trustedFolders: [proj] });
    const p = store.forProject(proj);
    expect(p.permissions.allow).toEqual(['Read', 'Bash(npm test:*)', 'WebFetch(domain:x.com)']);
    expect(p.permissions.deny).toEqual(['Bash(rm:*)']);
    expect(p.hooks.Stop).toEqual([{ command: 'echo stop' }]);
    expect(p.hooks.PreToolUse).toEqual([{ matcher: 'Bash', command: 'check.sh', timeoutMs: 5000 }]);

    store.update({ importClaudeConfig: false });
    const q = store.forProject(proj);
    expect(q.permissions.allow).toEqual(['Read']);
    expect(q.hooks.PreToolUse).toBeUndefined();
  });

  it('addProjectAllowRule() stores the rule in the app settings (keyed by folder, not in the repo) and dedupes', () => {
    const proj = join(tmp.dir, 'p2');
    mkdirSync(proj);
    const store = createSettingsStore(tmp.dir);
    store.addProjectAllowRule(proj, 'Bash(git status:*)');
    store.addProjectAllowRule(proj, 'Bash(git status:*)');
    store.addProjectAllowRule(proj, 'Edit');
    expect(existsSync(join(proj, '.obsidian-code', 'settings.json'))).toBe(false);
    const raw = JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8'));
    expect(raw.projectAllow[proj]).toEqual(['Bash(git status:*)', 'Edit']);
    expect(store.forProject(proj).permissions.allow).toEqual(['Bash(git status:*)', 'Edit']);
  });
});

describe('SecretStore', () => {
  it('AES-GCM fallback round-trips and never stores plaintext', () => {
    const native: NativeBridge = { isElectron: false, notify: () => undefined };
    const store = createSecretStore(tmp.dir, native);
    expect(store.mode).toBe('aes');
    store.set('vast.apiKey', 'super-secret-value');
    expect(store.get('vast.apiKey')).toBe('super-secret-value');
    expect(store.has('vast.apiKey')).toBe(true);
    expect(store.has('nope')).toBe(false);
    const fileText = readFileSync(join(tmp.dir, 'secrets.json'), 'utf8');
    expect(fileText).not.toContain('super-secret-value');
    expect(existsSync(join(tmp.dir, 'secret.key'))).toBe(true);

    const again = createSecretStore(tmp.dir, native);
    expect(again.get('vast.apiKey')).toBe('super-secret-value');
    again.set('vast.apiKey', null);
    expect(again.has('vast.apiKey')).toBe(false);
    expect(createSecretStore(tmp.dir, native).get('vast.apiKey')).toBeNull();
  });

  it('uses the native bridge when available', () => {
    const encrypt = vi.fn((plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`));
    const decrypt = vi.fn((data: Buffer) => Buffer.from(data.toString().slice(4), 'base64').toString());
    const native: NativeBridge = { isElectron: true, notify: () => undefined, encrypt, decrypt };
    const store = createSecretStore(tmp.dir, native);
    expect(store.mode).toBe('native');
    store.set('search.braveKey', 'brave-123');
    expect(encrypt).toHaveBeenCalledWith('brave-123');
    const again = createSecretStore(tmp.dir, native);
    expect(again.get('search.braveKey')).toBe('brave-123');
    expect(decrypt).toHaveBeenCalled();
    expect(readFileSync(join(tmp.dir, 'secrets.json'), 'utf8')).not.toContain('brave-123');

    // a natively-encrypted value cannot be read by the standalone core
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const standalone = createSecretStore(tmp.dir, { isElectron: false, notify: () => undefined });
    expect(standalone.has('search.braveKey')).toBe(true);
    expect(standalone.get('search.braveKey')).toBeNull();
    errSpy.mockRestore();
  });
});

describe('KvStore', () => {
  it('reads fallbacks, writes JSON files and returns copies', () => {
    const kv = createKvStore(tmp.dir);
    expect(kv.read('gpu-ledger', [] as number[])).toEqual([]);
    kv.write('gpu-ledger', [{ id: 'a', cost: 1.5 }]);
    expect(existsSync(join(tmp.dir, 'kv', 'gpu-ledger.json'))).toBe(true);
    const v = kv.read<{ id: string; cost: number }[]>('gpu-ledger', []);
    expect(v).toEqual([{ id: 'a', cost: 1.5 }]);
    v[0].cost = 99;
    expect(kv.read<{ cost: number }[]>('gpu-ledger', [])[0].cost).toBe(1.5);
    expect(createKvStore(tmp.dir).read<{ cost: number }[]>('gpu-ledger', [])[0].cost).toBe(1.5);
    kv.write('weird/../key', 1);
    expect(readdirSync(join(tmp.dir, 'kv')).sort()).toEqual(['gpu-ledger.json', 'weird_.._key.json']);
  });
});
