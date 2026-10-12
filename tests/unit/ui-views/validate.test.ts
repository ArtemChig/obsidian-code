import { describe, expect, it } from 'vitest';
import {
  HOOKS_EXAMPLE,
  MCP_EXAMPLE,
  joinArgs,
  locateJsonError,
  parseJson,
  parseModelList,
  slugify,
  splitArgs,
  validateHooks,
  validateMcpServers,
  validateNumber,
  validateProfiles,
  validateRule,
  validateUrl,
} from '@renderer/features/settings/validate';

describe('parseJson', () => {
  it('parses valid JSON and treats empty text as {}', () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson('   ')).toEqual({ ok: true, value: {} });
  });

  it('reports the line and column of a syntax error', () => {
    const r = parseJson('{\n  "a": 1,\n  "b": ,\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBe(3);
      expect(r.error).toMatch(/line 3/);
    }
  });
});

describe('locateJsonError', () => {
  it('returns null for valid JSON', () => {
    expect(locateJsonError('{"a":[1,2,{"b":null}],"c":"x\\ny","d":-1.5e3,"e":true}')).toBeNull();
    expect(locateJsonError('[]')).toBeNull();
  });

  it('finds the first problem and explains it', () => {
    expect(locateJsonError('{"a":1,}')?.message).toMatch(/Trailing comma/);
    expect(locateJsonError('[1,2,]')?.message).toMatch(/Trailing comma/);
    expect(locateJsonError('{"a" 1}')?.message).toMatch(/Expected ":"/);
    expect(locateJsonError('{a:1}')?.message).toMatch(/property name/);
    expect(locateJsonError('{"a":1')?.message).toMatch(/Expected "," or "}"/);
    expect(locateJsonError('{"a":"abc')?.message).toMatch(/Unterminated string/);
    expect(locateJsonError('{"a":1} x')?.message).toMatch(/after the end/);
    expect(locateJsonError('{"a":tru}')?.message).toMatch(/expected a value/);
  });

  it('points at a Windows path with single backslashes', () => {
    const text = '{"p":"C:\\Projects"}';
    const r = locateJsonError(text);
    expect(r?.message).toMatch(/Invalid escape/);
    expect(text[r?.pos ?? 0]).toBe('\\');
  });
});

describe('validateMcpServers', () => {
  it('accepts stdio and http servers', () => {
    expect(validateMcpServers(MCP_EXAMPLE)).toEqual([]);
    expect(validateMcpServers({})).toEqual([]);
    expect(validateMcpServers({ s: { type: 'sse', url: 'http://localhost:9000/sse' } })).toEqual([]);
  });

  it('reports every problem with the server name', () => {
    expect(validateMcpServers([])).toHaveLength(1);
    const errs = validateMcpServers({
      a: { args: ['x'] },
      b: { type: 'http', url: 'ftp://nope' },
      c: { command: 'npx', args: 'nope' },
      d: { command: 'npx', env: { A: 1 } },
      e: { command: 'x', enabled: 'yes' },
      'bad name': { command: 'x' },
      f: 'text',
      'g__h': { command: 'x' },
      i: { type: 'pipe', command: 'x' },
    });
    const joined = errs.join('\n');
    expect(joined).toMatch(/a: "command" is required/);
    expect(joined).toMatch(/b: "url" must be an http/);
    expect(joined).toMatch(/c: "args"/);
    expect(joined).toMatch(/d: "env"/);
    expect(joined).toMatch(/e: "enabled"/);
    expect(joined).toMatch(/bad name/);
    expect(joined).toMatch(/f: must be an object/);
    expect(joined).toMatch(/g__h/);
    expect(joined).toMatch(/i: "type"/);
  });
});

describe('validateHooks', () => {
  it('accepts the documented shape', () => {
    expect(validateHooks(HOOKS_EXAMPLE)).toEqual([]);
    expect(validateHooks({})).toEqual([]);
  });

  it('rejects unknown events, missing commands and bad timeouts', () => {
    const errs = validateHooks({ Nope: [], PreToolUse: [{ matcher: 5 }, { command: 'x', timeoutMs: -1 }, 'str'], Stop: {} }).join('\n');
    expect(errs).toMatch(/"Nope" is not a hook event/);
    expect(errs).toMatch(/PreToolUse\[0\]: "command" is required/);
    expect(errs).toMatch(/PreToolUse\[0\]: "matcher"/);
    expect(errs).toMatch(/PreToolUse\[1\]: "timeoutMs"/);
    expect(errs).toMatch(/PreToolUse\[2\]: must be an object/);
    expect(errs).toMatch(/Stop: must be an array/);
  });
});

const profile = {
  id: 'light',
  label: 'Light',
  description: 'x',
  gpuNames: ['RTX 5090'],
  numGpus: 1,
  minGpuRamGb: 30,
  minCpuRamGb: 32,
  minDiskGb: 80,
  minInetDownMbps: 500,
  minReliability: 0.98,
  maxPricePerHour: 1,
  datacenterOnly: false,
  defaultModelId: 'qwen38-27b-uncensored-hauhau-q5kp',
};

describe('validateProfiles', () => {
  it('accepts a valid list and normalises it', () => {
    const r = validateProfiles([profile, { ...profile, id: 'max', numGpus: 2, label: ' Max ', gpuNames: [' RTX PRO 6000 '] }]);
    expect(r.errors).toEqual([]);
    expect(r.profiles?.[1]).toMatchObject({ id: 'max', label: 'Max', gpuNames: ['RTX PRO 6000'] });
  });

  it('rejects non-arrays, empty lists, duplicates and bad numbers with the path', () => {
    expect(validateProfiles({}).errors[0]).toMatch(/array/);
    expect(validateProfiles([]).errors[0]).toMatch(/at least one/);
    const errs = validateProfiles([profile, { ...profile }, { ...profile, id: 'Bad Id', numGpus: 0, minReliability: 2, maxPricePerHour: 0, gpuNames: [], datacenterOnly: 'no', defaultModelId: '' }]).errors.join('\n');
    expect(errs).toMatch(/profiles\[1\]\.id: "light" is used twice/);
    expect(errs).toMatch(/profiles\[2\]\.id/);
    expect(errs).toMatch(/profiles\[2\]\.numGpus/);
    expect(errs).toMatch(/profiles\[2\]\.minReliability/);
    expect(errs).toMatch(/profiles\[2\]\.maxPricePerHour/);
    expect(errs).toMatch(/profiles\[2\]\.gpuNames/);
    expect(errs).toMatch(/profiles\[2\]\.datacenterOnly/);
    expect(errs).toMatch(/profiles\[2\]\.defaultModelId/);
  });
});

describe('rules, urls, numbers', () => {
  it('validateRule', () => {
    for (const ok of ['Bash', 'Bash(npm test:*)', 'WebFetch(domain:docs.vast.ai)', 'Read(src/**)', 'mcp__fs__read']) expect(validateRule(ok)).toBeNull();
    for (const bad of ['', '  ', 'Bash(', 'Bash()', '(x)', '1Bash', 'Bash npm']) expect(validateRule(bad)).toBeTruthy();
  });

  it('validateUrl', () => {
    expect(validateUrl('http://127.0.0.1:8080')).toBeNull();
    expect(validateUrl('https://openrouter.ai/api/v1')).toBeNull();
    expect(validateUrl('')).toBeTruthy();
    expect(validateUrl('', { allowEmpty: true })).toBeNull();
    expect(validateUrl('localhost:8080')).toBeTruthy();
    expect(validateUrl('ftp://x.y')).toBeTruthy();
  });

  it('validateNumber', () => {
    expect(validateNumber('150', { min: 1, max: 1000 })).toEqual({ ok: true, value: 150 });
    expect(validateNumber('2.5', { min: 0.5 })).toEqual({ ok: true, value: 2.5 });
    expect(validateNumber('2.5', { integer: true })).toMatchObject({ ok: false });
    expect(validateNumber('0', { min: 1 })).toMatchObject({ ok: false, error: 'Must be at least 1' });
    expect(validateNumber('99999', { max: 65535 })).toMatchObject({ ok: false });
    expect(validateNumber('abc', {})).toMatchObject({ ok: false });
    expect(validateNumber('', {})).toMatchObject({ ok: false });
  });
});

describe('small parsers', () => {
  it('slugify keeps ids unique', () => {
    expect(slugify('My Server!')).toBe('my-server');
    expect(slugify('OpenRouter', ['openrouter'])).toBe('openrouter-2');
    expect(slugify('OpenRouter', ['openrouter', 'openrouter-2'])).toBe('openrouter-3');
    expect(slugify('***')).toBe('endpoint');
  });

  it('splitArgs honours quotes and joinArgs re-quotes', () => {
    expect(splitArgs('--ctx-size 8192 --chat-template "my template" -b 2')).toEqual(['--ctx-size', '8192', '--chat-template', 'my template', '-b', '2']);
    expect(splitArgs('')).toEqual([]);
    expect(joinArgs(['--a', 'b c', 'd'])).toBe('--a "b c" d');
  });

  it('parseModelList splits on commas and newlines and de-duplicates', () => {
    expect(parseModelList('a, b\nc,,a\n')).toEqual(['a', 'b', 'c']);
  });
});
