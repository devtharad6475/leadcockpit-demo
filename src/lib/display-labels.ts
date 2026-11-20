/**
 * 2026-07-21 (M2) — Display label map.
 *
 * THE single source of truth for translating backend codes → friendly
 * user-facing labels. Per docs/UI-DESIGN.md M2 and the audit finding
 * (DECISIONS.md 2026-07-21): the audit found 26+ sites of
 * `.replaceAll("_", " ")` and raw enum dumps of "mql", "do_not_contact",
 * etc. This file replaces all of them.
 *
 * RULES (locked):
 *   - Every backend code that EVER surfaces in the UI has a function
 *     here. New codes → add to the relevant function.
 *   - Unknown codes are returned as-is (don't crash). This is intentional
 *     so the system degrades gracefully if the backend adds a new code
 *     before the label map is updated.
 *   - Labels never contain underscores (CASE K in the golden test).
 *   - Labels are sentence-case ("Needs review", not "Needs Review" or
 *     "needs review").
 *   - Abbreviations get expanded to plain English ("mql" → "Marketing
 *     qualified", not "Mql").
 *
 * Tone helpers return the BadgeTone for status colours so callers can
 * pass both label + tone to <Badge tone={...}>.
 *
 * Pinned by scripts/golden/golden-display-labels.ts.
 */
import { isAiScored } from "@/lib/lead-rules";
import type { BadgeTone } from "@/components/ui/Badge";

// ---------------------------------------------------------------------------
// Generic helper.
// ---------------------------------------------------------------------------

/**
 * Last-resort humaniser. Capitalises the first letter of each word and
 * replaces underscores with spaces. Used by `displayLabel(code)` for the
 * generic fallback only. The specific display functions (displayLeadStatus,
 * etc.) intentionally return the raw code if unknown — that way an
 * unexpected backend code shows up literally instead of being silently
 * transformed, so an operator notices and reports it.
 */
export function displayLabel(code: string): string {
  if (!code) return "";
  // Preserve already-uppercase strings (e.g. "MVP", "GST").
  if (code === code.toUpperCase() && code !== code.toLowerCase()) {
    return code.replace(/_/g, " ");
  }
  // Sentence case: underscores → spaces, only first letter of the whole
  // string capitalised. Matches the project's label convention
  // (UI-DESIGN.md: "Needs review", not "Needs Review").
  const withSpaces = code.replace(/_/g, " ");
  const sentence = withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
  return applyKnownSpellings(sentence);
}

/**
 * Words that have one correct spelling regardless of where they sit in a
 * sentence (2026-09-04, N-UX-24).
 *
 * The sentence-case rule above is right for ordinary words and wrong for
 * these. It printed the Knowledge Base domain "faqs" as "Faqs" on a wall of
 * twenty-four cards, and a ticket that arrived on WhatsApp as "Whatsapp" —
 * the name of the product the whole channel is built on, misspelt. Neither is
 * a data problem; both are this one function.
 *
 * Keys are lower-case whole words; matching is whole-word only, so "AI" never
 * appears inside "said" and "id" never inside "video".
 */
const KNOWN_SPELLINGS: Record<string, string> = {
  ai: "AI",
  api: "API",
  b2b: "B2B",
  crm: "CRM",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  minimax: "MiniMax",
  csv: "CSV",
  faq: "FAQ",
  faqs: "FAQs",
  gst: "GST",
  icp: "ICP",
  id: "ID",
  kyc: "KYC",
  mql: "MQL",
  pdf: "PDF",
  sla: "SLA",
  sms: "SMS",
  sql: "SQL",
  url: "URL",
  whatsapp: "WhatsApp",
};

function applyKnownSpellings(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => KNOWN_SPELLINGS[word.toLowerCase()] ?? word);
}

// ---------------------------------------------------------------------------
// Lead status.
// ---------------------------------------------------------------------------

const LEAD_STATUS_LABELS: Record<string, string> = {
  prospected: "Prospected",
  contacted_cold: "Cold contacted",
  talking: "In conversation",
  sample_phase: "Sample phase",
  discovered: "Discovered",
  needs_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
  enriching: "Enriching",
  enriched: "Enriched",
  message_ready: "Message ready",
  contacted: "Contacted",
  replied: "Replied",
  interested: "Interested",
  not_interested: "Not interested",
  // 2026-09-25 — sales jargon (MQL/SQL) in plain words.
  mql: "Warm lead",
  sql: "Ready to talk",
  hot_lead: "Hot lead",
  opportunity: "Opportunity",
  won: "Won",
  closed_won: "Won",
  lost: "Lost",
  closed_lost: "Lost",
  do_not_contact: "Do not contact",
  invalid: "Invalid",
  duplicate: "Duplicate",
};

/**
 * Render a stored, free-text title without letting a backend code reach the
 * screen (N-UX-11, 2026-09-03).
 *
 * The screen walk kept finding `manual_text` on the Knowledge Base — a document
 * titled "manual_text question answers question answers". The write path that
 * produced it was fixed, and the row heals on that document's next update, but
 * "it will heal eventually" is not a property an operator can see. Any row
 * written by an older build, imported, or restored from a backup carries the
 * old text for as long as nobody touches it.
 *
 * So the guard is at the point of DISPLAY, where it is total: whatever is in
 * the column, a backend code cannot be shown.
 *
 * Deliberately narrow. It rewrites ONLY tokens that are unambiguously
 * snake_case (lowercase words joined by underscores) and leaves every other
 * character exactly as the operator typed it — so "Combined onboarding sources
 * (3)" and "Q3 pricing v2.1" pass through untouched. It is not `displayLabel`,
 * which sentence-cases the whole string and would flatten real titles.
 */
export function displayStoredTitle(title: string | null | undefined): string {
  if (!title) return "Untitled";
  // 2026-09-04 N-BUG-2 -- this line was written with word boundaries around the
  // token, and both boundary escapes had been silently turned into literal
  // BACKSPACE characters (U+0008) before it was ever committed. The regex read
  // correctly in every editor and matched nothing at all at runtime, so this
  // guard has never once fired and `manual_text` kept reaching the screen
  // straight through it. It is the sixth time this exact escape has been eaten
  // (see docs/DECISIONS.md) and the first time it reached the product rather
  // than a document.
  const cleaned = title.replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, (token) => token.replace(/_/g, " "));
  const trimmed = cleaned.trim();
  return trimmed || "Untitled";
}

export function displayLeadStatus(code: string): string {
  return LEAD_STATUS_LABELS[code] ?? code;
}

/**
 * 2026-08-05 multi-agent audit V-P1-1: lead status badges had NO semantic colour
 * (all grey) while score chips on the same row were colour-banded — making the
 * status column look unfinished. Maps each lead status to a badge tone so the
 * operator's eye can scan for "what needs action."
 */
export function displayLeadStatusTone(code: string): BadgeTone {
  switch (code) {
    // Positive / actionable-good
    case "approved":
    case "won":
    case "closed_won":
    case "hot_lead":
    case "interested":
    case "opportunity":
      return "success";
    // Needs attention / in-progress
    case "contacted":
    case "replied":
    case "talking":
    case "sample_phase":
    case "mql":
    case "sql":
    case "message_ready":
      return "info";
    // Warning / cooling
    case "contacted_cold":
    case "needs_review":
    case "discovered":
    case "enriching":
    case "enriched":
      return "warning";
    // Negative / blocked
    case "do_not_contact":
    case "not_interested":
    case "rejected":
    case "lost":
    case "closed_lost":
    case "invalid":
    case "duplicate":
      return "danger";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Review status.
// ---------------------------------------------------------------------------

const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  unsure: "Unsure",
};

export function displayReviewStatus(code: string): string {
  return REVIEW_STATUS_LABELS[code] ?? code;
}

// ---------------------------------------------------------------------------
// Ticket status + priority.
// ---------------------------------------------------------------------------

const TICKET_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_customer: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
  reopened: "Reopened",
};

export function displayTicketStatus(code: string): string {
  return TICKET_STATUS_LABELS[code] ?? code;
}

const TICKET_PRIORITY_LABELS: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function displayTicketPriority(code: string): string {
  return TICKET_PRIORITY_LABELS[code] ?? code;
}

export function displayTicketPriorityTone(code: string): BadgeTone {
  switch (code) {
    case "urgent": return "danger";
    case "high": return "warning";
    case "medium": return "info";
    case "low": return "neutral";
    default: return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Order status.
// ---------------------------------------------------------------------------

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  quoted: "Quoted",
  confirmed: "Confirmed",
  in_progress: "In progress",
  partial_shipped: "Partially shipped",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  partial_cancelled: "Partially cancelled",
  returned: "Returned",
};

export function displayOrderStatus(code: string): string {
  return ORDER_STATUS_LABELS[code] ?? code;
}

export function displayOrderStatusTone(code: string): BadgeTone {
  switch (code) {
    case "delivered":
    case "shipped":
      return "success";
    case "cancelled":
    case "partial_cancelled":
    case "returned":
      return "danger";
    case "confirmed":
    case "in_progress":
    case "partial_shipped":
      return "info";
    case "draft":
    case "quoted":
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Quote status.
// ---------------------------------------------------------------------------

const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  superseded: "Superseded",
  converted: "Converted to order",
};

export function displayQuoteStatus(code: string): string {
  return QUOTE_STATUS_LABELS[code] ?? code;
}

/**
 * 2026-08-05 multi-agent audit V-P1-2: quote status badges were grey while
 * order status badges on the same screen were coloured — a visible split.
 * Now both use semantic tones consistently.
 */
export function displayQuoteStatusTone(code: string): BadgeTone {
  switch (code) {
    case "accepted":
    case "converted":
      return "success";
    case "sent":
      return "info";
    case "expired":
    case "rejected":
    case "superseded":
      return "danger";
    case "draft":
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Enrichment status.
// ---------------------------------------------------------------------------

const ENRICHMENT_STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export function displayEnrichmentStatus(code: string): string {
  return ENRICHMENT_STATUS_LABELS[code] ?? code;
}

// ---------------------------------------------------------------------------
// Reply classification.
// ---------------------------------------------------------------------------

// N-BUG (2026-09-08) — six of the categories the classifier can actually emit
// had no entry here, so displayReplyClassification fell through to `?? code`
// and the Replies inbox showed the raw key. Measured live: three replies read
// "Abusive message", "Opt-out request", "Price question" and the fourth read
// "catalogue_request", in the same list. The full set the product can produce
// is MessageCategory (src/conversations/message-classification.ts) plus the
// engine's validClassifications list (WhatsAppConversationEngine.ts); every
// member of both now has a label, and golden:reply-classification-labels fails
// if a new one is added without one.
const REPLY_CLASSIFICATION_LABELS: Record<string, string> = {
  greeting: "Greeting",
  catalogue_request: "Catalogue request",
  sample_request: "Sample request",
  moq_request: "Minimum order question",
  location_question: "Location question",
  not_interested: "Not interested",
  needs_human_review: "Needs human review",
  other: "Other",
  complaint: "Complaint",
  abusive_message: "Abusive message",
  return_question: "Return request",
  delivery_question: "Delivery question",
  payment_question: "Payment question",
  customization_question: "Customization question",
  export_question: "Export question",
  price_request: "Price question",
  bulk_order_interest: "Bulk order interest",
  hot_lead: "Hot lead",
  product_question: "Product question",
  unknown_question: "Question we can't answer",
  unsubscribe: "Opt-out request",
  wrong_number: "Wrong number",
  general_question: "General question",
  // 2026-09-25 — the reply model names categories freely; these two appeared
  // raw on the Replies screen ("moq_question").
  moq_question: "Minimum order question",
  data_request: "Data request",
};

export function displayReplyClassification(code: string): string {
  // An unknown category still reads as words ("price_list_query" → "Price list
  // query"), never as a code.
  return REPLY_CLASSIFICATION_LABELS[code] ?? displayLabel(code);
}

// ---------------------------------------------------------------------------
// Agent autonomy mode.
// ---------------------------------------------------------------------------

const AGENT_MODE_LABELS: Record<string, string> = {
  draft_only: "Drafts only (no auto-send)",
  safe_auto_reply: "Automatic replies (ticked kinds only)",
  fully_autonomous: "Fully autonomous",
  manual: "Manual",
  automatic: "Automatic",
};

export function displayAgentMode(code: string): string {
  return AGENT_MODE_LABELS[code] ?? code;
}

// 2026-08-05 audit fix (F-UI-23) — lead "fit score" colour band.
// The score is bounded 0-20 (src/llm/task-schemas.ts totalScore max=20;
// the deterministic scoreLead max = 5+5+5+3 = 18). The UI previously used
// >= 70 / >= 40 thresholds (as if the scale were 0-100), so the success and
// warning bands could NEVER trigger — every lead rendered "muted/low" no
// matter how strong. This helper is the single source of truth for the
// band, so all 4 surfaces (CRM drawer, Messages queue, LeadTable, Replies
// header) stay in sync. Bands chosen on the 0-20 scale:
//   >= 14 (70%+)  → high   (success/green)
//   >= 9  (45%+)  → medium (warning/amber)
//   else          → low    (muted)
// Returns the same className string the 4 sites previously inlined, so the
// migration is a drop-in. Pinned by golden:display-labels (CASE added).
const LEAD_SCORE_BAND_CLASS: Record<string, string> = {
  high: "bg-success-bg text-success-fg",
  medium: "bg-warning-bg text-warning-fg",
  low: "bg-surface-muted text-muted-2",
};
export function leadScoreBandClass(score: number): string {
  const band = score >= 14 ? "high" : score >= 9 ? "medium" : "low";
  return LEAD_SCORE_BAND_CLASS[band];
}
/** The denominator shown next to a score (e.g. "Score: 12/20"). */
export const LEAD_SCORE_MAX = 20;

/**
 * 2026-09-25 — lead scoring is AI only. A score is shown only when the AI
 * produced it (see isAiScored); otherwise the lead reads "Not scored yet".
 */
export function leadScoreText(lead: { leadScore?: number; qualificationStatus?: string; scoreReason?: unknown }): string {
  return isAiScored(lead) ? `${lead.leadScore || 0}/${LEAD_SCORE_MAX}` : "Not scored yet";
}

// S6 U-5 (2026-07-27): campaign status + approval status were rendered raw
// (snake_case like "needs_review") on the Campaign screen. These helpers
// replace the raw codes with human labels, matching the locked Label Map (M2).
const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

export function displayCampaignStatus(code: string): string {
  return CAMPAIGN_STATUS_LABELS[code] ?? code;
}

const CAMPAIGN_APPROVAL_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
};

export function displayCampaignApprovalStatus(code: string): string {
  return CAMPAIGN_APPROVAL_LABELS[code] ?? code;
}

// S6 U-6: the Information Needed screen rendered priority raw ("high" not
// "High"). Reuses the same value space as ticket priority.
export { displayTicketPriority as displayPriority };

// ---------------------------------------------------------------------------
// Stage 5 / WP3 (2026-07-28) — Platform ticket (user → operator support).
// Separate from the Stage 2 customer Ticket: this is a workspace user reporting
// a problem to the SaaS operator. Closed list of 6 categories (LOGIC.md).
// ---------------------------------------------------------------------------

const PLATFORM_TICKET_CATEGORY_LABELS: Record<string, string> = {
  bug: "Bug or error",
  account: "Account or login",
  billing: "Billing or plan",
  how_to: "How-to question",
  data_request: "My data request",
  other: "Something else",
};

export function displayPlatformTicketCategory(code: string): string {
  return PLATFORM_TICKET_CATEGORY_LABELS[code] ?? code;
}

const PLATFORM_TICKET_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_user: "Waiting on you",
  resolved: "Resolved",
  closed: "Closed",
  reopened: "Reopened",
};

export function displayPlatformTicketStatus(code: string): string {
  return PLATFORM_TICKET_STATUS_LABELS[code] ?? code;
}

export function displayPlatformTicketStatusTone(code: string): BadgeTone {
  switch (code) {
    case "open": return "info";
    case "in_progress": return "info";
    case "waiting_on_user": return "warning";
    case "resolved": return "success";
    case "closed": return "neutral";
    case "reopened": return "warning";
    default: return "neutral";
  }
}

/** Human labels for the event thread (user-facing; no raw enum dump). */
const PLATFORM_TICKET_EVENT_LABELS: Record<string, string> = {
  created: "Ticket opened",
  commented: "Comment",
  status_changed: "Status changed",
  assigned: "Assigned",
  resolved: "Marked resolved",
  closed: "Closed",
  reopened: "Reopened",
};

export function displayPlatformTicketEvent(code: string): string {
  return PLATFORM_TICKET_EVENT_LABELS[code] ?? code;
}

// ---------------------------------------------------------------------------
// Campaign analytics metrics.
// ---------------------------------------------------------------------------

/**
 * 2026-09-01 (N-UX-10) — the Analytics screen rendered its metric keys with
 * `key.replace(/([A-Z])/g, " $1")`, which printed "mql Count", "won Lost Count"
 * and "total Prospects Discovered" at the operator. That is a database column
 * name wearing a space, not a label.
 *
 * Every label and hint below was written AFTER reading what the number is
 * actually computed from, in `campaignAnalytics()`
 * (src/app/api/[[...path]]/route.ts:5685). That mattered:
 *
 *   - `wonLostCount` counts won AND lost together, so "Won" would have been a
 *     confidently wrong label — worse than the jargon it replaced.
 *   - `campaignConversionRate` is already a percentage (it is `Math.round(x *
 *     100)`), and the screen printed a bare "27". It now prints "27%".
 *   - `bestSource` and `bestChannel` are NOT measurements: the backend returns
 *     fixed sentences ("manual/csv until live integrations are connected").
 *     Calling them "Best source" would present a placeholder as a finding, so
 *     they are labelled as the settings they are.
 *
 * `hint` is the one-line plain-English meaning, for the operator who has never
 * met the term "MQL".
 */
export type MetricLabel = { label: string; hint?: string; suffix?: string };

const CAMPAIGN_METRIC_LABELS: Record<string, MetricLabel> = {
  totalProspectsDiscovered: { label: "Prospects found", hint: "Businesses added to this campaign so far." },
  leadsApproved: { label: "Approved for outreach", hint: "You said yes to contacting these." },
  leadsRejected: { label: "Rejected in review", hint: "You said no — they stay out of outreach." },
  leadsEnriched: { label: "Research completed", hint: "Prospects whose enrichment is marked complete, not proof of valid contact details." },
  messagesGenerated: { label: "Messages drafted", hint: "Written and waiting; drafting does not send anything." },
  messagesMarkedSent: { label: "Messages marked sent", hint: "Recorded as sent, including ones you sent by hand." },
  repliesReceived: { label: "Replies received", hint: "Answers that came back from prospects." },
  interestedReplies: { label: "Showing interest", hint: "Prospects currently marked interested, warm, ready to talk or hot." },
  mqlCount: { label: "Warm leads", hint: "Interested enough to keep warm, not ready to buy." },
  sqlCount: { label: "Ready to talk", hint: "Ready for a real sales conversation." },
  hotLeadCount: { label: "Hot leads", hint: "Close to buying — chase these first." },
  wonLostCount: { label: "Closed (won or lost)", hint: "Deals that finished either way, so they are off the pipeline." },
  campaignConversionRate: {
    label: "Conversion rate",
    suffix: "%",
    hint: "Share of prospects that reached qualified, hot, or won.",
  },
  bestSource: { label: "Lead source", hint: "Where these prospects came from." },
  bestIcp: { label: "Customer type", hint: "The ideal-customer profile this campaign targets." },
  bestChannel: { label: "Outreach channel", hint: "How these prospects are contacted." },
};

/**
 * The metric label for an analytics key.
 *
 * An unknown key falls back to the de-camel-cased form deliberately: a new
 * backend metric should show up looking WRONG so somebody adds it here, rather
 * than being silently hidden from the operator or silently prettified into a
 * label nobody wrote.
 */
export function displayCampaignMetric(key: string): MetricLabel {
  const known = CAMPAIGN_METRIC_LABELS[key];
  if (known) return known;
  return { label: key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) };
}

/** The metric keys this screen knows how to explain, in the order it shows them. */
export const CAMPAIGN_METRIC_ORDER = Object.keys(CAMPAIGN_METRIC_LABELS);

// ---------------------------------------------------------------------------
// Where a lead came from.
// ---------------------------------------------------------------------------

/**
 * 2026-09-01 (N-UX-11) — `Lead.source` was printed raw in three places: the
 * lead drawer's chip row (page.tsx), the Lead Review table, and the Needs-you
 * "Found via" line. The demo workspace stores `demo_seed`, so the operator's
 * screen literally read "demo_seed".
 *
 * NOTE THE DELIBERATE DEVIATION from this file's usual rule. The other display
 * functions return an unknown code AS-IS, so a new backend enum value shows up
 * literally and somebody notices. `source` is not an enum — it is an open
 * `String?` column (prisma/schema.prisma:567) fed by external providers
 * ("serpapi_google_maps"), by CSV import, and by hand. There is no fixed set to
 * keep in sync, so returning unknown values raw guarantees leaks rather than
 * catching them. Unknown sources therefore fall back to the generic humaniser:
 * "serpapi_google_maps" reads as "Serpapi google maps" — not perfect, but a
 * phrase rather than a database value.
 */
const LEAD_SOURCE_LABELS: Record<string, string> = {
  demo_seed: "Demo data",
  manual: "Added by hand",
  manual_csv: "CSV upload",
  csv: "CSV upload",
  csv_upload: "CSV upload",
  serpapi: "Web search",
  serpapi_google_maps: "Google Maps search",
  google_maps: "Google Maps search",
  whatsapp: "WhatsApp",
  website_extraction: "Your website",
  uploaded_document: "Uploaded document",
  signup: "Sign-up form",
  copilot: "Copilot",
  api: "API",
  backend: "Added by the system",
  discovery: "Prospect discovery",
};

export function displayLeadSource(code?: string | null): string {
  if (!code) return "Not recorded";
  return LEAD_SOURCE_LABELS[code] ?? displayLabel(code);
}
