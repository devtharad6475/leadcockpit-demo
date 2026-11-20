/**
 * golden-abusive-message-rule.ts — the owner's answer to "what do you do with
 * an abusive customer?" lands where the AI reads it as an instruction
 * (2026-09-24).
 *
 * It used to be written into `humanReviewRequiredTopics`, a list of TOPICS,
 * although the answer is a sentence about BEHAVIOUR ("do not argue, hand the
 * chat to a person"). Stored there it was a one-item "topic" the AI could not
 * act on, and it sat next to a near-copy of the complaint rule.
 *
 *   CASE A — extraction writes the answer to `abusiveMessageRule`, verbatim,
 *            and leaves the human-review topics untouched.
 *   CASE B — the settings draft (Information Needed → settings) proposes the
 *            same field, as text, not as a one-item list.
 *   CASE C — the AI's context carries the rule.
 *   CASE D — an abusive message still goes to a person: the rule changes what
 *            the AI is told, never whether a human reviews it.
 *
 * Run: npx tsx scripts/golden/golden-abusive-message-rule.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { routeExtractedFactsToSettings } from "@/services/ExtractionRoutingService";
import { draftStructuredSettingsFromAnswer } from "@/services/StructuredSettingsDraftService";
import { classifyCustomerMessage } from "@/conversations/message-classification";
import type { KnowledgeQuestionAnswer } from "@/lib/types";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
const WS = `ws_abuse_${Date.now()}`;
const RULE = "Do not answer in kind and do not argue. Stop replying and hand the conversation to a person immediately.";

test("CASE A — extraction writes the rule to its own field, not to the topics list", async () => {
  await repos.communicationSettings.upsertForWorkspace(WS, { humanReviewRequiredTopics: ["price", "credit"] });
  const answer = { workspaceId: WS, domainKey: "whatsapp_communication", questionKey: "abusive_customer_handling", answer: RULE } as unknown as KnowledgeQuestionAnswer;
  const result = await routeExtractedFactsToSettings(WS, [answer], "website", repos);
  const after = await repos.communicationSettings.getByWorkspace(WS);
  assert.strictEqual(after?.abusiveMessageRule, RULE);
  assert.deepStrictEqual(after?.humanReviewRequiredTopics, ["price", "credit"], "the topics list is not touched");
  assert.deepStrictEqual(result.details.map((d) => d.fieldKey), ["abusiveMessageRule"]);
});

test("CASE B — the settings draft proposes the same field, as text", async () => {
  const draft = draftStructuredSettingsFromAnswer({ domainKey: "whatsapp_communication", relatedQuestionKeys: ["abusive_customer_handling"], answer: RULE });
  assert.deepStrictEqual(draft.communication, { abusiveMessageRule: RULE });
});

test("CASE C — the AI's context carries the rule", async () => {
  const { buildAgentWorkspaceContext, formatAgentContext } = await import("@/services/AgentContextBuilder");
  const context = formatAgentContext(await buildAgentWorkspaceContext(WS, repos));
  assert.ok(context.includes(RULE), "the owner's instruction must reach the AI");
});

test("CASE D — an abusive message still needs a person", async () => {
  const verdict = classifyCustomerMessage("you are a fraud, idiot, I will ruin your business");
  assert.strictEqual(verdict.category, "abusive_message");
  assert.ok(verdict.requiresHumanReview, "the rule never replaces the human hand-off");
});

(async () => {
  console.log("\n=== GOLDEN: the abusive-customer rule reaches the AI as an instruction ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: abusive-message-rule");
    process.exit(1);
  }
})();
