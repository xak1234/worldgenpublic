/**
 * BCE-safe date arithmetic for in-world dates.
 *
 * Why this exists: the world simulator stores currentDate as a plain string
 * tag ("3000-07-15", "1962-10-22", "-0500-07-15"). Going through JS Date for
 * arithmetic loses the negative sign on toISOString(), so a BCE world
 * silently jumps to AD on the first day rollover. These helpers do the math
 * directly on the proleptic Gregorian calendar without round-tripping.
 *
 * Format accepted by parseWorldDate:
 *   YYYY-MM-DD          (positive year, any number of digits)
 *   -YYYY-MM-DD         (BCE / negative year)
 *   +YYYYYY-MM-DD       (ISO 8601 expanded form, any number of digits)
 */

export interface WorldDate { year: number; month: number; day: number; }

export function parseWorldDate(s: string): WorldDate {
  try {
    if (typeof s !== 'string') throw new Error(`worldDate: expected string, got ${typeof s}`);
    const trimmed = s.trim();
    // Match optional sign, year (1+ digits), '-', month (2 digits), '-', day (2 digits).
    const m = /^([+-]?)(\d+)-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
    if (!m) throw new Error(`worldDate: cannot parse "${s}"`);
    const [, sign, yearStr, monthStr, dayStr] = m;
    const year = (sign === '-' ? -1 : 1) * parseInt(yearStr, 10);
    if (Math.abs(year) > 999999) throw new Error('worldDate: year out of range');
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    if (month < 1 || month > 12) throw new Error(`worldDate: bad month ${month}`);
    if (day < 1 || day > daysInMonth(year, month)) throw new Error(`worldDate: bad day ${day} for ${year}-${month}`);
    return { year, month, day };
  } catch (err) {
    // Silently return epoch (1-1-1) for malformed dates. Warnings can be noisy with large datasets.
    return { year: 1, month: 1, day: 1 };
  }
}

export function formatWorldDate(d: WorldDate): string {
  const sign = d.year < 0 ? '-' : '';
  const year = Math.abs(d.year).toString().padStart(4, '0');
  const month = d.month.toString().padStart(2, '0');
  const day = d.day.toString().padStart(2, '0');
  return `${sign}${year}-${month}-${day}`;
}

export function isLeapYear(year: number): boolean {
  // Proleptic Gregorian. Year 0 is a leap year (divisible by 400).
  if (year % 400 === 0) return true;
  if (year % 100 === 0) return false;
  return year % 4 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
    case 4: case 6: case 9: case 11: return 30;
    case 2: return isLeapYear(year) ? 29 : 28;
    default: throw new Error(`worldDate: bad month ${month}`);
  }
}

export function addDays(s: string, n: number): string {
  let d = parseWorldDate(s);
  if (n === 0) return formatWorldDate(d);
  // Walk one day at a time. n is bounded (≤ 12 in practice) so this is fine.
  // For larger jumps a Julian-day-number conversion would be more efficient,
  // but day-at-a-time keeps the implementation auditable.
  let remaining = n;
  while (remaining > 0) {
    d = nextDay(d);
    remaining -= 1;
  }
  while (remaining < 0) {
    d = prevDay(d);
    remaining += 1;
  }
  return formatWorldDate(d);
}

function nextDay(d: WorldDate): WorldDate {
  if (d.day < daysInMonth(d.year, d.month)) return { year: d.year, month: d.month, day: d.day + 1 };
  if (d.month < 12) return { year: d.year, month: d.month + 1, day: 1 };
  // Year rollover. There is no year 0 in the historical Gregorian calendar,
  // but the proleptic Gregorian calendar (which JS Date uses) DOES have a
  // year 0 (= 1 BCE). We follow the proleptic convention because it makes
  // arithmetic uniform.
  return { year: d.year + 1, month: 1, day: 1 };
}

function prevDay(d: WorldDate): WorldDate {
  if (d.day > 1) return { year: d.year, month: d.month, day: d.day - 1 };
  if (d.month > 1) return { year: d.year, month: d.month - 1, day: daysInMonth(d.year, d.month - 1) };
  return { year: d.year - 1, month: 12, day: 31 };
}
