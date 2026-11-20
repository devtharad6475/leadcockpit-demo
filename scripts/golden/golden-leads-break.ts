/**
 * golden-leads-break.ts — what the 2026-09-26 break test found in finding
 * customers and managing leads, pinned so it cannot come back.
 *
 *   A — finding a company again must not move its lead backwards: an approved,
 *       contacted, won or rejected lead went back to "needs review / pending",
 *       and its consent and enrichment were wiped.
 *   B — the same company found with and without "https://www." (or a trailing
 *       slash, or capitals) is one lead, not two.
 *   C — a company already a lead from ANOTHER campaign (or a CSV) is not added
 *       again; one marked do-not-contact there is never re-added as contactable.
 *   D — the daily run drafts a first message for the NEW leads of a run, not for
 *       whichever leads happened to come first in the list.
 *   E — bulk approve with a do-not-contact / duplicate / missing lead in the
 *       selection approves the others and skips those, instead of failing half
 *       way with some approved and some not.
 *   F — adding a lead by hand: a number on the do-not-contact register is
 *       refused; the same phone typed differently, or the same email, is
 *       refused as an existing lead.
 *   G — a lead edit cannot move a lead to another workspace or store a score
 *       outside 0–100.
 *   H — rejecting a do-not-contact lead keeps it marked "do not contact".
 *   I — an AI "approve" can never auto-approve a lead the owner rejected.
 *   J — the daily auto-approve limit holds when the batch runs twice at once
 *       (and when it runs again later the same day).
 *
 * SerpApi and the AI are never called: candidates come from a stub search and
 * the AI is the mock provider (so nothing is scored — scoring is AI only).
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-leads-break.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Campaign, ICP, Lead } from "@/lib/types";
import { ProspectingService, type ProspectingCandidate } from "@/services/ProspectingService";
import { bulkReviewLeads, rejectLead } from "@/services/LeadReviewDecisionService";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { createManualLead } from "@/services/LeadImportService";
import { leadUpdateSchema } from "@/validation/schemas";
import { NeedsActionError } from "@/lib/user-errors";
import { newLeadsOfRun } from "@/services/DailyProspectingScheduler";
import { recommendLeadReviewDecision } from "@/services/LeadReviewDecisionService";
import { autoApproveBatch } from "@/services/LeadReviewBatchService";
import { LLMService } from "@/llm/LLMService";

// The AI, stubbed: it says "approve, 95% sure, no risks" to every lead review,
// after a short pause so two runs at once really interleave. Nothing else here
// reaches it (discovery above never scores, so the mock is fine there).
const realRunTask = LLMService.prototype.runTask;
LLMService.prototype.runTask = async function (this: LLMService, task: string, ...rest: unknown[]) {
  if (task !== "lead_review_decision") return (realRunTask as (...a: unknown[]) => unknown).call(this, task, ...rest);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { output: { decision: "approve", confidenceScore: 0.95, reason: "Strong fit", riskSignals: [], matchedSignals: ["fit"] }, mode: "real", provider: "stub" };
} as typeof LLMService.prototype.runTask;

/** A lead the AI has scored (auto-approval never touches unscored leads). */
const aiScored = { qualificationStatus: "good_prospect", scoreReason: { scoresFrom: "model", mode: "real" }, confidenceScore: 0.9, companyName: "Scored Co", fitReason: "fits" } as Partial<Lead>;
async function autoMode(ws: string, cap: number) {
  await repos.leadReviewSettings.upsertForWorkspace(ws, { workspaceId: ws, mode: "high_confidence_auto_approval", autoApproveThreshold: 0.85, autoRejectThreshold: 0.25, maxAutoApprovedPerDay: cap, requireHumanForNewCampaigns: true, requireHumanForNewIndustries: true, allowAutoSend: false });
}

delete process.env.PLATFORM_SERPAPI_API_KEY;
delete process.env.SERPAPI_API_KEY;

const repos = createJsonRepos() as RepositoryBundle;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

/** Discovery with a fixed list of companies instead of SerpApi / the AI's queries. */
class StubbedProspecting extends ProspectingService {
  constructor(private readonly found: Array<Partial<Lead>>) { super(repos); }
  async generateSearchQueries() { return { queries: ["stub query"], llm: undefined, warning: "" }; }
  async searchGoogleMaps() {
    return {
      mode: "llm_assisted_demo" as const,
      provider: "mock",
      candidates: this.found.map((item) => ({ ...item, searchQuery: "stub query", searchMode: "llm_assisted_demo", sourceProvider: "mock" }) as ProspectingCandidate),
    };
  }
}

async function workspace(slug: string) {
  const id = `ws_leads_break_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await repos.workspace.create({ id, name: `Leads break ${slug}`, status: "active" } as never);
  return id;
}

async function campaign(workspaceId: string, name = "Surat push"): Promise<Campaign> {
  return repos.campaign.create({
    workspaceId, name, goal: "Find buyers", targetRegion: ["Surat"], productFocus: ["zari"], offer: "x",
    selectedChannels: ["whatsapp"], dailyOutreachLimit: 5, leadGoal: 10, status: "active", approvalStatus: "approved",
    plan: { searchQueries: ["stub query"] } as Campaign["plan"],
  } as Partial<Campaign>);
}

async function discover(workspaceId: string, campaignId: string, found: Array<Partial<Lead>>) {
  // Websites are never fetched: only http(s) is fetched and the stubs use .invalid.
  return new StubbedProspecting(found).prospectForWorkspace({ workspaceId, campaignId, limit: 12 });
}

test("A — finding a company again keeps its stage, review, consent and enrichment", async () => {
  const ws = await workspace("A");
  const c = await campaign(ws);
  const found = [
    { companyName: "Won Traders", websiteUrl: "https://won.invalid" },
    { companyName: "Rejected Traders", websiteUrl: "https://rejected.invalid" },
  ];
  const first = await discover(ws, c.id, found);
  assert.equal(first.created, 2);
  const [won, rejected] = first.leads;
  await repos.lead.updateLead(ws, won.id, { status: "won", reviewStatus: "approved", consentStatus: "opted_in", enrichmentStatus: "completed" });
  await repos.lead.updateLead(ws, rejected.id, { status: "rejected", reviewStatus: "rejected" });
  const second = await discover(ws, c.id, found);
  assert.equal(second.created, 0, "the same companies were added again");
  const wonAfter = (await repos.lead.getLeadById(ws, won.id))!;
  assert.equal(wonAfter.status, "won", `a won lead went back to "${wonAfter.status}"`);
  assert.equal(wonAfter.reviewStatus, "approved", "an approved lead went back to pending review");
  assert.equal(wonAfter.consentStatus, "opted_in", "the customer's consent was wiped");
  assert.equal(wonAfter.enrichmentStatus, "completed", "the enrichment was wiped");
  const rejectedAfter = (await repos.lead.getLeadById(ws, rejected.id))!;
  assert.equal(rejectedAfter.reviewStatus, "rejected", "a lead the owner rejected came back for review");
  assert.equal(rejectedAfter.status, "rejected");
});

test("B — one company, website written four ways, is one lead", async () => {
  const ws = await workspace("B");
  const c = await campaign(ws);
  const result = await discover(ws, c.id, [
    { companyName: "Shree Zari", websiteUrl: "shreezari.invalid" },
    { companyName: "Shree Zari Pvt Ltd", websiteUrl: "https://www.ShreeZari.invalid/" },
    { companyName: "Shree Zari (Surat)", websiteUrl: "http://shreezari.invalid" },
    { companyName: "SZ", websiteUrl: "WWW.SHREEZARI.INVALID/contact" },
  ]);
  assert.equal(result.created, 1, `one company became ${result.created} leads`);
});

test("C — a company already a lead elsewhere is not added again; a do-not-contact one is never re-added", async () => {
  const ws = await workspace("C");
  const old = await campaign(ws, "Old campaign");
  const fresh = await campaign(ws, "New campaign");
  const csvLead = await repos.lead.createLead({ workspaceId: ws, companyName: "Imported Co", websiteUrl: "https://imported.invalid", status: "approved", reviewStatus: "approved" });
  const dncLead = await repos.lead.createLead({ workspaceId: ws, campaignId: old.id, companyName: "Stop Co", websiteUrl: "https://stop.invalid", doNotContact: true, status: "do_not_contact" });
  const result = await discover(ws, fresh.id, [
    { companyName: "Imported Co", websiteUrl: "https://www.imported.invalid" },
    { companyName: "Stop Co", websiteUrl: "https://stop.invalid" },
  ]);
  const all = await repos.lead.listLeads(ws);
  assert.equal(all.filter((l) => /imported/i.test(l.websiteUrl || "")).length, 1, "a company already a lead was added a second time");
  const stops = all.filter((l) => /stop\.invalid/.test(l.websiteUrl || ""));
  assert.ok(stops.every((l) => l.doNotContact), "a do-not-contact company was re-added as contactable");
  assert.equal(result.created, 0);
  // Its stage and campaign are untouched.
  const csvAfter = (await repos.lead.getLeadById(ws, csvLead.id))!;
  assert.equal(csvAfter.reviewStatus, "approved");
  assert.equal((await repos.lead.getLeadById(ws, dncLead.id))!.status, "do_not_contact");
});

test("D — the daily run drafts only for leads created in the run", async () => {
  const ws = await workspace("D");
  const c = await campaign(ws);
  await discover(ws, c.id, [{ companyName: "Known Co", websiteUrl: "https://known.invalid" }]);
  const run = await discover(ws, c.id, [
    { companyName: "Known Co", websiteUrl: "https://known.invalid" },
    { companyName: "New Co", websiteUrl: "https://new.invalid" },
  ]);
  assert.equal(run.created, 1);
  const names = newLeadsOfRun(run).map((l) => l.companyName);
  assert.deepEqual(names, ["New Co"], `the run would draft for ${JSON.stringify(names)}`);
});

test("E — bulk approve skips blocked leads and approves the rest", async () => {
  const ws = await workspace("E");
  const good1 = await repos.lead.createLead({ workspaceId: ws, companyName: "Good 1", status: "needs_review", reviewStatus: "pending" });
  const dnc = await repos.lead.createLead({ workspaceId: ws, companyName: "Stop", status: "do_not_contact", doNotContact: true, reviewStatus: "pending" });
  const dup = await repos.lead.createLead({ workspaceId: ws, companyName: "Dup", status: "duplicate", reviewStatus: "pending" });
  const good2 = await repos.lead.createLead({ workspaceId: ws, companyName: "Good 2", status: "needs_review", reviewStatus: "pending" });
  const result = await bulkReviewLeads(ws, [good1.id, dnc.id, dup.id, "lead_missing", good2.id], "approve", repos);
  assert.equal((await repos.lead.getLeadById(ws, good1.id))!.reviewStatus, "approved");
  assert.equal((await repos.lead.getLeadById(ws, good2.id))!.reviewStatus, "approved", "leads after a blocked one were left unapproved");
  assert.equal((await repos.lead.getLeadById(ws, dnc.id))!.reviewStatus, "pending");
  assert.equal((await repos.lead.getLeadById(ws, dup.id))!.reviewStatus, "pending");
  assert.equal(result.skipped.length, 3);
  assert.ok(result.skipped.every((s) => s.reason && !/Error|undefined/.test(s.reason)));
});

test("F — adding a lead by hand refuses an opted-out number and an existing contact", async () => {
  const ws = await workspace("F");
  await registerDoNotContact(ws, { phone: "+91 98250 11111", reason: "asked to stop" }, repos);
  await assert.rejects(() => createManualLead(ws, { companyName: "Stop again", phone: "+919825011111" }, repos), NeedsActionError, "an opted-out number was added as a new lead");
  await createManualLead(ws, { companyName: "Mehta Textiles", phone: "+91 98250 22222", email: "Buy@Mehta.invalid" }, repos);
  await assert.rejects(() => createManualLead(ws, { companyName: "Mehta Tex", phone: "+91-98250-22222" }, repos), NeedsActionError, "the same phone in another format became a second lead");
  await assert.rejects(() => createManualLead(ws, { contactName: "Mr Mehta", email: " buy@mehta.invalid " }, repos), NeedsActionError, "the same email became a second lead");
  const ok = await createManualLead(ws, { companyName: "Other Co", phone: "+91 98250 33333" }, repos);
  assert.equal(ok.doNotContact, false);
  assert.equal((await repos.lead.listLeads(ws)).length, 2);
});

test("G — a lead edit cannot move the lead or store an impossible score", async () => {
  const moved = leadUpdateSchema.safeParse({ workspaceId: "someone_else", companyName: "x" });
  assert.ok(!moved.success || !("workspaceId" in moved.data), "an edit carried a workspace id into the lead");
  for (const leadScore of [-5, 101, 99999]) {
    assert.equal(leadUpdateSchema.safeParse({ leadScore }).success, false, `a score of ${leadScore} was accepted`);
  }
  assert.equal(leadUpdateSchema.safeParse({ fitScore: 250 }).success, false);
  // 2026-09-28 (L10): scores are AI-only, so even a sensible typed score is refused.
  assert.equal(leadUpdateSchema.safeParse({ leadScore: 72 }).success, false);
});

test("H — rejecting a do-not-contact lead keeps it marked do not contact", async () => {
  const ws = await workspace("H");
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: "Stop", status: "do_not_contact", doNotContact: true, reviewStatus: "pending" });
  const after = await rejectLead(ws, lead.id, repos);
  assert.equal(after.status, "do_not_contact", `its stage became "${after.status}"`);
  assert.equal(after.reviewStatus, "rejected");
});

test("I — an AI approve never auto-approves a lead the owner rejected", async () => {
  const ws = await workspace("I");
  await autoMode(ws, 25);
  const lead = await repos.lead.createLead({ workspaceId: ws, ...aiScored, status: "rejected", reviewStatus: "rejected" });
  await recommendLeadReviewDecision(ws, lead.id, repos);
  const after = (await repos.lead.getLeadById(ws, lead.id))!;
  assert.equal(after.reviewStatus, "rejected", "the AI un-rejected a lead the owner rejected");
});

test("J — the daily auto-approve limit holds when the batch runs twice at once, and again later", async () => {
  const ws = await workspace("J");
  await autoMode(ws, 2);
  for (let i = 0; i < 6; i++) await repos.lead.createLead({ workspaceId: ws, ...aiScored, companyName: `Scored ${i}`, status: "needs_review", reviewStatus: "pending" });
  await Promise.all([autoApproveBatch(ws, repos), autoApproveBatch(ws, repos)]);
  let approved = (await repos.lead.listLeads(ws)).filter((l) => l.reviewStatus === "approved").length;
  assert.equal(approved, 2, `a daily limit of 2 approved ${approved} leads`);
  await autoApproveBatch(ws, repos);
  approved = (await repos.lead.listLeads(ws)).filter((l) => l.reviewStatus === "approved").length;
  assert.equal(approved, 2, `a second run the same day took it to ${approved}`);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`); }
    catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${(error as Error).message.split("\n")[0]}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
