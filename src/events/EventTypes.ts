export const EVENT_TYPES = [
  "workspace.created",
  "website_crawl.consent_given",
  "website_crawl.started",
  "website_crawl.extraction_review_required",
  "business_extraction.generated",
  "business_profile.created",
  "business_profile.approved",
  "icp.generated",
  "icp.selected",
  "campaign.created",
  "campaign.approved",
  "lead.created",
  "lead.approved",
  "lead.rejected",
  "lead.enrichment_requested",
  "lead.enriched",
  "lead.scored",
  "lead.review_decision_created",
  "lead.review_recommended",
  "lead.auto_approved",
  "message.generated",
  "message.approved",
  "outreach.marked_sent",
  "reply.created",
  "reply.classified",
  "lead.became_mql",
  "lead.became_sql",
  "lead.became_hot",
  "lead.marked_do_not_contact",
  "task.followup_due",
  "campaign.completed",
  "campaign.learning_generated",
  "product_research.generated",
  "unknown_question.created",
  "auto_reply.held_for_review",
  "whatsapp.dry_run_completed",
  "knowledge.document_created",
  // 2026-09-08 — removing a source document is as consequential as adding one:
  // it changes what the agent can quote. It gets an event for the same reason
  // the create does.
  "knowledge.document_deleted",
  "knowledge.answer_added",
  "ai_settings.updated",
  "settings.conflicts_created",
] as const;

export type AppEventType = (typeof EVENT_TYPES)[number];

export type AppEvent = {
  eventId: string;
  eventType: AppEventType;
  workspaceId: string;
  entityType?: string;
  entityId?: string;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type EventInput = Omit<AppEvent, "eventId" | "timestamp"> & {
  eventId?: string;
  timestamp?: string;
};
