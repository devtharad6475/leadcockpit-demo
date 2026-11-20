-- N13 (2026-09-25): each business is asked the checklist for its kind of
-- business instead of the same 424 questions. The owner's confirmed choice is
-- stored on the profile; until confirmed, a proposal is computed and shown.
ALTER TABLE "business_profiles" ADD COLUMN "checklist_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "business_profiles" ADD COLUMN "checklist_exports" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "business_profiles" ADD COLUMN "checklist_confirmed_at" TIMESTAMP(3);
