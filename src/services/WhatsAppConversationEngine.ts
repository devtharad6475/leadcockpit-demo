import { classifyCustomerMessage } from "@/conversations/message-classification";
import type { Lead, LeadStatus, MediaCatalogItem } from "@/lib/types";
import { defaultWhatsAppAgentSettings } from "@/policies/default-company-communication-settings";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { automaticReplyContentProblem, decideAutoReply } from "@/services/AutoReplyDecisionService";
import { automaticRepliesInARow } from "@/services/AutoReplyTrialService";
import { getRelevantContext, isVerifiedChunk, UNVERIFIED_CHUNK_MARKER } from "@/services/KnowledgeBaseService";
import { describeKnowledgeUsed, type KnowledgeUsedLine } from "@/rag/chunk-authority";
import { isContactBlocked } from "@/lib/dnc-registry";
import { gatherHistoryText } from "@/services/ConversationSummaryService";
import { getCustomerTicketReplyContext } from "@/services/CustomerTicketReplyContext";
import { formatLeadMemoryForPrompt, rememberConversation } from "@/services/LeadMemoryService";
import { listenForDiscoveryFacts } from "@/services/DiscoveryService";
import { classifyForTicket, createTicketFromInbound } from "@/services/TicketService";
import { LLMService } from "@/llm/LLMService";
import { WhatsAppLLMReplyOutputSchema, type WhatsAppLLMReplyOutput } from "@/validation/schemas";
import { MetaWhatsAppCloudProvider } from "@/providers/whatsapp/MetaWhatsAppCloudProvider";
import type { WhatsAppSendResult } from "@/providers/whatsapp/WhatsAppSendProvider";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { oneAtATime } from "@/lib/one-at-a-time";
import type { AgentLoopStep } from "@/agents/AgentLoop";

export type WhatsAppConversationInput = {
  workspaceId: string;
  leadId?: string;
  phone?: string;
  rawText: string;
  providerMessageId?: string;
  metadata?: Record<string, unknown>;
};

export type WhatsAppConversationResult = {
  classification: ReturnType<typeof classifyCustomerMessage>;
  suggestedReply: string;
  canAutoSend: boolean;
  needsHumanReview: boolean;
  blocked: boolean;
  reason: string;
  leadStatus?: LeadStatus;
  unknownQuestionCreated: boolean;
  autoReplyLogId: string;
  replyId: string;
  mediaAttachment?: {
    id: string;
    title: string;
    url: string;
    category: MediaCatalogItem["category"];
  };
  llm: {
    provider: string;
    modelName?: string;
    mode: "real" | "mock" | "fallback" | "unknown";
    fallbackUsed: boolean;
    validationStatus: "valid" | "invalid" | "not_run";
    warning?: string;
  };
  send: WhatsAppSendResult;
  /** True when this was a test: nothing above was saved or sent. */
  dryRun?: boolean;
  /** What a real message would have changed, reported instead of done. */
  wouldHave?: { recordedReply: boolean; changedLeadStatus?: LeadStatus; addedToDoNotContact: boolean; openedTicket: boolean; askedYouAQuestion: boolean; queuedDraftForApproval: boolean; sentByItself: boolean };
  /** Test only: the knowledge the reply read, with whether the owner approved each line. */
  knowledgeUsed?: KnowledgeUsedLine[];
};

/**
 * N-KB-2 (2026-08-20, found by the ten-company acceptance run): retrieval used
 * the raw customer message as its only query, so a follow-up that carries its
 * subject in the CONVERSATION rather than in the sentence retrieved nothing.
 *
 * Measured, not theorised. Against a water-treatment company whose knowledge
 * base states "Installation lead time: 8 weeks from signed order", the customer
 * message "If we sign this month, when would it be running?" returned ZERO
 * chunks at confidence 0.000 — the model drafted its reply with no company
 * context whatsoever, and duly answered "let me confirm the exact installation
 * timeline with our team" about a timeline the company had already written
 * down. That sentence shape is not an edge case; it is what every real sales
 * conversation looks like after the first message, once the customer stops
 * repeating the product name.
 *
 * The fix is deliberately conservative:
 *
 *   - The raw message is still the PRIMARY query, and its result is used
 *     whenever it is usable at all.
 *   - Only when the message alone retrieves nothing usable — no chunks, or a
 *     score below the same 0.35 bar decideAutoReply uses for
 *     hasSupportingKnowledge — do we retry with the tail of the conversation
 *     prepended.
 *   - Even then the STRONGER of the two results wins.
 *
 * So a question that already retrieves well cannot be diluted by unrelated
 * history, which is the regression a naive "always concatenate the history"
 * fix would introduce. The cost is one extra embedding call on the path where
 * the agent was previously blind, and a second knowledge query-log row for
 * that message — both honest: two retrievals really did happen.
 */
const HISTORY_QUERY_TAIL_CHARS = 600;
/** Same bar decideAutoReply uses for hasSupportingKnowledge — see the call site below. */
export const RETRIEVAL_USABLE_CONFIDENCE = 0.35;

export async function retrieveWithHistoryFallback(
  workspaceId: string,
  rawText: string,
  conversationHistory: string,
  repos: RepositoryBundle,
  /**
   * Test seam for the last-resort path below. Injected rather than
   * monkey-patched: the golden has to be able to say "the loop must NOT have
   * run", and counting calls is the only way to assert that honestly.
   */
  options: { agenticRetrieval?: typeof agenticRetrieval } = {},
): Promise<Awaited<ReturnType<typeof getRelevantContext>>> {
  const direct = await getRelevantContext(workspaceId, rawText, repos);
  if (direct.chunks.length > 0 && direct.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE) return direct;

  const history = (conversationHistory || "").trim();
  // gatherHistoryText returns this exact sentence for a lead with no events;
  // using it as a retrieval query would search for the words "no interactions".
  const hasHistory = Boolean(history) && history !== "No interactions yet.";

  let best = direct;
  if (hasHistory) {
    const expanded = await getRelevantContext(
      workspaceId,
      history.slice(-HISTORY_QUERY_TAIL_CHARS) + "\n" + rawText,
      repos,
    );
    if (expanded.confidenceScore > direct.confidenceScore) best = expanded;
  }
  if (best.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE) return best;

  // 2026-09-18 (session 57) — LAST RESORT: let the agent search in its own words.
  //
  // Both tries above search with the CUSTOMER's wording. A buyer who writes
  // "gold border ka rate" when the knowledge base says "zari trimming price
  // list" defeats them both. Here the model is given the search tool and left to
  // rephrase until it finds something — the one case where letting it choose its
  // own steps earns the extra calls.
  //
  // Deliberately only on the weak path, and reached whether or not the lead has
  // history: a first-time buyer asking in unusual words is exactly this case. A
  // question the first search already answered must not become three model
  // calls, because a customer is waiting on this path.
  if (!agenticRetrievalEnabled()) return best;
  const agentic = await (options.agenticRetrieval ?? agenticRetrieval)(workspaceId, rawText, repos);
  return agentic && agentic.confidenceScore > best.confidenceScore ? agentic : best;
}

/**
 * Off by default. The straight-line path is cheaper, faster and predictable;
 * this is switched on per deployment once it has been measured against it.
 */
/**
 * N4 — is per-lead memory on?
 *
 * On by default, unlike the agentic-retrieval flag, because this one costs
 * about five paise per conversation and cannot change what the AI is allowed to
 * SAY — it only gives the next reply something the last one already knew. The
 * switch exists so it can be turned off without a deploy if it ever misbehaves.
 */
export function rememberEnabled(): boolean {
  return process.env.LEADGEN_LEAD_MEMORY !== "0";
}

/**
 * N11 (2026-09-19) — listen for what a buyer tells us about themselves.
 *
 * On by default for the same reason as the memory flag: it cannot change a
 * single word the AI says. This half only WRITES DOWN what the customer already
 * volunteered; the half that asks questions is not built, and when it is, it
 * gets its own switch.
 */
export function discoveryListeningEnabled(): boolean {
  return process.env.LEADGEN_DISCOVERY_LISTEN !== "0";
}

export function agenticRetrievalEnabled(): boolean {
  return process.env.LEADGEN_AGENTIC_RETRIEVAL === "1";
}

/**
 * Run the WhatsApp agent with its knowledge-search tool, and keep the wording it
 * found most with. The loop's own answer is DISCARDED: the reply is still
 * written by the existing path, with the existing approval rules and the
 * existing verified/unverified handling. This changes what the AI can FIND, not
 * what it is allowed to say — which is what makes it safe to try on a live path.
 */
export async function agenticRetrieval(
  workspaceId: string,
  rawText: string,
  repos: RepositoryBundle,
): Promise<Awaited<ReturnType<typeof getRelevantContext>> | null> {
  try {
    const { runAgentLoop } = await import("@/agents/AgentLoop");
    const run = await runAgentLoop({
      agentName: "whatsapp-conversation-agent",
      workspaceId,
      taskName: "whatsapp_reply",
      instructions: [
        "A customer asked the question below and a plain search of the company knowledge found nothing useful.",
        "Search again in the words the company itself would use, not the customer's — a buyer may say 'gold border'",
        "where the company writes 'zari trimming'. Try a different wording each time, stop as soon as you find the",
        "answer, and say plainly if it is not there.",
      ].join(" "),
      question: rawText,
      repos,
      maxSteps: 3,
    });

    // The wordings it tried, best first. The tool reports the confidence of each
    // search, so the model's most productive query is knowable without trusting
    // its own summary of how well it did.
    const searches = run.steps
      .filter((step): step is Extract<AgentLoopStep, { kind: "tool_call" }> => step.kind === "tool_call" && step.tool === "search_knowledge_base")
      .map((step) => ({
        query: String((step.args as { query?: unknown }).query || ""),
        confidence: Number((step.result as { confidence?: unknown })?.confidence ?? 0),
      }))
      .filter((search) => search.query)
      .sort((a, b) => b.confidence - a.confidence);

    if (!searches[0] || searches[0].confidence < RETRIEVAL_USABLE_CONFIDENCE) return null;
    // Re-run through the normal path so the caller gets real chunks with their
    // metadata: the verified/unverified split downstream depends on them, and a
    // summary of a search is not a search result.
    return await getRelevantContext(workspaceId, searches[0].query, repos);
  } catch (error) {
    // Never fail a customer reply because the clever path broke. The weak
    // context from the plain search is still an honest answer.
    console.warn(`[whatsapp] agentic retrieval failed, using the plain search: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * `dryRun` (2026-09-25): the owner's "try it" buttons (WhatsApp Agent's full
 * check, the Replies inbox "Simulate") called this real inbound handler, so a
 * TEST saved a fake customer message in the Replies inbox, queued a draft in
 * AI Drafts, opened tickets and Information Needed cards, changed the chosen
 * lead's status — and a test message saying "stop" put a real customer on the
 * permanent do-not-contact list. With dryRun every one of those writes is
 * skipped (and nothing is sent — dryRun forces allowRealSend off); the result
 * reports what a real message WOULD have done instead. The model call and the
 * safety decision run exactly as for a real message, which is the point.
 */
export async function handleIncomingWhatsAppMessage(input: WhatsAppConversationInput, repos: RepositoryBundle = createRepositories(), options: { allowRealSend?: boolean; dryRun?: boolean } = {}): Promise<WhatsAppConversationResult> {
  // 2026-09-27 (review W5): one customer's messages are handled one after
  // another. Two arriving together both read "2 automatic replies so far" and
  // both sent, past the cap of 3; they could also race each other's lead updates.
  if (options.dryRun) return handleOne(input, repos, options);
  const key = `wa-inbound:${input.workspaceId}:${input.leadId || input.phone || "unknown"}`;
  return oneAtATime(key, () => handleOne(input, repos, options));
}

async function handleOne(input: WhatsAppConversationInput, repos: RepositoryBundle, options: { allowRealSend?: boolean; dryRun?: boolean }): Promise<WhatsAppConversationResult> {
  const dryRun = Boolean(options.dryRun);
  if (dryRun) options = { ...options, allowRealSend: false };
  const classification = classifyCustomerMessage(input.rawText);
  const lead = await resolveLead(input, repos);
  // 2026-08-04 (customer-simulation follow-up): pass the conversation history
  // to the reply model so it can personalize ("as we discussed…") instead of
  // treating every message as the first one. Gathers the lead's recent
  // outreach/replies/logs as a chronological feed. Bounded — empty for a new
  // lead, so first-contact behavior is unchanged. Best-effort: a failure here
  // must NOT break the reply (the model still gets the current message + KB).
  //
  // N-KB-2 (2026-08-20): this now runs BEFORE retrieval, because retrieval
  // needs it too. See retrieveWithHistoryFallback above.
  let conversationHistory = "";
  if (lead?.id) {
    try {
      const history = await gatherHistoryText(input.workspaceId, lead.id, repos);
      conversationHistory = history.text || "";
    } catch (e) {
      console.warn("[WhatsAppEngine] conversation history unavailable, continuing without it:", e instanceof Error ? e.message : e);
    }
  }
  const context = await retrieveWithHistoryFallback(input.workspaceId, input.rawText, conversationHistory, repos);
  const settings = await getOrCreateWhatsAppSettings(input.workspaceId, repos);
  // 2026-09-10 (session 55): only offer the agent files that can actually be
  // sent. A row whose bytes are not in the store (seeded demo content, or an
  // upload from before the bytes moved off the container filesystem) looks
  // exactly like a real one in this list -- observed live: the model was asked
  // for a catalogue, correctly picked the row titled "Zari lace catalogue
  // 2026", and that row has never had a file behind it. Meta would have been
  // handed a 404 and the customer would have received nothing, with the log
  // recording a successful choice. The owner still sees these rows in the
  // gallery, marked, so the gap is visible rather than silent.
  const allMedia = await repos.mediaCatalog.listByWorkspace(input.workspaceId);
  const availableMedia = allMedia.filter((item) => !item.fileMissing);
  const llmDraft = await generateLLMWhatsAppDraft(input, classification, context, lead, settings, repos, availableMedia, conversationHistory);
  const suggestedReply = llmDraft.output?.suggestedReply || buildFallbackSuggestedReply(classification.category, context.contextText, llmDraft.warning);
  const modelAnsweredMedia = typeof llmDraft.output?.mediaAttachmentId === "string";
  const mediaAttachment = chooseMediaAttachment(input.rawText, classification.category, availableMedia, llmDraft.output?.mediaAttachmentId, modelAnsweredMedia);
  // 2026-09-10 (session 55): record WHO picked the file. An attachment can come
  // from the model (it was given the catalogue with ids and asked to name one)
  // or from the keyword rule that runs when the model names nothing. Those are
  // very different facts about the product, and until now the log kept only
  // "availableMediaCount", so an owner asking "did the AI choose this?" had no
  // way to find out -- a rule-picked file is indistinguishable from a reasoned
  // one on every screen.
  const modelNamedMedia = Boolean(llmDraft.output?.mediaAttachmentId);
  const modelPickWasUsed = modelNamedMedia && mediaAttachment?.id === llmDraft.output?.mediaAttachmentId;
  const mediaChoiceSource = modelPickWasUsed
    ? "model"
    : mediaAttachment
      ? "rule"
      : modelNamedMedia
        ? "model_named_a_file_this_workspace_does_not_have"
        : modelAnsweredMedia
          ? "model_declined"
          : "none";
  const isGenericSafeReply = classification.category === "greeting" || classification.category === "catalogue_request";
  // Phase 2.9 audit fix: the send decision uses the UNION of the keyword
  // classifier and the LLM classifier. If EITHER flags the message as
  // sensitive, high-risk, or needing human review, the merged classification
  // reflects the stricter result. Previously only the keyword classifier fed
  // decideAutoReply — a price_request classified as low-risk by keywords but
  // high-risk by the LLM would slip through.
  const llmClassification = llmDraft.output?.classification;
  const llmNeedsReview = llmDraft.output?.needsHumanReview;
  // Session 55: the LLM's leadStatusSuggestion was read for the opt-out check
  // below and nowhere else, so the status actually written to the lead came
  // from the keyword floor alone — and that floor maps ANY price mention to
  // hot_lead (message-classification.ts). Observed live: a hobby buyer asking
  // for 1 kg, whom the product had just told "we wouldn't be able to supply",
  // was filed as hot_lead. The keyword pass cannot see a disqualification; the
  // LLM that read the message and the ICP can, and the prompt asks it for
  // exactly this field. Validated against LeadStatus so a hallucinated value
  // falls back to the floor rather than being written to the record.
  const llmStatusSuggestion = VALID_LEAD_STATUSES.has(String(llmDraft.output?.leadStatusSuggestion))
    ? (llmDraft.output?.leadStatusSuggestion as LeadStatus)
    : undefined;
  // 2026-09-27 (review W1): opt-outs are in this set. "Hi, please don't send
  // these anymore" read as a greeting to the keyword pass; the AI's
  // "unsubscribe" was ignored because it was not listed here, so a cheerful
  // automatic reply went out BEFORE the number was put on do-not-contact.
  const SENSITIVE_CATEGORIES = new Set([
    "price_request", "payment_question", "delivery_question", "return_question",
    "complaint", "abusive_message", "customization_question", "export_question",
    "moq_request", "hot_lead", "unknown_question",
    "unsubscribe", "not_interested", "wrong_number", "bulk_order_interest", "sample_request",
  ]);
  // D-2026-09-27-b — a kind of question the owner ticked for automatic replies
  // (only possible after the trial proved it) is judged by the AI that read the
  // message, not by the keyword pass's blanket default for the category (the
  // keyword pass marks every MOQ or sample question "medium, needs review"
  // without reading it). Both must still agree on the category, and the AI's
  // own risk, review flag and confidence still apply in full. The AI must name
  // the same kind (review W2: its "other" counted as agreement, so "Hi, is
  // 500m available?" went out as a greeting). The one exception is a location
  // question, a kind the AI reader cannot name at all.
  const ownerProvenTopic = (settings.autoReplyTopics ?? []).includes(classification.category)
    && Boolean(llmDraft.output)
    && (llmClassification === classification.category
      || (classification.category === "location_question" && llmClassification === "other"));
  const mergedClassification = {
    ...classification,
    // If the LLM flagged a sensitive category OR needsHumanReview, escalate.
    category: (llmClassification && SENSITIVE_CATEGORIES.has(llmClassification)) ? llmClassification : classification.category,
    riskLevel: (llmDraft.output?.riskLevel === "high" || llmDraft.output?.riskLevel === "medium") ? llmDraft.output.riskLevel : (ownerProvenTopic ? "low" as const : classification.riskLevel),
    requiresHumanReview: (ownerProvenTopic ? false : classification.requiresHumanReview) || Boolean(llmNeedsReview),
    confidence: ownerProvenTopic
      ? (llmDraft.output?.confidenceScore ?? 0)
      : Math.min(classification.confidence, llmDraft.output?.confidenceScore ?? classification.confidence),
    leadStatusSuggestion: llmStatusSuggestion || classification.leadStatusSuggestion,
  };
  const mergedIsGenericSafeReply = mergedClassification.category === "greeting" || mergedClassification.category === "catalogue_request";
  // D-2026-09-27-b — the per-conversation cap needs this customer's history.
  const automaticRepliesSoFar = lead?.id && !dryRun
    ? automaticRepliesInARow(await repos.autoReplyLog.listByLead(input.workspaceId, lead.id))
    : 0;
  let decision = decideAutoReply({
    settings,
    classification: mergedClassification,
    lead,
    hasSupportingKnowledge: context.confidenceScore >= 0.35,
    isGenericSafeReply: mergedIsGenericSafeReply,
    automaticRepliesInARow: automaticRepliesSoFar,
  });
  // F-OUTREACH-1 (2026-08-04 build-right audit): the pure decideAutoReply only
  // checks the lead's DNC FLAG, not the PERMANENT REGISTRY (LOGIC.md "DNC is
  // permanent — clearing the lead flag does NOT remove them from the registry").
  // Every sibling send path (AutoReplyReviewService, price-change/send) calls
  // isContactBlocked; this path is the gate for the CP-22 auto-acknowledge AND
  // any future Stage-4 auto-send. Latent today (every production caller passes
  // allowRealSend=false) but becomes a live P1 the moment that unlocks. Hard
  // block: if the registry says blocked, override the decision to blocked.
  if (lead) {
    try {
      const registry = await isContactBlocked(input.workspaceId, lead, repos);
      if (registry.blocked) {
        decision = { canAutoSend: false, needsHumanReview: false, blocked: true, reason: registry.reason };
      }
    } catch (e) {
      // Best-effort: a registry read failure must NOT enable an auto-send.
      // Fail safe → hold for review (the operator sees the message either way).
      console.warn("[WhatsAppEngine] DNC registry check failed, holding for review:", e instanceof Error ? e.message : e);
      decision = { canAutoSend: false, needsHumanReview: true, blocked: false, reason: "Could not verify do-not-contact registry status; held for review." };
    }
  }
  // 2026-09-28 (real-AI eval): the decision above judged the customer's
  // message; this reads the reply that would actually go out. A price, a date,
  // credit, a stock claim or a number that is not in the approved knowledge
  // the AI was given sends it to the owner instead (see
  // automaticReplyContentProblem). Only ever holds.
  if (decision.canAutoSend) {
    const problem = automaticReplyContentProblem(suggestedReply, {
      knowledgeText: context.chunks.filter(isVerifiedChunk).map((chunk) => chunk.chunkText).join("\n"),
      customerText: input.rawText,
    });
    if (problem) decision = { canAutoSend: false, needsHumanReview: true, blocked: false, reason: problem };
  }
  const realModelSucceeded = llmDraft.mode === "real" && !llmDraft.fallbackUsed && llmDraft.provider !== "mock" && llmDraft.validationStatus === "valid";
  const llmSafetyBlocks = !realModelSucceeded
    ? "Real LLM reply was not confirmed, so the draft is held for review."
    : llmDraft.output?.missingKnowledge
      ? "The LLM reported missing knowledge, so the draft is held for review."
      : "";
  const finalCanAutoSend = decision.canAutoSend && realModelSucceeded && !llmDraft.output?.missingKnowledge;
  const finalNeedsHumanReview = decision.needsHumanReview || !finalCanAutoSend;
  const finalReason = [decision.reason, llmSafetyBlocks].filter(Boolean).join(" ");
  const send = await maybeSendWhatsApp({
    workspaceId: input.workspaceId,
    // 2026-09-27 (review W8): answer the number that wrote. A buyer writing
    // from their second phone got the reply on the saved WhatsApp number.
    to: input.phone || lead?.whatsappNumber || "",
    body: suggestedReply,
    mode: settings.mode,
    canAutoSend: finalCanAutoSend,
    allowRealSend: Boolean(options.allowRealSend),
    mediaAttachment,
    repos, // CP-17c: resolve per-workspace WhatsApp creds.
  });

  // CP-22 (2026-08-02) — auto-acknowledge sensitive questions. When the
  // decision is "needs human review" (sensitive question the AI can't answer)
  // AND the owner has enabled autoAcknowledgeSensitive AND WhatsApp is
  // configured AND the message isn't blocked — auto-send a GENERIC holding
  // template so the customer isn't left hanging. The AI draft (real answer)
  // still waits for owner approval. This is the ONE controlled exception to
  // no-auto-outreach (D-2026-08-02-m). The template is owner-written, never
  // AI-generated, so it can never contain wrong prices/facts.
  let acknowledgementSent = false;
  const SENSITIVE_FOR_ACK = new Set([
    "price_request", "payment_question", "delivery_question", "moq_request",
    "sample_request", "customization_question", "export_question", "hot_lead",
    "unknown_question",
  ]);
  const isAckEligible =
    settings.autoAcknowledgeSensitive === true &&
    !decision.blocked &&
    finalNeedsHumanReview &&
    (SENSITIVE_FOR_ACK.has(mergedClassification.category) || decision.needsHumanReview) &&
    !["unsubscribe", "abusive_message", "not_interested", "wrong_number"].includes(mergedClassification.category) &&
    lead?.whatsappNumber;
  let ackSendResult: WhatsAppSendResult = { attempted: false, status: "not_attempted", provider: "meta_cloud" };
  if (isAckEligible && options.allowRealSend) {
    const ACK_TEMPLATE = settings.acknowledgementTemplate?.trim() ||
      "Thanks for your message! I want to give you the exact details, so I'm confirming with our team now. I'll get back to you within 24 hours.";
    try {
      const ackProvider = await new (await import("@/services/WhatsAppCredentialService")).WhatsAppCredentialService(repos).resolveProvider(input.workspaceId);
      if (ackProvider.isConfigured()) {
        ackSendResult = await ackProvider.sendTextMessage({
          workspaceId: input.workspaceId,
          to: lead!.whatsappNumber!,
          body: ACK_TEMPLATE,
          previewOnly: false,
        });
        acknowledgementSent = ackSendResult.status === "sent" || ackSendResult.attempted;
      }
    } catch {
      // No silent failure: the acknowledgement failure is recorded on the log
      // (acknowledgementSent stays false) so the owner sees it didn't go out.
      acknowledgementSent = false;
    }
  }

  // CP-22 Feature C — smarter draft. If the holding message was sent, the AI
  // draft becomes a clear placeholder so the owner knows the next step. If not
  // 2026-08-05 ROOT-FIX (build-right): do NOT throw away the LLM's real reply
  // just because it flagged missingKnowledge. The model's reply ALREADY defers
  // gracefully ("let me confirm with our team") AND adds value (acknowledges
  // the question, asks a clarifying question, references known facts). The old
  // code replaced it with a generic string — making EVERY sensitive/unknown
  // reply identical + useless to the owner reviewing the queue. Now: keep the
  // LLM reply. missingKnowledge still (a) routes to human review, (b) creates
  // an Information Needed card — both unchanged. Only fall back to the generic
  // string when there is NO LLM reply at all (truly empty / fallback mode).
  let finalSuggestedReply = suggestedReply;
  if (!suggestedReply || suggestedReply.trim().length < 10) {
    finalSuggestedReply = acknowledgementSent
      ? "[Holding message sent to customer. Answer the Information Needed card and the real reply will be drafted here.]"
      : "Thanks for your question. Let me confirm the exact details with our team and get right back to you.";
  }

  const replyInput = {
    workspaceId: input.workspaceId,
    campaignId: lead?.campaignId,
    // Cluster F fix (2026-07-21 session 20): NEVER write the fake id
    // "unmatched_whatsapp_lead". The OLD code wrote Reply/AutoReplyLog rows
    // pointing at this fake id when no lead matched — those rows were then
    // NEVER cleaned up by erasure (the cascade searches by real leadId),
    // leaving permanent orphans (P0 finding C4). Now we leave leadId
    // undefined when there's no real lead; the Reply is still recorded
    // (audit trail of the inbound message), but it's correctly attributed
    // as "no matching lead" rather than faked onto a phantom customer.
    leadId: lead?.id || input.leadId,
    channel: "whatsapp",
    rawText: input.rawText,
    // N-BUG (2026-09-08): recorded the keyword classifier's raw category while
    // the send decision ran on the merged one. On an LLM escalation the
    // Replies inbox labelled a held complaint "Greeting" — the operator read
    // one category on screen and the product had acted on another.
    classification: mergedClassification.category,
    confidenceScore: mergedClassification.confidence,
    summary: mergedClassification.reason,
    suggestedNextAction: finalNeedsHumanReview ? (acknowledgementSent ? "Holding message sent. Answer the Information Needed card, then approve the real reply." : "Review the LLM draft before sending.") : send.status === "sent" ? "Automatic WhatsApp reply sent." : "Safe automatic reply prepared.",
    suggestedResponse: finalSuggestedReply,
  };
  const reply = dryRun ? { id: "dry-run" } : await repos.reply.create(replyInput);

  let leadStatus = lead?.status;
  // N-BUG (2026-09-08): whether this is an opt-out does not depend on whether
  // we happen to have a lead record. It was computed inside `if (lead)`, and
  // the opt-out sitting in the live Replies inbox — "Stop, don't contact me",
  // from a number with no lead — therefore registered NOTHING, while the reply
  // the product sent back said "we won't contact you again".
  const triggersDnc = mergedClassification.category === "unsubscribe" || llmDraft.output?.leadStatusSuggestion === "do_not_contact";
  if (lead) {
    leadStatus = nextStatus(mergedClassification.leadStatusSuggestion, lead.status);
  }
  const inboundStampedAt = new Date().toISOString();
  if (lead && !dryRun) {
    await repos.lead.updateLead(input.workspaceId, lead.id, {
      status: leadStatus,
      doNotContact: triggersDnc ? true : lead.doNotContact,
      // CP-24 — stamp the customer's last inbound message time. Drives the
      // WhatsApp 24-hour customer-service window (Meta rule).
      lastInboundAt: inboundStampedAt,
      // 2026-09-28 (Needs you v2): an automatic reply that really went out is a
      // reply — without this the customer would be listed as "waiting".
      ...(send.status === "sent" ? { lastContactedAt: inboundStampedAt } : {}),
    });
  }
  // Session 3 audit fix: when a contact unsubscribes, register them on the
  // PERMANENT DNC registry so that even if this lead is later deleted or
  // re-imported, the opt-out survives. This is the legal-safety guarantee —
  // which is exactly why it runs on the INBOUND PHONE NUMBER and not on a lead
  // record that may not exist yet. A person who says "stop" before they are in
  // the CRM is the most important one to remember: nothing else in the system
  // knows about them, so if this write is skipped, the number is contactable
  // again the moment it is imported.
  if (triggersDnc && !dryRun) {
    await registerDoNotContact(input.workspaceId, {
      phone: lead?.whatsappNumber || lead?.phone || input.phone,
      email: lead?.email,
      reason: mergedClassification.category === "unsubscribe" ? "Customer requested opt-out via WhatsApp." : "System flagged do_not_contact.",
      sourceLeadId: lead?.id,
    }, repos);
    // 2026-09-28 — an opt-out is a real result: recorded, and a ticked kind the
    // AI answered by itself for this customer in the last 7 days is switched off.
    if (lead?.id) {
      const { recordOptOut } = await import("@/services/OutcomeSignalService");
      await recordOptOut(input.workspaceId, lead.id, repos);
    }
  }

  const shouldCreateUnknownQuestion = Boolean(llmDraft.output?.missingKnowledge && llmDraft.output.missingQuestion?.trim()) ||
    mergedClassification.category === "unknown_question" ||
    (!context.contextText && !mergedIsGenericSafeReply && !["unsubscribe", "abusive_message", "not_interested", "wrong_number", "complaint"].includes(mergedClassification.category));
  // Stage 2 (2026-07-20): complaints + problems → tracked Ticket, not just a
  // held auto-reply log. The owner sees it in their ticket inbox with an SLA
  // clock. Per AGENTS.md, sensitive topics (complaints) always require human
  // review — now they're tracked instead of just held.
  //
  // N-BUG (2026-09-08): this read `classification`, the keyword classifier's
  // raw output, and not `mergedClassification`. The merge exists precisely
  // because the keyword pass is only a floor — "complaint" and
  // "abusive_message" are both in SENSITIVE_CATEGORIES, so the LLM can and
  // does escalate into them — and every one of those escalations opened no
  // ticket. Same for the send decision, which already used the merge, so the
  // product could hold a message for human review as a complaint and leave
  // nothing in the ticket inbox to review it from.
  const opensTicket = ["complaint", "abusive_message", "return_question"].includes(mergedClassification.category);
  if (opensTicket && !dryRun) {
    const { type, priority } = classifyForTicket(mergedClassification.category);
    try {
      const ticket = await createTicketFromInbound({
        workspaceId: input.workspaceId,
        leadId: lead?.id || input.leadId,
        conversationId: reply.id,
        sourceChannel: "whatsapp",
        type,
        priority,
        subject: ticketSubjectFrom(input.rawText),
        description: input.rawText,
      }, repos);
      // 2026-09-28 — a complaint is a real result (and may switch off a kind
      // the AI answered by itself for this customer in the last 7 days).
      if (type === "complaint" && ticket.leadId) {
        const { recordComplaint } = await import("@/services/OutcomeSignalService");
        await recordComplaint(input.workspaceId, ticket.leadId, ticket.id, repos);
      }
    } catch (error) {
      // Per skill v2 "no silent failures": log the error so the operator can
      // see ticket creation failed, but don't let it block the reply flow.
      console.error(`[TicketService] Failed to create ticket from inbound WhatsApp complaint:`, error instanceof Error ? error.message : error);
    }
  }
  // 2026-09-28 — tell the OWNER (their own WhatsApp, when switched on) that a
  // complaint or an abusive message arrived. It only informs; nothing is sent
  // to the customer by it. A failure never stops the reply flow.
  if (!dryRun && (mergedClassification.category === "complaint" || mergedClassification.category === "abusive_message")) {
    try {
      const { alertOwnerOnComplaint } = await import("@/services/OwnerNotifyService");
      await alertOwnerOnComplaint(input.workspaceId, {
        replyId: reply.id,
        category: mergedClassification.category,
        leadName: lead?.companyName || lead?.contactName || undefined,
        text: input.rawText,
      }, repos);
    } catch (error) {
      console.error("[OwnerNotify] complaint alert failed:", error instanceof Error ? error.message : error);
    }
  }
  let unknownQuestionCreated = false;
  if (shouldCreateUnknownQuestion && !dryRun) {
    await repos.unknownQuestion.create(input.workspaceId, {
      leadId: lead?.id || input.leadId,
      channel: "whatsapp",
      questionText: llmDraft.output?.missingQuestion?.trim() || input.rawText,
      missingTopic: llmDraft.output?.classification || classification.category,
      status: "open",
      generatedBy: "whatsapp_unknown",
      priority: ["price_request", "payment_question", "delivery_question", "return_question", "customization_question", "export_question", "hot_lead"].includes(mergedClassification.category) ? "high" : "medium",
      suggestedAnswer: "Great question — let me confirm the exact details with our team and get right back to you.",
    });
    unknownQuestionCreated = true;
  }

  const logInput = {
    leadId: lead?.id || input.leadId,
    replyId: reply.id,
    channel: "whatsapp",
    incomingMessage: input.rawText,
    retrievedContext: {
      confidenceScore: context.confidenceScore,
      chunks: context.chunks.map((chunk) => ({ id: chunk.id, score: chunk.score, documentTitle: chunk.documentTitle })),
      llmClassification: llmDraft.output?.classification,
      // D-2026-09-27-b — the kind the send decision used; the trial record is
      // counted on this, so it matches what the owner ticks.
      decisionCategory: mergedClassification.category,
      llmRiskLevel: llmDraft.output?.riskLevel,
      llmReason: llmDraft.output?.reason,
      availableMediaCount: availableMedia.length,
      unsendableMediaCount: allMedia.length - availableMedia.length,
      mediaChoiceSource,
      modelNamedMediaId: llmDraft.output?.mediaAttachmentId,
    },
    classification: llmDraft.output?.classification || classification.category,
    generatedReply: finalSuggestedReply,
    confidenceScore: Math.min(classification.confidence, llmDraft.output?.confidenceScore ?? classification.confidence),
    canAutoSend: finalCanAutoSend,
    needsHumanReview: finalNeedsHumanReview,
    reason: finalReason,
    modelProvider: llmDraft.provider,
    modelName: llmDraft.modelName,
    modelMode: llmDraft.mode,
    fallbackUsed: llmDraft.fallbackUsed,
    validationStatus: llmDraft.validationStatus,
    sendAttempted: send.attempted,
    sendStatus: send.status,
    providerMessageId: send.providerMessageId,
    providerError: send.errorMessage,
    mediaAttachmentId: mediaAttachment?.id,
    mediaAttachmentUrl: mediaAttachment?.url,
    mediaAttachmentName: mediaAttachment?.title,
    acknowledgementSent,
    // CP-22 — when the holding message was sent but the real draft still needs
    // review, status is "acknowledged" (distinct from "held_for_review" so the
    // UI can show "holding message sent — awaiting your answer").
    // 2026-09-27 (review W6): an automatic send that failed goes back to the
    // owner as a draft to approve — "failed" had no Approve button, so the
    // customer's message sat unanswered with no way to send the reply.
    status: (decision.blocked || send.status === "blocked" ? "blocked" : send.status === "sent" ? "auto_sent" : send.status === "failed" ? "held_for_review" : acknowledgementSent ? "acknowledged" : finalCanAutoSend ? "drafted" : "held_for_review") as "blocked" | "auto_sent" | "failed" | "acknowledged" | "drafted" | "held_for_review",
  };
  const log = dryRun ? { id: "dry-run", status: logInput.status } : await repos.autoReplyLog.create(input.workspaceId, logInput);

  // N4 (2026-09-18) — update what we remember about this buyer.
  //
  // AFTER the reply is drafted and logged, and deliberately NOT awaited. The
  // customer is waiting on a WhatsApp webhook; making them wait an extra model
  // call so the system can take a note is the wrong trade. `rememberConversation`
  // never throws, so there is nothing here to catch.
  if (lead?.id && rememberEnabled() && !dryRun) {
    void rememberConversation(input.workspaceId, lead.id, repos);
  }

  // N11 (2026-09-19) — notice whether the customer just told us something on the
  // wanted list. Same placement and same reasoning: after the reply, never
  // awaited, never throws. It asks nothing and changes nothing the customer
  // sees — the asking half ships only once the owner has read what this caught.
  if (lead?.id && discoveryListeningEnabled() && !dryRun) {
    void listenForDiscoveryFacts(input.workspaceId, lead.id, repos);
  }

  // 2026-09-27 — reminders for later: a customer who names a time ("call after
  // Diwali", "next week") gets a PROPOSED reminder with their words, for the
  // owner to confirm. Cheap (no AI call) and never blocks the reply.
  if (lead?.id && !dryRun && !triggersDnc) {
    const { proposeReminderFromMessage } = await import("@/services/FollowUpService");
    await proposeReminderFromMessage(input.workspaceId, lead.id, input.rawText, repos);
  }

  return {
    classification,
    suggestedReply: finalSuggestedReply,
    canAutoSend: finalCanAutoSend,
    needsHumanReview: finalNeedsHumanReview,
    blocked: decision.blocked || send.status === "blocked",
    reason: finalReason,
    leadStatus,
    unknownQuestionCreated,
    autoReplyLogId: log.id,
    replyId: reply.id,
    mediaAttachment: mediaAttachment ? {
      id: mediaAttachment.id,
      title: mediaAttachment.title,
      url: mediaAttachment.url,
      category: mediaAttachment.category,
    } : undefined,
    llm: {
      provider: llmDraft.provider,
      modelName: llmDraft.modelName,
      mode: llmDraft.mode,
      fallbackUsed: llmDraft.fallbackUsed,
      validationStatus: llmDraft.validationStatus,
      warning: llmDraft.warning,
    },
    send,
    ...(dryRun ? {
      dryRun: true,
      wouldHave: {
        recordedReply: true,
        changedLeadStatus: lead && leadStatus !== lead.status ? leadStatus : undefined,
        addedToDoNotContact: triggersDnc,
        openedTicket: opensTicket,
        askedYouAQuestion: shouldCreateUnknownQuestion,
        queuedDraftForApproval: ["held_for_review", "drafted", "blocked", "failed"].includes(log.status),
        // Would a real message like this have gone to the customer with no
        // one looking? Needs the safety decision AND the owner's automatic
        // mode — the same two things maybeSendWhatsApp checks before a send.
        sentByItself: finalCanAutoSend && !decision.blocked && (settings.mode === "automatic" || settings.mode === "safe_auto_reply"),
      },
      knowledgeUsed: describeKnowledgeUsed(context.chunks),
    } : {}),
  };
}

async function generateLLMWhatsAppDraft(
  input: WhatsAppConversationInput,
  classification: ReturnType<typeof classifyCustomerMessage>,
  context: Awaited<ReturnType<typeof getRelevantContext>>,
  lead: Lead | undefined,
  settings: Awaited<ReturnType<typeof getOrCreateWhatsAppSettings>>,
  repos: RepositoryBundle,
  availableMedia: MediaCatalogItem[],
  conversationHistory: string,
): Promise<{
  output: WhatsAppLLMReplyOutput | undefined;
  provider: string;
  modelName?: string;
  mode: "real" | "mock" | "fallback" | "unknown";
  fallbackUsed: boolean;
  validationStatus: "valid" | "invalid" | "not_run";
  warning?: string;
}> {
  try {
    const currentTicketContext = await getCustomerTicketReplyContext(input.workspaceId, lead?.id, repos);
    const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>("whatsapp_reply", {
      customerMessage: input.rawText,
      deterministicClassification: classification,
      retrievedKnowledge: context.contextText,
      contextConfidence: context.confidenceScore,
      // Prior conversation with this customer (chronological feed). Lets the
      // model personalize ("as we discussed…") instead of re-asking answered
      // questions. Empty for a first-time contact.
      conversationHistory,
      currentTicketContext,
      // N4 (2026-09-18): what this buyer has told us across ALL past
      // conversations, not just the recent messages above. The history is a
      // transcript and gets long; this is four lines of what actually matters,
      // and it is what lets a reply in September use something said in March.
      customerMemory: formatLeadMemoryForPrompt(lead),
      lead: lead ? {
        id: lead.id,
        status: lead.status,
        reviewStatus: lead.reviewStatus,
        companyName: lead.companyName,
        contactName: lead.contactName,
        buyerType: lead.buyerType,
      } : undefined,
      whatsappSettings: {
        enabled: settings.enabled,
        mode: settings.mode,
        defaultLanguage: settings.defaultLanguage,
        unknownAnswerBehavior: settings.unknownAnswerBehavior,
        abusiveMessageBehavior: settings.abusiveMessageBehavior,
        priceQuestionBehavior: settings.priceQuestionBehavior,
      },
      availableMedia: availableMedia.slice(0, 12).map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        caption: item.caption,
        fileType: item.fileType,
      })),
    }, { workspaceId: input.workspaceId });
    const parsed = WhatsAppLLMReplyOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      // 2026-08-05 ROOT-FIX: don't throw away a good reply just because a
      // non-essential field (classification enum, leadStatusSuggestion) failed
      // validation. If the model gave us a usable suggestedReply, use it with
      // safe defaults for the rest. Real models return slightly-off enums;
      // the reply text is what matters.
      const raw = result.output as Record<string, unknown> | undefined;
      if (raw && typeof raw.suggestedReply === "string" && raw.suggestedReply.trim().length > 5) {
        const validClassifications = ["greeting","catalogue_request","price_request","sample_request","moq_request","delivery_question","payment_question","return_question","customization_question","export_question","complaint","abusive_message","unsubscribe","not_interested","hot_lead","unknown_question","other"] as const;
        const recovered: WhatsAppLLMReplyOutput = {
          classification: (typeof raw.classification === "string" && (validClassifications as readonly string[]).includes(raw.classification) ? raw.classification : "other") as WhatsAppLLMReplyOutput["classification"],
          riskLevel: (raw.riskLevel === "high" || raw.riskLevel === "medium" || raw.riskLevel === "low") ? raw.riskLevel : "medium",
          suggestedReply: raw.suggestedReply,
          confidenceScore: typeof raw.confidenceScore === "number" ? Math.min(1, Math.max(0, raw.confidenceScore)) : 0.6,
          needsHumanReview: typeof raw.needsHumanReview === "boolean" ? raw.needsHumanReview : true,
          canAutoSend: typeof raw.canAutoSend === "boolean" ? raw.canAutoSend : false,
          missingKnowledge: typeof raw.missingKnowledge === "boolean" ? raw.missingKnowledge : true,
          missingQuestion: typeof raw.missingQuestion === "string" ? raw.missingQuestion : "",
          // 2026-09-10: carry the model's chosen file through the recovery path
          // too. This branch exists because a model got one enum wrong; losing
          // its attachment as collateral would silently demote a reasoned pick
          // to the keyword rule, and nothing downstream could tell.
          mediaAttachmentId: typeof raw.mediaAttachmentId === "string" && raw.mediaAttachmentId.trim() ? raw.mediaAttachmentId.trim() : undefined,
          leadStatusSuggestion: "needs_review",
          reason: typeof raw.reason === "string" ? raw.reason : "(recovered from schema failure)",
        };
        return { output: recovered, provider: result.provider || "unknown", modelName: result.modelName, mode: result.mode || "unknown", fallbackUsed: Boolean(result.fallbackUsed), validationStatus: "valid" as const, warning: result.warning };
      }

      return {
        output: undefined,
        provider: result.provider || "unknown",
        modelName: result.modelName,
        mode: result.mode || "unknown",
        fallbackUsed: Boolean(result.fallbackUsed),
        validationStatus: "invalid" as const,
        warning: "LLM returned a reply that did not match the WhatsApp reply schema.",
      };
    }
    return {
      output: parsed.data,
      provider: result.provider || "unknown",
      modelName: result.modelName,
      mode: result.mode || "unknown",
      fallbackUsed: Boolean(result.fallbackUsed),
      validationStatus: "valid" as const,
      warning: result.warning,
    };
  } catch (error) {
    // 2026-08-05 (build-right Phase 4 — no silent failures): a failing LLM
    // draft MUST be visible. The engine silently fell back to the keyword
    // classifier's generic reply, making every reply look identical with no
    // signal the AI was broken. Log loudly so the operator sees it.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[WhatsAppEngine] LLM draft FAILED for lead ${lead?.id || input.phone}: ${reason.slice(0, 200)}. Falling back to keyword reply — the AI draft is NOT being used.`);
    return {
      output: undefined,
      provider: "unknown",
      modelName: "unknown",
      mode: "fallback" as const,
      fallbackUsed: true,
      validationStatus: "not_run" as const,
      warning: `LLM WhatsApp reply generation FAILED: ${reason}`,
    };
  }
}

async function maybeSendWhatsApp(input: { workspaceId: string; to: string; body: string; mode: string; canAutoSend: boolean; allowRealSend: boolean; mediaAttachment?: MediaCatalogItem; repos: RepositoryBundle }): Promise<WhatsAppSendResult> {
  const automaticMode = input.mode === "automatic" || input.mode === "safe_auto_reply";
  if (!automaticMode) return { attempted: false, status: "not_attempted", provider: "meta_cloud" };
  // D-2026-09-27-b: "not sent automatically" is not "blocked". Returning
  // "blocked" here made the log's status "blocked" for every reply that merely
  // needed the owner, in automatic mode — hiding it from the approval queue the
  // moment automatic replies were switched on. A real block (do-not-contact,
  // opt-out) is still decided by decideAutoReply and recorded as blocked.
  if (!input.canAutoSend) return { attempted: false, status: "not_attempted", provider: "meta_cloud", errorMessage: "Held for the owner — not an automatic reply." };
  // 2026-09-27 (review W6): a send that throws (the operator's WhatsApp
  // switch is off, credentials unreadable) must not lose the customer's
  // message — the draft is kept for the owner instead. Before, nothing was
  // saved and Meta's retry was then dropped as a duplicate.
  try {
    // CP-17c (2026-08-02) — per-workspace creds override env.
    const provider = await new (await import("@/services/WhatsAppCredentialService")).WhatsAppCredentialService(input.repos).resolveProvider(input.workspaceId);
    if (!provider.isConfigured()) return { attempted: false, status: "not_configured", provider: "meta_cloud", errorMessage: "WhatsApp Cloud API is not configured for this workspace." };
    return await provider.sendTextMessage({
      workspaceId: input.workspaceId,
      to: input.to,
      body: input.body,
      previewOnly: !input.allowRealSend,
      mediaAttachmentUrl: input.mediaAttachment?.url,
      mediaAttachmentMimeType: input.mediaAttachment?.fileType,
      mediaAttachmentFilename: input.mediaAttachment?.fileName,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { attempted: false, status: "not_attempted", provider: "meta_cloud", errorMessage: `Not sent automatically (${reason.slice(0, 160)}) — held for you.` };
  }
}

/**
 * Which file goes out with this reply.
 *
 * 2026-09-10 (session 55): the model's answer now WINS, including when its
 * answer is "none". The model is handed the media catalogue with ids and asked
 * to name the one file that answers what the customer asked for. If it names
 * one, that is the choice. If it deliberately returns an empty string -- "I am
 * not attaching anything here" -- that is a choice too, and the keyword rule
 * below must not quietly overrule it by attaching whatever catalogue it finds.
 *
 * The keyword rule survives for the case it was always for: a model that says
 * nothing at all about media (an older or weaker model that omits the field).
 * Then something sensible beats nothing.
 */
export function chooseMediaAttachment(rawText: string, category: string, mediaItems: MediaCatalogItem[], requestedId?: string, modelAnswered = false) {
  const activeItems = mediaItems.filter((item) => item.status === "active");
  if (requestedId) {
    const requested = activeItems.find((item) => item.id === requestedId);
    if (requested) return requested;
  }
  // The model answered, naming either nothing or a file this workspace does not
  // have. Attaching something else would put words in its mouth; the caller
  // records which of the two happened.
  if (modelAnswered) return undefined;
  const text = rawText.toLowerCase();
  const asksForMedia = category === "catalogue_request" || /(catalog|catalogue|brochure|photo|picture|image|certificate|pdf|policy)/i.test(text);
  if (!asksForMedia) return undefined;
  if (/(policy|terms|agreement)/i.test(text)) return activeItems.find((item) => item.category === "policy_document");
  if (/(certificate|iso|compliance)/i.test(text)) return activeItems.find((item) => item.category === "certificate") || activeItems.find((item) => item.category === "catalog");
  return activeItems.find((item) => item.category === "catalog")
    || activeItems.find((item) => item.category === "product_image")
    || activeItems.find((item) => item.category === "certificate")
    || activeItems[0];
}

async function resolveLead(input: WhatsAppConversationInput, repos: RepositoryBundle): Promise<Lead | undefined> {
  if (input.leadId) return repos.lead.getLeadById(input.workspaceId, input.leadId);
  if (!input.phone) return undefined;
  const leads = await repos.lead.listLeads(input.workspaceId);
  return leads.find((item) => item.whatsappNumber && normalizePhone(item.whatsappNumber) === normalizePhone(input.phone || ""));
}

async function getOrCreateWhatsAppSettings(workspaceId: string, repos: RepositoryBundle) {
  const existing = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
  if (existing) return existing;
  return repos.whatsAppAgentSettings.upsertForWorkspace(workspaceId, defaultWhatsAppAgentSettings(workspaceId));
}

/**
 * Every value LeadStatus admits, as a Record keyed by the union — so adding a
 * status to LeadStatus without adding it here is a compile error. The set
 * cannot quietly fall behind the type and start rejecting a status the rest of
 * the product uses.
 */
const LEAD_STATUS_KEYS: Record<LeadStatus, true> = {
  prospected: true, contacted_cold: true, talking: true, sample_phase: true,
  discovered: true, needs_review: true, approved: true, rejected: true, enriching: true, enriched: true,
  message_ready: true, contacted: true, replied: true, interested: true, not_interested: true,
  mql: true, sql: true, hot_lead: true, opportunity: true, won: true, closed_won: true, lost: true, closed_lost: true,
  do_not_contact: true, invalid: true, duplicate: true,
};
const VALID_LEAD_STATUSES = new Set<string>(Object.keys(LEAD_STATUS_KEYS));

/**
 * The one line an operator sees for this ticket in the inbox list.
 *
 * Session 55: this was `rawText.slice(0, 80)`, which cut mid-word — a live
 * complaint listed as "...is a different shade fro". The whole message is kept
 * in `description`, so nothing is lost either way; this is only about the
 * label being readable. Prefer the customer's first sentence, and when the
 * text must be cut, cut on a word boundary and say that it was cut.
 */
function ticketSubjectFrom(rawText: string): string {
  const collapsed = rawText.replace(/\s+/g, " ").trim();
  const firstSentence = collapsed.split(/(?<=[.!?])\s/)[0] || collapsed;
  const candidate = firstSentence.length >= 15 ? firstSentence : collapsed;
  if (candidate.length <= 80) return candidate;
  const cut = candidate.slice(0, 80);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/**
 * The line of retrieved knowledge, if any, that may be repeated to a customer.
 *
 * Session 55: the fallback used to take `contextText.split("\n")[0]` and state
 * it as fact. Retrieved chunks are stored as `Q: <question>\nA: <answer>`
 * (DocumentExtractionMappingService, DocumentQuestionAnsweringService), so the
 * first line is structurally always the QUESTION — a customer asking for a
 * price was told "Here's what I can tell you right away: Q: What industry or
 * category does the company belong to?." Unverified chunks are prefixed by
 * getRelevantContext with a marker saying "do not quote as fact to the
 * customer", and that marker was being quoted to the customer along with them.
 *
 * This path only runs when the model produced no reply, which is exactly when
 * nothing downstream is able to catch a bad sentence. So: answers only, never
 * questions, never unverified text, and nothing at all when in doubt — the
 * caller's "let me confirm with our team" line is always a safe answer.
 */
export function quotableAnswerLine(contextText: string): string | undefined {
  const firstChunk = contextText.split("\n\n").map((chunk) => chunk.trim()).find(Boolean);
  if (!firstChunk || firstChunk.startsWith(UNVERIFIED_CHUNK_MARKER)) return undefined;

  const lines = firstChunk.split("\n").map((line) => line.trim()).filter(Boolean);
  const answer = lines.find((line) => line.startsWith("A: "));
  const candidate = answer
    ? answer.slice(3).trim()
    // A chunk with no Q/A framing is prose, and its first line is content —
    // unless that line is itself a question.
    : (lines[0] || "").startsWith("Q: ") ? "" : (lines[0] || "");

  if (!candidate || candidate.endsWith("?")) return undefined;
  return candidate.replace(/\.+$/, "");
}

function buildFallbackSuggestedReply(category: string, contextText: string, warning?: string) {
  // CP-27 (2026-08-02): reworded fallbacks — positive framing instead of a
  // negative hedge. Same safety contract: never guess, defer to the team,
  // create Information Needed downstream.
  if (category === "unsubscribe") return "Understood — I've noted this and we won't contact you again. Thank you.";
  if (category === "abusive_message") return "I'm sorry this has been frustrating. I've asked our team to look into it right away and respond properly. Thank you for your patience.";
  if (category === "greeting") return "Hi! Thanks for reaching out. What can I help you with today?";
  if (category === "catalogue_request") return "Happy to share our catalogue! So I send the most useful pages, which product type or range are you interested in?";
  // 2026-09-28 (real-AI eval, docs/AI-QUALITY-EVAL-2026-09-28.md): this used
  // to open with "Here's what I can tell you right away: <first answer in the
  // top search result>". With the model down, 17 of 30 drafts did, and the line
  // was almost never the answer: a synced knowledge chunk holds many answers
  // and quotableAnswerLine takes the FIRST. "Where is your shop?" got "Saree
  // borders, lehenga and bridal wear…"; "Can you dispatch by Friday?" got the
  // company's own tone instruction ("Warm, short, businesslike…"); a discount
  // request got "Do not discount on the spot". Nothing downstream can check this
  // path, so it now quotes nothing. quotableAnswerLine stays (exported) for its
  // golden and for any caller that has ONE known-relevant answer.
  void contextText;
  void warning;
  return "Great question — let me confirm the exact details with our team and get right back to you.";
}

function nextStatus(suggestion: LeadStatus | undefined, current: LeadStatus | undefined): LeadStatus | undefined {
  // Session 55: do_not_contact was missing from protectedStatuses below, so it
  // was the one status any later suggestion could overwrite. Observed live — a
  // lead that sent "STOP. Do not message me again. Remove my number from your
  // list." was correctly set to do_not_contact, and one message later was
  // listed to the operator as hot_lead.
  //
  // The `doNotContact` flag survived, so automation stayed blocked and nothing
  // was sent. But the status is what the operator reads in the leads list, and
  // it was telling them to go and chase somebody who had just asked to be left
  // alone. An opt-out is a decision the customer made; withdrawing it is a
  // human action, never one inferred from the next message they send.
  if (current === "do_not_contact") return current;
  const protectedStatuses: LeadStatus[] = ["mql", "sql", "hot_lead", "opportunity", "won"];
  if (!suggestion) return current;
  if (current && protectedStatuses.includes(current) && !["do_not_contact", "hot_lead", "sql"].includes(suggestion)) return current;
  return suggestion;
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}
