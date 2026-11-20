/**
 * golden-contradiction-retrieval.ts — UA-4 ROOT CAUSE pin (2026-08-17, CEO-loop
 * session 3, decision D6 "if any document is contradicting always ask").
 *
 * WHY THIS TEST EXISTS:
 *   The UI audit planted a deliberate contradiction in the fixture company's
 *   documents: `06-pricing-and-moq-policy.md` says the minimum order for zari
 *   thread is "5 kg per shade", and `18-misc-sales-notes.txt` says "10 kg per
 *   shade". The extraction pipeline answered "5 kg" at confidence 0.95 and
 *   raised NO conflict — and the "10 kg" figure never even appeared in the
 *   answer's evidence sources (docs/UI-AUDIT-2026-08/03-FINDINGS.md, UA-4).
 *
 *   The merge layer was fixed first: two answers that disagree now always raise
 *   a conflict. But that fix can only fire if two answers exist. The ROOT cause
 *   is upstream, in retrieval: `retrieveRelevantDocumentContext` picks the top-5
 *   keyword-scoring chunks for each domain batch, and the scruffy notepad file
 *   loses that ranking to the clean policy table every time. So no LLM call ever
 *   saw both figures, only one answer was ever produced, and there was nothing
 *   for the merge layer to compare.
 *
 *   The fix is a contradiction sweep: after ranking, scan the chunks this batch
 *   REJECTED for a measurement that contradicts one in the selected context
 *   (same unit, different value, >=2 shared subject words), and force those
 *   chunks back in under an explicit "these may conflict — do not silently pick
 *   one" header.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE re-running the impl):
 *
 *   CASE A — the real recorded failure. Feed the two REAL fixture files, run
 *   the REAL pricing_policy batch. The returned contextText must contain BOTH
 *   "5 kg per shade" (the table, which always won) AND "10 kg per shade" (the
 *   note, which never used to make it in), plus the conflict header.
 *
 *   CASE B — the sweep is not indiscriminate. A document whose rejected chunks
 *   contain no contradicting measurement must produce contradictionChunksUsed
 *   === 0 and a contextText with no header. (A retrieval "fix" that just
 *   appends everything would pass CASE A and fail here.)
 *
 *   CASE C — unit discipline. 5 kg vs 10 kg contradicts; 5 kg vs 5 kg does not;
 *   5 kg vs 10 metres does not (different unit, different thing entirely).
 *
 *   CASE D — subject discipline. Same unit and different value is NOT enough:
 *   two figures that share fewer than 2 meaningful subject words are unrelated
 *   facts, not a contradiction ("office open 10 hours" vs "delivery 5 hours").
 *
 *   CASE E — bounded. The sweep must never blow the context window: with many
 *   contradicting rejected chunks it must return at most maxChunks chunks and
 *   at most maxChars characters.
 *
 *   CASE F — the header tells the model what to DO. It must instruct that a
 *   genuine disagreement is reported, not silently resolved — that is the
 *   product rule (D6), and a header that merely says "more context" would let
 *   the model quietly pick a winner again.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CONTRADICTION_CONTEXT_HEADER,
  findContradictionCandidates,
  retrieveRelevantDocumentContext,
} from "@/services/DocumentContextRetrievalService";
import { createExtractionPlan } from "@/services/KnowledgeQuestionBatcher";

const FIXTURES = path.join(process.cwd(), "fixtures", "meghdoot-zari");
let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

function main() {
  console.log("golden-contradiction-retrieval — UA-4 root cause (batch-scoped retrieval hid a real contradiction)\n");

  // --- CASE A: the exact recorded failure, on the real fixture text ----------
  const policy = readFileSync(path.join(FIXTURES, "06-pricing-and-moq-policy.md"), "utf8");
  const notes = readFileSync(path.join(FIXTURES, "18-misc-sales-notes.txt"), "utf8");
  // The pipeline concatenates every source document into one documentText, then
  // slices it per batch — so this is exactly the input shape the real run had.
  const combined = `${policy}\n\n${notes}`;
  const plan = createExtractionPlan();
  const pricingBatch = plan.find((batch) => batch.domainKey === "pricing_policy");
  assert.ok(pricingBatch, "fixture check: the framework must still have a pricing_policy domain");

  check("CASE A — both MOQ figures reach the same context window", () => {
    const out = retrieveRelevantDocumentContext(combined, pricingBatch!);
    assert.ok(out.contextText.includes("5 kg per shade"), "the policy table's 5 kg must be in context (it always was)");
    assert.ok(
      out.contextText.includes("10 kg per shade"),
      "the notepad file's contradicting 10 kg must now ALSO be in context — this is the UA-4 regression",
    );
    assert.ok(out.contradictionChunksUsed > 0, "the sweep must report that it pulled a contradiction chunk in");
    assert.ok(out.contextText.includes(CONTRADICTION_CONTEXT_HEADER), "the extra text must be labelled as possibly conflicting");
  });

  check("CASE A2 — the pre-fix behaviour is what actually changed", () => {
    // Disabling the sweep must reproduce the ORIGINAL bug exactly. If this
    // assertion ever fails, the 10 kg line is arriving through plain relevance
    // ranking and CASE A is no longer proving anything.
    const off = retrieveRelevantDocumentContext(combined, pricingBatch!, { contradictionChunks: 0 });
    assert.ok(off.contextText.includes("5 kg per shade"), "sanity: ranking still selects the policy table");
    assert.ok(
      !off.contextText.includes("10 kg per shade"),
      "sanity: without the sweep, the notepad's 10 kg is still lost — otherwise this golden proves nothing",
    );
  });

  // --- CASE B: no contradiction present, nothing appended -------------------
  check("CASE B — a consistent document triggers no sweep", () => {
    const consistent = [
      "Minimum order for zari thread is 5 kg per shade.",
      "",
      "Our office is in Surat and we ship across India.",
      "",
      "Delivery to Mumbai takes 3 days by road transport.",
      "",
      "The packing team works from 9am. Boxes are sealed and labelled by hand.",
    ].join("\n");
    const out = retrieveRelevantDocumentContext(consistent, pricingBatch!);
    assert.strictEqual(out.contradictionChunksUsed, 0, "nothing contradicts, so nothing may be appended");
    assert.ok(!out.contextText.includes(CONTRADICTION_CONTEXT_HEADER), "no header when there is no candidate");
  });

  // --- CASE C: unit discipline ----------------------------------------------
  check("CASE C — same unit + different value contradicts; same value or other unit does not", () => {
    const context = "Minimum order quantity for zari thread is 5 kg per shade.";
    const differs = findContradictionCandidates(context, ["Note: minimum order zari thread is 10 kg per shade."]);
    assert.strictEqual(differs.length, 1, "5 kg vs 10 kg on the same subject is a contradiction");

    const agrees = findContradictionCandidates(context, ["Reminder: minimum order zari thread is 5 kg per shade."]);
    assert.strictEqual(agrees.length, 0, "5 kg vs 5 kg agrees — must not be flagged");

    const otherUnit = findContradictionCandidates(context, ["Minimum order zari thread rolls measure 10 metres per shade."]);
    assert.strictEqual(otherUnit.length, 0, "kg vs metres are different facts, not a disagreement");
  });

  // --- CASE D: subject discipline -------------------------------------------
  check("CASE D — same unit + different value on an unrelated subject is not a contradiction", () => {
    const context = "The office stays open 10 hours a day.";
    const unrelated = findContradictionCandidates(context, ["Courier pickup for Mumbai closes 5 hours after cutoff."]);
    assert.strictEqual(unrelated.length, 0, "two unrelated durations share <2 subject words — not a contradiction");

    const related = findContradictionCandidates(context, ["Correction: the office stays open 8 hours a day now."]);
    assert.strictEqual(related.length, 1, "same subject, same unit, different value — must be flagged");
  });

  // --- CASE E: bounded ------------------------------------------------------
  check("CASE E — the sweep is capped in both chunks and characters", () => {
    const context = "Minimum order quantity for zari thread is 5 kg per shade.";
    const many = Array.from({ length: 10 }, (_, i) => `Note ${i}: minimum order zari thread is ${20 + i} kg per shade. ${"filler ".repeat(120)}`);
    const capped = findContradictionCandidates(context, many, { maxChunks: 2, maxChars: 1500 });
    assert.ok(capped.length <= 2, `at most 2 chunks, got ${capped.length}`);
    assert.ok(capped.join("").length <= 1500, `at most 1500 chars, got ${capped.join("").length}`);
    assert.ok(capped.length > 0, "but it must still pull something in");

    const zero = findContradictionCandidates(context, many, { maxChunks: 0 });
    assert.strictEqual(zero.length, 0, "a zero budget disables the sweep entirely (used by CASE A2)");
  });

  // --- CASE F: the header carries the product rule --------------------------
  check("CASE F — the header instructs 'report the conflict', not 'pick one'", () => {
    const header = CONTRADICTION_CONTEXT_HEADER.toLowerCase();
    assert.ok(header.includes("conflict"), "header must name the thing being looked for");
    assert.ok(
      header.includes("do not silently choose") || header.includes("not silently"),
      "header must forbid silently resolving the disagreement (decision D6)",
    );
    assert.ok(header.includes("owner"), "header must say who decides — the business owner, not the model");
  });

  console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
  if (failed) {
    console.error("\nFAIL golden-contradiction-retrieval");
    process.exit(1);
  }
  console.log("PASS golden-contradiction-retrieval: contradicting figures in different source documents now reach the same LLM call.");
}

main();
