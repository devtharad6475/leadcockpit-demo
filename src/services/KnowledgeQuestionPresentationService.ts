import { getAllKnowledgeQuestions, getEssentialKnowledgeQuestions, KNOWLEDGE_CORE_DOMAINS, KNOWLEDGE_QUESTION_FRAMEWORK, type KnowledgeQuestion } from "@/knowledge/knowledge-question-framework";
import type { KnowledgeQuestionAnswer, UnknownQuestion } from "@/lib/types";

export type KnowledgeFrontendCategory =
  | "STRUCTURED_FACT"
  | "PROFILE_FACT"
  | "POLICY_SETTING"
  | "CONTEXTUAL_KNOWLEDGE"
  | "STRATEGIC_KNOWLEDGE"
  | "MISSING_CLARIFICATION";

export type GuidedKnowledgeBlock = {
  blockKey: string;
  domainKey: string;
  title: string;
  prompt: string;
  example: string;
  mappedQuestionKeys: string[];
  answeredCount: number;
  partialCount: number;
  missingCount: number;
  conflictCount: number;
  sampleAnswers: string[];
};

export type MissingBusinessDetailGroup = {
  groupKey: string;
  title: string;
  description: string;
  domainKey?: string;
  topic: "product" | "payment" | "shipping" | "whatsapp" | "lead" | "policy" | "profile" | "strategy" | "general";
  priority: "high" | "medium" | "low";
  status: "open" | "resolved" | "skipped" | "mixed";
  questionsCount: number;
  questionIds: string[];
  relatedQuestionKeys: string[];
  generatedByTypes: string[];
  exampleQuestions: string[];
  suggestedAnswer?: string;
};

export type EssentialQuestionGroup = {
  coreDomainKey: string;
  coreDomainTitle: string;
  description: string;
  questions: Array<{
    id: string;
    domainKey: string;
    domainTitle: string;
    questionKey: string;
    question: string;
    answerType: string;
    required: boolean;
    priority: string;
    humanReviewRequired: boolean;
  }>;
};

const profileDomains = new Set(["factual_company_profile"]);
const policyDomains = new Set([
  "payment_credit_terms",
  "shipping_delivery",
  "returns_replacement",
  "samples_catalogue_quotation_rules",
  "pricing_policy",
  "legal_terms_privacy",
  "customization",
]);
const strategicDomains = new Set([
  "buyer_segments",
  "lead_qualification",
  "product_research_market_map",
  "campaign_strategy_knowledge",
  "analytics_success_metrics",
]);

export function classifyKnowledgeQuestion(input: KnowledgeQuestion & { domainKey: string }): KnowledgeFrontendCategory {
  const text = `${input.domainKey} ${input.questionKey} ${input.question}`.toLowerCase();
  if (profileDomains.has(input.domainKey) || input.mapsTo.includes("business_profile")) return "PROFILE_FACT";
  if (policyDomains.has(input.domainKey) || input.answerType === "policy" || input.humanReviewRequired) return "POLICY_SETTING";
  if (/(moq|minimum|credit period|dispatch|delivery timeline|return window|replacement|gst|iec|phone|email|address|material|size|packaging|production lead time|sample availability|quotation validity|price|pricing)/.test(text)) {
    return "STRUCTURED_FACT";
  }
  if (strategicDomains.has(input.domainKey) || input.mapsTo.includes("campaign_strategy") || input.mapsTo.includes("lead_qualification") || input.mapsTo.includes("product_research")) return "STRATEGIC_KNOWLEDGE";
  if (input.missingAnswerBehavior === "create_unknown_question") return "MISSING_CLARIFICATION";
  return "CONTEXTUAL_KNOWLEDGE";
}

// N13: every function below takes the workspace's checklist; the defaults
// (the whole pool) exist only for callers with no workspace in hand.
export function getQuestionPresentationSummary(questions: ReturnType<typeof getAllKnowledgeQuestions> = getAllKnowledgeQuestions()) {
  const categoryCounts = questions.reduce<Record<KnowledgeFrontendCategory, number>>((acc, question) => {
    const category = classifyKnowledgeQuestion(question);
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {
    STRUCTURED_FACT: 0,
    PROFILE_FACT: 0,
    POLICY_SETTING: 0,
    CONTEXTUAL_KNOWLEDGE: 0,
    STRATEGIC_KNOWLEDGE: 0,
    MISSING_CLARIFICATION: 0,
  });
  return { totalQuestions: questions.length, categoryCounts };
}

export function getEssentialQuestionGroups(questions: ReturnType<typeof getAllKnowledgeQuestions> = getAllKnowledgeQuestions()): EssentialQuestionGroup[] {
  const essentials = questions.filter((question) => question.isEssential);
  return KNOWLEDGE_CORE_DOMAINS.map((coreDomain) => ({
    ...coreDomain,
    questions: essentials
      .filter((question) => question.coreDomainKey === coreDomain.coreDomainKey)
      .map((question) => ({
        id: `${question.domainKey}/${question.questionKey}`,
        domainKey: question.domainKey,
        domainTitle: question.domainTitle,
        questionKey: question.questionKey,
        question: question.question,
        answerType: question.answerType,
        required: question.required,
        priority: question.priority,
        humanReviewRequired: question.humanReviewRequired,
      })),
  })).filter((group) => group.questions.length > 0);
}

const guidedBlockDefinitions: Record<string, Array<{ blockKey: string; title: string; prompt: string; example: string; match: RegExp }>> = {
  company_knowledge: [
    { blockKey: "company_overview", title: "Company Overview", prompt: "Explain what your company does, what you mainly sell, who usually buys from you, and what makes your business different.", example: "We manufacture and supply products for B2B customers including retailers, wholesalers, and manufacturers.", match: /overview|value|strength|position|promise|intro|trust|differentiator|brand/ },
    { blockKey: "proof_and_trust", title: "Trust Builders", prompt: "Add safe trust points such as experience, factory/showroom presence, catalogue, testimonials, certifications, or customer industries.", example: "Catalogue available, established manufacturing experience, and proven track record across customer segments.", match: /proof|factory|showroom|certification|testimonial|scale|experience|asset/ },
  ],
  product_knowledge: [
    { blockKey: "product_range", title: "Product Range", prompt: "Describe the main products, categories, specifications, strengths, and product limits agents should remember.", example: "Core products across multiple categories, available in various specifications and finishes.", match: /product|category|feature|benefit|seller|limit|material|specification|quality/ },
  ],
  product_varieties: [
    { blockKey: "variants_and_specs", title: "Variants and Specifications", prompt: "Add product variants, sizes, colors, grades, stock/made-to-order rules, MOQ differences, and recommendation notes.", example: "Premium variants are made to order; standard products are available from catalogue.", match: /variety|variant|grade|model|size|color|stock|made|moq|recommendation|premium/ },
  ],
  customer_knowledge: [
    { blockKey: "customers_and_buying", title: "Customers and Buying Behavior", prompt: "Describe current buyers, ideal buyers, customer needs, pain points, objections, and buying triggers.", example: "Retail buyers need variety and samples; wholesalers care about repeat availability and pricing.", match: /customer|buyer|pain|decision|fit|objection|trigger|success|segment/ },
  ],
  target_market_geography: [
    { blockKey: "geography_and_regions", title: "Geography and Market Reach", prompt: "Add where you sell now, where you want leads from, locations to avoid, export readiness, and delivery-region rules.", example: "Currently India-focused; UAE export buyers are desired but export documents need confirmation.", match: /location|region|geography|export|delivery|language|priority|serve/ },
  ],
  sales_process: [
    { blockKey: "sales_workflow", title: "Sales Workflow", prompt: "Describe enquiry handling, what to ask first, quotation inputs, follow-up rules, and when AI should hand off to a human.", example: "Ask for product type, quantity, location, and design reference before quotation.", match: /sales|response|quotation|follow|handoff|document|stage|process/ },
  ],
  whatsapp_communication: [
    { blockKey: "communication_rules", title: "WhatsApp and Reply Behavior", prompt: "Define tone, greeting, language, unknown-answer reply, auto-reply boundaries, and human-review topics.", example: "Warm and concise. For unknown details say: I will confirm this with our team and get back to you.", match: /tone|greeting|language|unknown|abusive|auto|reply|message|whatsapp/ },
  ],
  product_applications: [
    { blockKey: "applications_and_use_cases", title: "Applications and Use Cases", prompt: "Explain where products are used, which industries use them, seasonal use cases, examples, and bad-fit applications.", example: "Used across multiple industries and customer applications, with both standard and custom use cases.", match: /application|industry|season|use|example|bad|fit/ },
  ],
  campaign_strategy_knowledge: [
    { blockKey: "campaign_direction", title: "Campaign Direction", prompt: "Add campaign angles, target segments, priority geographies, lead sources, search phrases, and approval rules.", example: "Target relevant buyer segments during peak demand periods with a clear value proposition.", match: /campaign|target|source|search|angle|approval|intent/ },
  ],
};

const defaultGuidedBlock = {
  blockKey: "domain_summary",
  title: "Business Context",
  prompt: "Add the useful business details for this section in simple language. The system will map this section to internal questions for agents.",
  example: "Write the practical facts, rules, exceptions, and examples a sales or support agent should know.",
  match: /.*/,
};

export function buildGuidedKnowledgeBlocks(answers: KnowledgeQuestionAnswer[], framework: typeof KNOWLEDGE_QUESTION_FRAMEWORK = KNOWLEDGE_QUESTION_FRAMEWORK): GuidedKnowledgeBlock[] {
  const byKey = new Map(answers.map((answer) => [`${answer.domainKey}/${answer.questionKey}`, answer]));
  return framework.flatMap((domain) => {
    const definitions = guidedBlockDefinitions[domain.domainKey] || [defaultGuidedBlock];
    const assigned = new Set<string>();
    const blocks = definitions.map((definition) => {
      const questionKeys = domain.questions
        .filter((question) => definition.match.test(`${question.questionKey} ${question.question}`.toLowerCase()))
        .map((question) => question.questionKey);
      const mappedQuestionKeys = (questionKeys.length ? questionKeys : domain.questions.map((question) => question.questionKey))
        .filter((key) => {
          if (assigned.has(key) && questionKeys.length) return false;
          assigned.add(key);
          return true;
        });
      return { definition, mappedQuestionKeys };
    });
    // Guided-block coverage fix (2026-08-14, found while wiring the
    // fixed-choice dropdown for business_type): a domain's block regexes
    // don't have to cover every question in that domain — e.g.
    // company_knowledge's two regexes never match "business_type" or
    // "years_in_business" — and any question none of them match used to
    // silently vanish from the whole guided view, with no error and no
    // owner-visible sign it was missing. Whatever's left unassigned after
    // every block in a domain has run now gets folded into that domain's
    // last block, so every question is reachable somewhere.
    const leftover = domain.questions.map((question) => question.questionKey).filter((key) => !assigned.has(key));
    if (leftover.length && blocks.length) {
      const last = blocks[blocks.length - 1];
      last.mappedQuestionKeys = [...last.mappedQuestionKeys, ...leftover];
    }
    return blocks.map(({ definition, mappedQuestionKeys }) => {
      const blockAnswers = mappedQuestionKeys.map((key) => byKey.get(`${domain.domainKey}/${key}`)).filter(Boolean) as KnowledgeQuestionAnswer[];
      return {
        blockKey: `${domain.domainKey}:${definition.blockKey}`,
        domainKey: domain.domainKey,
        // Ten domains have hand-written blocks; the framework has twenty-six.
        // Every other one fell back to a block called "Business Context", so
        // the demo's guided view listed fifteen sections under that one name,
        // each with the same prompt, and an owner could not tell which part of
        // their business they were being asked about. The domain's own title
        // was on the record the whole time.
        title: definition === defaultGuidedBlock ? domain.domainTitle : definition.title,
        prompt: definition.prompt,
        example: definition.example,
        mappedQuestionKeys,
        answeredCount: blockAnswers.filter((answer) => answer.answerStatus === "answered").length,
        partialCount: blockAnswers.filter((answer) => answer.answerStatus === "partial" || answer.answerStatus === "needs_review").length,
        missingCount: mappedQuestionKeys.length - blockAnswers.filter((answer) => ["answered", "partial", "needs_review", "conflict", "not_applicable"].includes(answer.answerStatus)).length,
        conflictCount: blockAnswers.filter((answer) => answer.answerStatus === "conflict").length,
        sampleAnswers: blockAnswers.map((answer) => answer.answer || "").filter(Boolean).slice(0, 3),
      };
    });
  });
}

/**
 * Q-7 (2026-08-24) — the "start here" stage.
 *
 * `groupMissingBusinessDetails` below buckets a fresh tenant's whole backlog by
 * inferred topic. On a new workspace that is 90 cards. Nobody finishes 90 cards
 * on their first day, and an owner who abandons setup halfway leaves the AI
 * half-knowing the business, which is worse than an AI that knows nothing.
 *
 * The framework already marks 50 questions `isEssential` and already maps every
 * domain to one of 12 core domains. This function uses both to carve the SAME
 * records into a first stage of at most 12 groups. Deliberately the same
 * `MissingBusinessDetailGroup` shape and the same `questionIds`, so answering a
 * start-here card goes through the one existing write path
 * (`POST /api/unknown-questions/groups/answer`) — no second way to save an
 * answer, no second thing to keep correct.
 *
 * Scale: O(n) over records already in memory, and the group count is bounded by
 * the 12 core domains no matter how large the tenant grows.
 */
export type EssentialSetupStage = {
  groups: MissingBusinessDetailGroup[];
  essentialOpenCount: number;
  essentialTotalCount: number;
  remainingOpenCount: number;
};

const essentialQuestionByMarker = new Map(
  getEssentialKnowledgeQuestions().map((question) => [`${question.domainKey}/${question.questionKey}`, question]),
);

/** True when this backlog record came from a question the owner must answer before the AI may speak for them. */
export function isEssentialSetupQuestion(item: UnknownQuestion): boolean {
  if (!item.relatedDomain || !item.relatedQuestionKey) return false;
  return essentialQuestionByMarker.has(`${item.relatedDomain}/${item.relatedQuestionKey}`);
}

export function groupEssentialSetupQuestions(items: UnknownQuestion[]): EssentialSetupStage {
  const knowledgeItems = items.filter((item) => item.channel === "knowledge");
  const essentialItems = knowledgeItems.filter(isEssentialSetupQuestion);
  const buckets = new Map<string, UnknownQuestion[]>();
  for (const item of essentialItems) {
    const question = essentialQuestionByMarker.get(`${item.relatedDomain}/${item.relatedQuestionKey}`)!;
    buckets.set(question.coreDomainKey, [...(buckets.get(question.coreDomainKey) || []), item]);
  }

  // Core-domain order, not bucket-insertion order: the owner should always meet
  // these twelve areas in the same sequence, starting with who the business is.
  const groups = KNOWLEDGE_CORE_DOMAINS.flatMap((coreDomain) => {
    const groupItems = buckets.get(coreDomain.coreDomainKey);
    if (!groupItems?.length) return [];
    const open = groupItems.filter((item) => item.status === "open").length;
    const resolved = groupItems.filter((item) => item.status === "added_to_knowledge" || item.status === "answered").length;
    const skipped = groupItems.filter((item) => item.status === "ignored").length;
    const status: MissingBusinessDetailGroup["status"] = open ? (resolved || skipped ? "mixed" : "open") : skipped && !resolved ? "skipped" : "resolved";
    return [{
      groupKey: `essential:${coreDomain.coreDomainKey}`,
      title: coreDomain.coreDomainTitle,
      description: coreDomain.description,
      domainKey: groupItems[0].relatedDomain,
      topic: inferMissingTopic(groupItems[0]),
      // Every start-here group is high priority by definition. These are the
      // questions the AI is blocked on, not a nice-to-have backlog.
      priority: "high" as const,
      status,
      questionsCount: groupItems.length,
      questionIds: groupItems.map((item) => item.id),
      relatedQuestionKeys: groupItems.map((item) => item.relatedQuestionKey || "").filter(Boolean),
      generatedByTypes: Array.from(new Set(groupItems.map((item) => item.generatedBy || "framework"))),
      exampleQuestions: groupItems.map((item) => item.questionText).slice(0, 4),
      suggestedAnswer: groupItems.find((item) => item.suggestedAnswer)?.suggestedAnswer,
    }];
  });

  return {
    groups,
    essentialOpenCount: essentialItems.filter((item) => item.status === "open").length,
    essentialTotalCount: essentialItems.length,
    remainingOpenCount: knowledgeItems.filter((item) => item.status === "open" && !isEssentialSetupQuestion(item)).length,
  };
}

export function groupMissingBusinessDetails(items: UnknownQuestion[]): MissingBusinessDetailGroup[] {
  const openRelevant = items.filter((item) => item.channel === "knowledge");
  const buckets = new Map<string, UnknownQuestion[]>();
  for (const item of openRelevant) {
    const topic = inferMissingTopic(item);
    const domain = normalizeDomain(item.relatedDomain || item.missingTopic || "general");
    const productName = inferProductName(item.questionText);
    const groupKey = productName && topic === "product" ? `product-item:${productName.toLowerCase()}` : `${topic}:${domain}`;
    buckets.set(groupKey, [...(buckets.get(groupKey) || []), item]);
  }
  return Array.from(buckets.entries()).map(([groupKey, groupItems]) => {
    const topic = inferMissingTopic(groupItems[0]);
    const priority: MissingBusinessDetailGroup["priority"] = groupItems.some((item) => item.priority === "high") ? "high" : groupItems.some((item) => item.priority === "medium" || !item.priority) ? "medium" : "low";
    const open = groupItems.filter((item) => item.status === "open").length;
    const resolved = groupItems.filter((item) => item.status === "added_to_knowledge" || item.status === "answered").length;
    const skipped = groupItems.filter((item) => item.status === "ignored").length;
    const status: MissingBusinessDetailGroup["status"] = open ? resolved || skipped ? "mixed" : "open" : skipped && !resolved ? "skipped" : "resolved";
    return {
      groupKey,
      title: groupTitle(groupKey, topic, groupItems[0]),
      description: groupDescription(topic, groupItems),
      domainKey: groupItems[0].relatedDomain,
      topic,
      priority,
      status,
      questionsCount: groupItems.length,
      questionIds: groupItems.map((item) => item.id),
      relatedQuestionKeys: groupItems.map((item) => item.relatedQuestionKey || "").filter(Boolean),
      generatedByTypes: Array.from(new Set(groupItems.map((item) => item.generatedBy || "framework"))),
      exampleQuestions: groupItems.map((item) => item.questionText).slice(0, 4),
      suggestedAnswer: groupItems.find((item) => item.suggestedAnswer)?.suggestedAnswer,
    };
  }).sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.questionsCount - a.questionsCount);
}

function inferMissingTopic(item: UnknownQuestion): MissingBusinessDetailGroup["topic"] {
  const text = `${item.relatedDomain || ""} ${item.missingTopic || ""} ${item.questionText}`.toLowerCase();
  if (/(moq|product|material|size|color|colour|grade|spec|pack|stock|customization|warranty)/.test(text)) return "product";
  if (/(payment|credit|advance|gst|quotation|price|pricing|discount)/.test(text)) return "payment";
  if (/(shipping|delivery|dispatch|return|replacement|refund|damage|cancellation)/.test(text)) return "shipping";
  if (/(policy|legal|privacy|terms|sample|catalogue)/.test(text)) return "policy";
  if (/(whatsapp|reply|tone|message|escalation|customer conversation)/.test(text)) return "whatsapp";
  if (/(lead|qualification|buyer|segment|icp|mql|sql|hot)/.test(text)) return "lead";
  if (/(profile|company|address|phone|email|website|gst|iec)/.test(text)) return "profile";
  if (/(campaign|market|geography|strategy|analytics)/.test(text)) return "strategy";
  return "general";
}

function normalizeDomain(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "general";
}

function inferProductName(text: string) {
  const match = text.match(/(?:for|about)\s+([A-Z][A-Za-z0-9\s-]{2,40})/);
  const candidate = match?.[1]?.trim();
  if (!candidate || /knowledge|terms|policy|profile|question|domain/i.test(candidate)) return undefined;
  return candidate;
}

function groupTitle(groupKey: string, topic: MissingBusinessDetailGroup["topic"], item: UnknownQuestion) {
  const productName = groupKey.startsWith("product-item:") ? groupKey.replace("product-item:", "") : "";
  if (productName) return `Missing product order details: ${titleCase(productName)}`;
  const label = (item.relatedDomain || item.missingTopic || topic).replaceAll("_", " ");
  const prefix: Record<MissingBusinessDetailGroup["topic"], string> = {
    product: "Missing product details",
    payment: "Missing payment or credit rules",
    shipping: "Missing shipping, return, or delivery rules",
    whatsapp: "Missing WhatsApp reply behavior",
    lead: "Missing lead qualification rules",
    policy: "Missing business policy details",
    profile: "Missing company profile facts",
    strategy: "Missing market or campaign context",
    general: "Missing business details",
  };
  return `${prefix[topic]}: ${titleCase(label)}`;
}

function groupDescription(topic: MissingBusinessDetailGroup["topic"], items: UnknownQuestion[]) {
  const examples: Record<MissingBusinessDetailGroup["topic"], string> = {
    product: "Please add available details such as MOQ, packing, variants, customization, stock availability, use case, warranty, and usual dispatch time.",
    payment: "Please add the practical payment, advance, GST, credit eligibility, credit period, and quotation-validity rules.",
    shipping: "Please add serviceable locations, dispatch time, shipping charges, return/replacement window, and claim requirements.",
    whatsapp: "Please add how the agent should respond, when it should escalate, and which topics need human review.",
    lead: "Please add the signals that make a lead qualified, disqualified, hot, MQL, or SQL.",
    policy: "Please add the approved business rule and any situations where the team must review before replying.",
    profile: "Please add factual company identity details such as address, website, email, phone, GST/IEC, year established, or public brand basics.",
    strategy: "Please add strategic context such as target markets, campaign angles, search phrases, buyer segments, and success metrics.",
    general: "Please add the useful business detail once. The system will map it to the internal questions behind this card.",
  };
  return `${examples[topic]} This card covers ${items.length} internal question${items.length === 1 ? "" : "s"}.`;
}

function priorityRank(priority: MissingBusinessDetailGroup["priority"]) {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function titleCase(value: string) {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
