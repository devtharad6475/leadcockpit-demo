/**
 * Golden test — an approval that cannot be delivered must not be recorded as
 * one (N-DATA-10).
 *
 * WHY THIS EXISTS (2026-08-20)
 * ----------------------------
 * Found in the SHIP database, by looking at the screen rather than the code.
 * The AI Drafts queue held two cards. One of them read:
 *
 *     Unknown lead
 *     no contact on file — this cannot be delivered
 *
 * and still offered an Approve button. The row was `auto_reply_logs` id
 * `cmszwi1yy0002n8v31gsh366j`, pointing at lead `seed_lead_hot` — a lead that
 * had been deleted. A scan of all 13 tables carrying a lead reference found
 * exactly one such row, so the blast radius was one draft; the mechanism that
 * produced it was general.
 *
 * HOW THE ORPHAN GOT THERE. `scripts/purge-seed-demo-rows.ts` deleted rows
 * whose **id** begins with `seed_`, and its docstring claimed it also removed
 * "whatever the database cascades from those". Nothing cascaded:
 * `auto_reply_logs.lead_id` carries no foreign key (tracked as N-DATA-4). The
 * seeder assigns literal `seed_` ids to the rows it names and lets Prisma
 * generate a cuid for the ones it does not — the auto-reply log is one of
 * those — so the purge deleted the parent and left the child.
 *
 * WHY IT MATTERED MORE THAN A STRAY ROW. Approving that draft did not fail. It
 * quietly half-succeeded:
 *   - `lead` resolved to `undefined`, so `to` was the empty string;
 *   - the WhatsApp branch of `sendApprovedReply` did not check for an empty
 *     destination (the EMAIL branch already did — the two had drifted apart),
 *     so the outcome depended on whether credentials happened to be
 *     configured. `not_configured` is not `"failed"`, so nothing threw;
 *   - the `if (lead)` guard then skipped BOTH the outreach row and the lead
 *     status update;
 *   - and the log was still marked **approved**.
 * The operator ends up reading "approved" on a message nobody received, with
 * not even a failed outreach row to contradict it. That is worse than N-UX-4,
 * where the outreach row at least tells the truth.
 *
 *   CASE A — a draft whose lead no longer exists must be REFUSED, and must
 *     still be sitting in the queue afterwards. Not silently approved.
 *
 *   CASE B — a draft whose lead exists but has no WhatsApp number and no phone
 *     must be refused too, and refused BEFORE any credential check, so the
 *     answer does not depend on the environment. This is the asymmetry with
 *     the email branch, closed.
 *
 *   CASE C — the purge script must match on the lead reference, not on the id
 *     alone. This is the regression that created the orphan in the first
 *     place, and it is invisible without a database, so it is pinned as a
 *     source assertion.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-orphan-draft-refusal.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function expectThrows(fn: () => Promise<unknown>, label: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`ASSERTION FAILED: ${label} — the call SUCCEEDED. It must throw.`);
}

async function seedDraft(repos: RepositoryBundle, ws: string, leadId: string) {
  return repos.autoReplyLog.create(ws, {
    leadId,
    channel: "whatsapp",
    incomingMessage: "Can you confirm exact price for 500 meters?",
    retrievedContext: {},
    generatedReply: "Let me confirm and revert shortly.",
    canAutoSend: false,
    needsHumanReview: true,
    status: "held_for_review",
    reason: "Held for owner review.",
  });
}

async function main() {
  const repos = createRepositories();

  // ─── CASE A: the lead is gone ─────────────────────────────────────────────
  {
    const WS = "ws_orphan_a";
    await repos.workspace.create({ id: WS, name: "Orphan draft A", status: "active" });
    // A lead id that was never created — exactly the state the ship database
    // was in after the parent was deleted and this row was not.
    const log = await seedDraft(repos, WS, "lead_deleted_by_a_purge");

    const message = await expectThrows(
      () => approveAutoReplyLog(WS, log.id, {}, repos),
      "CASE A: approving a draft whose lead no longer exists",
    );
    assert(
      /no longer exists/i.test(message),
      `CASE A: the refusal must say the customer record is gone, so the operator knows why. Got: ${message}`,
    );
    assert(
      message.includes("lead_deleted_by_a_purge"),
      `CASE A: the refusal must name the missing record. Got: ${message}`,
    );

    const after = await repos.autoReplyLog.getById(WS, log.id);
    assert(after, "CASE A: the draft vanished — a refused approval must leave the row alone");
    assert(
      after.status === "held_for_review",
      `CASE A: the draft is now "${after.status}". A refused approval must NOT mark the draft approved — ` +
      "that is the whole defect: an approval recorded for a message nobody received.",
    );
    console.log("✅ CASE A — a draft whose customer record is gone is refused, and stays in the queue");
  }

  // ─── CASE B: the lead exists but there is nowhere to send ─────────────────
  {
    const WS = "ws_orphan_b";
    await repos.workspace.create({ id: WS, name: "Orphan draft B", status: "active" });
    const lead = await repos.lead.createLead({
      workspaceId: WS,
      companyName: "No Contact Textiles",
      contactName: "Unreachable Buyer",
      // No whatsappNumber. No phone. This is the "no contact on file" card.
      source: "manual",
      status: "approved",
      reviewStatus: "approved",
      enrichmentStatus: "completed",
      doNotContact: false,
      consentStatus: "none",
    });
    const log = await seedDraft(repos, WS, lead.id);

    const message = await expectThrows(
      () => approveAutoReplyLog(WS, log.id, {}, repos),
      "CASE B: approving a draft for a lead with no number",
    );
    assert(
      /no WhatsApp number or phone/i.test(message),
      `CASE B: the refusal must name the missing thing — a number — the way the email branch names a missing address. Got: ${message}`,
    );

    const after = await repos.autoReplyLog.getById(WS, log.id);
    assert(
      after && after.status === "held_for_review",
      `CASE B: the draft is now "${after?.status}". A send with no recipient is never a send, whatever the credential state.`,
    );

    // The point of CASE B is WHERE the refusal happens. No WhatsApp credentials
    // are configured in this golden's environment, so under the old code the
    // path returned `not_configured` and the approval went through. Reaching
    // the message above proves the destination is checked BEFORE the provider.
    const outreach = await repos.outreachActivity.listByWorkspace(WS);
    assert(
      outreach.length === 0,
      `CASE B: ${outreach.length} outreach row(s) were written for a message that was never sent. A refused approval must leave no trace of delivery.`,
    );
    console.log("✅ CASE B — a draft with no destination is refused before the provider is consulted, and writes no outreach row");
  }

  // ─── CASE C: the purge must not leave children behind ─────────────────────
  {
    const purge = readFileSync(resolve("scripts/purge-seed-demo-rows.ts"), "utf8");
    assert(
      /lead_id LIKE 'seed\\_%'/.test(purge),
      "CASE C: purge-seed-demo-rows.ts no longer matches rows by their LEAD reference, only by their own id. " +
      "The seeder gives literal `seed_` ids to the rows it names and lets the database generate ids for the rest, " +
      "and auto_reply_logs.lead_id has no foreign key to cascade from — so id-only matching deletes the lead and " +
      "leaves its draft orphaned in the operator's approval queue. That is exactly how N-DATA-10 happened.",
    );
    assert(
      /information_schema\.columns/.test(purge) && /column_name = 'lead_id'/.test(purge),
      "CASE C: the set of lead-referencing tables must be discovered from the database, not hardcoded — a hardcoded " +
      "list is one more thing to forget when a table is added",
    );
    console.log("✅ CASE C — the seed purge deletes the whole subtree, with or without a foreign key underneath it");
  }

  console.log("\n✅✅✅ All orphan-draft-refusal golden cases PASSED (A–C). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
