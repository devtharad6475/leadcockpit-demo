/**
 * Golden test — ICP generation (real AI + deterministic fallback).
 *
 * Phase 1.5 / skill v2 — written BEFORE the LLM-upgrade code.
 *
 * Operator-confirmed rules (from docs/LOGIC.md, 2026-07-19):
 *   1. generateICPs calls the LLM and returns 3-5 ICPs tailored to the
 *      business. The LLM decides the count based on business diversity.
 *   2. Every ICP must have: name, description, buyerType, industries,
 *      geography, likelyNeeds, buyingTriggers, painPoints, preferredChannels,
 *      messagingAngles, qualificationRules, confidenceScore (LLM-reported,
 *      capped at 0.9), status="suggested".
 *   3. If the LLM call fails OR returns fewer than 3 OR the run is in mock
 *      mode, fall back to the deterministic templates in
 *      generateICPsDeterministic (the existing 3-template version).
 *
 * Hand-computed expected values (BEFORE looking at the upgrade code):
 *
 *   CASE A — Deterministic fallback always returns EXACTLY 3 ICPs.
 *     The existing 3 templates (Direct Buyers / Manufacturers & Producers /
 *     Regional Wholesalers) is the floor. The fallback can never return <3.
 *
 *   CASE B — Every ICP from the deterministic fallback has all required
 *     fields populated (no undefined, no empty arrays for required fields).
 *
 *   CASE C — Every ICP's confidenceScore is in [0, 1].
 *
 *   CASE D — Every ICP's status is "suggested" (never "selected" or
 *     "rejected" on creation — those happen via the explicit select/reject
 *     endpoints).
 *
 *   CASE E — the LLM path itself, and the fallback rule that guards it.
 *     E1  LLM returns 2 valid ICPs        → deterministic 3 (below the floor)
 *     E2  LLM returns 4 valid ICPs        → those 4, confidenceScore capped to
 *         0.9, status "suggested", stamped with the caller's workspace/profile
 *     E3  LLM returns 4 but mode="mock"   → deterministic 3 (a placeholder is
 *         not an answer, however many of them there are)
 *     E4  LLM throws                      → deterministic 3, no throw escapes
 *     E5  LLM returns 4, 2 malformed      → 2 survive parsing → deterministic 3
 *     E6  LLM returns no `icps` array     → deterministic 3
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CASE E REWRITTEN 2026-08-26 (S24-15). READ THIS BEFORE CHANGING ANYTHING.
 *
 * Until today CASE E was CASE A with a different label. Its whole body was:
 *
 *     // We can't easily simulate a malformed LLM from this pure test
 *     // without injecting a fake LLMService — but we CAN assert that the
 *     // deterministic fallback itself is a safe 3.
 *     assert(deterministic.length >= 3, "CASE E: deterministic fallback is the floor ...")
 *
 * `generateICPs` — the function whose fallback rule the case is named after —
 * was never called. The rule could have been deleted from the product and this
 * golden would have stayed green while the board cited it as proof.
 *
 * The stated excuse ("without injecting a fake LLMService") was solvable in two
 * lines: `generateICPs` now takes an optional LLM seam as its third parameter,
 * mirroring the `repos` seam already on its second. Production callers pass
 * neither and behave exactly as before.
 *
 * MUTATION-TESTED 2026-08-26. Mutations on SHIPPING code (src/lib/agents.ts),
 * each compiling clean under tsc, source restored byte-identical (sha256):
 *   m15 the `aiIcps.length < 3` half of the guard never fires
 *       -> E1 and E5 fail. Two AI-authored ICPs reach the operator where the
 *          contract promises a floor of three.
 *   m16 the `isMockRun` half never fires
 *       -> E3 fails. The mock provider's placeholder is served to the customer
 *          as a real ICP — the exact "fake data looks real" failure.
 *   m17 the guard always fires (deterministic returned unconditionally)
 *       -> E2 fails. This is the mutation the OLD case could never have caught
 *          in principle: the whole AI feature is switched off and every
 *          assertion the old case made is still true.
 *
 * RECEIPT: the old CASE E was restored from backup and run under all three
 * mutations. It printed "CASE E OK" and the file exited 0 every time.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * First run on the pre-upgrade code: CASES A-D pass against the existing
 * deterministic generateICPs. CASE E cannot be exercised until the upgrade
 * adds an LLM-call path with fallback. After the upgrade, all 5 pass.
 *
 * Run: npx tsx scripts/golden/golden-icp-generation.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { generateICPs, generateICPsDeterministicForTest } from "@/lib/agents";
import { createJsonRepos } from "./_helpers/provider";
import type { LLMTaskName, LLMTaskOptions, LLMTaskResult } from "@/llm/types";
import type { BusinessProfile, ICP } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// These are the fields the ICP-generation function MUST populate. `id`,
// `createdAt`, `updatedAt` are assigned by the repository on insert, so
// they're NOT expected on the function output.
const REQUIRED_ICP_STRING_FIELDS = [
  "workspaceId", "businessProfileId", "name", "description", "buyerType", "companySizeBucket", "status",
] as const;
const REQUIRED_ICP_ARRAY_FIELDS = [
  "industries", "geography", "likelyNeeds", "buyingTriggers", "painPoints", "preferredChannels", "messagingAngles", "qualificationRules",
] as const;

const baseProfile: BusinessProfile = {
  id: "profile_test",
  workspaceId: "workspace_demo",
  companyName: "TestCo Industries",
  websiteUrl: "https://testco.example.com",
  industry: "Manufacturing",
  businessType: "Manufacturer",
  description: "TestCo manufactures widgets for B2B buyers.",
  products: ["Premium Widget", "Standard Widget"],
  services: [],
  productCategories: ["Widgets"],
  targetGeographies: ["Mumbai", "Pune"],
  currentCustomerTypes: ["Wholesaler"],
  desiredCustomerTypes: ["Wholesaler", "Distributor"],
  strengths: ["Manufacturing capability"],
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

async function main() {
  // === CASE A — Deterministic fallback returns exactly 3 ICPs ===
  const deterministic = generateICPsDeterministicForTest(baseProfile);
  assert(deterministic.length === 3,
    `CASE A: deterministic fallback must return exactly 3 ICPs, got ${deterministic.length}.`);
  console.log(`  CASE A OK: deterministic fallback → ${deterministic.length} ICPs.`);

  // === CASE B — Every ICP has all required fields populated ===
  for (const icp of deterministic) {
    const record = icp as unknown as Record<string, unknown>;
    for (const field of REQUIRED_ICP_STRING_FIELDS) {
      const value = record[field];
      assert(typeof value === "string" && (value as string).trim().length > 0,
        `CASE B: ICP "${icp.name}" missing required string field ${String(field)} (got ${String(value)}).`);
    }
    for (const field of REQUIRED_ICP_ARRAY_FIELDS) {
      const value = record[field];
      assert(Array.isArray(value) && value.length > 0,
        `CASE B: ICP "${icp.name}" required array field ${String(field)} must be a non-empty array.`);
    }
  }
  console.log("  CASE B OK: every deterministic ICP has all required fields populated.");

  // === CASE C — Every confidenceScore in [0, 1] ===
  for (const icp of deterministic) {
    assert(icp.confidenceScore >= 0 && icp.confidenceScore <= 1,
      `CASE C: ICP "${icp.name}" confidenceScore ${icp.confidenceScore} must be in [0, 1].`);
  }
  console.log("  CASE C OK: every confidenceScore is in [0, 1].");

  // === CASE D — Every status is "suggested" on creation ===
  for (const icp of deterministic) {
    assert(icp.status === "suggested",
      `CASE D: ICP "${icp.name}" status ${icp.status} must be "suggested" on creation.`);
  }
  console.log("  CASE D OK: every ICP starts as 'suggested'.");

  // === CASE E — the real LLM path, and the fallback rule that guards it ===
  //
  // REWRITTEN 2026-08-26 (S24-15). What this case used to be, verbatim:
  //
  //     // We can't easily simulate a malformed LLM from this pure test
  //     // without injecting a fake LLMService — but we CAN assert that the
  //     // deterministic fallback itself is a safe 3.
  //     assert(deterministic.length >= 3, "CASE E: deterministic fallback is the floor ...");
  //
  // That is CASE A restated. `generateICPs` — the function whose fallback rule
  // this case is named after — was never called. The rule at
  // src/lib/agents.ts:214 (`if (isMockRun || aiIcps.length < 3) return
  // deterministic;`) could be deleted entirely and this golden stayed green.
  //
  // The excuse was also solvable: `generateICPs` now takes an optional LLM
  // seam as its third parameter, mirroring the `repos` seam already on its
  // second. Production callers pass neither.
  const REAL_ICP = (n: number) => ({
    name: `AI ICP ${n}`,
    description: `An LLM-authored ICP, number ${n}.`,
    buyerType: "Distributor",
    industries: ["Manufacturing"],
    geography: ["Mumbai"],
    companySizeBucket: "medium company",
    likelyNeeds: ["Bulk supply"],
    buyingTriggers: ["Festive demand"],
    painPoints: ["Unreliable suppliers"],
    preferredChannels: ["WhatsApp"],
    messagingAngles: ["Reliability"],
    qualificationRules: ["Buys in bulk"],
    // Deliberately ABOVE the documented 0.9 cap, so E2 can prove the cap is
    // applied on the AI path and not only on the deterministic templates.
    confidenceScore: 0.99,
  });

  /**
   * A stand-in for LLMService that returns exactly what each scenario needs.
   * Typed as `Pick<LLMService, "runTask">` at the callsite, so it cannot drift
   * from the real signature without tsc noticing.
   */
  function fakeLlm(options: { icps?: unknown[]; mode?: "real" | "mock"; throws?: boolean }) {
    const state = { calls: 0 };
    const llm = {
      async runTask<T>(taskName: LLMTaskName, _input: unknown, _opts: LLMTaskOptions): Promise<LLMTaskResult<T>> {
        state.calls += 1;
        assert(taskName === "icp_generation",
          `CASE E fixture guard: generateICPs must ask for the "icp_generation" task, asked for "${taskName}".`);
        if (options.throws) throw new Error("simulated provider outage");
        return {
          output: { icps: options.icps } as T,
          provider: options.mode === "mock" ? "mock" : "deepseek",
          modelTier: "balanced",
          mode: options.mode || "real",
        };
      },
    };
    return { llm, state };
  }

  // generateICPs takes a bundle, so it gets a pinned one (see the warning on
  // createAmbientRepos). Nothing here reads or writes storage: the LLM seam is
  // a stand-in and the deterministic fallback is pure.
  const repos = createJsonRepos();
  const deterministicNames = deterministic.map((icp) => icp.name).join(" | ");

  // E1 — the LLM answered, but with fewer than 3. The floor takes over.
  {
    const { llm, state } = fakeLlm({ icps: [REAL_ICP(1), REAL_ICP(2)] });
    const out = await generateICPs(baseProfile, repos, llm);
    assert(state.calls === 1, "CASE E1: generateICPs must actually call the LLM (it did not).");
    assert(out.length === 3, `CASE E1: 2 AI ICPs is below the floor — must fall back to 3, got ${out.length}.`);
    assert(out.map((icp) => icp.name).join(" | ") === deterministicNames,
      "CASE E1: the fallback must return the DETERMINISTIC ICPs, not the LLM's short list.");
    console.log("  CASE E1 OK: LLM returned 2 → deterministic 3 returned instead.");
  }

  // E2 — the LLM answered properly. Its answer must be USED, not discarded.
  // Without this scenario a fallback that fires every time would pass E1.
  {
    const { llm, state } = fakeLlm({ icps: [REAL_ICP(1), REAL_ICP(2), REAL_ICP(3), REAL_ICP(4)] });
    const out = await generateICPs(baseProfile, repos, llm);
    assert(state.calls === 1, "CASE E2: generateICPs must actually call the LLM (it did not).");
    assert(out.length === 4, `CASE E2: 4 valid AI ICPs must be returned as 4, got ${out.length}.`);
    assert(out.every((icp) => icp.name.startsWith("AI ICP")),
      "CASE E2: the returned ICPs must be the LLM's, not the deterministic templates — the AI path is dead otherwise.");
    assert(out.every((icp) => icp.confidenceScore === 0.9),
      `CASE E2: confidenceScore 0.99 must be capped to 0.9 on the AI path, got ${out.map((i) => i.confidenceScore).join(",")}.`);
    assert(out.every((icp) => icp.status === "suggested"),
      "CASE E2: AI-authored ICPs must also start as 'suggested'.");
    assert(out.every((icp) => icp.workspaceId === baseProfile.workspaceId && icp.businessProfileId === baseProfile.id),
      "CASE E2: AI-authored ICPs must be stamped with the caller's workspace and profile, not the LLM's guess.");
    console.log("  CASE E2 OK: LLM returned 4 valid → all 4 returned, capped and stamped.");
  }

  // E3 — a mock run is not an answer, however many ICPs it invents.
  {
    const { llm } = fakeLlm({ icps: [REAL_ICP(1), REAL_ICP(2), REAL_ICP(3), REAL_ICP(4)], mode: "mock" });
    const out = await generateICPs(baseProfile, repos, llm);
    assert(out.length === 3 && out.map((icp) => icp.name).join(" | ") === deterministicNames,
      "CASE E3: mock-mode output must be discarded — a placeholder must never reach the customer as an ICP.");
    console.log("  CASE E3 OK: mock mode → deterministic, even with 4 well-formed ICPs.");
  }

  // E4 — the provider is down. The operator still gets 3.
  {
    const { llm } = fakeLlm({ throws: true });
    const out = await generateICPs(baseProfile, repos, llm);
    assert(out.length === 3 && out.map((icp) => icp.name).join(" | ") === deterministicNames,
      "CASE E4: an LLM outage must fall back, not throw out of generateICPs.");
    console.log("  CASE E4 OK: provider outage → deterministic 3.");
  }

  // E5 — 4 entries, but 2 are junk. What survives parsing is what counts.
  {
    const bad = { ...REAL_ICP(9), buyerType: "" };
    const { llm } = fakeLlm({ icps: [REAL_ICP(1), bad, REAL_ICP(2), { name: "no description" }] });
    const out = await generateICPs(baseProfile, repos, llm);
    assert(out.length === 3 && out.map((icp) => icp.name).join(" | ") === deterministicNames,
      "CASE E5: entries missing required fields are dropped, and 2 survivors is still below the floor.");
    console.log("  CASE E5 OK: 4 in, 2 malformed → 2 survive → below the floor → deterministic 3.");
  }

  // E6 — the LLM returned the wrong shape entirely.
  {
    const { llm } = fakeLlm({ icps: undefined });
    const out = await generateICPs(baseProfile, repos, llm);
    assert(out.length === 3 && out.map((icp) => icp.name).join(" | ") === deterministicNames,
      "CASE E6: a response with no `icps` array must fall back, not crash or return [].");
    console.log("  CASE E6 OK: missing `icps` array → deterministic 3.");
  }

  console.log("PASS golden-icp-generation: all 5 cases match hand-computed expected values.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
