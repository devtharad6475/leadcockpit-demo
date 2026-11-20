-- The owner's answer to "what do you do with an abusive customer?" is a sentence
-- about behaviour. It was being stored in the human-review TOPICS list. It gets
-- its own field so the AI reads it as an instruction (2026-09-24).
ALTER TABLE "communication_settings" ADD COLUMN "abusive_message_rule" TEXT;
