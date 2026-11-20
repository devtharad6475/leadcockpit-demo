import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { ensureWorkspace } from "./_helpers/fixtures";
import { readData } from "@/lib/db";
import type { Order, Quote } from "@/lib/types";

async function post<T>(path: string[], body: unknown = {}): Promise<{ status: number; body: T }> {
  const { POST } = await import("@/app/api/[[...path]]/route");
  const response = await POST(new Request(`http://localhost/api/${path.join("/")}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as never, { params: Promise.resolve({ path }) });
  return { status: response.status, body: await response.json() as T };
}

async function main() {
  const { repositories } = await import("@/repositories");
  await ensureWorkspace(repositories, "workspace_demo");
  const lead = await post<{ id: string }>(["leads", "manual"], { companyName: "Week Three Commercial", email: "week-three@example.test" });
  assert.equal(lead.status, 200);
  const line = { productName: "Precision thread", quantity: 2, unitPrice: 12.345 };
  const first = await post<Order>(["orders"], { leadId: ` ${lead.body.id} `, lineItems: [line], notes: "First agreement" });
  assert.equal(first.status, 200);
  assert.equal(first.body.leadId, lead.body.id, "save the same normalized customer that was validated");
  assert.equal(first.body.grandTotal, 24.69);
  const second = await post<Order>(["orders"], { leadId: lead.body.id, lineItems: [line], notes: "Second agreement" });
  assert.equal(second.status, 200);
  assert.notEqual(first.body.id, second.body.id, "different agreement notes must not collapse into the earlier order");
  const replay = await post<Order>(["orders"], { leadId: lead.body.id, lineItems: [line], notes: "Second agreement" });
  assert.equal(replay.body.id, second.body.id, "genuine double-click still returns one order");
  const q1 = await post<Quote>(["quotes"], { leadId: ` ${lead.body.id} `, lineItems: [line], validityNote: "Valid until Friday" });
  const q2 = await post<Quote>(["quotes"], { leadId: lead.body.id, lineItems: [line], validityNote: "Valid until Monday" });
  assert.equal(q1.status, 200); assert.equal(q2.status, 200);
  assert.equal(q1.body.leadId, lead.body.id);
  assert.notEqual(q1.body.id, q2.body.id, "different validity must keep distinct quotes");
  const cancel = await post<Order>(["orders", first.body.id, "cancel"], { actor: "forged-owner", actorUserId: "forged-owner", reason: "Customer cancelled" });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelledBy, "demo_user", "cancellation actor must come from the resolved identity, never the request label");
  const snapshot = await readData();
  assert.equal(snapshot.orders?.filter(o => o.id === second.body.id).length, 1);
  const other = await post<{ id: string }>(["leads", "manual"], { companyName: "Other buyer", email: "other-week-three@example.test" });
  const reply = await repositories.reply.create({ workspaceId: "workspace_demo", leadId: other.body.id, channel: "manual", rawText: "My order request" });
  const wrongReply = await post(["orders"], { leadId: lead.body.id, lineItems: [line], sourceReplyId: reply.id });
  assert.equal(wrongReply.status, 400, "another customer's conversation cannot be linked to this order");
  const missingProduct = await post(["quotes"], { leadId: lead.body.id, lineItems: [{ productId: "product-from-another-company", quantity: 1, unitPrice: 5 }] });
  assert.equal(missingProduct.status, 404, "a foreign or stale product reference cannot become a blank quoted item");
  console.log("PASS Week3 API: normalized customer, distinct agreements, once-only replay, truthful cancellation actor");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
