export const LEAD_STATUSES = [
  "discovered",
  "needs_review",
  "approved",
  "rejected",
  "enriching",
  "enriched",
  "message_ready",
  "contacted",
  "replied",
  "interested",
  "not_interested",
  "mql",
  "sql",
  "hot_lead",
  "opportunity",
  "won",
  "lost",
  "do_not_contact",
  "invalid",
  "duplicate",
] as const;

export const REVIEW_STATUSES = ["pending", "approved", "rejected", "unsure"] as const;

export const ENRICHMENT_STATUSES = ["not_started", "pending", "running", "completed", "failed"] as const;

export const QUALIFICATION_STATUSES = [
  "unqualified",
  "possible",
  "good_prospect",
  "mql",
  "sql",
  "hot_lead",
  "disqualified",
  // 2026-09-25 — the AI has not scored this lead yet (lead scoring is AI only).
  "not_scored",
] as const;

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;

export const APPROVAL_STATUSES = ["needs_review", "approved", "rejected"] as const;

export const OUTREACH_STATUSES = [
  "drafted",
  "approved",
  "sent_manual",
  "sent_api",
  "delivered",
  "opened",
  "clicked",
  "replied",
  "failed",
  "cancelled",
] as const;

export const REPLY_CLASSIFICATIONS = [
  "interested",
  "not_interested",
  "ask_catalogue",
  "ask_price",
  "ask_sample",
  "ask_moq",
  "ask_delivery",
  "ask_payment_terms",
  "ask_location",
  "ask_export",
  "asks_for_call",
  "wrong_person",
  "contact_later",
  "already_has_supplier",
  "objection",
  "unsubscribe",
  "spam",
  "irrelevant",
  "hot_lead",
  "unknown",
] as const;

export type LeadStatusValue = (typeof LEAD_STATUSES)[number];
export type ReviewStatusValue = (typeof REVIEW_STATUSES)[number];
export type EnrichmentStatusValue = (typeof ENRICHMENT_STATUSES)[number];
export type QualificationStatusValue = (typeof QUALIFICATION_STATUSES)[number];
export type ReplyClassificationValue = (typeof REPLY_CLASSIFICATIONS)[number];
