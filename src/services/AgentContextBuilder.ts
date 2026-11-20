import { createRepositories } from "@/repositories";
import { safeNotFound } from "@/lib/safe-not-found";

export type AgentWorkspaceContext = {
  profileText: string;
  salesText: string;
  productsText: string;
  policyText: string;
  communicationText: string;
  knowledgeText: string;
  conflictsText: string;
};

export type AgentWorkspaceContextSummary = {
  profileReady: boolean;
  salesReady: boolean;
  productsReady: boolean;
  policyReady: boolean;
  communicationReady: boolean;
  syncedKnowledgeReady: boolean;
  answerCount: number;
  chunkCount: number;
  conflictsPending: number;
  lastSyncedAt?: string;
  preview: {
    sales: string;
    products: string;
    policy: string;
    communication: string;
    knowledge: string;
  };
};

function toTextList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => item === true ? key : `${key}: ${String(item)}`)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export async function buildAgentWorkspaceContext(workspaceId: string, repos = createRepositories()): Promise<AgentWorkspaceContext> {
  // Cluster 5 P1-2: was `.catch(() => undefined)` — silently gave the agent an
  // EMPTY business context whenever any settings repo threw, so the agent then
  // drafted replies with no business knowledge (hallucination risk). Now:
  // not-found (workspace not configured yet) → undefined is the truth. Real
  // error → bubbles up so the caller knows the context build failed.
  const [profile, sales, products, policy, communication, kbDocs, conflicts] = await Promise.all([
    safeNotFound(() => repos.businessProfile.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContext businessProfile" }),
    safeNotFound(() => repos.salesSettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContext salesSettings" }),
    safeNotFound(() => repos.productSettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContext productSettings" }),
    safeNotFound(() => repos.policySettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContext policySettings" }),
    safeNotFound(() => repos.communicationSettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContext communicationSettings" }),
    safeNotFound(() => repos.knowledgeBaseDocument.listByWorkspace(workspaceId), { fallback: [], context: "buildAgentWorkspaceContext knowledgeBaseDocument" }),
    safeNotFound(() => repos.settingsConflict.listByWorkspace(workspaceId, { status: "open" }), { fallback: [], context: "buildAgentWorkspaceContext settingsConflict" }),
  ]);

  const profileText = profile
    ? [
        `Company: ${profile.companyName || "Unknown"}`,
        `Industry: ${profile.industry || "Unknown"}`,
        `Type: ${profile.businessType || "Unknown"}`,
        `Description: ${profile.description || "Not provided"}`,
        `Products: ${(profile.products || []).join(", ") || "Not specified"}`,
        `Services: ${(profile.services || []).join(", ") || "Not specified"}`,
        `Target geographies: ${(profile.targetGeographies || []).join(", ") || "Not specified"}`,
        `Strengths: ${(profile.strengths || []).join(", ") || "Not specified"}`,
        `Limitations: ${(profile.limitations || []).join(", ") || "Not specified"}`,
      ].join("\n")
    : "No business profile available.";

  const salesText = sales
    ? [
        `Default MOQ: ${sales.defaultMOQ || "Not set"}`,
        `Credit period: ${sales.standardCreditPeriod || "Not set"}`,
        `Quotation validity: ${sales.quotationValidity || "Not set"}`,
        `Advance payment rule: ${sales.advancePaymentRule || "Not set"}`,
        `Sample availability: ${sales.sampleAvailability || "Not set"}`,
        `Bulk order rule: ${sales.bulkOrderRule || "Not set"}`,
        `Lead qualification: ${sales.leadQualificationThresholds || "Not set"}`,
        `Human review triggers: ${sales.humanReviewTriggers || "Not set"}`,
        `Price discussion: ${sales.priceDiscussionRule || "Not set"}`,
        `Discount rules: ${sales.discountNegotiationRules || "Not set"}`,
      ].join("\n")
    : "No sales settings available.";

  const productsText = products?.products?.length
    ? products.products.map((p) => {
        const parts: string[] = [p.name];
        if (p.category) parts.push(`Category: ${p.category}`);
        if (p.material) parts.push(`Material: ${p.material}`);
        if (p.packaging) parts.push(`Packaging: ${p.packaging}`);
        if (p.moq) parts.push(`MOQ: ${p.moq}`);
        if (p.inStockDispatchTime) parts.push(`In-stock dispatch: ${p.inStockDispatchTime}`);
        if (p.productionDispatchTime) parts.push(`Production dispatch: ${p.productionDispatchTime}`);
        if (p.customizationAvailable) parts.push("Customization: available");
        if (p.useCaseTags?.length) parts.push(`Use cases: ${p.useCaseTags.join(", ")}`);
        return parts.join(" / ");
      }).join("\n")
    : "No product catalog available.";

  const policyText = policy
    ? [
        `Payment: ${policy.paymentPolicy || "Not set"}`,
        `Credit: ${policy.creditPolicy || "Not set"}`,
        `Shipping/delivery: ${policy.shippingDeliveryPolicy || "Not set"}`,
        `Returns/replacement: ${policy.returnReplacementPolicy || "Not set"}`,
        `Cancellation: ${policy.cancellationPolicy || "Not set"}`,
        `Customization: ${policy.customizationPolicy || "Not set"}`,
        `Samples: ${policy.samplePolicy || "Not set"}`,
      ].join("\n")
    : "No policy settings available.";

  const communicationText = communication
    ? [
        `Tone: ${communication.tone || "Not set"}`,
        `Fallback reply: ${communication.defaultFallbackReply || "Not set"}`,
        `Auto-reply topics: ${toTextList(communication.allowedAutoReplyTopics).join(", ") || "Not set"}`,
        `Human-review topics: ${toTextList(communication.humanReviewRequiredTopics).join(", ") || "Not set"}`,
        `Price reply rule: ${communication.priceReplyRule || "Not set"}`,
        `Credit/payment reply: ${communication.creditPaymentReplyRule || "Not set"}`,
        `Complaint reply: ${communication.complaintReplyRule || "Not set"}`,
        `Abusive message rule (always hand to a person): ${communication.abusiveMessageRule || "Not set"}`,
        `Unknown-answer behavior: ${communication.unknownAnswerBehavior || "Not set"}`,
      ].join("\n")
    : "No communication settings available.";

  const knowledgeDoc = kbDocs.find((d) => d.documentType === "question_answers" && d.source === "knowledge_question_answers");
  const knowledgeText = knowledgeDoc?.contentText
    ? `Synced knowledge (${knowledgeDoc.metadata?.answerCount || 0} answers):\n${knowledgeDoc.contentText.slice(0, 4000)}`
    : "No synced knowledge base available.";

  const conflictsText = conflicts.length
    ? `Open conflicts (${conflicts.length}):\n${conflicts.map((c) => `- ${c.settingsArea}.${c.fieldKey}: current="${c.existingValue || ""}" vs extracted="${c.extractedValue || ""}"`).join("\n")}`
    : "No open conflicts.";

  return { profileText, salesText, productsText, policyText, communicationText, knowledgeText, conflictsText };
}

export async function buildAgentWorkspaceContextSummary(workspaceId: string, repos = createRepositories()): Promise<AgentWorkspaceContextSummary> {
  // Cluster 5 P1-2: same family as buildAgentWorkspaceContext — see comment there.
  const [profile, sales, products, policy, communication, kbDocs, kbChunks, conflicts] = await Promise.all([
    safeNotFound(() => repos.businessProfile.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContextSummary businessProfile" }),
    safeNotFound(() => repos.salesSettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContextSummary salesSettings" }),
    safeNotFound(() => repos.productSettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContextSummary productSettings" }),
    safeNotFound(() => repos.policySettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContextSummary policySettings" }),
    safeNotFound(() => repos.communicationSettings.getByWorkspace(workspaceId), { fallback: undefined, context: "buildAgentWorkspaceContextSummary communicationSettings" }),
    safeNotFound(() => repos.knowledgeBaseDocument.listByWorkspace(workspaceId), { fallback: [], context: "buildAgentWorkspaceContextSummary knowledgeBaseDocument" }),
    safeNotFound(() => repos.knowledgeBaseChunk.listByWorkspace(workspaceId), { fallback: [], context: "buildAgentWorkspaceContextSummary knowledgeBaseChunk" }),
    safeNotFound(() => repos.settingsConflict.listByWorkspace(workspaceId, { status: "open" }), { fallback: [], context: "buildAgentWorkspaceContextSummary settingsConflict" }),
  ]);
  const knowledgeDoc = kbDocs.find((d) => d.documentType === "question_answers" && d.source === "knowledge_question_answers");
  const context = await buildAgentWorkspaceContext(workspaceId, repos);
  return {
    profileReady: Boolean(profile),
    salesReady: Boolean(sales),
    productsReady: Boolean(products?.products?.length),
    policyReady: Boolean(policy),
    communicationReady: Boolean(communication),
    syncedKnowledgeReady: Boolean(knowledgeDoc?.contentText),
    answerCount: Number(knowledgeDoc?.metadata?.answerCount || 0),
    chunkCount: kbChunks.filter((chunk) => chunk.documentId === knowledgeDoc?.id).length,
    conflictsPending: conflicts.length,
    lastSyncedAt: String(knowledgeDoc?.metadata?.syncedAt || knowledgeDoc?.updatedAt || ""),
    preview: {
      sales: compactPreview(context.salesText),
      products: compactPreview(context.productsText),
      policy: compactPreview(context.policyText),
      communication: compactPreview(context.communicationText),
      knowledge: compactPreview(context.knowledgeText),
    },
  };
}

export function formatAgentContext(context: AgentWorkspaceContext) {
  return [
    "=== COMPANY PROFILE ===",
    context.profileText,
    "",
    "=== SALES RULES ===",
    context.salesText,
    "",
    "=== PRODUCTS ===",
    context.productsText,
    "",
    "=== POLICIES ===",
    context.policyText,
    "",
    "=== COMMUNICATION STYLE ===",
    context.communicationText,
    "",
    "=== SYNCED KNOWLEDGE ===",
    context.knowledgeText,
    "",
    "=== OPEN CONFLICTS ===",
    context.conflictsText,
  ].join("\n");
}

function compactPreview(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}
