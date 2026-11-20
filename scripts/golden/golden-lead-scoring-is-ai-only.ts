/**
 * golden-lead-scoring-is-ai-only.ts — pin (2026-09-25, CEO decision).
 *
 * THE DECISION THIS PINS
 * ----------------------
 * Lead scoring is done by the AI only. The rule-based scorers (`heuristicScores`
 * during discovery, `scoreLead` behind "Score all") were measured at 93% on a
 * held-out set against the AI's 99% (docs/planning/JEV_TRIAL.md); the owner
 * chose "wait for the AI" over "show a guess". So:
 *
 *   CASE A — a real model answer with four numbers is a score.
 *   CASE B — sample mode, a backup model, an outage, or an answer with no
 *            numbers is NOT a score: the lead is "not_scored", 0s, and says why.
 *   CASE C — isAiScored: only a real model's numbers count; old rule scores,
 *            demo seeds and "not_scored" do not.
 *   CASE D — a failed RE-score changes nothing: the AI's earlier score stays.
 *   CASE E — "Score with AI" (shared pass): skips leads the AI already scored,
 *            skips rejected and do-not-contact leads, respects the budget, and
 *            stops at the first failure without writing anything.
 *   CASE F — a lead the AI has not scored is never auto-approved, even when
 *            every other signal says approve.
 *   CASE G — the rule-based scorers are gone from the code.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createJsonRepos } from "./_helpers/provider";
import { ProspectingService, scoreLeadsAwaitingAi } from "@/services/ProspectingService";
import { isAiScored } from "@/lib/lead-rules";
import { decideLeadForTest } from "@/services/LeadReviewDecisionService";
import type { Campaign, Lead, LeadReviewSettings } from "@/lib/types";
import { LLMService } from "@/llm/LLMService";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const repos = createJsonRepos();
const campaign = { id: "c1", name: "Trial", goal: "Find buyers", productFocus: ["Zari thread"], targetRegion: ["India"] } as unknown as Campaign;
const candidate = { companyName: "Tarun Fab", buyerType: "Clothing manufacturer", fitReason: "Found on Google Maps.", confidenceScore: 0.72 };
const NUMBERS = { fitScore: 5, needScore: 4, reachabilityScore: 4, timingScore: 3, reason: "Makes sarees in bulk; buys zari by the kilo." };

/** A stand-in for the model: returns whatever the case needs, counts calls. */
function fakeLlm(answer: () => Promise<unknown>) {
  let calls = 0;
  const llm = { runTask: async () => { calls += 1; return answer(); } } as unknown as LLMService;
  return { llm, calls: () => calls };
}
const real = () => Promise.resolve({ output: NUMBERS, provider: "deepseek", mode: "real", fallbackUsed: false });

test("CASE A — a real model answer is a score", async () => {
  const { llm } = fakeLlm(real);
  const lead = await new ProspectingService(repos, llm).qualifyLead("w", candidate as never, campaign);
  assert.strictEqual(lead.leadScore, 16);
  assert.strictEqual((lead.scoreReason as { scoresFrom?: string }).scoresFrom, "model");
  assert.ok(isAiScored(lead as Lead));
  assert.strictEqual(lead.fitReason, NUMBERS.reason, "the model's own reason is kept");
});

test("CASE B — no real model answer means not scored, never a guess", async () => {
  const shapes: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["sample mode", () => Promise.resolve({ output: NUMBERS, provider: "mock", mode: "mock", fallbackUsed: false }), /sample mode/],
    ["backup model", () => Promise.resolve({ output: NUMBERS, provider: "deepseek", mode: "real", fallbackUsed: true }), /backup/],
    ["no numbers", () => Promise.resolve({ output: { reason: "Looks good" }, provider: "deepseek", mode: "real", fallbackUsed: false }), /did not return a score/],
    ["outage", () => Promise.reject(new Error("503 overloaded")), /could not be reached/],
  ];
  for (const [label, answer, why] of shapes) {
    const { llm } = fakeLlm(answer);
    const lead = await new ProspectingService(repos, llm).qualifyLead("w", candidate as never, campaign);
    assert.strictEqual(lead.qualificationStatus, "not_scored", `${label}: must be not_scored`);
    assert.strictEqual(lead.leadScore, 0, `${label}: no number may be shown`);
    assert.ok(!isAiScored(lead as Lead), `${label}: must not count as scored`);
    assert.match(String((lead.scoreReason as { reason?: string }).reason), why, `${label}: must say why`);
  }
});

test("CASE C — only a real model's numbers count as a score", async () => {
  assert.ok(isAiScored({ scoreReason: { scoresFrom: "model", mode: "real" } }));
  assert.ok(!isAiScored({ scoreReason: { scoresFrom: "heuristic", mode: "real" } }), "an old rule score is not an AI score");
  assert.ok(!isAiScored({ scoreReason: { scoresFrom: "model", mode: "mock" } }), "a sample-mode score is not an AI score");
  assert.ok(!isAiScored({ scoreReason: { reason: "Demo score for UI and workflow verification." } }), "a seeded demo score is not an AI score");
  assert.ok(!isAiScored({ qualificationStatus: "not_scored", scoreReason: { scoresFrom: "model", mode: "real" } }));
  assert.ok(!isAiScored({}));
});

async function workspace() {
  const id = `ws_ai_only_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await repos.workspace.create({ id, name: "AI-only golden", status: "active" });
  return id;
}
const AI_SCORE = { leadScore: 17, fitScore: 5, needScore: 4, reachabilityScore: 4, timingScore: 4, qualificationStatus: "mql", scoreReason: { scoresFrom: "model", mode: "real", reason: "Earlier AI reasoning" } };

test("CASE D — a failed re-score leaves the AI's earlier score alone", async () => {
  const workspaceId = await workspace();
  const lead = await repos.lead.createLead({ workspaceId, companyName: "Scored Ltd", status: "approved", reviewStatus: "approved", ...AI_SCORE } as Partial<Lead>);
  const { llm } = fakeLlm(() => Promise.reject(new Error("503")));
  const result = await new ProspectingService(repos, llm).rescoreLead(workspaceId, lead);
  assert.strictEqual(result.aiScored, false);
  assert.deepStrictEqual(result.fields, {}, "nothing may be handed back to write");
});

test("CASE E — the shared pass: skips, budget, stop at first failure", async () => {
  const workspaceId = await workspace();
  await repos.lead.createLead({ workspaceId, companyName: "Already AI", status: "approved", reviewStatus: "approved", ...AI_SCORE } as Partial<Lead>);
  await repos.lead.createLead({ workspaceId, companyName: "Rejected", status: "needs_review", reviewStatus: "rejected" } as Partial<Lead>);
  await repos.lead.createLead({ workspaceId, companyName: "Opted out", status: "do_not_contact", reviewStatus: "approved", doNotContact: true } as Partial<Lead>);
  for (const n of [1, 2, 3]) await repos.lead.createLead({ workspaceId, companyName: `Waiting ${n}`, status: "needs_review", reviewStatus: "pending" } as Partial<Lead>);

  // The pass builds its own ProspectingService, so the model is stubbed at the
  // LLMService prototype for the duration of this case.
  const original = LLMService.prototype.runTask;
  let calls = 0;
  let fail = false;
  LLMService.prototype.runTask = (async () => { calls += 1; if (fail) throw new Error("503 overloaded"); return { output: NUMBERS, provider: "deepseek", mode: "real", fallbackUsed: false }; }) as never;
  try {
    const first = await scoreLeadsAwaitingAi(repos, workspaceId, { limit: 2 });
    assert.strictEqual(first.aiScored, 2, "budget of 2");
    assert.strictEqual(first.stillWaiting, 1, "the three waiting leads only — AI-scored, rejected and opted-out are not counted");
    assert.strictEqual(calls, 2, "the AI-scored, rejected and opted-out leads were never sent to the model");

    // Two more waiting, so three wait in all: a pass that keeps going after a
    // failure would call the model three times; one that stops calls it once.
    for (const n of [4, 5]) await repos.lead.createLead({ workspaceId, companyName: `Waiting ${n}`, status: "needs_review", reviewStatus: "pending" } as Partial<Lead>);
    fail = true;
    calls = 0;
    const second = await scoreLeadsAwaitingAi(repos, workspaceId, { limit: 5 });
    assert.strictEqual(second.aiScored, 0);
    assert.strictEqual(calls, 1, "the pass must stop at the first failure");
    assert.match(String(second.stoppedReason), /could not be reached/);
    const leads = await repos.lead.listLeads(workspaceId);
    const earlier = leads.find((l) => l.companyName === "Already AI")!;
    assert.strictEqual(earlier.leadScore, 17, "nothing is overwritten on failure");
  } finally {
    LLMService.prototype.runTask = original;
  }
});

test("CASE F — a lead the AI has not scored is never auto-approved", async () => {
  const settings = {
    id: "s", workspaceId: "w", mode: "high_confidence_auto_approval", autoApproveThreshold: 0.5, autoRejectThreshold: 0.1,
    maxAutoApprovedPerDay: 100, requireHumanForNewCampaigns: false, requireHumanForNewIndustries: false,
    allowAutoEnrichment: false, allowAutoOutreachPreparation: false, allowAutoSend: false, auditEveryDecision: true,
    createdAt: "", updatedAt: "",
  } as LeadReviewSettings;
  const strong = { id: "l", workspaceId: "w", companyName: "Strong Co", fitReason: "Great fit", websiteUrl: "https://x.example", confidenceScore: 0.9, status: "needs_review", reviewStatus: "pending" } as unknown as Lead;
  const waiting = decideLeadForTest(strong, settings, campaign, undefined, true, { awaitingAiScore: true });
  assert.notStrictEqual(waiting.decision, "approve", "an unscored lead must wait for a person");
  assert.match(String(waiting.autoApprovalBlockedReason), /AI has not scored/);
  const scored = decideLeadForTest(strong, settings, campaign, undefined, true, { awaitingAiScore: false });
  assert.strictEqual(scored.decision, "approve", "control: the same lead, AI-scored, is approvable — so the guard is what blocked it");
});

test("CASE G — the rule-based scorers are gone", async () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  assert.ok(!/export function heuristicScores/.test(read("src/services/ProspectingService.ts")));
  assert.ok(!/export function scoreLead\b/.test(read("src/lib/agents.ts")));
  assert.ok(!/Scored by the simple rules/.test(read("src/app/page.tsx")));
});

(async () => {
  console.log("golden-lead-scoring-is-ai-only — lead scores come from the AI or not at all\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); passed++; console.log(`  ✅ ${c.name}`); }
    catch (e) { failed++; console.error(`  ❌ ${c.name}`); console.error(`     ${(e as Error).message}`); }
  }
  console.log("");
  console.log(`lead-scoring-is-ai-only: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
