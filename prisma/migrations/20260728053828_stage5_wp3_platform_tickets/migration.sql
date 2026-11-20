-- CreateEnum
CREATE TYPE "PlatformTicketCategory" AS ENUM ('bug', 'account', 'billing', 'how_to', 'data_request', 'other');

-- CreateEnum
CREATE TYPE "PlatformTicketStatus" AS ENUM ('open', 'in_progress', 'waiting_on_user', 'resolved', 'closed', 'reopened');

-- CreateEnum
CREATE TYPE "PlatformTicketEventType" AS ENUM ('created', 'status_changed', 'priority_changed', 'assigned', 'commented', 'sla_breached', 'reopened', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "PlatformTicketActorType" AS ENUM ('user', 'operator', 'system');

-- CreateEnum
CREATE TYPE "PlatformAdminRole" AS ENUM ('operator', 'support_agent');

-- CreateEnum
CREATE TYPE "PlatformAdminStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "PlatformAuditEvent" AS ENUM ('admin_login', 'admin_login_failed', 'admin_created', 'admin_suspended', 'ticket_flagged_spam', 'ticket_assigned', 'ticket_status_changed', 'user_blocked', 'user_unblocked', 'workspace_suspended', 'workspace_resumed', 'impersonation_started', 'impersonation_ended', 'config_changed');

-- CreateTable
CREATE TABLE "platform_tickets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "raised_by_user_id" TEXT NOT NULL,
    "ticket_number" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "PlatformTicketCategory" NOT NULL,
    "status" "PlatformTicketStatus" NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL,
    "assigned_admin_id" TEXT,
    "is_spam_flagged" BOOLEAN NOT NULL DEFAULT false,
    "spam_reason" TEXT,
    "flagged_by_admin_id" TEXT,
    "sla_started_at" TIMESTAMP(3) NOT NULL,
    "sla_due_at" TIMESTAMP(3) NOT NULL,
    "first_response_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_ticket_events" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_type" "PlatformTicketEventType" NOT NULL,
    "actor_type" "PlatformTicketActorType" NOT NULL,
    "actor_user_id" TEXT,
    "actor_admin_id" TEXT,
    "from_status" "PlatformTicketStatus",
    "to_status" "PlatformTicketStatus",
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_support_hours" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "hours_start" TEXT NOT NULL,
    "hours_end" TEXT NOT NULL,
    "business_days" INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_support_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_ticket_sla_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "urgent_sla_minutes" INTEGER NOT NULL,
    "high_sla_minutes" INTEGER NOT NULL,
    "medium_sla_minutes" INTEGER NOT NULL,
    "low_sla_minutes" INTEGER NOT NULL,
    "clock_mode" TEXT NOT NULL DEFAULT 'business_hours',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_ticket_sla_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user_blocks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "is_blocked_from_support" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "blocked_by_admin_id" TEXT NOT NULL,
    "blocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PlatformAdminRole" NOT NULL DEFAULT 'operator',
    "status" "PlatformAdminStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_credentials" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admin_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" "PlatformAuditEvent" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_tickets_status_idx" ON "platform_tickets"("status");

-- CreateIndex
CREATE INDEX "platform_tickets_workspace_id_idx" ON "platform_tickets"("workspace_id");

-- CreateIndex
CREATE INDEX "platform_tickets_raised_by_user_id_idx" ON "platform_tickets"("raised_by_user_id");

-- CreateIndex
CREATE INDEX "platform_tickets_is_spam_flagged_idx" ON "platform_tickets"("is_spam_flagged");

-- CreateIndex
CREATE INDEX "platform_tickets_assigned_admin_id_idx" ON "platform_tickets"("assigned_admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_tickets_ticket_number_key" ON "platform_tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "platform_ticket_events_ticket_id_idx" ON "platform_ticket_events"("ticket_id");

-- CreateIndex
CREATE INDEX "platform_ticket_events_workspace_id_idx" ON "platform_ticket_events"("workspace_id");

-- CreateIndex
CREATE INDEX "platform_user_blocks_workspace_id_idx" ON "platform_user_blocks"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_blocks_user_id_key" ON "platform_user_blocks"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_credentials_admin_id_key" ON "platform_admin_credentials"("admin_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_admin_id_idx" ON "platform_audit_logs"("admin_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_action_idx" ON "platform_audit_logs"("action");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "platform_ticket_events" ADD CONSTRAINT "platform_ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "platform_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admin_credentials" ADD CONSTRAINT "platform_admin_credentials_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
