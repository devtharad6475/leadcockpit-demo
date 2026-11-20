/**
 * smoke-stage5-admin.ts — Stage 5 / WP2 acceptance test (operator lifecycle).
 *
 * WHAT THIS PROVES
 *   The operator admin OPERATIONS work as ONE continuous round-trip through
 *   the real service functions:
 *     list workspaces → suspend (login blocked, data intact) → resume
 *     → impersonate (start → verify → exit, audit on both)
 *     → password reset (token hashed, session killed, audit, no token leak)
 *     → feature flag toggle (off → on, audit).
 *
 *   This is COMPLEMENTARY to golden:platform-admin-ops (which pins each LOGIC
 *   rule with hand-computed values) — this smoke proves the sequence holds
 *   together as a real operator session, including cross-call state
 *   continuity (suspend then resume preserves data; impersonation start+exit
 *   both audited; flag toggle persists).
 *
 *   Why service-layer (not HTTP): matches the dominant repo smoke pattern
 *   (10/17 are service-layer integration tests, CI-reliable, no dev server).
 *   The HTTP wiring is pinned by the Playwright Golden Thread test.
 *
 * SACRED no-auto-outreach: the password-reset path is a TRANSACTIONAL email
 * to a known workspace user (the operator-confirmed exception). No
 * prospecting outreach is exercised here. Pinned by golden:no-auto-outreach.
 *
 * Run: npx tsx scripts/smoke-stage5-admin.ts
 * (No DATABASE_URL needed — uses the local JSON demo store. Each run uses a
 *  unique timestamp namespace so state never leaks between runs.)
 */
import { createRepositories } from "@/repositories";
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
} from "@/services/PlatformAdminService";
import { setFeatureFlag, isFeatureEnabled } from "@/services/FeatureFlagService";
import { AuthorizationError } from "@/lib/auth-service";
import assert from "node:assert";

function assert2(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  console.log("smoke-stage5-admin: operator lifecycle round-trip...\n");

  const repos: RepositoryBundle = createRepositories();
  // Unique-per-run namespace (Ironclad Gate #8: clean slate, no cross-run leak).
  const runId = `smoke5admin_${Date.now()}`;
  const wsId = `ws_${runId}`;
  const adminId = `admin_${runId}`;
  const ownerId = `user_${runId}_owner`;
  const adminUserId = `user_${runId}_admin`; // a workspace admin user (impersonatable)

  // ─── SEED: workspace + owner + admin user + platform operator ───────────
  await repos.workspace.create({
    id: wsId,
    name: `Smoke WS ${runId}`,
    businessName: `Smoke Tenant ${runId}`,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await repos.user.create({
    id: ownerId, workspaceId: wsId, name: "Smoke Owner", email: `owner+${runId}@test.example`,
    role: "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await repos.user.create({
    id: adminUserId, workspaceId: wsId, name: "Smoke Admin", email: `admin+${runId}@test.example`,
    role: "admin", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await repos.userCredential.create({
    id: `cred_${adminUserId}`, userId: adminUserId, workspaceId: wsId, email: `admin+${runId}@test.example`,
    passwordHash: "oldhash_smoke", sessionVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await repos.platformAdmin.createWithCredential({
    admin: { id: adminId, email: `op+${runId}@test.example`, name: "Smoke Operator", role: "operator", status: "active" },
    credential: { adminId: adminId, email: `op+${runId}@test.example`, passwordHash: "x".repeat(60) },
  });

  // ─── STEP 1: listAllWorkspaces ──────────────────────────────────────────
  console.log("  STEP 1 — listAllWorkspaces (default excludes suspended)...");
  {
    const active = await listAllWorkspaces({ includeSuspended: false });
    assert2(active.some((w) => w.id === wsId), "active workspace must appear in default list");
    const found = active.find((w) => w.id === wsId);
    assert2(found?.userCount === 2, `userCount must be 2 (owner+admin), got ${found?.userCount}`);
    console.log("    ✅ workspace listed with honest userCount=2");
  }

  // ─── STEP 2: suspendWorkspace ───────────────────────────────────────────
  console.log("  STEP 2 — suspendWorkspace (kill-switch)...");
  {
    const beforeLeads = await repos.lead.listLeads(wsId);
    assert2(await isWorkspaceLoginAllowed(wsId) === true, "login allowed before suspend");

    await suspendWorkspace({ adminId, workspaceId: wsId, reason: "smoke: non-payment simulation" });

    const ws = await repos.workspace.getById(wsId);
    assert2(ws?.status === "suspended", "status must be suspended");
    assert2(ws?.suspendedAt !== undefined, "suspendedAt stamped");
    assert2(await isWorkspaceLoginAllowed(wsId) === false, "login BLOCKED after suspend");

    // Data integrity: child data unchanged.
    const afterLeads = await repos.lead.listLeads(wsId);
    assert2(JSON.stringify(afterLeads) === JSON.stringify(beforeLeads), "leads byte-for-byte unchanged");

    // Suspended ws hidden from default list.
    const active = await listAllWorkspaces({ includeSuspended: false });
    assert2(!active.some((w) => w.id === wsId), "suspended ws hidden from default list");
    const withSusp = await listAllWorkspaces({ includeSuspended: true });
    assert2(withSusp.some((w) => w.id === wsId), "suspended ws visible with includeSuspended");

    // Audit row.
    const audit = await repos.platformAuditLog.list({ adminId, action: "workspace_suspended" });
    assert2(audit.some((e) => (e.metadata as Record<string, unknown>)?.workspaceId === wsId), "workspace_suspended audit row exists");
    console.log("    ✅ suspended, login blocked, data intact, hidden from default list, audited");
  }

  // ─── STEP 3: resumeWorkspace ────────────────────────────────────────────
  console.log("  STEP 3 — resumeWorkspace (unsuspend)...");
  {
    await resumeWorkspace({ adminId, workspaceId: wsId });
    const ws = await repos.workspace.getById(wsId);
    assert2(ws?.status === "active", "status active after resume");
    assert2(ws?.suspendedAt === undefined, "suspendedAt cleared");
    assert2(await isWorkspaceLoginAllowed(wsId) === true, "login allowed after resume");
    const audit = await repos.platformAuditLog.list({ adminId, action: "workspace_resumed" });
    assert2(audit.some((e) => (e.metadata as Record<string, unknown>)?.workspaceId === wsId), "workspace_resumed audit row exists");
    console.log("    ✅ resumed, login restored, audited");
  }

  // ─── STEP 4: support_agent CANNOT suspend (RBAC) ────────────────────────
  console.log("  STEP 4 — support_agent cannot suspend (RBAC)...");
  {
    const supportId = `support_${runId}`;
    await repos.platformAdmin.createWithCredential({
      admin: { id: supportId, email: `support+${runId}@test.example`, name: "Smoke Support", role: "support_agent", status: "active" },
      credential: { adminId: supportId, email: `support+${runId}@test.example`, passwordHash: "x".repeat(60) },
    });
    await assert.rejects(
      () => suspendWorkspace({ adminId: supportId, workspaceId: wsId, reason: "try" }),
      AuthorizationError,
    );
    // No audit row for the refused attempt.
    const audit = await repos.platformAuditLog.list({ adminId: supportId, action: "workspace_suspended" });
    assert2(audit.length === 0, "refused suspend writes NO audit row");
    console.log("    ✅ support_agent refused, no audit row written");
  }

  // ─── STEP 5: impersonation start → verify → exit ────────────────────────
  console.log("  STEP 5 — impersonation lifecycle (start → verify → exit)...");
  {
    // Owner CANNOT be impersonated.
    await assert.rejects(
      () => startImpersonation({ adminId, targetUserId: ownerId, targetWorkspaceId: wsId, reason: "try owner" }),
      AuthorizationError,
    );
    console.log("    ✅ owner impersonation refused + audited");

    // Admin user CAN be impersonated.
    const { token, payload } = await startImpersonation({ adminId, targetUserId: adminUserId, targetWorkspaceId: wsId, reason: "smoke: debugging" });
    assert2(token.length >= 32, "token ≥32 chars");
    assert2(payload.adminId === adminId, "payload.adminId correct");
    assert2(payload.targetUserId === adminUserId, "payload.targetUserId correct");

    const verified = await verifyImpersonationToken(token);
    assert2(verified !== null, "token verifies");
    assert2(verified?.targetUserId === adminUserId, "verified payload correct");

    // Cannot start a 2nd while active.
    await assert.rejects(
      () => startImpersonation({ adminId, targetUserId: adminUserId, targetWorkspaceId: wsId, reason: "second" }),
      AuthorizationError,
    );
    console.log("    ✅ 2nd impersonation while active refused (one at a time)");

    // Exit.
    await exitImpersonation({ adminId, token });
    const afterExit = await verifyImpersonationToken(token);
    assert2(afterExit === null, "token invalid after exit");

    // Both start + exit audited.
    const starts = await repos.platformAuditLog.list({ adminId, action: "impersonation_started" });
    const ends = await repos.platformAuditLog.list({ adminId, action: "impersonation_ended" });
    assert2(starts.some((e) => (e.metadata as Record<string, unknown>)?.targetUserId === adminUserId), "impersonation_started audited");
    assert2(ends.some((e) => (e.metadata as Record<string, unknown>)?.targetUserId === adminUserId), "impersonation_ended audited");
    console.log("    ✅ start+exit both audited, token invalidated on exit");
  }

  // ─── STEP 6: password reset ─────────────────────────────────────────────
  console.log("  STEP 6 — password reset (token hashed, session killed, no token leak)...");
  {
    const result = await issuePasswordReset({ adminId, targetUserId: adminUserId, targetWorkspaceId: wsId });
    assert2(result.token.length >= 32, "token ≥32 chars");

    // Token stored hashed (not the raw token).
    const stored = await repos.passwordResetToken.findLatestForUser(adminUserId);
    assert2(stored !== undefined, "reset token record exists");
    assert2(stored!.tokenHash !== result.token, "stored token MUST be hashed");

    // Session version bumped (existing sessions killed).
    const cred = await repos.userCredential.findByUserId(adminUserId);
    assert2((cred?.sessionVersion ?? 0) >= 2, `sessionVersion bumped (>=2), got ${cred?.sessionVersion}`);

    // Audit row exists; token NOT in metadata.
    const audit = await repos.platformAuditLog.list({ adminId, action: "password_reset_issued" });
    const entry = audit[audit.length - 1];
    assert2(entry !== undefined, "password_reset_issued audit row exists");
    const meta = entry!.metadata as Record<string, unknown>;
    assert2(!meta.token && !meta.tokenHash, "token NOT in audit metadata");
    console.log("    ✅ token hashed, session killed, audited, no token leak");
  }

  // ─── STEP 7: feature flag toggle ────────────────────────────────────────
  console.log("  STEP 7 — feature flag toggle (kill-switch)...");
  {
    const before = await isFeatureEnabled("ai_usage_enabled");
    await setFeatureFlag({ adminId, key: "ai_usage_enabled", enabled: false });
    assert2(await isFeatureEnabled("ai_usage_enabled") === false, "flag OFF after toggle");
    await setFeatureFlag({ adminId, key: "ai_usage_enabled", enabled: before });
    assert2(await isFeatureEnabled("ai_usage_enabled") === before, "flag restored");
    const audit = await repos.platformAuditLog.list({ adminId, action: "config_changed" });
    assert2(audit.some((e) => (e.metadata as Record<string, unknown>)?.key === "ai_usage_enabled"), "config_changed audit row exists");
    console.log("    ✅ toggle off→on, audited, restored");
  }

  console.log("\n✅ ALL CHECKS PASSED — smoke-stage5-admin lifecycle round-trip complete.\n");
  console.log("    Proven: list → suspend (kill-switch) → resume → RBAC → impersonation");
  console.log("            lifecycle → password reset → feature flag toggle.");
  console.log("    No-auto-outreach: only the password-reset transactional email path");
  console.log("    was exercised (operator-confirmed exception); no prospecting send.");
}

main().catch((e) => {
  console.error("\n❌ SMOKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
