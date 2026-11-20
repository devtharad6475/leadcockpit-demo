import "./_helpers/isolate-standalone";
import "./_helpers/no-platform-ai-keys";
import assert from "node:assert/strict";
import { createRepositories } from "@/repositories";
import { LLMService } from "@/llm/LLMService";
import { confirmCopilotBigJob } from "@/services/OwnerCopilotService";

async function main() {
  const repos = createRepositories("json");
  const workspaceId = "week_six_reports";
  await repos.workspace.create({ id: workspaceId, name: "Synthetic analysis fixture" });
  const campaign = await repos.campaign.create({ workspaceId, name: "Local campaign" });
  await repos.lead.createLead({ workspaceId, campaignId: campaign.id, status: "won" });
  await repos.campaignMetric.create({ workspaceId, campaignId: campaign.id, metricName: "replies", metricValue: 3 });
  await repos.campaign.create({ workspaceId: "foreign_reports", name: "Never include this company" });
  const original = LLMService.prototype.runTask;
  let calls = 0;
  async function run(intent: string, output: unknown, fail = false) {
    const conversation = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId: "owner" });
    const pendingActionId = `report_${++calls}`;
    await repos.ownerCopilotMessage.create({ workspaceId, conversationId: conversation.id, role: "copilot", kind: "copilot_confirm", tier: "T3", language: "en", text: "Run the analysis?", pendingAction: { intent, entityId: pendingActionId, entityType: "icp", request: "Analyze reusable packaging" } });
    LLMService.prototype.runTask = (async (task: string, payload: Record<string, unknown>) => {
      assert.equal(task, intent);
      if (task === "campaign_learning") {
        const context = payload as { campaigns: {id: string}[]; outcomes: {metrics: {metricValue: number}[]; customers: {status: string}[]}[] };
        assert.equal(context.campaigns.length, 1);
        assert.equal(context.campaigns[0].id, campaign.id);
        assert.equal(context.outcomes[0].metrics[0].metricValue, 3);
        assert.equal(context.outcomes[0].customers[0].status, "won");
      }
      if (fail) throw new Error("Synthetic provider outage");
      return { output, mode: "real", fallbackUsed: false, provider: "fixture", modelTier: "workhorse" };
    }) as unknown as typeof original;
    const result = await confirmCopilotBigJob({ workspaceId, ownerUserId: "owner", conversationId: conversation.id, intent, pendingActionId, repos });
    assert.equal(result.kind, "copilot_info");
    assert.doesNotMatch(result.text, /Research done|confidenceScore|0\.87|\{"/);
    const saved = await repos.ownerCopilotMessage.listByConversation(workspaceId, conversation.id);
    assert.equal(saved.at(-1)?.text, result.text);
    assert.equal(saved.at(-1)?.kind, "copilot_info");
    return result.text;
  }
  try {
    const campaignText = await run("campaign_learning", { summary: "Three replies were recorded.", winningPatterns: ["Review the saved won buyer."], losingPatterns: [], recommendedNextSteps: ["Review before changing the campaign."], confidenceScore: 0.87 });
    assert.match(campaignText, /Three replies|Review the saved won buyer/);
    assert.match(campaignText, /saved company campaign records only/);
    const productText = await run("product_application_research", { applications: ["Reusable packaging"], buyerSegments: [{ segment: "Packaging buyers", why: "They may reuse materials", channels: ["Company websites"] }], marketNotes: "Validate demand first", confidenceScore: 0.87 });
    assert.match(productText, /Packaging buyers|Reusable packaging/);
    assert.match(productText, /unverified analysis; no web sources were checked/);
    const embeddingText = await run("embedding", { preparedText: "Approved text to prepare", estimatedTokens: 4, embeddingModelNeeded: "Dedicated embedding model", ready: true });
    assert.match(embeddingText, /No vector embedding was generated or saved/);
    for (const intent of ["campaign_learning", "product_application_research", "embedding"]) {
      assert.match(await run(intent, { summary: "Wrong output shape" }), /not available/);
      assert.match(await run(intent, undefined, true), /not available/);
    }
    assert.equal((await repos.campaign.listByWorkspace(workspaceId)).length, 1);
    console.log("PASS Week 6 report honesty: 3 readable schema outputs, 3 malformed refusals, 3 outage refusals; scoped campaign outcome context, no raw scores or fake research/vector success");
  } finally { LLMService.prototype.runTask = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
