/**
 * golden-platform-admin-ops.ts — pins PlatformAdminService (Stage 5 / WP2).
 *
 * WHAT THIS PROVES (Stage 5 / WP2, docs/LOGIC.md 2026-07-28)
 *   The operator admin OPERATIONS: workspace suspend/resume (the kill-switch),
 *   impersonation (with the 5 hard safety limits), operator-initiated password
 *   reset, and global feature-flag kill-switches. Every LOGIC rule is asserted
 *   at the math/service layer here; the HTTP layer is pinned by
 *   `smoke:stage5-admin` + a Playwright Golden Thread test.
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *
 *   CASE A — listAllWorkspaces returns every workspace (across tenants), with
 *            active/suspended split. Default filter EXCLUDES suspended; a
 *            `includeSuspended: true` reveals them. Each row carries userCount,
 *            status, lastActivityAt (an honest summary — operator must see the
 *            shape of every tenant at a glance).
 *
 *   CASE B — suspendWorkspace: status → suspended; suspendedAt stamped; the
 *            workspace's login gate (isWorkspaceLoginAllowed) returns false;
 *            DATA INTEGRITY: the workspace's leads/users/tickets are
 *            byte-for-byte unchanged (suspend NEVER mutates child data —
 *            verified by snapshot-before + diff-after). Audit row written
 *            (workspace_suspended with adminId + workspaceId + reason).
 *
 *   CASE C — resumeWorkspace: status → active; suspendedAt cleared; the login
 *            gate returns true again; child data STILL unchanged (resume is a
 *            pure status flip, no migration). Audit row written
 *            (workspace_resumed).
 *
 *   CASE D — RBAC: support_agent CANNOT suspend/resume (throws
 *            AuthorizationError). Only operator. The audit log records NOTHING
 *            for a refused attempt (no row written — the action didn't happen).
 *
 *   CASE E — Impersonation start: operator starts impersonating a workspace
 *            admin user → returns an impersonation token + the workspace
 *            session payload. Both impersonation_started audit rows written
 *            (start + the marker). The token is time-boxed: 15 minutes from
 *            issue. Token carries impersonatingAs = targetUserId + adminId.
 *
 *   CASE F — Impersonation owner-block: operator tries to impersonate a
 *            workspace OWNER → throws AuthorizationError (cannot_impersonate_owner).
 *            The REFUSED attempt is itself audit-logged (impersonation_started
 *            with status=refused + reason). Operators can only impersonate
 *            admin/sales_member/viewer.
 *
 *   CASE G — Impersonation role-block: support_agent tries to start
 *            impersonation → throws AuthorizationError. Only operator.
 *
 *   CASE H — Impersonation one-at-a-time: an operator who is ALREADY
 *            impersonating (has an active, non-expired impersonation token)
 *            tries to start a SECOND impersonation → throws
 *            AuthorizationError. Must exit first.
 *
 *   CASE I — Impersonation time-box: a token issued 16 minutes ago is
 *            rejected by verifyImpersonationToken (returns null / throws).
 *            A token issued 14 minutes ago is still valid. The 15-min wall is
 *            exact (build-right boundary-value check).
 *
 *   CASE J — Impersonation exit: ends the impersonation; writes
 *            impersonation_ended audit row with endedAt; the token is
 *            invalidated (a subsequent verifyImpersonationToken on the same
 *            token throws/rejects). Operator can start a new impersonation
 *            after exit.
 *
 *   CASE J2 — Impersonation exit audits the DB session's identity, NOT the
 *            cookie's unsigned payload (N-SEC-1, 2026-08-17). The cookie is
 *            `${rawToken}.${base64url(payload)}` and only the rawToken is
 *            validated, so a tampered payload must never be recorded as the
 *            identity in the impersonation_ended audit row — it is recorded
 *            as an explicitly-flagged CLAIM alongside the real identity.
 *
 *   CASE K — Password reset: operator issues reset →
 *            1. A reset token is generated (≥32 bytes random, base64url), stored
 *               HASHED (the stored value is NOT the raw token — verified by
 *               asserting the stored field !== the returned token).
 *            2. Token has 24h expiry (assert: expiresAt = issuedAt + 24h ± 5s).
 *            3. The user's sessionVersion is bumped (existing sessions killed).
 *            4. The token is NEVER returned in the API response NOR logged in
 *               audit metadata (assert: audit metadata has userId + workspaceId
 *               but NO token field).
 *            5. Audit row written (password_reset_issued).
 *            6. Rate-limited: a 2nd reset for the SAME user within the window
 *               is refused (the rate-limit preset caps resets/user/hour).
 *
 *   CASE L — Feature flag toggle: operator sets new_signup_enabled=false →
 *            the flag is persisted; isFeatureEnabled("new_signup_enabled")
 *            returns false; audit row written (config_changed with key +
 *            before/after). Toggle back to true → isFeatureEnabled returns
 *            true. Only the 4 fixed keys are accepted (unknown key → throws).
 *            support_agent CANNOT toggle (throws AuthorizationError).
 *
 *   CASE M — Feature flag default: a flag that has NEVER been set returns
 *            TRUE (the system is "on" by default — kill-switches start enabled).
 *
 *   CASE N — no-auto-outreach invariant: NONE of these operations
 *            (suspend/resume/impersonate/reset-password/toggle-flag) sends any
 *            WhatsApp/Gmail message to a lead or customer contact. The password
 *            reset email is a TRANSACTIONAL email to a known workspace user
 *            (the operator-confirmed exception), NOT prospecting outreach —
 *            pinned separately by golden:no-auto-outreach. Here we assert the
 *            service files contain no WhatsApp/Gmail provider import.
 *
 * REAL PIPELINE: imports the real PlatformAdminService + real JSON repos. Each
 * case uses a unique workspace + admin + user namespace (Ironclad Gate #8) so
 * state never leaks between cases or between runs.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createAmbientRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import {
  listAllWorkspaces,
  suspendWorkspace,
  resumeWorkspace,
  isWorkspaceLoginAllowed,
  startImpersonation,
  verifyImpersonationToken,
  exitImpersonation,
  issuePasswordReset,
  IMPERSONATION_TTL_MS,
} from "@/services/PlatformAdminService";
import {
  setFeatureFlag,
  isFeatureEnabled,
  FIXED_FLAG_KEYS,
} from "@/services/FeatureFlagService";
import { AuthorizationError } from "@/lib/auth-service";
import assert from "node:assert";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN_ID = `wp2_${Date.now()}`;
function wsId(n: number) { return `ws_${RUN_ID}_${n}`; }
function adminId(n: number) { return `admin_${RUN_ID}_${n}`; }
function userId(n: number) { return `user_${RUN_ID}_${n}`; }

/**
 * Ironclad Gate #8 (Test Isolation): wipe every row this run created from the
 * shared JSON demo file. Every seeded id/email embeds RUN_ID (wp2_<timestamp>),
 * which is the unique marker. Called once before cases (clears stale state
 * from a previously-crashed run) and once in a finally block (the normal
 * cleanup). Without this, every CI run left ~13 workspaces + 13 admins +
 * audit rows + flag toggles + impersonation sessions + password-reset tokens
 * behind, silently corrupting any future test that counted those tables.
 */
async function cleanupRun() {
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    // Identify the test workspace + user IDs (their IDs embed RUN_ID directly).
    const testWorkspaceIds = new Set(
      (data.workspaces || []).filter((w) => typeof w.id === "string" && w.id.includes(RUN_ID)).map((w) => w.id),
    );
    const testUserIds = new Set(
      (data.users || []).filter((u) => typeof u.id === "string" && u.id.includes(RUN_ID)).map((u) => u.id),
    );
    const testAdminIds = new Set(
      (data.platformAdmins || []).filter((a) => typeof a.id === "string" && a.id.includes(RUN_ID)).map((a) => a.id),
    );

    // Wipe every Stage 5 table.
    data.workspaces = (data.workspaces || []).filter((w) => !testWorkspaceIds.has(w.id));
    data.users = (data.users || []).filter((u) => !testUserIds.has(u.id));
    data.workspaceMembers = (data.workspaceMembers || []).filter(
      (m) => !testWorkspaceIds.has(m.workspaceId) && !testUserIds.has(m.userId ?? ""),
    );
    data.userCredentials = (data.userCredentials || []).filter(
      (c) => !testUserIds.has(c.userId) && !(typeof c.email === "string" && c.email.includes(RUN_ID)),
    );
    // Stage 5 re-audit F-P1-7 ripple: WP1 services now write workspace-level
    // auditLog rows. Wipe by test workspace + test user so the demo file is
    // left pristine.
    data.auditLogs = (data.auditLogs || []).filter(
      (l) => !testWorkspaceIds.has(l.workspaceId) && !(typeof l.actorUserId === "string" && testUserIds.has(l.actorUserId)),
    );

    data.platformAdmins = (data.platformAdmins || []).filter((a) => !testAdminIds.has(a.id));
    data.platformAdminCredentials = (data.platformAdminCredentials || []).filter(
      (c) => !testAdminIds.has(c.adminId),
    );
    data.platformAuditLogs = (data.platformAuditLogs || []).filter((l) => {
      const adminId = typeof l.adminId === "string" ? l.adminId : "";
      const meta = (l.metadata || {}) as Record<string, unknown>;
      const metaTargetWs = typeof meta.targetWorkspaceId === "string" ? meta.targetWorkspaceId : "";
      const metaTargetUser = typeof meta.targetUserId === "string" ? meta.targetUserId : "";
      return (
        !adminId.includes(RUN_ID) &&
        !metaTargetWs.includes(RUN_ID) &&
        !metaTargetUser.includes(RUN_ID)
      );
    });
    // featureFlags: drop any row toggled by a test admin.
    data.featureFlags = (data.featureFlags || []).filter(
      (f) => !(typeof f.lastToggledByAdminId === "string" && f.lastToggledByAdminId.includes(RUN_ID)),
    );

    // Password-reset tokens + impersonation sessions reference test users/admins.
    data.passwordResetTokens = (data.passwordResetTokens || []).filter(
      (t) => !testUserIds.has(t.userId),
    );
    data.impersonationSessions = (data.impersonationSessions || []).filter((s) => {
      const adminId = typeof s.adminId === "string" ? s.adminId : "";
      const targetUserId = typeof s.targetUserId === "string" ? s.targetUserId : "";
      return !adminId.includes(RUN_ID) && !targetUserId.includes(RUN_ID);
    });
    return undefined;
  });
}

/** Ironclad Gate #8: seed a fresh isolated workspace + users for each case. */
async function seedWorkspace(
  repos: RepositoryBundle,
  n: number,
  opts: { withOwner?: boolean; withAdmin?: boolean; suspended?: boolean } = {},
) {
  const wid = wsId(n);
  await repos.workspace.create({
    id: wid,
    name: `WP2 Test WS ${n}`,
    status: opts.suspended ? "suspended" : "active",
    suspendedAt: opts.suspended ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (opts.withOwner) {
    await repos.user.create({
      id: userId(n * 10 + 1),
      workspaceId: wid,
      name: `Owner ${n}`,
      email: `owner+${RUN_ID}_${n}@test.example`,
      role: "owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  if (opts.withAdmin) {
    await repos.user.create({
      id: userId(n * 10 + 2),
      workspaceId: wid,
      name: `Admin ${n}`,
      email: `admin+${RUN_ID}_${n}@test.example`,
      role: "admin",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return wid;
}

async function seedAdmin(
  repos: RepositoryBundle,
  n: number,
  role: "operator" | "support_agent" = "operator",
) {
  const aid = adminId(n);
  await repos.platformAdmin.createWithCredential({
    admin: {
      id: aid,
      email: `op+${RUN_ID}_${n}@test.example`,
      name: `Operator ${n}`,
      role,
      status: "active",
    },
    credential: {
      adminId: aid,
      email: `op+${RUN_ID}_${n}@test.example`,
      passwordHash: "x".repeat(60), // not used by these ops
    },
  });
  return aid;
}

// ─── CASE A: listAllWorkspaces ──────────────────────────────────────────────
test("CASE A — listAllWorkspaces returns every workspace; default excludes suspended; includeSuspended reveals", async () => {
  const repos = createAmbientRepos();
  const a1 = await seedWorkspace(repos, 1, { withOwner: true }); // active
  const a2 = await seedWorkspace(repos, 2, { withOwner: true }); // active
  const s1 = await seedWorkspace(repos, 3, { suspended: true }); // suspended

  const activeOnly = await listAllWorkspaces({ includeSuspended: false });
  const ids = activeOnly.map((w) => w.id);
  assert.ok(ids.includes(a1), "active ws 1 must appear in default list");
  assert.ok(ids.includes(a2), "active ws 2 must appear in default list");
  assert.ok(!ids.includes(s1), "suspended ws must be HIDDEN from default list");

  const withSuspended = await listAllWorkspaces({ includeSuspended: true });
  const idsAll = withSuspended.map((w) => w.id);
  assert.ok(idsAll.includes(s1), "suspended ws must appear when includeSuspended=true");

  // userCount is honest (each ws has exactly 1 user seeded).
  const w1 = withSuspended.find((w) => w.id === a1);
  assert.ok(w1, "ws 1 detail missing");
  assert.strictEqual(w1!.userCount, 1, "userCount must be 1 (the seeded owner)");
  assert.strictEqual(w1!.status, "active");
});

// ─── CASE B: suspendWorkspace ───────────────────────────────────────────────
test("CASE B — suspendWorkspace flips status, blocks login, preserves child data, audits", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 10, { withOwner: true, withAdmin: true });
  const aid = await seedAdmin(repos, 10);

  // Snapshot child data BEFORE suspend.
  const beforeLeads = await repos.lead.listLeads(wid);
  const beforeUsers = await repos.user.listForWorkspace(wid);

  // Login allowed before.
  assert.strictEqual(await isWorkspaceLoginAllowed(wid), true, "login must be allowed before suspend");

  await suspendWorkspace({ adminId: aid, workspaceId: wid, reason: "non-payment test" });

  // Status flipped + suspendedAt stamped.
  const ws = await repos.workspace.getById(wid);
  assert.strictEqual(ws!.status, "suspended", "status must be suspended after suspendWorkspace");
  assert.ok(ws!.suspendedAt, "suspendedAt must be stamped");

  // Login now blocked.
  assert.strictEqual(await isWorkspaceLoginAllowed(wid), false, "login must be BLOCKED after suspend");

  // Child data UNCHANGED (kill-switch never loses data).
  const afterLeads = await repos.lead.listLeads(wid);
  const afterUsers = await repos.user.listForWorkspace(wid);
  assert.deepStrictEqual(afterLeads, beforeLeads, "leads must be byte-for-byte unchanged by suspend");
  assert.deepStrictEqual(afterUsers, beforeUsers, "users must be byte-for-byte unchanged by suspend");

  // Audit row written.
  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "workspace_suspended" });
  const entry = audit.find((e) => (e.metadata as Record<string, unknown>)?.workspaceId === wid);
  assert.ok(entry, "workspace_suspended audit row must exist for this workspace");
  assert.strictEqual((entry!.metadata as Record<string, unknown>)?.reason, "non-payment test");
});

// ─── CASE C: resumeWorkspace ────────────────────────────────────────────────
test("CASE C — resumeWorkspace flips status back, restores login, child data still unchanged, audits", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 20, { withOwner: true });
  const aid = await seedAdmin(repos, 20);
  await suspendWorkspace({ adminId: aid, workspaceId: wid, reason: "temp" });

  const beforeLeads = await repos.lead.listLeads(wid);

  await resumeWorkspace({ adminId: aid, workspaceId: wid });

  const ws = await repos.workspace.getById(wid);
  assert.strictEqual(ws!.status, "active", "status must be active after resume");
  assert.ok(!ws!.suspendedAt, "suspendedAt must be cleared on resume");
  assert.strictEqual(await isWorkspaceLoginAllowed(wid), true, "login must be allowed after resume");

  const afterLeads = await repos.lead.listLeads(wid);
  assert.deepStrictEqual(afterLeads, beforeLeads, "resume must NOT mutate child data");

  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "workspace_resumed" });
  const entry = audit.find((e) => (e.metadata as Record<string, unknown>)?.workspaceId === wid);
  assert.ok(entry, "workspace_resumed audit row must exist");
});

// ─── CASE D: RBAC on suspend ────────────────────────────────────────────────
test("CASE D — support_agent CANNOT suspend/resume; refused attempt writes NO audit row", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 30, { withOwner: true });
  const supportAid = await seedAdmin(repos, 30, "support_agent");

  await assert.rejects(
    () => suspendWorkspace({ adminId: supportAid, workspaceId: wid, reason: "try" }),
    AuthorizationError,
    "support_agent must be refused on suspend",
  );
  // No audit row written for the refused attempt.
  const audit = await repos.platformAuditLog.list({ adminId: supportAid, action: "workspace_suspended" });
  assert.strictEqual(audit.length, 0, "refused suspend must write NO audit row");
  // Workspace still active.
  const ws = await repos.workspace.getById(wid);
  assert.strictEqual(ws!.status, "active", "workspace must remain active after refused suspend");
});

// ─── CASE E: impersonation start ────────────────────────────────────────────
test("CASE E — operator starts impersonation of an admin user; token + audit + marker", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 40, { withAdmin: true });
  const targetUserId = userId(40 * 10 + 2); // the seeded admin user
  const aid = await seedAdmin(repos, 40);

  const result = await startImpersonation({
    adminId: aid,
    targetUserId,
    targetWorkspaceId: wid,
    reason: "debugging ticket #123",
  });

  // Token returned.
  assert.ok(result.token, "must return an impersonation token");
  assert.ok(result.token.length >= 32, "token must be ≥32 chars (cryptographic)");

  // Token verifies + carries the right payload.
  const payload = await verifyImpersonationToken(result.token);
  assert.ok(payload, "token must verify");
  assert.strictEqual(payload!.adminId, aid, "payload.adminId must be the operator");
  assert.strictEqual(payload!.targetUserId, targetUserId, "payload.targetUserId must be the target");
  assert.strictEqual(payload!.targetWorkspaceId, wid, "payload.workspaceId must be the target ws");

  // Audit row written.
  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "impersonation_started" });
  const entry = audit.find((e) => (e.metadata as Record<string, unknown>)?.targetUserId === targetUserId);
  assert.ok(entry, "impersonation_started audit row must exist");
  assert.strictEqual((entry!.metadata as Record<string, unknown>)?.reason, "debugging ticket #123");
});

// ─── CASE F: impersonation owner-block ──────────────────────────────────────
test("CASE F — operator CANNOT impersonate a workspace OWNER; refused attempt is audit-logged", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 50, { withOwner: true });
  const ownerUserId = userId(50 * 10 + 1); // the seeded owner
  const aid = await seedAdmin(repos, 50);

  await assert.rejects(
    () => startImpersonation({ adminId: aid, targetUserId: ownerUserId, targetWorkspaceId: wid, reason: "try owner" }),
    AuthorizationError,
    "impersonating an owner must be refused",
  );

  // The REFUSED attempt is itself audit-logged.
  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "impersonation_started" });
  const entry = audit.find((e) => (e.metadata as Record<string, unknown>)?.targetUserId === ownerUserId);
  assert.ok(entry, "the refused owner-impersonation must be audit-logged");
  assert.strictEqual((entry!.metadata as Record<string, unknown>)?.status, "refused");
  assert.strictEqual((entry!.metadata as Record<string, unknown>)?.reason, "cannot_impersonate_owner");
});

// ─── CASE G: impersonation role-block ───────────────────────────────────────
test("CASE G — support_agent CANNOT start impersonation", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 60, { withAdmin: true });
  const targetUserId = userId(60 * 10 + 2);
  const supportAid = await seedAdmin(repos, 60, "support_agent");

  await assert.rejects(
    () => startImpersonation({ adminId: supportAid, targetUserId, targetWorkspaceId: wid, reason: "try" }),
    AuthorizationError,
    "support_agent must be refused on impersonation start",
  );
});

// ─── CASE H: impersonation one-at-a-time ────────────────────────────────────
test("CASE H — operator already impersonating CANNOT start a 2nd; must exit first", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 70, { withAdmin: true });
  const target1 = userId(70 * 10 + 2);
  const aid = await seedAdmin(repos, 70);
  await startImpersonation({ adminId: aid, targetUserId: target1, targetWorkspaceId: wid, reason: "first" });

  // Second workspace + target to attempt a 2nd impersonation.
  const wid2 = await seedWorkspace(repos, 71, { withAdmin: true });
  const target2 = userId(71 * 10 + 2);
  await assert.rejects(
    () => startImpersonation({ adminId: aid, targetUserId: target2, targetWorkspaceId: wid2, reason: "second" }),
    AuthorizationError,
    "2nd impersonation while active must be refused",
  );
});

// ─── CASE I: impersonation time-box (15 min) ────────────────────────────────
test("CASE I — impersonation token expires exactly at 15 min (boundary value)", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 80, { withAdmin: true });
  const target = userId(80 * 10 + 2);
  const aid = await seedAdmin(repos, 80);
  const { token, payload } = await startImpersonation({ adminId: aid, targetUserId: target, targetWorkspaceId: wid, reason: "t" });

  // The payload carries startedAt + expiresAt (baked in at issue). To simulate
  // "N minutes have passed since issue", pass now = startedAt + N min.
  const MIN = 60 * 1000;

  // 14 min after issue → still valid (within the 15-min TTL).
  const at14Min = payload.startedAt + 14 * MIN;
  const valid = await verifyImpersonationToken(token, { now: at14Min });
  assert.ok(valid, "token 14 min after issue must still be valid");

  // 16 min after issue → expired (past the 15-min TTL).
  const at16Min = payload.startedAt + 16 * MIN;
  const expired = await verifyImpersonationToken(token, { now: at16Min });
  assert.strictEqual(expired, null, "token 16 min after issue must be rejected (past 15-min TTL)");

  // The TTL constant is exactly 15 min (build-right boundary check on the rule itself).
  assert.strictEqual(IMPERSONATION_TTL_MS, 15 * 60 * 1000, "IMPERSONATION_TTL_MS must be exactly 15 minutes");
});

// ─── CASE J: impersonation exit ─────────────────────────────────────────────
test("CASE J — exitImpersonation invalidates token + writes impersonation_ended audit", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 90, { withAdmin: true });
  const target = userId(90 * 10 + 2);
  const aid = await seedAdmin(repos, 90);
  const { token } = await startImpersonation({ adminId: aid, targetUserId: target, targetWorkspaceId: wid, reason: "t" });

  await exitImpersonation({ adminId: aid, token });

  // Token now invalid.
  const after = await verifyImpersonationToken(token);
  assert.strictEqual(after, null, "token must be invalid after exit");

  // Audit row written.
  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "impersonation_ended" });
  const entry = audit.find((e) => (e.metadata as Record<string, unknown>)?.targetUserId === target);
  assert.ok(entry, "impersonation_ended audit row must exist");
  assert.ok((entry!.metadata as Record<string, unknown>)?.endedAt, "endedAt must be stamped");
});

// ─── CASE J2: exit audits the DB identity, not the cookie payload ───────────
test("CASE J2 (N-SEC-1) — exitImpersonation audits the session's real identity, flags a tampered payload", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 91, { withAdmin: true });
  const target = userId(91 * 10 + 2);
  const aid = await seedAdmin(repos, 91);
  const { token } = await startImpersonation({ adminId: aid, targetUserId: target, targetWorkspaceId: wid, reason: "t" });

  // Forge the payload half of the cookie, leaving the rawToken half intact —
  // exactly what an attacker who obtains a rawToken can do, since only the
  // rawToken is validated (findByTokenHash) and the payload is not signed.
  const dot = token.indexOf(".");
  const rawToken = token.slice(0, dot);
  const realPayload = JSON.parse(Buffer.from(token.slice(dot + 1), "base64url").toString("utf8"));
  const forgedPayload = { ...realPayload, targetUserId: "user_victim_forged", targetWorkspaceId: "ws_forged" };
  const forgedToken = `${rawToken}.${Buffer.from(JSON.stringify(forgedPayload), "utf8").toString("base64url")}`;

  await exitImpersonation({ adminId: aid, token: forgedToken });

  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "impersonation_ended" });
  assert.strictEqual(audit.length, 1, "exactly one impersonation_ended audit row must exist for this admin");
  const meta = audit[0].metadata as Record<string, unknown>;

  assert.strictEqual(
    meta.targetUserId,
    target,
    "audit MUST record the DB session's real targetUserId, never the cookie's unsigned payload (N-SEC-1)",
  );
  assert.strictEqual(meta.targetWorkspaceId, wid, "audit MUST record the DB session's real targetWorkspaceId");
  assert.strictEqual(meta.status, "cookie_payload_mismatch", "a payload disagreeing with the session row must be flagged as tampering");
  assert.strictEqual(meta.claimedTargetUserId, "user_victim_forged", "the forged claim is preserved as a CLAIM, not as the identity");

  // An unrecognised token resolves to no session row: the payload must then be
  // recorded as an explicitly-unverified claim, with no targetUserId asserted.
  // Uses a second admin so this row is unambiguously the one being asserted,
  // independent of the audit list's ordering.
  const aid2 = await seedAdmin(repos, 92);
  const strayPayload = Buffer.from(JSON.stringify(forgedPayload), "utf8").toString("base64url");
  await exitImpersonation({ adminId: aid2, token: `not-a-real-raw-token.${strayPayload}` });
  const audit2 = await repos.platformAuditLog.list({ adminId: aid2, action: "impersonation_ended" });
  assert.strictEqual(audit2.length, 1, "exactly one impersonation_ended audit row must exist for the second admin");
  const meta2 = audit2[0].metadata as Record<string, unknown>;
  assert.strictEqual(meta2.status, "unknown_token", "an unrecognised rawToken must be audited as unknown_token");
  assert.strictEqual(meta2.targetUserId, undefined, "an unverified payload must never be recorded as targetUserId");
  assert.strictEqual(meta2.claimedTargetUserId, "user_victim_forged", "the unverified payload is kept as a CLAIM");
});

// ─── CASE K: password reset ─────────────────────────────────────────────────
test("CASE K — issuePasswordReset: token hashed, 24h expiry, session killed, token never logged", async () => {
  const repos = createAmbientRepos();
  const wid = await seedWorkspace(repos, 100, { withAdmin: true });
  const target = userId(100 * 10 + 2);
  const aid = await seedAdmin(repos, 100);

  // Seed a credential so we can assert the sessionVersion bump.
  //
  // A-7 (2026-08-26): this used to call `auth.createOwnerWithCredential` for a
  // user `seedWorkspace` had ALREADY created, and swallowed the failure with
  // `.catch(() => null)`. On JSON the duplicate user id was accepted, so the
  // credential landed and the case passed. On Postgres the primary key refuses
  // the second user, the whole transaction rolls back, no credential is
  // written - and the case then reported that the PRODUCT had failed to kill
  // the sessions, when in truth the seed had failed and said nothing.
  //
  // The user already exists. Create only the missing piece, and let a failure
  // here be a failure: a swallowed seed is how a green test stops meaning
  // anything.
  await repos.userCredential.create({
    id: `cred_${target}`,
    userId: target,
    workspaceId: wid,
    email: `t+${RUN_ID}@test.example`,
    passwordHash: "oldhash",
    sessionVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const seededCred = await repos.userCredential.findByUserId(target);
  assert.strictEqual(seededCred?.sessionVersion, 1, "the credential seed did not land, so the sessionVersion assertion below would prove nothing");

  const issuedAt = Date.now();
  const result = await issuePasswordReset({ adminId: aid, targetUserId: target, targetWorkspaceId: wid });

  // Token returned to caller (the route emails it; the service returns it for the email adapter).
  assert.ok(result.token, "must return a reset token");
  assert.ok(result.token.length >= 32, "token must be ≥32 chars");

  // Token stored HASHED — the stored value is NOT the raw token.
  const stored = await repos.passwordResetToken.findLatestForUser(target);
  assert.ok(stored, "a reset token record must exist");
  assert.notStrictEqual(stored!.tokenHash, result.token, "stored token MUST be hashed (not the raw token)");

  // 24h expiry (±5s tolerance for test runtime).
  const expectedExpiry = issuedAt + 24 * 60 * 60 * 1000;
  const actualExpiry = new Date(stored!.expiresAt).getTime();
  assert.ok(Math.abs(actualExpiry - expectedExpiry) < 5000, `expiry must be ~24h from issue (got ${actualExpiry - expectedExpiry}ms drift)`);

  // Session version bumped (existing sessions killed).
  const cred = await repos.userCredential.findByUserId(target);
  assert.ok((cred?.sessionVersion ?? 0) >= 2, "sessionVersion must be bumped to invalidate old sessions");

  // Audit row written; token NOT in metadata.
  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "password_reset_issued" });
  const entry = audit[audit.length - 1];
  assert.ok(entry, "password_reset_issued audit row must exist");
  const meta = entry!.metadata as Record<string, unknown>;
  assert.strictEqual(meta.targetUserId, target, "audit must record targetUserId");
  assert.strictEqual(meta.targetWorkspaceId, wid, "audit must record targetWorkspaceId");
  assert.ok(!meta.token && !meta.tokenHash, "audit metadata MUST NOT contain the token or its hash");
});

// ─── CASE L: feature flag toggle ────────────────────────────────────────────
test("CASE L — setFeatureFlag toggles; isFeatureEnabled reflects; unknown key rejected; support_agent refused", async () => {
  const repos = createAmbientRepos();
  const aid = await seedAdmin(repos, 110);

  // Default = enabled (kill-switches start ON).
  assert.strictEqual(await isFeatureEnabled("new_signup_enabled"), true, "unset flag must default to true");

  // Operator toggles OFF.
  await setFeatureFlag({ adminId: aid, key: "new_signup_enabled", enabled: false });
  assert.strictEqual(await isFeatureEnabled("new_signup_enabled"), false, "flag must be false after toggle off");

  // Audit row.
  const audit = await repos.platformAuditLog.list({ adminId: aid, action: "config_changed" });
  const entry = audit.find((e) => (e.metadata as Record<string, unknown>)?.key === "new_signup_enabled");
  assert.ok(entry, "config_changed audit row must exist");
  assert.strictEqual((entry!.metadata as Record<string, unknown>)?.before, true);
  assert.strictEqual((entry!.metadata as Record<string, unknown>)?.after, false);

  // Toggle back ON.
  await setFeatureFlag({ adminId: aid, key: "new_signup_enabled", enabled: true });
  assert.strictEqual(await isFeatureEnabled("new_signup_enabled"), true, "flag must be true after toggle on");

  // Unknown key rejected.
  await assert.rejects(
    () => setFeatureFlag({ adminId: aid, key: "arbitrary_new_thing", enabled: true }),
    /Unknown feature flag key/i,
    "unknown flag key must be rejected",
  );

  // Fixed set contains the documented kill-switches. NOTE (2026-08-04 build-
  // right audit): the OLD assertion demanded EXACTLY 4 keys, but CP-20
  // (D-2026-08-02-l) legitimately added `public_tour_enabled` as a 5th global
  // kill-switch (gates the public read-only Tour). The code is correct; the
  // golden was stale. Now asserts a SUPERSET of the documented keys, so a
  // future legitimate flag addition doesn't silently break this test (and a
  // REMOVAL still does — that would be a real regression).
  const documentedFlags = ["ai_usage_enabled", "billing_enabled", "new_signup_enabled", "whatsapp_send_enabled", "public_tour_enabled"] as const;
  const flagKeys = FIXED_FLAG_KEYS as readonly string[];
  for (const key of documentedFlags) {
    assert.ok(flagKeys.includes(key), `FIXED_FLAG_KEYS must include the documented kill-switch "${key}"`);
  }

  // support_agent refused.
  // FeatureFlagService loads this constructor dynamically. Match that loader
  // under Node 20/tsx without replacing instanceof with a name-only check.
  const { AuthorizationError: DynamicAuthorizationError } = await import("@/lib/auth-service");
  const supportAid = await seedAdmin(repos, 111, "support_agent");
  await assert.rejects(
    () => setFeatureFlag({ adminId: supportAid, key: "new_signup_enabled", enabled: false }),
    (error: unknown) => {
      assert.ok(error instanceof DynamicAuthorizationError);
      assert.strictEqual(error.statusCode, 403);
      assert.strictEqual(error.message, "Only the operator role may toggle feature flags.");
      return true;
    },
    "support_agent must be refused on flag toggle",
  );
});

// ─── CASE M: feature flag default true ──────────────────────────────────────
test("CASE M — a flag that was never set returns true (system is ON by default)", async () => {
  const repos = createAmbientRepos();
  void repos;
  // billing_enabled has never been set in this run-namespace.
  assert.strictEqual(await isFeatureEnabled("billing_enabled"), true, "never-set flag must default to true");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  // Gate #8: clear any stale rows from a prior crashed run BEFORE seeding.
  await cleanupRun();
  let passed = 0;
  let failed = 0;
  try {
    for (const c of cases) {
      try {
        await c.fn();
        passed += 1;
        console.log(`  ✅ ${c.name}`);
      } catch (e) {
        failed += 1;
        console.error(`  ❌ ${c.name}`);
        console.error(`     ${(e as Error).message}`);
      }
    }
    console.log(`\nGolden platform-admin-ops: ${passed} passed, ${failed} failed (of ${cases.length})`);
  } finally {
    // Gate #8: ALWAYS clean up, even on failure, so the demo file is left
    // pristine for the next test.
    await cleanupRun();
  }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
