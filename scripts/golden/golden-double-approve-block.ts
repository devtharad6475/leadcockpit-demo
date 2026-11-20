/**
 * Golden test — Double-approve block (Cluster C fix C, session 19).
 *
 * PROVES approveAutoReplyLog refuses to re-approve a log that is already
 * approved (or auto_sent). Without that refusal, an accidental double-click on
 * Approve sends the customer the same WhatsApp message twice.
 *
 * Operator-confirmed rule (2026-07-21):
 *   "Block 2nd click — show an error like 'This message was already
 *    approved and sent.' The customer gets ONE message only."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REWRITTEN 2026-08-26 (S24-11). READ THIS BEFORE CHANGING ANYTHING.
 *
 * Until today this file tested nothing. Every case asserted against a set the
 * file declared itself:
 *
 *     const BLOCKED_FROM_REAPPROVE = new Set(["approved", "auto_sent"]);
 *     assert.ok(BLOCKED_FROM_REAPPROVE.has("approved"));
 *
 * It never imported AutoReplyReviewService. Deleting the guard from the
 * shipping service would not have turned this golden red — it asserted that a
 * literal it had just written was present in a set it had just written. It sat
 * on the board as proof that customers cannot be messaged twice.
 *
 * It now calls the REAL `approveAutoReplyLog` against real repositories, once
 * per status, and asserts on what the service actually does. The email channel
 * is used with an injected stub provider (the documented ApproveOptions
 * injection point) so the success path runs end to end without a network call
 * and without WhatsApp credentials.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * HAND-COMPUTED CONTRACT (src/services/AutoReplyReviewService.ts:31-42):
 *
 *   CASE A — status "approved"  → throws, message names the status.
 *   CASE B — status "auto_sent" → throws, message names the status.
 *   CASE C — status "pending_review" / "held_for_review" / "drafted" /
 *            "blocked" / "failed" → approve SUCCEEDS and the send happens.
 *   CASE D — status "rejected"  → throws "Rejected drafts cannot be approved"
 *            (the older, separate guard on the line above).
 *   CASE E — the refusal is a REFUSAL, not a silent skip: after a blocked
 *            re-approve, no second send was recorded. This is the case that
 *            actually encodes the operator's rule — "the customer gets ONE
 *            message only" is about sends, not about exceptions.
 *
 * MUTATION-TESTED 2026-08-26. Mutations on SHIPPING code, each compiling clean
 * under tsc, sources restored byte-identical (sha256) afterwards:
 *   m6 the `approved`/`auto_sent` guard never fires -> 18 passed, 6 failed.
 *      Both terminal statuses accepted the second click AND
 *      "1 send(s) happened despite the refusal" — the customer is messaged twice.
 *   m7 the guard narrowed to `approved` only -> 21 passed, 3 failed. Only the
 *      `auto_sent` half breaks. This is the half-fix the old file could never
 *      have caught, because the old file's Set was its own answer key.
 *   m8 the `rejected` guard never fires -> 21 passed, 3 failed, including
 *      "status \"rejected\" → nothing was sent" — a draft an operator explicitly
 *      REJECTED goes out to the customer. 3 of 3 caught.
 *
 * A note on how the mutations were written. `if (false)` does not compile here:
 * tsc treats the block as unreachable, `log` loses the narrowing it got from the
 * `if (!log) throw` above, and TS18048 fires. The guards were disabled with a
 * condition tsc cannot fold (`process.env.__MUTATION_NEVER_SET__ === "1"`), so
 * every mutation type-checked clean — a mutation that does not compile proves
 * nothing, because the suite would never have run it in the first place.
 *
 * Run: npx tsx scripts/golden/golden-double-approve-block.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { createAmbientRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { AutoReplyLog, Lead } from "@/lib/types";

const RUN_ID = `dab_${Date.now()}`;
const WS = `ws_${RUN_ID}`;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  OK: ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Records every send instead of making one. The real provider is never built. */
function makeMockEmailProvider() {
  const sent: string[] = [];
  return {
    sent,
    provider: {
      async send(input: { to: string }) {
        sent.push(input.to);
        return { ok: true, providerMessageId: `mock_${sent.length}`, errorMessage: undefined };
      },
    },
  };
}

async function main() {
  const repos = createAmbientRepos();
  await ensureWorkspace(repos, WS, "Double-approve golden");

  /** One lead + one log in the requested status. Returns the log id. */
  async function seed(tag: string, status: string): Promise<string> {
    const leadId = `lead_${RUN_ID}_${tag}`;
    const logId = `arlog_${RUN_ID}_${tag}`;
    await repos.lead.createLead({
      id: leadId,
      workspaceId: WS,
      status: "message_ready",
      reviewStatus: "approved",
      contactName: `Contact ${tag}`,
      companyName: `Company ${tag}`,
      // RFC 2606 reserved domain — unroutable by construction (N-SAFETY-1).
      email: `${tag}@example.com`,
    } as Partial<Lead>);
    await repos.autoReplyLog.create(WS, {
      id: logId,
      workspaceId: WS,
      leadId,
      channel: "email",
      // Required NOT NULL on Prisma, absent on JSON. A fixture that omits it
      // passes on the file substrate and fails on the one we ship (A-7).
      incomingMessage: `Inbound message that prompted the ${tag} draft`,
      status,
      body: `Draft for ${tag}`,
      generatedReply: `Draft for ${tag}`,
    } as Partial<AutoReplyLog>);
    return logId;
  }

  // ── CASE A + CASE B — the two terminal statuses are refused ──────────────
  console.log("\nCASE A/B — re-approving an already-sent message:");
  for (const status of ["approved", "auto_sent"]) {
    const logId = await seed(status, status);
    const mock = makeMockEmailProvider();
    let thrown: Error | undefined;
    try {
      await approveAutoReplyLog(WS, logId, { body: "second click" }, repos, `tester_${RUN_ID}`, {
        emailProvider: mock.provider as never,
      });
    } catch (error) {
      thrown = error as Error;
    }
    ok(`status "${status}" → approve THROWS`, thrown !== undefined, "the second click was accepted");
    // 2026-09-26: the refusal says what happened in plain words ("already
    // approved and sent" / "already sent automatically") instead of printing
    // the internal status code to the owner.
    ok(
      `status "${status}" → the error says it was already sent, in plain words`,
      Boolean(thrown && /already/i.test(thrown.message) && /sent/i.test(thrown.message) && !thrown.message.includes("auto_sent")),
      `got: ${thrown?.message ?? "(no error)"}`,
    );
    // CASE E, per status: the refusal must prevent the SEND, not merely follow it.
    ok(
      `status "${status}" → NO second message was sent (the customer gets one)`,
      mock.sent.length === 0,
      `${mock.sent.length} send(s) happened despite the refusal`,
    );
  }

  // ── CASE D — the older, separate guard on rejected drafts ────────────────
  console.log("\nCASE D — a rejected draft cannot be approved:");
  {
    const logId = await seed("rejected", "rejected");
    const mock = makeMockEmailProvider();
    let thrown: Error | undefined;
    try {
      await approveAutoReplyLog(WS, logId, { body: "approve a rejected draft" }, repos, `tester_${RUN_ID}`, {
        emailProvider: mock.provider as never,
      });
    } catch (error) {
      thrown = error as Error;
    }
    ok("status \"rejected\" → approve THROWS", thrown !== undefined);
    ok(
      "the rejected refusal is its OWN message, not the double-send one",
      Boolean(thrown && /rejected/i.test(thrown.message) && !thrown.message.includes("double-send")),
      `got: ${thrown?.message ?? "(no error)"}`,
    );
    ok("status \"rejected\" → nothing was sent", mock.sent.length === 0);
  }

  // ── CASE C — every non-terminal status still approves normally ───────────
  // The guard must block exactly two statuses. A guard that blocks too much is
  // as broken as one that blocks too little: it strands drafts in the queue.
  console.log("\nCASE C — non-terminal statuses still approve:");
  for (const status of ["pending_review", "held_for_review", "drafted", "blocked", "failed"]) {
    const logId = await seed(status, status);
    const mock = makeMockEmailProvider();
    let thrown: Error | undefined;
    try {
      await approveAutoReplyLog(WS, logId, { body: `approving from ${status}` }, repos, `tester_${RUN_ID}`, {
        emailProvider: mock.provider as never,
      });
    } catch (error) {
      thrown = error as Error;
    }
    ok(`status "${status}" → approve SUCCEEDS`, thrown === undefined, `threw: ${thrown?.message ?? ""}`);
    ok(`status "${status}" → the message actually went out`, mock.sent.length === 1, `${mock.sent.length} send(s)`);
    const after = await repos.autoReplyLog.getById(WS, logId);
    ok(`status "${status}" → the log is now "approved"`, after?.status === "approved", `got ${after?.status}`);
  }

  // ── CASE F — five approvals of one draft AT THE SAME TIME ────────────────
  // 2026-09-26 break test: each passed the "already approved?" check before
  // any of them had marked the draft, so all of them sent.
  console.log("\nCASE F — five approve clicks arriving together:");
  {
    const logId = await seed("burst", "pending");
    const mock = makeMockEmailProvider();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      approveAutoReplyLog(WS, logId, { body: "burst" }, repos, `tester_${RUN_ID}`, { emailProvider: mock.provider as never })));
    ok("exactly one approval succeeds", results.filter((r) => r.status === "fulfilled").length === 1, results.map((r) => r.status).join(", "));
    ok("the customer gets exactly one message", mock.sent.length === 1, `${mock.sent.length} send(s)`);
  }

  console.log(`\n=== double-approve-block: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("FAIL golden-double-approve-block — the double-send guard regressed.");
    process.exit(1);
  }
  console.log("PASS golden-double-approve-block: the real service refuses a second approve; other statuses unaffected.");
}

main().catch((err) => {
  console.error("\nFAIL golden-double-approve-block:", err instanceof Error ? err.message : err);
  process.exit(1);
});
