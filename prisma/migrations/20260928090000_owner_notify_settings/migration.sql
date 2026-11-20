-- 2026-09-28: the owner's own WhatsApp morning summary + urgent alerts.
-- All off by default (a NULL column reads as "everything off").
-- Shape: OwnerNotifySettings in src/lib/owner-notify.ts. Rules: docs/LOGIC.md OWNER-WHATSAPP.
-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "owner_notify_settings" JSONB;
