import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { confirmCopilotBigJob, handleOwnerCopilotTurn } from "@/services/OwnerCopilotService";
import { LLMService } from "@/llm/LLMService";

async function main() {
  const repos = createJsonRepos();
  await repos.workspace.create({ id: "ws_confirm", name: "Confirmation fixture", status: "active" });
  const conversation = await repos.ownerCopilotConversation.create({ workspaceId: "ws_confirm", ownerUserId: "owner_confirm" });
  const other = await repos.ownerCopilotConversation.create({ workspaceId: "ws_confirm", ownerUserId: "owner_confirm" });
  const input = { workspaceId: "ws_confirm", ownerUserId: "owner_confirm", conversationId: conversation.id, repos, intent: "campaign_planning", pendingActionId: "forged" };
  let passed = 0;
  async function rejectsUnchanged(overrides: Partial<typeof input>, name: string) {
    const before = (await repos.ownerCopilotMessage.listByConversation(input.workspaceId, conversation.id)).length;
    await assert.rejects(() => confirmCopilotBigJob({ ...input, ...overrides }));
    assert.equal((await repos.ownerCopilotMessage.listByConversation(input.workspaceId, conversation.id)).length, before, "Invalid confirmation must not write an approval bubble");
    console.log(`PASS ${name}`); passed++;
  }
  await rejectsUnchanged({}, "forged id without proposal");
  const proposal = await handleOwnerCopilotTurn({ ...input, ownerText: "plan a campaign", conversationBrain: false });
  assert.equal(proposal.kind, "copilot_confirm");
  input.pendingActionId = proposal.pendingAction!.entityId!;
  await rejectsUnchanged({ intent: "icp_generation" }, "mismatched intent");
  await rejectsUnchanged({ conversationId: other.id }, "another conversation");
  await rejectsUnchanged({ ownerUserId: "another_owner" }, "another owner");
  await rejectsUnchanged({ workspaceId: "another_workspace" }, "another workspace");
  const results = await Promise.allSettled([confirmCopilotBigJob(input), confirmCopilotBigJob(input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  console.log("PASS concurrent confirmation only runs once"); passed++;
  await rejectsUnchanged({}, "persisted replay rejected");
  const ownerApprovals = (await repos.ownerCopilotMessage.listByConversation(input.workspaceId, conversation.id)).filter(message => message.role === "owner" && message.pendingAction?.entityId === input.pendingActionId);
  assert.equal(ownerApprovals.length, 1);
  const resolvedRequest = "Research industrial applications for copper and brass thread";
  const rewritten = await handleOwnerCopilotTurn({ ...input, ownerText: "and those two?", conversationBrain: async () => ({ real: true, output: { intent: "research", request: resolvedRequest, reply: "" } }) });
  assert.equal(rewritten.kind, "copilot_confirm");
  assert.equal(rewritten.pendingAction?.request, resolvedRequest, "The resolved research topic must be persisted with the proposal");
  console.log("PASS conversation rewrite saved with proposed job"); passed++;
  const original = LLMService.prototype.runTask;
  const topics: unknown[] = [];
  LLMService.prototype.runTask = (async (_task: unknown, payload: { topic?: string }) => { topics.push(payload.topic); return { output: { summary: "Offline research fixture" }, mode: "mock", fallbackUsed: false, provider: "mock", modelTier: "workhorse" }; }) as unknown as typeof original;
  try {
    await repos.ownerCopilotMessage.create({ workspaceId: input.workspaceId, conversationId: input.conversationId, role: "owner", kind: "owner_input", text: "and those two?" });
    await repos.ownerCopilotMessage.create({ workspaceId: input.workspaceId, conversationId: input.conversationId, role: "copilot", kind: "copilot_confirm", tier: "T3", language: "hi", text: "शोध करूँ?", pendingAction: { intent: "product_application_research", entityId: "research_saved_request", entityType: "icp", request: "Research industrial applications for copper and brass thread" } });
    await repos.ownerCopilotMessage.create({ workspaceId: input.workspaceId, conversationId: input.conversationId, role: "owner", kind: "owner_input", text: "Unrelated later question" });
    const result = await confirmCopilotBigJob({ ...input, pendingActionId: "research_saved_request", intent: "product_application_research" });
    assert.deepEqual(topics, ["Research industrial applications for copper and brass thread"]);
    assert.equal(result.language, "hi");
    assert.equal(result.aiStatus, "mock");
    console.log("PASS saved resolved research request and language retained"); passed++;
  } finally { LLMService.prototype.runTask = original; }
  console.log(`${passed} passed, 0 failed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
