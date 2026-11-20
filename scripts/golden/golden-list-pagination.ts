/**
 * golden-list-pagination.ts — P-3 fix pin (Session 7, 2026-07-28).
 *
 * WHY THIS TEST EXISTS:
 *   The list endpoints (GET /leads, etc.) returned the ENTIRE workspace
 *   collection with no row cap — at multi-tenant scale every dashboard load
 *   shipped a multi-MB JSON blob and could OOM Node (audit S7 P-3). The fix
 *   adds OPT-IN pagination to the lead list path: a new `listLeadsPage` repo
 *   method + the GET /leads endpoint accepts ?limit/?offset. The base
 *   `listLeads` is deliberately LEFT UNCAPPED because internal services
 *   (LeadReviewBatchService, ProspectingService dedup, OutreachQueueService)
 *   genuinely need ALL leads — silently paginating those would break counts and
 *   miss leads (the classic ripple trap). This golden pins the paginated path.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — written first):
 *   Seed 7 leads in an isolated workspace. Default page size = DEFAULT_PAGE_SIZE.
 *   P1 — listLeadsPage(ws, {limit:3, offset:0}) → 3 items, total=7, hasMore=true.
 *   P2 — listLeadsPage(ws, {limit:3, offset:3}) → 3 items (page 2), hasMore=true.
 *   P3 — listLeadsPage(ws, {limit:3, offset:6}) → 1 item (page 3), hasMore=false.
 *   P4 — listLeadsPage(ws, {limit:3, offset:10}) → 0 items, hasMore=false (past end).
 *   P5 — limit above the HARD CEILING is clamped to the ceiling (no unbounded query).
 *   P6 — workspace-scoped: another workspace's leads never appear.
 *   P7 — filters still apply within a page (e.g. campaignId).
 *
 * Run: `npm run golden:list-pagination`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { listLeadsPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/services/LeadListPagination";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS_A = `ws_golden_page_a_${RUN}`;
const WS_B = `ws_golden_page_b_${RUN}`;
const CAMPAIGN = `camp_golden_page_${RUN}`;

async function seedLead(repos: RepositoryBundle, workspaceId: string, name: string, campaignId?: string) {
  return repos.lead.createLead({
    workspaceId,
    companyName: name,
    source: "manual",
    status: "prospected",
    reviewStatus: "pending",
    consentStatus: "none",
    campaignId,
  });
}

async function cleanup(repos: RepositoryBundle, ...ws: string[]) {
  for (const w of ws) {
    const leads = await repos.lead.listLeads(w);
    for (const l of leads) {
      try { await repos.lead.deleteById(w, l.id); } catch { /* best effort */ }
    }
  }
}

async function main() {
  const repos = createRepositories("json");

  // Seed 7 leads in WS_A (5 in the campaign, 2 not); 2 leads in WS_B (isolation).
  for (let i = 0; i < 5; i++) await seedLead(repos, WS_A, `A-campaign-${i}`, CAMPAIGN);
  await seedLead(repos, WS_A, "A-other-1");
  await seedLead(repos, WS_A, "A-other-2");
  await seedLead(repos, WS_B, "B-1");
  await seedLead(repos, WS_B, "B-2");

  // P1 — first page.
  {
    const page = await listLeadsPage(repos, WS_A, { limit: 3, offset: 0 });
    assert.strictEqual(page.items.length, 3, `P1: page 1 has 3 items, got ${page.items.length}`);
    assert.strictEqual(page.total, 7, `P1: total = 7, got ${page.total}`);
    assert.strictEqual(page.limit, 3, "P1: limit echoed = 3");
    assert.strictEqual(page.offset, 0, "P1: offset echoed = 0");
    assert.strictEqual(page.hasMore, true, "P1: hasMore true (7 > 3)");
    console.log("  P1 OK: page 1 → 3 items, total 7, hasMore true.");
  }

  // P2 — second page.
  {
    const page = await listLeadsPage(repos, WS_A, { limit: 3, offset: 3 });
    assert.strictEqual(page.items.length, 3, `P2: page 2 has 3 items, got ${page.items.length}`);
    assert.strictEqual(page.total, 7, "P2: total still 7");
    assert.strictEqual(page.hasMore, true, "P2: hasMore true (6 used, 7 total)");
    // No overlap with page 1: the two pages' ids are disjoint.
    const p1 = await listLeadsPage(repos, WS_A, { limit: 3, offset: 0 });
    const p2ids = new Set(page.items.map((l) => l.id));
    assert.ok(p1.items.every((l) => !p2ids.has(l.id)), "P2: page 2 ids are disjoint from page 1 (no dupes)");
    console.log("  P2 OK: page 2 → 3 items, disjoint from page 1 (no duplicate leads across pages).");
  }

  // P3 — last partial page.
  {
    const page = await listLeadsPage(repos, WS_A, { limit: 3, offset: 6 });
    assert.strictEqual(page.items.length, 1, `P3: page 3 has 1 item (the remainder), got ${page.items.length}`);
    assert.strictEqual(page.hasMore, false, "P3: hasMore false (7 ≤ 6+1)");
    console.log("  P3 OK: page 3 → 1 item (remainder), hasMore false.");
  }

  // P4 — offset past the end → empty page, hasMore false (no crash).
  {
    const page = await listLeadsPage(repos, WS_A, { limit: 3, offset: 10 });
    assert.strictEqual(page.items.length, 0, `P4: past-end page → 0 items, got ${page.items.length}`);
    assert.strictEqual(page.total, 7, "P4: total still 7 (total is independent of offset)");
    assert.strictEqual(page.hasMore, false, "P4: hasMore false past the end");
    console.log("  P4 OK: offset past end → 0 items, no crash, total still reported.");
  }

  // P5 — limit above the HARD CEILING is clamped (no unbounded query possible).
  {
    const page = await listLeadsPage(repos, WS_A, { limit: 1_000_000, offset: 0 });
    assert.ok(page.limit <= MAX_PAGE_SIZE, `P5: limit clamped to ≤ MAX_PAGE_SIZE (${MAX_PAGE_SIZE}), got ${page.limit}`);
    assert.strictEqual(page.limit, MAX_PAGE_SIZE, `P5: limit clamped to exactly MAX_PAGE_SIZE, got ${page.limit}`);
    console.log(`  P5 OK: limit 1,000,000 clamped to MAX_PAGE_SIZE (${MAX_PAGE_SIZE}) — no unbounded query.`);
  }

  // P6 — workspace-scoped: WS_B's leads never appear in WS_A's pages.
  {
    const allPages: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await listLeadsPage(repos, WS_A, { limit: 3, offset });
      allPages.push(...page.items.map((l) => l.companyName || ""));
      if (!page.hasMore) break;
      offset += page.items.length;
    }
    assert.strictEqual(allPages.length, 7, `P6: paginated through all 7 WS_A leads, got ${allPages.length}`);
    assert.ok(allPages.every((name) => !name.startsWith("B-")), "P6: no WS_B lead leaked into WS_A pages (workspace-scoped)");
    console.log("  P6 OK: full pagination sweep returns exactly WS_A's 7 leads (no cross-tenant leak).");
  }

  // P7 — filters apply within pagination (campaignId narrows the page).
  {
    const page = await listLeadsPage(repos, WS_A, { limit: 10, offset: 0, filters: { campaignId: CAMPAIGN } });
    assert.strictEqual(page.total, 5, `P7: campaign filter → total 5, got ${page.total}`);
    assert.strictEqual(page.items.length, 5, `P7: campaign filter → 5 items, got ${page.items.length}`);
    assert.ok(page.items.every((l) => (l.companyName || "").startsWith("A-campaign-")), "P7: every item is a campaign lead");
    console.log("  P7 OK: campaignId filter narrows the page (total 5, all campaign leads).");
  }

  // P8 — default page size is sensible (DEFAULT_PAGE_SIZE is a positive integer).
  {
    assert.ok(DEFAULT_PAGE_SIZE > 0 && Number.isInteger(DEFAULT_PAGE_SIZE), `P8: DEFAULT_PAGE_SIZE is a positive int, got ${DEFAULT_PAGE_SIZE}`);
    assert.ok(DEFAULT_PAGE_SIZE <= MAX_PAGE_SIZE, "P8: DEFAULT ≤ MAX");
    const page = await listLeadsPage(repos, WS_A, { offset: 0 }); // no limit → default
    assert.strictEqual(page.limit, DEFAULT_PAGE_SIZE, `P8: omitted limit → DEFAULT_PAGE_SIZE (${DEFAULT_PAGE_SIZE})`);
    console.log(`  P8 OK: default page size = ${DEFAULT_PAGE_SIZE} (sensible, ≤ MAX ${MAX_PAGE_SIZE}).`);
  }

  await cleanup(repos, WS_A, WS_B);
  console.log("\nPASS golden-list-pagination: listLeadsPage contract pinned (8 cases — pages, ceiling, scope, filters).");
}

main().catch(async (err) => {
  console.error("\nFAIL golden-list-pagination:", err.message);
  const repos = createRepositories("json");
  await cleanup(repos, WS_A, WS_B);
  process.exit(1);
});
