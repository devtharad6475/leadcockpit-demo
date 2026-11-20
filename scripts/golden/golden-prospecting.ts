/**
 * golden-prospecting.ts — ProspectingService pin (NEW coverage, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   ProspectingService had NO golden test (only a flow smoke). It is the
 *   chokepoint that discovers NEW leads and writes them to the lead table.
 *   Two silent-failure modes are load-bearing: (1) a new lead must start at
 *   consentStatus "none" (LOGIC.md Q11 — a fresh prospect has NOT consented to
 *   anything, so the AutoSendGate consent check actually fires); (2) a number
 *   on the permanent DNC registry must NEVER be re-created as a fresh
 *   contactable lead (the Session-3 DNC-resurrection fix). We pin both, plus
 *   the limit cap and the new-lead field defaults. The LLM is the default
 *   mock fallback, so we assert on the DETERMINISTIC record-creation contract,
 *   not the LLM's exact candidate wording.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — prospectForWorkspace creates NEW leads with consentStatus "none".
 *     Without a SerpApi key the service runs in llm_assisted_demo mode and
 *     generates demo candidates deterministically from the campaign/ICP shape.
 *     Hand-computed: every created lead has consentStatus === "none" (NOT
 *     "unknown", NOT undefined). This is LOGIC.md Q11 + the D-5 seed fix. If
 *     consentStatus ever drifts back to "unknown", AutoSendGate's consent
 *     check silently no-ops on fresh prospects → unsolicited sends.
 *
 *   CASE B — the limit cap is respected (Math.max(1, Math.min(limit ?? 5, 12))).
 *     Hand-computed truth table on the input limit:
 *       limit=3   → 3 leads created (within [1,12])
 *       limit=99  → clamped DOWN to 12 (Math.min(..., 12)) — the upper clamp works
 *       limit=0   → FIXED (batch 3, 2026-07-27): nullish-coalescing so 0 is NOT
 *                   swallowed by `||`; reaches the clamp and becomes 1.
 *                   Was: `0 || 5 === 5` made the lower clamp dead code.
 *                   Now: `0 ?? 5 === 0`, then `Math.max(1, 0) === 1`.
 *
 *   CASE C — DNC-registered numbers are SKIPPED (never re-created).
 *     Seed the permanent DNC registry with a phone that one of the demo
 *     candidates will produce. Hand-computed: that candidate is skipped
 *     entirely (no lead row created with that phone). The total created count
 *     drops by the number of DNC-blocked candidates. This is the Session-3
 *     audit fix — without it, an unsubscribed contact gets a fresh
 *     contactable lead row on every prospecting re-run.
 *
 *   CASE D — new-lead field defaults (status / reviewStatus / enrichmentStatus).
 *     Hand-computed for every created lead:
 *       status            === "needs_review"  (queue for human triage)
 *       reviewStatus      === "pending"       (not yet approved)
 *       enrichmentStatus  === "not_started"   (enrichment is a separate step)
 *       doNotContact      === false           (fresh; DNC checked separately)
 *     These are the entry-point defaults; if any drifts, the downstream
 *     gates (auto-approve, enrichment, AutoSend) fire on the wrong population.
 *
 *   CASE E — prospecting requires an APPROVED campaign (throws otherwise).
 *     Hand-computed: calling prospectForWorkspace with a non-existent
 *     campaignId throws (the service refuses to discover prospects without a
 *     campaign). This is the guardrail that prevents free-form discovery.
 *
 * REAL PIPELINE: imports the real ProspectingService + the real JSON repo. The
 * DNC registry lives in the global JSON file (readData/mutateData), so each
 * case cleans its workspace's registry entries first to stay hermetic. Each
 * case uses a unique timestamped workspace so demo data stays clean.
 *
 * Run: `npm run golden:prospecting`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { ProspectingService as RealProspectingService } from "@/services/ProspectingService";
import { createAmbientRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { BusinessProfile, Campaign } from "@/lib/types";
import { mutateData, defaultWorkspaceId } from "@/lib/db";
import type { ICP } from "@/lib/types";

/**
 * 2026-09-27 (break test L1): invented sample prospects are now produced ONLY
 * for the sample company on the demo site; any other workspace with no search
 * key finds nobody. These cases pin what happens to candidates AFTER search
 * (consent, limits, DNC, defaults), so they ask the real sample-prospect path
 * for its candidates as the sample company would, and keep their own
 * timestamped workspaces for everything else.
 */
class ProspectingService extends RealProspectingService {
  async searchGoogleMaps(query: string, limit: number, campaign?: Campaign, icp?: ICP, workspaceKey?: string) {
    return super.searchGoogleMaps(query, limit, campaign ? { ...campaign, workspaceId: defaultWorkspaceId } : campaign, icp, workspaceKey);
  }
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_prospect_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// Ensure PLATFORM_SERPAPI_API_KEY / SERPAPI_API_KEY are unset so the service
// runs in deterministic llm_assisted_demo mode (no live network calls).
delete process.env.PLATFORM_SERPAPI_API_KEY;
delete process.env.SERPAPI_API_KEY;

/**
 * Make the tenant real, then make its DNC registry empty.
 *
 * A-7 (2026-08-25): this golden used to pin itself to JSON, so it proved the
 * DNC-resurrection rule against a file format production never uses. It now
 * follows the process - JSON on the normal suite run, the private Postgres
 * clone under the A-7 pass - and that costs it two things it never needed
 * before.
 *
 * First, the tenant has to exist: `ws_golden_prospect_C_...` is invented here,
 * and Postgres will not hang a lead or a registry entry off a workspace row
 * that was never created.
 *
 * Second, the registry wipe has to stop reaching into the JSON file directly.
 * Every case already invents a fresh timestamped workspace, so there is
 * nothing of its own to clean; the wipe is belt-and-braces against a re-run
 * colliding, and on Postgres the whole database is a throwaway clone. So it is
 * a no-op off JSON rather than a lie about which substrate it cleaned.
 */
async function cleanDncForWorkspace(repos: RepositoryBundle, ws: string) {
  await ensureWorkspace(repos, ws, `prospecting golden ${ws}`);
  if (process.env.PERSISTENCE_PROVIDER === "prisma") return;
  await mutateData(async (data) => {
    data.doNotContactRegistry = (data.doNotContactRegistry || []).filter((entry) => entry.workspaceId !== ws);
    return data;
  });
}

async function seedProfileAndCampaign(repos: RepositoryBundle, ws: string): Promise<{ profile: BusinessProfile; campaign: Campaign }> {
  const profile = await repos.businessProfile.create({
    workspaceId: ws,
    companyName: "Acme Threads Pvt Ltd",
    products: ["zari thread"],
    productCategories: ["textiles"],
    tonePreference: "Professional",
    languagePreference: "English",
    status: "approved",
  } as Partial<BusinessProfile>);
  // A-7: `icpId: "icp_test"` used to be a made-up string. JSON accepted it;
  // Postgres refused with campaigns_icp_id_fkey, because a campaign without a
  // real ICP is not a thing the product can produce. Seed the real row.
  const [icp] = await repos.icp.createMany([{
    workspaceId: ws,
    businessProfileId: profile.id,
    name: "Surat wholesale zari buyers",
    description: "Wholesale buyers of zari thread in the Surat textile market",
    buyerType: "wholesaler",
    industries: ["textiles"],
    geography: ["Surat"],
    companySizeBucket: "small company",
    likelyNeeds: ["bulk pricing"],
    buyingTriggers: ["festive season stocking"],
    painPoints: ["inconsistent supply"],
    preferredChannels: ["whatsapp"],
    messagingAngles: ["Lead with catalogue"],
    qualificationRules: ["bulk buyer"],
    confidenceScore: 0.8,
    status: "selected",
  }]);
  const campaign = await repos.campaign.create({
    workspaceId: ws,
    businessProfileId: profile.id,
    icpId: icp.id,
    name: "Surat Buyer Outreach",
    goal: "Find new wholesale buyers",
    targetRegion: ["Surat"],
    productFocus: ["zari thread"],
    offer: "Bulk pricing on zari thread",
    selectedChannels: ["whatsapp"],
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
  return { profile, campaign };
}

// --- CASE A: new leads get consentStatus "none" --------------------------------
test("CASE A — prospectForWorkspace creates NEW leads with consentStatus 'none' (LOGIC.md Q11)", async () => {
  const repos = createAmbientRepos();
  const WS = caseWorkspace("A");
  await cleanDncForWorkspace(repos, WS);
  const { campaign } = await seedProfileAndCampaign(repos, WS);

  const service = new ProspectingService(repos);
  const result = await service.prospectForWorkspace({
    workspaceId: WS,
    campaignId: campaign.id,
    limit: 3,
  });

  assert.ok(result.created >= 1, `at least 1 lead created (demo mode), got created=${result.created}`);
  // Hand-computed: EVERY created lead must carry consentStatus "none".
  for (const lead of result.leads) {
    assert.strictEqual(lead.consentStatus, "none", `lead ${lead.id} consentStatus === 'none' (NOT unknown/undefined)`);
  }
  // Also verify via the repo (round-trip through persistence).
  const persisted = await repos.lead.listLeads(WS);
  for (const lead of persisted) {
    assert.strictEqual(lead.consentStatus, "none", `persisted lead ${lead.id} consentStatus === 'none'`);
  }
});

// --- CASE B: limit cap respected -----------------------------------------------
test("CASE B — limit is clamped to [1, 12] (Math.max(1, Math.min(limit, 12)))", async () => {
  const repos = createAmbientRepos();

  // Subcase B1: limit=3 → at most 3 created.
  const WS3 = caseWorkspace("B3");
  await cleanDncForWorkspace(repos, WS3);
  const { campaign: c3 } = await seedProfileAndCampaign(repos, WS3);
  const r3 = await new ProspectingService(repos).prospectForWorkspace({ workspaceId: WS3, campaignId: c3.id, limit: 3 });
  assert.ok(r3.created <= 3, `limit=3 → created <= 3, got ${r3.created}`);
  assert.ok(r3.created >= 1, `limit=3 → created >= 1 (demo candidates produced), got ${r3.created}`);

  // Subcase B2: limit=0 → FIXED (batch 3, 2026-07-27). Was dead-code: `0 || 5`
  // === 5 in JS, so 0 silently became 5 (lower clamp unreachable). Root cause:
  // `Number(input.limit || 5)` used logical-or. Fix: `Number(input.limit ?? 5)`
  // (nullish coalescing) — only null/undefined fall back to default, explicit 0
  // reaches the clamp and becomes 1. Now hand-computed: limit=0 → clamp to 1
  // → exactly 1 lead created (the demo candidate generator always produces ≥1).
  const WS0 = caseWorkspace("B0");
  await cleanDncForWorkspace(repos, WS0);
  const { campaign: c0 } = await seedProfileAndCampaign(repos, WS0);
  const r0 = await new ProspectingService(repos).prospectForWorkspace({ workspaceId: WS0, campaignId: c0.id, limit: 0 });
  assert.ok(r0.created >= 1 && r0.created <= 1, `limit=0 → clamp UP to 1 → created === 1, got ${r0.created} (FIXED batch 3: nullish-coalesce so 0 reaches the lower clamp)`);

  // Subcase B3: limit=99 → clamped DOWN to 12 (Math.min(..., 12)).
  const WS99 = caseWorkspace("B99");
  await cleanDncForWorkspace(repos, WS99);
  const { campaign: c99 } = await seedProfileAndCampaign(repos, WS99);
  const r99 = await new ProspectingService(repos).prospectForWorkspace({ workspaceId: WS99, campaignId: c99.id, limit: 99 });
  assert.ok(r99.created <= 12, `limit=99 clamped to 12 → created <= 12, got ${r99.created}`);
});

// --- CASE C: DNC-registered numbers are SKIPPED --------------------------------
test("CASE C — DNC-registered phone numbers are SKIPPED (never re-created as fresh leads)", async () => {
  const repos = createAmbientRepos();
  const WS = caseWorkspace("C");
  await cleanDncForWorkspace(repos, WS);
  const { campaign } = await seedProfileAndCampaign(repos, WS);

  // First run: discover some leads and capture the phone of the first one.
  const service = new ProspectingService(repos);
  const firstRun = await service.prospectForWorkspace({ workspaceId: WS, campaignId: campaign.id, limit: 2 });
  assert.ok(firstRun.created >= 1, "first run created at least 1 lead");
  const dncPhone = firstRun.leads[0].whatsappNumber || firstRun.leads[0].phone;
  assert.ok(dncPhone, "first run produced a lead with a phone number (needed for the DNC test)");

  // Register that phone on the permanent DNC registry.
  const { registerDoNotContact } = await import("@/lib/dnc-registry");
  await registerDoNotContact(WS, { phone: dncPhone, reason: "Customer opted out", sourceLeadId: firstRun.leads[0].id }, repos);

  // Delete ALL leads in this workspace so the next run starts fresh (otherwise
  // the duplicate-detection path updates the existing lead instead of
  // creating, which would not exercise the DNC-skip branch).
  for (const lead of await repos.lead.listLeads(WS)) {
    try { await repos.lead.deleteById(WS, lead.id); } catch { /* best-effort */ }
  }

  // Second run with the SAME campaign/query shape: the demo candidate
  // generator is deterministic given the same campaign, so it produces the
  // same phone. That candidate must now be SKIPPED (DNC).
  // To force the same phone to re-appear we re-run with the same limit.
  const secondRun = await service.prospectForWorkspace({ workspaceId: WS, campaignId: campaign.id, limit: 2 });

  // Hand-computed: NONE of the newly-created leads carry the DNC phone.
  for (const lead of secondRun.leads) {
    const phone = lead.whatsappNumber || lead.phone;
    if (phone) {
      const { isPermanentlyDoNotContact } = await import("@/lib/dnc-registry");
      const blocked = await isPermanentlyDoNotContact(WS, { phone }, repos);
      assert.strictEqual(blocked, false, `DNC-blocked phone ${phone} was NOT re-created as a fresh lead (Session-3 fix)`);
    }
  }
});

// --- CASE D: new-lead field defaults -------------------------------------------
test("CASE D — new leads carry the correct entry-point defaults (status/reviewStatus/enrichmentStatus/doNotContact)", async () => {
  const repos = createAmbientRepos();
  const WS = caseWorkspace("D");
  await cleanDncForWorkspace(repos, WS);
  const { campaign } = await seedProfileAndCampaign(repos, WS);

  const result = await new ProspectingService(repos).prospectForWorkspace({
    workspaceId: WS, campaignId: campaign.id, limit: 2,
  });

  assert.ok(result.created >= 1, "at least one lead created");
  for (const lead of result.leads) {
    assert.strictEqual(lead.status, "needs_review", `lead ${lead.id} status === 'needs_review'`);
    assert.strictEqual(lead.reviewStatus, "pending", `lead ${lead.id} reviewStatus === 'pending'`);
    assert.strictEqual(lead.enrichmentStatus, "not_started", `lead ${lead.id} enrichmentStatus === 'not_started'`);
    assert.strictEqual(lead.doNotContact, false, `lead ${lead.id} doNotContact === false (fresh)`);
    assert.strictEqual(lead.campaignId, campaign.id, `lead ${lead.id} attached to the campaign`);
    assert.strictEqual(lead.workspaceId, WS, `lead ${lead.id} scoped to this workspace`);
  }
});

// --- CASE E: prospecting requires an APPROVED campaign -------------------------
test("CASE E — prospectForWorkspace THROWS when the campaign does not exist", async () => {
  const repos = createAmbientRepos();
  const WS = caseWorkspace("E");
  await cleanDncForWorkspace(repos, WS);
  // Note: we deliberately do NOT seed a campaign for this workspace.
  const service = new ProspectingService(repos);
  await assert.rejects(
    () => service.prospectForWorkspace({ workspaceId: WS, campaignId: "nonexistent_campaign", limit: 1 }),
    /campaign/i,
    "prospecting without an approved campaign throws",
  );
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
  console.log(`prospecting: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
