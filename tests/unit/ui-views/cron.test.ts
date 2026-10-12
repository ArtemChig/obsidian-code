import { describe, expect, it } from 'vitest';
import {
  buildSchedule,
  defaultScheduleForm,
  describeSchedule,
  isDescribed,
  isIsoTimestamp,
  nextRuns,
  parseSchedule,
  validateSchedule,
} from '@renderer/features/schedules/cron';

interface ScheduleForm {
  preset: 'hours' | 'daily' | 'weekdays' | 'weekly' | 'cron' | 'once';
  everyHours: string;
  time: string;
  weekday: string;
  cron: string;
  onceAt: string;
  runOnce: boolean;
}
const form = (patch: Partial<ScheduleForm>): ScheduleForm => ({ ...defaultScheduleForm(0), ...patch });
// A fixed "now" in local time: Mon 2026-10-12 12:00.
const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();

describe('describeSchedule', () => {
  it('describes common cron patterns in words', () => {
    expect(describeSchedule('0 2 * * *')).toBe('Every day at 02:00');
    expect(describeSchedule('30 8 * * 1-5')).toBe('Weekdays at 08:30');
    expect(describeSchedule('0 10 * * 6')).toBe('Every Saturday at 10:00');
    expect(describeSchedule('0 10 * * 6,0')).toBe('Weekends at 10:00');
    expect(describeSchedule('15 9 * * 1,3')).toBe('Every Mon, Wed at 09:15');
    expect(describeSchedule('0 */6 * * *')).toBe('Every 6 hours');
    expect(describeSchedule('0 * * * *')).toBe('Every hour');
    expect(describeSchedule('15 * * * *')).toBe('Every hour at :15');
    expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeSchedule('* * * * *')).toBe('Every minute');
    expect(describeSchedule('0 9,17 * * *')).toBe('Every day at 09:00 and 17:00');
    expect(describeSchedule('0 6,12,18 * * 1-5')).toBe('Weekdays at 06:00, 12:00 and 18:00');
    expect(describeSchedule('0 0,4,8,12,16 * * *')).toBe('5 times a day');
    expect(describeSchedule('0 3 1 * *')).toBe('Monthly on the 1st at 03:00');
    expect(describeSchedule('0 3 22 * *')).toBe('Monthly on the 22nd at 03:00');
  });

  it('handles 6-field cron with zero seconds, ISO timestamps and unknown patterns', () => {
    expect(describeSchedule('0 0 2 * * *')).toBe('Every day at 02:00');
    expect(describeSchedule('2026-10-13T09:00')).toBe('Once on Oct 13, 2026 at 09:00');
    expect(describeSchedule('5 4 * 6 *')).toBe('Custom cron');
    expect(describeSchedule('0 9 * * *', true)).toBe('Every day at 09:00 (once)');
    expect(describeSchedule('')).toBe('No schedule');
    expect(isDescribed('0 2 * * *')).toBe(true);
    expect(isDescribed('5 4 * 6 *')).toBe(false);
  });
});

describe('validateSchedule', () => {
  it('accepts cron expressions and ISO timestamps', () => {
    expect(validateSchedule('0 2 * * *')).toBeNull();
    expect(validateSchedule('*/5 * * * *')).toBeNull();
    expect(validateSchedule('2026-12-01T10:00')).toBeNull();
    expect(isIsoTimestamp('2026-12-01T10:00')).toBe(true);
    expect(isIsoTimestamp('0 2 * * *')).toBe(false);
  });

  it('rejects invalid input with a message', () => {
    expect(validateSchedule('')).toMatch(/enter/i);
    expect(validateSchedule('every day')).toMatch(/5 fields|invalid/i);
    expect(validateSchedule('99 * * * *')).toBeTruthy();
    expect(validateSchedule('* * * *')).toMatch(/5 fields/);
  });
});

describe('buildSchedule', () => {
  it('builds cron for each preset', () => {
    expect(buildSchedule(form({ preset: 'hours', everyHours: '6' }))).toEqual({ ok: true, schedule: '0 */6 * * *', oneShot: false });
    expect(buildSchedule(form({ preset: 'hours', everyHours: '1' }))).toEqual({ ok: true, schedule: '0 * * * *', oneShot: false });
    expect(buildSchedule(form({ preset: 'daily', time: '02:05' }))).toEqual({ ok: true, schedule: '5 2 * * *', oneShot: false });
    expect(buildSchedule(form({ preset: 'weekdays', time: '08:30' }))).toEqual({ ok: true, schedule: '30 8 * * 1-5', oneShot: false });
    expect(buildSchedule(form({ preset: 'weekly', time: '10:00', weekday: '6' }))).toEqual({ ok: true, schedule: '0 10 * * 6', oneShot: false });
    expect(buildSchedule(form({ preset: 'cron', cron: '  0   9  * * 1-5 ' }))).toEqual({ ok: true, schedule: '0 9 * * 1-5', oneShot: false });
    expect(buildSchedule(form({ preset: 'cron', cron: '0 9 * * *', runOnce: true }))).toEqual({ ok: true, schedule: '0 9 * * *', oneShot: true });
  });

  it('builds a one-shot ISO timestamp and requires the future', () => {
    expect(buildSchedule(form({ preset: 'once', onceAt: '2026-10-13T09:00' }), NOW)).toEqual({ ok: true, schedule: '2026-10-13T09:00', oneShot: true });
    expect(buildSchedule(form({ preset: 'once', onceAt: '2026-10-11T09:00' }), NOW)).toMatchObject({ ok: false, field: 'onceAt' });
    expect(buildSchedule(form({ preset: 'once', onceAt: '' }), NOW)).toMatchObject({ ok: false, field: 'onceAt' });
  });

  it('reports field errors', () => {
    expect(buildSchedule(form({ preset: 'hours', everyHours: '0' }))).toMatchObject({ ok: false, field: 'everyHours' });
    expect(buildSchedule(form({ preset: 'hours', everyHours: '24' }))).toMatchObject({ ok: false, field: 'everyHours' });
    expect(buildSchedule(form({ preset: 'hours', everyHours: '1.5' }))).toMatchObject({ ok: false, field: 'everyHours' });
    expect(buildSchedule(form({ preset: 'daily', time: '' }))).toMatchObject({ ok: false, field: 'time' });
    expect(buildSchedule(form({ preset: 'daily', time: '25:00' }))).toMatchObject({ ok: false, field: 'time' });
    expect(buildSchedule(form({ preset: 'cron', cron: 'nope' }))).toMatchObject({ ok: false, field: 'cron' });
  });
});

describe('parseSchedule', () => {
  it('round-trips the presets', () => {
    for (const f of [
      form({ preset: 'hours', everyHours: '4' }),
      form({ preset: 'daily', time: '07:45' }),
      form({ preset: 'weekdays', time: '08:30' }),
      form({ preset: 'weekly', time: '10:00', weekday: '0' }),
    ]) {
      const built = buildSchedule(f);
      if (!built.ok) throw new Error('build failed');
      const back = parseSchedule(built.schedule, built.oneShot);
      expect(back.preset).toBe(f.preset);
      if (f.preset === 'hours') expect(back.everyHours).toBe(f.everyHours);
      else expect(back.time).toBe(f.time);
      if (f.preset === 'weekly') expect(back.weekday).toBe(f.weekday);
    }
  });

  it('falls back to custom cron and keeps one-shot cron', () => {
    expect(parseSchedule('5 4 * 6 *', false)).toMatchObject({ preset: 'cron', cron: '5 4 * 6 *', runOnce: false });
    expect(parseSchedule('0 9 * * *', true)).toMatchObject({ preset: 'cron', cron: '0 9 * * *', runOnce: true });
    expect(parseSchedule('2026-10-13T09:00', true)).toMatchObject({ preset: 'once', onceAt: '2026-10-13T09:00' });
    expect(parseSchedule('0 * * * *', false)).toMatchObject({ preset: 'hours', everyHours: '1' });
  });
});

describe('nextRuns', () => {
  it('lists upcoming occurrences', () => {
    const runs = nextRuns('0 2 * * *', 3, NOW);
    expect(runs).toHaveLength(3);
    expect(new Date(runs[0]).getHours()).toBe(2);
    expect(runs[1] - runs[0]).toBe(24 * 3_600_000);
  });

  it('returns the single future instant for ISO and nothing for past ones', () => {
    expect(nextRuns('2026-10-13T09:00', 3, NOW)).toEqual([new Date(2026, 9, 13, 9, 0).getTime()]);
    expect(nextRuns('2026-10-01T09:00', 3, NOW)).toEqual([]);
    expect(nextRuns('garbage', 3, NOW)).toEqual([]);
  });

  it('weekday schedules skip the weekend', () => {
    const fri = new Date(2026, 9, 16, 12, 0).getTime();
    const runs = nextRuns('0 9 * * 1-5', 2, fri);
    expect(new Date(runs[0]).getDay()).toBe(1);
    expect(new Date(runs[1]).getDay()).toBe(2);
  });
});
