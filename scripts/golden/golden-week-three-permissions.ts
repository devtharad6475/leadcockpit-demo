import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createRepositories } from "@/repositories";
import { createSessionToken, SESSION_COOKIE } from "@/lib/session";
import { hashPassword } from "@/lib/password";
import type { WorkspaceRole } from "@/lib/types";

process.env.AUTH_MODE = "production";
process.env.AUTH_SESSION_SECRET = "disposable-week-three-permissions-session-secret";
process.env.NEXT_PUBLIC_APP_ORIGIN = "http://localhost:3000";
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.REDIS_URL = "";
const repos = createRepositories("json");
const run = `${Date.now()}_${process.pid}`;
const now = new Date().toISOString();
const lines = [{ productName: "Permissions item", quantity: 2, unitPrice: 25 }];

async function person(workspaceId: string, role: WorkspaceRole) {
  const id = `${workspaceId}_${role}`;
  const email = `${id}@example.invalid`;
  await repos.user.create({ id, workspaceId, name: role, email, role, createdAt: now, updatedAt: now });
  await repos.userCredential.create({ id: `${id}_credential`, userId: id, workspaceId, email,
    passwordHash: await hashPassword("Disposable-permissions-check-only!"), sessionVersion: 1, createdAt: now, updatedAt: now });
  await repos.workspaceMember.create({ id: `${id}_membership`, workspaceId, userId: id, email, name: role,
    role, status: "active", createdAt: now, updatedAt: now });
  return { id, token: createSessionToken({ userId: id, workspaceId, role, sessionVersion: 1 }) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(token: string, path: string[], body: unknown = {}): Promise<{ status: number; body: any }> {
  const { POST } = await import("@/app/api/[[...path]]/route");
  const request = new NextRequest(`http://localhost:3000/api/${path.join("/")}`, {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify(body),
  });
  const response = await POST(request, { params: Promise.resolve({ path }) });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const ws = `week_three_permissions_${run}`;
  const foreignWs = `week_three_foreign_${run}`;
  for (const id of [ws, foreignWs]) await repos.workspace.create({ id, name: "Disposable permission company", industry: "Testing", createdAt: now, updatedAt: now });
  const owner = await person(ws, "owner");
  const staff = await person(ws, "sales_member");
  const viewer = await person(ws, "viewer");
  const ownLead = await repos.lead.createLead({ workspaceId: ws, companyName: "Own company buyer", status: "approved" });
  const foreignLead = await repos.lead.createLead({ workspaceId: foreignWs, companyName: "Foreign buyer", status: "approved" });
  const quote = await post(owner.token, ["quotes"], { leadId: ownLead.id, lineItems: lines });
  assert.equal(quote.status, 200);
  const order = await post(staff.token, ["orders"], { leadId: ownLead.id, status: "confirmed", lineItems: lines });
  assert.equal(order.status, 200);
  const denied: Array<[string[], unknown]> = [
    [["orders"], { leadId: ownLead.id, lineItems: lines }],
    [["quotes"], { leadId: ownLead.id, lineItems: lines }],
    [["quotes", quote.body.id, "revise"], {}],
    [["quotes", quote.body.id, "convert"], {}],
    [["quotes", quote.body.id, "status"], { toStatus: "sent" }],
    [["orders", order.body.id, "cancel"], {}],
    [["orders", order.body.id, "status"], { toStatus: "shipped" }],
    [["tickets"], { leadId: ownLead.id, subject: "Viewer should not create" }],
  ];
  for (const [path, body] of denied) assert.equal((await post(viewer.token, path, body)).status, 403, `Viewer mutated ${path.join("/")}`);
  assert.equal((await repos.quote.getById(ws, quote.body.id))?.status, "draft");
  assert.equal((await repos.order.getById(ws, order.body.id))?.status, "confirmed");
  assert.equal((await repos.ticket.listByWorkspace(ws)).length, 0);
  const elevatedCookie = createSessionToken({ userId: viewer.id, workspaceId: ws, role: "owner", sessionVersion: 1 });
  assert.equal((await post(elevatedCookie, ["orders"], { lineItems: lines })).status, 403, "Cookie role overrode viewer membership");
  console.log("PASS viewer is refused across eight commercial/support mutations; persisted records unchanged and membership wins over cookie role");

  assert.equal((await post(staff.token, ["quotes", quote.body.id, "status"], { toStatus: "sent" })).status, 200);
  const converted = await post(staff.token, ["quotes", quote.body.id, "convert"]);
  assert.equal(converted.status, 200);
  assert.equal(converted.body.order.workspaceId, ws);
  const cancellation = await post(staff.token, ["orders", order.body.id, "cancel"], { actor: "owner", actorUserId: owner.id, reason: "Staff cancels own company order" });
  assert.equal(cancellation.status, 200);
  assert.equal(cancellation.body.cancelledBy, staff.id);
  assert.equal((await repos.order.getById(ws, order.body.id))?.cancelledBy, staff.id);
  const ticket = await post(staff.token, ["tickets"], { leadId: ownLead.id, orderId: converted.body.order.id, subject: "Own company order question", actorUserId: owner.id });
  assert.equal(ticket.status, 200);
  const events = await repos.ticketEvent.listByTicket(ws, ticket.body.id);
  assert.equal(events.find(event => event.eventType === "created")?.actorUserId, staff.id);
  console.log("PASS sales staff can create/advance/convert/cancel own company records; forged owner identity cannot change cancellation or ticket attribution");

  for (const path of [["orders"], ["quotes"], ["tickets"]]) {
    const bad = await post(staff.token, path, { leadId: foreignLead.id, lineItems: lines, subject: "Foreign buyer" });
    assert.equal(bad.status, 404, `Foreign buyer accepted by ${path.join("/")}`);
  }
  const foreignOrder = await repos.order.createWithNextOrderNumber({ workspaceId: foreignWs, leadId: foreignLead.id,
    status: "confirmed", lineItems: [{ id: "foreign-line", productName: "Foreign item", quantity: 1, unit: "item", unitPrice: 10, currencyCode: "INR", lineTotal: 10 }], grandTotal: 10, currencyCode: "INR", origin: "direct" });
  const foreignQuote = await repos.quote.createWithNextQuoteNumber({ workspaceId: foreignWs, leadId: foreignLead.id, status: "sent",
    lineItems: foreignOrder.lineItems, grandTotal: 10, currencyCode: "INR" });
  for (const [path, body] of [
    [["orders", foreignOrder.id, "cancel"], {}],
    [["orders", foreignOrder.id, "status"], { toStatus: "shipped" }],
    [["quotes", foreignQuote.id, "convert"], {}],
    [["quotes", foreignQuote.id, "revise"], {}],
    [["tickets"], { leadId: ownLead.id, orderId: foreignOrder.id, subject: "Foreign order" }],
    [["tickets"], { leadId: ownLead.id, quoteId: foreignQuote.id, subject: "Foreign quote" }],
  ] as Array<[string[], unknown]>) assert.equal((await post(staff.token, path, body)).status, 404, `Foreign record accepted by ${path.join("/")}`);
  assert.equal((await post(staff.token, ["orders"], { workspaceId: foreignWs, lineItems: lines })).status, 403);
  assert.equal((await repos.order.getById(foreignWs, foreignOrder.id))?.status, "confirmed");
  assert.equal((await repos.quote.getById(foreignWs, foreignQuote.id))?.status, "sent");
  console.log("PASS foreign company buyer/order/quote references and forged workspace are refused; foreign records remain unchanged");
  console.log("Week three production-auth commercial/support permissions: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
