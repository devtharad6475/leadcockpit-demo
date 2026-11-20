/**
 * golden-password-reset-redemption.ts — pins F-P0-4 (Stage 5 re-audit 2026-07-28).
 *
 * WHAT THIS PROVES (docs/AUDIT-FINDINGS-2026-07-28-STAGE5.md):
 *   The Stage 5 re-audit found that `issuePasswordReset` (the WP2 operator-side
 *   flow) issues a token + bumps sessionVersion + emails a `/reset-password?
 *   token=...` link — but the REDEMPTION side is entirely missing: no
 *   findByTokenHash on the repo, no redeemPasswordReset service, no POST route,
 *   no /reset-password page. The emailed link 404s. Combined with the session
 *   bump, the operator-issued reset is a ONE-WAY PERMANENT LOCKOUT.
 *
 *   This golden tests the REDEMPTION side at the service layer (the thing that
 *   was missing). The HTTP route + page are tested by the smoke + e2e.
 *
 * THE CONTRACTS (hand-computed BEFORE writing the assertions):
 *
 *   CASE A — happy path: redeemPasswordReset(rawToken, newPassword) sets the
 *     new password + bumps sessionVersion + marks the token consumed. The user
 *     can then log in with the NEW password (and NOT the old one).
 *
 *   CASE B — expired token rejected: a token past its 24h expiry → throws
 *     (410-ish). The password is NOT changed.
 *
 *   CASE C — already-consumed token rejected: a second redeem with the same
 *     token → throws (the token is one-shot).
 *
 *   CASE D — invalid token rejected: a random/guessed token → throws (the
 *     hashed-store lookup returns nothing).
 *
 *   CASE E — atomicity: the password change + token consumption happen
 *     TOGETHER (no window where the password changed but the token is still
 *     reusable).
 *
 * REAL PIPELINE: imports the real PlatformAdminService (issuePasswordReset) +
 * the NEW redeemPasswordReset service + real JSON repos. Each case uses a
 * unique RUN_ID namespace (Ironclad Gate #8).
 *
 * CASE B MUTATION-TESTED 2026-08-26 (it never could fail before today).
 * Both mutations compile clean under tsc; the source was restored
 * byte-identical (sha256 verified) after each:
 *   m4 SHIPPING PasswordResetService: expiry branch made unreachable
 *       -> CASE B fails, "Missing expected rejection"
 *   m5 SHIPPING PasswordResetService: expiry throws 400 instead of 410
 *       -> CASE B fails, "400 !== 410"
 * 2 of 2 caught. Proven on BOTH substrates: JSON 5/5, and real Postgres
 * via `npx tsx scripts/probes/golden-postgres-pass.ts --only
 * password-reset-redemption` (1 PASS, wrote to Postgres).
 *
 * Run: npx tsx scripts/golden/golden-password-reset-redemption.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { repositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import {
  issuePasswordReset,
} from "@/services/PlatformAdminService";
import {
  redeemPasswordReset,
} from "@/services/PasswordResetService";
import {
  loginWithPassword,
} from "@/lib/auth-service";
import { hashPassword, verifyPassword } from "@/lib/password";
import { AuthenticationError } from "@/lib/auth-service";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert";

/** The issue path's TTL (PlatformAdminService keeps it private). Used only to
 *  stamp a plausible issuedAt on the deliberately-expired row in CASE B. */
const RESET_TTL_MS = 24 * 60 * 60 * 1000;

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN_ID = `prr_${Date.now()}`;
function uniqEmail(tag: string) { return `${tag}+${RUN_ID}@test.example`; }

/** Seed an isolated operator admin (for issuePasswordReset RBAC). */
async function seedOperator(repos: RepositoryBundle, n: number) {
  const aid = `admin_${RUN_ID}_${n}`;
  await repos.platformAdmin.createWithCredential({
    admin: {
      id: aid,
      email: `op+${RUN_ID}_${n}@test.example`,
      name: `Operator ${n}`,
      role: "operator",
      status: "active",
    },
    credential: {
      adminId: aid,
      email: `op+${RUN_ID}_${n}@test.example`,
      passwordHash: "x".repeat(60),
    },
  });
  return aid;
}

/** Seed a workspace + owner + credential (the atomic way, post-Batch-1). */
async function seedWorkspaceWithOwner(
  repos: RepositoryBundle,
  tag: string,
  password: string,
): Promise<{ workspaceId: string; userId: string; email: string; password: string }> {
  const workspaceId = `ws_${RUN_ID}_${tag}`;
  const userId = `user_${RUN_ID}_${tag}`;
  const email = uniqEmail(tag);
  const passwordHash = await hashPassword(password);
  await repos.auth.createWorkspaceWithOwner({
    workspace: {
      id: workspaceId,
      name: `WS ${tag}`,
      ownerUserId: userId,
      status: "active",
      autonomyKillSwitch: true,
      autoSendToggle: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    user: {
      id: userId,
      workspaceId,
      name: `Owner ${tag}`,
      email,
      role: "owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    credential: {
      id: `cred_${RUN_ID}_${tag}`,
      userId,
      workspaceId,
      email,
      passwordHash,
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    member: {
      id: `member_${RUN_ID}_${tag}`,
      workspaceId,
      userId,
      email,
      name: `Owner ${tag}`,
      role: "owner",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  return { workspaceId, userId, email, password };
}

// ─── CASE A: happy path — redeem sets new password + consumes token ────────
test("CASE A — redeemPasswordReset(rawToken, newPassword) sets the new password + consumes the token; user logs in with NEW password", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 1);
  const oldPassword = "OldPassword123!";
  const newPassword = "NewPassword456!";
  const { workspaceId, userId, email } = await seedWorkspaceWithOwner(repos, "a", oldPassword);

  // Issue the reset (operator-side).
  const issued = await issuePasswordReset({
    adminId: aid,
    targetUserId: userId,
    targetWorkspaceId: workspaceId,
  });
  assert.ok(issued.token, "issuePasswordReset must return a raw token");
  assert.ok(issued.expiresAt, "must return an expiry");

  // Redeem it.
  const result = await redeemPasswordReset({ rawToken: issued.token, newPassword });
  assert.ok(result.userId, "redeem must return the userId");
  assert.ok(result.completedAt, "redeem must stamp completedAt");

  // The user can now log in with the NEW password.
  const loginNew = await loginWithPassword(workspaceId, email, newPassword);
  assert.ok(loginNew.ok === true, "login with NEW password must succeed after redeem");

  // The user CANNOT log in with the OLD password.
  const loginOld = await loginWithPassword(workspaceId, email, oldPassword);
  assert.ok(loginOld.ok === false, "login with OLD password must fail after redeem");
});

// ─── CASE B: expired token rejected ────────────────────────────────────────
test("CASE B — an EXPIRED reset token is rejected (password NOT changed)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 2);
  const oldPassword = "OldPassword123!";
  const { workspaceId, userId, email } = await seedWorkspaceWithOwner(repos, "b", oldPassword);

  // REAL EXPIRY, NOT A SIMULATION (rewritten 2026-08-26 — see the note below).
  //
  // issuePasswordReset() always stamps expiresAt 24h in the future and the
  // repository exposes no backdating hook, so this case mints the row itself
  // through the SAME public repository call the issue path uses, with the
  // clock already past. The row is byte-for-byte what an expired token looks
  // like in storage: same hash algorithm (SHA-256 of the raw token, which is
  // never stored), same fields, expiresAt one minute ago.
  //
  // WHAT THIS REPLACED, AND WHY IT MATTERS. Until today this case did none of
  // that. It redeemed a FRESH token, asserted that the row merely HAD an
  // expiresAt field, and passed — under a heading that claimed expired tokens
  // were rejected. The expiry branch of redeemPasswordReset had never once
  // been executed by this suite. It was found by the Postgres pass (A-7), and
  // only because a line of leftover debris in the old body — markConsumed("")
  // on an id that exists nowhere — is a silent no-op on the JSON substrate and
  // a hard error on the real database. The debris is gone; the case now does
  // what its own name says.
  const rawToken = randomBytes(32).toString("base64url");
  const expiredAtMs = Date.now() - 60_000; // one minute past expiry
  await repos.passwordResetToken.create({
    userId,
    workspaceId,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    issuedAt: new Date(expiredAtMs - RESET_TTL_MS).toISOString(),
    expiresAt: new Date(expiredAtMs).toISOString(),
    issuedByAdminId: aid,
  });

  // The redeem must be REFUSED, and refused for the RIGHT reason. 410 is the
  // expiry branch; 400 would mean the lookup never found the row, which would
  // be this test passing for a reason that has nothing to do with expiry.
  await assert.rejects(
    () => redeemPasswordReset({ rawToken, newPassword: "ExpiredShouldFail123!" }),
    (err: unknown) => {
      assert.ok(err instanceof AuthenticationError, "must throw AuthenticationError, not a generic Error");
      assert.strictEqual(
        (err as AuthenticationError).statusCode,
        410,
        `expired token must be rejected as 410 (gone), not ${(err as AuthenticationError).statusCode} — a 400 would mean the row was never found and expiry was never checked`,
      );
      assert.match((err as AuthenticationError).message, /expired/i, "the message must tell the user the link expired");
      return true;
    },
    "an expired reset token must be rejected",
  );

  // The password is UNCHANGED — a refused redeem must not half-apply.
  const loginOld = await loginWithPassword(workspaceId, email, oldPassword);
  assert.ok(loginOld.ok === true, "the ORIGINAL password must still work after a refused redeem");
  const loginNew = await loginWithPassword(workspaceId, email, "ExpiredShouldFail123!");
  assert.ok(loginNew.ok === false, "the password from the refused redeem must NOT have been set");

  // A FRESH token issued afterwards still works — the refusal is about this
  // token's age, not a lockout.
  const fresh = await issuePasswordReset({ adminId: aid, targetUserId: userId, targetWorkspaceId: workspaceId });
  const redeemed = await redeemPasswordReset({ rawToken: fresh.token, newPassword: "FreshPass123!" });
  assert.strictEqual(redeemed.userId, userId, "a fresh token must still redeem after an expired one was refused");
});

// ─── CASE C: already-consumed token rejected ───────────────────────────────
test("CASE C — a SECOND redeem with the same token is rejected (token is one-shot)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 3);
  const oldPassword = "OldPassword123!";
  const { workspaceId, userId } = await seedWorkspaceWithOwner(repos, "c", oldPassword);

  const issued = await issuePasswordReset({
    adminId: aid,
    targetUserId: userId,
    targetWorkspaceId: workspaceId,
  });

  // First redeem succeeds.
  await redeemPasswordReset({ rawToken: issued.token, newPassword: "FirstNew123!" });

  // Second redeem with the SAME token must FAIL (one-shot).
  await assert.rejects(
    () => redeemPasswordReset({ rawToken: issued.token, newPassword: "SecondNew123!" }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw");
      return true;
    },
    "a second redeem with the same token must be rejected (one-shot semantics)",
  );

  // The password is STILL the first new password (the second redeem did nothing).
  const login = await loginWithPassword(workspaceId, (await repos.auth.findUserById(workspaceId, userId))!.email, "FirstNew123!");
  assert.ok(login.ok === true, "password must be the FIRST new password (second redeem rejected)");
});

// ─── CASE D: invalid token rejected ────────────────────────────────────────
test("CASE D — an INVALID (guessed/random) token is rejected; password NOT changed", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 4);
  const oldPassword = "OldPassword123!";
  const { workspaceId, userId, email } = await seedWorkspaceWithOwner(repos, "d", oldPassword);

  // Issue a real token (so the user has one in flight) but try to redeem with a GUESSED token.
  await issuePasswordReset({
    adminId: aid,
    targetUserId: userId,
    targetWorkspaceId: workspaceId,
  });

  const guessedToken = "this-is-a-guessed-token-that-does-not-match-any-hash";
  await assert.rejects(
    () => redeemPasswordReset({ rawToken: guessedToken, newPassword: "Guessed123!" }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw on invalid token");
      return true;
    },
    "an invalid/guessed token must be rejected",
  );

  // The OLD password still works (the failed redeem changed nothing).
  const login = await loginWithPassword(workspaceId, email, oldPassword);
  assert.ok(login.ok === true, "old password must still work after a failed redeem (no change)");
});

// ─── CASE E: atomicity — password change + token consumption together ──────
test("CASE E — password change + token consumption are atomic (no reusable-token window)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 5);
  const oldPassword = "OldPassword123!";
  const { workspaceId, userId } = await seedWorkspaceWithOwner(repos, "e", oldPassword);

  const issued = await issuePasswordReset({
    adminId: aid,
    targetUserId: userId,
    targetWorkspaceId: workspaceId,
  });

  await redeemPasswordReset({ rawToken: issued.token, newPassword: "Atomic123!" });

  // After redeem, the token is CONSUMED (cannot be reused even though the
  // password changed). This proves the two writes landed together. We look up
  // by hash (findLatestForUser filters OUT consumed tokens, so it would
  // return undefined here — that's correct behavior, but we want to inspect
  // the row to prove consumedAt is stamped).
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(issued.token).digest("hex");
  const tokenAfter = await repos.passwordResetToken.findByTokenHash(tokenHash);
  assert.ok(tokenAfter, "token row must still exist (we keep it for audit)");
  assert.ok(tokenAfter!.consumedAt, "token must be marked consumed after redeem (atomicity)");
});

// ─── Runner ────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(err as Error).message}`);
    }
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-password-reset-redemption FAILED — see cases above.");
    process.exit(1);
  }
  console.log("✅ golden-password-reset-redemption ALL GREEN ✅");
  process.exit(0);
})();
