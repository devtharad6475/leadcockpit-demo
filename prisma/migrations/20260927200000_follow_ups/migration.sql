-- 2026-09-27: reminders to do something later about a customer ("call after Diwali").
-- Plan: docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md section 2.
-- CreateTable
CREATE TABLE "follow_ups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "due_on" TEXT,
    "note" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'owner',
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_by" TEXT,
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_ups_workspace_id_status_due_on_idx" ON "follow_ups"("workspace_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "follow_ups_workspace_id_lead_id_idx" ON "follow_ups"("workspace_id", "lead_id");

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

