-- N-DATA-3 — ten tables carried a workspace_id with no foreign key behind it.
--
-- Postgres did not know the column pointed at anything, so deleting a workspace
-- cascaded straight past these tables and left their rows behind forever. The
-- documented contract on WorkspaceRepository.delete ("deleting a workspace
-- removes every row belonging to it") was therefore false on the substrate we
-- ship on, while the JSON substrate — the one the goldens run on — swept them
-- correctly. The two disagreed, with the tested one right and the shipped one
-- wrong.
--
-- Measured in this database immediately before writing this migration:
--
--   ticket_events             orphaned=57  total=57
--   ticket_sla_settings       orphaned=28  total=28
--   platform_tickets          orphaned=23  total=23
--   platform_ticket_events    orphaned=138 total=138
--   (the other six tables were empty, so they were latent, not active)
--
-- 246 rows, and in all four tables the orphan count EQUALS the total: not one
-- legitimate row among them. Every owning workspace id is a golden-run fixture
-- (gc-*, ws_golden_fieldclear_*, sp-*) whose cleanup deleted the workspace and
-- could not reach these tables. workspace_demo, the only real tenant, owned zero.
--
-- The deletes below must run BEFORE the constraints: adding a foreign key to a
-- table that already holds unmatched rows fails outright, so a migration that
-- only added the keys would abort on any database with history.

-- Children before parents, so a cascade cannot race the explicit delete.
DELETE FROM "platform_ticket_events" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "ticket_events"          WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "platform_tickets"       WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "ticket_sla_settings"    WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "platform_user_blocks"   WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "password_reset_tokens"  WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "email_verification_tokens" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "invites"                WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
DELETE FROM "owner_copilot_messages" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");
-- feature_flags.workspace_id is NULLABLE by design: a global flag has no tenant
-- and must survive. NULL is never "unmatched" to a foreign key, so only rows
-- carrying a non-null id that points nowhere are removed.
DELETE FROM "feature_flags" WHERE "workspace_id" IS NOT NULL AND "workspace_id" NOT IN (SELECT "id" FROM "workspaces");

-- Pre-existing drift, unrelated to N-DATA-3 and corrected here because the
-- generator emitted it: the column was created as `json` while the schema has
-- always declared `Json`, which Prisma maps to `jsonb`.
ALTER TABLE "owner_copilot_messages" ALTER COLUMN "pending_action_json" SET DATA TYPE JSONB;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_sla_settings" ADD CONSTRAINT "ticket_sla_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_tickets" ADD CONSTRAINT "platform_tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_ticket_events" ADD CONSTRAINT "platform_ticket_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_user_blocks" ADD CONSTRAINT "platform_user_blocks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_copilot_messages" ADD CONSTRAINT "owner_copilot_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
