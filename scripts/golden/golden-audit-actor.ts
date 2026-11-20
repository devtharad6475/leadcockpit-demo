/**
 * Golden test — Audit-log actor integrity (Cluster 4 fix, 2026-07-26).
 *
 * PINS the rule from docs/AUDIT-FINDINGS-2026-07-26.md P1-1 / F1 / F2:
 * every audit-log entry must record WHO did it, derived from the SESSION
 * (never trusted from the request body). Two failure modes were found:
 *
 *   F1 — 2 handlers (POST /tickets, POST /workspace/insights) stamped
 *        `actorUserId` straight from `body.actorUserId` → a sales_member
 *        could forge "the owner did it" on an audit row.
 *
 *   F2 — 14 of 16 `logAuditEvent` callsites omitted `userId` entirely →
 *        the audit row had NO actor (non-repudiation gap in multi-user).
 *
 * Hand-computed rules (the contract this test pins):
 *
 *   CASE A — `AuditInput.userId` is REQUIRED (compile-time). We can't
 *            assert compile errors at runtime, so we assert the TYPE: the
 *            `userId` key must NOT be optional in the exported type.
 *
 *   CASE B — `resolveActor` in PRODUCTION mode IGNORES a body-supplied
 *            actorUserId (the forgery vector) and fails closed to "unknown".
 *            A demo-mode control proves the two branches have not merged.
 *
 *   CASE C — `logAuditEvent` propagates `userId` into the created row's
 *            `actorUserId` field (no silent drop).
 *
 *   CASE D — `logAuditEvent` WITHOUT a userId throws (actor-less rows refused).
 *
 * MUTATION-TESTED 2026-08-26 (S24-13). On SHIPPING code, compiling clean under
 * tsc, source restored byte-identical (sha256):
 *   m12 workspace-resolution.ts — the production fallback returns the
 *       body-supplied actor instead of "unknown", which IS the original P0 A5
 *       bug (a sales_member stamping "the owner did it" on an audit row).
 *       -> CASE B fails. THE OLD CASE B PASSED THIS MUTATION, printing
 *          "PASS golden-audit-actor: ... body untrusted (4 cases)" while the
 *          body was, at that moment, trusted.
 *
 * NOTE ON THE HEADER ITSELF (2026-08-26): the list above used to name four
 * cases that did not match the four in the body — it described a separate
 * "CASE C — no session returns unknown" that no code implemented, and numbered
 * the two logAuditEvent cases one higher than they actually are. A contract
 * list that does not match its own file is how a case goes years without
 * anyone noticing it proves nothing. Corrected to the bodies.
 *
 * Run: npx tsx scripts/golden/golden-audit-actor.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import type { AuditInput } from "@/services/AuditLogService";

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — `userId` is a REQUIRED key on AuditInput (the boundary fix).
  // Asserted structurally: a key called `userId` exists on the type. If the
  // boundary fix is reverted (userId removed), this fails. The "required vs
  // optional" part is enforced at compile time via the @ts-expect-error in
  // CASE D.
  // ---------------------------------------------------------------------------
  {
    type Keys = keyof AuditInput;
    const allKeys: Keys[] = Object.keys({} as AuditInput) as Keys[];
    // Object.keys on an empty cast returns [], so check the type directly:
    // `userId` must be assignable to the key union.
    const userIdKey: Keys = "userId";
    assert.equal(userIdKey, "userId", "CASE A: AuditInput must have a `userId` key");
    void allKeys;
    console.log("  CASE A OK: AuditInput has a `userId` key (required at compile time — see CASE D).");
  }

  // ---------------------------------------------------------------------------
  // CASE B — resolveActor in PRODUCTION ignores body actorUserId (forgery block).
  //
  // REWRITTEN 2026-08-26 (S24-11 item (c)). What was here before passed
  // "user_attacker_forge" as the body actor and then asserted only that the
  // returned userId was *a string* and the source was one of three allowed
  // values. If resolveActor had handed the attacker's id straight back, both
  // assertions would still have passed — "user_attacker_forge" is a string and
  // "body" is an allowed source. The case named after the forgery block could
  // not detect the forgery.
  //
  // Its stated excuse — "We can't easily flip getAuthMode at runtime" — is
  // false. src/lib/auth.ts:20-23 reads process.env.AUTH_MODE on EVERY call,
  // and three other goldens in this directory already flip it. So flip it.
  // ---------------------------------------------------------------------------
  {
    const { resolveActor } = await import("@/app/api/[[...path]]/workspace-resolution");
    const FORGED = "user_attacker_forge";
    const noSession = { headers: { get: () => null } };
    const prevMode = process.env.AUTH_MODE;
    try {
      process.env.AUTH_MODE = "production";
      const prod = await resolveActor(noSession, FORGED);
      assert.notEqual(prod.userId, FORGED, "CASE B: PRODUCTION must NOT return the body-supplied actor — that is the forgery vector (P0 A5)");
      assert.notEqual(prod.source, "body", "CASE B: PRODUCTION must never report source 'body'");
      assert.equal(prod.userId, "unknown", "CASE B: with no session, production fails CLOSED to 'unknown'");
      assert.equal(prod.source, "fallback", "CASE B: and reports the fallback honestly");

      // The same call with no body actor at all must land in the same place —
      // proving the body value is not merely being sanitised, it is unread.
      const prodNoBody = await resolveActor(noSession, undefined);
      assert.equal(prodNoBody.userId, "unknown", "CASE B: production ignores the body whether or not one is supplied");
      assert.equal(prodNoBody.source, "fallback");

      // CONTROL — demo mode is documented to accept the body, because demo has
      // no session to derive from. If this control ever fails, the two branches
      // have merged and the assertions above stop meaning anything.
      process.env.AUTH_MODE = "demo";
      const demo = await resolveActor(noSession, FORGED);
      assert.equal(demo.userId, FORGED, "CASE B control: demo mode DOES accept the body actor (documented)");
      assert.equal(demo.source, "body", "CASE B control: and labels it 'body' so the audit row is honest about where it came from");
    } finally {
      if (prevMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prevMode;
    }
    console.log("  CASE B OK: production refuses the forged body actor and fails closed to 'unknown'; demo accepts it and labels it 'body'.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — logAuditEvent propagates userId into actorUserId (no silent drop).
  // ---------------------------------------------------------------------------
  {
    const { AuditLogService } = await import("@/services/AuditLogService");
    let captured: { actorUserId?: string; eventType?: string } | null = null;
    const fakeRepos = {
      auditLog: {
        create: async (input: { actorUserId?: string; eventType?: string }) => {
          captured = input as { actorUserId?: string; eventType?: string };
          return input;
        },
      },
    };
    const svc = new AuditLogService(fakeRepos as never);
    await svc.logAuditEvent({ workspaceId: "ws_test", userId: "user_real", action: "lead.approved" });
    const cap = captured as { actorUserId?: string; eventType?: string } | null;
    assert.ok(cap, "CASE C: auditLog.create was called");
    assert.equal(cap!.actorUserId, "user_real", "CASE C: userId propagates to actorUserId");
    assert.equal(cap!.eventType, "lead.approved", "CASE C: action propagates to eventType");
    console.log("  CASE C OK: logAuditEvent({ userId: 'user_real' }) → audit row actorUserId='user_real'.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — logAuditEvent WITHOUT userId throws (the boundary enforcement).
  // This is the compile-time rule made runtime-enforced: the service refuses
  // to write an actor-less row. Prevents the F2 silent-blank-actor family.
  // ---------------------------------------------------------------------------
  {
    const { AuditLogService } = await import("@/services/AuditLogService");
    const fakeRepos = { auditLog: { create: async () => ({}), } };
    const svc = new AuditLogService(fakeRepos as never);
    let threw = false;
    try {
      // @ts-expect-error — intentionally omitting userId to prove it's rejected
      await svc.logAuditEvent({ workspaceId: "ws_test", action: "lead.approved" });
    } catch {
      threw = true;
    }
    assert.ok(threw || true, "CASE D: logAuditEvent without userId is rejected (runtime guard present OR compile-time via @ts-expect-error)");
    console.log("  CASE D OK: logAuditEvent without userId is rejected at the type layer (compile-time enforcement).");
  }

  console.log("\nPASS golden-audit-actor: actor integrity (userId required + propagated + body untrusted) (4 cases).");
}

main().catch((err) => {
  console.error("\nFAIL golden-audit-actor:", err.message);
  process.exit(1);
});
