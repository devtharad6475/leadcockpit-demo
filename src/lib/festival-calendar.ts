/**
 * The festival list, from Google's public "Holidays in India" calendar
 * (2026-09-30, CEO-approved plan docs/planning/FESTIVAL-CALENDAR-PLAN.md).
 *
 * Pure parts only: reading the calendar file and naming the festivals. The
 * fetching and caching live in FestivalCalendarService.
 *
 * The calendar holds ~60 named days a year, many of them regional or minor
 * observances. The owner is offered the festivals and national holidays below
 * — the days an Indian business might actually close or plan around. Anything
 * else in the file is ignored, never guessed at.
 */

export type FestivalKey =
  | "new_year" | "lohri" | "makar_sankranti" | "pongal" | "republic_day" | "vasant_panchami"
  | "maha_shivaratri" | "holika_dahana" | "holi" | "good_friday" | "gudi_padwa" | "ugadi"
  | "ram_navami" | "mahavir_jayanti" | "ambedkar_jayanti" | "vaisakhi" | "eid_ul_fitr"
  | "buddha_purnima" | "bakrid" | "muharram" | "rath_yatra" | "independence_day"
  | "raksha_bandhan" | "janmashtami" | "ganesh_chaturthi" | "onam" | "milad_un_nabi"
  | "gandhi_jayanti" | "navratri" | "durga_puja" | "dussehra" | "karva_chauth"
  | "naraka_chaturdashi" | "diwali" | "govardhan_puja" | "bhai_dooj" | "chhath_puja"
  | "guru_nanak_jayanti" | "christmas";

type FestivalDef = { key: FestivalKey; name: string; match: RegExp; season?: boolean };

/**
 * `match` is tested against the calendar's own name for the day. "(tentative)"
 * dates (moon-sighting festivals such as Eid) are kept and flagged.
 * `season: true` marks the festivals Indian B2B buyers stock up for — the ones
 * the "festival coming" reminder looks ahead to.
 */
export const FESTIVALS: FestivalDef[] = [
  { key: "new_year", name: "New Year's Day", match: /^New Year's Day$/i },
  { key: "lohri", name: "Lohri", match: /^Lohri$/i },
  { key: "makar_sankranti", name: "Makar Sankranti", match: /^Makar Sankranti$/i },
  { key: "pongal", name: "Pongal", match: /^Pongal$/i },
  { key: "republic_day", name: "Republic Day", match: /^Republic Day$/i },
  { key: "vasant_panchami", name: "Vasant Panchami", match: /^Vasant Panchami$/i },
  { key: "maha_shivaratri", name: "Maha Shivaratri", match: /^Maha Shivaratri$/i },
  { key: "holika_dahana", name: "Holika Dahan", match: /^Holika Dahana$/i },
  { key: "holi", name: "Holi", match: /^Holi$/i, season: true },
  { key: "good_friday", name: "Good Friday", match: /^Good Friday$/i },
  { key: "gudi_padwa", name: "Gudi Padwa", match: /^Gudi Padwa$/i },
  { key: "ugadi", name: "Ugadi", match: /^Ugadi$/i },
  { key: "ram_navami", name: "Ram Navami", match: /^Rama Navami$/i },
  { key: "mahavir_jayanti", name: "Mahavir Jayanti", match: /^Mahavir Jayanti$/i },
  { key: "ambedkar_jayanti", name: "Ambedkar Jayanti", match: /^Ambedkar Jayanti$/i },
  { key: "vaisakhi", name: "Vaisakhi", match: /^Vaisakhi$/i },
  { key: "eid_ul_fitr", name: "Eid ul-Fitr", match: /^Ramzan Id( \(tentative\))?$/i, season: true },
  { key: "buddha_purnima", name: "Buddha Purnima", match: /^Buddha Purnima$/i },
  { key: "bakrid", name: "Bakrid (Eid ul-Adha)", match: /^Bakrid( \(tentative\))?$/i },
  { key: "muharram", name: "Muharram", match: /^Muharram\/Ashura( \(tentative\))?$/i },
  { key: "rath_yatra", name: "Rath Yatra", match: /^Rath Yatra$/i },
  { key: "independence_day", name: "Independence Day", match: /^Independence Day$/i },
  { key: "raksha_bandhan", name: "Raksha Bandhan", match: /^Raksha Bandhan$/i, season: true },
  { key: "janmashtami", name: "Janmashtami", match: /^Janmashtami$/i },
  { key: "ganesh_chaturthi", name: "Ganesh Chaturthi", match: /^Ganesh Chaturthi$/i, season: true },
  { key: "onam", name: "Onam", match: /^Onam$/i },
  { key: "milad_un_nabi", name: "Milad un-Nabi", match: /^Milad un-Nabi( \(tentative\))?$/i },
  { key: "gandhi_jayanti", name: "Gandhi Jayanti", match: /^Mahatma Gandhi Jayanti$/i },
  { key: "navratri", name: "Navratri (first day)", match: /^First Day of Sharad Navratri$/i, season: true },
  { key: "durga_puja", name: "Durga Puja (first day)", match: /^First Day of Durga Puja Festivities$/i },
  { key: "dussehra", name: "Dussehra", match: /^Dussehra$/i },
  { key: "karva_chauth", name: "Karva Chauth", match: /^Karaka Chaturthi$/i },
  { key: "naraka_chaturdashi", name: "Choti Diwali", match: /^Naraka Chaturdasi$/i },
  { key: "diwali", name: "Diwali", match: /^Diwali\/Deepavali$/i, season: true },
  { key: "govardhan_puja", name: "Govardhan Puja", match: /^Govardhan Puja$/i },
  { key: "bhai_dooj", name: "Bhai Dooj", match: /^Bhai Duj$/i },
  { key: "chhath_puja", name: "Chhath Puja", match: /^Chhat Puja/i },
  { key: "guru_nanak_jayanti", name: "Guru Nanak Jayanti", match: /^Guru Nanak Jayanti$/i },
  { key: "christmas", name: "Christmas", match: /^Christmas$/i, season: true },
];

export const FESTIVAL_BY_KEY = new Map(FESTIVALS.map((f) => [f.key, f]));

export type FestivalDay = { key: FestivalKey; name: string; date: string; tentative: boolean };

/** Unfolds an .ics file (continuation lines start with a space or tab). */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/**
 * Reads the festivals out of an iCalendar file. Unknown days are skipped; a
 * festival listed twice on the same date is kept once; the result is sorted.
 */
export function parseFestivalCalendar(ics: string): FestivalDay[] {
  const out = new Map<string, FestivalDay>();
  let date = "";
  let summary = "";
  for (const line of unfold(ics)) {
    if (line.startsWith("BEGIN:VEVENT")) { date = ""; summary = ""; continue; }
    if (line.startsWith("DTSTART")) {
      const m = line.match(/:(\d{4})(\d{2})(\d{2})/);
      if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
      continue;
    }
    if (line.startsWith("SUMMARY")) { summary = line.slice(line.indexOf(":") + 1).trim(); continue; }
    if (line.startsWith("END:VEVENT")) {
      if (!date || !summary) continue;
      const def = FESTIVALS.find((f) => f.match.test(summary));
      if (!def) continue;
      out.set(`${def.key}:${date}`, { key: def.key, name: def.name, date, tentative: /tentative/i.test(summary) });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** The date of a festival in a given year, if the calendar has it. */
export function festivalDate(days: FestivalDay[], key: FestivalKey, year: number): FestivalDay | undefined {
  return days.find((d) => d.key === key && d.date.startsWith(`${year}-`));
}

// ─── The owner's rules ──────────────────────────────────────────────────────

/** How one company takes one festival (asked once, repeats every year). */
export type FestivalRule = {
  key: FestivalKey;
  /** Closed for it at all. A rule with closed=false is kept (the owner said "open"). */
  closed: boolean;
  /** Closed days before and after the festival day itself (0–10). */
  daysBefore: number;
  daysAfter: number;
  /** Open for half the day rather than closed (recorded; the reply clock treats it as open). */
  halfDay?: boolean;
  /** Dispatch stops too. */
  dispatchStops?: boolean;
};

export const MAX_DAYS_AROUND = 10;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Checks and tidies the owner's rules; returns a plain-English problem or the clean list. */
export function cleanFestivalRules(input: unknown): { rules: FestivalRule[] } | { problem: string } {
  if (!Array.isArray(input)) return { problem: "Send the festival rules as a list." };
  const byKey = new Map<FestivalKey, FestivalRule>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { problem: "Each festival rule must be filled in." };
    const r = raw as Record<string, unknown>;
    const key = String(r.key || "") as FestivalKey;
    if (!FESTIVAL_BY_KEY.has(key)) return { problem: "One of the festivals is not in the list." };
    const before = Number(r.daysBefore ?? 0);
    const after = Number(r.daysAfter ?? 0);
    for (const n of [before, after]) {
      if (!Number.isInteger(n) || n < 0 || n > MAX_DAYS_AROUND) return { problem: `Days before and after must be whole numbers from 0 to ${MAX_DAYS_AROUND}.` };
    }
    byKey.set(key, { key, closed: Boolean(r.closed), daysBefore: before, daysAfter: after, halfDay: Boolean(r.halfDay), dispatchStops: Boolean(r.dispatchStops) });
  }
  return { rules: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export type ClosedDateEntry = { date: string; label?: string; fromRule?: FestivalKey };

/**
 * The closed days the owner's rules give for the given years. Half-day rules
 * close nothing (the day is still worked). A festival the calendar does not
 * list for a year gives nothing for that year — never a guessed date.
 */
export function closedDaysFromRules(rules: FestivalRule[], days: FestivalDay[], years: number[]): ClosedDateEntry[] {
  const out: ClosedDateEntry[] = [];
  for (const rule of rules) {
    if (!rule.closed || rule.halfDay) continue;
    const def = FESTIVAL_BY_KEY.get(rule.key);
    if (!def) continue;
    for (const year of years) {
      const day = festivalDate(days, rule.key, year);
      if (!day) continue;
      for (let offset = -rule.daysBefore; offset <= rule.daysAfter; offset++) {
        const date = addDays(day.date, offset);
        const label = offset === 0 ? def.name : offset < 0 ? `Before ${def.name}` : `After ${def.name}`;
        out.push({ date, label, fromRule: rule.key });
      }
    }
  }
  return out;
}

/**
 * The company's closed days after applying its rules: the days the owner added
 * by hand are kept as they are; the days an earlier version of the rules added
 * are replaced by what the rules give now. A hand-added day always wins over a
 * rule day on the same date.
 */
export function mergeRuleClosedDays(current: ClosedDateEntry[], fromRules: ClosedDateEntry[]): ClosedDateEntry[] {
  const byDate = new Map<string, ClosedDateEntry>();
  for (const entry of fromRules) if (!byDate.has(entry.date)) byDate.set(entry.date, entry);
  for (const entry of current) if (!entry.fromRule) byDate.set(entry.date, { date: entry.date, ...(entry.label ? { label: entry.label } : {}) });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
