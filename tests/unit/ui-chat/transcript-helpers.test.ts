// ui-chat: streaming markdown blocks, tool card summaries/defaults, git HEAD parsing.
import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@shared/types';
import { candidateDirs, parseGitDirFile, parseGitHead } from '@renderer/features/chat/lib/git';
import { splitMarkdownBlocks } from '@renderer/features/chat/lib/markdown-blocks';
import { activityLabel, defaultExpanded, planOutcome, toolFamily, toolSummary } from '@renderer/features/chat/lib/tool-meta';

const CWD = 'E:\\proj';

function tool(name: string, input: Record<string, unknown>, extra: Partial<ToolUseBlock> = {}): ToolUseBlock {
  return { type: 'tool_use', id: 't1', name, input, status: 'done', ...extra };
}

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs but keeps fenced code (with blank lines) whole', () => {
    const md = 'Intro line\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toEqual(['Intro line', '```ts\nconst a = 1;\n\nconst b = 2;\n```', 'Outro']);
  });

  it('keeps loose lists and tables together', () => {
    const md = '- one\n\n- two\n\n  continued\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks[0]).toBe('- one\n\n- two\n\n  continued');
    expect(blocks[1].startsWith('| a | b |')).toBe(true);
    expect(blocks[2]).toBe('After');
  });

  it('is stable for finished blocks while the last one streams', () => {
    const a = splitMarkdownBlocks('First para.\n\nSecond pa');
    const b = splitMarkdownBlocks('First para.\n\nSecond paragraph grows');
    expect(a[0]).toBe(b[0]);
    expect(a).toHaveLength(2);
  });

  it('treats an unterminated fence as one block', () => {
    expect(splitMarkdownBlocks('```js\nlet x\n\nlet y')).toHaveLength(1);
  });
});

describe('toolSummary', () => {
  it('summarises file tools with cwd-relative paths', () => {
    const s = toolSummary(
      tool('Edit', { file_path: 'E:\\proj\\src\\a.ts' }, { result: { content: '', display: { kind: 'diff', path: 'E:\\proj\\src\\a.ts', before: 'x\n', after: 'y\nz\n' } } }),
      CWD,
    );
    expect(s).toMatchObject({ verb: 'Edit', target: 'src/a.ts', meta: '+2 −1' });
    const r = toolSummary(
      tool('Read', { file_path: 'E:\\proj\\README.md' }, { result: { content: '', display: { kind: 'file', path: 'E:\\proj\\README.md', content: 'a\nb', startLine: 10, totalLines: 50 } } }),
      CWD,
    );
    expect(r).toMatchObject({ verb: 'Read', target: 'README.md', meta: 'lines 10–11 of 50' });
  });

  it('shows exit codes for shell tools and prefers the description', () => {
    const ok = toolSummary(tool('Bash', { command: 'npm test', description: 'Run tests' }, { result: { content: '', display: { kind: 'bash', command: 'npm test', output: '', exitCode: 0 } } }), CWD);
    expect(ok).toMatchObject({ verb: 'Run', target: 'Run tests', mono: false, meta: 'exit 0', metaTone: 'success' });
    const bad = toolSummary(tool('Bash', { command: 'tsc\n--noEmit' }, { result: { content: '', display: { kind: 'bash', command: 'tsc', output: '', exitCode: 2 } } }), CWD);
    expect(bad).toMatchObject({ target: 'tsc …', metaTone: 'danger' });
    const bg = toolSummary(tool('Bash', { command: 'npm run dev', run_in_background: true }, { result: { content: '', display: { kind: 'bash', command: 'x', output: '', exitCode: null, background: true } } }), CWD);
    expect(bg.meta).toBe('background');
  });

  it('counts list results and marks truncated lists', () => {
    const s = toolSummary(tool('Grep', { pattern: 'foo', glob: '*.ts' }, { result: { content: '', display: { kind: 'list', title: 'Grep foo (300+)', items: ['a', 'b'] } } }), CWD);
    expect(s).toMatchObject({ verb: 'Search', target: 'foo  in *.ts', meta: '2+ results' });
  });

  it('handles todos, plans, MCP and unknown tools', () => {
    const todo = toolSummary(tool('TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }] }), CWD);
    expect(todo.meta).toBe('1/2 done');
    const plan = toolSummary(tool('ExitPlanMode', {}, { result: { content: 'User has approved your plan.' } }), CWD);
    expect(plan).toMatchObject({ meta: 'approved', metaTone: 'success' });
    expect(toolSummary(tool('mcp__github__create_issue', {}), CWD)).toMatchObject({ verb: 'create_issue', target: 'github · MCP' });
    expect(toolSummary(tool('Custom', { thing: 'value' }), CWD)).toMatchObject({ verb: 'Custom', target: 'value' });
  });
});

describe('activityLabel', () => {
  it('describes what a running tool is doing', () => {
    expect(activityLabel(tool('Edit', { file_path: 'E:\\proj\\src\\a.ts' }, { status: 'running' }), CWD)).toBe('Editing src/a.ts');
    expect(activityLabel(tool('Bash', { command: 'npm test', description: 'Run the tests' }), CWD)).toBe('Run the tests');
    expect(activityLabel(tool('Bash', { command: 'npm   test' }), CWD)).toBe('Running npm test');
    expect(activityLabel(tool('Task', { description: 'Map the API', subagent_type: 'Explore' }), CWD)).toBe('Agent working: Map the API');
    expect(activityLabel(tool('Grep', { pattern: 'onclose' }), CWD)).toBe('Searching onclose');
  });
});

describe('tool defaults', () => {
  it('families', () => {
    expect(toolFamily('MultiEdit')).toBe('edit');
    expect(toolFamily('BashOutput')).toBe('shell');
    expect(toolFamily('mcp__x__y')).toBe('mcp');
  });

  it('expands edits, errors and short shell output; collapses reads and pending permission', () => {
    expect(defaultExpanded(tool('Edit', {}))).toBe(true);
    expect(defaultExpanded(tool('Read', {}))).toBe(false);
    expect(defaultExpanded(tool('Write', {}, { status: 'error' }))).toBe(true);
    expect(defaultExpanded(tool('Bash', {}, { status: 'awaiting_permission' }))).toBe(false);
    expect(defaultExpanded(tool('Bash', {}, { status: 'running' }))).toBe(true);
    expect(defaultExpanded(tool('Bash', {}, { result: { content: '', display: { kind: 'bash', command: 'x', output: 'ok', exitCode: 0 } } }))).toBe(true);
    expect(defaultExpanded(tool('Bash', {}, { result: { content: '', display: { kind: 'bash', command: 'x', output: '', exitCode: 0 } } }))).toBe(false);
  });

  it('planOutcome reads the ExitPlanMode result', () => {
    expect(planOutcome('User has approved your plan.')).toBe('approved');
    expect(planOutcome('The user did not approve the plan')).toBe('rejected');
    expect(planOutcome(undefined)).toBeNull();
  });
});

describe('git', () => {
  it('parses HEAD', () => {
    expect(parseGitHead('ref: refs/heads/feat/chat-ui\n')).toBe('feat/chat-ui');
    expect(parseGitHead('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
    expect(parseGitHead('garbage')).toBeNull();
    expect(parseGitDirFile('gitdir: ../.git/worktrees/x\n')).toBe('../.git/worktrees/x');
  });

  it('walks up parents including the drive root', () => {
    expect(candidateDirs('E:\\a\\b', 4)).toEqual(['E:\\a\\b', 'E:\\a', 'E:\\']);
    expect(candidateDirs('/home/u/p', 1)).toEqual(['/home/u/p', '/home/u']);
  });
});
