-- AlterTable
ALTER TABLE "ticket_sla_settings" ADD COLUMN     "assignment_mode" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "assignment_rules_json" JSONB,
ADD COLUMN     "round_robin_pointer" INTEGER NOT NULL DEFAULT 0;
