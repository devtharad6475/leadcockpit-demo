/**
 * Golden test — Data-layer repositories (M7/M9 additions).
 *
 * Phase 1.5 / skill v2 — written AFTER the code (this is a retrofit of
 * the Golden Thread to data-layer code that shipped without tests).
 *
 * Pins:
 *   - JsonOrderRepository.nextOrderNumber — starts at 1, increments per create
 *   - JsonOrderRepository round-trip — create → getById → listByWorkspace →
 *     listByLead → update preserves fields
 *   - JsonQuoteRepository.nextQuoteNumber — same pattern
 *   - JsonWorkspaceRepository.update — kill-switch field round-trips
 *
 * The repos mutate the real demo JSON file, so we use a fresh test
 * workspace ID to avoid contaminating demo data. (We can't easily mock
 * the file system without a bigger refactor; the workspaceId scoping
 * keeps our test data isolated.)
 *
 * Hand-computed:
 *   CASE A — nextOrderNumber: first call returns 1 (empty workspace),
 *     second call returns 2 after one order created.
 *   CASE B — nextQuoteNumber: same pattern (1 → 2).
 *   CASE C — order round-trip: create with grandTotal=4500 → getById
 *     returns grandTotal=4500 → listByWorkspace includes it → update
 *     status to "confirmed" → getById returns status="confirmed".
 *   CASE D — workspace update: update autonomyKillSwitch=true → getById
 *     returns autonomyKillSwitch=true.
 *
 * Run: npx tsx scripts/golden/golden-repositories.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Order, Quote } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// Use a unique workspace ID so we don't collide with demo data.
const TEST_WORKSPACE_ID = `ws_golden_repos_${Date.now()}`;

async function main() {
  const repos: RepositoryBundle = createJsonRepos();

  // === CASE A — nextOrderNumber starts at 1, increments ===
  const firstNum = await repos.order.nextOrderNumber(TEST_WORKSPACE_ID);
  assert(firstNum === 1, `CASE A: first nextOrderNumber should be 1 for a fresh workspace, got ${firstNum}`);

  // Create one order, then nextNumber should be 2.
  const order1 = await repos.order.create({
    workspaceId: TEST_WORKSPACE_ID,
    orderNumber: firstNum,
    leadId: "lead_test_1",
    status: "draft",
    lineItems: [{
      id: "li1", productName: "Test", quantity: 10, unit: "kg",
      unitPrice: 450, currencyCode: "INR", lineTotal: 4500,
    }],
    grandTotal: 4500,
    currencyCode: "INR",
    origin: "direct",
  });
  const secondNum = await repos.order.nextOrderNumber(TEST_WORKSPACE_ID);
  assert(secondNum === 2, `CASE A: after 1 order, nextOrderNumber should be 2, got ${secondNum}`);
  console.log(`  CASE A OK: nextOrderNumber 1 → 2.`);

  // === CASE B — nextQuoteNumber ===
  const firstQ = await repos.quote.nextQuoteNumber(TEST_WORKSPACE_ID);
  assert(firstQ === 1, `CASE B: first nextQuoteNumber should be 1, got ${firstQ}`);
  await repos.quote.create({
    workspaceId: TEST_WORKSPACE_ID,
    quoteNumber: firstQ,
    leadId: "lead_test_1",
    status: "sent",
    lineItems: [{
      id: "li_q1", productName: "Test", quantity: 10, unit: "kg",
      unitPrice: 450, currencyCode: "INR", lineTotal: 4500,
    }],
    grandTotal: 4500,
    currencyCode: "INR",
  });
  const secondQ = await repos.quote.nextQuoteNumber(TEST_WORKSPACE_ID);
  assert(secondQ === 2, `CASE B: after 1 quote, nextQuoteNumber should be 2, got ${secondQ}`);
  console.log(`  CASE B OK: nextQuoteNumber 1 → 2.`);

  // === CASE C — order round-trip ===
  // (Use order1 from CASE A.)
  const fetched = await repos.order.getById(TEST_WORKSPACE_ID, order1.id);
  assert(fetched !== undefined, `CASE C: getById should find the order`);
  assert(fetched!.grandTotal === 4500, `CASE C: fetched grandTotal should be 4500, got ${fetched!.grandTotal}`);
  assert(fetched!.status === "draft", `CASE C: fetched status should be draft`);
  assert(fetched!.origin === "direct", `CASE C: fetched origin should be direct`);

  const list = await repos.order.listByWorkspace(TEST_WORKSPACE_ID);
  assert(list.length === 1, `CASE C: listByWorkspace should have 1 order, got ${list.length}`);
  assert(list[0].id === order1.id, `CASE C: list should contain our order`);

  const byLead = await repos.order.listByLead(TEST_WORKSPACE_ID, "lead_test_1");
  assert(byLead.length === 1, `CASE C: listByLead should find 1 order`);
  const byLeadEmpty = await repos.order.listByLead(TEST_WORKSPACE_ID, "lead_nonexistent");
  assert(byLeadEmpty.length === 0, `CASE C: listByLead with unknown leadId returns []`);

  const updated = await repos.order.update(TEST_WORKSPACE_ID, order1.id, { status: "confirmed" });
  assert(updated.status === "confirmed", `CASE C: after update, status should be 'confirmed', got ${updated.status}`);
  const refetched = await repos.order.getById(TEST_WORKSPACE_ID, order1.id);
  assert(refetched!.status === "confirmed", `CASE C: getById after update should reflect 'confirmed'`);
  console.log(`  CASE C OK: order create → getById → list → update round-trip.`);

  // === CASE D — workspace update (kill-switch field) ===
  // Create a test workspace first.
  const ws = await repos.workspace.create({
    id: TEST_WORKSPACE_ID,
    name: "Golden Repos Test Workspace",
    status: "active",
  });
  assert(ws.id === TEST_WORKSPACE_ID, `CASE D: workspace created with our id`);
  assert(ws.autonomyKillSwitch === undefined || ws.autonomyKillSwitch === false, `CASE D: fresh workspace has no kill-switch`);

  const updatedWs = await repos.workspace.update(TEST_WORKSPACE_ID, { autonomyKillSwitch: true });
  assert(updatedWs.autonomyKillSwitch === true, `CASE D: after update, autonomyKillSwitch should be true`);
  const refetchedWs = await repos.workspace.getById(TEST_WORKSPACE_ID);
  assert(refetchedWs?.autonomyKillSwitch === true, `CASE D: getById should reflect the persisted kill-switch=true`);

  // Toggle back to false.
  const toggledBack = await repos.workspace.update(TEST_WORKSPACE_ID, { autonomyKillSwitch: false });
  assert(toggledBack.autonomyKillSwitch === false, `CASE D: toggle back to false works`);
  console.log(`  CASE D OK: workspace.update round-trips the kill-switch field.`);

  // === CASE E — quote listByWorkspace + filtering ===
  const quotesList = await repos.quote.listByWorkspace(TEST_WORKSPACE_ID);
  assert(quotesList.length === 1, `CASE E: listByWorkspace should have 1 quote, got ${quotesList.length}`);

  const sentQuotes = await repos.quote.listByWorkspace(TEST_WORKSPACE_ID, { status: "sent" });
  assert(sentQuotes.length === 1, `CASE E: filter by status=sent → 1 quote`);
  const acceptedQuotes = await repos.quote.listByWorkspace(TEST_WORKSPACE_ID, { status: "accepted" });
  assert(acceptedQuotes.length === 0, `CASE E: filter by status=accepted → 0 quotes`);
  console.log(`  CASE E OK: quote list + status filter works.`);

  console.log("PASS golden-repositories: all 5 cases (nextOrderNumber, nextQuoteNumber, order round-trip, workspace update, quote filter) match.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
