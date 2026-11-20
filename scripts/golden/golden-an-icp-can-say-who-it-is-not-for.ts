/**
 * Golden test — the owner can say who they do NOT sell to, and nothing
 * overrules them.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * The operator asked, of a live workspace holding fifty-three discovered
 * companies: "Does my system know that they are the competitors, and they're
 * not going to take the material from us?"
 *
 * It did not. Reading the scoring and review code:
 *
 *   - The ICP had `qualificationRules` (who to sell to) and no field of any
 *     kind for who NOT to sell to.
 *   - `decideLead` awarded "Matches ICP context" merely because `icpId` was
 *     set, so attaching a lead to an ICP was a positive signal regardless of
 *     what the lead actually was.
 *   - The F-N-R-T score cannot express a disqualification at all. It is a
 *     weighted sum, and Reachability is the heaviest term — so a competitor
 *     with a good website and a listed phone number scores HIGHER than a
 *     genuine buyer who is hard to reach.
 *
 * Searching "zari work manufacturer Surat" returns the company's own
 * competitors beside its buyers, and competitors are the easiest of all to
 * reach. The LLM layer did catch some of them unprompted — one was flagged
 * "Potential competitor: manufactures similar products" — but that was the
 * model noticing, not the product knowing, and the model's opinion is not
 * something an owner can set, see or correct.
 *
 *   CASE A — the ICP can carry exclusions.
 *
 *   CASE B — a lead matching one is flagged, and the flag NAMES the phrase that
 *     matched, so an over-broad rule is visible as itself rather than as an
 *     unexplained rejection.
 *
 *   CASE C — a match forces a reject regardless of how well the lead scores.
 *     This is the whole point: the score could not express it, so the exclusion
 *     has to sit outside the score.
 *
 *   CASE D — the model cannot overturn it. The whole ICP goes into the prompt
 *     and the model usually agrees, but "we do not sell to these" is a fact
 *     about the business, not a judgement to revisit — the same treatment
 *     do-not-contact already gets.
 *
 *   CASE E — an empty or trivial exclusion list changes nothing. A workspace
 *     that never sets one must behave exactly as before, and a stray one- or
 *     two-character line must not reject the entire pipeline.
 *
 *   CASE F — the owner can set them on the screen, not only through the API.
 *
 * Substrate: the real matcher and the real decision function, plus a static
 * read of the service and the screen. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import type { ICP, Lead, LeadReviewSettings } from "@/lib/types";
import { decideLeadForTest, matchedExclusions } from "@/services/LeadReviewDecisionService";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const SERVICE = "src/services/LeadReviewDecisionService.ts";
const SCREEN = "src/app/page.tsx";
const TYPES = "src/lib/types.ts";

/** A lead that scores as well as this product can score one. */
function strongLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead_1",
    workspaceId: "w1",
    companyName: "Hariom Zarilon",
    websiteUrl: "https://example.com",
    linkedinUrl: "https://linkedin.com/company/example",
    fitReason: "Zari manufacturer in Surat with a large listed catalogue",
    industry: "Zari and metallic thread manufacturing",
    leadScore: 20, fitScore: 5, needScore: 5, reachabilityScore: 5, timingScore: 5,
    confidenceScore: 0.95,
    status: "discovered",
    enrichmentStatus: "not_started",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  } as Lead;
}

function icpWith(exclusions?: string[]): ICP {
  return {
    id: "icp_1", workspaceId: "w1", businessProfileId: "bp_1",
    name: "Embroidery units buying metallic thread",
    description: "", buyerType: "manufacturer",
    industries: [], geography: [], companySizeBucket: "small company",
    likelyNeeds: [], buyingTriggers: [], painPoints: [],
    preferredChannels: [], messagingAngles: [], qualificationRules: [],
    ...(exclusions ? { exclusions } : {}),
    confidenceScore: 0.8, status: "selected",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
  } as ICP;
}

const settings = {
  workspaceId: "w1", mode: "manual_review",
  autoApproveThreshold: 0.85, autoRejectThreshold: 0.25,
  maxAutoApprovedPerDay: 25,
  requireHumanForNewCampaigns: false, requireHumanForNewIndustries: false,
  allowAutoEnrichment: false, allowAutoOutreachPreparation: true,
  allowAutoSend: false, auditEveryDecision: true,
} as LeadReviewSettings;

function main() {
  console.log("=== GOLDEN: an ICP can say who it is not for ===\n");

  const service = readSource(SERVICE);
  const screen = readSource(SCREEN);

  // ---------------------------------------------------------------- CASE A
  {
    const types = readSource(TYPES);
    const icpType = types.slice(types.indexOf("export type ICP = {"), types.indexOf("export type Campaign"));
    assert(/exclusions\?: string\[\]/.test(icpType), `CASE A: ${TYPES} gives the ICP no way to say who it is NOT for`);
    console.log("✅ CASE A — the ICP can carry exclusions");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const hits = matchedExclusions(strongLead(), icpWith(["zari manufacturer", "staffing agency"]));
    assert(hits.length === 1 && hits[0] === "zari manufacturer", `CASE B: expected the matching phrase, got ${JSON.stringify(hits)}`);
    const decision = decideLeadForTest(strongLead(), settings, undefined, icpWith(["zari manufacturer"]));
    assert(
      decision.riskSignals.some((signal) => signal.includes("zari manufacturer")),
      `CASE B: the risk signal must name the phrase that matched, got ${JSON.stringify(decision.riskSignals)}`,
    );
    console.log("✅ CASE B — the matching phrase is named back to the operator");
  }

  // ---------------------------------------------------------------- CASE C
  {
    // Same lead, scored as highly as the product scores anything.
    const withoutRule = decideLeadForTest(strongLead(), settings, undefined, icpWith());
    assert(withoutRule.decision !== "reject", `CASE C setup: this lead should not be rejected on its own merits, got ${withoutRule.decision}`);
    const withRule = decideLeadForTest(strongLead(), settings, undefined, icpWith(["zari manufacturer"]));
    assert(
      withRule.decision === "reject",
      `CASE C: an excluded lead must be rejected however well it scores, got ${withRule.decision} at ${withRule.confidenceScore}`,
    );
    console.log("✅ CASE C — an exclusion beats a perfect score");
  }

  // ---------------------------------------------------------------- CASE D
  {
    const guard = service.slice(service.indexOf("const excluded = matchedExclusions(input.lead, input.icp)"));
    assert(guard.length > 0, `CASE D: the model's recommendation is never checked against the owner's exclusions`);
    assert(
      /decision: "reject"/.test(guard.slice(0, 500)),
      `CASE D: an excluded lead must stay rejected even when the model says approve`,
    );
    console.log("✅ CASE D — the model cannot overturn the owner's own rule");
  }

  // ---------------------------------------------------------------- CASE E
  {
    assert(matchedExclusions(strongLead(), icpWith()).length === 0, "CASE E: no exclusions must mean no change");
    assert(matchedExclusions(strongLead(), icpWith([])).length === 0, "CASE E: an empty list must mean no change");
    assert(matchedExclusions(strongLead(), icpWith(["", "  "])).length === 0, "CASE E: blank lines must not match");
    assert(matchedExclusions(strongLead(), icpWith(["a", "in"])).length === 0, "CASE E: a one- or two-character rule must not reject everything");
    const untouched = decideLeadForTest(strongLead(), settings, undefined, icpWith());
    assert(untouched.riskSignals.length === 0, `CASE E: a workspace with no exclusions must behave exactly as before`);
    console.log("✅ CASE E — no exclusions, no behaviour change");
  }

  // ---------------------------------------------------------------- CASE F
  {
    assert(/Who you do NOT sell to/.test(screen), `CASE F: ${SCREEN} gives the owner nowhere to set an exclusion`);
    assert(/exclusions: draft/.test(screen), `CASE F: the screen must actually save them`);
    console.log("✅ CASE F — the owner can set them on the screen");
  }

  console.log("\n=== GOLDEN PASSED (A-F) ===");
}

main();
