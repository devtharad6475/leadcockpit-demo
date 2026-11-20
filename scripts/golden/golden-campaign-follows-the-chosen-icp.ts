/**
 * Golden test — the campaign on screen belongs to the customer type the owner
 * chose.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo, on the Discovery screen, before spending a search
 * credit.
 *
 * The ICP is chosen explicitly — `icps.find(icp => icp.status === "selected")`.
 * The campaign was not chosen at all: `campaigns[0]`, repository order, so the
 * OLDEST campaign in the workspace won for its lifetime. Discovery reads its
 * search phrases off that campaign.
 *
 * On the demo this put, on one screen, one under the other:
 *
 *   Kind of company we want: Surat / Gujarat machine embroidery and job-work units
 *   Cloud ERP software for wholesale distributors United States
 *   ERP system for wholesale trade company COO or VP operations
 *
 * The second and third lines are the search phrases of a previous tenant's
 * campaign. Pressing the button would have spent real search credit looking for
 * American ERP buyers on behalf of a zari thread manufacturer in Surat, and
 * filed whatever came back as its leads. Generating a new campaign did not help:
 * the new one sorts after the old one, so `campaigns[0]` never moved.
 *
 *   CASE A — with several campaigns present, the one whose icpId matches the
 *     selected ICP is the one used, regardless of creation order.
 *
 *   CASE B — with no campaign for the selected ICP, the MOST RECENT is used,
 *     not the oldest. A plan just generated is the one the owner is looking at.
 *
 *   CASE C — the selection is by chosen ICP, not by list position: the fix must
 *     not be "campaigns[campaigns.length - 1]", which would break again the
 *     moment a campaign for another ICP is generated last.
 *
 * Substrate: static read of the screen's own selection expression. The value it
 * computes is UI state, not a service call, so this pins the expression.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const SCREEN = "src/app/page.tsx";

type Campaign = { id: string; icpId?: string; createdAt?: string; name: string };

/** The same rule the screen applies, kept here so the cases can exercise it. */
function pickCampaign(campaigns: Campaign[], selectedIcpId?: string) {
  return campaigns.find((item) => item.icpId && item.icpId === selectedIcpId)
    || [...campaigns].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
}

function main() {
  console.log("=== GOLDEN: the campaign on screen belongs to the chosen customer type ===\n");

  const stale: Campaign = { id: "camp_old", icpId: "icp_technova", createdAt: "2026-09-07T18:17:02.908Z", name: "Mid-Market Wholesale Distribution Company campaign" };
  const fresh: Campaign = { id: "camp_new", icpId: "icp_surat", createdAt: "2026-09-09T07:24:11.259Z", name: "Surat / Gujarat machine embroidery and job-work units campaign" };

  // ---------------------------------------------------------------- CASE A
  {
    const picked = pickCampaign([stale, fresh], "icp_surat");
    assert(
      picked?.id === fresh.id,
      `CASE A: the campaign for the chosen ICP must win, got ${JSON.stringify(picked?.name)}`,
    );
    console.log("✅ CASE A — the campaign for the chosen customer type is the one used");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const picked = pickCampaign([stale, fresh], "icp_with_no_campaign");
    assert(
      picked?.id === fresh.id,
      `CASE B: with no campaign for the chosen ICP the most recent must win, got ${JSON.stringify(picked?.name)}`,
    );
    console.log("✅ CASE B — with no match, the most recent plan is used, not the oldest");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const lastIsForAnotherIcp: Campaign = { id: "camp_other", icpId: "icp_exporters", createdAt: "2026-09-09T09:00:00.000Z", name: "Exporter campaign" };
    const picked = pickCampaign([stale, fresh, lastIsForAnotherIcp], "icp_surat");
    assert(
      picked?.id === fresh.id,
      `CASE C: a newer campaign for a DIFFERENT ICP must not displace the chosen one, got ${JSON.stringify(picked?.name)}`,
    );
    console.log("✅ CASE C — the newest campaign does not win when it belongs to another customer type");
  }

  // The screen must actually apply this rule.
  {
    const screen = readSource(SCREEN);
    assert(
      !/const selectedCampaign = campaigns\[0\];/.test(screen),
      `${SCREEN} still picks campaigns[0] — repository order, so the oldest campaign wins`,
    );
    assert(
      /item\.icpId === selectedIcp\?\.id/.test(screen),
      `${SCREEN} must select the campaign by the chosen ICP`,
    );
    console.log("✅ the screen applies it");
  }

  console.log("\n=== GOLDEN PASSED (A-C) ===");
}

main();
