-- Owner Copilot (2026-08-01) — owner-facing assistant chat.
-- Design: docs/planning/OWNER_COPILOT_DESIGN.md. Persists the conversation so
-- the chat survives refresh + is auditable. The 5-tier router + Quote handler
-- live in OwnerCopilotService; these tables only store chat state.

-- CreateTable
CREATE TABLE "owner_copilot_conversations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "active_lead_id" TEXT,
    "clarify_batch_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_copilot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_copilot_conversations_workspace_id_idx" ON "owner_copilot_conversations"("workspace_id");

-- CreateIndex
CREATE INDEX "owner_copilot_conversations_workspace_id_owner_user_id_idx" ON "owner_copilot_conversations"("workspace_id", "owner_user_id");

-- AddForeignKey
ALTER TABLE "owner_copilot_conversations" ADD CONSTRAINT "owner_copilot_conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "owner_copilot_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'unknown',
    "tier" TEXT,
    "pending_action_json" JSON,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_copilot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_copilot_messages_workspace_id_conversation_id_idx" ON "owner_copilot_messages"("workspace_id", "conversation_id");

-- AddForeignKey
ALTER TABLE "owner_copilot_messages" ADD CONSTRAINT "owner_copilot_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "owner_copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
