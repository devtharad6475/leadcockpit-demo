/**
 * golden-structured-settings-draft.ts — StructuredSettingsDraftService pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   StructuredSettingsDraftService turns a knowledge-Q&A answer into structured
 *   Sales/Policy/Communication setting drafts. It had NO golden test (DARK
 *   service). Two silent failures hurt: (1) an empty answer silently returns an
 *   empty draft with no guidance, so the operator thinks the draft worked; (2)
 *   the domainKey→field mapping can silently route a credit answer into the
 *   wrong field (or wrap a list answer into a scalar), corrupting the owner's
 *   approved settings. This pin locks the mapping table from
 *   questionToDraftTargets (StructuredSettingsDraftService.ts:12-39).
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — these are the rules, not the code):
 *
 *   CASE A — empty answer. draftStructuredSettingsFromAnswer({ answer: "" }) →
 *     warnings === ["Write an answer before creating settings drafts."], and
 *     fields === []. (Verified at line 52-55.)
 *
 *   CASE B — known domainKey + questionKey populates the RIGHT sales field with
 *     the documented label. domainKey="payment_credit_terms",
 *     questionKey="credit_period" maps to
 *       { area:"sales", fieldKey:"standardCreditPeriod", label:"Credit period" }
 *     (line 14). So result.sales.standardCreditPeriod === "30 days" and the
 *     emitted field carries label "Credit period".
 *
 *   CASE C — inputType:"list" targets wrap the answer in an array.
 *     domainKey="whatsapp_communication", questionKey="auto_reply_boundaries"
 *     maps to { area:"communication", fieldKey:"allowedAutoReplyTopics",
 *     inputType:"list" } (line 32). So the value is ["pricing, delivery"],
 *     NOT the bare string.
 *
 *   CASE D — relatedQuestionKeys FILTERING works: only matching targets return.
 *     domainKey="payment_credit_terms" has FOUR questionKeys (credit_period,
 *     gst_quotation_validity, advance_payment_rule, payment_methods,
 *     credit_allowed, credit_eligibility). Passing relatedQuestionKeys=["credit_period"]
 *     yields exactly ONE field (standardCreditPeriod), not the full set.
 *
 *   CASE E — unknown domainKey returns the documented "does not map" warning.
 *     domainKey="totally_unknown_domain_xyz" with a non-empty answer →
 *     fields === [] and warnings includes the literal
 *     "This answer does not map to a structured Sales, Policy, or Communication
 *      setting yet. It is still saved in Knowledge Base and the internal framework."
 *     (line 78.)
 *
 * REAL PIPELINE: imports the REAL draftStructuredSettingsFromAnswer from
 *   @/services/StructuredSettingsDraftService. No mocks. Each case builds its
 *   own literal input (Ironclad Gate #8 — clean slate per case).
 *
 * Run: `npm run golden:structured-settings-draft`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { draftStructuredSettingsFromAnswer } from "@/services/StructuredSettingsDraftService";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// --- CASE A: empty answer -----------------------------------------------------
test("CASE A — empty answer returns the documented warning + no fields", async () => {
  // Hand-computed: answer.trim() === "" → early return at line 52-55.
  const result = draftStructuredSettingsFromAnswer({
    domainKey: "payment_credit_terms",
    relatedQuestionKeys: ["credit_period"],
    answer: "",
  });
  assert.deepStrictEqual(result.fields, [], "empty answer yields zero draft fields");
  assert.ok(Array.isArray(result.warnings), "warnings is an array");
  assert.strictEqual(result.warnings.length, 1, "empty answer yields exactly one warning");
  assert.strictEqual(
    result.warnings[0],
    "Write an answer before creating settings drafts.",
    'empty-answer warning is the documented literal',
  );

  // Whitespace-only is ALSO empty (trimmed to "").
  const ws = draftStructuredSettingsFromAnswer({ domainKey: "x", answer: "   \n\t " });
  assert.deepStrictEqual(ws.fields, [], "whitespace-only yields zero fields");
  assert.strictEqual(ws.warnings[0], "Write an answer before creating settings drafts.", "whitespace-only yields same warning");
});

// --- CASE B: known domainKey/questionKey → right sales field + label ---------
test("CASE B — known domainKey (payment_credit_terms / credit_period) populates the right sales field with the documented label", async () => {
  // Mapping line 14: payment_credit_terms + credit_period →
  //   { area:"sales", fieldKey:"standardCreditPeriod", label:"Credit period" }.
  const result = draftStructuredSettingsFromAnswer({
    domainKey: "payment_credit_terms",
    relatedQuestionKeys: ["credit_period"],
    answer: "30 days",
  });
  assert.strictEqual(result.fields.length, 1, "exactly one field for credit_period");
  const field = result.fields[0];
  assert.strictEqual(field.area, "sales", "maps to the sales area");
  assert.strictEqual(field.fieldKey, "standardCreditPeriod", "maps to standardCreditPeriod fieldKey");
  assert.strictEqual(field.label, "Credit period", "carries the documented 'Credit period' label");
  // Value is a plain string (this target has NO inputType, so no array wrapping).
  assert.strictEqual(field.value, "30 days", "value is the raw answer string");
  // The sales object carries the same value under the fieldKey.
  assert.strictEqual(result.sales.standardCreditPeriod, "30 days", "result.sales.standardCreditPeriod === answer");
});

// --- CASE C: inputType:"list" wraps the answer in an array -------------------
test("CASE C — inputType:list target (whatsapp_communication / auto_reply_boundaries) wraps the answer in an array", async () => {
  // Mapping line 32: whatsapp_communication + auto_reply_boundaries →
  //   { area:"communication", fieldKey:"allowedAutoReplyTopics", inputType:"list" }.
  const result = draftStructuredSettingsFromAnswer({
    domainKey: "whatsapp_communication",
    relatedQuestionKeys: ["auto_reply_boundaries"],
    answer: "pricing, delivery timelines",
  });
  assert.strictEqual(result.fields.length, 1, "exactly one field for auto_reply_boundaries");
  const field = result.fields[0];
  assert.strictEqual(field.area, "communication", "maps to the communication area");
  assert.strictEqual(field.fieldKey, "allowedAutoReplyTopics", "maps to allowedAutoReplyTopics fieldKey");
  assert.strictEqual(field.label, "Allowed auto-reply topics", "carries the documented label");
  // inputType:"list" → value MUST be an array wrapping the WHOLE answer.
  assert.ok(Array.isArray(field.value), "list target value is an array");
  assert.deepStrictEqual(field.value, ["pricing, delivery timelines"], "list target wraps the full answer in a 1-element array");
  // Same on the communication object.
  assert.deepStrictEqual(
    result.communication.allowedAutoReplyTopics,
    ["pricing, delivery timelines"],
    "result.communication.allowedAutoReplyTopics is the wrapped array",
  );
});

// --- CASE D: relatedQuestionKeys filtering (only matching targets return) ----
test("CASE D — relatedQuestionKeys filtering returns only the matching target", async () => {
  // payment_credit_terms has multiple questionKeys. Passing ONLY credit_period
  // must yield exactly ONE field, not the whole domain's worth.
  const result = draftStructuredSettingsFromAnswer({
    domainKey: "payment_credit_terms",
    relatedQuestionKeys: ["credit_period"],
    answer: "30 days",
  });
  assert.strictEqual(result.fields.length, 1, "filter narrows to exactly 1 field");
  assert.strictEqual(result.fields[0].fieldKey, "standardCreditPeriod", "the filtered field is the credit_period mapping");
  // Contrast: passing NO relatedQuestionKeys returns ALL payment_credit_terms
  // targets — proves the filter is what narrows the set, not the domain itself.
  const all = draftStructuredSettingsFromAnswer({
    domainKey: "payment_credit_terms",
    answer: "30 days",
  });
  assert.ok(all.fields.length > 1, `unfiltered payment_credit_terms returns multiple targets (got ${all.fields.length})`);
});

// --- CASE E: unknown domainKey → documented "does not map" warning -----------
test("CASE E — unknown domainKey returns the documented 'does not map' warning", async () => {
  const result = draftStructuredSettingsFromAnswer({
    domainKey: "totally_unknown_domain_xyz",
    relatedQuestionKeys: ["any_question"],
    answer: "Some real answer text.",
  });
  assert.deepStrictEqual(result.fields, [], "unknown domainKey yields zero fields");
  assert.ok(result.warnings.length >= 1, "unknown domainKey yields at least one warning");
  assert.ok(
    result.warnings.includes(
      "This answer does not map to a structured Sales, Policy, or Communication setting yet. It is still saved in Knowledge Base and the internal framework.",
    ),
    "unknown-domainKey warning is the documented literal",
  );
  // And no area object was populated.
  assert.deepStrictEqual(result.sales, {}, "sales untouched for unknown domain");
  assert.deepStrictEqual(result.policy, {}, "policy untouched for unknown domain");
  assert.deepStrictEqual(result.communication, {}, "communication untouched for unknown domain");
});

// --- RUNNER ---------------------------------------------------------------------
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
  console.log("");
  console.log(`structured-settings-draft: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
