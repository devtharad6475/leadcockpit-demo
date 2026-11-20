import { BASE_APPLIES_TO, BUCKET_DOMAINS, CHECKLIST_ADDITIONS, CHECKLIST_DOMAINS, RETIRED_BASE_QUESTIONS } from "./checklist-additions";

export type KnowledgeAnswerType =
  | "short_text"
  | "long_text"
  | "list"
  | "boolean"
  | "number"
  | "date"
  | "policy"
  | "rule"
  | "structured_json"
  // Added for the fixed-choice UI (2026-08-14): a question whose real-world
  // answer is always one of a known, small set of values (e.g. "manufacturer,
  // trader, distributor..."). Rendered as a dropdown instead of free text, so
  // the owner picks instead of types, and the answer can never drift off-topic
  // the way a free-text answer can (see UA-3 in docs/UI-AUDIT-2026-08).
  | "single_choice"
  // Same idea, but more than one value can be true at once (not used by any
  // question yet — reserved for a future case like "which payment methods do
  // you accept").
  | "multi_choice";

export type KnowledgeQuestionPriority = "high" | "medium" | "low";

export type KnowledgeMapTarget =
  | "business_profile"
  | "knowledge_base"
  | "whatsapp_settings"
  | "lead_qualification"
  | "product_research"
  | "campaign_strategy"
  | "agent_instruction";

export type MissingAnswerBehavior = "ask_user" | "optional" | "create_unknown_question" | "human_review";

/**
 * N13 (2026-09-25) — the kinds of business a checklist is built for. A
 * business can be more than one ("Mixed" = manufacturer + trader). Exporting
 * is not a kind: it is an add-on to any of them (see QuestionAppliesTo).
 */
export type BusinessKind = "manufacturer" | "trader" | "retailer" | "service";
export const BUSINESS_KINDS: BusinessKind[] = ["manufacturer", "trader", "retailer", "service"];

/**
 * Which checklists a question is on. `kinds: "goods"` = any kind that sells
 * physical goods (manufacturer, trader, retailer). `exportsOnly` = only when
 * the business exports.
 */
export type QuestionAppliesTo = { kinds: "all" | "goods" | BusinessKind[]; exportsOnly?: boolean };

export type KnowledgeCoreDomainKey =
  | "brand_identity"
  | "products_services"
  | "pricing_moq"
  | "logistics_shipping"
  | "target_market"
  | "compliance_trust"
  | "sales_process"
  | "communication_whatsapp"
  | "lead_qualification"
  | "policies_risk"
  | "campaign_strategy"
  | "analytics_learning";

export type KnowledgeCoreDomain = {
  coreDomainKey: KnowledgeCoreDomainKey;
  coreDomainTitle: string;
  description: string;
};

export type KnowledgeQuestion = {
  questionKey: string;
  question: string;
  description: string;
  whyItMatters: string;
  answerType: KnowledgeAnswerType;
  required: boolean;
  priority: KnowledgeQuestionPriority;
  usedByAgents: string[];
  mapsTo: KnowledgeMapTarget[];
  sensitive: boolean;
  humanReviewRequired: boolean;
  exampleAnswer: string;
  missingAnswerBehavior: MissingAnswerBehavior;
  coreDomainKey: KnowledgeCoreDomainKey;
  coreDomainTitle: string;
  isEssential: boolean;
  // Populated only for answerType "single_choice" / "multi_choice" — the
  // fixed set of values the owner can pick from. Undefined for every other
  // answer type (free text, list, etc).
  options?: string[];
  /** N13: which kinds of business this question applies to. */
  appliesTo: QuestionAppliesTo;
  /**
   * N13: false for catch-all buckets. An empty bucket is not a gap, so it is
   * never counted as missing and never asked; the AI still files leftovers there.
   */
  countsAsMissing: boolean;
};

export type KnowledgeDomain = {
  domainKey: string;
  domainTitle: string;
  description: string;
  questions: KnowledgeQuestion[];
};

type QuestionSpec = [
  key: string,
  question: string,
  answerType: KnowledgeAnswerType,
  required: boolean,
  priority: KnowledgeQuestionPriority,
  mapsTo: KnowledgeMapTarget[],
  humanReviewRequired?: boolean,
  missingAnswerBehavior?: MissingAnswerBehavior,
  exampleAnswer?: string,
  isEssential?: boolean,
  options?: string[],
];

export const KNOWLEDGE_CORE_DOMAINS: KnowledgeCoreDomain[] = [
  { coreDomainKey: "brand_identity", coreDomainTitle: "Brand Identity", description: "What the business is, why buyers should trust it, and how agents should introduce it." },
  { coreDomainKey: "products_services", coreDomainTitle: "Products & Services", description: "What the business sells, important product details, benefits, limits, and use cases." },
  { coreDomainKey: "pricing_moq", coreDomainTitle: "Pricing & MOQ", description: "Pricing structure, minimum order, quotation, payment, credit, tax, and approval boundaries." },
  { coreDomainKey: "logistics_shipping", coreDomainTitle: "Logistics & Shipping", description: "Where the business serves, delivery timelines, dispatch, tracking, returns, and replacements." },
  { coreDomainKey: "target_market", coreDomainTitle: "Target Market", description: "Customer types, buyer segments, geographies, decision makers, and buying triggers." },
  { coreDomainKey: "compliance_trust", coreDomainTitle: "Compliance & Trust", description: "Proof, guarantees, privacy, legal boundaries, certifications, and claims agents must avoid." },
  { coreDomainKey: "sales_process", coreDomainTitle: "Sales Process", description: "How enquiries, quotations, follow-ups, samples, handoffs, and order steps should work." },
  { coreDomainKey: "communication_whatsapp", coreDomainTitle: "Communication & WhatsApp", description: "Tone, language, FAQ behavior, unknown-answer replies, and review rules for customer messages." },
  { coreDomainKey: "lead_qualification", coreDomainTitle: "Lead Qualification", description: "Signals for good-fit leads, bad-fit leads, required lead data, and do-not-contact handling." },
  { coreDomainKey: "policies_risk", coreDomainTitle: "Policies & Risk", description: "Sensitive business rules that must be owner-approved before an agent can rely on them." },
  { coreDomainKey: "campaign_strategy", coreDomainTitle: "Campaign Strategy", description: "Campaign goals, lead sources, search phrases, message angles, and disqualification rules." },
  { coreDomainKey: "analytics_learning", coreDomainTitle: "Analytics & Learning", description: "Success signals, reply intents, quality metrics, and feedback rules for improvement." },
];

const coreDomainTitleByKey = new Map(KNOWLEDGE_CORE_DOMAINS.map((item) => [item.coreDomainKey, item.coreDomainTitle]));

const DOMAIN_TO_CORE_DOMAIN: Record<string, KnowledgeCoreDomainKey> = {
  company_knowledge: "brand_identity",
  factual_company_profile: "brand_identity",
  product_knowledge: "products_services",
  product_varieties: "products_services",
  product_applications: "products_services",
  customer_knowledge: "target_market",
  target_market_geography: "target_market",
  buyer_segments: "target_market",
  lead_qualification: "lead_qualification",
  sales_process: "sales_process",
  whatsapp_communication: "communication_whatsapp",
  faqs: "communication_whatsapp",
  objection_handling: "communication_whatsapp",
  payment_credit_terms: "pricing_moq",
  shipping_delivery: "logistics_shipping",
  returns_replacement: "logistics_shipping",
  customization: "products_services",
  production_manufacturing: "products_services",
  sourcing_stock: "products_services",
  retail_store: "logistics_shipping",
  service_delivery: "products_services",
  export_trade: "logistics_shipping",
  samples_catalogue_quotation_rules: "pricing_moq",
  pricing_policy: "pricing_moq",
  product_research_market_map: "campaign_strategy",
  campaign_strategy_knowledge: "campaign_strategy",
  legal_terms_privacy: "compliance_trust",
  internal_operations: "policies_risk",
  analytics_success_metrics: "analytics_learning",
  extra_unmapped_information: "analytics_learning",
};

const ESSENTIAL_QUESTION_KEYS = new Set<string>([
  "company_knowledge/company_overview",
  "company_knowledge/value_proposition",
  "company_knowledge/core_strengths",
  "company_knowledge/business_type",
  "factual_company_profile/legal_company_name",
  "factual_company_profile/industry",
  "factual_company_profile/phone_whatsapp",
  "product_knowledge/main_products",
  "product_knowledge/product_categories",
  "product_knowledge/product_benefits",
  "product_knowledge/product_limitations",
  "product_varieties/variety_names",
  "product_applications/primary_applications",
  "product_applications/industry_applications",
  "customer_knowledge/current_customer_types",
  "customer_knowledge/ideal_customer_profile",
  "customer_knowledge/customer_pain_points",
  "target_market_geography/serviceable_locations",
  "target_market_geography/priority_locations",
  "buyer_segments/buyer_segment_list",
  "buyer_segments/segment_needs",
  "lead_qualification/mql_rules",
  "lead_qualification/sql_rules",
  "lead_qualification/hot_lead_signals",
  "lead_qualification/reject_rules",
  "lead_qualification/do_not_contact_rules",
  "sales_process/sales_stages",
  "sales_process/first_response_process",
  "sales_process/handoff_to_human",
  "whatsapp_communication/preferred_tone",
  "whatsapp_communication/unknown_answer_reply",
  "whatsapp_communication/auto_reply_boundaries",
  "faqs/price_faq",
  "faqs/delivery_faq",
  "payment_credit_terms/payment_methods",
  "payment_credit_terms/advance_payment_rule",
  "payment_credit_terms/credit_allowed",
  "shipping_delivery/delivery_timelines",
  "returns_replacement/return_allowed",
  "returns_replacement/replacement_policy",
  "samples_catalogue_quotation_rules/catalogue_available",
  "samples_catalogue_quotation_rules/quotation_requirements",
  "pricing_policy/pricing_structure",
  "pricing_policy/moq_policy",
  "pricing_policy/manager_approval_price_cases",
  "campaign_strategy_knowledge/primary_campaign_objective",
  "legal_terms_privacy/privacy_policy",
  "internal_operations/business_hours",
]);

const agentSets = {
  company: ["business_profile_agent", "campaign_planning_agent", "message_generation_agent", "whatsapp_conversation_agent"],
  product: ["product_application_research_agent", "icp_generation_agent", "campaign_planning_agent", "message_generation_agent", "lead_review_agent"],
  customer: ["icp_generation_agent", "prospect_discovery_agent", "lead_review_agent", "lead_scoring_agent", "campaign_planning_agent"],
  // 2026-09-25: auto_reply_review_agent and model_routing_agent removed — no
  // code path ever ran them (see docs/AGENT_RUNTIME_AND_MD_FILES.md).
  communication: ["whatsapp_conversation_agent", "reply_classification_agent", "message_generation_agent"],
  operations: ["whatsapp_conversation_agent", "knowledge_base_agent", "quality_review_agent"],
  analytics: ["campaign_learning_agent", "quality_review_agent"],
};

function q(domainKey: string, spec: QuestionSpec, usedByAgents: string[], description: string, appliesTo: QuestionAppliesTo = BASE_APPLIES_TO[`${domainKey}/${spec[0]}`] || { kinds: "all" }): KnowledgeQuestion {
  const [questionKey, question, answerType, required, priority, mapsTo, humanReviewRequired = false, missingAnswerBehavior, exampleAnswer = "Answer from company knowledge, uploaded documents, website extraction, or user-approved answers.", isEssential = false, options] = spec;
  const coreDomainKey = DOMAIN_TO_CORE_DOMAIN[domainKey] || "brand_identity";
  return {
    questionKey,
    question,
    description,
    whyItMatters: description,
    answerType,
    required,
    priority,
    usedByAgents,
    mapsTo,
    sensitive: domainKey.includes("legal") || domainKey.includes("pricing") || domainKey.includes("payment"),
    humanReviewRequired,
    exampleAnswer,
    missingAnswerBehavior: missingAnswerBehavior || (required ? "ask_user" : "optional"),
    coreDomainKey,
    coreDomainTitle: coreDomainTitleByKey.get(coreDomainKey) || "Business Setup",
    isEssential: isEssential || ESSENTIAL_QUESTION_KEYS.has(`${domainKey}/${questionKey}`),
    options,
    appliesTo,
    countsAsMissing: !BUCKET_DOMAINS.has(domainKey),
  };
}

function domain(domainKey: string, domainTitle: string, description: string, usedByAgents: string[], specs: QuestionSpec[]): KnowledgeDomain {
  return {
    domainKey,
    domainTitle,
    description,
    questions: specs.map((spec) => q(domainKey, spec, usedByAgents, description)),
  };
}

const BASE_KNOWLEDGE_QUESTION_FRAMEWORK: KnowledgeDomain[] = [
  domain("company_knowledge", "Company Knowledge", "Core business story, strengths, trust builders, and positioning used by sales agents.", agentSets.company, [
    ["company_overview", "What does the company do in simple business language?", "long_text", true, "high", ["knowledge_base", "campaign_strategy", "agent_instruction"], false, "ask_user", "We manufacture and supply products for B2B customers across multiple industries."],
    ["value_proposition", "What is the company primary value proposition for buyers?", "long_text", true, "high", ["knowledge_base", "campaign_strategy", "agent_instruction"]],
    ["core_strengths", "What are the company strongest differentiators or trust points?", "list", true, "high", ["knowledge_base", "campaign_strategy"]],
    // Fixed-choice (2026-08-14): free text let a completely off-topic answer
    // (a customer-service SLA paragraph) get stuck as this question's canonical
    // answer for a real workspace — see UA-3 in docs/UI-AUDIT-2026-08. A
    // dropdown with the real allowed values makes that class of bug impossible.
    ["business_type", "Is the company a manufacturer, trader, distributor, service provider, exporter, or mixed business?", "single_choice", true, "high", ["business_profile", "knowledge_base"], false, "ask_user", "Manufacturer", false, ["Manufacturer", "Trader", "Distributor", "Service provider", "Exporter", "Mixed (manufacturer and trader)"]],
    ["years_in_business", "How long has the company been operating?", "short_text", false, "medium", ["business_profile", "knowledge_base"]],
    ["proof_assets", "What proof assets can the company mention, such as factory, showroom, catalogue, certifications, testimonials, or clients?", "list", false, "medium", ["knowledge_base", "campaign_strategy"]],
  ]),
  domain("factual_company_profile", "Factual Company Profile", "Stable identity details that can update the factual Business Profile after review.", agentSets.company, [
    ["legal_company_name", "What is the official company or brand name?", "short_text", true, "high", ["business_profile", "knowledge_base"]],
    ["industry", "What industry or category does the company belong to?", "short_text", true, "high", ["business_profile", "knowledge_base"]],
    ["website", "What is the company website URL?", "short_text", false, "medium", ["business_profile"]],
    ["email", "What email address should customers use?", "short_text", false, "medium", ["business_profile"]],
    ["phone_whatsapp", "What phone or WhatsApp numbers are customer-facing?", "list", false, "medium", ["business_profile", "whatsapp_settings"], true, "human_review"],
    ["address_location", "What is the company address, city, state, and country?", "long_text", false, "medium", ["business_profile", "knowledge_base"]],
  ]),
  domain("product_knowledge", "Product Knowledge", "Products, services, features, benefits, and important product facts.", agentSets.product, [
    ["main_products", "What are the main products or services the company sells?", "list", true, "high", ["knowledge_base", "product_research", "campaign_strategy"]],
    ["product_categories", "What product categories or service categories exist?", "list", true, "high", ["knowledge_base", "product_research"]],
    ["product_features", "What important features, specifications, materials, sizes, or quality details are described?", "list", false, "medium", ["knowledge_base", "product_research"]],
    ["product_benefits", "What customer benefits do these products provide?", "list", true, "high", ["knowledge_base", "campaign_strategy"]],
    ["best_sellers", "Which products are best sellers or priority products for sales conversations?", "list", false, "medium", ["knowledge_base", "campaign_strategy"]],
    ["product_limitations", "Are there any product limitations, unavailable items, or things the agent should not promise?", "list", false, "high", ["knowledge_base", "agent_instruction"], true, "human_review"],
  ]),
  domain("product_varieties", "Product Varieties", "Variants, grades, sizes, colors, models, packages, and customization-ready options.", agentSets.product, [
    ["variety_names", "What varieties, models, grades, designs, colors, or sizes are offered?", "list", true, "high", ["knowledge_base", "product_research"]],
    ["variety_differences", "How do the varieties differ from each other?", "long_text", false, "medium", ["knowledge_base", "product_research"]],
    ["premium_economy_options", "Does the company offer premium, standard, economy, or custom tiers?", "list", false, "medium", ["knowledge_base", "campaign_strategy"]],
    ["stock_availability", "What stock, made-to-order, or availability rules should customers know?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["minimum_quantities_by_variety", "What is the minimum order for each product line, including custom orders?", "structured_json", false, "high", ["knowledge_base", "lead_qualification"], true, "human_review"],
    ["variety_recommendation_rules", "Which variety should be recommended for which customer use case?", "rule", false, "medium", ["knowledge_base", "agent_instruction"]],
  ]),
  domain("product_applications", "Product Applications", "Who uses the product, where it is applied, and what demand situations create buying intent.", agentSets.product, [
    ["primary_applications", "What are the main applications or use cases for the products?", "list", true, "high", ["product_research", "knowledge_base", "campaign_strategy"]],
    ["industry_applications", "Which industries or business types use these products?", "list", true, "high", ["product_research", "campaign_strategy"]],
    ["end_customer_uses", "How do end customers or final users benefit from the product?", "long_text", false, "medium", ["knowledge_base", "campaign_strategy"]],
    ["seasonal_applications", "Are there seasonal, event-driven, or trend-based demand patterns?", "list", false, "medium", ["product_research", "campaign_strategy"]],
    ["application_examples", "What concrete examples of product applications should be used in sales conversations?", "list", false, "medium", ["knowledge_base", "product_research"]],
    ["bad_fit_applications", "Where should the product not be recommended?", "list", false, "high", ["knowledge_base", "agent_instruction"], true, "human_review"],
  ]),
  domain("customer_knowledge", "Customer Knowledge", "Existing customers, ideal customers, buyer psychology, buying triggers, and customer problems.", agentSets.customer, [
    ["current_customer_types", "Who currently buys from the company?", "list", true, "high", ["knowledge_base", "campaign_strategy", "lead_qualification"]],
    ["ideal_customer_profile", "Who is the ideal customer or best-fit buyer?", "long_text", true, "high", ["campaign_strategy", "lead_qualification"]],
    ["customer_pain_points", "What problems or needs make customers contact this company?", "list", true, "high", ["knowledge_base", "campaign_strategy"]],
    ["customer_success_definition", "How do customers define a successful purchase or supplier relationship?", "long_text", false, "medium", ["knowledge_base", "campaign_strategy"]],
    ["bad_fit_customers", "Which customer types are poor fit or should be deprioritized?", "list", false, "high", ["lead_qualification", "agent_instruction"], true, "human_review"],
    ["decision_makers", "Who are the usual decision makers or influencers in the buying process?", "list", false, "medium", ["lead_qualification", "campaign_strategy"]],
  ]),
  domain("target_market_geography", "Target Market / Geography", "Geographies, serviceable locations, export readiness, and regional market focus.", agentSets.customer, [
    ["serviceable_locations", "Which cities, states, countries, or regions does the company serve?", "list", true, "high", ["business_profile", "campaign_strategy", "lead_qualification"]],
    ["priority_locations", "Which geographies should be prioritized for lead generation?", "list", false, "high", ["campaign_strategy", "lead_qualification"]],
    ["export_locations", "Does the company support export or international orders, and where?", "list", false, "medium", ["knowledge_base", "campaign_strategy"], true, "human_review"],
    ["excluded_locations", "Are there locations the company cannot serve or should avoid?", "list", false, "high", ["lead_qualification", "agent_instruction"], true, "human_review"],
    ["regional_language_needs", "Are there language preferences by geography?", "structured_json", false, "medium", ["whatsapp_settings", "agent_instruction"]],
    ["delivery_geography_rules", "Do delivery timelines or costs differ by location?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
  ]),
  domain("buyer_segments", "Buyer Segments", "Target buyer segments such as wholesalers, manufacturers, retailers, designers, distributors, and exporters.", agentSets.customer, [
    ["buyer_segment_list", "Which buyer segments are relevant: wholesaler, manufacturer, exporter, retailer, designer, boutique, distributor, reseller, or others?", "list", true, "high", ["product_research", "campaign_strategy", "lead_qualification"]],
    ["segment_needs", "What does each buyer segment care about most?", "structured_json", true, "high", ["product_research", "campaign_strategy"]],
    ["segment_objections", "What objections or hesitations are common for each segment?", "structured_json", false, "medium", ["knowledge_base", "agent_instruction"]],
    ["segment_search_queries", "What search queries or discovery phrases are useful for each buyer segment?", "structured_json", false, "medium", ["campaign_strategy"]],
    ["segment_qualification_signals", "What signals show that each segment is qualified?", "structured_json", true, "high", ["lead_qualification"]],
    ["segment_message_angles", "What messaging angle should be used for each segment?", "structured_json", false, "medium", ["campaign_strategy", "agent_instruction"]],
  ]),
  domain("lead_qualification", "Lead Qualification", "Rules for deciding whether a lead is worth review, approval, enrichment, outreach, or rejection.", agentSets.customer, [
    ["mql_rules", "What makes a lead a marketing qualified lead for this company?", "rule", true, "high", ["lead_qualification", "campaign_strategy"]],
    ["sql_rules", "What makes a lead sales qualified or ready for human sales follow-up?", "rule", true, "high", ["lead_qualification"]],
    ["hot_lead_signals", "What signals indicate a hot lead?", "list", true, "high", ["lead_qualification"]],
    ["reject_rules", "What rules should reject or deprioritize a lead?", "rule", true, "high", ["lead_qualification"], true, "human_review"],
    ["do_not_contact_rules", "What situations require do-not-contact or unsubscribe handling?", "rule", true, "high", ["lead_qualification", "agent_instruction"], true, "human_review"],
    ["minimum_required_lead_data", "What lead details are required before outreach should be prepared?", "list", false, "medium", ["lead_qualification"]],
  ]),
  domain("sales_process", "Sales Process", "How sales conversations should move from enquiry to qualification, quotation, follow-up, and close.", agentSets.customer, [
    ["sales_stages", "What are the normal sales stages from first enquiry to order?", "list", true, "high", ["knowledge_base", "campaign_strategy"]],
    ["first_response_process", "What should the first response collect or confirm?", "rule", true, "high", ["whatsapp_settings", "agent_instruction"]],
    ["quotation_process", "What information is needed before preparing a quotation?", "list", true, "high", ["lead_qualification", "whatsapp_settings"], true, "human_review"],
    ["follow_up_rules", "When and how should follow-ups happen?", "rule", false, "medium", ["campaign_strategy", "agent_instruction"]],
    ["handoff_to_human", "When should the AI hand off to a human salesperson?", "rule", true, "high", ["agent_instruction", "whatsapp_settings"], true, "human_review"],
    ["sales_documents_to_share", "Which documents can be shared during sales conversations, such as catalogue, brochure, quotation, or photos of past work?", "list", false, "medium", ["knowledge_base", "campaign_strategy"]],
  ]),
  domain("whatsapp_communication", "WhatsApp / Communication", "Tone, reply rules, allowed answers, escalation triggers, and channel behavior.", agentSets.communication, [
    ["preferred_tone", "What tone should WhatsApp and message replies use?", "short_text", true, "high", ["whatsapp_settings", "agent_instruction"]],
    ["greeting_style", "How should the agent greet new customers?", "rule", false, "medium", ["whatsapp_settings", "agent_instruction"]],
    ["language_preferences", "What languages or Hinglish rules should the agent follow?", "list", false, "medium", ["whatsapp_settings", "agent_instruction"]],
    ["unknown_answer_reply", "What should the agent say when it does not know the answer?", "rule", true, "high", ["whatsapp_settings", "agent_instruction"], true, "human_review", "I will confirm this with our team and get back to you."],
    ["abusive_customer_handling", "How should abusive or unsafe customer messages be handled?", "policy", true, "high", ["whatsapp_settings", "agent_instruction"], true, "human_review"],
    ["auto_reply_boundaries", "Which topics can be answered automatically and which always require human review?", "structured_json", true, "high", ["whatsapp_settings", "agent_instruction"], true, "human_review"],
  ]),
  domain("faqs", "FAQs", "Frequently asked questions and approved safe answers.", agentSets.communication, [
    ["frequent_questions", "What questions do customers ask most often?", "list", false, "medium", ["knowledge_base", "whatsapp_settings"]],
    ["catalogue_faq", "What should the agent answer when someone asks for catalogue?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"]],
    ["sample_faq", "What should the agent answer when someone asks for samples?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["price_faq", "What should the agent answer when someone asks for price?", "policy", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["delivery_faq", "What should the agent answer when someone asks delivery timeline?", "policy", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["custom_order_faq", "What should the agent answer for custom order enquiries?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
  ]),
  domain("objection_handling", "Objection Handling", "Safe responses to common objections without overpromising.", agentSets.communication, [
    ["price_objection", "How should the agent respond if a buyer says the price is too high?", "rule", false, "high", ["knowledge_base", "agent_instruction"], true, "human_review"],
    ["quality_objection", "How should the agent handle doubts about quality?", "rule", false, "high", ["knowledge_base", "agent_instruction"]],
    ["trust_objection", "How should the agent build trust with a new buyer?", "rule", false, "medium", ["knowledge_base", "agent_instruction"]],
    ["delivery_objection", "How should delivery delay concerns be handled?", "policy", false, "medium", ["knowledge_base", "agent_instruction"], true, "human_review"],
    ["moq_objection", "How should MOQ or small-order objections be handled?", "policy", false, "medium", ["knowledge_base", "agent_instruction"], true, "human_review"],
    ["competitor_objection", "How should the agent respond when a buyer compares with competitors?", "rule", false, "medium", ["campaign_strategy", "agent_instruction"]],
  ]),
  domain("payment_credit_terms", "Payment / Credit Terms", "Payment methods, advance, credit, GST, delayed payment, and quotation validity.", agentSets.operations, [
    ["payment_methods", "What payment methods does the company accept?", "list", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["advance_payment_rule", "How much advance does the company take, and when is the balance due?", "policy", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["credit_allowed", "Is credit allowed?", "boolean", true, "high", ["knowledge_base", "lead_qualification"], true, "human_review"],
    ["credit_eligibility", "Who is eligible for credit and who is not?", "policy", false, "high", ["knowledge_base", "lead_qualification"], true, "human_review"],
    ["credit_period", "What is the credit period, if any?", "short_text", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["gst_quotation_validity", "Is GST included, and how long is a quotation valid?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
  ]),
  domain("shipping_delivery", "Shipping / Delivery", "Delivery coverage, charges, timelines, courier, tracking, and export shipping rules.", agentSets.operations, [
    ["delivery_timelines", "What delivery timelines should be communicated?", "policy", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["shipping_charges", "How are shipping charges calculated or communicated?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["courier_partners", "Which courier, transport, or logistics partners are used?", "list", false, "low", ["knowledge_base"]],
    ["tracking_policy", "Does the company provide tracking or dispatch updates?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"]],
    ["urgent_delivery", "Can urgent or rush delivery be supported?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["delivery_exclusions", "Where or when can delivery not be promised?", "policy", false, "high", ["agent_instruction", "whatsapp_settings"], true, "human_review"],
  ]),
  domain("returns_replacement", "Returns / Replacement", "Return, refund, replacement, damage, cancellation, and complaint policies.", agentSets.operations, [
    ["return_allowed", "Are returns allowed?", "boolean", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["replacement_policy", "What replacement policy applies for damaged, wrong, or defective items?", "policy", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["refund_policy", "Is refund available and under what conditions?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["cancellation_policy", "Can orders be cancelled after payment, or once work on them has started?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["complaint_escalation", "How should complaints be escalated to a human?", "rule", true, "high", ["whatsapp_settings", "agent_instruction"], true, "human_review"],
    ["return_time_window", "What time window applies for reporting damage, returns, or replacement?", "short_text", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
  ]),
  domain("customization", "Customization", "Customization options, design support, custom order requirements, and approval process.", agentSets.product, [
    ["customization_available", "Does the company offer customization?", "boolean", false, "medium", ["knowledge_base", "product_research"]],
    ["customization_options", "What can be customized: size, color, material, design, packaging, branding, or specification?", "list", false, "medium", ["knowledge_base", "product_research"]],
    ["custom_order_requirements", "What information is required before accepting a custom order?", "list", false, "high", ["lead_qualification", "whatsapp_settings"], true, "human_review"],
    ["custom_order_payment", "Are custom orders prepaid or subject to special payment rules?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["design_approval_process", "Is sample/design approval required before production?", "policy", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["customization_limitations", "What customization requests should be refused or escalated?", "list", false, "high", ["agent_instruction"], true, "human_review"],
  ]),
  domain("samples_catalogue_quotation_rules", "Samples / Catalogue / Quotation Rules", "Rules for sharing catalogue, samples, pricing lists, and quotations.", agentSets.operations, [
    ["catalogue_available", "Is catalogue available and how should it be shared?", "policy", true, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["sample_available", "Are samples available?", "boolean", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["sample_charges", "Are samples free, paid, refundable, or courier-paid?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["quotation_requirements", "What details are required to prepare a quotation?", "list", true, "high", ["lead_qualification", "whatsapp_settings"], true, "human_review"],
    ["quotation_validity", "How long is a quotation valid?", "short_text", false, "medium", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["price_list_rules", "Can price lists be shared directly, or only after qualification?", "policy", false, "high", ["whatsapp_settings", "agent_instruction"], true, "human_review"],
  ]),
  domain("pricing_policy", "Pricing Policy", "Pricing structure, discounts, MOQ, wholesale rates, taxes, and approval boundaries.", agentSets.operations, [
    ["pricing_structure", "How is pricing structured: fixed, per unit, custom quote, tiered, wholesale, or project-based?", "policy", true, "high", ["knowledge_base", "campaign_strategy"], true, "human_review"],
    ["discount_policy", "What discount rules or boundaries exist?", "policy", false, "high", ["whatsapp_settings", "agent_instruction"], true, "human_review"],
    ["moq_policy", "What minimum order quantity rules apply?", "policy", false, "high", ["lead_qualification", "knowledge_base"], true, "human_review"],
    ["tax_policy", "Are taxes, GST, duties, or extra charges included or separate?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["price_change_policy", "Can prices change with input costs, quantity, season, or custom work?", "policy", false, "medium", ["knowledge_base", "agent_instruction"], true, "human_review"],
    ["manager_approval_price_cases", "Which pricing requests require manager/human approval?", "rule", true, "high", ["agent_instruction"], true, "human_review"],
  ]),
  domain("product_research_market_map", "Product Research / Market Map", "Market map connecting products, varieties, applications, buyer segments, and demand triggers.", agentSets.product, [
    ["product_to_buyer_map", "Which products map to which buyer segments?", "structured_json", true, "high", ["product_research", "campaign_strategy"]],
    ["application_to_buyer_map", "Which applications create demand for which buyer segments?", "structured_json", true, "high", ["product_research", "campaign_strategy"]],
    ["buyer_careabouts", "For each product, which buyer segment is it the best fit for, and why?", "structured_json", true, "high", ["product_research", "campaign_strategy"]],
    ["market_demand_triggers", "What triggers demand in this market?", "list", false, "medium", ["campaign_strategy"]],
    ["competitor_or_alternative_context", "What alternatives or competitor categories do buyers compare against?", "list", false, "medium", ["campaign_strategy"]],
    ["research_gaps", "What market research questions remain unanswered?", "list", false, "low", ["product_research"], false, "create_unknown_question"],
  ]),
  domain("campaign_strategy_knowledge", "Campaign Strategy Knowledge", "Positioning, angles, channels, searches, and campaign defaults.", agentSets.customer, [
    ["primary_campaign_objective", "What should the primary campaign objective be?", "short_text", true, "high", ["campaign_strategy"]],
    ["campaign_message_angles", "What campaign messaging angles are most appropriate?", "list", true, "high", ["campaign_strategy", "agent_instruction"]],
    ["lead_sources", "Which lead sources should be used: manual, CSV, Google, marketplaces, social, directories, referrals, or future integrations?", "list", false, "medium", ["campaign_strategy"]],
    ["search_query_patterns", "What search queries should discovery use?", "list", false, "medium", ["campaign_strategy"]],
    ["campaign_disqualifiers", "What campaign-level disqualifiers should prevent outreach?", "list", true, "high", ["campaign_strategy", "lead_qualification"], true, "human_review"],
    ["followup_strategy", "What follow-up strategy should campaigns use?", "rule", false, "medium", ["campaign_strategy", "agent_instruction"]],
  ]),
  domain("legal_terms_privacy", "Legal / Terms / Privacy", "Legal terms, privacy boundaries, claims, disclaimers, and compliance-sensitive statements.", agentSets.operations, [
    ["privacy_policy", "What privacy or customer data handling policy is stated?", "policy", false, "high", ["knowledge_base", "agent_instruction"], true, "human_review"],
    ["terms_conditions", "What terms and conditions should customers know?", "policy", false, "high", ["knowledge_base"], true, "human_review"],
    ["warranty_claims", "What warranty or guarantee claims are allowed?", "policy", false, "high", ["knowledge_base", "whatsapp_settings"], true, "human_review"],
    ["regulated_claims", "Are there legal, medical, safety, compliance, or regulated claims the agent must avoid?", "list", false, "high", ["agent_instruction"], true, "human_review"],
    ["document_disclaimer", "What disclaimer should be used for catalogues, quotations, or estimates?", "policy", false, "medium", ["agent_instruction"], true, "human_review"],
    ["data_retention_rules", "What data retention or deletion rules should the company follow?", "policy", false, "medium", ["agent_instruction"], true, "human_review"],
  ]),
  domain("internal_operations", "Internal Operations", "Non-private operational facts useful for customer service without asking financial/private questions.", agentSets.operations, [
    ["business_hours", "What are sales or support business hours?", "short_text", false, "medium", ["whatsapp_settings"]],
    ["escalation_contacts", "Which public-facing role or contact should escalations go to?", "list", false, "medium", ["whatsapp_settings", "agent_instruction"], true, "human_review"],
    ["order_processing_steps", "What are the high-level order processing steps?", "list", false, "medium", ["knowledge_base"]],
    ["production_or_service_capacity", "What safe public capacity or turnaround information is available?", "long_text", false, "medium", ["knowledge_base"], true, "human_review"],
    ["documents_needed_from_customer", "What documents, artwork, measurements, or details does the customer need to provide?", "list", false, "medium", ["whatsapp_settings", "lead_qualification"]],
    ["internal_non_private_constraints", "What operational constraints can be safely shared with customers?", "list", false, "medium", ["agent_instruction"], true, "human_review"],
  ]),
  domain("analytics_success_metrics", "Analytics / Success Metrics", "Business-safe measures for lead quality, campaign success, replies, and agent improvement.", agentSets.analytics, [
    ["lead_quality_metrics", "Which signals should analytics use to judge lead quality?", "list", false, "medium", ["campaign_strategy", "lead_qualification"]],
    ["campaign_success_metrics", "Which campaign outcomes matter most?", "list", false, "medium", ["campaign_strategy"]],
    ["reply_intent_metrics", "Which reply intents matter: catalogue, price, quote, sample, meeting, complaint, unsubscribe?", "list", false, "medium", ["campaign_strategy"]],
    ["agent_quality_metrics", "How should agent answer quality be reviewed?", "list", false, "low", ["agent_instruction"]],
    ["negative_signal_metrics", "Which negative signals should be tracked?", "list", false, "medium", ["lead_qualification"]],
    ["learning_feedback_rules", "What feedback should campaign learning use to improve future plans?", "rule", false, "low", ["campaign_strategy", "agent_instruction"]],
  ]),
  domain("extra_unmapped_information", "Extra / Unmapped Information", "Useful information that does not fit another domain yet but should not be lost.", agentSets.operations, [
    ["unmapped_facts", "What useful business facts were found but do not fit another section?", "list", false, "low", ["knowledge_base"]],
    ["unmapped_customer_statements", "What customer-facing statements should be preserved for review?", "list", false, "low", ["knowledge_base"], true, "human_review"],
    ["unmapped_product_notes", "What extra product notes should be reviewed later?", "list", false, "low", ["product_research", "knowledge_base"]],
    ["unmapped_policy_notes", "What extra policy notes should be reviewed later?", "list", false, "medium", ["knowledge_base"], true, "human_review"],
    ["unmapped_agent_instructions", "What extra guidance may affect agent behavior?", "list", false, "medium", ["agent_instruction"], true, "human_review"],
    ["future_questions", "What new questions should the business owner answer later?", "list", false, "low", ["knowledge_base"], false, "create_unknown_question"],
  ]),
];

/**
 * N13 (2026-09-25) — the question POOL: every question any checklist can hold.
 * A workspace never sees the whole pool; `checklistQuestions()` in
 * knowledge-sheets.ts picks the questions for its kind of business.
 *
 * What used to be here: a generator that pasted 274 topics into six stock
 * sentences ("What should the company knowledge include about X?"). The real
 * topics among them were rewritten by hand in checklist-additions.ts, keeping
 * their keys so stored answers carry over; the rest were retired. The frozen
 * 424-question bank lives in scripts/probes/legacy/ for the before/after
 * comparison only.
 */
const additionsByDomain = new Map<string, typeof CHECKLIST_ADDITIONS>();
for (const spec of CHECKLIST_ADDITIONS) {
  const list = additionsByDomain.get(spec.domainKey) || [];
  list.push(spec);
  additionsByDomain.set(spec.domainKey, list);
}

function additionToQuestion(spec: (typeof CHECKLIST_ADDITIONS)[number], usedByAgents: string[], description: string): KnowledgeQuestion {
  const questionSpec: QuestionSpec = [
    spec.key, spec.question, spec.answerType, spec.required, spec.priority, spec.mapsTo,
    Boolean(spec.humanReviewRequired), spec.humanReviewRequired ? "human_review" : undefined,
    spec.example, Boolean(spec.essential),
  ];
  return q(spec.domainKey, questionSpec, usedByAgents, description, spec.appliesTo);
}

const NEW_DOMAIN_AGENTS: Record<string, string[]> = {
  production_manufacturing: agentSets.product,
  sourcing_stock: agentSets.product,
  retail_store: agentSets.operations,
  service_delivery: agentSets.operations,
  export_trade: agentSets.operations,
};

export const KNOWLEDGE_QUESTION_FRAMEWORK: KnowledgeDomain[] = [
  ...BASE_KNOWLEDGE_QUESTION_FRAMEWORK.map((domainItem) => {
    const kept = domainItem.questions.filter((item) => !RETIRED_BASE_QUESTIONS[`${domainItem.domainKey}/${item.questionKey}`]);
    const usedByAgents = domainItem.questions[0]?.usedByAgents || agentSets.operations;
    const extras = (additionsByDomain.get(domainItem.domainKey) || []).map((spec) => additionToQuestion(spec, usedByAgents, domainItem.description));
    return { ...domainItem, questions: [...kept, ...extras] };
  }),
  ...CHECKLIST_DOMAINS.map((domainItem) => ({
    ...domainItem,
    questions: (additionsByDomain.get(domainItem.domainKey) || []).map((spec) => additionToQuestion(spec, NEW_DOMAIN_AGENTS[domainItem.domainKey] || agentSets.operations, domainItem.description)),
  })),
];

export type KnowledgeQuestionWithDomain = KnowledgeQuestion & {
  domainKey: string;
  domainTitle: string;
};

export function getAllKnowledgeQuestions(): KnowledgeQuestionWithDomain[] {
  return KNOWLEDGE_QUESTION_FRAMEWORK.flatMap((domainItem) =>
    domainItem.questions.map((question) => ({ ...question, domainKey: domainItem.domainKey, domainTitle: domainItem.domainTitle }))
  );
}

export function getEssentialKnowledgeQuestions(): KnowledgeQuestionWithDomain[] {
  return getAllKnowledgeQuestions().filter((question) => question.isEssential);
}

export function getKnowledgeDomain(domainKey: string) {
  return KNOWLEDGE_QUESTION_FRAMEWORK.find((item) => item.domainKey === domainKey);
}

export function getKnowledgeQuestion(domainKey: string, questionKey: string) {
  return getKnowledgeDomain(domainKey)?.questions.find((item) => item.questionKey === questionKey);
}
