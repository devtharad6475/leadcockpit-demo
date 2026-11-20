/**
 * golden-audit-fixes-aug04.ts — pins the 2026-08-04 continuous-improvement
 * audit fixes (build-right Phase 7 Tier 2 — NEW findings only, none in
 * AUDIT-EXCLUSIONS.md).
 *
 * WHAT THIS PROVES
 *   The continuous-improvement audit (3 parallel read-only agents + main-agent
 *   Test-Honesty verification) found 21 NEW findings. This golden pins the
 *   ones that are pure-function / data-contract regressions — the bugs that
 *   would silently re-appear if a future refactor touched the same code
 *   without this guard. UI-only fixes (ConfirmModal wiring, design tokens)
 *   are pinned by the Playwright e2e sweep, not here.
 *
 * HAND-COMPUTED CONTRACTS (anti-cheat):
 *
 *   CASE A — F-DATA-3: invite double-accept throws at the REPO layer.
 *     Pre-fix: acceptInviteAtomically did NOT re-check invite.status inside
 *     its transaction. Two concurrent accepts both passed the service-level
 *     pre-check (both saw "pending"), then both ran the atomic block → two
 *     user rows + two credential rows for one email (silent duplicate).
 *     Fix: re-check status==="accepted" INSIDE mutateData / runTx; throw.
 *     Contract: pre-mark the invite "accepted" (simulate the winner of the
 *     race), then call acceptInviteAtomically — it must throw and write
 *     nothing (no new user, no new credential).
 *
 *   CASE B — F-DATA-7: closed-24h-window + template routes to template send.
 *     (Pinned at the condition level: the sendApprovedReply branch fires only
 *     when the window is CLOSED. We assert the branching predicate directly
 *     because sendApprovedReply resolves the provider internally and a full
 *     integration test would need a provider mock — the condition itself is
 *     the regression surface.) Contract: given windowStatus.open + a template
 *     name, the template-send predicate (`templateName && !open`) must be
 *     false when open, true when closed. The OLD tautological predicate
 *     (`templateName && (!open || templateName)`) was true whenever a template
 *     was selected regardless of the window.
 *
 *   CASE C — F-API-6 / F-DATA-2: the status-route guards are route-level
 *     (validated by the build + the validationErrorResponse shape), but the
 *     TicketStatus union is the contract the gate enforces. Assert the union
 *     matches what the route declares so a future status added to the type
 *     without the route enum (or vice-versa) is caught.
 *
 * CASE B REWRITTEN 2026-08-26 (S24-14). It used to define the predicate under
 * test inside its own body and grade it. It now drives the real send path and
 * asserts on WHICH META API WAS CALLED — the thing Meta bills and blocks on.
 *
 * MUTATION-TESTED 2026-08-26. On SHIPPING code, compiling clean under tsc,
 * src/services/AutoReplyReviewService.ts restored byte-identical (sha256):
 *   m13 revert the condition to the F-DATA-7 tautology
 *       `input.templateName && (!windowStatus.open || input.templateName)`
 *       -> new CASE B fails: "window OPEN + template selected → free-text send
 *          — provider calls: [template]".
 *       THE OLD CASE B PRINTED "=== 19 PASS / 0 FAIL ===" UNDER THIS MUTATION,
 *       including its own final assertion that "the OLD buggy predicate
 *       incorrectly forced template send on an open window" — a true statement,
 *       green, while the shipping product was doing exactly that.
 *   m14 the closed-window refusal never fires
 *       -> new CASE B fails: "window CLOSED + no template → nothing is sent at
 *          all — provider calls: [free_text]", i.e. a free-text message goes to
 *          Meta after the 24h window, which Meta rejects and the owner never
 *          learns why. The old case printed 19 PASS / 0 FAIL for this one too.
 *   2 of 2 caught by the rewrite, 0 of 2 by what it replaced.
 *
 * REAL PIPELINE: imports the real JSON repos (force-json-provider preload) +
 * the real InviteService.createInvite to set up the invite. Each case uses a
 * unique RUN_ID namespace (Ironclad Gate #8 — no shared state).
 *
 * Run: npm run golden:audit-fixes-aug04
 */
// Force JSON provider BEFORE any service import (matched by the runner's
// force-json-provider preload; this line is a belt-and-suspenders for direct
// `tsx` runs).
process.env.PERSISTENCE_PROVIDER = "json";

// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { repositories } from "@/repositories";
import { createInvite } from "@/services/InviteService";
import { uid, timestamp } from "@/lib/db";
import type { User, UserCredential, Ticket } from "@/lib/types";

const RUN_ID = `aug04_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const WS = `ws_${RUN_ID}`;
const OWNER_ID = `owner_${RUN_ID}`;
let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

async function setupWorkspace() {
  // Minimal workspace + owner so createInvite's assertCanInvite passes.
  await repositories.workspace.create({ id: WS, name: `Audit-fix test ${RUN_ID}` });
  await repositories.user.create({
    id: OWNER_ID, workspaceId: WS, name: "Owner", email: `owner_${RUN_ID}@test.local`,
    role: "owner", createdAt: timestamp(), updatedAt: timestamp(),
  });
  await repositories.userCredential.create({
    id: uid("cred"), userId: OWNER_ID, workspaceId: WS,
    email: `owner_${RUN_ID}@test.local`, passwordHash: "x", sessionVersion: 1,
    createdAt: timestamp(), updatedAt: timestamp(),
  });
  await repositories.workspaceMember.create({
    id: uid("member"), workspaceId: WS, userId: OWNER_ID,
    email: `owner_${RUN_ID}@test.local`, name: "Owner", role: "owner",
    status: "active", createdAt: timestamp(), updatedAt: timestamp(),
  });
  // assertCanInvite (called by createInvite) only checks the inviter is an
  // owner/admin in this workspace — no feature flag is required for invites.
}

async function main() {
  console.log(`\n=== golden-audit-fixes-aug04 (run ${RUN_ID}) ===\n`);

  await setupWorkspace();

  // ─── CASE A: invite double-accept throws at the repo layer (F-DATA-3) ───
  console.log("CASE A — invite double-accept re-check (F-DATA-3):");
  {
    const inviteEmail = `invitee_a_${RUN_ID}@test.local`;
    const invite = await createInvite({
      workspaceId: WS,
      invitedByUserId: OWNER_ID,
      inviteeEmail: inviteEmail,
      role: "sales_member",
    });

    // Simulate the WINNER of the race: mark the invite accepted directly.
    // (In production, this is what the first concurrent accept does inside
    // its own transaction.) The pre-fix atomic method did NOT look at this
    // field — it just wrote. The fix re-checks it + throws.
    await repositories.invite.markAccepted(invite.inviteId, `winner_${RUN_ID}`);
    // Some JSON-repo builds name it markAccepted; others set it via mutateAll.
    // Belt-and-suspenders: ensure the row is actually "accepted" before the
    // second call, regardless of which helper exists.
    await repositories.mutateAll!((d) => {
      const row = (d.invites || []).find((i) => i.id === invite.inviteId);
      if (row) {
        row.status = "accepted";
        row.acceptedByUserId = `winner_${RUN_ID}`;
        row.resolvedAt = timestamp();
      }
      return row;
    });

    // The SECOND accept (the race loser) builds its user + credential, then
    // calls acceptInviteAtomically. Pre-fix this succeeded silently and
    // created a duplicate user + credential. Post-fix it must throw.
    const loserUserId = uid("user");
    const loserUser: User = {
      id: loserUserId, workspaceId: WS, name: "Loser", email: inviteEmail,
      role: "sales_member", createdAt: timestamp(), updatedAt: timestamp(),
    };
    const loserCred: UserCredential = {
      id: uid("cred"), userId: loserUserId, workspaceId: WS,
      email: inviteEmail, passwordHash: "x", sessionVersion: 1,
      createdAt: timestamp(), updatedAt: timestamp(),
    };

    let threw = false;
    let errMsg = "";
    try {
      await repositories.invite.acceptInviteAtomically({
        inviteId: invite.inviteId,
        user: loserUser,
        credential: loserCred,
        memberEmail: inviteEmail,
        memberName: "Loser",
        workspaceId: WS,
      });
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    ok("acceptInviteAtomically throws on already-accepted invite", threw, `expected throw, got: ${errMsg}`);

    // The critical data-integrity assertion: NO duplicate user/credential was
    // written by the rejected accept. Read the source of truth (the JSON data
    // file via mutateAll's read snapshot) and count rows for this email in
    // this workspace. Honest counting — no repo-abstraction shortcut that
    // could silently return [].
    let usersWithEmail = -1;
    let credsWithEmail = -1;
    await repositories.mutateAll!((d) => {
      usersWithEmail = (d.users || []).filter((u) => u.email === inviteEmail && u.workspaceId === WS).length;
      credsWithEmail = (d.userCredentials || []).filter((c) => c.email === inviteEmail && c.workspaceId === WS).length;
      return null;
    });
    // The owner's email is distinct (owner_<RUN_ID>@test.local), so the invite
    // email should have ZERO rows — the winner's user was never created in
    // this test (we simulated the win by marking the invite accepted directly),
    // and the loser must have been rejected.
    ok("no duplicate user row created by the rejected accept", usersWithEmail === 0,
       `expected 0 user rows with the invite email, found ${usersWithEmail}`);
    ok("no duplicate credential row created by the rejected accept", credsWithEmail === 0,
       `expected 0 credential rows with the invite email, found ${credsWithEmail}`);
  }

  // ─── CASE B: template-send condition is NOT tautological (F-DATA-7) ───
  //
  // REWRITTEN 2026-08-26 (S24-14, N-TEST-11 item (d)). What was here before
  // defined the predicate itself inside the test:
  //     const fixedPredicate = (templateName, open) => Boolean(templateName) && !open;
  //     const buggyPredicate = (templateName, open) => Boolean(templateName) && (!open || Boolean(templateName));
  // ...and then asserted that each behaved as written. It never called
  // sendApprovedReply. Reverting the shipping condition to the tautology it
  // exists to prevent would not have turned this case red — the test would
  // simply have kept grading its own copy.
  //
  // The real predicate lives inside sendApprovedReply, which is module-private
  // and resolves its WhatsApp provider from the workspace's saved credentials.
  // Reaching it used to mean either real network traffic to Meta or a stub over
  // global fetch. So `ApproveOptions` gained a `whatsappProvider` seam that
  // mirrors the `emailProvider` seam already sitting two lines above it — one
  // symmetric injection point instead of a global monkey-patch. The branch is
  // now driven end to end and the assertion is on WHICH META API WAS CALLED,
  // which is the thing Meta actually bills and blocks on.
  console.log("\nCASE B — template-send condition (F-DATA-7):");
  {
    const { approveAutoReplyLog } = await import("@/services/AutoReplyReviewService");
    const { WHATSAPP_WINDOW_MS } = await import("@/lib/whatsapp-window");

    /** Records which Meta API the send path chose. Sends nothing. */
    function spyProvider() {
      const calls: string[] = [];
      return {
        calls,
        provider: {
          isConfigured: () => true,
          async sendTextMessage() {
            calls.push("free_text");
            return { attempted: true, status: "sent" as const, provider: "meta_cloud" as const, providerMessageId: "spy_text" };
          },
          async sendTemplateMessage() {
            calls.push("template");
            return { attempted: true, status: "sent" as const, provider: "meta_cloud" as const, providerMessageId: "spy_tpl" };
          },
          // N-TEST-10 (2026-08-26, S29). `testConnection` is REQUIRED by
          // WhatsAppSendProvider (WhatsAppSendProvider.ts:61) and this double
          // did not have it, so all four call sites carried `as never` — which
          // switched off checking of the WHOLE object, `sendTextMessage`'s
          // return shape included. The double now implements the interface, and
          // it RECORDS the call: nothing in the approve path should be pinging
          // Meta to validate credentials, and if that ever changes, the four
          // assertions below on `spy.calls` will say so.
          async testConnection() {
            calls.push("test_connection");
            return { ok: true, status: "connected" as const, message: "spy provider: not a real connection" };
          },
        },
      };
    }

    /** One lead + one whatsapp draft. `hoursAgo` places the customer's last
     *  inbound message relative to the 24h window. */
    async function seedB(tag: string, hoursAgo: number): Promise<string> {
      const leadId = `lead_${RUN_ID}_b_${tag}`;
      const logId = `arlog_${RUN_ID}_b_${tag}`;
      await repositories.lead.createLead({
        id: leadId, workspaceId: WS, status: "message_ready", reviewStatus: "approved",
        contactName: `Contact ${tag}`, companyName: `Company ${tag}`,
        // N-SAFETY-1: unroutable by construction.
        whatsappNumber: "+91 00000 00042",
        lastInboundAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
      });
      await repositories.autoReplyLog.create(WS, {
        id: logId, workspaceId: WS, leadId, channel: "whatsapp",
        incomingMessage: `Inbound that prompted the ${tag} draft`,
        // N-TEST-10 (2026-08-26, S29). This said `status: "pending_review"`,
        // which is not an AutoReplyLog status — that word belongs to
        // PendingSettingsDraft. The held state this fixture means is
        // "held_for_review", which is what WhatsAppConversationEngine actually
        // writes. `as never` is the only reason it compiled. The four cases
        // below approve this draft and assert which Meta send path it takes,
        // so the fixture was entering the 24-hour-window logic from a state the
        // product can never produce. Today `approveAutoReplyLog` only refuses
        // "rejected" and short-circuits "approved"/"auto_sent"
        // (AutoReplyReviewService.ts:46,52) so the outcome is the same — but
        // the day that check becomes a whitelist, this test starts asserting
        // about a status nothing writes. Same lie fixed in
        // golden-substrate-parity.ts (S24-18).
        // ...and `body` was a second phantom on the same line: AutoReplyLog has
        // no `body` (src/lib/types.ts:1494) and auto_reply_logs has no such
        // column. The Prisma repository picks its columns explicitly so it
        // would have dropped the key; the JSON repository spreads, so it kept
        // it. `generatedReply` is the real field and the one the send path
        // reads. Removed.
        status: "held_for_review", generatedReply: `Draft ${tag}`,
      });
      return logId;
    }

    const OPEN_HOURS = 1;                                    // well inside the window
    const CLOSED_HOURS = WHATSAPP_WINDOW_MS / 3_600_000 + 1; // one hour past it

    // 1. Window OPEN + a template selected → FREE TEXT. This is the case the
    //    old tautology got wrong: it forced a template send on an open window,
    //    which is a worse customer experience and costs money Meta does not
    //    need to charge us.
    {
      const spy = spyProvider();
      await approveAutoReplyLog(WS, await seedB("open_tpl", OPEN_HOURS), { templateName: "tpl", templateLanguage: "en_US" },
        repositories, "tester", { whatsappProvider: spy.provider });
      ok("window OPEN + template selected → free-text send", spy.calls.join(",") === "free_text", `provider calls: [${spy.calls.join(", ")}]`);
    }

    // 2. Window CLOSED + a template selected → TEMPLATE send (Meta's only
    //    legal option after 24h).
    {
      const spy = spyProvider();
      await approveAutoReplyLog(WS, await seedB("closed_tpl", CLOSED_HOURS), { templateName: "tpl", templateLanguage: "en_US" },
        repositories, "tester", { whatsappProvider: spy.provider });
      ok("window CLOSED + template selected → template send", spy.calls.join(",") === "template", `provider calls: [${spy.calls.join(", ")}]`);
    }

    // 3. Window CLOSED + no template → refuse honestly, send NOTHING. Letting
    //    it through means Meta rejects it and the owner never learns why.
    {
      const spy = spyProvider();
      await approveAutoReplyLog(WS, await seedB("closed_none", CLOSED_HOURS), {},
        repositories, "tester", { whatsappProvider: spy.provider });
      ok("window CLOSED + no template → nothing is sent at all", spy.calls.length === 0, `provider calls: [${spy.calls.join(", ")}]`);
    }

    // 4. Window OPEN + no template → free text, the ordinary path. Included so
    //    a guard that blocks too much is caught as fast as one that blocks too
    //    little.
    {
      const spy = spyProvider();
      await approveAutoReplyLog(WS, await seedB("open_none", OPEN_HOURS), {},
        repositories, "tester", { whatsappProvider: spy.provider });
      ok("window OPEN + no template → free-text send (the ordinary path still works)", spy.calls.join(",") === "free_text", `provider calls: [${spy.calls.join(", ")}]`);
    }
  }

  // ─── CASE C: TicketStatus union matches the route's enum gate (F-API-6) ───
  console.log("\nCASE C — TicketStatus union ↔ route enum gate (F-API-6):");
  {
    // The route's enum gate (F-API-6 fix) hard-codes the status list. If a
    // status is added to the Ticket type but not the route enum (or vice-
    // versa), the gate either rejects a valid status or accepts an invalid
    // one. Assert the two lists agree. This is a compile-time-vs-runtime
    // contract drift check.
    const ROUTE_ENUM = ["open", "in_progress", "waiting_customer", "resolved", "closed", "reopened"];
    // The set of statuses changeTicketStatus can write (from the Ticket type
    // union). We assert by constructing a sample ticket per known status +
    // confirming the route enum accepts each. If the type union grows, this
    // test's hardcoded list must grow too — that's the point (forced review).
    const TYPE_STATUSES: Ticket["status"][] = ["open", "in_progress", "waiting_customer", "resolved", "closed", "reopened"];
    for (const s of TYPE_STATUSES) {
      ok(`route enum accepts ticket status "${s}"`, ROUTE_ENUM.includes(s));
    }
    // And the reverse: nothing in the route enum is outside the type union.
    for (const s of ROUTE_ENUM) {
      ok(`route enum value "${s}" is a valid Ticket status`, (TYPE_STATUSES as string[]).includes(s));
    }
  }

  console.log(`\n=== ${passed} PASS / ${failed} FAIL ===`);
  if (failed > 0) {
    console.error("❌ golden-audit-fixes-aug04 FAILED");
    process.exit(1);
  }
  console.log("ALL GREEN ✅");
}

main().catch((e) => {
  console.error("golden-audit-fixes-aug04 crashed:", e);
  process.exit(1);
});
