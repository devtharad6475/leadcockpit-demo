/**
 * golden-master-team.ts — the four helpers added to the master AI's team, and
 * the four unused agents removed (2026-09-25).
 *
 *   CASE A — the team is the eight helpers, each with tools it may use, and the
 *            master's planning prompt names every one of them.
 *   CASE B — no helper on the team holds a tool that writes, sends, approves or
 *            rejects. The only tool that spends beyond AI calls is research_market.
 *   CASE C — the web-search allowance holds however the model asks: three
 *            searches requested in one turn against an allowance of six run at
 *            most two, and with no allowance none runs.
 *   CASE D — the plan tells the owner the most web searches it can make, and a
 *            plan without the researcher says none.
 *   CASE E — a lead's profile says whether we have a phone or e-mail, never
 *            the number or address.
 *   CASE F — the owner's "not for" rules reach the lead reviewer; archived
 *            customer types do not.
 *   CASE G — campaign results are counted from what happened, per campaign.
 *   CASE H — the four removed agents are gone from every list that offered
 *            them, and every remaining agent still has its instruction file.
 *
 * No billed call: every AI and search key is blanked before anything loads, so
 * the research tool plans with the mock and searches nothing.
 *
 * Run: npx tsx scripts/golden/golden-master-team.ts
 */
for (const name of [
  "PLATFORM_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY", "PLATFORM_OPENAI_API_KEY", "OPENAI_API_KEY",
  "PLATFORM_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "PLATFORM_GEMINI_API_KEY", "GEMINI_API_KEY",
  "PLATFORM_KIMI_API_KEY", "KIMI_API_KEY", "PLATFORM_MINIMAX_API_KEY", "MINIMAX_API_KEY",
  "PLATFORM_SERPAPI_API_KEY", "SERPAPI_API_KEY",
]) process.env[name] = "";

import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { createJsonRepos } from "./_helpers/provider";
import { SUBORDINATES } from "@/agents/subordinates";
import { getTool, toolsForAgent, MARKET_RESEARCH_QUERIES } from "@/agents/tool-registry";
import { maxSearchesFor, plannerPrompt, type Plan } from "@/agents/Orchestrator";
import { AGENT_NAMES } from "@/constants/agents";
import { taskAgentMap } from "@/agents/AgentRuntime";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let n = 0;
const freshWs = () => `ws_team_${Date.now()}_${(n += 1)}`;

const TEAM = [
  "crm-researcher", "lead-scoring-agent", "knowledge-base-agent", "outreach-drafter",
  "quality-review-agent", "campaign-learning-agent", "lead-review-agent", "product-application-research-agent",
];
/** Tools that only read. Anything else on a helper must be argued for here. */
const READ_ONLY = new Set([
  "search_knowledge_base", "get_lead_history", "find_leads", "get_lead_profile", "get_ideal_customers",
  "get_campaign_results", "ask_knowledge_agent", "ask_lead_scorer",
]);
/** Writes nothing, sends nothing; spends: model calls / paid searches. */
const SPENDS_ONLY = new Set(["draft_outreach_messages", "research_market"]);

test("CASE A — eight helpers, each with tools, all named to the master", async () => {
  assert.deepStrictEqual(SUBORDINATES.map((helper) => helper.name), TEAM);
  const prompt = plannerPrompt("anything");
  for (const helper of SUBORDINATES) {
    assert.ok(toolsForAgent(helper.name).length > 0, `${helper.name} has no tools`);
    assert.ok(prompt.includes(helper.name), `the master is never told about ${helper.name}`);
    assert.ok(helper.label && helper.summary, `${helper.name} has no owner-facing name`);
  }
});

test("CASE B — nothing on the team can write, send, approve or reject", async () => {
  for (const helper of SUBORDINATES) {
    for (const tool of toolsForAgent(helper.name)) {
      assert.ok(READ_ONLY.has(tool.name) || SPENDS_ONLY.has(tool.name), `${helper.name} holds "${tool.name}", which is not known to be read-only`);
    }
  }
  const spenders = SUBORDINATES.filter((helper) => toolsForAgent(helper.name).some((tool) => tool.name === "research_market"));
  assert.deepStrictEqual(spenders.map((helper) => helper.name), ["product-application-research-agent"]);
  assert.ok(!toolsForAgent("lead-review-agent").some((tool) => /approve|reject|update/i.test(tool.name)));
  // Each new helper holds exactly what its job needs — no more. A reviewer
  // that can also draft messages is a reviewer doing outreach.
  const exact: Record<string, string[]> = {
    "quality-review-agent": ["search_knowledge_base"],
    "campaign-learning-agent": ["get_campaign_results"],
    "lead-review-agent": ["find_leads", "get_ideal_customers", "get_lead_profile"],
    "product-application-research-agent": ["research_market", "search_knowledge_base"],
  };
  for (const [helper, tools] of Object.entries(exact)) {
    assert.deepStrictEqual(toolsForAgent(helper).map((tool) => tool.name).sort(), tools, `${helper} tools changed`);
  }
});

test("CASE C — the web-search allowance holds", async () => {
  const research = getTool("research_market")!;
  const ws = freshWs();
  const ledger = { limit: 6, used: 0 };
  // Three asked for in one turn, all dispatched together — as the loop does.
  const results = await Promise.all([1, 2, 3].map(() => research.run({ topic: "zari thread buyers" }, { workspaceId: ws, repos, webSearches: ledger })));
  const refused = results.filter((result) => (result as { error?: string }).error);
  assert.strictEqual(refused.length, 1, "the third use in the same turn is refused");
  assert.ok(ledger.used <= 6, `allowance overspent: ${ledger.used} of 6`);
  assert.strictEqual(ledger.used, 2 * MARKET_RESEARCH_QUERIES);
  const none = await research.run({ topic: "zari thread buyers" }, { workspaceId: ws, repos });
  assert.match(String((none as { error?: string }).error), /No web searches/, "a caller that granted no allowance gets no search");
});

test("CASE D — the plan states its most web searches", async () => {
  const withResearch: Plan = { summary: "", subtasks: [
    { id: "t1", agent: "product-application-research-agent", instruction: "research", dependsOn: [] },
    { id: "t2", agent: "quality-review-agent", instruction: "check", dependsOn: ["t1"] },
  ] };
  const without: Plan = { summary: "", subtasks: [{ id: "t1", agent: "campaign-learning-agent", instruction: "review", dependsOn: [] }] };
  assert.strictEqual(maxSearchesFor(withResearch), 6);
  assert.strictEqual(maxSearchesFor(without), 0);
});

test("CASE E — a lead profile never carries a phone number or e-mail", async () => {
  const ws = freshWs();
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: "Shree Laces", phone: "+910000000071", email: "buyer@example.com", city: "Surat", status: "needs_review", reviewStatus: "pending", leadScore: 7 } as never);
  const profile = await getTool("get_lead_profile")!.run({ leadId: lead.id }, { workspaceId: ws, repos }) as Record<string, unknown>;
  assert.strictEqual(profile.company, "Shree Laces");
  assert.strictEqual(profile.hasPhone, true);
  assert.strictEqual(profile.hasEmail, true);
  const text = JSON.stringify(profile);
  assert.ok(!text.includes("0000000071") && !text.includes("buyer@example.com"), "contact details leaked into the profile");
  const other = await getTool("get_lead_profile")!.run({ leadId: lead.id }, { workspaceId: freshWs(), repos }) as { error?: string };
  assert.ok(other.error, "another workspace cannot read this lead");
});

test("CASE F — 'not for' rules reach the reviewer; archived types do not", async () => {
  const ws = freshWs();
  await repos.icp.createMany([{ workspaceId: ws, businessProfileId: "profile_x", name: "Bridal boutiques", description: "", buyerType: "boutique", industries: ["bridal"], geography: ["Gujarat"], likelyNeeds: [], buyingTriggers: [], painPoints: [], preferredChannels: [], messagingAngles: [], qualificationRules: [], exclusions: ["manufactures zari themselves"], companySizeBucket: "unknown", confidenceScore: 0.7, status: "selected" }, { workspaceId: ws, businessProfileId: "profile_x", name: "Old idea", description: "", buyerType: "x", industries: [], geography: [], likelyNeeds: [], buyingTriggers: [], painPoints: [], preferredChannels: [], messagingAngles: [], qualificationRules: [], companySizeBucket: "unknown", confidenceScore: 0.5, status: "archived" }] as never);
  const result = await getTool("get_ideal_customers")!.run({}, { workspaceId: ws, repos }) as { customerTypes: Array<{ name: string; notFor: string[] }> };
  assert.deepStrictEqual(result.customerTypes.map((type) => type.name), ["Bridal boutiques"]);
  assert.deepStrictEqual(result.customerTypes[0].notFor, ["manufactures zari themselves"]);
});

test("CASE G — campaign results are counted per campaign", async () => {
  const ws = freshWs();
  const campaign = await repos.campaign.create({ workspaceId: ws, businessProfileId: "p", icpId: "i", name: "Bridal Gujarat", goal: "first orders", targetRegion: [], productFocus: [], offer: "", selectedChannels: [], dailyOutreachLimit: 10, leadGoal: 10, status: "active", approvalStatus: "approved", plan: {} } as never);
  const other = await repos.campaign.create({ workspaceId: ws, businessProfileId: "p", icpId: "i", name: "Export test", goal: "", targetRegion: [], productFocus: [], offer: "", selectedChannels: [], dailyOutreachLimit: 10, leadGoal: 10, status: "draft", approvalStatus: "needs_review", plan: {} } as never);
  const a = await repos.lead.createLead({ workspaceId: ws, campaignId: campaign.id, companyName: "A", status: "won", reviewStatus: "approved", leadScore: 0 } as never);
  await repos.lead.createLead({ workspaceId: ws, campaignId: campaign.id, companyName: "B", status: "needs_review", reviewStatus: "rejected", leadScore: 0 } as never);
  await repos.lead.createLead({ workspaceId: ws, campaignId: other.id, companyName: "C", status: "needs_review", reviewStatus: "pending", leadScore: 0 } as never);
  await repos.reply.create({ workspaceId: ws, leadId: a.id, channel: "whatsapp", rawText: "price?", classification: "ask_price" } as never);
  const result = await getTool("get_campaign_results")!.run({ campaign: "bridal" }, { workspaceId: ws, repos }) as { campaigns: Array<Record<string, unknown>> };
  assert.strictEqual(result.campaigns.length, 1, "the named campaign only");
  const row = result.campaigns[0];
  assert.deepStrictEqual(
    { leads: row.leads, approved: row.approved, rejected: row.rejected, won: row.won, contacted: row.contacted, replies: row.replies },
    { leads: 2, approved: 1, rejected: 1, won: 1, contacted: 1, replies: 1 },
  );
  assert.deepStrictEqual(row.replyKinds, { ask_price: 1 });
});

test("CASE H — the four unused agents are gone, the rest still have instructions", async () => {
  const removed = ["website_extraction_agent", "auto_reply_review_agent", "integration_agent", "model_routing_agent"];
  for (const name of removed) {
    assert.ok(!(AGENT_NAMES as readonly string[]).includes(name), `${name} is still offered on the Agent Instructions screen`);
    assert.ok(!existsSync(`agents/${name.replace(/_/g, "-")}.md`), `${name} still has an instruction file`);
  }
  // Everything the runtime can route a task to must still have its file,
  // and must still be on the screen where the owner can adjust it.
  for (const agent of new Set(Object.values(taskAgentMap))) {
    assert.ok(existsSync(`agents/${agent.replace(/_/g, "-")}-agent.md`), `${agent} lost its instruction file`);
    assert.ok((AGENT_NAMES as readonly string[]).includes(`${agent}_agent`), `${agent} is missing from the Agent Instructions screen`);
  }
  assert.strictEqual(AGENT_NAMES.length, 16);
});

(async () => {
  console.log("\n=== GOLDEN: the master AI's team of eight ===\n");
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
    console.log("❌ GOLDEN FAILED: master-team");
    process.exit(1);
  }
})();
