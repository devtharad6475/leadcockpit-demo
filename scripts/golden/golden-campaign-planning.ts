/**
 * Golden test — Campaign planning (real AI + deterministic fallback).
 *
 * Phase 1.5 / skill v2 — written BEFORE the LLM-upgrade code.
 *
 * Operator-confirmed rules (from docs/LOGIC.md, 2026-07-19):
 *   1. planCampaign calls the LLM with ICP + business profile + products.
 *   2. The plan must include: searchQueries (specific to ICP + region),
 *      messageStrategy, outreachSequence, qualificationCriteria,
 *      expectedLeadStatuses, manualExecutionSteps, prospectSources.
 *   3. The plan must NOT auto-set abstract goals — goals are practical
 *      (find buyers, get catalogue requests, qualify leads).
 *      Catalogue/price/quote/sample requests are intent signals, not goals.
 *   4. If LLM fails or mock mode, fall back to deterministic planCampaign.
 *
 * N-TEST-13 (2026-08-26, S33). The mutation sweep put twelve separate breaks
 * into src/lib/agents.ts and this file noticed NONE of them, on a path the
 * operator sells. The reason was not subtle once looked at: every case here
 * asserted a SHAPE, never a VALUE. "is an array", "length >= 3", "is a
 * non-empty string". A planner that returned three queries of pure noise, or
 * ignored the target region entirely, or replaced the ICP's own qualification
 * rules with a hardcoded list, passed all five cases.
 *
 * And the last line of this file used to print "all 5 cases match hand-computed
 * expected values". There were no hand-computed expected values anywhere in it.
 * That is an A10 defect on its own — a walkthrough test that overstates what it
 * checked is worse than no test, because it stops anyone looking again.
 *
 * The values below ARE hand-computed, from planCampaignDeterministic
 * (src/lib/agents.ts:295) against the fixtures in this file:
 *
 *   region = input.targetRegion.join(", ")            = "Mumbai"
 *   icpSummary = `${icp.name}: ${icp.description}`    = "Mumbai Wholesalers: Wholesale buyers in Mumbai region."
 *   searchQueries[0] = `${icp.name} ${region}`        = "Mumbai Wholesalers Mumbai"
 *   searchQueries[1] = `${icp.buyerType} ${region}`   = "Wholesaler / distributor Mumbai"
 *   searchQueries[2] = `${icp.industries[0]} companies ${region}` = "Wholesale companies Mumbai"
 *   searchQueries[3] = `${profile.products[0]} buyer ${region}`   = "Premium Widget buyer Mumbai"
 *   searchQueries[4] = `${icp.name} contact WhatsApp email`       = "Mumbai Wholesalers contact WhatsApp email"
 *   messageStrategy  = "Short, permission-based outreach focused on Catalogue request."
 *   qualificationCriteria = icp.qualificationRules    = ["Has phone or WhatsApp", "Sells to retailers"]
 *
 *   CASE A — every field of the plan equals its hand-computed value exactly.
 *   CASE B — every search query carries the region; the ICP name, buyer type,
 *     industry and product each appear. Rule 2 says the queries must be
 *     SPECIFIC to the ICP and region, and only this asserts that.
 *   CASE C — outreachSequence is the operator-approved four-step ladder, in
 *     order. A silently dropped follow-up is lost revenue, not a style change.
 *   CASE D — qualificationCriteria is the ICP's OWN rules, not a constant.
 *   CASE E — No abstract goal language in the plan output (no "maximize
 *     ROI", "scale revenue", "dominate market", etc.). Goals must be
 *     practical per the operator rule.
 *   CASE F — change the target region and every region-bearing query changes
 *     with it. Proves the region is used rather than decorative.
 *   CASE G — with no targetRegion supplied, the ICP's geography is used.
 *   CASE H — change the ICP's qualification rules and the plan follows.
 *
 * Run: npx tsx scripts/golden/golden-campaign-planning.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { planCampaignDeterministicForTest } from "@/lib/agents";
import type { BusinessProfile, Campaign, ICP } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const profile: BusinessProfile = {
  id: "profile_test",
  workspaceId: "workspace_demo",
  companyName: "TestCo",
  industry: "Manufacturing",
  description: "TestCo manufactures widgets for B2B buyers.",
  products: ["Premium Widget"],
  services: [],
  productCategories: ["Widgets"],
  targetGeographies: ["Mumbai"],
  currentCustomerTypes: [],
  desiredCustomerTypes: ["Wholesaler"],
  strengths: [],
  limitations: [],
  certifications: [],
  socialLinks: [],
  catalogueLinks: [],
  proofAssets: [],
  languagePreference: "English",
  tonePreference: "Warm, concise, businesslike",
  status: "approved",
  fields: [],
  createdAt: "2026-07-19T00:00:00Z",
  updatedAt: "2026-07-19T00:00:00Z",
} as BusinessProfile;

const icp: ICP = {
  id: "icp_test",
  workspaceId: "workspace_demo",
  businessProfileId: "profile_test",
  name: "Mumbai Wholesalers",
  description: "Wholesale buyers in Mumbai region.",
  buyerType: "Wholesaler / distributor",
  industries: ["Wholesale", "Manufacturing"],
  geography: ["Mumbai"],
  companySizeBucket: "small company",
  likelyNeeds: ["Premium Widget", "bulk pricing"],
  buyingTriggers: ["Inventory planning"],
  painPoints: ["Margin pressure"],
  preferredChannels: ["WhatsApp"],
  messagingAngles: ["Bulk supply with reliable delivery"],
  qualificationRules: ["Has phone or WhatsApp", "Sells to retailers"],
  confidenceScore: 0.82,
  status: "selected",
  createdAt: "2026-07-19T00:00:00Z",
  updatedAt: "2026-07-19T00:00:00Z",
} as ICP;

const ABSTRACT_GOAL_PATTERNS = /\b(maximize roi|scale revenue|dominate market|growth hack|viral|disrupt|game[- ]changer|synergy|best in class|world[- ]class)\b/i;

async function main() {
  const plan = planCampaignDeterministicForTest(profile, icp, { targetRegion: ["Mumbai"], offer: "Catalogue request", productFocus: ["Premium Widget"] });

  // === CASE A — every field equals its hand-computed value ===
  // Deep equality, not shape. The planner is fully deterministic, so there is
  // no excuse for asserting anything weaker than the exact output.
  const eq = (actual: unknown, expected: unknown, label: string) =>
    assert(JSON.stringify(actual) === JSON.stringify(expected),
      `${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);

  eq(plan.icpSummary, "Mumbai Wholesalers: Wholesale buyers in Mumbai region.", "CASE A: icpSummary");
  eq(plan.prospectSources,
    ["Manual lead entry", "CSV upload", "Google-style search review", "Website/social profile review"],
    "CASE A: prospectSources");
  eq(plan.searchQueries, [
    "Mumbai Wholesalers Mumbai",
    "Wholesaler / distributor Mumbai",
    "Wholesale companies Mumbai",
    "Premium Widget buyer Mumbai",
    "Mumbai Wholesalers contact WhatsApp email",
  ], "CASE A: searchQueries");
  eq(plan.messageStrategy,
    "Short, permission-based outreach focused on Catalogue request.",
    "CASE A: messageStrategy");
  eq(plan.expectedLeadStatuses,
    ["needs_review", "approved", "enriched", "message_ready", "contacted", "replied", "mql", "sql", "hot_lead"],
    "CASE A: expectedLeadStatuses");
  eq(plan.manualExecutionSteps, [
    "Review prospects", "Approve only relevant leads", "Enrich approved leads",
    "Generate messages", "Open channel manually", "Mark sent", "Paste replies",
  ], "CASE A: manualExecutionSteps");
  console.log("  CASE A OK: every plan field matches its hand-computed value exactly.");

  // === CASE B — the queries are SPECIFIC to this ICP and region (rule 2) ===
  // The old version accepted any three non-empty strings. Three copies of the
  // word "the" would have passed. What the operator was promised is that the
  // queries name their ICP and their region, so that is what gets asserted.
  for (const q of plan.searchQueries) {
    assert(typeof q === "string" && q.trim().length > 0, "CASE B: every search query must be a non-empty string.");
  }
  const regionQueries = plan.searchQueries.filter((q) => q.includes("Mumbai"));
  assert(regionQueries.length === plan.searchQueries.length,
    `CASE B: every query must carry the region. Missing it: ${JSON.stringify(plan.searchQueries.filter((q) => !q.includes("Mumbai")))}`);
  const joined = plan.searchQueries.join(" | ");
  for (const needle of ["Mumbai Wholesalers", "Wholesaler / distributor", "Wholesale", "Premium Widget"]) {
    assert(joined.includes(needle), `CASE B: the queries must reference "${needle}". Got: ${joined}`);
  }
  console.log(`  CASE B OK: ${plan.searchQueries.length} queries, all region-bearing and ICP-specific.`);

  // === CASE C — the operator-approved four-step ladder, in order ===
  // Order matters and the count matters: a dropped follow-up is money, not
  // wording. "length >= 3" would have passed a three-step sequence that
  // silently lost the 7-day reminder.
  eq(plan.outreachSequence,
    ["First message", "Follow-up after 3 days", "Helpful reminder after 7 days", "Breakup message"],
    "CASE C: outreachSequence");
  console.log("  CASE C OK: exact 4-step outreach ladder, in order.");

  // === CASE D — the criteria are the ICP's OWN rules, not a constant ===
  eq(plan.qualificationCriteria, icp.qualificationRules, "CASE D: qualificationCriteria must be the ICP's rules");
  eq(plan.qualificationCriteria, ["Has phone or WhatsApp", "Sells to retailers"], "CASE D: qualificationCriteria value");
  console.log("  CASE D OK: qualification criteria come from the ICP.");

  // === CASE E — No abstract goal language in plan output ===
  const fullPlanText = JSON.stringify(plan);
  assert(!ABSTRACT_GOAL_PATTERNS.test(fullPlanText),
    `CASE E: plan contains abstract goal language (forbidden). Plan text snippet: ${fullPlanText.slice(0, 200)}...`);
  console.log("  CASE E OK: no abstract goal language in plan.");

  // === CASE F — the region is USED, not decorative ===
  // The single most plausible silent failure on this path: the planner keeps
  // producing a confident, well-formed plan aimed at the wrong city. Every
  // shape assertion in the old file would still have been green.
  const other = planCampaignDeterministicForTest(profile, icp, { targetRegion: ["Pune", "Nashik"], offer: "Catalogue request", productFocus: ["Premium Widget"] });
  eq(other.searchQueries, [
    "Mumbai Wholesalers Pune, Nashik",
    "Wholesaler / distributor Pune, Nashik",
    "Wholesale companies Pune, Nashik",
    "Premium Widget buyer Pune, Nashik",
    "Mumbai Wholesalers contact WhatsApp email",
  ], "CASE F: changing the target region must change every region-bearing query");
  assert(!other.searchQueries.slice(0, 4).some((q) => q.includes("Mumbai Wholesalers Mumbai")),
    "CASE F: the old region must not survive into the new plan");
  console.log("  CASE F OK: region flows into the queries (Mumbai -> Pune, Nashik).");

  // === CASE G — no target region supplied: fall back to the ICP geography ===
  const noRegion = planCampaignDeterministicForTest(profile, icp, { offer: "Catalogue request", productFocus: ["Premium Widget"] });
  eq(noRegion.searchQueries[0], "Mumbai Wholesalers Mumbai", "CASE G: with no targetRegion, icp.geography is the region");
  console.log("  CASE G OK: missing target region falls back to the ICP geography.");

  // === CASE H — the ICP's rules drive the criteria ===
  const strictIcp = { ...icp, qualificationRules: ["Must hold a GST number", "Orders 500 units or more"] } as ICP;
  const strictPlan = planCampaignDeterministicForTest(profile, strictIcp, { targetRegion: ["Mumbai"], offer: "Catalogue request", productFocus: ["Premium Widget"] });
  eq(strictPlan.qualificationCriteria, ["Must hold a GST number", "Orders 500 units or more"],
    "CASE H: a different ICP must produce different qualification criteria");
  console.log("  CASE H OK: qualification criteria follow the ICP.");

  console.log("PASS golden-campaign-planning: 8 cases — A/C/D exact-value, B specificity, E goal language, F/G region wiring, H ICP wiring.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
