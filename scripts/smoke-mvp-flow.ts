import { calculateFNRTScore, canCreateOutreachActivity, canEnrichLead, getLeadStatusFromReplyClassification, shouldProtectQualifiedStatus } from "../src/lib/lead-rules";
import type { Lead } from "../src/lib/types";
import { classifyCustomerMessage } from "../src/conversations/message-classification";
import { defaultWhatsAppAgentSettings } from "../src/policies/default-company-communication-settings";
import { getPersistenceProvider } from "../src/repositories";
import { decideAutoReply } from "../src/services/AutoReplyDecisionService";
import { assertNoDuplicateModelIds, DEFAULT_MODEL_CATALOG } from "../src/llm/model-catalog";
import { LLM_PROVIDERS } from "../src/llm/provider-types";
import { routeModelSelection } from "../src/llm/ModelRouter";
import { platformSlotDefaults } from "../src/llm/platform-defaults";
import { readFileSync, readdirSync } from "node:fs";
import { canConfigureAI, canExportData, canManageMembers, canViewAnalytics } from "../src/lib/permissions";
import { maskSecret, redactSecretsFromObject } from "../src/lib/secret-redaction";
import { encryptSecret, decryptSecret } from "../src/lib/credential-security";
import { checkRateLimit } from "../src/services/RateLimitService";
import { detectKnowledgeConflicts } from "../src/services/ConflictDetectionService";
import { getAllKnowledgeQuestions, KNOWLEDGE_QUESTION_FRAMEWORK } from "../src/knowledge/knowledge-question-framework";
import { extractQuestionAnswersFromText } from "../src/services/DocumentQuestionAnsweringService";
import { createExtractionPlan, DOCUMENT_QA_BATCH_SIZE } from "../src/services/KnowledgeQuestionBatcher";
import { retrieveRelevantDocumentContext } from "../src/services/DocumentContextRetrievalService";
import { mergeExtractedAnswers } from "../src/services/KnowledgeAnswerMergeService";
import { buildCombinedSourceText } from "../src/services/KnowledgeSourceBundleService";
import { calculateExtractionQuality } from "../src/services/ExtractionQualityService";
import { AGENT_NAMES } from "../src/constants/agents";
import { agentNameForTask } from "../src/agents/AgentRuntime";
import { MetaWhatsAppCloudProvider } from "../src/providers/whatsapp/MetaWhatsAppCloudProvider";
import type { AppData, KnowledgeQuestionAnswer } from "../src/lib/types";
import { draftProductSettingsFromNotes } from "../src/services/ProductSettingsDraftService";
import { draftStructuredSettingsFromAnswer } from "../src/services/StructuredSettingsDraftService";
import { createLeadAgentActionPlan } from "../src/services/LeadAgentActionPlanService";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

// 2026-09-04 N-SMOKE-7 — the live half of this file hard-coded
// http://127.0.0.1:3000 in twenty places. This project's dev server runs on
// 3010 (see .claude/launch.json); port 3000 on this machine belongs to a
// DIFFERENT application. So the live half never ran here — and worse, if that
// other app happened to be up, this file would have sent it real POSTs and PUTs
// (/api/crawl/start, /api/lead-review/settings, /api/documents/process) against
// somebody else's data.
//
// It now points at this project's own port and can be aimed elsewhere with
// SMOKE_BASE_URL. The guard below is the important half: before any write, the
// server has to prove it is THIS app by answering /api/health with a
// persistenceProvider. A stranger on the port is skipped, not written to.
const SMOKE_BASE_URL = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3010";

async function serverIsThisApp(): Promise<boolean> {
  try {
    const response = await fetch(`${SMOKE_BASE_URL}/api/health`);
    if (!response.ok) return false;
    const body = await response.json() as { persistenceProvider?: string };
    return typeof body.persistenceProvider === "string";
  } catch {
    return false;
  }
}

const baseLead: Lead = {
  id: "lead_test",
  workspaceId: "workspace_demo",
  companyName: undefined,
  leadScore: 0,
  fitScore: 0,
  needScore: 0,
  reachabilityScore: 0,
  timingScore: 0,
  confidenceScore: 0,
  status: "needs_review",
  enrichmentStatus: "not_started",
  reviewStatus: "pending",
  doNotContact: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

assert(baseLead.companyName === undefined, "Lead with partial data should allow missing companyName");
assert(!canEnrichLead({ ...baseLead, reviewStatus: "rejected", status: "rejected" }), "Rejected lead cannot be enriched");
assert(canEnrichLead({ ...baseLead, reviewStatus: "approved", status: "approved" }), "Approved lead can be enriched");
assert(shouldProtectQualifiedStatus("hot_lead"), "Hot lead status should be protected");
assert(getLeadStatusFromReplyClassification("ask_price", "approved") === "hot_lead", "Price reply should move to hot_lead");
assert(getLeadStatusFromReplyClassification("ask_catalogue", "approved") === "mql", "Catalogue reply should move to mql");
assert(getLeadStatusFromReplyClassification("asks_for_call", "approved") === "sql", "Call reply should move to sql");
assert(getLeadStatusFromReplyClassification("unsubscribe", "hot_lead") === "do_not_contact", "Unsubscribe should override hot lead");
assert(canCreateOutreachActivity({ ...baseLead, reviewStatus: "approved", status: "approved" }), "Approved lead can create outreach activity");
assert(!canCreateOutreachActivity({ ...baseLead, reviewStatus: "approved", status: "do_not_contact", doNotContact: true }), "DNC lead cannot create outreach");
assert(!canCreateOutreachActivity({ ...baseLead, reviewStatus: "rejected", status: "rejected" }), "Rejected lead cannot create outreach");
// L-3 (2026-08-04): the old assertion hard-required JSON ("Repository factory
// should default to JSON persistence"), which made the smoke FAIL the moment
// the operator flipped .env to prisma — even though nothing was actually
// broken (it failed purely because of the deliberate env change, not a
// regression). Now mode-aware: the smoke passes in EITHER runtime, asserting
// the provider matches what's configured (reads the env correctly). The
// prisma-specific round-trips are covered by smoke-prisma-auth +
// smoke-prisma-runtime + golden:prisma-commercial-parity.
const configuredProvider = getPersistenceProvider();
assert(configuredProvider === "json" || configuredProvider === "prisma", `Repository factory should resolve to a known provider (json|prisma), got "${configuredProvider}"`);
if (configuredProvider === "prisma") {
  console.log("  (mode-aware: PERSISTENCE_PROVIDER=prisma — running business-rule checks against the Postgres runtime)");
}
assert(canConfigureAI("owner") && canConfigureAI("admin"), "Owner/admin should configure AI");
assert(!canConfigureAI("sales_member"), "Sales member should not configure AI");
assert(canExportData("owner") && !canExportData("admin"), "Only owner should export workspace data");
assert(canViewAnalytics("viewer"), "Viewer should view analytics");
assert(canManageMembers("owner") && !canManageMembers("admin"), "Only owner should manage members");
assert(maskSecret("sk-test-secret") === "sk-t...cret", "Secret masking should preserve only prefix/suffix");
const redacted = redactSecretsFromObject({ apiKey: "sk-test-secret", nested: { token: "abc123456789" } }) as { apiKey: string; nested: { token: string } };
assert(redacted.apiKey !== "sk-test-secret" && redacted.nested.token !== "abc123456789", "Redaction should hide nested secrets");
const encrypted = encryptSecret("sk-real-key");
assert(encrypted !== "sk-real-key" && decryptSecret(encrypted) === "sk-real-key", "Credential helper should not store raw secrets and should decrypt demo wrapper");
// Stage C.1: checkRateLimit is now async (Redis backend awaits INCR/EXPIRE).
// The actual rate-limit assertion moved into main() below so it can be awaited.
// This top-level block stays sync for the non-async setup checks.
const conflicts = detectKnowledgeConflicts(["Payment is 50% advance.", "Payment is 100% advance."]);
assert(conflicts.length > 0 && conflicts[0].requiresResolution, "Conflict detection should catch contradictory payment terms");
const requiredKnowledgeDomains = [
  "company_knowledge", "factual_company_profile", "product_knowledge", "product_varieties", "product_applications",
  "customer_knowledge", "target_market_geography", "buyer_segments", "lead_qualification", "sales_process",
  "whatsapp_communication", "faqs", "objection_handling", "payment_credit_terms", "shipping_delivery",
  "returns_replacement", "customization", "samples_catalogue_quotation_rules", "pricing_policy",
  "product_research_market_map", "campaign_strategy_knowledge", "legal_terms_privacy", "internal_operations",
  "analytics_success_metrics", "extra_unmapped_information",
];
for (const domainKey of requiredKnowledgeDomains) {
  const domain = KNOWLEDGE_QUESTION_FRAMEWORK.find((item) => item.domainKey === domainKey);
  assert(Boolean(domain), `Knowledge framework should include ${domainKey}`);
  // Was ">= 10 per section": a count, which is what padded the bank with
  // generic filler (AGENTS.md, amended 2026-08-24: never pad a domain to reach
  // a count). Question quality is pinned by golden-question-bank-quality;
  // here the section only has to exist and ask something.
  assert((domain?.questions || []).length >= 1, `${domainKey} should ask at least one question`);
}
const allKnowledgeQuestions = getAllKnowledgeQuestions();
// 2026-09-04 N-SMOKE-1 — this said `>= 425`, and it has been failing since
// 1ff250c (2026-08-24) deliberately cut the padded 523-question bank down to
// the 424 that survived the quality audit. The floor was never lowered to
// match, so this whole file aborted here and nothing below it ran.
//
// It is pinned to the exact number rather than re-floored, because a floor
// only catches questions going missing and the failure that actually happened
// was the bank growing back with padding. An exact count catches both.
// 2026-09-26 (N13): the 424 were replaced by a 217-question pool from which
// each business gets its own checklist (195 for a maker + trader). Still an
// exact pin, for the same reason: a change in size must be a decision.
assert(allKnowledgeQuestions.length === 217, `Knowledge framework should hold exactly the 217 checklist-pool questions, found ${allKnowledgeQuestions.length}`);
const domainQuestionCounts = KNOWLEDGE_QUESTION_FRAMEWORK.map((item) => item.questions.length);
// 2026-09-04 N-SMOKE-2 — this asserted "varied question depths", which
// described the 523-question bank BEFORE the 1ff250c audit. That audit deleted
// the quota padding, and what it left behind is deliberately even: every domain
// carries its curated questions plus generated depth up to a cap, so the depths
// are 17 across the board with a single 16.
//
// Varied depth is therefore no longer a property of this product, and an
// assertion that cannot pass is not protecting anything. What the audit DID
// establish is the cap — the thing that would break if padding crept back in —
// so that is what is pinned here instead.
const deepestDomain = Math.max(...domainQuestionCounts);
const shallowestDomain = Math.min(...domainQuestionCounts);
assert(deepestDomain <= 17, `No knowledge domain may exceed the 17-question cap the 1ff250c audit set; deepest is ${deepestDomain}. A domain above the cap means quota padding has come back.`);
// 2026-09-26 (N13): the "at least 16 per section" floor described the padded
// bank's even depth. Sections now hold what their topic needs (1 to 12);
// dropped questions are caught by the exact 217 pin above instead.
assert(shallowestDomain >= 1, `Every knowledge section must ask something; shallowest is ${shallowestDomain}.`);
const extractionPlan = createExtractionPlan();
assert(extractionPlan.length === KNOWLEDGE_QUESTION_FRAMEWORK.length, "Extraction should create one batch per knowledge domain");
assert(extractionPlan.every((batch) => batch.questions.length <= DOCUMENT_QA_BATCH_SIZE), "Every extraction batch should respect configured batch size");
assert(extractionPlan.some((batch) => batch.domainKey === "product_knowledge"), "Extraction plan should preserve domain batching");
const productBatch = extractionPlan.find((batch) => batch.domainKey === "product_knowledge");
assert(Boolean(productBatch), "Product batch should exist");
const retrievedContext = retrieveRelevantDocumentContext("Premium zari thread material is metallic polyester. MOQ is 100 rolls. Payment is 50% advance.", productBatch!);
assert(retrievedContext.contextText.length > 0 && retrievedContext.contextText.length < 5000, "Batch context retrieval should return compact relevant context");
const uniqueQuestionKeys = new Set(allKnowledgeQuestions.map((item) => `${item.domainKey}:${item.questionKey}`));
assert(uniqueQuestionKeys.size === allKnowledgeQuestions.length, "Knowledge framework should not contain duplicate domain/question keys");
for (const item of allKnowledgeQuestions) {
  assert(Boolean(item.description && item.whyItMatters && item.answerType && item.priority), "Every knowledge question should include required metadata");
  assert(Array.isArray(item.usedByAgents) && item.usedByAgents.length > 0, "Every knowledge question should declare agent usage");
  assert(Array.isArray(item.mapsTo) && item.mapsTo.length > 0, "Every knowledge question should declare mapping targets");
}
const questionAnswers = extractQuestionAnswersFromText("Balaji Zari Udyog manufactures premium zari lace and decorative borders for bridal boutiques and garment manufacturers. Payment is 50% advance for custom orders. Delivery is usually 7 days in India. Catalogue is available on WhatsApp.");
assert(questionAnswers.some((item) => item.answerStatus !== "unanswered"), "Question answering should extract answers from company document text");
assert(questionAnswers.some((item) => item.answerStatus === "unanswered"), "Question answering should keep missing answers as unanswered");
const conflictingAnswers = extractQuestionAnswersFromText("Payment is 100% advance for all orders.", [{
  id: "existing_answer",
  workspaceId: "workspace_demo",
  domainKey: "payment_credit_terms",
  questionKey: "advance_payment_rule",
  question: "How much advance does the company take, and when is the balance due?",
  answer: "Payment is 50% advance.",
  answerStatus: "answered",
  sourceType: "manual_edit",
  confidenceScore: 1,
  usedByAgentsJson: {},
  mapsToJson: {},
  humanReviewRequired: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}]);
assert(conflictingAnswers.some((item) => item.answerStatus === "conflict"), "Question answering should mark contradictory answers as conflict");

const mergeNow = new Date().toISOString();
const mergeData: AppData = {
  workspaces: [], users: [], workspaceMembers: [], businessProfiles: [], websiteCrawlConsents: [], crawlJobs: [], crawlPages: [], businessExtractions: [],
  productKnowledges: [], productVarieties: [], productApplications: [], buyerSegments: [], productApplicationMarketMaps: [], icps: [], campaigns: [],
  leads: [], leadReviewSettings: [], leadReviewDecisions: [], messageTemplates: [], outreachActivities: [], replies: [], integrations: [],
  agentRuns: [],
  campaignLearnings: [], campaignMetrics: [], eventLogs: [], jobRuns: [], agentBehaviorPolicies: [], companyCommunicationSettings: [],
  conversationPolicies: [], whatsAppAgentSettings: [], escalationRules: [], unknownQuestions: [], autoReplyLogs: [], knowledgeBaseDocuments: [],
  knowledgeBaseChunks: [], knowledgeBaseQueryLogs: [], knowledgeQuestionAnswers: [], knowledgeExtractionRuns: [], knowledgeExtractionBatches: [],
  llmProviderCredentials: [], llmModelRoutings: [], aiUsageLimits: [],
};
const extractedMergeAnswer = (answer: string, status: KnowledgeQuestionAnswer["answerStatus"], sourceId: string) => ({
  domainKey: mergeBaseAnswer.domainKey,
  domainTitle: "Payment / Credit Terms",
  questionKey: mergeBaseAnswer.questionKey,
  question: mergeBaseAnswer.question,
  answer,
  answerStatus: status,
  sourceType: "document" as const,
  sourceId,
  confidenceScore: 0.8,
  usedByAgentsJson: {},
  mapsToJson: {},
  humanReviewRequired: true,
});
const mergeBaseAnswer: KnowledgeQuestionAnswer = {
  id: "kqa_website",
  workspaceId: "workspace_demo",
  domainKey: "payment_credit_terms",
  questionKey: "advance_payment_rule",
  question: "How much advance does the company take, and when is the balance due?",
  answer: "Payment is 50% advance.",
  answerStatus: "answered",
  sourceType: "website",
  sourceId: "crawl_test",
  confidenceScore: 0.8,
  usedByAgentsJson: {},
  mapsToJson: {},
  humanReviewRequired: true,
  isCanonical: true,
  evidenceJson: { sources: [{ sourceType: "website", sourceId: "crawl_test", answer: "Payment is 50% advance.", createdAt: mergeNow }] },
  createdAt: mergeNow,
  updatedAt: mergeNow,
};
mergeData.knowledgeQuestionAnswers = [mergeBaseAnswer];
mergeExtractedAnswers({
  workspaceId: "workspace_demo",
  sourceType: "document",
  sourceId: "doc_same",
  sourceTitle: "Payment policy",
  extractedAnswers: [extractedMergeAnswer("Payment is 50% advance.", "answered", "doc_same")],
  data: mergeData,
  now: mergeNow,
});
assert((mergeData.knowledgeQuestionAnswers || []).length === 1, "Same answer should merge source evidence without duplicate visible answer");
assert((mergeData.knowledgeQuestionAnswers?.[0].evidenceJson?.sources || []).length >= 2, "Merged answer should retain multiple source evidence records");
mergeExtractedAnswers({
  workspaceId: "workspace_demo",
  sourceType: "document",
  sourceId: "doc_missing",
  extractedAnswers: [extractedMergeAnswer("", "unanswered", "doc_missing")],
  data: mergeData,
  now: mergeNow,
});
assert(mergeData.knowledgeQuestionAnswers?.[0].answer === "Payment is 50% advance.", "Unanswered incoming extraction must not erase existing answer");
mergeExtractedAnswers({
  workspaceId: "workspace_demo",
  sourceType: "document",
  sourceId: "doc_conflict",
  extractedAnswers: [extractedMergeAnswer("Payment is 100% advance.", "answered", "doc_conflict")],
  data: mergeData,
  now: mergeNow,
});
assert(mergeData.knowledgeQuestionAnswers?.[0].answerStatus === "conflict", "Contradictory extraction should mark canonical answer as conflict");
assert((mergeData.unknownQuestions || []).some((item) => item.generatedBy === "conflict_detection"), "Contradictory extraction should create clarification question");
const combinedSourceText = buildCombinedSourceText([
  {
    id: "source_site",
    workspaceId: "workspace_demo",
    bundleId: "bundle_test",
    sourceType: "website",
    sourceTitle: "Website scan: example.com",
    sourceUrl: "https://example.com",
    extractedText: "Website says catalogue is available.",
    metadataJson: {},
    status: "ready",
    createdAt: mergeNow,
    updatedAt: mergeNow,
  },
  {
    id: "source_file",
    workspaceId: "workspace_demo",
    bundleId: "bundle_test",
    sourceType: "uploaded_file",
    sourceTitle: "brochure.pdf",
    sourceFileName: "brochure.pdf",
    extractedText: "Document says catalogue is available.",
    metadataJson: {},
    status: "ready",
    createdAt: mergeNow,
    updatedAt: mergeNow,
  },
]);
assert(combinedSourceText.includes("[Source: Website scan: example.com]"), "Combined extraction should preserve website source label");
assert(combinedSourceText.includes("[Source: File - brochure.pdf]"), "Combined extraction should preserve file source label");
const quality = calculateExtractionQuality({
  run: {
    id: "run_quality",
    workspaceId: "workspace_demo",
    sourceType: "manual_text",
    status: "completed",
    totalQuestions: 10,
    processedQuestions: 10,
    answeredCount: 8,
    partialCount: 1,
    unansweredCount: 1,
    conflictCount: 0,
    failedBatchCount: 0,
    totalBatches: 1,
    completedBatches: 1,
    outputJson: {},
    createdAt: mergeNow,
    updatedAt: mergeNow,
  },
  answers: [
    { ...mergeBaseAnswer, answerStatus: "answered", confidenceScore: 0.9 },
    { ...mergeBaseAnswer, id: "kqa_missing_quality", questionKey: "missing_quality", answer: "", answerStatus: "unanswered", confidenceScore: 0 },
  ],
  batches: [{
    id: "batch_quality",
    workspaceId: "workspace_demo",
    extractionRunId: "run_quality",
    documentId: "doc_quality",
    domainKey: "company_knowledge",
    batchIndex: 0,
    questionKeysJson: { values: ["company_overview"] },
    status: "completed",
    attemptCount: 1,
    maxAttempts: 1,
    modelProvider: "deepseek",
    modelName: "deepseek-v4-flash",
    timeoutMs: 420000,
    resultJson: { answeredCount: 8, partialCount: 1, unansweredCount: 1, conflictCount: 0 },
    startedAt: mergeNow,
    completedAt: mergeNow,
    createdAt: mergeNow,
    updatedAt: mergeNow,
  }],
});
assert(quality.score >= 0 && Boolean(quality.nextAction), "Extraction quality score should calculate a user next action");

const score = calculateFNRTScore({ fitScore: 6, needScore: 4, reachabilityScore: 4, timingScore: -1 });
assert(score.fitScore === 5, "Fit score should clamp to 5");
assert(score.timingScore === 0, "Timing score should clamp to 0");
assert(score.totalScore === 13, "Total score should sum clamped values");
assert(score.qualificationStatus === "good_prospect", "13 should map to good_prospect");

const settings = {
  id: "wa_test",
  ...defaultWhatsAppAgentSettings("workspace_demo"),
  enabled: true,
  mode: "safe_auto_reply" as const,
  // D-2026-09-27-b: every tickable kind on, so the checks below prove the
  // sensitive kinds still wait even when the owner allowed all the rest.
  autoReplyTopics: ["greeting", "catalogue_request", "location_question", "moq_request", "sample_request"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const greeting = classifyCustomerMessage("Hi");
assert(greeting.category === "greeting", "WhatsApp greeting should classify as greeting");
// D-2026-09-27-b: only kinds the owner ticked (after the trial) go out by themselves.
assert(!decideAutoReply({ settings: { ...settings, autoReplyTopics: [] }, classification: greeting, lead: baseLead, hasSupportingKnowledge: false, isGenericSafeReply: true }).canAutoSend, "An unticked greeting must wait for the owner");
assert(decideAutoReply({ settings: { ...settings, autoReplyTopics: ["greeting"] }, classification: greeting, lead: baseLead, hasSupportingKnowledge: false, isGenericSafeReply: true }).canAutoSend, "A ticked greeting can auto-reply in safe_auto_reply mode");
const price = classifyCustomerMessage("What is the price?");
assert(price.category === "price_request", "Price message should classify as price_request");
assert(decideAutoReply({ settings, classification: price, lead: baseLead, hasSupportingKnowledge: false }).needsHumanReview, "Price without knowledge must require human review");
const unknown = classifyCustomerMessage("Can you provide ISO certificate validity?");
assert(unknown.requiresHumanReview, "Unknown specific question should require human review");
const unsubscribe = classifyCustomerMessage("stop messaging me");
assert(unsubscribe.leadStatusSuggestion === "do_not_contact", "Stop message should suggest do_not_contact");
const abusive = classifyCustomerMessage("This is fraud stupid");
assert(abusive.riskLevel === "high" && abusive.requiresHumanReview, "Abusive message should be high risk and require review");
assert(decideAutoReply({ settings, classification: abusive, lead: baseLead, hasSupportingKnowledge: false }).needsHumanReview, "Abusive message should never auto-send");
const complaint = classifyCustomerMessage("The product is damaged and I have a complaint");
assert(complaint.category === "complaint", "Complaint should classify as complaint");
assert(decideAutoReply({ settings, classification: complaint, lead: baseLead, hasSupportingKnowledge: true }).needsHumanReview, "Complaint should require human review");
const bulk = classifyCustomerMessage("We need wholesale bulk quantity");
assert(bulk.category === "bulk_order_interest", "Bulk order should classify as bulk_order_interest");
assert(decideAutoReply({ settings, classification: bulk, lead: baseLead, hasSupportingKnowledge: true }).needsHumanReview, "Bulk order should require human review");
const payment = classifyCustomerMessage("Can I pay later on credit terms?");
assert(payment.category === "payment_question", "Payment terms should classify as payment_question");
assert(decideAutoReply({ settings, classification: payment, lead: baseLead, hasSupportingKnowledge: true }).needsHumanReview, "Payment question should require human review");
const rejectedLead = { ...baseLead, reviewStatus: "rejected" as const, status: "rejected" as const };
assert(decideAutoReply({ settings, classification: greeting, lead: rejectedLead, hasSupportingKnowledge: true, isGenericSafeReply: true }).blocked, "Rejected lead should block auto-reply");
assertNoDuplicateModelIds();
for (const provider of LLM_PROVIDERS) {
  assert(DEFAULT_MODEL_CATALOG.some((model) => model.provider === provider), `Model catalog should include ${provider}`);
}
const routed = routeModelSelection("whatsapp_reply", []);
assert(routed.slotId === "fast_customer_reply", "WhatsApp reply should route to fast customer reply slot");
// 2026-09-04 N-SMOKE-3 — this said an unconfigured route must be `mock`, which
// stopped being true at N-AI-2 (2026-08-20). Before that, platform defaults were
// a frozen table of six `mock` rows, so a fresh install answered real customers
// with sample text even when the operator's key was sitting in the environment.
// They are now resolved from the environment on every call, so on this machine
// the default is whatever provider actually has a key.
//
// Asserting `mock` therefore pinned a bug that was deliberately removed. What
// matters — and what UA-7 fought for — is that with no slot row configured the
// route says so plainly and lands on the platform default rather than some
// hidden third tier. That is the property pinned here.
const platformDefault = platformSlotDefaults().fast_customer_reply;
assert(routed.routeSource === "platform_default", `An unconfigured route must report itself as a platform default, not "${routed.routeSource}" — a hidden override tier is what UA-7 removed.`);
assert(routed.provider === platformDefault.provider, `An unconfigured route must use the platform default provider (${platformDefault.provider}), not "${routed.provider}".`);
assert(decideAutoReply({ settings: { ...settings, mode: "automatic" }, classification: greeting, lead: baseLead, hasSupportingKnowledge: false, isGenericSafeReply: true }).canAutoSend, "Automatic mode should allow strict low-risk greetings");
assert(decideAutoReply({ settings: { ...settings, mode: "automatic" }, classification: price, lead: baseLead, hasSupportingKnowledge: true }).needsHumanReview, "Automatic mode must still hold price questions for review");

// 2026-09-04 N-SMOKE-4 — this read src/app/page.tsx alone, and thirty-three
// assertions below it were failing for one reason: the screens they describe
// were long ago moved out of page.tsx into src/app/sections/*.tsx. The copy
// they look for is still on screen; it is just in another file.
//
// So the fix is the corpus, not the thirty-three strings. This is now every
// file the operator's UI is actually built from. It is strictly stricter than
// what it replaces: the positive assertions get a larger haystack, and the
// NEGATIVE ones ("this label must NOT appear") now have to hold across the
// whole UI instead of one file.
//
// It globs rather than listing the sections, so a screen extracted tomorrow is
// covered without anybody remembering to add it here.
const pageSource = [
  "src/app/page.tsx",
  ...readdirSync("src/app/sections").filter((file) => file.endsWith(".tsx")).map((file) => `src/app/sections/${file}`),
].map((file) => readFileSync(file, "utf8")).join("\n");
const routeSource = readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
// Cluster 10 (2026-07-26) extracted the shared api() helper to src/lib/api-client.ts.
// The "cache: no-store" directive lives there now; page.tsx imports + uses it. Static-
// source assertions must follow the refactor or they break on every chokepoint move.
const apiClientSource = readFileSync("src/lib/api-client.ts", "utf8");
const llmServiceSource = readFileSync("src/llm/LLMService.ts", "utf8");
const whatsappEngineSource = readFileSync("src/services/WhatsAppConversationEngine.ts", "utf8");
const sharedAgentRules = readFileSync("agents/_shared-agent-operating-rules.md", "utf8");
assert(sharedAgentRules.includes("Authority Order"), "Shared agent rules should define authority order");
assert(agentNameForTask("document_extraction_mapping") === "document_extraction", "Document extraction task should load Document Extraction Agent");
assert(agentNameForTask("whatsapp_reply") === "whatsapp_conversation", "WhatsApp task should load WhatsApp Conversation Agent");
assert(agentNameForTask("lead_review_decision") === "lead_review", "Lead review task should load Lead Review Agent");
assert(llmServiceSource.includes("buildAgentRuntimePrompt"), "LLMService must load agent runtime instructions for every task");
assert(whatsappEngineSource.includes("WhatsAppLLMReplyOutputSchema"), "WhatsApp engine should validate LLM reply output schema");
assert(whatsappEngineSource.includes('runTask<Record<string, unknown>>("whatsapp_reply"'), "WhatsApp engine should generate drafts through LLMService");
assert(whatsappEngineSource.includes("maybeSendWhatsApp"), "WhatsApp engine should include provider-ready send gate");
assert(whatsappEngineSource.includes("validationStatus"), "WhatsApp logs should include LLM validation diagnostics");
assert(whatsappEngineSource.includes("sendStatus"), "WhatsApp logs should include send status diagnostics");
for (const agentName of AGENT_NAMES) {
  const fileName = agentName.replace(/_agent$/, "").replaceAll("_", "-") + "-agent.md";
  const agentMarkdown = readFileSync(`agents/${fileName}`, "utf8");
  assert(agentMarkdown.includes("Shared Runtime Contract"), `${fileName} should include shared runtime contract`);
}

// Task 2: Documents removed from sidebar
assert(!pageSource.includes('"documents", "Documents"'), "Documents must NOT appear as a standalone sidebar item");
assert(pageSource.includes('"onboarding", "Onboarding"'), "Onboarding must remain in sidebar");

// Task 3: Sidebar has all required items
assert(pageSource.includes("AI Settings"), "Sidebar should expose AI Settings");
assert(pageSource.includes('"settings", "Settings"'), "Sidebar should expose Settings");
assert(pageSource.includes("Export / Backup"), "Sidebar should expose Export / Backup");
assert(pageSource.includes("overflow-y-auto"), "Sidebar/navigation should be vertically scrollable");

// Task 4: Onboarding has permission checkbox and multi-file upload
assert(pageSource.includes("I confirm that I have permission to scan this website"), "Website scan must require consent checkbox");
assert(pageSource.includes("multiple"), "Document upload must support multiple files");
assert(pageSource.includes("Extract Company Knowledge"), "Document upload must have Extract Company Knowledge button");
assert(!pageSource.includes('label="Document title"'), "Document title field must NOT be in main onboarding flow");
assert(pageSource.includes("Advanced: paste text manually"), "Paste text must be hidden under Advanced section");

// Task 6: Knowledge Base - one global Sync Knowledge, no per-section sync
assert(pageSource.includes("guided company brain"), "Knowledge Base must use guided company brain language");
// M11 cleanup (2026-07-21 session 11) renamed "internal checks" → "knowledge
// framework" in user-facing copy. The smoke was asserting on the old jargon;
// updated to match the post-cleanup reality. (R5 2026-07-21: noticed this
// was already broken before this session — fixing the stale assertion.)
assert(pageSource.includes("knowledge framework"), "Knowledge Base must hide raw question workload behind the knowledge framework");
// 2026-09-25 cleanup: the "Knowledge review workflow" panel and its "Domain
// Quality Overview" repeated the section list; replaced by four status tiles
// that filter that list.
// 2026-09-30: the four tiles became one summary row of filter chips (page guide).
assert(pageSource.includes("waiting for your OK") && pageSource.includes("where answers disagree"), "Knowledge Base should say what needs the owner at the top");
assert(pageSource.includes("safe answers"), "Knowledge Base should support safe bulk approval");
assert(pageSource.includes("View sources"), "Knowledge answers should expose source evidence without raw JSON");
assert(pageSource.includes("Details by section"), "Extraction status should expose per-section detail");
assert(pageSource.includes("Product specifications"), "Information Needed should include topic filters");
assert(pageSource.includes("High priority first"), "Information Needed should default to high-priority review");
// 2026-09-04 N-SMOKE-5 — this looked for the heading "Overall Questions from AI
// progress", which 2969b8b deleted along with the scoreboard under it (a
// percentage badge, a bar, two sentences and four tiles, in which four numbers
// were the same number and four totals disagreed).
//
// The heading is gone; the thing it was protecting is not. The point was that
// progress reads the WHOLE workload, so an operator narrowing the filters
// cannot make his remaining work appear to shrink. That is a property of which
// list the percentage is computed from, so it is pinned directly: the bar must
// be driven by progressGroups (everything) and never by visibleGroups (what
// survived the filters).
const questionsSource = readFileSync("src/app/sections/QuestionsFromAI.tsx", "utf8");
assert(/overallProgressPercent\s*=\s*Math\.round\(\(resolvedGroupCount\s*\/\s*Math\.max\(progressGroups\.length/.test(questionsSource), "Overall progress must be computed from progressGroups (the whole workload). Computing it from the filtered list lets an operator shrink his own remaining work by changing a filter.");
assert(!/overallProgressPercent[\s\S]{0,120}visibleGroups/.test(questionsSource), "Overall progress must not be derived from visibleGroups — that is the filtered list.");
assert(pageSource.includes("Recently resolved information"), "Information Needed should expose resolved groups without forcing a status filter switch");
assert(pageSource.includes("Sync Knowledge is needed before agents use this update"), "Information Needed should hand saved answers back to the global Sync Knowledge action");
assert(pageSource.includes("Open Sync Knowledge"), "Information Needed should navigate users to the global Sync Knowledge action after saving");
assert(pageSource.includes('"/api/unknown-questions/groups/answer"'), "Grouped Information Needed answers should use the group mapping endpoint");
assert(pageSource.includes('cache: "no-store"') || apiClientSource.includes('cache: "no-store"'), "App API reads should avoid stale browser-cached Information Needed state (assertion follows the Cluster 10 api-client refactor — the literal now lives in src/lib/api-client.ts)");
assert(pageSource.includes("markGroupResolvedLocally"), "Information Needed save should update visible progress immediately after a grouped answer");
assert(pageSource.includes("relatedQuestionKeys: currentGroup.relatedQuestionKeys"), "Grouped answer save should send internal framework keys for durable mapping");
assert(routeSource.includes('"cache-control": "no-store"'), "API responses should prevent stale grouped Information Needed progress after mutation");
assert(!pageSource.includes("Grouped answer saved under"), "Grouped Information Needed answers must not ignore extra internal questions");
assert(pageSource.includes("not set yet"), "Sync Knowledge summary should explain missing structured settings in business language");
assert(pageSource.includes("Open Settings"), "Sync Knowledge summary should guide users to structured settings when settings are missing");
assert(pageSource.includes("Agent contexts updated"), "Sync Knowledge summary should show refreshed CRM agent contexts");
assert(pageSource.includes("CRM agent context"), "Sync Knowledge summary should explain that agent-ready contexts were refreshed");
assert(pageSource.includes("sourceDetails"), "Sync Knowledge summary should expose settings source provenance from the backend");
assert(pageSource.includes("Reviewed Questions from AI vs direct Settings"), "Sync Knowledge UI should distinguish reviewed Information Needed draft sources");
assert(pageSource.includes("What the AI checks first"), "CRM lead records should show the synced agent context they rely on");
assert(pageSource.includes("/api/agent-context/summary"), "CRM record context should come from a backend-owned agent context summary route");
assert(pageSource.includes("Suggested next step"), "CRM lead records should expose a CRM-native agent action plan");
assert(pageSource.includes("/agent-action-plan"), "CRM agent action plan should use a backend-owned lead route");
assert(pageSource.includes("Human review required"), "CRM agent action plan should visibly keep human review gating");
assert(pageSource.includes("MessageGenerationStatus"), "Messages should show provider/model and review state for generated outreach drafts");
assert(pageSource.includes("Human reviewed"), "Approved messages should show that the review gate was completed");
assert(pageSource.includes("Check this reply before sending"), "Messages should identify older drafts that lack AI metadata");
assert(pageSource.includes("meta.context?.conflictsPending"), "Message draft UI should warn when the knowledge it used still has open contradictions (the raw answer/chunk counts were removed as jargon, cleanup 28a153f)");
assert(routeSource.includes("createReviewedOutreachDraft"), "Message generation route should delegate to provider-aware backend service");
assert(routeSource.includes("syncWorkspaceKnowledge"), "Knowledge sync should run through backend service");
const leadAgentPlanSource = readFileSync("src/services/LeadAgentActionPlanService.ts", "utf8");
assert(leadAgentPlanSource.includes("buildAgentWorkspaceContextSummary"), "Lead agent plan should use synced workspace context");
assert(leadAgentPlanSource.includes("LLMService"), "Lead agent plan should run through provider-aware LLM service");
assert(leadAgentPlanSource.includes("humanReviewRequired: true"), "Lead agent plan should keep outreach under human review");
assert(routeSource.includes("createLeadAgentActionPlan"), "Lead agent action plan route should delegate to backend service");
const messageGenerationSource = readFileSync("src/services/MessageGenerationService.ts", "utf8");
assert(messageGenerationSource.includes("LLMService"), "Message generation should run through provider-aware LLM service");
assert(messageGenerationSource.includes("buildAgentWorkspaceContextSummary"), "Message generation should use synced workspace context");
assert(messageGenerationSource.includes("humanReviewRequired: true"), "Message generation metadata should keep outreach under human review");
assert(messageGenerationSource.includes('reviewState: "pending_review"'), "Generated messages should start as pending-review drafts");
assert(messageGenerationSource.includes("generationMeta"), "Message generation should persist provider/model status with the draft");
assert(routeSource.includes("reviewState: nextStatus"), "Message approve/use actions should keep review metadata aligned with message status");
const syncServiceSource = readFileSync("src/services/SyncKnowledgeService.ts", "utf8");
assert(syncServiceSource.includes("productSettings?.products?.length"), "Empty Product Settings records should remain not configured during Sync Knowledge");
assert(syncServiceSource.includes("listByWorkspace(workspaceId)"), "Sync Knowledge should inspect saved and pending settings draft history");
const agentRuntimeSource = readFileSync("src/agents/AgentRuntime.ts", "utf8");
assert(agentRuntimeSource.includes("## Approved Workspace Context"), "Agent runtime prompts should include synced workspace context");
assert(pageSource.includes("Paste product details in your words"), "Product settings should support plain-language product capture");
assert(pageSource.includes("Turn into product rows"), "Product settings should draft reviewable rows before saving");
assert(pageSource.includes("Review Product Settings draft"), "Product Information Needed answers should create a reviewed product-settings handoff");
assert(pageSource.includes("Save reviewed Product Settings"), "Product Information Needed drafts should require owner save before becoming source of truth");
assert(pageSource.includes("isProductSettingsCandidate"), "Product settings handoff should be limited to product-related Information Needed cards");
assert(routeSource.includes('["settings", "products", "draft"]'), "Product settings draft API should be backend-owned");
assert(pageSource.includes("Review structured settings draft"), "Non-product Information Needed answers should create reviewed structured-settings drafts");
assert(pageSource.includes("Save reviewed settings"), "Structured settings drafts should require owner save before becoming source of truth");
assert(pageSource.includes("Review pending settings"), "Unsaved settings drafts should remain visible for owner review");
assert(pageSource.includes("/api/settings/pending-drafts"), "Pending settings drafts should be loaded from a backend-owned route");
assert(pageSource.includes("inferSettingsDraftDomainKey"), "Generated Information Needed cards should infer a draft settings domain when needed");
assert(routeSource.includes('["settings", "draft-from-answer"]'), "Structured settings draft API should be backend-owned");
assert(routeSource.includes('["settings", "pending-drafts"]'), "Pending settings draft API should be backend-owned");
assert(syncServiceSource.includes("source-of-truth settings"), "Sync Knowledge should not silently promote Information Needed answers into structured settings");

const productDraft = draftProductSettingsFromNotes([
  "Product: Standard Widget - category: Components; material: steel; packaging: 20 pieces per box; MOQ: 100 pieces; stock dispatch: 2 days; uses: factories, repair shops",
  "Custom Panel - category: Fabrication; material: aluminium; packaging: crate; MOQ: project based; production time: 10-15 days; customization available",
].join("\n"));
assert(productDraft.products.length === 2, "Plain-language product notes should create two reviewable product drafts");
assert(productDraft.products[0].moq?.includes("100"), "Product draft should detect MOQ");
assert(productDraft.products[0].packaging?.includes("20 pieces"), "Product draft should detect packaging");
assert(productDraft.products[1].customizationAvailable === true, "Product draft should detect customization");
const productInfoDraft = draftProductSettingsFromNotes("Product: Trade Sample Pack - category: Sample kit; material: mixed materials; packaging: 12 units per box; MOQ: 48 units; dispatch: 3 days; uses: dealer demos, catalogue samples; customization available");
assert(productInfoDraft.products.length === 1, "Product Information Needed owner answer should draft a product settings row");
assert(productInfoDraft.products[0].name === "Trade Sample Pack", "Product Information Needed draft should preserve product name");
assert(productInfoDraft.products[0].inStockDispatchTime?.includes("3 days"), "Product Information Needed draft should detect dispatch");
const structuredDraft = draftStructuredSettingsFromAnswer({
  domainKey: "payment_credit_terms",
  relatedQuestionKeys: ["credit_period", "payment_methods", "advance_payment_rule"],
  answer: "Standard payment is 50% advance and 50% before dispatch. Credit requires owner approval.",
});
assert(structuredDraft.fields.some((field) => field.area === "sales" && field.fieldKey === "standardCreditPeriod"), "Payment Information Needed answers should draft Sales settings fields");
assert(structuredDraft.fields.some((field) => field.area === "policy" && field.fieldKey === "paymentPolicy"), "Payment Information Needed answers should draft Policy settings fields");
const mixedGroupDraft = draftStructuredSettingsFromAnswer({
  domainKey: "whatsapp_communication",
  relatedQuestionKeys: ["deep_11_whatsapp_behavior_questions_still_needed"],
  answer: "Use a warm concise tone and ask the team when knowledge is missing.",
});
assert(mixedGroupDraft.fields.some((field) => field.area === "communication" && field.fieldKey === "tone"), "Mixed Information Needed groups should still draft settings from their business domain");
assert(typeof createLeadAgentActionPlan === "function", "CRM lead agent plan service should be importable");

// Task 8: Campaign is agent-led
assert(!pageSource.includes("Campaign goal"), "Simple campaign UI should not ask for a manual campaign goal");
assert(pageSource.includes("Make a campaign plan"), "Campaign planner should offer one plan action (label changed in cleanup 9ccce5c)");

// Task 9: Discovery is source-plan based
assert(!pageSource.includes("Assisted prospect discovery"), "Discovery page should no longer use confusing label");
assert(pageSource.includes("Who we will go looking for"), "Discovery page should be named for the job it does, not the feature (N-UX-44)");

// Task 10: Lead review modes present
// 2026-09-25 cleanup: four modes -> the two the server actually distinguishes.
assert(pageSource.includes("You approve every lead"), "Lead review must offer the approve-every-lead mode");
assert(pageSource.includes("Approve safe leads automatically"), "Lead review must offer the auto-approve mode");

// Task 11 / Task 15: AI Settings and other pages reachable
assert(pageSource.includes('"ai", "AI Settings"'), "AI Settings must be in sidebar tab list");
assert(pageSource.includes("Your checklist:"), "Knowledge Base should show which checklist the business is on (N13; old heading removed in cleanup 1844887)");
assert(pageSource.includes("Your company's fixed details"), "Business Profile UI should be titled for the job, not restated by its own subtitle (N-UX-46)");
// 2026-08-05 S-1: labels renamed in the UX overhaul — smoke was asserting the
// OLD names ("Information Needed", "AI Review Queue") and failing. Updated to
// the current nav labels.
assert(pageSource.includes("Questions from AI"), "Questions from AI (was Information Needed) workflow should be present");
// 2026-09-04 N-SMOKE-6 — this looked for the panel title "WhatsApp agent
// enquiry to you", which 2969b8b renamed. The panel is still there; it now
// names the job and carries the urgency ("A customer is waiting for an
// answer"), which is the point — a real person is blocked on this.
//
// So the assertion pins the panel's behaviour rather than its wording: the
// questions that came from a live WhatsApp conversation are separated out of
// the general queue and shown as urgent, because they are the only ones with a
// customer sitting at the other end.
assert(/const whatsappQuestions = openItems\.filter\(\(item\) => item\.channel === "whatsapp"\)/.test(questionsSource), "Questions raised by a live WhatsApp conversation must still be separated from the general queue.");
assert(/whatsappQuestions\.length[\s\S]{0,400}?tone="urgent"/.test(questionsSource), "The WhatsApp question panel must be toned urgent — a customer is waiting on it, unlike the rest of the queue.");
assert(pageSource.includes("Agent Instructions"), "Workspace agent instructions UI should be reachable");
assert(pageSource.includes("AGENT_NAMES.map"), "Agent Instructions UI should use the shared agent registry");
assert(pageSource.includes("WhatsApp Agent"), "WhatsApp Agent page must be reachable");
assert(pageSource.includes("Questions from AI"), "Questions from AI page must be reachable");
assert(pageSource.includes("AI Drafts"), "AI Drafts (was AI Review Queue) must be reachable");

// 15s, not 5s. A Next dev server compiles each route on first hit, and a cold
// `/api/state` regularly exceeds 5s — which made the live-API half abort on a
// perfectly healthy server (and then, before the F-4 fix, report "passed").
async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = 15000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // 2026-09-05 (session 52) — say WHICH request ran out of time.
    //
    // A cold Turbopack dev server compiles a route on first hit, so one slow
    // endpoint aborts the live half of this smoke. The report then said "the
    // dev server answered the probe and then became unreachable" and named
    // nothing, which describes a crash. The server was healthy both times; a
    // single route had simply exceeded its budget, and there was no way to tell
    // which one without adding logging by hand.
    //
    // The error's NAME is preserved, because isServerUnreachable() matches on
    // it — only the human-readable half changes.
    //
    // 2026-09-08 — the NAME was preserved and the MESSAGE was thrown away, and
    // isServerUnreachable() reads both: its regex matches "fetch failed" and
    // "ECONNREFUSED", which live in the message, not the name. Node reports a
    // refused connection as `TypeError: fetch failed`, so after wrapping, all
    // that survived was "TypeError" — which the regex does not list. The
    // result: with no dev server running, this smoke reported
    //
    //     /api/health did not answer within 60s (TypeError)
    //
    // and FAILED, where it was written to skip. That is every CI run, which
    // starts no dev server, and every developer who runs the smoke without one.
    // The original message is now kept, so the detector still sees what it
    // matches on, and `cause` keeps the whole original error for a reader.
    const original = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const wrapped = new Error(
      `${url.replace(SMOKE_BASE_URL, "")} did not answer within ${timeoutMs / 1000}s ` +
        `(${original})`,
      { cause: error },
    );
    wrapped.name = error instanceof Error ? error.name : "Error";
    throw wrapped;
  }
}

/**
 * True for "the dev server is not running", false for every other error.
 *
 * 2026-08-05 (audit finding F-4): this distinction is the whole point. The
 * previous version wrapped the entire live-API section in one try/catch that
 * printed "Live API smoke skipped or failed" and then let the script exit 0.
 * A genuine assertion failure — a real regression — was therefore reported
 * with the same words, and the same green exit code, as "no server running".
 * A gate that cannot fail is not a gate.
 */
function isServerUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ECONNREFUSED|fetch failed|TimeoutError|AbortError|ENOTFOUND|socket hang up/i.test(message);
}

// "skipped" = no server at all. "aborted" = there WAS a server and it stopped
// answering mid-run. Distinct because they mean different things to whoever
// reads the output: the first is normal local usage, the second is a symptom.
type LiveCheckOutcome = "ran" | "skipped" | "aborted";

/**
 * Endpoints whose assertions were NOT run because the endpoint returned a
 * non-OK status. Populated by `optional()` below and printed in the summary.
 *
 * 2026-08-05 (audit F-4): previously these were bare `if (resp.ok) { ... }`
 * blocks, so a 500 from an endpoint silently erased its assertions and the
 * smoke still printed "passed". Now every such skip is NAMED in the output.
 * The run can still be green (some of these endpoints genuinely depend on
 * optional configuration), but it can no longer be green and SILENT.
 */
const skippedEndpoints: string[] = [];

/** Endpoints this smoke calls that no longer exist server-side (HTTP 404). */
const missingEndpoints: string[] = [];

/**
 * Run `body` only if the response is OK; otherwise record a NAMED skip.
 *
 * A 404 is called out separately from other non-OK statuses: it means the
 * smoke is calling a route that no longer exists, so the assertions inside
 * have not run for however long the route has been gone. That is test rot,
 * not a configuration difference, and it should be fixed rather than tolerated.
 */
async function optional(name: string, response: Response, body: () => Promise<void>): Promise<void> {
  if (response.ok) return body();
  if (response.status === 404) missingEndpoints.push(name);
  else skippedEndpoints.push(`${name} (HTTP ${response.status})`);
}

async function checkApiStateIfServerIsRunning(): Promise<LiveCheckOutcome> {
  // Probe FIRST, separately, so "is the server up?" is answered before any
  // assertion runs. After this point the server is known to be reachable and
  // every failure below is a real failure.
  //
  // The probe deliberately hits BOTH /api/health (cheap liveness) and
  // /api/state (the first endpoint the real checks use) with a long timeout,
  // so a Next dev server does its cold route-compilation HERE rather than
  // blowing the tighter budget of the assertions that follow.
  try {
    await timedFetch(`${SMOKE_BASE_URL}/api/health`, {}, 60000);
    await timedFetch(`${SMOKE_BASE_URL}/api/state`, {}, 60000);
  } catch (error) {
    if (isServerUnreachable(error)) return "skipped";
    throw error;
  }

  // N-SMOKE-7 — something answered on the port. Everything below WRITES, so it
  // has to be this app before a single POST goes out.
  if (!await serverIsThisApp()) {
    console.log(`  Something is listening on ${SMOKE_BASE_URL} but it is not this application — skipping every live check rather than writing to it.`);
    return "skipped";
  }

  try {
    const response = await timedFetch(`${SMOKE_BASE_URL}/api/state`);
    // The server IS up, so a non-OK /api/state is a defect, not a skip.
    assert(response.ok, `/api/state should return 200 while the server is running (got ${response.status})`);
    const state = await response.json() as { recommendedNextAction?: string };
    assert(Boolean(state.recommendedNextAction), "/api/state should return a recommended next action");
    const dryRun = await timedFetch(`${SMOKE_BASE_URL}/api/whatsapp-agent/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace_demo", rawText: "send catalogue and price" }),
    });
    await optional("whatsapp-agent/dry-run", dryRun, async () => {
      // 2026-09-25: a dry run saves nothing. It used to create a real draft in
      // the approval queue on every smoke run (golden-whatsapp-test-saves-nothing).
      const payload = await dryRun.json() as { dryRun?: boolean; wouldHave?: { queuedDraftForApproval?: boolean }; needsHumanReview?: boolean };
      assert(payload.dryRun === true, "WhatsApp dry-run should report that it saved nothing");
      assert(payload.wouldHave?.queuedDraftForApproval === true, "and that a real message would have queued a draft");
      assert(payload.needsHumanReview === true, "Catalogue plus price should be held for human review");
    });
    const consentUrl = `https://consent-required-${Date.now()}.example`;
    const blockedCrawl = await timedFetch(`${SMOKE_BASE_URL}/api/crawl/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace_demo", websiteUrl: consentUrl, pageLimit: 1 }),
    });
    assert(blockedCrawl.status === 400, "Crawler should not start without explicit consent");
    const consent = await timedFetch(`${SMOKE_BASE_URL}/api/crawl/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace_demo", websiteUrl: consentUrl, consentGiven: true }),
    });
    assert(consent.ok, "Crawler consent endpoint should accept explicit consent");
    const settings = await timedFetch(`${SMOKE_BASE_URL}/api/lead-review/settings`);
    await optional("lead-review/settings", settings, async () => {
      const settingsPayload = await settings.json() as { mode?: string; allowAutoSend?: boolean };
      assert(["manual_review", "agent_recommendation", "high_confidence_auto_approval", "full_automation_with_limits"].includes(String(settingsPayload.mode)), "Lead review should return a valid mode");
      assert(settingsPayload.allowAutoSend === false, "Lead review settings must keep auto-send disabled");
      const updatedSettings = await timedFetch(`${SMOKE_BASE_URL}/api/lead-review/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace_demo", mode: "agent_recommendation", allowAutoSend: false }),
      });
      assert(updatedSettings.ok, "Lead review settings should be selectable");
      const updatedPayload = await updatedSettings.json() as { mode?: string; allowAutoSend?: boolean };
      assert(updatedPayload.mode === "agent_recommendation", "Lead review setting should persist selected mode");
      await timedFetch(`${SMOKE_BASE_URL}/api/lead-review/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace_demo", mode: "manual_review", allowAutoSend: false }),
      });
    });
    // 2026-09-05 N-FEAT-1 / N-SMOKE-8 — this route makes a LIVE, BILLED model
    // call. Measured against the real database on two consecutive runs: 122s
    // and 79s. Two things follow from that number.
    //
    // It cannot share the 15s default, and the 60s budget it was first given
    // did not help either — the timeout aborted the ENTIRE live half of the
    // smoke and reported "server became unreachable", which is a frightening
    // way to describe a route that was simply still working.
    //
    // And it does not belong on the default path of a check meant to be run
    // often: every run would spend two minutes and real money, and rewrite the
    // demo workspace's five product collections as a side effect.
    //
    // So it is opt-in. What the route does is pinned where it belongs instead:
    // golden-mutateall-removal-parity CASE C proves the five collections
    // replace rather than append, against the real database and with no model
    // call at all.
    if (process.env.SMOKE_PRODUCT_RESEARCH === "1") {
      const productResearch = await timedFetch(`${SMOKE_BASE_URL}/api/product-research/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }, 300000);
      await optional("product-research/generate", productResearch, async () => {
        const researchPayload = await productResearch.json() as { products?: unknown[]; buyerSegments?: unknown[]; marketMaps?: unknown[] };
        assert((researchPayload.products || []).length > 0, "Product research should create product knowledge");
        assert((researchPayload.buyerSegments || []).length > 0, "Product research should create buyer segments");
        assert((researchPayload.marketMaps || []).length > 0, "Product research should create market maps");
      });
    } else {
      skippedEndpoints.push("product-research/generate (opt in with SMOKE_PRODUCT_RESEARCH=1 — live billed model call, 80-120s)");
    }
    // Document processing runs the full extraction pipeline — chunking, then
    // an LLM pass per question. MEASURED against the real database with the
    // live provider on 2026-09-05: HTTP 200 in 124.9 seconds. The old budget
    // was 60s with a comment saying "5-15s even on the mock provider", and the
    // gap between those two numbers cost a whole smoke run: the request was
    // aborted mid-flight and the summary reported the SERVER as unreachable,
    // which it never was.
    //
    // It stays on the default path despite costing two minutes and a real model
    // call, because it is the only automated coverage this route has anywhere in
    // the repository — no golden and no e2e spec touches it — and it is the
    // feature the operator uses to teach the AI about the business. Making it
    // opt-in (as product-research/generate is) would leave it untested.
    //
    // The right end state is a golden that drives the pipeline on the mock
    // provider, which would cover the plumbing — chunking, storage, replacement
    // — where this session's bugs actually lived, for no money and no wait.
    // Recorded as open rather than done, because it is not a five-minute job.
    const docProcess = await timedFetch(`${SMOKE_BASE_URL}/api/documents/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace_demo", title: "Smoke FAQ", documentType: "faq", contentText: "Q: Do you share catalogue?\nA: Yes, catalogue can be shared on request." }),
    }, 300000);
    await optional("documents/process", docProcess, async () => {
      const preview = await docProcess.json() as { knowledgeDocuments?: unknown[]; faqs?: unknown[] };
      assert((preview.knowledgeDocuments || []).length > 0, "Document process API should return knowledge candidates");
      assert((preview.faqs || []).length > 0, "Document process API should detect FAQ candidates");
    });
    // The provider + model catalogues are static server-side data. They need
    // no credentials, so a non-200 here is always a defect.
    const providers = await timedFetch(`${SMOKE_BASE_URL}/api/ai/providers`);
    assert(providers.ok, `/api/ai/providers should return 200 (got ${providers.status})`);
    const providerPayload = await providers.json() as Array<{ id: string }>;
    assert(providerPayload.some((item) => item.id === "ollama"), "Provider API should include Ollama");
    assert(providerPayload.some((item) => item.id === "anthropic"), "Provider API should include Anthropic");
    const catalog = await timedFetch(`${SMOKE_BASE_URL}/api/ai/model-catalog`);
    assert(catalog.ok, `/api/ai/model-catalog should return 200 (got ${catalog.status})`);
    const catalogPayload = await catalog.json() as { models?: Array<{ provider: string }> };
    assert((catalogPayload.models || []).some((item) => item.provider === "openai"), "Model catalog API should include OpenAI models");
    assert((catalogPayload.models || []).some((item) => item.provider === "mock"), "Model catalog API should include mock models");
    const fetchModels = await timedFetch(`${SMOKE_BASE_URL}/api/ai/models/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace_demo", provider: "openai" }),
    });
    await optional("ai/models/fetch", fetchModels, async () => {
      const fetchPayload = await fetchModels.json() as { warning?: string; models?: unknown[] };
      assert(Boolean(fetchPayload.warning), "Model fetch without key should return a friendly warning");
      assert((fetchPayload.models || []).length > 0, "Model fetch without key should return static fallback models");
    });
    const slots = await timedFetch(`${SMOKE_BASE_URL}/api/ai/model-slots`);
    assert(slots.ok, `/api/ai/model-slots should return 200 (got ${slots.status})`);
    const slotPayload = await slots.json() as Array<{ slotId: string; provider: string }>;
    assert(slotPayload.some((slot) => slot.slotId === "fast_customer_reply"), "Model slots API should include fast_customer_reply");

    // Secret redaction on export is a security control — never let it skip.
    const exportResponse = await timedFetch(`${SMOKE_BASE_URL}/api/data/export`);
    assert(exportResponse.ok, `/api/data/export should return 200 (got ${exportResponse.status})`);
    const exportPayload = await exportResponse.json() as { warning?: string; data?: unknown };
    assert(Boolean(exportPayload.warning), "Data export should include a safety warning");
    assert(Boolean(exportPayload.data), "Data export should include redacted workspace data");
    // Health is infrastructure: if the server is up, these MUST answer. No
    // conditional — a broken health endpoint is exactly what a smoke is for.
    const health = await timedFetch(`${SMOKE_BASE_URL}/api/health`);
    assert(health.ok, `/api/health should return 200 (got ${health.status})`);
    const healthPayload = await health.json() as { ok?: boolean; authMode?: string };
    assert(healthPayload.ok && Boolean(healthPayload.authMode), "Health endpoint should return safe status");

    const deepHealth = await timedFetch(`${SMOKE_BASE_URL}/api/health/deep`);
    assert(deepHealth.ok, `/api/health/deep should return 200 (got ${deepHealth.status})`);
    const deepPayload = await deepHealth.json() as { productionReadiness?: unknown; llm?: unknown };
    assert(Boolean(deepPayload.productionReadiness), "Deep health should include production readiness summary");
    assert(Boolean(deepPayload.llm), "Deep health should include LLM summary");
    return "ran";
  } catch (error) {
    // The server was reachable at the probe above. If it became unreachable
    // mid-run that is itself worth reporting, but it is not an assertion
    // failure — surface it as a skip with the reason attached.
    if (isServerUnreachable(error)) {
      console.log(`  Live API checks aborted — server became unreachable: ${error instanceof Error ? error.message : String(error)}`);
      return "aborted";
    }
    // Anything else is a REAL failure. Propagate it so the process exits 1.
    throw error;
  }
}

async function main() {
  const metaProvider = new MetaWhatsAppCloudProvider();
  assert(!metaProvider.isConfigured(), "WhatsApp Cloud provider should be unconfigured in smoke environment");
  const notConfiguredSend = await metaProvider.sendTextMessage({ workspaceId: "workspace_demo", to: "919999999999", body: "Hello" });
  assert(notConfiguredSend.status === "not_configured" && !notConfiguredSend.attempted, "WhatsApp Cloud provider must not send without env credentials");
  // Stage C.1: checkRateLimit is async now. Memory backend path resolves
  // synchronously but the return type is Promise; await it.
  const limited = await checkRateLimit({ workspaceId: "workspace_demo", action: "smoke_limit", limit: 1, windowMs: 1000 });
  const blocked = await checkRateLimit({ workspaceId: "workspace_demo", action: "smoke_limit", limit: 1, windowMs: 1000 });
  assert(limited.allowed && !blocked.allowed, "Rate limit service should block after configured limit");
  const liveOutcome = await checkApiStateIfServerIsRunning();

  // 2026-08-05 (audit F-4): report what actually ran. The old code printed the
  // single line "Smoke MVP business-rule checks passed." whether or not the
  // entire live-API half had executed, which is how a run with ZERO HTTP
  // assertions could look identical to a full one.
  console.log("");
  console.log("Smoke MVP business-rule checks passed.");
  if (liveOutcome === "ran") {
    console.log(`Live API checks: RAN against ${SMOKE_BASE_URL}`);
    if (skippedEndpoints.length > 0) {
      console.log(`Live API checks: ${skippedEndpoints.length} endpoint group(s) skipped (non-OK response):`);
      for (const name of skippedEndpoints) console.log(`  - ${name}`);
    }
    if (missingEndpoints.length > 0) {
      console.log("");
      console.log(`  TEST ROT — ${missingEndpoints.length} endpoint(s) this smoke calls returned 404:`);
      for (const name of missingEndpoints) console.log(`    - /api/${name}`);
      console.log("  Their assertions have not run since the route was removed.");
      console.log("  Either restore the route or delete the dead check.");
    }
  } else if (liveOutcome === "skipped") {
    console.log("");
    console.log("  ══════════════════════════════════════════════════════════");
    console.log(`   PARTIAL RUN — no dev server on ${SMOKE_BASE_URL}, so`);
    console.log("   the entire live-API half of this smoke did NOT execute.");
    console.log("   Start the server (`npm run dev`) and re-run for full cover.");
    console.log("  ══════════════════════════════════════════════════════════");
  } else {
    // A server WAS answering and then stopped. That is a symptom worth acting
    // on (crash, restart, or a route hanging past the timeout), so unlike the
    // clean "no server" case this exits NON-ZERO.
    console.log("");
    console.log("  ══════════════════════════════════════════════════════════");
    console.log("   FAILED — the server answered the probe, then one request ran");
    console.log("   out of time. The live-API checks are incomplete.");
    console.log("   The endpoint and its budget are named in the line above:");
    console.log("   either a crash, or a route slower than the budget it was given.");
    console.log("  ══════════════════════════════════════════════════════════");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
