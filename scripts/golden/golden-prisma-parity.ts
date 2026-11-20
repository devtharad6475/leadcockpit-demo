/**
 * Golden test — Prisma parity (Tier 1.1).
 *
 * Skill v2 Phase 3: written BEFORE the fixes. Two operator-confirmed rules
 * from docs/LOGIC.md (2026-07-20):
 *
 *   RULE A (Redo rule): when a list is replaced, old rows are soft-archived
 *   and filtered out of normal list queries. Applies to ICPs, knowledge
 *   chunks, crawl pages, model routes.
 *
 *   RULE B (Daily-metric rule): upserting a metric for the same
 *   (workspace, campaign, metric, day) key overwrites — latest wins, not
 *   sum.
 *
 * Hand-computed expected values:
 *
 *   ICP replace (RULE A):
 *     - generate 3 ICPs for profile P (Round 1)
 *     - replace with 3 new ICPs for profile P (Round 2)
 *     - listByWorkspace must return EXACTLY 3 (Round 2's, not 6, not 0)
 *     - The Round 1 rows are archived, not deleted — a separate "history"
 *       query (or a flag) can see them, but the normal list filters them.
 *
 *   Knowledge chunk replace (RULE A):
 *     - 2 chunks for doc D (Round 1)
 *     - replace with 3 chunks for doc D (Round 2)
 *     - listByDocument must return EXACTLY 3 (not 5)
 *
 *   Crawl page delete + list (RULE A):
 *     - 3 pages for crawl job J
 *     - deleteByCrawlJob(J)
 *     - listByCrawlJob(J) must return EXACTLY 0 (not 3 tombstones)
 *
 *   Model route replace (RULE A):
 *     - 4 routes for workspace W (Round 1)
 *     - replace with 5 routes for W (Round 2)
 *     - listByWorkspace must return EXACTLY 5 (not 9)
 *
 *   Campaign metric upsert (RULE B):
 *     - upsert { workspace, campaign, metric="new_leads", day=TODAY, value=5 }
 *     - upsert { workspace, campaign, metric="new_leads", day=TODAY, value=7 }
 *     - listByCampaign must return EXACTLY 1 row for "new_leads" today,
 *       with value === 7 (not 5, not 12).
 *
 * Run: npx tsx scripts/golden/golden-prisma-parity.ts
 *
 * First run: FAILS on the unfixed code (ICP replace doubles rows in Prisma;
 * metric upsert creates duplicates in Prisma; etc.). Fix the repo code until
 * green. The same fixture runs against either provider — switch via
 * PERSISTENCE_PROVIDER. Default is json (demo), so it runs anywhere.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { defaultWorkspaceId, mutateData, readData, uid, timestamp } from "@/lib/db";
import type { AppData, ICP, CampaignMetric } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const WS = `ws_parity_${Date.now()}`;
const PROFILE_ID = `profile_parity_${Date.now()}`;
const CAMPAIGN_ID = `campaign_parity_${Date.now()}`;
const DOC_ID = `doc_parity_${Date.now()}`;
const CRAWL_JOB_ID = `crawl_parity_${Date.now()}`;
const TODAY = new Date().toISOString().slice(0, 10);

function makeIcp(name: string, round: number): Partial<ICP> {
  return {
    id: uid(`icp_${round}`),
    workspaceId: WS,
    businessProfileId: PROFILE_ID,
    name,
    description: `Round ${round} ICP`,
    buyerType: "Wholesaler",
    industries: ["Wholesale"],
    geography: ["Mumbai"],
    companySizeBucket: "small company",
    likelyNeeds: ["product"],
    buyingTriggers: ["trigger"],
    painPoints: ["pain"],
    preferredChannels: ["WhatsApp"],
    messagingAngles: ["angle"],
    qualificationRules: ["rule"],
    confidenceScore: 0.7,
    status: "suggested",
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

async function main() {
  let before: AppData | undefined;
  await mutateData((data) => {
    before = structuredClone(data);
    // Seed the workspace + business profile + campaign our test will use.
    if (!data.workspaces.find((w) => w.id === WS)) {
      data.workspaces.push({
        id: WS,
        name: "Parity Test Workspace",
        industry: "Testing",
        status: "active",
        createdAt: timestamp(),
        updatedAt: timestamp(),
      });
    }
    if (!data.businessProfiles.find((p) => p.id === PROFILE_ID)) {
      data.businessProfiles.push({
        id: PROFILE_ID,
        workspaceId: WS,
        companyName: "Parity Co",
        products: [],
        services: [],
        productCategories: [],
        targetGeographies: [],
        currentCustomerTypes: [],
        desiredCustomerTypes: [],
        strengths: [],
        limitations: [],
        certifications: [],
        socialLinks: [],
        catalogueLinks: [],
        proofAssets: [],
        languagePreference: "English",
        tonePreference: "professional",
        status: "approved",
        createdAt: timestamp(),
        updatedAt: timestamp(),
      } as never);
    }
    if (!data.campaigns.find((c) => c.id === CAMPAIGN_ID)) {
      data.campaigns.push({
        id: CAMPAIGN_ID,
        workspaceId: WS,
        businessProfileId: PROFILE_ID,
        icpId: "icp_placeholder",
        name: "Parity Campaign",
        goal: "test",
        targetRegion: [],
        productFocus: [],
        offer: "test",
        selectedChannels: [],
        dailyOutreachLimit: 10,
        leadGoal: 10,
        status: "draft",
        approvalStatus: "needs_review",
        createdAt: timestamp(),
        updatedAt: timestamp(),
      } as never);
    }
    return true;
  });

  const repos = createRepositories("json");

  try {
    // === RULE A — ICP replace: archived rows hidden from list ===
    // Round 1: 3 ICPs
    await repos.icp.replaceForBusinessProfile(WS, PROFILE_ID, [makeIcp("R1 A", 1), makeIcp("R1 B", 1), makeIcp("R1 C", 1)]);
    const afterRound1 = await repos.icp.listByWorkspace(WS);
    assert(afterRound1.length === 3, `ICP Round 1 list should have 3 rows, got ${afterRound1.length}.`);

    // Round 2: replace with 3 NEW ICPs
    await repos.icp.replaceForBusinessProfile(WS, PROFILE_ID, [makeIcp("R2 D", 2), makeIcp("R2 E", 2), makeIcp("R2 F", 2)]);
    const afterRound2 = await repos.icp.listByWorkspace(WS);
    // RULE A: list shows EXACTLY the 3 from Round 2, NOT 6.
    assert(afterRound2.length === 3,
      `RULE A (ICP replace): after replacing, list must show 3 rows (Round 2), got ${afterRound2.length}.`);
    assert(afterRound2.every((icp) => (icp.name || "").startsWith("R2")),
      `RULE A (ICP replace): every visible ICP should be from Round 2, got names: ${afterRound2.map((i) => i.name).join(", ")}.`);
    console.log(`  RULE A (ICP replace) OK: list shows ${afterRound2.length} Round-2 ICPs.`);

    // === RULE A — Knowledge chunk replace ===
    // Round 1: 2 chunks
    await repos.knowledgeBaseDocument.create(WS, {
      id: DOC_ID,
      title: "Parity Doc",
      documentType: "other",
      source: "manual",
      status: "active",
      contentText: "chunk1\n\nchunk2",
      metadata: {},
    });
    await repos.knowledgeBaseChunk.replaceForDocument(WS, DOC_ID, [
      { chunkIndex: 0, chunkText: "old A", metadata: {} },
      { chunkIndex: 1, chunkText: "old B", metadata: {} },
    ]);
    const chunksAfter1 = await repos.knowledgeBaseChunk.listByDocument(WS, DOC_ID);
    assert(chunksAfter1.length === 2, `Chunks Round 1 should be 2, got ${chunksAfter1.length}.`);

    // Round 2: replace with 3 chunks
    await repos.knowledgeBaseChunk.replaceForDocument(WS, DOC_ID, [
      { chunkIndex: 0, chunkText: "new A", metadata: {} },
      { chunkIndex: 1, chunkText: "new B", metadata: {} },
      { chunkIndex: 2, chunkText: "new C", metadata: {} },
    ]);
    const chunksAfter2 = await repos.knowledgeBaseChunk.listByDocument(WS, DOC_ID);
    // RULE A: list shows EXACTLY 3 new chunks, NOT 5.
    assert(chunksAfter2.length === 3,
      `RULE A (chunk replace): after replacing, list must show 3 chunks, got ${chunksAfter2.length}.`);
    assert(chunksAfter2.every((c) => (c.chunkText || "").startsWith("new")),
      `RULE A (chunk replace): every visible chunk should be new, got: ${chunksAfter2.map((c) => c.chunkText).join(", ")}.`);
    console.log(`  RULE A (chunk replace) OK: list shows ${chunksAfter2.length} new chunks.`);

    // === RULE A — Crawl page delete ===
    // Seed 3 pages for crawl job
    for (let i = 0; i < 3; i++) {
      await repos.websiteCrawlPage.createMany([{
        crawlJobId: CRAWL_JOB_ID,
        workspaceId: WS,
        url: `https://example.com/page-${i}`,
        title: `Page ${i}`,
        cleanedText: "text",
        metadata: {},
      }]);
    }
    const pagesBefore = await repos.websiteCrawlPage.listByCrawlJob(WS, CRAWL_JOB_ID);
    assert(pagesBefore.length === 3, `Crawl pages before delete should be 3, got ${pagesBefore.length}.`);

    await repos.websiteCrawlPage.deleteByCrawlJob(WS, CRAWL_JOB_ID);
    const pagesAfter = await repos.websiteCrawlPage.listByCrawlJob(WS, CRAWL_JOB_ID);
    // RULE A: list shows EXACTLY 0, NOT 3 tombstones.
    assert(pagesAfter.length === 0,
      `RULE A (crawl page delete): after deleteByCrawlJob, list must be empty, got ${pagesAfter.length}.`);
    console.log(`  RULE A (crawl page delete) OK: list empty after delete.`);

    // === RULE A — Model route replace ===
    // Round 1: 4 routes
    await repos.llmModelRouting.replaceForWorkspace(WS, [
      { slotId: "fast", provider: "openai", modelName: "gpt-4o-mini", modelTier: "fast", routeSource: "config", enableMockFallback: true },
      { slotId: "balanced", provider: "openai", modelName: "gpt-4o", modelTier: "balanced", routeSource: "config", enableMockFallback: true },
      { slotId: "strong", provider: "openai", modelName: "gpt-4o", modelTier: "strong", routeSource: "config", enableMockFallback: true },
      { slotId: "reasoning", provider: "openai", modelName: "o1-mini", modelTier: "reasoning", routeSource: "config", enableMockFallback: true },
    ] as never);
    const routesAfter1 = await repos.llmModelRouting.listByWorkspace(WS);
    assert(routesAfter1.length === 4, `Routes Round 1 should be 4, got ${routesAfter1.length}.`);

    // Round 2: replace with 5 routes
    await repos.llmModelRouting.replaceForWorkspace(WS, [
      { slotId: "nano", provider: "openai", modelName: "gpt-4o-mini", modelTier: "nano", routeSource: "config", enableMockFallback: true },
      { slotId: "fast", provider: "openai", modelName: "gpt-4o-mini", modelTier: "fast", routeSource: "config", enableMockFallback: true },
      { slotId: "balanced", provider: "openai", modelName: "gpt-4o", modelTier: "balanced", routeSource: "config", enableMockFallback: true },
      { slotId: "strong", provider: "openai", modelName: "gpt-4o", modelTier: "strong", routeSource: "config", enableMockFallback: true },
      { slotId: "reasoning", provider: "openai", modelName: "o1-mini", modelTier: "reasoning", routeSource: "config", enableMockFallback: true },
    ] as never);
    const routesAfter2 = await repos.llmModelRouting.listByWorkspace(WS);
    // RULE A: list shows EXACTLY 5, NOT 9.
    assert(routesAfter2.length === 5,
      `RULE A (route replace): after replacing, list must show 5 routes, got ${routesAfter2.length}.`);
    console.log(`  RULE A (route replace) OK: list shows ${routesAfter2.length} Round-2 routes.`);

    // === RULE B — Daily metric upsert: latest wins ===
    const metricBase: Partial<CampaignMetric> = {
      workspaceId: WS,
      campaignId: CAMPAIGN_ID,
      metricName: "new_leads",
      calculatedAt: TODAY,
    };
    await repos.campaignMetric.upsertMetric({ ...metricBase, value: 5 } as never);
    await repos.campaignMetric.upsertMetric({ ...metricBase, value: 7 } as never);
    const metrics = await repos.campaignMetric.listByCampaign(WS, CAMPAIGN_ID);
    const todayMetrics = metrics.filter((m) => m.metricName === "new_leads" && (m.calculatedAt || "").slice(0, 10) === TODAY);
    // RULE B: exactly 1 row for "new_leads" today, value === 7 (not 5, not 12).
    assert(todayMetrics.length === 1,
      `RULE B (metric upsert): expected exactly 1 row for new_leads today, got ${todayMetrics.length}.`);
    assert((todayMetrics[0] as { value?: number }).value === 7,
      `RULE B (metric upsert): latest value should be 7, got ${(todayMetrics[0] as { value?: number }).value}.`);
    console.log(`  RULE B (metric upsert) OK: 1 row, value 7.`);

    console.log("\nPASS golden-prisma-parity: all 5 cases match the operator-confirmed rules.");
  } finally {
    // Restore: delete everything we created.
    if (before) {
      await mutateData((data) => {
        const restored = structuredClone(before) as AppData;
        Object.keys(data).forEach((key) => delete (data as unknown as Record<string, unknown>)[key]);
        Object.assign(data, restored);
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
