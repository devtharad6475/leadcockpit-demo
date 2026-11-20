/**
 * Stage 2 / 2026-07-20 — Ticket SLA clock helpers.
 *
 * Pure functions. No I/O. Pinned by scripts/golden/golden-ticket-sla.ts.
 *
 * Operator-confirmed rules (docs/LOGIC.md 2026-07-20):
 *   - clockMode "business_hours": SLA clock pauses outside the workspace's
 *     business-hours window. Default window 09:00–18:00 IST Mon–Sat.
 *   - clockMode "always_24_7": SLA clock runs continuously.
 *   - clockMode "mixed": urgent priority runs 24/7; high/medium/low use
 *     business hours.
 *   - SLA breach = (current time > dueAt) AND status not resolved/closed.
 */

import type { TicketAssignmentMode, TicketAssignmentRule, TicketPriority, TicketSlaClockMode, TicketSlaSettings } from "./types";
import { istParts } from "./time";

export type SlaInput = {
  priority: TicketPriority;
  startedAt: Date;
  /** "now" for current-time checks; the test passes a fixed value. */
  now: Date;
  settings: TicketSlaSettings;
};

export type SlaResult = {
  dueAt: Date;
  /** True if `now` is past `dueAt`. */
  breached: boolean;
  /** Remaining minutes (negative if breached). */
  remainingMinutes: number;
};

/**
 * Get the SLA duration in minutes for a given priority.
 */
export function slaMinutesForPriority(settings: TicketSlaSettings, priority: TicketPriority): number {
  switch (priority) {
    case "urgent": return settings.urgentSlaMinutes;
    case "high": return settings.highSlaMinutes;
    case "medium": return settings.mediumSlaMinutes;
    case "low": return settings.lowSlaMinutes;
  }
}

/**
 * Returns true when the SLA clock is currently running (ticking) for the
 * given priority + mode at the given moment.
 *
 *   - "always_24_7" → always true.
 *   - "business_hours" → true only inside the business-hours window on a
 *     business day.
 *   - "mixed" → urgent = always; others = business-hours only.
 */
export function isSlaClockTicking(at: Date, priority: TicketPriority, settings: TicketSlaSettings): boolean {
  const mode: TicketSlaClockMode = settings.clockMode || "business_hours";
  if (mode === "always_24_7") return true;
  if (mode === "mixed" && priority === "urgent") return true;
  if (businessWindowIsEmpty(settings)) return true;
  return isWithinBusinessHours(at, settings);
}

function isWithinBusinessHours(at: Date, settings: TicketSlaSettings): boolean {
  // S6 D-6: the day and time are read in IST (istParts handles the UTC→IST
  // day rollover).
  //
  // 2026-09-26 (break test), two fixes:
  //   - Sunday. The settings screen and the save route store ISO weekdays
  //     (1 = Monday … 7 = Sunday); the IST helper reports JS days (0 = Sunday).
  //     So "open 7 days" never counted a single Sunday minute. Sunday is now
  //     matched as 7 (and as 0, for any older record written that way).
  //   - Half hours. Hours were rounded out to whole hours, so 09:30–17:30 ran
  //     the clock from 09:00 to 18:00. Compared in minutes now.
  const start = parseTimeToMinutes(settings.businessHoursStart);
  const end = parseTimeToMinutes(settings.businessHoursEnd);
  const p = istParts(at);
  const days = settings.businessDays || [];
  const isoDay = p.dayOfWeek === 0 ? 7 : p.dayOfWeek;
  if (!days.includes(isoDay) && !(isoDay === 7 && days.includes(0))) return false;
  // 2026-09-28 (M10): a date the owner marked closed (Diwali, Holi, a stock-
  // taking day) is not working time, even on a working weekday.
  if (isClosedDate(p, settings)) return false;
  const minuteOfDay = p.hours * 60 + p.minutes;
  return minuteOfDay >= start && minuteOfDay < end;
}

/**
 * 2026-09-26 (break test): with no working days, or an end time at or before
 * the start, the business-hours clock can never tick. computeSla then walked
 * its whole safety cap and set every deadline about a month out. When the
 * window is empty the clock counts plain hours instead, so the deadline is at
 * least a real one. (The settings route refuses to save such a window.)
 */
function businessWindowIsEmpty(settings: TicketSlaSettings): boolean {
  const days = (settings.businessDays || []).filter((d) => d >= 0 && d <= 7);
  return days.length === 0 || parseTimeToMinutes(settings.businessHoursEnd) <= parseTimeToMinutes(settings.businessHoursStart);
}

/** "YYYY-MM-DD" for an IST date-parts value. */
function istDateKey(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function isClosedDate(p: { year: number; month: number; day: number }, settings: TicketSlaSettings): boolean {
  const closed = settings.closedDates;
  if (!closed || closed.length === 0) return false;
  const key = istDateKey(p);
  return closed.some((entry) => entry && entry.date === key);
}

/** Upper bound on closed dates a company can keep (two years of holidays is far below it). */
export const MAX_CLOSED_DATES = 400;

/**
 * 2026-09-28 — what is wrong with a set of SLA settings, in words the owner
 * can act on, or null when they can be saved. Used by the settings route.
 *
 *   - No working days: the reply-deadline clock would never run. (The engine
 *     falls back to plain hours rather than looping, but saving such a
 *     setting is a mistake the owner should hear about.)
 *   - The day ends at or before it starts: same.
 *   - Closed dates must be real calendar dates, written YYYY-MM-DD.
 * The working-day checks apply only when the business-hours clock is used.
 */
export function slaSettingsProblem(settings: Pick<TicketSlaSettings, "clockMode" | "businessDays" | "businessHoursStart" | "businessHoursEnd" | "closedDates">): string | null {
  const closed: unknown = settings.closedDates ?? [];
  if (!Array.isArray(closed)) return "The closed dates could not be read. Remove them and add them again.";
  if (closed.length > MAX_CLOSED_DATES) return `You can keep at most ${MAX_CLOSED_DATES} closed dates. Remove old ones first.`;
  for (const entry of closed as Array<{ date?: unknown; label?: unknown } | null>) {
    if (!entry || typeof entry.date !== "string" || !isRealIsoDate(entry.date)) {
      const shown = entry && typeof entry.date === "string" ? entry.date : "one of the closed days";
      return `"${shown}" is not a date. Pick the closed day from the calendar.`;
    }
    if (entry.label !== undefined && (typeof entry.label !== "string" || entry.label.length > 80)) {
      return "A closed-day name can be at most 80 characters.";
    }
  }
  if ((settings.clockMode || "business_hours") === "always_24_7") return null;
  const days = (settings.businessDays || []).filter((d) => d >= 1 && d <= 7);
  if (days.length === 0) {
    return "Pick at least one working day. With no working days the reply-deadline clock can never run.";
  }
  if (parseTimeToMinutes(settings.businessHoursEnd) <= parseTimeToMinutes(settings.businessHoursStart)) {
    return "The working day must end after it starts. Check the opening and closing times.";
  }
  return null;
}

/** A real calendar date written YYYY-MM-DD ("2026-02-30" is not one). */
export function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Sort by date and drop repeats (the later name wins), so the saved list is tidy. */
export function tidyClosedDates<T extends { date: string; label?: string; fromRule?: string }>(entries: T[]): T[] {
  const byDate = new Map<string, T>();
  for (const entry of entries) {
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined;
    // 2026-09-30: a day a festival rule added keeps its mark, so the next
    // re-apply of the rules can replace it without touching hand-added days.
    const fromRule = typeof entry.fromRule === "string" && entry.fromRule ? entry.fromRule : undefined;
    byDate.set(entry.date, { date: entry.date, ...(label ? { label } : {}), ...(fromRule ? { fromRule } : {}) } as T);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map((part) => parseInt(part, 10));
  return (h || 0) * 60 + (m || 0);
}

/**
 * Compute the SLA dueAt time and breach status. This is the load-bearing
 * function. Walks forward minute-by-minute in coarse steps (for performance
 * we use 1-minute granularity) — only counting minutes when the clock is
 * ticking.
 *
 * For "always_24_7" mode (or urgent in "mixed" mode) this is simple addition.
 * For "business_hours" mode we skip outside-window minutes.
 *
 * Coarse 1-minute granularity is good enough for SLA math (4h/1d/3d/7d
 * targets are far coarser than 1-minute precision matters for).
 */
export function computeSla(input: SlaInput): SlaResult {
  const totalMinutesNeeded = slaMinutesForPriority(input.settings, input.priority);
  // Walk forward from startedAt, accumulating minutes only when ticking.
  //
  // 2026-09-26 (break test): this used to step ONE minute per loop turn. A
  // long target (a "low" SLA typed as 1,000,000 minutes) held the server for
  // 12 seconds on every new ticket, and bigger numbers for many minutes. The
  // walk now moves in stretches — the rest of an open window, or straight to
  // the next opening — which lands on exactly the same minute as before.
  const cursor = new Date(input.startedAt.getTime());
  const MINUTE = 60_000;
  const settings = input.settings;
  const alwaysTicking = (settings.clockMode || "business_hours") === "always_24_7"
    || (settings.clockMode === "mixed" && input.priority === "urgent")
    || businessWindowIsEmpty(settings);
  let remaining = totalMinutesNeeded;
  if (alwaysTicking) {
    cursor.setTime(cursor.getTime() + remaining * MINUTE);
    remaining = 0;
  }
  const start = parseTimeToMinutes(settings.businessHoursStart);
  const end = parseTimeToMinutes(settings.businessHoursEnd);
  // Guard against pathological inputs — cap the number of stretches.
  let guard = 0;
  while (remaining > 0 && guard < 5_000_000) {
    guard += 1;
    const p = istParts(cursor);
    const minuteOfDay = p.hours * 60 + p.minutes;
    let step: number;
    if (isWithinBusinessHours(cursor, settings)) {
      step = Math.min(remaining, end - minuteOfDay);
      remaining -= step;
    } else if (minuteOfDay < start && isWithinBusinessHours(new Date(cursor.getTime() + (start - minuteOfDay) * MINUTE), settings)) {
      step = start - minuteOfDay; // later today
    } else {
      step = 24 * 60 - minuteOfDay; // next IST midnight
    }
    cursor.setTime(cursor.getTime() + Math.max(1, step) * MINUTE);
  }
  const dueAt = new Date(cursor.getTime());
  const breached = input.now.getTime() > dueAt.getTime();
  const remainingMinutes = Math.round((dueAt.getTime() - input.now.getTime()) / 60000);
  return { dueAt, breached, remainingMinutes };
}

/**
 * DEFAULT_BUSINESS_DAYS — the single source of truth for the "fresh workspace"
 * SLA business-days default. 2026-07-26 Session 4 audit fix (P2-DESIGN-1).
 *
 * Operator directive: "the business hours will be actually set by the user.
 * As the customer wants to put seven days, it will be seven days. If a customer
 * wants six days, it will be six days. It is completely dependent on the
 * customer." This constant is the SEED value (used by defaultTicketSlaSettings
 * when a workspace has no saved settings); the user overrides it via the
 * WorkspaceSettings UI ("Business hours" editor). All 5 previous hardcoded
 * copies ([1,2,3,4,5,6]) now import this constant so a future change to the
 * default lands in ONE place.
 *
 * Convention: ISO weekday numbers (1 = Monday ... 7 = Sunday).
 */
export const DEFAULT_BUSINESS_DAYS = [1, 2, 3, 4, 5, 6] as const; // Mon–Sat (Indian B2B default)
/** Default business-hours window for a fresh workspace. Operator-overridable. */
export const DEFAULT_BUSINESS_HOURS_START = "09:00";
export const DEFAULT_BUSINESS_HOURS_END = "18:00";
/** Default SLA clock mode for a fresh workspace. Operator-overridable. */
export const DEFAULT_CLOCK_MODE: TicketSlaSettings["clockMode"] = "business_hours";

/**
 * 2026-09-28 (M9) — default reply deadlines, in minutes of WORKING time.
 *
 * The clock counts only working minutes (default 09:00–18:00 IST = 540 a day,
 * Mon–Sat). The old defaults were written as if a working day had 8 hours and
 * as if "7 calendar days" could be written as 7 × 24 × 60 working minutes:
 * "high = 1 working day" was 480 (less than a day), "medium = 3 working days"
 * was 1440 (2⅔ days) and "low = 7 calendar days" was 10080 working minutes —
 * about 18½ working days, three calendar weeks.
 *
 * The fix keeps the descriptions and makes the numbers match them on the
 * default working week:
 *   urgent = 4 working hours        = 240
 *   high   = 1 working day (9 h)    = 540
 *   medium = 3 working days         = 1620
 *   low    = 6 working days         = 3240 — one Mon–Sat week, i.e. 7 calendar
 *            days on the default week (longer if a closed date falls in it).
 */
export const DEFAULT_SLA_MINUTES = { urgent: 240, high: 540, medium: 1620, low: 3240 } as const;
/** The defaults before 2026-09-28. */
export const LEGACY_DEFAULT_SLA_MINUTES = { urgent: 240, high: 480, medium: 1440, low: 10080 } as const;

/**
 * A company whose four deadlines are exactly the old defaults gets the new
 * ones. Nobody picked the old numbers on purpose — no screen ever showed the
 * per-priority times — so they are the defaults, carrying the old arithmetic.
 * (Applied when settings are read, on both substrates; the 2026-09-28
 * migration also rewrites such rows in Postgres.)
 */
export function upgradeLegacySlaDefaults<T extends Pick<TicketSlaSettings, "urgentSlaMinutes" | "highSlaMinutes" | "mediumSlaMinutes" | "lowSlaMinutes">>(settings: T): T {
  const old = LEGACY_DEFAULT_SLA_MINUTES;
  if (settings.urgentSlaMinutes === old.urgent && settings.highSlaMinutes === old.high && settings.mediumSlaMinutes === old.medium && settings.lowSlaMinutes === old.low) {
    return { ...settings, highSlaMinutes: DEFAULT_SLA_MINUTES.high, mediumSlaMinutes: DEFAULT_SLA_MINUTES.medium, lowSlaMinutes: DEFAULT_SLA_MINUTES.low };
  }
  return settings;
}

/**
 * Default SLA settings for a fresh workspace. Per OPEN_QUESTIONS S2-Q1.
 */
export function defaultTicketSlaSettings(workspaceId: string): Pick<TicketSlaSettings, "workspaceId" | "clockMode" | "businessHoursStart" | "businessHoursEnd" | "businessDays" | "closedDates" | "urgentSlaMinutes" | "highSlaMinutes" | "mediumSlaMinutes" | "lowSlaMinutes" | "assignmentMode" | "assignmentRules" | "roundRobinPointer"> {
  return {
    workspaceId,
    clockMode: DEFAULT_CLOCK_MODE,
    businessHoursStart: DEFAULT_BUSINESS_HOURS_START,
    businessHoursEnd: DEFAULT_BUSINESS_HOURS_END,
    businessDays: [...DEFAULT_BUSINESS_DAYS], // Mon–Sat default (operator-overridable per workspace via WorkspaceSettings UI).
    closedDates: [],
    urgentSlaMinutes: DEFAULT_SLA_MINUTES.urgent, // 4 working hours
    highSlaMinutes: DEFAULT_SLA_MINUTES.high,     // 1 working day
    mediumSlaMinutes: DEFAULT_SLA_MINUTES.medium, // 3 working days
    lowSlaMinutes: DEFAULT_SLA_MINUTES.low,       // 6 working days = 7 calendar days on a Mon–Sat week
    assignmentMode: "manual" as TicketAssignmentMode,  // 2026-07-21 — default manual
    assignmentRules: [] as TicketAssignmentRule[],
    roundRobinPointer: 0,
  };
}
