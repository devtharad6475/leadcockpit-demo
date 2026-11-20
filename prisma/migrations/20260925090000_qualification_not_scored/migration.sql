-- 2026-09-25 (CEO decision: lead scoring is AI only). A lead the AI could not
-- score yet is "not_scored" - never a rule-based guess.
-- AlterEnum
ALTER TYPE "QualificationStatus" ADD VALUE 'not_scored';
