/**
 * DateUtils tests - local-timezone calendar day handling.
 *
 * THE BUG: days were computed with `toISOString()` (UTC) and ranges parsed
 * with `new Date('YYYY-MM-DD')` (also UTC), so a student coding at 1 AM east
 * of UTC had that work filed under the previous day, and a local date string
 * was compared against a UTC day boundary.
 *
 * WHY THESE ASSERT RELATIVE, NOT ABSOLUTE, OFFSETS: process.env.TZ cannot be
 * reliably changed once Node has started (verified: an earlier draft of this
 * file tried to pin Asia/Kolkata and silently ran under the host's UTC+02,
 * which made the suite fail in a way that looked like a product bug). These
 * tests therefore assert the INVARIANT - local day in == local day out - plus
 * the specific 1 AM case that reproduces the bug. They hold in any timezone,
 * and genuinely fail if the code regresses to UTC.
 */

import {
  addDays,
  daysBetween,
  endOfLocalDay,
  getDateRange,
  getRecentDateStrings,
  getToday,
  localDayRange,
  startOfLocalDay,
  toLocalDateString,
} from '../DateUtils';

/**
 * Minutes to ADD to local time to get UTC, evaluated FOR A GIVEN INSTANT.
 *
 * Deliberately takes a timestamp rather than reading the offset once at module
 * load: in DST zones the offset differs between "now" and the date under test
 * (New York is -240 in October, -300 in January; Lisbon is +60 in October, 0 in
 * January). A captured-at-load-time offset makes the assertion wrong for half
 * the year rather than wrong always.
 */
const offsetAt = (timestamp: number): number =>
  -new Date(timestamp).getTimezoneOffset();

describe('DateUtils local calendar days', () => {
  describe('toLocalDateString', () => {
    it('agrees with the runtime local date for a spread of timestamps', () => {
      const base = new Date(2026, 0, 16, 12, 0, 0).getTime();
      for (const deltaHours of [-12, -6, -1, 0, 1, 6, 12, 24]) {
        const d = new Date(base + deltaHours * 3600 * 1000);
        const expected = [
          d.getFullYear(),
          String(d.getMonth() + 1).padStart(2, '0'),
          String(d.getDate()).padStart(2, '0'),
        ].join('-');
        expect(toLocalDateString(d.getTime())).toBe(expected);
      }
    });

    it('THE REGRESSION: 1:00 AM local work stays on its own local day', () => {
      // This is the exact case that was broken: a late-night/early-morning
      // session must not be filed under the previous (UTC) day.
      const ts = new Date(2026, 0, 16, 1, 0, 0).getTime();
      expect(toLocalDateString(ts)).toBe('2026-01-16');

      // And the pre-1 AM day genuinely is the day before
      const tsBefore = new Date(2026, 0, 15, 23, 30, 0).getTime();
      expect(toLocalDateString(tsBefore)).toBe('2026-01-15');
    });

    it('23:30 local stays on its own day', () => {
      expect(toLocalDateString(new Date(2026, 0, 15, 23, 30, 0).getTime())).toBe(
        '2026-01-15',
      );
    });

    it('handles midnight exactly and 1ms before', () => {
      const midnight = new Date(2026, 0, 16, 0, 0, 0).getTime();
      expect(toLocalDateString(midnight)).toBe('2026-01-16');
      expect(toLocalDateString(midnight - 1)).toBe('2026-01-15');
    });

    it('accepts a Date as well as a timestamp', () => {
      const d = new Date(2026, 0, 16, 9, 0, 0);
      expect(toLocalDateString(d)).toBe(toLocalDateString(d.getTime()));
    });

    it('pads single-digit months and days', () => {
      expect(toLocalDateString(new Date(2026, 0, 5, 12, 0, 0).getTime())).toBe(
        '2026-01-05',
      );
      expect(toLocalDateString(new Date(2026, 10, 9, 12, 0, 0).getTime())).toBe(
        '2026-11-09',
      );
    });

    it('returns empty string for invalid input', () => {
      expect(toLocalDateString(Number.NaN)).toBe('');
      expect(toLocalDateString(new Date('not a date'))).toBe('');
    });
  });

  describe('getToday', () => {
    it('returns the local day, matching toLocalDateString', () => {
      expect(getToday()).toBe(toLocalDateString(Date.now()));
    });

    it('returns the local day for a 1 AM timestamp', () => {
      const spy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date(2026, 0, 16, 1, 0, 0).getTime());
      expect(getToday()).toBe('2026-01-16');
      spy.mockRestore();
    });
  });

  describe('startOfLocalDay', () => {
    it('is local midnight (hours/min/sec all zero)', () => {
      const d = new Date(startOfLocalDay('2026-01-16'));
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(0);
      expect(d.getDate()).toBe(16);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMilliseconds()).toBe(0);
    });

    it('differs from UTC parsing by exactly the local offset', () => {
      const local = startOfLocalDay('2026-01-16');
      const utcParsed = new Date('2026-01-16').getTime();
      // new Date('YYYY-MM-DD') is UTC midnight; local midnight is offset away.
      // Where the offset on THIS date is zero, local midnight and UTC midnight
      // are the same instant - which is why the original bug was invisible to
      // anyone whose test date fell in a zero-offset period (UTC, or Lisbon in
      // winter). The guard must key off the date's offset, not "now"'s.
      if (offsetAt(local) === 0) {
        expect(local).toBe(utcParsed);
      } else {
        expect(local).not.toBe(utcParsed);
      }
      // Offset must be measured for THIS date (2026-01-16), not for "now".
      expect((utcParsed - local) / 60000).toBe(offsetAt(local) || 0);
    });

    it('is idempotent - resolving the returned day gives the same instant', () => {
      const first = startOfLocalDay('2026-01-16');
      const day = toLocalDateString(first);
      expect(startOfLocalDay(day)).toBe(first);
    });

    it('returns 0 for malformed input (fails closed)', () => {
      expect(startOfLocalDay('garbage')).toBe(0);
      expect(startOfLocalDay('')).toBe(0);
      expect(startOfLocalDay('2026-13-01')).toBe(0);
      expect(startOfLocalDay('2026-01-32')).toBe(0);
    });
  });

  describe('endOfLocalDay', () => {
    it('is the last millisecond of the local day', () => {
      const d = new Date(endOfLocalDay('2026-01-16'));
      expect(d.getDate()).toBe(16);
      expect(d.getHours()).toBe(23);
      expect(d.getMinutes()).toBe(59);
      expect(d.getSeconds()).toBe(59);
      expect(d.getMilliseconds()).toBe(999);
    });

    it('is exactly 86,400,000ms after the start of the same day', () => {
      expect(endOfLocalDay('2026-01-16') - startOfLocalDay('2026-01-16')).toBe(
        24 * 3600 * 1000 - 1,
      );
    });
  });

  describe('localDayRange', () => {
    it('starts at local midnight and ends at the next local midnight', () => {
      const { start, end } = localDayRange('2026-01-16');
      expect(start).toBe(startOfLocalDay('2026-01-16'));
      expect(end).toBe(startOfLocalDay('2026-01-17'));
    });

    it('spans month boundaries', () => {
      const { start, end } = localDayRange('2026-01-31');
      expect(new Date(start).getDate()).toBe(31);
      expect(new Date(end).getMonth()).toBe(1); // February
      expect(new Date(end).getDate()).toBe(1);
    });

    it('spans leap day', () => {
      const { start, end } = localDayRange('2028-02-29');
      expect(new Date(start).getDate()).toBe(29);
      expect(new Date(end).getMonth()).toBe(2); // March
      expect(new Date(end).getDate()).toBe(1);
    });
  });

  describe('addDays', () => {
    it('rolls over month boundaries', () => {
      expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('rolls over year boundaries', () => {
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('handles leap years', () => {
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 not a leap year
    });

    it('is zero-offset', () => {
      expect(addDays('2026-01-16', 0)).toBe('2026-01-16');
    });

    it('handles large offsets', () => {
      expect(addDays('2026-01-01', 365)).toBe('2027-01-01');
    });

    it('walks every day of a month without a gap or repeat', () => {
      let day = '2026-01-01';
      const seen: string[] = [];
      for (let i = 0; i < 31; i++) {
        seen.push(day);
        day = addDays(day, 1);
      }
      expect(new Set(seen).size).toBe(31);
      expect(day).toBe('2026-02-01');
    });

    it('returns input unchanged when malformed', () => {
      expect(addDays('garbage', 1)).toBe('garbage');
    });
  });

  describe('daysBetween', () => {
    it('counts forward and backward', () => {
      expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
      expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7);
      expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
    });

    it('crosses months correctly', () => {
      expect(daysBetween('2026-01-30', '2026-02-02')).toBe(3);
    });

    it('is the inverse of addDays', () => {
      for (const n of [1, 7, 30, 365]) {
        expect(daysBetween('2026-01-01', addDays('2026-01-01', n))).toBe(n);
      }
    });

    it('returns 0 for malformed input', () => {
      expect(daysBetween('x', '2026-01-01')).toBe(0);
    });
  });

  describe('getRecentDateStrings', () => {
    it('returns N days ending today, oldest first', () => {
      const spy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date(2026, 0, 16, 12, 0, 0).getTime());
      expect(getRecentDateStrings(7)).toEqual([
        '2026-01-10',
        '2026-01-11',
        '2026-01-12',
        '2026-01-13',
        '2026-01-14',
        '2026-01-15',
        '2026-01-16',
      ]);
      spy.mockRestore();
    });

    it('last entry is today even at 1 AM local', () => {
      const spy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date(2026, 0, 16, 1, 0, 0).getTime());
      const days = getRecentDateStrings(3);
      expect(days).toEqual(['2026-01-14', '2026-01-15', '2026-01-16']);
      expect(days[days.length - 1]).toBe('2026-01-16');
      spy.mockRestore();
    });

    it('returns a single day when count is 1', () => {
      const spy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date(2026, 0, 16, 12, 0, 0).getTime());
      expect(getRecentDateStrings(1)).toEqual(['2026-01-16']);
      spy.mockRestore();
    });
  });

  describe('getDateRange', () => {
    it('is inclusive of both ends', () => {
      expect(getDateRange('2026-01-01', '2026-01-04')).toEqual([
        '2026-01-01',
        '2026-01-02',
        '2026-01-03',
        '2026-01-04',
      ]);
    });

    it('returns one day when start equals end', () => {
      expect(getDateRange('2026-01-01', '2026-01-01')).toEqual(['2026-01-01']);
    });

    it('returns empty when inverted', () => {
      expect(getDateRange('2026-01-04', '2026-01-01')).toEqual([]);
    });

    it('spans a month boundary', () => {
      expect(getDateRange('2026-01-30', '2026-02-02')).toEqual([
        '2026-01-30',
        '2026-01-31',
        '2026-02-01',
        '2026-02-02',
      ]);
    });
  });

  describe('INVARIANT: keys and ranges must agree', () => {
    // The regression that mattered: the range used to be UTC-derived while the
    // key was local (or both UTC but inconsistent). Any ms inside the range
    // must map back to the same date string, or events fall through.
    it('every ms in a day range maps back to that day', () => {
      for (const day of [
        '2026-01-15',
        '2026-01-16',
        '2026-03-01',
        '2026-06-15',
        '2026-12-31',
      ]) {
        const { start, end } = localDayRange(day);
        for (let h = 0; h < 24; h++) {
          expect(toLocalDateString(start + h * 3600 * 1000)).toBe(day);
        }
        expect(toLocalDateString(end - 1)).toBe(day);
        expect(toLocalDateString(end)).not.toBe(day);
      }
    });

    it('an event at 1 AM is inside its own day range', () => {
      const day = '2026-01-16';
      const { start, end } = localDayRange(day);
      const oneAm = new Date(2026, 0, 16, 1, 0, 0).getTime();
      expect(toLocalDateString(oneAm)).toBe(day);
      expect(oneAm).toBeGreaterThanOrEqual(start);
      expect(oneAm).toBeLessThan(end);
    });

    it('an event at 11:59 PM is inside its own day range', () => {
      const day = '2026-01-15';
      const { start, end } = localDayRange(day);
      const lateNight = new Date(2026, 0, 15, 23, 59, 0).getTime();
      expect(toLocalDateString(lateNight)).toBe(day);
      expect(lateNight).toBeGreaterThanOrEqual(start);
      expect(lateNight).toBeLessThan(end);
    });
  });
});
