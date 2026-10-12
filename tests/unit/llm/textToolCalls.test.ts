import { describe, expect, it } from 'vitest';
import type { ChatToolSpec } from '@core/contracts';
import { coerceValue, parseTextToolCalls } from '@core/llm/textToolCalls';

const TOOLS: ChatToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read_file', description: '',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }, offset: { type: 'integer' }, ratio: { type: 'number' }, verbose: { type: 'boolean' },
          tags: { type: 'array' }, options: { type: 'object' }, maybe: { type: ['string', 'null'] }, anything: {},
        },
      },
    },
  },
  { type: 'function', function: { name: 'get_time', description: '', parameters: { type: 'object', properties: {} } } },
];

describe('text-form tool-call fallback parser', () => {
  it('Qwen XML with schema coercion; strips exactly one leading/trailing newline', () => {
    const text = '<tool_call>\n<function=read_file>\n<parameter=path>\nC:\\tmp\\a.txt\n</parameter>\n<parameter=offset>\n10\n</parameter>\n'
      + '<parameter=ratio>\n0.5\n</parameter>\n<parameter=verbose>\ntrue\n</parameter>\n<parameter=tags>\n["x", "y"]\n</parameter>\n'
      + '<parameter=options>\n{"encoding": "utf-8"}\n</parameter>\n<parameter=anything>\n42\n</parameter>\n</function>\n</tool_call>';
    const r = parseTextToolCalls(text, TOOLS);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('read_file');
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({
      path: 'C:\\tmp\\a.txt', offset: 10, ratio: 0.5, verbose: true, tags: ['x', 'y'], options: { encoding: 'utf-8' }, anything: 42,
    });
    expect(r.rest).toBe('');
  });

  it('multi-line string values keep inner newlines and indentation; string-typed numbers stay strings', () => {
    const code = 'def greet(name):\n    return f"Hi {name}"\n';
    const text = `<tool_call>\n<function=read_file>\n<parameter=path>\n123\n</parameter>\n<parameter=maybe>\n${code}\n</parameter>\n</function>\n</tool_call>`;
    const args = JSON.parse(parseTextToolCalls(text, TOOLS).calls[0]!.arguments);
    expect(args.path).toBe('123');
    expect(args.maybe).toBe(code);
  });

  it('Hermes JSON (arguments object or JSON string, or "parameters")', () => {
    const a = parseTextToolCalls('<tool_call>\n{"name": "get_time", "arguments": {"tz": "UTC"}}\n</tool_call>', TOOLS);
    expect(a.calls[0]).toMatchObject({ name: 'get_time', arguments: '{"tz":"UTC"}' });
    const b = parseTextToolCalls('<tool_call>{"name":"get_time","arguments":"{\\"tz\\":\\"CET\\"}"}</tool_call>', TOOLS);
    expect(JSON.parse(b.calls[0]!.arguments)).toEqual({ tz: 'CET' });
    const c = parseTextToolCalls('<tool_call>{"name":"get_time","parameters":{"a":1}}</tool_call>', TOOLS);
    expect(JSON.parse(c.calls[0]!.arguments)).toEqual({ a: 1 });
  });

  it('GLM arg_key/arg_value form', () => {
    const text = '<tool_call>read_file\n<arg_key>path</arg_key>\n<arg_value>src/x.ts</arg_value>\n<arg_key>offset</arg_key>\n<arg_value>5</arg_value>\n</tool_call>';
    const r = parseTextToolCalls(text, TOOLS);
    expect(r.calls[0]!.name).toBe('read_file');
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ path: 'src/x.ts', offset: 5 });
  });

  it('GLM bare known tool name without args; unknown bare word is not a call', () => {
    expect(parseTextToolCalls('<tool_call>get_time</tool_call>', TOOLS).calls).toHaveLength(1);
    expect(parseTextToolCalls('<tool_call>hello</tool_call>', TOOLS).calls).toHaveLength(0);
  });

  it('missing final </tool_call>, bare <function=> blocks, several calls, text around', () => {
    const r = parseTextToolCalls('Let me check.\n<tool_call>\n<function=get_time>\n</function>\n</tool_call>\n<tool_call>\n<function=read_file>\n<parameter=path>\na\n</parameter>\n</function>', TOOLS);
    expect(r.calls.map((c) => c.name)).toEqual(['get_time', 'read_file']);
    expect(r.rest).toBe('Let me check.');
    const bare = parseTextToolCalls('<function=read_file>\n<parameter=path>\nb\n</parameter>\n</function>', TOOLS);
    expect(JSON.parse(bare.calls[0]!.arguments)).toEqual({ path: 'b' });
  });

  it('unparseable blocks stay text', () => {
    const r = parseTextToolCalls('<tool_call>{broken json</tool_call>', TOOLS);
    expect(r.calls).toHaveLength(0);
    expect(r.rest).toBe('<tool_call>{broken json</tool_call>');
  });

  it('coerceValue edge cases', () => {
    expect(coerceValue('abc', { type: 'integer' })).toBe('abc');
    expect(coerceValue(' false ', { type: 'boolean' })).toBe(false);
    expect(coerceValue('[1', { type: 'array' })).toBe('[1');
    expect(coerceValue('{"a":1}', undefined)).toEqual({ a: 1 });
    expect(coerceValue('plain', undefined)).toBe('plain');
    expect(coerceValue('null', { type: ['string', 'null'] })).toBe(null);
  });
});
