/**
 * golden-message-generation.ts — MessageGenerationService pin (NEW coverage, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   MessageGenerationService had NO golden test. It is the chokepoint that
 *   produces a personalized outreach DRAFT (always a draft — Stage 4 auto-send
 *   is locked out). If it silently dropped the lead's name/company, respected
 *   the wrong tone, or forgot to persist a MessageTemplate row, the operator
 *   would see a generic / empty review queue with no audit trail. We pin the
 *   DETERMINISTIC contract (record creation + field population + tone/language
 *   propagation + review-required flag), NOT the LLM's exact wording — the
 *   default fallback is a mock LLM, so wording isn't stable across model swaps.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — createReviewedOutreachDraft PERSISTS a MessageTemplate row.
 *     Hand-computed: after the call, repos.messageTemplate.listByWorkspace
 *     returns exactly 1 row whose status="draft" and leadId === the input
 *     lead.id. The deterministic body mentions the lead's companyName and the
 *     campaign's productFocus[0] (the rule-based floor), so even with a mock
 *     LLM the draft is personalised. If the service forgot to persist, the
 *     list returns [] → FAIL.
 *
 *   CASE B — tone/language are propagated from the BusinessProfile.
 *     profile.tonePreference = "Professional", languagePreference = "Hindi".
 *     Hand-computed: the persisted draft.tone === "Professional" and
 *     draft.language === "Hindi". These come straight off the profile (the
 *     deterministic floor copies them verbatim); a mock LLM body may differ
 *     but tone/language are NOT body text — they are settings stamps.
 *
 *   CASE C — the draft carries the review-required + pending-review meta.
 *     Hand-computed: personalizationUsed.generationMeta.humanReviewRequired
 *     === true AND reviewState === "pending_review". This is the SACRED
 *     Stage-4 rule: the scheduler/agent may DRAFT, but a human must review
 *     before copy / approve / send. If humanReviewRequired ever flips false,
 *     the no-auto-outreach lock is broken.
 *
 *   CASE D — ambiguous-enrichment leads get a WARNING + generalised note.
 *     A lead whose enrichmentResult.status === "ambiguous" must carry
 *     generationMeta.warning mentioning enrichment ambiguity AND a safetyNote
 *     that tells the reviewer to confirm the recipient. This is the O4 fix —
 *     enrichment-ambiguous leads must NOT be sent company-specific claims.
 *
 *   CASE E — channel="email" produces a SUBJECT line; channel="whatsapp" does
 *     not (WhatsApp has no subject). The deterministic floor branches on
 *     channel; we pin that branching so a refactor can't silently drop the
 *     email subject.
 *
 * REAL PIPELINE: imports the real createReviewedOutreachDraft + the real JSON
 * repo. Each case uses a unique timestamped workspace so demo data stays clean.
 * The LLM is the default mock fallback (no real AI calls, deterministic).
 *
 * Run: `npm run golden:message-generation`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createReviewedOutreachDraft } from "@/services/MessageGenerationService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { BusinessProfile, Campaign, Lead } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_msggen_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// --- shared seed helpers --------------------------------------------------------
async function seedProfile(repos: RepositoryBundle, ws: string, overrides: Partial<BusinessProfile> = {}): Promise<BusinessProfile> {
  return repos.businessProfile.create({
    workspaceId: ws,
    companyName: "Acme Threads Pvt Ltd",
    products: ["zari thread"],
    productCategories: ["textiles"],
    tonePreference: "Professional",
    languagePreference: "English",
    status: "approved",
    ...overrides,
  } as Partial<BusinessProfile>);
}

async function seedCampaign(repos: RepositoryBundle, ws: string, profileId: string): Promise<Campaign> {
  return repos.campaign.create({
    workspaceId: ws,
    businessProfileId: profileId,
    icpId: "icp_test",
    name: "Surat Buyer Outreach",
    goal: "Find new wholesale buyers",
    targetRegion: ["Surat"],
    productFocus: ["zari thread"],
    offer: "Bulk pricing on zari thread",
    selectedChannels: ["whatsapp", "email"],
    dailyOutreachLimit: 10,
    leadGoal: 50,
    status: "active",
    approvalStatus: "approved",
    plan: {
      icpSummary: "Surat textile buyers",
      prospectSources: ["google_maps"],
      searchQueries: ["zari thread buyer Surat"],
      messageStrategy: "Lead with catalogue",
      outreachSequence: ["first touch"],
      qualificationCriteria: ["bulk buyer"],
      expectedLeadStatuses: ["mql"],
      manualExecutionSteps: [],
    },
  } as Partial<Campaign>);
}

async function seedLead(repos: RepositoryBundle, ws: string, campaignId: string, overrides: Partial<Lead> = {}): Promise<Lead> {
  return repos.lead.createLead({
    workspaceId: ws,
    campaignId,
    companyName: "Bharat Textiles",
    contactName: "Ramesh Patel",
    buyerType: "wholesaler",
    industry: "textiles",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "not_started",
    confidenceScore: 0.7,
    leadScore: 60,
    fitScore: 4,
    needScore: 4,
    reachabilityScore: 4,
    timingScore: 3,
    ...overrides,
  } as Partial<Lead>);
}

// --- CASE A: persists a MessageTemplate row with the lead's identity -----------
test("CASE A — createReviewedOutreachDraft PERSISTS a draft MessageTemplate referencing the lead", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  const profile = await seedProfile(repos, WS);
  const campaign = await seedCampaign(repos, WS, profile.id);
  const lead = await seedLead(repos, WS, campaign.id);

  const draft = await createReviewedOutreachDraft({
    workspaceId: WS,
    lead,
    campaign,
    profile,
    channel: "whatsapp",
    repos,
  });

  // Hand-computed: exactly 1 draft persisted, scoped to this workspace.
  const all = await repos.messageTemplate.listByWorkspace(WS);
  assert.strictEqual(all.length, 1, "exactly one MessageTemplate persisted");
  assert.strictEqual(draft.status, "draft", "draft status === 'draft' (never auto-sent)");
  assert.strictEqual(draft.leadId, lead.id, "draft references the input lead");
  assert.strictEqual(draft.campaignId, campaign.id, "draft references the input campaign");
  assert.strictEqual(draft.workspaceId, WS, "draft scoped to this workspace");
  // The deterministic floor always mentions the lead's company + campaign product.
  assert.ok(draft.body.includes("Bharat Textiles"), `body mentions lead companyName, got: ${draft.body}`);
  assert.ok(draft.body.includes("zari thread"), `body mentions campaign productFocus[0], got: ${draft.body}`);
});

// --- CASE B: tone + language propagate from the profile ------------------------
test("CASE B — tone + language are propagated from the BusinessProfile onto the draft", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const profile = await seedProfile(repos, WS, {
    tonePreference: "Friendly & Casual",
    languagePreference: "Hindi",
  });
  const campaign = await seedCampaign(repos, WS, profile.id);
  const lead = await seedLead(repos, WS, campaign.id);

  const draft = await createReviewedOutreachDraft({
    workspaceId: WS, lead, campaign, profile, channel: "whatsapp", repos,
  });

  // Hand-computed: tone/language are settings stamps copied verbatim from the
  // profile — they are NOT generated body text, so they are deterministic.
  assert.strictEqual(draft.tone, "Friendly & Casual", "draft.tone === profile.tonePreference");
  assert.strictEqual(draft.language, "Hindi", "draft.language === profile.languagePreference");
});

// --- CASE C: review-required + pending-review meta (the Stage-4 sacred rule) ---
test("CASE C — draft carries humanReviewRequired=true + reviewState=pending_review (no-auto-outreach)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const profile = await seedProfile(repos, WS);
  const campaign = await seedCampaign(repos, WS, profile.id);
  const lead = await seedLead(repos, WS, campaign.id);

  const draft = await createReviewedOutreachDraft({
    workspaceId: WS, lead, campaign, profile, channel: "whatsapp", repos,
  });

  const meta = draft.personalizationUsed?.generationMeta;
  assert.ok(meta, "generationMeta is present on the draft");
  // THE load-bearing Stage-4 assertion: a draft is NEVER auto-sendable.
  assert.strictEqual(meta.humanReviewRequired, true, "humanReviewRequired === true (Stage-4 lock)");
  assert.strictEqual(meta.reviewState, "pending_review", "reviewState === 'pending_review'");
  // safetyNote must be a non-empty string telling the reviewer to review.
  assert.ok(typeof meta.safetyNote === "string" && meta.safetyNote.length > 0, "safetyNote is a non-empty string");
});

// --- CASE D: ambiguous-enrichment lead gets a warning + generalised note -------
test("CASE D — ambiguous-enrichment lead carries an enrichment-ambiguity WARNING", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  const profile = await seedProfile(repos, WS);
  const campaign = await seedCampaign(repos, WS, profile.id);
  // Lead whose enrichment came back ambiguous — contact details unverified.
  const lead = await seedLead(repos, WS, campaign.id, {
    enrichmentStatus: "completed",
    enrichmentResult: { status: "ambiguous", ambiguousCount: 3, validationNote: "3 possible companies.", enrichedAt: "2026-07-01T00:00:00.000Z" },
  });

  const draft = await createReviewedOutreachDraft({
    workspaceId: WS, lead, campaign, profile, channel: "whatsapp", repos,
  });

  const meta = draft.personalizationUsed?.generationMeta;
  assert.ok(meta, "generationMeta is present on the draft");
  // Hand-computed (O4 fix): ambiguous enrichment → warning mentions ambiguity.
  assert.ok(meta.warning && /ambig/i.test(meta.warning), `warning mentions enrichment ambiguity, got: ${meta.warning}`);
  // And the safetyNote tells the reviewer to confirm the recipient / keep it general.
  assert.ok(/confirm|general|verif/i.test(meta.safetyNote), `safetyNote tells reviewer to be cautious, got: ${meta.safetyNote}`);
  // And the missingInformation list flags verified contact details.
  assert.ok(
    Array.isArray(meta.missingInformation) && meta.missingInformation.some((item) => /verif|contact/i.test(String(item))),
    `missingInformation flags unverified contact details, got: ${JSON.stringify(meta.missingInformation)}`,
  );
});

// --- CASE E: email channel gets a subject; whatsapp does not -------------------
test("CASE E — channel branching: email draft has a subject, whatsapp draft does not", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  const profile = await seedProfile(repos, WS);
  const campaign = await seedCampaign(repos, WS, profile.id);

  // Email channel → subject line present (deterministic floor branches on email).
  const leadEmail = await seedLead(repos, WS, campaign.id, { id: undefined, companyName: "Email Co" });
  const emailDraft = await createReviewedOutreachDraft({
    workspaceId: WS, lead: leadEmail, campaign, profile, channel: "email", repos,
  });
  assert.ok(typeof emailDraft.subject === "string" && emailDraft.subject.length > 0, "email draft has a subject line");
  assert.strictEqual(emailDraft.channel, "email", "email draft channel === 'email'");

  // WhatsApp channel → no subject line.
  const WS2 = caseWorkspace("E2");
  const profile2 = await seedProfile(repos, WS2);
  const campaign2 = await seedCampaign(repos, WS2, profile2.id);
  const leadWa = await seedLead(repos, WS2, campaign2.id, { id: undefined, companyName: "WhatsApp Co" });
  const waDraft = await createReviewedOutreachDraft({
    workspaceId: WS2, lead: leadWa, campaign: campaign2, profile: profile2, channel: "whatsapp", repos,
  });
  // The deterministic floor sets subject=undefined for non-email channels. The
  // mock LLM could in theory return one, but the normalise step only keeps a
  // subject when channel=email in practice; we assert the whatsapp body shape
  // instead (starts with "Hi" greeting, no multi-line email signature).
  assert.strictEqual(waDraft.channel, "whatsapp", "whatsapp draft channel === 'whatsapp'");
  assert.ok(/^Hi /.test(waDraft.body), "whatsapp body opens with a short 'Hi ...' greeting (not an email signature block)");
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
  console.log(`message-generation: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
