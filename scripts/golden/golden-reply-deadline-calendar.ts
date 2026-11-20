/**
 * Golden — reply deadlines follow the company's real calendar (2026-09-28).
 *
 * Review items M9, M10 and the "no working days" save (docs/REVIEW-2026-09-27.md,
 * docs/OPEN-ISSUES.md "Added 2026-09-27"). Rules: docs/LOGIC.md 2026-09-28
 * REPLY-DEADLINE-CALENDAR.
 *
 * Hand-computed (IST = UTC+5:30; default day 09:00–18:00 = 540 working
 * minutes, Mon–Sat). Start: Monday 2026-10-05 10:00 IST = 04:30 UTC.
 *
 *   A  high (1 working day = 540) → Tue 10-06 10:00 IST (04:30Z). With Tue
 *      10-06 marked closed → Wed 10-07 10:00 IST. On 24/7 the closed day is
 *      ignored (the clock never pauses there).
 *   B  defaults match their descriptions: urgent 4 working hours → Mon 14:00
 *      IST; medium 3 working days → Thu 10-08 10:00; low "7 calendar days" →
 *      Mon 10-12 10:00 IST, exactly one week later. (Old low 10080 landed
 *      weeks later — the M9 finding.)
 *   C  a company still holding the old untouched defaults (240/480/1440/10080)
 *      reads the new ones; a company with its own numbers keeps them.
 *   D  settings the clock cannot use are refused in plain words: no working
 *      days, a day that ends before it starts, a closed "date" that is not
 *      one. 24/7 with no working days is fine.
 *   E  the save route runs that check and throws NeedsActionError BEFORE it
 *      writes, and accepts closedDates.
 *   F  the suggested Indian holidays are real dates, include Diwali for 2026
 *      and 2027, and say so honestly when a year's festival dates are unknown.
 *   G  the settings screen offers the editor, labels the list a suggestion to
 *      check, and sends closedDates on save.
 *
 * Run: npx tsx scripts/golden/golden-reply-deadline-calendar.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { computeSla, defaultTicketSlaSettings, slaSettingsProblem, isRealIsoDate, DEFAULT_SLA_MINUTES } from "@/lib/ticket-sla";
import { suggestedIndianHolidays } from "@/lib/holiday-suggestions";
import type { TicketSlaSettings, TicketPriority } from "@/lib/types";
import { createJsonRepos } from "./_helpers/provider";
import { readSource } from "./_helpers/read-source";

const cases: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);

const START = new Date("2026-10-05T04:30:00.000Z"); // Mon 10:00 IST
function settings(over: Partial<TicketSlaSettings> = {}): TicketSlaSettings {
  return { id: "s", createdAt: "", updatedAt: "", ...defaultTicketSlaSettings("ws_cal"), ...over } as TicketSlaSettings;
}
function due(priority: TicketPriority, s: TicketSlaSettings): string {
  return computeSla({ priority, startedAt: START, now: START, settings: s }).dueAt.toISOString();
}

test("A — a closed day stops the clock; 24/7 ignores it", () => {
  assert.equal(due("high", settings()), "2026-10-06T04:30:00.000Z");
  assert.equal(due("high", settings({ closedDates: [{ date: "2026-10-06", label: "Test holiday" }] })), "2026-10-07T04:30:00.000Z");
  assert.equal(due("high", settings({ clockMode: "always_24_7", closedDates: [{ date: "2026-10-05" }] })), "2026-10-05T13:30:00.000Z");
});

test("B — default deadlines are what they say (low = 7 calendar days)", () => {
  const s = settings();
  assert.deepEqual(DEFAULT_SLA_MINUTES, { urgent: 240, high: 540, medium: 1620, low: 3240 });
  assert.equal(due("urgent", s), "2026-10-05T08:30:00.000Z");
  assert.equal(due("medium", s), "2026-10-08T04:30:00.000Z");
  assert.equal(due("low", s), "2026-10-12T04:30:00.000Z", "low must be exactly one week from a Monday start");
});

test("C — untouched old defaults read as the new ones; chosen numbers stay", async () => {
  const repos = createJsonRepos();
  const ws = `ws_cal_${Date.now()}`;
  await repos.ticketSlaSettings.upsertForWorkspace(ws, { urgentSlaMinutes: 240, highSlaMinutes: 480, mediumSlaMinutes: 1440, lowSlaMinutes: 10080 });
  const read = await repos.ticketSlaSettings.getByWorkspace(ws);
  assert.equal(read?.lowSlaMinutes, 3240);
  assert.equal(read?.highSlaMinutes, 540);
  await repos.ticketSlaSettings.upsertForWorkspace(ws, { urgentSlaMinutes: 120, highSlaMinutes: 480, mediumSlaMinutes: 1440, lowSlaMinutes: 10080 });
  assert.equal((await repos.ticketSlaSettings.getByWorkspace(ws))?.lowSlaMinutes, 10080, "an owner's own numbers were rewritten");
  const fresh = await repos.ticketSlaSettings.upsertForWorkspace(`${ws}_new`, {});
  assert.equal(fresh.lowSlaMinutes, 3240);
});

test("D — unusable settings are refused in plain words", () => {
  const base = settings();
  assert.match(String(slaSettingsProblem({ ...base, businessDays: [] })), /at least one working day/);
  assert.equal(slaSettingsProblem({ ...base, clockMode: "always_24_7", businessDays: [] }), null);
  assert.match(String(slaSettingsProblem({ ...base, businessHoursStart: "18:00", businessHoursEnd: "09:00" })), /must end after it starts/);
  assert.match(String(slaSettingsProblem({ ...base, closedDates: [{ date: "2026-02-30" }] })), /is not a date/);
  assert.equal(slaSettingsProblem({ ...base, closedDates: [{ date: "2026-11-08", label: "Diwali" }] }), null);
  assert.equal(slaSettingsProblem(base), null);
});

test("E — the save route checks before it writes and takes closedDates", () => {
  const route = readSource("src/app/api/[[...path]]/route.ts");
  const branch = route.slice(route.indexOf(`if (match(path, ["tickets", "sla-settings"]) && request.method === "POST")`));
  const upsertAt = branch.indexOf("ticketSlaSettings.upsertForWorkspace");
  assert.ok(upsertAt > 0);
  const before = branch.slice(0, upsertAt);
  assert.ok(/slaSettingsProblem\(merged\)/.test(before), "the route does not run slaSettingsProblem before saving");
  assert.ok(/throw new NeedsActionError\(problem, 400\)/.test(before), "the refusal is not a plain NeedsActionError");
  assert.ok(/closedDates/.test(before), "the route drops closedDates");
});

test("F — suggested holidays are real dates and honest about unknown years", () => {
  for (const year of [2026, 2027]) {
    const { holidays, festivalDatesKnown } = suggestedIndianHolidays(year);
    assert.ok(festivalDatesKnown);
    assert.ok(holidays.some((h) => /Diwali/.test(h.label)), `no Diwali in ${year}`);
    for (const h of holidays) assert.ok(isRealIsoDate(h.date) && h.date.startsWith(String(year)), `${h.date} is not a real ${year} date`);
  }
  const unknown = suggestedIndianHolidays(2031);
  assert.equal(unknown.festivalDatesKnown, false);
  assert.ok(unknown.holidays.some((h) => h.date === "2031-01-26"));
});

test("G — the settings screen offers the editor as a suggestion and saves it", () => {
  const screen = readSource("src/app/sections/WorkspaceSettings.tsx");
  const editor = readSource("src/app/sections/ClosedDatesEditor.tsx");
  assert.ok(/<ClosedDatesEditor/.test(screen));
  assert.ok(/closedDates: slaClosedDates/.test(screen), "save does not send closedDates");
  assert.ok(/Add common Indian holidays for \{year\}/.test(editor));
  assert.ok(/suggestions — check each date/.test(editor), "the suggested list is not labelled as something to check");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`); }
    catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${(error as Error).message.split("\n")[0]}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
