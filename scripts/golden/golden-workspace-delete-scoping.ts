/**
 * golden-workspace-delete-scoping.ts — N-DATA-2 pin (2026-08-18, CEO-loop
 * session 4).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `WorkspaceRepository` had no `delete` method at all, so
 * `golden-substrate-parity.ts` could remove the rows it created but never the
 * `sp-<timestamp>-ws` workspace itself. On JSON that was harmless (isolated
 * temp store, discarded). On Prisma it wrote into the SHIP database once per
 * run and nothing ever reaped it — 15 orphan workspaces had accumulated when
 * this was measured.
 *
 * WHY THIS GOLDEN EXISTS ON TOP OF THE PARITY GOLDEN. The parity golden proves
 * the two substrates behave identically when a workspace is deleted. It does
 * NOT prove the deletion is correctly SCOPED, because it only ever has one
 * workspace in play. That matters here more than usual: Postgres cascades via
 * 68 declared foreign keys, but the JSON substrate has no cascade and sweeps
 * every collection by hand, filtering on `workspaceId`. A wrong filter in that
 * sweep does not fail loudly — it deletes other tenants' rows. This golden is
 * the guard for that, and it runs on JSON where the sweep actually lives.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE running the implementation):
 *
 *   CASE A — before deleting, BOTH workspaces hold their rows. Without this
 *            control, every "row is gone" assertion below would also pass on a
 *            fixture that never created anything.
 *   CASE B — deleting workspace A reports deleted: true.
 *   CASE C — workspace A itself is gone.
 *   CASE D — A's child rows are gone, across more than one collection (leads
 *            and campaigns), i.e. the sweep is not lead-only.
 *   CASE E — THE IMPORTANT ONE. Workspace B is untouched: B still exists, B's
 *            lead still exists, B's campaign still exists. A broken filter in
 *            the JSON sweep shows up here and nowhere else.
 *   CASE F — deletedRows is greater than zero on JSON and matches the number of
 *            rows actually created under A, so the count is a real count and
 *            not a constant.
 *   CASE G — deleting a workspace that does not exist reports deleted: false
 *            and does NOT throw. `cleanup()` calls this from a `finally` block;
 *            a throwing cleanup would mask the real failure underneath it.
 *   CASE H — deleting the SAME workspace twice is safe (second call is a no-op).
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories } from "@/repositories";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

/**
 * N-SAFETY-1: fake data must be unroutable BY CONSTRUCTION. Phones are
 * `+91 00000 000NN`, so even if one of these rows ever escaped the isolated
 * test store it could not reach a human being.
 */
const WS_A = "wsdel-a";
const WS_B = "wsdel-b";

async function main() {
  console.log("GOLDEN: workspace delete scoping (N-DATA-2)");
  console.log("");

  const repos = createRepositories("json");
  const now = new Date().toISOString();

  // Two tenants, identically shaped, so nothing about A makes it special.
  for (const [ws, label] of [[WS_A, "Tenant A"], [WS_B, "Tenant B"]] as const) {
    await repos.workspace.create({ id: ws, name: label, createdAt: now, updatedAt: now });
    await repos.lead.createLead({
      id: `${ws}-lead`, workspaceId: ws, companyName: `${label} Textiles`, source: "golden_test",
      status: "prospected", reviewStatus: "pending", enrichmentStatus: "not_started",
      confidenceScore: 0.5, qualificationStatus: "mql", leadScore: 0, fitScore: 0,
      phone: "+91 00000 00011", whatsappNumber: "+91 00000 00011",
      city: "Surat", industry: "Textiles", createdAt: now, updatedAt: now,
    });
    await repos.campaign.create({
      id: `${ws}-campaign`, workspaceId: ws, businessProfileId: `${ws}-profile`, icpId: `${ws}-icp`,
      name: `${label} campaign`, status: "draft", targetRegion: ["Surat"], productFocus: ["Border"],
      dailyOutreachLimit: 20, leadGoal: 50, createdAt: now, updatedAt: now,
    });
  }

  // ── CASE A — control ─────────────────────────────────────────────────────
  const beforeALead = await repos.lead.getLeadById(WS_A, `${WS_A}-lead`);
  const beforeACampaign = await repos.campaign.getById(WS_A, `${WS_A}-campaign`);
  const beforeBLead = await repos.lead.getLeadById(WS_B, `${WS_B}-lead`);
  const beforeBCampaign = await repos.campaign.getById(WS_B, `${WS_B}-campaign`);
  check("CASE A — both workspaces hold their rows before the delete", () => {
    assert.ok(beforeALead, "A's lead was never created — the rest of this golden would be vacuous");
    assert.ok(beforeACampaign, "A's campaign was never created");
    assert.ok(beforeBLead, "B's lead was never created");
    assert.ok(beforeBCampaign, "B's campaign was never created");
  });

  // ── The delete under test ────────────────────────────────────────────────
  const result = await repos.workspace.delete(WS_A);

  check("CASE B — delete reports deleted: true", () => {
    assert.strictEqual(result.deleted, true, `Got ${JSON.stringify(result)}`);
  });

  const afterAWorkspace = await repos.workspace.getById(WS_A);
  check("CASE C — workspace A is gone", () => {
    assert.strictEqual(afterAWorkspace, undefined, `Workspace A survived its own delete: ${JSON.stringify(afterAWorkspace)}`);
  });

  const afterALead = await repos.lead.getLeadById(WS_A, `${WS_A}-lead`);
  const afterACampaign = await repos.campaign.getById(WS_A, `${WS_A}-campaign`);
  check("CASE D — A's rows are gone in more than one collection", () => {
    assert.strictEqual(afterALead, undefined, "A's lead survived — the JSON sweep missed the leads collection");
    assert.strictEqual(afterACampaign, undefined, "A's campaign survived — the sweep is lead-only, not a real cascade");
  });

  // ── CASE E — the one that catches a wrong filter ─────────────────────────
  const afterBWorkspace = await repos.workspace.getById(WS_B);
  const afterBLead = await repos.lead.getLeadById(WS_B, `${WS_B}-lead`);
  const afterBCampaign = await repos.campaign.getById(WS_B, `${WS_B}-campaign`);
  check("CASE E — workspace B is completely untouched", () => {
    assert.ok(afterBWorkspace, "Deleting A destroyed workspace B — the sweep is not scoped by workspaceId");
    assert.ok(afterBLead, "Deleting A destroyed B's lead — cross-tenant data loss");
    assert.ok(afterBCampaign, "Deleting A destroyed B's campaign — cross-tenant data loss");
    assert.strictEqual(afterBLead?.companyName, "Tenant B Textiles");
  });

  check("CASE F — deletedRows is a real count, not a constant", () => {
    // Created under A: 1 lead + 1 campaign. The sweep may also remove rows the
    // repositories created as a side effect (phone numbers, activity), so this
    // asserts a floor rather than an exact figure — the point is that it counts.
    assert.ok(result.deletedRows >= 2, `Expected at least the 2 rows created under A, got ${result.deletedRows}`);
  });

  const absent = await repos.workspace.delete("wsdel-never-existed");
  check("CASE G — deleting an absent workspace is a quiet no-op", () => {
    assert.strictEqual(absent.deleted, false, `Got ${JSON.stringify(absent)}`);
    assert.strictEqual(absent.deletedRows, 0);
  });

  const twice = await repos.workspace.delete(WS_A);
  check("CASE H — deleting the same workspace twice is safe", () => {
    assert.strictEqual(twice.deleted, false, `Second delete claimed to delete something: ${JSON.stringify(twice)}`);
  });

  console.log("");
  console.log(`=== GOLDEN workspace-delete-scoping: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("GOLDEN CRASHED:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
