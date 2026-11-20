-- D-2026-09-27-b (CEO): the kinds of question the AI may answer by itself
-- when a customer messages first. Empty = nothing is sent automatically.
ALTER TABLE "whatsapp_agent_settings" ADD COLUMN "auto_reply_topics" TEXT[] DEFAULT ARRAY[]::TEXT[];
