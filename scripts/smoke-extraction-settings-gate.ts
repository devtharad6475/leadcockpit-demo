/**
 * smoke-extraction-settings-gate.ts — Phase 2.1 acceptance test
 *
 * Proves that sensitive extracted settings (payment, credit, delivery, returns,
 * pricing) create a REVIEW CARD (SettingsConflict) instead of being written
 * directly to settings. Non-sensitive settings (e.g. tone, language) still
 * fill directly when empty.
 */
import { routeExtractedFactsToSettings } from "../src/services/ExtractionRoutingService";
import { createRepositories } from "../src/repositories";
import { readData, mutateData, uid, timestamp } from "../src/lib/db";
import type { KnowledgeQuestionAnswer } from "../src/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const WS = "workspace_demo";

function makeAnswer(domainKey: string, questionKey: string, answer: string): KnowledgeQuestionAnswer {
  return {
    id: uid("qa"), workspaceId: WS, domainKey, questionKey,
    question: questionKey, answer, answerStatus: "answered",
    sourceType: "document", isUserApproved: false, confidenceScore: 0.8,
    evidenceJson: { sources: [] }, isCanonical: true, conflictWithExisting: false,
    createdAt: timestamp(), updatedAt: timestamp(),
  } as unknown as KnowledgeQuestionAnswer;
}

async function main() {
  console.log("smoke-extraction-settings-gate: testing sensitive-settings gate...\n");

  // Reset relevant state
  await mutateData((data) => {
    data.settingsConflicts = [];
    // M3.3 / pre-existing test-isolation fix: clear ALL sales/policy/
    // communication settings records for this workspace, not just append a
    // new one. Previously the smoke pushed a new record with a fresh uid
    // each run while leaving the seeded record (which already had
    // standardCreditPeriod, tone, etc. populated) intact. getByWorkspace
    // then returned the seeded record, so the "empty field" path was never
    // actually tested — masking real regressions on both the gate logic
    // and the test itself.
    data.salesSettings = (data.salesSettings || []).filter((s) => s.workspaceId !== WS);
    data.policySettings = (data.policySettings || []).filter((s) => s.workspaceId !== WS);
    data.companyCommunicationSettings = (data.companyCommunicationSettings || []).filter((s) => s.workspaceId !== WS);
    return true;
  });

  const repos = createRepositories();

  // Now upsert fresh empty records. Because we cleared above, these are the
  // only records for this workspace.
  await repos.salesSettings.upsertForWorkspace(WS, { id: uid("sales"), workspaceId: WS, createdAt: timestamp(), updatedAt: timestamp() } as Record<string, unknown>);
  await repos.policySettings.upsertForWorkspace(WS, { id: uid("policy"), workspaceId: WS, createdAt: timestamp(), updatedAt: timestamp() } as Record<string, unknown>);
  await repos.communicationSettings.upsertForWorkspace(WS, { id: uid("communication"), workspaceId: WS, tone: "", createdAt: timestamp(), updatedAt: timestamp() } as Record<string, unknown>);

  const answers = [
    // SENSITIVE: credit period — must create review card, NOT write directly
    makeAnswer("payment_credit_terms", "credit_period", "Net 30 days"),
    // SENSITIVE: delivery — must create review card
    makeAnswer("shipping_delivery", "delivery_timelines", "7-10 business days"),
    // SENSITIVE: advance payment — must create review card
    makeAnswer("payment_credit_terms", "advance_payment_rule", "50% advance required"),
    // NON-SENSITIVE: communication tone — should fill directly
    makeAnswer("whatsapp_communication", "preferred_tone", "Professional and friendly"),
  ];

  const result = await routeExtractedFactsToSettings(WS, answers, "test-extraction", repos);

  console.log("  Result:", JSON.stringify(result, null, 2));

  // Sensitive fields → conflict (review card), NOT filled
  const sensitiveConflicts = result.details.filter((d) => d.fieldKey === "standardCreditPeriod" || d.fieldKey === "shippingDeliveryPolicy" || d.fieldKey === "advancePaymentRule");
  assert(sensitiveConflicts.every((d) => d.action === "conflict"), "Sensitive fields should create review cards (action=conflict), not fill directly");
  assert(sensitiveConflicts.length === 3, `Expected 3 sensitive conflicts, got ${sensitiveConflicts.length}`);
  console.log("  OK sensitive fields (credit, delivery, advance payment) -> review cards, not direct write");

  // Non-sensitive field → filled directly
  const toneDetail = result.details.find((d) => d.fieldKey === "tone");
  assert(toneDetail && toneDetail.action === "filled", `Non-sensitive field (tone) should fill directly, got ${toneDetail?.action}`);
  console.log("  OK non-sensitive field (tone) -> filled directly");

  // Verify the review cards exist in storage
  const data = await readData();
  const conflicts = (data.settingsConflicts || []).filter((c) => c.workspaceId === WS);
  const sensitiveConflictFields = conflicts.map((c) => c.fieldKey);
  assert(sensitiveConflictFields.includes("standardCreditPeriod"), "Credit period review card should exist");
  assert(sensitiveConflictFields.includes("shippingDeliveryPolicy"), "Delivery review card should exist");
  assert(sensitiveConflictFields.includes("advancePaymentRule"), "Advance payment review card should exist");
  console.log("  OK review cards created in storage for all 3 sensitive fields");

  // Verify the sensitive settings were NOT written to the actual settings
  const sales = await repos.salesSettings.getByWorkspace(WS) as Record<string, unknown> | undefined;
  assert(!sales?.standardCreditPeriod || sales.standardCreditPeriod === "", "Credit period should NOT be written directly to settings");
  assert(!sales?.advancePaymentRule || sales.advancePaymentRule === "", "Advance payment should NOT be written directly to settings");
  const policy = await repos.policySettings.getByWorkspace(WS) as Record<string, unknown> | undefined;
  assert(!policy?.shippingDeliveryPolicy || policy.shippingDeliveryPolicy === "", "Delivery policy should NOT be written directly to settings");
  console.log("  OK sensitive values NOT written to settings (owner must approve)");

  console.log("\nsmoke-extraction-settings-gate: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error("\nsmoke-extraction-settings-gate FAILED:", error.message);
  process.exit(1);
});
