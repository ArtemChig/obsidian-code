// Schedule helpers for the Scheduled view: presets <-> cron, human descriptions, validation, next runs. Owner: ui-views.
// The core stores a cron expression (5 or 6 fields, croner) OR an ISO timestamp for one-shot tasks (see src/core/scheduler).
import { Cron } from 'croner';

export type Preset = 'hours' | 'daily' | 'weekdays' | 'weekly' | 'cron' | 'once';

export interface ScheduleForm {
  preset: Preset;
  /** "every N hours" (string: it comes from an input). */
  everyHours: string;
  /** "HH:MM" 24 h. */
  time: string;
  /** 0 = Sunday … 6 = Saturday (cron convention). */
  weekday: string;
  cron: string;
  /** Local "YYYY-MM-DDTHH:mm" (datetime-local value). */
  onceAt: string;
  /** Custom cron only: disable the task after it fires once. */
  runOnce: boolean;
}

export const PRESET_LABEL: Record<Preset, string> = {
  hours: 'Every N hours',
  daily: 'Daily at',
  weekdays: 'Weekdays at',
  weekly: 'Weekly on',
  cron: 'Custom cron',
  once: 'Once at',
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultScheduleForm(now = Date.now()): ScheduleForm {
  return { preset: 'daily', everyHours: '6', time: '09:00', weekday: '1', cron: '0 9 * * 1-5', onceAt: toLocalInput(now + 3_600_000), runOnce: false };
}

// ───────────────────────────── ISO helpers ─────────────────────────────

/** Mirrors core/scheduler isIsoTimestamp: cron strings contain spaces, ISO strings do not. */
export function isIsoTimestamp(schedule: string): boolean {
  const s = schedule.trim();
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s));
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Epoch ms -> local "YYYY-MM-DDTHH:mm". */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// ───────────────────────────── Validation ─────────────────────────────

/** Error message, or null when the schedule string is valid (same rules as the core). */
export function validateSchedule(schedule: string): string | null {
  const s = (schedule ?? '').trim();
  if (!s) return 'Enter a cron expression';
  if (isIsoTimestamp(s)) return null;
  const fields = s.split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return 'A cron expression has 5 fields: minute hour day-of-month month day-of-week';
  try {
    new Cron(s);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace(/^CronPattern:\s*/i, '').replace(/^Invalid cron pattern[:.]?\s*/i, 'Invalid cron expression: ');
  }
}

/** Next run strictly after `from`, or undefined. */
export function nextRunAfter(schedule: string, from = Date.now()): number | undefined {
  const s = (schedule ?? '').trim();
  if (!s) return undefined;
  if (isIsoTimestamp(s)) {
    const ts = Date.parse(s);
    return ts > from ? ts : undefined;
  }
  try {
    const next = new Cron(s).nextRun(new Date(from));
    return next ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

/** The next `count` occurrences after `from`. */
export function nextRuns(schedule: string, count: number, from = Date.now()): number[] {
  const out: number[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const n = nextRunAfter(schedule, cursor);
    if (n === undefined) break;
    out.push(n);
    cursor = n;
    if (isIsoTimestamp(schedule)) break;
  }
  return out;
}

// ───────────────────────────── Form -> schedule ─────────────────────────────

export type BuildResult = { ok: true; schedule: string; oneShot: boolean } | { ok: false; error: string; field: 'everyHours' | 'time' | 'cron' | 'onceAt' };

export function buildSchedule(f: ScheduleForm, now = Date.now()): BuildResult {
  switch (f.preset) {
    case 'hours': {
      const n = Number(f.everyHours);
      if (!/^\d+$/.test(f.everyHours.trim()) || !Number.isInteger(n) || n < 1 || n > 23) return { ok: false, field: 'everyHours', error: 'Enter a whole number of hours between 1 and 23' };
      return { ok: true, schedule: n === 1 ? '0 * * * *' : `0 */${n} * * *`, oneShot: false };
    }
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const m = TIME_RE.exec(f.time.trim());
      if (!m) return { ok: false, field: 'time', error: 'Pick a time (HH:MM)' };
      const dow = f.preset === 'daily' ? '*' : f.preset === 'weekdays' ? '1-5' : String(Math.max(0, Math.min(6, Number(f.weekday) || 0)));
      return { ok: true, schedule: `${Number(m[2])} ${Number(m[1])} * * ${dow}`, oneShot: false };
    }
    case 'cron': {
      const err = validateSchedule(f.cron);
      if (err) return { ok: false, field: 'cron', error: err };
      if (isIsoTimestamp(f.cron)) return { ok: true, schedule: f.cron.trim(), oneShot: true };
      return { ok: true, schedule: f.cron.trim().replace(/\s+/g, ' '), oneShot: f.runOnce };
    }
    case 'once': {
      if (!f.onceAt.trim()) return { ok: false, field: 'onceAt', error: 'Pick a date and time' };
      const ts = Date.parse(f.onceAt);
      if (Number.isNaN(ts)) return { ok: false, field: 'onceAt', error: 'That date and time is not valid' };
      if (ts <= now) return { ok: false, field: 'onceAt', error: 'Pick a time in the future' };
      return { ok: true, schedule: f.onceAt.trim(), oneShot: true };
    }
  }
}

// ───────────────────────────── Schedule -> form ─────────────────────────────

/** Recognise our presets in a stored schedule; anything else opens as custom cron. */
export function parseSchedule(schedule: string, oneShot: boolean, now = Date.now()): ScheduleForm {
  const base = defaultScheduleForm(now);
  const s = (schedule ?? '').trim();
  if (!s) return base;
  if (isIsoTimestamp(s)) return { ...base, preset: 'once', onceAt: toLocalInput(Date.parse(s)) };
  const custom: ScheduleForm = { ...base, preset: 'cron', cron: s, runOnce: oneShot };
  const fields = s.split(/\s+/);
  if (fields.length !== 5 || oneShot) return custom;
  const [min, hour, dom, mon, dow] = fields;
  if (dom !== '*' || mon !== '*') return custom;
  if (min === '0' && dow === '*') {
    if (hour === '*') return { ...base, preset: 'hours', everyHours: '1' };
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step && Number(step[1]) >= 1 && Number(step[1]) <= 23) return { ...base, preset: 'hours', everyHours: String(Number(step[1])) };
  }
  if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour) && Number(min) < 60 && Number(hour) < 24) {
    const time = `${p2(Number(hour))}:${p2(Number(min))}`;
    if (dow === '*') return { ...base, preset: 'daily', time };
    if (dow === '1-5') return { ...base, preset: 'weekdays', time };
    if (/^[0-6]$/.test(dow)) return { ...base, preset: 'weekly', time, weekday: dow };
  }
  return custom;
}

// ───────────────────────────── Human description ─────────────────────────────

function fmtTime(h: number, m: number): string {
  return `${p2(h)}:${p2(m)}`;
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10]}`;
}

/** Expand a cron field list/range ("1,3-5") into numbers within [lo, hi]; null when it is not a plain list. */
function expandList(field: string, lo: number, hi: number): number[] | null {
  const out: number[] = [];
  for (const part of field.split(',')) {
    const r = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!r) return null;
    const a = Number(r[1]);
    const b = r[2] === undefined ? a : Number(r[2]);
    if (a < lo || b > hi || a > b) return null;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out.length ? [...new Set(out)] : null;
}

function describeDays(dow: string): string | null {
  if (dow === '*') return 'Every day';
  const days = expandList(dow.replace(/\b7\b/g, '0'), 0, 6);
  if (!days) return null;
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (set.length === 1) return `Every ${WEEKDAYS[set[0]]}`;
  return `Every ${set.map((d) => WD_SHORT[d]).join(', ')}`;
}

function describeCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 6) {
    if (fields[0] !== '0') return null; // seconds precision: not described
    fields.shift();
  }
  if (fields.length !== 5) return null;
  const [min, hour, dom, mon, dow] = fields;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') return Number(everyMin[1]) === 1 ? 'Every minute' : `Every ${everyMin[1]} minutes`;

  const minute = /^\d{1,2}$/.test(min) && Number(min) < 60 ? Number(min) : null;
  if (minute === null) return null;

  if (dom === '*' && mon === '*') {
    const days = describeDays(dow);
    if (!days) return null;
    if (hour === '*') return days === 'Every day' ? (minute === 0 ? 'Every hour' : `Every hour at :${p2(minute)}`) : `${days}, every hour at :${p2(minute)}`;
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step) {
      const n = Number(step[1]);
      const cadence = n === 1 ? 'Every hour' : `Every ${n} hours`;
      const at = minute === 0 ? '' : ` at :${p2(minute)}`;
      return days === 'Every day' ? `${cadence}${at}` : `${days}, ${cadence.toLowerCase()}${at}`;
    }
    const hours = expandList(hour, 0, 23);
    if (!hours) return null;
    const times = hours.map((h) => fmtTime(h, minute));
    if (times.length > 3) return days === 'Every day' ? `${times.length} times a day` : `${days}, ${times.length} times a day`;
    const when = times.length === 1 ? `at ${times[0]}` : `at ${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
    return `${days} ${when}`;
  }

  if (dow === '*' && mon === '*' && /^\d{1,2}$/.test(dom) && /^\d{1,2}$/.test(hour) && Number(dom) >= 1 && Number(dom) <= 31) {
    return `Monthly on the ${ordinal(Number(dom))} at ${fmtTime(Number(hour), minute)}`;
  }
  return null;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${date} at ${fmtTime(d.getHours(), d.getMinutes())}`;
}

/** "Every day at 02:00", "Weekdays at 08:30", "Every 6 hours", "Once on Oct 13, 2026 at 09:00", or the raw cron. */
export function describeSchedule(schedule: string, oneShot = false): string {
  const s = (schedule ?? '').trim();
  if (!s) return 'No schedule';
  if (isIsoTimestamp(s)) return `Once on ${fmtDateTime(Date.parse(s))}`;
  const d = describeCron(s);
  if (d) return oneShot ? `${d} (once)` : d;
  return oneShot ? `Custom cron, once` : 'Custom cron';
}

/** True when describeSchedule fell back to "Custom cron" (so the UI should also show the raw expression). */
export function isDescribed(schedule: string): boolean {
  const s = (schedule ?? '').trim();
  return isIsoTimestamp(s) || describeCron(s) !== null;
}
