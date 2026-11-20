-- UX Fix 1 (2026-08-05) — operator's internal note on a held customer reply.
--
-- BACKFILL OF A MISSED MIGRATION. The `internalNote` field was added to
-- prisma/schema.prisma, to the AutoReplyLog TypeScript type, to the Replies
-- UI, and to AutoReplyLogPrismaRepository.updateNote() — but the migration
-- was never generated. Result: the column did not exist in Postgres and was
-- absent from the generated client, so `updateNote` threw
-- "Unknown argument `internalNote`" on every call in the PRISMA runtime while
-- working fine on the JSON demo substrate.
--
-- Found by scripts/golden/golden-substrate-parity.ts (audit finding F-1),
-- which drives both substrates through the same operation script and diffs
-- the results. This is the first defect that golden caught.
--
-- Column is nullable: every existing auto-reply log predates the note field.

ALTER TABLE "auto_reply_logs" ADD COLUMN "internal_note" TEXT;
