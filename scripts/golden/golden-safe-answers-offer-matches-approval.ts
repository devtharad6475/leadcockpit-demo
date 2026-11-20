/**
 * golden-safe-answers-offer-matches-approval.ts — pin (2026-09-25).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The Knowledge Base screen counted "safe to approve" answers with its own
 * copy of the rule, missing two of the server's conditions (sensitive topics
 * such as price / payment / delivery, and snippet evidence). A browser test
 * caught it: after pressing "Approve safe answers" the server skipped 13
 * sensitive answers, and the screen kept offering "Approve 13 safe answers"
 * — a button that could be pressed forever and never do anything. The server
 * message also counted already-approved answers as newly approved.
 *
 * HAND-COMPUTED CONTRACT (fixture: 2 safe non-sensitive answers, 1 price
 * answer, 1 already-approved answer, 1 low-confidence answer)
 *   CASE A — the list marks exactly the 2 safe answers `safeToBulkApprove`.
 *   CASE B — the approval approves exactly those 2 (not the approved one again).
 *   CASE C — afterwards the list marks 0 answers safe: the offer disappears.
 *   CASE D — the price answer is untouched (still waiting for a person).
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { approveAllSafeKnowledgeAnswers, listKnowledgeQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";

const repos = createJsonRepos();
const workspaceId = `ws_safe_offer_${Date.now()}`;

async function plant(overrides: Partial<KnowledgeQuestionAnswer>) {
  await repos.mutateAll!((data: AppData) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push({
      id: `kqa_${workspaceId}_${overrides.questionKey}`,
      workspaceId,
      domainKey: "company_knowledge",
      answerStatus: "answered",
      sourceType: "document_extraction",
      sourceSnippet: "from the company profile",
      confidenceScore: 0.9,
      humanReviewRequired: false,
      isUserApproved: false,
      isCanonical: true,
      conflictWithExisting: false,
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
      ...overrides,
    } as unknown as KnowledgeQuestionAnswer);
    return undefined;
  });
}

type Listed = KnowledgeQuestionAnswer & { safeToBulkApprove?: boolean };
const mine = async () => (await listKnowledgeQuestionAnswers(workspaceId, repos) as Listed[]).filter((a) => a.id.startsWith(`kqa_${workspaceId}_`));

(async () => {
  console.log("golden-safe-answers-offer-matches-approval — the screen offers exactly what the server will approve\n");
  // Keys must be real framework questions: the list and the approval both walk the framework.
  await plant({ questionKey: "business_type", question: "Is the company a manufacturer, trader, distributor, service provider, exporter, or mixed business?", answer: "We manufacture in house." });
  await plant({ questionKey: "core_strengths", question: "What are the company strongest differentiators or trust points?", answer: "Consistent shades batch to batch." });
  await plant({ questionKey: "years_in_business", question: "How long has the company been operating?", answer: "Since 1998.", isUserApproved: true });
  await plant({ domainKey: "pricing_policy", questionKey: "pricing_structure", question: "How is pricing structured: fixed, per unit, custom quote, tiered, wholesale, or negotiated?", answer: "Rs 335 per kg." });
  await plant({ questionKey: "company_overview", question: "What does the company do in simple business language?", answer: "Zari thread.", confidenceScore: 0.4 });

  let failed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message}`); }
  };

  let offered: string[] = [];
  await check("CASE A — exactly the 2 safe answers are offered", async () => {
    const listed = await mine();
    // Not every planted key is a framework question (unknown keys are simply
    // not listed); the three that matter here are.
    assert.ok(listed.some((a) => a.questionKey === "years_in_business"), "fixture: the already-approved answer is listed");
    offered = listed.filter((a) => a.safeToBulkApprove).map((a) => a.questionKey).sort();
    assert.deepStrictEqual(offered, ["business_type", "core_strengths"]);
  });
  await check("CASE B — the approval approves exactly those, not the approved one again", async () => {
    const result = await approveAllSafeKnowledgeAnswers(workspaceId, repos);
    assert.strictEqual(result.approvedCount, 2, `approvedCount must equal what was offered (${offered.length}), got ${result.approvedCount}`);
  });
  await check("CASE C — afterwards nothing is offered", async () => {
    const left = (await mine()).filter((a) => a.safeToBulkApprove);
    assert.strictEqual(left.length, 0, `still offered: ${left.map((a) => a.questionKey).join(", ")}`);
  });
  await check("CASE D — the price answer still waits for a person", async () => {
    const price = (await mine()).find((a) => a.questionKey === "pricing_structure");
    assert.ok(price, "fixture: the price answer is listed");
    assert.strictEqual(price.isUserApproved, false);
  });
  console.log("");
  console.log(`safe-answers-offer-matches-approval: ${4 - failed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed) process.exit(1);
})();
