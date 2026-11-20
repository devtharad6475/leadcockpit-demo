import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { cancelOrder, createOrderDirect, createReorderDraft, shipmentPatchFor, validateShippedQuantities } from "@/services/OrderService";
import { nextOrderStatuses } from "@/lib/status-transitions";

async function main() {
  const original = await createOrderDirect({ workspaceId: "commercial-journey", leadId: "synthetic-buyer", status: "confirmed", currencyCode: "INR",
    lineItems: [{ id: "original-line", productName: "Sample spool", unit: "spools", currencyCode: "INR", quantity: 10, unitPrice: 100, lineTotal: 1000 }] });
  const lineId = original.lineItems[0].id;
  let order = { ...original, ...shipmentPatchFor(original, "partial_shipped", { [lineId]: 2 }), status: "partial_shipped" as const };
  const firstCancellation = await cancelOrder(order, { actor: "owner", reason: "Customer reduced request", cancelQuantitiesByLine: { [lineId]: 3 } });
  assert.equal(firstCancellation.grandTotal, 700);
  assert.ok(nextOrderStatuses(firstCancellation.status).includes("partial_shipped"));
  order = { ...firstCancellation, ...shipmentPatchFor(firstCancellation, "partial_shipped", { [lineId]: 4 }), status: "partial_shipped" };
  assert.throws(() => validateShippedQuantities(order, { [lineId]: 8 }), /Only 7/);
  const secondCancellation = await cancelOrder(order, { actor: "owner", reason: "One more no longer needed", cancelQuantitiesByLine: { [lineId]: 1 } });
  assert.equal(secondCancellation.cancelledQuantityByLine?.[lineId], 4);
  assert.equal(secondCancellation.grandTotal, 600);
  assert.deepEqual(shipmentPatchFor(secondCancellation, "shipped", undefined).shippedQuantityByLine, { [lineId]: 6 });
  console.log("PASS dispatch → cancellation → further dispatch → further cancellation preserves counts and totals");

  const repeated = await createReorderDraft(secondCancellation);
  assert.equal(repeated.status, "draft");
  assert.equal(repeated.lineItems[0].quantity, 10);
  assert.equal(repeated.lineItems[0].lineTotal, 1000);
  assert.equal(repeated.grandTotal, 1000);
  assert.notEqual(repeated.lineItems[0].id, original.lineItems[0].id);
  assert.equal(repeated.reorderedFromOrderId, original.id);
  assert.equal(repeated.cancelledQuantityByLine, undefined);
  assert.equal(repeated.shippedQuantityByLine, undefined);
  assert.equal(secondCancellation.grandTotal, 600);
  console.log("PASS repeat order restores original quantities, recomputes full total and preserves original history");

  const fractional = { ...original, status: "partial_cancelled" as const,
    lineItems: [{ ...original.lineItems[0], quantity: 0.3, unitPrice: 100, lineTotal: 30 }],
    shippedQuantityByLine: { [lineId]: 0.1 }, cancelledQuantityByLine: { [lineId]: 0.1 } };
  assert.deepEqual(shipmentPatchFor(fractional, "shipped", undefined).shippedQuantityByLine, { [lineId]: 0.2 });
  assert.throws(() => shipmentPatchFor(fractional, "partial_shipped", { [lineId]: 0.3 }), /Only 0.2/);
  assert.equal((await createReorderDraft(fractional)).grandTotal, 30);
  console.log("PASS fractional remaining stock stays exact and cannot overship cancelled quantities");
  console.log("3 commercial journey scenarios PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
