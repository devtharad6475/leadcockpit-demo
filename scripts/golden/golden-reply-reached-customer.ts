/**
 * golden-reply-reached-customer.ts — 2026-09-29, owner walk-through R2/NY2.
 *
 * An approved reply that never reached the customer (WhatsApp not connected,
 * window closed, a block) used to end on a Copy button, and approving it
 * stamped the customer as contacted — so they vanished from "Needs you"
 * although they received nothing.
 *
 *   A — an approved, undelivered reply from the last 30 days is a Needs-you
 *       item ("did not reach them"), listed once per customer (latest reply),
 *       and the customer is not ALSO listed as waiting.
 *   B — "I sent it myself": the row reads "Sent by you" (delivered, never
 *       "Sent on WhatsApp"), the customer counts as answered, the item goes,
 *       and it is audited.
 *   C — only an approved reply can be marked; a delivered one is left alone.
 *   D — delivered replies, do-not-contact customers and replies older than 30
 *       days are not listed.
 *   E — a waiting customer's chip says how long they really waited.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-reply-reached-customer.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { NeedsActionError } from "@/lib/user-errors";
import { replyDeliveryState } from "@/lib/reply-delivery-state";
import { buildNeedsYouList, waitedFor } from "@/services/NeedsYouService";
import { markReplySentByOwner } from "@/services/AutoReplyReviewService";
import { readData } from "@/lib/db";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

async function ws(tag: string) {
  const id = `ws_reached_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
let seq = 0;
async function buyer(W: string, extra: Record<string, unknown> = {}) {
  seq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Buyer ${seq}`, contactName: "B", whatsappNumber: `9197711${String(seq).padStart(5, "0")}`, source: "manual", status: "contacted", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", lastInboundAt: ago(3), lastContactedAt: ago(2), ...extra } as never);
}
async function approvedReply(W: string, leadId: string, sendStatus: string | undefined, text = "Here is our catalogue.") {
  const log = await repos.autoReplyLog.create(W, { leadId, channel: "whatsapp", incomingMessage: "catalogue?", retrievedContext: {}, canAutoSend: false, needsHumanReview: true, status: "held_for_review", generatedReply: text } as never);
  return repos.autoReplyLog.approve(W, log.id, { sendStatus: sendStatus as never, generatedReply: text });
}
const undelivered = (list: Awaited<ReturnType<typeof buildNeedsYouList>>) => list.items.filter((i) => i.id.startsWith("u:"));

test("A — an approved reply that did not reach the customer needs the owner", async () => {
  const W = await ws("a");
  const lead = await buyer(W);
  await approvedReply(W, lead.id, "not_configured", "older reply");
  const latest = await approvedReply(W, lead.id, "not_attempted", "latest reply");
  const list = await buildNeedsYouList(W, repos, { now: NOW });
  const items = undelivered(list);
  assert.equal(items.length, 1, "one item per customer, not one per reply");
  assert.equal(items[0].log?.id, latest.id, "the latest undelivered reply is the one listed");
  assert.match(items[0].title, /did not reach them/);
  assert.ok(!list.items.some((i) => i.bucket === "customer_waiting" && i.leadId === lead.id), "listed once, not also as waiting");
  assert.equal(list.count, list.items.length);
});

test("B — 'I sent it myself' closes it honestly", async () => {
  const W = await ws("b");
  const lead = await buyer(W, { lastContactedAt: undefined });
  const log = await approvedReply(W, lead.id, "not_configured");
  const marked = await markReplySentByOwner(W, log.id, repos, "user_owner_b");
  assert.equal(marked.sendStatus, "sent_by_owner");
  const state = replyDeliveryState(marked);
  assert.equal(state.delivered, true);
  assert.equal(state.label, "Sent by you", "must never claim a WhatsApp Cloud send");
  assert.ok((await repos.lead.getLeadById(W, lead.id))?.lastContactedAt, "the customer counts as answered");
  assert.equal(undelivered(await buildNeedsYouList(W, repos, { now: NOW })).length, 0, "the item must go");
  const audit = (await readData()).auditLogs?.filter((a) => a.workspaceId === W && a.eventType === "message.sent_by_owner") || [];
  assert.equal(audit.length, 1, "marking must be audited once");
  await markReplySentByOwner(W, log.id, repos);
  assert.equal(((await readData()).auditLogs?.filter((a) => a.workspaceId === W && a.eventType === "message.sent_by_owner") || []).length, 1, "marking twice changes nothing");
});

test("C — only an approved, undelivered reply can be marked", async () => {
  const W = await ws("c");
  const lead = await buyer(W);
  const held = await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "price?", retrievedContext: {}, canAutoSend: false, needsHumanReview: true, status: "held_for_review", generatedReply: "draft" } as never);
  await assert.rejects(() => markReplySentByOwner(W, held.id, repos), NeedsActionError, "a held draft cannot be marked as sent");
  const sent = await approvedReply(W, lead.id, "sent");
  assert.equal((await markReplySentByOwner(W, sent.id, repos)).sendStatus, "sent", "a WhatsApp-delivered reply stays as it is");
  await assert.rejects(() => markReplySentByOwner(`${W}_other`, sent.id, repos), NeedsActionError, "another company cannot mark it");
});

test("D — delivered, opted-out and old replies are not listed", async () => {
  const W = await ws("d");
  const a = await buyer(W);
  await approvedReply(W, a.id, "sent");
  const b = await buyer(W, { doNotContact: true, status: "do_not_contact" });
  await approvedReply(W, b.id, "not_configured");
  const c = await buyer(W);
  const old = await approvedReply(W, c.id, "not_configured");
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    const row = data.autoReplyLogs?.find((l) => l.id === old.id);
    if (row) { row.createdAt = ago(40); row.updatedAt = ago(40); }
  });
  assert.equal(undelivered(await buildNeedsYouList(W, repos, { now: NOW })).length, 0);
});

test("E — a waiting customer's chip says how long they really waited", async () => {
  assert.equal(waitedFor(new Date(NOW.getTime() - 35 * DAY).toISOString(), NOW), "35 days");
  assert.equal(waitedFor(new Date(NOW.getTime() - 1 * DAY).toISOString(), NOW), "1 day");
  assert.equal(waitedFor(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW), "3 hours");
  assert.equal(waitedFor(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW), "5 minutes");
  const W = await ws("e");
  const lead = await buyer(W, { lastInboundAt: ago(35), lastContactedAt: undefined });
  const item = (await buildNeedsYouList(W, repos, { now: NOW })).items.find((i) => i.bucket === "customer_waiting" && i.leadId === lead.id);
  assert.ok(item, "a 35-day wait must be listed");
  assert.equal(item!.chips[0]?.text, "No reply for 35 days");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
