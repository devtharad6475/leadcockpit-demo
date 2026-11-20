import type { CommunicationSettings, JsonRecord, PolicySettings, SalesSettings } from "@/lib/types";

type DraftArea = "sales" | "policy" | "communication";

type DraftTarget = {
  area: DraftArea;
  fieldKey: string;
  label: string;
  inputType?: "text" | "textarea" | "list";
};

const questionToDraftTargets: Array<{ domainKey: string; questionKey: string; target: DraftTarget }> = [
  { domainKey: "product_varieties", questionKey: "minimum_quantities_by_variety", target: { area: "sales", fieldKey: "defaultMOQ", label: "Default MOQ" } },
  { domainKey: "payment_credit_terms", questionKey: "credit_period", target: { area: "sales", fieldKey: "standardCreditPeriod", label: "Credit period" } },
  { domainKey: "payment_credit_terms", questionKey: "gst_quotation_validity", target: { area: "sales", fieldKey: "quotationValidity", label: "Quotation validity" } },
  { domainKey: "payment_credit_terms", questionKey: "advance_payment_rule", target: { area: "sales", fieldKey: "advancePaymentRule", label: "Advance payment rule" } },
  { domainKey: "samples_catalogue_quotation_rules", questionKey: "sample_available", target: { area: "sales", fieldKey: "sampleAvailability", label: "Sample availability" } },
  { domainKey: "samples_catalogue_quotation_rules", questionKey: "bulk_order_rule", target: { area: "sales", fieldKey: "bulkOrderRule", label: "Bulk order rule" } },
  { domainKey: "lead_qualification", questionKey: "mql_rules", target: { area: "sales", fieldKey: "leadQualificationThresholds", label: "Lead qualification thresholds", inputType: "textarea" } },
  { domainKey: "lead_qualification", questionKey: "hot_lead_signals", target: { area: "sales", fieldKey: "humanReviewTriggers", label: "Human review triggers", inputType: "textarea" } },
  { domainKey: "pricing_policy", questionKey: "pricing_structure", target: { area: "sales", fieldKey: "priceDiscussionRule", label: "Price discussion rule", inputType: "textarea" } },
  { domainKey: "pricing_policy", questionKey: "discount_policy", target: { area: "sales", fieldKey: "discountNegotiationRules", label: "Discount and negotiation rules", inputType: "textarea" } },
  { domainKey: "payment_credit_terms", questionKey: "payment_methods", target: { area: "policy", fieldKey: "paymentPolicy", label: "Payment policy", inputType: "textarea" } },
  { domainKey: "payment_credit_terms", questionKey: "credit_allowed", target: { area: "policy", fieldKey: "creditPolicy", label: "Credit policy", inputType: "textarea" } },
  { domainKey: "shipping_delivery", questionKey: "delivery_timelines", target: { area: "policy", fieldKey: "shippingDeliveryPolicy", label: "Shipping and delivery policy", inputType: "textarea" } },
  { domainKey: "returns_replacement", questionKey: "return_allowed", target: { area: "policy", fieldKey: "returnReplacementPolicy", label: "Return and replacement policy", inputType: "textarea" } },
  { domainKey: "returns_replacement", questionKey: "cancellation_policy", target: { area: "policy", fieldKey: "cancellationPolicy", label: "Cancellation policy", inputType: "textarea" } },
  { domainKey: "customization", questionKey: "customization_available", target: { area: "policy", fieldKey: "customizationPolicy", label: "Customization policy", inputType: "textarea" } },
  { domainKey: "samples_catalogue_quotation_rules", questionKey: "catalogue_available", target: { area: "policy", fieldKey: "samplePolicy", label: "Sample and catalogue policy", inputType: "textarea" } },
  { domainKey: "whatsapp_communication", questionKey: "preferred_tone", target: { area: "communication", fieldKey: "tone", label: "Communication tone" } },
  { domainKey: "whatsapp_communication", questionKey: "unknown_answer_reply", target: { area: "communication", fieldKey: "defaultFallbackReply", label: "Default fallback reply", inputType: "textarea" } },
  { domainKey: "whatsapp_communication", questionKey: "auto_reply_boundaries", target: { area: "communication", fieldKey: "allowedAutoReplyTopics", label: "Allowed auto-reply topics", inputType: "list" } },
  { domainKey: "whatsapp_communication", questionKey: "abusive_customer_handling", target: { area: "communication", fieldKey: "abusiveMessageRule", label: "Abusive message rule", inputType: "text" } },
  { domainKey: "pricing_policy", questionKey: "price_faq", target: { area: "communication", fieldKey: "priceReplyRule", label: "Price reply rule", inputType: "textarea" } },
  { domainKey: "payment_credit_terms", questionKey: "credit_eligibility", target: { area: "communication", fieldKey: "creditPaymentReplyRule", label: "Credit/payment reply rule", inputType: "textarea" } },
  { domainKey: "returns_replacement", questionKey: "complaint_escalation", target: { area: "communication", fieldKey: "complaintReplyRule", label: "Complaint reply rule", inputType: "textarea" } },
  { domainKey: "whatsapp_communication", questionKey: "language_preferences", target: { area: "communication", fieldKey: "unknownAnswerBehavior", label: "Unknown-answer behavior", inputType: "textarea" } },
  { domainKey: "whatsapp_communication", questionKey: "stop_unsubscribe_handling", target: { area: "communication", fieldKey: "stopUnsubscribeBehavior", label: "Stop and unsubscribe behavior", inputType: "textarea" } },
];

export type StructuredSettingsDraftResult = {
  sales: Partial<SalesSettings>;
  policy: Partial<PolicySettings>;
  communication: Partial<CommunicationSettings>;
  fields: Array<DraftTarget & { value: string | string[] }>;
  warnings: string[];
};

export function draftStructuredSettingsFromAnswer(input: { domainKey?: string; relatedQuestionKeys?: string[]; answer: string }): StructuredSettingsDraftResult {
  const answer = input.answer.trim();
  const result: StructuredSettingsDraftResult = { sales: {}, policy: {}, communication: {}, fields: [], warnings: [] };
  if (!answer) {
    result.warnings.push("Write an answer before creating settings drafts.");
    return result;
  }

  const relatedQuestionKeys = input.relatedQuestionKeys || [];
  let targets = questionToDraftTargets
    .filter((mapping) => mapping.domainKey === input.domainKey && (!relatedQuestionKeys.length || relatedQuestionKeys.includes(mapping.questionKey)))
    .map((mapping) => mapping.target);

  if (!targets.length && input.domainKey) {
    targets = questionToDraftTargets
      .filter((mapping) => mapping.domainKey === input.domainKey)
      .map((mapping) => mapping.target);
  }

  const uniqueTargets = new Map<string, DraftTarget>();
  for (const target of targets) uniqueTargets.set(`${target.area}.${target.fieldKey}`, target);

  for (const target of uniqueTargets.values()) {
    const value = target.inputType === "list" ? [answer] : answer;
    (result[target.area] as JsonRecord)[target.fieldKey] = value;
    result.fields.push({ ...target, value });
  }

  if (!result.fields.length) {
    result.warnings.push("This answer does not map to a structured Sales, Policy, or Communication setting yet. It is still saved in Knowledge Base and the internal framework.");
  }

  return result;
}
