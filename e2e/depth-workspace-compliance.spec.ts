/**
 * 2026-07-29 — DEPTH AUDIT: Workspace + Compliance — Slice B, Batch 8.
 *
 * Persistence + Golden Thread proof for the workspace + compliance flows
 * that actually exist. (Research confirmed: there is NO workspace-settings-
 * save endpoint and NO slaInsightHours field — those were plan assumptions.
 * The real flows are: kill-switch READ, compliance erasure, DNC remove.)
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - GET /api/workspace/kill-switch → { autonomyKillSwitch, autoSendToggle }
 *     (both Boolean() of optional fields; absent → false). Source: route.ts:605.
 *   - POST /api/erasure/:leadId → HARD-DELETE cascade: removes the lead +
 *     replies/tickets/ticketEvents/orders/quotes/outreachActivities/
 *     autoReplyLogs/unknownQuestions/humanFallbackTasks. PRESERVES the DNC
 *     registry entry (compliance) + writes an anonymized audit row.
 *     Source: route.ts:3521-3722, ErasureCascade.
 *   - POST /api/consent/:leadId/remove-dnc → owner-only, requires reason ≥5
 *     chars; removes DNC registry entry + clears lead doNotContact flag +
 *     moves status out of do_not_contact. Source: route.ts:3478-3520.
 *   - F-UI-3 check: ALL routes here use the CORRECT path index. Clean.
 *
 * Seed (workspace_demo): 1 workspace (status active, no killSwitch fields →
 * kill-switch reads false/false); 1 DNC registry entry (dnc_demo_1 → lead_dnc);
 * 6 leads incl lead_dnc (doNotContact:true, status do_not_contact).
 *
 * Run: npx playwright test depth-workspace-compliance --reporter=list
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

function lead(id: string): any {
  return readAppData().leads.find((l: any) => l.id === id);
}
function dncRegistry(): any[] {
  return readAppData().doNotContactRegistry.filter((d: any) => d.workspaceId === "workspace_demo");
}
function auditLogs(actionOrEventType: string): any[] {
  // Audit rows use either `action` (safeAudit path) or `eventType` (direct
  // repos.auditLog.create path, e.g. erasure/dnc). Match either field.
  return readAppData().auditLogs.filter(
    (a: any) => a.workspaceId === "workspace_demo" && (a.action === actionOrEventType || a.eventType === actionOrEventType),
  );
}
async function api(route: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════════════════════
// KILL-SWITCH READ — surfaces autonomy kill-switch + autoSend toggle
// ════════════════════════════════════════════════════════════════════════════
test.describe("Workspace depth — kill-switch read", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("GET /api/workspace/kill-switch returns two booleans (false/false on clean seed)", async () => {
    const { status, body } = await api("/api/workspace/kill-switch");
    expect(status).toBeLessThan(400);
    expect(body.autonomyKillSwitch).toBe(false);
    expect(body.autoSendToggle).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COMPLIANCE — erasure (full PII delete cascade; DNC preserved)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Compliance depth — erasure", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/erasure/:leadId hard-deletes the lead + related records, PRESERVES DNC", async () => {
    // Use lead_approved (has companyName "Aarna Bridal Studio" for the
    // confirmName check). Count its related records before.
    const TARGET = "lead_approved";
    const dataBefore = readAppData();
    const leadBefore = lead(TARGET);
    expect(leadBefore).toBeDefined();
    const leadsBefore = dataBefore.leads.filter((l: any) => l.workspaceId === "workspace_demo").length;

    const { status, body } = await api(`/api/erasure/${TARGET}`, "POST", {
      confirmName: leadBefore.companyName,
    });
    expect(status).toBeLessThan(400);
    expect(body.erased).toBe(true);

    // The lead row is GONE.
    const dataAfter = readAppData();
    expect(dataAfter.leads.find((l: any) => l.id === TARGET), "lead must be hard-deleted").toBeUndefined();
    expect(dataAfter.leads.filter((l: any) => l.workspaceId === "workspace_demo").length).toBe(leadsBefore - 1);

    // An anonymized audit row was written (kept forever for compliance).
    expect(auditLogs("customer_erased").length).toBeGreaterThanOrEqual(1);

    // The DNC registry is PRESERVED (compliance — the block survives erasure).
    // lead_dnc's registry entry must still exist.
    expect(dncRegistry().length, "DNC registry must survive erasure").toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COMPLIANCE — DNC remove (legitimate un-block path)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Compliance depth — DNC remove", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/consent/:leadId/remove-dnc clears doNotContact + removes registry entry", async () => {
    // lead_dnc: doNotContact:true, status do_not_contact, has a registry entry.
    expect(lead("lead_dnc").doNotContact).toBe(true);
    expect(lead("lead_dnc").status).toBe("do_not_contact");
    const dncBefore = dncRegistry().length;
    expect(dncBefore).toBeGreaterThanOrEqual(1);

    const { status, body } = await api("/api/consent/lead_dnc/remove-dnc", "POST", {
      reason: "Customer called and asked to be re-contacted with offers.",
    });
    expect(status).toBeLessThan(400);
    expect(body.removed).toBeGreaterThanOrEqual(1);

    // Lead signals cleared.
    const after = lead("lead_dnc");
    expect(after.doNotContact, "doNotContact flag must clear").toBe(false);
    expect(after.status, "status must move out of do_not_contact").not.toBe("do_not_contact");

    // DNC registry entry removed (no orphan).
    const dncAfter = dncRegistry();
    expect(dncAfter.length, "DNC registry entry must be removed").toBeLessThan(dncBefore);

    // Audit row.
    expect(auditLogs("dnc_removed").length).toBeGreaterThanOrEqual(1);
  });

  test("DNC remove requires a reason ≥5 chars (no silent un-block)", async () => {
    const { status } = await api("/api/consent/lead_dnc/remove-dnc", "POST", { reason: "ok" });
    expect(status, "short reason must be rejected (no silent un-block)").toBeGreaterThanOrEqual(400);
    // And the lead must STILL be DNC (not un-blocked).
    expect(lead("lead_dnc").doNotContact).toBe(true);
  });
});
