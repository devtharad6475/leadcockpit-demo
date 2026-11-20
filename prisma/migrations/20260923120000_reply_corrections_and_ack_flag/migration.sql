-- 2026-09-23, session 58.
--
-- 1. CP-22's "holding message sent" flag. The WhatsApp engine has passed it
--    to the reply log since 2026-08-02, and NEITHER store kept it: Postgres had
--    no column, and both create paths name their fields by hand and left it out. On production the owner's
--    timeline never showed "Holding message sent to customer", and a reply that
--    had already had a holding message looked like one that had not.
--    Default false is what a missing value already read as.
ALTER TABLE "auto_reply_logs" ADD COLUMN IF NOT EXISTS "acknowledgement_sent" BOOLEAN NOT NULL DEFAULT false;

-- 2. N5 — keep the AI's draft when the owner corrects it before approving.
--    Approval overwrites generated_reply with the sent text, so until now the
--    correction was thrown away. Existing rows cannot be backfilled: what the
--    AI originally wrote for them is gone. Learning starts from here.
ALTER TABLE "auto_reply_logs" ADD COLUMN IF NOT EXISTS "ai_draft" TEXT;
ALTER TABLE "auto_reply_logs" ADD COLUMN IF NOT EXISTS "owner_edited" BOOLEAN NOT NULL DEFAULT false;
