import { StorageError } from '@localqa/storage';

type Matcher = { values: ReadonlySet<number>; unrestricted: boolean };
export interface CronSpec {
  minute: Matcher;
  hour: Matcher;
  day: Matcher;
  month: Matcher;
  weekday: Matcher;
}

function field(src: string, min: number, max: number, sunday = false): Matcher {
  if (!/^[\d*\/,\-]+$/.test(src)) throw new StorageError('VALIDATION_ERROR');
  const values = new Set<number>();
  for (const part of src.split(',')) {
    const chunks = part.split('/');
    if (chunks.length > 2 || chunks.some((p) => !p))
      throw new StorageError('VALIDATION_ERROR');
    const step = chunks.length === 2 ? Number(chunks[1]) : 1;
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1)
      throw new StorageError('VALIDATION_ERROR');
    const segment = chunks[0]!;
    let begin: number;
    let end: number;
    if (segment === '*') {
      begin = min;
      end = max;
    } else if (segment.includes('-')) {
      const bounds = segment.split('-');
      if (bounds.length !== 2 || bounds.some((x) => !/^\d+$/.test(x)))
        throw new StorageError('VALIDATION_ERROR');
      begin = Number(bounds[0]);
      end = Number(bounds[1]);
    } else if (/^\d+$/.test(segment)) {
      begin = Number(segment);
      end = chunks.length === 2 ? max : begin;
    } else {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (begin < min || end > max || begin > end)
      throw new StorageError('VALIDATION_ERROR');
    for (let n = begin; n <= end; n += step)
      values.add(sunday && n === 7 ? 0 : n);
  }
  return { values, unrestricted: src === '*' };
}

/** Five-field numeric POSIX cron: minute hour DOM month DOW. */
export function parseScheduleClock(cron: string, timezone: string): CronSpec {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new StorageError('VALIDATION_ERROR');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new StorageError('VALIDATION_ERROR');
  }
  return {
    minute: field(parts[0]!, 0, 59),
    hour: field(parts[1]!, 0, 23),
    day: field(parts[2]!, 1, 31),
    month: field(parts[3]!, 1, 12),
    weekday: field(parts[4]!, 0, 7, true),
  };
}

const weekdayNumber: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function scheduledLocal(
  instant: Date,
  timezone: string,
): {
  label: string;
  hour: number;
  minute: number;
  day: number;
  month: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  const day = Number(value('day'));
  const month = Number(value('month'));
  const weekday = weekdayNumber[value('weekday')];
  if (weekday === undefined) throw new StorageError('VALIDATION_ERROR');
  return {
    label: `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`,
    hour,
    minute,
    day,
    month,
    weekday,
  };
}

export function matchingMinutes(
  cron: string,
  timezone: string,
  fromExclusive: Date,
  toInclusive: Date,
): { at: Date; local: string }[] {
  const spec = parseScheduleClock(cron, timezone);
  const start = Math.floor(fromExclusive.getTime() / 60000) + 1;
  const end = Math.floor(toInclusive.getTime() / 60000);
  if (end < start) return [];
  if (end - start > 7 * 24 * 60) throw new StorageError('VALIDATION_ERROR');
  const times: { at: Date; local: string }[] = [];
  const seenLocal = new Set<string>();
  for (let minute = start; minute <= end; minute++) {
    const at = new Date(minute * 60000);
    const wall = scheduledLocal(at, timezone);
    const dom = spec.day.values.has(wall.day);
    const dow = spec.weekday.values.has(wall.weekday);
    const dayMatches = spec.day.unrestricted
      ? dow
      : spec.weekday.unrestricted
        ? dom
        : dom || dow;
    if (
      spec.minute.values.has(wall.minute) &&
      spec.hour.values.has(wall.hour) &&
      spec.month.values.has(wall.month) &&
      dayMatches &&
      !seenLocal.has(wall.label)
    ) {
      seenLocal.add(wall.label);
      times.push({ at, local: wall.label });
    }
  }
  return times;
}
