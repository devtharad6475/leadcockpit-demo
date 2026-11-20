import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { getFollowupRadar } from "@/services/OutreachQueueService";
import { createReminder, confirmReminder, closeReminder, findTimePhrase, listDueReminders, listProposedReminders, proposeReminderFromMessage, syncNextFollowUp } from "@/services/FollowUpService";

const repos = createJsonRepos();
const workspace = `week_two_followups_${Date.now()}`;
const cases: Array<[string, () => Promise<void>]> = [];
let sequence = 0;
async function buyer() {
  sequence += 1;
  return repos.lead.createLead({ workspaceId: workspace, companyName: `Reminder buyer ${sequence}`, whatsappNumber: `9198800${String(sequence).padStart(5, "0")}`, source: "manual", status: "replied", doNotContact: false } as never);
}
const test = (name: string, run: () => Promise<void>) => cases.push([name, run]);

test("Permanent opt-out survives cleared lead flags across reminder paths", async () => {
  const lead = await buyer();
  const open = await createReminder(workspace, { leadId: lead.id, dueOn: "2026-10-03", note: "Call buyer" }, repos);
  const proposal = await proposeReminderFromMessage(workspace, lead.id, "call me next week", repos);
  assert.ok(proposal);
  await registerDoNotContact(workspace, { phone: lead.whatsappNumber, reason: "Customer asked to stop" }, repos);
  await assert.rejects(() => createReminder(workspace, { leadId: lead.id, dueOn: "2026-10-04", note: "Call again" }, repos));
  await assert.rejects(() => confirmReminder(workspace, proposal.id, { dueOn: "2026-10-04" }, repos));
  assert.equal(await proposeReminderFromMessage(workspace, lead.id, "call me tomorrow", repos), undefined);
  assert.equal((await listDueReminders(workspace, "2099-01-01", repos)).some((item) => item.id === open.id), false);
  assert.equal((await listProposedReminders(workspace, repos)).some((item) => item.id === proposal.id), false);
  await syncNextFollowUp(workspace, lead.id, repos);
  assert.equal((await repos.lead.getLeadById(workspace, lead.id))?.nextFollowUpAt ?? null, null);
});

test("Specific customer time phrase takes priority", async () => {
  const today = new Date("2026-10-03T00:00:00Z");
  assert.equal(findTimePhrase("Call me day after tomorrow", today)?.suggestedDueOn, "2026-10-05");
  assert.equal(findTimePhrase("Call me tomorrow", today)?.suggestedDueOn, "2026-10-04");
  assert.equal(findTimePhrase("Diwali ke baad", today)?.suggestedDueOn, undefined);
});

test("Stale-contact radar excludes flag and permanent opt-outs and fails closed", async () => {
  const allowed = await buyer();
  const flagged = await buyer();
  const permanent = await buyer();
  for (const lead of [allowed, flagged, permanent]) {
    await repos.lead.updateLead(workspace, lead.id, { status: "contacted", lastContactedAt: "2020-01-01T00:00:00Z" });
  }
  await repos.lead.updateLead(workspace, flagged.id, { doNotContact: true });
  await registerDoNotContact(workspace, { phone: permanent.whatsappNumber, reason: "Stop" }, repos);
  const radar = await getFollowupRadar(workspace, repos);
  assert.deepEqual(radar.leads.map((lead) => lead.id), [allowed.id]);
  assert.equal(radar.count, 1);
  const unavailable = {
    ...repos,
    doNotContact: { ...repos.doNotContact, findMatch: async () => { throw new Error("Contact registry unavailable"); } },
  };
  await assert.rejects(() => getFollowupRadar(workspace, unavailable), /registry unavailable/);
});

test("Registry failure cannot authorize contact reminders", async () => {
  const lead = await buyer();
  await createReminder(workspace, { leadId: lead.id, dueOn: "2026-10-03", note: "Call" }, repos);
  const unavailable = {
    ...repos,
    doNotContact: { ...repos.doNotContact, findMatch: async () => { throw new Error("Contact registry unavailable"); } },
  };
  await assert.rejects(() => createReminder(workspace, { leadId: lead.id, dueOn: "2026-10-04", note: "Again" }, unavailable), /registry unavailable/);
  await assert.rejects(() => listDueReminders(workspace, "2099-01-01", unavailable), /registry unavailable/);
  assert.equal(await proposeReminderFromMessage(workspace, lead.id, "call next month", unavailable), undefined);
  assert.equal((await repos.followUp.listByWorkspace(workspace, { leadId: lead.id })).length, 1);
});

test("Only confirmed open reminders count; close and deletion resync earliest", async () => {
  const lead = await buyer();
  const late = await createReminder(workspace, { leadId: lead.id, dueOn: "2026-12-01", note: "Later" }, repos);
  const early = await createReminder(workspace, { leadId: lead.id, dueOn: "2026-11-01", note: "Earlier" }, repos);
  await proposeReminderFromMessage(workspace, lead.id, "call me tomorrow", repos);
  assert.equal((await repos.lead.getLeadById(workspace, lead.id))?.nextFollowUpAt, "2026-11-01T03:30:00.000Z");
  await closeReminder(workspace, early.id, "done", repos);
  assert.equal((await repos.lead.getLeadById(workspace, lead.id))?.nextFollowUpAt, "2026-12-01T03:30:00.000Z");
  await closeReminder(workspace, late.id, "dismissed", repos);
  assert.equal((await repos.lead.getLeadById(workspace, lead.id))?.nextFollowUpAt ?? null, null);
  await repos.followUp.deleteByLead(workspace, lead.id);
  await syncNextFollowUp(workspace, lead.id, repos);
  assert.equal((await repos.followUp.listByWorkspace(workspace, { leadId: lead.id })).length, 0);
});

test("Invalid dates and other workspace ownership are rejected", async () => {
  const lead = await buyer();
  for (const dueOn of ["2026-02-30", "2026-13-01", "not a date"]) {
    await assert.rejects(() => createReminder(workspace, { leadId: lead.id, dueOn, note: "Call" }, repos));
  }
  const reminder = await createReminder(workspace, { leadId: lead.id, dueOn: "2026-11-01", note: "Call" }, repos);
  await ensureWorkspace(repos, `${workspace}_other`);
  await assert.rejects(() => closeReminder(`${workspace}_other`, reminder.id, "done", repos));
  await assert.rejects(() => createReminder(`${workspace}_other`, { leadId: lead.id, dueOn: "2026-11-01", note: "Call" }, repos));
  assert.equal((await repos.followUp.getById(workspace, reminder.id))?.status, "open");
});

async function main() {
  await ensureWorkspace(repos, workspace);
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
  }
  console.log(`${cases.length - failed}/${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
void main();
