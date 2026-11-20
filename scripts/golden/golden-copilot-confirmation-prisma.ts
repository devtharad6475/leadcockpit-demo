// PRISMA_GOLDEN — run only on the disposable readiness database, never hosted.
import "./_helpers/readiness-prisma-environment";
import { readinessFixtureCleanup } from "./_helpers/readiness-fixture-cleanup";
import assert from "node:assert/strict";
import { repositories as repos } from "@/repositories";
import { prisma } from "@/lib/prisma";

const fixtures = readinessFixtureCleanup();
fixtures.attach(repos);
async function main() {
  const workspace = await repos.workspace.create({ name: "Disposable confirmation", status: "active" });
  const conversation = await repos.ownerCopilotConversation.create({ workspaceId: workspace.id, ownerUserId: "fixture_owner" });
  const proposal = await repos.ownerCopilotMessage.create({ workspaceId: workspace.id, conversationId: conversation.id, role: "copilot", kind: "copilot_confirm", tier: "T3", text: "Plan a campaign?", pendingAction: { intent: "campaign_planning", entityId: "pending_atomic", entityType: "campaign" } });
  const input = { workspaceId: workspace.id, conversationId: conversation.id, ownerUserId: "fixture_owner", proposalMessageId: proposal.id, pendingActionId: "pending_atomic", intent: "campaign_planning", text: "Yes, go ahead.", language: "en" as const };
  // Calls reach the repository directly, bypassing the service's process lock.
  const results = await Promise.all([repos.ownerCopilotMessage.claimConfirmation(input), repos.ownerCopilotMessage.claimConfirmation(input)]);
  assert.deepEqual([...results].sort(), [false, true]);
  assert.equal((await repos.ownerCopilotMessage.listByConversation(workspace.id, conversation.id)).filter(row => row.role === "owner").length, 1);
  console.log("PASS actual Postgres concurrent claim appends exactly one approval");
  assert.equal(await repos.ownerCopilotMessage.claimConfirmation(input), false);
  assert.equal(await repos.ownerCopilotMessage.claimConfirmation({ ...input, ownerUserId: "stranger" }), false);
  console.log("PASS persisted replay and wrong owner rejected");
  const second = await repos.ownerCopilotMessage.create({ workspaceId: workspace.id, conversationId: conversation.id, role: "copilot", kind: "copilot_confirm", tier: "T3", text: "Another plan?", pendingAction: { intent: "campaign_planning", entityId: "pending_rollback", entityType: "campaign" } });
  const retry = { ...input, proposalMessageId: second.id, pendingActionId: "pending_rollback" };
  await prisma.$executeRawUnsafe("CREATE FUNCTION readiness_reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role = 'owner' THEN RAISE EXCEPTION 'injected confirmation write failure'; END IF; RETURN NEW; END $$");
  await prisma.$executeRawUnsafe('CREATE TRIGGER readiness_reject_confirmation BEFORE INSERT ON owner_copilot_messages FOR EACH ROW EXECUTE FUNCTION readiness_reject_confirmation()');
  try { await assert.rejects(() => repos.ownerCopilotMessage.claimConfirmation(retry)); }
  finally { await prisma.$executeRawUnsafe('DROP TRIGGER readiness_reject_confirmation ON owner_copilot_messages'); await prisma.$executeRawUnsafe('DROP FUNCTION readiness_reject_confirmation()'); }
  assert.equal(await repos.ownerCopilotMessage.claimConfirmation(retry), true);
  console.log("PASS failed approval write rolls back; safe retry succeeds");
  console.log("3 passed, 0 failed on disposable PostgreSQL");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await fixtures.cleanup(); } finally { await prisma.$disconnect(); } });
