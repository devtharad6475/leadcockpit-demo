/**
 * golden-platform-kill-switch-login-block.ts — pins F-P0-3 (Stage 5 re-audit 2026-07-28).
 *
 * WHAT THIS PROVES (docs/AUDIT-FINDINGS-2026-07-28-STAGE5.md):
 *   The Stage 5 re-audit found that `isWorkspaceLoginAllowed` (the WP2 kill-
 *   switch helper) was DEFINED + golden-tested (CASE B/C in platform-admin-ops)
 *   but NEVER WIRED into `loginWithPassword` or `resolveUserFromSessionWithVersionCheck`.
 *   A suspended workspace's users could keep logging in + use existing sessions
 *   until their cookie expired. The kill-switch was half a kill-switch.
 *
 *   The existing golden tests the HELPER; this golden tests the WIRING — does
 *   the login/session path actually REFUSE a suspended workspace's user?
 *
 *   NOTE: the existing `golden:kill-switch-wiring` (session 16) is a DIFFERENT
 *   kill-switch — the workspace's autonomy kill-switch flip (the owner toggling
 *   auto-outreach on/off). THIS golden tests the OPERATOR's WP2 suspend
 *   kill-switch — the operator suspending a whole tenant for non-payment/abuse.
 *
 * THE CONTRACTS (hand-computed BEFORE writing the assertions):
 *
 *   CASE A — loginWithPassword REFUSES a suspended workspace's user:
 *     Suspend → loginWithPassword returns {ok: false} with a reason that
 *     indicates suspension (NOT "incorrect email or password").
 *
 *   CASE B — resolveUserFromSessionWithVersionCheck REFUSES a suspended
 *     workspace's existing session (the 12h cookie does NOT survive suspend).
 *
 *   CASE C — resume RESTORES login + session (kill-switch is reversible).
 *
 * REAL PIPELINE: imports the real auth-service + PlatformAdminService + real
 * JSON repos. Each case uses a unique RUN_ID namespace (Ironclad Gate #8).
 *
 * Run: npx tsx scripts/golden/golden-platform-kill-switch-login-block.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { repositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import {
  suspendWorkspace,
  resumeWorkspace,
} from "@/services/PlatformAdminService";
import {
  loginWithPassword,
  resolveCurrentUser,
  resolveUserFromSessionWithVersionCheck,
  AuthenticationError,
} from "@/lib/auth-service";
import { createSessionToken, SESSION_COOKIE } from "@/lib/session";
import { hashPassword } from "@/lib/password";
import assert from "node:assert";
import { NextRequest } from "next/server";

/**
 * Build a NextRequest whose lc_session cookie carries the given token. The real
 * request path (resolveCurrentUser) reads the cookie off the request, so this
 * is how we exercise it as the live API would.
 */
function requestWithSession(token: string): NextRequest {
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
  return new NextRequest("http://localhost/api/state", { headers });
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN_ID = `pkslb_${Date.now()}`;
function uniqEmail(tag: string) { return `${tag}+${RUN_ID}@test.example`; }

/** Seed an isolated operator admin (for the suspend/resume RBAC). */
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

// ─── CASE A: loginWithPassword REFUSES a suspended workspace's user ────────
test("CASE A — loginWithPassword REFUSES a suspended workspace's owner (not 'incorrect password')", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 1);
  const password = "StrongPassword123!";
  const { workspaceId, email } = await seedWorkspaceWithOwner(repos, "a", password);

  // Pre-suspend: login works.
  const before = await loginWithPassword(workspaceId, email, password);
  assert.ok(before.ok === true, "login must succeed before suspend");

  // Suspend the workspace.
  await suspendWorkspace({ adminId: aid, workspaceId, reason: "non-payment test A" });

  // Post-suspend: login MUST REFUSE. The reason must indicate suspension (NOT
  // the generic "incorrect email or password" — that would mislead the user
  // into thinking their password is wrong).
  const after = await loginWithPassword(workspaceId, email, password);
  assert.ok(after.ok === false, "login MUST fail after suspend (F-P0-3 wiring)");
  if (!after.ok) {
    assert.match(
      after.reason.toLowerCase(),
      /suspend|disabled|inactive|unavailable/i,
      `login refusal reason must indicate suspension (got: "${after.reason}"). ` +
        `Pre-fix (F-P0-3) the kill-switch helper existed but was never wired into loginWithPassword.`,
    );
  }
});

// ─── CASE B: resolveUserFromSessionWithVersionCheck REFUSES suspended session
test("CASE B — resolveUserFromSessionWithVersionCheck REFUSES a suspended workspace's existing session (12h cookie does NOT survive suspend)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 2);
  const password = "StrongPassword123!";
  const { workspaceId, userId } = await seedWorkspaceWithOwner(repos, "b", password);

  // Mint a valid session token for the owner.
  const token = createSessionToken({
    userId,
    workspaceId,
    role: "owner",
    sessionVersion: 1,
  });

  // Pre-suspend: the session resolves.
  const before = await resolveUserFromSessionWithVersionCheck(token);
  assert.ok(before, "session must resolve before suspend");
  assert.strictEqual(before.workspaceId, workspaceId);

  // Suspend the workspace.
  await suspendWorkspace({ adminId: aid, workspaceId, reason: "non-payment test B" });

  // Post-suspend: the SAME session token MUST be refused. Pre-fix (F-P0-3)
  // the existing session survived the suspend until cookie expiry — the
  // kill-switch was half a kill-switch.
  let threw = false;
  try {
    await resolveUserFromSessionWithVersionCheck(token);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof AuthenticationError, "must throw AuthenticationError");
  }
  assert.ok(
    threw,
    "resolveUserFromSessionWithVersionCheck MUST throw for a suspended workspace's session " +
      "(F-P0-3 wiring — the 12h cookie must NOT survive the suspend)",
  );
});

// ─── CASE D: resolveCurrentUser (the REAL request path) REFUSES a suspended
// workspace's existing session. 2026-08-02 audit: CASE B above tests
// resolveUserFromSessionWithVersionCheck, which is DEAD CODE (never called by
// any HTTP request). The function the live API actually uses is
// resolveCurrentUser (src/app/api/[[...path]]/route.ts GET line 228, and POST
// via enforceAuthGate→requireRole). Pre-fix it checked session + sessionVersion
// but NOT the kill-switch, so a suspended workspace's already-logged-in users
// kept full access until their 12h cookie expired. This CASE pins the real path.
test("CASE D — resolveCurrentUser (REAL request path) REFUSES a suspended workspace's existing session", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 4);
  const password = "StrongPassword123!";
  const { workspaceId, userId } = await seedWorkspaceWithOwner(repos, "d", password);

  // resolveCurrentUser only does its DB-backed work in production mode (demo
  // mode short-circuits to the fixed demo owner). Flip to production for this
  // case, restore at the end so we don't perturb sibling cases.
  const prevMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "production";
  try {
    const token = createSessionToken({ userId, workspaceId, role: "owner", sessionVersion: 1 });
    const req = requestWithSession(token);

    // Pre-suspend: the session resolves.
    const before = await resolveCurrentUser(req);
    assert.ok(before, "session must resolve before suspend");
    assert.strictEqual(before.workspaceId, workspaceId);

    // Suspend the workspace.
    await suspendWorkspace({ adminId: aid, workspaceId, reason: "non-payment test D" });

    // Post-suspend: the SAME session token MUST be refused on the real request
    // path. Pre-fix (2026-08-02 audit P0-1) resolveCurrentUser never called
    // isWorkspaceLoginAllowed, so the existing session survived the suspend
    // until cookie expiry — the kill-switch was only half a kill-switch.
    let threw = false;
    try {
      await resolveCurrentUser(req);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof AuthenticationError, "must throw AuthenticationError");
    }
    assert.ok(
      threw,
      "resolveCurrentUser MUST throw for a suspended workspace's session " +
        "(2026-08-02 audit P0-1 — the real request path must enforce the kill-switch, " +
        "not just loginWithPassword). The 12h cookie must NOT survive the suspend.",
    );
  } finally {
    process.env.AUTH_MODE = prevMode;
  }
});

// ─── CASE C: resume RESTORES login + session ───────────────────────────────
test("CASE C — resumeWorkspace RESTORES login + session (kill-switch is reversible)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 3);
  const password = "StrongPassword123!";
  const { workspaceId, email } = await seedWorkspaceWithOwner(repos, "c", password);

  // Suspend.
  await suspendWorkspace({ adminId: aid, workspaceId, reason: "temp" });
  const suspended = await loginWithPassword(workspaceId, email, password);
  assert.ok(suspended.ok === false, "login refuses while suspended");

  // Resume.
  await resumeWorkspace({ adminId: aid, workspaceId });
  const resumed = await loginWithPassword(workspaceId, email, password);
  assert.ok(resumed.ok === true, "login must SUCCEED again after resume");

  // A fresh session after resume resolves.
  if (resumed.ok) {
    const freshResolved = await resolveUserFromSessionWithVersionCheck(resumed.token);
    assert.ok(freshResolved, "fresh session after resume must resolve");
  }
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
    console.error("❌ golden-platform-kill-switch-login-block FAILED — see cases above.");
    process.exit(1);
  }
  console.log("✅ golden-platform-kill-switch-login-block ALL GREEN ✅");
  process.exit(0);
})();
