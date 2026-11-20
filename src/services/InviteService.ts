/**
 * InviteService — Stage 5 / WP1 (2026-07-28).
 *
 * Member invite lifecycle. Per docs/LOGIC.md 2026-07-28 (WP1 invite entry):
 *   - Owner/admin invites by email with a role from {admin, sales_member,
 *     viewer} — NEVER owner.
 *   - Invite row created (token hashed, 7-day expiry) + WorkspaceMember row
 *     created with status="invited".
 *   - Invite email sent (transactional — the no-auto-outreach exception).
 *   - Accept: verifies token + creates User + UserCredential atomically,
 *     flips member status invited→active, marks invite consumed.
 *   - Revoke: invalidates token + removes the "invited" member row.
 *   - One pending invite per (workspace, email). Re-inviting an active member
 *     → refused.
 *
 * SECURITY: the raw token is returned to the route (which emails it); the
 * inviter never sees it (zero-knowledge). Token stored SHA-256 hashed.
 *
 * NO-AUTO-OUTREACH: the invite email is TRANSACTIONAL (sent to an email the
 * inviter typed — they vouch for it). No WhatsApp/Gmail prospecting.
 */
import { oneAtATime } from "@/lib/one-at-a-time";
import { createHash, randomBytes } from "node:crypto";
import { repositories } from "@/repositories";
import { uid, timestamp } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createSessionToken } from "@/lib/session";
import { AuthenticationError, AuthorizationError } from "@/lib/auth-service";
import { EmailSendError } from "@/providers/email";
import { sendAccountEmail } from "@/lib/account-email";
import { accountEmailOrigin } from "@/lib/account-email-origin";
import type { User, WorkspaceRole } from "@/lib/types";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Roles that can be assigned on invite (NEVER owner — one owner per workspace). */
const INVITABLE_ROLES: WorkspaceRole[] = ["admin", "sales_member", "viewer"];

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type InviteResult = {
  inviteId: string;
  /** Raw token for the email link. The route emails this; never returns to inviter. */
  rawToken: string;
  emailSent: boolean;
  emailUnconfirmed: boolean;
};

/**
 * Assert the inviter is an owner or admin of the workspace (RBAC for invites).
 */
async function assertCanInvite(workspaceId: string, invitedByUserId: string): Promise<void> {
  const inviter = await repositories.user.findById(invitedByUserId);
  if (!inviter || inviter.workspaceId !== workspaceId) {
    throw new AuthorizationError("Inviter not found in this workspace.", 403);
  }
  // 2026-09-28 (S3): the role that counts is the one on the ACTIVE membership.
  const membership = await repositories.workspaceMember.findForUser(workspaceId, invitedByUserId);
  const role = membership ? (membership.status === "active" ? membership.role : undefined) : inviter.role;
  if (role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can invite members.", 403);
  }
}

/**
 * Create a member invite. The invite email is sent (transactional). The
 * inviter never sees the raw token.
 */
export async function createInvite(input: {
  workspaceId: string;
  invitedByUserId: string;
  inviteeEmail: string;
  role: WorkspaceRole;
}): Promise<InviteResult> {
  await assertCanInvite(input.workspaceId, input.invitedByUserId);

  const email = input.inviteeEmail.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AuthenticationError("A valid invitee email is required.", 400);
  }

  // Role validation: never owner.
  if (!INVITABLE_ROLES.includes(input.role)) {
    throw new AuthenticationError(`Invalid invite role. Must be one of: ${INVITABLE_ROLES.join(", ")}.`, 400);
  }

  // 2026-09-26 (break test): five clicks on Invite at once each passed the
  // "already a pending invite?" check and made five invites and five
  // emails. Checks and writes for one (workspace, email) now run one at a
  // time; Postgres also has the unique index behind this.
  const { invite, rawToken } = await oneAtATime(`invite:${input.workspaceId}:${email}`, async () => {
    // Check: is the email already an active member of this workspace?
    const members = await repositories.workspaceMember.listByWorkspace(input.workspaceId);
    const alreadyMember = members.some(
      (m) => m.email === email && m.status === "active",
    );
    if (alreadyMember) {
      throw new AuthenticationError("This email is already a member of this workspace.", 409);
    }

    // Check: is there already a PENDING invite for this email?
    const pending = await repositories.invite.findPendingForEmail(input.workspaceId, email);
    if (pending) {
      throw new AuthenticationError("A pending invite already exists for this email. Revoke it first.", 409);
    }

    // Stage 5 re-audit fix (F-P2-8, 2026-07-28): clean up prior NON-pending
    // (revoked / accepted / expired) invites for this (workspace, email) so the
    // table doesn't accumulate one row per status combo. The
    // `@@unique([workspaceId, email, status])` constraint otherwise allows
    // unbounded growth + `listByWorkspace` returns stale history. Pinned by
    // golden:stage5-batch4-chokepoints CASE 9.
    await repositories.invite.deleteNonPendingForEmail(input.workspaceId, email);

    // Create the invite row (token hashed, 7-day expiry).
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256(rawToken);
    const nowIso = timestamp();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    const invite = await repositories.invite.create({
      workspaceId: input.workspaceId,
      email,
      role: input.role,
      tokenHash,
      invitedByUserId: input.invitedByUserId,
      expiresAt,
    });

    // Create the WorkspaceMember row with status="invited" (shows in team list).
    // F-ATOMIC-1 (2026-08-04 build-right audit, P3): this is a TWO-write sequence
    // (invite.create above + workspaceMember.create here) with no outer
    // transaction — a crash between them orphans one row. The accept path
    // (acceptInviteAtomically) IS atomic, and revoke cleans up both, so the
    // blast radius is limited to a visible-but-orphan row. The proper fix is an
    // atomic `invite.createInviteAndMember` repo method (one mutateData /
    // prisma.$transaction); deferred as P3 since no credential or send is
    // involved. Tracked in docs/AUDIT-EXCLUSIONS.md KNOWN LIMITATIONS.
    // 2026-09-28 (S3): a person removed from the team keeps a "disabled"
    // membership row. Inviting them again turns that row back into an invite
    // (one row per email per company), and accepting reactivates their old
    // account with the new password — see acceptInvite.
    const removed = members.find((m) => m.email === email && m.status === "disabled");
    if (removed) {
      await repositories.workspaceMember.update(input.workspaceId, removed.id, { status: "invited", role: input.role });
    } else {
      await repositories.workspaceMember.create({
        id: uid("member"),
        workspaceId: input.workspaceId,
        userId: null, // no user yet — created on accept. The email is the link (N-DATA-18).
        email,
        name: undefined,
        role: input.role,
        status: "invited",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
    return { invite, rawToken };
  });

  // Stage 5 re-audit F-P1-7 (2026-07-28): audit the invite (non-repudiation —
  // "who invited this member, when, and to what role"). Pinned by
  // golden:stage5-batch4-chokepoints CASE 3.
  await repositories.auditLog.create({
    workspaceId: input.workspaceId,
    actorUserId: input.invitedByUserId,
    eventType: "invite.created",
    entityType: "invite",
    entityId: invite.id,
    payload: { inviteeEmail: email, role: input.role },
  }).catch((e: unknown) => console.error("[audit] invite.created write failed:", e));

  // Send the invite email (transactional).
  let emailSent = false;
  let emailUnconfirmed = false;
  try {
    const delivery = await sendAccountEmail({
      to: email,
      subject: "You're invited to join a LeadCockpit workspace",
      html: `<p>You've been invited to join a workspace on LeadCockpit.</p><p>Click the link below to accept and set up your account:</p><p><a href="${accountEmailOrigin()}/invite?token=${rawToken}">Accept invite</a></p><p>This invite expires in 7 days.</p>`,
      purpose: "invite",
    });
    emailSent = delivery.ok && delivery.provider !== "mock";
  } catch (e) {
    // No silent failure: log visibly so the inviter knows the email didn't go.
    emailSent = false;
    emailUnconfirmed = e instanceof EmailSendError && e.outcomeUnknown;
    console.error("[createInvite] invite email send FAILED for", email, ":", (e as Error).message);
  }

  return { inviteId: invite.id, rawToken, emailSent, emailUnconfirmed };
}

export type AcceptInviteResult = {
  user: { id: string; email: string; role: string; workspaceId: string };
  sessionToken: string;
};

/**
 * Accept an invite: verify the token, create the User + UserCredential, flip
 * the member status invited→active, mark the invite consumed. Issues a session.
 */
export async function acceptInvite(input: {
  /** The invite id (optional — the token alone resolves the invite). */
  inviteId?: string;
  rawToken: string;
  name: string;
  password: string;
}): Promise<AcceptInviteResult> {
  if (!input.password || input.password.length < 8) {
    throw new AuthenticationError("Password must be at least 8 characters.", 400);
  }

  const tokenHash = sha256(input.rawToken);
  const invite = await repositories.invite.findByTokenHash(tokenHash);
  if (!invite) {
    throw new AuthenticationError("Invalid invite token.", 400);
  }
  if (invite.status === "revoked") {
    throw new AuthenticationError("This invite has been revoked.", 410);
  }
  if (invite.status === "accepted") {
    throw new AuthenticationError("This invite has already been accepted.", 410);
  }
  // Check expiry.
  if (Date.parse(invite.expiresAt) < Date.now()) {
    throw new AuthenticationError("This invite has expired. Ask for a new one.", 410);
  }

  const workspaceId = invite.workspaceId;
  const email = invite.email;
  const role = invite.role;

  // F-P1-11 (closed 2026-08-17, CEO-loop session 3) — defense in depth against
  // a duplicate account for one email in one workspace.
  //
  // The realistic paths were already closed elsewhere: createInvite rejects an
  // email that is already an active member and rejects a second pending invite
  // for the same email (409 each), and the concurrent double-accept race is
  // closed inside acceptInviteAtomically. But this function itself never asked
  // whether a user for this email already existed — it just created one. That
  // made the guarantee depend entirely on every OTHER path staying correct, so
  // any future route that creates a user by another means would reintroduce
  // the duplicate silently, and the symptom would be an ambiguous login rather
  // than an error anyone could trace back to here.
  //
  // Checking the credential (not the User row) is deliberate: a second
  // credential for the same email in the same workspace is the thing that
  // actually breaks login, and findCredentialByEmail is the same lookup the
  // login path uses, so this check can never disagree with it.
  const existingCredential = await repositories.auth.findCredentialByEmail(workspaceId, email);
  if (existingCredential) {
    // 2026-09-28 (S3): someone removed from this team and invited back. Their
    // old account (and everything it touched) is reused, with the password
    // they choose now and the role on the new invite.
    const members = await repositories.workspaceMember.listByWorkspace(workspaceId);
    const returning = members.find((m) => m.email === email && m.status === "invited" && m.userId === existingCredential.user.id);
    if (returning) return reactivateReturningMember({ invite, member: returning, userId: existingCredential.user.id, name: input.name, password: input.password });

    throw new AuthenticationError("An account already exists for this email in this workspace. Sign in instead, or ask an admin to reset the password.", 409);
  }

  const userId = uid("user");
  const nowIso = timestamp();
  const passwordHash = await hashPassword(input.password);

  // Create the User + UserCredential (scoped to the invited workspace).
  const user: User = {
    id: userId,
    workspaceId,
    name: input.name?.trim() || "Member",
    email,
    role,
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

  // Stage 5 re-audit fix (F-P0-2, 2026-07-28): ATOMIC accept. Pre-fix this
  // was 4 separate awaits (user.create, userCredential.create,
  // workspaceMember.activateInvitedByEmail, invite.markAccepted); a failure
  // between them orphaned the user. Now all 4 writes land in ONE transaction
  // or NONE land. Pinned by golden:signup-invite-atomicity CASE C.
  await repositories.invite.acceptInviteAtomically({
    inviteId: invite.id,
    user,
    credential,
    memberEmail: email,
    memberName: user.name,
    workspaceId,
  });

  // Stage 5 re-audit F-P1-7 (2026-07-28): audit the accept (the actor is the
  // newly-created user — there was no prior session for a public accept).
  await repositories.auditLog.create({
    workspaceId,
    actorUserId: userId,
    eventType: "invite.accepted",
    entityType: "invite",
    entityId: invite.id,
    payload: { inviteeEmail: email, role, invitedByUserId: invite.invitedByUserId },
  }).catch((e: unknown) => console.error("[audit] invite.accepted write failed:", e));

  const sessionToken = createSessionToken({
    userId,
    workspaceId,
    role,
    sessionVersion: 1,
  });

  return {
    user: { id: userId, email, role, workspaceId },
    sessionToken,
  };
}

async function reactivateReturningMember(input: {
  invite: { id: string; workspaceId: string; email: string; role: WorkspaceRole; invitedByUserId: string };
  member: { id: string };
  userId: string;
  name: string;
  password: string;
}): Promise<AcceptInviteResult> {
  const { invite } = input;
  const passwordHash = await hashPassword(input.password);
  return oneAtATime(`team:${invite.workspaceId}`, () => {
  const work = async () => {
  // Recheck after taking the shared membership lock: another acceptance or
  // revocation may have completed while the password was being hashed.
  const current = await repositories.invite.findById(invite.id);
  if (!current || current.status !== "pending" || Date.parse(current.expiresAt) <= Date.now()) {
    throw new AuthenticationError("This invite is no longer available. Ask for a new one.", 410);
  }
  const member = await repositories.workspaceMember.findForUser(invite.workspaceId, input.userId);
  if (!member || member.id !== input.member.id || member.status !== "invited") {
    throw new AuthenticationError("This team invitation is no longer available.", 410);
  }
  const credential = await repositories.userCredential.updatePasswordAndBumpSession(input.userId, passwordHash);
  await repositories.user.update(input.userId, { role: invite.role, ...(input.name?.trim() ? { name: input.name.trim() } : {}) });
  await repositories.workspaceMember.update(invite.workspaceId, input.member.id, { status: "active", role: invite.role, ...(input.name?.trim() ? { name: input.name.trim() } : {}) });
  await repositories.invite.markAccepted(invite.id, input.userId);
  await repositories.auditLog.create({
    workspaceId: invite.workspaceId,
    actorUserId: input.userId,
    eventType: "invite.accepted",
    entityType: "invite",
    entityId: invite.id,
    payload: { inviteeEmail: invite.email, role: invite.role, invitedByUserId: invite.invitedByUserId, returningMember: true },
  }).catch((e: unknown) => console.error("[audit] invite.accepted write failed:", e));
  return {
    user: { id: input.userId, email: invite.email, role: invite.role, workspaceId: invite.workspaceId },
    sessionToken: createSessionToken({ userId: input.userId, workspaceId: invite.workspaceId, role: invite.role, sessionVersion: credential.sessionVersion ?? 1 }),
  };
  };
  if (repositories.withWorkspaceTeamTransaction) return repositories.withWorkspaceTeamTransaction(invite.workspaceId, work);
  return repositories.withTransaction ? repositories.withTransaction(work) : work();
  });
}

/**
 * Revoke a pending invite. Invalidates the token + removes the "invited"
 * member row (no orphan). Only owner/admin of the workspace can revoke.
 */
export async function revokeInvite(input: {
  workspaceId: string;
  inviteId: string;
  revokedByUserId: string;
}): Promise<void> {
  await assertCanInvite(input.workspaceId, input.revokedByUserId);

  const invite = await repositories.invite.findById(input.inviteId);
  if (!invite || invite.workspaceId !== input.workspaceId) {
    throw new AuthenticationError("Invite not found in this workspace.", 404);
  }
  if (invite.status !== "pending") {
    throw new AuthenticationError("Only pending invites can be revoked.", 400);
  }

  await repositories.invite.markRevoked(input.inviteId);

  // Remove the "invited" member row (no orphan — a revoked invite must not
  // leave a ghost member). Only removes status="invited" rows.
  // 2026-09-28 (S3): a returning member's row (it still points at their old
  // account) goes back to "removed" instead, so a later invite can bring them back.
  const invitedRow = (await repositories.workspaceMember.listByWorkspace(input.workspaceId))
    .find((m) => m.email === invite.email && m.status === "invited");
  if (invitedRow?.userId) {
    await repositories.workspaceMember.update(input.workspaceId, invitedRow.id, { status: "disabled" });
  } else {
    await repositories.workspaceMember.deleteInvitedByEmail(input.workspaceId, invite.email);
  }

  // Stage 5 re-audit F-P1-7 (2026-07-28): audit the revoke.
  await repositories.auditLog.create({
    workspaceId: input.workspaceId,
    actorUserId: input.revokedByUserId,
    eventType: "invite.revoked",
    entityType: "invite",
    entityId: invite.id,
    payload: { inviteeEmail: invite.email },
  }).catch((e: unknown) => console.error("[audit] invite.revoked write failed:", e));
}
