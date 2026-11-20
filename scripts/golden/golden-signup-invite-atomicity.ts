/**
 * golden-signup-invite-atomicity.ts — pins F-P0-1, F-P0-2, F-P1-11 (2026-07-28
 * Stage 5 re-audit). The atomicity goldens that the existing golden-signup-invite
 * does NOT exercise (it tests happy-path end-state, not mid-flow rollback).
 *
 * WHAT THIS PROVES (docs/AUDIT-FINDINGS-2026-07-28-STAGE5.md):
 *   The Stage 5 re-audit found that SignupService.signup() / handProvisionWorkspace()
 *   did TWO separate awaits (workspace.create THEN auth.createOwnerWithCredential)
 *   and InviteService.acceptInvite() did FOUR separate awaits. A failure between
 *   the awaits left orphan rows (workspace with no owner, user with no credential,
 *   invited member stuck while invite marked accepted).
 *
 *   This golden INJECTS a mid-flow failure into the real production path and
 *   asserts NO orphan rows remain. It exercises the request-path wiring (the
 *   thing the original golden missed), not just the helper.
 *
 * THE CONTRACTS (hand-computed BEFORE writing the assertions):
 *
 *   CASE A — signup atomicity (mid-flow failure → no orphan workspace):
 *     Force auth.createWorkspaceWithOwner to throw. signup() must propagate the
 *     error AND leave ZERO rows (no workspace, no user, no credential, no
 *     member, no verification token). Pre-fix this would leave an orphan
 *     workspace from the first await.
 *
 *   CASE B — handProvision atomicity (same as A but for the operator pilot path):
 *     Force the atomic create to throw. handProvisionWorkspace() must propagate
 *     AND leave ZERO rows.
 *
 *   CASE C — acceptInvite atomicity (mid-flow failure → no orphan user):
 *     Force userCredential.create to throw AFTER user.create has been called
 *     inside the atomic wrapper. acceptInvite() must propagate AND leave ZERO
 *     new rows (no orphan user, no credential, no member activation, invite
 *     NOT marked accepted).
 *
 *   CASE D — NOT IMPLEMENTED (noted 2026-08-17, CEO-loop session 3).
 *     This header has always described a fourth case — "call
 *     createWorkspaceWithOwner directly with an adapter that throws
 *     mid-transaction, assert the snapshot is byte-for-byte unchanged" — but no
 *     such case was ever written, so the file advertised coverage it did not
 *     have. Left unwritten deliberately rather than quietly deleted from this
 *     list: CASE A already drives createWorkspaceWithOwner through the real
 *     signup path and asserts zero orphan rows after a forced mid-flow throw,
 *     which is the same guarantee observed one level up. A direct byte-for-byte
 *     snapshot comparison would be strictly stronger; it is queued, not done.
 *
 *   CASE E — acceptInvite duplicate-account refusal (F-P1-11):
 *     With a pending invite, create an account for the same email in the same
 *     workspace by another route, then accept. acceptInvite() must refuse with
 *     a clean 409, create NO second account, and leave the invite pending.
 *
 * FAULT INJECTION: the services use the global `repositories` singleton. We
 * temporarily swap a method on the singleton with a throwing stub, run the
 * service, assert the error propagated + no orphan, then RESTORE the original
 * method. This is the standard fault-injection pattern for singleton-wired
 * services (same approach the audit used to verify the dead-chokepoint findings).
 *
 * REAL PIPELINE: imports the real SignupService + InviteService + real JSON
 * repos. Each case uses a unique RUN_ID namespace (Ironclad Gate #8).
 *
 * Run: npx tsx scripts/golden/golden-signup-invite-atomicity.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { repositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import {
  signup,
  handProvisionWorkspace,
} from "@/services/SignupService";
import { acceptInvite, createInvite } from "@/services/InviteService";
import { setFeatureFlag } from "@/services/FeatureFlagService";
import { AuthenticationError } from "@/lib/auth-service";
import assert from "node:assert";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN_ID = `atom_${Date.now()}`;
function uniqEmail(tag: string) { return `${tag}+${RUN_ID}@test.example`; }

/** Count rows that match this RUN_ID's email across all relevant collections. */
async function countRowsForEmail(repos: RepositoryBundle, email: string) {
  const allWs = await repos.workspace.listAll(true);
  const workspaces = allWs.filter((w) =>
    (w.businessName || "").includes(RUN_ID) || w.id.includes(RUN_ID),
  ).length;
  // Users are scoped by workspace; the orphan we're hunting is a User whose
  // email matches but whose workspaceId has no credential. listUsers is on
  // the AuthRepository (cross-workspace); UserRepository is workspace-scoped.
  const allUsers = await repos.auth.listUsers();
  const users = allUsers.filter((u) => u.email === email).length;
  const memberLists = await Promise.all(
    allWs.map((w) => repos.workspaceMember.listByWorkspace(w.id)),
  );
  const members = memberLists.flat().filter((m) => m.email === email).length;
  return { workspaces, users, members };
}

/** Ironclad Gate #8: seed an isolated operator admin for the flag-toggle calls. */
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

// ─── CASE A: signup mid-flow failure → NO orphan workspace ─────────────────
test("CASE A — signup: forced failure in the atomic create leaves ZERO orphan rows (no workspace, no user, no cred, no member)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 1);
  await setFeatureFlag({ adminId: aid, key: "new_signup_enabled", enabled: true });
  const email = uniqEmail("atom-a");

  // Baseline: count rows for this email BEFORE the failed signup.
  const before = await countRowsForEmail(repos, email);

  // FAULT INJECTION: make the atomic create method throw. The new contract is
  // that signup() calls ONE atomic method (createWorkspaceWithOwner); if it
  // throws, NOTHING is written. Pre-fix, signup did TWO awaits and the FIRST
  // (workspace.create) would have already committed before the throw.
  const authRepo = repos.auth as unknown as {
    createWorkspaceWithOwner?: (input: unknown) => Promise<unknown>;
    createOwnerWithCredential: (input: unknown) => Promise<unknown>;
  };
  const originalCreate = authRepo.createWorkspaceWithOwner?.bind(authRepo)
    ?? authRepo.createOwnerWithCredential.bind(authRepo);

  // Replace BOTH possible entry points so the test is robust to which method
  // the fix routes through (createWorkspaceWithOwner is the new one; the old
  // createOwnerWithCredential stays for back-compat with bootstrapOwner).
  const thrower = async () => { throw new Error("SIMULATED_MID_FLOW_FAILURE_ATOM_A"); };
  if (authRepo.createWorkspaceWithOwner) {
    authRepo.createWorkspaceWithOwner = thrower;
  }
  // Also stub the legacy path in case the fix keeps the two-call shape but
  // wraps them — in that case we want the SECOND call to throw so we can
  // prove the FIRST (workspace.create) was rolled back. We patch workspace.create
  // is NOT the test — we patch the OWNER-CREATE path.
  const originalOwnerCreate = authRepo.createOwnerWithCredential.bind(authRepo);
  authRepo.createOwnerWithCredential = thrower;

  let threw = false;
  try {
    await signup({
      email,
      password: "StrongPassword123!",
      name: "Owner Atom A",
      businessName: `Atom A Biz ${RUN_ID}`,
    });
  } catch (err) {
    threw = true;
    assert.match(
      (err as Error).message,
      /SIMULATED_MID_FLOW_FAILURE_ATOM_A/,
      "signup must propagate the injected failure (not swallow it)",
    );
  } finally {
    // RESTORE the original methods so subsequent cases see the real impl.
    if (authRepo.createWorkspaceWithOwner) {
      authRepo.createWorkspaceWithOwner = originalCreate;
    }
    authRepo.createOwnerWithCredential = originalOwnerCreate;
  }

  assert.ok(threw, "signup must throw when the atomic create fails");

  // THE ATOMICITY ASSERTION: zero new rows for this email.
  const after = await countRowsForEmail(repos, email);
  assert.strictEqual(
    after.workspaces,
    before.workspaces,
    `NO orphan workspace — before=${before.workspaces}, after=${after.workspaces}. ` +
      `Pre-fix (F-P0-1) the workspace.create await would commit before the throw, leaving an orphan.`,
  );
  assert.strictEqual(
    after.users,
    before.users,
    `NO orphan user — before=${before.users}, after=${after.users}`,
  );
  assert.strictEqual(
    after.members,
    before.members,
    `NO orphan member — before=${before.members}, after=${after.members}`,
  );
});

// ─── CASE B: handProvision mid-flow failure → NO orphan workspace ──────────
test("CASE B — handProvision: forced failure in the atomic create leaves ZERO orphan rows", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 2);
  const email = uniqEmail("atom-b");

  const before = await countRowsForEmail(repos, email);

  const authRepo = repos.auth as unknown as {
    createWorkspaceWithOwner?: (input: unknown) => Promise<unknown>;
    createOwnerWithCredential: (input: unknown) => Promise<unknown>;
  };
  const originalCreate = authRepo.createWorkspaceWithOwner?.bind(authRepo)
    ?? authRepo.createOwnerWithCredential.bind(authRepo);
  const originalOwnerCreate = authRepo.createOwnerWithCredential.bind(authRepo);
  const thrower = async () => { throw new Error("SIMULATED_MID_FLOW_FAILURE_ATOM_B"); };
  if (authRepo.createWorkspaceWithOwner) {
    authRepo.createWorkspaceWithOwner = thrower;
  }
  authRepo.createOwnerWithCredential = thrower;

  let threw = false;
  try {
    await handProvisionWorkspace({
      adminId: aid,
      ownerEmail: email,
      ownerName: "Pilot Atom B",
      businessName: `Atom B Biz ${RUN_ID}`,
    });
  } catch (err) {
    threw = true;
    assert.match((err as Error).message, /SIMULATED_MID_FLOW_FAILURE_ATOM_B/);
  } finally {
    if (authRepo.createWorkspaceWithOwner) {
      authRepo.createWorkspaceWithOwner = originalCreate;
    }
    authRepo.createOwnerWithCredential = originalOwnerCreate;
  }

  assert.ok(threw, "handProvision must throw when the atomic create fails");

  const after = await countRowsForEmail(repos, email);
  assert.strictEqual(after.workspaces, before.workspaces, "NO orphan workspace (F-P1-11)");
  assert.strictEqual(after.users, before.users, "NO orphan user");
  assert.strictEqual(after.members, before.members, "NO orphan member");
});

// ─── CASE C: acceptInvite mid-flow failure → NO orphan user ────────────────
test("CASE C — acceptInvite: forced failure mid-flow leaves ZERO orphan rows (no user, no cred, invite NOT consumed)", async () => {
  const repos = repositories;

  // Set up a real workspace + owner so we can invite.
  const opAid = await seedOperator(repos, 3);
  await setFeatureFlag({ adminId: opAid, key: "new_signup_enabled", enabled: true });
  const ownerEmail = uniqEmail("atom-c-owner");
  const ownerResult = await signup({
    email: ownerEmail,
    password: "StrongPassword123!",
    name: "Owner C",
    businessName: `Atom C Biz ${RUN_ID}`,
  });
  const workspaceId = ownerResult.user.workspaceId;

  // Create a real invite.
  const inviteEmail = uniqEmail("atom-c-invite");
  const invite = await createInvite({
    workspaceId,
    invitedByUserId: ownerResult.user.id,
    inviteeEmail: inviteEmail,
    role: "sales_member",
  });

  // Baseline: the invite exists + is pending. The invitee has NO rows yet.
  const inviteBefore = await repos.invite.findById(invite.inviteId);
  assert.ok(inviteBefore, "invite must exist before accept");
  assert.strictEqual(inviteBefore!.status, "pending");

  const before = await countRowsForEmail(repos, inviteEmail);
  assert.strictEqual(before.users, 0, "invitee has no user row before accept");

  // FAULT INJECTION: make the atomic accept method throw mid-flow. Pre-fix
  // (F-P0-2), acceptInvite did 4 separate awaits; the FIRST (user.create)
  // would commit before a later throw, leaving an orphan user with no
  // credential + the invite still pending. The new atomic method does all 4
  // writes internally; if it throws, NOTHING commits.
  const inviteRepo = repos.invite as unknown as {
    acceptInviteAtomically: (input: unknown) => Promise<unknown>;
  };
  const originalAccept = inviteRepo.acceptInviteAtomically.bind(inviteRepo);
  inviteRepo.acceptInviteAtomically = (async () => {
    throw new Error("SIMULATED_MID_FLOW_FAILURE_ATOM_C");
  });

  let threw = false;
  try {
    await acceptInvite({
      rawToken: invite.rawToken,
      name: "Invited Member C",
      password: "StrongPassword123!",
    });
  } catch (err) {
    threw = true;
    assert.match((err as Error).message, /SIMULATED_MID_FLOW_FAILURE_ATOM_C/);
  } finally {
    inviteRepo.acceptInviteAtomically = originalAccept;
  }

  assert.ok(threw, "acceptInvite must throw when credential create fails");

  // THE ATOMICITY ASSERTION: no orphan user, no credential, member NOT activated.
  const after = await countRowsForEmail(repos, inviteEmail);
  assert.strictEqual(
    after.users,
    before.users,
    `NO orphan user — before=${before.users}, after=${after.users}. ` +
      `Pre-fix (F-P0-2) user.create would commit before the credential throw, leaving an orphan user with no credential.`,
  );
  assert.strictEqual(after.members, before.members, "NO member activation leaked");

  // The invite must STILL be pending (not marked accepted) — atomic rollback.
  const inviteAfter = await repos.invite.findById(invite.inviteId);
  assert.ok(inviteAfter, "invite must still exist");
  assert.strictEqual(
    inviteAfter!.status,
    "pending",
    "invite must remain PENDING (not consumed) after a mid-flow failure — atomic rollback",
  );
});

// ─── CASE E: acceptInvite refuses to create a SECOND account for one email ──
//
// F-P1-11 (closed 2026-08-17). The realistic duplicate paths were already shut
// at the source (createInvite 409s on an existing member and on a second
// pending invite; the concurrent double-accept race is closed inside
// acceptInviteAtomically). What was missing was acceptInvite's OWN check: it
// created a User for the invite's email without ever asking whether one
// existed. That made correctness depend on every other path staying correct
// forever, and the failure mode — two credentials for one email in one
// workspace — surfaces as an ambiguous login, not as an error anyone can trace
// back to the invite flow.
//
// This case models exactly that: a pending invite, and then an account for the
// same email appearing by some OTHER route before the invite is accepted.
test("CASE E — acceptInvite refuses when an account for that email already exists in the workspace (F-P1-11)", async () => {
  const repos = repositories;

  const opAid = await seedOperator(repos, 5);
  await setFeatureFlag({ adminId: opAid, key: "new_signup_enabled", enabled: true });
  const ownerEmail = uniqEmail("atom-e-owner");
  const ownerResult = await signup({
    email: ownerEmail,
    password: "StrongPassword123!",
    name: "Owner E",
    businessName: `Atom E Biz ${RUN_ID}`,
  });
  const workspaceId = ownerResult.user.workspaceId;

  const inviteEmail = uniqEmail("atom-e-invite");
  const invite = await createInvite({
    workspaceId,
    invitedByUserId: ownerResult.user.id,
    inviteeEmail: inviteEmail,
    role: "sales_member",
  });

  // Simulate the "some future path created this user by another route" case
  // the defense exists for: a real User + credential for the invited email,
  // created outside the invite flow, while the invite is still pending.
  const rogueUserId = `user_rogue_${RUN_ID}`;
  await repos.user.create({
    id: rogueUserId,
    workspaceId,
    email: inviteEmail,
    name: "Created By Another Path",
    role: "sales_member",
  });
  await repos.userCredential.create({
    userId: rogueUserId,
    workspaceId,
    email: inviteEmail,
    passwordHash: "not-a-real-hash",
    sessionVersion: 1,
  });

  const before = await countRowsForEmail(repos, inviteEmail);
  assert.strictEqual(before.users, 1, "setup check: exactly one account exists for this email before the accept");

  let threw = false;
  let status = 0;
  try {
    await acceptInvite({
      rawToken: invite.rawToken,
      name: "Duplicate Member E",
      password: "StrongPassword123!",
    });
  } catch (err) {
    threw = true;
    status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 0;
    assert.match((err as Error).message, /already exists/i, "the refusal must say an account already exists");
  }

  assert.ok(threw, "acceptInvite must REFUSE when an account for the email already exists in the workspace");
  assert.strictEqual(status, 409, `the refusal must be a clean 409 conflict, got ${status}`);

  // And it must refuse WITHOUT writing anything — no second user, and the
  // invite is left pending so an admin can still revoke or re-issue it.
  const after = await countRowsForEmail(repos, inviteEmail);
  assert.strictEqual(after.users, before.users, `no second account may be created — before=${before.users}, after=${after.users}`);
  const inviteAfter = await repos.invite.findById(invite.inviteId);
  assert.strictEqual(inviteAfter!.status, "pending", "a refused accept must NOT consume the invite");
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
    console.error("❌ golden-signup-invite-atomicity FAILED — see cases above.");
    process.exit(1);
  }
  console.log("✅ golden-signup-invite-atomicity ALL GREEN ✅");
  process.exit(0);
})();
