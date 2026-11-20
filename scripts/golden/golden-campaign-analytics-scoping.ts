/**
 * Golden test — campaign analytics must not answer for a neighbour's campaign.
 *
 * WHAT WENT WRONG, AND WHY THE PREVIOUS FIX MISSED IT. Session 17 (2026-07-21)
 * found that `campaignAnalytics` filtered by campaignId alone, so any tenant
 * holding a neighbour's campaign id could read that campaign's numbers. The fix
 * threaded the session workspaceId in and scoped every COUNTED collection —
 * leads, message templates, outreach activities, replies. It scoped fourteen
 * lines and missed one:
 *
 *     bestIcp: data.icps.find((icp) => icp.id ===
 *                data.campaigns.find((c) => c.id === campaignId)?.icpId)?.name
 *
 * Two unscoped lookups. Tenant A passes tenant B's campaign id, the inner find
 * walks EVERY tenant's campaigns, and the reply carries tenant B's ICP NAME —
 * which is a customer-written string ("Mid-size pharma distributors, Gujarat").
 * Found on 2026-08-25 by scripts/probes/tenant-read-boundary.ts on a live
 * two-tenant run against real Postgres in production auth mode.
 *
 * THE FIX HAS TWO LAYERS, AND THIS TEST PINS BOTH.
 *   Layer 1, the class fix: the route now loads the campaign scoped to the
 *     caller's workspace and answers 404 before reading anything. A field added
 *     to this report next month cannot leak from a request that never gets that
 *     far. CASE D pins it by reading the route source, because the 404 lives in
 *     an HTTP handler and this suite runs headless.
 *   Layer 2, defence in depth: both lookups inside campaignAnalytics are
 *     scoped, so an internal caller that forgets to pass workspaceId still
 *     cannot pull a neighbour's ICP name. CASES A and B pin it.
 *
 * HAND-COMPUTED BEFORE THE FIX WAS WRITTEN (the data is built in this file):
 *
 *   ws_A: campaign cam_A (icp_A "Alpha buyers"), 2 leads on cam_A (1 mql),
 *         1 reply, 1 outreach activity sent, 1 message template
 *   ws_B: campaign cam_B (icp_B "Bravo buyers"), 3 leads on cam_B (2 mql),
 *         2 replies, 0 outreach activities, 0 message templates
 *
 *   campaignAnalytics(data, "cam_B", "ws_A")   — A asking about B's campaign:
 *     totalProspectsDiscovered = 0     (B's 3 leads are not A's)
 *     repliesReceived          = 0
 *     bestIcp                  = "Not enough data"   <-- WAS "Bravo buyers"
 *
 *   campaignAnalytics(data, "cam_A", "ws_A")   — A asking about its own:
 *     totalProspectsDiscovered = 2
 *     mqlCount                 = 1
 *     repliesReceived          = 1
 *     messagesGenerated        = 1
 *     messagesMarkedSent       = 1
 *     bestIcp                  = "Alpha buyers"
 *     campaignConversionRate   = 50    (1 of 2 leads is mql)
 *
 * A fix that returns nothing for everybody is not a fix, which is why CASE B
 * exists: the owner's own numbers must still be right.
 *
 * MUTATION-TESTED 2026-08-25, every mutation compiling clean under tsc:
 *   m3 wsFilter degenerates to "always true"            -> CASE A fails
 *   m4 the route drops the 404 and answers anyway       -> CASE D fails
 *   m5 the guard runs AFTER the read and the report     -> CASE D fails
 *   m6 the campaign is loaded UNSCOPED, so 404 never fires -> CASE D fails
 *   m7 both filters off the bestIcp line (the real bug) -> CASE A fails
 *
 * m1 and m2 remove ONE filter each from the bestIcp line and are honest
 * EQUIVALENT MUTANTS: either filter alone blocks the leak, so removing one
 * changes no observable answer and no test can catch it. They are kept in the
 * mutation set and named as equivalent rather than quietly dropped, because a
 * mutation score that hides its equivalents is a score you cannot trust. The
 * second filter is deliberate belt-and-braces, not dead code — it is what keeps
 * the line safe if the other side is ever refactored away.
 *
 * Run: npx tsx scripts/golden/golden-campaign-analytics-scoping.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AppData, Lead, Reply, Campaign, ICP, Workspace, OutreachActivity, MessageTemplate,
} from "@/lib/types";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildData(): AppData {
  const workspaces = [
    { id: "ws_A", name: "Tenant A", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "ws_B", name: "Tenant B", createdAt: "2026-01-01T00:00:00.000Z" },
  ] as Workspace[];

  const icps = [
    { id: "icp_A", workspaceId: "ws_A", name: "Alpha buyers" },
    { id: "icp_B", workspaceId: "ws_B", name: "Bravo buyers" },
  ] as ICP[];

  const campaigns = [
    { id: "cam_A", workspaceId: "ws_A", icpId: "icp_A", name: "Campaign A", status: "active" },
    { id: "cam_B", workspaceId: "ws_B", icpId: "icp_B", name: "Campaign B", status: "active" },
  ] as Campaign[];

  const leads = [
    { id: "l_A1", workspaceId: "ws_A", campaignId: "cam_A", status: "mql", reviewStatus: "approved", enrichmentStatus: "completed" },
    { id: "l_A2", workspaceId: "ws_A", campaignId: "cam_A", status: "discovered", reviewStatus: "pending" },
    { id: "l_B1", workspaceId: "ws_B", campaignId: "cam_B", status: "mql", reviewStatus: "approved" },
    { id: "l_B2", workspaceId: "ws_B", campaignId: "cam_B", status: "mql", reviewStatus: "approved" },
    { id: "l_B3", workspaceId: "ws_B", campaignId: "cam_B", status: "won", reviewStatus: "approved" },
  ] as Lead[];

  const replies = [
    { id: "r_A1", workspaceId: "ws_A", campaignId: "cam_A", leadId: "l_A1" },
    { id: "r_B1", workspaceId: "ws_B", campaignId: "cam_B", leadId: "l_B1" },
    { id: "r_B2", workspaceId: "ws_B", campaignId: "cam_B", leadId: "l_B2" },
  ] as Reply[];

  const outreachActivities = [
    { id: "oa_A1", workspaceId: "ws_A", campaignId: "cam_A", leadId: "l_A1", status: "sent" },
  ] as OutreachActivity[];

  const messageTemplates = [
    { id: "mt_A1", workspaceId: "ws_A", campaignId: "cam_A" },
  ] as MessageTemplate[];

  return {
    workspaces, icps, campaigns, leads, replies, outreachActivities, messageTemplates,
  } as unknown as AppData;
}

async function main() {
  console.log("GOLDEN — campaign analytics tenant scoping\n");

  const mod = await import("@/app/api/[[...path]]/route");
  const campaignAnalytics = (mod as unknown as {
    campaignAnalytics?: (data: AppData, campaignId: string, workspaceId?: string) => Record<string, unknown>;
  }).campaignAnalytics;

  assert.equal(typeof campaignAnalytics, "function",
    "campaignAnalytics must be exported from route.ts so this boundary can be tested at all");

  const data = buildData();

  check("CASE A — tenant A asking about tenant B's campaign learns nothing", () => {
    const report = campaignAnalytics!(data, "cam_B", "ws_A");
    assert.equal(report.totalProspectsDiscovered, 0, "B's leads must not be counted for A");
    assert.equal(report.repliesReceived, 0, "B's replies must not be counted for A");
    assert.equal(report.mqlCount, 0, "B's MQLs must not be counted for A");
    // The one that regressed. "Bravo buyers" is tenant B's own words.
    assert.equal(report.bestIcp, "Not enough data",
      `bestIcp leaked tenant B's ICP name: ${String(report.bestIcp)}`);
  });

  check("CASE B — tenant A's own numbers are still right (a fix that blanks everyone is not a fix)", () => {
    const report = campaignAnalytics!(data, "cam_A", "ws_A");
    assert.equal(report.totalProspectsDiscovered, 2);
    assert.equal(report.mqlCount, 1);
    assert.equal(report.repliesReceived, 1);
    assert.equal(report.messagesGenerated, 1);
    assert.equal(report.messagesMarkedSent, 1);
    assert.equal(report.leadsApproved, 1);
    assert.equal(report.campaignConversionRate, 50);
    assert.equal(report.bestIcp, "Alpha buyers", "the owner must still see their own ICP name");
  });

  check("CASE C — tenant B's own numbers are right too (proves A's zeros are scoping, not emptiness)", () => {
    const report = campaignAnalytics!(data, "cam_B", "ws_B");
    assert.equal(report.totalProspectsDiscovered, 3);
    assert.equal(report.mqlCount, 2);
    assert.equal(report.repliesReceived, 2);
    assert.equal(report.bestIcp, "Bravo buyers");
  });

  check("CASE D — the route refuses a campaign the caller does not own, BEFORE reading anything", () => {
    const src = readFileSync(resolve("src/app/api/[[...path]]/route.ts"), "utf8");
    const start = src.indexOf('if (match(path, ["analytics", "campaign", ":campaignId"])) {');
    assert.ok(start > 0, "the analytics/campaign/:campaignId handler has moved or been renamed");
    const handler = src.slice(start, src.indexOf("\n  }", start));

    const guardAt = handler.indexOf("repos.campaign.getById(workspaceId, path[2])");
    assert.ok(guardAt > 0,
      "the handler must load the campaign scoped to the caller's workspace before answering");
    assert.ok(handler.includes("CAMPAIGN_NOT_FOUND") && handler.includes("404"),
      "an unowned campaign must be refused with 404, not answered with a zeroed report");

    const analyticsAt = handler.indexOf("campaignAnalytics(");
    assert.ok(analyticsAt > guardAt,
      "the workspace check must run BEFORE campaignAnalytics, or a future field leaks again");
    const readAllAt = handler.indexOf("repos.readAll");
    assert.ok(readAllAt > guardAt,
      "the whole-database read must happen AFTER the campaign is confirmed to belong to the caller");
  });

  check("CASE E — an internal caller that omits workspaceId is still confined to one campaign's own tenant", () => {
    // Backward compatibility is documented in the function: workspaceId is
    // optional. That must not mean "and then it answers for everybody" — the
    // report is still built from the campaign that was asked for.
    const report = campaignAnalytics!(data, "cam_B");
    assert.equal(report.totalProspectsDiscovered, 3, "unscoped still means THIS campaign, not all campaigns");
    assert.equal(report.bestIcp, "Bravo buyers");
  });

  console.log(`\n${failures ? `FAILED — ${failures} case(s)` : "OK — all cases passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("GOLDEN CRASHED:", error);
  process.exit(1);
});
