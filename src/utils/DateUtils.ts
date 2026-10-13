/**
 * DateUtils - local-timezone-correct calendar day handling.
 *
 * WHY THIS EXISTS:
 * Calendar days were computed with `toISOString().split('T')[0]`, which is
 * UTC. A student coding at 1:00 AM in a timezone east of UTC had that work
 * filed under the previous day. The inverse also broke: `new Date('2026-01-15')
 * .getTime()` parses as UTC midnight, so a *local* date string was compared
 * against a *UTC* day boundary.
 *
 * Both halves must agree, or a day's events land in the wrong bucket:
 *   - keys derived from a timestamp  -> must use LOCAL calendar day
 *   - ranges parsed from a YYYY-MM-DD -> must resolve to LOCAL midnight
 *
 * Everything here works in the machine's local timezone. Date strings stay
 * `YYYY-MM-DD`. Day arithmetic is done on the string, not on a Date object,
 * so it cannot be broken by DST transitions shifting midnight.
 */

/**
 * Convert a timestamp (ms) to the local calendar day as YYYY-MM-DD.
 * This is the canonical "which day was this?" function.
 */
export function toLocalDateString(timestamp: number | Date): string {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Today's local calendar day as YYYY-MM-DD.
 */
export function getToday(): string {
  return toLocalDateString(Date.now());
}

/**
 * Resolve a YYYY-MM-DD string to the epoch ms of LOCAL midnight.
 *
 * `new Date('2026-01-15')` parses as UTC midnight, which is up to 14 hours
 * away from local midnight depending on offset. That mismatch put events in
 * the wrong day for every non-UTC user. This constructs the date in local
 * time instead.
 *
 * Returns 0 for malformed input so callers fail closed rather than matching
 * the entire epoch.
 */
export function startOfLocalDay(dateString: string): number {
  const parsed = parseDateString(dateString);
  if (!parsed) {
    return 0;
  }
  return new Date(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0, 0).getTime();
}

/**
 * End of the given local day (23:59:59.999), as epoch ms.
 */
export function endOfLocalDay(dateString: string): number {
  const parsed = parseDateString(dateString);
  if (!parsed) {
    return 0;
  }
  return new Date(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    23,
    59,
    59,
    999,
  ).getTime();
}

/**
 * Half-open [start, end) epoch range covering one local calendar day.
 * Prefer this over arithmetic on timestamps: it is DST-safe because local
 * midnight is resolved per-day rather than by adding 86,400,000 ms.
 */
export function localDayRange(dateString: string): {
  start: number;
  end: number;
} {
  return { start: startOfLocalDay(dateString), end: startOfLocalDay(addDays(dateString, 1)) };
}

/** Parse YYYY-MM-DD into parts. Returns null when malformed. */
function parseDateString(
  dateString: string,
): { year: number; month: number; day: number } | null {
  if (!dateString) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return { year, month, day };
}

/**
 * Add (or subtract) whole days to a YYYY-MM-DD string.
 *
 * Done with Date.UTC on the *date parts only* so the result cannot be shifted
 * by a DST transition - we never interpret these as local midnight mid-way.
 * Returns the input unchanged if malformed.
 */
export function addDays(dateString: string, days: number): string {
  const parsed = parseDateString(dateString);
  if (!parsed) {
    return dateString;
  }
  const base = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const shifted = new Date(base + days * 86400000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole days from `fromDate` to `toDate` (negative if `toDate` is earlier). */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = parseDateString(fromDate);
  const b = parseDateString(toDate);
  if (!a || !b) {
    return 0;
  }
  const from = Date.UTC(a.year, a.month - 1, a.day);
  const to = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((to - from) / 86400000);
}

/**
 * The last `count` local calendar days, oldest first, ending today.
 */
export function getRecentDateStrings(count: number): string[] {
  const dates: string[] = [];
  const today = getToday();
  for (let i = count - 1; i >= 0; i--) {
    dates.push(addDays(today, -i));
  }
  return dates;
}

/**
 * Inclusive range of YYYY-MM-DD strings between two local dates.
 */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const span = daysBetween(startDate, endDate);
  if (span < 0) {
    return dates;
  }
  for (let i = 0; i <= span; i++) {
    dates.push(addDays(startDate, i));
  }
  return dates;
}
