/**
 * checklist-additions.ts — N13 (2026-09-25). The hand-written questions that
 * replaced the 274 template questions, plus the questions each KIND of
 * business needs that the old bank never asked.
 *
 * Two kinds of entry live here:
 *
 *  1. REWRITTEN template topics. The old bank turned a topic ("quality
 *     standards and inspection checks") into a question by pasting it into one
 *     of six stock sentences. Where the topic was real and not already asked
 *     by a hand-written question, it is rewritten here as a question a person
 *     can answer, and it KEEPS ITS OLD KEY — answers already found for it carry
 *     over untouched. The ~225 template topics not listed here were duplicates
 *     of a hand-written question, meta-questions ("what information is still
 *     needed about…"), or campaign outputs rather than business facts. They
 *     leave the checklist; their stored answers are kept (nothing is deleted).
 *
 *  2. NEW questions per kind of business, from research into what buyers ask
 *     each kind before ordering (sources in docs/planning/N13-TYPE-SHEETS-PLAN.md):
 *     manufacturer, trader, retailer, service provider, and the exports add-on.
 *
 * `appliesTo` decides which checklists a question is on. "goods" means any
 * business that sells physical goods (manufacturer, trader, retailer).
 * `exportsOnly` puts a question on a checklist only when the business exports.
 */
import type { BusinessKind, KnowledgeAnswerType, KnowledgeMapTarget, KnowledgeQuestionPriority, QuestionAppliesTo } from "./knowledge-question-framework";

export type ChecklistQuestionSpec = {
  domainKey: string;
  key: string;
  question: string;
  answerType: KnowledgeAnswerType;
  required: boolean;
  priority: KnowledgeQuestionPriority;
  mapsTo: KnowledgeMapTarget[];
  humanReviewRequired?: boolean;
  appliesTo: QuestionAppliesTo;
  essential?: boolean;
  example?: string;
};

const ALL: QuestionAppliesTo = { kinds: "all" };
const GOODS: QuestionAppliesTo = { kinds: "goods" };
const only = (...kinds: BusinessKind[]): QuestionAppliesTo => ({ kinds });
const EXPORTS: QuestionAppliesTo = { kinds: "all", exportsOnly: true };
const EXPORTS_GOODS: QuestionAppliesTo = { kinds: "goods", exportsOnly: true };

/** New checklist sections. Existing sections keep their keys and titles. */
export const CHECKLIST_DOMAINS: Array<{ domainKey: string; domainTitle: string; description: string }> = [
  { domainKey: "production_manufacturing", domainTitle: "Production", description: "Where and how the goods are made, and what a buyer can rely on from order to order." },
  { domainKey: "sourcing_stock", domainTitle: "Sourcing and stock", description: "Where traded goods come from, what is kept in stock, and the terms for resellers." },
  { domainKey: "retail_store", domainTitle: "Shop and online store", description: "How end customers buy, check stock and exchange items." },
  { domainKey: "service_delivery", domainTitle: "How the service works", description: "What is included, how long it takes, who does it, and what happens if the client is unhappy." },
  { domainKey: "export_trade", domainTitle: "Exports", description: "What overseas buyers, their banks and their freight agents need before ordering." },
];

export const CHECKLIST_ADDITIONS: ChecklistQuestionSpec[] = [
  // ---------------------------------------------------------------- rewritten topics (old keys kept)
  { domainKey: "company_knowledge", key: "deep_02_founder_or_leadership_story_that_builds_trust", question: "Who founded or runs the company, and is there a short story about it that builds trust?", answerType: "long_text", required: false, priority: "low", mapsTo: ["knowledge_base", "campaign_strategy"], appliesTo: ALL },
  { domainKey: "company_knowledge", key: "deep_04_certifications_awards_memberships_or_recogniti", question: "Which certifications, awards, memberships or registrations does the company hold?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base", "campaign_strategy"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "company_knowledge", key: "deep_08_claims_the_agent_must_avoid_unless_approved", question: "Which claims must the AI never make without your approval, such as 'best in India' or 'lowest price'?", answerType: "list", required: true, priority: "high", mapsTo: ["agent_instruction"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "company_knowledge", key: "deep_09_company_scale_statements_that_are_safe_to_ment", question: "Which facts about your size (team, capacity, years, number of clients) may the AI mention?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base", "campaign_strategy"], appliesTo: ALL },
  { domainKey: "company_knowledge", key: "deep_10_preferred_way_to_introduce_the_company_in_outr", question: "How should the AI introduce the company in a first message, in one or two lines?", answerType: "long_text", required: false, priority: "medium", mapsTo: ["campaign_strategy", "agent_instruction"], appliesTo: ALL },
  { domainKey: "company_knowledge", key: "reference_buyers", question: "Can you give references from existing buyers if a new buyer asks? Who may be named?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: ALL },

  { domainKey: "factual_company_profile", key: "deep_01_gst_iec_registration_or_tax_identifiers_safe_t", question: "What GST number (and IEC, if you export) may be shared with buyers?", answerType: "short_text", required: false, priority: "medium", mapsTo: ["business_profile", "knowledge_base"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "factual_company_profile", key: "deep_02_founder_owner_or_public_contact_person", question: "Who is the public contact person for buyers (name and role)?", answerType: "short_text", required: false, priority: "medium", mapsTo: ["business_profile", "whatsapp_settings"], appliesTo: ALL },
  { domainKey: "factual_company_profile", key: "deep_04_factory_showroom_warehouse_or_branch_locations", question: "Where are all your premises: offices, branches and any other sites?", answerType: "list", required: false, priority: "medium", mapsTo: ["business_profile", "knowledge_base"], appliesTo: ALL },
  { domainKey: "factual_company_profile", key: "deep_05_public_social_media_and_catalogue_links", question: "Which public links may the AI share: social media pages, online catalogue, marketplace listings?", answerType: "list", required: false, priority: "low", mapsTo: ["business_profile", "whatsapp_settings"], appliesTo: ALL },
  { domainKey: "factual_company_profile", key: "deep_10_official_billing_or_quotation_entity_name", question: "Which company name appears on invoices and quotations, if different from the brand name?", answerType: "short_text", required: false, priority: "low", mapsTo: ["business_profile"], appliesTo: ALL },

  { domainKey: "product_knowledge", key: "deep_01_materials_or_ingredients_used_in_each_product", question: "What materials or raw materials are your products made of?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base", "product_research"], appliesTo: GOODS },
  { domainKey: "product_knowledge", key: "deep_02_technical_specifications_dimensions_counts_wei", question: "Which technical specifications do buyers ask about: sizes, counts, weights, grades?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base", "product_research"], appliesTo: GOODS },
  { domainKey: "product_knowledge", key: "deep_03_quality_standards_and_inspection_checks", question: "What quality checks happen before goods leave, and what proof (test report, inspection note) goes with them?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base"], appliesTo: only("manufacturer", "trader") },
  { domainKey: "product_knowledge", key: "deep_05_packaging_formats_and_units_of_sale", question: "How are goods packed, and in what units are they sold (piece, kg, metre, roll, box)?", answerType: "list", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], appliesTo: GOODS },
  { domainKey: "product_knowledge", key: "deep_08_care_storage_handling_or_maintenance_instructi", question: "Are there storage, handling or care instructions buyers should know?", answerType: "long_text", required: false, priority: "low", mapsTo: ["knowledge_base"], appliesTo: GOODS },
  { domainKey: "product_knowledge", key: "deep_09_common_product_substitutions_or_alternatives", question: "When an item is unavailable, what do you usually offer instead?", answerType: "long_text", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], appliesTo: GOODS },
  { domainKey: "product_varieties", key: "deep_01_sku_model_grade_or_variant_naming_rules", question: "How are models, grades or item codes named, so the AI can tell what a buyer means?", answerType: "long_text", required: false, priority: "medium", mapsTo: ["knowledge_base", "product_research"], appliesTo: GOODS },
  { domainKey: "product_applications", key: "deep_09_application_specific_installation_or_usage_con", question: "Are there usage, fitting or compatibility limits a buyer must know before ordering?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: GOODS },

  { domainKey: "customer_knowledge", key: "deep_01_best_customer_segments_by_order_value_or_repea", question: "Which kind of customer brings the largest orders or the most repeat business?", answerType: "long_text", required: false, priority: "medium", mapsTo: ["campaign_strategy", "lead_qualification"], appliesTo: ALL },
  { domainKey: "customer_knowledge", key: "deep_05_customer_proof_requirements_before_purchase", question: "What do new buyers usually want to see before their first order (a visit, references, a trial, a test report)?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base", "campaign_strategy"], appliesTo: ALL },
  { domainKey: "customer_knowledge", key: "deep_07_customer_purchase_frequency_or_reorder_pattern", question: "How often do customers usually order again?", answerType: "short_text", required: false, priority: "low", mapsTo: ["campaign_strategy"], appliesTo: ALL },
  { domainKey: "customer_knowledge", key: "deep_08_customer_decision_timeline", question: "How long does a typical buyer take from first enquiry to first order?", answerType: "short_text", required: false, priority: "low", mapsTo: ["campaign_strategy", "lead_qualification"], appliesTo: ALL },
  { domainKey: "lead_qualification", key: "deep_05_budget_or_order_size_signals_that_are_safe_to_", question: "What order size makes a buyer worth pursuing, and below what size do you decline?", answerType: "rule", required: false, priority: "high", mapsTo: ["lead_qualification"], humanReviewRequired: true, appliesTo: ALL },

  { domainKey: "sales_process", key: "deep_03_sample_request_process", question: "What happens when a buyer asks for a sample: who approves it, how is it sent, how long does it take?", answerType: "rule", required: false, priority: "medium", mapsTo: ["whatsapp_settings", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer", "trader") },
  { domainKey: "sales_process", key: "deep_05_order_confirmation_steps", question: "How is an order confirmed: purchase order, advance payment, written approval?", answerType: "list", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], appliesTo: ALL },
  { domainKey: "sales_process", key: "deep_06_payment_confirmation_steps", question: "How does a buyer confirm payment, and when does the work on their order begin after it?", answerType: "rule", required: false, priority: "medium", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "sales_process", key: "deep_09_lost_lead_or_inactive_lead_handling", question: "What should happen with a buyer who goes quiet after receiving a quotation?", answerType: "rule", required: false, priority: "medium", mapsTo: ["campaign_strategy", "agent_instruction"], appliesTo: ALL },
  { domainKey: "whatsapp_communication", key: "deep_09_message_length_and_tone_boundaries", question: "How long should WhatsApp replies be, and are emojis acceptable?", answerType: "rule", required: false, priority: "low", mapsTo: ["whatsapp_settings", "agent_instruction"], appliesTo: ALL },
  { domainKey: "faqs", key: "deep_01_product_availability_faq", question: "What should the AI say when a buyer asks whether an item is in stock?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: GOODS },
  { domainKey: "objection_handling", key: "deep_05_sample_charge_objection", question: "How should the AI respond when a buyer objects to paying for a sample?", answerType: "rule", required: false, priority: "low", mapsTo: ["agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer", "trader") },
  { domainKey: "objection_handling", key: "deep_08_credit_request_objection", question: "How should the AI respond when a new buyer asks for credit?", answerType: "rule", required: false, priority: "medium", mapsTo: ["agent_instruction"], humanReviewRequired: true, appliesTo: ALL },

  { domainKey: "payment_credit_terms", key: "deep_03_new_customer_payment_rule", question: "Do new and repeat buyers pay differently? Give the advance and when the balance is due for each.", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "payment_credit_terms", key: "deep_07_payment_delay_handling", question: "What happens when a buyer pays late: reminders, interest, stopping further supply?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "payment_credit_terms", key: "gst_invoice", question: "Does every order come with a proper GST invoice?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "whatsapp_settings"], appliesTo: ALL },

  { domainKey: "shipping_delivery", key: "deep_06_delivery_responsibility_after_dispatch", question: "Once goods are handed to the transporter, who is responsible for loss or damage?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: GOODS },
  { domainKey: "shipping_delivery", key: "deep_10_delivery_details_needed_before_quoting", question: "What must a buyer tell you before you can quote delivery (pincode, quantity, transport preference)?", answerType: "list", required: false, priority: "medium", mapsTo: ["whatsapp_settings", "lead_qualification"], appliesTo: GOODS },
  { domainKey: "returns_replacement", key: "deep_07_custom_order_return_restrictions", question: "Can customised or made-to-order goods be returned or replaced?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("manufacturer") },
  { domainKey: "returns_replacement", key: "deep_10_customer_documents_photos_needed_for_claims", question: "What proof must a buyer send with a complaint: photos, video, invoice, the item itself?", answerType: "list", required: false, priority: "medium", mapsTo: ["whatsapp_settings", "agent_instruction"], appliesTo: ALL },
  { domainKey: "customization", key: "deep_05_custom_order_moq", question: "What is the minimum order for a customised product?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "lead_qualification"], humanReviewRequired: true, appliesTo: only("manufacturer") },
  { domainKey: "customization", key: "deep_06_custom_order_delivery_timeline", question: "How long does a customised order take compared with a standard one?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("manufacturer") },
  { domainKey: "customization", key: "deep_07_custom_packaging_or_branding_options", question: "Can buyers get their own branding or packaging on your goods?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "product_research"], appliesTo: only("manufacturer", "trader") },
  { domainKey: "samples_catalogue_quotation_rules", key: "deep_06_quotation_approval_authority", question: "Who in your company approves a quotation before it is sent?", answerType: "short_text", required: false, priority: "medium", mapsTo: ["agent_instruction"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "samples_catalogue_quotation_rules", key: "deep_09_photo_video_sharing_rule", question: "May the AI share product photos or videos with buyers? Which ones?", answerType: "policy", required: false, priority: "medium", mapsTo: ["whatsapp_settings"], appliesTo: GOODS },
  { domainKey: "samples_catalogue_quotation_rules", key: "bulk_order_rule", question: "How are large bulk orders handled: special price, longer lead time, different advance?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "pricing_policy", key: "deep_02_quantity_discount_rules", question: "What are your quantity price slabs, for example the price at 10, 50 and 100 units?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer", "trader") },
  { domainKey: "pricing_policy", key: "deep_03_wholesale_rate_rules", question: "Do wholesale or reseller buyers get a different rate? What decides it?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer", "trader") },
  { domainKey: "pricing_policy", key: "deep_05_customization_effect_on_pricing", question: "How does customisation change the price: a one-time setup, design or tooling charge, or extra per unit?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer") },
  { domainKey: "legal_terms_privacy", key: "deep_08_permission_for_testimonials_or_logos", question: "Which customer names, logos or testimonials may the AI mention?", answerType: "list", required: false, priority: "medium", mapsTo: ["agent_instruction"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "legal_terms_privacy", key: "deep_10_legal_escalation_triggers", question: "Which situations must come straight to you (legal notice, fraud claim, police, consumer court)?", answerType: "list", required: true, priority: "high", mapsTo: ["agent_instruction", "whatsapp_settings"], humanReviewRequired: true, appliesTo: ALL },
  { domainKey: "internal_operations", key: "deep_05_production_timeline", question: "How long does production take for a first order, and for a repeat order?", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("manufacturer"), essential: true },
  { domainKey: "internal_operations", key: "deep_08_job_work_or_outsourcing_boundaries", question: "Do you take job work, where the buyer supplies the material and you process it? On what terms?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base"], appliesTo: only("manufacturer") },

  // ---------------------------------------------------------------- every business: gaps in the old bank
  { domainKey: "whatsapp_communication", key: "stop_unsubscribe_handling", question: "How should the AI respond when someone says stop or asks not to be contacted again?", answerType: "rule", required: true, priority: "high", mapsTo: ["whatsapp_settings", "agent_instruction"], humanReviewRequired: true, appliesTo: ALL, example: "Confirm once that they will not be contacted again, then stop." },

  // ---------------------------------------------------------------- manufacturer
  { domainKey: "production_manufacturing", key: "production_location", question: "Where are the goods made: in your own unit, or at partner units? How do you check the partner units?", answerType: "long_text", required: true, priority: "high", mapsTo: ["knowledge_base", "business_profile"], appliesTo: only("manufacturer"), essential: true },
  { domainKey: "production_manufacturing", key: "batch_consistency", question: "How do you make sure a repeat order matches the first one (same shade, size, specification)?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer") },
  { domainKey: "production_manufacturing", key: "spec_change_after_order", question: "If a buyer changes the design or specification after ordering, what happens to the price and the timeline?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer") },
  { domainKey: "production_manufacturing", key: "design_confidentiality", question: "Do you keep a buyer's designs private, and will you sign an agreement for it?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("manufacturer") },

  // ---------------------------------------------------------------- trader / wholesaler / distributor
  { domainKey: "sourcing_stock", key: "supply_source", question: "Do you make the goods you sell, buy them direct from the makers, or buy from other traders?", answerType: "long_text", required: true, priority: "high", mapsTo: ["knowledge_base"], appliesTo: only("trader"), essential: true },
  { domainKey: "sourcing_stock", key: "brands_authorised", question: "Which brands or makers do you sell, and can you show you are authorised to sell them?", answerType: "list", required: false, priority: "high", mapsTo: ["knowledge_base", "campaign_strategy"], humanReviewRequired: true, appliesTo: only("trader") },
  { domainKey: "sourcing_stock", key: "restock_time", question: "When an item runs out, how long does restocking take, and how is the buyer told?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("trader", "retailer") },
  { domainKey: "sourcing_stock", key: "dealer_territory", question: "Do you give area or dealer protection to buyers who resell your goods?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "lead_qualification"], humanReviewRequired: true, appliesTo: only("manufacturer", "trader") },
  { domainKey: "sourcing_stock", key: "sells_direct_to_consumers", question: "Do you also sell directly to end customers or on online marketplaces?", answerType: "short_text", required: false, priority: "medium", mapsTo: ["knowledge_base", "lead_qualification"], appliesTo: only("manufacturer", "trader") },
  { domainKey: "sourcing_stock", key: "discontinued_lines", question: "How do you handle discontinued items and end-of-season stock?", answerType: "policy", required: false, priority: "low", mapsTo: ["knowledge_base"], appliesTo: only("trader", "retailer") },

  // ---------------------------------------------------------------- retailer
  { domainKey: "retail_store", key: "retail_sales_channels", question: "Do customers buy in your shop, online, or both?", answerType: "short_text", required: true, priority: "high", mapsTo: ["knowledge_base", "business_profile"], appliesTo: only("retailer"), essential: true },
  { domainKey: "retail_store", key: "stock_check_before_visit", question: "Can a customer check whether an item is in stock before visiting? How?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "whatsapp_settings"], appliesTo: only("retailer") },
  { domainKey: "retail_store", key: "exchange_policy", question: "Can customers exchange an item for another size, colour or product? Within how many days?", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("retailer"), essential: true },

  // ---------------------------------------------------------------- service provider
  { domainKey: "service_delivery", key: "service_scope", question: "What exactly is included in each service, and what is not included?", answerType: "long_text", required: true, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("service"), essential: true },
  { domainKey: "service_delivery", key: "service_done_definition", question: "How do you and the client agree that the work is finished?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], appliesTo: only("service") },
  { domainKey: "service_delivery", key: "service_turnaround", question: "How long does a typical job take from start to finish?", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("service"), essential: true },
  { domainKey: "service_delivery", key: "service_change_requests", question: "If the client wants changes or extra work midway, how is it priced and who approves it?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("service") },
  { domainKey: "service_delivery", key: "service_team", question: "Who does the work, your own team or partners, and who is the client's single contact?", answerType: "long_text", required: false, priority: "medium", mapsTo: ["knowledge_base"], appliesTo: only("service") },
  { domainKey: "service_delivery", key: "service_response_time", question: "How quickly do you reply to a client's question or problem?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("service") },
  { domainKey: "service_delivery", key: "service_rework", question: "If the client is not happy with the work, what do you do: redo it, refund, or discount?", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: only("service"), essential: true },
  { domainKey: "service_delivery", key: "service_mode", question: "Do you work at the client's site, remotely, or both?", answerType: "short_text", required: false, priority: "medium", mapsTo: ["knowledge_base", "lead_qualification"], appliesTo: only("service") },
  { domainKey: "service_delivery", key: "service_agreement", question: "Do you work on a written agreement? What does it cover?", answerType: "policy", required: false, priority: "medium", mapsTo: ["knowledge_base"], humanReviewRequired: true, appliesTo: only("service") },
  { domainKey: "service_delivery", key: "service_extra_costs", question: "Are there costs on top of the quoted price, such as travel, materials or software?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: only("service") },

  // ---------------------------------------------------------------- exports add-on
  { domainKey: "export_trade", key: "export_incoterms", question: "Which shipping terms do you quote to overseas buyers: Ex Works, FOB (which port), CIF, or delivered to their door?", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: EXPORTS_GOODS, essential: true },
  { domainKey: "export_trade", key: "export_payment_terms", question: "What payment terms do you accept from overseas buyers: advance transfer, letter of credit, part advance?", answerType: "policy", required: true, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: EXPORTS, essential: true },
  { domainKey: "export_trade", key: "export_currency", question: "Which currencies do you quote in for overseas buyers?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base"], appliesTo: EXPORTS },
  { domainKey: "export_trade", key: "export_documents", question: "Which export documents can you provide: commercial invoice, packing list, certificate of origin, others?", answerType: "list", required: false, priority: "high", mapsTo: ["knowledge_base"], appliesTo: EXPORTS_GOODS },
  { domainKey: "export_trade", key: "export_hs_codes", question: "What are the HS (customs) codes for your main products?", answerType: "list", required: false, priority: "medium", mapsTo: ["knowledge_base"], appliesTo: EXPORTS_GOODS },
  { domainKey: "export_trade", key: "export_standards", question: "Do your products meet any overseas standards or lab tests that buyers ask for? Which ones?", answerType: "list", required: false, priority: "high", mapsTo: ["knowledge_base", "agent_instruction"], humanReviewRequired: true, appliesTo: EXPORTS_GOODS },
  { domainKey: "export_trade", key: "export_min_order", question: "Is the minimum order different for export, for example a full carton or container?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "lead_qualification"], humanReviewRequired: true, appliesTo: EXPORTS_GOODS },
  { domainKey: "export_trade", key: "export_packing", question: "How are goods packed for export shipments?", answerType: "long_text", required: false, priority: "medium", mapsTo: ["knowledge_base"], appliesTo: EXPORTS_GOODS },
  { domainKey: "export_trade", key: "export_lead_time", question: "How long from a confirmed overseas order to shipment or delivery?", answerType: "policy", required: false, priority: "high", mapsTo: ["knowledge_base", "whatsapp_settings"], humanReviewRequired: true, appliesTo: EXPORTS },
];

/**
 * Which checklists the hand-written questions of the original bank belong on.
 * Anything not listed is on every checklist. "goods" = the question assumes
 * physical goods (a service business cannot answer it).
 */
export const BASE_APPLIES_TO: Record<string, QuestionAppliesTo> = {
  "product_knowledge/product_features": GOODS,
  "product_varieties/variety_names": GOODS,
  "product_varieties/variety_differences": GOODS,
  "product_varieties/stock_availability": GOODS,
  "product_varieties/minimum_quantities_by_variety": only("manufacturer", "trader"),
  "product_varieties/variety_recommendation_rules": GOODS,
  "target_market_geography/delivery_geography_rules": GOODS,
  "faqs/catalogue_faq": GOODS,
  "faqs/sample_faq": only("manufacturer", "trader"),
  "faqs/delivery_faq": GOODS,
  "faqs/custom_order_faq": only("manufacturer"),
  "objection_handling/delivery_objection": GOODS,
  "objection_handling/moq_objection": only("manufacturer", "trader"),
  "shipping_delivery/delivery_timelines": GOODS,
  "shipping_delivery/shipping_charges": GOODS,
  "shipping_delivery/courier_partners": GOODS,
  "shipping_delivery/tracking_policy": GOODS,
  "shipping_delivery/urgent_delivery": GOODS,
  "shipping_delivery/delivery_exclusions": GOODS,
  "returns_replacement/return_allowed": GOODS,
  "returns_replacement/replacement_policy": GOODS,
  "returns_replacement/return_time_window": GOODS,
  "customization/customization_available": only("manufacturer", "trader"),
  "customization/customization_options": only("manufacturer", "trader"),
  "customization/custom_order_requirements": only("manufacturer", "trader"),
  "customization/custom_order_payment": only("manufacturer"),
  "customization/design_approval_process": only("manufacturer"),
  "customization/customization_limitations": only("manufacturer"),
  "samples_catalogue_quotation_rules/catalogue_available": GOODS,
  "samples_catalogue_quotation_rules/sample_available": only("manufacturer", "trader"),
  "samples_catalogue_quotation_rules/sample_charges": only("manufacturer", "trader"),
  "pricing_policy/moq_policy": only("manufacturer", "trader"),
  "internal_operations/order_processing_steps": GOODS,
};

/**
 * Hand-written questions of the original bank that leave every checklist.
 * Each is either a duplicate of another question or a question about the
 * system rather than the business. Stored answers are kept.
 */
export const RETIRED_BASE_QUESTIONS: Record<string, string> = {
  "product_research_market_map/buyer_careabouts": "duplicate of buyer_segments/segment_needs (audit Q-4)",
  "product_research_market_map/research_gaps": "asks the owner for the system's own to-do list",
  "analytics_success_metrics/agent_quality_metrics": "about reviewing the AI, not about the business",
  "analytics_success_metrics/learning_feedback_rules": "about tuning the AI, not about the business",
  "extra_unmapped_information/future_questions": "asks the owner for the system's own to-do list",
  // Same question asked twice in different sections (found building N13):
  "analytics_success_metrics/negative_signal_metrics": "same as lead_qualification/reject_rules",
  "analytics_success_metrics/reply_intent_metrics": "reply categories are fixed by the product, not the business",
  "campaign_strategy_knowledge/followup_strategy": "same as sales_process/follow_up_rules",
  "campaign_strategy_knowledge/campaign_disqualifiers": "same as lead_qualification/reject_rules",
  "buyer_segments/segment_message_angles": "same as campaign_strategy_knowledge/campaign_message_angles",
  "buyer_segments/segment_search_queries": "same as campaign_strategy_knowledge/search_query_patterns",
  "product_research_market_map/application_to_buyer_map": "same as product_applications/industry_applications",
  "product_research_market_map/market_demand_triggers": "same as product_applications/seasonal_applications",
  "target_market_geography/regional_language_needs": "same as whatsapp_communication/language_preferences",
  "legal_terms_privacy/data_retention_rules": "about how LeadCockpit stores data, not a business fact",
  "product_applications/application_examples": "same as product_applications/primary_applications",
  "sales_process/quotation_process": "same as samples_catalogue_quotation_rules/quotation_requirements",
  "analytics_success_metrics/lead_quality_metrics": "same as lead_qualification/mql_rules",
};

/**
 * Catch-all buckets. The AI still files leftover facts here so nothing found
 * in a document is lost, but an empty bucket is not a gap: these never count
 * as "missing" and are never asked.
 */
export const BUCKET_DOMAINS = new Set(["extra_unmapped_information"]);
