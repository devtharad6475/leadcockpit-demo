-- 2026-09-28 — leftovers from the 2026-09-27 review (docs/LOGIC.md 2026-09-28).
--
-- M10: a company's closed dates (holidays). The reply-deadline clock skips them.
ALTER TABLE "ticket_sla_settings" ADD COLUMN "closed_dates_json" JSONB;

-- M9: reply-deadline defaults in WORKING minutes (9-hour day, Mon-Sat):
-- urgent 4 h = 240, high 1 day = 540, medium 3 days = 1620, low 6 days = 3240
-- (= 7 calendar days). The old 480 / 1440 / 10080 were written for an 8-hour
-- day and for calendar minutes; "low" came out at about three weeks.
ALTER TABLE "ticket_sla_settings" ALTER COLUMN "high_sla_minutes" SET DEFAULT 540;
ALTER TABLE "ticket_sla_settings" ALTER COLUMN "medium_sla_minutes" SET DEFAULT 1620;
ALTER TABLE "ticket_sla_settings" ALTER COLUMN "low_sla_minutes" SET DEFAULT 3240;

-- Rows still holding exactly the old four defaults were never chosen by an
-- owner (no screen ever showed per-priority times), so they take the new ones.
-- The app also reads such rows as the new defaults (upgradeLegacySlaDefaults).
UPDATE "ticket_sla_settings"
SET "high_sla_minutes" = 540, "medium_sla_minutes" = 1620, "low_sla_minutes" = 3240
WHERE "urgent_sla_minutes" = 240 AND "high_sla_minutes" = 480
  AND "medium_sla_minutes" = 1440 AND "low_sla_minutes" = 10080;

-- L10: a company known only by its website can be on the do-not-contact register.
ALTER TABLE "do_not_contact_entries" ADD COLUMN "normalized_domain" TEXT;
CREATE INDEX "do_not_contact_entries_workspace_id_normalized_domain_idx" ON "do_not_contact_entries"("workspace_id", "normalized_domain");
