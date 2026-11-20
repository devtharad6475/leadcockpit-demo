/**
 * SignupService — Stage 5 / WP1 (2026-07-28).
 *
 * Self-serve signup + email verification + operator hand-provision. Per
 * docs/LOGIC.md 2026-07-28 (WP1 entries):
 *   - signup() creates Workspace + owner User + UserCredential + WorkspaceMember
 *     ATOMICALLY, gated by the `new_signup_enabled` feature flag.
 *   - One workspace per email (global uniqueness check).
 *   - Re-signup after suspend is BLOCKED (kill-switch sticks).
 *   - Email verification is SOFT (login allowed before verifying); a
 *     verification token is created + emailed; verifyEmail() marks the user
 *     verified + idempotent + re-issue invalidates prior tokens.
 *   - handProvisionWorkspace() is the operator-side pilot path (no
 *     verification email; the operator uses the WP2 password-reset flow to
 *     let the pilot owner set their own password).
 *
 * SECURITY: tokens are SHA-256 hashed in storage (never plaintext). The raw
 * token is returned to the CALLER (the route) so it can be emailed — the
 * operator/inviter never sees it in the response payload (zero-knowledge).
 *
 * NO-AUTO-OUTREACH: the only emails sent are TRANSACTIONAL (signup verify).
 * No WhatsApp/Gmail prospecting. See docs/LOGIC.md (WP1 no-auto-outreach entry).
 */
import { createHash, randomBytes } from "node:crypto";
import { repositories } from "@/repositories";
import { defaultWorkspaceId, uid, timestamp } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createSessionToken } from "@/lib/session";
import { AuthenticationError, AuthorizationError } from "@/lib/auth-service";
import { isFeatureEnabled } from "@/services/FeatureFlagService";
import { EmailSendError } from "@/providers/email";
import { accountEmailSender, sendAccountEmail } from "@/lib/account-email";
import { accountEmailOrigin } from "@/lib/account-email-origin";
import type { User, Workspace, WorkspaceRole } from "@/lib/types";

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** SHA-256 hex hash of a raw token (for storage; raw token is never stored). */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 2026-09-28 (S7) — thrown by signup() when the email already has an account.
 * The public route never shows this to the browser (see publicSignup): it
 * would tell a stranger which emails are registered.
 */
export class EmailAlreadyRegisteredError extends AuthenticationError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "EmailAlreadyRegisteredError";
  }
}

/** What the public sign-up page is told — identical for a new and a taken email. */
export const PUBLIC_SIGNUP_MESSAGE = "Your request has been processed. You can try signing in with your email and password. If account email delivery is available, check your inbox for verification or sign-in guidance.";

export type PublicSignupOutcome = {
  /** For tests and logs only — never sent to the browser. */
  created: boolean;
  noticeSent: boolean;
};

export type SignupResult = {
  user: { id: string; email: string; role: string; workspaceId: string };
  sessionToken: string;
  emailVerified: boolean;
  /** The raw verification token (for the email link). NOT returned to the UI
   *  by the route — the route emails it. Exposed here for the email-sending step. */
  emailVerificationToken: string;
  /**
   * Stage 5 re-audit F-P1-2 (2026-07-28): honest flag for whether the
   * verification email actually went out. Was silently swallowed in an empty
   * catch; the route returned `{ok: true}` unconditionally, so a Resend
   * outage during signup left zero signal anywhere. The route now surfaces
   * this as an `emailWarning` so the UI can offer a "resend" banner.
   */
  emailSent: boolean;
};

/**
 * Public self-serve signup. Creates a new Workspace + owner atomically.
 * Gated by the `new_signup_enabled` feature flag (the operator flips it OFF
 * during the pilot, ON once ready for public — per D-2026-07-28-c).
 */
export async function signup(input: {
  email: string;
  password: string;
  name?: string;
  businessName?: string;
}): Promise<SignupResult> {
  // Feature-flag gate.
  if (!(await isFeatureEnabled("new_signup_enabled"))) {
    throw new AuthorizationError("Public signup is currently disabled.", 403);
  }

  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AuthenticationError("A valid email is required.", 400);
  }
  if (!input.password || input.password.length < 8) {
    throw new AuthenticationError("Password must be at least 8 characters.", 400);
  }

  // Global email uniqueness: check ALL workspaces (active + suspended).
  // The suspended check makes the kill-switch stick (D-2026-07-28 LOGIC).
  const allWorkspaces = await repositories.workspace.listAll(true);
  for (const ws of allWorkspaces) {
    const existingCred = await repositories.auth.findCredentialByEmail(ws.id, email);
    if (existingCred) {
      if (ws.status === "suspended") {
        throw new EmailAlreadyRegisteredError("This email is associated with a suspended account and cannot re-register.", 403);
      }
      throw new EmailAlreadyRegisteredError("An account with this email already exists. Log in instead.", 409);
    }
  }

  // Atomic create: Workspace + User + UserCredential + WorkspaceMember.
  const workspaceId = uid("workspace");
  const userId = uid("user");
  const nowIso = timestamp();
  const passwordHash = await hashPassword(input.password);

  const workspace: Workspace = {
    id: workspaceId,
    name: input.businessName?.trim() || `${input.name || "New"}'s Workspace`,
    ownerUserId: userId,
    businessName: input.businessName?.trim() || undefined,
    status: "active",
    autonomyKillSwitch: true,   // safe default: no auto-outreach
    autoSendToggle: false,      // safe default: no auto-send
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const user: User = {
    id: userId,
    workspaceId,
    name: input.name?.trim() || "Owner",
    email,
    role: "owner",
    // emailVerifiedAt is intentionally unset (SOFT verification).
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const credential = {
    id: uid("cred"),
    userId,
    workspaceId,
    email,
    passwordHash,
    sessionVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const member = {
    id: uid("member"),
    workspaceId,
    userId,
    email,
    name: user.name,
    role: "owner" as WorkspaceRole,
    status: "active" as const,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Stage 5 re-audit fix (F-P0-1, 2026-07-28): ATOMIC 4-row create. Pre-fix
  // this was TWO separate awaits (workspace.create THEN createOwnerWithCredential);
  // a throw between them orphaned the workspace. Now all 4 rows land in ONE
  // transaction (JSON: one mutateData; Prisma: one $transaction) or NONE land.
  // Pinned by golden:signup-invite-atomicity CASE A.
  await repositories.auth.createWorkspaceWithOwner({
    workspace,
    user,
    credential,
    member,
  });

  // Stage 5 re-audit F-P1-7 (2026-07-28): audit the signup (non-repudiation —
  // "who created this workspace and when"). The actor is the newly-created
  // owner (no prior session for a public signup). Pinned by
  // golden:stage5-batch4-chokepoints CASE 3.
  await repositories.auditLog.create({
    workspaceId,
    actorUserId: userId,
    eventType: "workspace.signup",
    payload: { email, businessName: input.businessName || null },
  }).catch((e: unknown) => console.error("[audit] workspace.signup write failed:", e));

  // Create the email verification token (hashed, 24h).
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  const issuedAt = timestamp();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
  await repositories.emailVerificationToken.create({
    userId,
    workspaceId,
    tokenHash,
    issuedAt,
    expiresAt,
    source: "signup",
  });

  // Send the verification email (transactional — the no-auto-outreach
  // exception; the user just typed this email, they requested it).
  // Stage 5 re-audit F-P1-2 + F-P3-4 (2026-07-28): the email purpose is the
  // distinct "verify_email" (was mislabeled "invite", defeating the per-purpose
  // chokepoint). And email-send failure is surfaced honestly via emailSent
  // (was silently swallowed). Pinned by golden:stage5-batch4-chokepoints CASE 2 + 13.
  let emailSent = false;
  try {
    const delivery = await sendAccountEmail({
      to: email,
      subject: "Verify your LeadCockpit account",
      html: `<p>Welcome to LeadCockpit!</p><p>Click the link below to verify your email address:</p><p><a href="${accountEmailOrigin()}/verify-email?token=${rawToken}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
      purpose: "verify_email",
    });
    emailSent = delivery.ok && delivery.provider !== "mock";
  } catch (e) {
    // No Silent Failures (build-right Phase 4): the signup SUCCEEDED, but the
    // email send failed. We log visibly AND set emailSent=false so the route
    // can surface an `emailWarning` to the user (with a resend link). We do
    // NOT throw — the account is the primary deliverable, and the user can
    // re-request verification from the in-app banner.
    emailSent = false;
    console.error("[signup] verification email send FAILED for", email, ":", (e as Error).message);
  }

  const sessionToken = createSessionToken({
    userId,
    workspaceId,
    role: "owner",
    sessionVersion: 1,
  });

  return {
    user: { id: userId, email, role: "owner", workspaceId },
    sessionToken,
    emailVerified: false,
    emailVerificationToken: rawToken,
    emailSent,
  };
}

export type HandProvisionResult = {
  workspaceId: string;
  ownerUserId: string;
  emailSent: false;
};

/**
 * Operator hand-provision for pilot customers (D-2026-07-28-c). Creates a
 * Workspace + owner WITHOUT sending a verification email (the operator is
 * talking to the customer in person). The owner gets a PROVISIONAL credential;
 * the operator uses the existing WP2 password-reset flow to let the owner set
 * their own password.
 *
 * RBAC: operator-only (support_agent refused).
 */
export async function handProvisionWorkspace(input: {
  adminId: string;
  ownerEmail: string;
  ownerName?: string;
  businessName?: string;
}): Promise<HandProvisionResult> {
  // RBAC defense-in-depth: load the admin + assert role.
  const admin = await repositories.platformAdmin.findById(input.adminId);
  if (!admin) {
    throw new AuthorizationError("Admin not found.", 403);
  }
  if (admin.role !== "operator") {
    throw new AuthorizationError("Only operators can hand-provision workspaces.", 403);
  }

  const email = input.ownerEmail.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AuthenticationError("A valid owner email is required.", 400);
  }

  // Global email uniqueness (same check as signup).
  const allWorkspaces = await repositories.workspace.listAll(true);
  for (const ws of allWorkspaces) {
    const existing = await repositories.auth.findCredentialByEmail(ws.id, email);
    if (existing) {
      throw new AuthenticationError("An account with this email already exists.", 409);
    }
  }

  const workspaceId = uid("workspace");
  const userId = uid("user");
  const nowIso = timestamp();

  // Provisional credential: a random placeholder password hash. The owner
  // CANNOT log in with this — they must use the WP2 password-reset flow to
  // set a real password. This is the zero-knowledge pilot-provision pattern.
  const provisionalHash = await hashPassword(randomBytes(32).toString("base64url"));

  const workspace: Workspace = {
    id: workspaceId,
    name: input.businessName?.trim() || `${input.ownerName || "Pilot"}'s Workspace`,
    ownerUserId: userId,
    businessName: input.businessName?.trim() || undefined,
    status: "active",
    autonomyKillSwitch: true,
    autoSendToggle: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const user: User = {
    id: userId,
    workspaceId,
    name: input.ownerName?.trim() || "Pilot Owner",
    email,
    role: "owner",
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const credential = {
    id: uid("cred"),
    userId,
    workspaceId,
    email,
    passwordHash: provisionalHash,
    provisional: true,
    sessionVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const member = {
    id: uid("member"),
    workspaceId,
    userId,
    email,
    name: user.name,
    role: "owner" as WorkspaceRole,
    status: "active" as const,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Stage 5 re-audit fix (F-P1-11, 2026-07-28): ATOMIC 4-row create (same as
  // signup). Pinned by golden:signup-invite-atomicity CASE B.
  await repositories.auth.createWorkspaceWithOwner({ workspace, user, credential, member });

  // Stage 5 re-audit F-P1-7 (2026-07-28): audit the operator-initiated
  // provision at BOTH the workspace level (who/when) AND the platform level
  // (the operator admin who did it). Pinned by golden:stage5-batch4-chokepoints CASE 3.
  await repositories.auditLog.create({
    workspaceId,
    actorUserId: userId,
    eventType: "workspace.provisioned",
    payload: { email, businessName: input.businessName || null, provisionedByAdminId: input.adminId },
  }).catch((e: unknown) => console.error("[audit] workspace.provisioned write failed:", e));
  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "workspace_provisioned",
    metadata: { workspaceId, ownerUserId: userId, ownerEmail: email },
  }).catch((e: unknown) => console.error("[platform-audit] workspace_provisioned write failed:", e));

  return { workspaceId, ownerUserId: userId, emailSent: false };
}

export type VerifyEmailResult = {
  verified: boolean;
  verifiedAt: string;
};

/**
 * Verify an email via a raw token. Idempotent: if the user is already
 * verified, returns success without error. Throws on invalid/expired tokens.
 */
export async function verifyEmail(rawToken: string): Promise<VerifyEmailResult> {
  const tokenHash = sha256(rawToken);
  const tokenRow = await repositories.emailVerificationToken.findByTokenHash(tokenHash);
  if (!tokenRow) {
    throw new AuthenticationError("Invalid verification token.", 400);
  }
  // Check expiry.
  if (Date.parse(tokenRow.expiresAt) < Date.now()) {
    throw new AuthenticationError("This verification link has expired. Request a new one.", 410);
  }

  // Resolve the user to determine idempotency vs re-issue.
  const user = await repositories.user.findById(tokenRow.userId);

  // If the token is CONSUMED, distinguish two cases:
  //   (a) The user IS already verified → idempotent re-click → return success
  //       (the user clicked the same link twice; no error).
  //   (b) The user is NOT verified but the token is consumed → the token was
  //       invalidated by a re-issue (invalidatePriorTokens) → reject so the
  //       user uses the NEW link, not the stale one.
  if (tokenRow.consumedAt) {
    if (user?.emailVerifiedAt) {
      // Idempotent: already verified.
      return { verified: true, verifiedAt: user.emailVerifiedAt };
    }
    // Consumed but user NOT verified → stale (re-issued) token.
    throw new AuthenticationError("This verification link is no longer valid. Use the most recent one.", 410);
  }

  // Fresh token — mark consumed + verify the user.
  const nowIso = await repositories.emailVerificationToken.verifyAndConsume(tokenHash);
  if (!nowIso) throw new AuthenticationError("This verification link has expired or is no longer valid. Use the most recent one.", 410);

  // Stage 5 re-audit F-P1-7 (2026-07-28): audit the verification.
  await repositories.auditLog.create({
    workspaceId: tokenRow.workspaceId,
    actorUserId: tokenRow.userId,
    eventType: "email.verified",
    payload: { source: tokenRow.source },
  }).catch((e: unknown) => console.error("[audit] email.verified write failed:", e));

  return { verified: true, verifiedAt: nowIso };
}

/**
 * Re-issue a verification token for a user (the "resend verification email"
 * action). Invalidates all prior unconsumed tokens for the user (one-shot).
 * Returns the new raw token for the email link.
 */
export async function resendVerification(input: { userId: string }): Promise<string> {
  const user = await repositories.user.findById(input.userId);
  if (!user) throw new AuthenticationError("User not found.", 404);
  if (user.emailVerifiedAt) {
    throw new AuthenticationError("Email is already verified.", 400);
  }
  const origin = accountEmailOrigin();
  accountEmailSender();
  // Validate the destination before retiring a previously usable link.
  await repositories.emailVerificationToken.invalidatePriorTokens(input.userId);

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  const issuedAt = timestamp();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
  await repositories.emailVerificationToken.create({
    userId: user.id,
    workspaceId: user.workspaceId,
    tokenHash,
    issuedAt,
    expiresAt,
    source: "reissue",
  });

  // Send the new verification email.
  // Stage 5 re-audit F-P1-2 + F-P3-4 (2026-07-28): honest purpose + visible
  // failure log (was mislabeled "invite" + silently swallowed).
  try {
    await sendAccountEmail({
      to: user.email,
      subject: "Verify your LeadCockpit account",
      html: `<p>Click the link below to verify your email address:</p><p><a href="${origin}/verify-email?token=${rawToken}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
      purpose: "verify_email",
    });
  } catch (e) {
    // No silent failure: log visibly so the operator/user knows the resend
    // did not go through. Throw so the route does not claim a successful resend;
    // retry creates a fresh verification link.
    console.error("[resendVerification] email send FAILED:", (e as Error).message);
    if (e instanceof EmailSendError && e.outcomeUnknown) throw e;
    throw new AuthenticationError("Verification email could not be sent. Please try again later.", 503);
  }

  return rawToken;
}

/**
 * 2026-09-28 (S7) — the public sign-up door. Answers the same way whether or
 * not the email is taken: a new email gets its company and the verification
 * email; a taken email gets NO account and a short note telling the real owner
 * someone tried (with how to sign in / reset). Neither path signs anyone in
 * here — the new owner signs in with the password they just chose. A password
 * hash is computed on both paths so timing does not tell them apart either.
 */
export async function publicSignup(input: { email: string; password: string; name?: string; businessName?: string }): Promise<PublicSignupOutcome> {
  try {
    const result = await signup(input);
    return { created: Boolean(result.user?.id), noticeSent: false };
  } catch (error) {
    // The in-transaction duplicate check (two sign-ups racing) throws a plain
    // "already exists" error; it means the same thing.
    const taken = error instanceof EmailAlreadyRegisteredError || (error instanceof Error && /already exists|unique constraint/i.test(error.message));
    if (!taken) throw error;
    await hashPassword(input.password).catch(() => undefined); // same work as a real sign-up
    const email = input.email.trim().toLowerCase();
    try {
      // Email configuration failures must not distinguish a taken address
      // from a newly created account in the public signup acknowledgement.
      const origin = accountEmailOrigin();
      const delivery = await sendAccountEmail({
        to: email,
        subject: "Someone tried to sign up with your email",
        html: `<p>Someone just tried to create a new LeadCockpit account with this email address. Your email already has an account, so nothing was created and nothing changed.</p><p>If it was you: <a href="${origin}/">sign in</a>, or <a href="${origin}/forgot-password">reset your password</a> if you've forgotten it.</p><p>If it wasn't you, you can ignore this email.</p>`,
        purpose: "security_notice",
      });
      return { created: false, noticeSent: delivery.ok && delivery.provider !== "mock" };
    } catch (e) {
      console.error("[signup] existing-account notice failed:", (e as Error).message);
      return { created: false, noticeSent: false };
    }
  }
}
