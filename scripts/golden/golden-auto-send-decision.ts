/**
 * Golden test — decideAutoSend (the wrapper around AutoSendGate).
 *
 * Phase 1.5 / skill v2 — written 2026-07-21 (Batch 5) to pin the operator-
 * confirmed qualification threshold AFTER the operator caught the agent
 * using a made-up 0.7 value. The 0.7 had no operator confirmation; it was
 * a Phase 1.5 violation. This test makes sure that never silently regresses.
 *
 * What this pins:
 *   - `decideAutoSend` computes `leadQualified` from
 *     `lead.reviewStatus === "approved" && lead.confidenceScore >= 0.85`.
 *   - A lead at confidenceScore 0.84 (reviewStatus approved) → NOT qualified.
 *   - A lead at confidenceScore 0.85 (reviewStatus approved) → qualified.
 *   - A lead at confidenceScore 0.78 (reviewStatus approved) → NOT qualified.
 *     (This is the exact Surat-buyer example the operator was asked about.)
 *   - A lead at confidenceScore 0.99 but reviewStatus != "approved" → NOT
 *     qualified (review gate is AND-ed with score, not OR-ed).
 *
 * Why a separate test from golden-auto-send-gate.ts:
 *   golden-auto-send-gate.ts pins `evaluateAutoSendGate` (the 11-condition
 *   gate), which receives `leadQualified` as an already-computed boolean.
 *   It does NOT prove how `leadQualified` is derived from raw lead fields.
 *   This test pins the derivation. Together the two tests cover both the
 *   derivation rule AND the gate — the Golden Thread at the math layer.
 *
 * Hand-computed cases (operator-confirmed 2026-07-21 Batch 5 Q1):
 *   CASE A — confidenceScore 0.84, reviewStatus approved
 *     → 0.84 < 0.85 → leadQualified=false → gate reason mentions "qualif"
 *   CASE B — confidenceScore 0.85, reviewStatus approved
 *     → 0.85 >= 0.85 → leadQualified=true → if all other inputs pass,
 *       gate allows. We assert only that the reason is NOT "qualif".
 *   CASE C — confidenceScore 0.78, reviewStatus approved (the Surat example)
 *     → 0.78 < 0.85 → leadQualified=false → gate reason mentions "qualif".
 *       This is the example the operator was asked about; the answer was
 *       "0.78 does NOT auto-send, goes to review."
 *   CASE D — confidenceScore 0.99, reviewStatus "pending"
 *     → reviewStatus != "approved" → leadQualified=false → "qualif" block.
 *
 * Run: npx tsx scripts/golden/golden-auto-send-decision.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { decideAutoSend } from "@/services/AutoSendDecisionService";
import { createJsonRepos } from "./_helpers/provider";
import type { Lead, Workspace } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// Use a unique workspace + lead id so the real demo JSON is not contaminated.
const TEST_WORKSPACE_ID = `ws_golden_decision_${Date.now()}`;
const TEST_LEAD_ID = `lead_golden_${Date.now()}`;

// A workspace with kill-switch OFF + auto-send toggle ON + an owner number.
// (We want to isolate the qualification decision, so other gate inputs are
// set to "would pass". The qualification check is what we're testing.)
const baseWorkspace: Workspace = {
  id: TEST_WORKSPACE_ID,
  name: "Golden Test Workspace",
  status: "active",
  ownerUserId: "owner1",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  autonomyKillSwitch: false,
  autoSendToggle: true,
  ownerWhatsappNumber: "+919999999999",
};

// Inputs that would otherwise pass the gate.
const passingInput = {
  countryAllowList: ["IN"],
  campaignDailyCap: 20,
  campaignSendsToday: 5,
  liveProviderConfigured: true,
  usesApprovedTemplate: true,
};

// A clean, low-risk draft message (no prices / warranty / delivery / credit).
const cleanDraftMessage = "Hi, we're a textile supplier. May we share our catalogue with you?";

async function main() {
  const repos = createJsonRepos();

  /**
   * Helper: build a Lead with the given confidenceScore + reviewStatus.
   * Other fields set to neutral values. Lead requires several numeric
   * score fields; we set them all to 0 except confidenceScore (the one
   * under test) so the test isolates the qualification decision.
   */
  function makeLead(confidenceScore: number, reviewStatus: Lead["reviewStatus"]): Lead {
    return {
      id: TEST_LEAD_ID,
      workspaceId: TEST_WORKSPACE_ID,
      contactName: "Test Buyer",
      companyName: "Test Co",
      country: "IN",
      // Score fields (all required by the Lead type).
      leadScore: 0,
      fitScore: 0,
      needScore: 0,
      reachabilityScore: 0,
      timingScore: 0,
      confidenceScore,
      // Status fields.
      status: "approved" as Lead["status"],
      enrichmentStatus: "not_started",
      reviewStatus,
      // DNC flag explicitly false (otherwise CASE B would fail at the DNC
      // gate, not at qualification).
      doNotContact: false,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
  }

  // CASE A — 0.84 (just below the bar).
  {
    const result = await decideAutoSend(
      { ...passingInput, workspace: baseWorkspace, lead: makeLead(0.84, "approved"), draftMessage: cleanDraftMessage },
      repos,
    );
    assert(!result.allowed, `CASE A: 0.84 should be blocked, got allowed.`);
    assert(/qualif/i.test(result.reason || ""), `CASE A: expected qualification block, got: ${result.reason}`);
    console.log(`  CASE A OK: confidenceScore 0.84 (below 0.85) → blocked at qualification.`);
  }

  // CASE B — 0.85 (exactly at the bar — boundary).
  {
    const result = await decideAutoSend(
      { ...passingInput, workspace: baseWorkspace, lead: makeLead(0.85, "approved"), draftMessage: cleanDraftMessage },
      repos,
    );
    // At 0.85 the qualification passes. We do NOT assert result.allowed=true
    // because the test runs at real "now" and could land inside IST quiet
    // hours (21:00–09:00) which would block for a different reason. Instead
    // we assert that IF it's blocked, the reason is NOT qualification.
    if (!result.allowed) {
      assert(!/qualif/i.test(result.reason || ""),
        `CASE B: at 0.85 the qualification must PASS. If blocked, reason should be unrelated (quiet hours / cap), got: ${result.reason}`);
    }
    console.log(`  CASE B OK: confidenceScore 0.85 (at bar) → qualification passes.${result.allowed ? " Gate ALLOWED." : ` Blocked for unrelated reason: ${result.reason}`}`);
  }

  // CASE C — 0.78 (the Surat-buyer example the operator was asked about).
  {
    const result = await decideAutoSend(
      { ...passingInput, workspace: baseWorkspace, lead: makeLead(0.78, "approved"), draftMessage: cleanDraftMessage },
      repos,
    );
    assert(!result.allowed, `CASE C: 0.78 Surat buyer should be blocked, got allowed.`);
    assert(/qualif/i.test(result.reason || ""),
      `CASE C: expected qualification block for the 0.78 Surat buyer, got: ${result.reason}`);
    console.log(`  CASE C OK: confidenceScore 0.78 (the Surat-buyer example) → blocked at qualification. The owner reviews manually.`);
  }

  // CASE D — high score 0.99 BUT reviewStatus != "approved" → not qualified.
  {
    const result = await decideAutoSend(
      { ...passingInput, workspace: baseWorkspace, lead: makeLead(0.99, "pending"), draftMessage: cleanDraftMessage },
      repos,
    );
    assert(!result.allowed, `CASE D: high score but unreviewed should be blocked, got allowed.`);
    assert(/qualif/i.test(result.reason || ""),
      `CASE D: expected qualification block (reviewStatus != approved), got: ${result.reason}`);
    console.log(`  CASE D OK: confidenceScore 0.99 but reviewStatus="pending" → blocked at qualification. Review gate is AND-ed with score.`);
  }

  console.log("PASS golden-auto-send-decision: 4 boundary cases pin the 0.85 threshold (Batch 5 Q1).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
