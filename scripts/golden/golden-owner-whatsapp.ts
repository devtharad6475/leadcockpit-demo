/**
 * golden-owner-whatsapp.ts — 2026-09-28: the morning summary and urgent alerts
 * go to the OWNER's own WhatsApp — never to a customer, never pretending.
 * Rules: docs/LOGIC.md OWNER-WHATSAPP; decision D-2026-09-28-a (proposed).
 * The WhatsApp provider is a stub: nothing reaches Meta.
 *
 *   A — the owner's number: checked, written +91… by default, bad ones refused.
 *   B — settings: off by default; switching on needs a number; a customer's
 *       number is refused.
 *   C — the summary text: at most 8 lines, ₹ totals, zero lines left out.
 *   D — sending the summary: off / no approved template / not connected all
 *       stay in the app and SAY so (no send); connected + approved template
 *       sends once, as a template with a one-line variable; every attempt is
 *       recorded; a second run the same day sends nothing.
 *   E — alerts: quiet hours hold; the same alert never twice; the daily limit
 *       holds the rest; held alerts roll into the next summary.
 *   F — never to a customer: a customer added later with the owner's number
 *       blocks the send.
 *   G — complaint / big order / waiting customer / urgent ticket alerts.
 *   H — the daily routine sends the summary after the night's work.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-owner-whatsapp.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { WhatsAppSendProvider, WhatsAppTemplateSendInput } from "@/providers/whatsapp/WhatsAppSendProvider";
import { NeedsActionError } from "@/lib/user-errors";
import { isOwnerQuietHours, normalizeOwnerWhatsappNumber } from "@/lib/owner-notify";
import {
  alertOwnerOnBigAmount, alertOwnerOnComplaint, checkTimedOwnerAlerts, raiseOwnerAlert, renderOwnerMorningSummary,
  saveOwnerNotifySettings, sendOwnerMorningSummary, OWNER_MESSAGE_EVENT,
} from "@/services/OwnerNotifyService";
import { runDailyRoutine } from "@/services/DailyRoutineService";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

const DAYTIME = new Date("2026-09-29T09:30:00Z"); // Tue 15:00 IST
const NIGHT = new Date("2026-09-29T17:00:00Z");   // Tue 22:30 IST
const OWNER = "+919812345678";

function stub(configured = true) {
  const calls: WhatsAppTemplateSendInput[] = [];
  const texts: unknown[] = [];
  const provider: WhatsAppSendProvider = {
    isConfigured: () => configured,
    sendTextMessage: async (input) => { texts.push(input); return { attempted: true, status: "sent", provider: "meta_cloud" }; },
    sendTemplateMessage: async (input) => { calls.push(input); return { attempted: true, status: "sent", provider: "meta_cloud", providerMessageId: `wamid.${calls.length}` }; },
    testConnection: async () => ({ ok: configured, status: configured ? "connected" : "not_configured", message: "" }),
  };
  return { provider, calls, texts, deps: (now = DAYTIME) => ({ resolveProvider: async () => provider, now: () => now }) };
}

async function ws(tag: string) {
  const id = `ws_owner_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
let seq = 0;
async function buyer(W: string, extra: Record<string, unknown> = {}) {
  seq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Buyer ${seq}`, contactName: "B", whatsappNumber: `9197711${String(seq).padStart(5, "0")}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", ...extra } as never);
}
async function approvedTemplate(W: string, name = "owner_update") {
  return repos.whatsAppTemplate.create(W, { name, language: "en", category: "UTILITY", status: "approved", body: "Your LeadCockpit update: {{1}}" });
}
async function records(W: string) {
  return (await repos.auditLog.listByWorkspace(W)).filter((l) => l.eventType === OWNER_MESSAGE_EVENT);
}
async function setUp(tag: string, settings: Record<string, unknown>) {
  const W = await ws(tag);
  const t = await approvedTemplate(W);
  await saveOwnerNotifySettings(W, { ownerWhatsappNumber: "98123 45678", summaryTemplateId: t.id, alertTemplateId: t.id, ...settings }, "owner", repos);
  return W;
}

test("A — the owner's number", async () => {
  const ok = (raw: string) => { const r = normalizeOwnerWhatsappNumber(raw); return r.ok ? r.number : undefined; };
  assert.equal(ok("98123 45678"), OWNER, "no country code → Indian (+91)");
  assert.equal(ok("098123-45678"), OWNER);
  assert.equal(ok("+91 98123 45678"), OWNER);
  assert.equal(ok("919812345678"), OWNER);
  assert.equal(ok("+44 20 7946 0958"), "+442079460958", "another country keeps its code");
  for (const bad of ["", "12345", "+91 12345 67890", "98123 4567", "call me", "+1"]) {
    assert.equal(ok(bad), undefined, `"${bad}" must be refused`);
  }
  assert.equal(isOwnerQuietHours(NIGHT), true, "22:30 IST is quiet");
  assert.equal(isOwnerQuietHours(DAYTIME), false);
  assert.equal(isOwnerQuietHours(new Date("2026-09-29T02:00:00Z")), true, "07:30 IST is quiet");
});

test("B — settings", async () => {
  const W = await ws("b");
  const s = stub();
  const off = await sendOwnerMorningSummary(W, {}, repos, s.deps());
  assert.equal(off.status, "off", "everything is off by default");
  assert.equal(s.calls.length, 0);
  await assert.rejects(() => saveOwnerNotifySettings(W, { morningSummary: true }, "owner", repos), NeedsActionError, "switching on without a number must be refused");
  await assert.rejects(() => saveOwnerNotifySettings(W, { ownerWhatsappNumber: "12345", morningSummary: true }, "owner", repos), NeedsActionError);
  const customer = await buyer(W);
  await assert.rejects(() => saveOwnerNotifySettings(W, { ownerWhatsappNumber: customer.whatsappNumber, morningSummary: true }, "owner", repos), NeedsActionError, "a customer's number must be refused");
  await saveOwnerNotifySettings(W, { ownerWhatsappNumber: "98123 45678", morningSummary: true, maxAlertsPerDay: 3 }, "owner", repos);
  const saved = await repos.workspace.getById(W);
  assert.equal(saved?.ownerWhatsappNumber, OWNER, "the number is saved in one checked form");
  await assert.rejects(() => saveOwnerNotifySettings(W, { maxAlertsPerDay: 99 }, "owner", repos), NeedsActionError);
  await assert.rejects(() => saveOwnerNotifySettings(W, { bigAmountInr: -5 }, "owner", repos), NeedsActionError);
});

test("C — the summary text", async () => {
  const items = [
    { bucket: "quote_waiting", amountInr: 125000 }, { bucket: "quote_waiting", amountInr: 75000 },
    { bucket: "order", amountInr: 80000 }, { bucket: "customer_waiting" }, { bucket: "ticket" },
  ] as never;
  const counts = { customer_waiting: 1, ticket: 1, question: 0, money: 0, flag: 0, order: 1, quote_waiting: 2, reminder: 0, festival: 0, lead: 0 };
  const text = renderOwnerMorningSummary({ list: { count: 5, counts, items }, newBuyers: 4, remindersDue: 3, heldAlerts: 2, link: "https://app.example.in", day: "2026-09-29" });
  const lines = text.split("\n");
  assert.ok(lines.length <= 8, `at most 8 lines, got ${lines.length}`);
  assert.match(lines[0], /5 things need you/);
  assert.match(lines[0], /2 alerts waited for the morning/);
  assert.ok(lines.includes("Quotes with no answer: 2 (₹2,00,000)"), text);
  assert.ok(lines.includes("Orders to ship: 1 (₹80,000)"), text);
  assert.ok(lines.includes("Customers waiting for a reply: 1"));
  assert.ok(lines.includes("Tickets late or due today: 1"));
  assert.ok(lines.includes("Reminders due today: 3"));
  assert.ok(lines.includes("New buyers found: 4"));
  assert.equal(lines[lines.length - 1], "Open: https://app.example.in");
  const quiet = renderOwnerMorningSummary({ list: { count: 0, counts: { ...counts, customer_waiting: 0, ticket: 0, order: 0, quote_waiting: 0 }, items: [] as never }, newBuyers: 0, remindersDue: 0, heldAlerts: 0, day: "2026-09-29" });
  assert.equal(quiet.split("\n").length, 2, "nothing to say → two lines, no zero lines");
  assert.match(quiet, /Nothing needs you/);
});

test("D — sending the summary", async () => {
  // Switched on, but the template is not approved yet → stays in the app.
  const W1 = await ws("d1");
  const pending = await repos.whatsAppTemplate.create(W1, { name: "owner_update", language: "en", status: "pending", body: "{{1}}" });
  await saveOwnerNotifySettings(W1, { ownerWhatsappNumber: OWNER, morningSummary: true, summaryTemplateId: pending.id }, "owner", repos);
  const s1 = stub();
  const r1 = await sendOwnerMorningSummary(W1, {}, repos, s1.deps());
  assert.equal(r1.status, "needs_template");
  assert.equal(s1.calls.length + s1.texts.length, 0, "no approved template → nothing may be sent");
  assert.match((await records(W1))[0].payload.reason as string, /template/i, "the record must say why it stayed in the app");

  // Approved template, WhatsApp not connected → stays in the app.
  const W2 = await setUp("d2", { morningSummary: true });
  const s2 = stub(false);
  assert.equal((await sendOwnerMorningSummary(W2, {}, repos, s2.deps())).status, "not_connected");
  assert.equal(s2.calls.length, 0);

  // Connected + approved → sent once, to the owner, as a template.
  const W3 = await setUp("d3", { morningSummary: true });
  await buyer(W3, { lastInboundAt: "2026-09-29T05:30:00Z" });
  // 2026-09-28 — "New buyers found" is counted with the "Today's new buyers"
  // rule (NewBuyersTodayService): three AI-scored, reachable, uncontacted
  // prospects found today.
  for (let i = 0; i < 3; i++) {
    const found = await buyer(W3, { source: "serpapi_google_maps", status: "discovered", reviewStatus: "pending", leadScore: 15, qualificationStatus: "mql", scoreReason: { scoresFrom: "model", mode: "real" } });
    await repos.lead.updateLead(W3, found.id, { createdAt: "2026-09-29T04:00:00Z" });
  }
  const s3 = stub();
  const r3 = await sendOwnerMorningSummary(W3, {}, repos, s3.deps());
  assert.equal(r3.status, "sent");
  assert.equal(s3.calls.length, 1);
  assert.equal(s3.texts.length, 0, "never free text — Meta allows only a template outside 24 hours");
  assert.equal(s3.calls[0].to, OWNER, "only to the owner's own number");
  assert.equal(s3.calls[0].templateName, "owner_update");
  const variable = s3.calls[0].components?.[0].parameters[0].text || "";
  assert.ok(!/\n/.test(variable), "Meta refuses a line break inside a template variable");
  assert.match(variable, /Customers waiting for a reply: 1/);
  assert.match(variable, /New buyers found: 3/);
  const recs = await records(W3);
  assert.equal(recs.length, 1, "every send is recorded");
  assert.equal(recs[0].payload.status, "sent");
  assert.ok(!String(recs[0].payload.to).includes("12345678"), "the record masks the number");
  const again = await sendOwnerMorningSummary(W3, {}, repos, s3.deps());
  assert.equal(again.status, "duplicate");
  assert.equal(s3.calls.length, 1, "a second run the same day must not send a second summary");
});

test("E — quiet hours, once only, daily limit, roll into the summary", async () => {
  const W = await setUp("e", { urgentAlerts: true, morningSummary: true, maxAlertsPerDay: 2 });
  const s = stub();
  const night = await raiseOwnerAlert(W, { kind: "complaint", key: "k-night", text: "night" }, repos, s.deps(NIGHT));
  assert.equal(night.status, "held_quiet_hours");
  assert.equal(s.calls.length, 0, "nothing between 21:00 and 08:00 IST");
  assert.equal((await raiseOwnerAlert(W, { kind: "complaint", key: "k1", text: "one" }, repos, s.deps())).status, "sent");
  assert.equal((await raiseOwnerAlert(W, { kind: "complaint", key: "k1", text: "one" }, repos, s.deps())).status, "duplicate", "the same alert twice");
  assert.equal((await raiseOwnerAlert(W, { kind: "complaint", key: "k2", text: "two" }, repos, s.deps())).status, "sent");
  assert.equal((await raiseOwnerAlert(W, { kind: "complaint", key: "k3", text: "three" }, repos, s.deps())).status, "held_daily_limit");
  assert.equal(s.calls.length, 2, "at most 2 alerts today");
  const summary = await sendOwnerMorningSummary(W, {}, repos, s.deps(new Date("2026-09-30T03:30:00Z")));
  assert.match(summary.text, /2 alerts waited for the morning/, "held alerts roll into the next summary");
});

test("F — never to a customer", async () => {
  const W = await setUp("f", { urgentAlerts: true });
  await buyer(W, { whatsappNumber: "+91 98123 45678" }); // a customer later saved with the owner's number
  const s = stub();
  const r = await raiseOwnerAlert(W, { kind: "complaint", key: "f1", text: "x" }, repos, s.deps());
  assert.equal(r.status, "blocked_customer_number");
  assert.equal(s.calls.length, 0, "a message meant for the owner must never reach a customer's number");
});

test("G — complaint, big order, waiting customer, urgent ticket", async () => {
  const W = await setUp("g", { urgentAlerts: true, bigAmountInr: 100000, maxAlertsPerDay: 20 });
  const s = stub();
  const c = await alertOwnerOnComplaint(W, { replyId: "rep1", category: "complaint", leadName: "Shree Sarees", text: "The zari colour is wrong,\nvery bad" }, repos, s.deps());
  assert.equal(c?.status, "sent");
  assert.match(c!.text, /A complaint from Shree Sarees/);
  assert.match(c!.text, /Nothing was sent back/, "an alert only informs");
  assert.equal(await alertOwnerOnComplaint(W, { replyId: "rep2", category: "price_request", text: "rate?" }, repos, s.deps()), undefined, "a price question is not an alert");

  await repos.workspace.update(W, { ownerUserId: "user_owner_g" });
  assert.equal(await alertOwnerOnBigAmount(W, { kind: "order", id: "o1", total: 99999 }, repos, s.deps()), undefined, "below the amount → no alert");
  assert.equal(await alertOwnerOnBigAmount(W, { kind: "order", id: "o2", total: 500000, currencyCode: "USD" }, repos, s.deps()), undefined, "the ₹ amount is not compared with dollars");
  assert.equal(await alertOwnerOnBigAmount(W, { kind: "quote", id: "q1", total: 250000, actorUserId: "user_owner_g" }, repos, s.deps()), undefined, "the owner made it — they already know");
  const big = await alertOwnerOnBigAmount(W, { kind: "order", id: "o3", number: 42, total: 250000, actorUserId: "user_staff" }, repos, s.deps());
  assert.equal(big?.status, "sent");
  assert.match(big!.text, /order #42 of ₹2,50,000/);

  await buyer(W, { companyName: "Waiting Co", lastInboundAt: "2026-09-29T05:30:00Z" });
  const base = { workspaceId: W, type: "complaint", subject: "Damaged roll", description: "x", sourceChannel: "whatsapp", sourceEntityType: "manual", slaStartedAt: "2026-09-29T06:00:00Z", slaBreached: false, status: "open" };
  await repos.ticket.create({ ...base, ticketNumber: 7, priority: "urgent", slaDueAt: "2026-09-29T09:50:00Z" } as never); // 20 min away
  await repos.ticket.create({ ...base, ticketNumber: 8, priority: "urgent", slaDueAt: "2026-09-29T11:30:00Z" } as never); // 2 h away
  await repos.ticket.create({ ...base, ticketNumber: 9, priority: "high", slaDueAt: "2026-09-29T09:40:00Z" } as never);   // not urgent
  const timed = await checkTimedOwnerAlerts(W, repos, s.deps());
  const texts = timed.filter((r) => r.status === "sent").map((r) => r.text);
  assert.ok(texts.some((t) => /Waiting Co has waited over 2 working hours/.test(t)), texts.join(" / "));
  assert.ok(texts.some((t) => /Urgent ticket #7 is due in 20 minutes/.test(t)), texts.join(" / "));
  assert.ok(!texts.some((t) => /#8|#9/.test(t)), "only an URGENT ticket, only 30 minutes before");
  const second = await checkTimedOwnerAlerts(W, repos, s.deps());
  assert.ok(second.every((r) => r.status === "duplicate"), "the next check must not repeat them");
});

test("H — the daily routine sends the summary after the night's work", async () => {
  const W = await setUp("h", { morningSummary: true });
  // The night's search created 5 leads, but only 2 are AI-scored good,
  // reachable and uncontacted — the summary says 2 (the "Today's new buyers" rule).
  for (const score of [16, 12, 6]) {
    const found = await buyer(W, { status: "discovered", reviewStatus: "pending", leadScore: score, scoreReason: { scoresFrom: "model", mode: "real" } });
    await repos.lead.updateLead(W, found.id, { createdAt: "2026-09-29T04:00:00Z" });
  }
  const s = stub();
  const order: string[] = [];
  const [report] = await runDailyRoutine(repos, {
    discover: async () => [{ workspaceId: W, campaignsRun: 1, candidatesDiscovered: 3, leadsCreated: 5, leadsUpdated: 0, draftsGenerated: 0, errors: [], warnings: [] } as never],
    score: async () => { order.push("score"); return { aiScored: 1, stillWaiting: 0 }; },
    autoApprove: async () => { order.push("approve"); return { approvedCount: 0, errors: [] }; },
    followUpsDue: async () => { order.push("reminders"); return 1; },
    ownerSummary: async (r, id, input) => { order.push("summary"); return sendOwnerMorningSummary(id, input, r, s.deps()); },
    ownerAlerts: async () => { order.push("alerts"); return []; },
  });
  assert.deepEqual(order.slice(0, 4), ["score", "approve", "reminders", "summary"], "the summary must come after the night's work");
  assert.equal(report.ownerSummary?.status, "sent");
  assert.match(s.calls[0].components?.[0].parameters[0].text || "", /New buyers found: 2/);
  const digest = (await repos.auditLog.listByWorkspace(W)).find((l) => l.eventType === "digest_sent");
  assert.equal(typeof digest?.payload.needsYouCount, "number", "the in-app summary carries the same Needs-you count");
  assert.match(String(digest?.payload.ownerMessage), /Good morning/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).stack}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
