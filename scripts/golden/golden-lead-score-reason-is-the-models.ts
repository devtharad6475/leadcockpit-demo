/**
 * Golden test — the reason stored against a lead's score is the one the model
 * gave, and the record does not credit the model with numbers it never
 * produced.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo after discovering fifty-three real Surat embroidery
 * businesses through the product's own Discovery screen. Every one of the
 * fifty-three carried the same justification:
 *
 *   scoreReason.reason:   "Found from Google Maps query \"zari work manufacturer
 *                          Surat Gujarat\". Review before outreach."
 *   scoreReason.provider: "deepseek"
 *   scoreReason.mode:     "real"
 *   scoreReason.fallbackUsed: false
 *
 * That sentence is the discovery template. The model never wrote it. Two
 * separate faults put it there:
 *
 *   1. `leadScoringPrompt` asks the model to return `reason`. `ScoreOutput`
 *      had no `reason` field and `qualifyLead` read `fitReason`, so the
 *      model's actual reasoning was parsed and thrown away on every run, and
 *      the template took its place — beside a record saying deepseek produced
 *      it in real mode.
 *
 *   2. `fallbackUsed` was computed from the CALL, not from the OUTPUT. A call
 *      that succeeds and returns prose, or JSON with no scores in it, leaves
 *      all four numbers heuristic while the record still reports a real
 *      provider and no fallback. The operator reads "AI scored this 15/20"
 *      about four numbers a regex produced.
 *
 *   CASE A — the prompt's field name is one the parser reads. This is the
 *     actual defect: a prompt and a parser that disagree lose the answer
 *     silently, and no type error is possible because the output is untyped
 *     JSON.
 *
 *   CASE B — a model reason is preferred over the discovery template.
 *
 *   CASE C — with no model reason, the discovery note is still used rather
 *     than nothing. Losing it would leave the operator with a blank.
 *
 *   CASE D — when the model returns no scores, the lead is NOT scored.
 *     (2026-09-25: this used to record the rule's numbers as "heuristic"; lead
 *     scoring is now AI only, so no numbers are credited to anyone - see
 *     golden-lead-scoring-is-ai-only for the behaviour.)
 *
 * Substrate: static read of the prompt and the service, plus the service's own
 * precedence expression. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const PROMPT = "src/llm/prompts/leadScoringPrompt.ts";
const SERVICE = "src/services/ProspectingService.ts";

/** The same precedence `qualifyLead` applies, so the cases can exercise it. */
function pickReason(
  llmOutput: { fitReason?: string; reason?: string },
  candidateFitReason: string,
) {
  return String(llmOutput.fitReason || llmOutput.reason || candidateFitReason || "");
}

function main() {
  console.log("=== GOLDEN: the score's reason is the model's, and the record is honest ===\n");

  const prompt = readSource(PROMPT);
  const service = readSource(SERVICE);

  // ---------------------------------------------------------------- CASE A
  {
    // Every field the prompt tells the model to return must be one the parser
    // can read, or the answer is dropped without an error anywhere.
    const asked: string[] = prompt.match(/\b(fitScore|needScore|reachabilityScore|timingScore|fitReason|reason)\b/g) || [];
    assert(asked.includes("reason"), `CASE A setup: ${PROMPT} no longer asks for a reason at all`);
    const scoreOutput = service.slice(service.indexOf("type ScoreOutput"), service.indexOf("};", service.indexOf("type ScoreOutput")));
    for (const field of Array.from(new Set(asked))) {
      assert(
        new RegExp(`\\b${field}\\?:`).test(scoreOutput),
        `CASE A: the prompt asks the model for "${field}" but ScoreOutput cannot hold it — the answer is parsed and dropped`,
      );
    }
    assert(
      /llmOutput\.fitReason \|\| llmOutput\.reason/.test(service),
      `CASE A: ${SERVICE} must read the reason the prompt actually asks for`,
    );
    console.log(`✅ CASE A — every field the prompt asks for is one the parser reads (${Array.from(new Set(asked)).join(", ")})`);
  }

  // ---------------------------------------------------------------- CASE B
  {
    const template = 'Found from Google Maps query "zari work manufacturer Surat Gujarat". Review before outreach.';
    const modelText = "Runs 12 multi-head embroidery machines on job work for Surat saree houses; buys metallic thread by the carton.";
    const picked = pickReason({ reason: modelText }, template);
    assert(picked === modelText, `CASE B: the model's own reason must win, got ${JSON.stringify(picked)}`);
    console.log("✅ CASE B — the model's reason is what gets stored");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const template = 'Found from Google Maps query "embroidery job work Katargam Surat". Review before outreach.';
    const picked = pickReason({}, template);
    assert(picked === template, `CASE C: with no model reason the discovery note must still be kept, got ${JSON.stringify(picked)}`);
    assert(/String\(llmOutput\.fitReason \|\| llmOutput\.reason \|\| candidate\.fitReason \|\| ""\)/.test(service), "CASE C: the service must use this same precedence");
    console.log("✅ CASE C — with no model reason the operator still gets a sentence, never a blank");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /const aiScored = numbers\.every\(Number\.isFinite\) && llmMeta\.mode === "real" && !llmMeta\.fallbackUsed;/.test(service),
      `CASE D: ${SERVICE} must only count a score the real model produced, from the OUTPUT not the call`,
    );
    assert(!/heuristicScores|scoresFrom: modelScored/.test(service), "CASE D: the rule-based scorer must be gone");
    console.log("✅ CASE D — a lead is scored only when the real model returned the numbers");
  }

  console.log("\n=== GOLDEN PASSED (A-D) ===");
}

main();
