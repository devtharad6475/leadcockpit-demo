/**
 * AccountSecurityService — the signed-in person's own account safety (S4 +
 * self-service password, docs/REVIEW-2026-09-27.md §4; rules in
 * docs/LOGIC.md 2026-09-28).
 *
 *   - endAllSessions: "Sign out" and "Sign out everywhere". Sessions are
 *     signed cookies with no server-side table, so the only way to make a
 *     copied cookie stop working is to bump the credential's sessionVersion.
 *     That ends EVERY session of that person, on every device — which is what
 *     "sign out" now means, and the screen says so.
 *   - requestPasswordReset: "Forgot password?". Same answer whether or not the
 *     email has an account; emails one link per company the person can still
 *     sign in to. Asking for a link does NOT sign anyone out (otherwise anyone
 *     could log a stranger out by typing their email) — using the link does.
 *   - changePassword: needs the current password; ends every other session and
 *     hands back a fresh cookie for this device.
 *
 * NO-AUTO-OUTREACH: the reset email is transactional, sent only to the address
 * the person typed and only when that address already has an account.
 */
import { createHash, randomBytes } from "node:crypto";
import { repositories } from "@/repositories";
import { hashPassword, verifyPassword } from "@/lib/password";
import { createSessionToken } from "@/lib/session";
import { AuthenticationError } from "@/lib/auth-service";
import { NeedsActionError } from "@/lib/user-errors";
import { oneAtATime } from "@/lib/one-at-a-time";
import { accountEmailSender, sendAccountEmail } from "@/lib/account-email";
import { accountEmailOrigin } from "@/lib/account-email-origin";
import type { RequestUser } from "@/lib/auth";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour for a self-service link
/** Marks a reset token the person asked for themselves (no operator involved). */
export const SELF_SERVICE_RESET_ISSUER = "self_service";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

/**
 * End every session this person holds (all devices). Used by sign-out and
 * "Sign out everywhere". Returns the new sessionVersion.
 */
export async function endAllSessions(userId: string, workspaceId: string, reason: "sign_out" | "sign_out_everywhere"): Promise<number> {
  const version = await repositories.userCredential.bumpSessionVersion(userId);
  await repositories.auditLog.create({
    workspaceId,
    actorUserId: userId,
    eventType: reason === "sign_out" ? "auth.signed_out" : "auth.signed_out_everywhere",
    entityType: "user",
    entityId: userId,
    payload: {},
  }).catch((e: unknown) => console.error("[audit] sign-out write failed:", e));
  return version;
}

export type PasswordResetRequestOutcome = {
  /** How many companies a link was sent for. NEVER returned to the browser. */
  linksSent: number;
  emailSent: boolean;
};

/**
 * Self-service "Forgot password?". The route answers the same thing whatever
 * this returns; the count is only for tests and logs.
 */
export async function requestPasswordReset(rawEmail: string): Promise<PasswordResetRequestOutcome> {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { linksSent: 0, emailSent: false };
  const origin = accountEmailOrigin();
  accountEmailSender();
  return oneAtATime(`forgot-password:${email}`, async () => {
    const found = await repositories.auth.findCredentialsByEmail(email);
    const workspaces = found.length ? await repositories.workspace.listAll(true) : [];
    const links: Array<{ company: string; link: string }> = [];
    for (const { user } of found) {
      const workspace = workspaces.find((ws) => ws.id === user.workspaceId);
      if (!workspace || workspace.status === "suspended") continue;
      const member = await repositories.workspaceMember.findForUser(user.workspaceId, user.id);
      if (!member || member.status !== "active") continue;
      // Only the newest link works: retire any earlier unused one for this person.
      for (let i = 0; i < 100; i++) {
        const older = await repositories.passwordResetToken.findLatestForUser(user.id);
        if (!older) break;
        await repositories.passwordResetToken.markConsumed(older.id);
      }
      const rawToken = randomBytes(32).toString("base64url");
      const issuedAt = Date.now();
      await repositories.passwordResetToken.create({
        userId: user.id,
        workspaceId: user.workspaceId,
        tokenHash: sha256(rawToken),
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + RESET_TTL_MS).toISOString(),
        issuedByAdminId: SELF_SERVICE_RESET_ISSUER,
      });
      await repositories.auditLog.create({
        workspaceId: user.workspaceId,
        actorUserId: user.id,
        eventType: "auth.password_reset_requested",
        entityType: "user",
        entityId: user.id,
        payload: {},
      }).catch((e: unknown) => console.error("[audit] reset request write failed:", e));
      links.push({ company: workspace.businessName || workspace.name || "Your company", link: `${origin}/reset-password?token=${encodeURIComponent(rawToken)}` });
    }
    if (!links.length) return { linksSent: 0, emailSent: false };
    const items = links.map((l) => `<li>${escapeHtml(l.company)}: <a href="${l.link}">Set a new password</a></li>`).join("");
    try {
      const delivery = await sendAccountEmail({
        to: email,
        subject: "Reset your LeadCockpit password",
        html: `<p>Someone asked to reset the password for this email on LeadCockpit.</p><ul>${items}</ul><p>The link works once and expires in 1 hour. Setting a new password signs you out on every device.</p><p>If you didn't ask for this, ignore this email — your password stays the same.</p>`,
        purpose: "password_reset",
      });
      const accepted = delivery.ok && delivery.provider !== "mock";
      return { linksSent: accepted ? links.length : 0, emailSent: accepted };
    } catch (e) {
      console.error("[forgot-password] reset email failed:", (e as Error).message);
      return { linksSent: 0, emailSent: false };
    }
  });
}

export type ChangePasswordResult = { sessionToken: string };

/**
 * Change the signed-in person's password. Needs the current password. Ends
 * every session (all devices) and returns a fresh cookie for this one.
 */
export async function changePassword(user: RequestUser, input: { currentPassword: string; newPassword: string }): Promise<ChangePasswordResult> {
  if (user.isTour) throw new AuthenticationError("The demo tour can't change passwords.", 403);
  const credential = await repositories.userCredential.findByUserId(user.id);
  if (!credential) throw new NeedsActionError("This account has no password yet. Use “Forgot password?” on the sign-in page to set one.", 400);
  if (!(await verifyPassword(input.currentPassword || "", credential.passwordHash))) {
    throw new NeedsActionError("Your current password is not right. Try again, or sign out and use “Forgot password?”.", 400);
  }
  if (input.currentPassword === input.newPassword) {
    throw new NeedsActionError("The new password is the same as the current one. Choose a different password.", 400);
  }
  const newHash = await hashPassword(input.newPassword);
  const updated = await repositories.userCredential.updatePasswordAndBumpSession(user.id, newHash);
  await repositories.auditLog.create({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
    eventType: "auth.password_changed",
    entityType: "user",
    entityId: user.id,
    payload: {},
  }).catch((e: unknown) => console.error("[audit] password change write failed:", e));
  const sessionToken = createSessionToken({
    userId: user.id,
    workspaceId: user.workspaceId,
    role: user.role,
    sessionVersion: updated.sessionVersion ?? 1,
  });
  return { sessionToken };
}
