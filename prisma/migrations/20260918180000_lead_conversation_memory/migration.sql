-- N4 (2026-09-18, session 57) — what a buyer has told us, kept on the lead.
--
-- Deliberately three columns and not one. The TEXT is what the AI reads before
-- the next conversation; the SOURCE is what stops the AI overwriting a
-- correction the owner made by hand; the timestamp is what lets the owner see
-- how old the memory is before trusting it.
--
-- Nullable with no default: a lead nobody has spoken to has no memory, and an
-- empty string would read as "we talked and they said nothing".
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "conversation_memory" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "conversation_memory_source" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "conversation_memory_at" TIMESTAMP(3);
