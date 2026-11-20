/**
 * holiday-suggestions.ts — a starting list of common Indian holidays that the
 * owner can add to their closed dates in one click (2026-09-28, M10).
 *
 * THIS IS A SUGGESTION, NOT A CALENDAR OF RECORD. Festival dates follow the
 * lunar calendar, differ by state and community, and some are announced late.
 * The screen says "check these dates" and every one can be removed or edited.
 * The product never closes a day by itself: nothing here takes effect until
 * the owner adds it and saves.
 *
 * Only the years below carry festival dates. For any other year the list holds
 * the fixed-date national holidays alone, and `festivalDatesKnown` is false so
 * the screen can say "add the festival days yourself".
 */

export type SuggestedHoliday = { date: string; label: string };

/** National holidays on the same date every year. */
const FIXED: Array<{ monthDay: string; label: string }> = [
  { monthDay: "01-26", label: "Republic Day" },
  { monthDay: "08-15", label: "Independence Day" },
  { monthDay: "10-02", label: "Gandhi Jayanti" },
  { monthDay: "12-25", label: "Christmas" },
];

/**
 * Major festivals by year. Kept short on purpose — the days most Indian
 * businesses close — and to be checked by the owner.
 */
const FESTIVALS: Record<number, SuggestedHoliday[]> = {
  2026: [
    { date: "2026-01-14", label: "Makar Sankranti / Pongal" },
    { date: "2026-03-04", label: "Holi" },
    { date: "2026-03-21", label: "Eid al-Fitr" },
    { date: "2026-04-03", label: "Good Friday" },
    { date: "2026-10-20", label: "Dussehra" },
    { date: "2026-11-08", label: "Diwali" },
    { date: "2026-11-09", label: "Diwali (Govardhan Puja)" },
    { date: "2026-11-11", label: "Bhai Dooj" },
  ],
  2027: [
    { date: "2027-01-14", label: "Makar Sankranti / Pongal" },
    { date: "2027-03-10", label: "Eid al-Fitr" },
    { date: "2027-03-22", label: "Holi" },
    { date: "2027-03-26", label: "Good Friday" },
    { date: "2027-10-09", label: "Dussehra" },
    { date: "2027-10-29", label: "Diwali" },
    { date: "2027-10-30", label: "Diwali (Govardhan Puja)" },
    { date: "2027-10-31", label: "Bhai Dooj" },
  ],
};

/** The years for which festival dates are included. */
export const HOLIDAY_SUGGESTION_YEARS = Object.keys(FESTIVALS).map(Number).sort();

export function suggestedIndianHolidays(year: number): { holidays: SuggestedHoliday[]; festivalDatesKnown: boolean } {
  const fixed = FIXED.map((h) => ({ date: `${year}-${h.monthDay}`, label: h.label }));
  const festivals = FESTIVALS[year] || [];
  const holidays = [...fixed, ...festivals].sort((a, b) => a.date.localeCompare(b.date));
  return { holidays, festivalDatesKnown: festivals.length > 0 };
}
