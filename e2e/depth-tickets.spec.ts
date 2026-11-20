/**
 * 2026-07-29 — DEPTH AUDIT: Customer Tickets — Slice B, Batch 4.
 *
 * Persistence + Golden Thread proof for the customer Ticket lifecycle
 * (Stage-2 customer Ticket, NOT the Stage-5 PlatformTicket). Create → status
 * transitions → SLA settings. Each: trigger via API → read JSON file off disk
 * → assert persisted fields match expectation → ripple checks (events, SLA).
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - POST /api/tickets → initial status "open", SLA clock starts
 *     (slaStartedAt + computed slaDueAt), ticketNumber = max+1. Source:
 *     TicketService.ts:47-186.
 *   - POST /api/tickets/:id/status {toStatus}:
 *       → resolved   sets resolvedAt (if unset)
 *       → closed     sets closedAt   (if unset)
 *       → reopened   clears resolvedAt
 *       → in_progress | waiting_customer sets firstRespondedAt (first time)
 *     NOTE exact status string is "waiting_customer" (NOT waiting_on_customer).
 *     Transitions are UNGUARDED (any→any by design). Source: TicketService.ts:192-224.
 *   - POST /api/tickets/sla-settings (owner-only): clockMode, businessHours*,
 *     businessDays, urgentSlaMinutes/highSlaMinutes/mediumSlaMinutes/
 *     lowSlaMinutes. Does NOT accept assignmentMode. Source: route.ts:2990.
 *   - F-UI-3 check: ticket :id routes use path[1] CORRECTLY (id always at
 *     index 1). No off-by-one here.
 *
 * Seed (workspace_demo): 1 ticket (ticket_demo_1, status "open", priority
 * medium), 1 ticketEvent (created), 1 ticketSlaSettings (urgentSlaMinutes=240,
 * highSlaMinutes=480, mediumSlaMinutes=1440, lowSlaMinutes=10080, business
 * hours 09:00-18:00 Mon-Sat).
 *
 * Run: npx playwright test depth-tickets --reporter=list
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";

import { readAppData } from "./helpers/app-data";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const REPO_ROOT = path.resolve(__dirname, "..");
// 2026-08-19 (N-TEST-5) — was `path.join(REPO_ROOT, ".leadgen-data", "app-data.json")`.
// The suite moved onto its own data directory earlier the same session, so this
// pointed at the PRODUCT file while the server wrote to the suite's file: every
// assertion below read a value the test had never written. See e2e/helpers/data-dir.ts.
const BASE = E2E_BASE_URL;
const HEADERS = { Cookie: "lc_demo=1", "Content-Type": "application/json" };

function findTicket(id: string): any {
  return readAppData().tickets.find((t: any) => t.id === id);
}
function ticketEventsFor(id: string): any[] {
  return readAppData().ticketEvents.filter((e: any) => e.ticketId === id);
}
function slaSettings(): any {
  return readAppData().ticketSlaSettings.find((s: any) => s.workspaceId === "workspace_demo");
}
async function post(route: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════════════════════
// CREATE — initial status open + SLA clock starts + ticketNumber allocated
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tickets depth — Create", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("create ticket persists fields + status open + SLA clock starts + ticketNumber is max+1", async () => {
    const SUBJECT = "Custom border design enquiry";
    const ticketsBefore = readAppData().tickets.filter((t: any) => t.workspaceId === "workspace_demo").length;
    // 2026-08-19 (N-TEST-5) — was hard-coded as 2, with the comment "seed has
    // ticketNumber 1 -> new is 2". Two things were wrong with that. The seed
    // changed and now carries more than one ticket, and ticketNumber is
    // sequential GLOBALLY across workspaces (src/lib/types.ts), so a ticket in
    // any other workspace moves this number too. The rule under test is
    // "max + 1"; that is what the test should compute and assert.
    const highestBefore = readAppData().tickets.reduce(
      (max: number, t: any) => Math.max(max, t.ticketNumber ?? 0),
      0,
    );

    const { status, body } = await post("/api/tickets", {
      leadId: "lead_approved",
      sourceChannel: "manual",
      type: "question",
      priority: "high",
      subject: SUBJECT,
      description: "Customer wants a custom border design for 200 metres.",
    });
    expect(status).toBeLessThan(400);

    const id = body.id;
    const t = findTicket(id);
    expect(t).toBeDefined();
    expect(t.workspaceId).toBe("workspace_demo");
    expect(t.subject).toBe(SUBJECT);
    expect(t.priority).toBe("high");
    expect(t.leadId).toBe("lead_approved");
    // Initial status is ALWAYS "open".
    expect(t.status).toBe("open");
    expect(t.ticketNumber, `ticketNumber must be max+1 = ${highestBefore + 1}`).toBe(highestBefore + 1);
    // SLA clock starts at creation.
    expect(t.slaStartedAt, "SLA clock must start at creation").toBeTruthy();
    expect(t.slaDueAt, "slaDueAt must be computed from priority + SLA settings").toBeTruthy();
    expect(t.slaBreached).toBe(false);

    // Ripple: a "created" event was written.
    const events = ticketEventsFor(id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e: any) => e.eventType === "created")).toBe(true);

    // Total ticket count went up by exactly 1.
    const ticketsAfter = readAppData().tickets.filter((t: any) => t.workspaceId === "workspace_demo").length;
    expect(ticketsAfter).toBe(ticketsBefore + 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STATUS TRANSITIONS — timestamps stamped per transition + events emitted
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tickets depth — Status transitions", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("open → in_progress stamps firstRespondedAt + emits status_changed event", async () => {
    const t0 = findTicket("ticket_demo_1");
    expect(t0.status).toBe("open");
    expect(t0.firstRespondedAt).toBeFalsy();

    const { status } = await post("/api/tickets/ticket_demo_1/status", { toStatus: "in_progress" });
    expect(status).toBeLessThan(400);

    const t = findTicket("ticket_demo_1");
    expect(t.status).toBe("in_progress");
    expect(t.firstRespondedAt, "first transition to in_progress must stamp firstRespondedAt").toBeTruthy();
    // Event ripple.
    const events = ticketEventsFor("ticket_demo_1");
    expect(events.some((e: any) => e.eventType === "status_changed" && e.toStatus === "in_progress")).toBe(true);
  });

  test("→ resolved stamps resolvedAt; → closed stamps closedAt", async () => {
    // Move to resolved.
    let r = await post("/api/tickets/ticket_demo_1/status", { toStatus: "resolved", note: "Customer issue investigated and corrected." });
    expect(r.status).toBeLessThan(400);
    let t = findTicket("ticket_demo_1");
    expect(t.status).toBe("resolved");
    expect(t.resolvedAt, "resolved must stamp resolvedAt").toBeTruthy();

    // Then closed.
    r = await post("/api/tickets/ticket_demo_1/status", { toStatus: "closed", note: "Reviewed the completed issue and closed the case." });
    expect(r.status).toBeLessThan(400);
    t = findTicket("ticket_demo_1");
    expect(t.status).toBe("closed");
    expect(t.closedAt, "closed must stamp closedAt").toBeTruthy();
    // resolvedAt preserved (not cleared by close).
    expect(t.resolvedAt).toBeTruthy();
  });

  test("→ waiting_customer stamps firstRespondedAt (exact status string)", async () => {
    // The exact status string is "waiting_customer" (NOT waiting_on_customer).
    const { status } = await post("/api/tickets/ticket_demo_1/status", { toStatus: "waiting_customer" });
    expect(status).toBeLessThan(400);
    const t = findTicket("ticket_demo_1");
    expect(t.status).toBe("waiting_customer");
    expect(t.firstRespondedAt).toBeTruthy();
  });

  test("resolved → reopened clears resolvedAt", async () => {
    // Resolve first.
    await post("/api/tickets/ticket_demo_1/status", { toStatus: "resolved", note: "Initial customer issue corrected before reopening." });
    expect(findTicket("ticket_demo_1").resolvedAt).toBeTruthy();
    // Then reopen.
    const { status } = await post("/api/tickets/ticket_demo_1/status", { toStatus: "reopened" });
    expect(status).toBeLessThan(400);
    const t = findTicket("ticket_demo_1");
    expect(t.status).toBe("reopened");
    expect(t.resolvedAt, "reopened must clear resolvedAt").toBeFalsy();
    // Event ripple: a "reopened" event.
    const events = ticketEventsFor("ticket_demo_1");
    expect(events.some((e: any) => e.eventType === "reopened")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLA SETTINGS — owner-only save persists the 4 priority SLA minutes
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tickets depth — SLA settings save", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/tickets/sla-settings persists clockMode + 4 priority minutes", async () => {
    const before = slaSettings();
    expect(before.mediumSlaMinutes).toBe(1440); // seed value

    const { status } = await post("/api/tickets/sla-settings", {
      clockMode: "always_24_7",
      urgentSlaMinutes: 120,
      highSlaMinutes: 360,
      mediumSlaMinutes: 720,
      lowSlaMinutes: 4320,
    });
    expect(status).toBeLessThan(400);

    const after = slaSettings();
    expect(after.clockMode).toBe("always_24_7");
    expect(after.urgentSlaMinutes).toBe(120);
    expect(after.highSlaMinutes).toBe(360);
    expect(after.mediumSlaMinutes).toBe(720);
    expect(after.lowSlaMinutes).toBe(4320);
  });

  test("SLA settings: business-hours validation rejects malformed time (→ 422 or 400)", async () => {
    // "25:00" is not a valid HH:MM 24h time.
    const { status } = await post("/api/tickets/sla-settings", {
      clockMode: "business_hours",
      businessHoursStart: "25:00",
      businessHoursEnd: "18:00",
      businessDays: [1, 2, 3],
      mediumSlaMinutes: 1440,
    });
    expect(status, "malformed business-hours must be rejected").toBeGreaterThanOrEqual(400);
  });
});
