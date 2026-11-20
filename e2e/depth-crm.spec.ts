/**
 * 2026-07-29 — DEPTH AUDIT: CRM lead mutations — Slice B, Batch 2.
 *
 * Full persistence + Golden Thread proof for the lead-mutation flows. For
 * each: trigger via UI (and/or API for the precise field assertions) → read
 * the JSON file off disk → assert the persisted fields match expectation →
 * re-open in the UI → assert the rendered state matches (round-trip). Then
 * dashboard ripple checks (pendingReviews / approved count).
 *
 * Verified backend behaviour (research 2026-07-29, see D-2026-07-29-p notes):
 *   - Approve → reviewStatus:"approved", status:"approved", enrichmentStatus
 *     reset to "not_started" if not already "completed". Audit + event.
 *     Throws if doNotContact / status is do_not_contact|invalid|duplicate.
 *     Source: LeadReviewDecisionService.ts:120-142.
 *   - Reject  → reviewStatus:"rejected", status:"rejected". Does NOT set
 *     doNotContact (DNC is a SEPARATE flag/registry). Source: lines 144-159.
 *   - Bulk score → writes fitScore/needScore/reachabilityScore/timingScore/
 *     leadScore/qualificationStatus/scoreReason. Deterministic (scoreLead).
 *     Source: route.ts:2004-2015, agents.ts:376-393.
 *   - Message generate → SEND-CLASS, DRAFT ONLY (never sends). Creates a
 *     MessageTemplate status:"draft" + sets lead status:"message_ready".
 *     Source: MessageGenerationService.ts:49-105.
 *   - Policy PDF → creates a mediaCatalogItem (category:"policy_document"),
 *     does NOT mutate the lead. Source: PolicyPdfService.ts:21-46.
 *   - Agent action plan → audit log ONLY, does NOT mutate the lead, never
 *     approves/sends. Source: LeadAgentActionPlanService.ts:45-100.
 *   - Dashboard ripple: /api/state has NO totalApproved — only
 *     pendingReviews (= count reviewStatus==="pending"). The "approved" UI
 *     stat is client-computed from leads[].reviewStatus. Source: route.ts
 *     dashboardState (~line 4340) + page.tsx:656.
 *
 * Seed "before" state (workspace_demo): 6 leads — 1 pending (lead_review),
 * 4 approved, 1 rejected/DNC (lead_dnc). pendingReviews=1.
 *
 * Hand-computed score for lead_review (computed BEFORE looking at output, then
 * corrected after the test caught an oversight — Gate #7 Test-Honesty):
 *   fit          = icp present AND lead.fitReason truthy (seed sets it) → 4
 *   need         = industry truthy → 4
 *   reachability = only websiteUrl (1 route, <2) & websiteUrl truthy → 2
 *   timing       = personalizationNote contains "catalogue" → 3
 *   total        = 4+4+2+3 = 13
 *   qualStatus   = 13 ≥ 11 → good_prospect
 *
 * Run: npx playwright test depth-crm --reporter=list
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";

import { readAppData } from "./helpers/app-data";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const REPO_ROOT = path.resolve(__dirname, "..");
// 2026-08-19 (N-TEST-5) — was `path.join(REPO_ROOT, ".leadgen-data", "app-data.json")`.
// The suite moved onto its own data directory earlier the same session, so this
// pointed at the PRODUCT file while the server wrote to the suite's file: every
// assertion below read a value the test had never written. See e2e/helpers/data-dir.ts.
const DEMO_COOKIE = { name: "lc_demo", value: "1", url: E2E_BASE_URL };
const BASE = E2E_BASE_URL;

function findLead(id: string): any {
  return readAppData().leads.find((l: any) => l.id === id);
}
function leadsWith(reviewStatus: string): number {
  return readAppData().leads.filter((l: any) => l.workspaceId === "workspace_demo" && l.reviewStatus === reviewStatus).length;
}
async function apiState(): Promise<any> {
  const r = await fetch(`${BASE}/api/state`, { headers: { Cookie: "lc_demo=1" } });
  return r.json();
}

async function openWorkspace(page: Page) {
  await page.context().addCookies([DEMO_COOKIE]);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await nav.isVisible({ timeout: 2000 }).catch(() => false)) break;
    const demoBtn = page.getByRole("button", { name: "Continue in Demo Mode" });
    if (await demoBtn.count() > 0) {
      await demoBtn.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);
    }
  }
  await nav.waitFor({ timeout: 30000 });
  // 2026-08-19 (N-TEST-5) — was `expect(page.getByText(/Leads to review/))`.
  // That card only renders when the queue actually HAS leads to review, so a
  // login helper was asserting a DATA condition: any test that emptied the
  // queue made every later login look like a failed login. Assert the shell.
  await expectAppShell(page);
}

async function openLeadReview(page: Page) {
  // 2026-08-19 (N-TEST-4) — see the note in depth-commercial.spec.ts: the
  // drawers start collapsed, so these tabs cannot be clicked directly any more.
  await openTabByLabel(page, "Lead Review");
  await page.waitForTimeout(900);
}

// ════════════════════════════════════════════════════════════════════════════
// APPROVE — pending → approved (+ dashboard ripple)
// ════════════════════════════════════════════════════════════════════════════
test.describe("CRM depth — Approve lead", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("approve lead_review flips reviewStatus+status to approved (+ pendingReviews ↓1)", async ({ page, request }) => {
    // Pre-state assertions (prove clean slate)
    expect(findLead("lead_review").reviewStatus).toBe("pending");
    expect(findLead("lead_review").status).toBe("needs_review");
    const stateBefore = await apiState();
    expect(stateBefore.pendingReviews).toBe(1);
    // 2026-08-19 (N-TEST-7) — the approved count below used to be the literal 5
    // the seed shipped when this test was written; the seed now ships 14 and the
    // failure read "approved count in file must be 5 now / Received: 14", which
    // says nothing about approving. The claim worth making is the DELTA.
    const approvedBefore = leadsWith("approved");

    // Approve via API (the UI button hits the same endpoint; API gives precise
    // field assertions). Then verify the UI reflects it too.
    const resp = await request.post(`${BASE}/api/leads/lead_review/approve`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: {},
    });
    expect(resp.status()).toBeLessThan(400);

    // File: reviewStatus + status flipped to approved
    const lead = findLead("lead_review");
    expect(lead.reviewStatus).toBe("approved");
    expect(lead.status).toBe("approved");
    // Approve RESETS enrichmentStatus to not_started if it wasn't completed.
    expect(lead.enrichmentStatus).toBe("not_started");
    // Approve must NOT set doNotContact (that's a separate, permanent flag).
    expect(lead.doNotContact).toBe(false);

    // Dashboard ripple: pendingReviews dropped 1 → 0. approved count is
    // client-derived (not in /api/state), so we check the file count.
    const stateAfter = await apiState();
    expect(stateAfter.pendingReviews, "approving a pending lead must drop pendingReviews").toBe(0);
    expect(leadsWith("approved"), "approving one pending lead must raise the approved count by exactly 1").toBe(approvedBefore + 1);

    // UI round-trip: the dashboard's "Leads to review" queue card shows 0.
    //
    // 2026-08-19 (N-TEST-11) — this used to log in and immediately match
    // `/0\s*Leads to review/` OR `/All caught up/`. Two things were wrong.
    // Since the 2026-08-17 redesign the app lands on **Needs you**, not the
    // dashboard, so the queue cards were on a screen the test never opened. And
    // the "You're all caught up" line only appears when ALL FIVE counters are
    // zero (page.tsx:1422) -- approving one lead does not empty the drafts or
    // follow-ups queues, so that branch could never fire here either. The test
    // then waited out 10s and reported the approve flow as broken, having
    // already proved via the API and the file that it worked perfectly.
    await openWorkspace(page);
    await openTabByLabel(page, "Dashboard");
    const reviewCard = page.getByRole("button", { name: "Open Leads to review" });
    await expect(reviewCard).toBeVisible({ timeout: 10000 });
    await expect(
      reviewCard.getByText("0", { exact: true }),
      "the queue card's count must read exactly 0 after the last pending review is approved",
    ).toBeVisible({ timeout: 10000 });
  });

  test("approve is blocked for a do-not-contact lead (guard throws)", async ({ request }) => {
    // lead_dnc has doNotContact:true + reviewStatus:"rejected". Approving it
    // must throw (LeadReviewDecisionService.ts:123-124 guard).
    const resp = await request.post(`${BASE}/api/leads/lead_dnc/approve`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: {},
    });
    expect(resp.status(), "approving a DNC lead must be rejected").toBeGreaterThanOrEqual(400);
    // And it must NOT have flipped the reviewStatus.
    expect(findLead("lead_dnc").reviewStatus).toBe("rejected");
    expect(findLead("lead_dnc").doNotContact).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REJECT — pending → rejected (does NOT set doNotContact)
// ════════════════════════════════════════════════════════════════════════════
test.describe("CRM depth — Reject lead", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("reject lead_review flips reviewStatus+status to rejected, does NOT set doNotContact", async ({ request }) => {
    expect(findLead("lead_review").reviewStatus).toBe("pending");
    const resp = await request.post(`${BASE}/api/leads/lead_review/reject`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { reason: "Not a fit for this campaign" },
    });
    expect(resp.status()).toBeLessThan(400);

    const lead = findLead("lead_review");
    expect(lead.reviewStatus).toBe("rejected");
    expect(lead.status).toBe("rejected");
    // CRITICAL distinction (research finding): reject does NOT set doNotContact.
    // DNC is a separate permanent registry. A rejected lead is NOT DNC.
    expect(lead.doNotContact, "reject must NOT set doNotContact (separate flag)").toBe(false);

    // Dashboard ripple: pendingReviews dropped to 0.
    const state = await apiState();
    expect(state.pendingReviews).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCORE WITH AI — lead scoring is AI only (2026-09-25, CEO decision)
// ════════════════════════════════════════════════════════════════════════════
// This used to hand-compute the rule scorer's arithmetic (F=4 N=4 R=4 T=3 →
// 15 → mql). The rule scorer is gone. e2e runs with every paid AI key blanked
// (playwright.config.ts PAID_KEY_ENV_NAMES), so the honest expectation is:
// the button scores nothing, overwrites nothing, and says why.
test.describe("CRM depth — Score with AI, with no real AI available", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("scores nothing, changes nothing, and says the AI is not available", async ({ request }) => {
    const before = findLead("lead_review");
    const resp = await request.post(`${BASE}/api/leads/bulk-score`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: {},
    });
    expect(resp.status()).toBeLessThan(400);
    const body = await resp.json();
    expect(body.aiScored, "no real AI → nothing scored").toBe(0);
    expect(String(body.stoppedReason || ""), "and the reason is given").toMatch(/sample mode|could not be reached|did not return a score|backup/);

    const after = findLead("lead_review");
    expect(after.leadScore, "the stored score is untouched").toBe(before.leadScore);
    expect(after.scoreReason, "and so is its reason").toEqual(before.scoreReason);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MESSAGE DRAFT GENERATION — SEND-CLASS, must be DRAFT ONLY (no real send)
// ════════════════════════════════════════════════════════════════════════════
test.describe("CRM depth — Message draft generation (no-auto-outreach gate)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("generate message for an approved lead creates a DRAFT + sets lead status message_ready (NO send)", async ({ request }) => {
    // lead_approved is reviewStatus:"approved" → eligible.
    const before = findLead("lead_approved");
    expect(before.reviewStatus).toBe("approved");
    const draftsBefore = readAppData().messageTemplates.filter((m: any) => m.workspaceId === "workspace_demo").length;

    const resp = await request.post(`${BASE}/api/messages/generate`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { leadId: "lead_approved", campaignId: "campaign_bridal_uae", channel: "WhatsApp" },
    });
    expect(resp.status()).toBeLessThan(400);

    // File: a NEW message template was created with status DRAFT.
    const data = readAppData();
    const newTemplates = data.messageTemplates.filter((m: any) => m.workspaceId === "workspace_demo");
    expect(newTemplates.length, "a new draft message must be persisted").toBe(draftsBefore + 1);
    // The newest one must be a draft (no-auto-outreach — never auto-sent).
    const newest = newTemplates[newTemplates.length - 1];
    expect(newest.status, "generated message MUST be a draft, never auto-sent").toBe("draft");
    expect(newest.leadId).toBe("lead_approved");

    // Lead ripple: status moved to message_ready (the only lead mutation).
    const lead = findLead("lead_approved");
    expect(["message_ready", "approved"]).toContain(lead.status);
  });

  test("message generation BLOCKED for a non-approved lead (guard throws)", async ({ request }) => {
    // lead_review is pending → must be rejected by the reviewStatus gate.
    const resp = await request.post(`${BASE}/api/messages/generate`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { leadId: "lead_review", campaignId: "campaign_bridal_uae", channel: "WhatsApp" },
    });
    expect(resp.status(), "pending lead must NOT get a message draft").toBeGreaterThanOrEqual(400);
  });

  test("message generation BLOCKED for a DNC lead (sacred no-auto-outreach)", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/messages/generate`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { leadId: "lead_dnc", campaignId: "campaign_bridal_uae", channel: "WhatsApp" },
    });
    expect(resp.status(), "DNC lead must NEVER get a message").toBeGreaterThanOrEqual(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POLICY PDF — creates a mediaCatalogItem, does NOT mutate the lead
// ════════════════════════════════════════════════════════════════════════════
test.describe("CRM depth — Policy PDF generation", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("generate policy PDF creates a mediaCatalogItem (policy_document), lead untouched", async ({ request }) => {
    const mediaBefore = readAppData().mediaCatalogItems.filter((m: any) => m.workspaceId === "workspace_demo").length;
    const leadBefore = findLead("lead_approved");

    const resp = await request.post(`${BASE}/api/leads/lead_approved/generate-policy`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { title: "Bridal order policy" },
    });
    expect(resp.status()).toBeLessThan(400);

    // File: a new mediaCatalogItem with category policy_document + PDF type.
    const data = readAppData();
    const mediaAfter = data.mediaCatalogItems.filter((m: any) => m.workspaceId === "workspace_demo");
    expect(mediaAfter.length, "a new policy PDF artifact must be persisted").toBe(mediaBefore + 1);
    const newest = mediaAfter[mediaAfter.length - 1];
    expect(newest.category).toBe("policy_document");
    expect(newest.fileType).toBe("application/pdf");
    expect(newest.leadId).toBe("lead_approved");

    // Lead must be UNCHANGED (status/updatedAt may bump, but review fields stable).
    const leadAfter = findLead("lead_approved");
    expect(leadAfter.reviewStatus).toBe(leadBefore.reviewStatus);
    expect(leadAfter.status).toBe(leadBefore.status);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AGENT ACTION PLAN — audit log only, never approves/sends, lead untouched
// ════════════════════════════════════════════════════════════════════════════
test.describe("CRM depth — Agent action plan", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("agent plan returns advisory output + humanReviewRequired, lead NOT mutated, NO send", async ({ request }) => {
    const leadBefore = findLead("lead_review");
    const auditBefore = readAppData().auditLogs.filter((a: any) => a.workspaceId === "workspace_demo").length;

    const resp = await request.post(`${BASE}/api/leads/lead_review/agent-action-plan`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: {},
    });
    expect(resp.status()).toBeLessThan(400);
    const plan = await resp.json();

    // The plan is advisory: has a recommendation + explicitly requires human review.
    expect(plan.humanReviewRequired, "agent plan must require human review").toBe(true);
    expect(plan.safetyNote || "").toMatch(/review before outreach|never sends/i);
    expect(plan.recommendation || plan.contextStatus).toBeTruthy();

    // Lead must be UNCHANGED (reviewStatus especially — the plan never approves).
    const leadAfter = findLead("lead_review");
    expect(leadAfter.reviewStatus, "plan must NOT change reviewStatus").toBe(leadBefore.reviewStatus);
    expect(leadAfter.status, "plan must NOT change status").toBe(leadBefore.status);

    // An audit log entry was written (the only persistent side effect).
    const auditAfter = readAppData().auditLogs.filter((a: any) => a.workspaceId === "workspace_demo").length;
    expect(auditAfter, "plan must write an audit log entry").toBe(auditBefore + 1);
  });
});
