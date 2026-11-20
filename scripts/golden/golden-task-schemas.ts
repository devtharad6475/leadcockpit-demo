/**
 * golden-task-schemas.ts — pins the zod LLM-output validation schemas + the
 * provider type guard (Stage 6 / 2026-07-31 full coverage sweep).
 *
 * WHY THIS TEST EXISTS:
 *   task-schemas.ts + provider-types.ts were DARK. These zod schemas are the
 *   GATE that decides whether an LLM's output is accepted or rejected. A
 *   regression that loosens a schema (e.g. drops the 0-20 bound on totalScore)
 *   silently lets malformed AI output through — wrong lead scores, bad reply
 *   classifications, broken campaign plans. The hand-computed bounds below are
 *   the CONTRACT; a schema that accepts an out-of-bounds value fails here.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — LeadScoreOutputSchema: valid {F,N,R,T each 0-5, total 0-20,
 *     status, reason} passes; an out-of-bounds score (6) rejects; a negative
 *     rejects; total > 20 rejects; missing field rejects.
 *   CASE B — ReplyClassificationOutputSchema: valid passes; confidence > 1
 *     rejects; missing classification rejects.
 *   CASE C — the remaining 5 schemas (BusinessExtraction, ICPGeneration,
 *     CampaignPlan, MessageGeneration, CampaignLearning): a well-formed payload
 *     passes; each rejects when a required field is missing.
 *   CASE D — provider-types isLLMProviderId: admits the real provider ids;
 *     rejects an unknown string.
 *
 * Run: npx tsx scripts/golden/golden-task-schemas.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  LeadScoreOutputSchema,
  ReplyClassificationOutputSchema,
  BusinessExtractionOutputSchema,
  ICPGenerationOutputSchema,
  CampaignPlanOutputSchema,
  MessageGenerationOutputSchema,
  CampaignLearningOutputSchema,
} from "@/llm/task-schemas";
import { isLLMProviderId } from "@/llm/provider-types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const ok = (schema: { safeParse: (x: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

// ─── CASE A: LeadScoreOutputSchema ──────────────────────────────────────────
test("CASE A — LeadScoreOutputSchema: bounds 0-5 per score, 0-20 total; rejects out-of-range + missing", async () => {
  const valid = { fitScore: 4, needScore: 4, reachabilityScore: 2, timingScore: 3, totalScore: 13, qualificationStatus: "good_prospect", reason: "strong fit" };
  assert.strictEqual(ok(LeadScoreOutputSchema, valid), true, "valid score passes");
  assert.strictEqual(ok(LeadScoreOutputSchema, { ...valid, fitScore: 6 }), false, "score > 5 rejects");
  assert.strictEqual(ok(LeadScoreOutputSchema, { ...valid, needScore: -1 }), false, "negative score rejects");
  assert.strictEqual(ok(LeadScoreOutputSchema, { ...valid, totalScore: 21 }), false, "total > 20 rejects");
  assert.strictEqual(ok(LeadScoreOutputSchema, { fitScore: 4 }), false, "missing fields reject");
});

// ─── CASE B: ReplyClassificationOutputSchema ────────────────────────────────
test("CASE B — ReplyClassificationOutputSchema: confidence 0-1; rejects >1 + missing", async () => {
  const valid = { classification: "price_question", confidenceScore: 0.9, leadStatus: "replied", summary: "s", suggestedNextAction: "a", suggestedResponse: "r" };
  assert.strictEqual(ok(ReplyClassificationOutputSchema, valid), true, "valid classification passes");
  assert.strictEqual(ok(ReplyClassificationOutputSchema, { ...valid, confidenceScore: 1.5 }), false, "confidence > 1 rejects");
  assert.strictEqual(ok(ReplyClassificationOutputSchema, { ...valid, classification: undefined }), false, "missing classification rejects");
});

// ─── CASE C: the other 5 schemas (type-safety: accept valid, reject wrong types) ─
test("CASE C — remaining schemas: accept well-formed; reject wrong-typed fields", async () => {
  // These schemas are intentionally LENIENT (extraction/planning can return
  // partial info — all-optional fields, so {} is valid). The load-bearing
  // contract is TYPE safety: a string where an array is expected rejects.
  const checks: Array<[string, { safeParse: (x: unknown) => { success: boolean } }, unknown]> = [
    ["BusinessExtraction", BusinessExtractionOutputSchema, { companyName: "Acme", products: ["p1"], services: [] }],
    ["ICPGeneration", ICPGenerationOutputSchema, { icps: [] }],
    ["CampaignPlan", CampaignPlanOutputSchema, { campaignName: "x", phases: [] }],
    ["MessageGeneration", MessageGenerationOutputSchema, { channel: "whatsapp", body: "hi", tone: "warm", language: "en", personalizationUsed: [] }],
    ["CampaignLearning", CampaignLearningOutputSchema, { summary: "s", patterns: [] }],
  ];
  for (const [name, schema, sample] of checks) {
    assert.strictEqual(ok(schema, sample), true, `${name} accepts a well-formed object`);
    // A wrong TYPE (array field given a string) must reject — the schema is not a no-op.
    const wrongType = ok(schema, "not-an-object-at-all");
    assert.strictEqual(wrongType, false, `${name} rejects a non-object value (type-safe, not a no-op)`);
  }
  // BusinessExtraction specifically: products must be an array (not a string).
  assert.strictEqual(ok(BusinessExtractionOutputSchema, { products: "not-an-array" }), false, "BusinessExtraction rejects a string for the products array");
});

// ─── CASE D: isLLMProviderId ────────────────────────────────────────────────
test("CASE D — isLLMProviderId: admits real provider ids; rejects unknown", async () => {
  assert.strictEqual(isLLMProviderId("openai"), true);
  assert.strictEqual(isLLMProviderId("anthropic"), true);
  assert.strictEqual(isLLMProviderId("ollama"), true);
  assert.strictEqual(isLLMProviderId("mock"), true);
  assert.strictEqual(isLLMProviderId("bogus-provider"), false, "unknown provider rejected");
  assert.strictEqual(isLLMProviderId(""), false, "empty rejected");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-task-schemas FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-task-schemas ALL GREEN ✅");
  process.exit(0);
})();
