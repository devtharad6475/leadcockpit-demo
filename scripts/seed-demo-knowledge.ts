/**
 * The demo workspace's answered knowledge (2026-09-04, N-DEMO-3).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Knowledge Base screen showed twenty-six identical cards reading
 * "0 of 17 answered · 17 still missing · Weak", and a progress bar at
 * "0 of 424 questions answered". Nothing on that screen was wrong — the demo
 * workspace genuinely had an empty brain — but a screen where every row says
 * the same thing teaches the reader nothing, and it made the AI screens
 * downstream of it (Questions from AI, AI Drafts, WhatsApp Agent) look broken
 * rather than unconfigured.
 *
 * Filling it by running the real extraction pipeline would need a live model
 * call over the seeded documents on every seed. That costs money every time
 * and produces a different answer every time, which is the wrong trade for a
 * demo that has to look the same to everyone. So the answers are written down
 * here instead.
 *
 * WHAT IS AND ISN'T CLAIMED. Every row is marked `sourceType: "document"`
 * against the seeded company profile document, which is true — the facts here
 * are the same facts that document states. Rows the framework marks
 * `humanReviewRequired` (money, delivery promises, legal) keep that flag and
 * stay unapproved, so the demo shows the review queue doing its job instead of
 * pretending a machine already signed off on pricing.
 *
 * COVERAGE IS DELIBERATELY UNEVEN. Ten domains are fully answered, six are
 * partly answered, and ten are left empty. A demo where everything is green
 * shows nothing; this one shows a business part-way through setup, which is
 * what the screen is for and what every operator will actually see.
 */
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "../src/knowledge/knowledge-question-framework";
import type { AppData } from "../src/lib/types";

/** [domainKey, questionKey, answer] — kept flat so the content stays readable. */
type Entry = [string, string, string];

const ANSWERS: Entry[] = [
  // --- Company knowledge (complete) ---
  ["company_knowledge", "company_overview", "We manufacture zari thread and supply embroidery trims — laces, borders, sequins and cutdana — to the Indian textile trade. Business to business only: no retail and no single pieces."],
  ["company_knowledge", "value_proposition", "Mill-direct zari at trade rates, shade matching to a customer's own sample, and one supplier for thread and trims together instead of three."],
  ["company_knowledge", "core_strengths", "Own zari unit in Surat; custom shade matching; stock held on the five fastest-moving lines; catalogue shared same day."],
  ["company_knowledge", "business_type", "Mixed (manufacturer and trader)"],
  ["company_knowledge", "years_in_business", "Trading since 2009; own manufacturing since 2016."],
  ["company_knowledge", "proof_assets", "Factory in Surat; physical shade card; product catalogue PDF; long-running saree wholesaler accounts in Surat and Varanasi."],

  // --- Factual company profile (complete) ---
  ["factual_company_profile", "legal_company_name", "Meghdoot Zari & Trims Pvt Ltd"],
  ["factual_company_profile", "industry", "Textile trims and zari manufacturing"],
  ["factual_company_profile", "website", "https://meghdootzari.example"],
  ["factual_company_profile", "email", "sales@meghdootzari.example"],
  ["factual_company_profile", "phone_whatsapp", "+91 00000 00010 for both calls and WhatsApp."],
  ["factual_company_profile", "address_location", "Ring Road, Surat, Gujarat 395002, India."],

  // --- Product knowledge (complete) ---
  ["product_knowledge", "main_products", "Zari thread, laces, borders, sequins, cutdana."],
  ["product_knowledge", "product_categories", "Textiles; ethnic wear material; embroidery trims."],
  ["product_knowledge", "product_features", "Zari in gold, silver and antique finishes. Laces from 12mm to 75mm. Borders on cotton and net base. Sequins in 3mm, 4mm and 5mm."],
  ["product_knowledge", "product_benefits", "One supplier for thread and trims, shades that repeat between orders, and stock on the fast-moving lines so a rush order does not wait for production."],
  ["product_knowledge", "best_sellers", "Gold zari thread and 25mm cotton-base border — together they are most of what we ship."],
  ["product_knowledge", "product_limitations", "We do not make finished garments, and we do not sell single pieces. Never promise an exact shade match without seeing the customer's sample."],

  // --- Product varieties (complete) ---
  ["product_varieties", "variety_names", "Zari thread in Gold, Silver and Antique. Laces, borders, sequins and cutdana in standard trade sizes."],
  ["product_varieties", "variety_differences", "Gold is the standard bridal shade; Silver suits lighter fabrics; Antique is a matte finish for heavier traditional work."],
  ["product_varieties", "premium_economy_options", "Standard and premium grades on zari. Custom shades are quoted separately."],
  ["product_varieties", "stock_availability", "Gold zari and the common border sizes are held in stock. Antique zari and custom shades are made to order."],
  ["product_varieties", "minimum_quantities_by_variety", "Zari thread from 5 kg. Laces and borders from 100 metres. Sequins from 10 packs, cutdana from 20 packs. Custom shades from 25 kg."],
  ["product_varieties", "variety_recommendation_rules", "Bridal and heavy work: Gold or Antique zari with a wide border. Everyday and festive ranges: Silver zari with narrow lace."],

  // --- Product applications (complete) ---
  ["product_applications", "primary_applications", "Saree borders, lehenga and bridal wear, dupattas, blouse work, and embroidery job work. For example, a Surat saree wholesaler buying 25mm gold border by the roll every month, or an embroidery unit buying antique zari for bridal lehenga work."],
  ["product_applications", "industry_applications", "Saree wholesalers, embroidery units, garment manufacturers, ethnic wear brands."],
  ["product_applications", "end_customer_uses", "The final buyer gets ethnic wear whose trim holds its colour and does not blacken after a season."],
  ["product_applications", "seasonal_applications", "Demand climbs from August through the wedding season and peaks before Diwali. Bookings for that period start in June."],
  ["product_applications", "bad_fit_applications", "Not for upholstery, footwear or industrial use, and not for anyone wanting a handful of pieces for personal sewing."],

  // --- Customer knowledge (complete) ---
  ["customer_knowledge", "current_customer_types", "Saree wholesalers, embroidery units, garment makers."],
  ["customer_knowledge", "ideal_customer_profile", "A repeat trade buyer in a textile hub who orders monthly in roll quantities and cares more about shade consistency than the last rupee."],
  ["customer_knowledge", "customer_pain_points", "Shades that do not repeat between orders, suppliers who miss the wedding-season window, and having to buy thread and trims from separate sellers."],
  ["customer_knowledge", "customer_success_definition", "The shade matches the last order, the delivery lands before their production date, and one call fixes any problem."],
  ["customer_knowledge", "bad_fit_customers", "Retail buyers, hobby customers, and anyone below our minimum order who will not grow past it."],
  ["customer_knowledge", "decision_makers", "The owner or purchase manager in a wholesale firm; the production head in an embroidery unit."],

  // --- Target market and geography (complete) ---
  ["target_market_geography", "serviceable_locations", "All of India."],
  ["target_market_geography", "priority_locations", "Surat, Varanasi, Mumbai, Jaipur, Delhi — the textile hubs where our buyers already cluster."],
  ["target_market_geography", "export_locations", "No exports today. Export enquiries go to a human."],
  ["target_market_geography", "excluded_locations", "Nothing is excluded within India, but remote locations add to delivery time."],
  ["target_market_geography", "delivery_geography_rules", "Gujarat and Maharashtra are quickest. Anywhere else adds two to three days. Exact days are confirmed by a person."],

  // --- Pricing policy (complete, and every line stays under human review) ---
  ["pricing_policy", "pricing_structure", "Per unit at trade rates — zari by the kilo, laces and borders by the metre, sequins and cutdana by the pack. The rate depends on design and quantity."],
  ["pricing_policy", "discount_policy", "Volume discounts exist but are approved by a person, never quoted by the agent."],
  ["pricing_policy", "moq_policy", "Zari thread from 5 kg, laces and borders from 100 metres, sequins from 10 packs, cutdana from 20 packs. Custom shades from 25 kg."],
  ["pricing_policy", "tax_policy", "GST is charged separately on top of the quoted rate."],
  ["pricing_policy", "price_change_policy", "Zari rates move with silver and raw material cost, so quotations carry a validity date."],
  ["pricing_policy", "manager_approval_price_cases", "Any discount, any custom-shade rate, and any order above one lakh rupees."],

  // --- Payment and credit (complete, human review throughout) ---
  ["payment_credit_terms", "payment_methods", "Bank transfer and UPI. No cash on delivery."],
  ["payment_credit_terms", "advance_payment_rule", "50% advance on the first order with a new buyer; the balance before dispatch."],
  ["payment_credit_terms", "credit_allowed", "Yes, but only for established accounts and only once a person approves it."],
  ["payment_credit_terms", "credit_eligibility", "Buyers with at least three completed orders and a clean payment record. New buyers, never."],
  ["payment_credit_terms", "credit_period", "30 days from dispatch where credit has been approved."],
  ["payment_credit_terms", "gst_quotation_validity", "GST is extra. A quotation holds for 15 days."],

  // --- WhatsApp and communication (complete) ---
  ["whatsapp_communication", "preferred_tone", "Warm, short, businesslike. Trade language, not marketing language."],
  ["whatsapp_communication", "greeting_style", "Greet by company name, say who we are in one line, then ask what they are looking for."],
  ["whatsapp_communication", "language_preferences", "Reply in the language the customer wrote in. Hindi, Gujarati, English and Hinglish are all fine; Hindi and Gujarati are the most common on WhatsApp, and English is fine for written quotations."],
  ["whatsapp_communication", "unknown_answer_reply", "Say plainly that you will confirm with the team and come back, and then hand it to a person. Never guess."],
  ["whatsapp_communication", "abusive_customer_handling", "Do not answer in kind and do not argue. Stop replying and hand the conversation to a person immediately."],
  ["whatsapp_communication", "auto_reply_boundaries", "Answer automatically: what we make, catalogue requests, minimum quantities, delivery in general terms. Always hand to a person: exact prices, discounts, credit, complaints, and anything legal."],

  // --- FAQs (complete) ---
  ["faqs", "frequent_questions", "What is the price? Can you send the catalogue? What is your minimum? How many days for delivery? Can you match this shade?"],
  ["faqs", "catalogue_faq", "Yes — send the catalogue straight away and ask which range they work in."],
  ["faqs", "sample_faq", "Samples are available. Shade cards are free; product samples are charged and adjusted against the first order."],
  ["faqs", "price_faq", "Do not quote a number. Say the rate depends on design and quantity, ask what they need and how much, and pass it to the team for a quotation."],
  ["faqs", "delivery_faq", "Stock lines dispatch in two to three days. Made-to-order takes seven to ten. Confirm the exact date with a person before promising it."],
  ["faqs", "custom_order_faq", "Custom shades are possible from 25 kg, need the customer's sample, and are quoted by a person."],

  // --- Partly answered from here down: a demo of a business mid-setup ---
  ["samples_catalogue_quotation_rules", "catalogue_available", "Yes. The catalogue PDF can be sent on WhatsApp without asking anyone."],
  ["samples_catalogue_quotation_rules", "sample_available", "Yes."],
  ["samples_catalogue_quotation_rules", "sample_charges", "Shade cards free. Product samples charged and adjusted against the first order."],
  ["samples_catalogue_quotation_rules", "quotation_requirements", "Product, shade, width or size, quantity, and the delivery city."],

  ["shipping_delivery", "delivery_timelines", "Two to three working days for stock lines; seven to ten for made-to-order."],
  ["shipping_delivery", "shipping_charges", "Charged at actuals and shown separately on the invoice."],
  ["shipping_delivery", "tracking_policy", "A dispatch note with the transporter's docket number goes out the day the goods leave."],

  ["lead_qualification", "mql_rules", "A trade buyer who asked about a product we actually sell and gave a company name."],
  ["lead_qualification", "sql_rules", "They named a quantity at or above our minimum and asked for a rate or a quotation."],
  ["lead_qualification", "hot_lead_signals", "Asked for a quotation, named a delivery date, or asked about credit terms."],
  ["lead_qualification", "do_not_contact_rules", "Anyone who asks to stop, anyone on the do-not-contact list, and any number that turns out to be a consumer rather than a business."],

  ["objection_handling", "price_objection", "Do not discount on the spot. Explain what the rate includes — mill-direct supply, shade matching, stock availability — and offer to have the team look at the quantity."],
  ["objection_handling", "quality_objection", "Offer a shade card and a sample against their own fabric. A sample settles it faster than an argument."],
  ["objection_handling", "moq_objection", "Explain the minimum plainly, and offer the smallest starting quantity we do take."],

  ["sales_process", "sales_stages", "Enquiry, qualification, catalogue or sample, quotation, order, dispatch."],
  ["sales_process", "first_response_process", "Find out the product, the quantity, and the city. Those three decide everything after it."],
  ["sales_process", "handoff_to_human", "Any exact price, any discount, any credit question, any complaint, any custom shade."],

  ["internal_operations", "business_hours", "Monday to Saturday, 9am to 6pm IST. Sunday closed."],
  ["internal_operations", "escalation_contacts", "The sales desk on the main number handles anything the agent hands over."],
];

/**
 * Turn the flat table above into stored answers, and refuse to write anything
 * the framework does not recognise.
 *
 * The check matters more than it looks: a typo in a domain or question key
 * would store an answer nothing ever reads — the Knowledge Base would still
 * show "0 of 17 answered" and the seed would look like it had worked. Failing
 * loudly at seed time is the difference between a bug found in one second and
 * a bug found by eye, later, on a screen.
 */
export function demoKnowledgeAnswers(workspaceId: string, now: string): NonNullable<AppData["knowledgeQuestionAnswers"]> {
  const byKey = new Map<string, { question: (typeof KNOWLEDGE_QUESTION_FRAMEWORK)[number]["questions"][number]; domainKey: string }>();
  for (const domain of KNOWLEDGE_QUESTION_FRAMEWORK) {
    for (const question of domain.questions) {
      byKey.set(`${domain.domainKey}::${question.questionKey}`, { question, domainKey: domain.domainKey });
    }
  }

  const seen = new Set<string>();
  return ANSWERS.map(([domainKey, questionKey, answer], index) => {
    const key = `${domainKey}::${questionKey}`;
    const found = byKey.get(key);
    if (!found) {
      throw new Error(`seed-demo-knowledge: "${key}" is not a question in KNOWLEDGE_QUESTION_FRAMEWORK. Fix the key or remove the row — a stored answer with an unknown key is invisible to every screen.`);
    }
    if (seen.has(key)) {
      throw new Error(`seed-demo-knowledge: "${key}" is answered twice. Two canonical answers to one question is the conflict state, not the answered state.`);
    }
    seen.add(key);
    const question = found.question;
    return {
      id: `kqa_demo_${String(index + 1).padStart(3, "0")}`,
      workspaceId,
      domainKey,
      questionKey,
      question: question.question,
      answer,
      answerStatus: "answered" as const,
      sourceType: "document" as const,
      sourceId: "kb_doc_demo",
      sourceTitle: "Demo company profile knowledge",
      // High but not perfect, and identical across rows on purpose: these came
      // from one document, so one confidence. A spread of invented per-row
      // scores would be a number that describes nothing.
      confidenceScore: 0.86,
      usedByAgentsJson: {},
      mapsToJson: {},
      // Kept from the framework rather than decided here. The framework already
      // knows which subjects a machine must not settle alone.
      humanReviewRequired: Boolean(question.humanReviewRequired),
      // Nothing is pre-approved. Approving is the operator's job, and a demo
      // that starts with it already done hides the step it is demonstrating.
      isUserApproved: false,
      isCanonical: true,
      evidenceJson: {
        sources: [{
          sourceType: "document" as const,
          sourceId: "kb_doc_demo",
          sourceTitle: "Demo company profile knowledge",
          sourceSnippet: answer.slice(0, 160),
          confidenceScore: 0.86,
          answer,
          createdAt: now,
        }],
      },
      createdAt: now,
      updatedAt: now,
    };
  });
}
