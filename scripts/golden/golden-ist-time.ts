/**
 * golden-ist-time.ts — IST timezone chokepoint (NEW, S6 D-6/D-7).
 *
 * WHY THIS TEST EXISTS:
 *   Audit S6 D-6/D-7: "today" / "midnight reset" / "business hours" were
 *   computed in UTC or server-local, not IST — 5.5h off. On a UTC server this
 *   silently shifted daily counters + the SLA day-of-week. This golden pins
 *   the IST helpers in src/lib/time.ts so a future refactor can't reintroduce
 *   the drift.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — every value verifiable on a clock):
 *   All test inputs are FIXED UTC instants; the IST expected values are
 *   computed by hand (UTC + 5:30, day rollover when crossing midnight).
 *
 *   CASE A — istParts at 19:00 UTC = 00:30 IST NEXT DAY.
 *     Input:  2026-07-28T19:00:00.000Z  (a Tuesday in UTC)
 *     IST:    2026-07-29 00:30  (Wednesday in IST — day rolled forward)
 *     dayOfWeek = 3 (Wednesday)
 *
 *   CASE B — istParts at 12:00 UTC = 17:30 IST SAME DAY.
 *     Input:  2026-07-28T12:00:00.000Z  (Tuesday UTC)
 *     IST:    2026-07-28 17:30  (same Tuesday in IST)
 *     dayOfWeek = 2 (Tuesday)
 *
 *   CASE C — startOfIstDay at 19:00 UTC = midnight of the IST day (18:30 UTC).
 *     Input:  2026-07-28T19:00:00.000Z
 *     Expected start: 2026-07-29 00:00 IST = 2026-07-28T18:30:00.000Z
 *
 *   CASE D — nextIstMidnight: from 12:00 UTC → next 00:00 IST = 18:30 UTC same day.
 *     Input:  2026-07-28T12:00:00.000Z
 *     Expected next midnight: 2026-07-29 00:00 IST = 2026-07-28T18:30:00.000Z
 *
 *   CASE E — todayIstIsoDate at 19:00 UTC returns the IST date (next day).
 *     Input:  2026-07-28T19:00:00.000Z  →  IST date "2026-07-29" (NOT "2026-07-28")
 *
 *   CASE F — isWithinIstBusinessHours: the SLA day-rollover bug.
 *     At 2026-07-26T19:00:00.000Z (= Sunday 19:00 UTC = Monday 00:30 IST),
 *     with businessDays Mon-Sat [1,2,3,4,5,6] and hours 9-18:
 *       OLD broken code (getUTCDay) → day=0 (Sunday) → NOT in [1-6] → false (WRONG)
 *       NEW ist code → day=1 (Monday IST) → in [1-6] BUT hours=0 → outside 9-18 → false (correct: it's 00:30, outside business hours)
 *     Better test: at 2026-07-28T03:00:00.000Z (= 08:30 IST Tuesday) the OLD
 *       code said day=getUTCDay=Tuesday but hours=3 → outside 9-18 → false.
 *       NEW says hours=8 → outside 9-18 → false. Both false here.
 *     Cleanest load-bearing case: 2026-07-28T04:00:00.000Z = 09:30 IST Tuesday.
 *       NEW: day=Tuesday(2) in [1-6], hours=9 in [9,18) → TRUE.
 *
 * REAL PIPELINE: pure functions, fixed inputs. No mocks, no clock dependency.
 *
 * Run: `npm run golden:ist-time`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { istParts, startOfIstDay, nextIstMidnight, todayIstIsoDate, isWithinIstBusinessHours } from "@/lib/time";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

test("CASE A — istParts at 19:00 UTC = 00:30 IST NEXT DAY (day rolls forward)", async () => {
  const at = new Date("2026-07-28T19:00:00.000Z"); // Tuesday UTC
  const p = istParts(at);
  // IST = UTC + 5:30 → 19:00 + 5:30 = 24:30 = next day 00:30.
  assert.strictEqual(p.year, 2026, "year");
  assert.strictEqual(p.month, 7, "month");
  assert.strictEqual(p.day, 29, "day rolled to 29 (was 28 UTC)");
  assert.strictEqual(p.hours, 0, "hours = 0");
  assert.strictEqual(p.minutes, 30, "minutes = 30");
  assert.strictEqual(p.dayOfWeek, 3, "dayOfWeek = 3 (Wednesday in IST; was Tuesday in UTC)");
});

test("CASE B — istParts at 12:00 UTC = 17:30 IST SAME DAY (no rollover)", async () => {
  const at = new Date("2026-07-28T12:00:00.000Z"); // Tuesday UTC
  const p = istParts(at);
  // 12:00 + 5:30 = 17:30 same day.
  assert.strictEqual(p.day, 28, "same day");
  assert.strictEqual(p.hours, 17, "hours = 17");
  assert.strictEqual(p.minutes, 30, "minutes = 30");
  assert.strictEqual(p.dayOfWeek, 2, "dayOfWeek = 2 (Tuesday, same in IST)");
});

test("CASE C — startOfIstDay at 19:00 UTC = midnight IST (18:30 UTC)", async () => {
  const at = new Date("2026-07-28T19:00:00.000Z");
  const start = startOfIstDay(at);
  // IST day is 2026-07-29 (rolled forward); midnight IST = 2026-07-28T18:30:00Z.
  assert.strictEqual(start.toISOString(), "2026-07-28T18:30:00.000Z", "start of IST day in UTC");
});

test("CASE D — nextIstMidnight from 12:00 UTC = 18:30 UTC same day", async () => {
  const at = new Date("2026-07-28T12:00:00.000Z");
  const next = nextIstMidnight(at);
  // Current IST day = 2026-07-28; next midnight IST = 2026-07-29 00:00 IST = 2026-07-28T18:30:00Z.
  assert.strictEqual(next.toISOString(), "2026-07-28T18:30:00.000Z", "next IST midnight in UTC");
});

test("CASE E — todayIstIsoDate at 19:00 UTC returns the IST date (next day)", async () => {
  const at = new Date("2026-07-28T19:00:00.000Z");
  assert.strictEqual(todayIstIsoDate(at), "2026-07-29", "IST date is 2026-07-29 (UTC was 2026-07-28)");
  // And a no-rollover case.
  const at2 = new Date("2026-07-28T12:00:00.000Z");
  assert.strictEqual(todayIstIsoDate(at2), "2026-07-28", "IST date is 2026-07-28 (same as UTC, no rollover)");
});

test("CASE F — isWithinIstBusinessHours uses the IST day-of-week (the SLA bug fix)", async () => {
  // THE load-bearing case: at 2026-07-28T04:00:00.000Z = 09:30 IST Tuesday.
  // businessDays Mon-Sat [1,2,3,4,5,6], hours 9-18.
  // NEW code: day=Tuesday(2) in [1-6], hours=9 in [9,18) → TRUE.
  const tuesday0930Ist = new Date("2026-07-28T04:00:00.000Z");
  assert.strictEqual(
    isWithinIstBusinessHours(tuesday0930Ist, 9, 18, [1, 2, 3, 4, 5, 6]),
    true,
    "09:30 IST Tuesday is within business hours (Mon-Sat 9-18)",
  );
  // Sunday 09:30 IST = 2026-07-26T04:00:00Z → day=Sunday(0) NOT in [1-6] → false.
  const sunday0930Ist = new Date("2026-07-26T04:00:00.000Z");
  assert.strictEqual(
    isWithinIstBusinessHours(sunday0930Ist, 9, 18, [1, 2, 3, 4, 5, 6]),
    false,
    "Sunday is not a business day even within hours",
  );
  // Tuesday 02:00 IST = 2026-07-27T20:30:00Z → day=Tuesday but hours=2 → outside 9-18 → false.
  const tuesday0200Ist = new Date("2026-07-27T20:30:00.000Z");
  assert.strictEqual(
    isWithinIstBusinessHours(tuesday0200Ist, 9, 18, [1, 2, 3, 4, 5, 6]),
    false,
    "02:00 IST Tuesday is outside business hours (9-18)",
  );
  // The exact SLA bug case: 2026-07-26T19:00:00Z = Monday 00:30 IST. The OLD
  // code used getUTCDay (=Sunday=0) so it said "not a business day". The NEW
  // code correctly sees Monday IST but hours=0 → outside 9-18 → false. Both
  // false here, but for the RIGHT reason (IST day, IST hours).
  const monday0030Ist = new Date("2026-07-26T19:00:00.000Z");
  assert.strictEqual(
    isWithinIstBusinessHours(monday0030Ist, 9, 18, [1, 2, 3, 4, 5, 6]),
    false,
    "00:30 IST Monday is outside business hours (correct: hours matter, not just day)",
  );
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`ist-time: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
