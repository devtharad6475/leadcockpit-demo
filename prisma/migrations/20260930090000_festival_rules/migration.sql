-- 2026-09-30 — each company's festival rules (FestivalCalendarService).
ALTER TABLE "ticket_sla_settings" ADD COLUMN "festival_rules_json" JSONB;
