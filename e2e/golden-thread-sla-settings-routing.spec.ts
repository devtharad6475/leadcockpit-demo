/**
 * 2026-07-27 — Golden Thread test: SLA-settings route shadowing (P0 regression pin).
 *
 * ROOT CAUSE THIS TEST PINS:
 *   In `src/app/api/[[...path]]/route.ts`, the literal sub-resource
 *   `match(path, ["tickets", "sla-settings"])` sat BELOW the wildcard
 *   `match(path, ["tickets", ":id"])` in the GET handler. Because `:id` is a
 *   catch-all in `match()`, the URL `tickets/sla-settings` matched `:id` first
 *   → the handler looked up a ticket with id === "sla-settings", got
 *   `undefined`, and `NextResponse.json(undefined)` threw
 *   "Value is not JSON serializable" → HTTP 500 on EVERY Workspace tab load.
 *   The full-ui-sweep caught it as 2 console errors (Ironclad Gate #2 red).
 *
 * THE FIX (two layers, defense in depth):
 *   1. ROUTE ORDER: literal `sla-settings` now sits ABOVE `:id` in the GET
 *      handler (with a comment explaining why — never move it back).
 *   2. CHOKEPOINT: `json()` now coerces `payload === undefined → null` so a
 *      future shadowed route can never crash the Web-Fetch serializer again.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat):
 *   CASE A — `GET /api/tickets/sla-settings` returns HTTP 200 (NOT 500) with a
 *     JSON body that has `clockMode`, `businessDays`, the 4 SLA-minute fields,
 *     and `assignmentMode`. This is the load-bearing assertion: the OLD code
 *     returned 500 here.
 *   CASE B — `businessDays` is a number array containing 1..6 (Mon–Sat). If
 *     the route returned the wrong object (e.g. a ticket), this fails.
 *   CASE C — a real ticket id (from GET /api/tickets) STILL resolves via
 *     `GET /api/tickets/:id` → 200 with that ticket's id. Regression guard:
 *     the fix must not break the `:id` route it was moved above.
 *   CASE D — `GET /api/tickets/sla-settings` must NOT be mistaken for a ticket
 *     lookup: the body must NOT contain `ticketNumber`/`leadId`/`status` (the
 *     shape of a Ticket). Proves the route reached the SLA handler, not :id.
 *
 * Run: npx playwright test golden-thread-sla-settings-routing
 */
import { test, expect } from "@playwright/test";
import { E2E_BASE_URL } from "./helpers/e2e-target";

type SlaSettings = {
  id?: string;
  workspaceId?: string;
  clockMode?: string;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  businessDays?: number[];
  urgentSlaMinutes?: number;
  highSlaMinutes?: number;
  mediumSlaMinutes?: number;
  lowSlaMinutes?: number;
  assignmentMode?: string;
  // Ticket-only fields that MUST be absent (proves we didn't hit the :id route)
  ticketNumber?: unknown;
  leadId?: unknown;
  status?: unknown;
};

type Ticket = { id: string; ticketNumber?: number; leadId?: string; status?: string };

async function apiRaw(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${E2E_BASE_URL}${url}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test.describe("Golden Thread — SLA-settings route shadowing (P0 pin)", () => {
  test("CASE A — GET /api/tickets/sla-settings returns 200 with the SLA shape (was 500)", async () => {
    const { status, body } = await apiRaw("/api/tickets/sla-settings");
    // THE load-bearing assertion. The OLD shadowed route returned 500 here on
    // every Workspace tab load. If this regresses, Ironclad Gate #2 goes red.
    expect(status, "must be 200, not the 500 from json(undefined)").toBe(200);
    const s = body as SlaSettings;
    expect(s.clockMode, "clockMode must be present").toBeTruthy();
    expect(s.assignmentMode, "assignmentMode must be present").toBeTruthy();
    expect(["manual", "auto_rule", "round_robin"], "assignmentMode is one of the 3 modes").toContain(s.assignmentMode);
  });

  test("CASE B — businessDays is a number array containing weekdays 1..6", async () => {
    const { body } = await apiRaw("/api/tickets/sla-settings");
    const s = body as SlaSettings;
    expect(Array.isArray(s.businessDays), "businessDays is an array").toBe(true);
    // Default seed is Mon–Sat = [1,2,3,4,5,6]. Assert the deterministic subset.
    expect(s.businessDays, "includes Mon(1) and Sat(6)").toEqual(expect.arrayContaining([1, 6]));
    // All 4 SLA minute buckets must be positive integers.
    for (const key of ["urgentSlaMinutes", "highSlaMinutes", "mediumSlaMinutes", "lowSlaMinutes"] as const) {
      const v = s[key];
      expect(typeof v, `${key} is a number`).toBe("number");
      expect(Number.isInteger(v as number), `${key} is an integer`).toBe(true);
      expect((v as number) > 0, `${key} > 0`).toBe(true);
    }
  });

  test("CASE C — real ticket id STILL resolves via GET /api/tickets/:id (regression guard)", async () => {
    // The fix MOVED sla-settings above :id. This must not break :id resolution.
    const listRes = await apiRaw("/api/tickets");
    const list = (listRes.body as Ticket[]) || [];
    if (list.length === 0) {
      // Demo seed always has tickets; if none, the test environment is wrong.
      test.skip(true, "No tickets in demo seed — cannot regression-check :id route");
      return;
    }
    const firstId = list[0].id;
    const { status, body } = await apiRaw(`/api/tickets/${firstId}`);
    expect(status, "real ticket id must still 200").toBe(200);
    expect((body as Ticket).id, "the SAME ticket id comes back").toBe(firstId);
  });

  test("CASE D — sla-settings body must NOT have Ticket-only fields (proves it reached the SLA handler, not :id)", async () => {
    // If the :id wildcard ever shadows sla-settings again, the body would be a
    // Ticket (or null). A Ticket has ticketNumber/leadId/status; SLA settings
    // must not. This is the structural proof the right handler ran.
    const { body } = await apiRaw("/api/tickets/sla-settings");
    const s = body as SlaSettings;
    expect(s.ticketNumber, "SLA settings must not carry ticketNumber").toBeUndefined();
    expect(s.leadId, "SLA settings must not carry leadId").toBeUndefined();
    expect(s.status, "SLA settings must not carry a ticket status").toBeUndefined();
  });
});
