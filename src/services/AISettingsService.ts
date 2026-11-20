import { NeedsActionError } from "@/lib/user-errors";
import { sameQuestionKey } from "@/lib/owner-question-text";
import { defaultWorkspaceId, timestamp, uid } from "@/lib/db";
import type { AIUsageLimit, AutoReplyLog, KnowledgeBaseChunk, KnowledgeBaseDocument, LLMModelRouting, UnknownQuestion } from "@/lib/types";
import { defaultWhatsAppAgentSettings } from "@/policies/default-company-communication-settings";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { withSnapshotSession } from "@/repositories/snapshot-session";
import { chunkKnowledgeDocument, createKnowledgeDocument } from "@/services/KnowledgeBaseService";
import { maskSecret } from "@/lib/secret-redaction";
import { encryptSecret } from "@/lib/credential-security";
import { defaultSlotRoutes } from "@/llm/ModelRouter";
import { LLM_PROVIDERS, isLLMProviderId } from "@/llm/provider-types";
import { DEFAULT_MODEL_CATALOG, findModel } from "@/llm/model-catalog";
import { validateModelCapability } from "@/llm/ModelDiscoveryService";
import { platformApiKey } from "@/llm/LLMService";
import { embedChunks } from "@/rag/embed-chunks";
import type { ModelSlotId, ModelCatalogEntry } from "@/llm/types";
import {
  DEFAULT_DAILY_TOKEN_LIMIT,
  DEFAULT_MONTHLY_TOKEN_LIMIT,
  DEFAULT_DAILY_COST_LIMIT,
  DEFAULT_MONTHLY_COST_LIMIT,
} from "@/services/AIUsageService";
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";
import { answerKnowledgeQuestionFromUnknown, rebuildAnswerSearchIndex } from "@/services/DocumentQuestionAnsweringService";
import { upsertKnowledgeEntry } from "@/services/KnowledgeSyncService";
import { validateAutoReplyTopics } from "@/services/AutoReplyTrialService";

export async function getWhatsAppSettings(workspaceId: string, repos = createRepositories()) {
  const existing = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
  if (existing) return existing;
  return repos.whatsAppAgentSettings.upsertForWorkspace(workspaceId, {
    id: uid("wa_settings"),
    ...defaultWhatsAppAgentSettings(workspaceId),
    createdAt: timestamp(),
  });
}

export async function updateWhatsAppSettings(workspaceId: string, input: Record<string, unknown>, repos = createRepositories()) {
  const existing = await getWhatsAppSettings(workspaceId, repos);
  // D-2026-09-27-b — only tickable kinds, and a kind is newly switched on only
  // once the trial proves it (AutoReplyTrialService). Absent = unchanged.
  const autoReplyTopics = await validateAutoReplyTopics(workspaceId, input.autoReplyTopics, existing.autoReplyTopics ?? [], repos);
  return repos.whatsAppAgentSettings.upsertForWorkspace(workspaceId, {
    ...existing,
    enabled: Boolean(input.enabled),
    mode: ["draft_only", "automatic", "safe_auto_reply", "human_approval"].includes(String(input.mode)) ? String(input.mode) as typeof existing.mode : existing.mode,
    defaultLanguage: String(input.defaultLanguage || existing.defaultLanguage),
    escalationContactName: String(input.escalationContactName || ""),
    escalationContactPhone: String(input.escalationContactPhone || ""),
    escalationContactEmail: String(input.escalationContactEmail || ""),
    unknownAnswerBehavior: String(input.unknownAnswerBehavior || existing.unknownAnswerBehavior),
    abusiveMessageBehavior: String(input.abusiveMessageBehavior || existing.abusiveMessageBehavior),
    priceQuestionBehavior: String(input.priceQuestionBehavior || existing.priceQuestionBehavior),
    // CP-22 (2026-08-02) — auto-acknowledge toggle + template.
    autoAcknowledgeSensitive: typeof input.autoAcknowledgeSensitive === "boolean" ? input.autoAcknowledgeSensitive : existing.autoAcknowledgeSensitive ?? false,
    acknowledgementTemplate: typeof input.acknowledgementTemplate === "string" && input.acknowledgementTemplate.trim() ? input.acknowledgementTemplate : (existing.acknowledgementTemplate || ""),
    // CP-23 (2026-08-02) — message batching toggle.
    messageBatchingEnabled: typeof input.messageBatchingEnabled === "boolean" ? input.messageBatchingEnabled : existing.messageBatchingEnabled ?? false,
    autoReplyTopics,
  });
}

export async function getAISettings(workspaceId: string, repos = createRepositories()) {
  const credentials = await repos.llmProviderCredential.listByWorkspace(workspaceId);
  const routes = await repos.llmModelRouting.listByWorkspace(workspaceId);
  const usage = await getOrCreateUsage(workspaceId, repos);
  return {
    mode: "balanced",
    credentials: credentials.map((item) => ({ ...item, encryptedApiKey: maskSecret(item.encryptedApiKey) })),
    routes,
    modelSlots: await getModelSlots(workspaceId, repos),
    usage,
    note: "Demo mode uses mock models unless real provider credentials are added later.",
  };
}

export async function updateAISettings(workspaceId: string, input: Record<string, unknown>, repos = createRepositories()) {
  if (input.provider || input.displayName || input.apiKey) {
    await repos.llmProviderCredential.create(workspaceId, {
      id: uid("llm_credential"),
      provider: String(input.provider || "openai"),
      displayName: String(input.displayName || "Demo credential"),
      // Session 2 audit fix: encrypt with real AES-256-GCM (was a broken
      // "placeholder_encrypted_<masked>" value that could never be decrypted,
      // forcing silent mock fallback).
      encryptedApiKey: input.apiKey ? encryptSecret(String(input.apiKey), workspaceId) : undefined,
      status: "not_connected",
      config: { demoOnly: true, baseUrl: input.baseUrl ? String(input.baseUrl) : undefined, organizationId: input.organizationId, projectId: input.projectId, region: input.region },
    });
  }
  await getOrCreateUsage(workspaceId, repos);
  return { ok: true, mode: String(input.mode || "balanced") };
}

export async function getModelSlots(workspaceId: string, repos = createRepositories()) {
  const routes = await repos.llmModelRouting.listByWorkspace(workspaceId);
  const existing = routes.filter((route) => ["fast_customer_reply", "daily_workhorse", "deep_reasoning", "research_search", "creative_image", "embedding_advanced"].includes(route.taskName));
  const existingBySlot = new Map(existing.map((route) => [route.taskName, route]));
  const slots = defaultSlotRoutes(workspaceId).map((route) => existingBySlot.get(route.taskName || "") || ({
    id: uid("llm_slot_default"),
    workspaceId,
    taskName: route.taskName || "daily_workhorse",
    provider: route.provider || "mock",
    modelName: route.modelName,
    modelTier: route.modelTier || "mock",
    isEnabled: route.isEnabled ?? true,
    fallbackProvider: route.fallbackProvider || "mock",
    fallbackModelName: route.fallbackModelName,
    config: route.config || {},
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }));
  return slots.map((slot) => {
    const provider = isLLMProviderId(slot.provider) ? slot.provider : "mock";
    let model = findModel(provider, slot.modelName || "");
    if (!model && slot.modelName && slot.modelName !== "ollama-custom") {
      // Virtual entry for models not in static catalog (e.g. fetched from Ollama)
      model = {
        id: `${provider}:${slot.modelName}`,
        provider,
        modelName: slot.modelName,
        displayName: slot.modelName,
        tier: "local",
        capabilities: ["text_generation", "local_runtime"],
        family: provider,
        requiresApiKey: provider !== "mock" && provider !== "ollama",
        requiresBaseUrl: ["ollama", "openai_compatible"].includes(provider),
        recommendedSlots: ["fast_customer_reply", "daily_workhorse", "deep_reasoning"],
        recommendedTasks: ["message_generation", "whatsapp_reply"],
        supportsStreaming: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        notes: "Virtual entry for custom model.",
        deprecated: false,
        enabledByDefault: false,
      } as ModelCatalogEntry;
    }
    const validation = validateModelCapability(model, slot.taskName as ModelSlotId);
    return {
      id: slot.id,
      slotId: slot.taskName,
      provider,
      modelName: slot.modelName || "mock-balanced",
      modelTier: slot.modelTier,
      fallbackProvider: slot.fallbackProvider || "mock",
      fallbackModelName: slot.fallbackModelName || "mock-balanced",
      enableMockFallback: slot.config?.enableMockFallback !== false,
      credentialId: slot.config?.credentialId,
      fallbackCredentialId: slot.config?.fallbackCredentialId,
      primaryKeyPreview: slot.config?.primaryKeyPreview,
      fallbackKeyPreview: slot.config?.fallbackKeyPreview,
      baseUrl: slot.config?.baseUrl,
      fallbackBaseUrl: slot.config?.fallbackBaseUrl,
      customModelName: slot.config?.customModelName,
      fallbackCustomModelName: slot.config?.fallbackCustomModelName,
      // UA-9 fix: providerFor() (LLMService.ts) resolves a key from a
      // workspace credential OR this shared platform-level .env fallback —
      // either makes the slot genuinely real. The dashboard health widget
      // previously only checked for a workspace credential, so a slot running
      // for real on the platform key was reported as "not ready".
      hasPlatformKey: provider !== "mock" && Boolean(platformApiKey(provider)),
      warnings: validation.warnings,
    };
  });
}

export async function updateModelSlots(workspaceId: string, slots: Array<Record<string, unknown>>, repos = createRepositories()) {
  if (!slots.length) {
    throw new NeedsActionError("No model slots were sent, so existing AI model routing was preserved. Reload AI Settings and save the visible slot cards.", 400);
  }
  // Validate every saved-key reference before creating a new key or replacing
  // routes. A service change must not retain a key belonging to another service
  // (or another company), even when a client submits stale form state.
  const credentials = await repos.llmProviderCredential.listByWorkspace(workspaceId);
  for (const slot of slots) {
    for (const [key, providerKey, label] of [
      ["credentialId", "provider", "AI service"],
      ["fallbackCredentialId", "fallbackProvider", "backup AI service"],
    ] as const) {
      if (!slot[key]) continue;
      const credential = credentials.find(item => item.id === String(slot[key]));
      if (!credential || credential.provider !== String(slot[providerKey] || "mock")) {
        throw new NeedsActionError(`The saved key does not belong to the selected ${label}. Choose that service again and enter its own key.`, 400);
      }
    }
  }
  const existingTaskOverrides = (await repos.llmModelRouting.listByWorkspace(workspaceId)).filter((route) => !["fast_customer_reply", "daily_workhorse", "deep_reasoning", "research_search", "creative_image", "embedding_advanced"].includes(route.taskName));
  const slotRoutes: Partial<LLMModelRouting>[] = [];
  for (const slot of slots) {
    const slotId = String(slot.slotId || slot.taskName || "daily_workhorse");
    const provider = (LLM_PROVIDERS as readonly string[]).includes(String(slot.provider)) ? String(slot.provider) : "mock";
    const fallbackProvider = (LLM_PROVIDERS as readonly string[]).includes(String(slot.fallbackProvider)) ? String(slot.fallbackProvider) : "mock";
    let credentialId = slot.credentialId ? String(slot.credentialId) : undefined;
    let fallbackCredentialId = slot.fallbackCredentialId ? String(slot.fallbackCredentialId) : undefined;
    let primaryKeyPreview = slot.primaryKeyPreview ? String(slot.primaryKeyPreview) : undefined;
    let fallbackKeyPreview = slot.fallbackKeyPreview ? String(slot.fallbackKeyPreview) : undefined;

    if (slot.apiKey && String(slot.apiKey).trim()) {
      const credential = await repos.llmProviderCredential.create(workspaceId, {
        id: uid("llm_slot_credential"),
        provider,
        displayName: `${slotId} primary key`,
        encryptedApiKey: encryptSecret(String(slot.apiKey), workspaceId),
        status: "not_connected",
        config: { demoOnly: true, slotId, purpose: "primary" },
      });
      credentialId = credential.id;
      primaryKeyPreview = maskSecret(String(slot.apiKey));
    }

    if (slot.fallbackApiKey && String(slot.fallbackApiKey).trim()) {
      const credential = await repos.llmProviderCredential.create(workspaceId, {
        id: uid("llm_slot_fallback_credential"),
        provider: fallbackProvider,
        displayName: `${slotId} fallback key`,
        encryptedApiKey: encryptSecret(String(slot.fallbackApiKey), workspaceId),
        status: "not_connected",
        config: { demoOnly: true, slotId, purpose: "fallback" },
      });
      fallbackCredentialId = credential.id;
      fallbackKeyPreview = maskSecret(String(slot.fallbackApiKey));
    }

    slotRoutes.push({
      id: String(slot.id || uid("llm_slot")),
      workspaceId,
      taskName: slotId,
      provider,
      modelName: String(slot.modelName || "mock-balanced"),
      modelTier: String(slot.modelTier || findModel(isLLMProviderId(provider) ? provider : "mock", String(slot.modelName || ""))?.tier || "mock"),
      isEnabled: slot.isEnabled !== false,
      fallbackProvider,
      fallbackModelName: String(slot.fallbackModelName || "mock-balanced"),
      config: {
        enableMockFallback: slot.enableMockFallback !== false,
        credentialId,
        fallbackCredentialId,
        primaryKeyPreview,
        fallbackKeyPreview,
        baseUrl: slot.baseUrl ? String(slot.baseUrl) : undefined,
        fallbackBaseUrl: slot.fallbackBaseUrl ? String(slot.fallbackBaseUrl) : undefined,
        customModelName: slot.customModelName ? String(slot.customModelName) : undefined,
        fallbackCustomModelName: slot.fallbackCustomModelName ? String(slot.fallbackCustomModelName) : undefined,
      },
    });
  }
  await repos.llmModelRouting.replaceForWorkspace(workspaceId, [...existingTaskOverrides, ...slotRoutes]);
  return getModelSlots(workspaceId, repos);
}

export function catalogSummary() {
  return {
    providerCount: LLM_PROVIDERS.length,
    modelCount: DEFAULT_MODEL_CATALOG.length,
    providers: LLM_PROVIDERS,
  };
}

export async function updateModelRouting(workspaceId: string, routes: Array<Record<string, unknown>>, repos = createRepositories()) {
  const saved: Partial<LLMModelRouting>[] = routes.map((route) => ({
    id: String(route.id || uid("llm_route")),
    workspaceId,
    taskName: String(route.taskName || "message_generation"),
    provider: String(route.provider || "mock"),
    modelName: route.modelName ? String(route.modelName) : undefined,
    modelTier: String(route.modelTier || "mock"),
    isEnabled: route.isEnabled !== false,
    fallbackProvider: route.fallbackProvider ? String(route.fallbackProvider) : "mock",
    fallbackModelName: route.fallbackModelName ? String(route.fallbackModelName) : undefined,
    config: {},
  }));
  return repos.llmModelRouting.replaceForWorkspace(workspaceId, saved);
}

export async function updateUnknownQuestion(workspaceId: string, unknownQuestionId: string, input: Record<string, unknown>, repos = createRepositories()) {
  // F-UI-5 (depth-audit 2026-07-29): build the patch from ONLY the keys the
  // caller actually sent. The previous shape always passed `status: undefined`
  // when the caller didn't send status — and the repo's `Object.assign(item,
  // input)` then OVERWROTE the existing status with undefined, silently
  // destroying it. A "Save draft" (suggestedAnswer only) wiped the question's
  // open/answered status. Now undefined values are omitted from the patch.
  const patch: Partial<UnknownQuestion> = {};
  // 2026-09-26 (break test): the status came straight from the request, so a
  // plain edit could mark a question "added to knowledge" without adding
  // anything (the card vanished, nothing was learned) or store a made-up
  // status. A plain edit may only set a question aside or reopen it; answering
  // it goes through its own action, which saves the answer.
  if (input.status !== undefined) {
    if (input.status !== "open" && input.status !== "ignored") {
      throw new NeedsActionError("A question can only be set aside or reopened here. To answer it, use Answer.", 400);
    }
    patch.status = input.status;
  }
  if (input.finalAnswer !== undefined) patch.finalAnswer = String(input.finalAnswer);
  if (input.suggestedAnswer !== undefined) patch.suggestedAnswer = String(input.suggestedAnswer);
  return repos.unknownQuestion.update(workspaceId, unknownQuestionId, patch);
}

/**
 * The question an answer is FILED under, which is not always the sentence the
 * owner was shown.
 *
 * A conflict item asks "A new source has more detail for: <question>. Should
 * this update the approved answer?" — a prompt, addressed to the owner. That
 * string was being written into the knowledge base as the FAQ question, so the
 * agent searched a base full of entries no customer would ever ask, whose
 * answers were the owner's decision rather than the company's position. Found
 * on the live demo: 50-odd documents titled "Answer: A new source has more
 * detail for: ...", every one of them retrievable at reply time.
 *
 * The real question is on the record already — conflict items carry it, and
 * anything mapped to the framework can be looked up by key.
 */
function knowledgeQuestionTextFor(question: UnknownQuestion): string {
  const carried = (question.conflictSourcesJson as { question?: unknown } | undefined)?.question;
  if (typeof carried === "string" && carried.trim()) return carried.trim();
  if (question.relatedQuestionKey) {
    for (const domain of KNOWLEDGE_QUESTION_FRAMEWORK) {
      const match = domain.questions.find((item) => item.questionKey === question.relatedQuestionKey);
      if (match?.question) return match.question;
    }
  }
  return question.questionText;
}

/**
 * The knowledge document an earlier answer to exactly these questions created,
 * if any (2026-09-26, break test) — so a second answer replaces the first
 * instead of leaving both for the AI to find.
 */
async function answerDocumentFor(workspaceId: string, unknownQuestionIds: string[], repos: RepositoryBundle) {
  const wanted = [...new Set(unknownQuestionIds)].sort().join("|");
  return (await repos.knowledgeBaseDocument.listByWorkspace(workspaceId)).find((document) => {
    if (document.source !== "unknown_question") return false;
    const metadata = (document.metadata || {}) as { unknownQuestionId?: unknown; unknownQuestionIds?: unknown };
    const ids = Array.isArray(metadata.unknownQuestionIds)
      ? metadata.unknownQuestionIds.map(String)
      : typeof metadata.unknownQuestionId === "string" ? [metadata.unknownQuestionId] : [];
    return ids.length > 0 && [...new Set(ids)].sort().join("|") === wanted;
  });
}

/**
 * Session 55: this is the SINGLE-question save — the button an owner presses on
 * a WhatsApp question the AI could not answer — and it was the one answer path
 * with no snapshot session. `answerUnknownQuestionGroup` below has had one
 * since N-PERF-3; this did not, so every save read and rewrote the whole
 * workspace snapshot several times over (answerKnowledgeQuestionFromUnknown,
 * upsertKnowledgeEntry, createKnowledgeDocument each run their own cycle).
 *
 * Observed live on the demo: nine saves in about thirty-five seconds took the
 * container down with "Server returned a non-JSON response with status 502",
 * and the saves were lost. A human answering at human pace does not hit it,
 * which is exactly why it survived — it needs somebody working quickly, which
 * is what an owner does on their first afternoon.
 *
 * The embedding step stays OUTSIDE the session deliberately. snapshot-session.ts
 * is explicit that a session must not span a network call: in JSON mode it holds
 * the data-file lock for its whole life, so wrapping one embedding call per
 * chunk would block every other write for the duration.
 */
export async function answerUnknownQuestion(workspaceId: string, unknownQuestionId: string, rawAnswer: string, addToKnowledge: boolean, repos = createRepositories()) {
  // 2026-09-26 (break test): an answer of only spaces passed the route's
  // "required" check and closed the question with nothing learned.
  const finalAnswer = rawAnswer.trim();
  if (!finalAnswer) throw new NeedsActionError("Write an answer first.", 400);
  const { question, knowledgeAnswer, documentId } = await withSnapshotSession(async () => {
    const saved = addToKnowledge
      ? await repos.unknownQuestion.update(workspaceId, unknownQuestionId, { finalAnswer, status: "added_to_knowledge" })
      : await repos.unknownQuestion.markAnswered(workspaceId, unknownQuestionId, finalAnswer);
    if (!addToKnowledge || !finalAnswer.trim()) {
      return { question: saved, knowledgeAnswer: undefined, documentId: undefined as string | undefined };
    }
    const frameworkMarker = saved.suggestedAnswer?.match(/Framework question: ([^.\n]+)/)?.[1];
    const mapped = await answerKnowledgeQuestionFromUnknown(
      workspaceId,
      saved.questionText,
      finalAnswer,
      frameworkMarker,
      saved.relatedDomain,
      saved.relatedQuestionKey,
    );
    await upsertKnowledgeEntryForUnknownQuestion(workspaceId, saved, finalAnswer);
    const contentText = `Question: ${knowledgeQuestionTextFor(saved)}\nAnswer: ${finalAnswer}`;
    // 2026-09-26 (break test): answering the same question again created a
    // SECOND answer document and left the first searchable, so the AI could
    // still quote the answer the owner had just corrected. The question's own
    // document is rewritten instead; its chunks are rebuilt below.
    const earlier = await answerDocumentFor(workspaceId, [unknownQuestionId], repos);
    const document = earlier
      ? await repos.knowledgeBaseDocument.update(workspaceId, earlier.id, { contentText, status: "active" })
      : await createKnowledgeDocument({
        workspaceId,
        title: `Answer: ${knowledgeQuestionTextFor(saved).slice(0, 60)}`,
        documentType: "faq",
        source: "unknown_question",
        contentText,
        metadata: { unknownQuestionId },
      }, repos);
    return { question: saved, knowledgeAnswer: mapped, documentId: document.id };
  });
  // Outside the session: one metered embedding call per chunk.
  if (documentId) await chunkKnowledgeDocument(workspaceId, documentId, repos);
  // 2026-09-27 (K2): the checklist answer changed, so the searchable copy of
  // approved answers must be rebuilt too — otherwise it keeps the old answer
  // next to the new one. Outside the session for the same reason as above.
  if (knowledgeAnswer) await rebuildAnswerSearchIndex(workspaceId, repos);
  // 2026-09-29 (owner walk-through NY4): the same disagreement is often raised
  // several times (one per document that disagrees). "Needs you" shows it once;
  // the owner's answer settles the fact for that question, so the open copies
  // close with the same answer instead of coming straight back.
  const closedCopies = await closeSameQuestionCopies(workspaceId, question, finalAnswer, repos);
  return {
    question,
    closedCopies,
    knowledgeAnswer,
    status: knowledgeAnswer ? "added_to_knowledge_base" : addToKnowledge ? "saved_but_no_matching_framework_question" : "answered",
    message: knowledgeAnswer
      ? "Answer saved and reflected in Knowledge Base."
      : addToKnowledge
        ? "Answer saved. No matching framework question was found, so it was added as a knowledge document."
        : "Answer saved.",
  };
}

async function closeSameQuestionCopies(workspaceId: string, question: UnknownQuestion, finalAnswer: string, repos: RepositoryBundle): Promise<number> {
  const key = sameQuestionKey(question);
  if (!key) return 0;
  const copies = (await repos.unknownQuestion.listByWorkspace(workspaceId))
    .filter((q) => q.id !== question.id && q.status === "open" && sameQuestionKey(q) === key);
  for (const copy of copies) await repos.unknownQuestion.markAnswered(workspaceId, copy.id, finalAnswer);
  return copies.length;
}

/**
 * N-PERF-3 / audit A-13 (2026-08-25) — this is the wrapper, the work is below.
 *
 * Saving ONE setup card took 25 seconds on the real substrate and 96 seconds in
 * a real browser. Nothing in here is slow on its own; it is slow because it
 * reads the entire database fifteen times to save seven answers. Two full
 * snapshot cycles per question (answerKnowledgeQuestionFromUnknown, then
 * upsertKnowledgeEntry) plus a final one in persistGroupedFrameworkAnswers, and
 * every one of them pulled the same 27,271 records across 37 tenants.
 *
 * withSnapshotSession makes the whole save one unit of work: read once, write
 * the difference once. The body below is unchanged — the session is picked up
 * through AsyncLocalStorage, so even upsertKnowledgeEntry, which opens its own
 * repository bundle and never sees this `repos`, joins it.
 *
 * The session also makes the save atomic, which it was not: a throw halfway
 * through used to leave the first few questions written and the rest not.
 *
 * Pinned by scripts/golden/golden-snapshot-session.ts and measured end to end
 * by scripts/probes/essential-stage-ui.ts in a real browser.
 */
export async function answerUnknownQuestionGroup(
  workspaceId: string,
  unknownQuestionIds: string[],
  finalAnswer: string,
  addToKnowledge: boolean,
  repos = createRepositories(),
  fallbackGroup?: { domainKey?: string; relatedQuestionKeys?: string[] },
) {
  const result = await withSnapshotSession(() =>
    answerUnknownQuestionGroupWork(workspaceId, unknownQuestionIds, finalAnswer, addToKnowledge, repos, fallbackGroup),
  );
  // K2 (2026-09-27): rebuild the searchable copy of approved answers the
  // group just changed — outside the session, it makes embedding calls.
  if (result.mappedAnswers > 0) await rebuildAnswerSearchIndex(workspaceId, repos);
  // Outside the session: one metered embedding call per chunk. See the note in
  // answerUnknownQuestionGroupWork where the document is created.
  if (result.documentId) {
    const chunks = await chunkKnowledgeDocument(workspaceId, result.documentId, repos);
    return { ...result, chunks: chunks.length };
  }
  return result;
}

async function answerUnknownQuestionGroupWork(
  workspaceId: string,
  unknownQuestionIds: string[],
  finalAnswer: string,
  addToKnowledge: boolean,
  repos: RepositoryBundle,
  fallbackGroup?: { domainKey?: string; relatedQuestionKeys?: string[] },
) {
  const uniqueIds = Array.from(new Set(unknownQuestionIds.filter(Boolean)));
  if (!uniqueIds.length) throw new NeedsActionError("Select at least one information-needed item.", 400);
  if (!finalAnswer.trim()) throw new NeedsActionError("Answer is required.", 400);

  let usedGeneratedFrameworkGroup = false;
  let questions = (await repos.unknownQuestion.listByWorkspace(workspaceId))
    .filter((item) => uniqueIds.includes(item.id));
  // Only when NOTHING real resolved. The fabricated records below stamp ONE
  // domainKey across every question, and a group can legitimately span two —
  // "Brand Identity" holds four company_knowledge questions and three
  // factual_company_profile ones. Letting the fallback win over real records
  // rewrote those three as company_knowledge/legal_company_name (and /industry,
  // /phone_whatsapp), which are not framework keys, so they mapped to nothing
  // and stayed open: the owner answered a card of 7 and 3 came straight back.
  // Real records carry their own relatedDomain per question, so they are always
  // the better source. The fallback exists only for framework-generated groups
  // whose UnknownQuestion rows do not exist yet — see
  // scripts/smoke-group-answer-concurrency.ts, which posts synthetic ids.
  if (!questions.length && fallbackGroup?.domainKey && fallbackGroup.relatedQuestionKeys?.length) {
    const now = timestamp();
    usedGeneratedFrameworkGroup = true;
    questions = Array.from(new Set(fallbackGroup.relatedQuestionKeys)).map((questionKey, index): UnknownQuestion => ({
      id: uniqueIds[index] || uid("unknown"),
      workspaceId,
      channel: "knowledge",
      questionText: questionKey.replaceAll("_", " "),
      missingTopic: fallbackGroup.domainKey?.replaceAll("_", " "),
      status: "open",
      suggestedAnswer: `Framework question: ${fallbackGroup.domainKey}/${questionKey}.`,
      generatedBy: "framework",
      relatedDomain: fallbackGroup.domainKey,
      relatedQuestionKey: questionKey,
      priority: "high",
      createdAt: now,
      updatedAt: now,
    }));
  }
  if (!questions.length) throw new Error("Information-needed items were not found.");

  const answeredQuestions: UnknownQuestion[] = [];
  const mappedAnswerIds: string[] = [];
  for (const question of questions) {
    const updated = usedGeneratedFrameworkGroup
      ? { ...question, finalAnswer, status: addToKnowledge ? "added_to_knowledge" as const : "answered" as const, updatedAt: timestamp() }
      : addToKnowledge
        ? await repos.unknownQuestion.update(workspaceId, question.id, { finalAnswer, status: "added_to_knowledge" })
        : await repos.unknownQuestion.markAnswered(workspaceId, question.id, finalAnswer);
    answeredQuestions.push(updated);

    if (addToKnowledge) {
      const frameworkMarker = question.suggestedAnswer?.match(/Framework question: ([^.\n]+)/)?.[1];
      const knowledgeAnswer = await answerKnowledgeQuestionFromUnknown(
        workspaceId,
        question.questionText,
        finalAnswer,
        frameworkMarker,
        question.relatedDomain,
        question.relatedQuestionKey,
        repos,
      );
      if (knowledgeAnswer?.id) mappedAnswerIds.push(knowledgeAnswer.id);
      await upsertKnowledgeEntryForUnknownQuestion(workspaceId, question, finalAnswer);
    }
  }

  let document;
  let chunks: KnowledgeBaseChunk[] = [];
  if (addToKnowledge) {
    const earlier = await answerDocumentFor(workspaceId, questions.map((question) => question.id), repos);
    const input = {
      workspaceId,
      title: `Information Needed: ${questions[0].missingTopic || knowledgeQuestionTextFor(questions[0]).slice(0, 48)}`,
      documentType: "faq" as const,
      source: "unknown_question",
      contentText: [
        "Grouped Information Needed answer",
        "",
        `Questions covered: ${questions.length}`,
        ...questions.map((question, index) => `${index + 1}. ${knowledgeQuestionTextFor(question)}`),
        "",
        `Answer: ${finalAnswer}`,
      ].join("\n"),
      metadata: {
        unknownQuestionIds: questions.map((question) => question.id),
        mappedKnowledgeAnswerIds: mappedAnswerIds,
      },
    };
    // 2026-09-26 (break test): the same card answered again replaces its
    // earlier answer rather than adding a second one the AI can still find.
    document = earlier
      ? await repos.knowledgeBaseDocument.update(workspaceId, earlier.id, { contentText: input.contentText, metadata: input.metadata, status: "active" })
      : await createKnowledgeDocument(input, repos);
    // Session 55: chunking embeds each chunk, which is a network call per
    // chunk, and this runs inside withSnapshotSession. snapshot-session.ts is
    // explicit that a session must not span one — in JSON mode it holds the
    // data-file lock for its whole life. The document is created here; the
    // chunking is done by the caller after the session closes.
  }

  const durableMappedCount = addToKnowledge ? await persistGroupedFrameworkAnswers(workspaceId, questions, finalAnswer, repos) : 0;
  const mappedCount = Math.max(new Set(mappedAnswerIds).size, durableMappedCount);
  return {
    status: addToKnowledge ? "added_to_knowledge_base" : "answered",
    message: addToKnowledge
      ? `Business detail saved and mapped to ${mappedCount} internal question answer${mappedCount === 1 ? "" : "s"}.`
      : `Business detail saved for ${answeredQuestions.length} information item${answeredQuestions.length === 1 ? "" : "s"}.`,
    answeredQuestions: answeredQuestions.length,
    mappedAnswers: mappedCount,
    documentId: document?.id,
    chunks: chunks.length,
  };
}

async function persistGroupedFrameworkAnswers(workspaceId: string, questions: UnknownQuestion[], finalAnswer: string, repos: RepositoryBundle) {
  return repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.unknownQuestions ||= [];
    const now = timestamp();
    const mappedIds = new Set<string>();
    for (const question of questions) {
      const markerParts = question.suggestedAnswer?.match(/Framework question: ([^.\n]+)/)?.[1]?.split("/");
      const domainKey = question.relatedDomain || markerParts?.[0];
      const questionKey = question.relatedQuestionKey || markerParts?.[1];
      if (!domainKey || !questionKey) continue;

      const answer = data.knowledgeQuestionAnswers.find((item) =>
        item.workspaceId === workspaceId &&
        item.domainKey === domainKey &&
        item.questionKey === questionKey
      );
      if (!answer) continue;

      Object.assign(answer, {
        answer: finalAnswer.trim(),
        answerStatus: "answered",
        sourceType: "user_answer",
        confidenceScore: 1,
        isUserApproved: true,
        reviewedByUser: "user_owner",
        reviewedAt: now,
        isCanonical: true,
        updatedAt: now,
      });
      mappedIds.add(answer.id);

      const unknown = data.unknownQuestions.find((item) => item.workspaceId === workspaceId && item.id === question.id);
      if (unknown) {
        unknown.status = "added_to_knowledge";
        unknown.finalAnswer = finalAnswer.trim();
        unknown.updatedAt = now;
      }
    }
    return mappedIds.size;
  });
}

async function upsertKnowledgeEntryForUnknownQuestion(workspaceId: string, question: UnknownQuestion, finalAnswer: string) {
  const markerParts = question.suggestedAnswer?.match(/Framework question: ([^.\n]+)/)?.[1]?.split("/");
  const domainKey = question.relatedDomain || markerParts?.[0];
  const questionKey = question.relatedQuestionKey || markerParts?.[1];
  if (!domainKey || !questionKey) return undefined;
  try {
    return await upsertKnowledgeEntry({
      workspaceId,
      domainKey,
      questionKey,
      answer: finalAnswer,
    });
  } catch {
    return undefined;
  }
}

export async function addUnknownQuestionToKnowledge(workspaceId: string, unknownQuestionId: string, repos = createRepositories()) {
  const question = (await repos.unknownQuestion.listByWorkspace(workspaceId)).find((item) => item.id === unknownQuestionId);
  if (!question) throw new Error("Unknown question not found");
  // 2026-09-26 (break test): this fell back to suggestedAnswer, which is the
  // AI's suggestion or the system's own note ("Existing answer: 5 kg / New
  // document answer: 10 kg") — and published it as a fact the AI could quote.
  // Only the owner's answer goes into the knowledge base.
  const answer = question.finalAnswer?.trim();
  if (!answer) throw new NeedsActionError("Answer the question before adding it to knowledge.", 400);
  // Pressing it twice added the same answer twice; the question's existing
  // document is brought up to date instead.
  const earlier = await answerDocumentFor(workspaceId, [unknownQuestionId], repos);
  if (earlier) {
    const contentText = `Question: ${question.questionText}\nAnswer: ${answer}`;
    if (earlier.contentText !== contentText) {
      await repos.knowledgeBaseDocument.update(workspaceId, earlier.id, { contentText, status: "active" });
      await chunkKnowledgeDocument(workspaceId, earlier.id, repos);
    }
    return repos.unknownQuestion.markAddedToKnowledge(workspaceId, unknownQuestionId);
  }
  const document: Partial<KnowledgeBaseDocument> = {
    id: uid("kb_doc"),
    title: `Answer: ${question.questionText.slice(0, 60)}`,
    documentType: "faq",
    source: "unknown_question",
    contentText: `Question: ${question.questionText}\nAnswer: ${answer}`,
    metadata: { unknownQuestionId },
    status: "active",
  };
  const saved = await repos.knowledgeBaseDocument.create(workspaceId, document);
  const chunk: Partial<KnowledgeBaseChunk> = {
    id: uid("kb_chunk"),
    chunkIndex: 0,
    chunkText: saved.contentText,
    metadata: { documentType: "faq", source: "unknown_question" },
  };
  // 2026-09-17 (session 57): embedded like every other chunk. Without this the
  // answer the owner just approved is the one thing in the knowledge base that
  // meaning-search cannot find — it would only ever match on shared words.
  // Best-effort: with no embedding provider it is stored as before.
  await repos.knowledgeBaseChunk.createMany(workspaceId, saved.id, await embedChunks(workspaceId, [chunk], repos));
  return repos.unknownQuestion.markAddedToKnowledge(workspaceId, unknownQuestionId);
}

export async function getAgentAutonomousSettings(workspaceId: string, repos = createRepositories()) {
  const existing = await repos.agentAutonomousSettings.getByWorkspace(workspaceId);
  if (existing) return existing;
  return repos.agentAutonomousSettings.upsertForWorkspace(workspaceId, {
    icpGeneratorMode: "manual",
    campaignPlannerMode: "manual",
    discoveryMode: "manual",
    whatsappMode: "manual",
  });
}

export async function updateAgentAutonomousSettings(workspaceId: string, input: Record<string, unknown>, repos = createRepositories()) {
  const existing = await getAgentAutonomousSettings(workspaceId, repos);
  return repos.agentAutonomousSettings.upsertForWorkspace(workspaceId, {
    ...existing,
    icpGeneratorMode: (["manual", "automatic"].includes(String(input.icpGeneratorMode)) ? input.icpGeneratorMode : existing.icpGeneratorMode) as "manual" | "automatic",
    campaignPlannerMode: (["manual", "automatic"].includes(String(input.campaignPlannerMode)) ? input.campaignPlannerMode : existing.campaignPlannerMode) as "manual" | "automatic",
    discoveryMode: (["manual", "automatic"].includes(String(input.discoveryMode)) ? input.discoveryMode : existing.discoveryMode) as "manual" | "automatic",
    whatsappMode: (["manual", "automatic"].includes(String(input.whatsappMode)) ? input.whatsappMode : existing.whatsappMode) as "manual" | "automatic",
  });
}

export async function getOrCreateUsage(workspaceId = defaultWorkspaceId, repos = createRepositories()): Promise<AIUsageLimit> {
  const existing = await repos.aiUsageLimit.getByWorkspace(workspaceId);
  if (existing) return existing;
  // N-BUG (2026-09-07) — this used to write all four limits as `undefined`,
  // which is a NULL column under Prisma. Whichever surface touched AI Settings
  // first therefore created the workspace's usage row with NO caps, beating
  // resetUsageIfNeeded (the only writer that knew the defaults) to the row.
  // Combined with the NULL-reads-as-0 mapper bug that produced a hard zero cap
  // and blocked every LLM call on the deployment. Two creators of the same
  // singleton row must agree on its defaults, so this one writes the same four
  // constants AIUsageService does.
  return repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
    id: uid("ai_usage"),
    dailyTokenLimit: DEFAULT_DAILY_TOKEN_LIMIT,
    monthlyTokenLimit: DEFAULT_MONTHLY_TOKEN_LIMIT,
    dailyCostLimit: DEFAULT_DAILY_COST_LIMIT,
    monthlyCostLimit: DEFAULT_MONTHLY_COST_LIMIT,
    currentDailyTokens: 0,
    currentMonthlyTokens: 0,
    currentDailyCost: 0,
    currentMonthlyCost: 0,
  });
}

export type { AutoReplyLog };
