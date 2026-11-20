/**
 * Festival calendar + each company's holiday rules (2026-09-30, CEO-approved
 * plan docs/planning/FESTIVAL-CALENDAR-PLAN.md; rules in docs/LOGIC.md
 * FESTIVAL-CALENDAR).
 *
 *   - The festival list comes from Google's PUBLIC "Holidays in India"
 *     calendar: one read of a public file, no key, no company data sent. It is
 *     kept in memory for 12 hours. If it cannot be read, the last good copy is
 *     used, and before any copy exists the built-in list (checked against the
 *     same calendar on 2026-09-29) — the owner never sees an empty list.
 *   - Each company says, per festival, whether it closes and for how many days
 *     around it. Those rules turn into closed days for this year and next; the
 *     reply-deadline clock already stops on closed days. Hand-added closed days
 *     are never touched.
 *   - Nothing here sends anything to anyone.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { createRepositories } from "@/repositories";
import { NeedsActionError } from "@/lib/user-errors";
import { todayIstIsoDate } from "@/lib/time";
import { defaultTicketSlaSettings } from "@/lib/ticket-sla";
import { suggestedIndianHolidays, HOLIDAY_SUGGESTION_YEARS } from "@/lib/holiday-suggestions";
import {
  FESTIVALS, cleanFestivalRules, closedDaysFromRules, mergeRuleClosedDays, parseFestivalCalendar,
  type ClosedDateEntry, type FestivalDay, type FestivalKey, type FestivalRule,
} from "@/lib/festival-calendar";

export const GOOGLE_INDIA_HOLIDAYS_ICS =
  "https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics";
const CACHE_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export type FestivalCalendar = { days: FestivalDay[]; source: "google" | "built_in"; fetchedAt?: string };

let cache: { at: number; calendar: FestivalCalendar } | undefined;

/** Test hook: swap the reader and clear the cache. */
let reader: () => Promise<string> = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_INDIA_HOLIDAYS_ICS, { signal: controller.signal, headers: { accept: "text/calendar" } });
    if (!res.ok) throw new Error(`calendar answered ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
};
export function setFestivalCalendarReaderForTests(next: (() => Promise<string>) | undefined): void {
  reader = next ?? reader;
  cache = undefined;
}

/** The built-in list, used only before Google's calendar has ever been read. */
function builtInCalendar(): FestivalCalendar {
  const byName = new Map(FESTIVALS.map((f) => [f.name.toLowerCase(), f]));
  const aliases: Record<string, FestivalKey> = {
    "makar sankranti / pongal": "makar_sankranti", "eid al-fitr": "eid_ul_fitr", "diwali (govardhan puja)": "govardhan_puja",
    "gandhi jayanti": "gandhi_jayanti",
  };
  const days: FestivalDay[] = [];
  for (const year of HOLIDAY_SUGGESTION_YEARS) {
    for (const h of suggestedIndianHolidays(year).holidays) {
      const key = aliases[h.label.toLowerCase()] ?? byName.get(h.label.toLowerCase())?.key;
      const def = key ? FESTIVALS.find((f) => f.key === key) : undefined;
      if (def) days.push({ key: def.key, name: def.name, date: h.date, tentative: false });
    }
  }
  return { days: days.sort((a, b) => a.date.localeCompare(b.date)), source: "built_in" };
}

export async function getFestivalCalendar(now: number = Date.now()): Promise<FestivalCalendar> {
  if (cache && now - cache.at < CACHE_MS) return cache.calendar;
  try {
    const days = parseFestivalCalendar(await reader());
    if (days.length < 20) throw new Error("the calendar came back almost empty");
    cache = { at: now, calendar: { days, source: "google", fetchedAt: new Date(now).toISOString() } };
    return cache.calendar;
  } catch (error) {
    console.warn("[festivals] Google's holiday calendar could not be read:", error instanceof Error ? error.message : error);
    if (cache) return cache.calendar; // the last good copy
    return builtInCalendar();
  }
}

function yearsFromToday(today = todayIstIsoDate()): number[] {
  const y = Number(today.slice(0, 4));
  return [y, y + 1];
}

async function settingsFor(workspaceId: string, repos: RepositoryBundle) {
  const saved = await repos.ticketSlaSettings.getByWorkspace(workspaceId);
  return saved || ({ id: "", createdAt: "", updatedAt: "", ...defaultTicketSlaSettings(workspaceId) } as NonNullable<typeof saved>);
}

export type FestivalView = {
  source: FestivalCalendar["source"];
  /** Each festival's next date from today, in date order. */
  upcoming: Array<FestivalDay & { rule?: FestivalRule }>;
  rules: FestivalRule[];
  /** The closed days the rules give (this year and next). */
  closedByRules: ClosedDateEntry[];
};

export async function getFestivalView(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<FestivalView> {
  const [calendar, settings] = await Promise.all([getFestivalCalendar(), settingsFor(workspaceId, repos)]);
  const today = todayIstIsoDate();
  const rules = settings.festivalRules || [];
  const next = new Map<FestivalKey, FestivalDay>();
  for (const day of calendar.days) if (day.date >= today && !next.has(day.key)) next.set(day.key, day);
  const upcoming = [...next.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({ ...day, rule: rules.find((r) => r.key === day.key) }));
  return {
    source: calendar.source,
    upcoming,
    rules,
    closedByRules: (settings.closedDates || []).filter((d) => (d as ClosedDateEntry).fromRule) as ClosedDateEntry[],
  };
}

/** Saves the owner's rules and turns them into closed days for this year and next. */
export async function saveFestivalRules(workspaceId: string, input: unknown, repos: RepositoryBundle = createRepositories()): Promise<FestivalView> {
  const cleaned = cleanFestivalRules(input);
  if ("problem" in cleaned) throw new NeedsActionError(cleaned.problem, 400);
  await applyRules(workspaceId, cleaned.rules, repos);
  return getFestivalView(workspaceId, repos);
}

async function applyRules(workspaceId: string, rules: FestivalRule[], repos: RepositoryBundle): Promise<number> {
  const calendar = await getFestivalCalendar();
  const settings = await settingsFor(workspaceId, repos);
  const fromRules = closedDaysFromRules(rules, calendar.days, yearsFromToday());
  const closedDates = mergeRuleClosedDays((settings.closedDates || []) as ClosedDateEntry[], fromRules);
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = settings;
  await repos.ticketSlaSettings.upsertForWorkspace(workspaceId, { ...rest, festivalRules: rules, closedDates });
  return fromRules.length;
}

/**
 * Daily routine: re-apply every company's rules so next year's dates appear
 * as soon as the calendar has them. Changes nothing for a company with no
 * rules. Never throws; returns how many companies were refreshed.
 */
export async function refreshFestivalClosedDays(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<boolean> {
  try {
    const settings = await repos.ticketSlaSettings.getByWorkspace(workspaceId);
    if (!settings?.festivalRules?.length) return false;
    await applyRules(workspaceId, settings.festivalRules, repos);
    return true;
  } catch (error) {
    console.warn("[festivals] refreshing closed days failed:", error instanceof Error ? error.message : error);
    return false;
  }
}
