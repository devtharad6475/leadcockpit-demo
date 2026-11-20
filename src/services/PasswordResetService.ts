/**
 * PasswordResetService — Stage 5 re-audit fix (F-P0-4, 2026-07-28).
 *
 * The REDEMPTION side of the WP2 password-reset flow. The ISSUE side
 * (operator triggers reset → token generated + hashed + emailed) lives in
 * PlatformAdminService.issuePasswordReset. Pre-fix, the redemption side was
 * entirely missing: no findByTokenHash, no redeem service, no route, no page.
 * The emailed link 404'd + the sessionVersion bump permanently locked the
 * user out. This closes that gap.
 *
 * CONTRACT (docs/LOGIC.md 2026-07-28 + pinned by golden:password-reset-redemption):
 *   - redeemPasswordReset(rawToken, newPassword) verifies the token hash,
 *     checks expiry + unconsumed, sets the new password (hashed), re-bumps
 *     sessionVersion (kills any sessions minted between issue + redeem), and
 *     marks the token consumed — ATOMICALLY (one mutateData for JSON; one
 *     database transaction with conditional token claim for Prisma).
 *   - Tokens are one-shot (a second redeem with the same token throws).
 *   - Expired tokens throw (410-ish).
 *   - Invalid/guessed tokens throw (the hashed-store lookup returns nothing).
 *
 * SECURITY: the raw token is NEVER stored (only its SHA-256 hash). The raw
 * token appears only in the emailed link. We hash it here to look up the row.
 *
 * NO-AUTO-OUTREACH: this service sends NO emails. The issue side already
 * emailed the link; the redemption is a pure password-set operation.
 */
import { createHash } from "node:crypto";
import { repositories } from "@/repositories";
import { hashPassword } from "@/lib/password";
import { AuthenticationError } from "@/lib/auth-service";
import { oneAtATime } from "@/lib/one-at-a-time";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type RedeemPasswordResetResult = {
  userId: string;
  workspaceId: string;
  completedAt: string;
};

/**
 * Redeem a password-reset token: set a new password + consume the token.
 * Throws on invalid/expired/consumed tokens. The password is hashed before
 * storage (scrypt); the raw password is never persisted.
 */
export async function redeemPasswordReset(input: {
  rawToken: string;
  newPassword: string;
}): Promise<RedeemPasswordResetResult> {
  if (!input.rawToken || input.rawToken.length < 10) {
    throw new AuthenticationError("Reset token is required.", 400);
  }
  if (!input.newPassword || input.newPassword.length < 8) {
    throw new AuthenticationError("Password must be at least 8 characters.", 400);
  }

  // Look up the token row by its hash (the raw token is never stored).
  const tokenHash = sha256(input.rawToken);
  // 2026-09-26 (break test): two uses of one link at the same moment both
  // passed the "already used?" check and both set a password. One at a time.
  return oneAtATime(`password-reset:${tokenHash}`, () => redeemChecked(tokenHash, input.newPassword));
}

async function redeemChecked(tokenHash: string, newPassword: string): Promise<RedeemPasswordResetResult> {
  const input = { newPassword };
  const tokenRow = await repositories.passwordResetToken.findByTokenHash(tokenHash);
  if (!tokenRow) {
    throw new AuthenticationError("Invalid reset token.", 400);
  }

  // Already consumed → one-shot semantics.
  if (tokenRow.consumedAt) {
    throw new AuthenticationError(
      "This reset link has already been used, or a newer one was sent. Use the latest email, or request a new link.",
      410,
    );
  }

  // Expired → reject.
  if (Date.parse(tokenRow.expiresAt) < Date.now()) {
    throw new AuthenticationError("This reset link has expired. Request a new one.", 410);
  }

  // Set the new password + re-bump sessionVersion (kills any session minted
  // between issue + redeem, e.g. if the user logged in elsewhere during the
  // reset window). The hashPassword call is the expensive step; do it before
  // the write so a failure here doesn't consume the token.
  const newHash = await hashPassword(input.newPassword);
  const result = await repositories.passwordResetToken.redeem(tokenHash, newHash);
  if (!result) throw new AuthenticationError("This reset link has expired or has already been used. Request a new link.", 410);
  return result;
}
