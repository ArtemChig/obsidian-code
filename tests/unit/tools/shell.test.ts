import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bashOutputTool } from '../../../src/core/tools/bash-output';
import { bashTool } from '../../../src/core/tools/bash';
import { killShellTool } from '../../../src/core/tools/kill-shell';
import { powershellTool } from '../../../src/core/tools/powershell';
import { commandRule, findGitBash, isReadOnlyCommand, OutputBuffer, resolveShellKind, splitSegments } from '../../../src/core/tools/lib/shell';
import { cleanupTempDirs, makeCtx, makeTempDir, sleep, write } from './helpers';

afterAll(cleanupTempDirs);

const HAS_BASH = !!findGitBash();
const IS_WIN = process.platform === 'win32';
const slash = (p: string) => p.replace(/\\/g, '/');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean, ms = 10_000, step = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
}

describe('shell selection', () => {
  it('auto → Git Bash when present, else PowerShell; explicit settings win', () => {
    expect(resolveShellKind('powershell')).toBe('powershell');
    if (IS_WIN) expect(resolveShellKind('cmd')).toBe('cmd');
    expect(resolveShellKind('auto')).toBe(HAS_BASH ? 'bash' : 'powershell');
    expect(resolveShellKind('git-bash')).toBe(HAS_BASH ? 'bash' : 'powershell');
    expect(resolveShellKind(undefined)).toBe(HAS_BASH ? 'bash' : 'powershell');
  });
});

describe('OutputBuffer', () => {
  it('keeps head and tail, tracks offsets for incremental reads', () => {
    const b = new OutputBuffer(10, 20);
    b.push('0123456789');
    expect(b.since(0)).toEqual({ text: '0123456789', end: 10 });
    b.push('abcdefghij'.repeat(10)); // 100 more chars
    expect(b.total).toBe(110);
    expect(b.all().startsWith('0123456789')).toBe(true);
    expect(b.all()).toContain('characters of output dropped');
    expect(b.all().endsWith('abcdefghij')).toBe(true);
    expect(b.since(105).text).toBe('fghij');
    expect(b.since(110).text).toBe('');
    expect(b.recent(5)).toBe('fghij');
  });
});

describe('read-only command allowlist', () => {
  const bashRead = ['git status', 'git diff --stat', 'git log --oneline | head -5', 'ls -la', 'pwd', 'cd src && ls', 'cat a.txt', 'git status 2>&1',
    'node --version', 'find . -name "*.ts"', 'git branch', 'git branch -a', 'grep -rn "x; y" src', 'echo "a && b"', 'git diff HEAD~1 -- src/a.ts', 'ls 2>/dev/null', 'npm ls', 'git -C src status', 'date +%Y', 'hostname'];
  const bashExec = ['rm -rf x', 'git commit -m x', 'git push', 'npm install', 'ls > out.txt', 'ls && rm x', 'echo $(whoami)', 'cat a | tee b', 'git -c core.pager=x status',
    'find . -delete', 'git branch -D x', 'sleep 1 &', 'FOO=1 ls', 'echo `id`', 'git diff --output=x', 'node script.js', 'cat <<EOF', 'git checkout main', 'echo "unterminated', 'rg --pre cat foo', 'date -s 2020-01-01', 'hostname evil', 'git grep -Ocmd foo', 'git -C src commit -m x'];
  it.each(bashRead)('treats %j as read-only', (cmd) => {
    expect(isReadOnlyCommand(cmd, 'bash')).toBe(true);
    expect(bashTool.permission({ command: cmd }, { cwd: ".", settings: makeCtx(".").settings })).toBe("read");
  });
  it.each(bashExec)('treats %j as exec', (cmd) => {
    expect(isReadOnlyCommand(cmd, 'bash')).toBe(false);
  });
  it('bash permission() is exec for mutating commands', () => {
    const c = { cwd: '.', settings: makeCtx('.').settings };
    expect(bashTool.permission({ command: 'npm install' }, c)).toBe('exec');
    expect(bashTool.permission({ command: "git status" }, c)).toBe("read");
  });
  it('PowerShell allowlist', () => {
    for (const c of ['Get-ChildItem', 'Get-Content a.txt | Select-Object -First 5', 'pwd', 'git status', 'Test-Path C:\\x', 'Get-Location']) {
      expect(isReadOnlyCommand(c, 'powershell')).toBe(true);
    }
    for (const c of ['Remove-Item x', 'Get-ChildItem | ForEach-Object { Remove-Item $_ }', 'Set-Content a b', 'Get-Date > x', '& evil.exe', 'Invoke-WebRequest x', 'Get-Content (Get-Item $(x))', 'Get-ChildItem (Remove-Item x)']) {
      expect(isReadOnlyCommand(c, 'powershell')).toBe(false);
    }
    expect(powershellTool.permission({ command: 'Get-ChildItem' }, { cwd: '.', settings: makeCtx('.').settings })).toBe('read');
    expect(powershellTool.permission({ command: 'Remove-Item x' }, { cwd: '.', settings: makeCtx('.').settings })).toBe('exec');
  });
  it('splitSegments handles quotes and operators', () => {
    expect(splitSegments('a "b; c" && d | e', 'bash')).toEqual(['a "b; c"', 'd', 'e']);
    expect(splitSegments("echo 'a > b'", 'bash')).toEqual(["echo 'a > b'"]);
    expect(splitSegments('a > b', 'bash')).toBeNull();
  });
});

describe('rules and titles', () => {
  it('derives allow rules from the first two words for simple commands', () => {
    expect(bashTool.ruleFor?.({ command: 'npm test' })).toBe('Bash(npm test:*)');
    expect(bashTool.ruleFor?.({ command: 'npm test -- --watch' })).toBe('Bash(npm test:*)');
    expect(bashTool.ruleFor?.({ command: 'npm run build' })).toBe('Bash(npm run build:*)'); // script name kept (security F4)
    expect(bashTool.ruleFor?.({ command: 'ls -la src' })).toBe('Bash(ls:*)');
    expect(bashTool.ruleFor?.({ command: 'python script.py --x' })).toBe('Bash(python script.py --x)'); // interpreters: exact only
    expect(bashTool.ruleFor?.({ command: 'git status' })).toBe('Bash(git status:*)');
  });
  it('uses the exact command for compound commands (so a prefix rule cannot be abused)', () => {
    expect(bashTool.ruleFor?.({ command: 'git status && rm -rf /' })).toBe('Bash(git status && rm -rf /)');
    expect(bashTool.ruleFor?.({ command: 'echo hi > f.txt' })).toBe('Bash(echo hi > f.txt)');
    expect(commandRule('PowerShell', 'Get-ChildItem -Recurse', 'powershell')).toBe('PowerShell(Get-ChildItem:*)');
    expect(powershellTool.ruleFor?.({ command: 'Remove-Item x' })).toBe('PowerShell(Remove-Item x)'); // deletion: exact only
  });
  it('titles', () => {
    expect(bashTool.title({ command: 'npm install' })).toBe('Run: npm install');
    expect(powershellTool.title({ command: 'Get-Date' })).toBe('PowerShell: Get-Date');
  });
  it('is tolerant of bad input in permission/title/ruleFor', () => {
    const c = { cwd: '.', settings: makeCtx('.').settings };
    expect(bashTool.permission({} as never, c)).toBe('exec');
    expect(typeof bashTool.title({} as never)).toBe('string');
    expect(typeof bashTool.ruleFor?.({} as never)).toBe('string');
  });
});

describe.runIf(HAS_BASH)('Bash tool (Git Bash)', () => {
  const bash = (dir: string, input: Record<string, unknown>, ctx = makeCtx(dir, { settings: { shell: 'git-bash' } })) => bashTool.run(input as never, ctx);

  it('runs a command in cwd (path with spaces) and returns output + display', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash' } });
    const r = await bashTool.run({ command: 'echo hello; pwd' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('hello');
    expect(r.content).toContain(path.basename(dir));
    expect(r.display).toMatchObject({ kind: 'bash', command: 'echo hello; pwd', exitCode: 0 });
  });

  it('reports exit codes and merges stderr', async () => {
    const dir = makeTempDir();
    const r = await bash(dir, { command: 'echo out; echo err >&2; exit 3' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('out');
    expect(r.content).toContain('err');
    expect(r.content).toContain('Exit code: 3');
    expect(r.display).toMatchObject({ exitCode: 3 });
  });

  it('handles quoting, multi-line scripts, unicode and the UTF-8 locale', async () => {
    const dir = makeTempDir();
    const file = write(dir, 'dir with space/f g.txt', 'content here\n');
    const r = await bash(dir, { command: `echo "a b" 'c d'\nif true; then\n  echo multi-line\nfi\necho "héllo wörld ✓"\necho $LANG\ncat "${slash(file)}"` });
    expect(r.content).toBe('a b c d\nmulti-line\nhéllo wörld ✓\nC.UTF-8\ncontent here');
  });

  it('passes backslashes and very long commands through untouched', async () => {
    const dir = makeTempDir();
    const r = await bash(dir, { command: String.raw`echo 'a\\b' 'C:\Users\x' "q\"q" '\\\\server\share'` });
    expect(r.content).toBe(String.raw`a\\b C:\Users\x q"q \\\\server\share`);
    const big = 'x'.repeat(60_000);
    const long = await bash(dir, { command: `cat > big.txt <<'EOF'\n${big}\nEOF\nwc -c < big.txt` });
    expect(long.content.trim()).toBe(String(big.length + 1));
    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8').trim().length).toBe(big.length);
  });

  it('hides the temp script path in shell error messages', async () => {
    const r = await bash(makeTempDir(), { command: 'echo start\nthis_command_does_not_exist_xyz\necho end' });
    expect(r.content).toContain('start');
    expect(r.content).toContain('end');
    expect(r.content).toMatch(/^bash: line 2: this_command_does_not_exist_xyz: command not found$/m);
    expect(r.content).not.toContain('obsidian-code-sh');
  });

  it('does not hang on commands that read stdin', async () => {
    const dir = makeTempDir();
    const t = Date.now();
    const r = await bash(dir, { command: 'cat; echo after' });
    expect(r.content).toContain('after');
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('returns "(no output)" for silent successes', async () => {
    const r = await bash(makeTempDir(), { command: 'true' });
    expect(r.content).toBe('(no output)');
  });

  it('kills the process on timeout', async () => {
    const dir = makeTempDir();
    const t = Date.now();
    const r = await bash(dir, { command: 'echo started; sleep 30', timeout: 1500 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('timed out');
    expect(r.content).toContain('started');
  });

  it('kills the whole process tree on timeout and on abort', async () => {
    const dir = makeTempDir();
    const pidFile = path.join(dir, 'child.pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const nodeExe = slash(process.execPath);
    const cmd = `"${nodeExe}" -e '${script.replace(/'/g, "'\\''")}' & wait`;

    const r = await bash(dir, { command: cmd, timeout: 3000 });
    expect(r.isError).toBe(true);
    const pid1 = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid1).toBeGreaterThan(0);
    expect(await waitFor(() => !alive(pid1), 5000)).toBe(true);

    fs.rmSync(pidFile);
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash' } });
    const p = bashTool.run({ command: cmd, timeout: 60_000 }, ctx);
    expect(await waitFor(() => fs.existsSync(pidFile), 8000)).toBe(true);
    const pid2 = Number(fs.readFileSync(pidFile, 'utf8'));
    ctx.controller.abort();
    const aborted = await p;
    expect(aborted.isError).toBe(true);
    expect(aborted.content).toContain('interrupted');
    expect(await waitFor(() => !alive(pid2), 5000)).toBe(true);
  });

  it('returns immediately when already aborted', async () => {
    const ctx = makeCtx(makeTempDir(), { settings: { shell: 'git-bash' } });
    ctx.controller.abort();
    const r = await bashTool.run({ command: 'echo never' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('never');
  });

  it('truncates long output keeping head and tail', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash', maxToolOutputChars: 3000 } });
    const r = await bashTool.run({ command: 'for i in $(seq 1 2000); do echo "line-$i-xxxxxxxxxxxxxxxxxxxx"; done' }, ctx);
    expect(r.content.length).toBeLessThan(3400);
    expect(r.content).toContain('line-1-');
    expect(r.content).toContain('line-2000-');
    expect(r.content).toMatch(/characters omitted/);
  });

  it('streams progress while the command runs', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash' } });
    const r = await bashTool.run({ command: 'echo one; sleep 1; echo two; sleep 1; echo three' }, ctx);
    expect(r.content).toBe('one\ntwo\nthree');
    expect(ctx.progressLog.length).toBeGreaterThanOrEqual(2);
    expect(ctx.progressLog.some((p) => p.includes('one') && !p.includes('three'))).toBe(true);
    expect(ctx.progressLog.at(-1)).toContain('two');
  });

  it('fails cleanly for a missing working directory and empty commands', async () => {
    const ctx = makeCtx(path.join(makeTempDir(), 'missing'), { settings: { shell: 'git-bash' } });
    expect((await bashTool.run({ command: 'echo hi' }, ctx)).content).toContain('Working directory does not exist');
    expect((await bashTool.run({ command: '   ' }, makeCtx(makeTempDir()))).isError).toBe(true);
    expect((await bashTool.run({} as never, makeCtx(makeTempDir()))).content).toContain('command');
  });

  it('clamps timeout and coerces string timeouts', async () => {
    const dir = makeTempDir();
    const r = await bash(dir, { command: 'echo ok', timeout: '5000' });
    expect(r.content).toBe('ok');
  });
});

describe.runIf(HAS_BASH)('background shells', () => {
  it('start → incremental BashOutput → exit status → filter', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash' } });
    const started = await bashTool.run({ command: 'echo alpha; sleep 1.5; echo beta; echo gamma; sleep 1.5; echo omega', run_in_background: true }, ctx);
    expect(started.isError).toBeFalsy();
    const id = /bash_\d+/.exec(started.content)![0];
    expect(started.display).toMatchObject({ kind: 'bash', background: true, shellId: id });
    expect(started.content).toContain('alpha');

    // incremental: alpha was consumed by the start call
    expect(await waitFor(() => ctx.registry.output(id, { sinceLastRead: false }).output.includes('gamma'), 6000)).toBe(true);
    const mid = await bashOutputTool.run({ bash_id: id }, ctx);
    expect(mid.content).toMatch(/\[bash_\d+: running\]/);
    expect(mid.content).toContain('beta');
    expect(mid.content).not.toContain('alpha');

    expect(await waitFor(() => !ctx.registry.list().find((s) => s.id === id)?.running, 8000)).toBe(true);
    const end = await bashOutputTool.run({ bash_id: id }, ctx);
    expect(end.content).toContain('exited with code 0');
    expect(end.content).toContain('omega');
    expect(end.content).not.toContain('beta');
    const again = await bashOutputTool.run({ bash_id: id }, ctx);
    expect(again.content).toContain('(no new output)');

    // full re-read + filter
    const all = ctx.registry.output(id, { sinceLastRead: false });
    expect(all.output).toContain('alpha');
    expect(all.output).toContain('omega');
    expect(all.exitCode).toBe(0);
    expect(ctx.registry.output(id, { sinceLastRead: false, filter: '^(beta|omega)$' }).output).toBe('beta\nomega');
  });

  it('KillShell stops a long-running shell and its children', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash' } });
    const pidFile = path.join(dir, 'bg.pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const cmd = `"${slash(process.execPath)}" -e '${script.replace(/'/g, "'\\''")}' & wait`;
    const started = await bashTool.run({ command: cmd, run_in_background: true }, ctx);
    const id = /bash_\d+/.exec(started.content)![0];
    expect(await waitFor(() => fs.existsSync(pidFile), 8000)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(ctx.registry.list().find((s) => s.id === id)?.running).toBe(true);

    const killed = await killShellTool.run({ shell_id: id }, ctx);
    expect(killed.isError).toBeFalsy();
    expect(killed.content).toContain(`Killed shell ${id}`);
    expect(ctx.registry.list().find((s) => s.id === id)?.running).toBe(false);
    expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
    expect((await killShellTool.run({ shell_id: id }, ctx)).content).toContain('already finished');
  });

  it('reports immediate failures of background commands and unknown ids', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir, { settings: { shell: 'git-bash' } });
    const r = await bashTool.run({ command: 'echo oops >&2; exit 7', run_in_background: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('exit code 7');
    expect(r.content).toContain('oops');
    expect((await bashOutputTool.run({ bash_id: 'bash_999' }, ctx)).isError).toBe(true);
    expect((await killShellTool.run({ shell_id: 'nope' }, ctx)).isError).toBe(true);
  });

  it('registry: sessions, activity reporting and list()', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir);
    const id = ctx.registry.start({ command: 'echo hi', cwd: dir, shell: 'bash', sessionId: 'sess-A' });
    ctx.registry.start({ command: 'echo yo', cwd: dir, shell: 'bash', sessionId: 'sess-B' });
    expect(ctx.registry.list('sess-A').map((s) => s.id)).toEqual([id]);
    expect(ctx.registry.list().length).toBe(2);
    expect(await waitFor(() => !ctx.registry.list('sess-A')[0].running, 6000)).toBe(true);
    expect(ctx.registry.output(id).output).toBe('hi\n');
    expect(ctx.registry.output('missing')).toEqual({ output: '', running: false, exitCode: null });
    expect(ctx.registry.kill(id)).toBe(false);
  });
});

describe.runIf(IS_WIN)('PowerShell tool', () => {
  const ps = (dir: string, input: Record<string, unknown>, ctx = makeCtx(dir)) => powershellTool.run(input as never, ctx);

  it('runs commands in cwd with UTF-8 output', async () => {
    const dir = makeTempDir();
    const r = await ps(dir, { command: 'Write-Output "héllo wörld ✓"; $PWD.Path' });
    expect(r.isError).toBeFalsy();
    expect(r.content.split('\n')[0].trim()).toBe('héllo wörld ✓');
    expect(r.content).toContain(dir);
    expect(r.display).toMatchObject({ kind: 'bash', exitCode: 0 });
  }, 30_000);

  it('propagates native exit codes, errors and handles multi-line scripts', async () => {
    const dir = makeTempDir();
    const code = await ps(dir, { command: 'cmd /c exit 3' });
    expect(code.isError).toBe(true);
    expect(code.content).toContain('Exit code: 3');
    const err = await ps(dir, { command: 'Get-Item C:\\definitely\\missing' });
    expect(err.isError).toBe(true);
    expect(err.content).toContain('Cannot find path');
    expect(err.content).not.toContain('.ps1');
    expect(err.content).not.toContain('CLIXML');
    const multi = await ps(dir, { command: '$x = 5\nif ($x -gt 3) {\n  "big $($x * 2)"\n} else {\n  "small"\n}' });
    expect(multi.content).toBe('big 10');
    const ok = await ps(dir, { command: 'cmd /c exit 4; Write-Output fine' });
    expect(ok.isError).toBeFalsy();
  }, 60_000);

  it('handles quotes safely and removes its temp script', async () => {
    const dir = makeTempDir();
    const scriptDir = path.join(os.tmpdir(), 'obsidian-code-ps');
    const before = fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir).length : 0;
    const r = await ps(dir, { command: `Write-Output 'it''s "quoted" $env:USERNAME_NOT_SET|x'; Write-Output "expanded: $($env:USERNAME_NOT_SET)|y"` });
    expect(r.content).toBe(`it's "quoted" $env:USERNAME_NOT_SET|x\nexpanded: |y`);
    const after = fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir).length : 0;
    expect(after).toBeLessThanOrEqual(before);
  }, 30_000);

  it('times out and kills powershell', async () => {
    const dir = makeTempDir();
    const t = Date.now();
    const r = await ps(dir, { command: 'Write-Output begin; Start-Sleep -Seconds 60', timeout: 2500 });
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('timed out');
    expect(r.content).toContain('begin');
  }, 30_000);

  it('supports run_in_background via the registry', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx(dir);
    const started = await powershellTool.run({ command: 'Write-Output one; Start-Sleep -Seconds 1; Write-Output two', run_in_background: true } as never, ctx);
    const id = /bash_\d+/.exec(started.content)![0];
    expect(await waitFor(() => !ctx.registry.list().find((s) => s.id === id)?.running, 15_000)).toBe(true);
    const out = ctx.registry.output(id, { sinceLastRead: false });
    expect(out.output.replace(/\r/g, '')).toContain('one\ntwo');
    expect(out.exitCode).toBe(0);
    expect(out.output).not.toContain('.ps1');
  }, 40_000);

  it('the Bash tool runs PowerShell when settings.shell is powershell, and cmd when cmd', async () => {
    const dir = makeTempDir();
    const viaPs = await bashTool.run({ command: '$PSVersionTable.PSVersion.Major' }, makeCtx(dir, { settings: { shell: 'powershell' } }));
    expect(Number(viaPs.content.trim())).toBeGreaterThanOrEqual(5);
    const viaCmd = await bashTool.run({ command: 'echo %CD%' }, makeCtx(dir, { settings: { shell: 'cmd' } }));
    expect(viaCmd.content.toLowerCase()).toContain(path.basename(dir).toLowerCase());
  }, 30_000);
});
