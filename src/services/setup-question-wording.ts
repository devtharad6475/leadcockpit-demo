/** Reviewed interview copy only. The canonical bank still controls identity,
 * applicability, answer type, sources and review rules. No general word
 * replacement: if a definition changes, keep its new text until reviewed. */
const PLAIN_SETUP_QUESTIONS: ReadonlyArray<readonly [marker: string, canonical: string, plain: string]> = [
  ['company_knowledge/value_proposition', 'What is the company primary value proposition for buyers?', 'What is the main benefit customers get from buying from your company?'],
  ['company_knowledge/core_strengths', 'What are the company strongest differentiators or trust points?', 'What makes your company stand out, and what gives customers confidence in it?'],
  ['company_knowledge/proof_assets', 'What proof assets can the company mention, such as factory, showroom, catalogue, certifications, testimonials, or clients?', 'What can the AI mention as proof of your work, such as a factory, showroom, catalogue, certificates, customer reviews or clients?'],
  ['factual_company_profile/phone_whatsapp', 'What phone or WhatsApp numbers are customer-facing?', 'Which phone or WhatsApp numbers should customers use?'],
  ['product_knowledge/product_features', 'What important features, specifications, materials, sizes, or quality details are described?', 'What important features, specifications, materials, sizes and quality details should customers know about your products?'],
  ['product_varieties/premium_economy_options', 'Does the company offer premium, standard, economy, or custom tiers?', 'Do you offer premium, standard, lower-cost or custom product options?'],
  ['product_varieties/variety_recommendation_rules', 'Which variety should be recommended for which customer use case?', 'Which product option should the AI recommend for each customer need?'],
  ['product_applications/primary_applications', 'What are the main applications or use cases for the products?', 'What do customers mainly use your products for?'],
  ['product_applications/seasonal_applications', 'Are there seasonal, event-driven, or trend-based demand patterns?', 'Does demand change with seasons, events or trends?'],
  ['product_applications/application_examples', 'What concrete examples of product applications should be used in sales conversations?', 'What examples of how your products are used should the AI share in sales conversations?'],
  ['customer_knowledge/ideal_customer_profile', 'Who is the ideal customer or best-fit buyer?', 'Which kinds of customers are the best fit for your business?'],
  ['customer_knowledge/customer_success_definition', 'How do customers define a successful purchase or supplier relationship?', 'What do customers expect from a good purchase or a good supplier relationship?'],
  ['customer_knowledge/bad_fit_customers', 'Which customer types are poor fit or should be deprioritized?', 'Which kinds of customers are not a good fit, or should receive less priority?'],
  ['target_market_geography/priority_locations', 'Which geographies should be prioritized for lead generation?', 'Which locations should we focus on when finding potential customers?'],
  ['target_market_geography/regional_language_needs', 'Are there language preferences by geography?', 'Do customers in different locations prefer different languages?'],
  ['buyer_segments/segment_needs', 'What does each buyer segment care about most?', 'What matters most to each kind of buyer?'],
  ['buyer_segments/segment_objections', 'What objections or hesitations are common for each segment?', 'What doubts or concerns does each kind of buyer usually have?'],
  ['buyer_segments/segment_qualification_signals', 'What signals show that each segment is qualified?', 'For each kind of buyer, what tells you they are a suitable potential customer?'],
  ['buyer_segments/segment_message_angles', 'What messaging angle should be used for each segment?', 'What should the AI focus on when speaking to each kind of buyer?'],
  ['lead_qualification/mql_rules', 'What makes a lead a marketing qualified lead for this company?', 'What tells you a potential customer is suitable for your marketing efforts?'],
  ['lead_qualification/sql_rules', 'What makes a lead sales qualified or ready for human sales follow-up?', 'What tells you a potential customer is ready for your sales team to contact?'],
  ['lead_qualification/hot_lead_signals', 'What signals indicate a hot lead?', 'What tells you a potential customer is very interested and ready to buy?'],
  ['lead_qualification/reject_rules', 'What rules should reject or deprioritize a lead?', 'When should we reject a potential customer, or give them less priority?'],
  ['lead_qualification/minimum_required_lead_data', 'What lead details are required before outreach should be prepared?', 'Which customer details must be available before preparing a message to them?'],
  ['sales_process/handoff_to_human', 'When should the AI hand off to a human salesperson?', 'When should the AI ask a person on your sales team to take over?'],
  ['objection_handling/moq_objection', 'How should MOQ or small-order objections be handled?', 'What should the AI say when a buyer wants less than your minimum order?'],
  ['returns_replacement/complaint_escalation', 'How should complaints be escalated to a human?', 'When a customer complains, how should the AI pass the issue to a person?'],
  ['pricing_policy/moq_policy', 'What minimum order quantity rules apply?', 'What minimum order must customers place, and are there any exceptions?'],
  ['pricing_policy/manager_approval_price_cases', 'Which pricing requests require manager/human approval?', 'Which price requests must a manager or another person approve?'],
  ['campaign_strategy_knowledge/primary_campaign_objective', 'What should the primary campaign objective be?', 'What is the main result you want from a sales campaign?'],
  ['campaign_strategy_knowledge/campaign_message_angles', 'What campaign messaging angles are most appropriate?', 'What should campaign messages focus on to interest your customers?'],
  ['campaign_strategy_knowledge/campaign_disqualifiers', 'What campaign-level disqualifiers should prevent outreach?', 'Which campaign rules should stop us from contacting a potential customer?'],
  ['legal_terms_privacy/data_retention_rules', 'What data retention or deletion rules should the company follow?', 'How long should customer information be kept, and when should it be deleted?'],
];

export function setupQuestionWording(domainKey: string, questionKey: string, canonicalQuestion: string): string {
  const marker = `${domainKey}/${questionKey}`;
  const reviewed = PLAIN_SETUP_QUESTIONS.find(([key, canonical]) => key === marker && canonical === canonicalQuestion);
  return reviewed?.[2] ?? canonicalQuestion;
}
