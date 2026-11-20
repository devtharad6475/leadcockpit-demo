/**
 * golden-optout-without-lead.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Sitting in the live Replies inbox, from a number with no lead record:
 *
 *     Opt-out request — "Stop, don't contact me"
 *
 * The engine's reply to that is "Understood — I've noted this and we won't
 * contact you again." Nothing was noted. The permanent Do-Not-Contact
 * registration was written INSIDE `if (lead)`, so an opt-out from anyone not
 * already in the CRM registered nothing at all.
 *
 * The registry exists precisely so an opt-out survives a lead being deleted or
 * re-imported — its own comment calls it "the legal-safety guarantee". Gating
 * it on a lead record inverts that: the person the system knows least about,
 * and can least afford to message again, is the one it does not remember. The
 * number is contactable the moment it is imported, and the product has already
 * promised them it would not be.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the live message, from a number with NO lead. The registry must
 *   hold that number afterwards.
 *
 *   CASE B — and the block must actually bite: the shared checker used by every
 *   outbound path must refuse that number afterwards.
 *
 *   CASE C — an opt-out from a KNOWN lead still does both things it did before:
 *   flags the lead AND registers the number. This is a widening, not a move.
 *
 *   CASE D — an ordinary message registers nobody. A registry that fills up
 *   with people who never opted out is the same bug pointing the other way.
 *
 *   CASE E — the reply the customer is shown and what the system stored agree.
 *   A promise on screen with no row behind it is what made this dangerous.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { isContactBlocked } from "@/lib/dnc-registry";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const repos = createJsonRepos();

let seq = 0;
const nextWorkspace = () => `ws_optout_${Date.now()}_${seq++}`;

async function workspace() {
  const id = nextWorkspace();
  await repos.workspace.create({ id, name: "Opt-out golden", status: "active" });
  return id;
}

const STOP = "Stop, don't contact me";
const UNKNOWN_PHONE = "+1 555 0199";

test("CASE A — an opt-out from a number with no lead is remembered", async () => {
  const workspaceId = await workspace();
  await handleIncomingWhatsAppMessage({ workspaceId, phone: UNKNOWN_PHONE, rawText: STOP }, repos);

  const entries = await repos.doNotContact.listByWorkspace(workspaceId);
  assert.ok(entries.length > 0,
    "this is the exact message sitting in the live inbox — it registered nothing, while the reply said 'we won't contact you again'");
});

test("CASE B — and every outbound path is actually blocked from that number", async () => {
  const workspaceId = await workspace();
  await handleIncomingWhatsAppMessage({ workspaceId, phone: UNKNOWN_PHONE, rawText: STOP }, repos);

  // The number is presented differently by an imported lead than by the
  // webhook, which is the whole reason the registry normalises.
  const blocked = await isContactBlocked(workspaceId, { phone: "+15550199" }, repos);
  assert.ok(blocked,
    "a row nobody checks is not a safeguard — the shared checker must refuse this number however it is spelled");
});

test("CASE C — an opt-out from a known lead still flags the lead AND the registry", async () => {
  const workspaceId = await workspace();
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Known Buyer Ltd",
    phone: "+1 555 0177",
    whatsappNumber: "+1 555 0177",
    status: "contacted",
    reviewStatus: "approved",
  });

  await handleIncomingWhatsAppMessage({ workspaceId, leadId: lead.id, phone: "+1 555 0177", rawText: STOP }, repos);

  const after = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.strictEqual(after?.doNotContact, true, "the lead flag was already correct and must stay correct");
  const entries = await repos.doNotContact.listByWorkspace(workspaceId);
  assert.ok(entries.length > 0, "and the permanent registry, which survives the lead being deleted, must still be written");
});

test("CASE D — an ordinary message registers nobody", async () => {
  const workspaceId = await workspace();
  await handleIncomingWhatsAppMessage({ workspaceId, phone: "+1 555 0188", rawText: "Hi, can you send me the price list?" }, repos);

  const entries = await repos.doNotContact.listByWorkspace(workspaceId);
  assert.deepStrictEqual(entries, [],
    "a registry that fills up with people who never opted out is the same bug pointing the other way");
});

test("CASE E — what the customer is told and what was stored agree", async () => {
  const workspaceId = await workspace();
  const result = await handleIncomingWhatsAppMessage({ workspaceId, phone: UNKNOWN_PHONE, rawText: STOP }, repos);
  const entries = await repos.doNotContact.listByWorkspace(workspaceId);

  const promised = /won'?t contact you again|noted this|opt(ed)?[- ]out|removed you/i.test(result.suggestedReply);
  if (promised) {
    assert.ok(entries.length > 0,
      `the reply promises the customer they are opted out, so a row must exist: ${JSON.stringify(result.suggestedReply)}`);
  }
  assert.strictEqual(result.classification.category, "unsubscribe",
    "and the message must be read as an opt-out in the first place");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-optout-without-lead — N-BUG (saying 'stop' must be remembered even with no lead record)\n");
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
  console.log(`optout-without-lead: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
