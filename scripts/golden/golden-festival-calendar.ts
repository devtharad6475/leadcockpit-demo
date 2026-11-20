/**
 * golden-festival-calendar.ts — 2026-09-30, CEO-approved festival plan
 * (docs/planning/FESTIVAL-CALENDAR-PLAN.md; rules docs/LOGIC.md FESTIVAL-CALENDAR).
 *
 *   A — reading Google's calendar file: festivals named, folded lines,
 *       "(tentative)" flagged, unknown days and repeats dropped.
 *   B — the owner's rules are checked (known festival, 0–10 days).
 *   C — rules → closed days: days before/after, half day closes nothing, no
 *       date for a year gives nothing, hand-added days are kept and win,
 *       an older rule's days are replaced.
 *   D — saving rules stores them and the closed days; the reply-deadline
 *       clock stops on them; saving the ticket clock afterwards keeps the rules.
 *   E — the calendar cannot be read: the last good copy, else the built-in list.
 *   F — "festival coming": customers who ordered before it last year, 7–28
 *       days ahead, never a do-not-contact customer; "remind me" sets one
 *       reminder each two weeks before and sends nothing; the card then goes;
 *       "not this year" also closes it.
 *   G — the morning routine refreshes the festival days.
 *   H — a held reply or draft quote that names a closed day gets a red chip
 *       in Needs you; dates are read only when unambiguous.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-festival-calendar.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { NeedsActionError } from "@/lib/user-errors";
import { todayIstIsoDate } from "@/lib/time";
import { computeSla, defaultTicketSlaSettings } from "@/lib/ticket-sla";
import {
  cleanFestivalRules, closedDaysFromRules, mergeRuleClosedDays, parseFestivalCalendar,
} from "@/lib/festival-calendar";
import {
  getFestivalCalendar, getFestivalView, saveFestivalRules, setFestivalCalendarReaderForTests,
} from "@/services/FestivalCalendarService";
import { festivalPrompts, remindForFestival, skipFestival } from "@/services/FestivalSeasonService";
import { buildNeedsYouList } from "@/services/NeedsYouService";
import { runDailyRoutine } from "@/services/DailyRoutineService";
import { closedDayMentions, datesNamedIn } from "@/lib/closed-day-mentions";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

const DAY = 86_400_000;
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const compact = (iso: string) => iso.replace(/-/g, "");
function ics(events: Array<[string, string]>): string {
  const body = events.map(([date, name]) => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${compact(date)}\r\nSUMMARY:${name}\r\nEND:VEVENT`).join("\r\n");
  return `BEGIN:VCALENDAR\r\n${body}\r\nEND:VCALENDAR\r\n`;
}
/** A calendar with enough days to count as real (the reader rejects an almost-empty file). */
function fullCalendar(extra: Array<[string, string]>): string {
  const filler: Array<[string, string]> = [];
  for (let y = 2025; y <= 2028; y++) {
    for (const [md, name] of [["01-26", "Republic Day"], ["08-15", "Independence Day"], ["10-02", "Mahatma Gandhi Jayanti"], ["12-25", "Christmas"], ["01-14", "Makar Sankranti"], ["04-03", "Good Friday"]]) filler.push([`${y}-${md}`, name]);
  }
  return ics([...filler, ...extra]);
}

async function ws(tag: string) {
  const id = `ws_fest_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}

test("A — reading Google's calendar file", async () => {
  const file = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261108\r\nSUMMARY:Diwali/Dee\r\n pavali\r\nEND:VEVENT\r\n"
    + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20270310\r\nSUMMARY:Ramzan Id (tentative)\r\nEND:VEVENT\r\n"
    + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261108\r\nSUMMARY:Diwali/Deepavali\r\nEND:VEVENT\r\n"
    + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260904\r\nSUMMARY:Janmashtami (Smarta)\r\nEND:VEVENT\r\n"
    + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260216\r\nSUMMARY:Some Local Observance\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const days = parseFestivalCalendar(file);
  assert.deepEqual(days.map((d) => [d.key, d.date, d.tentative]), [["diwali", "2026-11-08", false], ["eid_ul_fitr", "2027-03-10", true]],
    "a folded name is read, a repeat is kept once, tentative is flagged, unknown days and the Smarta duplicate are dropped");
});

test("B — the owner's rules are checked", async () => {
  assert.ok("problem" in cleanFestivalRules("x"));
  assert.ok("problem" in cleanFestivalRules([{ key: "not_a_festival", closed: true }]));
  assert.ok("problem" in cleanFestivalRules([{ key: "diwali", closed: true, daysBefore: 11 }]));
  assert.ok("problem" in cleanFestivalRules([{ key: "diwali", closed: true, daysAfter: 1.5 }]));
  const ok = cleanFestivalRules([{ key: "holi", closed: true, daysBefore: 0, daysAfter: 1 }, { key: "diwali", closed: true, daysBefore: 2, daysAfter: 3 }]);
  assert.ok("rules" in ok && ok.rules.length === 2);
});

test("C — rules become closed days", async () => {
  const days = parseFestivalCalendar(ics([["2026-11-08", "Diwali/Deepavali"], ["2027-10-29", "Diwali/Deepavali"], ["2026-03-04", "Holi"]]));
  const got = closedDaysFromRules([
    { key: "diwali", closed: true, daysBefore: 1, daysAfter: 2 },
    { key: "holi", closed: true, daysBefore: 0, daysAfter: 0, halfDay: true },
    { key: "christmas", closed: true, daysBefore: 0, daysAfter: 0 },
  ], days, [2026, 2027]);
  assert.deepEqual(got.map((d) => d.date), ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2027-10-28", "2027-10-29", "2027-10-30", "2027-10-31"],
    "Diwali ±days for both years; a half day closes nothing; a festival with no date in the calendar gives nothing");
  assert.equal(got[1].label, "Diwali");
  assert.equal(got[0].label, "Before Diwali");
  const merged = mergeRuleClosedDays(
    [{ date: "2026-11-08", label: "Shop anniversary" }, { date: "2026-12-01", label: "Stock-taking" }, { date: "2026-03-04", label: "Holi", fromRule: "holi" }],
    got,
  );
  assert.ok(merged.some((d) => d.date === "2026-12-01" && !d.fromRule), "a hand-added day is kept");
  assert.equal(merged.find((d) => d.date === "2026-11-08")?.label, "Shop anniversary", "a hand-added day wins over a rule day");
  assert.ok(!merged.some((d) => d.date === "2026-03-04"), "a day an older rule added is replaced by what the rules give now");
});

test("D — saving rules closes the days, and the ticket clock keeps them", async () => {
  const W = await ws("d");
  const year = Number(todayIstIsoDate().slice(0, 4));
  setFestivalCalendarReaderForTests(async () => fullCalendar([[`${year}-11-08`, "Diwali/Deepavali"], [`${year + 1}-10-29`, "Diwali/Deepavali"]]));
  await assert.rejects(() => saveFestivalRules(W, [{ key: "diwali", closed: true, daysBefore: 20 }], repos), NeedsActionError);
  const view = await saveFestivalRules(W, [{ key: "diwali", closed: true, daysBefore: 1, daysAfter: 1 }], repos);
  assert.equal(view.closedByRules.length, 6, "3 days × this year and next");
  const settings = await repos.ticketSlaSettings.getByWorkspace(W);
  assert.equal(settings?.festivalRules?.[0]?.key, "diwali");
  // The reply clock: an urgent ticket at 17:00 the day before the closed days (7–9 Nov) is due after them.
  const s = { ...defaultTicketSlaSettings(W), ...settings, clockMode: "business_hours" as const };
  const due = computeSla({ priority: "urgent", startedAt: new Date(`${year}-11-06T17:00:00+05:30`), now: new Date(`${year}-11-06T17:00:00+05:30`), settings: s as never });
  assert.ok(due.dueAt >= new Date(`${year}-11-10T09:00:00+05:30`), `a deadline must skip the closed Diwali days (was ${due.dueAt.toISOString()})`);
  // Saving the ticket clock alone (as the Working hours card does) keeps the rules.
  await repos.ticketSlaSettings.upsertForWorkspace(W, { ...settings!, businessHoursEnd: "19:00", festivalRules: settings!.festivalRules });
  const { id: _i, createdAt: _c, updatedAt: _u, festivalRules: _f, ...withoutRules } = (await repos.ticketSlaSettings.getByWorkspace(W))!;
  await repos.ticketSlaSettings.upsertForWorkspace(W, withoutRules);
  assert.equal((await repos.ticketSlaSettings.getByWorkspace(W))?.festivalRules?.length, 1, "a save without the rules must not wipe them");
  setFestivalCalendarReaderForTests(undefined);
});

test("E — the calendar cannot be read", async () => {
  setFestivalCalendarReaderForTests(async () => { throw new Error("offline"); });
  const fallback = await getFestivalCalendar();
  assert.equal(fallback.source, "built_in");
  assert.ok(fallback.days.some((d) => d.key === "diwali" && d.date === "2026-11-08"), "the built-in list is used before any good copy exists");
  setFestivalCalendarReaderForTests(async () => fullCalendar([["2026-11-08", "Diwali/Deepavali"]]));
  const good = await getFestivalCalendar(1_000);
  assert.equal(good.source, "google");
  let calls = 0;
  setFestivalCalendarReaderForTests(async () => { calls++; return fullCalendar([["2026-11-08", "Diwali/Deepavali"]]); });
  await getFestivalCalendar(2_000);
  const cached = await getFestivalCalendar(3_000);
  assert.equal(calls, 1, "read once, then kept for 12 hours");
  assert.equal(cached.source, "google");
  setFestivalCalendarReaderForTests(undefined);
});

test("F — festival coming: the right customers, a reminder each, nothing sent", async () => {
  const W = await ws("f");
  const today = todayIstIsoDate();
  const thisDiwali = shift(today, 20);
  const lastDiwali = shift(thisDiwali, -365);
  setFestivalCalendarReaderForTests(async () => fullCalendar([[thisDiwali, "Diwali/Deepavali"], [lastDiwali, "Diwali/Deepavali"]]));
  const lead = (name: string, extra: Record<string, unknown> = {}) => repos.lead.createLead({ workspaceId: W, companyName: name, contactName: "B", whatsappNumber: `9197${Math.floor(Math.random() * 1e8)}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", ...extra } as never);
  const regular = await lead("Diwali Regular");
  const optedOut = await lead("Opted Out Buyer", { doNotContact: true, status: "do_not_contact" });
  const other = await lead("Summer Buyer");
  const { mutateData } = await import("@/lib/db");
  const order = async (leadId: string, at: string) => {
    const o = await repos.order.create({ workspaceId: W, leadId, status: "delivered", lineItems: [], grandTotal: 1000, currencyCode: "INR", origin: "manual" } as never);
    await mutateData((d) => { const row = d.orders?.find((x) => x.id === o.id); if (row) row.createdAt = `${at}T10:00:00.000Z`; });
  };
  await order(regular.id, shift(lastDiwali, -30));
  await order(optedOut.id, shift(lastDiwali, -20));
  await order(other.id, shift(lastDiwali, -120));

  const prompts = await festivalPrompts(W, repos);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].basis, "last_year_festival");
  assert.deepEqual(prompts[0].customers.map((c) => c.name), ["Diwali Regular"], "only last year's pre-festival buyers, never an opted-out one");
  assert.ok((await buildNeedsYouList(W, repos, {})).items.some((i) => i.bucket === "festival"), "the card is in Needs you");

  const before = (await repos.outreachActivity.listByLead(W, regular.id)).length;
  const { created } = await remindForFestival(W, "diwali", repos);
  assert.equal(created, 1);
  const reminders = await repos.followUp.listByWorkspace(W, { leadId: regular.id });
  assert.equal(reminders[0]?.dueOn, shift(thisDiwali, -14), "the reminder is two weeks before the festival");
  assert.equal((await repos.outreachActivity.listByLead(W, regular.id)).length, before, "nothing was sent to the customer");
  assert.equal((await festivalPrompts(W, repos)).length, 0, "the card goes once handled");
  await assert.rejects(() => remindForFestival(W, "diwali", repos), NeedsActionError, "handled cards cannot be run twice");

  const W2 = await ws("f2");
  const l2 = await repos.lead.createLead({ workspaceId: W2, companyName: "Recent Buyer", contactName: "B", whatsappNumber: "919788800001", source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none" } as never);
  const o2 = await repos.order.create({ workspaceId: W2, leadId: l2.id, status: "delivered", lineItems: [], grandTotal: 500, currencyCode: "INR", origin: "manual" } as never);
  void o2;
  const p2 = await festivalPrompts(W2, repos);
  assert.equal(p2[0]?.basis, "last_12_months", "with no pre-festival history, recent buyers are offered instead");
  await skipFestival(W2, "diwali", repos);
  assert.equal((await festivalPrompts(W2, repos)).length, 0, "'not this year' closes the card");

  setFestivalCalendarReaderForTests(async () => fullCalendar([[shift(today, 40), "Diwali/Deepavali"], [shift(today, 40 - 365), "Diwali/Deepavali"]]));
  const W3 = await ws("f3");
  assert.equal((await festivalPrompts(W3, repos)).length, 0, "more than 28 days away: no card yet");
  setFestivalCalendarReaderForTests(undefined);
});

test("G — the morning routine refreshes the festival days", async () => {
  const W = await ws("g");
  const seen: string[] = [];
  await runDailyRoutine(repos, {
    discover: async () => [{ workspaceId: W, campaignsRun: 0, candidatesDiscovered: 0, leadsCreated: 0, leadsUpdated: 0, draftsGenerated: 0, errors: [], warnings: [] } as never],
    score: async () => undefined as never,
    autoApprove: async () => ({ approvedCount: 0, errors: [] }),
    learn: async () => ({ noReplySignals: 0, reorderProposed: 0, learningProposals: 0, learningRan: false }),
    festivals: async (_r, id) => { seen.push(id); return true; },
    followUpsDue: async () => 0,
    ownerSummary: async () => ({ status: "kept", reason: "test", text: "", count: 0 }),
    ownerAlerts: async () => undefined,
  });
  assert.deepEqual(seen, [W]);
  const view = await getFestivalView(W, repos);
  assert.ok(Array.isArray(view.upcoming));
});

test("H — a draft naming a closed day is flagged before the owner approves", async () => {
  const T = "2026-10-01";
  assert.deepEqual(datesNamedIn("Dispatch on 9 Nov, or 10th November 2026, or Nov 11.", T), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  assert.deepEqual(datesNamedIn("Ready 2026-11-12 and 13/11/2026 (day first).", T), ["2026-11-12", "2026-11-13"]);
  assert.deepEqual(datesNamedIn("Delivery 5 Jan.", T), ["2027-01-05"], "a day with no year is the next time it comes round");
  assert.deepEqual(datesNamedIn("Next week, after Diwali, 30 Feb, in 3 days, 500 metres.", T), [], "vague or impossible dates are never guessed");
  assert.deepEqual(closedDayMentions("We can dispatch on 9 Nov.", [{ date: "2026-11-09", label: "Diwali" }], T), [{ date: "2026-11-09", label: "Diwali" }]);
  assert.deepEqual(closedDayMentions("We can dispatch on 12 Nov.", [{ date: "2026-11-09", label: "Diwali" }], T), []);

  const W = await ws("h");
  const today = todayIstIsoDate();
  const closed = shift(today, 10);
  const [y, m, d] = closed.split("-");
  const settings = { ...defaultTicketSlaSettings(W), closedDates: [{ date: closed, label: "Diwali" }] };
  await repos.ticketSlaSettings.upsertForWorkspace(W, settings as never);
  const lead = await repos.lead.createLead({ workspaceId: W, companyName: "Clash Buyer", contactName: "B", whatsappNumber: "919788800009", source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none" } as never);
  await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "When can you deliver?", generatedReply: `We will dispatch on ${d}/${m}/${y}.`, status: "held_for_review" } as never);
  await repos.quote.create({ workspaceId: W, leadId: lead.id, quoteNumber: 1, status: "draft", lineItems: [{ id: "l1", productName: "Zari", quantity: 1, unit: "kg", unitPrice: 100, lineTotal: 100 }], grandTotal: 100, currencyCode: "INR", notes: `Delivery by ${closed}.` } as never);
  await repos.quote.create({ workspaceId: W, leadId: lead.id, quoteNumber: 2, status: "draft", lineItems: [{ id: "l2", productName: "Zari", quantity: 1, unit: "kg", unitPrice: 100, lineTotal: 100 }], grandTotal: 100, currencyCode: "INR", notes: `Delivery by ${shift(closed, 1)}.` } as never);
  const items = (await buildNeedsYouList(W, repos, {})).items;
  const clash = (i: { chips?: Array<{ text: string; tone: string }> }) => (i.chips || []).some((c) => c.tone === "danger" && /when you are closed \(Diwali\)/.test(c.text));
  assert.ok(items.some((i) => i.bucket === "flag" && clash(i)), "the held reply is flagged");
  assert.ok(items.some((i) => i.bucket === "money" && i.quote?.quoteNumber === 1 && clash(i)), "the quote naming the closed day is flagged");
  assert.ok(items.some((i) => i.bucket === "money" && i.quote?.quoteNumber === 2 && !clash(i)), "a quote naming an open day is not");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
