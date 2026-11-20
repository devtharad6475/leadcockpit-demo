/**
 * Golden test — Multi-tenant READ scoping (Cluster 1 fix, 2026-07-26 audit).
 *
 * PROVES that READ paths which the prior audit found leaking cross-tenant
 * data are scoped by the session workspace:
 *   - dashboardState(data, workspaceId)  — was hardcoded to defaultWorkspaceId
 *   - scopeDataForExport(data, workspaceId) — was returning ALL workspaces
 *
 * Hand-computed BEFORE writing the fix (the data is constructed in this file):
 *
 *   ws_A: 3 leads (hot, mql, pending-review), 1 reply, 1 campaign, profile A
 *   ws_B: 2 leads (won, do_not_contact), 1 reply, 0 campaigns, profile B
 *
 *   dashboardState(data, "ws_A") must return:
 *     totalLeads = 3   (NOT 5 — ws_B's leads excluded)
 *     hotLeads   = 1
 *     pendingReviews = 1
 *     recentReplies length = 1   (ws_B's reply excluded; was 2 before fix)
 *
 *   dashboardState(data, "ws_B") must return:
 *     totalLeads = 2
 *     recentReplies length = 1
 *
 *   scopeDataForExport(data, "ws_A").leads.length = 3
 *   scopeDataForExport(data, "ws_A").replies.length = 1
 *   scopeDataForExport(data, "ws_B").leads.length = 2
 *
 * Without this test, the P0 multi-tenant hole returns silently: a single-
 * tenant demo masks it because ws_A === defaultWorkspaceId.
 *
 * Run: npx tsx scripts/golden/golden-multi-tenant-scoping.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import type { AppData, Lead, Reply, Campaign, BusinessProfile, Workspace } from "@/lib/types";

// ---------------------------------------------------------------------------
// Build a known 2-workspace dataset.
// ---------------------------------------------------------------------------
function buildTwoWorkspaceData(): AppData {
  const wsA = "ws_A";
  const wsB = "ws_B";

  const workspaces: Workspace[] = [
    { id: wsA, name: "Tenant A", createdAt: "2026-01-01T00:00:00.000Z" } as Workspace,
    { id: wsB, name: "Tenant B", createdAt: "2026-01-01T00:00:00.000Z" } as Workspace,
  ];

  const businessProfiles: BusinessProfile[] = [
    { id: "bp_A", workspaceId: wsA, companyName: "Company A", status: "approved" } as BusinessProfile,
    { id: "bp_B", workspaceId: wsB, companyName: "Company B", status: "approved" } as BusinessProfile,
  ];

  const leads: Lead[] = [
    { id: "l_A1", workspaceId: wsA, status: "hot_lead",   reviewStatus: "approved", contactName: "A1" } as Lead,
    { id: "l_A2", workspaceId: wsA, status: "mql",        reviewStatus: "approved", contactName: "A2" } as Lead,
    { id: "l_A3", workspaceId: wsA, status: "discovered", reviewStatus: "pending",  contactName: "A3" } as Lead,
    { id: "l_B1", workspaceId: wsB, status: "won",        reviewStatus: "approved", contactName: "B1" } as Lead,
    { id: "l_B2", workspaceId: wsB, status: "do_not_contact", reviewStatus: "rejected", contactName: "B2" } as Lead,
  ];

  const replies: Reply[] = [
    { id: "r_A1", workspaceId: wsA, body: "A reply", createdAt: "2026-07-01T00:00:00.000Z" } as unknown as Reply,
    { id: "r_B1", workspaceId: wsB, body: "B reply", createdAt: "2026-07-02T00:00:00.000Z" } as unknown as Reply,
  ];

  const campaigns: Campaign[] = [
    { id: "c_A1", workspaceId: wsA, status: "active", name: "Camp A" } as Campaign,
  ];

  return {
    workspaces,
    businessProfiles,
    leads,
    replies,
    campaigns,
    icps: [],
    messageTemplates: [],
    outreachActivities: [],
    autoReplyLogs: [],
    unknownQuestions: [],
    tickets: [],
    orders: [],
    quotes: [],
    mediaCatalogItems: [],
    auditLogs: [],
    knowledgeBaseDocuments: [],
    productKnowledges: [],
    knowledgeQuestionAnswers: [],
    humanFallbackTasks: [],
    escalationRules: [],
    doNotContactRegistry: [],
    consentRecords: [],
    integrations: [],
    agentRuns: [],
    users: [],
    sessions: [],
    salesSettings: [],
    productSettings: [],
    policySettings: [],
    communicationSettings: [],
    ticketSlaSettings: [],
    pendingSettingsDrafts: [],
    settingsConflicts: [],
    priceChangeNotifications: [],
  } as unknown as AppData;
}

async function main() {
  const data = buildTwoWorkspaceData();

  // Lazy import so the test fails clearly if the symbols don't exist yet.
  const dashboardMod = await import("@/app/api/[[...path]]/route");
  const dashboardState = dashboardMod.dashboardState as (data: AppData, workspaceId: string) => {
    totalLeads: number; hotLeads: number; pendingReviews: number; recentReplies: unknown[];
  };
  assert.equal(typeof dashboardState, "function", "dashboardState must be exported from route.ts");

  // ---------------------------------------------------------------------------
  // CASE A — dashboardState(ws_A) returns ONLY ws_A's data.
  // BEFORE the fix this returned 5 leads / 2 replies (the whole store).
  // ---------------------------------------------------------------------------
  {
    const dashA = dashboardState(data, "ws_A");
    assert.equal(dashA.totalLeads, 3, "CASE A: ws_A totalLeads must be 3, not 5 (cross-tenant leak)");
    assert.equal(dashA.hotLeads, 1, "CASE A: ws_A hotLeads = 1");
    assert.equal(dashA.pendingReviews, 1, "CASE A: ws_A pendingReviews = 1");
    assert.equal(dashA.recentReplies.length, 1, "CASE A: ws_A recentReplies must exclude ws_B's reply");
    console.log("  CASE A OK: dashboardState(ws_A) → 3 leads, 1 hot, 1 pending, 1 reply (ws_B excluded).");
  }

  // ---------------------------------------------------------------------------
  // CASE B — dashboardState(ws_B) returns ONLY ws_B's data.
  // ---------------------------------------------------------------------------
  {
    const dashB = dashboardState(data, "ws_B");
    assert.equal(dashB.totalLeads, 2, "CASE B: ws_B totalLeads = 2");
    assert.equal(dashB.recentReplies.length, 1, "CASE B: ws_B recentReplies = 1 (ws_A's reply excluded)");
    console.log("  CASE B OK: dashboardState(ws_B) → 2 leads, 1 reply (ws_A excluded).");
  }

  // ---------------------------------------------------------------------------
  // CASE C — scopeDataForExport(ws_A) returns ONLY ws_A's collections.
  // ---------------------------------------------------------------------------
  {
    assert.equal(typeof dashboardMod.scopeDataForExport, "function",
      "CASE C: scopeDataForExport must be exported from route.ts");
    const exportA = dashboardMod.scopeDataForExport(data, "ws_A");
    assert.equal(exportA.leads.length, 3, "CASE C: export ws_A leads = 3");
    assert.equal(exportA.replies.length, 1, "CASE C: export ws_A replies = 1");
    assert.equal(exportA.campaigns.length, 1, "CASE C: export ws_A campaigns = 1");
    assert.equal(exportA.businessProfiles.length, 1, "CASE C: export ws_A profiles = 1");
    console.log("  CASE C OK: scopeDataForExport(ws_A) → 3 leads, 1 reply, 1 campaign, 1 profile.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — scopeDataForExport(ws_B) returns ONLY ws_B's collections.
  // ---------------------------------------------------------------------------
  {
    const exportB = dashboardMod.scopeDataForExport(data, "ws_B");
    assert.equal(exportB.leads.length, 2, "CASE D: export ws_B leads = 2");
    assert.equal(exportB.replies.length, 1, "CASE D: export ws_B replies = 1");
    assert.equal(exportB.campaigns.length, 0, "CASE D: export ws_B campaigns = 0");
    console.log("  CASE D OK: scopeDataForExport(ws_B) → 2 leads, 1 reply, 0 campaigns.");
  }

  console.log("\nPASS golden-multi-tenant-scoping: dashboard + export scoped by session workspace (4 cases).");
  console.log("NOTE: route handlers MUST pass the session workspaceId into dashboardState and scopeDataForExport.");
}

main().catch((err) => {
  console.error("\nFAIL golden-multi-tenant-scoping:", err.message);
  process.exit(1);
});
