/**
 * golden-whatsapp-test-saves-nothing.ts — pin (2026-09-25).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The owner's "try it" buttons — WhatsApp Agent's full check and the Replies
 * inbox "Simulate" — called the REAL inbound handler through
 * /api/whatsapp-agent/dry-run. The name promised a dry run; the handler wrote
 * everything a real customer message writes:
 *   - a fake customer message in the Replies inbox,
 *   - a draft in the AI Drafts approval queue (seven "No lead linked — send
 *     catalogue and price" drafts in the demo data came from a smoke script),
 *   - tickets and Information Needed cards,
 *   - a status change on the lead the owner picked to "pretend it came from",
 *   - and a test message saying "stop" put that real customer on the
 *     PERMANENT do-not-contact list.
 *
 * HAND-COMPUTED CONTRACT (`dryRun: true`):
 *   CASE A — "stop" from a real lead: the lead's status and flag are untouched,
 *            the do-not-contact list stays empty, and the result says it WOULD
 *            have added them.
 *   CASE B — a complaint: no reply, no draft, no ticket, no question saved;
 *            the result says it would have opened a ticket.
 *   CASE C — the draft and the safety decision are still produced (a test that
 *            skips the thinking would prove nothing).
 *   CASE D — control: the same "stop" WITHOUT dryRun does write. If this ever
 *            fails, cases A–B are passing because nothing writes at all, not
 *            because dryRun works.
 *   CASE E — the HTTP route the buttons call passes dryRun (read from source:
 *            the route is the part a refactor would silently drop).
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createJsonRepos } from "./_helpers/provider";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const repos = createJsonRepos();
let seq = 0;

async function workspaceWithLead() {
  const workspaceId = `ws_wa_dryrun_${Date.now()}_${seq++}`;
  await repos.workspace.create({ id: workspaceId, name: "Dry-run golden", status: "active" });
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Real Customer Pvt Ltd",
    phone: "+91 00000 00071",
    whatsappNumber: "+91 00000 00071",
    status: "contacted",
    reviewStatus: "approved",
  });
  return { workspaceId, lead };
}

async function counts(workspaceId: string) {
  return {
    replies: (await repos.reply.listByWorkspace(workspaceId)).length,
    drafts: (await repos.autoReplyLog.listByWorkspace(workspaceId)).length,
    tickets: (await repos.ticket.listByWorkspace(workspaceId)).length,
    questions: (await repos.unknownQuestion.listByWorkspace(workspaceId)).length,
    doNotContact: (await repos.doNotContact.listByWorkspace(workspaceId)).length,
  };
}
const NOTHING = { replies: 0, drafts: 0, tickets: 0, questions: 0, doNotContact: 0 };

test("CASE A — a test 'stop' from a real customer changes nothing and says what it would have done", async () => {
  const { workspaceId, lead } = await workspaceWithLead();
  const result = await handleIncomingWhatsAppMessage({ workspaceId, leadId: lead.id, rawText: "Stop, don't contact me" }, repos, { dryRun: true });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.strictEqual(after?.doNotContact, lead.doNotContact, "a TEST must not flag a real customer do-not-contact");
  assert.strictEqual(after?.status, "contacted", "a test must not move the customer's status");
  assert.deepStrictEqual(await counts(workspaceId), NOTHING, "a test must save nothing");
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.wouldHave?.addedToDoNotContact, true, "the owner must still be told a real 'stop' would opt them out");
});

test("CASE B — a test complaint opens no ticket, queues no draft, asks no question", async () => {
  const { workspaceId, lead } = await workspaceWithLead();
  const result = await handleIncomingWhatsAppMessage({ workspaceId, leadId: lead.id, rawText: "The 20 kg consignment arrived damaged. I want a refund." }, repos, { dryRun: true });
  assert.deepStrictEqual(await counts(workspaceId), NOTHING);
  assert.strictEqual(result.wouldHave?.openedTicket, true, "a real complaint opens a ticket, so the test must say so");
  assert.strictEqual(result.send.status === "sent", false, "nothing is ever sent from a test");
});

test("CASE C — the test still produces the draft and the safety decision", async () => {
  const { workspaceId, lead } = await workspaceWithLead();
  const result = await handleIncomingWhatsAppMessage({ workspaceId, leadId: lead.id, rawText: "send catalogue and price" }, repos, { dryRun: true });
  assert.ok(result.suggestedReply.trim().length > 0, "a test that skips the draft proves nothing");
  assert.strictEqual(result.needsHumanReview, true, "a price question is held for review — the decision must still run");
  assert.strictEqual(result.wouldHave?.queuedDraftForApproval, true);
});

test("CASE D — control: without dryRun the same message DOES write", async () => {
  const { workspaceId, lead } = await workspaceWithLead();
  await handleIncomingWhatsAppMessage({ workspaceId, leadId: lead.id, rawText: "Stop, don't contact me" }, repos);
  const c = await counts(workspaceId);
  assert.ok(c.replies > 0 && c.drafts > 0 && c.doNotContact > 0,
    `a real opt-out must still be recorded — otherwise A and B pass only because nothing writes: ${JSON.stringify(c)}`);
});

test("CASE E — the route behind the test buttons passes dryRun", async () => {
  const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/[[...path]]/route.ts"), "utf8");
  const start = route.indexOf('match(path, ["whatsapp-agent", "dry-run"])');
  assert.ok(start > 0, "route not found");
  const block = route.slice(start, route.indexOf("\n  }\n", start));
  assert.ok(/dryRun:\s*true/.test(block), "the dry-run route must call the engine with { dryRun: true }");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-whatsapp-test-saves-nothing — a WhatsApp test run must save nothing and send nothing\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`whatsapp-test-saves-nothing: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
