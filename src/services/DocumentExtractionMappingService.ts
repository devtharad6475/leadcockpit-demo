import { timestamp, uid } from "@/lib/db";
import type { BusinessProfile, KnowledgeQuestionAnswer, KnowledgeQuestionAnswerStatus } from "@/lib/types";
import { emitEvent } from "@/events/EventDispatcher";
import { chunkKnowledgeDocument } from "@/services/KnowledgeBaseService";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { LLMService } from "@/llm/LLMService";
import { getAllKnowledgeQuestions, type KnowledgeQuestion } from "@/knowledge/knowledge-question-framework";

export type DocumentExtractionMappingPreview = {
  documentId: string;
  documentTitle: string;
  documentType: string;
  confidenceScore: number;
  businessProfilePatch: Partial<BusinessProfile>;
  products: Array<{ productName: string; productCategory: string; description: string; confidenceScore: number }>;
  productVarieties: Array<{ name: string; description: string; confidenceScore: number }>;
  applications: Array<{ applicationName: string; industry: string; description: string; confidenceScore: number }>;
  buyerSegments: Array<{ name: string; segmentType: string; description: string; confidenceScore: number }>;
  knowledgeDocuments: Array<{ title: string; documentType: string; contentText: string; confidenceScore: number }>;
  communicationSettingsPatch: Record<string, unknown>;
  whatsappSettingsPatch: Record<string, unknown>;
  policies: Array<{ topic: string; summary: string; confidenceScore: number }>;
  faqs: Array<{ question: string; answer: string; confidenceScore: number }>;
  companyKnowledge?: Array<{ question: string; answer: string; confidenceScore: number }>;
  customerKnowledge?: Array<{ question: string; answer: string; confidenceScore: number }>;
  leadQualificationRules: string[];
  unmappedInformation: string[];
  missingQuestions: Array<{ id: string; section: string; question: string }>;
  modelUsed?: { provider: string; modelName?: string; slotId?: string; fallbackUsed?: boolean };
  createdAt: string;
};

type LLMRecord = Record<string, unknown>;

/**
 * M2.2 / R5 audit fix: resolve an honest confidence score for an extracted
 * fact, instead of the old hardcoded 0.85.
 *
 * Rules (hand-computed and pinned by golden-document-extraction-confidence.ts):
 *   - MOCK mode (provider === "mock", or fallbackUsed and no real provider):
 *       always 0.45 — clearly below the 0.75 bulk-approve bar, so mock
 *       extraction can NEVER be silently auto-promoted to approved.
 *   - REAL mode: use the LLM-reported confidenceScore if it is a finite
 *       number in [0, 1]. Cap at 0.9 (no fact is "100% certain"; even a
 *       confident LLM cannot auto-stamp absolute certainty).
 *   - REAL mode but the LLM omitted the field: fall back to 0.6 (clearly
 *       human-review territory — above mock's 0.45, below the 0.75 bulk-
 *       approve bar).
 *
 * Exported so the same rule can be unit-tested directly.
 */
export const EXTRACTION_CONFIDENCE_MOCK = 0.45;
export const EXTRACTION_CONFIDENCE_REAL_DEFAULT = 0.6;
export const EXTRACTION_CONFIDENCE_REAL_CAP = 0.9;

export function resolveExtractionConfidence(
  llmRecord: LLMRecord | undefined,
  llmTrace: { provider?: string; mode?: string; fallbackUsed?: boolean } | undefined,
): number {
  const isMockRun = llmTrace?.provider === "mock" || llmTrace?.mode === "mock" || (llmTrace?.fallbackUsed === true && llmTrace?.provider !== "mock" && !llmTrace?.provider);
  if (isMockRun) return EXTRACTION_CONFIDENCE_MOCK;
  const raw = llmRecord?.confidenceScore;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return Math.min(raw, EXTRACTION_CONFIDENCE_REAL_CAP);
  }
  return EXTRACTION_CONFIDENCE_REAL_DEFAULT;
}

export async function mapDocumentExtraction(input: {
  workspaceId: string;
  title: string;
  documentType: string;
  contentText: string;
}, repos: RepositoryBundle = createRepositories()): Promise<DocumentExtractionMappingPreview> {
  const profile = await repos.businessProfile.getByWorkspace(input.workspaceId);
  const text = input.contentText.trim();
  const lower = text.toLowerCase();
  const llmTrace = await new LLMService(undefined, repos).runTask<Record<string, unknown>>("document_extraction_mapping", {
    documentType: input.documentType,
    textPreview: text.slice(0, 25000),
    questionnaire: frameworkQuestionnairePrompt(),
  }, { workspaceId: input.workspaceId }).catch(() => undefined);

  let products = detectProducts(text, profile);
  if (llmTrace?.output?.products && Array.isArray(llmTrace.output.products) && llmTrace.output.products.length > 0) {
    products = (llmTrace.output.products as LLMRecord[]).map((p) => ({
      productName: String(p.productName || p.name || "Product"),
      productCategory: "extracted",
      description: String(p.description || "Detected product information from uploaded document text."),
      confidenceScore: resolveExtractionConfidence(p, llmTrace),
    }));
  }

  let faqs = detectFaqs(text);
  if (llmTrace?.output?.faqs && Array.isArray(llmTrace.output.faqs) && llmTrace.output.faqs.length > 0) {
    faqs = (llmTrace.output.faqs as LLMRecord[]).map((f) => ({
      question: String(f.question || ""),
      answer: String(f.answer || ""),
      confidenceScore: resolveExtractionConfidence(f, llmTrace),
    })).filter((f) => f.question && f.answer);
  }

  let policies = detectPolicies(text, input.documentType);
  if (llmTrace?.output?.policies && Array.isArray(llmTrace.output.policies) && llmTrace.output.policies.length > 0) {
    policies = (llmTrace.output.policies as LLMRecord[]).map((p) => ({
      topic: String(p.topic || ""),
      summary: String(p.summary || ""),
      confidenceScore: resolveExtractionConfidence(p, llmTrace),
    })).filter((p) => p.topic && p.summary);
  }

  let leadQualificationRules = detectLeadRules(text);
  if (llmTrace?.output?.leadQualificationRules && Array.isArray(llmTrace.output.leadQualificationRules)) {
    leadQualificationRules = llmTrace.output.leadQualificationRules.map(String).filter(Boolean);
  }

  let companyKnowledge: Array<{ question: string; answer: string; confidenceScore: number }> = [];
  if (llmTrace?.output?.companyKnowledge && Array.isArray(llmTrace.output.companyKnowledge)) {
    companyKnowledge = (llmTrace.output.companyKnowledge as LLMRecord[]).map((c) => ({
      question: String(c.question || ""),
      answer: String(c.answer || ""),
      confidenceScore: resolveExtractionConfidence(c, llmTrace),
    })).filter((c) => c.question && c.answer);
  }

  let customerKnowledge: Array<{ question: string; answer: string; confidenceScore: number }> = [];
  if (llmTrace?.output?.customerKnowledge && Array.isArray(llmTrace.output.customerKnowledge)) {
    customerKnowledge = (llmTrace.output.customerKnowledge as LLMRecord[]).map((c) => ({
      question: String(c.question || ""),
      answer: String(c.answer || ""),
      confidenceScore: resolveExtractionConfidence(c, llmTrace),
    })).filter((c) => c.question && c.answer);
  }
  const answeredQuestionIds = new Set(((llmTrace?.output?.answeredQuestionIds as string[]) || []).map(normalizeFrameworkId));
  const missingQuestions = previewFrameworkQuestions()
    .filter((question) => !answeredQuestionIds.has(frameworkQuestionId(question)))
    .map((question) => ({ id: frameworkQuestionId(question), section: question.domainKey.replaceAll("_", " "), question: question.question }));

  // Preview-level confidence: mock runs report an honest "this is a guess"
  // number; real runs use a length-based heuristic that says "longer source
  // = more to extract from." Both are capped well below the 0.75 bulk-approve
  // bar so the preview itself never auto-approves anything.
  const isMockPreview = llmTrace?.provider === "mock" || llmTrace?.mode === "mock" || (llmTrace?.fallbackUsed === true && !llmTrace?.provider);
  const previewConfidence = isMockPreview
    ? Math.min(EXTRACTION_CONFIDENCE_MOCK, 0.5)
    : (text.length > 160 ? 0.72 : 0.54);

  return {
    documentId: `doc_preview_${Date.now()}`,
    documentTitle: input.title || "Untitled document",
    documentType: input.documentType || "other",
    confidenceScore: previewConfidence,
    businessProfilePatch: {
      products: products.map((item) => item.productName),
      description: profile?.description || firstSentence(text),
    },
    products,
    productVarieties: products.map((item) => ({
      name: item.productName,
      description: `Detected from ${input.documentType.replaceAll("_", " ")} content.`,
      confidenceScore: item.confidenceScore,
    })),
    applications: detectApplications(text, products),
    buyerSegments: detectBuyerSegments(lower),
    knowledgeDocuments: [{
      title: input.title || "Uploaded document knowledge",
      documentType: input.documentType || "other",
      contentText: text,
      confidenceScore: isMockPreview ? EXTRACTION_CONFIDENCE_MOCK : Math.min(0.72, EXTRACTION_CONFIDENCE_REAL_CAP),
    }],
    communicationSettingsPatch: lower.includes("premium") ? { tone: "premium" } : {},
    whatsappSettingsPatch: lower.includes("whatsapp") ? { defaultLanguage: "English" } : {},
    policies,
    faqs,
    companyKnowledge,
    customerKnowledge,
    leadQualificationRules,
    unmappedInformation: text.length ? text.split(/\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 4) : [],
    missingQuestions,
    modelUsed: {
      provider: llmTrace?.provider || "mock",
      modelName: llmTrace?.modelName || "deterministic-document-mapper",
      slotId: llmTrace?.slotId || "daily_workhorse",
      fallbackUsed: llmTrace?.fallbackUsed ?? true,
    },
    createdAt: timestamp(),
  } as DocumentExtractionMappingPreview;
}

export async function applyDocumentExtraction(input: {
  workspaceId: string;
  preview: DocumentExtractionMappingPreview;
}, repos: RepositoryBundle = createRepositories()) {
  const createdDocuments = [];

  // Session 6 audit fix: stamp the extraction provenance onto EVERY created
  // KB document so mock/fallback-origin knowledge is never indistinguishable
  // from real-model extraction. Downstream agents and the UI can then refuse
  // to quote unverified knowledge to customers (per the no-hallucination rule).
  const modelUsed = input.preview.modelUsed || { provider: "mock", fallbackUsed: true };
  const extractionMode: "real" | "fallback" | "mock" = modelUsed.provider === "mock" ? "mock" : modelUsed.fallbackUsed ? "fallback" : "real";
  const extractionUnverified = extractionMode !== "real";
  const provenanceMetadata = {
    extractionProvider: modelUsed.provider,
    extractionModel: modelUsed.modelName,
    extractionSlot: modelUsed.slotId,
    extractionMode,
    extractionFallbackUsed: modelUsed.fallbackUsed ?? true,
    extractionUnverified,
    extractionVerifiedAt: extractionUnverified ? undefined : timestamp(),
  };

  for (const item of input.preview.knowledgeDocuments) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: item.title,
      documentType: item.documentType,
      source: "uploaded_document",
      contentText: item.contentText,
      metadata: {
        ...provenanceMetadata,
        extractionConfidence: item.confidenceScore,
        sourcePreviewId: input.preview.documentId,
        appliedAt: timestamp(),
      },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  if (input.preview.products?.length) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: "Extracted Products",
      documentType: "catalogue",
      source: "uploaded_document",
      contentText: input.preview.products.map((p) => `${p.productName}:\n${p.description}`).join("\n\n"),
      metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  if (input.preview.faqs?.length) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: "Extracted FAQs",
      documentType: "faq",
      source: "uploaded_document",
      contentText: input.preview.faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n"),
      metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  if (input.preview.policies?.length) {
    for (const policy of input.preview.policies) {
      let docType = "policy";
      const topic = policy.topic.toLowerCase();
      if (topic.includes("shipping") || topic.includes("delivery")) docType = "shipping_policy";
      if (topic.includes("payment")) docType = "payment_policy";
      if (topic.includes("return") || topic.includes("refund")) docType = "return_policy";

      const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
        workspaceId: input.workspaceId,
        title: policy.topic,
        documentType: docType,
        source: "uploaded_document",
        contentText: policy.summary,
        metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
      });
      await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
      createdDocuments.push(document);
    }
  }

  if (input.preview.leadQualificationRules?.length) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: "Extracted Lead Qualification Rules",
      documentType: "lead_qualification_rules",
      source: "uploaded_document",
      contentText: input.preview.leadQualificationRules.map((r) => `- ${r}`).join("\n"),
      metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  if (input.preview.companyKnowledge?.length) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: "Extracted Company Knowledge",
      documentType: "company_profile",
      source: "uploaded_document",
      contentText: input.preview.companyKnowledge.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n\n"),
      metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  if (input.preview.customerKnowledge?.length) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: "Extracted Customer Knowledge",
      documentType: "customer_knowledge",
      source: "uploaded_document",
      contentText: input.preview.customerKnowledge.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n\n"),
      metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  if (input.preview.unmappedInformation?.length) {
    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: "Extracted Additional Information",
      documentType: "other",
      source: "uploaded_document",
      contentText: input.preview.unmappedInformation.join("\n"),
      metadata: { ...provenanceMetadata, sourcePreviewId: input.preview.documentId, appliedAt: timestamp() },
    });
    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    createdDocuments.push(document);
  }

  const profilePatch = input.preview.businessProfilePatch;
  if (profilePatch && Object.keys(profilePatch).length > 0) {
    const profile = await repos.businessProfile.getByWorkspace(input.workspaceId);
    if (profile) {
      // M3.3 / O1 audit fix: do NOT blindly overwrite an approved profile.
      // For each field in the patch:
      //   - if the existing field is EMPTY → fill it (extraction is advisory).
      //   - if the existing field is NON-EMPTY and the extracted value differs
      //     AND the profile is approved → create a SettingsConflict for human
      //     review (mirrors ExtractionRoutingService's pattern). The existing
      //     approved value is preserved.
      //   - if the existing field is NON-EMPTY and equals the extracted value
      //     → skip (no-op).
      // Sensitive profile fields (description, products) ALWAYS create a
      // conflict when they differ from a non-empty existing value, even if
      // the profile is only in "draft" status, because they shape every
      // customer-facing message.
      const safePatch: Record<string, unknown> = {};
      const SENSITIVE_PROFILE_FIELDS = new Set(["description", "products", "industry", "companyName"]);
      for (const [fieldKey, extractedValue] of Object.entries(profilePatch)) {
        const existingValue = (profile as unknown as Record<string, unknown>)[fieldKey];
        const existingText = Array.isArray(existingValue) ? existingValue.join(", ") : String(existingValue || "");
        const extractedText = Array.isArray(extractedValue) ? (extractedValue as unknown[]).join(", ") : String(extractedValue || "");
        if (!existingText.trim()) {
          // Empty field — extraction may fill it.
          safePatch[fieldKey] = extractedValue;
        } else if (existingText.trim() === extractedText.trim()) {
          // Same value — no-op.
          continue;
        } else if (profile.status === "approved" || SENSITIVE_PROFILE_FIELDS.has(fieldKey)) {
          // Differs from existing approved (or sensitive) value — create a
          // review card instead of overwriting. Pattern mirrors
          // ExtractionRoutingService.routeExtractedFactsToSettings.
          await repos.settingsConflict.create(input.workspaceId, {
            settingsArea: "profile",
            fieldKey,
            existingValue: existingText,
            extractedValue: extractedText,
            extractedSource: `document_extraction:${input.preview.documentTitle}`,
            status: "open",
          });
        } else {
          // Differs but profile is draft + non-sensitive — allow the patch.
          safePatch[fieldKey] = extractedValue;
        }
      }
      if (Object.keys(safePatch).length > 0) {
        await repos.businessProfile.update(input.workspaceId, profile.id, safePatch as Partial<BusinessProfile>);
      }
    } else {
      await repos.businessProfile.create({
        id: `profile_${Date.now()}`,
        workspaceId: input.workspaceId,
        companyName: "Extracted Company",
        businessType: "Unknown",
        industry: "Unknown",
        ...profilePatch,
      } as BusinessProfile);
    }
  }

  for (const doc of createdDocuments) {
    await chunkKnowledgeDocument(input.workspaceId, doc.id, repos);
    await emitEvent({
      eventType: "knowledge.document_created",
      workspaceId: input.workspaceId,
      entityType: "knowledge_base_document",
      entityId: doc.id,
      source: "document_extraction_mapping",
      payload: { title: doc.title, documentType: doc.documentType },
    });
  }

  if (input.preview.missingQuestions?.length) {
    for (const q of input.preview.missingQuestions) {
      await repos.unknownQuestion.create(input.workspaceId, {
        workspaceId: input.workspaceId,
        questionText: q.question,
        missingTopic: q.section,
        channel: "document_extraction",
        status: "open",
      });
    }
  }

  return {
    applied: true,
    documents: createdDocuments,
    businessProfilePatch: input.preview.businessProfilePatch,
    productsDetected: input.preview.products.length,
    message: "Document information was added to the Knowledge Base for review-backed use.",
  };
}

export async function processManualAnswer(input: {
  workspaceId: string;
  answerText: string;
  originalQuestionId: string;
}, repos: RepositoryBundle = createRepositories()): Promise<{ answeredCount: number }> {
  const llmTrace = await new LLMService(undefined, repos).runTask<{ mappings: Array<{ questionId: string; answer: string }> }>("manual_answer_mapping", {
    answerText: input.answerText,
    questionnaire: frameworkQuestionnairePrompt(),
  }, { workspaceId: input.workspaceId }).catch(() => undefined);

  const mappings = normalizeManualMappings(llmTrace?.output?.mappings || [], input.answerText);

  // Always include the original question if not in the LLM output
  const originalQuestion = resolveFrameworkQuestion(input.originalQuestionId);
  if (originalQuestion && !mappings.some(m => normalizeFrameworkId(m.questionId) === frameworkQuestionId(originalQuestion))) {
    mappings.push({ questionId: input.originalQuestionId, answer: input.answerText });
  }

  let answeredCount = 0;
  const answeredFrameworkQuestions: Array<{ question: KnowledgeQuestion & { domainKey: string; domainTitle: string }; answer: string }> = [];
  for (const mapping of mappings) {
    const question = resolveFrameworkQuestion(mapping.questionId);
    if (!question) continue;

    const document = await repos.knowledgeBaseDocument.create(input.workspaceId, {
      workspaceId: input.workspaceId,
      title: `Answer: ${question.question.slice(0, 50)}...`,
      documentType: knowledgeDocumentTypeForMapping(question.domainKey),
      source: "manual_answer",
      contentText: mapping.answer,
      metadata: {
        questionId: frameworkQuestionId(question),
        domainKey: question.domainKey,
        questionKey: question.questionKey,
        appliedAt: timestamp(),
        source: "process_manual_answer"
      },
    });

    await chunkKnowledgeDocument(input.workspaceId, document.id, repos);
    answeredFrameworkQuestions.push({ question, answer: mapping.answer });
    answeredCount++;
  }
  if (answeredFrameworkQuestions.length) {
    await upsertManualFrameworkAnswers(input.workspaceId, answeredFrameworkQuestions, repos);
  }

  return { answeredCount };
}

function knowledgeDocumentTypeForMapping(section: string) {
  switch (section) {
    case "company_knowledge":
    case "factual_company_profile": return "company_profile";
    case "product_knowledge":
    case "product_varieties":
    case "product_applications": return "catalogue";
    case "customer_knowledge":
    case "buyer_segments":
    case "lead_qualification": return "lead_qualification_rules";
    case "payment_credit_terms":
    case "pricing_policy":
    case "shipping_delivery":
    case "returns_replacement":
    case "legal_terms_privacy": return "policy";
    default: return "other";
  }
}

function previewFrameworkQuestions() {
  return getAllKnowledgeQuestions()
    .filter((question) => question.required || question.priority === "high")
    .slice(0, 140);
}

function frameworkQuestionnairePrompt() {
  return previewFrameworkQuestions()
    .map((question) => `[${frameworkQuestionId(question)}] ${question.question}`)
    .join("\n");
}

function frameworkQuestionId(question: Pick<KnowledgeQuestion & { domainKey: string }, "domainKey" | "questionKey">) {
  return `${question.domainKey}/${question.questionKey}`;
}

function normalizeFrameworkId(id: string) {
  return String(id || "").trim().replace(":", "/");
}

function resolveFrameworkQuestion(id: string) {
  const normalized = normalizeFrameworkId(id);
  const questions = getAllKnowledgeQuestions();
  return questions.find((question) =>
    frameworkQuestionId(question) === normalized ||
    question.questionKey === normalized ||
    question.question.toLowerCase() === normalized.toLowerCase()
  );
}

function normalizeManualMappings(mappings: Array<{ questionId: string; answer: string }>, fallbackAnswer: string) {
  const seen = new Set<string>();
  return mappings
    .map((mapping) => ({ questionId: normalizeFrameworkId(mapping.questionId), answer: String(mapping.answer || fallbackAnswer).trim() }))
    .filter((mapping) => mapping.questionId && mapping.answer && !seen.has(mapping.questionId) && seen.add(mapping.questionId));
}

async function upsertManualFrameworkAnswers(
  workspaceId: string,
  answers: Array<{ question: KnowledgeQuestion & { domainKey: string; domainTitle: string }; answer: string }>,
  repos: RepositoryBundle,
) {
  await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.auditLogs ||= [];
    const now = timestamp();
    for (const item of answers) {
      const status: KnowledgeQuestionAnswerStatus = item.question.humanReviewRequired ? "needs_review" : "answered";
      const existing = data.knowledgeQuestionAnswers.find((answer) =>
        answer.workspaceId === workspaceId &&
        answer.domainKey === item.question.domainKey &&
        answer.questionKey === item.question.questionKey
      );
      const patch: Partial<KnowledgeQuestionAnswer> = {
        answer: item.answer,
        answerStatus: status,
        sourceType: "manual_edit",
        confidenceScore: 1,
        usedByAgentsJson: { values: item.question.usedByAgents },
        mapsToJson: { values: item.question.mapsTo },
        humanReviewRequired: item.question.humanReviewRequired,
        sourceSnippet: item.answer.slice(0, 420),
        reviewedByUser: "user_owner",
        reviewedAt: now,
        isUserApproved: status === "answered",
        isCanonical: true,
        evidenceJson: {
          sources: [{
            sourceType: "manual_edit",
            sourceSnippet: item.answer.slice(0, 420),
            confidenceScore: 1,
            answer: item.answer,
            createdAt: now,
          }],
        },
        updatedAt: now,
      };
      if (existing) {
        Object.assign(existing, patch);
      } else {
        data.knowledgeQuestionAnswers.push({
          id: uid("kqa"),
          workspaceId,
          domainKey: item.question.domainKey,
          questionKey: item.question.questionKey,
          question: item.question.question,
          createdAt: now,
          ...patch,
        } as KnowledgeQuestionAnswer);
      }
    }
    data.auditLogs.push({
      id: uid("audit"),
      workspaceId,
      actorUserId: "user_owner",
      eventType: "knowledge.manual_answer.mapped",
      entityType: "knowledge_question_answer",
      entityId: workspaceId,
      payload: { mappedCount: answers.length, questionIds: answers.map((item) => frameworkQuestionId(item.question)) },
      createdAt: now,
      updatedAt: now,
    });
  });
}

function detectProducts(text: string, profile?: BusinessProfile | null) {
  const candidates = [
    ...(profile?.products || []),
    ...Array.from(text.matchAll(/\b(?:product|products|catalogue|catalog|we supply|we manufacture|we sell)\b[:\-\s]+([^\n.]+)/gi)).map((match) => match[1]),
  ].flatMap((part) => String(part).split(/,|;| and /)).map((item) => item.trim()).filter(Boolean);
  const unique = Array.from(new Set(candidates)).slice(0, 5);
  return (unique.length ? unique : ["Core product"]).map((productName) => ({
    productName,
    productCategory: "detected_from_document",
    description: `Detected product information from uploaded document text.`,
    confidenceScore: unique.length ? 0.72 : 0.45,
  }));
}

function detectApplications(text: string, products: Array<{ productName: string }>) {
  const lower = text.toLowerCase();
  const applicationName = lower.includes("occasion") || lower.includes("event") ? "Event and occasion use" : lower.includes("export") ? "Export supply" : "B2B product usage";
  return products.slice(0, 3).map((product) => ({
    applicationName,
    industry: "B2B",
    description: `${product.productName} can be mapped to buyer applications during product research.`,
    confidenceScore: 0.6,
  }));
}

function detectBuyerSegments(lower: string) {
  const segments = [
    lower.includes("wholesale") ? ["Wholesale Buyers", "wholesaler", "Care about margin, variety, bulk rate, and ready stock."] : undefined,
    lower.includes("manufactur") ? ["Manufacturers", "manufacturer", "Care about consistency, custom requirements, repeat supply, and delivery time."] : undefined,
    lower.includes("export") ? ["Export Buyers", "exporter", "Care about packaging, compliance, repeat orders, and shipment clarity."] : undefined,
    lower.includes("boutique") || lower.includes("designer") ? ["Designers and Boutiques", "designer", "Care about unique options, samples, and customization."] : undefined,
  ].filter(Boolean) as string[][];
  return (segments.length ? segments : [["General B2B Buyers", "buyer", "Care about product fit, reliability, and response time."]]).map(([name, segmentType, description]) => ({ name, segmentType, description, confidenceScore: 0.64 }));
}

export function detectFaqs(text: string) {
  return Array.from(text.matchAll(/(?:q[:\-\s]+([^\n]+)\n+a[:\-\s]+([\s\S]+?)(?=\nq[:\-\s]+|$))/gi)).slice(0, 5).map((match) => ({
    question: match[1].trim(),
    answer: match[2].trim(),
    confidenceScore: 0.8,
  }));
}

function detectPolicies(text: string, documentType: string) {
  const lower = text.toLowerCase();
  const topics = [
    lower.includes("refund") || lower.includes("return") || documentType.includes("return") ? "Return/refund policy" : "",
    lower.includes("shipping") || lower.includes("delivery") || documentType.includes("shipping") ? "Shipping/delivery policy" : "",
    lower.includes("payment") || documentType.includes("payment") ? "Payment policy" : "",
  ].filter(Boolean);
  return topics.map((topic) => ({ topic, summary: `Detected ${topic.toLowerCase()} details that need owner review before customer-facing use.`, confidenceScore: 0.68 }));
}

function detectLeadRules(text: string) {
  const lower = text.toLowerCase();
  const rules = [];
  if (lower.includes("bulk")) rules.push("Prioritize bulk order inquiries.");
  if (lower.includes("sample")) rules.push("Treat sample requests as buying intent.");
  if (lower.includes("catalogue") || lower.includes("catalog")) rules.push("Catalogue requests should become MQL unless already higher.");
  return rules;
}

function firstSentence(text: string) {
  return text.split(/[.!?]\s/)[0]?.slice(0, 240) || undefined;
}
