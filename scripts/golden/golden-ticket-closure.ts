import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { repositories as repos } from "@/repositories";
import { createTicketFromInbound, changeTicketStatus } from "@/services/TicketService";
import { getTicketClosureDraft, saveTicketClosureDraft } from "@/services/TicketClosureService";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import type { WhatsAppSendProvider } from "@/providers/whatsapp/WhatsAppSendProvider";
import { replyDeliveryState } from "@/lib/reply-delivery-state";

async function main() {
  const workspaceId = "closure-company";
  const lead = await repos.lead.createLead({ workspaceId, companyName: "Synthetic buyer", status: "approved", doNotContact: false });
  const ticket = await createTicketFromInbound({ workspaceId, leadId: lead.id, sourceChannel: "manual", type: "complaint", priority: "high", subject: "Sample issue", description: "Wrong sample received." }, repos);
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: "We recorded the correction." }, repos), /Record the resolution/);
  await changeTicketStatus(workspaceId, ticket.id, "resolved", { actorType: "owner", userId: "employee", note: "Corrected sample verified." }, repos);
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: {} }, repos), /4,000/);
  await assert.rejects(() => saveTicketClosureDraft("foreign-company", ticket.id, { body: "Hello" }, repos), /not found/);
  const saves = await Promise.all([1, 2].map(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: "We have recorded the sample correction.", actorUserId: "employee" }, repos)));
  assert.equal(saves[0].draft.id, saves[1].draft.id);
  assert.equal((await repos.autoReplyLog.listByLead(workspaceId, lead.id)).length, 1);
  const log = await repos.autoReplyLog.getById(workspaceId, saves[0].draft.id);
  assert.equal(log?.status, "held_for_review"); assert.equal(log?.canAutoSend, false);
  assert.equal(log?.sendAttempted, false); assert.equal(log?.sendStatus, "not_attempted");
  assert.equal(log?.modelMode, "unknown");
  assert.equal((await getTicketClosureDraft(workspaceId, ticket.id, repos)).draft?.id, log?.id);
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: "Updated outcome." }, repos), /Confirm replacement/);
  const originalEventCreate = repos.ticketEvent.create.bind(repos.ticketEvent);
  repos.ticketEvent.create = async () => { throw new Error("Injected case history failure"); };
  try {
    await assert.rejects(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: "Updated outcome.", replaceExisting: true }, repos), /Injected case history/);
  } finally { repos.ticketEvent.create = originalEventCreate; }
  assert.equal((await repos.autoReplyLog.getById(workspaceId, log!.id))?.status, "held_for_review");
  assert.equal((await repos.autoReplyLog.listByLead(workspaceId, lead.id)).length, 1);
  const replaced = await saveTicketClosureDraft(workspaceId, ticket.id, { body: "Updated outcome.", replaceExisting: true }, repos);
  assert.notEqual(replaced.draft.id, log?.id);
  assert.equal((await repos.autoReplyLog.getById(workspaceId, log!.id))?.status, "rejected");
  assert.equal((await getTicketClosureDraft(workspaceId, ticket.id, repos)).draft?.id, replaced.draft.id);
  // Approval state is simulated locally; this suite never calls a sender.
  await repos.autoReplyLog.approve(workspaceId, replaced.draft.id, { status: "approved", sendStatus: "not_configured" });
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: "Another message", replaceExisting: true }, repos), /already has an approved reply/);
  assert.equal((await saveTicketClosureDraft(workspaceId, ticket.id, { body: "Updated outcome." }, repos)).reused, true);
  await repos.lead.updateLead(workspaceId, lead.id, { doNotContact: true });
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, ticket.id, { body: "Hello again" }, repos), /asked not to be contacted/);
  const missing = await createTicketFromInbound({ workspaceId, sourceChannel: "manual", type: "question", priority: "low", subject: "Internal", description: "No customer." }, repos);
  await changeTicketStatus(workspaceId, missing.id, "resolved", { actorType: "owner", note: "Internal case recorded." }, repos);
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, missing.id, { body: "Hello" }, repos), /Attach a customer/);
  const senderBuyer = await repos.lead.createLead({ workspaceId, companyName: "Synthetic send seam", phone: "919900001234", status: "approved", lastInboundAt: new Date().toISOString() });
  const senderTicket = await createTicketFromInbound({ workspaceId, leadId: senderBuyer.id, sourceChannel: "whatsapp", type: "question", priority: "low", subject: "Recorded outcome", description: "Synthetic only." }, repos);
  await changeTicketStatus(workspaceId, senderTicket.id, "resolved", { actorType: "owner", note: "Outcome checked." }, repos);
  const senderDraft = await saveTicketClosureDraft(workspaceId, senderTicket.id, { body: "Recorded outcome." }, repos);
  let calls = 0;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
  const provider: WhatsAppSendProvider = {
    isConfigured: () => true,
    testConnection: async () => ({ ok: true, status: "connected", message: "Synthetic seam" }),
    sendTextMessage: async () => {
      calls++; entered(); await paused;
      return { attempted: true, status: "sent", provider: "meta_cloud", providerMessageId: "synthetic-closure-send" };
    },
  };
  const approving = approveAutoReplyLog(workspaceId, senderDraft.draft.id, {}, repos, "synthetic-owner", { whatsappProvider: provider });
  await started;
  assert.equal((await repos.autoReplyLog.getById(workspaceId, senderDraft.draft.id))?.status, "approved", "Claim must be committed before provider entry");
  await assert.rejects(() => saveTicketClosureDraft(workspaceId, senderTicket.id, { body: "Replacement during approval", replaceExisting: true }, repos), /approved reply/);
  release(); await approving;
  await assert.rejects(() => approveAutoReplyLog(workspaceId, senderDraft.draft.id, {}, repos, "synthetic-owner", { whatsappProvider: provider }), /already approved/);
  assert.equal(calls, 1);
  assert.equal((await getTicketClosureDraft(workspaceId, senderTicket.id, repos)).draft?.sendStatus, "sent");
  const uncertainTicket = await createTicketFromInbound({ workspaceId, leadId: senderBuyer.id, sourceChannel: "whatsapp", type: "question", priority: "low", subject: "Uncertain provider result", description: "Synthetic only." }, repos);
  await changeTicketStatus(workspaceId, uncertainTicket.id, "resolved", { actorType: "owner", note: "Outcome checked." }, repos);
  const uncertain = await saveTicketClosureDraft(workspaceId, uncertainTicket.id, { body: "Another recorded outcome." }, repos);
  let uncertainCalls = 0;
  const uncertainProvider: WhatsAppSendProvider = { ...provider, sendTextMessage: async () => { uncertainCalls++; throw new Error("Synthetic connection lost after submission"); } };
  await assert.rejects(() => approveAutoReplyLog(workspaceId, uncertain.draft.id, {}, repos, "synthetic-owner", { whatsappProvider: uncertainProvider }), /delivery could not be confirmed/);
  await assert.rejects(() => approveAutoReplyLog(workspaceId, uncertain.draft.id, {}, repos, "synthetic-owner", { whatsappProvider: uncertainProvider }), /already approved/);
  assert.equal(uncertainCalls, 1);
  const uncertainLog = await repos.autoReplyLog.getById(workspaceId, uncertain.draft.id);
  assert.equal(uncertainLog?.sendStatus, "unconfirmed");
  assert.equal(replyDeliveryState(uncertainLog!).label, "Approved, delivery unconfirmed");
  console.log("PASS ticket closure: validation, scope, atomic replacement rollback, concurrent retry, durable approval claim, uncertain delivery blocks repeat, DNC; synthetic provider only, no external sends");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
