-- 2026-09-28: team and sign-in safety (docs/REVIEW-2026-09-27.md section 4, S3/S4/S8).
-- Rules: docs/LOGIC.md 2026-09-28.

-- S8: sign-in finds every account for an email with ONE indexed lookup,
-- instead of one query per company.
-- CreateIndex
CREATE INDEX "user_credentials_email_idx" ON "user_credentials"("email");

-- S4: the operator console's sign-out must end the session for real. The
-- admin cookie carries this number; signing out bumps it.
-- AlterTable
ALTER TABLE "platform_admin_credentials" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 1;

-- S4: an audit event for the operator signing out.
-- AlterEnum
ALTER TYPE "PlatformAuditEvent" ADD VALUE 'admin_logout';

-- S3: access now needs an ACTIVE membership row in the company, and the role
-- is read from that row. Every account created by the product already has one
-- (owner set-up, sign-up, invite). This gives one to any older account that
-- can sign in but has none, with the role it has today, so nobody is locked
-- out by the change. The demo tour viewer is left out on purpose (tour
-- sessions are checked separately and are always read-only).
INSERT INTO "workspace_members" ("id", "workspace_id", "user_id", "email", "name", "role", "status", "created_at", "updated_at")
SELECT 'member_backfill_' || u."id", u."workspace_id", u."id", u."email", u."name", u."role", 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users" u
WHERE u."id" <> 'user_tour'
  AND EXISTS (SELECT 1 FROM "user_credentials" c WHERE c."user_id" = u."id")
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_members" m
    WHERE m."workspace_id" = u."workspace_id"
      AND (m."user_id" = u."id" OR lower(m."email") = lower(u."email"))
  );
