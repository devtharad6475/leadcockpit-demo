/**
 * "This reply names 9 Nov — you are closed that day (Diwali)." (2026-09-30,
 * CEO-approved plan docs/planning/FESTIVAL-CALENDAR-PLAN.md part 3,
 * "Promises"; rules docs/LOGIC.md FESTIVAL-CALENDAR).
 *
 * Pure: finds the dates a draft reply or quote names and returns the ones the
 * company is closed on. Automatic replies can never promise a delivery date
 * (AutoSendGate condition 10), so every draft that names one already waits for
 * the owner; this only makes sure the owner sees the clash before approving.
 *
 * Only unambiguous dates are read: "9 Nov", "9th November 2026", "Nov 9",
 * "2026-11-09", "09/11/2026" (Indian day/month order). A date without a year is
 * the next time that day comes round from today. Anything vaguer ("next week",
 * "after Diwali") is left alone — never guessed at.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export type ClosedDayMention = { date: string; label?: string };

function iso(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return undefined; // 31 Feb and friends
  return date.toISOString().slice(0, 10);
}

/** A day and month with no year: the next time it comes round (today counts). */
function nextOccurrence(m: number, d: number, today: string): string | undefined {
  const year = Number(today.slice(0, 4));
  const thisYear = iso(year, m, d);
  if (thisYear && thisYear >= today) return thisYear;
  return iso(year + 1, m, d);
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/** Every date the text names, as ISO days, in the order they appear. */
export function datesNamedIn(text: string, today: string): string[] {
  const found: Array<{ at: number; date: string }> = [];
  const add = (at: number, date: string | undefined) => { if (date) found.push({ at, date }); };
  const t = text || "";

  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index!, iso(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) add(m.index!, iso(fullYear(m[3]), Number(m[2]), Number(m[1])));
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_WORD}\\b\\.?(?:,?\\s+(\\d{4}))?`, "gi");
  for (const m of t.matchAll(dayMonth)) {
    const month = MONTHS[m[2].toLowerCase()];
    add(m.index!, m[3] ? iso(Number(m[3]), month, Number(m[1])) : nextOccurrence(month, Number(m[1]), today));
  }
  const monthDay = new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi");
  for (const m of t.matchAll(monthDay)) {
    const month = MONTHS[m[1].toLowerCase()];
    add(m.index!, m[3] ? iso(Number(m[3]), month, Number(m[2])) : nextOccurrence(month, Number(m[2]), today));
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.date)
    .filter((d) => (seen.has(d) ? false : (seen.add(d), true)));
}

/** The dates the text names that fall on one of the company's closed days. */
export function closedDayMentions(
  text: string,
  closedDates: Array<{ date: string; label?: string }>,
  today: string,
): ClosedDayMention[] {
  if (!text || !closedDates.length) return [];
  const byDate = new Map(closedDates.map((c) => [c.date, c]));
  return datesNamedIn(text, today)
    .filter((d) => byDate.has(d))
    .map((d) => ({ date: d, ...(byDate.get(d)!.label ? { label: byDate.get(d)!.label } : {}) }));
}
