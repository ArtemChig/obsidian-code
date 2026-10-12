// ui-chat: composer helpers (palette triggers, completions, permission modes) and the fuzzy matcher.
import { describe, expect, it } from 'vitest';
import type { PermissionMode } from '@shared/types';
import {
  applyCompletion,
  base64Bytes,
  detectTrigger,
  mentionFor,
  nextPermissionMode,
  parseDataUrl,
} from '@renderer/features/chat/lib/composer';
import { fuzzyRank, fuzzyScore } from '@renderer/features/chat/lib/fuzzy';

describe('detectTrigger', () => {
  it('opens the slash palette only inside the first word of a "/" message', () => {
    expect(detectTrigger('/', 1)).toMatchObject({ kind: 'slash', query: '', start: 0, end: 1 });
    expect(detectTrigger('/comp', 5)).toMatchObject({ kind: 'slash', query: 'comp' });
    expect(detectTrigger('/compact focus', 14)).toBeNull();
    expect(detectTrigger('/compact focus', 3)).toMatchObject({ kind: 'slash', query: 'co', end: 8 });
    expect(detectTrigger('hello /x', 8)).toBeNull();
  });

  it('opens the mention palette for an @word at the caret', () => {
    expect(detectTrigger('look at @src/ap', 15)).toMatchObject({ kind: 'mention', query: 'src/ap', start: 8, end: 15 });
    expect(detectTrigger('@', 1)).toMatchObject({ kind: 'mention', query: '' });
    // caret in the middle of the token: query is what is left of the caret, end covers the whole word
    expect(detectTrigger('see @rpc.ts now', 8)).toMatchObject({ query: 'rpc', end: 11 });
    expect(detectTrigger('mail me@host.com', 16)).toBeNull();
    expect(detectTrigger('plain text', 5)).toBeNull();
  });
});

describe('applyCompletion', () => {
  it('replaces the token and adds one space', () => {
    const t = detectTrigger('/comp', 5)!;
    expect(applyCompletion('/comp', t, '/compact')).toEqual({ text: '/compact ', caret: 9 });
  });

  it('does not double the space when one follows', () => {
    const text = 'see @rp and more';
    const t = detectTrigger(text, 7)!;
    const r = applyCompletion(text, t, '@src/rpc.ts');
    expect(r.text).toBe('see @src/rpc.ts and more');
    expect(r.caret).toBe('see @src/rpc.ts '.length);
  });
});

describe('mentions, modes, images', () => {
  it('mentionFor normalises Windows paths and quotes spaces', () => {
    expect(mentionFor('src\\core\\a.ts')).toBe('@src/core/a.ts');
    expect(mentionFor('./docs/My Notes.md')).toBe('@"docs/My Notes.md"');
  });

  it('Shift+Tab cycles default → acceptEdits → plan → bypass → default', () => {
    const seen: PermissionMode[] = [];
    let m: PermissionMode = 'default';
    for (let i = 0; i < 4; i++) {
      m = nextPermissionMode(m);
      seen.push(m);
    }
    expect(seen).toEqual(['acceptEdits', 'plan', 'bypassPermissions', 'default']);
  });

  it('parses data URLs and estimates sizes', () => {
    expect(parseDataUrl('data:image/png;base64,AAAA')).toEqual({ mediaType: 'image/png', data: 'AAAA' });
    expect(parseDataUrl('https://x/y.png')).toBeNull();
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AA==')).toBe(1);
  });
});

describe('fuzzy', () => {
  it('ranks exact > prefix > substring > subsequence', () => {
    const exact = fuzzyScore('plan', 'plan')!;
    const prefix = fuzzyScore('pl', 'plan')!;
    const sub = fuzzyScore('lan', 'plan')!;
    const seq = fuzzyScore('pn', 'plan')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(fuzzyScore('zz', 'plan')).toBeNull();
  });

  it('fuzzyRank uses secondary fields with lower weight and keeps order on ties', () => {
    type Cmd = { name: string; description: string };
    const cmds: Cmd[] = [
      { name: 'compact', description: 'Summarize older history' },
      { name: 'cost', description: 'Show token usage' },
      { name: 'clear', description: 'Start a new conversation' },
    ];
    // Both are prefix matches: the closer (shorter) name wins; 'clear' does not match "co" at all by name.
    expect(fuzzyRank(cmds, 'co', (c: Cmd) => [c.name, c.description]).map((c: Cmd) => c.name).slice(0, 2)).toEqual(['cost', 'compact']);
    expect(fuzzyRank(cmds, 'usage', (c: Cmd) => [c.name, c.description]).map((c: Cmd) => c.name)).toEqual(['cost']);
    expect(fuzzyRank(cmds, '', (c: Cmd) => [c.name]).map((c: Cmd) => c.name)).toEqual(['compact', 'cost', 'clear']);
  });
});
