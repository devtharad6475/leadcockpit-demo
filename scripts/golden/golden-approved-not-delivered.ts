/**
 * Golden test — an approved reply that was NEVER DELIVERED must never look
 * delivered (N-UX-4).
 *
 * WHY THIS EXISTS (2026-08-20, S14-1)
 * -----------------------------------
 * `approveAutoReplyLog` stores `status: "approved"` whenever the send did not
 * hard-fail. That is CORRECT at the data layer and is already pinned by CASE C
 * of golden-whatsapp-outbound-send: with the 24-hour WhatsApp window closed and
 * no template chosen, the row is stored as `approved` + `sendStatus: "blocked"`,
 * and the outreach row underneath honestly says a human still has to deliver it.
 *
 * The APPROVALS LIST is what an operator actually scans, and there the row read
 *
 *     "Approved - Manual Send"   in bg-success-bg text-success-fg
 *
 * — the SAME success green as a message that really reached the customer. Four
 * of the six send outcomes fell through to it: `dry_run`, `blocked`,
 * `not_attempted`, and rows with no sendStatus at all. Nothing was delivered.
 * Nothing had been sent manually either — the label invented a fact.
 *
 * That is the worst class of bug this product can have. Everything else here is
 * a lead that goes stale; this one lets an owner believe a customer was
 * answered when the customer heard nothing, and the owner has no reason to look
 * again.
 *
 * THE RULE, now enforced in exactly one place
 * (src/lib/reply-delivery-state.ts):
 *
 *     A reply is DELIVERED only when the provider says `sent`.
 *     Nothing that was not delivered may carry the success tone.
 *     A row that was not delivered must SAY it was not delivered, and say why.
 *
 * Hand-computed BEFORE the assertions (the Golden Thread):
 *
 *   CASE A — the delivered map. Across all six `sendStatus` values, exactly
 *     ONE (`sent`) yields delivered=true. Hand-computed:
 *       sent → true · failed → false · blocked → false ·
 *       not_configured → false · dry_run → false · not_attempted → false.
 *
 *   CASE B — the colour rule, swept over every sendStatus × every status
 *     (6+1 × 8 = 56 combinations). Expected: `tone === "success"` is true for
 *     EXACTLY the combinations where delivered is true, and for every
 *     combination the operator would read as "the owner sent this" (status
 *     approved / auto_sent) that was NOT delivered, the label contains the
 *     words "Not Delivered" and the explanation says the customer got nothing.
 *
 *   CASE C — the exact N-UX-4 scenarios, one at a time, with the old buggy
 *     label named in the failure message so a regression is unmistakable.
 *
 *   CASE D — the UI is wired to the chokepoint and cannot paint its own green:
 *     page.tsx imports replyDeliveryState, both replyStatusDisplay and
 *     sendStatusText route through it, the badge function contains NO literal
 *     colour class, and the string "Approved - Manual Send" is gone.
 *
 *   CASE E — the real thing. A real lead whose last inbound message was 72
 *     hours ago, real credentials, a real `approveAutoReplyLog` call, real
 *     persistence — then the ACTUAL stored row is fed to the chokepoint.
 *     Expected: the row is `approved`/`blocked` (unchanged, so CASE C of
 *     golden-whatsapp-outbound-send still holds), and what the operator sees
 *     is NOT delivered, NOT success-toned, and names the reason.
 *
 * Test isolation (Gate #8): own workspace ids (ws_notdeliv_*), JSON substrate,
 * fetch restored in a finally, no network (asserted).
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-approved-not-delivered.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { replyDeliveryState, REPLY_SEND_STATUSES } from "@/lib/reply-delivery-state";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { WhatsAppCredentialService } from "@/services/WhatsAppCredentialService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Every status an AutoReplyLog row can hold (types.ts:1502). */
const REPLY_STATUSES = [
  "drafted",
  "auto_sent",
  "held_for_review",
  "blocked",
  "failed",
  "approved",
  "rejected",
  "acknowledged",
] as const;

/** Not a credential. A literal test string; never printed. */
const TEST_ACCESS_TOKEN = "golden-test-token-not-a-real-credential";
const PHONE_NUMBER_ID = "1555000222";

function installFetchStub() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ messages: [{ id: "wamid.SHOULD_NOT_HAPPEN" }] }),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function seedLead(repos: RepositoryBundle, ws: string, phone: string, lastInboundAt: string) {
  const lead = await repos.lead.createLead({
    workspaceId: ws,
    companyName: `Customer ${ws}`,
    contactName: "Test Buyer",
    whatsappNumber: phone,
    source: "manual",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
    doNotContact: false,
    consentStatus: "none",
  });
  return repos.lead.updateLead(ws, lead.id, { lastInboundAt });
}

async function seedDraftReply(repos: RepositoryBundle, ws: string, leadId: string, body: string) {
  const reply = await repos.reply.create({ workspaceId: ws, leadId, channel: "whatsapp", rawText: "customer message" });
  return repos.autoReplyLog.create(ws, {
    leadId,
    replyId: reply.id,
    channel: "whatsapp",
    incomingMessage: "customer message",
    retrievedContext: {},
    generatedReply: body,
    canAutoSend: false,
    needsHumanReview: true,
    status: "held_for_review",
    reason: "Held for owner review.",
  });
}

async function main() {
  for (const [status, label] of [
    ["held_for_review", "Needs review"],
    ["drafted", "Draft Prepared"],
    ["rejected", "Dismissed"],
    ["approved", "Approved, not delivered"],
  ]) {
    const state = replyDeliveryState({ status, sendStatus: "not_attempted" });
    assert(state.label === label, `Unsent ${status} must say ${label}, got ${state.label}`);
    assert(!state.delivered, `Unsent ${status} must not claim delivery`);
  }
  console.log("✅ Pending and dismissed drafts never imply owner approval");
  // ─── CASE A: exactly one send outcome counts as delivered ──────────────────
  {
    const expected: Record<string, boolean> = {
      sent: true,
      failed: false,
      blocked: false,
      not_configured: false,
      dry_run: false,
      not_attempted: false,
      // 2026-09-29 (walk-through R2): the owner sent it from their own phone and
      // said so. Delivered — and labelled "Sent by you", never "Sent on WhatsApp".
      sent_by_owner: true,
      unconfirmed: false,
    };
    assert(
      REPLY_SEND_STATUSES.length === Object.keys(expected).length,
      `CASE A: the send-status list changed (${REPLY_SEND_STATUSES.length} values, this golden hand-computed ` +
      `${Object.keys(expected).length}). A NEW outcome must be classified as delivered or not-delivered here before it ships.`,
    );
    for (const sendStatus of REPLY_SEND_STATUSES) {
      const state = replyDeliveryState({ status: "approved", sendStatus });
      assert(
        state.delivered === expected[sendStatus],
        `CASE A: sendStatus "${sendStatus}" → delivered=${state.delivered}, hand-computed ${expected[sendStatus]}. ` +
        "Only the provider saying \"sent\", or the owner saying they sent it themselves, means the customer got the message.",
      );
    }
    const deliveredCount = REPLY_SEND_STATUSES.filter((s) => replyDeliveryState({ status: "approved", sendStatus: s }).delivered).length;
    assert(deliveredCount === 2, `CASE A: exactly two send outcomes may count as delivered (sent, sent_by_owner), got ${deliveredCount}`);
    assert(replyDeliveryState({ status: "approved", sendStatus: "sent_by_owner" }).label === "Sent by you", "CASE A: an owner-sent reply must never be labelled as a WhatsApp send");
    console.log("✅ CASE A — of the 8 outcomes only sent and sent_by_owner confirm delivery; unconfirmed preserves uncertainty");
  }

  // ─── CASE B: success green is reachable ONLY through real delivery ─────────
  {
    let combos = 0;
    let flaggedNotDelivered = 0;
    for (const status of REPLY_STATUSES) {
      for (const sendStatus of [...REPLY_SEND_STATUSES, undefined]) {
        combos += 1;
        const state = replyDeliveryState({ status, sendStatus, providerError: "24-hour window closed" });

        // B1 — the colour and the fact can never disagree.
        assert(
          (state.tone === "success") === state.delivered,
          `CASE B: status="${status}" sendStatus="${sendStatus}" → tone="${state.tone}" but delivered=${state.delivered}. ` +
          "Success styling is reserved for a message that actually reached the customer; this combination would show " +
          "the operator green for a message that did not.",
        );

        // B2 — a row the operator reads as "sent by us" that was not delivered
        // must say so in the label itself, not only in a tooltip.
        const looksSentToOperator = status === "approved" || status === "auto_sent";
        if (looksSentToOperator && !state.delivered) {
          flaggedNotDelivered += 1;
          if (sendStatus === "unconfirmed") {
            assert(state.label === "Approved, delivery unconfirmed", "CASE B: ambiguous delivery must say unconfirmed, not definitely unsent");
            assert(/Check the customer's conversation before sending again/.test(state.explanation), "CASE B: uncertain delivery must require checking before another send");
            assert(!/received nothing|not delivered/.test(state.explanation), "CASE B: uncertainty must not be presented as a confirmed failure");
            continue;
          }
          assert(
            /not delivered/i.test(state.label),
            `CASE B: status="${status}" sendStatus="${sendStatus}" was NOT delivered, but the badge reads ` +
            `"${state.label}" — it must contain "Not Delivered". The original defect was exactly this: the badge ` +
            "read \"Approved - Manual Send\" for a message nobody sent.",
          );
          assert(
            /received nothing|nothing left this system|no record of this message reaching/i.test(state.explanation),
            `CASE B: status="${status}" sendStatus="${sendStatus}" explanation does not tell the operator the customer ` +
            `got nothing: "${state.explanation}"`,
          );
        }
      }
    }
    assert(combos === REPLY_STATUSES.length * (REPLY_SEND_STATUSES.length + 1), `CASE B: expected full sweep, ran ${combos}`);
    assert(flaggedNotDelivered >= 10, `CASE B: expected at least 10 approved-looking-but-undelivered combinations, saw ${flaggedNotDelivered}`);
    console.log(`✅ CASE B — swept ${combos} combinations; ${flaggedNotDelivered} rows without confirmed delivery use failure or explicit uncertainty labels; none use success tone`);
  }

  // ─── CASE C: the four outcomes that used to render as success green ────────
  {
    const wasGreenBefore: Array<{ sendStatus?: string; why: string }> = [
      { sendStatus: "dry_run", why: "dry-run mode: nothing is ever sent" },
      { sendStatus: "blocked", why: "the 24h window closed with no template" },
      { sendStatus: "not_attempted", why: "no send was attempted at all" },
      { sendStatus: undefined, why: "an older row with no send record" },
    ];
    for (const { sendStatus, why } of wasGreenBefore) {
      const state = replyDeliveryState({ status: "approved", sendStatus });
      assert(
        !state.delivered && state.tone !== "success",
        `CASE C: approved + sendStatus="${sendStatus}" (${why}) renders as delivered/success again. This is the exact ` +
        "N-UX-4 regression: it used to read \"Approved - Manual Send\" in bg-success-bg, identical to a real send.",
      );
      assert(
        state.label !== "Approved - Manual Send",
        `CASE C: the old lying label "Approved - Manual Send" is back for sendStatus="${sendStatus}". Nobody sent it ` +
        "manually — the system invented that fact.",
      );
      assert(
        /not delivered/i.test(state.label),
        `CASE C: approved + sendStatus="${sendStatus}" (${why}) must be labelled "Not Delivered", got "${state.label}"`,
      );
    }
    // "Not delivered" is not enough on its own. The operator has to know WHICH
    // of these four happened, because the next action differs every time: a
    // dry-run means turn sending on, a blocked send means pick a template, a
    // missing send record means go and check the phone. Collapsing them into
    // one generic sentence would satisfy every assertion above and still leave
    // the owner guessing, so the reasons are pinned as mutually distinct.
    const reasons = wasGreenBefore.map(({ sendStatus }) => replyDeliveryState({ status: "approved", sendStatus }).explanation);
    const distinct = new Set(reasons);
    assert(
      distinct.size === reasons.length,
      `CASE C: the four not-delivered outcomes must each explain THEMSELVES — got ${distinct.size} distinct ` +
      `explanations for ${reasons.length} different causes:\n  ${reasons.join("\n  ")}`,
    );
    console.log("✅ CASE C — all four formerly-green outcomes (dry_run, blocked, not_attempted, no-status) now read \"Not Delivered\", each with its own reason");
  }

  // ─── CASE D: the screen cannot paint its own green ─────────────────────────
  {
    const page = readFileSync(resolve("src/app/page.tsx"), "utf8");
    // Assertions about what the screen DOES must not trip over comments that
    // merely describe the old defect, so strip line comments for those checks.
    const stripComments = (src: string) => src.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    const pageCode = stripComments(page);
    assert(
      /import \{[^}]*replyDeliveryState[^}]*\} from "@\/lib\/reply-delivery-state"/.test(page),
      "CASE D: src/app/page.tsx no longer imports replyDeliveryState — the approvals UI has gone back to deciding " +
      "delivery wording on its own, which is how N-UX-4 happened.",
    );

    const badge = page.slice(page.indexOf("function replyStatusDisplay("));
    const badgeBody = badge.slice(0, badge.indexOf("\n}"));
    assert(
      badgeBody.includes("replyDeliveryState("),
      "CASE D: replyStatusDisplay() no longer calls replyDeliveryState().",
    );
    assert(
      !/bg-success-bg|bg-warning-bg|bg-danger-bg/.test(stripComments(badgeBody)),
      "CASE D: replyStatusDisplay() contains a literal colour class again. Every colour must come from the tone map, " +
      `otherwise a hand-written "bg-success-bg" can reappear on an undelivered row. Body:\n${badgeBody}`,
    );

    const text = page.slice(page.indexOf("function sendStatusText("));
    const textBody = text.slice(0, text.indexOf("\n}"));
    assert(
      textBody.includes("replyDeliveryState("),
      "CASE D: sendStatusText() no longer calls replyDeliveryState(), so the sentence under \"WhatsApp send status\" " +
      "can drift out of agreement with the badge beside it.",
    );

    assert(
      !pageCode.includes("Approved - Manual Send"),
      "CASE D: the string \"Approved - Manual Send\" is back in page.tsx. Nothing in this system records a manual send, " +
      "so that label asserts a fact the product does not know.",
    );
    console.log("✅ CASE D — page.tsx routes both the badge and the sentence through the chokepoint and holds no colour literals or the old label");
  }

  // ─── CASE E: a real approve, with the window closed, read back as shown ────
  {
    const repos = createJsonRepos();
    delete process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
    delete process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;

    const WS = "ws_notdeliv_e";
    await repos.workspace.create({ id: WS, name: "Not delivered E", status: "active" });
    await new WhatsAppCredentialService(repos).save(WS, { accessToken: TEST_ACCESS_TOKEN, phoneNumberId: PHONE_NUMBER_ID });
    const lead = await seedLead(repos, WS, "+91 00000 00081", hoursAgo(72));
    const log = await seedDraftReply(repos, WS, lead.id, "Following up three days later.");

    const stub = installFetchStub();
    let approved;
    try {
      approved = await approveAutoReplyLog(WS, log.id, {}, repos, "owner");
    } finally {
      stub.restore();
    }

    assert(stub.calls.length === 0, `CASE E: the 24h gate must block before any network call, got ${stub.calls.length}`);

    // The DATA layer is unchanged on purpose — golden-whatsapp-outbound-send
    // CASE C pins exactly this, and a status rename would have broken it.
    assert(approved.status === "approved", `CASE E: the stored status stays "approved" (pinned by golden-whatsapp-outbound-send CASE C), got "${approved.status}"`);
    assert(approved.sendStatus === "blocked", `CASE E: the stored sendStatus stays "blocked", got "${approved.sendStatus}"`);

    // Read the row back out of the database rather than trusting the return
    // value — the operator sees what was PERSISTED.
    const stored = await repos.autoReplyLog.getById(WS, log.id);
    assert(stored, "CASE E: the approved row must be readable back from the database");
    const shown = replyDeliveryState({ status: String(stored.status), sendStatus: stored.sendStatus, providerError: stored.providerError });

    assert(
      shown.delivered === false,
      "CASE E: a real approve with the 24-hour window closed reports delivered=true. The customer received NOTHING — " +
      "no network call was even made.",
    );
    assert(
      shown.tone !== "success",
      `CASE E: the operator would see tone "${shown.tone}" (success styling) for a message that never left the machine.`,
    );
    assert(
      /not delivered/i.test(shown.label),
      `CASE E: the badge for this real, persisted row reads "${shown.label}" — it must say Not Delivered.`,
    );
    assert(
      /template/i.test(shown.explanation),
      `CASE E: the explanation must carry the provider's own reason so the owner knows to pick a template, got "${shown.explanation}"`,
    );

    console.log(`✅ CASE E — real approve, window closed 72h: stored as approved/blocked (unchanged), shown to the operator as "${shown.label}" with the reason "${shown.explanation}"`);
  }

  console.log("\n✅✅✅ All approved-but-not-delivered golden cases PASSED (A–E). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
