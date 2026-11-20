import assert from "node:assert/strict";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Quote } from "@/lib/types";
import { createOrderDirect } from "@/services/OrderService";
import { convertPersistedQuoteToOrder } from "@/services/QuoteConversionService";

export async function checkWeekThreeConversions(repos: RepositoryBundle) {
  const workspaceId = `week_three_conversion_${Date.now()}_${process.pid}`;
  const now = new Date().toISOString();
  await repos.workspace.create({ id: workspaceId, name: "Disposable conversion checks", industry: "Testing", createdAt: now, updatedAt: now });
  async function makeQuote(status: Quote["status"] = "sent") {
    return repos.quote.createWithNextQuoteNumber({ workspaceId, leadId: "", status,
      lineItems: [{ id: "line-one", productName: "Measured item", quantity: 1.5, unit: "kg", unitPrice: 12.345, lineTotal: 18.52, currencyCode: "INR" }],
      grandTotal: 18.52, currencyCode: "INR", notes: "Price snapshot" });
  }
  const original = await makeQuote();
  const conversions = await Promise.all(Array.from({ length: 6 }, () => convertPersistedQuoteToOrder(workspaceId, original.id, undefined, repos)));
  assert.ok(conversions.every(result => result?.order.id === conversions[0]?.order.id));
  assert.equal(conversions.filter(result => !result?.alreadyConverted).length, 1);
  assert.equal((await repos.order.listByWorkspace(workspaceId)).length, 1);
  const persisted = await repos.quote.getById(workspaceId, original.id);
  assert.equal(persisted?.status, "converted");
  assert.equal(persisted?.orderId, conversions[0]?.order.id);
  assert.equal(conversions[0]?.order.quoteId, original.id);
  assert.equal(conversions[0]?.order.grandTotal, 18.52);
  assert.equal(conversions[0]?.order.lineItems[0].unitPrice, 12.345);
  console.log("PASS concurrent conversion creates one order with both durable links and exact snapshot");

  await assert.rejects(repos.quote.update(workspaceId, original.id, { status: "accepted" }, "sent"), /changed while/);
  assert.equal((await repos.quote.getById(workspaceId, original.id))?.status, "converted");
  const rejected = await makeQuote("rejected");
  await assert.rejects(convertPersistedQuoteToOrder(workspaceId, rejected.id, undefined, repos), /only sent or accepted/);
  assert.equal((await repos.quote.getById(workspaceId, rejected.id))?.status, "rejected");
  assert.equal(await convertPersistedQuoteToOrder("other-workspace", original.id, undefined, repos), undefined);
  console.log("PASS stale changes, terminal quotes and foreign workspace cannot bypass conversion history");

  const rollback = await makeQuote();
  const countBefore = (await repos.order.listByWorkspace(workspaceId)).length;
  await assert.rejects(repos.quote.convertToOrderAtomically(workspaceId, rollback.id, async current => {
    current.notes = "Must not leak";
    throw new Error("Injected business failure");
  }), /Injected business failure/);
  assert.equal((await repos.quote.getById(workspaceId, rollback.id))?.notes, "Price snapshot");
  assert.equal((await repos.quote.getById(workspaceId, rollback.id))?.status, "sent");
  assert.equal((await repos.order.listByWorkspace(workspaceId)).length, countBefore);
  const retry = await convertPersistedQuoteToOrder(workspaceId, rollback.id, undefined, repos);
  assert.equal(retry?.alreadyConverted, false);
  console.log("PASS failure does not mutate the quote; retry makes exactly one linked order");

  const raceQuote = await makeQuote();
  const revision = (current: Quote) => {
    if (["accepted", "converted", "superseded"].includes(current.status)) throw new Error("Committed or replaced quote cannot be revised");
    return Promise.resolve({ workspaceId, leadId: current.leadId, status: "draft" as const,
      lineItems: current.lineItems, grandTotal: current.grandTotal, currencyCode: current.currencyCode,
      supersedesQuoteId: current.id });
  };
  const race = await Promise.allSettled([
    repos.quote.reviseAtomically(workspaceId, raceQuote.id, revision),
    convertPersistedQuoteToOrder(workspaceId, raceQuote.id, undefined, repos),
  ]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  const final = await repos.quote.getById(workspaceId, raceQuote.id);
  const replacements = (await repos.quote.listByWorkspace(workspaceId)).filter(q => q.supersedesQuoteId === raceQuote.id);
  const matchingOrders = (await repos.order.listByWorkspace(workspaceId)).filter(o => o.quoteId === raceQuote.id);
  if (final?.status === "superseded") { assert.equal(replacements.length, 1); assert.equal(matchingOrders.length, 0); }
  else { assert.equal(final?.status, "converted"); assert.equal(matchingOrders.length, 1); assert.equal(replacements.length, 0); }
  console.log("PASS revision and conversion race preserves one valid outcome without overwritten commitment");

  const numberQuote = await makeQuote();
  const numbers = await Promise.all([
    convertPersistedQuoteToOrder(workspaceId, numberQuote.id, undefined, repos),
    createOrderDirect({ workspaceId, leadId: "", lineItems: original.lineItems, currencyCode: "INR" }).then(order => repos.order.createWithNextOrderNumber(order)),
  ]);
  assert.notEqual(numbers[0] && "order" in numbers[0] ? numbers[0].order.orderNumber : undefined, numbers[1] && "orderNumber" in numbers[1] ? numbers[1].orderNumber : undefined);
  const all = await repos.order.listByWorkspace(workspaceId);
  assert.equal(new Set(all.map(o => o.orderNumber)).size, all.length);
  console.log("PASS direct order and quote conversion share unique workspace numbering");
  return { workspaceId, makeQuote };
}
