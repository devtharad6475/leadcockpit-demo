/**
 * Owner Copilot service — the owner-facing assistant chat.
 *
 * Design: docs/planning/OWNER_COPILOT_DESIGN.md (operator-approved 2026-08-01).
 * Decisions: docs/DECISIONS.md D-2026-08-01-d/e.
 *
 * The Copilot is UNIVERSAL (maps to any of the 22 AI tasks) but TIERED for
 * safety. Every intent is routed to one of 5 tiers; only T1 (read-only) fires
 * instantly. T2 drafts (owner approves). T3 confirms cost. T4/T5 never act
 * from a casual chat line. This makes the universal feel SAFE — an eager
 * "send to all leads" is deflected (T5), not executed.
 *
 * MVP scope (this file): the 5-tier router + ALL 22 tasks wired end-to-end
 * (2026-08-01 universal wiring). T1/T2/T3 have real handlers; T4/T5 never
 * execute from a chat line (the universal safety wall). The router + tier map
 * are the chokepoint that makes this safe + uniform.
 *
 * NON-NEGOTIABLE rules inherited from AGENTS.md (do NOT regress):
 *  - No-auto-outreach: the Quote handler produces a DRAFT (status="draft"),
 *    NEVER sends. Sending is a separate explicit approve() call.
 *  - No-hallucination: missing required fields → THROW (ask), never invent.
 *  - Audit trail: every step writes a copilot.* audit row when logAudit=true.
 *  - Per-lead isolation for ACTIONS: a quote is scoped to ONE leadId.
 *
 * Pinned by scripts/golden/golden-copilot-quote.ts (7 cases).
 */
import { uid, timestamp } from "@/lib/db";
import { compareMoney } from "@/lib/money";
import { setupQuestionWording } from "@/services/SetupInterviewService";
import type { OrderLineItem, Quote, ProductSetting, OwnerCopilotMessage, Lead } from "@/lib/types";
import type { LLMTaskName } from "@/llm/types";
import type { RepositoryBundle } from "@/repositories";
import { createRepositories } from "@/repositories";
import {
  computeLineTotal,
  computeGrandTotal,
  finalizeLineItems,
  quoteStatusPatch,
} from "@/services/OrderService";
import { NeedsActionError } from "@/lib/user-errors";
import { AuditLogService } from "@/services/AuditLogService";
import { getRelevantContext } from "@/services/KnowledgeBaseService";
import { LLMService } from "@/llm/LLMService";
import { numbersNotGrounded } from "@/services/AutoReplyDecisionService";

// ─── Operator-locked clarification bounds (Q2, D-2026-08-01-e) ──────────────
/** Max questions asked in one batch. Operator chose 4 (tightened from 5). */
export const MAX_QUESTIONS_PER_BATCH = 4;
/** Max batches of questions before "review manually". Operator chose 3. */
export const MAX_CLARIFY_BATCHES = 3;

// ─── Tier map ───────────────────────────────────────────────────────────────
export type CopilotTier = "T1" | "T2" | "T3" | "T4" | "T5";

export type CopilotIntent = {
  tier: CopilotTier;
  /** A human label for the UI / audit log, e.g. "draft_quote". */
  intent: string;
  /** Which of the 22 AI tasks this maps to (for the agent runtime), if any. */
  taskName?: string;
};

// ─── Universal task→tier map (CP-1: EVERY one of the 22 tasks has a tier) ────
/**
 * The authoritative map of all 22 AI tasks to their Copilot tier. This is the
 * single source of truth for "which tier does task X belong to" — the keyword
 * router (TIER_KEYWORDS) feeds INTO this; anything reachable from chat must
 * resolve through this map. No task is left ambiguous (CP-1 universal coverage,
 * pinned by golden-copilot-tasks CASE A).
 *
 * Tier rationale (matches docs/planning/OWNER_COPILOT_DESIGN.md §5):
 *  - T1 (read-only, instant): scoring, classification, knowledge/policy lookups.
 *  - T2 (draft → owner approves): content that does NOT touch the customer.
 *  - T3 (confirm cost → RUN per CP-10): heavy multi-step AI jobs.
 *  - T4 (hard gate, never from a casual line): spends money / reaches customer.
 *  - T5 (never from chat): bulk / irreversible / destructive.
 */
export const ALL_TASK_TIER_MAP: Record<LLMTaskName, CopilotTier> = {
  // T1 — read-only Q&A. Zero danger.
  reply_classification: "T1",
  lead_scoring: "T1",
  knowledge_answer: "T1",
  policy_answer: "T1",
  quality_review: "T1",
  // T2 — draft it, I'll approve. No customer contact.
  whatsapp_reply: "T2",
  message_generation: "T2",
  lead_enrichment: "T2",
  manual_answer_mapping: "T2",
  document_extraction_mapping: "T2",
  business_extraction: "T2",
  // T3 — big job, confirm cost/time first (CP-10: runs after confirm).
  icp_generation: "T3",
  campaign_planning: "T3",
  campaign_learning: "T3",
  product_application_research: "T3",
  market_research: "T3",
  lead_review_decision: "T3",
  embedding: "T3",
  // T4 — touches a customer / spends. Hard per-action gate, never from chat line.
  prospect_research: "T4",
  web_search: "T4",
  image_generation: "T4",
  creative_generation: "T4",
};

/**
 * Keyword → tier map. This is the PURE LOOKUP the router uses — NO AI decides
 * routing (a deterministic table means routing never errs; build-right Phase 3d
 * chokepoint). Keyword matching is deliberately conservative: an ambiguous
 * phrase defaults UP to a safer tier, never down. Bulk/delete/erasure are T5.
 *
 * The map is intentionally keyword-based (not LLM-based) for the router
 * because routing is a SAFETY decision, not a wording decision. An LLM that
 * "helpfully" reroutes "send to all" from T5 to T2 would be a P0 safety bug.
 */
const TIER_KEYWORDS: Array<{ tier: CopilotTier; intent: string; taskName?: string; keywords: string[] }> = [
  // T5 — NEVER from chat (bulk send / delete / erasure / suspend). Checked FIRST.
  {
    tier: "T5",
    intent: "bulk_outreach_blocked",
    keywords: ["to all", "to every", "all leads", "all warm", "all customers", "bulk send", "broadcast", "price list to all", "सभी ग्राहकों को भेज", "सब ग्राहकों को भेज", "सभी लीड को भेज", "sab customers ko bhej", "sabhi customers ko bhej", "sab leads ko bhej"],
  },
  { tier: "T5", intent: "delete_blocked", keywords: ["delete", "remove permanently", "wipe", "erase", "erase all", "wipe all", "destroy", "लीड मिटा", "ग्राहक मिटा", "डेटा मिटा", "लीड हटा", "ग्राहक हटा"] },
  { tier: "T5", intent: "erasure_blocked", taskName: undefined, keywords: ["gdpr", "erasure", "right to be forgotten"] },
  { tier: "T5", intent: "suspend_blocked", keywords: ["suspend the workspace", "deactivate the workspace"] },

  // T4 — touches a customer / spends (actual SEND, image-gen, paid search).
  // These require a HARD per-action approval gate; never fire from a chat line.
  {
    tier: "T4",
    intent: "send_to_customer",
    keywords: ["send the quote", "send the message", "send it to", "send now", "send this", "whatsapp him", "whatsapp her", "email him", "email her", "actually send"],
  },
  { tier: "T4", intent: "image_generation", taskName: "image_generation", keywords: ["generate an image", "make an image", "create an image", "product photo"] },
  { tier: "T4", intent: "creative_generation", taskName: "creative_generation", keywords: ["write me a creative", "ad copy", "marketing creative", "social post copy"] },
  { tier: "T4", intent: "prospect_research", taskName: "prospect_research", keywords: ["find me new leads", "find new prospects", "search for leads", "discover leads", "find customers for me"] },
  { tier: "T4", intent: "paid_search", taskName: "web_search", keywords: ["run a paid search", "buy search credits", "search the web for"] },

  // T3 — big job, confirm cost/time first (heavy AI, costs money + minutes).
  // N8 (2026-09-23) — a request with several parts goes to the MASTER agent,
  // which splits it between subordinates. Deliberately narrow phrases: T3 is
  // checked before T2, so a loose word like "and" or "draft" here would steal
  // ordinary "draft a reply" requests. A misroute costs one planning call and
  // a plan the owner simply does not confirm.
  {
    tier: "T3",
    intent: "orchestrated_job",
    taskName: "campaign_planning",
    keywords: ["check who we", "for the rest", "then draft", "plan and do", "big job", "master agent", "orchestrate", "split this up", "split this job"],
  },
  {
    tier: "T3",
    intent: "icp_generation",
    taskName: "icp_generation",
    keywords: ["build my customer profile", "ideal customer", "icp", "who is my customer", "customer profile"],
  },
  {
    tier: "T3",
    intent: "campaign_planning",
    taskName: "campaign_planning",
    keywords: ["plan a campaign", "campaign for", "outreach campaign", "marketing campaign"],
  },
  {
    tier: "T3",
    intent: "campaign_learning",
    taskName: "campaign_learning",
    keywords: ["what's working", "what is working", "campaign learning", "learn from the campaign", "how are my campaigns doing"],
  },
  {
    tier: "T3",
    intent: "market_research",
    taskName: "market_research",
    keywords: ["market research", "research the market", "research a market", "research surat", "research mumbai"],
  },
  {
    tier: "T3",
    intent: "research",
    taskName: "product_application_research",
    keywords: ["research", "product application", "deep research", "find out about", "what can my product be used for", "uses for my product"],
  },
  {
    tier: "T3",
    intent: "lead_review_decision",
    taskName: "lead_review_decision",
    keywords: ["decide which leads", "approve leads for me", "review my pending leads", "batch approve", "which leads should i approve"],
  },

  // T2 — draft it, I'll approve (no customer contact). High-frequency + safe.
  {
    tier: "T2",
    intent: "draft_reply",
    taskName: "whatsapp_reply",
    keywords: ["draft a reply", "reply to", "respond to", "answer", "what should i say", "draft a response"],
  },
  {
    tier: "T2",
    intent: "draft_quote",
    taskName: "message_generation",
    keywords: ["make a quote", "draft a quote", "quote for", "quotation", "prepare a quote", "give him a quote", "give her a quote", "pricing for"],
  },
  {
    tier: "T2",
    intent: "draft_first_message",
    taskName: "message_generation",
    keywords: ["draft the first message", "first message", "intro message", "introduction"],
  },
  { tier: "T2", intent: "enrich_lead", taskName: "lead_enrichment", keywords: ["enrich", "fill in", "find their", "look up the lead"] },
  { tier: "T2", intent: "map_manual_answer", taskName: "manual_answer_mapping", keywords: ["map my answer", "i answered this", "record my answer to this question"] },
  { tier: "T2", intent: "extract_document", taskName: "document_extraction_mapping", keywords: ["read this document", "extract this", "read this pdf", "read this into the knowledge base", "ingest this document"] },
  { tier: "T2", intent: "business_extraction", taskName: "business_extraction", keywords: ["extract business info", "pull business details", "extract from this site", "extract from the website"] },

  // T1 — just tell me (read-only Q&A). Zero danger. Default fallback tier.
  {
    tier: "T1",
    intent: "lead_scoring",
    taskName: "lead_scoring",
    keywords: ["score this lead", "score the lead", "how good is this lead", "rate this lead", "qualify this lead"],
  },
  {
    tier: "T1",
    intent: "classify_reply",
    taskName: "reply_classification",
    keywords: ["classify this reply", "what did they mean", "classify the reply", "what is this reply about"],
  },
  {
    tier: "T1",
    intent: "quality_review",
    taskName: "quality_review",
    keywords: ["is this draft ok", "review this draft", "check this message", "is this message good", "quality review"],
  },
  {
    tier: "T1",
    intent: "policy_answer",
    taskName: "policy_answer",
    keywords: ["return policy", "refund policy", "shipping policy", "delivery policy", "warranty"],
  },
  {
    tier: "T1",
    intent: "demand_analysis",
    taskName: "reply_classification",
    keywords: ["what are people asking for", "what products are people asking", "demand report", "what is the demand", "what are customers asking", "main confusion", "what are the main confusions", "is there demand", "voice of customer", "what do customers want", "trending products", "what should i stock"],
  },
  {
    tier: "T1",
    intent: "knowledge_answer",
    taskName: "knowledge_answer",
    keywords: ["what is our", "what's our", "do we have", "our moq", "our policy", "moq", "minimum order", "what is the", "what's the", "how much is"],
  },
];

/**
 * Classify an owner's free-text intent into a tier. PURE — no I/O, no AI.
 *
 * Safety rule (test CASE B): T5 keywords are checked FIRST and a match locks
 * T5 regardless of any later T1/T2 keyword in the same phrase. This is why
 * "send our price list to all warm leads" → T5 (it has "to all"), NOT T4
 * (even though it also has "send").
 */
export function classifyCopilotIntent(ownerText: string): CopilotIntent {
  const text = ownerText.toLowerCase();

  // T5 FIRST — the dangerous-intent guard. Once matched, never downgraded.
  const blockedIntentOrder = ["erasure_blocked", "delete_blocked", "bulk_outreach_blocked"];
  for (const rule of [...TIER_KEYWORDS].sort((a, b) => blockedIntentOrder.indexOf(a.intent) - blockedIntentOrder.indexOf(b.intent))) {
    if (rule.tier !== "T5") continue;
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return { tier: "T5", intent: rule.intent };
    }
  }
  // Then T4, T3, T2, T1 in order (more-dangerous tiers win over less).
  // 2026-08-07 real-AI proof-pass fix: "T1" was missing from this list, so
  // every T1 keyword rule (lead_scoring, classify_reply, quality_review,
  // policy_answer, demand_analysis) was unreachable dead code — "score this
  // lead", "what are people asking for", etc. always fell through to the
  // generic knowledge_answer default below, no matter what the owner typed.
  // The underlying handlers were fine; the router just never reached them.
  for (const checkTier of ["T4", "T3", "T2", "T1"] as CopilotTier[]) {
    // The owner's setup starter is not customer-lead enrichment. Keep this
    // narrow exception below every dangerous/cost-confirmed route.
    if (checkTier === "T2" && ["fill in my business details", "continue setting up my business details", "set up my business details", "continue setup", "start business setup"].some(phrase => text.includes(phrase))) {
      return { tier: "T1", intent: "setup_question" };
    }
    for (const rule of TIER_KEYWORDS) {
      if (rule.tier !== checkTier) continue;
      if (rule.keywords.some((kw) => text.includes(kw))) {
        return { tier: rule.tier, intent: rule.intent, taskName: rule.taskName };
      }
    }
  }
  // Default: read-only Q&A. Safer to treat an unknown ask as "just tell me"
  // (T1) than to guess it's an action. T1 never mutates, so this is safe.
  return { tier: "T1", intent: "general_question", taskName: "knowledge_answer" };
}

// ─── Quote action (T2) ──────────────────────────────────────────────────────
export type QuoteCaptureInput = {
  workspaceId: string;
  leadId: string;
  /** The product name snapshot (free text or matched from ProductSettings). */
  productName: string;
  /** Optional ProductSettings id, used to detect "below standard price". */
  productId?: string;
  quantity: number;
  /** "kg", "metre", "piece", etc. */
  unit: string;
  /** Price per unit. */
  unitPrice: number;
  currencyCode: string;
  /** Optional owner-stated validity (e.g. "7 days"). */
  validityNote?: string;
};

export type QuoteDraftResult = Quote & {
  /** True when the unitPrice is below the matched product's standard price —
   * the handler OFFERS to save the new fact, never saves silently. */
  offerSaveToKnowledge: boolean;
  /** The human suggestion shown to the owner ("save this permanently?"). */
  saveFactSuggestion: string;
};

/**
 * Draft a Quote from owner-captured call notes. PURE MATH — no LLM.
 *
 * Never-guess (CASE C): if quantity/unit/unitPrice/currencyCode/productName
 * are missing or invalid, this THROWS rather than inventing values. The caller
 * (the clarify loop) is expected to ask the owner for the missing fields first.
 *
 * Never-auto-send (CASE D): the returned Quote has status="draft" and NO
 * sentAt. Sending is a separate approveQuoteForSend() call.
 *
 * Audit (CASE F): when opts.logAudit, writes a copilot.quote_drafted row.
 *
 * Ask-before-save (CASE G): when a productId matches a ProductSettings entry
 * whose price is HIGHER than unitPrice, sets offerSaveToKnowledge=true + a
 * suggestion. Never silently saves.
 */
export async function draftQuoteFromCapture(
  input: QuoteCaptureInput,
  repos: RepositoryBundle = createRepositories(),
  opts: { actorUserId?: string; logAudit?: boolean } = {},
): Promise<QuoteDraftResult> {
  // ── Never-guess: validate every required field ──────────────────────────
  const missing: string[] = [];
  if (!input.productName || !input.productName.trim()) missing.push("productName");
  if (input.quantity === undefined || input.quantity === null || !(input.quantity > 0)) missing.push("quantity");
  if (!input.unit || !input.unit.trim()) missing.push("unit");
  if (input.unitPrice === undefined || input.unitPrice === null || !(input.unitPrice >= 0)) missing.push("unitPrice");
  if (!input.currencyCode || !input.currencyCode.trim()) missing.push("currencyCode");
  if (missing.length > 0) {
    throw new Error(`Cannot draft quote — missing required field(s): ${missing.join(", ")}. Ask the owner before drafting (never-guess).`);
  }

  // ── Build the line item + compute the math (reuses proven OrderService) ─
  const lineItem: OrderLineItem = {
    id: uid("li"),
    productId: input.productId,
    productName: input.productName,
    quantity: input.quantity,
    unit: input.unit,
    unitPrice: input.unitPrice,
    currencyCode: input.currencyCode,
    lineTotal: computeLineTotal(input.quantity, input.unitPrice),
  };
  const items = finalizeLineItems([lineItem]);
  const grandTotal = computeGrandTotal(items);
  const now = timestamp();

  // F-ALLOC-2 (2026-08-05 CONTINUOUS-3 audit): this path used the non-atomic
  // nextQuoteNumber + create pair (two awaits, read-max then write). Two
  // concurrent owner quote drafts could read the same max quoteNumber and
  // both persist → duplicate quote numbers. The atomic
  // createWithNextQuoteNumber (read+increment+write in one transaction) exists
  // precisely to prevent this (pinned by golden:number-allocation-race for
  // the route path). Mirror the route's defensive pattern: prefer the atomic
  // method when available, fall back to the pair otherwise.
  const quoteDraft: Omit<Quote, "id" | "quoteNumber"> & { id?: string; quoteNumber?: number } = {
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    status: "draft", // Never-auto-send: always draft. Sending is approveQuoteForSend().
    lineItems: items,
    grandTotal,
    currencyCode: input.currencyCode,
    validityNote: input.validityNote,
    createdAt: now,
    updatedAt: now,
  };

  // ── Ask-before-save: detect a below-standard price ──────────────────────
  let offerSaveToKnowledge = false;
  let saveFactSuggestion = "";
  if (input.productId) {
    const productSettings = await repos.productSettings.getByWorkspace(input.workspaceId);
    const matched: ProductSetting | undefined = productSettings?.products?.find((p: ProductSetting) => p.id === input.productId);
    // F12 (2026-08-04 CONTINUOUS-2 audit): use integer-paise compareMoney
    // instead of raw float <. LOGIC.md: "Every commercial calculation routes
    // through src/lib/money.ts." This site was missed by the P2-MONEY-1 sweep
    // that fixed OrderService.computeDiscountFlag.
    if (matched && matched.price !== undefined && compareMoney(input.unitPrice, matched.price) < 0) {
      offerSaveToKnowledge = true;
      saveFactSuggestion = `The rate ₹${input.unitPrice}/${input.unit} is below your standard ₹${matched.price}/${input.unit} for "${matched.name}". Save this lower rate permanently?`;
    }
  }

  // ── Persist the draft (atomic number allocation when available) ─────────
  const quoteRepo = repos.quote as unknown as {
    createWithNextQuoteNumber?: (input: typeof quoteDraft) => Promise<Quote>;
    nextQuoteNumber: (ws: string) => Promise<number>;
    create: (input: typeof quoteDraft & { id: string; quoteNumber: number }) => Promise<Quote>;
  };
  let quote: Quote;
  if (typeof quoteRepo.createWithNextQuoteNumber === "function") {
    quote = await quoteRepo.createWithNextQuoteNumber(quoteDraft);
  } else {
    const quoteNumber = await quoteRepo.nextQuoteNumber(input.workspaceId);
    quote = await quoteRepo.create({ ...quoteDraft, id: uid("quote"), quoteNumber });
  }

  // ── Audit trail ─────────────────────────────────────────────────────────
  if (opts.logAudit && opts.actorUserId) {
    await new AuditLogService(repos).logAuditEvent({
      workspaceId: input.workspaceId,
      userId: opts.actorUserId,
      action: "copilot.quote_drafted",
      entityType: "quote",
      entityId: quote.id,
      newValuesJson: {
        leadId: input.leadId,
        productName: input.productName,
        quantity: input.quantity,
        unit: input.unit,
        unitPrice: input.unitPrice,
        grandTotal,
        currencyCode: input.currencyCode,
        status: "draft",
        offerSaveToKnowledge,
      },
    });
  }

  return { ...quote, offerSaveToKnowledge, saveFactSuggestion };
}

// ─── Approve (T4 gate) — the only path that could send. Stays no-send in MVP ─
/**
 * Owner approves a drafted quote. In the MVP this marks the quote "approved"
 * (still NO auto-send to the customer — sending requires the existing
 * owner-approved WhatsApp/email send flow, which is a separate, dedicated
 * screen per the no-auto-outreach rule). This function is the hook where a
 * future "send the approved quote" action plugs in, behind its own gate.
 *
 * 2026-09-27 (sector review M1): this wrote status "sent" with no checks. An
 * already-converted quote went back to "sent" and could be converted a second
 * time (two orders from one quote); rejected, expired and replaced quotes came
 * back to life; an unpriced line was not caught; sentAt was never stamped. It
 * now goes through OrderService.quoteStatusPatch — the same guarded
 * transition POST /quotes/:id/status uses — and refuses in plain words.
 */
export async function approveQuoteDraft(
  workspaceId: string,
  quoteId: string,
  repos: RepositoryBundle = createRepositories(),
  opts: { actorUserId?: string; logAudit?: boolean } = {},
): Promise<Quote> {
  const quote = await repos.quote.getById(workspaceId, quoteId);
  if (!quote) throw new NeedsActionError("That quote was not found — it may have been removed. Refresh and try again.", 404);
  const patch = quoteStatusPatch(quote, "sent", timestamp());
  const updated = await repos.quote.update(workspaceId, quoteId, patch, quote.status);
  if (opts.logAudit && opts.actorUserId) {
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: opts.actorUserId,
      action: "copilot.quote_approved",
      entityType: "quote",
      entityId: quoteId,
      oldValuesJson: { status: quote.status },
      newValuesJson: { status: updated.status, ...(patch.sentAt ? { sentAt: patch.sentAt } : {}) },
      metadataJson: { note: "Owner approved the Copilot-drafted quote. No customer send occurred from this action." },
    });
  }
  return updated;
}

// ─── Language detection (operator Q4: BOTH English + Hindi) ─────────────────
/**
 * Detect whether the owner typed English or Hindi (Devanagari script). Pure.
 * Returns "hi" if the text contains Devanagari codepoints, else "en". The
 * Copilot responds in the SAME language the owner used (operator Q4).
 */
export function detectLanguage(text: string): "en" | "hi" {
  // Devanagari Unicode block: U+0900–U+097F. Covers Hindi, Marathi, Nepali etc.
  return /[\u0900-\u097F]/.test(text) ? "hi" : "en";
}

// ─── Tier responses (bilingual — operator Q4) ───────────────────────────────
const TIERS_WITH_DANGER: CopilotTier[] = ["T4", "T5"];

// 2026-09-26 (break test) — these messages printed the internal intent code
// to the owner: `That action ("bulk_outreach_blocked") can't be done…`. Each
// now says in plain words what the job is and where it is done instead.
const PLAIN_JOB: Record<string, { en: string; hi: string; where?: string }> = {
  bulk_outreach_blocked: { en: "Sending messages to many customers at once", hi: "एक साथ कई ग्राहकों को संदेश भेजना", where: "Prospecting → Campaign, where you approve every message" },
  delete_blocked: { en: "Deleting records", hi: "रिकॉर्ड डिलीट करना", where: "the record's own screen" },
  erasure_blocked: { en: "Erasing a customer's personal data", hi: "ग्राहक का निजी डेटा मिटाना", where: "Workspace & admin → Compliance" },
  suspend_blocked: { en: "Suspending the workspace", hi: "वर्कस्पेस बंद करना", where: "Workspace & admin → Workspace" },
  send_to_customer: { en: "Sending a message to a customer", hi: "ग्राहक को संदेश भेजना", where: "Conversations → Replies, after you approve the draft" },
  icp_generation: { en: "Working out your ideal customers", hi: "आपके आदर्श ग्राहक तय करना" },
  campaign_planning: { en: "Planning a campaign", hi: "कैंपेन की योजना बनाना" },
  campaign_learning: { en: "Reviewing how a campaign went", hi: "कैंपेन के नतीजे देखना" },
  lead_review_decision: { en: "Reviewing leads", hi: "लीड्स की समीक्षा" },
  orchestrated_job: { en: "This job", hi: "यह काम" },
  market_research: { en: "Market research", hi: "मार्केट रिसर्च" },
  research: { en: "Research", hi: "रिसर्च" },
};
function plainJob(intent: string, lang: "en" | "hi"): string {
  const job = PLAIN_JOB[intent];
  if (job) return lang === "hi" ? job.hi : job.en;
  return lang === "hi" ? "यह काम" : "That";
}

function tierDeflectText(intent: string, lang: "en" | "hi"): string {
  const where = PLAIN_JOB[intent]?.where;
  if (lang === "hi") {
    return `${plainJob(intent, lang)} चैट से नहीं होता — सुरक्षा के लिए यह अपनी अलग स्क्रीन से ही होता है${where ? ` (${where})` : ""}।`;
  }
  return `${plainJob(intent, lang)} can't be done from chat — for safety it only happens on its own screen${where ? `: ${where}` : ""}. Nothing was changed.`;
}

function tierConfirmText(intent: string, lang: "en" | "hi"): string {
  if (lang === "hi") {
    return `${plainJob(intent, lang)} एक बड़ा काम है। इसमें कुछ समय और AI खर्च लगेगा। जारी रखें?`;
  }
  return `${plainJob(intent, lang)} is a bigger job. It will take a little time and use some AI credit. Go ahead?`;
}

// ─── The orchestrator (what the API route calls) ────────────────────────────
export type CopilotResponse = {
  /** The assistant's visible reply text. */
  text: string;
  language: "en" | "hi";
  tier: CopilotTier;
  intent: string;
  kind: OwnerCopilotMessage["kind"];
  /** When the response is a draft / confirm / offer awaiting approval, this carries the handle. */
  pendingAction?: OwnerCopilotMessage["pendingAction"];
  /**
   * Honest AI status (CP-1 §10): "real" | "mock" | "fallback" | "kb" | "none".
   * The owner must never mistake a mock draft for a real one. "kb" = answered
   * from the Knowledge Base (no LLM). "none" = no AI used (pure logic).
   */
  aiStatus?: "real" | "mock" | "fallback" | "kb" | "none";
};

/** Every entity type a Copilot pending action can point at. */
export type PendingEntityType = NonNullable<NonNullable<OwnerCopilotMessage["pendingAction"]>["entityType"]>;

/**
 * Handle one owner turn. This is the controller the API route calls. It:
 *   1. classifies the owner's intent into a tier (pure lookup — no AI routing),
 *   2. applies the tier rule (T1 answer / T2 draft / T3 confirm / T4-5 deflect),
 *   3. persists the owner message + the copilot response (audit trail),
 *   4. NEVER sends anything to a customer (no-auto-outreach).
 *
 * Every one of the 22 tasks routes through here. T1/T2/T3 have REAL handlers;
 * T4/T5 never execute from a chat line (the universal safety wall, CP-1).
 * Pinned by golden-copilot-tasks (8 cases) + golden-copilot-quote (7 cases).
 */
export async function handleOwnerCopilotTurn(input: {
  workspaceId: string;
  ownerUserId: string;
  conversationId: string;
  ownerText: string;
  /** For Quote (T2): the structured fields, if the owner already provided them. */
  quoteCapture?: QuoteCaptureInput;
  /** The active lead in context (CP-6: T2+ actions are per-lead-isolated). */
  leadId?: string;
  repos?: RepositoryBundle;
  /** Test seam (N8): the master agent's planner, so a golden can drive a real turn without spending. */
  orchestrationSeams?: import("@/services/OrchestrationService").OrchestrationSeams;
  /**
   * The conversation brain (2026-09-25). Omitted = the real model; `false` =
   * keyword routing only (goldens that pin the keyword table); a function =
   * a test seam.
   */
  conversationBrain?: import("@/services/OwnerConversationBrain").BrainCall | false;
}): Promise<CopilotResponse> {
  const repos = input.repos || createRepositories();
  const lang = detectLanguage(input.ownerText);
  // SAFETY-FIRST routing (audit follow-up 2026-08-04, D-2026-08-04-a). The
  // previous short-circuit (`if (quoteCapture) classified = {T2,draft_quote}`)
  // ran BEFORE the T5 guard, so a T5 phrase ("send price list to all leads")
  // + quoteCapture bypassed the deflect and produced a draft. Now we ALWAYS
  // classify first, and the T5 (and T4) guards below fire on the real text no
  // matter what structured fields are attached. `quoteCapture` may only
  // PROMOTE a non-dangerous intent to draft_quote (CASE H pins this).
  const textClassified = classifyCopilotIntent(input.ownerText);
  const isDangerous = textClassified.tier === "T5" || textClassified.tier === "T4";
  const classified = input.quoteCapture && !isDangerous
    ? { tier: "T2" as CopilotTier, intent: "draft_quote", taskName: "message_generation" as LLMTaskName | undefined }
    : textClassified;

  // Persist the owner's message.
  await repos.ownerCopilotMessage.create({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    role: "owner",
    kind: "owner_input",
    text: input.ownerText,
    language: lang,
    tier: classified.tier,
  });
  // Moves this conversation to the top of the owner's chat list.
  await repos.ownerCopilotConversation.update(input.workspaceId, input.conversationId, {}).catch(() => undefined);

  // ── Tier responses ──────────────────────────────────────────────────────
  // T5 — deflect (bulk/delete/erasure). NEVER executes from chat.
  if (classified.tier === "T5") {
    const text = tierDeflectText(classified.intent, lang);
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_deflect");
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_deflect", aiStatus: "none" };
  }

  // T4 — touches a customer / spends. Hard gate: never fire from a chat line.
  // Finding F2 (2026-08-04): the old copy said "I'll draft it first" but the
  // T4 branch produces NO draft — that promised something it didn't do. Now the
  // copy honestly says "I won't send from chat — use the dedicated screen."
  if (classified.tier === "T4") {
    const text = lang === "hi"
      ? `इस काम में ग्राहक को संदेश भेजना या पैसे खर्च होना शामिल है। मैं चैट से यह नहीं भेजूँगा — कृपया समर्पित स्क्रीन (Commercial / Replies) से खुद भेजें। यहाँ से कुछ भी अपने आप नहीं भेजा जाएगा।`
      : `This action contacts a customer or spends money. I won't send it from chat — open the Commercial or Replies screen to send it yourself. (Nothing sends automatically from here.)`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_confirm");
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_confirm", aiStatus: "none" };
  }

  // 2026-09-25 — the conversation. Past the T5/T4 guards on the owner's own
  // words, a model that has read the conversation picks what to do and
  // rewrites the request in full. The tier of what it picks still comes from
  // this file's table. If no real model answers, keyword routing below runs.
  if (!input.quoteCapture && input.conversationBrain !== false) {
    const routed = await routeWithConversationBrain(repos, input, lang);
    if (routed) return routed;
  }

  // No real brain answered: the existing explicit setup action still works
  // from the actual checklist, rather than asking which customer to enrich.
  if (classified.intent === "setup_question") {
    const { setupProgress } = await import("@/services/SetupInterviewService");
    const { getKnowledgeQuestion } = await import("@/knowledge/knowledge-question-framework");
    const messages = await repos.ownerCopilotMessage.listByConversation(input.workspaceId, input.conversationId);
    const last = [...messages].reverse().find(message => message.role === "copilot");
    if (last?.pendingAction?.entityType === "knowledge_answer_confirm") {
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, last.text, lang, classified, "copilot_question", last.pendingAction);
      return { text: last.text, language: lang, tier: "T1", intent: "setup_question", kind: "copilot_question", pendingAction: last.pendingAction, aiStatus: "none" };
    }
    const progress = await setupProgress(input.workspaceId, repos);
    const existingMarker = last?.pendingAction?.entityType === "knowledge_question" ? String(last.pendingAction.entityId || "") : undefined;
    const marker = existingMarker && progress.open.has(existingMarker) ? existingMarker
      : progress.next ? `${progress.next.domainKey}/${progress.next.questionKey}` : undefined;
    const text = marker ? `${lang === "hi" ? "व्यवसाय की जानकारी भरते हैं। अगला सवाल" : "Let's fill in your business details. Next question"}: ${questionTextOf(getKnowledgeQuestion, marker)}`
      : lang === "hi" ? "व्यवसाय की सारी जानकारी भर गई।" : "That's every question on your checklist answered.";
    const pendingAction = marker ? askAction(marker) : undefined;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_question", pendingAction);
    return { text, language: lang, tier: "T1", intent: "setup_question", kind: "copilot_question", pendingAction, aiStatus: "none" };
  }

  // T3 — big job (ICP/campaign/research/lead-review/learning). Confirm cost first.
  // CP-10: after the owner confirms, the job RUNS via confirmCopilotBigJob().
  if (classified.tier === "T3" && classified.intent === "orchestrated_job") {
    return await proposeOrchestratedJob(repos, input, lang, classified);
  }
  if (classified.tier === "T3") {
    const pendingId = uid("cp_t3");
    const costNote = t3CostNote(classified.intent, lang);
    const text = `${tierConfirmText(classified.intent, lang)}\n${costNote}`;
    const pendingAction = { intent: classified.intent, entityId: pendingId, entityType: t3EntityType(classified.intent), request: input.ownerText };
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_confirm", pendingAction);
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_confirm", pendingAction, aiStatus: "none" };
  }

  // T2 — draft it (no customer contact). Quote is the proven path; the others
  // (draft_reply, draft_first_message, enrich, extract) now have real handlers.
  if (classified.tier === "T2") {
    return await handleT2Action(repos, input, lang, classified);
  }

  // T1 — read-only Q&A. Real handler: knowledge/policy answers + scoring +
  // classification + quality review. Never mutates; offers a capture card when
  // the KB has no answer (CP-11).
  return await handleT1Action(repos, input, lang, classified);
}

// ─── The conversation brain (2026-09-25) ─────────────────────────────────────
/** Tier of an intent, from this file's table — never from the model. */
function tierOfIntent(intent: string): CopilotIntent {
  const rule = TIER_KEYWORDS.find((item) => item.intent === intent);
  if (rule) return { tier: rule.tier, intent: rule.intent, taskName: rule.taskName };
  return { tier: "T1", intent: "knowledge_answer", taskName: "knowledge_answer" };
}

/** "Ask this setup question" — marks it pending on the assistant's message. */
function askAction(marker: string): OwnerCopilotMessage["pendingAction"] {
  return { intent: "setup_question", entityId: marker, entityType: "knowledge_question" };
}

function questionTextOf(lookup: (domainKey: string, questionKey: string) => { question: string } | undefined, marker: string): string {
  const [domainKey, questionKey] = marker.split("/");
  return setupQuestionWording(domainKey, questionKey, lookup(domainKey, questionKey)?.question || marker);
}

/**
 * Save an answer from the conversation under one checklist question, with the
 * owner's words as its evidence, and say exactly what was saved where.
 */
async function saveSetupAnswer(repos: RepositoryBundle, workspaceId: string, marker: string, answer: string, ownerWords: string, lang: "en" | "hi", expectedAnswer?: string): Promise<string> {
  const { recordSetupAnswer } = await import("@/services/SetupInterviewService");
  const { getKnowledgeQuestion } = await import("@/knowledge/knowledge-question-framework");
  const [domainKey, questionKey] = marker.split("/");
  const result = await recordSetupAnswer({ workspaceId, domainKey, questionKey, answer, ownerWords, expectedAnswer, repos });
  const question = questionTextOf(getKnowledgeQuestion, marker);
  if (!result.saved) {
    return lang === "hi" ? `"${question}" के लिए जवाब सेव नहीं हो सका।` : `I couldn't save that under "${question}" — nothing was changed.`;
  }
  let text = lang === "hi" ? `"${question}" के जवाब में सेव किया: "${answer}"` : `Saved under "${question}": "${answer}"`;
  if (result.contradicts && result.previous) {
    text = `${lang === "hi" ? "ध्यान दें: पहले यह लिखा था" : "Note: this replaces what was there before, which said something different"} — "${result.previous.slice(0, 200)}".\n\n${text}`;
  }
  return text;
}

/**
 * The owner's yes or no to "save it under that question instead?". A yes
 * saves the proposal the SERVER stored with that message (never text sent by
 * the screen); either way the question that was asked is asked again.
 */
async function settleAnswerProposal(
  repos: RepositoryBundle,
  workspaceId: string,
  conversationId: string,
  waiting: NonNullable<OwnerCopilotMessage["pendingAction"]>,
  save: boolean,
  lang: "en" | "hi",
): Promise<CopilotResponse> {
  const { getKnowledgeQuestion } = await import("@/knowledge/knowledge-question-framework");
  const proposal = waiting.proposal!;
  if (save && proposal.revision) {
    const { listKnowledgeQuestionAnswers } = await import('@/services/DocumentQuestionAnsweringService');
    const current = (await listKnowledgeQuestionAnswers(workspaceId, repos)).find(answer => `${answer.domainKey}/${answer.questionKey}` === waiting.entityId);
    if (current?.answer !== proposal.previousAnswer) {
      const text = lang === 'hi' ? 'यह जवाब उसके बाद बदल गया है। पुराना सुझाव सेव नहीं किया। नया सुझाव माँगें।' : 'That answer has changed since this suggestion. I have not overwritten it. Please ask for a fresh revision.';
      const pendingAction = proposal.askedMarker ? askAction(proposal.askedMarker) : undefined;
      await persistCopilotMessage(repos, workspaceId, conversationId, text, lang, { tier: 'T1', intent: 'conversation' }, 'copilot_question', pendingAction);
      return { text, language: lang, tier: 'T1', intent: 'conversation', kind: 'copilot_question', pendingAction, aiStatus: 'none' };
    }
  }
  const first = save
    ? await saveSetupAnswer(repos, workspaceId, String(waiting.entityId), proposal.answer, proposal.ownerWords, lang, proposal.revision ? proposal.previousAnswer : undefined)
    : lang === "hi" ? "ठीक है, सेव नहीं किया।" : "OK — I haven't saved it.";
  const askedAgain = proposal.askedMarker;
  const text = askedAgain
    ? `${first}\n\n${lang === "hi" ? "मेरे सवाल पर वापस" : "Back to my question"}: ${questionTextOf(getKnowledgeQuestion, askedAgain)}`
    : first;
  const pendingAction = askedAgain ? askAction(askedAgain) : undefined;
  await persistCopilotMessage(repos, workspaceId, conversationId, text, lang, { tier: "T1", intent: "conversation" }, "copilot_question", pendingAction);
  return { text, language: lang, tier: "T1", intent: save ? "confirm_yes" : "confirm_no", kind: "copilot_question", pendingAction, aiStatus: "none" };
}

/**
 * The "Save it there" / "Don't save" buttons. Acts only when the message is
 * the conversation's latest and still carries its proposal — a second click,
 * or a click on an old message, changes nothing.
 */
export async function resolveSetupAnswerProposal(input: {
  repos: RepositoryBundle; workspaceId: string; ownerUserId: string; conversationId: string; messageId?: string; save: boolean;
}): Promise<{ ok: true; response: CopilotResponse } | { ok: false; error: string }> {
  const { repos, workspaceId, conversationId } = input;
  const conversation = await repos.ownerCopilotConversation.getById(workspaceId, conversationId);
  if (!conversation || conversation.ownerUserId !== input.ownerUserId) return { ok: false, error: "Conversation not found." };
  const messages = await repos.ownerCopilotMessage.listByConversation(workspaceId, conversationId);
  const last = messages[messages.length - 1];
  if (!last || (input.messageId && last.id !== input.messageId) || last.pendingAction?.entityType !== "knowledge_answer_confirm" || !last.pendingAction.proposal) {
    return { ok: false, error: "That question has already been answered." };
  }
  const lang = last.language === "hi" ? "hi" : "en";
  await repos.ownerCopilotMessage.create({ workspaceId, conversationId, role: "owner", kind: "owner_input", text: input.save ? (lang === "hi" ? "हाँ, वहाँ सेव करें" : "Yes, save it there") : (lang === "hi" ? "नहीं" : "No, don't save it"), language: lang });
  return { ok: true, response: await settleAnswerProposal(repos, workspaceId, conversationId, last.pendingAction, input.save, lang) };
}

async function routeWithConversationBrain(
  repos: RepositoryBundle,
  input: Parameters<typeof handleOwnerCopilotTurn>[0],
  lang: "en" | "hi",
): Promise<CopilotResponse | null> {
  const { decideTurn, realBrain } = await import("@/services/OwnerConversationBrain");
  const { setupProgress, setupCandidates, safeAnswerWording } = await import("@/services/SetupInterviewService");
  const { isAnswerEditingRequest, revisionPreview } = await import("@/services/setup-answer-revision");
  const { listKnowledgeQuestionAnswers } = await import("@/services/DocumentQuestionAnsweringService");
  const { getKnowledgeQuestion } = await import("@/knowledge/knowledge-question-framework");

  // The owner's message was persisted just before this; the history is what
  // came before it.
  const all = await repos.ownerCopilotMessage.listByConversation(input.workspaceId, input.conversationId);
  const history = all.slice(0, -1);
  const lastAssistant = [...history].reverse().find((message) => message.role === "copilot");
  // The question the assistant is waiting on. While it waits for a yes/no on
  // "save it under that question instead?", the question it asked is still
  // the pending one (kept in the proposal).
  const waiting = lastAssistant?.pendingAction?.entityType === "knowledge_answer_confirm" && lastAssistant.pendingAction.proposal ? lastAssistant.pendingAction : undefined;
  const pendingMarker = waiting ? waiting.proposal!.askedMarker
    : lastAssistant?.pendingAction?.entityType === "knowledge_question" ? lastAssistant.pendingAction.entityId : undefined;
  const pendingQuestion = pendingMarker ? questionTextOf(getKnowledgeQuestion, pendingMarker) : undefined;
  const asked = new Set(history.filter((message) => message.pendingAction?.entityType === "knowledge_question" && message.pendingAction.entityId).map((message) => String(message.pendingAction!.entityId)));

  let progress: Awaited<ReturnType<typeof setupProgress>> | undefined;
  try { progress = await setupProgress(input.workspaceId, repos, asked); } catch { progress = undefined; }
  // In setup, every checklist question is a place an answer could go; the
  // model names one by ref, the code maps it back. Outside setup, none.
  const candidates = pendingMarker ? await setupCandidates(input.workspaceId, repos, pendingMarker, asked).catch(() => []) : [];
  const refs = new Map(candidates.map((candidate, index) => [`q${index + 1}`, candidate]));
  const storedAnswers = await listKnowledgeQuestionAnswers(input.workspaceId, repos);
  const savedSources = storedAnswers.filter(answer => answer.isUserApproved && answer.answer?.trim()).map(answer => {
    const marker = `${answer.domainKey}/${answer.questionKey}`;
    const lastSave = [...history].reverse().find(message => message.role === 'copilot' &&
      (message.pendingAction?.savedAnswer?.marker === marker || message.text.includes(`Saved under "${questionTextOf(getKnowledgeQuestion, marker)}": "${answer.answer}"`) || message.text.includes(`"${questionTextOf(getKnowledgeQuestion, marker)}" के जवाब में सेव किया: "${answer.answer}"`)));
    const saved = lastSave?.pendingAction?.savedAnswer;
    return { marker, answer: answer.answer!, ownerWords: (saved && saved.answer === answer.answer ? saved.ownerWords : undefined) ?? answer.sourceSnippet ?? answer.answer!,
      question: questionTextOf(getKnowledgeQuestion, marker), position: lastSave ? history.indexOf(lastSave) : -1 };
  }).filter(source => source.position >= 0).sort((a, b) => b.position - a.position || a.marker.localeCompare(b.marker)).slice(0, 14);
  const savedRefs = new Map(savedSources.map((source, index) => [`s${index + 1}`, source]));
  const profile = await repos.businessProfile.getByWorkspace(input.workspaceId).catch(() => undefined);
  const lead = input.leadId ? await repos.lead.getLeadById(input.workspaceId, input.leadId).catch(() => undefined) : undefined;

  const call = typeof input.conversationBrain === "function" ? input.conversationBrain : realBrain(input.workspaceId, repos);
  const { decision } = await decideTurn({
    history: history.map((message) => ({ role: message.role, text: message.text })),
    ownerText: input.ownerText,
    businessName: profile?.companyName,
    activeLeadName: lead?.companyName,
    activeLeadDetails: lead ? leadDetailsForBrain(lead) : undefined,
    pendingSetupQuestion: pendingQuestion,
    openSetupQuestions: [...refs].map(([ref, candidate]) => ({ ref, question: candidate.question, answered: candidate.answered })),
    recentSavedAnswers: [...savedRefs].map(([ref, source]) => ({ ref, question: source.question, answer: source.answer, ownerWords: source.ownerWords })),
    awaitingConfirmation: waiting ? { question: questionTextOf(getKnowledgeQuestion, String(waiting.entityId)), answer: waiting.proposal!.answer } : undefined,
    nextSetupQuestion: progress?.next?.question,
    setupProgress: progress ? `${progress.missing} of ${progress.total} business details still missing` : undefined,
  }, call);
  if (!decision) {
    if (!isAnswerEditingRequest(input.ownerText)) return null;
    const text = lang === 'hi' ? 'आप पिछले जवाब के शब्द सुधारना चाहते हैं। अभी असली AI उपलब्ध नहीं है, इसलिए मैं उसे विश्वसनीय ढंग से दोबारा नहीं लिख सका। आपका जवाब नहीं बदला। AI settings में मॉडल जाँचें या Knowledge Base में जवाब संपादित करें।' :
      'You want to improve an earlier answer. A working AI model is unavailable right now, so I could not rephrase it reliably. Your answer is unchanged. Check the model in AI settings, or edit the answer in Knowledge Base.';
    const pendingAction = waiting || (pendingMarker ? askAction(pendingMarker) : undefined);
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: 'T1', intent: 'conversation' }, 'copilot_info', pendingAction);
    return { text, language: lang, tier: 'T1', intent: 'conversation', kind: 'copilot_info', pendingAction, aiStatus: 'fallback' };
  }

  // The rewritten request passes the same guard as the owner's own words: a
  // model must not be able to turn "send it to all of them" into a draft.
  const requestClass = classifyCopilotIntent(decision.request);
  if (requestClass.tier === "T5" || requestClass.tier === "T4") {
    const text = requestClass.tier === "T5" ? tierDeflectText(requestClass.intent, lang)
      : lang === "hi" ? "इसमें ग्राहक से संपर्क या पैसे खर्च होना शामिल है। मैं यह चैट से नहीं करूँगा।"
      : "That would contact a customer or spend money, so I won't do it from chat. Open the Replies or Commercial screen to do it yourself.";
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, requestClass, requestClass.tier === "T5" ? "copilot_deflect" : "copilot_confirm");
    return { text, language: lang, tier: requestClass.tier, intent: requestClass.intent, kind: requestClass.tier === "T5" ? "copilot_deflect" : "copilot_confirm", aiStatus: "none" };
  }

  const talk: CopilotIntent = { tier: "T1", intent: "conversation" };
  const keepPending = waiting || (pendingMarker ? askAction(pendingMarker) : undefined);

  // An editing instruction must never fall through to the answer-save path,
  // even when the model repeats the screenshot's incorrect classification.
  if (decision.intent === 'rewrite_answer' || (!['reply', 'ask', 'confirm_no'].includes(decision.intent) && isAnswerEditingRequest(input.ownerText))) {
    const source = decision.intent === 'rewrite_answer' ? savedRefs.get(decision.answers) : undefined;
    const clean = source ? revisionPreview(decision.answerText, source.answer, input.ownerText) : undefined;
    if (!source || !clean) {
      const text = lang === 'hi' ? 'मैं आपके पिछले जवाब को सुधारने की बात समझ रहा हूँ। मैंने कुछ सेव नहीं किया। किस जवाब को सुधारना है, और उसका अर्थ वही रखना है?' :
        'You want to improve an earlier answer, not answer the next question. Nothing was saved. Which answer should I rephrase? You can quote the line; I will keep its meaning.';
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, talk, 'copilot_question', keepPending);
      return { text, language: lang, tier: 'T1', intent: 'conversation', kind: 'copilot_question', pendingAction: keepPending, aiStatus: 'real' };
    }
    const pendingAction: OwnerCopilotMessage['pendingAction'] = { intent: 'confirm_setup_answer', entityId: source.marker, entityType: 'knowledge_answer_confirm',
      proposal: { answer: clean, ownerWords: source.ownerWords, askedMarker: pendingMarker, revision: true, previousAnswer: source.answer } };
    const text = lang === 'hi' ? `पिछले जवाब के लिए बेहतर शब्द:\n\n"${source.question}"\n\nपहले: "${source.answer}"\n\nनया: "${clean}"\n\nअर्थ वही है तो Save revised answer दबाएँ। अभी सेव नहीं किया और अगला सवाल आगे नहीं बढ़ाया।` :
      `Let's improve the earlier answer first.\n\nFor: "${source.question}"\n\nCurrently saved: "${source.answer}"\n\nSuggested wording: "${clean}"\n\nPlease check that the meaning is unchanged, then save the revised answer. Nothing has changed yet; the next question can wait.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, talk, 'copilot_question', pendingAction);
    return { text, language: lang, tier: 'T1', intent: 'confirm_setup_answer', kind: 'copilot_question', pendingAction, aiStatus: 'real' };
  }

  // The owner's yes/no to a waiting "save it under that question instead?".
  if (decision.intent === "confirm_yes" || decision.intent === "confirm_no") {
    if (!waiting) {
      const text = lang === "hi" ? "अभी कुछ भी पुष्टि के लिए नहीं रुका है।" : "There's nothing waiting for a yes or no right now.";
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, talk, "copilot_info", keepPending);
      return { text, language: lang, tier: "T1", intent: "conversation", kind: "copilot_info", pendingAction: keepPending, aiStatus: "real" };
    }
    return await settleAnswerProposal(repos, input.workspaceId, input.conversationId, waiting, decision.intent === "confirm_yes", lang);
  }

  if (decision.intent === "reply" || decision.intent === "ask") {
    const kind = decision.intent === "ask" ? "copilot_question" : "copilot_info";
    // A reply or follow-up during setup keeps the pending question pending
    // (a browser test on 2026-09-26 lost it when the owner added a side fact).
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, decision.reply, lang, talk, kind, keepPending);
    return { text: decision.reply, language: lang, tier: "T1", intent: "conversation", kind, pendingAction: keepPending, aiStatus: "real" };
  }

  // An answer is filed only under a question the model names by ref from the
  // list it was given. No valid ref: nothing is saved, and the owner is told.
  const target = decision.intent === "record_answer" ? refs.get(decision.answers) : undefined;
  if (decision.intent === "record_answer" && !target) {
    const text = pendingQuestion
      ? (lang === "hi" ? `मैंने इसे सेव नहीं किया — यह इस सवाल का जवाब नहीं लगता: "${pendingQuestion}". इसका जवाब दें, या "skip" कहें।`
        : `I haven't saved that — it doesn't look like an answer to "${pendingQuestion}". Could you answer that, or say skip?`)
      : (lang === "hi" ? "मैंने इसे सेव नहीं किया — मैंने आपसे कोई सवाल नहीं पूछा था। व्यवसाय की जानकारी भरने के लिए Continue setup दबाएँ।"
        : "I haven't saved that as a business detail — I hadn't asked you a question. Press Continue setup to fill in your business details together.");
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, talk, "copilot_question", keepPending);
    return { text, language: lang, tier: "T1", intent: "conversation", kind: "copilot_question", pendingAction: keepPending, aiStatus: "real" };
  }

  // The answer in clean wording — unless the rewrite brought in a number the
  // owner never said, in which case their own words are saved.
  const wording = safeAnswerWording(decision.answerText, input.ownerText);

  // It answers a DIFFERENT question from the one asked: say so, show the
  // wording, and save only on the owner's yes (CEO, 2026-09-26: "will it ask
  // me as a follow-up … I have understood that you are answering this
  // particular question").
  if (target && target.marker !== pendingMarker) {
    const pendingAction: OwnerCopilotMessage["pendingAction"] = {
      intent: "confirm_setup_answer", entityId: target.marker, entityType: "knowledge_answer_confirm",
      proposal: { answer: wording.answer, ownerWords: input.ownerText, askedMarker: pendingMarker },
    };
    const text = lang === "hi"
      ? `यह "${target.question}" का जवाब लगता है, मेरे सवाल ("${pendingQuestion}") का नहीं।${target.answered ? " उसका जवाब पहले से है — यह उसे बदल देगा।" : ""} क्या इसे वहाँ ऐसे सेव करूँ: "${wording.answer}"?`
      : `That sounds like the answer to "${target.question}", not the question I asked ("${pendingQuestion}").${target.answered ? " That question already has an answer — this would replace it." : ""} Shall I save it there as: "${wording.answer}"?`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, talk, "copilot_question", pendingAction);
    return { text, language: lang, tier: "T1", intent: "confirm_setup_answer", kind: "copilot_question", pendingAction, aiStatus: "real" };
  }

  if (decision.intent === "setup_question" || decision.intent === "record_answer" || decision.intent === "skip_question") {
    let text = decision.reply;
    if (decision.intent === "record_answer" && target) {
      text = `${await saveSetupAnswer(repos, input.workspaceId, target.marker, wording.answer, input.ownerText, lang)}\n\n${text}`;
    }
    // After an answer to the pending question, or a skip, ask the next one.
    const next = decision.intent === "setup_question" && pendingMarker ? pendingMarker
      : progress?.next ? `${progress.next.domainKey}/${progress.next.questionKey}` : undefined;
    const pendingAction = next ? askAction(next) : undefined;
    if (pendingAction && decision.intent === 'record_answer' && target && (text.includes('Saved under "') || text.includes('के जवाब में सेव किया:'))) {
      pendingAction.savedAnswer = { marker: target.marker, answer: wording.answer, ownerWords: input.ownerText };
    }
    // The model gave no follow-up words: ask the next question plainly, so the
    // owner is never left without the question that is now pending.
    if (!decision.reply.trim() && (next || progress?.missing === 0)) {
      const nextLine = next ? `${lang === "hi" ? "अगला सवाल" : "Next"}: ${questionTextOf(getKnowledgeQuestion, next)}` : (lang === "hi" ? "व्यवसाय की सारी जानकारी भर गई।" : "That's every question on your checklist answered.");
      text = `${text.trim()}

${nextLine}`.trim();
    }
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, talk, "copilot_question", pendingAction);
    return { text, language: lang, tier: "T1", intent: decision.intent, kind: "copilot_question", pendingAction, aiStatus: "real" };
  }

  // A tool. Its tier comes from the table; the handler gets the full request.
  const classified = tierOfIntent(decision.intent);
  // Defence in depth: the allowed list already excludes these, but a tier the
  // chat must never act on is refused here too, whatever the list says.
  if (classified.tier === "T4" || classified.tier === "T5") return null;
  const routedInput = { ...input, ownerText: decision.request };
  if (classified.tier === "T3" && classified.intent === "orchestrated_job") return await proposeOrchestratedJob(repos, routedInput, lang, classified);
  if (classified.tier === "T3") {
    const pendingId = uid("cp_t3");
    const text = `${tierConfirmText(classified.intent, lang)}\n${t3CostNote(classified.intent, lang)}`.trim();
    const pendingAction = { intent: classified.intent, entityId: pendingId, entityType: t3EntityType(classified.intent), request: routedInput.ownerText };
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_confirm", pendingAction);
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_confirm", pendingAction, aiStatus: "none" };
  }
  if (classified.tier === "T2") return await handleT2Action(repos, routedInput, lang, classified);
  return await handleT1Action(repos, routedInput, lang, classified);
}

/** The CRM's record of one customer, in plain lines, for the conversation. */
function leadDetailsForBrain(lead: Lead): string {
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);
  const lines: Array<[string, unknown]> = [
    ["Contact person", lead.contactName && `${lead.contactName}${lead.contactRole ? ` (${lead.contactRole})` : ""}`],
    ["Place", [lead.city, lead.state, lead.country].filter(Boolean).join(", ")],
    ["Kind of buyer", lead.buyerType || lead.industry],
    ["Stage", lead.status],
    ["Lead score (out of 20)", lead.leadScore || undefined],
    ["Why they fit", lead.fitReason],
    ["What they have told us", lead.conversationMemory],
    ["Last contacted by us", day(lead.lastContactedAt)],
    ["Last message from them", day(lead.lastInboundAt)],
    ["Next follow-up", day(lead.nextFollowUpAt)],
    ["Do not contact", lead.doNotContact ? "YES — never message them" : undefined],
    // Whether contact details exist, not the details themselves: the model
    // does not need the number to say "we can reach them on WhatsApp".
    ["WhatsApp or phone on file", lead.whatsappNumber || lead.phone ? "yes" : "no"],
    ["Email on file", lead.email ? "yes" : "no"],
  ];
  return lines.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([label, value]) => `- ${label}: ${String(value).slice(0, 400)}`).join("\n") || "- Nothing beyond the name is recorded.";
}

// ─── T3 helpers ──────────────────────────────────────────────────────────────
/** The entity type a T3 confirm pending action points at (for the UI button). */
function t3EntityType(intent: string): PendingEntityType {
  if (intent === "icp_generation") return "icp";
  if (intent === "campaign_planning") return "campaign";
  return "icp"; // research/lead-review/learning all report back in chat (no persisted entity the owner clicks)
}

/** An honest note about what a T3 job will do (CP-10: destructive jobs say so). */
function t3CostNote(intent: string, lang: "en" | "hi"): string {
  const notes: Record<string, { en: string; hi: string }> = {
    icp_generation: {
      en: "(Note: this replaces any existing customer profiles.)",
      hi: "(ध्यान: यह मौजूदा ग्राहक प्रोफाइल को बदल देगा।)",
    },
    campaign_planning: {
      en: "(This drafts a campaign plan for your review.)",
      hi: "(यह आपकी समीक्षा के लिए एक कैंपेन योजना तैयार करेगा।)",
    },
    lead_review_decision: {
      en: "(This reviews your pending leads and suggests which to approve.)",
      hi: "(यह आपकी लंबित लीड्स की समीक्षा करेगा और सुझाव देगा।)",
    },
  };
  const note = notes[intent];
  if (!note) return "";
  return lang === "hi" ? note.hi : note.en;
}

// ─── T2 handlers (draft → owner approves; never sends) ───────────────────────
async function handleT2Action(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; ownerText: string; leadId?: string; quoteCapture?: QuoteCaptureInput },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  // Quote — the proven path (golden-copilot-quote 7 cases).
  if (classified.intent === "draft_quote") {
    if (!input.quoteCapture) {
      // CP-4 (clarify-bounded): load the conversation's batch counter + enforce
      // the cap. The owner locked "max 3 batches, then review manually" (Q2).
      // Without this, an incomplete quote loops forever re-asking the same 4
      // fields (audit finding C, 2026-08-04). The counter persists on the
      // conversation row so it survives refresh.
      const convo = await repos.ownerCopilotConversation.getById(input.workspaceId, input.conversationId);
      const batchesSoFar = convo?.clarifyBatchCount ?? 0;
      if (batchesSoFar >= MAX_CLARIFY_BATCHES) {
        // Bound hit — stop asking, hand off to manual review (CP-4).
        const text = lang === "hi"
          ? `मैं पर्याप्त आश्वस्त नहीं हूँ कि कोटेशन बनाऊँ — ${MAX_CLARIFY_BATCHES} बार पूछ चुका हूँ। कृपया कमर्शियल स्क्रीन से मैन्युअल रूप से कोटेशन बनाएँ, या ऊपर फ़ील्ड भरें।`
          : `I'm not sure enough to draft this quote — I've asked ${MAX_CLARIFY_BATCHES} times. Please create the quote manually from the Commercial screen, or fill in the fields above.`;
        await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
        return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
      }
      // Under the cap → ask the clarifying questions + increment the counter.
      await repos.ownerCopilotConversation.update(input.workspaceId, input.conversationId, { clarifyBatchCount: batchesSoFar + 1 });
      const text = lang === "hi"
        ? `कोटेशन बनाने के लिए मुझे यह चाहिए:\n1. प्रोडक्ट का नाम\n2. मात्रा (quantity)\n3. यूनिट (metre/kg/piece)\n4. रेट (₹/unit)\n(करेंसी डिफ़ॉल्ट INR है।)`
        : `To draft the quote, I need:\n1. Product name\n2. Quantity\n3. Unit (metre/kg/piece)\n4. Rate (₹/unit)\n(Currency defaults to INR.)`;
      // Attach a pendingAction so the UI can render the inline quote-fields
      // form deterministically (Finding B) instead of text-matching the prompt.
      const quotePending = { intent: "draft_quote", entityType: "quote" as const };
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_question", quotePending);
      return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_question", pendingAction: quotePending, aiStatus: "none" };
    }
    // Structured fields provided. CP-6 (audit follow-up 2026-08-04): VALIDATE
    // the leadId before drafting — a quote must attach to a real lead in THIS
    // workspace, never an arbitrary / non-existent id supplied in the request
    // body (the route passes quoteCapture.leadId through from the body). Without
    // this check the quote is orphaned to a fake leadId. Pinned by CASE I.
    const leadId = input.quoteCapture.leadId || input.leadId || "";
    if (!leadId) {
      const text = lang === "hi"
        ? `कोटेशन के लिए कोई लीड चुनी नहीं गई। पहले कोई लीड खोलें, फिर फिर से कोशिश करें।`
        : `No lead is selected for this quote. Open a lead first, then try again.`;
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
      return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
    }
    const existingLead = await repos.lead.getLeadById(input.workspaceId, leadId);
    if (!existingLead) {
      const text = lang === "hi"
        ? `इस लीड से कोटेशन नहीं बना सकता — यह लीड आपके वर्कस्पेस में नहीं मिली। कृपया किसी मौजूदा लीड का उपयोग करें।`
        : `I can't draft a quote for that lead — it doesn't exist in your workspace. Please use an existing lead.`;
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
      return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
    }
    // The loop closes → reset the clarify counter so a future quote starts
    // fresh (CP-4 hygiene). No silent catch (Phase 4): a reset failure is
    // surfaced so a stuck counter can't hide (best-effort, but loud).
    try {
      await repos.ownerCopilotConversation.update(input.workspaceId, input.conversationId, { clarifyBatchCount: 0 });
    } catch (e) {
      console.warn("[OwnerCopilot] failed to reset clarifyBatchCount:", e instanceof Error ? e.message : e);
    }
    const draft = await draftQuoteFromCapture({ ...input.quoteCapture, leadId }, repos, { actorUserId: input.ownerUserId, logAudit: true });
    const text = lang === "hi"
      ? `कोटेशन तैयार है:\n• ${draft.lineItems[0].quantity} ${draft.lineItems[0].unit} "${draft.lineItems[0].productName}" @ ₹${draft.lineItems[0].unitPrice} = ₹${draft.grandTotal}\nस्थिति: ड्राफ़्ट (अभी ग्राहक को नहीं भेजा गया)।${draft.offerSaveToKnowledge ? `\n\n${draft.saveFactSuggestion}` : ""}`
      : `Here's the drafted quote:\n• ${draft.lineItems[0].quantity} ${draft.lineItems[0].unit} of "${draft.lineItems[0].productName}" @ ₹${draft.lineItems[0].unitPrice} = ₹${draft.grandTotal}\nStatus: DRAFT (not yet sent to the customer).${draft.offerSaveToKnowledge ? `\n\n${draft.saveFactSuggestion}` : ""}`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_draft", { intent: classified.intent, entityId: draft.id, entityType: "quote" });
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_draft", pendingAction: { intent: classified.intent, entityId: draft.id, entityType: "quote" }, aiStatus: "none" };
  }

  // Draft reply / draft first message — per-lead-isolated (CP-6).
  if (classified.intent === "draft_reply" || classified.intent === "draft_first_message") {
    if (!input.leadId) {
      // CP-6: never draft against a guessed lead.
      const text = lang === "hi"
        ? `रिप्लाई ड्राफ़्ट करने के लिए, पहले बताइए किस लीड के लिए? (ऊपर से कोई लीड चुनें या नाम बताएँ।)`
        : `To draft a reply, which lead is this for? (Pick a lead above, or tell me the name.)`;
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_question");
      return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_question", aiStatus: "none" };
    }
    return await draftReplyOrMessage(repos, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, conversationId: input.conversationId, leadId: input.leadId, ownerText: input.ownerText }, lang, classified);
  }

  // Enrich lead — per-lead-isolated (CP-6).
  if (classified.intent === "enrich_lead") {
    if (!input.leadId) {
      const text = lang === "hi"
        ? `किस लीड को एनरिच करूँ? (ऊपर से लीड चुनें या नाम बताएँ।)`
        : `Which lead should I enrich? (Pick a lead above, or tell me the name.)`;
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_question");
      return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_question", aiStatus: "none" };
    }
    return await enrichLeadFromChat(repos, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, conversationId: input.conversationId, leadId: input.leadId }, lang, classified);
  }

  // Document extraction / business extraction / manual-answer mapping — these
  // need a source (a document or an answer text) the owner hasn't given inline.
  // Ask honestly instead of guessing (never-guess).
  if (["extract_document", "business_extraction", "map_manual_answer"].includes(classified.intent)) {
    const need = classified.intent === "map_manual_answer"
      ? (lang === "hi" ? "आपका उत्तर (कौन सा सवाल, और आपका जवाब)" : "your answer (which question, and your answer)")
      : (lang === "hi" ? "दस्तावेज़ या स्रोत (फ़ाइल अपलोड करें या लिंक दें)" : "the document or source (upload the file or give the link)");
    const text = lang === "hi"
      ? `इसके लिए मुझे ${need} चाहिए। कृपया समर्पित नॉलेज स्क्रीन से जोड़ें।`
      : `For this I need ${need}. Please add it from the dedicated Knowledge screen.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
  }

  // Fallback (should not happen — every T2 intent is handled above).
  const text = lang === "hi"
    ? `मैं इस काम को समझ नहीं पाया। कृपया थोड़ा और विस्तार से बताएँ।`
    : `I didn't quite understand that action. Could you say a bit more?`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
  return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
}

/**
 * Draft a reply (or first message) via the LLM, persist as a DRAFT (never-send),
 * audit the step. Reuses the proven whatsapp_reply task through LLMService.
 */
async function draftReplyOrMessage(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; leadId: string; ownerText: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  const taskName = classified.intent === "draft_first_message" ? "message_generation" : "whatsapp_reply";
  const lead = await repos.lead.getLeadById(input.workspaceId, input.leadId);
  if (!lead) {
    const text = lang === "hi" ? `मुझे वह लीड नहीं मिला। कृपया नाम जाँचें।` : `I couldn't find that lead. Please check the name.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
  }

  // Load recent context (the lead + recent replies) for an intelligent draft.
  const recentReplies = (await repos.reply.listByWorkspace(input.workspaceId))
    .filter((r) => r.leadId === input.leadId)
    .slice(-3);

  let draftBody: string;
  let aiStatus: "real" | "mock" | "fallback";
  try {
    // Runtime's compact company summary only contains the synced questionnaire.
    // Retrieve the approved policy/document excerpts relevant to this draft too.
    // This is scoped to the same workspace and never treats unreviewed extraction
    // as company knowledge that can be quoted to a customer.
    const context = await getRelevantContext(input.workspaceId,
      [input.ownerText, ...recentReplies.map(reply => reply.rawText)].join("\n").slice(0, 4000), repos);
    const knowledgeContext = context.chunks.filter(chunk => !chunk.metadata?.extractionUnverified)
      .map(chunk => chunk.chunkText).join("\n\n").slice(0, 8000);
    const llm = new LLMService(undefined, repos);
    const result = await llm.runTask<{ body?: string; subject?: string; message?: string; suggestedReply?: string }>(taskName, {
      lead: { companyName: lead.companyName, contactName: lead.contactName, buyerType: lead.buyerType },
      recentMessages: recentReplies.map((r) => r.rawText),
      knowledgeContext,
      ownerNote: input.ownerText,
      language: lang,
    }, { workspaceId: input.workspaceId });
    // 2026-08-07 real-AI proof-pass fix: taskName is "whatsapp_reply" for the
    // (more common) draft_reply intent, whose real schema/prompt returns
    // `suggestedReply` — not `body`/`message` (that shape is message_generation's,
    // used only for draft_first_message). Reading only body/message meant a
    // genuinely successful real model call (aiStatus stayed "real") always
    // fell through to the empty-draft placeholder below; the model's actual
    // words were discarded.
    draftBody = String(result.output?.suggestedReply || result.output?.body || result.output?.message || "");
    aiStatus = result.mode === "real" ? "real" : result.fallbackUsed ? "fallback" : "mock";
  } catch (error) {
    // LLM unavailable (no key / usage blocked) → honest mock placeholder so the
    // owner still gets a draft to edit. Never silently fails.
    // 2026-08-07: log the REAL reason (usage cap, bad key, model error) —
    // previously swallowed entirely, so "usage cap exceeded" and "no key
    // configured" were both invisible to the operator, indistinguishable
    // from each other in the UI's generic "(mock)" tag.
    console.error(`[OwnerCopilot] draftReply LLM call failed, showing mock draft: ${error instanceof Error ? error.message : error}`);
    draftBody = lang === "hi"
      ? `नमस्ते ${lead.contactName || lead.companyName}, आपके संदेश के लिए धन्यवाद। [यहाँ अपना उत्तर लिखें]`
      : `Hi ${lead.contactName || lead.companyName}, thanks for your message. [Write your reply here]`;
    aiStatus = "mock";
  }
  if (!draftBody.trim()) {
    // A valid provider response can still contain no usable reply. This is
    // our editable placeholder, not text written by the real model.
    aiStatus = "mock";
    draftBody = lang === "hi"
      ? `नमस्ते ${lead.contactName || lead.companyName}, [यहाँ अपना उत्तर लिखें]`
      : `Hi ${lead.contactName || lead.companyName}, [Write your reply here]`;
  }

  // Persist as a DRAFT (never-send — status="draft", no send).
  const draft = await repos.messageTemplate.create({
    workspaceId: input.workspaceId,
    campaignId: "copilot",
    leadId: input.leadId,
    channel: "whatsapp",
    body: draftBody,
    tone: "professional",
    language: lang,
    status: "draft",
    personalizationUsed: { source: "copilot", aiStatus, taskName },
  });

  await new AuditLogService(repos).logAuditEvent({
    workspaceId: input.workspaceId,
    userId: input.ownerUserId,
    action: "copilot.reply_drafted",
    entityType: "message_template",
    entityId: draft.id,
    newValuesJson: { leadId: input.leadId, taskName, aiStatus, status: "draft" },
  });

  const honestTag = aiStatus === "mock"
    ? (lang === "hi" ? " (मॉक ड्राफ़्ट — असली AI की जरूरत है)" : " (mock draft — needs a real AI key)")
    : aiStatus === "fallback" ? (lang === "hi" ? " (फ़ॉलबैक)" : " (fallback)") : "";
  const text = lang === "hi"
    ? `रिप्लाई का ड्राफ़्ट तैयार:${honestTag}\n\n"${draftBody}"\n\nस्थिति: ड्राफ़्ट (अभी ग्राहक को नहीं भेजा गया)। समीक्षा स्क्रीन से एडिट/भेजें।`
    : `Here's a drafted reply:${honestTag}\n\n"${draftBody}"\n\nStatus: DRAFT (not sent to the customer). Edit/send it from the review screen.`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_draft", { intent: classified.intent, entityId: draft.id, entityType: "reply" });
  return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_draft", pendingAction: { intent: classified.intent, entityId: draft.id, entityType: "reply" }, aiStatus };
}

/**
 * Enrich a lead from chat — reuses the proven LeadEnrichmentService. The lead
 * must be approved + contact-safe (the service enforces this; it throws otherwise,
 * which we surface honestly).
 */
async function enrichLeadFromChat(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; leadId: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  // Lazy import to avoid a module-load cycle (LeadEnrichmentService imports repos).
  const { enrichLead } = await import("@/services/LeadEnrichmentService");
  try {
    const summary = await enrichLead(input.workspaceId, input.leadId, {}, repos, input.ownerUserId);
    const text = lang === "hi"
      ? `लीड एनरिच किया गया। स्थिति: ${summary.status}${summary.fieldsAdded?.length ? ` (जोड़े गए: ${summary.fieldsAdded.join(", ")})` : ""}।`
      : `Lead enriched. Status: ${summary.status}${summary.fieldsAdded?.length ? ` (added: ${summary.fieldsAdded.join(", ")})` : ""}.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_action_done", { intent: classified.intent, entityId: input.leadId, entityType: "lead" });
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_action_done", pendingAction: { intent: classified.intent, entityId: input.leadId, entityType: "lead" }, aiStatus: "none" };
  } catch (e) {
    // enrichLead throws for non-approved / DNC leads — surface honestly.
    const reason = e instanceof Error ? e.message : "enrichment failed";
    const text = lang === "hi" ? `एनरिचमेंट नहीं हो सका: ${reason}` : `Couldn't enrich: ${reason}`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
    return { text, language: lang, tier: classified.tier, intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
  }
}

// ─── T1 handlers (read-only; instant; never mutates) ────────────────────────
async function handleT1Action(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; ownerText: string; leadId?: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  // Knowledge / policy answer — read from the KB (no LLM needed for retrieval).
  if (classified.intent === "knowledge_answer" || classified.intent === "policy_answer") {
    return await answerFromKnowledgeBase(repos, input, lang, classified);
  }

  // Lead scoring — read-only (per-lead if a lead is in context).
  if (classified.intent === "lead_scoring") {
    return await scoreLeadFromChat(repos, input, lang, classified);
  }

  // Voice-of-Customer demand analysis (CP-12) — read-only report across ALL
  // customer messages + leads + orders. Never mutates, never sends.
  if (classified.intent === "demand_analysis") {
    return await runDemandAnalysis(repos, input, lang, classified);
  }

  // Reply classification / quality review — read-only analysis.
  if (classified.intent === "classify_reply" || classified.intent === "quality_review") {
    return await analyzeReadOnly(repos, input, lang, classified);
  }

  // Default T1 — treat as a general knowledge question.
  return await answerFromKnowledgeBase(repos, input, lang, { ...classified, intent: "knowledge_answer" });
}

/**
 * Answer a knowledge/policy question from the Knowledge Base. CP-11: if the KB
 * has no verified chunk, do NOT invent — say "I don't have that" + offer a
 * capture card (UnknownQuestion / Information Needed).
 */
async function answerFromKnowledgeBase(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; ownerText: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  const ctx = await getRelevantContext(input.workspaceId, stripQuestion(input.ownerText), repos);
  const verifiedChunk = ctx.chunks.find((c) => !c.metadata?.extractionUnverified);

  if (verifiedChunk && ctx.confidenceScore >= 0.2) {
    // 2026-09-28 (real-AI eval, docs/AI-QUALITY-EVAL-2026-09-28.md): this used
    // to return the top search result's raw text as "the answer". A synced
    // chunk holds a dozen Q/A pairs, so "What is our minimum order for zari?"
    // got a page about product varieties, "Hamara address kya hai?" got the
    // website and email, and "What is the price of gold zari?" got the product
    // list — 7 of 9 knowledge questions answered with something else, labelled
    // as the knowledge base's answer. Now the model answers FROM those excerpts
    // (grounded task), its numbers are checked against them, and a "not in
    // there" is said plainly. The raw text is only the fallback when no real
    // model answered, and it says so.
    const grounded = await groundedOwnerAnswer(repos, input, ctx.chunks.filter((c) => !c.metadata?.extractionUnverified).slice(0, 5).map((c) => c.chunkText));
    if (grounded?.answer) {
      await persistCopilotMessage(repos, input.workspaceId, input.conversationId, grounded.answer, lang, classified, "copilot_info");
      return { text: grounded.answer, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", aiStatus: "real" };
    }
    if (!grounded?.notInKnowledge) {
    const source = verifiedChunk.documentTitle ? (lang === "hi" ? ` (स्रोत: ${verifiedChunk.documentTitle})` : ` (source: ${verifiedChunk.documentTitle})`) : "";
    const confidence = ctx.confidenceScore >= 0.6 ? "" : (lang === "hi" ? "\n(कम आत्मविश्वास — कृपया पुष्टि करें)" : "\n(low confidence — please verify)");
    const lead = lang === "hi" ? "AI अभी जवाब नहीं दे सका — आपके नॉलेज बेस में सबसे मिलता-जुलता हिस्सा:\n\n" : "The AI could not answer just now — here is the closest part of your knowledge base:\n\n";
    const text = `${lead}${verifiedChunk.chunkText}${source}${confidence}`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
    return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", aiStatus: "kb" };
    }
  }

  // CP-11: no answer in the KB → honest "I don't have that" + offer a card.
  const offerId = uid("cp_offer");
  const text = lang === "hi"
    ? `मुझे यह आपके नॉलेज बेस में नहीं मिला। एक बार जोड़ दें तो मैं फिर कभी नहीं पूछूँगा।\n\n"${input.ownerText}"\n\nइसे "Information Needed" कार्ड के रूप में सहेजें?`
    : `I don't have that in your knowledge base yet. Add it once and I won't have to ask again.\n\n"${input.ownerText}"\n\nSave this as an "Information Needed" card?`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info", { intent: "save_fact", entityId: offerId, entityType: "unknown_question" });
  return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", pendingAction: { intent: "save_fact", entityId: offerId, entityType: "unknown_question" }, aiStatus: "kb" };
}

/**
 * The owner's knowledge question, answered by the model from the excerpts only.
 * Returns { answer } when a real model answered with nothing it could not ground;
 * { notInKnowledge } when it said the excerpts do not hold the answer; undefined
 * when no real model answered (the caller shows the excerpt, labelled).
 */
async function groundedOwnerAnswer(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerText: string },
  excerpts: string[],
): Promise<{ answer?: string; notInKnowledge?: boolean } | undefined> {
  if (!excerpts.length) return undefined;
  try {
    const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>("knowledge_answer", {
      question: input.ownerText,
      knowledgeContext: excerpts.join("\n\n"),
      asker: "owner",
      ownerNote: "The asker is the business OWNER asking about their own business. Sensitive-topic deferral is for customers: for the owner, state exactly what the knowledge context says, in one to three short sentences, in the owner's language (Hinglish in Roman letters if they wrote Hinglish). If the context does not answer the question, answer with exactly NOT_IN_KNOWLEDGE. Never add a number, name or term the context does not state.",
    }, { workspaceId: input.workspaceId });
    if (result.mode !== "real" || result.fallbackUsed) return undefined;
    const output = (result.output || {}) as Record<string, unknown>;
    const answer = String(output.answer || "").trim();
    if (!answer) return undefined;
    if (/NOT_IN_KNOWLEDGE/i.test(answer) || (output.deferReason && !output.sourceLabel)) return { notInKnowledge: true };
    // Every figure in the answer must be in the excerpts or the owner's own question.
    if (numbersNotGrounded(answer, `${excerpts.join("\n")}\n${input.ownerText}`).length) return undefined;
    return { answer };
  } catch {
    return undefined;
  }
}

/** Read-only lead scoring. Reuses the proven lead_scoring task. */
async function scoreLeadFromChat(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; ownerText: string; leadId?: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  if (!input.leadId) {
    const text = lang === "hi"
      ? `किस लीड को स्कोर करूँ? (ऊपर से लीड चुनें या नाम बताएँ।)`
      : `Which lead should I score? (Pick a lead above, or tell me the name.)`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_question");
    return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_question", aiStatus: "none" };
  }
  const lead = await repos.lead.getLeadById(input.workspaceId, input.leadId);
  if (!lead) {
    const text = lang === "hi" ? `मुझे वह लीड नहीं मिला।` : `I couldn't find that lead.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
    return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", aiStatus: "none" };
  }
  let aiStatus: "real" | "mock" | "fallback" = "mock";
  let scoreText: string;
  try {
    const llm = new LLMService(undefined, repos);
    const result = await llm.runTask<{ totalScore?: number; qualificationStatus?: string; reason?: string; recommendation?: string; reasoning?: string }>("lead_scoring", {
      lead: { companyName: lead.companyName, buyerType: lead.buyerType, industry: lead.industry },
    }, { workspaceId: input.workspaceId });
    aiStatus = result.mode === "real" ? "real" : result.fallbackUsed ? "fallback" : "mock";
    const s = result.output;
    // 2026-08-07 real-AI proof-pass fix: leadScoringPrompt.ts actually asks
    // for `qualificationStatus` + `reason` — this read `recommendation` +
    // `reasoning` (a different task's field names), so a real, correct model
    // response always printed "Recommendation: —" with the reasoning dropped.
    const recommendation = s?.qualificationStatus || s?.recommendation;
    const reasoning = s?.reason || s?.reasoning;
    scoreText = lang === "hi"
      ? `लीड स्कोर: ${s?.totalScore ?? "n/a"}। सुझाव: ${recommendation ?? "—"}।${reasoning ? `\nकारण: ${reasoning}` : ""}`
      : `Lead score: ${s?.totalScore ?? "n/a"}. Recommendation: ${recommendation ?? "—"}.${reasoning ? `\nReasoning: ${reasoning}` : ""}`;
  } catch (error) {
    console.error(`[OwnerCopilot] lead_scoring LLM call failed: ${error instanceof Error ? error.message : error}`);
    scoreText = lang === "hi" ? `स्कोरिंग अभी उपलब्ध नहीं है (AI की जरूरत)।` : `Scoring isn't available right now (needs an AI key).`;
  }
  const honestTag = aiStatus === "mock" ? (lang === "hi" ? " (मॉक)" : " (mock)") : aiStatus === "fallback" ? (lang === "hi" ? " (फ़ॉलबैक)" : " (fallback)") : "";
  const text = `${scoreText}${honestTag}`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
  return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", aiStatus };
}

/** Read-only reply classification / quality review via the LLM. */
async function analyzeReadOnly(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; ownerText: string; leadId?: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  const taskName = classified.intent === "classify_reply" ? "reply_classification" : "quality_review";
  const lead = input.leadId ? await repos.lead.getLeadById(input.workspaceId, input.leadId) : undefined;
  const records = lead
    ? taskName === "reply_classification"
      ? (await repos.reply.listByLead(input.workspaceId, lead.id)).map(r => ({ body: r.rawText, createdAt: r.createdAt }))
      : (await repos.messageTemplate.listByWorkspace(input.workspaceId)).filter(r => r.leadId === lead.id).map(r => ({ body: r.body, createdAt: r.createdAt }))
    : [];
  const target = records.filter(r => r.body?.trim()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!target) {
    const text = lang === "hi"
      ? "पहले ग्राहक चुनें और उसका संदेश या ड्राफ़्ट सेव करें। विश्लेषण के लिए कोई संदेश उपलब्ध नहीं है।"
      : `Select a customer with a saved ${taskName === "reply_classification" ? "reply" : "message draft"} first. There is no message available to analyse.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_question");
    return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_question", aiStatus: "none" };
  }
  let aiStatus: "real" | "mock" | "fallback" = "mock";
  let analysis: string;
  try {
    const llm = new LLMService(undefined, repos);
    const result = await llm.runTask<Record<string, unknown>>(taskName, {
      question: input.ownerText, leadId: lead!.id,
      ...(taskName === "reply_classification" ? { message: target.body, rawText: target.body } : { output: target.body, body: target.body }),
    }, { workspaceId: input.workspaceId });
    aiStatus = result.mode === "real" ? "real" : result.fallbackUsed ? "fallback" : "mock";
    const output = result.output;
    if (taskName === "reply_classification" && typeof output?.classification === "string" && typeof output.summary === "string") {
      analysis = `${output.summary}\n${lang === "hi" ? "सुझाया गया अगला कदम" : "Suggested next step"}: ${typeof output.suggestedNextAction === "string" ? output.suggestedNextAction : "Review the message before acting."}`;
    } else if (taskName === "quality_review" && typeof output?.passes === "boolean" && Array.isArray(output.issues) && Array.isArray(output.recommendations)) {
      const issues = output.issues.flatMap(item => item && typeof item === "object" && typeof (item as Record<string, unknown>).issue === "string" ? [(item as Record<string, unknown>).issue as string] : []);
      const recommendations = output.recommendations.filter((item): item is string => typeof item === "string");
      analysis = `${output.passes ? "Review passed." : "Changes are needed before using this draft."}${issues.length ? `\nIssues: ${issues.join("; ")}` : ""}${recommendations.length ? `\nSuggested changes: ${recommendations.join("; ")}` : ""}`;
    } else {
      analysis = lang === "hi" ? "AI ने उपयोगी विश्लेषण नहीं दिया। संदेश की समीक्षा करें और फिर प्रयास करें।" : "The AI did not return a usable analysis. Review the saved message and try again.";
    }
  } catch (error) {
    console.error(`[OwnerCopilot] ${taskName} LLM call failed: ${error instanceof Error ? error.message : error}`);
    analysis = lang === "hi" ? "विश्लेषण अभी उपलब्ध नहीं है (AI की जरूरत)।" : "Analysis isn't available right now (needs an AI key).";
  }
  const honestTag = aiStatus === "mock" ? (lang === "hi" ? " (मॉक)" : " (mock)") : aiStatus === "fallback" ? (lang === "hi" ? " (फ़ॉलबैक)" : " (fallback)") : "";
  const text = lang === "hi" ? `विश्लेषण:${honestTag}\n${analysis}` : `Analysis:${honestTag}\n${analysis}`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
  return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", aiStatus };
}

/**
 * CP-12 Voice-of-Customer demand analysis. Read-only: reads ALL customer
 * messages + leads + orders for the workspace, clusters into demand topics,
 * returns a ranked report. Never sends, never mutates. Writes a copilot.voc_run
 * audit row (CP-12e). No-hallucination: <3 signals → "not enough data".
 */
async function runDemandAnalysis(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; ownerText: string },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  const { analyzeVoiceOfCustomer } = await import("@/services/VoiceOfCustomerService");
  const report = await analyzeVoiceOfCustomer(input.workspaceId, repos);

  // CP-12e: audit each run (it costs AI credits when the LLM layer fires).
  await new AuditLogService(repos).logAuditEvent({
    workspaceId: input.workspaceId,
    userId: input.ownerUserId,
    action: "copilot.voc_run",
    newValuesJson: {
      totalSignals: report.totalSignals,
      topicCount: report.topics.length,
      insufficientData: report.insufficientData,
      aiStatus: report.aiStatus,
      topTopic: report.topics[0]?.label,
    },
  });

  // Render the report in the owner's language (the deterministic summary is
  // English; for Hindi we prefix a short Hindi header + keep the ranked list).
  const header = lang === "hi"
    ? `आपके ग्राहकों के आधार पर डिमांड रिपोर्ट (${report.totalSignals} सिग्नल):`
    : `Demand report from your customer data (${report.totalSignals} signals):`;
  const honestTag = report.aiStatus === "mock" ? (lang === "hi" ? "\n(मॉक सारांश — असली AI की जरूरत)" : "\n(mock summary — needs a real AI key)") : "";
  const text = `${header}${honestTag}\n\n${report.summary}`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
  return { text, language: lang, tier: "T1", intent: classified.intent, kind: "copilot_info", aiStatus: report.aiStatus };
}

/** Strip filler words from a question for better KB retrieval. */
function stripQuestion(text: string): string {
  return text.replace(/^(what is|what's|whats|do we have|how much is|our|the)\s+/i, "").trim();
}

// ─── CP-10: confirm + RUN a big job (T3) ─────────────────────────────────────
/**
 * After the owner confirms a T3 cost prompt, EXECUTE the job (CP-10). This is
 * the function that makes the Copilot "THEN it works" — a confirmed ICP
 * generation actually creates ICP rows, a confirmed campaign plan actually
 * drafts a campaign, etc. The confirm gate (handleOwnerCopilotTurn → copilot_confirm)
 * still stood; this is the "go" the owner gives.
 *
 * Every job is bounded: the AI-usage gate caps cost; destructive jobs were
 * flagged in the confirm text. Every run writes a copilot.* audit row.
 */
// Avoid duplicate local work; the repository claim also consumes the proposal
// atomically (Postgres serializes across server processes).
const confirmationLocks = new Map<string, Promise<void>>();

export async function confirmCopilotBigJob(input: {
  workspaceId: string;
  ownerUserId: string;
  conversationId: string;
  /** The pending action id from the copilot_confirm message. */
  pendingActionId: string;
  /** The intent to run (icp_generation / campaign_planning / research / etc.). */
  intent: string;
  repos?: RepositoryBundle;
}): Promise<CopilotResponse> {
  const key = `${input.workspaceId}:${input.conversationId}`;
  const previous = confirmationLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  confirmationLocks.set(key, current);
  await previous;
  try {
    return await confirmPersistedCopilotJob(input);
  } finally {
    release();
    if (confirmationLocks.get(key) === current) confirmationLocks.delete(key);
  }
}

async function confirmPersistedCopilotJob(input: Parameters<typeof confirmCopilotBigJob>[0]): Promise<CopilotResponse> {
  const repos = input.repos || createRepositories();
  const conversation = await repos.ownerCopilotConversation.getById(input.workspaceId, input.conversationId);
  if (!conversation || conversation.ownerUserId !== input.ownerUserId) {
    throw new NeedsActionError("Conversation not found.", 404);
  }
  const messages = await repos.ownerCopilotMessage.listByConversation(input.workspaceId, input.conversationId);
  const proposal = messages.find(message => message.role === "copilot" && message.kind === "copilot_confirm"
    && message.tier === "T3" && message.pendingAction?.entityId === input.pendingActionId
    && message.pendingAction.intent === input.intent);
  if (!proposal || (tierOfIntent(input.intent).tier !== "T3" && ALL_TASK_TIER_MAP[input.intent as LLMTaskName] !== "T3")) {
    throw new NeedsActionError("This action does not match a pending proposal. Please ask the Assistant again.");
  }
  if (messages.some(message => message.role === "owner" && message.pendingAction?.entityId === input.pendingActionId)) {
    throw new NeedsActionError("This action has already been confirmed. Check its result before requesting another run.");
  }
  const lang = proposal.language === "hi" ? "hi" : "en";
  const proposalIndex = messages.findIndex(message => message.id === proposal.id);
  const request = proposal.pendingAction?.request || [...messages.slice(0, proposalIndex)].reverse().find(message => message.role === "owner")?.text;
  const isResearch = !["orchestrated_job", "icp_generation", "campaign_planning", "lead_review_decision", "campaign_learning"].includes(input.intent);
  if (isResearch && !request?.trim()) throw new NeedsActionError("The original request is missing. Please ask the Assistant again.");

  // Persist the owner's confirm "message" (the audit trail records the go).
  const claimed = await repos.ownerCopilotMessage.claimConfirmation({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    ownerUserId: input.ownerUserId,
    proposalMessageId: proposal.id,
    pendingActionId: input.pendingActionId,
    intent: input.intent,
    // Shown as the owner's bubble when the chat is reopened — plain words,
    // not the internal code it used to be ("[confirmed: orchestrated_job]").
    text: lang === "hi" ? "हाँ, आगे बढ़ें।" : "Yes, go ahead.",
    language: lang,
  });
  if (!claimed) throw new NeedsActionError("This action has already been confirmed or is no longer available.");

  // Route to the right job runner.
  if (input.intent === "orchestrated_job") {
    return await runOrchestratedJob(repos, input, lang);
  }
  if (input.intent === "icp_generation") {
    return await runIcpGeneration(repos, input, lang);
  }
  if (input.intent === "campaign_planning") {
    return await runCampaignPlanning(repos, input, lang);
  }
  if (input.intent === "lead_review_decision") {
    return await runLeadReviewDecision(repos, input, lang);
  }
  if (input.intent === "campaign_learning") {
    return await runCampaignLearning(repos, input, lang);
  }
  // Confirmation is a click, not a new research request. Recover the owner's
  // saved request preceding this exact proposal, never a later chat message.
  return await runResearchTask(repos, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, conversationId: input.conversationId, intent: input.intent, topic: request! }, lang, input.intent);
}

/** CP-10: actually generate ICPs and persist them. */
async function runIcpGeneration(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string },
  lang: "en" | "hi",
): Promise<CopilotResponse> {
  const profile = await repos.businessProfile.getByWorkspace(input.workspaceId);
  if (!profile) {
    const text = lang === "hi" ? `पहले अपना बिज़नेस प्रोफाइल भरें, तब ICP बन सकता है।` : `Please fill in your Business Profile first — ICPs are built from it.`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent: "icp_generation" }, "copilot_info");
    return { text, language: lang, tier: "T3", intent: "icp_generation", kind: "copilot_info", aiStatus: "none" };
  }
  let aiStatus: "real" | "mock" | "fallback" = "mock";
  let icpData: Array<Record<string, unknown>>;
  try {
    const llm = new LLMService(undefined, repos);
    const result = await llm.runTask<{ icps?: Array<Record<string, unknown>> }>("icp_generation", {
      businessProfile: { companyName: profile.companyName, industry: profile.industry, products: profile.products },
    }, { workspaceId: input.workspaceId });
    aiStatus = result.mode === "real" ? "real" : result.fallbackUsed ? "fallback" : "mock";
    const generated = result.output?.icps;
    if (!Array.isArray(generated) || generated.length === 0 || generated.some(d => !d || typeof d !== "object" || typeof d.name !== "string" || !d.name.trim())) {
      return generationUnavailable(repos, input, lang, "icp_generation", aiStatus);
    }
    icpData = generated;
  } catch (error) {
    console.error(`[OwnerCopilot] icp_generation LLM call failed: ${error instanceof Error ? error.message : error}`);
    return generationUnavailable(repos, input, lang, "icp_generation", "none");
  }
  // Persist the ICPs (replaceForBusinessProfile — destructive, flagged in confirm).
  const icps = await repos.icp.replaceForBusinessProfile(input.workspaceId, profile.id, icpData.map((d) => ({ ...d, workspaceId: input.workspaceId })));

  await new AuditLogService(repos).logAuditEvent({
    workspaceId: input.workspaceId,
    userId: input.ownerUserId,
    action: "copilot.icp_generated",
    entityType: "icp",
    entityId: profile.id,
    newValuesJson: { count: icps.length, aiStatus },
  });

  const names = icps.map((i) => i.name || "ICP").join(", ");
  const honestTag = aiStatus === "mock" ? (lang === "hi" ? " (मॉक)" : " (mock)") : aiStatus === "fallback" ? (lang === "hi" ? " (फ़ॉलबैक)" : " (fallback)") : "";
  const text = lang === "hi"
    ? `ICP बना दिए गए:${honestTag} ${icps.length} प्रोफाइल (${names})। ICP स्क्रीन पर देखें।`
    : `ICPs generated:${honestTag} ${icps.length} profile(s) (${names}). See them on the ICP screen.`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent: "icp_generation" }, "copilot_action_done", { intent: "icp_generation", entityType: "icp" });
  return { text, language: lang, tier: "T3", intent: "icp_generation", kind: "copilot_action_done", pendingAction: { intent: "icp_generation", entityType: "icp" }, aiStatus };
}

async function generationUnavailable(
  repos: RepositoryBundle,
  input: { workspaceId: string; conversationId: string },
  lang: "en" | "hi", intent: "icp_generation" | "campaign_planning",
  aiStatus: CopilotResponse["aiStatus"],
): Promise<CopilotResponse> {
  const text = lang === "hi"
    ? "AI अभी उपयोगी परिणाम नहीं दे सका। आपके मौजूदा ग्राहक प्रोफाइल और कैंपेन सुरक्षित हैं। फिर प्रयास करने के लिए नया अनुरोध करें और उसकी पुष्टि करें।"
    : "The AI could not produce a usable result. Your existing customer profiles and campaigns were kept. Make a new request and confirm it to try again.";
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent }, "copilot_info");
  return { text, language: lang, tier: "T3", intent, kind: "copilot_info", aiStatus };
}

/** CP-10: draft a campaign plan (status needs_review — owner approves). */
async function runCampaignPlanning(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string },
  lang: "en" | "hi",
): Promise<CopilotResponse> {
  const icps = await repos.icp.listByWorkspace(input.workspaceId);
  if (icps.length === 0) {
    const text = lang === "hi" ? `कैंपेन के लिए पहले ICP चाहिए (ऊपर "बिल्ड कस्टमर प्रोफाइल" टाइप करें)।` : `A campaign needs an ICP first (type "build my customer profile" above).`;
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent: "campaign_planning" }, "copilot_info");
    return { text, language: lang, tier: "T3", intent: "campaign_planning", kind: "copilot_info", aiStatus: "none" };
  }
  let aiStatus: "real" | "mock" | "fallback" = "mock";
  let plan: Record<string, unknown> = {};
  try {
    const llm = new LLMService(undefined, repos);
    const result = await llm.runTask<Record<string, unknown>>("campaign_planning", { icps }, { workspaceId: input.workspaceId });
    aiStatus = result.mode === "real" ? "real" : result.fallbackUsed ? "fallback" : "mock";
    plan = result.output || {};
    const arrays = ["prospectSources", "searchQueries", "outreachSequence", "qualificationCriteria", "expectedLeadStatuses", "manualExecutionSteps"];
    if (typeof plan.icpSummary !== "string" || !plan.icpSummary.trim() || typeof plan.messageStrategy !== "string" || !plan.messageStrategy.trim()
      || arrays.some(key => !Array.isArray(plan[key]) || !(plan[key] as unknown[]).length || (plan[key] as unknown[]).some(value => typeof value !== "string" || !value.trim()))) {
      return generationUnavailable(repos, input, lang, "campaign_planning", aiStatus);
    }
  } catch (error) {
    console.error(`[OwnerCopilot] campaign_planning LLM call failed: ${error instanceof Error ? error.message : error}`);
    return generationUnavailable(repos, input, lang, "campaign_planning", "none");
  }
  const campaign = await repos.campaign.create({
    workspaceId: input.workspaceId,
    name: String(plan.name || "Copilot-drafted campaign"),
    goal: String(plan.goal || ""),
    status: "draft",
    icpId: icps[0].id,
    plan: plan as never,
  } as never);

  await new AuditLogService(repos).logAuditEvent({
    workspaceId: input.workspaceId,
    userId: input.ownerUserId,
    action: "copilot.campaign_planned",
    entityType: "campaign",
    entityId: campaign.id,
    newValuesJson: { status: "draft", aiStatus },
  });

  const honestTag = aiStatus === "mock" ? (lang === "hi" ? " (मॉक)" : " (mock)") : aiStatus === "fallback" ? (lang === "hi" ? " (फ़ॉलबैक)" : " (fallback)") : "";
  const text = lang === "hi"
    ? `कैंपेन प्लान तैयार:${honestTag} "${campaign.name}" (स्थिति: ड्राफ़्ट)। कैंपेन स्क्रीन पर समीक्षा करें।`
    : `Campaign plan drafted:${honestTag} "${campaign.name}" (status: draft). Review it on the Campaigns screen.`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent: "campaign_planning" }, "copilot_action_done", { intent: "campaign_planning", entityId: campaign.id, entityType: "campaign" });
  return { text, language: lang, tier: "T3", intent: "campaign_planning", kind: "copilot_action_done", pendingAction: { intent: "campaign_planning", entityId: campaign.id, entityType: "campaign" }, aiStatus };
}

/** CP-10: lead-review batch decision (suggests approvals — owner confirms on the review screen). */
async function runLeadReviewDecision(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string },
  lang: "en" | "hi",
): Promise<CopilotResponse> {
  const pending = (await repos.lead.listLeads(input.workspaceId)).filter((lead) => lead.reviewStatus === "pending");
  let aiStatus: "real" | "mock" | "fallback" | "none" = "none";
  let submittedCount = 0;
  let recommendationCount = 0;
  let text: string;
  if (!pending.length) {
    text = lang === "hi" ? "कोई लंबित लीड नहीं है।" : "No pending leads to review.";
  } else if (pending.length > 1) {
    // The task contract returns ONE unlabelled decision, not an ID-keyed batch.
    // Never attach that decision to several buyers or claim all were analyzed.
    text = lang === "hi"
      ? `${pending.length} खरीदार समीक्षा के लिए लंबित हैं। चैट में एक साथ सभी के विश्वसनीय सुझाव उपलब्ध नहीं हैं। Lead Review स्क्रीन पर उनकी मैन्युअल समीक्षा करें। किसी की स्थिति नहीं बदली गई।`
      : `${pending.length} buyers are waiting for review. Reliable batch recommendations are not available in chat. Review them manually on the Lead Review screen. No buyer status changed.`;
  } else {
    const lead = pending[0];
    const unavailable = lang === "hi"
      ? `${lead.companyName || "इस खरीदार"} के लिए विश्वसनीय समीक्षा सुझाव नहीं मिल सका। Lead Review स्क्रीन पर मैन्युअल समीक्षा करें। स्थिति नहीं बदली गई।`
      : `I could not produce a usable review recommendation for ${lead.companyName || "this buyer"}. Review the buyer manually on the Lead Review screen. No buyer status changed.`;
    text = unavailable;
    try {
      const [profile, icps] = await Promise.all([repos.businessProfile.getByWorkspace(input.workspaceId), repos.icp.listByWorkspace(input.workspaceId)]);
      submittedCount = 1;
      const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>("lead_review_decision", {
        lead, icp: lead.icpId ? icps.find((icp) => icp.id === lead.icpId) : undefined,
        availableCustomerProfiles: icps, products: profile?.products || [],
      }, { workspaceId: input.workspaceId });
      aiStatus = result.mode === "real" && !result.fallbackUsed ? "real" : result.fallbackUsed ? "fallback" : "mock";
      const output = result.output;
      const decision = output?.decision;
      const reason = typeof output?.reason === "string" ? output.reason.trim() : "";
      const signals = output?.signals;
      const confidence = output?.confidenceScore;
      if ((output?.leadId === undefined || output.leadId === lead.id)
        && (decision === "approve" || decision === "reject" || decision === "needs_review") && reason
        && Array.isArray(signals) && signals.length > 0 && signals.every((signal) => typeof signal === "string" && signal.trim())
        && typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
        recommendationCount = 1;
        const label = decision === "approve" ? (lang === "hi" ? "मंज़ूरी पर विचार करें" : "Consider approval")
          : decision === "reject" ? (lang === "hi" ? "अस्वीकृति पर विचार करें" : "Consider rejection")
          : (lang === "hi" ? "और समीक्षा आवश्यक" : "More review needed");
        const statusNote = aiStatus === "real" ? "" : aiStatus === "fallback" ? " (fallback model)" : " (sample model)";
        text = lang === "hi"
          ? `${lead.companyName || "खरीदार"}: ${label}${statusNote}।\nकारण: ${reason}\nसंकेत: ${signals.join("; ")}\nयह केवल चैट में सुझाव है। Lead Review स्क्रीन पर निर्णय लें। खरीदार की स्थिति नहीं बदली गई।`
          : `${lead.companyName || "Buyer"}: ${label}${statusNote}.\nReason: ${reason}\nEvidence: ${signals.join("; ")}\nThis is a chat suggestion only. Make your decision on the Lead Review screen. No buyer status changed.`;
      }
    } catch (error) {
      console.error(`[OwnerCopilot] lead_review_decision unavailable: ${error instanceof Error ? error.message : error}`);
      aiStatus = "none";
    }
  }
  await new AuditLogService(repos).logAuditEvent({
    workspaceId: input.workspaceId, userId: input.ownerUserId, action: "copilot.lead_review_run", entityType: "lead",
    newValuesJson: { pendingCount: pending.length, submittedCount, recommendationCount, aiStatus, statusesChanged: false },
  });
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent: "lead_review_decision" }, "copilot_info");
  return { text, language: lang, tier: "T3", intent: "lead_review_decision", kind: "copilot_info", aiStatus };
}

/** CP-10: campaign learning analysis (read-only report). */
async function runCampaignLearning(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string },
  lang: "en" | "hi",
): Promise<CopilotResponse> {
  const campaigns = await repos.campaign.listByWorkspace(input.workspaceId);
  const outcomes = await Promise.all(campaigns.map(async campaign => ({
    campaignId: campaign.id, name: campaign.name,
    metrics: await repos.campaignMetric.listByCampaign(input.workspaceId, campaign.id),
    customers: (await repos.lead.listLeadsByCampaign(input.workspaceId, campaign.id)).map(lead => ({ status: lead.status, reviewStatus: lead.reviewStatus })),
  })));
  let aiStatus: CopilotResponse["aiStatus"] = "none";
  let learning: Record<string, unknown> = {};
  let usable = false;
  try {
    const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>("campaign_learning", { campaigns, outcomes }, { workspaceId: input.workspaceId });
    aiStatus = result.fallbackUsed ? "fallback" : result.mode === "real" ? "real" : "mock";
    learning = result.output || {};
    usable = typeof learning.summary === "string" && !!learning.summary.trim()
      && ["winningPatterns", "losingPatterns", "recommendedNextSteps"].every(key => Array.isArray(learning[key]) && (learning[key] as unknown[]).every(value => typeof value === "string" && !!value.trim()));
  } catch (error) {
    console.error(`[OwnerCopilot] campaign_learning failed: ${error instanceof Error ? error.message : error}`);
  }
  const sections = [["winningPatterns", "What may be working"], ["losingPatterns", "What may need attention"], ["recommendedNextSteps", "Suggested next steps"]];
  const tag = aiStatus === "real" ? "" : ` (${aiStatus === "fallback" ? "fallback" : "sample"} analysis)`;
  const text = usable
    ? `Campaign analysis${tag}:\n${learning.summary}\n` + sections.map(([key, title]) => (learning[key] as string[]).length ? `${title}:\n${(learning[key] as string[]).map(value => `• ${value}`).join("\n")}` : "").filter(Boolean).join("\n") + "\nSuggestions use saved company campaign records only; missing outcomes are not evidence of success. No campaign or settings were changed."
    : lang === "hi" ? "कैंपेन का उपयोगी विश्लेषण नहीं मिला। कोई कैंपेन या सेटिंग नहीं बदली। नया अनुरोध करके फिर पुष्टि करें।" : "A usable campaign analysis was not available. No campaign or settings were changed. Make a new request and confirm it to try again.";
  await new AuditLogService(repos).logAuditEvent({ workspaceId: input.workspaceId, userId: input.ownerUserId, action: "copilot.campaign_learning", newValuesJson: { campaignCount: campaigns.length, aiStatus, usable } });
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent: "campaign_learning" }, "copilot_info");
  return { text, language: lang, tier: "T3", intent: "campaign_learning", kind: "copilot_info", aiStatus };
}

/** CP-10: research tasks (market/product/embedding) — run + report in chat. */
async function runResearchTask(
  repos: RepositoryBundle,
  input: { workspaceId: string; ownerUserId: string; conversationId: string; intent: string; topic: string },
  lang: "en" | "hi",
  intent: string,
): Promise<CopilotResponse> {
  // GAP-6 (2026-07-31): market_research now ACTUALLY EXECUTES its plan via
  // MarketResearchService (plan → SerpApi → findings), instead of just printing
  // the LLM's plan as "Research done". The other research intents
  // (product_application_research / embedding) still use the LLM-only path for
  // now (they're analytical, not search-driven) — marked honest in the output.
  if (intent === "market_research" || intent === "research") {
    const { runMarketResearch } = await import("@/services/MarketResearchService");
    const result = await runMarketResearch(input.workspaceId, input.topic, repos);
    const providerTag = result.provider === "serpapi" ? "" : result.provider === "mock" ? (lang === "hi" ? " (मॉक)" : " (mock)") : (lang === "hi" ? " (कोई लाइव खोज नहीं)" : " (no live search)");
    const findingsText = result.findings.length === 0
      ? result.reason
      : result.findings.slice(0, 8).map((f, i) => `${i + 1}. ${f.title}${f.snippet ? ` — ${f.snippet}` : ""}`).join("\n");
    const text = lang === "hi"
      ? `बाज़ार शोध:${providerTag}\n${result.findings.length} नतीजे (${result.queriesRun} क्वेरीज़ से)।\n${findingsText}`
      : `Market research:${providerTag}\n${result.findings.length} finding(s) from ${result.queriesRun} quer${result.queriesRun === 1 ? "y" : "ies"}.\n${findingsText}`;
    const aiStatus: "real" | "mock" | "fallback" = result.provider === "serpapi" ? "real" : result.provider === "mock" ? "mock" : "fallback";
    await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent }, "copilot_action_done");
    return { text, language: lang, tier: "T3", intent, kind: "copilot_action_done", aiStatus };
  }

  // product_application_research / embedding — LLM-only analytical path (honest).
  const taskMap: Record<string, import("@/llm/types").LLMTaskName> = {
    research: "product_application_research",
    product_application_research: "product_application_research",
    embedding: "embedding",
  };
  const taskName = taskMap[intent] || "product_application_research";
  let aiStatus: CopilotResponse["aiStatus"] = "none";
  let findings: Record<string, unknown> = {};
  let usable = false;
  try {
    const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>(taskName, { topic: input.topic }, { workspaceId: input.workspaceId });
    aiStatus = result.fallbackUsed ? "fallback" : result.mode === "real" ? "real" : "mock";
    findings = result.output || {};
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && !!item.trim());
    usable = taskName === "embedding"
      ? typeof findings.preparedText === "string" && !!findings.preparedText.trim() && typeof findings.embeddingModelNeeded === "string" && !!findings.embeddingModelNeeded.trim() && typeof findings.ready === "boolean" && typeof findings.estimatedTokens === "number" && Number.isInteger(findings.estimatedTokens) && findings.estimatedTokens >= 0
      : strings(findings.applications) && findings.applications.length > 0 && typeof findings.marketNotes === "string" && !!findings.marketNotes.trim() && Array.isArray(findings.buyerSegments) && findings.buyerSegments.length > 0 && findings.buyerSegments.every(value => {
        if (!value || typeof value !== "object") return false;
        const buyer = value as Record<string, unknown>;
        return typeof buyer.segment === "string" && !!buyer.segment.trim() && typeof buyer.why === "string" && !!buyer.why.trim() && strings(buyer.channels);
      });
  } catch (error) {
    console.error(`[OwnerCopilot] ${taskName} failed: ${error instanceof Error ? error.message : error}`);
  }
  const tag = aiStatus === "real" ? "" : ` (${aiStatus === "fallback" ? "fallback" : "sample"} analysis)`;
  const text = !usable
    ? lang === "hi" ? "उपयोगी विश्लेषण नहीं मिला। कोई जानकारी नहीं बदली। नया अनुरोध करके फिर पुष्टि करें।" : "A usable analysis was not available. No company information was changed. Make a new request and confirm it to try again."
    : taskName === "embedding"
      ? `Text preparation${tag}:\n${findings.preparedText}\nA separate embedding provider is still needed (${findings.embeddingModelNeeded}). No vector embedding was generated or saved.`
      : `Product application suggestions${tag} — unverified analysis; no web sources were checked:\nApplications:\n${(findings.applications as string[]).map(value => `• ${value}`).join("\n")}\nPossible buyers:\n${(findings.buyerSegments as {segment: string; why: string; channels: string[]}[]).map(value => `• ${value.segment}: ${value.why}${value.channels.length ? `; suggested channels: ${value.channels.join(", ")}` : ""}`).join("\n")}\n${findings.marketNotes}\nReview these suggestions before using them. No approved company facts were changed.`;
  await new AuditLogService(repos).logAuditEvent({ workspaceId: input.workspaceId, userId: input.ownerUserId, action: "copilot.research_run", newValuesJson: { taskName, aiStatus, usable, webSourcesChecked: false, vectorGenerated: false } });
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T3", intent }, "copilot_info");
  return { text, language: lang, tier: "T3", intent, kind: "copilot_info", aiStatus };
}

// ─── CP-5/CP-11: save a captured fact as an Information Needed card ─────────
/**
 * When the owner accepts the "save this fact?" offer (from a T1 empty-KB answer
 * or a T2 below-standard-price reveal), capture it as an UnknownQuestion
 * (Information Needed). CP-5: NEVER silently write to the KB — this creates a
 * CARD for the owner to fill in + approve, not a finished KB fact.
 */
export async function saveCopilotFact(input: {
  workspaceId: string;
  ownerUserId: string;
  conversationId: string;
  /** The question / fact the owner wants to capture. */
  questionText: string;
  /** An optional topic key (e.g. "credit_policy") for grouping. */
  missingTopic?: string;
  leadId?: string;
  repos?: RepositoryBundle;
}): Promise<CopilotResponse> {
  const repos = input.repos || createRepositories();
  const lang = "en" as "en" | "hi";

  // CP-5: create an Information Needed CARD (UnknownQuestion), NOT a KB fact.
  const uq = await repos.unknownQuestion.create(input.workspaceId, {
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    conversationId: input.conversationId,
    channel: "copilot",
    questionText: input.questionText,
    missingTopic: input.missingTopic,
    status: "open",
    generatedBy: "user",
    priority: "medium",
  });

  await new AuditLogService(repos).logAuditEvent({
    workspaceId: input.workspaceId,
    userId: input.ownerUserId,
    action: "copilot.fact_offered",
    entityType: "unknown_question",
    entityId: uq.id,
    newValuesJson: { questionText: input.questionText, missingTopic: input.missingTopic, status: "open" },
  });

  // Persist the owner's accept "message" (audit trail).
  await repos.ownerCopilotMessage.create({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    role: "owner",
    kind: "owner_input",
    text: `[accepted save-fact: ${input.questionText}]`,
    language: lang,
    tier: "T1",
  });

  const text = lang === "hi"
    ? `सहेजा गया — "Information Needed" कार्ड बना। जब आप उत्तर भरेंगे, मैं इसे नॉलेज बेस में जोड़ दूँगा और फिर कभी नहीं पूछूँगा।`
    : `Saved — created an "Information Needed" card. When you fill in the answer, I'll add it to the Knowledge Base and never ask again.`;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, { tier: "T1", intent: "save_fact" }, "copilot_action_done", { intent: "save_fact", entityId: uq.id, entityType: "unknown_question" });
  return { text, language: lang, tier: "T1", intent: "save_fact", kind: "copilot_action_done", pendingAction: { intent: "save_fact", entityId: uq.id, entityType: "unknown_question" }, aiStatus: "none" };
}

/** Helper: persist the copilot's reply (the audit trail). */
// ─── N8: the master agent ───────────────────────────────────────────────────
/**
 * Ask the master agent for a plan and show it. Nothing runs yet: the owner sees
 * who will do what and the most it can cost, and confirms or ignores it.
 */
async function proposeOrchestratedJob(
  repos: RepositoryBundle,
  input: { workspaceId: string; conversationId: string; ownerText: string; orchestrationSeams?: import("@/services/OrchestrationService").OrchestrationSeams },
  lang: "en" | "hi",
  classified: CopilotIntent,
): Promise<CopilotResponse> {
  const { proposeJob, describePlan } = await import("@/services/OrchestrationService");
  let text: string;
  let pendingAction: { intent: string; entityId: string; entityType: PendingEntityType } | undefined;
  try {
    const job = await proposeJob({ workspaceId: input.workspaceId, goal: input.ownerText, conversationId: input.conversationId, repos, seams: input.orchestrationSeams });
    text = describePlan(job);
    // Only a plan that passed the checks gets a Confirm button.
    // The entity type is what makes the chat draw a "Yes, run it" button. The
    // first version left it out, and a valid plan appeared with no way to run
    // it — found in the browser, not by any test.
    if (job.status === "awaiting_confirmation") pendingAction = { intent: "orchestrated_job", entityId: job.jobId, entityType: "orchestration_job" };
  } catch (error) {
    text = error instanceof Error ? error.message : "I could not plan that.";
  }
  const kind = pendingAction ? "copilot_confirm" : "copilot_info";
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, kind, pendingAction);
  return { text, language: lang, tier: classified.tier, intent: classified.intent, kind, pendingAction, aiStatus: "none" };
}

/** The owner said yes: run exactly the plan they saw, once. */
async function runOrchestratedJob(
  repos: RepositoryBundle,
  input: { workspaceId: string; conversationId: string; pendingActionId: string },
  lang: "en" | "hi",
): Promise<CopilotResponse> {
  const { runJob } = await import("@/services/OrchestrationService");
  const classified: CopilotIntent = { tier: "T3", intent: "orchestrated_job" };
  const outcome = await runJob({ workspaceId: input.workspaceId, jobId: input.pendingActionId, repos });
  const text = outcome.ran ? outcome.text : outcome.reason;
  await persistCopilotMessage(repos, input.workspaceId, input.conversationId, text, lang, classified, "copilot_info");
  return { text, language: lang, tier: "T3", intent: "orchestrated_job", kind: "copilot_info",
    // Not "real": each helper may have run on a real provider or fallen back,
    // and this one flag cannot say which. The per-task lines in the text can.
    aiStatus: "none" };
}

async function persistCopilotMessage(
  repos: RepositoryBundle,
  workspaceId: string,
  conversationId: string,
  text: string,
  language: "en" | "hi",
  classified: CopilotIntent,
  kind: OwnerCopilotMessage["kind"],
  pendingAction?: OwnerCopilotMessage["pendingAction"],
) {
  await repos.ownerCopilotMessage.create({
    workspaceId,
    conversationId,
    role: "copilot",
    kind,
    text,
    language,
    tier: classified.tier,
    pendingAction,
  });
}

/** Public re-export for type-only consumers (keeps the import surface tidy). */
export { TIERS_WITH_DANGER };
