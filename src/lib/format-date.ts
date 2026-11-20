/**
 * One way to show a date to the owner (2026-09-29, owner walk-through NY1).
 *
 * Screens used `toLocaleDateString()` with no locale, so a browser set to US
 * English showed 8/24/2026 — which an Indian owner reads as the 8th of the
 * 24th month, or confuses with 24/8. Every date on screen now comes from here:
 * day and short month, India time, the year only when it is not this year.
 *
 *   formatDate("2026-08-24T10:00:00Z")      → "24 Aug"
 *   formatDate("2025-08-24T10:00:00Z")      → "24 Aug 2025"
 *   formatDateTime("2026-08-24T10:00:00Z")  → "24 Aug, 3:30 pm"
 */
const TZ = "Asia/Kolkata";

function valid(value: string | number | Date | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function istYear(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-IN", { timeZone: TZ, year: "numeric" }).format(d));
}

export function formatDate(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const d = valid(value);
  if (!d) return "";
  const sameYear = istYear(d) === istYear(now);
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}

export function formatDateTime(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const d = valid(value);
  if (!d) return "";
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
  return `${formatDate(d, now)}, ${time}`;
}
