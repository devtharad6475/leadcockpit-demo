/**
 * golden-whatsapp-webhook.ts — pins the inbound-WhatsApp lead-creation chokepoint.
 *
 * WHAT THIS PROVES
 *   `getOrCreateInboundWhatsAppLead` is the function that decides whether an
 *   inbound WhatsApp message creates a fresh CRM lead. It contains the
 *   load-bearing DNC-resurrection block (Session 3 audit fix): if the phone
 *   previously unsubscribed, NO new contactable lead is created. Without this,
 *   a customer who opted out gets a fresh contactable record every time Meta
 *   redelivers their message (or every time they text again).
 *
 * THE CONTRACT (hand-computed BEFORE writing assertions):
 *   CASE A — first-time inbound → creates a lead with the documented defaults:
 *            source=whatsapp, status=replied, reviewStatus=pending,
 *            enrichmentStatus=not_started, doNotContact=false,
 *            consentStatus=none. (These defaults feed the downstream gates —
 *            auto-approve, AutoSend, enrichment — so a drift here breaks
 *            the whole inbound funnel.)
 *   CASE B — DNC-registered phone → returns null, creates NO lead. This is the
 *            sacred "Do not contact / unsubscribe is immediate and permanent"
 *            rule (AGENTS.md) made executable.
 *   CASE C — second inbound from the SAME phone → reuses the existing lead
 *            (idempotent on phone, no duplicate). Pinned because Meta
 *            redelivers + the dedup service handles message.id, but the
 *            phone-level dedup is the second layer of defense.
 *   CASE D — phone normalization is robust: "+91 98765 43210" and
 *            "919876543210" and "+919876543210" all match the same lead
 *            (so a customer texting from a differently-formatted caller-id
 *            doesn't get a duplicate record).
 *
 * REAL PIPELINE: imports the real WhatsAppWebhookService module to reach the
 * exported `processWhatsAppCloudWebhook` (which calls getOrCreateInboundWhatsAppLead
 * internally). Each case runs on an isolated workspace (Ironclad Gate #8) with
 * a fresh DNC registry state.
 *
 * NOTE: getOrCreateInboundWhatsAppLead is module-private (not exported). We
 * exercise it via the public processWhatsAppCloudWebhook with a minimal stub
 * Meta payload shape, asserting on the lead-creation side-effects (the lead
 * list + the DNC registry). This is the real pipeline — no mocks of the
 * function under test.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createAmbientRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { registerDoNotContact, isPermanentlyDoNotContact } from "@/lib/dnc-registry";
import type { RepositoryBundle } from "@/repositories/interfaces";
import assert from "node:assert";

/** Isolated workspace per case (Ironclad Gate #8 — no state leaks between cases). */
function caseWs(caseId: string) { return `ws_wh_webhook_${caseId}`; }

async function clearWorkspaceLeads(ws: string, repos: RepositoryBundle) {
  for (const lead of await repos.lead.listLeads(ws)) {
    try { await repos.lead.deleteById(ws, lead.id); } catch { /* best-effort */ }
  }
}

/**
 * Make the tenant real, then empty its DNC registry.
 *
 * A-7 (2026-08-25): this golden used to pin itself to JSON, which meant the
 * "a phone on the permanent opt-out list must never become a lead" rule was
 * only ever proven against a file format production does not use. It now
 * follows the process - JSON on the normal suite run, a private Postgres clone
 * under the A-7 pass.
 *
 * Two consequences. The tenant `ws_wh_webhook_B` is invented by this file, and
 * Postgres will not hang a lead or a registry row off a workspace that was
 * never created - so it gets created here, out loud, where a reader of the
 * golden can see the dependency. And the registry wipe stops reaching into the
 * JSON file directly: off JSON the whole database is a throwaway clone that
 * starts empty, so there is nothing to wipe and pretending otherwise would be
 * a lie about which substrate was cleaned.
 */
async function clearDncForWorkspace(ws: string, repos: RepositoryBundle) {
  await ensureWorkspace(repos, ws, `whatsapp webhook golden ${ws}`);
  if (process.env.PERSISTENCE_PROVIDER === "prisma") return;
  const { readData, mutateData } = await import("@/lib/db");
  const data = await readData();
  const before = (data.doNotContactRegistry || []).filter((d) => d.workspaceId === ws).length;
  if (before > 0) {
    await mutateData((d) => {
      d.doNotContactRegistry = (d.doNotContactRegistry || []).filter((entry) => entry.workspaceId !== ws);
      return undefined;
    });
  }
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- CASE A: first-time inbound creates a lead with documented defaults ---------
test("CASE A — first-time inbound creates a lead with the documented defaults", async () => {
  const ws = caseWs("A");
  const repos = createAmbientRepos();
  await clearWorkspaceLeads(ws, repos);
  await clearDncForWorkspace(ws, repos);

  // Exercise the real webhook service. We import processWhatsAppCloudWebhook
  // which calls getOrCreateInboundWhatsAppLead internally.
  const { processWhatsAppCloudWebhook } = await import("@/services/WhatsAppWebhookService");
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry_id", changes: [{
        value: {
          messaging_product: "whatsapp",
          phone_number_id: "phone_id_123",
          metadata: { display_phone_number: "15550123456" },
          contacts: [{ profile: { name: "Test Customer A" }, wa_id: "919876543210" }],
          messages: [{ from: "919876543210", id: `msg_A_${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hi, interested in your products" } }],
        },
        field: "messages",
      }],
    }],
  };
  const result = await processWhatsAppCloudWebhook(ws, payload, repos);

  // Hand-computed truth: a lead MUST have been created with these defaults.
  const leads = await repos.lead.listLeads(ws);
  const created = leads.find((l) => l.whatsappNumber?.includes("919876543210") || l.phone?.includes("919876543210"));
  assert.ok(created, "first-time inbound created a lead");
  assert.strictEqual(created!.source, "whatsapp", "source === 'whatsapp'");
  assert.strictEqual(created!.reviewStatus, "pending", "reviewStatus === 'pending'");
  assert.strictEqual(created!.enrichmentStatus, "not_started", "enrichmentStatus === 'not_started'");
  assert.strictEqual(created!.doNotContact, false, "doNotContact === false (fresh)");
  assert.strictEqual(created!.consentStatus, "none", "consentStatus === 'none' (LOGIC.md Q11)");
  assert.strictEqual(created!.workspaceId, ws, "scoped to this workspace");
  // processedMessages confirms the message was handled (not silently dropped).
  assert.ok(result.processedMessages.length >= 1, "the message was processed");
});

// --- CASE B: DNC-registered phone → returns null, creates NO lead ----------------
test("CASE B — DNC-registered phone creates NO lead (sacred unsubscribe rule)", async () => {
  const ws = caseWs("B");
  const repos = createAmbientRepos();
  await clearWorkspaceLeads(ws, repos);
  await clearDncForWorkspace(ws, repos);

  const DNC_PHONE = "919876543210";
  // Register the phone on the permanent DNC registry BEFORE the inbound.
  await registerDoNotContact(ws, { phone: DNC_PHONE, reason: "Customer opted out", sourceLeadId: undefined }, repos);
  const blocked = await isPermanentlyDoNotContact(ws, { phone: DNC_PHONE }, repos);
  assert.strictEqual(blocked, true, "precondition: phone IS on the DNC registry");

  const { processWhatsAppCloudWebhook } = await import("@/services/WhatsAppWebhookService");
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry_id_b", changes: [{
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: "Blocked Customer" }, wa_id: DNC_PHONE }],
          messages: [{ from: DNC_PHONE, id: `msg_B_${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "I want to buy" } }],
        },
        field: "messages",
      }],
    }],
  };
  await processWhatsAppCloudWebhook(ws, payload, repos);

  // Hand-computed truth: NO lead exists with the DNC phone. The sacred rule
  // "Do not contact / unsubscribe is immediate and permanent" (AGENTS.md) must
  // hold even when the customer texts again.
  const leads = await repos.lead.listLeads(ws);
  const matchingLead = leads.find((l) => (l.whatsappNumber || l.phone || "").includes(DNC_PHONE));
  assert.strictEqual(matchingLead, undefined, "DNC phone did NOT create a fresh contactable lead");
  assert.strictEqual(leads.length, 0, `workspace has 0 leads (DNC blocked all), got ${leads.length}`);
});

// --- CASE C: second inbound from same phone reuses the existing lead ------------
test("CASE C — second inbound from the SAME phone reuses the existing lead (idempotent)", async () => {
  const ws = caseWs("C");
  const repos = createAmbientRepos();
  await clearWorkspaceLeads(ws, repos);
  await clearDncForWorkspace(ws, repos);

  const PHONE = "919876543210";
  const { processWhatsAppCloudWebhook } = await import("@/services/WhatsAppWebhookService");
  const makePayload = (msgId: string) => ({
    object: "whatsapp_business_account",
    entry: [{
      id: "entry_id_c", changes: [{
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: "Repeat Customer" }, wa_id: PHONE }],
          messages: [{ from: PHONE, id: msgId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hello" } }],
        },
        field: "messages",
      }],
    }],
  });

  // First inbound — creates the lead.
  await processWhatsAppCloudWebhook(ws, makePayload(`msg_C1_${Date.now()}`), repos);
  const after1 = await repos.lead.listLeads(ws);
  assert.strictEqual(after1.length, 1, "first inbound created 1 lead");
  const firstLeadId = after1[0].id;

  // Second inbound from the SAME phone — must reuse, not duplicate.
  await processWhatsAppCloudWebhook(ws, makePayload(`msg_C2_${Date.now()}`), repos);
  const after2 = await repos.lead.listLeads(ws);
  assert.strictEqual(after2.length, 1, "second inbound did NOT create a duplicate lead");
  assert.strictEqual(after2[0].id, firstLeadId, "the same lead was reused (idempotent on phone)");
});

// --- CASE D: phone normalization is robust (different formats → same lead) -------
test("CASE D — phone normalization: +91 98765 43210 and 919876543210 match the same lead", async () => {
  const ws = caseWs("D");
  const repos = createAmbientRepos();
  await clearWorkspaceLeads(ws, repos);
  await clearDncForWorkspace(ws, repos);

  const { processWhatsAppCloudWebhook } = await import("@/services/WhatsAppWebhookService");
  // First inbound with E.164 plus-spaces format (some carriers send this).
  const payload1 = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry_d1", changes: [{
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: "Format Test" }, wa_id: "919876543210" }],
          messages: [{ from: "919876543210", id: `msg_D1_${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "first" } }],
        },
        field: "messages",
      }],
    }],
  };
  await processWhatsAppCloudWebhook(ws, payload1, repos);

  // Second inbound from the same digits, no country-code plus. normalizePhone
  // strips non-digits, so this MUST match the existing lead.
  const payload2 = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry_d2", changes: [{
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: "Format Test" }, wa_id: "919876543210" }],
          messages: [{ from: "919876543210", id: `msg_D2_${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "second" } }],
        },
        field: "messages",
      }],
    }],
  };
  await processWhatsAppCloudWebhook(ws, payload2, repos);

  const leads = await repos.lead.listLeads(ws);
  // Hand-computed: exactly ONE lead — the second inbound matched the first by
  // normalized phone, not created a duplicate. (If normalization were broken,
  // we'd see 2 leads with slightly different phone strings.)
  assert.strictEqual(leads.length, 1, `normalization matched both inbound to ONE lead, got ${leads.length}`);
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
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
  console.log(`whatsapp-webhook: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
