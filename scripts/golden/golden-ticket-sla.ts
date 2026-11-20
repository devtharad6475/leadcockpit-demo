/**
 * Golden test — Ticket SLA clock (Stage 2).
 *
 * Phase 1.5 / skill v2 — written BEFORE the wiring.
 *
 * Operator-confirmed rules (docs/LOGIC.md 2026-07-20; Mon-Sat default updated 2026-07-26 per operator directive "business hours will be set by the user"):
 *   - "business_hours" mode: SLA pauses outside 09:00–18:00 IST, default Mon–Sat (operator-overridable per workspace).
 *   - "always_24_7" mode: SLA runs continuously.
 *   - "mixed" mode: urgent runs 24/7; others business-hours-only.
 *
 * Hand-computed expected values (every value checked on a calculator):
 *
 * All times are in UTC. IST = UTC + 5:30. The default business window is
 * 09:00–18:00 IST = 03:30–12:30 UTC.
 *
 *   CASE A — business_hours, urgent (4h = 240min), started inside window
 *     startedAt = Monday 05:00 UTC (= 10:30 IST, inside window)
 *     now       = Monday 06:00 UTC (= 11:30 IST, 1 hour after start, inside window)
 *     Expected: 240 min SLA all-ticking in this window → dueAt = Monday 09:00
 *               UTC (= 14:30 IST, 4 hours after startedAt). At now=06:00 UTC
 *               we're 1 hour in → remainingMinutes = 180.
 *
 *   CASE B — business_hours, urgent (4h), started near end of day, BREACHED
 *     startedAt = Monday 12:00 UTC (= 17:30 IST, inside window, 30 min left)
 *     now       = Tuesday 09:00 UTC (= 14:30 IST, next business day)
 *     Expected: 30 min ticks Monday + 210 min needed Tuesday. dueAt = Tuesday
 *               07:00 UTC (= 12:30 IST). At now=09:00 UTC, BREACHED by 120 min.
 *
 *   CASE C — always_24_7, urgent (4h = 240min)
 *     startedAt = Friday 17:00 UTC
 *     now       = Friday 21:00 UTC (4 hours later, weekend irrelevant)
 *     Expected: dueAt = Friday 21:00 UTC exactly (240 minutes wall-clock).
 *               breached = false (exactly at boundary).
 *
 *   CASE D — always_24_7, breach detected
 *     Same as C but now = Friday 22:00 UTC (5 hours later, 1h past due).
 *     Expected: breached = true, remainingMinutes = -60.
 *
 *   CASE E — mixed mode, urgent runs 24/7 but high uses business hours
 *     startedAt = Saturday 10:00 UTC (weekend — not a business day)
 *     priority  = urgent → 24/7 in mixed mode
 *     now       = Saturday 14:00 UTC
 *     Expected (urgent): dueAt = Saturday 14:00 UTC (4h wall-clock, weekend
 *                       irrelevant because urgent in mixed mode runs 24/7).
 *
 *   CASE F — mixed mode, high priority uses business hours
 *     Same start as E but priority = high.
 *     Expected: clock does NOT tick on weekend → dueAt pushed into Monday.
 *               (We don't pin an exact minute here — just verify the dueAt
 *               is on or after Monday 03:30 UTC = Monday 09:00 IST.)
 *
 * Run: npx tsx scripts/golden/golden-ticket-sla.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { computeSla, defaultTicketSlaSettings } from "@/lib/ticket-sla";
import type { TicketSlaSettings } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function makeSettings(overrides: Partial<TicketSlaSettings>): TicketSlaSettings {
  return {
    id: "sla_test",
    createdAt: "2026-07-20T00:00:00Z",
    updatedAt: "2026-07-20T00:00:00Z",
    ...defaultTicketSlaSettings("ws_test"),
    ...overrides,
  } as TicketSlaSettings;
}

// Helper: 2024-07-15 was a Monday.
const MONDAY_05_00 = new Date("2024-07-15T05:00:00.000Z");
const MONDAY_06_00 = new Date("2024-07-15T06:00:00.000Z");
const MONDAY_09_00 = new Date("2024-07-15T09:00:00.000Z");
const MONDAY_12_00 = new Date("2024-07-15T12:00:00.000Z");
const TUESDAY_09_00 = new Date("2024-07-16T09:00:00.000Z");
const FRIDAY_17_00 = new Date("2024-07-19T17:00:00.000Z");
const FRIDAY_21_00 = new Date("2024-07-19T21:00:00.000Z");
const FRIDAY_22_00 = new Date("2024-07-19T22:00:00.000Z");
const SATURDAY_10_00 = new Date("2024-07-20T10:00:00.000Z");
const SATURDAY_14_00 = new Date("2024-07-20T14:00:00.000Z");
const MONDAY_NEXT_03_30 = new Date("2024-07-22T03:30:00.000Z"); // Monday 09:00 IST

async function main() {
  // === CASE A — business_hours, urgent, started inside window ===
  {
    const result = computeSla({
      priority: "urgent",
      startedAt: MONDAY_05_00,
      now: MONDAY_06_00,
      settings: makeSettings({ clockMode: "business_hours" }),
    });
    // 240 min SLA all-ticking in this window → dueAt = started + 240 min.
    // At now=06:00 UTC (1h after start) remaining = 240 - 60 = 180.
    assert(result.remainingMinutes === 180,
      `CASE A: expected remaining 180 (240-60), got ${result.remainingMinutes}`);
    assert(result.breached === false, `CASE A: expected not breached`);
    console.log(`  CASE A OK: business_hours urgent → remaining 180min after 1h, not breached.`);
  }

  // === CASE B — business_hours, urgent, started near end of day, BREACHED ===
  {
    const result = computeSla({
      priority: "urgent",
      startedAt: MONDAY_12_00,
      now: TUESDAY_09_00,
      settings: makeSettings({ clockMode: "business_hours" }),
    });
    // 30 min Monday + 210 min Tuesday → dueAt = Tuesday 07:00 UTC.
    // now = Tuesday 09:00 UTC → BREACHED by 120 minutes.
    assert(result.breached === true,
      `CASE B: expected breached. dueAt=${result.dueAt.toISOString()}, now=${TUESDAY_09_00.toISOString()}`);
    assert(result.remainingMinutes === -120,
      `CASE B: expected remaining -120, got ${result.remainingMinutes}`);
    console.log(`  CASE B OK: split-day SLA BREACHED at Tuesday 09:00 UTC, -120 min remaining.`);
  }

  // === CASE C — always_24_7, urgent, exactly at boundary ===
  {
    const result = computeSla({
      priority: "urgent",
      startedAt: FRIDAY_17_00,
      now: FRIDAY_21_00,
      settings: makeSettings({ clockMode: "always_24_7" }),
    });
    assert(result.breached === false,
      `CASE C: at exact boundary, expected not breached. dueAt=${result.dueAt.toISOString()}`);
    assert(result.remainingMinutes === 0,
      `CASE C: at boundary, expected 0 remaining, got ${result.remainingMinutes}`);
    console.log(`  CASE C OK: always_24_7 urgent, exactly at boundary → 0 remaining.`);
  }

  // === CASE D — always_24_7, breach detected ===
  {
    const result = computeSla({
      priority: "urgent",
      startedAt: FRIDAY_17_00,
      now: FRIDAY_22_00,
      settings: makeSettings({ clockMode: "always_24_7" }),
    });
    assert(result.breached === true, `CASE D: expected breached.`);
    assert(result.remainingMinutes === -60,
      `CASE D: expected -60 remaining, got ${result.remainingMinutes}`);
    console.log(`  CASE D OK: breach detected, -60 remaining.`);
  }

  // === CASE E — mixed mode, urgent on weekend (24/7) ===
  {
    const result = computeSla({
      priority: "urgent",
      startedAt: SATURDAY_10_00,
      now: SATURDAY_14_00,
      settings: makeSettings({ clockMode: "mixed" }),
    });
    assert(result.breached === false,
      `CASE E: urgent on weekend in mixed mode should be 24/7, not breached. dueAt=${result.dueAt.toISOString()}`);
    console.log(`  CASE E OK: mixed-mode urgent runs on weekend.`);
  }

  // === CASE F — mixed mode, high priority on weekend (business hours) ===
  {
    const result = computeSla({
      priority: "high",
      startedAt: SATURDAY_10_00,
      now: SATURDAY_14_00,
      settings: makeSettings({ clockMode: "mixed" }),
    });
    // Clock doesn't tick on Saturday → dueAt pushed to Monday or later.
    assert(result.dueAt.getTime() >= MONDAY_NEXT_03_30.getTime(),
      `CASE F: high priority in mixed mode on weekend should push dueAt to Monday or later. Got ${result.dueAt.toISOString()}`);
    console.log(`  CASE F OK: mixed-mode high on weekend → dueAt pushed into Monday.`);
  }

  console.log("PASS golden-ticket-sla: all 6 cases match the operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
