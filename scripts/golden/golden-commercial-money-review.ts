/**
 * golden-commercial-money-review.ts — what the 2026-09-27 sector review found
 * in quotes, orders and money. Each case failed on the code before its fix.
 *
 *   M1 — the Copilot's "approve" goes through the same guarded move as the
 *        quote status route: a converted quote is not put back to "sent" (and
 *        so is not converted into a second order), a rejected quote stays
 *        rejected, an unpriced line blocks sending, and sentAt is stamped.
 *   M2 — a line total is the exact quantity × price, rounded once:
 *        100,000 × ₹0.045 = ₹4,500 (was ₹5,000), 1,000 × ₹12.345 = ₹12,345.
 *   M3 — every order and quote line gets its own server id, even when the
 *        client sends none or repeats one; a part-shipped order made from the
 *        Commercial screen's payload can still be cancelled.
 *   M4 — cancels add up: a second cancel does not un-cancel the first, never
 *        cancels shipped units, and cannot cancel more than is left.
 *   M5 — two cancels at once are applied one after the other, not one over
 *        the other.
 *   M6 — a double-click on Create makes one order (and one quote), not two.
 *   M7 — only real ISO currency codes, and every line in the document's
 *        currency.
 *   M8 — a part shipment must give its counts; an order with 2 of 10 shipped
 *        cannot be marked delivered; "shipped" records the remainder.
 *   M12 — the follow-up radar's count is the true number due, not the ≤10 shown.
 *
 * Run: npm run golden:commercial-money-review
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { ensureWorkspace } from "./_helpers/fixtures";
import { computeLineTotal, cancelOrder } from "@/services/OrderService";
import { computeDiscountAmountPaise } from "@/lib/money";
import type { Order } from "@/lib/types";

const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: "GET" | "POST", path: string[], body?: unknown): Promise<{ status: number; body: any }> {
  const mod = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/${path.join("/")}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const handler = (mod as unknown as Record<string, (r: never, c: unknown) => Promise<Response>>)[method];
  const response = await handler(request as never, { params: Promise.resolve({ path }) });
  return { status: response.status, body: await response.json() };
}
const post = (path: string[], body?: unknown) => call("POST", path, body ?? {});

let leadId = "";
async function lead(): Promise<string> {
  if (leadId) return leadId;
  const r = await post(["leads", "manual"], { companyName: `Money review ${RUN}`, email: `money_${RUN}@example.test` });
  assert.equal(r.status, 200, `lead create failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  leadId = r.body.id;
  return leadId;
}
/** A product name unique to the case, so the double-click guard never merges two cases' orders. */
const product = (tag: string) => `Zari ${tag} ${RUN}`;

async function newOrder(tag: string, qty = 10, unitPrice = 100) {
  const r = await post(["orders"], { leadId: await lead(), status: "confirmed", lineItems: [{ productName: product(tag), quantity: qty, unitPrice }] });
  assert.equal(r.status, 200, `order create failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body as Order;
}

// ─── M1 ───────────────────────────────────────────────────────────────────
test("M1 — approve cannot revive a converted quote into a second order", async () => {
  const q = await post(["quotes"], { leadId: await lead(), lineItems: [{ productName: product("m1a"), quantity: 10, unitPrice: 500 }] });
  assert.equal((await post(["quotes", q.body.id, "status"], { toStatus: "sent" })).status, 200);
  const c1 = await post(["quotes", q.body.id, "convert"]);
  assert.equal(c1.status, 200);
  const ap = await post(["copilot", "approve"], { quoteId: q.body.id });
  assert.equal(ap.status, 409, `approving a converted quote returned ${ap.status}: ${JSON.stringify(ap.body).slice(0, 200)}`);
  assert.match(ap.body.error.message, /converted/);
  const c2 = await post(["quotes", q.body.id, "convert"]);
  assert.equal(c2.body.alreadyConverted, true, "the quote converted a second time");
  const { readData } = await import("@/lib/db");
  const orders = ((await readData()).orders || []) as Order[];
  assert.equal(orders.filter((o) => o.quoteId === q.body.id).length, 1, "two orders from one quote");
});

test("M1 — approve leaves a rejected quote rejected, blocks unpriced lines, stamps sentAt", async () => {
  const r = await post(["quotes"], { leadId: await lead(), lineItems: [{ productName: product("m1b"), quantity: 1, unitPrice: 50 }] });
  await post(["quotes", r.body.id, "status"], { toStatus: "rejected" });
  const ap = await post(["copilot", "approve"], { quoteId: r.body.id });
  assert.equal(ap.status, 409, `approving a rejected quote returned ${ap.status}`);
  const { repositories } = await import("@/repositories");
  const { defaultWorkspaceId } = await import("@/lib/db");
  assert.equal((await repositories.quote.getById(defaultWorkspaceId, r.body.id))?.status, "rejected");

  const unpriced = await post(["quotes"], { leadId: await lead(), lineItems: [{ productName: product("m1c"), quantity: 3, unitPrice: 0 }] });
  const ap2 = await post(["copilot", "approve"], { quoteId: unpriced.body.id });
  assert.equal(ap2.status, 409, "a quote with an unpriced line was approved to send");
  assert.match(ap2.body.error.message, /no price/);
  const viaStatus = await post(["quotes", unpriced.body.id, "status"], { toStatus: "sent" });
  assert.equal(viaStatus.status, 409, "the status route sent an unpriced quote");

  const good = await post(["quotes"], { leadId: await lead(), lineItems: [{ productName: product("m1d"), quantity: 2, unitPrice: 75 }] });
  const ap3 = await post(["copilot", "approve"], { quoteId: good.body.id });
  assert.equal(ap3.status, 200);
  assert.equal(ap3.body.quote.status, "sent");
  assert.ok(ap3.body.quote.sentAt, "sentAt was not stamped on approve");
  const missing = await post(["copilot", "approve"], { quoteId: `quote_nope_${RUN}` });
  assert.equal(missing.status, 404);
});

// ─── M2 ───────────────────────────────────────────────────────────────────
test("M2 — per-metre / per-gram prices multiply exactly, rounded once", async () => {
  assert.equal(computeLineTotal(100000, 0.045), 4500);
  assert.equal(computeLineTotal(1000, 12.345), 12345);
  assert.equal(computeLineTotal(250000, 0.0125), 3125);
  assert.equal(computeLineTotal(3, 0.335), 1.01, "1.005 rounds half up to 1.01");
  assert.equal(computeLineTotal(1.5, 100), 150);
  assert.equal(computeDiscountAmountPaise(0.05, 0.045, 100000), 500);
  const o = await newOrder("m2", 100000, 0.045);
  assert.equal(o.grandTotal, 4500, `order total ${o.grandTotal}`);
  assert.equal(o.lineItems[0].lineTotal, 4500);
});

// ─── M3 ───────────────────────────────────────────────────────────────────
test("M3 — every line gets a distinct server id (orders and quotes)", async () => {
  const noIds = await newOrder("m3a");
  assert.ok(typeof noIds.lineItems[0].id === "string" && noIds.lineItems[0].id.length > 0, "order line has no id");
  const dup = await post(["orders"], { leadId: await lead(), lineItems: [{ id: "X", productName: product("m3b"), quantity: 10, unitPrice: 100 }, { id: "X", productName: product("m3c"), quantity: 5, unitPrice: 1000 }] });
  const ids = (dup.body as Order).lineItems.map((l) => l.id);
  assert.equal(new Set(ids).size, 2, `duplicate line ids kept: ${ids}`);
  const q = await post(["quotes"], { leadId: await lead(), lineItems: [{ productName: product("m3d"), quantity: 1, unitPrice: 1 }, { productName: product("m3e"), quantity: 1, unitPrice: 2 }] });
  const qids = (q.body.lineItems as Array<{ id?: string }>).map((l) => l.id);
  assert.ok(qids.every(Boolean) && new Set(qids).size === 2, `quote line ids: ${qids}`);
  // The reviewer's repro: part-ship then cancel the Commercial screen's order.
  const lineId = noIds.lineItems[0].id;
  const ps = await post(["orders", noIds.id, "status"], { toStatus: "partial_shipped", shippedQuantityByLine: { [lineId]: 4 } });
  assert.equal(ps.status, 200);
  assert.deepEqual(Object.keys(ps.body.shippedQuantityByLine), [lineId]);
  const c = await post(["orders", noIds.id, "cancel"], { reason: "cut", cancelQuantitiesByLine: { [lineId]: 6 } });
  assert.equal(c.status, 200, `cancel failed: ${JSON.stringify(c.body).slice(0, 200)}`);
  assert.equal(c.body.grandTotal, 400);
});

// ─── M4 ───────────────────────────────────────────────────────────────────
test("M4 — cancels add up and never touch shipped units", async () => {
  const o = await newOrder("m4a");
  const L = o.lineItems[0].id;
  await post(["orders", o.id, "status"], { toStatus: "partial_shipped", shippedQuantityByLine: { [L]: 4 } });
  const a = await post(["orders", o.id, "cancel"], { reason: "first", cancelQuantitiesByLine: { [L]: 3 } });
  assert.equal(a.body.grandTotal, 700);
  const b = await post(["orders", o.id, "cancel"], { reason: "second", cancelQuantitiesByLine: { [L]: 1 } });
  assert.equal(b.status, 200);
  assert.equal(b.body.cancelledQuantityByLine[L], 4, "the second cancel replaced the first instead of adding to it");
  assert.equal(b.body.grandTotal, 600);
  const over = await post(["orders", o.id, "cancel"], { reason: "too many", cancelQuantitiesByLine: { [L]: 3 } });
  assert.equal(over.status, 409, "cancelled more than was left (2)");
  const noQty = await post(["orders", o.id, "cancel"], { reason: "full" });
  assert.equal(noQty.status, 409, "a no-quantity cancel after a shipment was accepted");
  const rest = await post(["orders", o.id, "cancel"], { reason: "rest", cancelQuantitiesByLine: { [L]: 2 } });
  assert.equal(rest.body.status, "partial_cancelled", "an order with shipped units became fully cancelled");
  assert.equal(rest.body.cancelledQuantityByLine[L], 6);
  assert.equal(rest.body.grandTotal, 400, "the 4 shipped units are still owed for");
  assert.equal((await post(["orders", o.id, "cancel"], { reason: "again" })).status, 409, "nothing left, yet cancel went through");

  // Nothing shipped: part-cancel, then cancel the rest → cancelled, 10 recorded.
  const n = await newOrder("m4b");
  const N = n.lineItems[0].id;
  await post(["orders", n.id, "cancel"], { reason: "part", cancelQuantitiesByLine: { [N]: 3 } });
  const all = await post(["orders", n.id, "cancel"], { reason: "the rest" });
  assert.equal(all.body.status, "cancelled");
  assert.equal(all.body.cancelledQuantityByLine[N], 10);

  // Pure: a partial_cancelled order with shipped units, cancelled with no quantities.
  const pure = { id: "o", orderNumber: 1, workspaceId: "w", leadId: "l", status: "partial_cancelled", origin: "direct", currencyCode: "INR",
    lineItems: [{ id: "li", productName: "Zari", quantity: 10, unitPrice: 100, lineTotal: 1000 }], grandTotal: 700,
    shippedQuantityByLine: { li: 4 }, cancelledQuantityByLine: { li: 3 }, createdAt: "", updatedAt: "" } as unknown as Order;
  await assert.rejects(cancelOrder(pure, { actor: "owner" }), /shipped/i);
});

// ─── M5 ───────────────────────────────────────────────────────────────────
test("M5 — two cancels at once both count", async () => {
  const o = await newOrder("m5");
  const L = o.lineItems[0].id;
  const r = await Promise.all([
    post(["orders", o.id, "cancel"], { reason: "A", cancelQuantitiesByLine: { [L]: 3 } }),
    post(["orders", o.id, "cancel"], { reason: "B", cancelQuantitiesByLine: { [L]: 5 } }),
  ]);
  assert.deepEqual(r.map((x) => x.status), [200, 200]);
  const { repositories } = await import("@/repositories");
  const { defaultWorkspaceId } = await import("@/lib/db");
  const saved = await repositories.order.getById(defaultWorkspaceId, o.id);
  assert.equal(saved?.cancelledQuantityByLine?.[L], 8, `stored cancelled ${saved?.cancelledQuantityByLine?.[L]} — one cancel overwrote the other`);
  assert.equal(saved?.grandTotal, 200);
});

// ─── M6 ───────────────────────────────────────────────────────────────────
test("M6 — a double-click creates one order and one quote", async () => {
  const body = { leadId: await lead(), lineItems: [{ productName: product("m6"), quantity: 1, unitPrice: 1 }] };
  const [a, b] = await Promise.all([post(["orders"], body), post(["orders"], body)]);
  assert.equal(a.body.id, b.body.id, `two orders: #${a.body.orderNumber} and #${b.body.orderNumber}`);
  const c = await post(["orders"], body);
  assert.equal(c.body.id, a.body.id, "a second click a moment later made another order");
  const d = await post(["orders"], { ...body, lineItems: [{ ...body.lineItems[0], quantity: 2 }] });
  assert.notEqual(d.body.id, a.body.id, "a different order was merged into the first");
  const [q1, q2] = await Promise.all([post(["quotes"], body), post(["quotes"], body)]);
  assert.equal(q1.body.id, q2.body.id, "two quotes from one double-click");
});

// ─── M7 ───────────────────────────────────────────────────────────────────
test("M7 — currency must be a real code and every line must match it", async () => {
  const bogus = await post(["orders"], { leadId: await lead(), currencyCode: "rupees", lineItems: [{ productName: product("m7a"), quantity: 1, unitPrice: 100 }] });
  assert.equal(bogus.status, 400, `"rupees" accepted as a currency (${bogus.status})`);
  assert.match(bogus.body.error.message, /currency code/);
  const mixed = await post(["orders"], { leadId: await lead(), currencyCode: "INR", lineItems: [{ productName: product("m7b"), quantity: 1, unitPrice: 100, currencyCode: "USD" }] });
  assert.equal(mixed.status, 400, "a USD line was added into an INR order");
  const qMixed = await post(["quotes"], { leadId: await lead(), lineItems: [{ productName: product("m7c"), quantity: 1, unitPrice: 100, currencyCode: "EUR" }] });
  assert.equal(qMixed.status, 400, "a EUR line was added into an INR quote");
  const lower = await post(["quotes"], { leadId: await lead(), currencyCode: "usd", lineItems: [{ productName: product("m7d"), quantity: 1, unitPrice: 100 }] });
  assert.equal(lower.status, 200);
  assert.equal(lower.body.currencyCode, "USD");
  const rv = await post(["quotes", lower.body.id, "revise"], { currencyCode: "dollars" });
  assert.equal(rv.status, 400, "a revise saved a made-up currency");
});

// ─── M8 ───────────────────────────────────────────────────────────────────
test("M8 — part shipments need counts; delivered needs everything shipped", async () => {
  const o = await newOrder("m8");
  const L = o.lineItems[0].id;
  const noCounts = await post(["orders", o.id, "status"], { toStatus: "partial_shipped" });
  assert.equal(noCounts.status, 400, "partial_shipped with no counts recorded everything as shipped");
  await post(["orders", o.id, "status"], { toStatus: "partial_shipped", shippedQuantityByLine: { [L]: 2 } });
  const early = await post(["orders", o.id, "status"], { toStatus: "delivered" });
  assert.equal(early.status, 409, "delivered with 2 of 10 shipped");
  assert.match(early.body.error.message, /2 of 10/);
  const shipped = await post(["orders", o.id, "status"], { toStatus: "shipped" });
  assert.equal(shipped.body.shippedQuantityByLine[L], 10, "shipped did not record the remainder");
  assert.equal((await post(["orders", o.id, "status"], { toStatus: "delivered" })).status, 200);
});

// ─── M12 ──────────────────────────────────────────────────────────────────
test("M12 — the follow-up radar counts every lead that is due", async () => {
  const { repositories } = await import("@/repositories");
  const { getFollowupRadar } = await import("@/services/OutreachQueueService");
  const ws = `ws_radar_${RUN}`;
  await ensureWorkspace(repositories, ws);
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  for (let i = 0; i < 13; i++) {
    await repositories.lead.createLead({ workspaceId: ws, companyName: `Radar ${i} ${RUN}`, status: "contacted", lastContactedAt: old } as never);
  }
  const radar = await getFollowupRadar(ws, repositories);
  assert.equal(radar.leads.length, 10);
  assert.equal(radar.count, 13, `count ${radar.count} — capped at the list size`);
});

(async () => {
  console.log("golden-commercial-money-review — quotes, orders and money (sector review 2026-09-27)\n");
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
  }
  console.log(`\ncommercial-money-review: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
  process.exit(failed ? 1 : 0);
})();
