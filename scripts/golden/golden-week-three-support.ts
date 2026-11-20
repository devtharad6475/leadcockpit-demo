import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { createTicketFromInbound, changeTicketStatus, assignTicketToMember, convertToTicket } from "@/services/TicketService";
import { defaultTicketSlaSettings } from "@/lib/ticket-sla";
import type { TicketSlaSettings } from "@/lib/types";
import { NeedsActionError } from "@/lib/user-errors";

async function main() {
  const repos = createJsonRepos();
  const ws = `ws_support_${Date.now()}`;
  await ensureWorkspace(repos, ws);
  const a = await repos.lead.createLead({ workspaceId: ws, companyName: "Customer A" });
  const b = await repos.lead.createLead({ workspaceId: ws, companyName: "Customer B" });
  const otherWs = `${ws}_other`;
  await ensureWorkspace(repos, otherWs);
  const other = await repos.lead.createLead({ workspaceId: otherWs, companyName: "Other workspace" });
  const order = await repos.order.create({ workspaceId: ws, leadId: b.id, orderNumber: 1, status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct" });
  const quote = await repos.quote.create({ workspaceId: ws, leadId: a.id, quoteNumber: 1, status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR" });
  const reply = await repos.reply.create({ workspaceId: ws, leadId: b.id, channel: "whatsapp", rawText: "Damaged parcel" });
  const base = { workspaceId: ws, sourceChannel: "manual", type: "complaint" as const, priority: "high" as const, subject: "Parcel", description: "Damaged parcel" };
  const before = (await repos.ticket.listByWorkspace(ws)).length;
  for (const links of [
    { leadId: a.id, orderId: order.id },
    { leadId: a.id, replyId: reply.id },
    { orderId: order.id, quoteId: quote.id },
    { leadId: "missing" }, { orderId: "missing" }, { quoteId: "missing" }, { replyId: "missing" }, { leadId: other.id },
  ]) {
    await assert.rejects(() => createTicketFromInbound({ ...base, ...links }, repos), NeedsActionError);
  }
  assert.equal((await repos.ticket.listByWorkspace(ws)).length, before, "Rejected links must not create a ticket");
  const ticket = await createTicketFromInbound({ ...base, leadId: ` ${b.id} `, orderId: order.id, replyId: reply.id }, repos);
  assert.equal(ticket.leadId, b.id);
  assert.equal(ticket.orderId, order.id);
  const creation = (await repos.ticketEvent.listByTicket(ws, ticket.id)).find(event => event.eventType === "created");
  assert.equal(creation?.note, "Created manually.", "A manually created case must not claim to come automatically from a customer message");
  assert.equal(creation?.actorType, "owner");
  assert.equal(ticket.sourceEntityType, "manual");
  const inbound = await createTicketFromInbound({ ...base, sourceChannel: "whatsapp", leadId: b.id }, repos);
  const inboundCreation = (await repos.ticketEvent.listByTicket(ws, inbound.id)).find(event => event.eventType === "created");
  assert.equal(inboundCreation?.note, "Created automatically from a WhatsApp message.");
  assert.equal(inboundCreation?.actorType, "agent");
  assert.equal(inbound.sourceEntityType, "inbound");
  const matchingQuote = await createTicketFromInbound({ ...base, leadId: a.id, quoteId: quote.id }, repos);
  assert.equal(matchingQuote.quoteId, quote.id);
  const orderOnly = await createTicketFromInbound({ ...base, orderId: order.id }, repos);
  assert.equal(orderOnly.leadId, b.id, "An order-linked manual case must retain its customer for conversations and closure");
  const quoteOnly = await createTicketFromInbound({ ...base, quoteId: quote.id }, repos);
  assert.equal(quoteOnly.leadId, a.id, "A quote-linked manual case must retain its customer");
  const manualFirst = await createTicketFromInbound({ ...base, leadId: a.id }, repos);
  const manualSecond = await createTicketFromInbound({ ...base, leadId: a.id }, repos);
  assert.notEqual(manualFirst.id, manualSecond.id, "Separate manual cases must remain separate without an inbound message link");
  assert.equal((await createTicketFromInbound({ ...base, leadId: b.id, replyId: reply.id }, repos)).id, ticket.id, "Repeated inbound retains its existing ticket");
  await assert.rejects(() => changeTicketStatus(ws, ticket.id, "banana" as never, { actorType: "owner" }, repos), NeedsActionError);
  assert.equal((await repos.ticket.getById(ws, ticket.id))?.status, "open");
  await assert.rejects(() => changeTicketStatus(ws, "missing", "closed", { actorType: "owner" }, repos), (error: unknown) => error instanceof NeedsActionError && error.statusCode === 404);
  const now = new Date().toISOString();
  await repos.workspaceMember.create({ id: `member_${ws}`, workspaceId: ws, userId: "support_owner", email: "support@example.test", name: "Support Owner", role: "sales_member", status: "active", createdAt: now, updatedAt: now });
  await assignTicketToMember(ws, ticket.id, "support_owner", "support_owner", repos);
  await assignTicketToMember(ws, ticket.id, undefined, "support_owner", repos);
  assert.equal((await repos.ticket.getById(ws, ticket.id))?.assignedTo, undefined);
  assert.ok((await repos.ticketEvent.listByTicket(ws, ticket.id)).some((event) => event.note === "Assignment removed."), "Removing assignment must remain visible in history");
  const source = await repos.unknownQuestion.create(ws, { questionText: "When is the parcel arriving?", leadId: a.id });
  const conversion = { source: { entity: "unknown_question" as const, record: source }, type: "question" as const, priority: "medium" as const, slaSettings: defaultTicketSlaSettings(ws) as TicketSlaSettings };
  await assert.rejects(() => convertToTicket({ ...conversion, priority: "banana" as never }), NeedsActionError);
  await assert.rejects(() => convertToTicket({ ...conversion, type: "banana" as never }), NeedsActionError);
  console.log("PASS golden-week-three-support: linked customer integrity, rejected writes, repeat inbound, status validation, assignment history");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
