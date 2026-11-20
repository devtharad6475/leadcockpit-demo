/**
 * Stage 5 / WP2 (2026-07-28) — Platform admin OPERATIONS service.
 *
 * The operator's day-to-day actions on the SaaS: workspace suspend/resume
 * (the kill-switch), impersonation (with the 5 hard safety limits), and
 * operator-initiated password reset. Every rule below is pinned by
 * golden:platform-admin-ops; the HTTP wiring is pinned by smoke:stage5-admin
 * + a Playwright Golden Thread test.
 *
 * RULES (docs/LOGIC.md 2026-07-28) — enforced HERE (the chokepoint):
 *
 *   Workspace suspend:
 *   - Reversible. status → suspended; suspendedAt + suspendedByAdminId stamped.
 *   - Login for the workspace's users is blocked (isWorkspaceLoginAllowed=false).
 *   - Child data is NEVER mutated (leads/users/tickets byte-for-byte unchanged).
 *   - Operator-only. Refused attempt writes NO audit row.
 *
 *   Impersonation (5 hard limits):
 *   1. Audited (start + exit both write PlatformAuditLog).
 *   2. Time-boxed — IMPERSONATION_TTL_MS = 15 min exactly.
 *   3. One at a time (must exit before starting a 2nd).
 *   4. Owner blocked (admin/sales_member/viewer only; refused attempt IS audited).
 *   5. Marked (the session carries adminId + targetUserId so actions during
 *      impersonation are never mistaken for the user's own).
 *
 *   Password reset:
 *   - One-time token (≥32 bytes random), stored HASHED (SHA-256), 24h expiry.
 *   - Existing sessions killed (UserCredential.sessionVersion bumped).
 *   - Token emailed to the user via the email provider (operator never sees it).
 *   - Audit-logged (password_reset_issued); token NEVER in audit metadata.
 *
 * SACRED no-auto-outreach: NONE of these sends anything to a lead/customer
 * contact. The password-reset email is a TRANSACTIONAL email to a known
 * workspace user (the operator-confirmed exception). Pinned by
 * golden:no-auto-outreach + golden:platform-admin-ops CASE N.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { createHash, randomBytes } from "node:crypto";
import { repositories } from "@/repositories";
import { AuthorizationError } from "@/lib/auth-service";
import { oneAtATime } from "@/lib/one-at-a-time";
import type { ImpersonationSession, PlatformAdmin, PlatformAdminRole, User, Workspace } from "@/lib/types";

export { AuthorizationError };

/** The impersonation time-box. Exactly 15 minutes (boundary pinned by golden CASE I). */
export const IMPERSONATION_TTL_MS = 15 * 60 * 1000;

/** Password-reset token expiry. Exactly 24 hours (pinned by golden CASE K). */
const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;

// ─── helpers ────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Assert the acting admin is an operator. Throws AuthorizationError otherwise. */
async function requireOperator(adminId: string): Promise<PlatformAdmin> {
  const admin = await repositories.platformAdmin.findById(adminId);
  if (!admin) throw new AuthorizationError("Admin not found.");
  if (admin.status === "suspended") throw new AuthorizationError("This admin account is suspended.");
  if (admin.role !== "operator") throw new AuthorizationError("Only the operator role may perform this action.");
  return admin;
}

// ─── Workspace list (operator console) ──────────────────────────────────────

export type WorkspaceSummary = Workspace & { userCount: number };

/**
 * List every workspace (cross-tenant) with an honest user count. Default
 * excludes suspended; includeSuspended reveals them. Pinned by golden CASE A.
 */
export async function listAllWorkspaces(opts: { includeSuspended?: boolean } = {}): Promise<WorkspaceSummary[]> {
  const workspaces = await repositories.workspace.listAll(opts.includeSuspended ?? false);
  // Count users per workspace (N workspaces → N queries; acceptable at tenant
  // scale — a future stage may denormalize a userCount column if this grows).
  const withCounts = await Promise.all(
    workspaces.map(async (w) => {
      const users = await repositories.user.listForWorkspace(w.id);
      return { ...w, userCount: users.length };
    }),
  );
  return withCounts;
}

// ─── Workspace login gate (used by the session layer) ───────────────────────

/**
 * Is login allowed for this workspace? False when suspended. This is the
 * READ chokepoint for the kill-switch login block — the session layer calls
 * this on every authenticated request. Pinned by golden CASE B + CASE C.
 */
export async function isWorkspaceLoginAllowed(workspaceId: string): Promise<boolean> {
  const ws = await repositories.workspace.getById(workspaceId);
  if (!ws) return false; // unknown workspace → fail closed.
  return ws.status !== "suspended";
}

// ─── Workspace suspend / resume ─────────────────────────────────────────────

/**
 * Suspend a workspace (the kill-switch). Operator-only. Flips status →
 * suspended, stamps suspendedAt + suspendedByAdminId, PRESERVES all child
 * data, writes a workspace_suspended audit row. Pinned by golden CASE B + D.
 */
export async function suspendWorkspace(input: {
  adminId: string;
  workspaceId: string;
  reason: string;
}): Promise<Workspace> {
  await requireOperator(input.adminId);

  const ws = await repositories.workspace.getById(input.workspaceId);
  if (!ws) throw new Error(`Workspace ${input.workspaceId} not found.`);
  if (ws.status === "suspended") {
    // Stage 5 re-audit fix (F-P2-1, 2026-07-28): TRUE idempotency. Pre-fix
    // this branch was EMPTY (just a comment) and control fell through to the
    // unconditional update below, which (a) overwrote the ORIGINAL suspendedAt
    // + suspendedByAdminId (audit history destroyed) and (b) wrote a duplicate
    // workspace_suspended audit row. Now we early-return the existing row +
    // write a DISTINCT re-attempt audit event so the operator sees the attempt
    // WITHOUT rewriting history. Pinned by golden:stage5-batch4-chokepoints CASE 5.
    await repositories.platformAuditLog.create({
      adminId: input.adminId,
      action: "workspace_suspended",
      metadata: {
        workspaceId: input.workspaceId,
        reason: input.reason,
        reattempt: true,
        originalSuspendedAt: ws.suspendedAt,
        originalSuspendedByAdminId: ws.suspendedByAdminId,
      },
    });
    return ws;
  }

  const now = nowIso();
  const updated = await repositories.workspace.update(input.workspaceId, {
    status: "suspended",
    suspendedAt: now,
    suspendedByAdminId: input.adminId,
  });

  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "workspace_suspended",
    metadata: {
      workspaceId: input.workspaceId,
      reason: input.reason,
    },
  });

  return updated;
}

/**
 * Resume a suspended workspace. Operator-only. Flips status → active, clears
 * suspendedAt + suspendedByAdminId, child data STILL unchanged, writes a
 * workspace_resumed audit row. Pinned by golden CASE C.
 */
export async function resumeWorkspace(input: {
  adminId: string;
  workspaceId: string;
}): Promise<Workspace> {
  await requireOperator(input.adminId);

  const ws = await repositories.workspace.getById(input.workspaceId);
  if (!ws) throw new Error(`Workspace ${input.workspaceId} not found.`);
  // 2026-09-26 (break test): resuming a workspace that was not suspended
  // wrote a "workspace_resumed" entry for something that never happened.
  // Nothing to resume → nothing changes, nothing is logged (mirrors suspend).
  if (ws.status !== "suspended") return ws;

  const updated = await repositories.workspace.update(input.workspaceId, {
    status: "active",
    suspendedAt: undefined,
    suspendedByAdminId: undefined,
  });

  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "workspace_resumed",
    metadata: {
      workspaceId: input.workspaceId,
    },
  });

  return updated;
}

// ─── Impersonation ──────────────────────────────────────────────────────────

export type ImpersonationTokenPayload = {
  adminId: string;
  targetUserId: string;
  targetWorkspaceId: string;
  startedAt: number; // ms epoch
  expiresAt: number; // ms epoch
};

export type StartImpersonationResult = {
  token: string;
  payload: ImpersonationTokenPayload;
};

/**
 * Start an impersonation session. Enforces ALL 5 safety limits:
 *   - operator-only (golden CASE G)
 *   - one at a time (golden CASE H)
 *   - owner blocked (golden CASE F)
 *   - audited (golden CASE E)
 *   - time-boxed (golden CASE I)
 *
 * The token returned is what the route sets as a workspace-session marker.
 * The token is stored HASHED in ImpersonationSession.tokenHash; the raw token
 * is returned to the route once (to set the cookie) and never persisted raw.
 */
export async function startImpersonation(input: {
  adminId: string;
  targetUserId: string;
  targetWorkspaceId: string;
  reason: string;
}): Promise<StartImpersonationResult> {
  // 2026-09-26 (break test): two "Impersonate" clicks at once both passed the
  // one-at-a-time check below and opened two live sessions. Starts for one
  // operator now run one after another, so the second sees the first.
  return oneAtATime(`impersonate:${input.adminId}`, () => startImpersonationChecked(input));
}

async function startImpersonationChecked(input: {
  adminId: string;
  targetUserId: string;
  targetWorkspaceId: string;
  reason: string;
}): Promise<StartImpersonationResult> {
  await requireOperator(input.adminId);

  // Rule 3: one at a time.
  const active = await repositories.impersonationSession.findActiveForAdmin(input.adminId);
  if (active) {
    throw new AuthorizationError("You are already impersonating a user. Exit the current impersonation first.");
  }

  // Resolve the target user + enforce owner-block.
  const target = await repositories.user.findById(input.targetUserId);
  if (!target) throw new AuthorizationError("Target user not found.");
  if (target.workspaceId !== input.targetWorkspaceId) {
    throw new AuthorizationError("Target user does not belong to the specified workspace.");
  }

  // Rule 4: owner blocked. The REFUSED attempt is itself audit-logged.
  if (target.role === "owner") {
    await repositories.platformAuditLog.create({
      adminId: input.adminId,
      action: "impersonation_started",
      metadata: {
        targetUserId: input.targetUserId,
        targetWorkspaceId: input.targetWorkspaceId,
        status: "refused",
        reason: "cannot_impersonate_owner",
        attemptedReason: input.reason,
      },
    });
    throw new AuthorizationError("Cannot impersonate a workspace owner. Only admin/sales_member/viewer users may be impersonated.");
  }

  // Rule 2: time-boxed. Generate token + compute expiry.
  const startedAt = Date.now();
  const expiresAt = startedAt + IMPERSONATION_TTL_MS;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);

  const payload: ImpersonationTokenPayload = {
    adminId: input.adminId,
    targetUserId: input.targetUserId,
    targetWorkspaceId: input.targetWorkspaceId,
    startedAt,
    expiresAt,
  };

  // Rule 1: audited (start).
  await repositories.impersonationSession.create({
    adminId: input.adminId,
    targetUserId: input.targetUserId,
    targetWorkspaceId: input.targetWorkspaceId,
    tokenHash,
    startedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    reason: input.reason,
  });

  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "impersonation_started",
    metadata: {
      targetUserId: input.targetUserId,
      targetWorkspaceId: input.targetWorkspaceId,
      reason: input.reason,
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    },
  });

  // The route sets a cookie encoding {token, payload}. The token is the
  // random secret; the payload is the public marker (adminId/targetUserId).
  const sessionToken = encodeImpersonationCookie(rawToken, payload);

  return { token: sessionToken, payload };
}

/**
 * Verify an impersonation token. Returns the payload if the token is valid,
 * non-expired, and not ended; returns null otherwise. Accepts an optional
 * `now` (ms epoch) for boundary-value testing (golden CASE I).
 *
 * Rule 2 (time-box) is enforced HERE: expiresAt < now → null.
 */
export async function verifyImpersonationToken(
  sessionToken: string,
  opts: { now?: number } = {},
): Promise<ImpersonationTokenPayload | null> {
  let rawToken: string;
  let payload: ImpersonationTokenPayload;
  try {
    [rawToken, payload] = decodeImpersonationCookie(sessionToken);
  } catch {
    return null; // malformed → reject.
  }

  const session = await repositories.impersonationSession.findByTokenHash(sha256(rawToken));
  if (!session) return null;
  if (session.endedAt) return null; // exited → reject.

  const now = opts.now ?? Date.now();
  if (now >= payload.expiresAt) return null; // expired → reject.
  if (now >= new Date(session.expiresAt).getTime()) return null; // server-side expiry → reject.

  // Stage 5 re-audit F-P2-9 (2026-07-28): return the DB session's AUTHORITATIVE
  // identity fields, NOT the cookie's unsigned `payload`. The cookie format is
  // `${rawToken}.${base64url(payload)}` — the payload is NOT HMAC-signed, only
  // the rawToken is validated via findByTokenHash. An attacker who obtains a
  // rawToken could rewrite the payload to impersonate a different user. By
  // returning the server-side session row's targetUserId/targetWorkspaceId/
  // adminId, the identity is anchored to the DB (which the attacker cannot
  // edit). Any future session-layer consumer trusts these server-side values.
  // (Latent today — impersonation is disabled per F-P1-4 — but this hardens
  // the chokepoint before re-enablement.)
  return {
    adminId: session.adminId,
    targetUserId: session.targetUserId,
    targetWorkspaceId: session.targetWorkspaceId,
    startedAt: new Date(session.startedAt).getTime(),
    expiresAt: new Date(session.expiresAt).getTime(),
  };
}

/**
 * End an impersonation session. Invalidates the token (stamps endedAt) +
 * writes an impersonation_ended audit row. Pinned by golden CASE J.
 */
export async function exitImpersonation(input: {
  adminId: string;
  token: string;
}): Promise<void> {
  let rawToken: string;
  let payload: ImpersonationTokenPayload;
  try {
    [rawToken, payload] = decodeImpersonationCookie(input.token);
  } catch {
    // Malformed token on exit — nothing to end. Audit the attempt.
    await repositories.platformAuditLog.create({
      adminId: input.adminId,
      action: "impersonation_ended",
      metadata: { status: "malformed_token" },
    });
    return;
  }

  const session = await repositories.impersonationSession.findByTokenHash(sha256(rawToken));
  if (session && !session.endedAt) {
    await repositories.impersonationSession.markEnded(session.id);
  }

  // 2026-08-17 N-SEC-1: audit the DB session's AUTHORITATIVE identity, never
  // the cookie's unsigned payload. The cookie is `${rawToken}.${b64(payload)}`
  // and only the rawToken is validated (findByTokenHash) — an attacker holding
  // a rawToken can rewrite the payload, and this row would otherwise record
  // that forged identity as fact in the platform audit log. This is the same
  // defect F-P2-9 closed inside verifyImpersonationToken; the exit path was
  // missed. When the token resolves to no session row it is unrecognised, so
  // the payload is recorded as an explicitly-unverified CLAIM, not as the
  // identity. A payload that disagrees with the session row is itself evidence
  // of tampering and is recorded as such. Pinned by golden:platform-admin-ops
  // CASE J2.
  const claimed = {
    claimedTargetUserId: payload.targetUserId,
    claimedTargetWorkspaceId: payload.targetWorkspaceId,
  };
  const payloadMatchesSession = Boolean(
    session &&
      session.targetUserId === payload.targetUserId &&
      session.targetWorkspaceId === payload.targetWorkspaceId,
  );

  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "impersonation_ended",
    metadata: session
      ? {
          targetUserId: session.targetUserId,
          targetWorkspaceId: session.targetWorkspaceId,
          endedAt: nowIso(),
          ...(payloadMatchesSession ? {} : { status: "cookie_payload_mismatch", ...claimed }),
        }
      : {
          status: "unknown_token",
          ...claimed,
          endedAt: nowIso(),
        },
  });
}

// The impersonation cookie encodes {rawToken}.{base64url(payload)}. The
// rawToken is the secret (validated against the stored hash); the payload
// is the public marker the session layer reads to attribute actions.
function encodeImpersonationCookie(rawToken: string, payload: ImpersonationTokenPayload): string {
  const payloadJson = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${rawToken}.${payloadJson}`;
}

function decodeImpersonationCookie(sessionToken: string): [string, ImpersonationTokenPayload] {
  const dot = sessionToken.indexOf(".");
  if (dot < 0) throw new Error("malformed impersonation token");
  const rawToken = sessionToken.slice(0, dot);
  const payloadJson = Buffer.from(sessionToken.slice(dot + 1), "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson) as ImpersonationTokenPayload;
  return [rawToken, payload];
}

/** Resolve the active impersonation (if any) for an admin — used by the /admin
 *  UI to show "Exit impersonation" instead of "Impersonate". */
export async function getActiveImpersonation(adminId: string): Promise<ImpersonationSession | null> {
  const session = await repositories.impersonationSession.findActiveForAdmin(adminId);
  return session ?? null;
}

// ─── Password reset ─────────────────────────────────────────────────────────

export type IssuePasswordResetResult = {
  token: string;
  expiresAt: string;
};

/**
 * Issue a one-time password reset for a user. Operator-only.
 *   1. Generates a token (≥32 bytes random).
 *   2. Stores it HASHED (SHA-256), 24h expiry.
 *   3. Bumps the user's sessionVersion (existing sessions killed).
 *   4. Audit-logs (password_reset_issued); token NEVER in metadata.
 *   5. Returns the raw token so the route can email it via the provider.
 *
 * The email send itself happens in the route (so the route can rate-limit +
 * handle provider errors with a user-facing message). Pinned by golden CASE K.
 */
export async function issuePasswordReset(input: {
  adminId: string;
  targetUserId: string;
  targetWorkspaceId: string;
}): Promise<IssuePasswordResetResult> {
  await requireOperator(input.adminId);

  const target = await repositories.user.findById(input.targetUserId);
  if (!target) throw new Error(`User ${input.targetUserId} not found.`);
  if (target.workspaceId !== input.targetWorkspaceId) {
    throw new NeedsActionError("User does not belong to the specified workspace.", 400);
  }

  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + PASSWORD_RESET_TTL_MS;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);

  // Bump sessionVersion so existing sessions are killed. The credential may
  // not exist yet (e.g. an invited-but-not-yet-activated user) — in that case
  // we skip the bump but still issue the reset (the user has no sessions to
  // kill anyway). Honest: we don't fail the whole reset on a missing cred.
  const cred = await repositories.userCredential.findByUserId(input.targetUserId);
  if (cred) {
    await repositories.userCredential.updatePasswordAndBumpSession(input.targetUserId, cred.passwordHash);
  }

  // 2026-09-26 (break test): an older reset link kept working after a newer
  // one was sent. The operator re-sends precisely when the first email went
  // astray, so every earlier unused link for this user is retired first.
  for (let i = 0; i < 100; i++) {
    const older = await repositories.passwordResetToken.findLatestForUser(input.targetUserId);
    if (!older) break;
    await repositories.passwordResetToken.markConsumed(older.id);
  }

  await repositories.passwordResetToken.create({
    userId: input.targetUserId,
    workspaceId: input.targetWorkspaceId,
    tokenHash,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    issuedByAdminId: input.adminId,
  });

  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "password_reset_issued",
    metadata: {
      // Deliberately NO token / tokenHash here (golden CASE K).
      targetUserId: input.targetUserId,
      targetWorkspaceId: input.targetWorkspaceId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  });

  return {
    token: rawToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

// ─── User lookup (operator console user list) ───────────────────────────────

export async function listUsersForWorkspace(workspaceId: string): Promise<User[]> {
  return repositories.user.listForWorkspace(workspaceId);
}
