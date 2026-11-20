import { buildAgentWorkspaceContextSummary } from "@/services/AgentContextBuilder";
import { LLMService } from "@/llm/LLMService";
import type { LLMTaskResult } from "@/llm/types";
import { generateMessage } from "@/lib/agents";
import type { BusinessProfile, Campaign, Lead, MessageTemplate } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";

type MessageGenerationOutput = {
  channel?: string;
  subject?: string;
  body?: string;
  tone?: string;
  language?: string;
  personalizationUsed?: Record<string, unknown>;
  missingInformation?: string[];
  humanReviewRequired?: boolean;
};

export type GeneratedMessageTemplate = MessageTemplate & {
  personalizationUsed: MessageTemplate["personalizationUsed"] & {
      generationMeta?: {
      agentName: string;
      provider: string;
      modelName?: string;
      mode: "real" | "mock" | "fallback";
      fallbackUsed: boolean;
      routeSource?: string;
      runId?: string;
      warning?: string;
      humanReviewRequired: boolean;
      reviewState: "pending_review" | "approved" | "used";
      safetyNote: string;
      missingInformation: string[];
      enrichment: {
        enrichmentStatus: Lead["enrichmentStatus"];
        resultStatus?: NonNullable<Lead["enrichmentResult"]>["status"];
        validationNote?: string;
      };
      context: {
        answerCount: number;
        chunkCount: number;
        conflictsPending: number;
      };
    };
  };
};

export async function createReviewedOutreachDraft(input: {
  workspaceId: string;
  lead: Lead;
  campaign: Campaign;
  profile: BusinessProfile;
  channel: string;
  repos?: RepositoryBundle;
}): Promise<GeneratedMessageTemplate> {
  const repos = input.repos || createRepositories();
  const contextStatus = await buildAgentWorkspaceContextSummary(input.workspaceId, repos);
  const deterministic = generateMessage(input.profile, input.campaign, input.lead, input.channel);
  const llmResult = await runMessageGenerationTask(input, deterministic, contextStatus, repos);
  // 2026-09-01 (N-DATA-23) — `normalized` carries `missingInformation`, which
  // is NOT a MessageTemplate column: its home is
  // `personalizationUsed.generationMeta.missingInformation`, which is where the
  // UI reads it from (src/app/page.tsx:3716). Spreading `...normalized`
  // straight into `create()` therefore sent a stray key to the repository, and
  // Prisma rejected the whole write:
  //
  //     Unknown argument `missingInformation` ... model("messageTemplate").create()
  //
  // Every "generate a message" for every lead returned 500 against Postgres —
  // the provider the product ships on. It survived unnoticed because the JSON
  // provider silently accepts unknown keys, so the entire e2e suite, which runs
  // on JSON, was green throughout.
  const { missingInformation: generatedMissingInformation, ...normalized } =
    normalizeMessageOutput(llmResult?.output, deterministic);
  const missingInformation = [
    !contextStatus.productsReady ? "reviewed Product Settings" : "",
    !contextStatus.communicationReady ? "reviewed WhatsApp or Communication Settings" : "",
    contextStatus.conflictsPending ? "open knowledge conflicts" : "",
    input.lead.enrichmentResult?.status === "ambiguous" ? "verified contact details for this lead" : "",
  ].filter(Boolean);
  const enrichmentSafetyNote = input.lead.enrichmentResult?.status === "ambiguous"
    ? "Contact details are not verified because enrichment found multiple possible companies. Keep the message general and confirm the recipient before sending."
    : "Draft only. A human must review before copying, approving, or marking outreach as sent.";

  return repos.messageTemplate.create({
    ...deterministic,
    ...normalized,
    status: "draft",
    personalizationUsed: {
      ...deterministic.personalizationUsed,
      ...(normalized.personalizationUsed || {}),
      generationMeta: {
        agentName: llmResult?.agentName || "message_generation",
        provider: llmResult?.provider || "deterministic",
        modelName: llmResult?.modelName || "rule-based",
        mode: llmResult?.mode || "mock",
        fallbackUsed: Boolean(llmResult?.fallbackUsed),
        routeSource: llmResult?.routeSource,
        runId: llmResult?.runId,
        warning: input.lead.enrichmentResult?.status === "ambiguous" ? "Lead enrichment is ambiguous; message was kept general." : llmResult?.warning,
        humanReviewRequired: true,
        reviewState: "pending_review",
        safetyNote: enrichmentSafetyNote,
        missingInformation: normalizeList(generatedMissingInformation, missingInformation),
        enrichment: {
          enrichmentStatus: input.lead.enrichmentStatus,
          resultStatus: input.lead.enrichmentResult?.status,
          validationNote: input.lead.enrichmentResult?.validationNote,
        },
        context: {
          answerCount: contextStatus.answerCount,
          chunkCount: contextStatus.chunkCount,
          conflictsPending: contextStatus.conflictsPending,
        },
      },
    },
  }) as Promise<GeneratedMessageTemplate>;
}

async function runMessageGenerationTask(
  input: {
    workspaceId: string;
    lead: Lead;
    campaign: Campaign;
    profile: BusinessProfile;
    channel: string;
  },
  deterministic: Omit<MessageTemplate, "id" | "createdAt" | "updatedAt">,
  contextStatus: Awaited<ReturnType<typeof buildAgentWorkspaceContextSummary>>,
  repos: RepositoryBundle,
): Promise<LLMTaskResult<MessageGenerationOutput> | undefined> {
  try {
    return await new LLMService(undefined, repos).runTask<MessageGenerationOutput>("message_generation", {
      channel: input.channel,
      lead: {
        companyName: input.lead.companyName,
        contactName: input.lead.contactName,
        buyerType: input.lead.buyerType,
        status: input.lead.status,
        reviewStatus: input.lead.reviewStatus,
        personalizationNote: input.lead.personalizationNote,
        doNotContact: input.lead.doNotContact,
        enrichmentStatus: input.lead.enrichmentStatus,
        enrichmentResult: input.lead.enrichmentResult,
      },
      campaign: {
        name: input.campaign.name,
        goal: input.campaign.goal,
        offer: input.campaign.offer,
        productFocus: input.campaign.productFocus,
        messageStrategy: input.campaign.plan?.messageStrategy,
      },
      business: {
        companyName: input.profile.companyName,
        tonePreference: input.profile.tonePreference,
        languagePreference: input.profile.languagePreference,
      },
      syncedContext: {
        answers: contextStatus.answerCount,
        chunks: contextStatus.chunkCount,
        conflictsPending: contextStatus.conflictsPending,
        previews: contextStatus.preview,
      },
      deterministicDraft: {
        channel: deterministic.channel,
        subject: deterministic.subject,
        body: deterministic.body,
        tone: deterministic.tone,
        language: deterministic.language,
        personalizationUsed: deterministic.personalizationUsed,
      },
      instructions: [
        "Return JSON with channel, subject, body, tone, language, personalizationUsed, missingInformation, and humanReviewRequired.",
        "Draft only; never send outreach.",
        input.lead.enrichmentResult?.status === "ambiguous"
          ? "WARNING: This lead's contact information has not been verified. Do not include specific company claims. Keep the message general."
          : "",
      ].filter(Boolean).join(" "),
    }, { workspaceId: input.workspaceId });
  } catch (error) {
    // M3.6 / O4 audit fix: previously this swallowed ALL errors silently and
    // returned undefined, which the caller rendered as "deterministic / mock
    // mode" with no warning. A real-model crash was invisible. Now we return
    // a fallback-shaped LLMTaskResult that carries an honest warning — the
    // caller (createReviewedOutreachDraft) already reads `llmResult?.warning`
    // and surfaces it on the draft. `output` stays undefined because no LLM
    // output was produced; the caller already falls back to `deterministic`
    // when `llmResult?.output` is missing.
    return {
      output: undefined as unknown as MessageGenerationOutput,
      provider: "unknown",
      modelTier: "balanced",
      modelName: "unknown",
      slotId: undefined,
      fallbackUsed: true,
      mode: "fallback",
      warning: `LLM message generation failed: ${error instanceof Error ? error.message : String(error)}. Falling back to deterministic draft.`,
      rawText: undefined,
      latencyMs: 0,
      credentialUsed: false,
      baseUrl: undefined,
      testPrompt: undefined,
      routeSource: undefined,
      runId: undefined,
      agentName: "message_generation",
    };
  }
}

function normalizeMessageOutput(
  output: MessageGenerationOutput | undefined,
  fallback: Omit<MessageTemplate, "id" | "createdAt" | "updatedAt">,
): Partial<MessageTemplate> & Pick<MessageGenerationOutput, "missingInformation"> {
  return {
    channel: cleanString(output?.channel) || fallback.channel,
    subject: cleanString(output?.subject) || fallback.subject,
    body: cleanString(output?.body) || fallback.body,
    tone: cleanString(output?.tone) || fallback.tone,
    language: cleanString(output?.language) || fallback.language,
    personalizationUsed: isRecord(output?.personalizationUsed) ? output.personalizationUsed : {},
    missingInformation: normalizeList(output?.missingInformation, []),
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
