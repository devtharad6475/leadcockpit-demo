import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { importLeadsFromCsv, MAX_CSV_BYTES } from "@/services/LeadImportService";
import { listNewBuyersToday } from "@/services/NewBuyersTodayService";
import { getOutreachQueue } from "@/services/OutreachQueueService";
import { enrichLead } from "@/services/LeadEnrichmentService";
import { createLeadAgentActionPlan } from "@/services/LeadAgentActionPlanService";
import type { RepositoryBundle } from "@/repositories/interfaces";

const repos = createJsonRepos();
const cases: Array<[string, () => Promise<void>]> = [];
const now = new Date("2026-10-03T04:00:00Z");
async function setup(tag: string) {
  const workspaceId = `workflow_crm_${tag}`;
  await ensureWorkspace(repos, workspaceId);
  return workspaceId;
}
async function buyer(workspaceId: string, name: string, websiteUrl?: string) {
  const lead = await repos.lead.createLead({ workspaceId, companyName: name, websiteUrl,
    email: `${name}@example.invalid`, status: "approved", reviewStatus: "approved",
    doNotContact: false, leadScore: 15, scoreReason: { scoresFrom: "model", mode: "real" },
    qualificationStatus: "mql", enrichmentStatus: "not_started" });
  return repos.lead.updateLead(workspaceId, lead.id, { createdAt: now.toISOString() });
}
cases.push(["UTF-8 CSV byte limit refuses before any repository call", async () => {
  // Each Hindi character takes 3 UTF-8 bytes; this is >5 MB but <5M UTF-16 units.
  const text = "company_name\n" + "क".repeat(Math.floor(MAX_CSV_BYTES / 3) + 1);
  assert.ok(Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES);
  assert.ok(text.length < MAX_CSV_BYTES);
  const result = await importLeadsFromCsv("unused", text, {}, {} as RepositoryBundle);
  assert.ok("refused" in result && result.code === "CSV_TOO_LARGE");
}]);
cases.push(["new buyers excludes website-only permanent opt-out", async () => {
  const ws = await setup("newbuyers");
  await buyer(ws, "blocked", "https://blocked.example.invalid");
  await registerDoNotContact(ws, { website: "https://blocked.example.invalid", reason: "stop" }, repos);
  const list = await listNewBuyersToday(ws, repos, { now });
  assert.equal(list.count, 0);
}]);
cases.push(["new buyers does not fail open when DNC registry cannot be read", async () => {
  const ws = await setup("registry_failure");
  await buyer(ws, "safe-looking");
  const broken = { ...repos, doNotContact: { ...repos.doNotContact, findMatch: async () => { throw new Error("registry unavailable"); } } } as RepositoryBundle;
  await assert.rejects(() => listNewBuyersToday(ws, broken, { now }), /registry unavailable/);
}]);
cases.push(["outreach queue excludes rejected and permanent DNC drafts", async () => {
  const ws = await setup("queue");
  const rejected = await buyer(ws, "rejected");
  await repos.lead.updateLead(ws, rejected.id, { reviewStatus: "rejected" });
  const blocked = await buyer(ws, "registered", "https://registered.example.invalid");
  await registerDoNotContact(ws, { website: blocked.websiteUrl, reason: "stop" }, repos);
  const good = await buyer(ws, "good");
  for (const lead of [rejected, blocked, good]) {
    await repos.messageTemplate.create({ workspaceId: ws, leadId: lead.id, channel: "WhatsApp", body: "Draft", status: "draft", personalizationUsed: { generationMeta: { reviewState: "pending_review" } } });
  }
  const queue = await getOutreachQueue(ws, repos);
  assert.deepEqual(queue.items.map(i => i.lead.id), [good.id]);
}]);
cases.push(["enrichment refuses permanent opt-out before recording a paid research run", async () => {
  const ws = await setup("enrich");
  const lead = await buyer(ws, "enrich-blocked", "https://enrich-blocked.example.invalid");
  await registerDoNotContact(ws, { website: lead.websiteUrl, reason: "stop" }, repos);
  let researchRuns = 0;
  const observed = { ...repos, agentRun: { ...repos.agentRun, create: async () => { researchRuns++; throw new Error("research started"); } } } as RepositoryBundle;
  await assert.rejects(() => enrichLead(ws, lead.id, { candidates: [] }, observed), /do.not.contact/i);
  assert.equal(researchRuns, 0);
}]);
cases.push(["agent action plan never drafts contact for permanent opt-out", async () => {
  const ws = await setup("plan");
  const lead = await buyer(ws, "plan-blocked", "https://plan-blocked.example.invalid");
  await registerDoNotContact(ws, { website: lead.websiteUrl, reason: "stop" }, repos);
  const plan = await createLeadAgentActionPlan(ws, lead.id, repos);
  assert.equal(plan.draftMessage, "");
  assert.match(plan.recommendation, /do not contact/i);
}]);

async function main() {
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  }
  console.log(`workflow-crm-safety: ${cases.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
void main();
