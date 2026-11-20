-- CreateTable
CREATE TABLE "processed_webhook_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "from_phone" TEXT,
    "processed_at" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processed_webhook_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_webhook_messages_workspace_id_idx" ON "processed_webhook_messages"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhook_messages_workspace_id_provider_message_id_key" ON "processed_webhook_messages"("workspace_id", "provider_message_id");

-- AddForeignKey
ALTER TABLE "processed_webhook_messages" ADD CONSTRAINT "processed_webhook_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
