import { mkdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtensions } from '@core/ext';
import { MEMORY_CAP_CHARS, findImports } from '@core/ext/memory';
import { cleanupTmp, makeCtx, tmpDir, write } from './helpers';

afterEach(cleanupTmp);

function setup(patch: Parameters<typeof makeCtx>[1] = {}) {
  const root = tmpDir();
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const data = path.join(root, 'data');
  const fake = makeCtx(data, patch);
  const ext = createExtensions(fake.ctx, { homeDir: home });
  return { root, home, ext, fake };
}

describe('memoryText', () => {
  it('orders user files first, then root -> cwd (most specific last), each prefixed by its path', async () => {
    const { root, home, ext } = setup({ importClaudeConfig: true });
    const proj = path.join(root, 'proj');
    const cwd = path.join(proj, 'a', 'b');
    write(path.join(home, '.obsidian-code', 'OBSIDIAN.md'), 'USER-OBS');
    write(path.join(home, '.claude', 'CLAUDE.md'), 'USER-CLAUDE');
    write(path.join(proj, 'CLAUDE.md'), 'ROOT-CLAUDE');
    write(path.join(proj, 'a', 'AGENTS.md'), 'MID-AGENTS');
    write(path.join(cwd, 'OBSIDIAN.md'), 'CWD-OBS');
    write(path.join(cwd, 'CLAUDE.md'), 'CWD-CLAUDE');
    write(path.join(cwd, '.claude', 'CLAUDE.md'), 'CWD-DOTCLAUDE');

    const text = await ext.memoryText(cwd);
    const order = ['USER-OBS', 'USER-CLAUDE', 'ROOT-CLAUDE', 'MID-AGENTS', 'CWD-OBS', 'CWD-CLAUDE', 'CWD-DOTCLAUDE'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // every entry is prefixed by its own path
    expect(text).toContain(`Contents of ${path.join(cwd, 'OBSIDIAN.md')}`);
    expect(text).toContain(`Contents of ${path.join(home, '.obsidian-code', 'OBSIDIAN.md')}`);
    expect(text).toContain(`Contents of ${path.join(cwd, '.claude', 'CLAUDE.md')}`);
  });

  it('returns an empty string when there is no memory', async () => {
    const { root, ext } = setup();
    const cwd = path.join(root, 'empty');
    mkdirSync(cwd, { recursive: true });
    // (ancestors of the tmp dir may contain real memory files on a dev machine; only assert our own are absent)
    const text = await ext.memoryText(cwd);
    expect(text).not.toContain(root);
  });

  it('does not read ~/.claude/CLAUDE.md unless importClaudeConfig is on, even when cwd is under home', async () => {
    const { home, ext, fake } = setup({ importClaudeConfig: false });
    const cwd = path.join(home, 'work');
    write(path.join(home, '.claude', 'CLAUDE.md'), 'PRIVATE-CLAUDE-USER-FILE');
    write(path.join(home, 'CLAUDE.md'), 'HOME-DIR-CLAUDE');
    write(path.join(cwd, 'CLAUDE.md'), 'WORK');
    let text = await ext.memoryText(cwd);
    expect(text).not.toContain('PRIVATE-CLAUDE-USER-FILE');
    expect(text).toContain('HOME-DIR-CLAUDE');

    fake.update({ importClaudeConfig: true });
    text = await ext.memoryText(cwd);
    expect(text.split('PRIVATE-CLAUDE-USER-FILE').length - 1).toBe(1); // present exactly once (deduped with the walk)
    expect(text.indexOf('PRIVATE-CLAUDE-USER-FILE')).toBeLessThan(text.indexOf('HOME-DIR-CLAUDE'));
  });

  it('de-duplicates identical content (e.g. CLAUDE.md mirrored as AGENTS.md)', async () => {
    const { root, ext } = setup();
    const cwd = path.join(root, 'dup');
    write(path.join(cwd, 'CLAUDE.md'), 'SAME-RULES-123');
    write(path.join(cwd, 'AGENTS.md'), 'SAME-RULES-123\n');
    const text = await ext.memoryText(cwd);
    expect(text.split('SAME-RULES-123').length - 1).toBe(1);
  });

  it('follows @path imports one level deep only', async () => {
    const { root, home, ext } = setup();
    const cwd = path.join(root, 'imp');
    write(path.join(home, 'shared.md'), 'HOME-SHARED-TEXT');
    write(path.join(cwd, 'CLAUDE.md'), ['Rules here.', 'See @docs/rules.md for more and @~/shared.md too.', 'Mail me at joe@example.com', '`@docs/inline.md` in code', '```', '@docs/fenced.md', '```', '@missing.md'].join('\n'));
    write(path.join(cwd, 'docs', 'rules.md'), 'RULES-BODY\n@deep.md');
    write(path.join(cwd, 'docs', 'deep.md'), 'DEEP-BODY');
    write(path.join(cwd, 'docs', 'inline.md'), 'INLINE-BODY');
    write(path.join(cwd, 'docs', 'fenced.md'), 'FENCED-BODY');
    const text = await ext.memoryText(cwd);
    expect(text).toContain('RULES-BODY');
    expect(text).toContain('HOME-SHARED-TEXT');
    expect(text).not.toContain('DEEP-BODY');
    expect(text).not.toContain('INLINE-BODY');
    expect(text).not.toContain('FENCED-BODY');
    expect(text).toContain(`Contents of ${path.join(cwd, 'docs', 'rules.md')}`);
  });

  it('findImports ignores emails, code spans and fences', () => {
    expect(findImports('a @x.md b\nuser@host.com\n`@no.md`\n```\n@fence.md\n```\n(@paren.md)')).toEqual(['x.md', 'paren.md']);
  });

  it('caps the total size (~12k), keeps the most specific files and adds a note', async () => {
    const { root, ext } = setup();
    const cwd = path.join(root, 'big', 'deep');
    write(path.join(root, 'big', 'CLAUDE.md'), 'GENERAL-START ' + 'g'.repeat(20_000));
    write(path.join(cwd, 'CLAUDE.md'), 'SPECIFIC-START ' + 's'.repeat(20_000));
    write(path.join(cwd, 'OBSIDIAN.md'), 'MOST-SPECIFIC-START ' + 'o'.repeat(20_000));
    const text = await ext.memoryText(cwd);
    expect(text.length).toBeLessThan(MEMORY_CAP_CHARS + 400);
    expect(text).toContain('MOST-SPECIFIC-START');
    expect(text).toContain('[Memory truncated');
  });

  it('picks up edits (mtime-checked cache)', async () => {
    const { root, ext } = setup();
    const cwd = path.join(root, 'edit');
    const file = write(path.join(cwd, 'CLAUDE.md'), 'VERSION-ONE');
    expect(await ext.memoryText(cwd)).toContain('VERSION-ONE');
    write(file, 'VERSION-TWO');
    const t = new Date(Date.now() + 5000);
    utimesSync(file, t, t);
    const text = await ext.memoryText(cwd);
    expect(text).toContain('VERSION-TWO');
    expect(text).not.toContain('VERSION-ONE');
  });

  it('handles CRLF files and a UTF-8 BOM', async () => {
    const { root, ext } = setup();
    const cwd = path.join(root, 'crlf');
    write(path.join(cwd, 'CLAUDE.md'), '﻿line one\r\nline two\r\n');
    const text = await ext.memoryText(cwd);
    expect(text).toContain('line one\nline two');
    expect(text).not.toContain('\r');
    expect(text).not.toContain('﻿');
  });
});
