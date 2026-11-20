/**
 * Golden test — lead-review auto-approve math (O6, O7, maxAutoApprovedPerDay).
 *
 * M3.1 / O6+O7 audit fix. The auto-approval math was too generous and ignored
 * three settings it was supposed to enforce:
 *
 *   - Every matched signal added +0.08 unconditionally. A demo prospect with
 *     base confidence 0.58 + a name + a website + a campaign + an ICP = 0.90,
 *     auto-approving past the 0.85 bar just for existing.
 *   - `requireHumanForNewCampaigns` / `requireHumanForNewIndustries` were
 *     stored but never consulted.
 *   - `maxAutoApprovedPerDay` was stored but never decremented.
 *
 * Hand-computed expected values (BEFORE writing the fix):
 *
 *   CASE A — "nothing-special demo lead":
 *     Lead: confidenceScore=0.58, has companyName + websiteUrl + fitReason,
 *           attached to a campaign.
 *     Old math: 0.58 + 5*0.08 = 0.98 → capped to 0.95 → AUTO-APPROVE (wrong).
 *     Expected: stays in `needs_review`. A 0.58 lead with only "lead exists"
 *               signals should not auto-approve. After the fix, weak signals
 *               (has a name, has a campaign) add less; only strong signals
 *               (matches ICP explicitly, has market-map support) add real
 *               weight, and the total bonus is capped at +0.20.
 *
 *   CASE B — "high-confidence but new campaign":
 *     Lead: confidenceScore=0.92, no risk signals, attached to a NEW campaign
 *           (no other approved leads in it), settings.requireHumanForNewCampaigns=true.
 *     Old behavior: AUTO-APPROVE (the setting was ignored).
 *     Expected: `needs_review` because requireHumanForNewCampaigns=true and
 *               the campaign has 0 prior approved leads.
 *
 *   CASE C — "high-confidence, existing campaign, known industry":
 *     Lead: confidenceScore=0.92, no risk signals, attached to a campaign
 *           that already has approved leads, industry matches existing
 *           approved leads' industries.
 *     Expected: AUTO-APPROVE (this is the legitimate case).
 *
 *   CASE D — "daily cap met":
 *     Lead: confidenceScore=0.92 (would normally auto-approve), but the
 *           workspace has already hit maxAutoApprovedPerDay=25 today.
 *     Expected: NOT auto-approved — downgraded to needs_review with a reason.
 *
 *   CASE E — "DNC lead never auto-approves regardless of math":
 *     Lead: doNotContact=true.
 *     Expected: reject path, never approve. (Sanity check — already enforced.)
 *
 * The first run on unfixed code FAILS on cases A and B (and C is over-permissive
 * only by accident). Fix M3.2 then re-run until green.
 *
 * Run: npx tsx scripts/golden/golden-lead-review-math.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { decideLeadForTest, isAutoApprovalCandidateForTest } from "@/services/LeadReviewDecisionService";
import type { Lead, LeadReviewSettings, Campaign, ICP } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const baseSettings: LeadReviewSettings = {
  id: "lr_test",
  workspaceId: "workspace_demo",
  mode: "high_confidence_auto_approval",
  autoApproveThreshold: 0.85,
  autoRejectThreshold: 0.25,
  maxAutoApprovedPerDay: 25,
  requireHumanForNewCampaigns: true,
  requireHumanForNewIndustries: true,
  allowAutoEnrichment: false,
  allowAutoOutreachPreparation: true,
  allowAutoSend: false,
  auditEveryDecision: true,
  createdAt: "2026-07-19T00:00:00Z",
  updatedAt: "2026-07-19T00:00:00Z",
};

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead_test",
    workspaceId: "workspace_demo",
    companyName: "TestCo",
    contactName: "Test",
    source: "test",
    buyerType: "B2B buyer",
    industry: "Textiles",
    companySizeBucket: "small company",
    fitReason: "ICP fit",
    relevancyReason: "test",
    personalizationNote: "",
    leadScore: 50,
    fitScore: 10,
    needScore: 10,
    reachabilityScore: 10,
    timingScore: 10,
    confidenceScore: 0.5,
    qualificationStatus: "unqualified",
    scoreReason: {},
    status: "needs_review",
    reviewStatus: "pending",
    enrichmentStatus: "not_started",
    doNotContact: false,
    consentStatus: "unknown",
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
    ...overrides,
  } as Lead;
}

const existingCampaign: Campaign = {
  id: "camp_existing",
  workspaceId: "workspace_demo",
  name: "Existing Campaign",
  status: "active",
  approvalStatus: "approved",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
} as Campaign;

const newCampaign: Campaign = {
  id: "camp_new",
  workspaceId: "workspace_demo",
  name: "Brand New Campaign",
  status: "active",
  approvalStatus: "approved",
  createdAt: "2026-07-19T00:00:00Z",
  updatedAt: "2026-07-19T00:00:00Z",
} as Campaign;

const matchingIcp: ICP = {
  id: "icp_test",
  workspaceId: "workspace_demo",
  name: "Textile Buyers",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
} as ICP;

async function main() {
  // === CASE A — "nothing-special demo lead" ===
  // Hand-computed: 0.58 base + only weak signals. Should NOT reach 0.85.
  {
    const lead = makeLead({
      confidenceScore: 0.58,
      websiteUrl: "https://testco.example.com",
      fitReason: "Generic fit",
      campaignId: "camp_existing",
    });
    const result = decideLeadForTest(lead, baseSettings, existingCampaign, undefined, false, {
      campaignIsNew: false,
      industryIsNew: false,
      autoApprovesToday: 0,
    });
    assert(result.decision === "needs_review",
      `CASE A: 0.58 lead with weak signals should stay in needs_review, got ${result.decision} (confidence ${result.confidenceScore}).`);
    assert(Math.abs(result.confidenceScore - 0.71) < 1e-9,
      `CASE A: confidence must be 0.58 base + fitReason 0.04 + public profile 0.04 + company name 0.02 + attached-to-campaign 0.03 = 0.71, got ${result.confidenceScore}.`);
    assert(result.confidenceScore < baseSettings.autoApproveThreshold,
      `CASE A: confidence ${result.confidenceScore} must stay below auto-approve threshold ${baseSettings.autoApproveThreshold}.`);
    assert(result.riskSignals.length === 0,
      `CASE A: an ordinary lead must carry no risk signals, got ${JSON.stringify(result.riskSignals)}.`);
    console.log(`  CASE A OK: 0.58 lead → ${result.decision} (confidence ${result.confidenceScore}).`);
  }

  // === CASE B — "high-confidence but new campaign" ===
  // requireHumanForNewCampaigns=true must override auto-approve.
  {
    const lead = makeLead({
      confidenceScore: 0.92,
      campaignId: "camp_new",
    });
    const result = decideLeadForTest(lead, baseSettings, newCampaign, matchingIcp, true, {
      campaignIsNew: true,
      industryIsNew: false,
      autoApprovesToday: 0,
    });
    assert(!isAutoApprovalCandidateForTest(result, baseSettings, { campaignIsNew: true, industryIsNew: false, autoApprovesToday: 0 }),
      "CASE B: requireHumanForNewCampaigns=true must prevent auto-approval for a new campaign.");
    console.log(`  CASE B OK: high-confidence lead in NEW campaign not auto-approved.`);
  }

  // === CASE C — "high-confidence, existing campaign, known industry" ===
  // The legitimate auto-approve case.
  {
    const lead = makeLead({
      confidenceScore: 0.92,
      campaignId: "camp_existing",
    });
    const result = decideLeadForTest(lead, baseSettings, existingCampaign, matchingIcp, true, {
      campaignIsNew: false,
      industryIsNew: false,
      autoApprovesToday: 0,
    });
    assert(isAutoApprovalCandidateForTest(result, baseSettings, { campaignIsNew: false, industryIsNew: false, autoApprovesToday: 0 }),
      `CASE C: high-confidence lead in existing campaign + known industry should be auto-approval candidate. Got decision=${result.decision}, confidence=${result.confidenceScore}.`);
    console.log(`  CASE C OK: high-confidence lead in existing campaign → auto-approval candidate.`);
  }

  // === CASE D — "daily cap met" ===
  // Even an otherwise-approvable lead is downgraded when the cap is hit.
  {
    const lead = makeLead({
      confidenceScore: 0.92,
      campaignId: "camp_existing",
    });
    const result = decideLeadForTest(lead, baseSettings, existingCampaign, matchingIcp, true, {
      campaignIsNew: false,
      industryIsNew: false,
      autoApprovesToday: 25, // cap met
    });
    assert(!isAutoApprovalCandidateForTest(result, baseSettings, { campaignIsNew: false, industryIsNew: false, autoApprovesToday: 25 }),
      "CASE D: maxAutoApprovedPerDay cap met must prevent auto-approval.");
    console.log(`  CASE D OK: daily-cap-met lead not auto-approved.`);
  }

  // === CASE E — "DNC never approves" ===
  {
    const lead = makeLead({
      doNotContact: true,
      status: "do_not_contact",
      confidenceScore: 0.99,
    });
    const result = decideLeadForTest(lead, baseSettings, undefined, undefined, false, {
      campaignIsNew: false,
      industryIsNew: false,
      autoApprovesToday: 0,
    });
    assert(result.decision === "reject",
      `CASE E: DNC lead must be rejected, got ${result.decision}.`);
    console.log(`  CASE E OK: DNC lead → reject.`);
  }

  // === CASE F — "do-not-contact by FLAG alone" ===
  // The gap CASE E left open. CASE E sets doNotContact=true AND
  // status="do_not_contact", so it passes whether the service reads either
  // field or both — the mutation that turns `lead.doNotContact ||
  // lead.status === "do_not_contact"` into `&&` survives it untouched. An
  // operator who ticks "do not contact" without also changing the pipeline
  // status is the ordinary case, and under that mutation their lead would be
  // approved and messaged.
  {
    const lead = makeLead({
      doNotContact: true,
      status: "needs_review",
      confidenceScore: 0.5,
    });
    const result = decideLeadForTest(lead, baseSettings, undefined, undefined, false, {
      campaignIsNew: false, industryIsNew: false, autoApprovesToday: 0,
    });
    assert(result.decision === "reject",
      `CASE F: doNotContact=true alone must reject, got ${result.decision}.`);
    assert(result.riskSignals.includes("Do not contact"),
      `CASE F: the refusal must be recorded as "Do not contact", got ${JSON.stringify(result.riskSignals)}.`);
    console.log(`  CASE F OK: doNotContact flag alone → reject.`);
  }

  // === CASE G — "do-not-contact by STATUS alone" ===
  // The mirror of CASE F, so neither half of that `||` can be deleted quietly.
  {
    const lead = makeLead({
      doNotContact: false,
      status: "do_not_contact",
      confidenceScore: 0.5,
    });
    const result = decideLeadForTest(lead, baseSettings, undefined, undefined, false, {
      campaignIsNew: false, industryIsNew: false, autoApprovesToday: 0,
    });
    assert(result.decision === "reject",
      `CASE G: status="do_not_contact" alone must reject, got ${result.decision}.`);
    assert(result.riskSignals.includes("Do not contact"),
      `CASE G: the refusal must be recorded as "Do not contact", got ${JSON.stringify(result.riskSignals)}.`);
    console.log(`  CASE G OK: do_not_contact status alone → reject.`);
  }

  // === CASE H — "blocked lead status" (invalid / duplicate / human-rejected) ===
  // Nothing in the original five cases touched this branch at all, so the
  // whole "Blocked lead status" rule was unproven: a lead the operator had
  // already marked invalid, or that de-duplication had flagged, or that a
  // human had already rejected, could be scored and put back into outreach.
  // Each of the three is asserted separately so no single one of them can be
  // dropped from the condition unnoticed.
  //
  // Hand-computed confidence for these leads: 0.5 base + fitReason 0.04 +
  // company name 0.02 − one risk signal × 0.2 = 0.36. Asserted with a
  // tolerance rather than as a literal, because that sum evaluates to
  // 0.36000000000000004 in binary floating point, and pinning the artefact of
  // the addition ORDER would make the case fail on a harmless refactor.
  for (const [label, overrides] of [
    ["invalid", { status: "invalid" }],
    ["duplicate", { status: "duplicate" }],
    ["human-rejected", { reviewStatus: "rejected" }],
  ] as Array<[string, Partial<Lead>]>) {
    const lead = makeLead({ confidenceScore: 0.5, ...overrides });
    const result = decideLeadForTest(lead, baseSettings, undefined, undefined, false, {
      campaignIsNew: false, industryIsNew: false, autoApprovesToday: 0,
    });
    assert(result.decision === "reject",
      `CASE H (${label}): a blocked lead must reject, got ${result.decision}.`);
    assert(result.riskSignals.includes("Blocked lead status"),
      `CASE H (${label}): the reason must be recorded as "Blocked lead status", got ${JSON.stringify(result.riskSignals)}.`);
    assert(Math.abs(result.confidenceScore - 0.36) < 1e-9,
      `CASE H (${label}): confidence must be 0.5 + 0.04 + 0.02 − 0.2 = 0.36, got ${result.confidenceScore}.`);
  }
  console.log(`  CASE H OK: invalid / duplicate / human-rejected → reject at confidence 0.36.`);

  // === CASE I — "no daily cap configured" ===
  // maxAutoApprovedPerDay = 0 means NO CAP, not a cap of zero. The guard is
  // `cap > 0 && used >= cap`; widen it to `cap >= 0` and every workspace that
  // has not set a cap silently stops auto-approving anything. CASE D proves
  // the cap blocks when it is MET; nothing proved auto-approval still WORKS
  // when no cap is set — a check that only ever asserts the negative cannot
  // notice a rule that has started refusing everything.
  //
  // Hand-computed: 0.9 base + fit 0.04 + profile 0.04 + company 0.02 +
  // campaign 0.03 + ICP 0.08 = 0.21, clipped to the 0.2 bonus cap, so
  // 0.9 + 0.2 = 1.1, clipped again to the 0.95 ceiling.
  {
    const noCapSettings: LeadReviewSettings = { ...baseSettings, maxAutoApprovedPerDay: 0 };
    const lead = makeLead({
      confidenceScore: 0.9,
      websiteUrl: "https://testco.example.com",
      campaignId: "camp_existing",
    });
    const flags = { campaignIsNew: false, industryIsNew: false, autoApprovesToday: 0 };
    const result = decideLeadForTest(lead, noCapSettings, existingCampaign, matchingIcp, false, flags);
    assert(result.confidenceScore === 0.95,
      `CASE I: confidence must hit the 0.95 ceiling (0.9 + capped 0.2 bonus), got ${result.confidenceScore}.`);
    assert(result.autoApprovalBlockedReason === undefined,
      `CASE I: no cap configured must not block auto-approval, got "${result.autoApprovalBlockedReason}".`);
    assert(result.decision === "approve",
      `CASE I: a 0.95 lead with no blocking flag must approve, got ${result.decision}.`);
    assert(isAutoApprovalCandidateForTest(result, noCapSettings, flags),
      "CASE I: with maxAutoApprovedPerDay=0 (no cap) a 0.95 lead must still be an auto-approval candidate.");
    console.log(`  CASE I OK: no cap configured → 0.95 lead still auto-approves.`);
  }

  console.log("PASS golden-lead-review-math: all 9 cases match hand-computed expected values.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
