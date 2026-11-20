/**
 * golden-audit-fixes-aug05.ts — pins the 2026-08-05 continuous-improvement
 * audit fixes (build-right Phase 7 — NEW findings only, none in AUDIT-EXCLUSIONS.md).
 *
 * WHAT THIS PROVES
 *   The 2026-08-05 continuous-improvement audit (3 parallel read-only Explore
 *   agents + main-agent Test-Honesty verification of every P1 claim against the
 *   code) found 2 P1 data-integrity regressions + 5 P2 UI + 5 P3 polish.
 *   This golden pins the 2 P1 data-contract fixes.
 *
 * HAND-COMPUTED CONTRACTS (anti-cheat):
 *
 *   CASE A — F-DATA-21: partial-cancel money math when cancelQty < unshippedQty.
 *     Pre-fix: cancelOrder picked `effectiveQty = shippedByLine[li.id]` whenever
 *     the key existed, DROPPING `survivingQty`. The bug was masked by the
 *     existing golden:partial-cancel-math CASE B, which only cancels the ENTIRE
 *     unshipped remainder (where survivingQty == shippedQty, so either choice
 *     gives the same number). This case cancels only SOME of the unshipped
 *     units, where survivingQty > shippedQty — the exact case the bug bites.
 *
 *     HAND-COMPUTED:
 *       Line li1: quantity=10, unitPrice=₹100 → line total ₹1,000.
 *       shippedQuantityByLine = { li1: 4 } (4 units already shipped).
 *       Caller cancels 3 of the 6 unshipped: cancelQuantitiesByLine = { li1: 3 }.
 *         - Validation cap: cancellableQty = 10 − 4 = 6; 3 ≤ 6 → passes.
 *         - cancelledQuantityByLine = { li1: 3 }.
 *         - survivingQty = 10 − 3 = 7  (4 shipped + 3 still pending survive).
 *       EXPECTED grandTotal = 7 × ₹100 = ₹700.
 *       ACTUAL pre-fix = 4 × ₹100 = ₹400 (only shipped counted; the 3
 *         surviving unshipped units silently dropped).
 *       CONTRACT: grandTotal MUST equal 700 after the fix.
 *
 *     cancelOrder is a PURE function (order → order, no DB) so we call it
 *     directly with a hand-built Order. No repos, no JSON file pollution.
 *
 *   CASE B — F-DATA-22: workspace Ticket update clears resolvedAt when the
 *     caller passes `resolvedAt: undefined` (the reopen patch).
 *     Pre-fix: the JSON repo cleared it via Object.assign, but the Prisma repo
 *     silently ignored `undefined` → stale resolvedAt on a reopened ticket.
 *     Fix: clearableTicketUpdate maps explicit-undefined resolvedAt/closedAt/
 *     firstRespondedAt → Prisma null.
 *
 *     Since this golden runs on JSON (no DATABASE_URL), CASE B here proves the
 *     JSON repo HONOURS the contract (resolvedAt is undefined after the update)
 *     AND that an explicit-undefined patch on a NULLABLE field clears it. The
 *     Prisma parity is pinned separately by golden:prisma-field-clearing CASE C
 *     (added to that suite; needs DATABASE_URL). Both halves together prove the
 *     fix across both runtimes.
 *
 * Run: npm run golden:audit-fixes-aug05
 */
// Force JSON provider BEFORE any service import (matched by the runner's
// force-json-provider preload; belt-and-suspenders for direct `tsx` runs).
process.env.PERSISTENCE_PROVIDER = "json";

// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { cancelOrder } from "@/services/OrderService";
import { repositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { Order, OrderLineItem, Ticket } from "@/lib/types";

const RUN_ID = `aug05_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const WS = `ws_${RUN_ID}`;

function makeLine(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  const quantity = overrides.quantity ?? 10;
  const unitPrice = overrides.unitPrice ?? 100;
  return {
    id: overrides.id || `li_${RUN_ID}`,
    productId: overrides.productId || `p_${RUN_ID}`,
    productName: overrides.productName || "Test Zari",
    quantity,
    unitPrice,
    lineTotal: overrides.lineTotal ?? quantity * unitPrice,
    ...overrides,
  } as OrderLineItem;
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: `order_${RUN_ID}`,
    workspaceId: WS,
    orderNumber: 1,
    leadId: `lead_${RUN_ID}`,
    status: "confirmed",
    lineItems: [makeLine({ id: `li_${RUN_ID}`, quantity: 10, unitPrice: 100 })],
    grandTotal: 1000,
    currencyCode: "INR",
    origin: "direct",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  } as Order;
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: `ticket_${RUN_ID}`,
    workspaceId: WS,
    ticketNumber: 1,
    leadId: undefined,
    sourceChannel: "manual",
    type: "general",
    priority: "medium",
    status: "resolved",
    subject: "F-DATA-22 regression test",
    description: "Reopen must clear resolvedAt",
    sourceEntityType: "manual",
    slaStartedAt: "2026-08-01T00:00:00.000Z",
    slaDueAt: "2026-08-08T00:00:00.000Z",
    resolvedAt: "2026-08-01T10:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as unknown as Ticket;
}

async function main() {
  let pass = 0;
  const fail: string[] = [];

  // A-7 (2026-08-26): CASE B writes a real ticket row through the
  // repository bundle. `WS` is invented per run, so on Postgres the tenant
  // it hangs off does not exist and the create dies on
  // tickets_workspace_id_fkey. JSON never noticed because a file has no
  // foreign keys. Make the tenant real before anything is hung off it.
  await ensureWorkspace(repositories, WS, `audit-fixes-aug05 golden ${RUN_ID}`);

  // ─────────────────────────────────────────────────────────────────────
  // CASE A — F-DATA-21: partial-cancel when cancelQty < unshippedQty.
  // ─────────────────────────────────────────────────────────────────────
  try {
    const order = makeOrder({
      id: `order_${RUN_ID}_A`,
      status: "partial_shipped",
      shippedQuantityByLine: { [`li_${RUN_ID}`]: 4 },
    });
    // Cancel 3 of the 6 unshipped.
    const result = await cancelOrder(order, {
      actor: `owner_${RUN_ID}`,
      reason: "F-DATA-21 regression test",
      cancelQuantitiesByLine: { [`li_${RUN_ID}`]: 3 },
    });
    // HAND-COMPUTED: surviving = 10 − 3 = 7 → 7 × ₹100 = ₹700.
    // Pre-fix bug: effectiveQty = shippedByLine[li] = 4 → 4 × ₹100 = ₹400.
    assert.equal(result.grandTotal, 700, "CASE A: grandTotal must be 700 (7 surviving × ₹100), not 400 (dropped 3 surviving unshipped units)");
    assert.equal(result.status, "partial_cancelled", "CASE A: status");
    assert.equal(result.cancelledQuantityByLine?.[`li_${RUN_ID}`], 3, "CASE A: cancelledQuantityByLine.li = 3");
    assert.notEqual(result.grandTotal, 400, "CASE A regression guard: grandTotal must NOT be the pre-fix 400");
    console.log("  CASE A OK: partial-cancel (cancelQty=3 < unshippedQty=6) → grandTotal ₹700 (was ₹400 pre-fix). F-DATA-21 pinned.");
    pass++;
  } catch (e) {
    fail.push(`CASE A — ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE B — F-DATA-22: Ticket repo update clears resolvedAt when caller
  // passes resolvedAt: undefined (the reopen patch shape).
  // JSON path proof (Prisma path → golden:prisma-field-clearing CASE C).
  // ─────────────────────────────────────────────────────────────────────
  try {
    const repos = repositories;
    const ticket = makeTicket({
      id: `ticket_${RUN_ID}_B`,
      resolvedAt: "2026-08-01T10:00:00.000Z",
    });
    await repos.ticket.create(ticket);

    // Sanity: resolvedAt is set before the update.
    const before = await repos.ticket.getById(WS, ticket.id);
    assert.equal(before?.resolvedAt, "2026-08-01T10:00:00.000Z", "CASE B setup: resolvedAt set before update");

    // The exact patch shape `changeTicketStatus` builds on reopen:
    //   { status: "reopened", resolvedAt: undefined }
    await repos.ticket.update(WS, ticket.id, {
      status: "reopened",
      resolvedAt: undefined,
    } as Partial<Ticket>);

    const after = await repos.ticket.getById(WS, ticket.id);
    assert.equal(after?.status, "reopened", "CASE B: status after reopen");
    // The contract: resolvedAt MUST be cleared (undefined or null).
    assert.ok(after?.resolvedAt === undefined || after?.resolvedAt === null,
      `CASE B: resolvedAt must be cleared after reopen, got ${JSON.stringify(after?.resolvedAt)}`);
    console.log("  CASE B OK: Ticket update with resolvedAt:undefined clears the field (JSON path). F-DATA-22 service contract pinned (Prisma path → golden:prisma-field-clearing CASE C).");
    pass++;
  } catch (e) {
    fail.push(`CASE B — ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Report
  // ─────────────────────────────────────────────────────────────────────
  console.log("");
  if (fail.length === 0) {
    console.log(`✅ golden-audit-fixes-aug05 ALL GREEN ✅  (${pass}/${pass + fail.length})`);
    process.exit(0);
  }
  console.error(`❌ golden-audit-fixes-aug05 FAILED — ${fail.length} case(s) failed:`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}

// `uid` is imported to guarantee the helper module loads even though we build
// ids inline; keeps the import graph honest if a future refactor moves uid().

main().catch((e) => {
  console.error("golden-audit-fixes-aug05 crashed:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
