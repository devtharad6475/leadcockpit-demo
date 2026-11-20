import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { safeAnswerWording } from "@/services/SetupInterviewService";
import { brainPrompt } from "@/services/OwnerConversationBrain";

const cases: Array<[string, () => void]> = [
  ["quantity units cannot change while digits stay the same", () => {
    const own = "MOQ is 50 kg and delivery takes 7 days";
    assert.equal(safeAnswerWording("MOQ is 50 metres and delivery takes 7 hours", own).answer, own);
  }],
  ["quantity bindings cannot be exchanged", () => {
    const own = "MOQ is 50 kg and delivery takes 7 days";
    assert.equal(safeAnswerWording("MOQ is 7 kg and delivery takes 50 days", own).answer, own);
  }],
  ["negative promise cannot become a guarantee", () => {
    const own = "We cannot guarantee delivery in 7 days";
    assert.equal(safeAnswerWording("The company guarantees delivery in 7 days", own).answer, own);
  }],
  ["uncertain wording cannot become a commitment", () => {
    const own = "We may deliver in 7 days depending on stock";
    assert.equal(safeAnswerWording("The company will deliver in 7 days", own).answer, own);
  }],
  ["unprovided products and places are refused", () => {
    const own = "We manufacture cotton thread in Surat";
    assert.equal(safeAnswerWording("The company manufactures silk thread in Mumbai", own).answer, own);
  }],
  ["tidy wording and familiar unit spellings remain permitted", () => {
    assert.equal(safeAnswerWording("The company manufactures zari thread and also trades laces. It sells to businesses only.", "we make zari thread n also trade laces, only b2b").rewritten, true);
    assert.equal(safeAnswerWording("The MOQ is 50 kilograms and delivery takes 7 days.", "MOQ 50 kg, delivery takes 7 days").rewritten, true);
    assert.equal(safeAnswerWording("The limit is ₹2,00,000 for 30 days.", "limit 200000 rupees, 30 days").rewritten, true);
  }],
  ["exhausted unasked questions do not imply completed setup", () => {
    const prompt = brainPrompt({ history: [], ownerText: "What remains?", setupProgress: "4 of 12 business details still missing" });
    assert.ok(!prompt.includes("none — setup is complete"));
    assert.ok(prompt.includes("revisit"));
    assert.ok(brainPrompt({ history: [], ownerText: "What remains?", setupProgress: "0 of 12 business details still missing" }).includes("setup is complete"));
    assert.ok(!brainPrompt({ history: [], ownerText: "Hello" }).includes("none — setup is complete"));
  }],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
console.log(`setup-answer-grounding: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
