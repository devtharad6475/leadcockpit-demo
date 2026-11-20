/**
 * golden-outreach-queue.ts — OutreachQueueService pin (NEW coverage, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   OutreachQueueService had NO golden test. Its 4 exported functions are the
 *   operator's daily workflow surfaces: the review queue, the follow-up radar,
 *   the per-lead activity timeline, and the dashboard intelligence counters. A
 *   silent scoping bug in getLeadActivityTimeline (e.g. returning another
 *   lead's replies) is a cross-tenant data leak inside a workspace; a
 *   miscounted dashboard counter sends the operator chasing phantom leads.
 *   We pin the deterministic scoping + counting contracts.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — getLeadActivityTimeline is SCOPED to the requested lead.
 *     Seed 2 leads in one workspace. Attach an outreach activity + a reply to
 *     EACH lead. Hand-computed: lead A's timeline contains ONLY lead A's
 *     events — lead B's reply text and outreach body must NOT appear. This is
 *     the load-bearing scoping assertion (a leak here means the operator sees
 *     another customer's messages inside the wrong contact record).
 *
 *   CASE B — getLeadActivityTimeline throws when the lead does not exist.
 *     Hand-computed: calling with a nonexistent leadId rejects with
 *     "Lead not found". This is the fail-loud guardrail (vs returning an empty
 *     timeline that looks like a brand-new lead).
 *
 *   CASE C — getOutreachQueue returns ONLY draft + pending_review messages
 *     that have a matching lead, sorted by leadScore desc. Seed 3 messages:
 *       m1: draft, pending_review, lead with score 80
 *       m2: draft, pending_review, lead with score 40
 *       m3: approved (NOT draft) — must be EXCLUDED
 *     Hand-computed: queue returns [m1, m2] in that order (score desc). m3 is
 *     excluded because it's not a pending draft.
 *
 *   CASE D — getFollowupRadar returns only CONTACTED/REPLIED leads whose
 *     lastContactedAt is >= staleDays old, and EXCLUDES terminal statuses
 *     (interested / not_interested / do_not_contact / won / lost / closed_*).
 *     Seed:
 *       lead X: status=contacted, lastContactedAt = 10 days ago → INCLUDED
 *       lead Y: status=interested, lastContactedAt = 10 days ago → EXCLUDED (terminal)
 *       lead Z: status=contacted, lastContactedAt = 1 day ago    → EXCLUDED (too fresh)
 *     Hand-computed: radar returns exactly [lead X].
 *
 *   CASE E — getDashboardIntelligence counts the right populations.
 *     Seed leads/messages and hand-compute:
 *       pendingReviewLeads   = count of reviewStatus==="pending"
 *       approvedLeads        = count of reviewStatus==="approved"
 *       draftsPendingReview  = count of draft + pending_review messages
 *       repliesUnread        = count of replies with no classification
 *
 * REAL PIPELINE: imports the 4 real exported functions + the real JSON repo.
 * Each case uses a unique timestamped workspace so demo data stays clean.
 *
 * Run: `npm run golden:outreach-queue`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  getOutreachQueue,
  getFollowupRadar,
  getLeadActivityTimeline,
  getDashboardIntelligence,
} from "@/services/OutreachQueueService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_outreach_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

async function seedLead(repos: RepositoryBundle, ws: string, overrides: Partial<Lead> = {}): Promise<Lead> {
  return repos.lead.createLead({
    workspaceId: ws,
    companyName: `Co ${Math.floor(Math.random() * 1e6)}`,
    status: "contacted",
    reviewStatus: "approved",
    enrichmentStatus: "not_started",
    confidenceScore: 0.5,
    leadScore: 50,
    fitScore: 3,
    needScore: 3,
    reachabilityScore: 3,
    timingScore: 3,
    lastContactedAt: daysAgoIso(10),
    ...overrides,
  } as Partial<Lead>);
}

// --- CASE A: getLeadActivityTimeline is SCOPED to the requested lead ----------
test("CASE A — getLeadActivityTimeline returns ONLY the requested lead's events (scoping)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  const leadA = await seedLead(repos, WS, { companyName: "Lead A Co", contactName: "Alice" });
  const leadB = await seedLead(repos, WS, { companyName: "Lead B Co", contactName: "Bob" });

  // Attach a unique-marker reply + outreach to EACH lead.
  await repos.reply.create({
    workspaceId: WS, leadId: leadA.id, channel: "whatsapp",
    rawText: "UNIQUE_MARKER_REPLY_LEAD_A_alice_interest", classification: undefined,
  } as Partial<import("@/lib/types").Reply>);
  await repos.reply.create({
    workspaceId: WS, leadId: leadB.id, channel: "whatsapp",
    rawText: "UNIQUE_MARKER_REPLY_LEAD_B_bob_complaint", classification: undefined,
  } as Partial<import("@/lib/types").Reply>);
  await repos.outreachActivity.create({
    workspaceId: WS, leadId: leadA.id, channel: "whatsapp", direction: "outbound",
    status: "sent_manual", sentManually: true, body: "UNIQUE_MARKER_OUTREACH_A", activityAt: daysAgoIso(5),
  } as Partial<import("@/lib/types").OutreachActivity>);
  await repos.outreachActivity.create({
    workspaceId: WS, leadId: leadB.id, channel: "whatsapp", direction: "outbound",
    status: "sent_manual", sentManually: true, body: "UNIQUE_MARKER_OUTREACH_B", activityAt: daysAgoIso(5),
  } as Partial<import("@/lib/types").OutreachActivity>);

  const timelineA = await getLeadActivityTimeline(WS, leadA.id, repos);

  // Hand-computed: every event in lead A's timeline is lead-A-scoped.
  // Lead B's reply/outreach markers must NOT appear.
  for (const event of timelineA.events) {
    const text = `${event.label} ${event.detail || ""}`;
    assert.ok(!text.includes("LEAD_B"), `lead A timeline contains ONLY lead A events (no LEAD_B leak): ${text}`);
    assert.ok(!text.includes("bob"), `lead A timeline contains ONLY lead A events (no Bob leak): ${text}`);
  }
  // And lead A's own markers MUST appear (proves the timeline isn't empty).
  const allText = timelineA.events.map((e) => `${e.label} ${e.detail || ""}`).join("\n");
  assert.ok(allText.includes("LEAD_A"), "lead A timeline includes lead A's own reply marker");
  assert.ok(allText.includes("OUTREACH_A"), "lead A timeline includes lead A's own outreach marker");

  // Symmetric check: lead B's timeline must not contain lead A's markers.
  const timelineB = await getLeadActivityTimeline(WS, leadB.id, repos);
  for (const event of timelineB.events) {
    const text = `${event.label} ${event.detail || ""}`;
    assert.ok(!text.includes("LEAD_A"), `lead B timeline contains ONLY lead B events (no LEAD_A leak): ${text}`);
  }
});

// --- CASE B: getLeadActivityTimeline throws when lead not found ---------------
test("CASE B — getLeadActivityTimeline THROWS when the lead does not exist", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  await assert.rejects(
    () => getLeadActivityTimeline(WS, "nonexistent_lead_id", repos),
    /lead not found/i,
    "timeline for a nonexistent lead rejects with 'Lead not found'",
  );
});

// --- CASE C: getOutreachQueue filters + sorts ----------------------------------
test("CASE C — getOutreachQueue returns ONLY draft+pending_review messages with a lead, sorted by leadScore desc", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  // Three leads with distinct scores.
  const leadHigh = await seedLead(repos, WS, { leadScore: 80 });
  const leadLow = await seedLead(repos, WS, { leadScore: 40 });
  const leadApprovedMsg = await seedLead(repos, WS, { leadScore: 99 });

  // m1: draft + pending_review, lead score 80.
  await repos.messageTemplate.create({
    workspaceId: WS, campaignId: "c1", leadId: leadHigh.id, channel: "whatsapp",
    body: "m1 body", tone: "Professional", language: "English", status: "draft",
    personalizationUsed: { generationMeta: { reviewState: "pending_review" } },
    createdAt: daysAgoIso(1),
  });
  // m2: draft + pending_review, lead score 40.
  await repos.messageTemplate.create({
    workspaceId: WS, campaignId: "c1", leadId: leadLow.id, channel: "whatsapp",
    body: "m2 body", tone: "Professional", language: "English", status: "draft",
    personalizationUsed: { generationMeta: { reviewState: "pending_review" } },
    createdAt: daysAgoIso(2),
  });
  // m3: APPROVED (not draft) — must be EXCLUDED even though lead score is highest.
  await repos.messageTemplate.create({
    workspaceId: WS, campaignId: "c1", leadId: leadApprovedMsg.id, channel: "whatsapp",
    body: "m3 body", tone: "Professional", language: "English", status: "approved",
    personalizationUsed: { generationMeta: { reviewState: "approved" } },
    createdAt: daysAgoIso(0),
  });

  const queue = await getOutreachQueue(WS, repos);

  // Hand-computed: exactly 2 items (m1, m2), sorted by leadScore desc → [80, 40].
  assert.strictEqual(queue.count, 2, "queue count === 2 (m3 approved excluded)");
  assert.strictEqual(queue.items.length, 2, "queue items length === 2");
  assert.strictEqual(queue.items[0].lead.id, leadHigh.id, "first queue item is the highest-score lead (80)");
  assert.strictEqual(queue.items[1].lead.id, leadLow.id, "second queue item is the lower-score lead (40)");
  // The approved message's lead must NOT appear in the queue.
  const queuedLeadIds = queue.items.map((item) => item.lead.id);
  assert.ok(!queuedLeadIds.includes(leadApprovedMsg.id), "approved-status message excluded from the queue");
});

// --- CASE D: getFollowupRadar filters by status + staleness -------------------
test("CASE D — getFollowupRadar returns only stale contacted/replied leads (terminal statuses + fresh excluded)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  // lead X: contacted, 10 days stale → INCLUDED.
  const leadX = await seedLead(repos, WS, { status: "contacted", lastContactedAt: daysAgoIso(10) });
  // lead Y: interested (terminal) + 10 days stale → EXCLUDED.
  await seedLead(repos, WS, { status: "interested", lastContactedAt: daysAgoIso(10) });
  // lead Z: contacted but only 1 day stale → EXCLUDED (under staleDays=3).
  await seedLead(repos, WS, { status: "contacted", lastContactedAt: daysAgoIso(1) });

  const radar = await getFollowupRadar(WS, repos, 3);

  // Hand-computed: exactly lead X.
  assert.strictEqual(radar.count, 1, "radar count === 1 (only lead X is stale + non-terminal)");
  assert.strictEqual(radar.leads.length, 1, "radar leads length === 1");
  assert.strictEqual(radar.leads[0].id, leadX.id, "the included lead is lead X");
  // daysSinceContact on the included lead must be >= staleDays (3).
  assert.ok(radar.leads[0].daysSinceContact >= 3, "included lead's daysSinceContact >= staleDays");
});

// --- CASE E: getDashboardIntelligence counts the right populations ------------
test("CASE E — getDashboardIntelligence counts pending/approved leads, pending drafts, and unread replies", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  // 2 pending + 3 approved leads.
  await seedLead(repos, WS, { reviewStatus: "pending" });
  await seedLead(repos, WS, { reviewStatus: "pending" });
  await seedLead(repos, WS, { reviewStatus: "approved" });
  await seedLead(repos, WS, { reviewStatus: "approved" });
  await seedLead(repos, WS, { reviewStatus: "approved" });
  // 2 pending-review drafts + 1 approved message (not counted as pending).
  const leadForMsg = await seedLead(repos, WS, { reviewStatus: "approved" });
  await repos.messageTemplate.create({
    workspaceId: WS, campaignId: "c1", leadId: leadForMsg.id, channel: "whatsapp",
    body: "d1", tone: "t", language: "l", status: "draft",
    personalizationUsed: { generationMeta: { reviewState: "pending_review" } },
  });
  await repos.messageTemplate.create({
    workspaceId: WS, campaignId: "c1", leadId: leadForMsg.id, channel: "whatsapp",
    body: "d2", tone: "t", language: "l", status: "draft",
    personalizationUsed: { generationMeta: { reviewState: "pending_review" } },
  });
  await repos.messageTemplate.create({
    workspaceId: WS, campaignId: "c1", leadId: leadForMsg.id, channel: "whatsapp",
    body: "d3", tone: "t", language: "l", status: "approved",
    personalizationUsed: { generationMeta: { reviewState: "approved" } },
  });
  // 2 unread replies (no classification) + 1 read reply (classified).
  await repos.reply.create({ workspaceId: WS, leadId: leadForMsg.id, channel: "whatsapp", rawText: "r1", classification: undefined });
  await repos.reply.create({ workspaceId: WS, leadId: leadForMsg.id, channel: "whatsapp", rawText: "r2", classification: undefined });
  await repos.reply.create({ workspaceId: WS, leadId: leadForMsg.id, channel: "whatsapp", rawText: "r3", classification: "interested" });

  const intel = await getDashboardIntelligence(WS, repos);

  // Hand-computed: 2 explicit pending leads + 3 explicit approved leads + the
  // leadForMsg lead (reviewStatus=approved, used as the anchor for messages
  // and replies) = 2 pending, 4 approved total.
  assert.strictEqual(intel.pendingReviewLeads, 2, "2 pending-review leads");
  assert.strictEqual(intel.approvedLeads, 4, "4 approved leads (3 explicit + anchor lead)");
  assert.strictEqual(intel.draftsPendingReview, 2, "2 pending-review drafts (approved message excluded)");
  assert.strictEqual(intel.repliesUnread, 2, "2 unread replies (classified reply excluded)");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`outreach-queue: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
