import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  formatBytes,
  formatClock,
  formatDuration,
  formatMoney,
  formatTokens,
  modelKey,
  parseModelKey,
  relativeTime,
  relativeToCwd,
  shortModelName,
  shortenPath,
} from '@renderer/lib/format';
import { langFromPath, resolveLang } from '@renderer/lib/highlighter';
import { groupModels, groupSessions } from '@renderer/state/selectors';
import type { SessionSummary } from '@shared/types';

const NOW = new Date('2026-10-12T12:00:00Z').getTime();

describe('format helpers', () => {
  it('relativeTime', () => {
    expect(relativeTime(NOW - 2_000, NOW)).toBe('now');
    expect(relativeTime(NOW - 45_000, NOW)).toBe('45s');
    expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe('12m');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 30 * 3_600_000, NOW, { short: true })).toBe('1d');
    expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe('4d');
    expect(relativeTime(NOW - 20 * 86_400_000, NOW, { short: true })).toBe('2w');
    expect(relativeTime(NOW + 5 * 60_000, NOW)).toBe('in 5m');
  });

  it('durations and clocks', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(184_000)).toBe('3m 04s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
    expect(formatClock(42_000)).toBe('0:42');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  it('money, tokens, bytes', () => {
    expect(formatMoney(1.19)).toBe('$1.19');
    expect(formatMoney(0.0042, { precise: true })).toBe('$0.004');
    expect(formatMoney(null)).toBe('—');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(1_250)).toBe('1.3k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('windows-aware paths', () => {
    expect(basename('E:\\programming projects\\obsidian-code\\')).toBe('obsidian-code');
    expect(basename('/home/x/proj')).toBe('proj');
    expect(dirname('C:\\a\\b\\c.ts')).toBe('C:\\a\\b');
    expect(relativeToCwd('E:\\p\\src\\a.ts', 'E:\\p')).toBe('src/a.ts');
    expect(relativeToCwd('D:\\other\\a.ts', 'E:\\p')).toBe('D:\\other\\a.ts');
    expect(shortenPath('C:\\Users\\dev\\code\\a\\b\\c\\d', 'C:\\Users\\dev', 2)).toBe('~\\…\\c\\d');
  });

  it('model helpers', () => {
    const ref = { provider: 'custom:or' as const, model: 'qwen/qwen3::x' };
    expect(parseModelKey(modelKey(ref))).toEqual(ref);
    expect(shortModelName('unsloth/Qwen3.8-27B-GGUF')).toBe('Qwen3.8-27B');
    expect(shortModelName('Qwen3.6-35B-A3B.gguf')).toBe('Qwen3.6-35B-A3B');
  });

  it('highlighter language resolution', () => {
    expect(resolveLang('ts')).toBe('typescript');
    expect(resolveLang('PS1')).toBe('powershell');
    expect(resolveLang('klingon')).toBeNull();
    expect(langFromPath('C:\\x\\app.tsx')).toBe('tsx');
    expect(langFromPath('/x/Dockerfile')).toBe('dockerfile');
    expect(langFromPath('notes.unknownext')).toBeUndefined();
  });
});

function s(id: string, cwd: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    cwd,
    kind: 'chat',
    createdAt: 0,
    updatedAt,
    status: 'idle',
    model: null,
    permissionMode: 'default',
    thinking: true,
    usage: { inputTokens: 0, outputTokens: 0, lastPromptTokens: 0, requests: 0 },
    ...extra,
  };
}

describe('selectors (pure)', () => {
  it('groups sessions: pinned first, then by folder (case-insensitive), newest first, subagents hidden', () => {
    const m = groupSessions([
      s('a', 'E:\\P\\One', 10),
      s('b', 'e:\\p\\one\\', 30),
      s('c', 'E:\\P\\Two', 20),
      s('d', 'E:\\P\\Two', 40, { pinned: true }),
      s('e', 'E:\\P\\One', 50, { kind: 'subagent', parentSessionId: 'a' }),
    ]);
    expect(m.pinned.map((x: SessionSummary) => x.id)).toEqual(['d']);
    expect(m.groups.map((g: { name: string }) => g.name)).toEqual(['one', 'Two']);
    expect(m.groups[0].sessions.map((x: SessionSummary) => x.id)).toEqual(['b', 'a']);
    expect(m.total).toBe(4);
    expect(groupSessions([s('a', 'C:\\x', 1, { title: 'Fix parser' }), s('b', 'C:\\y', 2)], 'parser').total).toBe(1);
  });

  it('groups models by provider and keeps unknown providers', () => {
    const groups = groupModels(
      [{ id: 'local', label: 'Local', status: 'online', baseUrl: null }],
      [
        { ref: { provider: 'local', model: 'a' }, label: 'A', contextLength: 1, supportsVision: false, supportsTools: true, supportsThinking: true, status: 'online' },
        { ref: { provider: 'vast', model: 'b' }, label: 'B', contextLength: 1, supportsVision: false, supportsTools: true, supportsThinking: true, status: 'online' },
      ],
    );
    expect(groups.map((g: { provider: { id: string }; models: unknown[] }) => [g.provider.id, g.models.length])).toEqual([
      ['local', 1],
      ['vast', 1],
    ]);
  });
});
