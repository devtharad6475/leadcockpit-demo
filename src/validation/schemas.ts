import { z } from "zod";
import { CHANNELS } from "@/constants/channels";

const channel = z.enum(CHANNELS);
const provider = z.string().min(1);

// 2026-08-05 F-P1-2: was accepting garbage URLs/emails (no format check). A
// fat-fingered website became the canonical company URL silently. Now validates
// format when the field is present (empty/undefined stays OK = "not set").
export const businessProfileUpdateSchema = z.object({
  workspaceId: z.string().optional(),
  companyName: z.string().optional(),
  websiteUrl: z.union([z.literal(""), z.string().url()]).optional(),
  contactEmail: z.union([z.literal(""), z.string().email()]).optional(),
  industry: z.string().optional(),
}).passthrough();

export const campaignCreateSchema = z.object({
  workspaceId: z.string().optional(),
  icpId: z.string().optional(),
  goal: z.string().optional(),
  leadGoal: z.coerce.number().optional(),
  dailyOutreachLimit: z.coerce.number().optional(),
}).passthrough();

export const leadCreateSchema = z.object({
  workspaceId: z.string().optional(),
  campaignId: z.string().optional(),
  icpId: z.string().optional(),
  companyName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  whatsappNumber: z.string().optional(),
}).passthrough();

export const messageGenerationSchema = z.object({
  workspaceId: z.string().optional(),
  leadId: z.string().min(1),
  campaignId: z.string().optional(),
  channel: z.string().optional(),
}).passthrough();

export const outreachMarkSentSchema = z.object({
  workspaceId: z.string().optional(),
  leadId: z.string().min(1),
  messageTemplateId: z.string().optional(),
  channel: z.string().optional(),
}).passthrough();

export const replyCreateSchema = z.object({
  workspaceId: z.string().optional(),
  leadId: z.string().min(1),
  campaignId: z.string().optional(),
  channel: z.string().optional(),
  rawText: z.string().default(""),
}).passthrough();

export const inboundLeadSchema = z.object({
  workspaceId: z.string().min(1),
  provider,
  source: z.string().optional(),
  companyName: z.string().optional(),
  contactName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  whatsappNumber: z.string().optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const inboundReplySchema = z.object({
  workspaceId: z.string().min(1),
  provider,
  leadId: z.string().min(1),
  channel: channel.or(z.string()).default("manual"),
  from: z.string().optional(),
  rawText: z.string().default(""),
  providerMessageId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const modelFetchSchema = z.object({
  workspaceId: z.string().optional(),
  provider: z.string().min(1),
  baseUrl: z.string().url().optional().or(z.literal("")),
  apiKey: z.string().optional(),
  credentialId: z.string().optional(),
}).passthrough();

export const modelSlotSchema = z.object({
  slotId: z.string().min(1),
  provider: z.string().min(1),
  modelName: z.string().min(1),
  fallbackProvider: z.string().optional(),
  fallbackModelName: z.string().optional(),
  apiKey: z.string().optional(),
  fallbackApiKey: z.string().optional(),
  baseUrl: z.string().url().optional().or(z.literal("")),
  fallbackBaseUrl: z.string().url().optional().or(z.literal("")),
}).passthrough();

export const unknownQuestionAnswerSchema = z.object({
  workspaceId: z.string().optional(),
  finalAnswer: z.string().min(1, "Answer is required."),
  addToKnowledge: z.boolean().optional(),
}).passthrough();

export const unknownQuestionGroupAnswerSchema = z.object({
  workspaceId: z.string().optional(),
  questionIds: z.array(z.string().min(1)).min(1, "At least one information item is required."),
  domainKey: z.string().optional(),
  relatedQuestionKeys: z.array(z.string().min(1)).optional(),
  finalAnswer: z.string().min(1, "Answer is required."),
  addToKnowledge: z.boolean().optional(),
}).passthrough();

/** Schema for validating structured LLM output for WhatsApp reply task */
export const WhatsAppLLMReplyOutputSchema = z.object({
  classification: z.enum([
    "greeting", "catalogue_request", "price_request", "sample_request", "moq_request",
    "delivery_question", "payment_question", "return_question", "customization_question",
    "export_question", "complaint", "abusive_message", "unsubscribe", "not_interested",
    "hot_lead", "unknown_question", "other",
  ]),
  riskLevel: z.enum(["low", "medium", "high"]).catch("medium"),
  suggestedReply: z.string().min(1),
  confidenceScore: z.number().min(0).max(1).catch(0.5),
  needsHumanReview: z.boolean().catch(true),
  canAutoSend: z.boolean().catch(false),
  missingKnowledge: z.boolean().catch(true),
  missingQuestion: z.string().default("").catch(""),
  mediaAttachmentId: z.string().optional(),
  // 2026-08-05 (build-right root-fix): real models (DeepSeek, Claude) don't
  // always emit every field in the exact enum. A great reply was being THROWN
  // AWAY + replaced with a generic fallback purely because this field was
  // missing/wrong — a brittle schema rejecting valid output. Now tolerant:
  // default to needs_review (safe — a human still checks). The deterministic
  // classifier's leadStatusSuggestion remains the source of truth; this LLM
  // field is advisory.
  leadStatusSuggestion: z.enum(["mql", "sql", "hot_lead", "do_not_contact", "interested", "not_interested", "needs_review"]).catch("needs_review"),
  reason: z.string().min(1).catch("(no reason provided by model)"),
});

export type WhatsAppLLMReplyOutput = z.infer<typeof WhatsAppLLMReplyOutputSchema>;

/** Schema for the /api/whatsapp-agent/llm-test POST request body */
export const whatsappLlmTestSchema = z.object({
  workspaceId: z.string().optional(),
  leadId: z.string().optional(),
  customerMessage: z.string().min(1, "Customer message is required."),
  forceRealModel: z.boolean().optional(),
}).passthrough();

/* ===========================================================================
 * PUT-route validation schemas (added in audit Session 1).
 *
 * These close the "unvalidated PUT" hole: every PUT route previously passed
 * the raw request body straight into Object.assign at the repository layer,
 * which allowed arbitrary field overwrite and prototype pollution.
 *
 * Design:
 *  - For routes that touch SECURITY-CRITICAL fields (leads, whatsapp-agent
 *    settings, ai settings), we use a STRICT allowlist (no passthrough) so
 *    only known-safe fields can be written.
 *  - For routes that update arbitrary-shaped admin settings (sales/products/
 *    policy/communication, knowledge docs, ICPs, etc.), we use strictShape()
 *    which strips __proto__/constructor/prototype and unknown top-level keys
 *    that look dangerous, but otherwise allows the rich object through. These
 *    routes are admin-only and gated by auth; the prototype strip is the key
 *    protection there.
 * =========================================================================== */

const LEAD_STATUS_VALUES = [
  "prospected", "contacted_cold", "talking", "sample_phase",
  "discovered", "needs_review", "approved", "rejected", "enriching", "enriched",
  "message_ready", "contacted", "replied", "interested", "not_interested",
  "mql", "sql", "hot_lead", "opportunity", "won", "closed_won", "lost", "closed_lost",
  "do_not_contact", "invalid", "duplicate",
] as const;
const LEAD_REVIEW_STATUS_VALUES = ["pending", "approved", "rejected", "unsure"] as const;

/**
 * Lead update schema. Strict: only these fields may be written via PUT.
 *
 * Note on doNotContact / status: these ARE allowed here because the legitimate
 * UI flows (lead review, DNC toggle) need to set them. The protection against
 * abuse comes from AUTH (only authenticated users reach this route in
 * production) plus the dedicated review/reject services that enforce DNC.
 * Prototype keys are stripped upstream by parseBodySafely.
 */
export const leadUpdateSchema = z.object({
  workspaceId: z.string().optional(),
  campaignId: z.string().optional(),
  icpId: z.string().optional(),
  websiteUrl: z.string().optional(),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  buyerType: z.string().optional(),
  industry: z.string().optional(),
  companySizeBucket: z.string().optional(),
  contactName: z.string().optional(),
  companyName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  whatsappNumber: z.string().optional(),
  title: z.string().optional(),
  fitReason: z.string().optional(),
  personalizationNote: z.string().optional(),
  // Cluster 2 fix (2026-07-26 audit, P0-3 / D-2026-07-26-1): the generic
  // lead-update route is COSMETIC-ONLY. status / reviewStatus / doNotContact
  // / consentStatus are deliberately OMITTED — those transitions must go
  // through the dedicated approve / reject / consent / DNC endpoints, which
  // consult the permanent DNC registry and write audit logs. Previously a
  // client could flip doNotContact:false here to silently un-block a
  // customer (no audit, no registry check).
  enrichmentStatus: z.enum(["not_started", "pending", "running", "completed", "failed"]).optional(),
  // 2026-09-28 (review L10): leadScore / fitScore are NOT editable here. Lead
  // scoring is AI-only (LOGIC.md 2026-09-25): a score always carries the AI's
  // reason and label. A hand-typed number arrived with neither, so the lead
  // showed a score nobody could explain. The strict schema now refuses them.
  assignedTo: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
}).strict()
  // 2026-09-26 (break test): `workspaceId` is accepted (clients send it) but
  // never passed on — the edit wrote it into the lead, moving the lead into
  // whatever workspace the request named.
  .transform(({ workspaceId: _workspaceId, ...rest }) => { void _workspaceId; return rest; });

/** WhatsApp agent settings update. Strict allowlist — `mode` is the safety knob.
 *
 * F-UI-8 (depth-audit 2026-07-29): this schema is aligned with the fields the
 * UI (page.tsx) sends AND the service `updateWhatsAppSettings` actually
 * persists. The old schema accepted fields the service ignored (replyTone,
 * autoReplyConfidenceThreshold, language, businessHours, fallbackReply,
 * signatureTemplate, escalationEmail) and — because `.strict()` rejects
 * unknown keys — REJECTED the fields the UI actually sends (enabled,
 * defaultLanguage, escalationContactName/Phone/Email, *Behavior). So every
 * "Save settings" click in the WhatsApp tab 422'd silently. The mode values
 * now match the service's allowlist (draft_only/automatic/safe_auto_reply/
 * human_approval) plus "off" for explicit disable. */
const WHATSAPP_MODE_VALUES = ["off", "draft_only", "safe_auto_reply", "automatic", "human_approval"] as const;
export const whatsappSettingsUpdateSchema = z.object({
  workspaceId: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(WHATSAPP_MODE_VALUES).optional(),
  defaultLanguage: z.string().optional(),
  escalationContactName: z.string().optional(),
  escalationContactPhone: z.string().optional(),
  escalationContactEmail: z.string().optional(),
  unknownAnswerBehavior: z.string().optional(),
  abusiveMessageBehavior: z.string().optional(),
  priceQuestionBehavior: z.string().optional(),
  // CP-22 (2026-08-02) — auto-acknowledge sensitive questions.
  autoAcknowledgeSensitive: z.boolean().optional(),
  acknowledgementTemplate: z.string().optional(),
  // CP-23 (2026-08-02) — message batching (conversation window).
  messageBatchingEnabled: z.boolean().optional(),
  // D-2026-09-27-b — kinds the AI may answer by itself (checked by the service).
  autoReplyTopics: z.array(z.string().max(64)).max(20).optional(),
}).strict();

/** AI settings update. Strict — apiKey is captured but encrypted by the service. */
export const aiSettingsUpdateSchema = z.object({
  workspaceId: z.string().optional(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  enableMockFallback: z.boolean().optional(),
}).strict();

/** Auth/login request schemas. */
// 2026-09-26 (break test): emails are trimmed and lower-cased here, before
// anything uses them. The login rate limit is keyed by this value, so
// "Owner@x.com", "owner@x.com " and "OWNER@X.COM" each got their own 5
// tries — an easy way round the brute-force guard. And a phone keyboard's
// trailing space made sign-up and invite say "A valid email is required."
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Email is required."),
  password: z.string().min(1, "Password is required."),
  workspaceId: z.string().optional(),
});

export const ownerBootstrapSchema = z.object({
  email: z.string().email("A valid email is required."),
  password: z.string().min(8, "Password must be at least 8 characters.").refine((value) => value.trim().length > 0, "A password can't be only spaces."),
  name: z.string().optional(),
  workspaceId: z.string().optional(),
});

// ─── Stage 5 / WP1 (2026-07-28) — signup + invite schemas ───────────────────

/**
 * Public self-serve signup. Gated by the `new_signup_enabled` feature flag at
 * the service layer; the schema only validates the body shape.
 */
export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required."),
  // Stage 5 re-audit F-P3-1 (2026-07-28): bound the password length at the
  // schema so zod rejects oversized bodies BEFORE allocation. hashPassword
  // also caps at 1024, but by then the body is already parsed into memory.
  // Mirrors the redeemPasswordResetSchema pattern (.max(1024)).
  password: z.string().min(8, "Password must be at least 8 characters.").max(1024).refine((value) => value.trim().length > 0, "A password can't be only spaces."),
  name: z.string().min(1, "Name is required.").max(100),
  businessName: z.string().max(200).optional(),
});

// 2026-08-05 (audit F-7, golden:schema-wiring): verifyEmailSchema and
// resendVerificationSchema were removed here. Both were written for a
// BODY-based contract; the real routes are query-param (`auth/verify-email`
// reads `?token=` from the URL, not the body) and no-body-at-all
// (`auth/resend-verification` reads the user from the session). Neither
// route could ever call these schemas correctly — they validated a shape
// nothing sends. Both routes already 400 on a missing token inline; deleting
// the dead schemas is more honest than force-wiring something meaningless
// just to satisfy the wiring check.

/** Operator hand-provision of a pilot workspace + owner. */
export const adminProvisionWorkspaceSchema = z.object({
  ownerEmail: z.string().email("A valid owner email is required."),
  ownerName: z.string().min(1, "Owner name is required.").max(100),
  businessName: z.string().max(200).optional(),
});

/** Create a member invite (authed — owner/admin only). */
export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid invitee email is required."),
  role: z.enum(["admin", "sales_member", "viewer"], {
    message: "Role must be admin, sales_member, or viewer.",
  }),
});

/** Accept an invite (public — the invitee has the token from the email). */
export const acceptInviteSchema = z.object({
  token: z.string().min(10, "Invite token is required."),
  name: z.string().min(1, "Name is required.").max(100),
  // Stage 5 re-audit F-P3-1 (2026-07-28): bound the password length (see signupSchema).
  password: z.string().min(8, "Password must be at least 8 characters.").max(1024).refine((value) => value.trim().length > 0, "A password can't be only spaces."),
});

/**
 * Stage 5 re-audit fix (F-P0-4, 2026-07-28) — Redeem a password-reset token
 * (public — the user clicked the emailed link). The token comes from the
 * email link; the new password is set by the user.
 */
export const redeemPasswordResetSchema = z.object({
  token: z.string().min(10, "Reset token is required."),
  password: z.string().min(8, "Password must be at least 8 characters.").max(1024).refine((value) => value.trim().length > 0, "A password can't be only spaces."),
});

// 2026-09-28 — self-service "Forgot password?" (public) and "Change password"
// (signed in). Same password rules as sign-up and reset.
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter the email you sign in with."),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(1024),
  newPassword: z.string().min(8, "Password must be at least 8 characters.").max(1024).refine((value) => value.trim().length > 0, "A password can't be only spaces."),
});
// 2026-09-28 (S3) — change a team member's role.
export const teamRoleSchema = z.object({
  role: z.enum(["owner", "admin", "sales_member", "viewer"], { message: "Choose Owner, Admin, Sales Member or Viewer." }),
});

/**
 * 2026-07-21 (Cluster C fix, session 19) — Order + Quote line-item schemas.
 * Previously POST /orders and POST /quotes accepted body.lineItems as raw
 * unvalidated arrays, allowing negative quantities/prices (negative totals)
 * or thousands of line items (DoS). These schemas enforce:
 *   - quantity: positive number (> 0)
 *   - unitPrice: non-negative number (≥ 0; 0 allowed for free samples)
 *   - lineItems.length: capped at 200 (matches MAX_BULK elsewhere)
 *
 * NOTE: this is the USER-INPUT shape (a subset of OrderLineItem). The
 * service layer (createOrderDirect) fills in productName, unit, currencyCode,
 * lineTotal etc. from the product catalogue at write time.
 * Pinned by scripts/golden/golden-lineitem-validation.ts.
 */
export const MAX_ORDER_LINE_ITEMS = 200;

export const orderLineItemInputSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  productVariantId: z.string().optional(),
  productName: z.string().optional(),
  // 2026-09-26 (break test): quantity had no ceiling, so 10^15 units
  // overflowed the paise arithmetic and the owner got "something went wrong".
  quantity: z.number().positive("Line item quantity must be greater than 0.").max(1_000_000_000, "Line item quantity is implausibly large (max 1,000,000,000)."),
  unit: z.string().optional(),
  // S6 W-3: cap unitPrice at ₹1,000,000,000 (well above any plausible B2B
  // unit price). Without this, a fat-finger ₹1e15 entry overflowed the
  // integer-paise math and silently corrupted the order total.
  unitPrice: z.number().nonnegative("Line item unit price cannot be negative.").max(1_000_000_000, "Line item unit price is implausibly large (max ₹1,000,000,000)."),
  currencyCode: z.string().optional(),
  // Audit 2026-07-27 S6/D-3: when a client supplies lineTotal it MUST equal
  // quantity × unitPrice (within a 0.01 tolerance for sub-paise rounding).
  // Previously lineTotal was an unconstrained optional, so a client could POST
  // {qty:5, unitPrice:100, lineTotal:-9999} and bypass the money chokepoint,
  // creating an order with an arbitrary (incl. negative) total. Now the schema
  // forces every supplied lineTotal through the chokepoint; omitting lineTotal
  // is still fine (the service computes it).
  lineTotal: z.number().optional(),
  notes: z.string().optional(),
}).refine(
  // Tolerance is HALF A PAISE (0.005), not a full paise: this allows two code
  // paths to round a 3rd-decimal half-paise differently (legit), but rejects
  // any real disagreement (a full paise off or more = the client is supplying
  // a wrong/arbitrary total that bypasses the money chokepoint).
  (li) => li.lineTotal === undefined || Math.abs(li.lineTotal - li.quantity * li.unitPrice) < 0.005,
  { message: "lineTotal must equal quantity × unitPrice. Omit it to let the system compute it." },
).refine(
  // Each factor is capped above, but their product can still pass ₹1,000
  // crore — beyond any real line and past what the paise maths holds exactly.
  (li) => li.quantity * li.unitPrice <= 10_000_000_000,
  { message: "This line comes to more than ₹1,000 crore — check the quantity and price." },
).refine(
  // A line with neither a product nor a name prints as a blank row on the
  // customer's quote (break test, 2026-09-26).
  (li) => Boolean(li.productId?.trim() || li.productName?.trim()),
  { message: "Each line needs a product." },
);

export const orderCreateSchema = z.object({
  leadId: z.string().optional(),
  // Audit 2026-07-27 S6/D-4: require ≥1 line item. Previously only .max(200)
  // was set, so an empty lineItems:[] was valid and produced a ₹0 phantom order.
  lineItems: z.array(orderLineItemInputSchema).min(1, "An order must have at least one line item.").max(MAX_ORDER_LINE_ITEMS, `An order cannot have more than ${MAX_ORDER_LINE_ITEMS} line items.`),
  currencyCode: z.string().optional(),
  notes: z.string().optional(),
  sourceReplyId: z.string().optional(),
  sourceInteractionId: z.string().optional(),
  // Depth-audit F-UI-2 (2026-07-29): operator-chosen initial status from the
  // Commercial create-form. Constrained to draft | confirmed — the other
  // OrderStatus values (shipped/delivered/cancelled/...) are forward
  // transitions that must go through their dedicated endpoints, NOT be set
  // at creation. Before this, zod silently stripped `status`, so the UI's
  // hard-coded "confirmed" was lost and every manual order became "draft".
  status: z.enum(["draft", "confirmed"]).optional(),
});

export const quoteCreateSchema = z.object({
  leadId: z.string().optional(),
  lineItems: z.array(orderLineItemInputSchema).min(1, "A quote must have at least one line item.").max(MAX_ORDER_LINE_ITEMS, `A quote cannot have more than ${MAX_ORDER_LINE_ITEMS} line items.`),
  currencyCode: z.string().optional(),
  notes: z.string().optional(),
  validityNote: z.string().max(4000).optional(),
});

/**
 * For PUT routes that update rich admin-owned objects (settings, ICPs,
 * knowledge docs) we strip dangerous keys but allow the object through. These
 * routes are admin-only and authenticated; the prototype strip is the key
 * defense. Returns the cleaned object or throws.
 */
export function sanitizeStrictShape<T extends Record<string, unknown>>(input: T, alsoDrop: string[] = []): T {
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    // 2026-09-26 (break test): an edit never changes WHICH record it is, whose
    // it is, or when it was made. A request carrying "id" rewrote the record's
    // id in the database; "workspaceId"/"createdAt" were stored as sent.
    if (IDENTITY_KEYS.has(key) || alsoDrop.includes(key)) continue;
    cleaned[key] = input[key];
  }
  return cleaned as T;
}
const IDENTITY_KEYS = new Set(["id", "workspaceId", "createdAt", "updatedAt"]);
/**
 * Fields that only their own action may change (approve / select / the
 * checklist drawer), each of which checks and audits. A plain edit that
 * carries them — the profile's Save sends the whole profile back — keeps the
 * stored value instead of silently approving something.
 */
export const GOVERNED_FIELDS = {
  businessProfile: ["status", "checklistKinds", "checklistExports", "checklistConfirmedAt"],
  campaign: ["approvalStatus"],
  messageTemplate: ["status"],
  icp: ["status"],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 / WP3 (2026-07-28) — Platform ticket + admin auth schemas.
// Rules in docs/LOGIC.md 2026-07-28.
// ─────────────────────────────────────────────────────────────────────────────

/** Closed list of platform-ticket categories (LOGIC.md 2026-07-28). */
export const PLATFORM_TICKET_CATEGORIES = ["bug", "account", "billing", "how_to", "data_request", "other"] as const;
export const PLATFORM_TICKET_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

/** User-side: open a platform ticket (owner/admin only — enforced at the route). */
export const platformTicketCreateSchema = z.object({
  category: z.enum(PLATFORM_TICKET_CATEGORIES),
  priority: z.enum(PLATFORM_TICKET_PRIORITIES).default("medium"),
  subject: z.string().trim().min(3, "Subject must be at least 3 characters").max(200),
  description: z.string().trim().min(10, "Please describe the problem in at least 10 characters").max(10000),
});

/** User-side or operator-side: add a comment to the thread. */
export const platformTicketCommentSchema = z.object({
  note: z.string().trim().min(1, "Comment cannot be empty").max(10000),
});

/**
 * User-side: close/reopen your own ticket (operator-side moves use /admin/*).
 *
 * Stage 5 re-audit F-P2-3 (2026-07-28): restricted to the user-allowed
 * terminal/reopen states. The full 6-value enum let a user self-drive the
 * operator's triage funnel (set their ticket to `in_progress` to look handled,
 * or `waiting_on_user` to push it back). Per docs/LOGIC.md the operator-only
 * triage states (`open`, `in_progress`, `waiting_on_user`) are reserved for
 * the operator-side routes. Pinned by golden:stage5-batch4-chokepoints CASE 7.
 */
export const platformTicketStatusSchema = z.object({
  toStatus: z.enum(["resolved", "closed", "reopened"]),
  note: z.string().trim().max(1000).optional(),
});

/** Operator-side: flag a ticket as spam (requires a reason). */
export const platformTicketFlagSpamSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(500),
});

/** Operator-side: block/unblock a user from support. */
export const platformUserBlockSchema = z.object({
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  isBlockedFromSupport: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/** Operator admin login. */
export const platformAdminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

/** Operator-side: change a ticket's status / assignment. */
export const platformTicketOperatorUpdateSchema = z.object({
  toStatus: z.enum(["open", "in_progress", "waiting_on_user", "resolved", "closed", "reopened"]).optional(),
  assignedAdminId: z.string().nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});

// ─── Stage 5 / WP2 (2026-07-28) — operator admin ops schemas ────────────────

/** Operator-side: suspend a workspace (the kill-switch). Reason is required. */
export const adminSuspendWorkspaceSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(500),
});

/**
 * Operator-side: start an impersonation session. Reason is required.
 *
 * 2026-08-05 (audit F-7, golden:schema-wiring): deliberately UNWIRED. The
 * route it belongs to (`POST /admin/workspaces/:id/impersonate`) is a
 * documented 503 stub (F-P1-4, 2026-07-28) — "the session-marker cookie
 * wiring is a planned follow-up." There is nothing to validate yet because
 * the feature does not run. Kept (not deleted) because it's reviewed,
 * correct, and ready for whoever finishes F-P1-4. Explicitly exempted in
 * golden-schema-wiring.ts's KNOWN_UNWIRED list — remove it from that list
 * the same day this schema gets wired in.
 */
export const adminImpersonateSchema = z.object({
  targetUserId: z.string().min(1),
  targetWorkspaceId: z.string().min(1),
  reason: z.string().trim().min(3, "A reason is required").max(500),
});

/** Operator-side: toggle a global feature flag. Key must be one of the fixed set. */
export const adminFeatureFlagSchema = z.object({
  key: z.enum(["new_signup_enabled", "billing_enabled", "whatsapp_send_enabled", "ai_usage_enabled"]),
  enabled: z.boolean(),
});


// ── Settings saves (2026-09-26 break test) ───────────────────────────────────
// These routes used to hand the whole request to the repository. A request with
// a wrong-shaped product list replaced the owner's products with an empty one,
// and junk keys, a forged record id and a numeric workspaceId were stored as
// sent. Each schema below names the fields a save may change and their types;
// id / workspaceId / createdAt / updatedAt (which the screen sends back) and
// any unknown key are dropped, and a wrong type is refused with a 400.
const text = z.string().max(5000);
const shortText = z.string().max(500);
// Older data stored some lists as one text; accepted, one item per line.
const textList = z.union([z.array(z.string().max(2000)).max(200), z.string().max(5000)])
  .transform((value) => (typeof value === "string" ? value.split(/\n|;/).map((item) => item.trim()).filter(Boolean) : value));

export const salesSettingsSaveSchema = z.object({
  defaultMOQ: text.optional(),
  productWiseMOQ: z.record(z.string().max(200), text).optional(),
  standardCreditPeriod: text.optional(),
  maxCreditPeriod: text.optional(),
  advancePaymentRule: text.optional(),
  sampleAvailability: text.optional(),
  quotationValidity: text.optional(),
  bulkOrderRule: text.optional(),
  leadQualificationThresholds: text.optional(),
  humanReviewTriggers: text.optional(),
  priceDiscussionRule: text.optional(),
  discountNegotiationRules: text.optional(),
});

const productVariantSchema = z.object({ id: z.string().max(200).optional(), name: z.string().max(500).optional() }).passthrough();
export const productSettingSaveSchema = z.object({
  // A product drafted by the AI may not have an id yet; the route gives it one.
  id: z.string().min(1).max(200).optional(),
  name: z.string().max(500),
  category: shortText.optional(),
  variants: z.array(productVariantSchema).max(500).optional(),
  productMode: z.enum(["simple", "variant"]).optional(),
  material: shortText.optional(),
  sizeSpec: shortText.optional(),
  packaging: shortText.optional(),
  customizationAvailable: z.boolean().optional(),
  inStockDispatchTime: shortText.optional(),
  productionDispatchTime: shortText.optional(),
  moq: shortText.optional(),
  useCaseTags: textList.optional(),
  notes: text.optional(),
  price: z.number().finite().min(0).optional(),
  priceUnit: shortText.optional(),
});
export const productSettingsSaveSchema = z.object({
  products: z.array(productSettingSaveSchema).max(1000).optional(),
});

export const policySettingsSaveSchema = z.object({
  paymentPolicy: text.optional(),
  creditPolicy: text.optional(),
  shippingDeliveryPolicy: text.optional(),
  returnReplacementPolicy: text.optional(),
  cancellationPolicy: text.optional(),
  customizationPolicy: text.optional(),
  samplePolicy: text.optional(),
});

export const communicationSettingsSaveSchema = z.object({
  tone: text.optional(),
  defaultFallbackReply: text.optional(),
  allowedAutoReplyTopics: textList.optional(),
  humanReviewRequiredTopics: textList.optional(),
  priceReplyRule: text.optional(),
  creditPaymentReplyRule: text.optional(),
  complaintReplyRule: text.optional(),
  abusiveMessageRule: text.optional(),
  stopUnsubscribeBehavior: text.optional(),
  unknownAnswerBehavior: text.optional(),
});

export const leadReviewSettingsSaveSchema = z.object({
  mode: z.enum(["manual_review", "agent_recommendation", "high_confidence_auto_approval", "full_automation_with_limits"]).optional(),
  autoApproveThreshold: z.number().finite().optional(),
  autoRejectThreshold: z.number().finite().optional(),
  maxAutoApprovedPerDay: z.number().finite().optional(),
  requireHumanForNewCampaigns: z.boolean().optional(),
  requireHumanForNewIndustries: z.boolean().optional(),
  allowAutoEnrichment: z.boolean().optional(),
  allowAutoOutreachPreparation: z.boolean().optional(),
  // Accepted so the screen can send the whole card back; the service forces it false.
  allowAutoSend: z.boolean().optional(),
  auditEveryDecision: z.boolean().optional(),
});

const autonomyMode = z.enum(["manual", "automatic"]);
export const agentAutonomousSettingsSaveSchema = z.object({
  icpGeneratorMode: autonomyMode.optional(),
  campaignPlannerMode: autonomyMode.optional(),
  discoveryMode: autonomyMode.optional(),
  whatsappMode: autonomyMode.optional(),
});

/** null means "not set": dropped before a settings schema checks the types. */
export function withoutNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutNulls(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)])) as T;
  }
  return value;
}

// Editing one Knowledge Base answer (2026-09-26 break test). The route used to
// pass the whole request on, so a caller could set sourceType ("the owner said
// this"), reviewedByUser and reviewedAt to anything — forged provenance — and a
// non-text answer crashed it. Who reviewed it, when, and where it came from
// are decided by the server.
export const knowledgeAnswerEditSchema = z.object({
  answer: z.string().max(8000, "Keep an answer under 8,000 characters.").optional(),
  answerStatus: z.enum(["answered", "unanswered", "partial", "conflict", "needs_review", "not_applicable"]).optional(),
  isUserApproved: z.boolean().optional(),
});
