-- CreateTable
CREATE TABLE "lead_phone_numbers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "normalized_digits" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_phone_numbers_workspace_id_idx" ON "lead_phone_numbers"("workspace_id");

-- CreateIndex
CREATE INDEX "lead_phone_numbers_normalized_digits_idx" ON "lead_phone_numbers"("normalized_digits");

-- CreateIndex
CREATE UNIQUE INDEX "lead_phone_numbers_lead_id_normalized_digits_key" ON "lead_phone_numbers"("lead_id", "normalized_digits");

-- AddForeignKey
ALTER TABLE "lead_phone_numbers" ADD CONSTRAINT "lead_phone_numbers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_phone_numbers" ADD CONSTRAINT "lead_phone_numbers_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
