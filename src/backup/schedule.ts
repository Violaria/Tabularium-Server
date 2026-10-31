// When scheduled backups run: every day, on one weekday, or on one day of the month (the last day when a month is
// shorter), at a time of day in a time zone. Times are computed in that zone, so they follow its daylight saving changes.
export interface Plan {
  frequency: 'daily' | 'weekly' | 'monthly';
  /** 0 is Sunday. */
  weekday: number;
  monthDay: number;
  /** "HH:MM". */
  time: string;
  timezone: string;
}

const DAY = 86_400_000;

/** The wall-clock date and time of an instant in a time zone. */
function wallClock(instant: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(instant).map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
/** The zone's offset from UTC at an instant, in milliseconds. */
function offset(instant: number, timezone: string) {
  const w = wallClock(instant, timezone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}
/** The instant a wall-clock time occurs in a zone (in a gap at a daylight saving change, the time after it). */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offset(guess, timezone);
  return guess - offset(first, timezone);
}

/** Whether a calendar date (in the plan's zone) is a backup day. */
function isBackupDay(year: number, month: number, day: number, plan: Plan) {
  if (plan.frequency === 'daily') return true;
  if (plan.frequency === 'weekly') return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === plan.weekday;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === Math.min(plan.monthDay, lastDay);
}

/** The scheduled times around `from`: the first one after it (direction 1) or the last one at or before it (-1). */
function scan(from: number, plan: Plan, direction: 1 | -1) {
  const [hour, minute] = plan.time.split(':').map(Number);
  const today = wallClock(from, plan.timezone);
  for (let step = 0; step <= 400; step++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day) + direction * step * DAY);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!isBackupDay(year, month, day, plan)) continue;
    const at = instantOf(year, month, day, hour, minute, plan.timezone);
    if (direction === 1 ? at > from : at <= from) return at;
  }
  throw new Error('No backup time within a year');
}

export const nextRun = (after: number, plan: Plan) => scan(after, plan, 1);
export const previousRun = (atOrBefore: number, plan: Plan) => scan(atOrBefore, plan, -1);

export function validTimezone(timezone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true; } catch { return false; }
}
