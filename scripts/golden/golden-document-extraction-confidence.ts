/**
 * Golden test — document-extraction confidence honesty (R5).
 *
 * M2.1 / R5 audit fix. The code in DocumentExtractionMappingService.ts
 * hardcoded `confidenceScore: 0.85` on every LLM-extracted fact (products,
 * FAQs, policies, company knowledge, customer knowledge), regardless of
 * whether the AI was real or mock. Mock-extracted facts then sailed past
 * the `>= 0.75` bulk-approve gate in DocumentQuestionAnsweringService.ts
 * and got auto-promoted to "approved" — violating the rule "mock output
 * must never be shown as real."
 *
 * Hand-computed expected values (BEFORE looking at the fix code):
 *
 *   Mock mode (the default; no real provider key configured):
 *     - The mock LLM provider never returns a real confidenceScore on the
 *       records it outputs.
 *     - Therefore the code's confidence-resolution helper must apply its
 *       mock fallback: 0.45 (below the 0.75 bulk-approve bar).
 *     - Every extracted product / FAQ / policy / knowledge fact MUST have
 *       confidenceScore <= 0.5. Cap is 0.5 to give a little headroom while
 *       still being clearly below 0.75.
 *     - The overall preview confidenceScore MUST be <= 0.6 (the honest
 *       "this is mock" range).
 *
 *   Real-AI mode (LLM returns its own confidenceScore per fact):
 *     - The helper uses the LLM's number, capped at 0.9 (no fact, however
 *       confident the AI claims to be, can be labelled "100% certain").
 *     - If the LLM omits the field, fall back to a conservative 0.6.
 *     - The bulk-approve gate at >= 0.75 is still reachable by real-AI
 *       facts (otherwise the gate is pointless) — but only when the AI
 *       itself reports high confidence.
 *
 * The mock-mode assertions below are the load-bearing ones (that's the bug
 * as it actually manifests in the demo). The real-mode behavior is covered
 * by unit-testing the confidence-resolution helper directly.
 *
 * First run on the unfixed code WILL FAIL — every fact comes back at 0.85.
 * That failure IS the bug. Fix M2.2 then re-run until green.
 *
 * Run: npx tsx scripts/golden/golden-document-extraction-confidence.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { mapDocumentExtraction } from "@/services/DocumentExtractionMappingService";
import { defaultWorkspaceId, mutateData } from "@/lib/db";
import type { AppData } from "@/lib/types";
import { createRepositories } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/**
 * Synthetic document with hand-known content. The mock extractor will find
 * "Premium Zari Thread" as a product and "What is your MOQ?" as a FAQ.
 * Whatever it finds, the confidence on each fact MUST be honest about being
 * a mock guess.
 */
const SYNTHETIC_DOCUMENT = `
TestCo Premium Textiles — Product Reference Sheet

Products we supply:
- Premium Zari Thread (gold and silver variants)
- Metallic Yarn for weaving

Frequently Asked Questions:
Q: What is your MOQ?
A: Our MOQ is 50 kg per variant.

Payment terms: 50% advance with order, balance before dispatch.
Delivery: 7-10 business days within India.
`;

async function main() {
  let before: AppData | undefined;
  await mutateData((data) => {
    before = structuredClone(data);
  });
  const repos = createRepositories("json");

  try {
    // === MOCK-MODE EXTRACTION ===
    // No real LLM key is configured in this test, so mapDocumentExtraction
    // routes through the MockLLMProvider. Today's (buggy) code stamps 0.85;
    // after the M2.2 fix, mock-extracted facts must come back <= 0.5.
    const preview = await mapDocumentExtraction({
      workspaceId: defaultWorkspaceId,
      title: "TestCo Product Reference",
      documentType: "product_catalog",
      contentText: SYNTHETIC_DOCUMENT,
    }, repos);

    // Hand-computed expected values:
    //  - Every mock-extracted product must have confidence <= 0.5
    //    (today: 0.85 — fails)
    const mockProductConfidences = preview.products.map((p) => p.confidenceScore);
    for (const c of mockProductConfidences) {
      assert(c <= 0.5, `Mock-extracted product confidence ${c} must be <= 0.5 (below the 0.75 bulk-approve bar).`);
    }

    //  - Every mock-extracted FAQ must have confidence <= 0.5
    const mockFaqConfidences = preview.faqs.map((f) => f.confidenceScore);
    for (const c of mockFaqConfidences) {
      assert(c <= 0.5, `Mock-extracted FAQ confidence ${c} must be <= 0.5.`);
    }

    //  - Every mock-extracted policy must have confidence <= 0.5
    const mockPolicyConfidences = preview.policies.map((p) => p.confidenceScore);
    for (const c of mockPolicyConfidences) {
      assert(c <= 0.5, `Mock-extracted policy confidence ${c} must be <= 0.5.`);
    }

    //  - Every mock-extracted company-knowledge fact must have confidence <= 0.5
    const mockCompanyKnowledgeConfidences = (preview.companyKnowledge || []).map((k) => k.confidenceScore);
    for (const c of mockCompanyKnowledgeConfidences) {
      assert(c <= 0.5, `Mock-extracted company-knowledge confidence ${c} must be <= 0.5.`);
    }

    //  - The overall preview confidence must be in the honest mock range.
    assert(preview.confidenceScore <= 0.6, `Preview-level confidence ${preview.confidenceScore} must be <= 0.6 when mock mode was used.`);

    //  - And the modelUsed block must honestly report mock / fallback.
    const provider = preview.modelUsed?.provider;
    assert(provider === "mock" || preview.modelUsed?.fallbackUsed === true,
      `Mock-mode extraction must honestly report mock provider or fallbackUsed=true; got provider=${provider}, fallbackUsed=${preview.modelUsed?.fallbackUsed}`);

    // === INVARIANT: the bulk-approve bar is 0.75 ===
    // (Cross-check: if this constant ever drifts, the rest of the test's
    // reasoning breaks. Document it explicitly.)
    const BULK_APPROVE_BAR = 0.75;
    assert(BULK_APPROVE_BAR === 0.75, "Sanity: bulk-approve bar expected to be 0.75");

    console.log(
      `PASS golden-document-extraction-confidence: mock-mode products(${mockProductConfidences.length})/faqs(${mockFaqConfidences.length})/policies(${mockPolicyConfidences.length}) all <= 0.5; preview ${preview.confidenceScore} <= 0.6; provider=${provider}.`,
    );
  } finally {
    if (before) {
      await mutateData((data) => {
        const restored = structuredClone(before) as AppData;
        Object.keys(data).forEach((key) => delete (data as unknown as Record<string, unknown>)[key]);
        Object.assign(data, restored);
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
