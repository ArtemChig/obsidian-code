import { mkdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtensions } from '@core/ext';
import { BUILTIN_COMMANDS, substituteArguments } from '@core/ext/commands';
import { parseMarkdown } from '@core/ext/frontmatter';
import { splitArgs } from '@core/ext/util';
import { cleanupTmp, makeCtx, tmpDir, write } from './helpers';

afterEach(cleanupTmp);

function setup(patch: Parameters<typeof makeCtx>[1] = {}) {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const fake = makeCtx(path.join(root, 'data'), patch);
  const ext = createExtensions(fake.ctx, { homeDir: home });
  return { root, home, cwd, ext, fake };
}

describe('frontmatter', () => {
  it('parses YAML, CRLF and BOM; tolerates unquoted colons; refuses js engines', () => {
    expect(parseMarkdown('---\nname: a\ndescription: "x: y"\n---\nbody').data).toEqual({ name: 'a', description: 'x: y' });
    expect(parseMarkdown('﻿---\r\nname: crlf\r\n---\r\nhello\r\n').data.name).toBe('crlf');
    const lenient = parseMarkdown('---\nname: skill\ndescription: Use when: the user asks about x\n---\nbody text');
    expect(lenient.data).toEqual({ name: 'skill', description: 'Use when: the user asks about x' });
    expect(lenient.body).toBe('body text');
    const js = parseMarkdown('---js\n({ name: "pwned" })\n---\nbody');
    expect(js.data.name).toBeUndefined();
    expect(parseMarkdown('no frontmatter').body).toBe('no frontmatter');
  });
});

describe('skills', () => {
  it('discovers user + project skills, honours importClaudeConfig, project overrides user', async () => {
    const { home, cwd, ext, fake } = setup({ importClaudeConfig: false });
    write(path.join(home, '.obsidian-code', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: User PDF skill\n---\nUser body');
    write(path.join(cwd, '.obsidian-code', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Project PDF skill\n---\nProject body');
    write(path.join(cwd, '.obsidian-code', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy it\n---\nSteps...');
    write(path.join(home, '.claude', 'skills', 'cu', 'SKILL.md'), '---\nname: claude-user\ndescription: from ~/.claude\n---\nx');
    write(path.join(cwd, '.claude', 'skills', 'cp', 'SKILL.md'), '---\nname: claude-project\ndescription: from .claude\n---\nx');
    write(path.join(cwd, '.obsidian-code', 'skills', 'README.md'), 'not a skill dir entry');

    let list = await ext.skills(cwd);
    expect(list.map((s) => s.name)).toEqual(['deploy', 'pdf']);
    const pdf = list.find((s) => s.name === 'pdf')!;
    expect(pdf.description).toBe('Project PDF skill');
    expect(pdf.source).toBe('project');
    expect(pdf.path).toBe(path.join(cwd, '.obsidian-code', 'skills', 'pdf', 'SKILL.md'));

    fake.update({ importClaudeConfig: true });
    list = await ext.skills(cwd);
    expect(list.map((s) => `${s.name}:${s.source}`)).toEqual(['claude-project:claude-project', 'claude-user:claude-user', 'deploy:project', 'pdf:project']);
  });

  it('falls back to the dir name and first body line when frontmatter is thin', async () => {
    const { cwd, ext } = setup();
    write(path.join(cwd, '.obsidian-code', 'skills', 'my-skill', 'SKILL.md'), '# Does a thing\n\nMore text');
    const [s] = await ext.skills(cwd);
    expect(s!.name).toBe('my-skill');
    expect(s!.description).toBe('Does a thing');
  });

  it('loadSkill returns the body without frontmatter and the skill dir; null when unknown', async () => {
    const { cwd, ext } = setup();
    const dir = path.join(cwd, '.obsidian-code', 'skills', 'release');
    write(path.join(dir, 'SKILL.md'), '---\nname: release\ndescription: Cut a release\n---\n\n# Release\n1. tag\n2. push\n');
    write(path.join(dir, 'helper.sh'), 'echo hi');
    const sk = await ext.loadSkill(cwd, 'release');
    expect(sk).toEqual({ name: 'release', body: '# Release\n1. tag\n2. push', dir });
    expect((await ext.loadSkill(cwd, 'RELEASE'))?.name).toBe('release');
    expect(await ext.loadSkill(cwd, 'nope')).toBeNull();
  });

  it('re-reads a skill after it changes (mtime-checked cache)', async () => {
    const { cwd, ext } = setup();
    const file = write(path.join(cwd, '.obsidian-code', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: one\n---\nbody 1');
    expect((await ext.skills(cwd))[0]!.description).toBe('one');
    write(file, '---\nname: x\ndescription: two\n---\nbody 2');
    const t = new Date(Date.now() + 5000);
    utimesSync(file, t, t);
    expect((await ext.skills(cwd))[0]!.description).toBe('two');
    expect((await ext.loadSkill(cwd, 'x'))!.body).toBe('body 2');
  });
});

describe('agents', () => {
  it('provides the builtin agent types with the right tool restrictions', async () => {
    const { cwd, ext } = setup();
    const types = await ext.agentTypes(cwd);
    expect(types.map((t) => t.name)).toEqual(['general-purpose', 'Explore', 'Plan']);
    expect(types.every((t) => t.source === 'builtin')).toBe(true);
    const gp = types.find((t) => t.name === 'general-purpose')!;
    expect(gp.tools).toBeUndefined(); // all tools
    for (const name of ['Explore', 'Plan']) {
      const t = types.find((x) => x.name === name)!;
      expect(t.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Bash']));
      expect(t.tools).not.toContain('Write');
      expect(t.tools).not.toContain('Edit');
      expect(t.tools).not.toContain('Task');
    }
    const explore = (await ext.agentDefinition(cwd, 'Explore'))!;
    expect(explore.systemPrompt).toMatch(/read-only/i);
    expect(explore.tools).toContain('Grep');
    const plan = (await ext.agentDefinition(cwd, 'plan'))!; // case-insensitive
    expect(plan.name).toBe('Plan');
    expect(plan.systemPrompt).toMatch(/plan/i);
    expect((await ext.agentDefinition(cwd, 'general-purpose'))!.tools).toBeUndefined();
    expect(await ext.agentDefinition(cwd, 'nope')).toBeNull();
  });

  it('loads custom agents: frontmatter tools (comma list / YAML list), model, body = system prompt', async () => {
    const { home, cwd, ext, fake } = setup({ importClaudeConfig: true });
    write(path.join(home, '.obsidian-code', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob\nmodel: qwen-35b\n---\nYou review code.\nBe terse.');
    write(path.join(cwd, '.obsidian-code', 'agents', 'doc-writer.md'), '---\ndescription: Writes docs\ntools:\n  - Read\n  - Write\nmodel: sonnet\n---\nWrite docs.');
    write(path.join(cwd, '.claude', 'agents', 'from-claude.md'), '---\nname: from-claude\ndescription: Imported agent\nmodel: inherit\n---\nPrompt.');
    const types = await ext.agentTypes(cwd);
    const reviewer = types.find((t) => t.name === 'reviewer')!;
    expect(reviewer).toMatchObject({ description: 'Reviews code', tools: ['Read', 'Grep', 'Glob'], model: 'qwen-35b', source: 'user' });
    const doc = types.find((t) => t.name === 'doc-writer')!; // name from file name
    expect(doc).toMatchObject({ tools: ['Read', 'Write'], source: 'project' });
    expect(doc.model).toBeUndefined(); // Claude aliases (sonnet/opus/haiku/inherit) are dropped
    expect(types.find((t) => t.name === 'from-claude')!.model).toBeUndefined();
    expect((await ext.agentDefinition(cwd, 'reviewer'))).toEqual({ name: 'reviewer', systemPrompt: 'You review code.\nBe terse.', tools: ['Read', 'Grep', 'Glob'], model: 'qwen-35b' });

    fake.update({ importClaudeConfig: false });
    expect((await ext.agentTypes(cwd)).some((t) => t.name === 'from-claude')).toBe(false);
  });

  it('lets a project agent override a builtin of the same name', async () => {
    const { cwd, ext } = setup();
    write(path.join(cwd, '.obsidian-code', 'agents', 'explore.md'), '---\nname: Explore\ndescription: Custom explorer\ntools: Read\n---\nCustom prompt');
    const types = await ext.agentTypes(cwd);
    expect(types.filter((t) => t.name.toLowerCase() === 'explore')).toHaveLength(1);
    const def = (await ext.agentDefinition(cwd, 'Explore'))!;
    expect(def.systemPrompt).toBe('Custom prompt');
    expect(def.tools).toEqual(['Read']);
  });
});

describe('slash commands', () => {
  it('lists the builtin commands (SPEC 4.1) with descriptions and argument hints', async () => {
    const { cwd, ext } = setup();
    const list = await ext.slashCommands(cwd);
    const names = list.filter((c) => c.source === 'builtin').map((c) => c.name);
    for (const n of ['clear', 'compact', 'model', 'plan', 'init', 'help', 'cost', 'todos', 'agents', 'skills', 'memory', 'thinking', 'rewind']) {
      expect(names).toContain(n);
    }
    expect(BUILTIN_COMMANDS.every((c) => c.description.length > 5)).toBe(true);
    expect(list.find((c) => c.name === 'model')!.argumentHint).toBe('<model id>');
    expect(list.find((c) => c.name === 'thinking')!.argumentHint).toBe('on|off');
    expect(list.find((c) => c.name === 'compact')!.argumentHint).toBeTruthy();
  });

  it('loads custom commands from user/project dirs; subdirectories become "dir:name"; project overrides user', async () => {
    const { home, cwd, ext, fake } = setup({ importClaudeConfig: false });
    write(path.join(home, '.obsidian-code', 'commands', 'review.md'), '---\ndescription: User review\n---\nUser review $ARGUMENTS');
    write(path.join(cwd, '.obsidian-code', 'commands', 'review.md'), '---\ndescription: Project review\nargument-hint: <pr number>\n---\nProject review $ARGUMENTS');
    write(path.join(cwd, '.obsidian-code', 'commands', 'frontend', 'component.md'), '---\ndescription: New component\n---\nMake component $1');
    write(path.join(cwd, '.obsidian-code', 'commands', 'frontend', 'deep', 'thing.md'), 'Deep thing');
    write(path.join(cwd, '.obsidian-code', 'commands', 'plain.md'), '# Heading line\nbody');
    write(path.join(cwd, '.claude', 'commands', 'claude-only.md'), 'from claude');
    write(path.join(cwd, '.obsidian-code', 'commands', 'help.md'), 'attempt to shadow builtin');

    let list = await ext.slashCommands(cwd);
    const custom = list.filter((c) => c.source !== 'builtin');
    expect(custom.map((c) => c.name)).toEqual(['frontend:component', 'frontend:deep:thing', 'plain', 'review']);
    expect(custom.find((c) => c.name === 'review')).toMatchObject({ description: 'Project review', source: 'project', argumentHint: '<pr number>' });
    expect(custom.find((c) => c.name === 'plain')!.description).toBe('Heading line');
    expect(list.filter((c) => c.name === 'help')).toHaveLength(1); // builtin wins
    expect(list.find((c) => c.name === 'help')!.source).toBe('builtin');

    fake.update({ importClaudeConfig: true });
    list = await ext.slashCommands(cwd);
    expect(list.some((c) => c.name === 'claude-only')).toBe(true);
  });

  it('expandCommand substitutes $ARGUMENTS and $1..$9; null for builtin/unknown names', async () => {
    const { cwd, ext } = setup();
    write(path.join(cwd, '.obsidian-code', 'commands', 'fix.md'), '---\ndescription: Fix\n---\nFix issue $1 in $2 (all: $ARGUMENTS) [$3]');
    write(path.join(cwd, '.obsidian-code', 'commands', 'ns', 'greet.md'), 'Hello $ARGUMENTS!');
    write(path.join(cwd, '.obsidian-code', 'commands', 'noargs.md'), 'Just run the tests.');
    write(path.join(cwd, '.obsidian-code', 'commands', 'price.md'), 'It costs $100 and $1.');

    expect(await ext.expandCommand(cwd, 'fix', '42 "src/my file.ts"')).toBe('Fix issue 42 in src/my file.ts (all: 42 "src/my file.ts") []');
    expect(await ext.expandCommand(cwd, '/fix', 'a b')).toBe('Fix issue a in b (all: a b) []');
    expect(await ext.expandCommand(cwd, 'ns:greet', 'World')).toBe('Hello World!');
    expect(await ext.expandCommand(cwd, 'noargs', '')).toBe('Just run the tests.');
    expect(await ext.expandCommand(cwd, 'noargs', 'focus on utils')).toBe('Just run the tests.\n\nARGUMENTS: focus on utils');
    expect(await ext.expandCommand(cwd, 'price', 'X')).toBe('It costs $100 and X.');
    expect(await ext.expandCommand(cwd, 'compact', 'x')).toBeNull();
    expect(await ext.expandCommand(cwd, 'does-not-exist', '')).toBeNull();
  });

  it('substituteArguments does not re-expand placeholders found inside the arguments', () => {
    expect(substituteArguments('A=$1 ALL=$ARGUMENTS', '$2 b')).toBe('A=$2 ALL=$2 b');
  });

  it('splitArgs handles quotes and escapes', () => {
    expect(splitArgs(`one "two words" 'three words' four\\ five "q\\"uote"`)).toEqual(['one', 'two words', 'three words', 'four\\', 'five', 'q"uote']);
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('""')).toEqual(['']);
  });
});
