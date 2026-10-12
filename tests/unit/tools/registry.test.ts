import { afterAll, describe, expect, it } from 'vitest';
import type { CoreContext, ToolDef } from '../../../src/core/contracts';
import { builtinTools, createShellRegistry, createToolRegistry } from '../../../src/core/tools';
import { normalizeInput, validateInput } from '../../../src/core/tools/lib/input';
import { displayPath, resolvePath } from '../../../src/core/tools/lib/paths';
import { cleanupTempDirs, makeCtx, makeTempDir } from './helpers';
import path from 'node:path';

afterAll(cleanupTempDirs);

const EXPECTED = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash', 'BashOutput', 'KillShell', 'PowerShell', 'WebFetch', 'WebSearch',
  'TodoWrite', 'AskUserQuestion', 'Task', 'ExitPlanMode', 'Skill', 'NotebookEdit', 'ScheduleTask', 'ListScheduledTasks', 'DeleteScheduledTask',
];

function fakeCore(mcp: ToolDef[] | (() => ToolDef[]) = []): CoreContext {
  return { ext: { mcpTools: typeof mcp === 'function' ? mcp : () => mcp }, activity: { upsert() {}, onStop() {} } } as unknown as CoreContext;
}

describe('createToolRegistry', () => {
  it('exposes exactly the model-facing tool names, in a stable order', () => {
    const reg = createToolRegistry(fakeCore());
    expect(reg.all().map((t) => t.name)).toEqual(EXPECTED);
    expect(builtinTools().map((t) => t.name)).toEqual(EXPECTED);
    expect(reg.all().map((t) => t.name)).toEqual(reg.all().map((t) => t.name));
  });

  it('get() finds tools by exact or case-insensitive name', () => {
    const reg = createToolRegistry(fakeCore());
    expect(reg.get('Bash')?.name).toBe('Bash');
    expect(reg.get('bash')?.name).toBe('Bash');
    expect(reg.get('TODOWRITE')?.name).toBe('TodoWrite');
    expect(reg.get('Nope')).toBeUndefined();
  });

  it('appends ctx.ext.mcpTools() (sorted), never shadowing built-ins, and survives ext errors', () => {
    const mk = (name: string): ToolDef => ({
      name, description: 'mcp', inputSchema: { type: 'object', properties: {} }, permission: () => 'exec', title: () => name, concurrencySafe: false,
      run: async () => ({ content: 'ok' }),
    });
    const reg = createToolRegistry(fakeCore([mk('mcp__z__b'), mk('mcp__a__x'), mk('Read')]));
    const names = reg.all().map((t) => t.name);
    expect(names.slice(0, EXPECTED.length)).toEqual(EXPECTED);
    expect(names.slice(EXPECTED.length)).toEqual(['mcp__a__x', 'mcp__z__b']);
    expect(reg.get('mcp__a__x')?.name).toBe('mcp__a__x');
    expect(reg.get('Read')?.description).not.toBe('mcp');
    const broken = createToolRegistry(fakeCore(() => { throw new Error('not started'); }));
    expect(broken.all()).toHaveLength(EXPECTED.length);
    expect(createToolRegistry({} as CoreContext).all()).toHaveLength(EXPECTED.length);
  });

  it('reflects MCP tools that appear later (lazy ctx use)', () => {
    let tools: ToolDef[] = [];
    const reg = createToolRegistry(fakeCore(() => tools));
    expect(reg.all()).toHaveLength(EXPECTED.length);
    tools = [{ name: 'mcp__s__t', description: '', inputSchema: {}, permission: () => 'exec', title: () => '', concurrencySafe: false, run: async () => ({ content: '' }) }];
    expect(reg.all()).toHaveLength(EXPECTED.length + 1);
    expect(reg.get('mcp__s__t')).toBeDefined();
  });
});

describe('createShellRegistry', () => {
  it('implements the ShellRegistry contract without touching other modules at construction', () => {
    const reg = createShellRegistry({} as CoreContext);
    expect(typeof reg.start).toBe('function');
    expect(reg.list()).toEqual([]);
    expect(reg.output('x')).toEqual({ output: '', running: false, exitCode: null });
    expect(reg.kill('x')).toBe(false);
  });
});

describe('tool definitions', () => {
  const tools = builtinTools();

  it.each(tools.map((t) => [t.name, t] as const))('%s has a well-formed definition', (_name, t) => {
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.description.length).toBeLessThan(900);
    const schema = t.inputSchema as { type: string; properties: Record<string, { type?: string; description?: string }>; required?: string[] };
    expect(schema.type).toBe('object');
    expect(typeof schema.properties).toBe('object');
    for (const r of schema.required ?? []) expect(Object.keys(schema.properties)).toContain(r);
    expect(typeof t.concurrencySafe).toBe('boolean');
    expect(['read', 'edit', 'exec', 'network', 'none']).toContain(t.permission({} as never, { cwd: '.', settings: makeCtx('.').settings }));
    expect(typeof t.title({} as never)).toBe('string');
    expect(() => JSON.stringify(t.inputSchema)).not.toThrow();
  });

  it('keeps the whole tool list small enough for local models (~3.5k tokens)', () => {
    const size = tools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }).length, 0);
    expect(size).toBeLessThan(13_500);
  });

  it('permission kinds match the spec', () => {
    const c = { cwd: '.', settings: makeCtx('.').settings };
    const kind = (name: string, input: Record<string, unknown> = {}) => builtinTools().find((t) => t.name === name)!.permission(input as never, c);
    for (const n of ['Read', 'Glob', 'Grep', 'LS', 'BashOutput']) expect(kind(n)).toBe('read');
    for (const n of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(kind(n)).toBe('edit');
    expect(kind('Bash', { command: 'npm install' })).toBe('exec');
    expect(kind('Bash', { command: 'git status' })).toBe('read');
    expect(kind('PowerShell', { command: 'Remove-Item x' })).toBe('exec');
    expect(kind('KillShell')).toBe('none');
    for (const n of ['WebFetch', 'WebSearch']) expect(kind(n)).toBe('network');
    for (const n of ['TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Skill', 'Task']) expect(kind(n)).toBe('none');
    for (const n of ['ScheduleTask', 'ListScheduledTasks', 'DeleteScheduledTask']) expect(kind(n)).toBe('exec');
  });

  it('read-only tools are concurrency safe, mutating ones are not', () => {
    const safe = new Set(tools.filter((t) => t.concurrencySafe).map((t) => t.name));
    for (const n of ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'BashOutput', 'Task']) expect(safe.has(n)).toBe(true);
    for (const n of ['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell', 'TodoWrite', 'NotebookEdit']) expect(safe.has(n)).toBe(false);
  });

  it('ruleFor suggestions look like permission rules', () => {
    expect(tools.find((t) => t.name === 'Edit')!.ruleFor?.({} as never)).toBe('Edit');
    expect(tools.find((t) => t.name === 'WebFetch')!.ruleFor?.({ url: 'https://example.com/x' } as never)).toBe('WebFetch(domain:example.com)');
    expect(tools.find((t) => t.name === 'Bash')!.ruleFor?.({ command: 'npm test --silent' } as never)).toBe('Bash(npm test:*)');
  });

  it('run() never throws: bad input becomes an error result', async () => {
    const ctx = makeCtx(makeTempDir());
    for (const t of tools) {
      const r = await t.run(undefined as never, ctx);
      expect(typeof r.content).toBe('string');
    }
  });
});

describe('input normalisation', () => {
  const schema = {
    type: 'object',
    properties: {
      file_path: { type: 'string' }, offset: { type: 'integer' }, flag: { type: 'boolean' }, mode: { type: 'string', enum: ['in_progress', 'done'] },
      list: { type: 'array', items: { type: 'string' } }, obj: { type: 'object', properties: { n: { type: 'number' } } },
    },
    required: ['file_path'],
  };

  it('coerces strings to numbers/booleans/arrays/objects and drops nulls', () => {
    const n = normalizeInput(schema, { file_path: 5, offset: '12', flag: 'TRUE', list: 'one', obj: '{"n":"2.5"}', extra: null, mode: 'In-Progress' });
    expect(n).toEqual({ file_path: '5', offset: 12, flag: true, list: ['one'], obj: { n: 2.5 }, mode: 'in_progress', extra: undefined });
    expect(normalizeInput(schema, { file_path: 'a', offset: null, flag: '' })).toEqual({ file_path: 'a' });
    expect(normalizeInput(schema, { file_path: 'a', list: '["x","y"]' }).list).toEqual(['x', 'y']);
    expect(normalizeInput(schema, '{"file_path":"z"}')).toEqual({ file_path: 'z' });
    expect(normalizeInput(schema, 'garbage')).toEqual({});
    expect(normalizeInput(schema, undefined)).toEqual({});
    expect(normalizeInput(schema, [1, 2])).toEqual({});
  });

  it('maps camelCase and aliased keys to schema names', () => {
    expect(normalizeInput(schema, { filePath: 'a' })).toEqual({ file_path: 'a' });
    expect(normalizeInput(schema, { path: 'b' }, { file_path: ['path'] })).toEqual({ file_path: 'b' });
    expect(normalizeInput(schema, { file_path: 'keep', path: 'ignored' }, { file_path: ['path'] }).file_path).toBe('keep');
  });

  it('validates required fields, types and enums with readable messages', () => {
    expect(validateInput(schema, { file_path: 'a' })).toBeNull();
    expect(validateInput(schema, {})).toBe('Missing required parameter "file_path"');
    expect(validateInput(schema, { file_path: 'a', offset: 1.5 })).toContain('expected integer');
    expect(validateInput(schema, { file_path: 'a', mode: 'x' })).toContain('must be one of');
    expect(validateInput(schema, { file_path: 'a', list: [1] })).toContain('list[0]');
  });
});

describe('paths', () => {
  const cwd = makeTempDir();

  it('resolves relative, absolute, quoted, forward-slash and ~ paths', () => {
    expect(resolvePath('a/b.txt', cwd)).toBe(path.join(cwd, 'a', 'b.txt'));
    expect(resolvePath(`"${path.join(cwd, 'x y.txt')}"`, cwd)).toBe(path.join(cwd, 'x y.txt'));
    expect(resolvePath(cwd.replace(/\\/g, '/') + '/z.txt', cwd)).toBe(path.join(cwd, 'z.txt'));
    expect(resolvePath('./sub/../q.txt', cwd)).toBe(path.join(cwd, 'q.txt'));
    expect(resolvePath('~', cwd)).toBe(path.resolve(require('node:os').homedir()));
    expect(resolvePath('dir/', cwd)).toBe(path.join(cwd, 'dir'));
    const fileUrl = `file:///${encodeURI(cwd.replace(/\\/g, '/'))}/f.txt`.replace('file:////', 'file:///');
    expect(resolvePath(process.platform === 'win32' ? fileUrl : fileUrl.replace('file:///', 'file:////'), cwd)).toBe(path.join(cwd, 'f.txt'));
  });

  it.runIf(process.platform === 'win32')('understands Git-Bash style drive paths (/c/Users/…)', () => {
    expect(resolvePath('/c/Users/x/f.txt', 'D:\\other')).toBe('C:\\Users\\x\\f.txt');
    expect(resolvePath('/mnt/c/Users', 'D:\\other')).toBe('C:\\Users');
    expect(resolvePath('c:\\Temp\\a.txt', 'D:\\other')).toBe('C:\\Temp\\a.txt');
  });

  it('displays cwd-relative paths with forward slashes, absolute otherwise', () => {
    expect(displayPath(path.join(cwd, 'src', 'a.ts'), cwd)).toBe('src/a.ts');
    expect(displayPath(cwd, cwd)).toBe('.');
    expect(displayPath(path.join(cwd, '..', 'other.txt'), cwd)).toBe(path.resolve(cwd, '..', 'other.txt').replace(/\\/g, '/'));
  });
});
