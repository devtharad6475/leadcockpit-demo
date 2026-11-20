/**
 * Golden test — DNC registry + lead state-machine (Cluster 2 fix, 2026-07-26).
 *
 * PINS the 4 operator-locked decisions from DECISIONS.md D-2026-07-26:
 *
 *   D-1: PUT /leads/:id schema is COSMETIC-ONLY — it must NOT accept
 *        status / reviewStatus / doNotContact. Those go through the
 *        dedicated approve/reject/consent/DNC endpoints.
 *
 *   D-3: price-change send calls isContactBlocked() for every recipient.
 *        A lead in the DNC registry (even with the lead.doNotContact flag
 *        cleared) must be SKIPPED.
 *
 *   D-4: not_interested is PERMANENT — decideAutoReply blocks a lead whose
 *        status is "not_interested", regardless of the new message's
 *        classification.
 *
 *   D-2: remove-dnc endpoint requires a written reason and writes an audit
 *        log (covered by an HTTP test separately; here we pin the
 *        ConsentService.removeDnc planner that the route must call).
 *
 * Hand-computed BEFORE writing the fix:
 *
 *   CASE A — leadUpdateSchema.safeParse({status:"approved"}) → NOT success
 *            (status must be rejected/absent).
 *   CASE B — leadUpdateSchema.safeParse({doNotContact:false}) → NOT success.
 *   CASE C — leadUpdateSchema.safeParse({reviewStatus:"approved"}) → NOT success.
 *   CASE D — leadUpdateSchema.safeParse({contactName:"Ramesh"}) → success
 *            (cosmetic field allowed).
 *
 *   CASE E — price-change recipient set:
 *            - lead_F (flag=false, in registry) → must be SKIPPED.
 *            - lead_G (flag=false, NOT in registry) → must be SENT.
 *            skippedCount = 1, sentCount = 1.
 *
 *   CASE F — decideAutoReply on lead with status="not_interested",
 *            new message classified "interested" low-risk → blocked=true.
 *
 *   CASE G — decideAutoReply on lead with status="discovered" (normal),
 *            new message "interested" low-risk + safe mode + knowledge →
 *            canAutoSend=true (proves we didn't over-block).
 *
 * Run: npx tsx scripts/golden/golden-dnc-state-machine.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { repositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import { leadUpdateSchema } from "@/validation/schemas";
import { decideAutoReply } from "@/services/AutoReplyDecisionService";
import type { Lead, WhatsAppAgentSettings } from "@/lib/types";
import type { MessageClassification } from "@/conversations/message-classification";

const baseSettings: WhatsAppAgentSettings = {
  enabled: true,
  mode: "safe_auto_reply",
} as WhatsAppAgentSettings;

const interestedLowRisk: MessageClassification = {
  category: "interested",
  riskLevel: "low",
  confidence: 0.9,
  requiresHumanReview: false,
} as unknown as MessageClassification;

async function main() {
  // ---------------------------------------------------------------------------
  // CASES A-D — leadUpdateSchema is cosmetic-only (D-1).
  // ---------------------------------------------------------------------------
  {
    const a = leadUpdateSchema.safeParse({ status: "approved" });
    assert.equal(a.success, false, "CASE A: status must be rejected by leadUpdateSchema");
    console.log("  CASE A OK: leadUpdateSchema rejects `status` (cosmetic-only).");
  }
  {
    const b = leadUpdateSchema.safeParse({ doNotContact: false });
    assert.equal(b.success, false, "CASE B: doNotContact must be rejected");
    console.log("  CASE B OK: leadUpdateSchema rejects `doNotContact` (cosmetic-only).");
  }
  {
    const c = leadUpdateSchema.safeParse({ reviewStatus: "approved" });
    assert.equal(c.success, false, "CASE C: reviewStatus must be rejected");
    console.log("  CASE C OK: leadUpdateSchema rejects `reviewStatus` (cosmetic-only).");
  }
  {
    const d = leadUpdateSchema.safeParse({ contactName: "Ramesh", phone: "+919999999999", tags: ["vip"] });
    assert.equal(d.success, true, "CASE D: cosmetic fields must be accepted");
    console.log("  CASE D OK: leadUpdateSchema accepts cosmetic fields (contactName, phone, tags).");
  }

  // ---------------------------------------------------------------------------
  // CASE E — isContactBlocked uses the PERMANENT REGISTRY, not just the lead
  // flag (D-3). A lead whose flag was cleared but whose phone is in the
  // registry must still be blocked. This is the function price-change/send
  // (and every other send path) must call per recipient.
  // We seed a temp registry entry via mutateData, then check.
  // ---------------------------------------------------------------------------
  {
    const { isContactBlocked, registerDoNotContact } = await import("@/lib/dnc-registry");
    const { mutateData } = await import("@/lib/db");
    assert.equal(typeof isContactBlocked, "function", "CASE E: isContactBlocked must be exported from dnc-registry");

    const wsE = "ws_dnc_test_E";
    // A-7: the registry row is hung off a tenant, and on Postgres that tenant
    // has to exist. A file never asked, so this golden never said so.
    await ensureWorkspace(repositories, wsE, "DNC State Machine Golden E");
    const phoneF = "+919999900001";
    const phoneG = "+919999900002";

    // Clean slate for this workspace.
    await mutateData(async (d) => {
      d.doNotContactRegistry = (d.doNotContactRegistry || []).filter((e) => e.workspaceId !== wsE);
      return d;
    });
    // Register lead_F's phone permanently.
    await registerDoNotContact(wsE, { phone: phoneF, reason: "Customer opted out 2026-01-01", sourceLeadId: "lead_F" });

    const lead_F_flagCleared_inRegistry: Lead = {
      id: "lead_F", doNotContact: false, status: "discovered", whatsappNumber: phoneF,
    } as unknown as Lead;
    const lead_G_clean: Lead = {
      id: "lead_G", doNotContact: false, status: "discovered", whatsappNumber: phoneG,
    } as unknown as Lead;

    const blockedF = await isContactBlocked(wsE, lead_F_flagCleared_inRegistry);
    assert.equal(blockedF.blocked, true, "CASE E: lead_F (flag cleared but in registry) must be BLOCKED");

    const blockedG = await isContactBlocked(wsE, lead_G_clean);
    assert.equal(blockedG.blocked, false, "CASE E: lead_G (not in registry) must NOT be blocked");

    // Cleanup so the test is idempotent.
    await mutateData(async (d) => {
      d.doNotContactRegistry = (d.doNotContactRegistry || []).filter((e) => e.workspaceId !== wsE);
      return d;
    });

    console.log("  CASE E OK: isContactBlocked uses the registry — lead_F skipped (flag cleared but in registry), lead_G sent.");
  }

  // ---------------------------------------------------------------------------
  // CASE F — decideAutoReply blocks a not_interested lead permanently (D-4),
  // even when the new message is "interested" + low-risk.
  // ---------------------------------------------------------------------------
  {
    const notInterestedLead: Lead = {
      id: "lead_NI", status: "not_interested", doNotContact: false, reviewStatus: "approved",
    } as unknown as Lead;
    const decision = decideAutoReply({
      settings: baseSettings,
      classification: interestedLowRisk,
      lead: notInterestedLead,
      hasSupportingKnowledge: true,
    });
    assert.equal(decision.blocked, true, "CASE F: not_interested lead must be BLOCKED even on interested message");
    console.log("  CASE F OK: lead with status=not_interested → auto-reply blocked (permanent until manual reactivation).");
  }

  // ---------------------------------------------------------------------------
  // CASE G — decideAutoReply ALLOWS a normal lead (proves we didn't over-block).
  // ---------------------------------------------------------------------------
  {
    const normalLead: Lead = {
      id: "lead_normal", status: "discovered", doNotContact: false, reviewStatus: "approved",
    } as unknown as Lead;
    // D-2026-09-27-b: only a kind the owner ticked goes out by itself, so the
    // "not over-blocked" proof uses a ticked greeting.
    const decision = decideAutoReply({
      settings: { ...baseSettings, autoReplyTopics: ["greeting"] },
      classification: { ...interestedLowRisk, category: "greeting" } as MessageClassification,
      lead: normalLead,
      hasSupportingKnowledge: true,
      isGenericSafeReply: true,
    });
    assert.equal(decision.canAutoSend, true, "CASE G: normal lead with safe message → canAutoSend=true");
    console.log("  CASE G OK: normal lead + safe message → auto-reply allowed (no over-block).");
  }

  // ---------------------------------------------------------------------------
  // CASE H — removeFromDncRegistry actually removes the entry (D-2026-07-26-2).
  // The owner-only + reason + audit-log rules live in the route handler; here
  // we pin the registry-removal helper that the route MUST call.
  // ---------------------------------------------------------------------------
  {
    const { registerDoNotContact, removeFromDncRegistry, isContactBlocked } = await import("@/lib/dnc-registry");
    const wsH = "ws_dnc_test_H";
    await ensureWorkspace(repositories, wsH, "DNC State Machine Golden H");
    const phoneH = "+919999900003";
    // Clean slate.
    await removeFromDncRegistry(wsH, { whatsappNumber: phoneH });
    // Register, then confirm blocked.
    await registerDoNotContact(wsH, { phone: phoneH, reason: "opted out" });
    const before = await isContactBlocked(wsH, { whatsappNumber: phoneH } as unknown as Lead);
    assert.equal(before.blocked, true, "CASE H (setup): lead should be blocked after register");
    // Remove.
    const removed = await removeFromDncRegistry(wsH, { whatsappNumber: phoneH });
    assert.equal(removed, 1, "CASE H: removeFromDncRegistry returns count removed (1)");
    // After removal, no longer blocked.
    const after = await isContactBlocked(wsH, { whatsappNumber: phoneH } as unknown as Lead);
    assert.equal(after.blocked, false, "CASE H: lead no longer blocked after removeFromDncRegistry");
    // Idempotent: removing again returns 0.
    const removedAgain = await removeFromDncRegistry(wsH, { whatsappNumber: phoneH });
    assert.equal(removedAgain, 0, "CASE H: removeFromDncRegistry idempotent (0 on second call)");
    console.log("  CASE H OK: removeFromDncRegistry removes the entry (1), isContactBlocked then false, idempotent (0).");
  }

  console.log("\nPASS golden-dnc-state-machine: cosmetic-only PUT + registry DNC + permanent not_interested + remove-dnc (8 cases).");
}

main().catch(async (err) => {
  console.error("\nFAIL golden-dnc-state-machine:", err.message);
  // If isContactBlocked doesn't exist yet, surface a clear message.
  try {
    await import("@/lib/dnc-registry");
  } catch {
    console.error("(dnc-registry.isContactBlocked not found — the fix must add/export it.)");
  }
  process.exit(1);
});
