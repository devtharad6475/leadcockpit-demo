-- N-DATA-19 (audit A-7, 2026-08-25) — a reply does not always have a lead.
--
-- An inbound WhatsApp message from a number the workspace has never seen is
-- the ordinary first contact, not an edge case. There is no lead row yet, so
-- the product writes the reply with no lead id — deliberately, since the old
-- placeholder "unmatched_whatsapp_lead" produced orphan rows that survived a
-- customer's erasure request.
--
-- The JSON substrate accepted that (a file does not check). Postgres rejected
-- the whole insert, so on the database we ship on every inbound from an
-- unknown number returned a 500 and the reply the product promises to record
-- "always, no silent drops" was silently dropped.
ALTER TABLE "replies" ALTER COLUMN "lead_id" DROP NOT NULL;

-- Belt and braces, same as N-DATA-18. Rows carrying the empty string or the
-- old placeholder cannot exist here today (the foreign key was already
-- refusing them), but the same column is written by the JSON substrate and a
-- database restored from a JSON-era import could carry either.
UPDATE "replies" SET "lead_id" = NULL WHERE "lead_id" = '' OR "lead_id" = 'unmatched_whatsapp_lead';
