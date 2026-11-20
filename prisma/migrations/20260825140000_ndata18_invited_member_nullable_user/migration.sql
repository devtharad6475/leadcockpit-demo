-- N-DATA-18 (audit A-7, 2026-08-25) — an invited member has no user yet.
--
-- InviteService created a workspace_members row with user_id = '' so the team
-- list could show the pending invitee before they accept. The JSON substrate
-- stored that happily; Postgres refused it with workspace_members_user_id_fkey
-- because '' is not a user id, so EVERY team invite failed on the database we
-- actually ship on. Nullable is the honest model: the User row is created at
-- accept time, and until then this column has nothing true to hold.
--
-- Side effect, and a good one: @@unique(workspace_id, user_id) previously made
-- two pending invites in the same workspace collide on ('ws', ''). Postgres
-- treats NULLs as distinct, so that constraint now does what it was meant to
-- do. Duplicate invites remain blocked by @@unique(workspace_id, email).
ALTER TABLE "workspace_members" ALTER COLUMN "user_id" DROP NOT NULL;

-- Belt and braces. Rows with '' cannot exist here (the foreign key was already
-- rejecting them) but the same column is written by the JSON substrate, and a
-- database restored from a JSON-era import could carry them.
UPDATE "workspace_members" SET "user_id" = NULL WHERE "user_id" = '';
