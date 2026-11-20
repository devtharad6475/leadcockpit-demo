import { getKnowledgeQuestion } from "@/knowledge/knowledge-question-framework";
import { timestamp, uid } from "@/lib/db";
import type { JsonRecord, KnowledgeQuestionAnswer, ProductSetting, ProductSettings } from "@/lib/types";
import { createRepositories, type RepositoryBundle } from "@/repositories";

type StructuredSettingsInput = {
  sales?: JsonRecord;
  product?: ProductSettings | JsonRecord;
  policy?: JsonRecord;
  communication?: JsonRecord;
};

/**
 * Settings field -> the question keys that mean the same thing.
 *
 * Exported since N-AI-3 (2026-08-18): this is the only place in the codebase
 * that records WHICH QUESTIONS DESCRIBE THE SAME REAL-WORLD FACT, so
 * `knowledge-fact-groups.ts` derives cross-question contradiction detection
 * from it instead of maintaining a second copy that would drift.
 *
 * Keep this table NARROW. It is a WRITE path — `syncStructuredSettingsToQuestions`
 * overwrites the answer of every question key listed here. Same-fact siblings
 * that must be compared but must NOT be overwritten belong in that module's
 * extras table, not here.
 */
export const mappings: Array<{ area: keyof StructuredSettingsInput; field: string; domainKey: string; questionKeys: string[]; label: string }> = [
  { area: "sales", field: "defaultMOQ", domainKey: "product_varieties", questionKeys: ["minimum_quantities_by_variety", "deep_06_variant_specific_moq_or_pack_size_rules"], label: "Default MOQ" },
  { area: "sales", field: "standardCreditPeriod", domainKey: "payment_credit_terms", questionKeys: ["credit_period", "credit_allowed", "credit_eligibility"], label: "Credit period" },
  { area: "sales", field: "quotationValidity", domainKey: "payment_credit_terms", questionKeys: ["gst_quotation_validity", "deep_08_quotation_validity_period"], label: "Quotation validity" },
  { area: "sales", field: "advancePaymentRule", domainKey: "payment_credit_terms", questionKeys: ["advance_payment_rule"], label: "Advance payment rule" },
  { area: "sales", field: "sampleAvailability", domainKey: "samples_catalogue_quotation_rules", questionKeys: ["sample_available", "sample_charges"], label: "Sample availability" },
  { area: "sales", field: "bulkOrderRule", domainKey: "samples_catalogue_quotation_rules", questionKeys: ["bulk_order_rule"], label: "Bulk order rule" },
  { area: "sales", field: "leadQualificationThresholds", domainKey: "lead_qualification", questionKeys: ["mql_rules", "sql_rules", "hot_lead_signals"], label: "Lead qualification thresholds" },
  { area: "sales", field: "humanReviewTriggers", domainKey: "lead_qualification", questionKeys: ["hot_lead_signals"], label: "Human review triggers" },
  { area: "sales", field: "priceDiscussionRule", domainKey: "pricing_policy", questionKeys: ["pricing_structure", "price_faq"], label: "Price discussion rule" },
  { area: "sales", field: "discountNegotiationRules", domainKey: "pricing_policy", questionKeys: ["discount_policy"], label: "Discount and negotiation rules" },
  { area: "policy", field: "paymentPolicy", domainKey: "payment_credit_terms", questionKeys: ["payment_methods", "advance_payment_rule", "credit_allowed"], label: "Payment policy" },
  { area: "policy", field: "creditPolicy", domainKey: "payment_credit_terms", questionKeys: ["credit_period", "credit_allowed", "credit_eligibility"], label: "Credit policy" },
  { area: "policy", field: "shippingDeliveryPolicy", domainKey: "shipping_delivery", questionKeys: ["delivery_timelines", "shipping_charges", "delivery_geography_rules"], label: "Shipping and delivery policy" },
  { area: "policy", field: "returnReplacementPolicy", domainKey: "returns_replacement", questionKeys: ["return_allowed", "replacement_policy", "refund_policy"], label: "Return and replacement policy" },
  { area: "policy", field: "cancellationPolicy", domainKey: "returns_replacement", questionKeys: ["cancellation_policy"], label: "Cancellation policy" },
  { area: "policy", field: "customizationPolicy", domainKey: "customization", questionKeys: ["customization_available", "customization_options", "custom_order_requirements"], label: "Customization policy" },
  { area: "policy", field: "samplePolicy", domainKey: "samples_catalogue_quotation_rules", questionKeys: ["sample_available", "sample_charges", "catalogue_available"], label: "Sample and catalogue policy" },
  { area: "communication", field: "tone", domainKey: "whatsapp_communication", questionKeys: ["preferred_tone", "greeting_style", "language_preferences"], label: "Communication tone" },
  { area: "communication", field: "defaultFallbackReply", domainKey: "whatsapp_communication", questionKeys: ["unknown_answer_reply"], label: "Unknown-answer reply" },
  { area: "communication", field: "allowedAutoReplyTopics", domainKey: "whatsapp_communication", questionKeys: ["auto_reply_boundaries"], label: "Allowed auto-reply topics" },
  { area: "communication", field: "humanReviewRequiredTopics", domainKey: "whatsapp_communication", questionKeys: ["auto_reply_boundaries"], label: "Human-review-required topics" },
  { area: "communication", field: "abusiveMessageRule", domainKey: "whatsapp_communication", questionKeys: ["abusive_customer_handling"], label: "Abusive message rule" },
  { area: "communication", field: "priceReplyRule", domainKey: "pricing_policy", questionKeys: ["price_faq"], label: "Price reply rule" },
  { area: "communication", field: "creditPaymentReplyRule", domainKey: "payment_credit_terms", questionKeys: ["credit_eligibility"], label: "Credit and payment reply rule" },
  { area: "communication", field: "complaintReplyRule", domainKey: "returns_replacement", questionKeys: ["complaint_escalation"], label: "Complaint reply rule" },
  { area: "communication", field: "unknownAnswerBehavior", domainKey: "whatsapp_communication", questionKeys: ["language_preferences"], label: "Unknown-answer behavior" },
  { area: "communication", field: "stopUnsubscribeBehavior", domainKey: "whatsapp_communication", questionKeys: ["stop_unsubscribe_handling"], label: "Stop and unsubscribe behavior" },
];

const productMappings: Array<{ domainKey: string; questionKeys: string[]; label: string; buildAnswer: (products: ProductSetting[]) => string }> = [
  {
    domainKey: "product_knowledge",
    questionKeys: ["main_products", "product_categories"],
    label: "Product range",
    buildAnswer: (products) => {
      if (!products.length) return "";
      const lines = products.map((p) => {
        const parts = [p.name, p.category].filter(Boolean);
        return parts.join(" — ");
      });
      return `Product range: ${lines.join("; ")}`;
    },
  },
  {
    domainKey: "product_knowledge",
    questionKeys: ["product_features", "deep_01_materials_or_ingredients_used_in_each_product", "deep_02_technical_specifications_dimensions_counts_weights_or"],
    label: "Product material and specs",
    buildAnswer: (products) => {
      if (!products.length) return "";
      const lines = products.map((p) => {
        const parts: string[] = [];
        if (p.material) parts.push(`Material: ${p.material}`);
        if (p.sizeSpec) parts.push(`Size: ${p.sizeSpec}`);
        if (p.packaging) parts.push(`Packaging: ${p.packaging}`);
        if (p.moq) parts.push(`MOQ: ${p.moq}`);
        if (!parts.length) return "";
        return `${p.name}: ${parts.join(", ")}`;
      }).filter(Boolean);
      return lines.length ? `Product specs: ${lines.join("; ")}` : "";
    },
  },
  {
    domainKey: "shipping_delivery",
    questionKeys: ["delivery_timelines", "tracking_policy", "urgent_delivery"],
    label: "Dispatch time",
    buildAnswer: (products) => {
      if (!products.length) return "";
      const lines = products.map((p) => {
        const parts: string[] = [];
        if (p.inStockDispatchTime) parts.push(`In-stock: ${p.inStockDispatchTime}`);
        if (p.productionDispatchTime) parts.push(`Production: ${p.productionDispatchTime}`);
        if (!parts.length) return "";
        return `${p.name}: ${parts.join(", ")}`;
      }).filter(Boolean);
      return lines.length ? `Dispatch times: ${lines.join("; ")}` : "";
    },
  },
  {
    domainKey: "customization",
    questionKeys: ["customization_available", "customization_options", "custom_order_requirements"],
    label: "Customization rule",
    buildAnswer: (products) => {
      if (!products.length) return "";
      const customizable = products.filter((p) => p.customizationAvailable);
      if (!customizable.length) return "Customization: Not available for any listed product.";
      return `Customization available for: ${customizable.map((p) => p.name).join(", ")}. ${customizable.map((p) => p.notes).filter(Boolean).join(" ")}`;
    },
  },
  {
    domainKey: "product_varieties",
    questionKeys: ["minimum_quantities_by_variety"],
    label: "Product-wise MOQ",
    buildAnswer: (products) => {
      if (!products.length) return "";
      const lines = products.map((p) => (p.moq ? `${p.name}: ${p.moq}` : "")).filter(Boolean);
      return lines.length ? `Product-wise MOQ: ${lines.join("; ")}` : "";
    },
  },
];

export async function syncStructuredSettingsToQuestions(workspaceId: string, settings: StructuredSettingsInput, repos: RepositoryBundle = createRepositories()) {
  const now = timestamp();
  return repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.auditLogs ||= [];
    let updated = 0;
    const skipped: string[] = [];

    // Standard field mappings (sales, policy, communication)
    for (const mapping of mappings) {
      const areaSettings = settings[mapping.area];
      if (!areaSettings || mapping.area === "product") continue;
      const value = (areaSettings as JsonRecord)[mapping.field];
      const answer = formatSettingAnswer(mapping.label, value);
      if (!answer) continue;
      for (const questionKey of mapping.questionKeys) {
        const frameworkQuestion = getKnowledgeQuestion(mapping.domainKey, questionKey);
        if (!frameworkQuestion) {
          skipped.push(`${mapping.domainKey}/${questionKey}`);
          continue;
        }
        const existing = data.knowledgeQuestionAnswers.find((item) => item.workspaceId === workspaceId && item.domainKey === mapping.domainKey && item.questionKey === questionKey);
        const evidence = {
          sourceType: "user_answer" as const,
          sourceId: `structured_settings:${mapping.area}.${mapping.field}`,
          sourceTitle: `${mapping.label} setting`,
          sourceSnippet: answer,
          confidenceScore: 1,
          answer,
          createdAt: now,
        };
        if (existing?.isUserApproved && existing.answer?.trim() && answersConflict(existing.answer, answer)) {
          existing.answerStatus = "conflict";
          existing.conflictWithExisting = true;
          existing.conflictReason = `Structured setting "${answer}" conflicts with approved answer "${existing.answer}".`;
          existing.evidenceJson = { sources: [...(existing.evidenceJson?.sources || []), evidence] };
          existing.updatedAt = now;
          updated += 1;
          continue;
        }
        const payload: KnowledgeQuestionAnswer = {
          id: existing?.id || uid("kqa"),
          workspaceId,
          domainKey: mapping.domainKey,
          questionKey,
          question: frameworkQuestion.question,
          answer,
          answerStatus: "answered",
          sourceType: "user_answer",
          sourceId: `structured_settings:${mapping.area}.${mapping.field}`,
          sourceTitle: `${mapping.label} setting`,
          confidenceScore: 1,
          usedByAgentsJson: { values: frameworkQuestion.usedByAgents },
          mapsToJson: { values: frameworkQuestion.mapsTo },
          humanReviewRequired: frameworkQuestion.humanReviewRequired,
          sourceSnippet: answer,
          isUserApproved: true,
          reviewedByUser: "user_owner",
          reviewedAt: now,
          isCanonical: true,
          evidenceJson: { sources: [...(existing?.evidenceJson?.sources || []), evidence] },
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        if (existing) Object.assign(existing, payload);
        else data.knowledgeQuestionAnswers.push(payload);
        updated += 1;
      }
    }

    // Product-specific mappings from ProductSettings.products array
    const productSettings = settings.product as ProductSettings | undefined;
    const products = productSettings?.products || [];
    if (products.length) {
      for (const mapping of productMappings) {
        const answer = mapping.buildAnswer(products);
        if (!answer) continue;
        for (const questionKey of mapping.questionKeys) {
          const frameworkQuestion = getKnowledgeQuestion(mapping.domainKey, questionKey);
          if (!frameworkQuestion) {
            skipped.push(`${mapping.domainKey}/${questionKey}`);
            continue;
          }
          const existing = data.knowledgeQuestionAnswers.find((item) => item.workspaceId === workspaceId && item.domainKey === mapping.domainKey && item.questionKey === questionKey);
          const evidence = {
            sourceType: "user_answer" as const,
            sourceId: `structured_settings:product.${mapping.label}`,
            sourceTitle: `${mapping.label} setting`,
            sourceSnippet: answer,
            confidenceScore: 1,
            answer,
            createdAt: now,
          };
          if (existing?.isUserApproved && existing.answer?.trim() && answersConflict(existing.answer, answer)) {
            existing.answerStatus = "conflict";
            existing.conflictWithExisting = true;
            existing.conflictReason = `Structured setting "${answer}" conflicts with approved answer "${existing.answer}".`;
            existing.evidenceJson = { sources: [...(existing.evidenceJson?.sources || []), evidence] };
            existing.updatedAt = now;
            updated += 1;
            continue;
          }
          const payload: KnowledgeQuestionAnswer = {
            id: existing?.id || uid("kqa"),
            workspaceId,
            domainKey: mapping.domainKey,
            questionKey,
            question: frameworkQuestion.question,
            answer,
            answerStatus: "answered",
            sourceType: "user_answer",
            sourceId: `structured_settings:product.${mapping.label}`,
            sourceTitle: `${mapping.label} setting`,
            confidenceScore: 1,
            usedByAgentsJson: { values: frameworkQuestion.usedByAgents },
            mapsToJson: { values: frameworkQuestion.mapsTo },
            humanReviewRequired: frameworkQuestion.humanReviewRequired,
            sourceSnippet: answer,
            isUserApproved: true,
            reviewedByUser: "user_owner",
            reviewedAt: now,
            isCanonical: true,
            evidenceJson: { sources: [...(existing?.evidenceJson?.sources || []), evidence] },
            createdAt: existing?.createdAt || now,
            updatedAt: now,
          };
          if (existing) Object.assign(existing, payload);
          else data.knowledgeQuestionAnswers.push(payload);
          updated += 1;
        }
      }
    }

    data.auditLogs.push({
      id: uid("audit"),
      workspaceId,
      actorUserId: "user_owner",
      eventType: "structured_settings.synced_to_questions",
      entityType: "knowledge_question_answer",
      payload: { updated, skipped },
      createdAt: now,
      updatedAt: now,
    });
    return { status: "synced", updatedAnswers: updated, skippedMappings: skipped };
  });
}

/**
 * The business profile's identity fields -> the question keys that hold the
 * same fact.
 *
 * Session 55: this is the mirror of `questionToProfileMappings` in
 * ExtractionRoutingService, which routes extracted ANSWERS into the PROFILE.
 * Nothing routed the other way. So the Profile screen could say one thing and
 * the answers the agent quotes another, indefinitely, with nothing comparing
 * them.
 *
 * Observed live on the demo: the Profile screen read "Om Jari & Metallic",
 * "omjari.in", "sales@omjari.in", while `factual_company_profile/
 * legal_company_name` still held "TechNova Solutions", `website`
 * "technovasolutions.com" and `email` "contact@technovasolutions.com" — left
 * over from an earlier extraction. No conflict card was ever raised because no
 * code path put the two beside each other. The agent introduces the company by
 * the knowledge answer, so the product was ready to tell a real customer the
 * wrong company name.
 *
 * Kept to identity only, and deliberately narrow: these are facts the owner
 * types into a form and can see, not judgements. The same key list is used by
 * ExtractionRoutingService in the other direction.
 */
const profileToQuestionMappings: Array<{ field: ProfileIdentityField; domainKey: string; questionKeys: string[]; label: string }> = [
  { field: "companyName", domainKey: "factual_company_profile", questionKeys: ["legal_company_name"], label: "Company name" },
  { field: "industry", domainKey: "factual_company_profile", questionKeys: ["industry"], label: "Industry" },
  { field: "websiteUrl", domainKey: "factual_company_profile", questionKeys: ["website"], label: "Website" },
  { field: "contactEmail", domainKey: "factual_company_profile", questionKeys: ["email"], label: "Contact email" },
  { field: "contactPhone", domainKey: "factual_company_profile", questionKeys: ["phone_whatsapp"], label: "Contact phone" },
  { field: "address", domainKey: "factual_company_profile", questionKeys: ["address_location"], label: "Address" },
  { field: "businessType", domainKey: "company_knowledge", questionKeys: ["business_type"], label: "Business type" },
  { field: "description", domainKey: "company_knowledge", questionKeys: ["company_overview"], label: "Description" },
];

type ProfileIdentityField =
  | "companyName" | "industry" | "websiteUrl" | "contactEmail"
  | "contactPhone" | "address" | "businessType" | "description";

export type ProfileQuestionSyncResult = {
  status: "synced";
  updatedAnswers: number;
  conflicts: number;
  skippedMappings: string[];
};

/**
 * Push the owner's own profile into the answers the agent quotes.
 *
 * The profile is what the owner typed and can see on screen, so it wins over a
 * stale extraction — but never silently over an answer the owner separately
 * approved. That case becomes a `conflict`, exactly as
 * `syncStructuredSettingsToQuestions` does, so the disagreement is surfaced as
 * a decision rather than resolved by whichever code ran last.
 */
export async function syncBusinessProfileToQuestions(
  workspaceId: string,
  profile: Partial<Record<ProfileIdentityField, string | undefined>>,
  repos: RepositoryBundle = createRepositories(),
): Promise<ProfileQuestionSyncResult> {
  const now = timestamp();
  return repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.auditLogs ||= [];
    let updated = 0;
    let conflicts = 0;
    const skipped: string[] = [];

    for (const mapping of profileToQuestionMappings) {
      const raw = profile[mapping.field];
      const value = typeof raw === "string" ? raw.trim() : "";
      // An empty profile field is "not filled in", not "the answer is blank".
      // It must never erase an answer that came from somewhere else.
      if (!value) continue;
      const answer = `${mapping.label}: ${value}`;

      for (const questionKey of mapping.questionKeys) {
        const frameworkQuestion = getKnowledgeQuestion(mapping.domainKey, questionKey);
        if (!frameworkQuestion) {
          skipped.push(`${mapping.domainKey}/${questionKey}`);
          continue;
        }
        const existing = data.knowledgeQuestionAnswers.find((item) =>
          item.workspaceId === workspaceId && item.domainKey === mapping.domainKey && item.questionKey === questionKey);
        const evidence = {
          sourceType: "user_answer" as const,
          sourceId: `business_profile:${mapping.field}`,
          sourceTitle: `${mapping.label} on the business profile`,
          sourceSnippet: answer,
          confidenceScore: 1,
          answer,
          createdAt: now,
        };

        if (existing?.isUserApproved && existing.answer?.trim() && answersConflict(existing.answer, answer)) {
          existing.answerStatus = "conflict";
          existing.conflictWithExisting = true;
          existing.conflictReason = `The business profile says "${value}", which conflicts with the approved answer "${existing.answer}".`;
          existing.evidenceJson = { sources: [...(existing.evidenceJson?.sources || []), evidence] };
          existing.updatedAt = now;
          conflicts += 1;
          continue;
        }

        const payload: KnowledgeQuestionAnswer = {
          id: existing?.id || uid("kqa"),
          workspaceId,
          domainKey: mapping.domainKey,
          questionKey,
          question: frameworkQuestion.question,
          answer,
          answerStatus: "answered",
          sourceType: "user_answer",
          sourceId: `business_profile:${mapping.field}`,
          sourceTitle: `${mapping.label} on the business profile`,
          confidenceScore: 1,
          usedByAgentsJson: { values: frameworkQuestion.usedByAgents },
          mapsToJson: { values: frameworkQuestion.mapsTo },
          humanReviewRequired: frameworkQuestion.humanReviewRequired,
          sourceSnippet: answer,
          isUserApproved: true,
          reviewedByUser: "user_owner",
          reviewedAt: now,
          isCanonical: true,
          evidenceJson: { sources: [...(existing?.evidenceJson?.sources || []), evidence] },
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        if (existing) Object.assign(existing, payload);
        else data.knowledgeQuestionAnswers.push(payload);
        updated += 1;
      }
    }

    data.auditLogs.push({
      id: uid("audit"),
      workspaceId,
      actorUserId: "user_owner",
      eventType: "business_profile.synced_to_questions",
      entityType: "knowledge_question_answer",
      payload: { updated, conflicts, skipped },
      createdAt: now,
      updatedAt: now,
    });
    return { status: "synced" as const, updatedAnswers: updated, conflicts, skippedMappings: skipped };
  });
}

function formatSettingAnswer(label: string, value: unknown) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => String(item).trim()).filter(Boolean);
    return cleaned.length ? `${label}: ${cleaned.join(", ")}` : "";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonRecord).filter(([, item]) => item !== undefined && item !== null && String(item).trim());
    return entries.length ? `${label}: ${entries.map(([key, item]) => `${key} = ${String(item)}`).join("; ")}` : "";
  }
  const text = String(value).trim();
  return text ? `${label}: ${text}` : "";
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function answersConflict(existingAnswer: string, settingsAnswer: string) {
  const existing = normalize(existingAnswer);
  const setting = normalize(settingsAnswer);
  if (existing === setting) return false;
  return stripAnswerLabel(existing) !== stripAnswerLabel(setting);
}

function stripAnswerLabel(value: string) {
  let stripped = value.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = stripped.replace(/^[a-z0-9/&() -]{2,60}:\s*/i, "").trim();
    if (next === stripped) break;
    stripped = next;
  }
  return stripped;
}
