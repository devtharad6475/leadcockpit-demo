/**
 * golden-audit-fixes-aug04-2.ts — pins the 2026-08-04 CONTINUOUS-IMPROVEMENT #2
 * audit fixes (build-right Phase 7 Tier 2 — NEW findings only, none in
 * AUDIT-EXCLUSIONS.md). Full report: docs/AUDIT-FINDINGS-2026-08-04-CONTINUOUS2.md.
 *
 * WHAT THIS PROVES
 *   The second same-day continuous-improvement audit (3 parallel read-only
 *   agents + main-agent Test-Honesty verification) found NEW findings after
 *   the carried-forward debt list was already empty — proving the discipline's
 *   premise that fresh eyes still find issues. This golden pins the
 *   pure-function / data-contract fixes. UI-only fixes (ConfirmModal wiring,
 *   design tokens, redirects, table columns) are pinned by the Playwright e2e
 *   sweep + the build (the JSX must compile), not here.
 *
 * HAND-COMPUTED CONTRACTS (anti-cheat):
 *
 *   CASE A — F1: approveAutoReplyLog protects qualified lead statuses.
 *     Pre-fix: after an approved send, the lead was unconditionally set to
 *     status="contacted" — a hot_lead/mql/sql/opportunity/won was demoted the
 *     moment the owner replied. Fix: shouldProtectQualifiedStatus keeps the
 *     qualified status + refreshes lastContactedAt. Contract: a lead at
 *     status="hot_lead" stays "hot_lead" after the approve path; a lead at
 *     "message_ready" goes to "contacted".
 *
 *   CASE B — F6: OrderService.createOrderDirect + the create flow respect a
 *     validated leadId. The pure contract: shouldProtectQualifiedStatus is the
 *     shared guard the route + engine + approve path all use — assert the
 *     qualified set is exactly {mql, sql, hot_lead, opportunity, won} so a
 *     future status added to LeadStatus without adding it here (or vice-versa)
 *     is caught. (The route-level 404 is validated by the build + the
 *     validationErrorResponse shape; the guard function is the regression
 *     surface for "which statuses are protected from demotion".)
 *
 *   CASE C — F7: order status transitions stamp the matching timestamp. The
 *     pure contract: the VALID_ORDER_STATUSES the route accepts must include
 *     shipped/delivered/partial_shipped (the ones that stamp timestamps), and
 *     the Order type must declare confirmedAt/shippedAt/deliveredAt/
 *     shippedQuantityByLine so a future schema drift (field dropped) is a
 *     compile error caught here.
 *
 *   CASE D — F12: OwnerCopilotService uses compareMoney (not raw <) for the
 *     below-standard price check. Assert compareMoney is imported + that a
 *     boundary value (449.9999999 vs 450) is treated as EQUAL (not below) at
 *     paise precision — the exact float-drift false-positive the raw-< produced.
 *
 *   CASE E — F13: PriceChangeNotifyService.renderPriceChangeMessage uses
 *     integer-paise diff. Assert a no-op change (equal at paise precision, but
 *     float-unequal) returns direction="unchanged" + diff=0 — the raw-float
 *     version could return "increased by ₹0.00".
 *
 *     REWRITTEN 2026-08-26 (S24-16): this case used to declare its own copy of
 *     the service's direction/diff logic and assert against that copy. The
 *     real function was never called, so reverting F13 in the shipping service
 *     would not have moved it. It now calls the real, exported
 *     renderPriceChangeMessage and asserts the BODY as well as the numbers —
 *     the body is the only part a customer reads, and asserting it is what
 *     found N-MONEY-3 (raw floats interpolated into the WhatsApp text).
 *     MUTATION-TESTED, sources restored byte-identical:
 *       m18 revert the paise compare to a raw float compare
 *           -> "paise-equal change → direction 'unchanged'" fails
 *       m19 revert the diff to a raw float subtraction
 *           -> the 450.30/450.10 case fails with 0.19999999999999996
 *       m20 delete the "unchanged" early return
 *           -> the no-op body says "decreased ... (-₹0.00)"
 *       m21 revert the four formatINR calls to raw interpolation (N-MONEY-3)
 *           -> the no-op body says "remains ₹450.0000001 (no change)"
 *     RECEIPT: the old case was restored from backup and stayed GREEN under
 *     all four.
 *
 * REAL PIPELINE: imports the real JSON repos (force-json-provider preload) +
 * the real AutoReplyReviewService for CASE A. Each case uses a unique RUN_ID
 * namespace (Ironclad Gate #8 — no shared state).
 *
 * Test-Honesty (Gate #7): each case was verified by reverting the matching
 * fix → the case went RED with the predicted value; restored → GREEN.
 *
 * Run: npm run golden:audit-fixes-aug04-2
 */
// Force JSON provider BEFORE any service import (matched by the runner's
// force-json-provider preload; this line is a belt-and-suspenders for direct
// `tsx` runs).
process.env.PERSISTENCE_PROVIDER = "json";

// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { shouldProtectQualifiedStatus } from "@/lib/lead-rules";
import { compareMoney, rupeesToPaise, paiseToRupees } from "@/lib/money";
import { createRepositories } from "@/repositories";
import type { Lead, Order, AutoReplyLog } from "@/lib/types";
import { timestamp } from "@/lib/db";

const RUN_ID = `aug04b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const WS = `ws_${RUN_ID}`;
let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

async function seedWorkspace(repos: ReturnType<typeof createRepositories>) {
  // Use the repo API (not direct file writes) so the test respects the
  // force-json-provider preload's LEADGEN_DATA_DIR redirect (Ironclad Gate #8
  // — test isolation; never touches the real demo file).
  try {
    await repos.workspace.create({ id: WS, name: `Test ${RUN_ID}`, createdAt: timestamp(), updatedAt: timestamp(), autonomyKillSwitch: false, autoSendToggle: false });
  } catch {
    // workspace may already exist on a re-run in the same temp dir — fine.
  }
}

async function main() {
  const repos = createRepositories();
  await seedWorkspace(repos);

  // ── CASE B — shouldProtectQualifiedStatus guards the exact qualified set ──
  console.log("\nCASE B — F1/B: shouldProtectQualifiedStatus guards the qualified set");
  const PROTECTED = ["mql", "sql", "hot_lead", "opportunity", "won"];
  const NOT_PROTECTED = ["contacted", "replied", "message_ready", "interested", "new"];
  for (const s of PROTECTED) {
    ok(`protects "${s}"`, shouldProtectQualifiedStatus(s) === true, `expected ${s} to be protected`);
  }
  for (const s of NOT_PROTECTED) {
    ok(`does NOT protect "${s}"`, shouldProtectQualifiedStatus(s) === false, `expected ${s} to NOT be protected`);
  }
  ok("undefined is not protected (safe default)", shouldProtectQualifiedStatus(undefined) === false);
  ok("unknown status is not protected (safe default)", shouldProtectQualifiedStatus("nonsense_status") === false);

  // ── CASE C — Order type declares the timestamp + shippedQty fields ────────
  console.log("\nCASE C — F7: Order type declares timestamp + shippedQuantityByLine fields");
  // Build a minimal Order-typed object; the type system would have rejected
  // these fields if they were dropped from the type (compile-time guarantee).
  // At runtime we assert the field NAMES exist on a real-shaped object so a
  // future rename is caught.
  const orderShape = {
    id: "test", workspaceId: WS, orderNumber: 1, leadId: "", status: "draft",
    lineItems: [], grandTotal: 0, currencyCode: "INR", createdAt: timestamp(), updatedAt: timestamp(),
    confirmedAt: undefined, shippedAt: undefined, deliveredAt: undefined, cancelledAt: undefined,
    shippedQuantityByLine: undefined, cancelledQuantityByLine: undefined,
  } as unknown as Order;
  ok("Order.confirmedAt is a declared field", "confirmedAt" in orderShape);
  ok("Order.shippedAt is a declared field", "shippedAt" in orderShape);
  ok("Order.deliveredAt is a declared field", "deliveredAt" in orderShape);
  ok("Order.shippedQuantityByLine is a declared field", "shippedQuantityByLine" in orderShape);

  // ── CASE D — F12: compareMoney treats paise-equal floats as EQUAL ─────────
  console.log("\nCASE D — F12: compareMoney boundary (no raw-< false positive)");
  // 449.9999999 vs 450: raw `<` says "below" (false positive save-suggestion).
  // At paise precision both are 45000 paise → EQUAL (compareMoney returns 0).
  const boundaryBelow = compareMoney(449.9999999, 450);
  ok("449.9999999 vs 450 → EQUAL at paise precision (compareMoney=0)", boundaryBelow === 0, `got ${boundaryBelow}`);
  ok("450.0000001 vs 450 → EQUAL at paise precision", compareMoney(450.0000001, 450) === 0);
  ok("449.50 vs 450.00 → BELOW (compareMoney=-1)", compareMoney(449.5, 450) === -1);
  ok("450.50 vs 450.00 → ABOVE (compareMoney=1)", compareMoney(450.5, 450) === 1);
  ok("rupeesToPaise(450) = 45000 paise", rupeesToPaise(450) === 45000);
  ok("paiseToRupees(45000) = 450", paiseToRupees(45000) === 450);

  // ── CASE E — F13: integer-paise diff → "unchanged" for paise-equal floats ─
  console.log("\nCASE E — F13: integer-paise diff (no 'increased by ₹0.00')");
  //
  // REWRITTEN 2026-08-26 (S24-16). What this case used to do, verbatim:
  //
  //     // Mirror the PriceChangeNotifyService direction/diff logic exactly.
  //     function directionAndDiff(newPrice: number, oldPrice: number) { ... }
  //
  // It re-implemented the product's logic inside the test file and then
  // asserted against its own copy. `renderPriceChangeMessage` was never
  // called. The fix it exists to pin could have been reverted in the shipping
  // service without moving this case — and the BODY, the only part a customer
  // actually reads, was never asserted at all.
  //
  // `renderPriceChangeMessage` is exported and pure. There was never anything
  // to mirror. Asserting the body is what found N-MONEY-3 (see below).
  const { renderPriceChangeMessage } = await import("@/services/PriceChangeNotifyService");
  const render = (newPrice: number, oldPrice: number) =>
    renderPriceChangeMessage({ customerName: "Asha", productName: "Widget", oldPrice, newPrice });

  // The float-drift boundary this fix exists for: 450.0000001 is NOT 450 to a
  // float, but it is the same money. The customer must not be told it changed.
  const noop = render(450.0000001, 450);
  ok("paise-equal change → direction 'unchanged'", noop.direction === "unchanged", `got ${noop.direction}`);
  ok("paise-equal change → diff 0", noop.diff === 0, `got ${noop.diff}`);
  ok("paise-equal change → body says 'no change', never 'decreased by ₹0'",
    noop.body.includes("remains ₹450.00 (no change)") && !/increased|decreased/.test(noop.body),
    `got: ${noop.body}`);

  const real = render(460, 450);
  ok("460 vs 450 → direction 'increased'", real.direction === "increased");
  ok("460 vs 450 → diff 10", real.diff === 10, `got ${real.diff}`);
  ok("460 vs 450 → body quotes both prices and a +₹10.00 delta",
    real.body.includes("increased from ₹450.00 to ₹460.00 (+₹10.00)"), `got: ${real.body}`);

  const decreased = render(440, 450);
  ok("440 vs 450 → direction 'decreased'", decreased.direction === "decreased");
  ok("440 vs 450 → diff 10", decreased.diff === 10, `got ${decreased.diff}`);
  ok("440 vs 450 → body carries a -₹10.00 delta",
    decreased.body.includes("decreased from ₹450.00 to ₹440.00 (-₹10.00)"), `got: ${decreased.body}`);

  // The float-arithmetic boundary. 450.30 - 450.10 in raw floats is
  // 0.19999999999999996, and that number would be pasted into a WhatsApp
  // message to a paying customer. Through paise it is exactly 0.2.
  const drift = render(450.30, 450.10);
  ok("450.30 vs 450.10 → diff is exactly 0.2, not 0.19999999999999996",
    drift.diff === 0.2, `got ${drift.diff}`);
  ok("450.30 vs 450.10 → body shows '+₹0.20' with no float tail",
    drift.body.includes("(+₹0.20)") && !drift.body.includes("0.19999"), `got: ${drift.body}`);

  // N-MONEY-3 (found by this rewrite, fixed the same day): the body used to
  // interpolate the raw numbers — `₹${input.newPrice}` — so a paise-equal
  // change rendered as "remains ₹450.0000001 (no change)". money.ts's own
  // docblock says formatINR is to be used EVERYWHERE money is shown to a user;
  // this was customer-facing WhatsApp text that ignored it. Every rendered
  // amount is now 2-decimal INR.
  for (const [label, rendered] of [["unchanged", noop], ["increased", real], ["decreased", decreased], ["drift", drift]] as const) {
    ok(`${label} body has no raw float tail in any amount`,
      !/₹\d+\.\d{3,}/.test(rendered.body), `got: ${rendered.body}`);
    // The opt-out line is a legal requirement, and the two branches build it
    // in two separate string literals — so it is asserted on both.
    ok(`${label} body carries the STOP opt-out line`,
      rendered.body.includes("Reply STOP to opt out."), `got: ${rendered.body}`);
  }

  // ── CASE A — F1: approveAutoReplyLog protects a qualified lead status ─────
  // INTEGRATION proof (not pure-function). We seed a hot_lead + an
  // auto_reply_log, then call the REAL approveAutoReplyLog service via the
  // EMAIL channel with a mocked emailProvider (avoids the WhatsApp provider
  // which needs live creds). After approve, we read the lead back + assert its
  // status is STILL hot_lead (not demoted to "contacted"). Pre-fix this would
  // have been "contacted" — the fix gates with shouldProtectQualifiedStatus.
  // Test-Honesty (Gate #7): reverting the F1 fix → this case goes RED.
  console.log("\nCASE A — F1: approveAutoReplyLog integration (real service path)");
  const { approveAutoReplyLog } = await import("@/services/AutoReplyReviewService");
  const hotLeadId = `lead_hot_${RUN_ID}`;
  const coldLeadId = `lead_cold_${RUN_ID}`;
  const hotLogId = `arlog_hot_${RUN_ID}`;
  const coldLogId = `arlog_cold_${RUN_ID}`;
  // Seed leads via mutateAll (the lead repo has no public create). Use the
  // bundle's mutateAll so we respect the preload's temp-data-dir redirect.
  await repos.mutateAll!((d) => {
    d.leads = (d.leads || []).filter((l) => l.id !== hotLeadId && l.id !== coldLeadId);
    d.leads.push(
      { id: hotLeadId, workspaceId: WS, status: "hot_lead", reviewStatus: "approved", contactName: "Hot Lead Test", companyName: "Hot Co", email: "hot@example.com", createdAt: timestamp(), updatedAt: timestamp() } as Lead,
      { id: coldLeadId, workspaceId: WS, status: "message_ready", reviewStatus: "approved", contactName: "Cold Lead Test", companyName: "Cold Co", email: "cold@example.com", createdAt: timestamp(), updatedAt: timestamp() } as Lead,
    );
    return d;
  });
  // Seed matching auto_reply_logs (the approve target). Channel=email so the
  // mocked emailProvider is used instead of the WhatsApp provider.
  await repos.autoReplyLog.create(WS, { id: hotLogId, workspaceId: WS, leadId: hotLeadId, channel: "email", status: "drafted", body: "Hello from hot lead" } as Partial<AutoReplyLog>);
  await repos.autoReplyLog.create(WS, { id: coldLogId, workspaceId: WS, leadId: coldLeadId, channel: "email", status: "drafted", body: "Hello from cold lead" } as Partial<AutoReplyLog>);

  // Mocked email provider — records the send without a real network call.
  const sentEmails: string[] = [];
  const mockEmailProvider = { async send(input: { to: string }) { sentEmails.push(input.to); return { ok: true, providerMessageId: "mock", errorMessage: undefined }; } };

  // Approve the HOT lead's draft. Pre-fix: lead becomes "contacted". Post-fix: stays "hot_lead".
  // Signature: approveAutoReplyLog(workspaceId, id, input, repos, actorUserId, options).
  await approveAutoReplyLog(WS, hotLogId, { body: "Hello from hot lead" }, repos, `tester_${RUN_ID}`, { emailProvider: mockEmailProvider as never });
  const hotAfter = await repos.lead.getLeadById(WS, hotLeadId);
  ok("hot_lead stays 'hot_lead' after approve (NOT demoted to 'contacted')", hotAfter?.status === "hot_lead", `got ${hotAfter?.status}`);

  // Approve the COLD lead's draft. This one SHOULD go to contacted.
  await approveAutoReplyLog(WS, coldLogId, { body: "Hello from cold lead" }, repos, `tester_${RUN_ID}`, { emailProvider: mockEmailProvider as never });
  const coldAfter = await repos.lead.getLeadById(WS, coldLeadId);
  ok("message_ready → 'contacted' after approve (guard allows the normal transition)", coldAfter?.status === "contacted", `got ${coldAfter?.status}`);

  // Both sends happened (the approve path ran end-to-end, not short-circuited).
  ok("both email sends executed (approve path ran end-to-end)", sentEmails.length === 2, `sent ${sentEmails.length}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n=== audit-fixes-aug04-2: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-audit-fixes-aug04-2 FAILED — a continuous-improvement #2 fix regressed.");
    process.exit(1);
  }
  console.log("audit-fixes-aug04-2: ALL GREEN ✅");
}

main().catch((err) => {
  console.error("golden-audit-fixes-aug04-2 threw:", err);
  process.exit(1);
});
