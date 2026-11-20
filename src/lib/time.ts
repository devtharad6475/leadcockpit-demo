/**
 * time.ts — IST (Asia/Kolkata, UTC+5:30) timezone chokepoint.
 *
 * THE PROBLEM (audit S6 D-6/D-7):
 *   The system uses IST for business hours, "today" counters, daily caps, and
 *   midnight resets — but the production server runs in UTC (Hetzner default).
 *   Several call sites computed "today" / "midnight" with raw `new Date()`
 *   + `setHours(0,0,0,0)` (server-local = UTC) or `toISOString().slice(0,10)`
 *   (UTC date). On a UTC server these are 5.5h off from IST:
 *     - The AI daily token limit reset at 05:30 IST instead of midnight IST.
 *     - The auto-approve daily cap counted approvals across the 18:30–24:00 IST
 *       window as "yesterday" when the operator perceived them as "today".
 *     - The SLA business-hours check used the UTC day-of-week, off by one for
 *       tickets created 18:30–24:00 UTC (= 00:00–05:30 IST).
 *
 * THE FIX (one chokepoint, build-right Phase 3d):
 *   Every "today" / "midnight" / "business-hours" computation in the app MUST
 *   go through these helpers. IST is fixed at UTC+5:30 (India does not observe
 *   DST, so no offset table is needed). All math uses the UTC getters with the
 *   +330-minute offset applied, and rolls the day forward correctly when IST
 *   crosses UTC midnight.
 *
 * Convention:
 *   - Inputs/outputs are `Date` (or ISO string for the date-only helpers).
 *   - All helpers are pure (no I/O), so they're trivially golden-testable.
 */

/** IST offset in minutes (UTC+5:30 = 330). India has no DST. */
export const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * Convert any Date to the IST date-parts {year, month, day, hours, minutes,
 * dayOfWeek} where dayOfWeek is 0=Sunday..6=Saturday in IST. Handles the
 * UTC→IST day rollover (IST is ahead of UTC, so late-UTC-times roll to the
 * NEXT IST day).
 */
export function istParts(from: Date = new Date()): {
  year: number; month: number; day: number; hours: number; minutes: number; dayOfWeek: number;
} {
  // Total minutes since UTC midnight on `from`'s UTC date.
  const utcMinutesToday = from.getUTCHours() * 60 + from.getUTCMinutes();
  let istTotalMinutes = utcMinutesToday + IST_OFFSET_MINUTES;
  let dayShift = 0;
  if (istTotalMinutes >= 24 * 60) { istTotalMinutes -= 24 * 60; dayShift = 1; }
  // (istTotalMinutes can't go negative because IST is AHEAD of UTC; only the
  // forward rollover matters.)
  const istHours = Math.floor(istTotalMinutes / 60);
  const istMinutes = istTotalMinutes % 60;
  // Day-of-week + date in IST: build a Date shifted by the offset + the dayShift.
  // Use a Date constructed from the UTC components so we control exactly.
  const shifted = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayShift));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: istHours,
    minutes: istMinutes,
    dayOfWeek: shifted.getUTCDay(),
  };
}

/**
 * The start of the current IST day (midnight IST) as a UTC Date. Use this
 * instead of `new Date(); setHours(0,0,0,0)` which uses server-local time.
 *
 * Example: at 2026-07-28 19:00 UTC (= 2026-07-29 00:30 IST), this returns
 * 2026-07-29 00:00 IST = 2026-07-28 18:30 UTC.
 */
export function startOfIstDay(from: Date = new Date()): Date {
  const p = istParts(from);
  // Midnight IST on the IST date = UTC midnight minus 5:30.
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) - IST_OFFSET_MINUTES * 60 * 1000);
}

/**
 * The next IST midnight (when daily counters reset). Use this instead of
 * `reset.setHours(0,0,0,0); reset.setDate(reset.getDate()+1)` (server-local).
 *
 * Returns the UTC Date of the NEXT 00:00 IST strictly after `from`. If `from`
 * is exactly IST midnight, returns the NEXT day's IST midnight.
 */
export function nextIstMidnight(from: Date = new Date()): Date {
  const start = startOfIstDay(from);
  const next = new Date(start);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Today's date as an ISO "YYYY-MM-DD" string IN IST. Use this instead of
 * `new Date().toISOString().slice(0,10)` which returns the UTC date.
 *
 * At 2026-07-28 19:00 UTC (= 2026-07-29 00:30 IST) this returns "2026-07-29",
 * not "2026-07-28".
 */
export function todayIstIsoDate(from: Date = new Date()): string {
  const p = istParts(from);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/**
 * Is the given UTC instant within IST business hours on the given
 * {startHour, endHour, businessDays} schedule? businessDays is 0=Sun..6=Sat
 * (matching JS getDay). The day-of-week is computed in IST (handles the
 * UTC→IST rollover). This replaces the broken getUTCDay() in ticket-sla.ts.
 *
 * startHour/endHour are IST hours (0-23). Inclusive of startHour, exclusive
 * of endHour (so 9-18 = 09:00:00 through 17:59:59).
 */
export function isWithinIstBusinessHours(
  at: Date,
  startHour: number,
  endHour: number,
  businessDays: number[],
): boolean {
  const p = istParts(at);
  // 2026-09-26 (break test): saved settings use ISO weekdays (7 = Sunday);
  // accept Sunday written either way.
  const sunday = p.dayOfWeek === 0 && (businessDays.includes(0) || businessDays.includes(7));
  if (!sunday && !businessDays.includes(p.dayOfWeek)) return false;
  return p.hours >= startHour && p.hours < endHour;
}
