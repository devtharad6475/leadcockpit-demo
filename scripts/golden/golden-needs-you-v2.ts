/**
 * golden-needs-you-v2.ts — 2026-09-28 (CEO: "the owner checks it once or twice
 * a day"). "Needs you" is ONE server list with ONE count, used by the screen,
 * the header and the morning summary. Rules: docs/LOGIC.md NEEDS-YOU-V2.
 *
 *   A — a customer waiting: more than 2 BUSINESS hours with no reply (the
 *       company's hours, not the wall clock); a reply, an automatic reply that
 *       went out, do-not-contact, or a held reply already listed → not waiting.
 *   B — tickets: late or due today are listed; tomorrow, resolved and
 *       waiting-for-customer are not.
 *   C — orders: confirmed or partly shipped for more than 3 days.
 *   D — quotes: sent more than 3 days ago with no answer, with the amount;
 *       a customer who wrote back since is not "no answer".
 *   E — one count: count = items; held replies only for the owner.
 *   F — company-scoped.
 *   G — the WhatsApp engine stamps an automatic reply that went out as a reply.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-needs-you-v2.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { buildNeedsYouList } from "@/services/NeedsYouService";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// Tuesday 29 Sep 2026, 15:00 IST. Default business hours: Mon–Sat 09:00–18:00 IST.
const NOW = new Date("2026-09-29T09:30:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

async function ws(tag: string) {
  const id = `ws_needs_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
let seq = 0;
async function buyer(W: string, extra: Record<string, unknown> = {}) {
  seq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Buyer ${seq}`, contactName: "B", whatsappNumber: `9198800${String(seq).padStart(5, "0")}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", ...extra } as never);
}
const ids = (list: Awaited<ReturnType<typeof buildNeedsYouList>>, bucket: string) =>
  list.items.filter((i) => i.bucket === bucket).map((i) => i.leadId || i.id);

test("A — a customer waiting more than 2 business hours", async () => {
  const W = await ws("a");
  const waiting = await buyer(W, { lastInboundAt: "2026-09-29T05:30:00Z" });            // 11:00 IST → 4 working hours
  const recent = await buyer(W, { lastInboundAt: "2026-09-29T08:30:00Z" });             // 14:00 IST → 1 hour
  const eveningBefore = await buyer(W, { lastInboundAt: "2026-09-28T12:00:00Z" });      // Mon 17:30 IST
  const answered = await buyer(W, { lastInboundAt: "2026-09-29T05:30:00Z", lastContactedAt: "2026-09-29T06:00:00Z" });
  const autoAnswered = await buyer(W, { lastInboundAt: "2026-09-29T05:30:00Z", lastContactedAt: "2026-09-29T05:30:00Z" });
  const optedOut = await buyer(W, { lastInboundAt: "2026-09-29T05:30:00Z", doNotContact: true, status: "do_not_contact" });
  const held = await buyer(W, { lastInboundAt: "2026-09-29T05:30:00Z" });
  await repos.autoReplyLog.create(W, { leadId: held.id, channel: "whatsapp", incomingMessage: "price?", retrievedContext: {}, canAutoSend: false, needsHumanReview: true, status: "held_for_review", generatedReply: "draft" } as never);

  const list = await buildNeedsYouList(W, repos, { now: NOW });
  const w = ids(list, "customer_waiting");
  assert.ok(w.includes(waiting.id), "a customer unanswered for 4 working hours must be listed");
  assert.ok(w.includes(eveningBefore.id), "Mon 17:30 → Tue 15:00 is 6.5 working hours: waiting");
  assert.ok(!w.includes(recent.id), "one working hour is not yet waiting");
  assert.ok(!w.includes(answered.id), "a customer we replied to is not waiting");
  assert.ok(!w.includes(autoAnswered.id), "an automatic reply that went out counts as a reply");
  assert.ok(!w.includes(optedOut.id), "a do-not-contact customer is never listed as waiting");
  assert.ok(!w.includes(held.id), "a customer whose reply is held is listed once (held reply), not twice");
  assert.ok(ids(list, "flag").includes(held.id));

  // Tuesday 09:30 IST: Mon 17:30 → 30 min Monday + 30 min Tuesday = 1 working hour,
  // although 16 hours passed on the clock.
  const morning = await buildNeedsYouList(W, repos, { now: new Date("2026-09-29T04:00:00Z") });
  assert.ok(!ids(morning, "customer_waiting").includes(eveningBefore.id), "night hours must not count as waiting (business hours, not the clock)");

  // The company's own hours are used: open 24/7 → the night counts.
  await repos.ticketSlaSettings.upsertForWorkspace(W, { clockMode: "always_24_7" } as never);
  const allDay = await buildNeedsYouList(W, repos, { now: new Date("2026-09-29T04:00:00Z") });
  assert.ok(ids(allDay, "customer_waiting").includes(eveningBefore.id), "a company open 24/7 must count the night");
});

test("B — tickets late or due today", async () => {
  const W = await ws("b");
  const base = { workspaceId: W, type: "complaint", priority: "high", subject: "Wrong colour", description: "x", sourceChannel: "whatsapp", sourceEntityType: "manual", slaStartedAt: ago(1), slaBreached: false };
  const late = await repos.ticket.create({ ...base, ticketNumber: 1, status: "open", slaDueAt: "2026-09-29T08:00:00Z" } as never);
  const today = await repos.ticket.create({ ...base, ticketNumber: 2, status: "in_progress", slaDueAt: "2026-09-29T12:00:00Z" } as never);
  const tomorrow = await repos.ticket.create({ ...base, ticketNumber: 3, status: "open", slaDueAt: "2026-09-30T06:00:00Z" } as never);
  const resolved = await repos.ticket.create({ ...base, ticketNumber: 4, status: "resolved", slaDueAt: "2026-09-28T08:00:00Z" } as never);
  const theirTurn = await repos.ticket.create({ ...base, ticketNumber: 5, status: "waiting_customer", slaDueAt: "2026-09-28T08:00:00Z" } as never);
  const list = await buildNeedsYouList(W, repos, { now: NOW });
  const t = list.items.filter((i) => i.bucket === "ticket");
  assert.deepEqual(t.map((i) => i.ticket?.id), [late.id, today.id], "late first, then due today — nothing else");
  assert.ok(t[0].chips.some((c) => c.text === "Late"));
  assert.ok(t[1].chips.some((c) => c.text === "Due today"));
  for (const x of [tomorrow, resolved, theirTurn]) assert.ok(!t.some((i) => i.ticket?.id === x.id));
});

test("C — orders to ship", async () => {
  const W = await ws("c");
  const lead = await buyer(W);
  const mk = (n: number, status: string, extra: Record<string, unknown>) =>
    repos.order.create({ workspaceId: W, leadId: lead.id, orderNumber: n, status, lineItems: [], grandTotal: 50000 * n, currencyCode: "INR", origin: "direct", ...extra } as never);
  const old = await mk(1, "confirmed", { confirmedAt: ago(5) });
  const fresh = await mk(2, "confirmed", { confirmedAt: ago(1) });
  const partly = await mk(3, "partial_shipped", { confirmedAt: ago(9), shippedAt: ago(4) });
  const shipped = await mk(4, "shipped", { confirmedAt: ago(9), shippedAt: ago(8) });
  const o = (await buildNeedsYouList(W, repos, { now: NOW })).items.filter((i) => i.bucket === "order").map((i) => i.order?.id);
  assert.ok(o.includes(old.id) && o.includes(partly.id), "confirmed or partly shipped for more than 3 days must be listed");
  assert.ok(!o.includes(fresh.id) && !o.includes(shipped.id));
});

test("D — quotes with no answer", async () => {
  const W = await ws("d");
  const quiet = await buyer(W);
  const wroteBack = await buyer(W, { lastInboundAt: ago(2) });
  const mk = (n: number, leadId: string, status: string, sentAt?: string) =>
    repos.quote.create({ workspaceId: W, leadId, quoteNumber: n, status, lineItems: [{ id: `l${n}`, productName: "Zari", quantity: 10, unit: "kg", unitPrice: 12500, lineTotal: 125000 }], grandTotal: 125000, currencyCode: "INR", sentAt } as never);
  const noAnswer = await mk(1, quiet.id, "sent", ago(5));
  const answered = await mk(2, wroteBack.id, "sent", ago(5));
  const recent = await mk(3, quiet.id, "sent", ago(1));
  const draft = await mk(4, quiet.id, "draft");
  const list = await buildNeedsYouList(W, repos, { now: NOW });
  const q = list.items.filter((i) => i.bucket === "quote_waiting");
  assert.deepEqual(q.map((i) => i.quote?.id), [noAnswer.id]);
  assert.equal(q[0].amountInr, 125000, "the rupee amount must travel with the item (morning summary totals)");
  assert.ok(!q.some((i) => i.quote?.id === answered.id || i.quote?.id === recent.id));
  assert.ok(list.items.some((i) => i.bucket === "money" && i.quote?.id === draft.id), "a draft quote stays in the money group");
});

test("E — one list, one count; held replies only for the owner", async () => {
  const W = await ws("e");
  const lead = await buyer(W, { reviewStatus: "pending" });
  await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "hi", retrievedContext: {}, canAutoSend: false, needsHumanReview: true, status: "held_for_review" } as never);
  await repos.unknownQuestion.create(W, { leadId: lead.id, channel: "whatsapp", questionText: "Do you ship to Dubai?", status: "open", generatedBy: "whatsapp_unknown" } as never);
  await repos.unknownQuestion.create(W, { questionText: "What is your GST number?", channel: "knowledge", status: "open", generatedBy: "framework" } as never);
  const owner = await buildNeedsYouList(W, repos, { now: NOW });
  assert.equal(owner.count, owner.items.length, "the count is the list");
  assert.equal(Object.values(owner.counts).reduce((a, b) => a + b, 0), owner.count);
  assert.equal(owner.counts.flag, 1);
  assert.equal(owner.counts.question, 1, "a setup (framework) question is not an interruption");
  assert.equal(owner.setupBacklog, 1, "…but it is counted in the setup backlog");
  assert.equal(owner.counts.lead, 1);
  const member = await buildNeedsYouList(W, repos, { now: NOW, includeHeldReplies: false });
  assert.equal(member.counts.flag, 0, "held replies are listed only for the owner, who alone may send them");
  assert.equal(member.count, owner.count - 1);
});

test("F — company-scoped", async () => {
  const A = await ws("fa");
  const B = await ws("fb");
  await buyer(A, { lastInboundAt: "2026-09-29T05:30:00Z", reviewStatus: "pending" });
  const b = await buildNeedsYouList(B, repos, { now: NOW });
  assert.equal(b.count, 0, "company B saw company A's customers");
});

test("G — an automatic reply that went out is stamped as a reply", async () => {
  const src = readFileSync("src/services/WhatsAppConversationEngine.ts", "utf8");
  assert.match(src, /send\.status === "sent" \? \{ lastContactedAt: inboundStampedAt \}/, "the engine must stamp lastContactedAt when an automatic reply went out");
  assert.match(src, /alertOwnerOnComplaint\(/, "the engine must tell the owner about a complaint");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
