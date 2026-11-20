-- 2026-09-10 (session 55): media bytes move off the container filesystem.
--
-- public/uploads is not a disk on this deployment: every deploy and every
-- free-tier spin-down replaces the container, so uploaded catalogue photos
-- disappeared while their rows survived pointing at a dead URL. Keep the
-- bytes with the row.
ALTER TABLE "media_catalog_items" ADD COLUMN IF NOT EXISTS "content_base64" TEXT;
