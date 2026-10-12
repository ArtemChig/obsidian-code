import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createExtensions } from '@core/ext';
import { buildHookStdin, matcherMatches } from '@core/ext/hooks';
import { resolveShell } from '@core/ext/shell';
import type { HookConfig } from '@shared/types';
import { cleanupTmp, fwd, makeCtx, tmpDir, write } from './helpers';

afterEach(cleanupTmp);

const HOOK_SCRIPT = `
const fs = require('fs');
const [mode, out] = process.argv.slice(2);
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const p = data ? JSON.parse(data) : {};
  if (out) fs.writeFileSync(out, data);
  switch (mode) {
    case 'block': console.error('blocked ' + (p.tool_name || '')); process.exit(2);
    case 'context': console.log(JSON.stringify({ additionalContext: 'ctx for ' + p.tool_name })); break;
    case 'decision': console.log(JSON.stringify({ decision: 'block', reason: 'policy says no' })); break;
    case 'fail': console.error('boom'); process.exit(1);
    case 'sleep': setTimeout(() => {}, 30000); break;
    case 'text': console.log('plain text context'); break;
    case 'env': console.log(JSON.stringify({ additionalContext: [process.env.OBSIDIAN_CODE_PROJECT_DIR, process.env.OBSIDIAN_CODE_HOOK_EVENT, process.cwd()].join('|') })); break;
    default: break;
  }
});
`;

let script: string;
let scriptDir: string;
beforeAll(() => {
  scriptDir = mkdtempSync(path.join(os.tmpdir(), 'oc-hook-script-'));
  script = write(path.join(scriptDir, 'hook.js'), HOOK_SCRIPT);
});
afterAll(() => rmSync(scriptDir, { recursive: true, force: true }));

/** A shell command running the hook script with the platform shell that hooks will use. */
function cmd(mode: string, out?: string, pref: 'auto' | 'powershell' | 'cmd' = 'auto'): string {
  const shell = resolveShell(pref);
  const exe = `"${fwd(process.execPath)}"`;
  const rest = [script, mode, ...(out ? [out] : [])].map((a) => `"${fwd(a)}"`).join(' ');
  return shell.kind === 'powershell' ? `& ${exe} ${rest}` : `${exe} ${rest}`;
}

function setup(hooks: Record<string, HookConfig[]>) {
  const root = tmpDir();
  const cwd = path.join(root, 'proj');
  const fake = makeCtx(path.join(root, 'data'), { hooks });
  const ext = createExtensions(fake.ctx, { homeDir: path.join(root, 'home') });
  return { root, cwd, fake, ext };
}

describe('matcher', () => {
  it('matches tool names as an anchored regex; empty/* = all', () => {
    expect(matcherMatches(undefined, 'Bash')).toBe(true);
    expect(matcherMatches('', 'Bash')).toBe(true);
    expect(matcherMatches('*', 'Bash')).toBe(true);
    expect(matcherMatches('Bash', 'Bash')).toBe(true);
    expect(matcherMatches('Bash', 'BashOutput')).toBe(false);
    expect(matcherMatches('Edit|Write', 'Write')).toBe(true);
    expect(matcherMatches('Edit|Write', 'MultiEdit')).toBe(false);
    expect(matcherMatches('mcp__.*', 'mcp__fixture__echo')).toBe(true);
    expect(matcherMatches('(', '(')).toBe(true); // invalid regex falls back to exact compare
    expect(matcherMatches('Bash', undefined)).toBe(false);
  });
});

describe('buildHookStdin', () => {
  it('adds hook_event_name, cwd and Claude-style snake_case aliases', () => {
    const j = JSON.parse(buildHookStdin('PreToolUse', { sessionId: 's1', toolName: 'Bash', input: { command: 'ls' } }, '/work'));
    expect(j).toMatchObject({ hook_event_name: 'PreToolUse', cwd: '/work', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, sessionId: 's1' });
    const post = JSON.parse(buildHookStdin('PostToolUse', { tool_name: 'Read', result: 'ok' }, '/work'));
    expect(post.tool_response).toBe('ok');
  });
});

describe('runHooks', () => {
  it('returns { block: false } when nothing is configured', async () => {
    const { ext, cwd } = setup({});
    expect(await ext.runHooks('PreToolUse', { tool_name: 'Bash' }, cwd)).toEqual({ block: false });
  });

  it('exit code 2 blocks with stderr as the message, and the JSON payload arrives on stdin', async () => {
    const root = tmpDir();
    const out = path.join(root, 'stdin.json');
    const { ext, cwd } = setup({ PreToolUse: [{ matcher: 'Bash', command: cmd('block', out) }] });
    const r = await ext.runHooks('PreToolUse', { sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf x' } }, cwd);
    expect(r.block).toBe(true);
    expect(r.message).toContain('blocked Bash');
    const stdin = JSON.parse(readFileSync(out, 'utf8'));
    expect(stdin).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, session_id: 's1', cwd });
  });

  it('only runs hooks whose matcher matches the tool name', async () => {
    const { ext, cwd } = setup({ PreToolUse: [{ matcher: 'Edit|Write', command: cmd('block') }] });
    expect((await ext.runHooks('PreToolUse', { tool_name: 'Bash' }, cwd)).block).toBe(false);
    expect((await ext.runHooks('PreToolUse', { tool_name: 'Write' }, cwd)).block).toBe(true);
    expect((await ext.runHooks('PreToolUse', { toolName: 'Edit' }, cwd)).block).toBe(true);
  });

  it('empty matcher runs for every tool; non-tool events ignore the matcher', async () => {
    const { ext, cwd } = setup({
      PreToolUse: [{ command: cmd('context') }],
      UserPromptSubmit: [{ matcher: 'Bash', command: cmd('text') }],
    });
    expect((await ext.runHooks('PreToolUse', { tool_name: 'Anything' }, cwd)).additionalContext).toBe('ctx for Anything');
    expect((await ext.runHooks('UserPromptSubmit', { prompt: 'hi' }, cwd)).additionalContext).toBe('plain text context');
  });

  it('stdout JSON additionalContext is returned without blocking; decision "block" blocks', async () => {
    const { ext, cwd } = setup({ PostToolUse: [{ command: cmd('context') }], Stop: [{ command: cmd('decision') }] });
    expect(await ext.runHooks('PostToolUse', { tool_name: 'Read' }, cwd)).toEqual({ block: false, additionalContext: 'ctx for Read' });
    expect(await ext.runHooks('Stop', {}, cwd)).toEqual({ block: true, message: 'policy says no' });
  });

  it('plain stdout is ignored for tool events (only UserPromptSubmit / SessionStart use it as context)', async () => {
    const { ext, cwd } = setup({ PreToolUse: [{ command: cmd('text') }], SessionStart: [{ command: cmd('text') }] });
    expect(await ext.runHooks('PreToolUse', { tool_name: 'Bash' }, cwd)).toEqual({ block: false });
    expect((await ext.runHooks('SessionStart', { source: 'startup' }, cwd)).additionalContext).toBe('plain text context');
  });

  it('other non-zero exit codes are logged only (no block)', async () => {
    const { ext, cwd } = setup({ PreToolUse: [{ command: cmd('fail') }] });
    const r = await ext.runHooks('PreToolUse', { tool_name: 'Bash' }, cwd);
    expect(r).toEqual({ block: false });
  });

  it('kills a hook that exceeds its timeout and does not block', async () => {
    const { ext, cwd } = setup({ PreToolUse: [{ command: cmd('sleep'), timeoutMs: 600 }] });
    const t0 = Date.now();
    const r = await ext.runHooks('PreToolUse', { tool_name: 'Bash' }, cwd);
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ block: false });
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(8000);
  });

  it('merges global and project hooks, de-duplicates identical ones, and combines results', async () => {
    const { ext, cwd, fake } = setup({ PreToolUse: [{ command: cmd('context') }] });
    fake.setProjectHooks(cwd, { PreToolUse: [{ command: cmd('context') }, { command: cmd('block') }] });
    const r = await ext.runHooks('PreToolUse', { tool_name: 'Bash' }, cwd);
    expect(r.block).toBe(true);
    expect(r.message).toContain('blocked Bash');
    expect(r.additionalContext).toBe('ctx for Bash'); // the duplicate "context" hook ran once
  });

  it('runs the hook in the project directory with OBSIDIAN_CODE_PROJECT_DIR set', async () => {
    const root = tmpDir();
    const cwd = path.join(root, 'proj');
    write(path.join(cwd, 'marker.txt'), 'x');
    const { ext } = setup({ SessionStart: [{ command: cmd('env') }] });
    const r = await ext.runHooks('SessionStart', {}, cwd);
    const [dir, event, wd] = r.additionalContext!.split('|');
    const real = (p: string) => realpathSync.native(p).toLowerCase();
    expect(real(dir!)).toBe(real(cwd));
    expect(event).toBe('SessionStart');
    expect(real(wd!)).toBe(real(cwd));
  });

  it('non-ASCII payloads and output pass through unchanged', async () => {
    const { ext, cwd } = setup({ PostToolUse: [{ command: cmd('context') }] });
    const r = await ext.runHooks('PostToolUse', { tool_name: 'Rëad中' }, cwd);
    expect(r.additionalContext).toBe('ctx for Rëad中');
  });

  it('a command that cannot start is logged, never thrown', async () => {
    const { ext, cwd } = setup({ Stop: [{ command: 'definitely-not-a-real-command-xyz' }] });
    const r = await ext.runHooks('Stop', {}, cwd);
    expect(r.block).toBe(false); // exit 127 / 1 → log only
  });
});

describe.each(['powershell', 'cmd'] as const)('runHooks through the %s shell (Windows)', (pref) => {
  it.skipIf(process.platform !== 'win32')('blocks on exit 2, passes stdin and returns JSON context', async () => {
    const root = tmpDir();
    const out = path.join(root, 'stdin.json');
    const fake = makeCtx(path.join(root, 'data'), {
      shell: pref,
      hooks: { PreToolUse: [{ command: cmd('block', out, pref) }], PostToolUse: [{ command: cmd('context', undefined, pref) }] },
    });
    const ext = createExtensions(fake.ctx, { homeDir: path.join(root, 'home') });
    const cwd = path.join(root, 'proj');
    const blocked = await ext.runHooks('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }, cwd);
    expect(blocked.block).toBe(true);
    expect(blocked.message).toContain('blocked Bash');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'x' } });
    expect(await ext.runHooks('PostToolUse', { tool_name: 'Read' }, cwd)).toEqual({ block: false, additionalContext: 'ctx for Read' });
    // non-ASCII survives stdin and stdout
    expect((await ext.runHooks('PostToolUse', { tool_name: 'Rëad中' }, cwd)).additionalContext).toBe('ctx for Rëad中');
  });
});

describe('abort', () => {
  it('an aborted hook run kills the hook process and resolves promptly', async () => {
    const { cwd, ext } = setup({ UserPromptSubmit: [{ command: cmd('sleep'), timeoutMs: 30_000 }] });
    const ac = new AbortController();
    const started = Date.now();
    const p = ext.runHooks('UserPromptSubmit', { prompt: 'x' }, cwd, ac.signal);
    setTimeout(() => ac.abort(), 300);
    await expect(p).resolves.toEqual({ block: false });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);

  it('an already-aborted signal runs nothing', async () => {
    const root = tmpDir();
    const out = path.join(root, 'ran.json');
    const { cwd, ext } = setup({ SessionStart: [{ command: cmd('context', out) }] });
    const ac = new AbortController();
    ac.abort();
    expect(await ext.runHooks('SessionStart', {}, cwd, ac.signal)).toEqual({ block: false });
    expect(() => readFileSync(out)).toThrow();
  });
});
