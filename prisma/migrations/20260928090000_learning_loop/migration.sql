-- 2026-09-28: the system learns from what actually happens (docs/LOGIC.md LEARNING-LOOP).
-- Written by hand (no database reachable from the worktree); the lead applies it.

-- Outcome signals: real results per customer, erased with the customer.
CREATE TABLE "outcome_signals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION,
    "related_reply_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcome_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outcome_signals_workspace_id_kind_source_id_key" ON "outcome_signals"("workspace_id", "kind", "source_id");

-- CreateIndex
CREATE INDEX "outcome_signals_workspace_id_at_idx" ON "outcome_signals"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "outcome_signals_workspace_id_lead_id_idx" ON "outcome_signals"("workspace_id", "lead_id");

-- AddForeignKey
ALTER TABLE "outcome_signals" ADD CONSTRAINT "outcome_signals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcome_signals" ADD CONSTRAINT "outcome_signals_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The owner's verdict on a reply the AI sent by itself.
ALTER TABLE "auto_reply_logs" ADD COLUMN "owner_verdict" TEXT;
ALTER TABLE "auto_reply_logs" ADD COLUMN "owner_verdict_at" TIMESTAMP(3);

-- Kinds the system switched off after a bad result.
ALTER TABLE "whatsapp_agent_settings" ADD COLUMN "auto_reply_paused_json" JSONB;

-- Reorder / dormant proposals: what they are about, and the order cycle.
ALTER TABLE "follow_ups" ADD COLUMN "kind" TEXT;
ALTER TABLE "follow_ups" ADD COLUMN "cycle_key" TEXT;
