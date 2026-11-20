/**
 * golden-learning-loop.ts — 2026-09-28 (CEO overnight): the system learns from
 * what actually happens, safely. docs/LOGIC.md "LEARNING-LOOP".
 *
 *   A — the owner's mark on an automatic reply feeds the trial record, and a
 *       kind switched off starts a fresh trial from the switch-off.
 *   B — "should not have sent" switches that kind off (only that kind, only
 *       for that company), tells the owner why, and ticking it again is
 *       refused until a fresh trial; only automatic replies can be marked.
 *   C — a complaint or an opt-out within 7 days after an automatic reply of a
 *       ticked kind switches it off; an older automatic reply does not.
 *   D — outcome signals at the chokepoints: confirmed order (once per order),
 *       accepted quote, won / lost / opted out; company-scoped; erased with the
 *       customer.
 *   E — no reply in 14 days is recorded once per last message, not for a
 *       customer who answered.
 *   F — the weekly step proposes a pattern only above the threshold, never
 *       changes a setting, and runs once per 7 days.
 *   G — reorder / dormant reminders from order history: proposed with the
 *       history in plain words, once per cycle, upgraded to dormant at 2x the
 *       gap, never for do-not-contact, not with one order.
 *   H — "What the system learned this week" lists the switch-off, the
 *       proposals and the reorder suggestions; the daily routine runs the
 *       learning steps and reports them in the morning summary.
 *
 * Run: npm run golden:learning-loop
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, Order } from "@/lib/types";
import { NeedsActionError } from "@/lib/user-errors";
import { computeTrialRecords, markAutomaticReply, acknowledgePause } from "@/services/AutoReplyTrialService";
import { getWhatsAppSettings, updateWhatsAppSettings } from "@/services/AISettingsService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { recordNoReplyOutcomes } from "@/services/OutcomeSignalService";
import { runWeeklyOutcomeLearning, getLearnedThisWeek, MIN_OUTCOMES } from "@/services/OutcomeLearningService";
import { proposeReorderReminders } from "@/services/ReorderReminderService";
import { updateLeadDetails } from "@/services/LeadImportService";
import { runDailyRoutine } from "@/services/DailyRoutineService";
import { mutateData, readData } from "@/lib/db";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const DAY = 86_400_000;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

async function ws(tag: string) {
  const id = `ws_learn_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
let seq = 0;
async function buyer(W: string, extra: Record<string, unknown> = {}) {
  seq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Learn Buyer ${seq}`, contactName: "B", whatsappNumber: `9198800${String(seq).padStart(5, "0")}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", ...extra } as never);
}
const ago = (days: number, now = Date.now()) => new Date(now - days * DAY).toISOString();
function autoSent(W: string, leadId: string, topic: string, createdAt: string) {
  return repos.autoReplyLog.create(W, { leadId, channel: "whatsapp", incomingMessage: "hi", retrievedContext: {}, classification: topic, generatedReply: "Hello!", canAutoSend: true, needsHumanReview: false, status: "auto_sent", sendStatus: "sent", createdAt });
}
/** A company with greeting + catalogue ticked (written directly: the trial itself is pinned elsewhere). */
async function tickedCompany(tag: string, topics = ["greeting", "catalogue_request"]) {
  const W = await ws(tag);
  const s = await getWhatsAppSettings(W, repos);
  await repos.whatsAppAgentSettings.upsertForWorkspace(W, { ...s, enabled: true, mode: "safe_auto_reply", autoReplyTopics: topics });
  return W;
}
const settingsOf = async (W: string) => (await repos.whatsAppAgentSettings.getByWorkspace(W))!;

// ─── A ────────────────────────────────────────────────────────────────────
test("A — the owner's mark feeds the trial; a switch-off starts a fresh trial", async () => {
  const NOW = new Date("2026-09-28T10:00:00Z");
  const base = { workspaceId: "w", channel: "whatsapp", incomingMessage: "hi", retrievedContext: {}, canAutoSend: true, needsHumanReview: false, classification: "greeting", status: "auto_sent" as const, createdAt: ago(2, NOW.getTime()), updatedAt: ago(2, NOW.getTime()) };
  const logs: AutoReplyLog[] = [
    ...Array.from({ length: 9 }, (_, i) => ({ ...base, id: `f${i}`, ownerVerdict: "looked_fine" as const })),
    { ...base, id: "bad", ownerVerdict: "should_not_have_sent" as const },
  ];
  const r = computeTrialRecords(logs, NOW).find((x) => x.topic === "greeting")!;
  assert.equal(r.sentUnchanged, 9, "\"looked fine\" must count as sent unchanged");
  assert.equal(r.rejected, 1, "\"should not have sent\" must count against the kind");
  assert.equal(r.proven, true);
  const paused = computeTrialRecords(logs, NOW, [{ topic: "greeting", pausedAt: ago(1, NOW.getTime()), trigger: "owner_marked", reason: "x", evidenceLogIds: [] }]).find((x) => x.topic === "greeting")!;
  assert.equal(paused.reviewed, 0, "drafts from before the switch-off must not re-prove the kind");
});

// ─── B ────────────────────────────────────────────────────────────────────
test("B — \"should not have sent\" switches that kind off and says why", async () => {
  const W = await tickedCompany("b");
  const other = await tickedCompany("b2");
  const lead = await buyer(W);
  const log = await autoSent(W, lead.id, "greeting", ago(20));
  const held = await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "price?", retrievedContext: {}, classification: "price_request", status: "held_for_review", canAutoSend: false, needsHumanReview: true });
  await assert.rejects(() => markAutomaticReply(W, held.id, "should_not_have_sent", repos), NeedsActionError, "only automatic replies can be marked");
  await assert.rejects(() => markAutomaticReply(other, log.id, "should_not_have_sent", repos), NeedsActionError, "company B marked company A's reply");
  const { switchedOff } = await markAutomaticReply(W, log.id, "should_not_have_sent", repos);
  assert.equal(switchedOff.length, 1);
  const s = await settingsOf(W);
  assert.deepEqual(s.autoReplyTopics, ["catalogue_request"], "only the marked kind must be switched off");
  assert.match(s.autoReplyPaused?.[0]?.reason || "", /should not have sent/);
  assert.deepEqual((await settingsOf(other)).autoReplyTopics, ["greeting", "catalogue_request"], "another company's kinds must not change");
  const audit = (await readData()).auditLogs?.filter((l) => l.workspaceId === W && l.eventType === "auto_reply.kind_switched_off") || [];
  assert.equal(audit.length, 1, "the switch-off must be on the record");
  await assert.rejects(
    () => updateWhatsAppSettings(W, { enabled: true, mode: "safe_auto_reply", autoReplyTopics: ["greeting", "catalogue_request"] }, repos),
    /switched "greeting" off/,
    "ticking the kind again must be refused until a fresh trial",
  );
  assert.equal((await repos.autoReplyLog.getById(W, log.id))?.ownerVerdict, "should_not_have_sent");
  await acknowledgePause(W, "greeting", repos);
  assert.ok((await settingsOf(W)).autoReplyPaused?.[0]?.seenAt, "the owner's \"understood\" must be kept");
});

// ─── C ────────────────────────────────────────────────────────────────────
test("C — a complaint or opt-out within 7 days of an automatic reply switches the kind off", async () => {
  const W = await tickedCompany("c");
  const lead = await buyer(W);
  await autoSent(W, lead.id, "greeting", ago(2));
  await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber!, rawText: "The zari you sent is damaged, very poor quality" }, repos);
  const s = await settingsOf(W);
  assert.ok(!s.autoReplyTopics?.includes("greeting"), "a complaint 2 days after an automatic greeting must switch greetings off");
  assert.ok(s.autoReplyTopics?.includes("catalogue_request"), "a kind the customer never got must stay on");
  assert.equal(s.autoReplyPaused?.[0]?.trigger, "complaint");
  assert.equal((await repos.outcomeSignal.listByWorkspace(W, { kind: "complaint" })).length, 1, "the complaint must be recorded as a result");

  const W2 = await tickedCompany("c2");
  const optOut = await buyer(W2);
  await autoSent(W2, optOut.id, "catalogue_request", ago(3));
  await handleIncomingWhatsAppMessage({ workspaceId: W2, leadId: optOut.id, phone: optOut.whatsappNumber!, rawText: "Please remove my number" }, repos);
  assert.ok(!(await settingsOf(W2)).autoReplyTopics?.includes("catalogue_request"), "an opt-out after an automatic reply must switch that kind off");
  assert.equal((await repos.outcomeSignal.listByWorkspace(W2, { kind: "opted_out" })).length, 1);

  const W3 = await tickedCompany("c3");
  const old = await buyer(W3);
  await autoSent(W3, old.id, "greeting", ago(10));
  await handleIncomingWhatsAppMessage({ workspaceId: W3, leadId: old.id, phone: old.whatsappNumber!, rawText: "The zari you sent is damaged, very poor quality" }, repos);
  assert.ok((await settingsOf(W3)).autoReplyTopics?.includes("greeting"), "an automatic reply 10 days earlier must not switch the kind off");
});

// ─── D ────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: "POST" | "PUT", path: string[], body?: unknown): Promise<{ status: number; body: any }> {
  const mod = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/${path.join("/")}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const handler = (mod as unknown as Record<string, (r: never, c: unknown) => Promise<Response>>)[method];
  const response = await handler(request as never, { params: Promise.resolve({ path }) });
  return { status: response.status, body: await response.json() };
}

test("D — results are recorded where they happen, once, per company, and erased with the customer", async () => {
  const lead = await call("POST", ["leads", "manual"], { companyName: `Outcome buyer ${RUN}`, email: `outcome_${RUN}@example.test` });
  assert.equal(lead.status, 200, JSON.stringify(lead.body).slice(0, 200));
  const W = lead.body.workspaceId as string;
  const order = await call("POST", ["orders"], { leadId: lead.body.id, status: "confirmed", lineItems: [{ productName: `Zari learn ${RUN}`, quantity: 5, unitPrice: 100 }] });
  assert.equal(order.status, 200, JSON.stringify(order.body).slice(0, 200));
  assert.equal((await repos.outcomeSignal.listByWorkspace(W, { leadId: lead.body.id, kind: "order_placed" })).length, 1, "an order created confirmed must be recorded at once");
  assert.equal((await call("POST", ["orders", order.body.id, "status"], { toStatus: "in_progress" })).status, 200);
  const placed = await repos.outcomeSignal.listByWorkspace(W, { leadId: lead.body.id, kind: "order_placed" });
  assert.equal(placed.length, 1, "a confirmed order must be one \"order placed\", however often its status moves");
  assert.equal(placed[0].value, 500);
  const q = await call("POST", ["quotes"], { leadId: lead.body.id, lineItems: [{ productName: `Zari learn q ${RUN}`, quantity: 2, unitPrice: 300 }] });
  assert.equal((await call("POST", ["quotes", q.body.id, "status"], { toStatus: "sent" })).status, 200);
  assert.equal((await call("POST", ["quotes", q.body.id, "status"], { toStatus: "accepted" })).status, 200);
  assert.equal((await repos.outcomeSignal.listByWorkspace(W, { leadId: lead.body.id, kind: "quote_accepted" })).length, 1, "an accepted quote must be recorded");

  const L = await ws("d");
  const b = await buyer(L);
  await updateLeadDetails(L, b.id, { status: "won" } as never, repos);
  await updateLeadDetails(L, b.id, { fitReason: "still won" } as never, repos);
  const c = await buyer(L);
  await updateLeadDetails(L, c.id, { status: "lost" } as never, repos);
  const d = await buyer(L);
  await updateLeadDetails(L, d.id, { doNotContact: true, status: "do_not_contact" } as never, repos);
  const kinds = (await repos.outcomeSignal.listByWorkspace(L)).map((s) => s.kind).sort();
  assert.deepEqual(kinds, ["lead_lost", "lead_won", "opted_out"], "won / lost / opted out must each be recorded once, only on a change");
  assert.equal((await repos.outcomeSignal.listByWorkspace(`ws_learn_nobody_${RUN}`)).length, 0);
  assert.equal((await repos.outcomeSignal.listByWorkspace(W, { leadId: b.id })).length, 0, "a company must not see another company's results");

  const { eraseLeadCascade } = await import("@/services/ErasureCascade");
  await eraseLeadCascade({ workspaceId: L, leadId: b.id, data: await readData(), mutateData: mutateData as never } as never);
  assert.equal((await repos.outcomeSignal.listByWorkspace(L, { leadId: b.id })).length, 0, "the erased customer's results survived");
});

// ─── E ────────────────────────────────────────────────────────────────────
test("E — no reply in 14 days, once per last message", async () => {
  const W = await ws("e");
  const now = new Date();
  const quiet = await buyer(W, { lastContactedAt: ago(20) });
  await buyer(W, { lastContactedAt: ago(20), lastInboundAt: ago(18) });
  await buyer(W, { lastContactedAt: ago(5) });
  await buyer(W, { lastContactedAt: ago(30), doNotContact: true, status: "do_not_contact" });
  assert.equal(await recordNoReplyOutcomes(W, repos, now), 1);
  assert.equal(await recordNoReplyOutcomes(W, repos, now), 0, "the same silence must not be counted twice");
  const [signal] = await repos.outcomeSignal.listByWorkspace(W, { kind: "no_reply_14d" });
  assert.equal(signal.leadId, quiet.id);
  assert.equal(signal.at.slice(0, 10), new Date(Date.parse(quiet.lastContactedAt!) + 14 * DAY).toISOString().slice(0, 10), "dated 14 days after the message");
});

// ─── F ────────────────────────────────────────────────────────────────────
async function seedPattern(W: string, perSide: number, now: Date) {
  for (let i = 0; i < perSide; i++) {
    const good = await buyer(W);
    await autoSent(W, good.id, "catalogue_request", ago(5, now.getTime()));
    await repos.outcomeSignal.create(W, { leadId: good.id, kind: "order_placed", at: ago(2, now.getTime()), sourceId: `seed-o-${good.id}` });
    const bad = await buyer(W);
    await autoSent(W, bad.id, "greeting", ago(5, now.getTime()));
    await repos.outcomeSignal.create(W, { leadId: bad.id, kind: "no_reply_14d", at: ago(2, now.getTime()), sourceId: `seed-n-${bad.id}` });
  }
}

test("F — the weekly step proposes clear patterns only, and changes nothing", async () => {
  const now = new Date();
  const W = await tickedCompany("f");
  await seedPattern(W, MIN_OUTCOMES + 1, now);
  const before = JSON.stringify(await settingsOf(W));
  const run = await runWeeklyOutcomeLearning(W, repos, now);
  assert.equal(run.ran, true);
  assert.ok(run.proposed.length >= 1, "a clear pattern must become a proposal");
  const card = run.proposed.find((q) => /catalogue request/.test(q.questionText));
  assert.ok(card, `expected a card about catalogue requests, got ${run.proposed.map((q) => q.questionText).join(" | ")}`);
  assert.equal(card!.generatedBy, "learned_from_outcomes");
  assert.equal(card!.status, "open");
  assert.equal(card!.sourceIds?.length, MIN_OUTCOMES + 1, "the card must carry its evidence ids");
  assert.match(card!.suggestedAnswer || "", /6 of 6/);
  assert.equal(JSON.stringify(await settingsOf(W)), before, "learning must never change a setting by itself");
  const again = await runWeeklyOutcomeLearning(W, repos, new Date(now.getTime() + 2 * DAY));
  assert.equal(again.ran, false, "once per 7 days per company");
  const later = await runWeeklyOutcomeLearning(W, repos, new Date(now.getTime() + 8 * DAY));
  assert.equal(later.proposed.length, 0, "the same pattern must not be proposed again while its card is open");

  const small = await ws("f2");
  await seedPattern(small, MIN_OUTCOMES - 1, now);
  assert.equal((await runWeeklyOutcomeLearning(small, repos, now)).proposed.length, 0, "below the threshold nothing is proposed");
});

// ─── G ────────────────────────────────────────────────────────────────────
async function orderAt(W: string, leadId: string, daysAgo: number, now: Date): Promise<Order> {
  const when = ago(daysAgo, now.getTime());
  return repos.order.create({ workspaceId: W, leadId, status: "delivered", lineItems: [], grandTotal: 1000, currencyCode: "INR", origin: "direct", confirmedAt: when, createdAt: when } as never);
}

test("G — reorder and dormant reminders from order history", async () => {
  const W = await ws("g");
  const now = new Date();
  const regular = await buyer(W);
  for (const d of [150, 105, 60]) await orderAt(W, regular.id, d, now);
  const single = await buyer(W);
  await orderAt(W, single.id, 200, now);
  const optedOut = await buyer(W, { doNotContact: true, status: "do_not_contact" });
  for (const d of [150, 105, 60]) await orderAt(W, optedOut.id, d, now);
  const onTrack = await buyer(W);
  for (const d of [100, 55, 10]) await orderAt(W, onTrack.id, d, now);

  const first = await proposeReorderReminders(W, repos, now);
  assert.equal(first.proposed, 1, "only the overdue customer who may be contacted gets a proposal");
  const [p] = await repos.followUp.listByWorkspace(W, { leadId: regular.id });
  assert.equal(p.status, "proposed", "a reorder reminder is a proposal the owner keeps or dismisses");
  assert.equal(p.source, "ai_proposed");
  assert.equal(p.kind, "reorder");
  assert.match(p.evidence || "", /Orders every ~45 days \(3 orders\); last order 60 days ago/);
  assert.equal((await proposeReorderReminders(W, repos, now)).proposed, 0, "once per customer per cycle");

  const later = new Date(now.getTime() + 31 * DAY); // 91 days since the last order ≥ 2 × 45
  const second = await proposeReorderReminders(W, repos, later);
  assert.equal(second.upgraded, 1, "a waiting reorder proposal must become a dormant one");
  const all = await repos.followUp.listByWorkspace(W, { leadId: regular.id });
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "dormant");
  assert.equal((await proposeReorderReminders(W, repos, later)).proposed + (await proposeReorderReminders(W, repos, later)).upgraded, 0);

  await orderAt(W, regular.id, 0, later); // a new order starts a new cycle
  assert.equal((await proposeReorderReminders(W, repos, later)).proposed, 0, "a customer who just ordered is on track");
});

// ─── H ────────────────────────────────────────────────────────────────────
test("H — the weekly card and the daily routine", async () => {
  const W = await tickedCompany("h");
  const lead = await buyer(W);
  const log = await autoSent(W, lead.id, "greeting", ago(1));
  await markAutomaticReply(W, log.id, "should_not_have_sent", repos);
  const now = new Date();
  const regular = await buyer(W);
  for (const d of [150, 105, 60]) await orderAt(W, regular.id, d, now);

  const reports = await runDailyRoutine(repos, {
    discover: async () => [{ workspaceId: W, campaignsRun: 0, candidatesDiscovered: 0, leadsCreated: 0, leadsUpdated: 0, draftsGenerated: 0, errors: [], warnings: [] } as never],
    score: async () => ({ aiScored: 0, stillWaiting: 0 }),
    autoApprove: async () => ({ approvedCount: 0, errors: [] }),
  });
  const report = reports.find((r) => r.workspaceId === W)!;
  assert.equal(report.learning?.reorderProposed, 1, "the daily routine must propose the reorder");
  assert.equal(report.learning?.learningRan, true, "the weekly step must run inside the daily routine");
  const digest = (await readData()).auditLogs?.find((l) => l.workspaceId === W && l.eventType === "digest_sent");
  assert.equal((digest?.payload as Record<string, unknown>)?.reorderProposed, 1, "the morning summary must show it");

  const week = await getLearnedThisWeek(W, repos);
  assert.equal(week.switchedOff.length, 1, "the switch-off must be in the weekly card");
  assert.equal(week.reorders.length, 1);
  assert.match(week.reorders[0].evidence || "", /Orders every ~45 days/);
  const other = await getLearnedThisWeek(await ws("h2"), repos);
  assert.equal(other.switchedOff.length + other.reorders.length + other.proposals.length, 0, "another company sees none of it");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
