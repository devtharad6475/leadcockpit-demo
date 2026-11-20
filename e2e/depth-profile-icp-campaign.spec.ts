/**
 * 2026-07-29 — DEPTH AUDIT: Profile + ICP + Campaign + Discovery — Batch 7.
 *
 * Persistence + Golden Thread proof for business-profile save/approve, ICP
 * generation (deterministic mock), campaign creation (deterministic plan),
 * and manual-lead discovery (+ dashboard totalLeads ripple).
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - POST /api/business-profile → upsert (create-or-update). POST
 *     /api/business-profile/:id/approve → status "approved". Source:
 *     route.ts:1656-1671.
 *   - POST /api/icp/generate → generateICPs. 2026-08-19: this is now a REAL
 *     LLM call. `generateICPs` (agents.ts:193) asks DeepSeek for 3-5 ICPs and
 *     falls back to the deterministic set only when the run was mock mode or
 *     the model returned fewer than 3. Since the platform key was supplied it
 *     takes the real path, so the old assertion — exactly 3 ICPs with the
 *     hand-known scores [0.72, 0.76, 0.82] — was testing the FALLBACK and
 *     failing on the feature working. The deterministic floor is still pinned,
 *     by scripts/golden/golden-icp-generation.ts, which is where a fixed-output
 *     assertion belongs. This spec asserts the CONTRACT that holds either way.
 *     DESTRUCTIVE: replaceForBusinessProfile wipes existing ICPs. Source:
 *     route.ts:1806-1817, agents.ts:112-275.
 *   - POST /api/campaigns (requires profile + ICP) → status "draft",
 *     approvalStatus "needs_review" + deterministic plan. Source:
 *     route.ts:1828-1852, agents.ts:283-301.
 *   - POST /api/leads/manual → new lead (status needs_review) + totalLeads
 *     +1 ripple. Source: route.ts:1865-1875.
 *   - NO agent-instructions save route exists (agentBehaviorPolicies is
 *     read-only over HTTP). The editable surface is /settings/communication
 *     (Batch 3). So no separate agent-instructions test here.
 *   - F-UI-3 check: ALL routes in these areas use the CORRECT path index.
 *
 * Seed (workspace_demo): 1 businessProfile (profile_demo, status approved,
 * companyName "Balaji Zari Udyog"); 3 ICPs (icp_bridal_uae selected, +2
 * suggested); 1 campaign (campaign_bridal_uae, active); 6 leads.
 *
 * Run: npx playwright test depth-profile-icp-campaign --reporter=list
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

function profile(): any {
  return readAppData().businessProfiles.find((p: any) => p.workspaceId === "workspace_demo");
}
function icps(): any[] {
  return readAppData().icps.filter((i: any) => i.workspaceId === "workspace_demo");
}
function campaigns(): any[] {
  return readAppData().campaigns.filter((c: any) => c.workspaceId === "workspace_demo");
}
function leadCount(): number {
  return readAppData().leads.filter((l: any) => l.workspaceId === "workspace_demo").length;
}
async function apiState(): Promise<any> {
  const r = await fetch(`${BASE}/api/state`, { headers: { Cookie: "lc_demo=1" } });
  return r.json();
}
async function api(route: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════════════════════
// BUSINESS PROFILE — save + approve
// ════════════════════════════════════════════════════════════════════════════
test.describe("Profile depth — save + approve", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("PUT business-profile/:id persists field changes", async () => {
    const id = profile().id; // profile_demo
    const NEW_TAGLINE = "Premium zari and ethnic trims since 1998";
    const { status } = await api(`/api/business-profile/${id}`, "PUT", { description: NEW_TAGLINE });
    expect(status).toBeLessThan(400);
    expect(profile().description).toBe(NEW_TAGLINE);
  });

  test("POST business-profile/:id/approve sets status approved", async () => {
    // First move it back to draft via PUT so approve is observable.
    await api(`/api/business-profile/${profile().id}`, "PUT", { status: "draft" });
    expect(profile().status).toBe("draft");
    const { status } = await api(`/api/business-profile/${profile().id}/approve`, "POST", {});
    expect(status).toBeLessThan(400);
    expect(profile().status, "approve must set status approved").toBe("approved");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ICP GENERATE — deterministic 3 ICPs in mock demo mode
// ════════════════════════════════════════════════════════════════════════════
test.describe("ICP depth — generate (deterministic mock)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/icp/generate returns a usable ICP set (3-5, all suggested, scored ≤ 0.9)", async () => {
    // A real model call — allow for it rather than timing out at 30s and
    // reporting a working feature as broken.
    test.setTimeout(120_000);
    const { status, body } = await api("/api/icp/generate", "POST", {});
    expect(status).toBeLessThan(400);
    const generated = Array.isArray(body) ? body : body?.icps || body?.data || [];

    // The contract the route guarantees whichever path it took: the LLM is
    // asked for 3-5, and anything under 3 falls back to the deterministic set
    // of 3 (agents.ts:214). So the count is bounded on both sides.
    expect(generated.length, "3-5 ICPs, whether from the model or the fallback").toBeGreaterThanOrEqual(3);
    expect(generated.length).toBeLessThanOrEqual(5);
    expect(generated.every((i: any) => i.status === "suggested"), "every new ICP starts unselected").toBe(true);

    for (const icp of generated) {
      // normalizeLLMICP drops anything missing these, so a present-but-empty
      // field means the normaliser let something through.
      expect(String(icp.name || "").length, `ICP has a name: ${JSON.stringify(icp.name)}`).toBeGreaterThan(0);
      expect(String(icp.description || "").length).toBeGreaterThan(0);
      expect(String(icp.buyerType || "").length).toBeGreaterThan(0);
      expect(Array.isArray(icp.industries) && icp.industries.length).toBeTruthy();
      // The 0.9 ceiling is clamped in normalizeLLMICP — a model claiming 0.99
      // certainty about an invented customer profile is exactly what it caps.
      expect(icp.confidenceScore, `confidence in [0, 0.9], got ${icp.confidenceScore}`).toBeGreaterThanOrEqual(0);
      expect(icp.confidenceScore).toBeLessThanOrEqual(0.9);
    }
  });

  test("ICP generate is DESTRUCTIVE: replaces existing ICPs for the workspace", async () => {
    test.setTimeout(120_000);
    // Seed has 3 ICPs. After generate, the workspace should still have ICPs
    // but they are the NEW set (replaceForBusinessProfile wipes + reinserts).
    const beforeIds = icps().map((i: any) => i.id).sort();
    expect(beforeIds.length).toBe(3);
    await api("/api/icp/generate", "POST", {});
    const after = icps();
    // 2026-08-19 — was `toBe(3)`, which a REPLACE and an APPEND both satisfy
    // only by accident of the model returning exactly 3. What "destructive"
    // actually means is that none of the old rows survived.
    expect(after.length, "3-5 ICPs after generate").toBeGreaterThanOrEqual(3);
    expect(after.length).toBeLessThanOrEqual(5);
    const survivors = after.map((i: any) => i.id).filter((id: string) => beforeIds.includes(id));
    expect(survivors, "replaceForBusinessProfile wipes the old set — nothing may survive").toEqual([]);
    // The previously-"selected" seed ICP (icp_bridal_uae) is gone — flag as a
    // known destructive behavior (research note), not a bug to fix here.
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CAMPAIGN — create with deterministic plan (requires profile + ICP)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Campaign depth — create (deterministic plan)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/campaigns creates a draft campaign + deterministic plan", async () => {
    const before = campaigns().length;
    const { status, body } = await api("/api/campaigns", "POST", {
      icpId: "icp_bridal_uae",
      name: "Test campaign",
      offer: "Festive catalogue",
    });
    expect(status).toBeLessThan(400);

    const after = campaigns();
    expect(after.length, "a new campaign must be created").toBe(before + 1);
    // Find the new one.
    const created = after.find((c: any) => c.name === "Test campaign");
    expect(created).toBeDefined();
    expect(created.status).toBe("draft");
    expect(created.approvalStatus).toBe("needs_review");
    // Deterministic plan fields.
    expect(created.plan).toBeTruthy();
    expect(created.plan.searchQueries.length, "deterministic plan has ≥3 search queries").toBeGreaterThanOrEqual(3);
    expect(created.plan.outreachSequence.length).toBeGreaterThanOrEqual(3);
    expect(created.plan.messageStrategy).toMatch(/catalogue|permission/i);
  });

  test("POST /api/campaigns requires an ICP (throws if none provided + none selected)", async () => {
    test.setTimeout(120_000);
    // Re-generate ICPs so none is "selected" (generate resets all to suggested),
    // then try to create a campaign WITHOUT an explicit icpId.
    await api("/api/icp/generate", "POST", {});
    expect(icps().every((i) => i.status === "suggested")).toBe(true);
    const { status } = await api("/api/campaigns", "POST", { name: "No ICP campaign" });
    expect(status, "creating a campaign with no ICP must fail").toBeGreaterThanOrEqual(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DISCOVERY — manual lead add (+ dashboard totalLeads ripple)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Discovery depth — manual lead add", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/leads/manual creates a needs_review lead + totalLeads +1 ripple", async () => {
    const RUN = String(Date.now()).slice(-5);
    const leadsBefore = leadCount();
    const stateBefore = await apiState();
    expect(stateBefore.totalLeads).toBe(leadsBefore);

    const COMPANY = "Test Boutique Dubai";
    const { status, body } = await api("/api/leads/manual", "POST", {
      companyName: COMPANY,
      // 2026-09-26: unique per run — adding a lead whose email or phone is
      // already on file is now refused ("You already have this lead").
      email: `owner.${RUN}@testboutique.example`,
      // N-SAFETY-1: unroutable by construction. An Indian mobile never starts
      // its subscriber part with 0, so +91 00000 xxxxx can never be assigned.
      // This lead is written to real app data by the API, so a later send test
      // could pick it up — it must not be able to reach a person.
      phone: `+9100000${RUN}`,
      campaignId: "campaign_bridal_uae",
      icpId: "icp_bridal_uae",
    });
    expect(status).toBeLessThan(400);

    // File: a new lead appended.
    const after = readAppData().leads.filter((l: any) => l.workspaceId === "workspace_demo");
    expect(after.length, "lead count must increase by 1").toBe(leadsBefore + 1);
    const newLead = after.find((l: any) => l.companyName === COMPANY);
    expect(newLead).toBeDefined();
    expect(newLead.status).toBe("needs_review");
    expect(newLead.source).toBe("manual");
    expect(newLead.email).toBe(`owner.${RUN}@testboutique.example`);

    // Dashboard ripple: totalLeads incremented.
    const stateAfter = await apiState();
    expect(stateAfter.totalLeads, "dashboard totalLeads must reflect +1").toBe(leadsBefore + 1);
  });

  test("POST /api/leads/manual rejects an invalid email (zod → 422)", async () => {
    const { status } = await api("/api/leads/manual", "POST", {
      companyName: "Bad email co",
      email: "not-an-email",
    });
    expect(status, "invalid email must be rejected").toBe(422);
  });
});
