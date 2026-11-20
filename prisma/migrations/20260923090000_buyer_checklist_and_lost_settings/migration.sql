-- 2026-09-23, session 58.
--
-- 1. THREE SETTINGS PRODUCTION NEVER KEPT.
--    autoAcknowledgeSensitive, acknowledgementTemplate and messageBatchingEnabled
--    were added to the WhatsApp settings on 2026-08-02 (CP-22, CP-23). The JSON
--    store kept them. Postgres had no column and the repository payload named
--    none of them, so on the substrate we ship on, an owner who switched on
--    "acknowledge sensitive questions" saved nothing and reloaded to OFF. Nothing
--    threw. Defaults match what a missing value already read as, so existing rows
--    behave exactly as before this migration.
ALTER TABLE "whatsapp_agent_settings" ADD COLUMN IF NOT EXISTS "auto_acknowledge_sensitive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_agent_settings" ADD COLUMN IF NOT EXISTS "acknowledgement_template" TEXT;
ALTER TABLE "whatsapp_agent_settings" ADD COLUMN IF NOT EXISTS "message_batching_enabled" BOOLEAN NOT NULL DEFAULT false;

-- 2. N12 — the owner's buyer checklist. NULL means "never decided", which is
--    what makes the system PROPOSE a starting list rather than listen for
--    nothing. An owner's deliberately empty list is stored as a value, not NULL.
ALTER TABLE "whatsapp_agent_settings" ADD COLUMN IF NOT EXISTS "discovery_checklist_json" JSONB;

-- 3. N12 — lines the owner added to one lead alone.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "discovery_extras_json" JSONB;
