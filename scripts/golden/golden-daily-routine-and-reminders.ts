/**
 * golden-daily-routine-and-reminders.ts — 2026-09-27 (CEO): the daily routine
 * runs by itself, and the system remembers things to do later.
 * Plan: docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md.
 *
 *   A — the outside trigger's secret: off when unset or short, refused when
 *       wrong, accepted when right.
 *   B — the routine builds the morning summary AFTER scoring and auto-approve
 *       (review M11), includes reminders due today, and a failed step does not
 *       stop the next one; a company already run today gets no second summary.
 *   C — a reminder needs a note and a real date; a do-not-contact customer
 *       cannot get one; the earliest open reminder is the customer's "next
 *       follow-up", and closing it clears that.
 *   D — a customer naming a time gives a PROPOSED reminder with their words,
 *       which counts for nothing until the owner confirms it with a date; the
 *       same words never propose twice; an opted-out customer gets none.
 *   E — reminders are company-scoped.
 *   F — "due today" skips future dates and do-not-contact customers.
 *   G — erasing a customer removes their reminders.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-daily-routine-and-reminders.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { NeedsActionError } from "@/lib/user-errors";
import { dailyRunSecretMatches } from "@/lib/daily-run-secret";
import { runDailyRoutine } from "@/services/DailyRoutineService";
import {
  closeReminder, confirmReminder, countFollowUpsDue, createReminder, findTimePhrase,
  listDueReminders, proposeReminderFromMessage,
} from "@/services/FollowUpService";
import { mutateData, readData } from "@/lib/db";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

async function ws(tag: string) {
  const id = `ws_daily_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
let seq = 0;
async function buyer(W: string, extra: Record<string, unknown> = {}) {
  seq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Buyer ${seq}`, contactName: "B", whatsappNumber: `9197700${String(seq).padStart(5, "0")}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", ...extra } as never);
}

test("A — the daily-run secret", async () => {
  const good = "x".repeat(40);
  assert.equal(dailyRunSecretMatches(good, undefined), "off", "no secret configured must mean the endpoint is off");
  assert.equal(dailyRunSecretMatches("short", "short"), "off", "a short secret must not switch the endpoint on");
  assert.equal(dailyRunSecretMatches(null, good), "wrong");
  assert.equal(dailyRunSecretMatches("y".repeat(40), good), "wrong");
  assert.equal(dailyRunSecretMatches(good, good), "ok");
});

test("B — the morning summary comes after the night's work and includes reminders", async () => {
  const W = await ws("b");
  const order: string[] = [];
  const reports = await runDailyRoutine(repos, {
    discover: async () => [
      { workspaceId: W, campaignsRun: 1, candidatesDiscovered: 3, leadsCreated: 2, leadsUpdated: 0, draftsGenerated: 1, errors: [], warnings: [] } as never,
      { workspaceId: `${W}_already`, skipped: "already ran today", campaignsRun: 0, candidatesDiscovered: 0, leadsCreated: 0, leadsUpdated: 0, draftsGenerated: 0, errors: [] } as never,
    ],
    score: async () => { order.push("score"); throw new Error("AI down"); },
    autoApprove: async () => { order.push("approve"); return { approvedCount: 4, errors: [] }; },
    followUpsDue: async () => { order.push("reminders"); return 3; },
  });
  assert.deepEqual(order, ["score", "approve", "reminders"], "a failed scoring step must not stop auto-approve or the summary");
  const report = reports.find((r) => r.workspaceId === W)!;
  assert.equal(report.autoApproved, 4);
  assert.equal(report.followUpsDue, 3);
  assert.ok(report.errors.some((e) => /AI scoring failed/.test(e)), "the scoring failure must be reported");
  const logs = (await readData()).auditLogs?.filter((l) => l.workspaceId === W && l.eventType === "digest_sent") || [];
  assert.equal(logs.length, 1, "exactly one morning summary");
  const payload = logs[0].payload as Record<string, unknown>;
  assert.equal(payload.autoApproved, 4, "the summary must show the night's auto-approvals");
  assert.equal(payload.followUpsDue, 3, "the summary must show today's reminders");
  const skipped = (await readData()).auditLogs?.filter((l) => l.workspaceId === `${W}_already` && l.eventType === "digest_sent") || [];
  assert.equal(skipped.length, 0, "a company already run today gets no second summary");
});

test("C — setting, syncing and closing a reminder", async () => {
  const W = await ws("c");
  const lead = await buyer(W);
  await assert.rejects(() => createReminder(W, { leadId: lead.id, dueOn: "", note: "call" }, repos), NeedsActionError);
  await assert.rejects(() => createReminder(W, { leadId: lead.id, dueOn: "2026-02-30", note: "call" }, repos), NeedsActionError, "an impossible date must be refused");
  await assert.rejects(() => createReminder(W, { leadId: lead.id, dueOn: "2026-11-10", note: "   " }, repos), NeedsActionError);
  const later = await createReminder(W, { leadId: lead.id, dueOn: "2026-12-01", note: "Wedding season order" }, repos);
  const sooner = await createReminder(W, { leadId: lead.id, dueOn: "2026-11-10", note: "Call after Diwali" }, repos);
  assert.equal((await repos.lead.getLeadById(W, lead.id))?.nextFollowUpAt?.slice(0, 10), "2026-11-10", "the earliest reminder must be the next follow-up");
  await closeReminder(W, sooner.id, "done", repos);
  assert.equal((await repos.lead.getLeadById(W, lead.id))?.nextFollowUpAt?.slice(0, 10), "2026-12-01");
  await closeReminder(W, later.id, "dismissed", repos);
  assert.ok(!(await repos.lead.getLeadById(W, lead.id))?.nextFollowUpAt, "no open reminder must mean no next follow-up");
  const dnc = await buyer(W, { doNotContact: true, status: "do_not_contact" });
  await assert.rejects(() => createReminder(W, { leadId: dnc.id, dueOn: "2026-11-10", note: "call" }, repos), NeedsActionError, "an opted-out customer got a reminder");
});

test("D — a customer's words give a proposal, not a reminder", async () => {
  const W = await ws("d");
  const lead = await buyer(W);
  const proposal = await proposeReminderFromMessage(W, lead.id, "Abhi nahi, Diwali ke baad call karna", repos);
  assert.equal(proposal?.status, "proposed");
  assert.equal(proposal?.dueOn, undefined, "a date we cannot work out must be left for the owner");
  assert.equal(proposal?.evidence, "Abhi nahi, Diwali ke baad call karna");
  assert.equal(await countFollowUpsDue(W, "2099-01-01", repos), 0, "a proposal must not count until confirmed");
  assert.equal((await repos.lead.getLeadById(W, lead.id))?.nextFollowUpAt, undefined, "a proposal must not set the next follow-up");
  assert.equal(await proposeReminderFromMessage(W, lead.id, "Abhi nahi, Diwali ke baad call karna", repos), undefined, "the same words proposed twice");
  await assert.rejects(() => confirmReminder(W, proposal!.id, {}, repos), NeedsActionError, "confirming without a date must ask for one");
  await confirmReminder(W, proposal!.id, { dueOn: "2026-11-12" }, repos);
  assert.equal(await countFollowUpsDue(W, "2026-11-12", repos), 1);
  assert.ok(findTimePhrase("ok send next week", new Date("2026-09-27T00:00:00Z"))?.suggestedDueOn === "2026-10-04", "next week must suggest a date a week out");
  assert.equal(findTimePhrase("send the sample please"), undefined, "no time named, no proposal");
  const dnc = await buyer(W, { doNotContact: true, status: "do_not_contact" });
  assert.equal(await proposeReminderFromMessage(W, dnc.id, "call me next week", repos), undefined, "an opted-out customer got a proposal");
});

test("E — reminders are company-scoped", async () => {
  const A = await ws("ea");
  const B = await ws("eb");
  const lead = await buyer(A);
  const r = await createReminder(A, { leadId: lead.id, dueOn: "2026-11-10", note: "call" }, repos);
  assert.equal(await repos.followUp.getById(B, r.id), undefined, "company B read company A's reminder");
  await assert.rejects(() => closeReminder(B, r.id, "done", repos), NeedsActionError, "company B closed company A's reminder");
  await assert.rejects(() => createReminder(B, { leadId: lead.id, dueOn: "2026-11-10", note: "x" }, repos), NeedsActionError, "company B set a reminder on company A's customer");
});

test("F — due today skips future dates and opted-out customers", async () => {
  const W = await ws("f");
  const a = await buyer(W);
  const b = await buyer(W);
  await createReminder(W, { leadId: a.id, dueOn: "2026-10-01", note: "due" }, repos);
  await createReminder(W, { leadId: a.id, dueOn: "2026-10-09", note: "future" }, repos);
  await createReminder(W, { leadId: b.id, dueOn: "2026-10-01", note: "opted out later" }, repos);
  await repos.lead.updateLead(W, b.id, { doNotContact: true, status: "do_not_contact" } as never);
  const due = await listDueReminders(W, "2026-10-02", repos);
  assert.deepEqual(due.map((d) => d.note), ["due"]);
});

test("G — erasing a customer removes their reminders", async () => {
  const W = await ws("g");
  const lead = await buyer(W);
  await createReminder(W, { leadId: lead.id, dueOn: "2026-11-10", note: "call" }, repos);
  const { eraseLeadCascade } = await import("@/services/ErasureCascade");
  await eraseLeadCascade({ workspaceId: W, leadId: lead.id, data: await readData(), mutateData: mutateData as never } as never);
  assert.equal((await repos.followUp.listByWorkspace(W, { leadId: lead.id })).length, 0, "the erased customer's reminders survived");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
