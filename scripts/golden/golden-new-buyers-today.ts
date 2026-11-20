/**
 * golden-new-buyers-today.ts — 2026-09-28: "Today's new buyers" (feature book #10).
 * Rules: docs/LOGIC.md TODAY'S-NEW-BUYERS. Service: src/services/NewBuyersTodayService.ts.
 *
 *   A — only new since yesterday (IST): found the day before yesterday is out;
 *       found yesterday evening IST (still "yesterday" though the UTC date differs) is in.
 *   B — unreachable, do-not-contact (flag, status, permanent register),
 *       rejected, duplicate, already contacted, already talking: all out.
 *   C — AI-only score: a low AI score is out; a high number NOT from the AI is out.
 *   D — company-scoped: another company's buyers never appear.
 *   E — cap + ordering: best score first, then fit; at most 10; count keeps the full total.
 *   F — the morning summary's "New buyers found" equals this list's count
 *       (and the list length when under the cap).
 *   G — reading the list sends nothing to anyone.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-new-buyers-today.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";
import { listNewBuyersToday, NEW_BUYERS_CAP } from "@/services/NewBuyersTodayService";
import { renderOwnerMorningSummary, sendOwnerMorningSummary } from "@/services/OwnerNotifyService";
import { registerDoNotContact } from "@/lib/dnc-registry";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// Tue 2026-09-29 08:00 IST. "Since yesterday" = found on 2026-09-28 or 2026-09-29 IST.
const NOW = new Date("2026-09-29T02:30:00Z");
const TODAY_EARLY = "2026-09-29T00:30:00Z";      // 06:00 IST today
const YESTERDAY_EVENING = "2026-09-28T17:00:00Z"; // 22:30 IST yesterday
const LATE_NIGHT_BEFORE = "2026-09-27T18:00:00Z"; // 23:30 IST on 09-27 — the day before yesterday
const AI = { scoresFrom: "model", mode: "real" };

async function ws(tag: string) {
  const id = `ws_newbuyers_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
let seq = 0;
async function prospect(W: string, extra: Partial<Lead> & { createdAt?: string } = {}): Promise<Lead> {
  seq++;
  const { createdAt = TODAY_EARLY, ...rest } = extra;
  const lead = await repos.lead.createLead({
    workspaceId: W, companyName: `Prospect ${seq}`, contactName: "P",
    whatsappNumber: `9198800${String(seq).padStart(5, "0")}`, source: "serpapi_google_maps",
    status: "discovered", reviewStatus: "pending", enrichmentStatus: "not_started", doNotContact: false, consentStatus: "none",
    leadScore: 15, fitScore: 4, qualificationStatus: "mql", scoreReason: AI,
    fitReason: "Makes zari borders for sarees in Surat.",
    ...rest,
  } as never);
  return repos.lead.updateLead(W, lead.id, { createdAt });
}
const names = async (W: string) => (await listNewBuyersToday(W, repos, { now: NOW })).items.map((i) => i.name);

test("A — only new since yesterday", async () => {
  const W = await ws("a");
  await prospect(W, { companyName: "Today Co" });
  await prospect(W, { companyName: "Yesterday Evening Co", createdAt: YESTERDAY_EVENING });
  await prospect(W, { companyName: "Old Co", createdAt: LATE_NIGHT_BEFORE });
  const list = await names(W);
  assert.ok(list.includes("Today Co"));
  assert.ok(list.includes("Yesterday Evening Co"), "22:30 IST yesterday is yesterday in IST");
  assert.ok(!list.includes("Old Co"), "found the day before yesterday is not new");
  const one = (await listNewBuyersToday(W, repos, { now: NOW })).items.find((i) => i.name === "Today Co")!;
  assert.equal(one.reason, "Scored 15/20 — makes zari borders for sarees in Surat; has WhatsApp", one.reason);
  assert.equal(one.awaitingReview, true);
});

test("B — unreachable, do-not-contact, rejected, duplicate, contacted: all out", async () => {
  const W = await ws("b");
  await prospect(W, { companyName: "Good Co" });
  await prospect(W, { companyName: "Email Only Co", whatsappNumber: undefined, email: "buy@emailonly.in" });
  await prospect(W, { companyName: "No Way To Reach", whatsappNumber: undefined, email: undefined, phone: undefined });
  await prospect(W, { companyName: "Bad Email Co", whatsappNumber: undefined, email: "not-an-email" });
  await prospect(W, { companyName: "DNC Flag Co", doNotContact: true });
  await prospect(W, { companyName: "DNC Status Co", status: "do_not_contact" });
  const registered = await prospect(W, { companyName: "DNC Register Co" });
  await registerDoNotContact(W, { phone: registered.whatsappNumber, reason: "asked to stop" }, repos);
  await prospect(W, { companyName: "Rejected Co", reviewStatus: "rejected" });
  await prospect(W, { companyName: "Duplicate Co", status: "duplicate" });
  await prospect(W, { companyName: "Invalid Co", status: "invalid" });
  await prospect(W, { companyName: "Contacted Co", lastContactedAt: TODAY_EARLY });
  await prospect(W, { companyName: "Contacted Status Co", status: "contacted" });
  await prospect(W, { companyName: "Talking Co", lastInboundAt: TODAY_EARLY });
  await prospect(W, { companyName: "Approved Co", reviewStatus: "approved", status: "approved" });
  const list = await names(W);
  assert.deepEqual([...list].sort(), ["Approved Co", "Email Only Co", "Good Co"].sort(), list.join(", "));
  const approved = (await listNewBuyersToday(W, repos, { now: NOW })).items.find((i) => i.name === "Approved Co")!;
  assert.equal(approved.awaitingReview, false, "an approved buyer is shown without Approve / Not a fit");
});

test("C — AI-only score: low is out, non-AI is out", async () => {
  const W = await ws("c");
  await prospect(W, { companyName: "Good Co", leadScore: 11 });
  await prospect(W, { companyName: "Low Co", leadScore: 10 });
  await prospect(W, { companyName: "Rules Co", leadScore: 19, scoreReason: { scoresFrom: "rules", mode: "real" } });
  await prospect(W, { companyName: "Sample Co", leadScore: 19, scoreReason: { scoresFrom: "model", mode: "mock" } });
  await prospect(W, { companyName: "Waiting Co", leadScore: 19, qualificationStatus: "not_scored" });
  assert.deepEqual(await names(W), ["Good Co"]);
});

test("D — company-scoped", async () => {
  const W1 = await ws("d1");
  const W2 = await ws("d2");
  await prospect(W1, { companyName: "Mine Co" });
  await prospect(W2, { companyName: "Theirs Co" });
  assert.deepEqual(await names(W1), ["Mine Co"]);
  assert.deepEqual(await names(W2), ["Theirs Co"]);
});

test("E — cap and ordering", async () => {
  const W = await ws("e");
  for (let i = 0; i < 12; i++) await prospect(W, { companyName: `Score ${11 + (i % 8)} #${i}`, leadScore: 11 + (i % 8), fitScore: 2 });
  await prospect(W, { companyName: "Top Fit", leadScore: 20, fitScore: 5 });
  await prospect(W, { companyName: "Top Less Fit", leadScore: 20, fitScore: 3 });
  const result = await listNewBuyersToday(W, repos, { now: NOW });
  assert.equal(result.count, 14, "count keeps every qualifying buyer");
  assert.equal(result.items.length, NEW_BUYERS_CAP, "at most 10 shown");
  assert.equal(result.items[0].name, "Top Fit", "best score first, then fit");
  assert.equal(result.items[1].name, "Top Less Fit");
  for (let i = 1; i < result.items.length; i++) assert.ok(result.items[i - 1].score >= result.items[i].score, "best first");
});

test("F — the morning summary counts the same buyers", async () => {
  const W = await ws("f");
  await prospect(W, { companyName: "One" });
  await prospect(W, { companyName: "Two", leadScore: 18 });
  await prospect(W, { companyName: "Too Low", leadScore: 5 });
  await prospect(W, { companyName: "Unreachable", whatsappNumber: undefined });
  const list = await listNewBuyersToday(W, repos, { now: NOW });
  assert.equal(list.items.length, 2);
  const summary = await sendOwnerMorningSummary(W, {}, repos, { now: () => NOW });
  assert.equal(summary.newBuyers, list.count, "the summary's number is this list's count");
  assert.equal(summary.newBuyers, list.items.length, "under the cap, that is the list length");
  assert.match(summary.text, /New buyers found: 2/, summary.text);
  const quiet = renderOwnerMorningSummary({ list: { count: 0, counts: { customer_waiting: 0, ticket: 0, question: 0, money: 0, flag: 0, order: 0, quote_waiting: 0, reminder: 0, festival: 0, lead: 0 }, items: [] }, newBuyers: 0, remindersDue: 0, heldAlerts: 0, day: "2026-09-29" });
  assert.ok(!/New buyers/.test(quiet), "no zero line");
});

test("G — reading the list sends nothing", async () => {
  const W = await ws("g");
  await prospect(W, { companyName: "Quiet Co" });
  const before = (await repos.auditLog.listByWorkspace(W)).length;
  await listNewBuyersToday(W, repos, { now: NOW });
  const leads = await repos.lead.listLeads(W);
  assert.ok(leads.every((l) => !l.lastContactedAt), "nobody was contacted");
  assert.equal((await repos.auditLog.listByWorkspace(W)).length, before, "no send or change recorded");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
