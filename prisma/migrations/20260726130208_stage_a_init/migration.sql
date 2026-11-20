-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'sales_member', 'viewer');

-- CreateEnum
CREATE TYPE "BusinessProfileStatus" AS ENUM ('draft', 'reviewed', 'approved');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ICPStatus" AS ENUM ('suggested', 'selected', 'rejected', 'archived');

-- CreateEnum
CREATE TYPE "CompanySizeBucket" AS ENUM ('solo_small_business', 'small_company', 'medium_company', 'large_company', 'unknown');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('needs_review', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('prospected', 'contacted_cold', 'talking', 'sample_phase', 'discovered', 'needs_review', 'approved', 'rejected', 'enriching', 'enriched', 'message_ready', 'contacted', 'replied', 'interested', 'not_interested', 'mql', 'sql', 'hot_lead', 'opportunity', 'won', 'closed_won', 'lost', 'closed_lost', 'do_not_contact', 'invalid', 'duplicate');

-- CreateEnum
CREATE TYPE "EnrichmentStatus" AS ENUM ('not_started', 'pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'approved', 'rejected', 'unsure');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('unqualified', 'possible', 'good_prospect', 'mql', 'sql', 'hot_lead', 'disqualified');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('pending', 'merged', 'ignored');

-- CreateEnum
CREATE TYPE "MessageTemplateStatus" AS ENUM ('draft', 'approved', 'rejected', 'used');

-- CreateEnum
CREATE TYPE "OutreachDirection" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('drafted', 'approved', 'sent_manual', 'sent_api', 'sent', 'replied', 'failed', 'manual');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('not_connected', 'connected', 'error');

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('whatsapp_cloud', 'gmail', 'smtp', 'google_maps', 'google_search', 'instagram', 'linkedin', 'indiamart', 'tradeindia', 'apollo', 'hunter', 'clearbit', 'email_verifier', 'crm_hubspot', 'crm_zoho', 'google_sheets', 'zapier_webhook', 'manual');

-- CreateEnum
CREATE TYPE "SenderAccountStatus" AS ENUM ('active', 'paused', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "ProviderAccountStatus" AS ENUM ('active', 'paused', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "WhatsAppTemplateStatus" AS ENUM ('draft', 'pending', 'approved', 'rejected', 'paused');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "business_name" TEXT,
    "industry" TEXT,
    "target_audience" TEXT,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'active',
    "autonomy_kill_switch" BOOLEAN DEFAULT false,
    "auto_send_toggle" BOOLEAN DEFAULT false,
    "owner_whatsapp_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_name" TEXT,
    "website_url" TEXT,
    "industry" TEXT,
    "business_type" TEXT,
    "description" TEXT,
    "products_json" JSONB,
    "services_json" JSONB,
    "product_categories_json" JSONB,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "whatsapp_number" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "target_geographies_json" JSONB,
    "current_customer_types_json" JSONB,
    "desired_customer_types_json" JSONB,
    "strengths_json" JSONB,
    "limitations_json" JSONB,
    "certifications_json" JSONB,
    "social_links_json" JSONB,
    "catalogue_links_json" JSONB,
    "proof_assets_json" JSONB,
    "language_preference" TEXT,
    "tone_preference" TEXT,
    "status" "BusinessProfileStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "fields_json" JSONB,

    CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_crawl_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "website_url" TEXT NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'pending',
    "pages_found" INTEGER NOT NULL DEFAULT 0,
    "pages_crawled" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_crawl_pages" (
    "id" TEXT NOT NULL,
    "crawl_job_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "raw_html" TEXT,
    "cleaned_text" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_crawl_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_extractions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "crawl_job_id" TEXT,
    "extracted_company_name" TEXT,
    "extracted_industry" TEXT,
    "extracted_products_json" JSONB,
    "extracted_services_json" JSONB,
    "extracted_contacts_json" JSONB,
    "extracted_locations_json" JSONB,
    "extracted_socials_json" JSONB,
    "extracted_strengths_json" JSONB,
    "extracted_target_customers_json" JSONB,
    "extracted_certifications_json" JSONB,
    "extracted_catalogue_links_json" JSONB,
    "confidence_json" JSONB,
    "missing_fields_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "icps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "buyer_type" TEXT,
    "industries_json" JSONB,
    "geography_json" JSONB,
    "company_size_bucket" "CompanySizeBucket" NOT NULL DEFAULT 'unknown',
    "likely_needs_json" JSONB,
    "buying_triggers_json" JSONB,
    "pain_points_json" JSONB,
    "preferred_channels_json" JSONB,
    "messaging_angles_json" JSONB,
    "qualification_rules_json" JSONB,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "ICPStatus" NOT NULL DEFAULT 'suggested',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "icps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "icp_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "target_region_json" JSONB,
    "product_focus_json" JSONB,
    "offer" TEXT,
    "selected_channels_json" JSONB,
    "daily_outreach_limit" INTEGER NOT NULL DEFAULT 20,
    "lead_goal" INTEGER NOT NULL DEFAULT 50,
    "plan_json" JSONB,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'needs_review',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "icp_id" TEXT,
    "company_name" TEXT,
    "contact_name" TEXT,
    "contact_role" TEXT,
    "website_url" TEXT,
    "source" TEXT,
    "source_url" TEXT,
    "source_type" TEXT,
    "linkedin_url" TEXT,
    "instagram_url" TEXT,
    "facebook_url" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "whatsapp_number" TEXT,
    "country" TEXT,
    "state" TEXT,
    "city" TEXT,
    "address" TEXT,
    "buyer_type" TEXT,
    "industry" TEXT,
    "company_size_bucket" "CompanySizeBucket" NOT NULL DEFAULT 'unknown',
    "fit_reason" TEXT,
    "discovered_info" TEXT,
    "personalization_note" TEXT,
    "lead_score" INTEGER NOT NULL DEFAULT 0,
    "fit_score" INTEGER NOT NULL DEFAULT 0,
    "need_score" INTEGER NOT NULL DEFAULT 0,
    "reachability_score" INTEGER NOT NULL DEFAULT 0,
    "timing_score" INTEGER NOT NULL DEFAULT 0,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qualification_status" "QualificationStatus" NOT NULL DEFAULT 'unqualified',
    "score_reason_json" JSONB,
    "enrichment_result_json" JSONB,
    "relevancy_reason" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'needs_review',
    "enrichment_status" "EnrichmentStatus" NOT NULL DEFAULT 'not_started',
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
    "consent_status" TEXT,
    "assigned_to" TEXT,
    "last_contacted_at" TIMESTAMP(3),
    "next_follow_up_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "question_text" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interactions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "needs_human_help" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_fallback_tasks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "interaction_id" TEXT NOT NULL,
    "prospect_query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "converted_to_ticket_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_fallback_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_enrichment_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "provider" TEXT NOT NULL,
    "status" "EnrichmentStatus" NOT NULL DEFAULT 'pending',
    "input_json" JSONB,
    "output_json" JSONB,
    "confidence_json" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_enrichment_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_candidates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id_1" TEXT NOT NULL,
    "lead_id_2" TEXT NOT NULL,
    "duplicate_reason" TEXT NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "DuplicateStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "tone" TEXT,
    "language" TEXT,
    "status" "MessageTemplateStatus" NOT NULL DEFAULT 'draft',
    "personalization_used_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_activities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "lead_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "message_template_id" TEXT,
    "direction" "OutreachDirection" NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'drafted',
    "sent_manually" BOOLEAN NOT NULL DEFAULT true,
    "body" TEXT,
    "subject" TEXT,
    "media_attachment_id" TEXT,
    "media_attachment_url" TEXT,
    "media_attachment_name" TEXT,
    "activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "lead_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "raw_text" TEXT NOT NULL,
    "classification" TEXT,
    "confidence_score" DOUBLE PRECISION,
    "summary" TEXT,
    "suggested_next_action" TEXT,
    "suggested_response" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_metrics" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_learnings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "winning_patterns_json" JSONB,
    "losing_patterns_json" JSONB,
    "recommended_next_steps_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_learnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'not_connected',
    "auth_type" TEXT,
    "encrypted_credentials" TEXT,
    "config_json" JSONB,
    "last_connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "input_json" JSONB,
    "output_json" JSONB,
    "status" "AgentRunStatus" NOT NULL,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "payload_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "integration_id" TEXT,
    "provider" "WebhookProvider" NOT NULL,
    "account_identifier" TEXT,
    "email" TEXT,
    "phone_number" TEXT,
    "display_name" TEXT,
    "status" "ProviderAccountStatus" NOT NULL DEFAULT 'active',
    "daily_limit" INTEGER,
    "used_today" INTEGER NOT NULL DEFAULT 0,
    "config_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider_template_id" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT,
    "status" "WhatsAppTemplateStatus" NOT NULL DEFAULT 'draft',
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "payload_json" JSONB,
    "metadata_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload_json" JSONB,
    "result_json" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_behavior_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "policy_json" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_behavior_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_communication_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'English',
    "tone" TEXT NOT NULL DEFAULT 'professional_friendly',
    "brand_voice" TEXT,
    "message_length" TEXT NOT NULL DEFAULT 'short',
    "greeting" TEXT NOT NULL DEFAULT 'Hello',
    "closing" TEXT NOT NULL DEFAULT 'Thank you',
    "preferred_words_json" JSONB,
    "avoided_words_json" JSONB,
    "formality_level" TEXT,
    "emoji_usage" TEXT NOT NULL DEFAULT 'minimal',
    "allow_hinglish" BOOLEAN NOT NULL DEFAULT false,
    "custom_instructions" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_communication_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "policy_json" JSONB NOT NULL,
    "sensitive_topics_json" JSONB,
    "auto_reply_allowed_categories_json" JSONB,
    "human_approval_required_categories_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_agent_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'draft_only',
    "default_language" TEXT NOT NULL DEFAULT 'English',
    "max_auto_replies_per_conversation" INTEGER NOT NULL DEFAULT 3,
    "business_hours_json" JSONB,
    "escalation_contact_name" TEXT,
    "escalation_contact_phone" TEXT,
    "escalation_contact_email" TEXT,
    "unknown_answer_behavior" TEXT NOT NULL DEFAULT 'hold_for_review',
    "abusive_message_behavior" TEXT NOT NULL DEFAULT 'escalate',
    "price_question_behavior" TEXT NOT NULL DEFAULT 'ask_quantity_or_escalate',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "condition_json" JSONB,
    "action_json" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unknown_questions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "conversation_id" TEXT,
    "channel" TEXT NOT NULL,
    "question_text" TEXT NOT NULL,
    "missing_topic" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "suggested_answer" TEXT,
    "final_answer" TEXT,
    "generated_by" TEXT,
    "related_domain" TEXT,
    "related_question_key" TEXT,
    "conflict_sources_json" JSONB,
    "source_ids_json" JSONB,
    "source_document_id" TEXT,
    "priority" TEXT,
    "converted_to_ticket_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unknown_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_number" INTEGER NOT NULL DEFAULT 0,
    "lead_id" TEXT,
    "reply_id" TEXT,
    "conversation_id" TEXT,
    "source_channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resolution" TEXT,
    "assigned_to" TEXT,
    "source_entity_type" TEXT,
    "source_entity_id" TEXT,
    "sla_started_at" TIMESTAMP(3) NOT NULL,
    "sla_due_at" TIMESTAMP(3) NOT NULL,
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "first_responded_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor_user_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_sla_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "clock_mode" TEXT NOT NULL DEFAULT 'business_hours',
    "business_hours_start" TEXT NOT NULL DEFAULT '09:00',
    "business_hours_end" TEXT NOT NULL DEFAULT '18:00',
    "business_days_json" JSONB,
    "urgent_sla_minutes" INTEGER NOT NULL DEFAULT 240,
    "high_sla_minutes" INTEGER NOT NULL DEFAULT 480,
    "medium_sla_minutes" INTEGER NOT NULL DEFAULT 1440,
    "low_sla_minutes" INTEGER NOT NULL DEFAULT 10080,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_sla_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_reply_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "reply_id" TEXT,
    "channel" TEXT NOT NULL,
    "incoming_message" TEXT NOT NULL,
    "retrieved_context_json" JSONB,
    "classification" TEXT,
    "generated_reply" TEXT,
    "confidence_score" DOUBLE PRECISION,
    "can_auto_send" BOOLEAN NOT NULL DEFAULT false,
    "needs_human_review" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "model_provider" TEXT,
    "model_name" TEXT,
    "model_mode" TEXT,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "validation_status" TEXT,
    "send_attempted" BOOLEAN NOT NULL DEFAULT false,
    "send_status" TEXT,
    "provider_message_id" TEXT,
    "provider_error" TEXT,
    "media_attachment_id" TEXT,
    "media_attachment_url" TEXT,
    "media_attachment_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'drafted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_reply_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_catalog_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "file_name" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "caption" TEXT,
    "lead_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "content_text" TEXT NOT NULL,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_base_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_chunks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding_json" JSONB,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_base_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_query_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "query_text" TEXT NOT NULL,
    "retrieved_chunks_json" JSONB,
    "answer_used" BOOLEAN NOT NULL DEFAULT false,
    "confidence_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_base_query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_provider_credentials" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "display_name" TEXT,
    "encrypted_api_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not_connected',
    "config_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_model_routing" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_name" TEXT,
    "model_tier" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "fallback_provider" TEXT,
    "fallback_model_name" TEXT,
    "config_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_model_routing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_limits" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "daily_token_limit" INTEGER,
    "monthly_token_limit" INTEGER,
    "daily_cost_limit" DOUBLE PRECISION,
    "monthly_cost_limit" DOUBLE PRECISION,
    "current_daily_tokens" INTEGER NOT NULL DEFAULT 0,
    "current_monthly_tokens" INTEGER NOT NULL DEFAULT 0,
    "current_daily_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "current_monthly_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reset_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_crawl_consents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "website_url" TEXT NOT NULL,
    "consent_given" BOOLEAN NOT NULL DEFAULT false,
    "consent_given_at" TIMESTAMP(3),
    "consent_text_version" TEXT NOT NULL DEFAULT 'v1',
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_crawl_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_knowledges" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "product_category" TEXT,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_knowledges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_varieties" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_knowledge_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "use_cases_json" JSONB,
    "buyer_types_json" JSONB,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_varieties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_applications" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_knowledge_id" TEXT NOT NULL,
    "variety_id" TEXT,
    "application_name" TEXT NOT NULL,
    "industry" TEXT,
    "description" TEXT,
    "example_products_json" JSONB,
    "buyer_types_json" JSONB,
    "seasonality_json" JSONB,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_segments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment_type" TEXT NOT NULL,
    "description" TEXT,
    "needs_json" JSONB,
    "buying_criteria_json" JSONB,
    "preferred_channels_json" JSONB,
    "qualification_signals_json" JSONB,
    "bad_fit_signals_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buyer_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_application_market_maps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_knowledge_id" TEXT NOT NULL,
    "variety_id" TEXT,
    "application_id" TEXT NOT NULL,
    "buyer_segment_id" TEXT NOT NULL,
    "targeting_angle" TEXT NOT NULL,
    "message_angle" TEXT NOT NULL,
    "search_queries_json" JSONB,
    "lead_sources_json" JSONB,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_application_market_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_review_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'manual_review',
    "auto_approve_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "auto_reject_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "max_auto_approved_per_day" INTEGER NOT NULL DEFAULT 25,
    "require_human_for_new_campaigns" BOOLEAN NOT NULL DEFAULT true,
    "require_human_for_new_industries" BOOLEAN NOT NULL DEFAULT true,
    "allow_auto_enrichment" BOOLEAN NOT NULL DEFAULT false,
    "allow_auto_outreach_preparation" BOOLEAN NOT NULL DEFAULT true,
    "allow_auto_send" BOOLEAN NOT NULL DEFAULT false,
    "audit_every_decision" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_review_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_review_decisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "decision" TEXT NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "reason" TEXT NOT NULL,
    "matched_signals_json" JSONB,
    "risk_signals_json" JSONB,
    "suggested_next_step" TEXT,
    "mode_used" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "provisional" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "do_not_contact_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "normalized_phone" TEXT,
    "normalized_email" TEXT,
    "reason" TEXT NOT NULL,
    "source_lead_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "do_not_contact_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_question_answers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain_key" TEXT NOT NULL,
    "question_key" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "answer_status" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "source_title" TEXT,
    "source_url" TEXT,
    "source_file_name" TEXT,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "used_by_agents_json" JSONB NOT NULL,
    "maps_to_json" JSONB NOT NULL,
    "human_review_required" BOOLEAN NOT NULL DEFAULT false,
    "source_snippet" TEXT,
    "conflict_with_existing" BOOLEAN,
    "conflict_reason" TEXT,
    "reviewed_by_user" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "is_user_approved" BOOLEAN,
    "is_canonical" BOOLEAN,
    "superseded_by_answer_id" TEXT,
    "merged_from_answer_ids" JSONB,
    "evidence_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_question_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_extraction_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total_questions" INTEGER NOT NULL DEFAULT 0,
    "processed_questions" INTEGER,
    "answered_count" INTEGER NOT NULL DEFAULT 0,
    "unanswered_count" INTEGER NOT NULL DEFAULT 0,
    "partial_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,
    "failed_batch_count" INTEGER,
    "total_batches" INTEGER,
    "completed_batches" INTEGER,
    "current_domain" TEXT,
    "current_batch_index" INTEGER,
    "model_provider" TEXT,
    "model_name" TEXT,
    "fallback_used" BOOLEAN,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "output_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_extraction_batches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "extraction_run_id" TEXT NOT NULL,
    "document_id" TEXT,
    "domain_key" TEXT NOT NULL,
    "batch_index" INTEGER NOT NULL,
    "question_keys_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 2,
    "model_provider" TEXT,
    "model_name" TEXT,
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "error_message" TEXT,
    "result_json" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_extraction_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_extraction_source_bundles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "website_url" TEXT,
    "website_crawl_job_id" TEXT,
    "uploaded_document_ids_json" JSONB NOT NULL DEFAULT '{}',
    "source_count" INTEGER NOT NULL DEFAULT 0,
    "combined_text_length" INTEGER NOT NULL DEFAULT 0,
    "extraction_run_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_extraction_source_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_extraction_sources" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_title" TEXT NOT NULL,
    "source_url" TEXT,
    "source_file_name" TEXT,
    "extracted_text" TEXT NOT NULL,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_extraction_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "default_moq" TEXT,
    "product_wise_moq" JSONB,
    "standard_credit_period" TEXT,
    "max_credit_period" TEXT,
    "advance_payment_rule" TEXT,
    "sample_availability" TEXT,
    "quotation_validity" TEXT,
    "bulk_order_rule" TEXT,
    "lead_qualification_thresholds" TEXT,
    "human_review_triggers" TEXT,
    "price_discussion_rule" TEXT,
    "discount_negotiation_rules" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "payment_policy" TEXT,
    "credit_policy" TEXT,
    "shipping_delivery_policy" TEXT,
    "return_replacement_policy" TEXT,
    "cancellation_policy" TEXT,
    "customization_policy" TEXT,
    "sample_policy" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "tone" TEXT,
    "default_fallback_reply" TEXT,
    "allowed_auto_reply_topics" JSONB,
    "human_review_required_topics" JSONB,
    "price_reply_rule" TEXT,
    "credit_payment_reply_rule" TEXT,
    "complaint_reply_rule" TEXT,
    "stop_unsubscribe_behavior" TEXT,
    "unknown_answer_behavior" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "products" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_conflicts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "settings_area" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "existing_value" TEXT,
    "extracted_value" TEXT,
    "custom_value" TEXT,
    "extracted_source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolution_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_settings_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_group_key" TEXT,
    "source_title" TEXT,
    "source_topic" TEXT,
    "source_answer" TEXT,
    "products" JSONB,
    "sales" JSONB,
    "policy" JSONB,
    "communication" JSONB,
    "fields" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_settings_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_autonomous_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "icp_generator_mode" TEXT NOT NULL DEFAULT 'manual',
    "campaign_planner_mode" TEXT NOT NULL DEFAULT 'manual',
    "discovery_mode" TEXT NOT NULL DEFAULT 'manual',
    "whatsapp_mode" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_autonomous_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "order_number" INTEGER NOT NULL DEFAULT 0,
    "lead_id" TEXT NOT NULL,
    "quote_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "line_items_json" JSONB NOT NULL,
    "grand_total" DECIMAL(12,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'INR',
    "origin" TEXT NOT NULL DEFAULT 'direct',
    "reordered_from_order_id" TEXT,
    "source_reply_id" TEXT,
    "source_interaction_id" TEXT,
    "discount_given" BOOLEAN DEFAULT false,
    "total_discount_amount" DECIMAL(12,2),
    "shipped_quantity_by_line" JSONB,
    "cancelled_quantity_by_line_json" JSONB,
    "confirmed_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_number" INTEGER NOT NULL DEFAULT 0,
    "lead_id" TEXT NOT NULL,
    "order_id" TEXT,
    "supersedes_quote_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "line_items_json" JSONB NOT NULL,
    "grand_total" DECIMAL(12,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'INR',
    "validity_note" TEXT,
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_workspace_id_idx" ON "users"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_workspace_id_email_key" ON "users"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_status_idx" ON "workspace_members"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_email_key" ON "workspace_members"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "business_profiles_workspace_id_idx" ON "business_profiles"("workspace_id");

-- CreateIndex
CREATE INDEX "business_profiles_workspace_id_status_idx" ON "business_profiles"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "website_crawl_jobs_workspace_id_idx" ON "website_crawl_jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "website_crawl_jobs_workspace_id_status_idx" ON "website_crawl_jobs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "website_crawl_pages_workspace_id_idx" ON "website_crawl_pages"("workspace_id");

-- CreateIndex
CREATE INDEX "website_crawl_pages_crawl_job_id_idx" ON "website_crawl_pages"("crawl_job_id");

-- CreateIndex
CREATE INDEX "business_extractions_workspace_id_idx" ON "business_extractions"("workspace_id");

-- CreateIndex
CREATE INDEX "business_extractions_crawl_job_id_idx" ON "business_extractions"("crawl_job_id");

-- CreateIndex
CREATE INDEX "icps_workspace_id_idx" ON "icps"("workspace_id");

-- CreateIndex
CREATE INDEX "icps_business_profile_id_idx" ON "icps"("business_profile_id");

-- CreateIndex
CREATE INDEX "icps_workspace_id_status_idx" ON "icps"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_idx" ON "campaigns"("workspace_id");

-- CreateIndex
CREATE INDEX "campaigns_business_profile_id_idx" ON "campaigns"("business_profile_id");

-- CreateIndex
CREATE INDEX "campaigns_icp_id_idx" ON "campaigns"("icp_id");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_status_idx" ON "campaigns"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_approval_status_idx" ON "campaigns"("workspace_id", "approval_status");

-- CreateIndex
CREATE INDEX "leads_workspace_id_idx" ON "leads"("workspace_id");

-- CreateIndex
CREATE INDEX "leads_campaign_id_idx" ON "leads"("campaign_id");

-- CreateIndex
CREATE INDEX "leads_icp_id_idx" ON "leads"("icp_id");

-- CreateIndex
CREATE INDEX "leads_workspace_id_status_idx" ON "leads"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "leads_workspace_id_review_status_idx" ON "leads"("workspace_id", "review_status");

-- CreateIndex
CREATE INDEX "leads_workspace_id_enrichment_status_idx" ON "leads"("workspace_id", "enrichment_status");

-- CreateIndex
CREATE INDEX "leads_workspace_id_qualification_status_idx" ON "leads"("workspace_id", "qualification_status");

-- CreateIndex
CREATE INDEX "leads_email_idx" ON "leads"("email");

-- CreateIndex
CREATE INDEX "leads_phone_idx" ON "leads"("phone");

-- CreateIndex
CREATE INDEX "leads_whatsapp_number_idx" ON "leads"("whatsapp_number");

-- CreateIndex
CREATE INDEX "leads_website_url_idx" ON "leads"("website_url");

-- CreateIndex
CREATE INDEX "knowledge_entries_workspace_id_idx" ON "knowledge_entries"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_entries_workspace_id_domain_idx" ON "knowledge_entries"("workspace_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entries_workspace_id_question_id_key" ON "knowledge_entries"("workspace_id", "question_id");

-- CreateIndex
CREATE INDEX "interactions_workspace_id_idx" ON "interactions"("workspace_id");

-- CreateIndex
CREATE INDEX "interactions_lead_id_idx" ON "interactions"("lead_id");

-- CreateIndex
CREATE INDEX "interactions_workspace_id_channel_idx" ON "interactions"("workspace_id", "channel");

-- CreateIndex
CREATE INDEX "interactions_workspace_id_needs_human_help_idx" ON "interactions"("workspace_id", "needs_human_help");

-- CreateIndex
CREATE INDEX "human_fallback_tasks_workspace_id_idx" ON "human_fallback_tasks"("workspace_id");

-- CreateIndex
CREATE INDEX "human_fallback_tasks_interaction_id_idx" ON "human_fallback_tasks"("interaction_id");

-- CreateIndex
CREATE INDEX "human_fallback_tasks_workspace_id_status_idx" ON "human_fallback_tasks"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "lead_enrichment_runs_workspace_id_idx" ON "lead_enrichment_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "lead_enrichment_runs_lead_id_idx" ON "lead_enrichment_runs"("lead_id");

-- CreateIndex
CREATE INDEX "lead_enrichment_runs_campaign_id_idx" ON "lead_enrichment_runs"("campaign_id");

-- CreateIndex
CREATE INDEX "lead_enrichment_runs_workspace_id_status_idx" ON "lead_enrichment_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "duplicate_candidates_workspace_id_idx" ON "duplicate_candidates"("workspace_id");

-- CreateIndex
CREATE INDEX "duplicate_candidates_lead_id_1_idx" ON "duplicate_candidates"("lead_id_1");

-- CreateIndex
CREATE INDEX "duplicate_candidates_lead_id_2_idx" ON "duplicate_candidates"("lead_id_2");

-- CreateIndex
CREATE INDEX "duplicate_candidates_workspace_id_status_idx" ON "duplicate_candidates"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_candidates_lead_id_1_lead_id_2_key" ON "duplicate_candidates"("lead_id_1", "lead_id_2");

-- CreateIndex
CREATE INDEX "message_templates_workspace_id_idx" ON "message_templates"("workspace_id");

-- CreateIndex
CREATE INDEX "message_templates_campaign_id_idx" ON "message_templates"("campaign_id");

-- CreateIndex
CREATE INDEX "message_templates_lead_id_idx" ON "message_templates"("lead_id");

-- CreateIndex
CREATE INDEX "message_templates_workspace_id_status_idx" ON "message_templates"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "outreach_activities_workspace_id_idx" ON "outreach_activities"("workspace_id");

-- CreateIndex
CREATE INDEX "outreach_activities_campaign_id_idx" ON "outreach_activities"("campaign_id");

-- CreateIndex
CREATE INDEX "outreach_activities_lead_id_idx" ON "outreach_activities"("lead_id");

-- CreateIndex
CREATE INDEX "outreach_activities_message_template_id_idx" ON "outreach_activities"("message_template_id");

-- CreateIndex
CREATE INDEX "outreach_activities_workspace_id_status_idx" ON "outreach_activities"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "replies_workspace_id_idx" ON "replies"("workspace_id");

-- CreateIndex
CREATE INDEX "replies_campaign_id_idx" ON "replies"("campaign_id");

-- CreateIndex
CREATE INDEX "replies_lead_id_idx" ON "replies"("lead_id");

-- CreateIndex
CREATE INDEX "replies_classification_idx" ON "replies"("classification");

-- CreateIndex
CREATE INDEX "campaign_metrics_workspace_id_idx" ON "campaign_metrics"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_metrics_campaign_id_idx" ON "campaign_metrics"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_metrics_campaign_id_metric_name_calculated_at_key" ON "campaign_metrics"("campaign_id", "metric_name", "calculated_at");

-- CreateIndex
CREATE INDEX "campaign_learnings_workspace_id_idx" ON "campaign_learnings"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_learnings_campaign_id_idx" ON "campaign_learnings"("campaign_id");

-- CreateIndex
CREATE INDEX "integrations_workspace_id_idx" ON "integrations"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_workspace_id_provider_key" ON "integrations"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_idx" ON "agent_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_agent_name_idx" ON "agent_runs"("workspace_id", "agent_name");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_status_idx" ON "agent_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_idx" ON "audit_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_event_type_idx" ON "audit_logs"("workspace_id", "event_type");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "webhook_events_workspace_id_idx" ON "webhook_events"("workspace_id");

-- CreateIndex
CREATE INDEX "webhook_events_workspace_id_provider_idx" ON "webhook_events"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "webhook_events_workspace_id_processed_idx" ON "webhook_events"("workspace_id", "processed");

-- CreateIndex
CREATE INDEX "provider_accounts_workspace_id_idx" ON "provider_accounts"("workspace_id");

-- CreateIndex
CREATE INDEX "provider_accounts_integration_id_idx" ON "provider_accounts"("integration_id");

-- CreateIndex
CREATE INDEX "provider_accounts_workspace_id_provider_idx" ON "provider_accounts"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "provider_accounts_workspace_id_status_idx" ON "provider_accounts"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_workspace_id_provider_account_identifier_key" ON "provider_accounts"("workspace_id", "provider", "account_identifier");

-- CreateIndex
CREATE INDEX "whatsapp_templates_workspace_id_idx" ON "whatsapp_templates"("workspace_id");

-- CreateIndex
CREATE INDEX "whatsapp_templates_workspace_id_status_idx" ON "whatsapp_templates"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_workspace_id_name_language_key" ON "whatsapp_templates"("workspace_id", "name", "language");

-- CreateIndex
CREATE INDEX "event_logs_workspace_id_idx" ON "event_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "event_logs_workspace_id_event_type_idx" ON "event_logs"("workspace_id", "event_type");

-- CreateIndex
CREATE INDEX "event_logs_entity_type_entity_id_idx" ON "event_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "job_runs_workspace_id_idx" ON "job_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "job_runs_workspace_id_job_type_idx" ON "job_runs"("workspace_id", "job_type");

-- CreateIndex
CREATE INDEX "job_runs_workspace_id_status_idx" ON "job_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "agent_behavior_policies_workspace_id_idx" ON "agent_behavior_policies"("workspace_id");

-- CreateIndex
CREATE INDEX "agent_behavior_policies_scope_is_active_idx" ON "agent_behavior_policies"("scope", "is_active");

-- CreateIndex
CREATE INDEX "company_communication_settings_workspace_id_idx" ON "company_communication_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_communication_settings_workspace_id_key" ON "company_communication_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "conversation_policies_workspace_id_idx" ON "conversation_policies"("workspace_id");

-- CreateIndex
CREATE INDEX "conversation_policies_workspace_id_channel_idx" ON "conversation_policies"("workspace_id", "channel");

-- CreateIndex
CREATE INDEX "whatsapp_agent_settings_workspace_id_idx" ON "whatsapp_agent_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_agent_settings_workspace_id_key" ON "whatsapp_agent_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "escalation_rules_workspace_id_idx" ON "escalation_rules"("workspace_id");

-- CreateIndex
CREATE INDEX "escalation_rules_workspace_id_channel_idx" ON "escalation_rules"("workspace_id", "channel");

-- CreateIndex
CREATE INDEX "unknown_questions_workspace_id_idx" ON "unknown_questions"("workspace_id");

-- CreateIndex
CREATE INDEX "unknown_questions_workspace_id_status_idx" ON "unknown_questions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "unknown_questions_lead_id_idx" ON "unknown_questions"("lead_id");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_idx" ON "tickets"("workspace_id");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_status_idx" ON "tickets"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_priority_idx" ON "tickets"("workspace_id", "priority");

-- CreateIndex
CREATE INDEX "tickets_lead_id_idx" ON "tickets"("lead_id");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_sla_breached_idx" ON "tickets"("workspace_id", "sla_breached");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_workspace_id_ticket_number_key" ON "tickets"("workspace_id", "ticket_number");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_idx" ON "ticket_events"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_events_workspace_id_idx" ON "ticket_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_sla_settings_workspace_id_key" ON "ticket_sla_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "auto_reply_logs_workspace_id_idx" ON "auto_reply_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "auto_reply_logs_workspace_id_status_idx" ON "auto_reply_logs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "auto_reply_logs_lead_id_idx" ON "auto_reply_logs"("lead_id");

-- CreateIndex
CREATE INDEX "media_catalog_items_workspace_id_idx" ON "media_catalog_items"("workspace_id");

-- CreateIndex
CREATE INDEX "media_catalog_items_workspace_id_category_idx" ON "media_catalog_items"("workspace_id", "category");

-- CreateIndex
CREATE INDEX "media_catalog_items_lead_id_idx" ON "media_catalog_items"("lead_id");

-- CreateIndex
CREATE INDEX "knowledge_base_documents_workspace_id_idx" ON "knowledge_base_documents"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_base_documents_workspace_id_document_type_idx" ON "knowledge_base_documents"("workspace_id", "document_type");

-- CreateIndex
CREATE INDEX "knowledge_base_documents_workspace_id_status_idx" ON "knowledge_base_documents"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_base_chunks_workspace_id_idx" ON "knowledge_base_chunks"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_base_chunks_document_id_idx" ON "knowledge_base_chunks"("document_id");

-- CreateIndex
CREATE INDEX "knowledge_base_query_logs_workspace_id_idx" ON "knowledge_base_query_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "llm_provider_credentials_workspace_id_idx" ON "llm_provider_credentials"("workspace_id");

-- CreateIndex
CREATE INDEX "llm_provider_credentials_workspace_id_provider_idx" ON "llm_provider_credentials"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "llm_model_routing_workspace_id_idx" ON "llm_model_routing"("workspace_id");

-- CreateIndex
CREATE INDEX "llm_model_routing_workspace_id_task_name_idx" ON "llm_model_routing"("workspace_id", "task_name");

-- CreateIndex
CREATE INDEX "ai_usage_limits_workspace_id_idx" ON "ai_usage_limits"("workspace_id");

-- CreateIndex
CREATE INDEX "website_crawl_consents_workspace_id_idx" ON "website_crawl_consents"("workspace_id");

-- CreateIndex
CREATE INDEX "website_crawl_consents_workspace_id_website_url_idx" ON "website_crawl_consents"("workspace_id", "website_url");

-- CreateIndex
CREATE INDEX "product_knowledges_workspace_id_idx" ON "product_knowledges"("workspace_id");

-- CreateIndex
CREATE INDEX "product_knowledges_workspace_id_product_name_idx" ON "product_knowledges"("workspace_id", "product_name");

-- CreateIndex
CREATE INDEX "product_varieties_workspace_id_idx" ON "product_varieties"("workspace_id");

-- CreateIndex
CREATE INDEX "product_varieties_product_knowledge_id_idx" ON "product_varieties"("product_knowledge_id");

-- CreateIndex
CREATE INDEX "product_applications_workspace_id_idx" ON "product_applications"("workspace_id");

-- CreateIndex
CREATE INDEX "product_applications_product_knowledge_id_idx" ON "product_applications"("product_knowledge_id");

-- CreateIndex
CREATE INDEX "product_applications_variety_id_idx" ON "product_applications"("variety_id");

-- CreateIndex
CREATE INDEX "buyer_segments_workspace_id_idx" ON "buyer_segments"("workspace_id");

-- CreateIndex
CREATE INDEX "buyer_segments_workspace_id_segment_type_idx" ON "buyer_segments"("workspace_id", "segment_type");

-- CreateIndex
CREATE INDEX "product_application_market_maps_workspace_id_idx" ON "product_application_market_maps"("workspace_id");

-- CreateIndex
CREATE INDEX "product_application_market_maps_product_knowledge_id_idx" ON "product_application_market_maps"("product_knowledge_id");

-- CreateIndex
CREATE INDEX "product_application_market_maps_application_id_idx" ON "product_application_market_maps"("application_id");

-- CreateIndex
CREATE INDEX "product_application_market_maps_buyer_segment_id_idx" ON "product_application_market_maps"("buyer_segment_id");

-- CreateIndex
CREATE INDEX "lead_review_settings_workspace_id_mode_idx" ON "lead_review_settings"("workspace_id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "lead_review_settings_workspace_id_key" ON "lead_review_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "lead_review_decisions_workspace_id_idx" ON "lead_review_decisions"("workspace_id");

-- CreateIndex
CREATE INDEX "lead_review_decisions_workspace_id_lead_id_idx" ON "lead_review_decisions"("workspace_id", "lead_id");

-- CreateIndex
CREATE INDEX "lead_review_decisions_workspace_id_campaign_id_idx" ON "lead_review_decisions"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "user_credentials_workspace_id_idx" ON "user_credentials"("workspace_id");

-- CreateIndex
CREATE INDEX "user_credentials_user_id_idx" ON "user_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_credentials_workspace_id_email_key" ON "user_credentials"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "do_not_contact_entries_workspace_id_idx" ON "do_not_contact_entries"("workspace_id");

-- CreateIndex
CREATE INDEX "do_not_contact_entries_workspace_id_normalized_phone_idx" ON "do_not_contact_entries"("workspace_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "do_not_contact_entries_workspace_id_normalized_email_idx" ON "do_not_contact_entries"("workspace_id", "normalized_email");

-- CreateIndex
CREATE INDEX "knowledge_question_answers_workspace_id_idx" ON "knowledge_question_answers"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_question_answers_workspace_id_domain_key_idx" ON "knowledge_question_answers"("workspace_id", "domain_key");

-- CreateIndex
CREATE INDEX "knowledge_question_answers_workspace_id_answer_status_idx" ON "knowledge_question_answers"("workspace_id", "answer_status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_question_answers_workspace_id_question_key_key" ON "knowledge_question_answers"("workspace_id", "question_key");

-- CreateIndex
CREATE INDEX "knowledge_extraction_runs_workspace_id_idx" ON "knowledge_extraction_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_extraction_runs_workspace_id_status_idx" ON "knowledge_extraction_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_extraction_batches_workspace_id_idx" ON "knowledge_extraction_batches"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_extraction_batches_extraction_run_id_idx" ON "knowledge_extraction_batches"("extraction_run_id");

-- CreateIndex
CREATE INDEX "knowledge_extraction_batches_workspace_id_status_idx" ON "knowledge_extraction_batches"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_extraction_source_bundles_workspace_id_idx" ON "knowledge_extraction_source_bundles"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_extraction_source_bundles_workspace_id_status_idx" ON "knowledge_extraction_source_bundles"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_extraction_sources_workspace_id_idx" ON "knowledge_extraction_sources"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_extraction_sources_bundle_id_idx" ON "knowledge_extraction_sources"("bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_settings_workspace_id_key" ON "sales_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_settings_workspace_id_key" ON "policy_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_settings_workspace_id_key" ON "communication_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_settings_workspace_id_key" ON "product_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "settings_conflicts_workspace_id_idx" ON "settings_conflicts"("workspace_id");

-- CreateIndex
CREATE INDEX "settings_conflicts_workspace_id_status_idx" ON "settings_conflicts"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "pending_settings_drafts_workspace_id_idx" ON "pending_settings_drafts"("workspace_id");

-- CreateIndex
CREATE INDEX "pending_settings_drafts_workspace_id_status_idx" ON "pending_settings_drafts"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_autonomous_settings_workspace_id_key" ON "agent_autonomous_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "orders_workspace_id_idx" ON "orders"("workspace_id");

-- CreateIndex
CREATE INDEX "orders_workspace_id_status_idx" ON "orders"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "orders_lead_id_idx" ON "orders"("lead_id");

-- CreateIndex
CREATE INDEX "orders_quote_id_idx" ON "orders"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_workspace_id_order_number_key" ON "orders"("workspace_id", "order_number");

-- CreateIndex
CREATE INDEX "quotes_workspace_id_idx" ON "quotes"("workspace_id");

-- CreateIndex
CREATE INDEX "quotes_workspace_id_status_idx" ON "quotes"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "quotes_lead_id_idx" ON "quotes"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_workspace_id_quote_number_key" ON "quotes"("workspace_id", "quote_number");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_crawl_jobs" ADD CONSTRAINT "website_crawl_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_crawl_pages" ADD CONSTRAINT "website_crawl_pages_crawl_job_id_fkey" FOREIGN KEY ("crawl_job_id") REFERENCES "website_crawl_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_crawl_pages" ADD CONSTRAINT "website_crawl_pages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_extractions" ADD CONSTRAINT "business_extractions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_extractions" ADD CONSTRAINT "business_extractions_crawl_job_id_fkey" FOREIGN KEY ("crawl_job_id") REFERENCES "website_crawl_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "icps" ADD CONSTRAINT "icps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "icps" ADD CONSTRAINT "icps_business_profile_id_fkey" FOREIGN KEY ("business_profile_id") REFERENCES "business_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_business_profile_id_fkey" FOREIGN KEY ("business_profile_id") REFERENCES "business_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_fallback_tasks" ADD CONSTRAINT "human_fallback_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_fallback_tasks" ADD CONSTRAINT "human_fallback_tasks_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_enrichment_runs" ADD CONSTRAINT "lead_enrichment_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_enrichment_runs" ADD CONSTRAINT "lead_enrichment_runs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_enrichment_runs" ADD CONSTRAINT "lead_enrichment_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_lead_id_1_fkey" FOREIGN KEY ("lead_id_1") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_lead_id_2_fkey" FOREIGN KEY ("lead_id_2") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_activities" ADD CONSTRAINT "outreach_activities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_activities" ADD CONSTRAINT "outreach_activities_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_activities" ADD CONSTRAINT "outreach_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_activities" ADD CONSTRAINT "outreach_activities_message_template_id_fkey" FOREIGN KEY ("message_template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_metrics" ADD CONSTRAINT "campaign_metrics_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_metrics" ADD CONSTRAINT "campaign_metrics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_learnings" ADD CONSTRAINT "campaign_learnings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_learnings" ADD CONSTRAINT "campaign_learnings_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logs" ADD CONSTRAINT "event_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_behavior_policies" ADD CONSTRAINT "agent_behavior_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_communication_settings" ADD CONSTRAINT "company_communication_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_policies" ADD CONSTRAINT "conversation_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_agent_settings" ADD CONSTRAINT "whatsapp_agent_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unknown_questions" ADD CONSTRAINT "unknown_questions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_reply_logs" ADD CONSTRAINT "auto_reply_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_catalog_items" ADD CONSTRAINT "media_catalog_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_documents" ADD CONSTRAINT "knowledge_base_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_chunks" ADD CONSTRAINT "knowledge_base_chunks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_chunks" ADD CONSTRAINT "knowledge_base_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_base_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_query_logs" ADD CONSTRAINT "knowledge_base_query_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_provider_credentials" ADD CONSTRAINT "llm_provider_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_model_routing" ADD CONSTRAINT "llm_model_routing_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_limits" ADD CONSTRAINT "ai_usage_limits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_crawl_consents" ADD CONSTRAINT "website_crawl_consents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_knowledges" ADD CONSTRAINT "product_knowledges_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_varieties" ADD CONSTRAINT "product_varieties_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_varieties" ADD CONSTRAINT "product_varieties_product_knowledge_id_fkey" FOREIGN KEY ("product_knowledge_id") REFERENCES "product_knowledges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_applications" ADD CONSTRAINT "product_applications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_applications" ADD CONSTRAINT "product_applications_product_knowledge_id_fkey" FOREIGN KEY ("product_knowledge_id") REFERENCES "product_knowledges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_applications" ADD CONSTRAINT "product_applications_variety_id_fkey" FOREIGN KEY ("variety_id") REFERENCES "product_varieties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buyer_segments" ADD CONSTRAINT "buyer_segments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_application_market_maps" ADD CONSTRAINT "product_application_market_maps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_application_market_maps" ADD CONSTRAINT "product_application_market_maps_product_knowledge_id_fkey" FOREIGN KEY ("product_knowledge_id") REFERENCES "product_knowledges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_application_market_maps" ADD CONSTRAINT "product_application_market_maps_variety_id_fkey" FOREIGN KEY ("variety_id") REFERENCES "product_varieties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_application_market_maps" ADD CONSTRAINT "product_application_market_maps_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "product_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_application_market_maps" ADD CONSTRAINT "product_application_market_maps_buyer_segment_id_fkey" FOREIGN KEY ("buyer_segment_id") REFERENCES "buyer_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_review_settings" ADD CONSTRAINT "lead_review_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_review_decisions" ADD CONSTRAINT "lead_review_decisions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "do_not_contact_entries" ADD CONSTRAINT "do_not_contact_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_question_answers" ADD CONSTRAINT "knowledge_question_answers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_extraction_runs" ADD CONSTRAINT "knowledge_extraction_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_extraction_batches" ADD CONSTRAINT "knowledge_extraction_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_extraction_source_bundles" ADD CONSTRAINT "knowledge_extraction_source_bundles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_extraction_sources" ADD CONSTRAINT "knowledge_extraction_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_settings" ADD CONSTRAINT "policy_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_settings" ADD CONSTRAINT "communication_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_settings" ADD CONSTRAINT "product_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings_conflicts" ADD CONSTRAINT "settings_conflicts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_settings_drafts" ADD CONSTRAINT "pending_settings_drafts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_autonomous_settings" ADD CONSTRAINT "agent_autonomous_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
