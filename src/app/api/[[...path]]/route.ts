import { buildCampaignAnalytics, buildCampaignAnalyticsDetails, ANALYTICS_METRIC_KEYS, type AnalyticsMetricKey } from "@/services/CampaignAnalyticsService";
import { runProductApplicationResearch } from "@/services/ProductApplicationResearchService";
import { NeedsActionError } from "@/lib/user-errors";
import { extractPdfText } from "@/lib/pdf-text";
import { oneAtATime } from "@/lib/one-at-a-time";
import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { createManualLead } from "@/services/LeadImportService";
import { ManualOutreachProvider } from "@/lib/adapters";
import { classifyReply, extractBusinessFromPages, generateICPs, generateLearning, planCampaign, profileFromExtraction } from "@/lib/agents";
import { validateApiKeyOrWebhookSecret } from "@/lib/api-auth";
import { errorResponse, forbiddenResponse, jsonOne, notFoundResponse, successResponse, validationErrorResponse } from "@/lib/api-response";
import { getAuthMode, productionAuthConfigured } from "@/lib/auth";
import { AuthenticationError, AuthorizationError, bootstrapOwner, hasAnyCredentials, issueSessionForUser, loginWithPassword, requireRole, resolveCurrentUser, resolveUserFromSession, startTourSession } from "@/lib/auth-service";
import { publicSignup, PUBLIC_SIGNUP_MESSAGE, handProvisionWorkspace, verifyEmail, resendVerification as resendVerificationService } from "@/services/SignupService";
import { createInvite, revokeInvite, acceptInvite } from "@/services/InviteService";
// 2026-08-05 (audit F-8) — list pagination / bare-list ceiling chokepoint.
import { paginate, capBareList, paginationHeaders, BARE_LIST_CEILING } from "@/services/ListPagination";
import { isCsrfSafe } from "@/lib/csrf";
import { clearSessionCookie, setSessionCookie } from "@/lib/session";
import { parseBodySafely } from "@/lib/safe-body";
import { safeAudit } from "@/lib/safe-audit";
import { isContactBlocked } from "@/lib/dnc-registry";
import { readAndVerifyWebhookBody } from "@/lib/webhook-signature";
import { crawlWebsite } from "@/lib/crawler";
import { defaultWorkspaceId, timestamp, uid } from "@/lib/db";
import { canCreateOutreachActivity, getLeadStatusFromReplyClassification, shouldProtectQualifiedStatus } from "@/lib/lead-rules";
import { ADMIN_REQUIRED_PREFIXES, OWNER_ONLY_PREFIXES, requiredRoleForPath } from "@/lib/rbac-map";
import { stripRedactedValues, redactSecretsFromObject } from "@/lib/secret-redaction";
import type { AppData, AuditLog, AutoReplyLog, HumanFallbackTask, Lead, Order, OutreachActivity, Quote, Reply, Ticket, TicketEvent, UnknownQuestion, Workspace } from "@/lib/types";
import { clearWorkspaceCollectionsInSnapshot, RESET_PRESERVED_COLLECTIONS } from "@/lib/workspace-reset";
import { restoreWorkspaceAtomically } from "@/services/WorkspaceRestoreService";
import { createRepositories, getPersistenceProvider } from "@/repositories";
import type { RepositoryBundle } from "@/repositories";
import { emitEvent } from "@/events/EventDispatcher";
import type { AppEventType } from "@/events/EventTypes";
import { getProviderHealth } from "@/services/ProviderHealthService";
import { addUnknownQuestionToKnowledge, answerUnknownQuestion, answerUnknownQuestionGroup, catalogSummary, getAISettings, getAgentAutonomousSettings, getModelSlots, getWhatsAppSettings, updateAISettings, updateAgentAutonomousSettings, updateModelRouting, updateModelSlots, updateUnknownQuestion, updateWhatsAppSettings } from "@/services/AISettingsService";
import { createKnowledgeDocument, getKnowledgeDocument, listKnowledgeDocuments, chunkKnowledgeDocument, searchKnowledge, updateKnowledgeDocument, saveAgentInstruction, refreshBusinessProfileKnowledge } from "@/services/KnowledgeBaseService";
import { normalizeAgentName, pickCurrentAgentInstruction } from "@/lib/agent-instruction-selection";
import { AGENT_NAMES } from "@/constants/agents";
import { checkAgentInstruction } from "@/services/AgentInstructionConflictService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { approveLead, bulkReviewLeads, getLeadReviewSettings, recommendLeadReviewDecision, rejectLead, updateLeadReviewSettings } from "@/services/LeadReviewDecisionService";
import { applyDocumentExtraction, detectFaqs, mapDocumentExtraction, processManualAnswer } from "@/services/DocumentExtractionMappingService";
import type { DocumentExtractionMappingPreview } from "@/services/DocumentExtractionMappingService";
import { proposeSupersededChunks, restoreChunk, retireChunk } from "@/services/KnowledgeCorrectionService";
import { answerDocumentQuestions, approveAllSafeKnowledgeAnswers, approveKnowledgeQuestionAnswer, cancelActiveKnowledgeExtraction, getActiveKnowledgeExtractionStatus, getKnowledgeExtractionRun, listKnowledgeExtractionBatches, listKnowledgeQuestionAnswers, retryFailedKnowledgeExtractionBatches, syncMissingKnowledgeQuestions, updateKnowledgeQuestionAnswer, getWorkspaceChecklist, setWorkspaceChecklist } from "@/services/DocumentQuestionAnsweringService";
import { aiSettingsUpdateSchema, inboundLeadSchema, inboundReplySchema, leadCreateSchema, leadUpdateSchema, loginSchema, messageGenerationSchema, modelFetchSchema, outreachMarkSentSchema, ownerBootstrapSchema, platformAdminLoginSchema, platformTicketCreateSchema, platformTicketCommentSchema, platformTicketFlagSpamSchema, platformTicketOperatorUpdateSchema, platformTicketStatusSchema, platformUserBlockSchema, replyCreateSchema, sanitizeStrictShape, unknownQuestionAnswerSchema, unknownQuestionGroupAnswerSchema, whatsappLlmTestSchema, whatsappSettingsUpdateSchema, WhatsAppLLMReplyOutputSchema, adminSuspendWorkspaceSchema, adminFeatureFlagSchema, signupSchema, acceptInviteSchema, createInviteSchema, adminProvisionWorkspaceSchema, redeemPasswordResetSchema, forgotPasswordSchema, changePasswordSchema, teamRoleSchema,
  // 2026-08-05 (audit F-7): these 9 schemas existed in validation/schemas.ts
  // but were never imported anywhere, so they validated nothing. The demo
  // workspace's own business profile has websiteUrl "not-a-url" and
  // contactEmail "bad-email" TODAY — live proof the dead schema below would
  // have caught. Wiring them is a validation-only change: every field stays
  // optional/passthrough, so an already-valid request is unaffected.
  businessProfileUpdateSchema, campaignCreateSchema, modelSlotSchema,
  salesSettingsSaveSchema, productSettingsSaveSchema, policySettingsSaveSchema, communicationSettingsSaveSchema,
  leadReviewSettingsSaveSchema, agentAutonomousSettingsSaveSchema, knowledgeAnswerEditSchema, withoutNulls, GOVERNED_FIELDS } from "@/validation/schemas";
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";
import { describeChecklist } from "@/knowledge/knowledge-sheets";
import { PROVIDER_LABELS, type LLMProviderId } from "@/llm/provider-types";
import { listProviders, listStaticCatalog, fetchProviderModels, validateModelCapability } from "@/llm/ModelDiscoveryService";
import { isLLMProviderId } from "@/llm/provider-types";
import { findModel } from "@/llm/model-catalog";
import { LLMService } from "@/llm/LLMService";
import { checkRateLimit, listRateLimitSnapshot } from "@/services/RateLimitService";
import { extractCompanyKnowledgeFromSourceBundle } from "@/services/KnowledgeSourceBundleService";
import { buildKnowledgeQuestionnairePdf } from "@/services/KnowledgeQuestionnairePdfService";
import { deleteMediaCatalogItem, listMediaCatalogItems, readMediaCatalogFile, saveMediaCatalogItem } from "@/services/MediaCatalogService";
import { generatePolicyPdfForLead } from "@/services/PolicyPdfService";
import { generateQuotePdf } from "@/services/QuotePdfService";
import { buildGuidedKnowledgeBlocks, getEssentialQuestionGroups, getQuestionPresentationSummary, groupEssentialSetupQuestions, groupMissingBusinessDetails, isEssentialSetupQuestion } from "@/services/KnowledgeQuestionPresentationService";
import { syncStructuredSettingsToQuestions } from "@/services/StructuredSettingsQuestionMappingService";
import { upsertKnowledgeEntry } from "@/services/KnowledgeSyncService";
import { syncWorkspaceKnowledge } from "@/services/SyncKnowledgeService";
import { getSalesSettings, updateSalesSettings, getProductSettings, updateProductSettings, getPolicySettings, updatePolicySettings, getCommunicationSettings, updateCommunicationSettings } from "@/services/SettingsService";
import { routeExtractedFactsToSettings, resolveSettingsConflict } from "@/services/ExtractionRoutingService";
import { draftProductSettingsFromNotes } from "@/services/ProductSettingsDraftService";
import { draftStructuredSettingsFromAnswer } from "@/services/StructuredSettingsDraftService";
import { discardPendingSettingsDraft, listPendingSettingsDrafts, markPendingSettingsDraftSaved, savePendingSettingsDraft } from "@/services/PendingSettingsDraftService";
import { buildAgentWorkspaceContextSummary } from "@/services/AgentContextBuilder";
import { createLeadAgentActionPlan } from "@/services/LeadAgentActionPlanService";
import { createReviewedOutreachDraft } from "@/services/MessageGenerationService";
import { ProspectingService, scoreLeadsAwaitingAi, scoringIcpFor } from "@/services/ProspectingService";
import { bulkEnrichApproved, enrichLead, type LeadEnrichmentCandidate } from "@/services/LeadEnrichmentService";
import { getDashboardIntelligence, getFollowupRadar, getLeadActivityTimeline, getOutreachQueue } from "@/services/OutreachQueueService";
import { approveAutoReplyLog, rejectAutoReplyLog } from "@/services/AutoReplyReviewService";
import { eraseCustomer } from "@/services/ErasureService";
import { processWhatsAppCloudWebhook, verifyWhatsAppWebhook } from "@/services/WhatsAppWebhookService";

export const runtime = "nodejs";

/**
 * R2 audit fix: resolve the workspace ID from the authenticated session in
 * production mode, falling back to the demo workspace in demo/local mode.
 *
 * Previously every GET handler used the constant `defaultWorkspaceId`, which
 * made the system blind to the caller's actual workspace. In single-workspace
 * demo mode that's harmless; the moment a second workspace exists (Stage 5),
 * any GET would silently read cross-tenant data. The one active hole today is
 * `GET /api/business-profile/:workspaceId` (line ~210), which trusted the URL
 * segment over the session — fixed below by ignoring the URL segment.
 *
 * This helper does NOT throw on auth failure (callers that need strict auth
 * already call `resolveCurrentUser` themselves). It returns the session
 * workspace when one exists, the demo workspace otherwise.
 */
/** 2026-09-28 — what "Forgot password?" always answers (known email or not). */
const FORGOT_PASSWORD_MESSAGE = "Request received. If an eligible account exists and account email is available, a password reset link will be emailed. Check your inbox and spam folder. A link works once and expires in 1 hour.";

async function resolveWorkspaceId(request: NextRequest): Promise<string> {
  if (getAuthMode() !== "production") return defaultWorkspaceId;
  try {
    const user = await resolveCurrentUser(request);
    return user?.workspaceId || defaultWorkspaceId;
  } catch {
    return defaultWorkspaceId;
  }
}

/**
 * Stage 5 / WP5 (2026-07-29) — Front-door (edge) rate limit.
 *
 * Per docs/LOGIC.md §WP5.4 + docs/DECISIONS.md D-2026-07-29-h: a SECOND layer
 * on top of the 27 per-endpoint presets. Caps TOTAL request volume per IP
 * (300/min) + per workspace (600/min) across ALL endpoints. Exempt paths
 * (health, deep health, whatsapp-webhook, admin auth status) bypass it.
 *
 * Returns a 429 response when the request is blocked; returns null when
 * allowed (the caller proceeds normally). Honors `Retry-After` so well-
 * behaved clients back off.
 *
 * Demo mode: the guard is still active (it uses the in-memory backend). It
 * keeps demo behavior honest — the guard is exercised in every mode, not
 * silently disabled.
 *
 * N-SEC-1 (2026-09-03) corrects a claim that used to sit here: "with
 * effectively no real traffic it never trips". It trips readily. One page load
 * costs 16 requests and opening Questions from AI costs 16 more, and on
 * localhost every browser shares the single "unknown" IP bucket because no
 * forwarding header is present — so an operator and any test tooling spend the
 * SAME 300/minute allowance. Assuming a guard is inert is how it went five
 * times too strict without anyone noticing. Pinned by
 * golden:wp5-edge-rate-limit.
 */
async function applyEdgeRateLimit(
  request: NextRequest,
  path: string[],
  workspaceId: string,
): Promise<NextResponse | null> {
  // Lazy import to keep the route's module-load surface stable (the
  // edge-rate-limit module imports the rate-limit dispatcher, which is
  // already imported at the top — but lazy keeps the dependency order
  // explicit + avoids any circular-load surprise).
  const { checkEdgeRateLimit, getClientIp, isEdgeExempt } = await import("@/lib/edge-rate-limit");
  if (isEdgeExempt(path)) return null;
  const ip = getClientIp(request);
  const result = await checkEdgeRateLimit({ ip, workspaceId: workspaceId === defaultWorkspaceId ? undefined : workspaceId });
  if (result.allowed) return null;
  // Compute Retry-After in seconds (ceil to be safe).
  const retryAfterSec = Math.max(1, Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000));
  // Construct directly with NextResponse so we can attach the Retry-After
  // header (the local `json` helper doesn't accept custom headers).
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "EDGE_RATE_LIMITED",
        message: `Too many requests. Blocked by ${result.blockedBy} rate limit. Try again in ${retryAfterSec}s.`,
        blockedBy: result.blockedBy,
        resetAt: result.resetAt,
      },
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfterSec),
      },
    },
  );
}

export async function GET(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  try {
    return await handleGet(request, context);
  } catch (error) {
    return errorToResponse(error);
  }
}

async function handleGet(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const path = (await context.params).path || [];
  const repos = createRepositories();
  // R2 audit fix: scope every GET to the caller's actual workspace (from the
  // session in production, demo workspace otherwise). Previously this was the
  // hardcoded `defaultWorkspaceId` constant, which made cross-workspace reads
  // trivially possible the moment a second workspace existed.
  const workspaceId = await resolveWorkspaceId(request);

  // Stage 5 / WP5 (2026-07-29) — front-door rate limit. Runs BEFORE any
  // routing so it covers every endpoint. Exempt paths (health, deep health,
  // whatsapp-webhook, admin auth status) bypass via isEdgeExempt.
  const edgeBlock = await applyEdgeRateLimit(request, path, workspaceId);
  if (edgeBlock) return edgeBlock;

  // ---- Auth status endpoints (Session 1) -----------------------------------
  // These are reachable WITHOUT a session so the login page can render.
  if (match(path, ["auth", "status"])) {
    const mode = getAuthMode();
    const bootstrapped = await hasAnyCredentials();
    // 2026-08-02 (UI polish) — in demo/local mode there is no signed session,
    // so the boot payload returned user:null. That left the shell unable to
    // tell who was logged in (the avatar + role chip always fell back to the
    // "demo" default). Now surface the demo owner so the UI can render the
    // correct role (owner) just like production does after a real login.
    // 2026-09-28 (S9): the same check as every other request — a suspended
    // company, a reset password or a removed member reads as signed out, and
    // the dead cookie is cleared.
    const cookie = request.cookies.get("lc_session")?.value;
    const sessionUser = mode === "production"
      ? await resolveUserFromSession(cookie)
      : { id: "user_owner", email: "owner@example.com", name: "Demo Owner", role: "owner", workspaceId: defaultWorkspaceId };
    const statusResponse = NextResponse.json({ authMode: mode, bootstrapped, authenticated: Boolean(sessionUser), user: sessionUser }, { headers: { "cache-control": "no-store" } });
    if (mode === "production" && cookie && !sessionUser) clearSessionCookie(statusResponse);
    return statusResponse;
  }
  if (match(path, ["auth", "me"])) {
    const mode = getAuthMode();
    if (mode !== "production") {
      return json({ user: { id: "user_owner", email: "owner@example.com", name: "Demo Owner", role: "owner", workspaceId: defaultWorkspaceId } });
    }
    // 2026-09-28 (S9): version, membership and suspension are all checked.
    const user = await resolveUserFromSession(request.cookies.get("lc_session")?.value);
    if (!user) {
      const denied = NextResponse.json({ success: false, error: { code: "UNAUTHENTICATED", message: "You are signed out. Please sign in again." } }, { status: 401 });
      clearSessionCookie(denied);
      return denied;
    }
    return json({ user });
  }
  // Stage 5 / WP1 (2026-07-28) — public email verification. The link in the
  // signup email points here with ?token=<rawToken>. Idempotent + re-issue-safe.
  if (match(path, ["auth", "verify-email"])) {
    const token = request.nextUrl.searchParams.get("token") || "";
    if (!token) return json({ ok: false, error: { code: "MISSING_TOKEN", message: "Token is required." } }, 400);
    try {
      const result = await verifyEmail(token);
      return json({ ok: true, verified: result.verified, verifiedAt: result.verifiedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification failed.";
      const status = /expired|no longer/i.test(message) ? 410 : 400;
      return json({ ok: false, error: { code: "VERIFY_FAILED", message } }, status);
    }
  }

  if (match(path, ["inbound", "whatsapp-webhook"])) {
    // The workspace's own verify token wins over the env var. A lookup failure
    // must not be read as "no token": fall through to the env var and let the
    // handshake fail closed rather than pass.
    let workspaceVerifyToken: string | undefined;
    try {
      const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
      workspaceVerifyToken = await new WhatsAppCredentialService(repos).getVerifyToken(defaultWorkspaceId);
    } catch {
      workspaceVerifyToken = undefined;
    }
    const verification = verifyWhatsAppWebhook(request.nextUrl.searchParams, workspaceVerifyToken);
    if (!verification.ok) return new NextResponse(verification.reason, { status: 403 });
    return new NextResponse(verification.challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // Phase 1.1: health is public (basic liveness check only — no sensitive data).
  if (match(path, ["health"])) {
    const authModeNow = process.env.AUTH_MODE || "demo";
    const persistenceNow = process.env.PERSISTENCE_PROVIDER || "json";
    // N-OBS-2 (2026-08-20): the pre-login "Demo safety boundaries" panel used to
    // hardcode five reassuring strings. Three of them were FALSE on this very
    // machine: it claimed JSON persistence while running on Postgres, and
    // "sample AI responses (demo)" while four of six model slots were making
    // real, billed DeepSeek calls on a live key. The third was true only by
    // accident — "no real sending" is hardcoded, so the day WhatsApp
    // credentials are supplied the panel keeps promising it while messages go
    // to customers. A safety panel that cannot be wrong is not a safety panel.
    //
    // The panel now reads these five facts. They are deliberately COARSE: a
    // count and a verdict, never provider names, never model names, never the
    // readiness map — that surface is `health/deep`, which is owner/admin-gated
    // in production for exactly that reason. And the block is omitted entirely
    // outside demo mode, so a production deployment publishes nothing new.
    let demoBoundaries: Record<string, string> | undefined;
    if (authModeNow !== "production") {
      let liveSlots = 0;
      let totalSlots = 0;
      /** Slots naming a real provider that has no key — these bill nobody and answer nobody. */
      let keylessSlots = 0;
      // HARD TIME BUDGET (S13-3). Measured, not theoretical: the first version of
      // this awaited getModelSlots() with no bound, and on the Postgres substrate
      // with the database unreachable the dev server logged
      // `GET /api/health 200 in 7.0min (application-code: 7.0min)`. `health` is a
      // LIVENESS endpoint — the container healthcheck and any load balancer call
      // it — so a slow answer is worse than no answer: it reports the whole
      // service as hung. The lookup gets 1.5s; if it does not come back the panel
      // says "could not be checked", which is the honest and the SAFE reading.
      let slotTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const slots = await Promise.race([
          getModelSlots(workspaceId, repos),
          new Promise<never>((_, reject) => {
            slotTimer = setTimeout(() => reject(new Error("health: model slot lookup exceeded its 1.5s budget")), 1500);
          }),
        ]);
        totalSlots = slots.length;
        // 2026-09-08 — this counted slots whose PROVIDER was not "mock", which
        // is not the same question as "will a real call happen". The demo
        // deployment had all four DeepSeek slots configured and no
        // PLATFORM_DEEPSEEK_API_KEY, so this panel said
        // "LIVE — 4 of 6 model slots call a real AI provider and are billed"
        // while every single call fell back to canned text and the AI Settings
        // screen said "No API key is set for this model. (deepseek) … 25 recent
        // AI calls have been affected". A label asserting a state nobody checked.
        //
        // A slot can only bill anyone if a key can be resolved for it, which is
        // exactly what LLMService.providerFor does: the slot's own stored
        // credential first, otherwise the platform key for that provider.
        // Ollama needs no key because it is a local runtime.
        const realProviderSlots = slots.filter((slot) => slot.provider && slot.provider !== "mock");
        liveSlots = realProviderSlots.filter((slot) => {
          if (slot.provider === "ollama") return true;
          if (typeof slot.credentialId === "string" && slot.credentialId.trim()) return true;
          return Boolean(slot.hasPlatformKey);
        }).length;
        keylessSlots = realProviderSlots.length - liveSlots;
      } catch {
        // Leave the counts at zero and say so below rather than guessing. A
        // failed OR SLOW lookup must never render as "safe".
        totalSlots = -1;
      } finally {
        if (slotTimer) clearTimeout(slotTimer);
      }
      // The env vars are only ONE of the two ways a real number gets attached.
      // The product's own Integrations screen says "Paste your WhatsApp
      // Business access token + phone number ID here", stores them per
      // workspace, and sends through them - and this panel never looked. Found
      // live: a Meta test number was connected through the UI, "Test
      // connection" answered "Connected. WhatsApp number +1 555-641-2188 is
      // reachable", and the pre-login safety panel still told every visitor
      // "Dry-run only - no message can leave this machine". That is the exact
      // failure the note below this block was written about.
      //
      // Unknown is not safe: a lookup that fails or hangs must say so, the way
      // the model-slot count above does, never render as "no message can
      // leave".
      let whatsappLive = Boolean(process.env.WHATSAPP_CLOUD_ACCESS_TOKEN && process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID);
      let whatsappChecked = true;
      if (!whatsappLive) {
        let waTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
          const view = await Promise.race([
            new WhatsAppCredentialService(repos).getView(defaultWorkspaceId),
            new Promise<never>((_, reject) => { waTimer = setTimeout(() => reject(new Error("timeout")), 1500); }),
          ]);
          whatsappLive = Boolean(view.hasCredentials && view.phoneNumberId);
        } catch {
          whatsappChecked = false;
        } finally {
          if (waTimer) clearTimeout(waTimer);
        }
      }
      const searchLive = Boolean(process.env.PLATFORM_SERPAPI_API_KEY || process.env.SERPAPI_API_KEY);
      demoBoundaries = {
        "Auth mode": "Demo only — no production login",
        Persistence: persistenceNow === "prisma"
          ? "PostgreSQL database (real, not a scratch file)"
          : "JSON file on this machine",
        WhatsApp: !whatsappChecked
          ? "Could not be checked — assume a real number may be attached"
          : whatsappLive
            ? "LIVE — approved messages are really sent to customers"
            : "Dry-run only — no message can leave this machine",
        LLM: totalSlots < 0
          ? "Could not be checked — assume real calls are possible"
          : liveSlots === 0 && keylessSlots > 0
            ? `NOT ANSWERING — ${keylessSlots} of ${totalSlots} model slots name a real provider with no API key, so replies fall back to canned text`
            : liveSlots === 0
              ? `Sample AI responses only — all ${totalSlots} model slots are mocked`
              : keylessSlots > 0
                ? `LIVE — ${liveSlots} of ${totalSlots} model slots call a real AI provider and are billed; ${keylessSlots} name a provider with no API key`
                : `LIVE — ${liveSlots} of ${totalSlots} model slots call a real AI provider and are billed`,
        Prospecting: searchLive
          ? "LIVE — real web searches are performed"
          : "Demo prospects — no external search is made",
      };
    }
    // 2026-09-08 — this endpoint reported `"status":"healthy"` for a full day
    // while the demo deployment could not reach its database at all. Every data
    // route was returning 500 (`prisma.workspace.findMany()` → ECONNREFUSED,
    // because DATABASE_URL was never set on that service) and the health check
    // said nothing, because it never asked the database anything. Its
    // "Persistence: PostgreSQL database (real, not a scratch file)" line was
    // reassuring the reader about a database that was not there.
    //
    // It now asks. Two deliberate constraints:
    //
    //   1. A HARD TIME BUDGET, for the same reason the model-slot lookup above
    //      has one: this is a LIVENESS endpoint and a slow answer reports the
    //      whole service as hung.
    //   2. It still returns HTTP 200 with ok:true. Render calls this as the
    //      service health check, and Neon's free tier SUSPENDS the compute when
    //      idle — the first query after a suspend is slow by design. Failing the
    //      check on that would restart a service whose only problem is that
    //      nobody has used it recently. So an unreachable database is reported
    //      as `status: "degraded"` with a `database` block, loudly and in the
    //      body, rather than by taking the service down.
    let database: { reachable: boolean; checkedIn?: number; error?: string };
    const dbStart = Date.now();
    let dbTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        repos.workspace.getById(workspaceId),
        new Promise<never>((_, reject) => {
          dbTimer = setTimeout(() => reject(new Error("the database did not answer within 2s")), 2000);
        }),
      ]);
      database = { reachable: true, checkedIn: Date.now() - dbStart };
    } catch (error) {
      database = {
        reachable: false,
        checkedIn: Date.now() - dbStart,
        // First line only, capped: a Prisma error message is a multi-line
        // essay and this field is read at a glance.
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
      };
    } finally {
      if (dbTimer) clearTimeout(dbTimer);
    }

    // The safety panel must not describe a database the server cannot reach.
    if (demoBoundaries && !database.reachable) {
      demoBoundaries.Persistence = persistenceNow === "prisma"
        ? "UNREACHABLE — this deployment cannot connect to its PostgreSQL database"
        : "UNREADABLE — this deployment cannot read its JSON data file";
    }

    return json({
      ok: true,
      status: database.reachable ? "healthy" : "degraded",
      persistenceProvider: persistenceNow,
      authMode: authModeNow,
      database,
      ...(demoBoundaries ? { demoBoundaries } : {}),
    });
  }
  // ---- The stored file itself (2026-09-10, session 55) ---------------------
  //
  // Deliberately ABOVE the production auth gate, because the two clients that
  // fetch this URL cannot carry a session:
  //   * Meta's servers. A WhatsApp media send passes a LINK, and Meta fetches
  //     it from this origin with no cookies. Behind the gate, every catalogue
  //     photo the AI attaches would fail to send.
  //   * an <img> tag in a page a customer opens.
  // What guards a file is the id: a repository-minted UUID, not a sequence, so
  // it cannot be walked. That is the same bargain every object store makes for
  // a public media URL. Nothing sensitive belongs in this catalogue -- it is
  // product photos, brochures and certificates the business sends to strangers
  // on purpose. An archived item stops resolving, because getById filters it.
  if (match(path, ["media", ":id", "file"])) {
    const stored = await readMediaCatalogFile(workspaceId, path[1], repos);
    if (!stored) return notFoundResponse("That file is no longer stored.");
    return new NextResponse(new Uint8Array(stored.bytes), {
      headers: {
        "Content-Type": stored.item.fileType || "application/octet-stream",
        "Content-Length": String(stored.bytes.length),
        // inline: Meta and a browser both want to render it, not download it.
        "Content-Disposition": `inline; filename="${stored.item.fileName.replace(/"/g, "")}"`,
        // The bytes at an id never change (a correction uploads a new item),
        // so let Meta and the browser keep it.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (getAuthMode() === "production" && !productionAuthConfigured()) return forbiddenResponse("Production authentication is not configured.");

  // Operator routes use their own signed session and role gate. Dispatch
  // before the company-session gate so an operator need not join a tenant
  // merely to view system health. Every admin GET keeps its admin role gate.
  if (path[0] === "admin") {
    return await handlePlatformAdminGet(request, path, repos);
  }

  // ---- Phase 1 audit fix (1.1): GET data endpoints require authentication ----
  // Previously every GET data route (leads, replies, knowledge, settings, PII,
  // dashboard state, ...) was reachable anonymously, even in production mode.
  // Only health/deep and data/export had inline gates. Now all GETs past this
  // point require an authenticated session in production. The four public GET
  // routes above (auth/status, auth/me, inbound/whatsapp-webhook verification,
  // health) and demo mode are intentionally unaffected. health/deep keeps its
  // own owner/admin role gate as defense-in-depth.
  if (getAuthMode() === "production") {
    try {
      await resolveCurrentUser(request);
    } catch (error) {
      const status = error instanceof AuthenticationError ? error.statusCode : 401;
      return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
    }
    // Phase 5.10: role-based GET redaction gate. Sensitive config endpoints
    // (ai/*, integrations, agent-autonomous/settings, health/deep, data/export)
    // expose credentials, provider keys, or full workspace snapshots. A
    // viewer/sales_member must NOT read them even when authenticated. Owner/
    // admin only. Non-sensitive CRM data endpoints (leads, replies, campaigns)
    // remain readable by any authenticated member.
    const minRole = requiredRoleForPath(path, "GET");
    const isSensitiveGet = OWNER_ONLY_PREFIXES.has(path[0])
      || ADMIN_REQUIRED_PREFIXES.has(path[0])
      || match(path, ["health", "deep"])
      || match(path, ["data", "export"]);
    if (isSensitiveGet) {
      try {
        await requireRole(request, minRole);
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
        }
        const status = error instanceof AuthenticationError ? error.statusCode : 401;
        return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
      }
    }
  }
  if (match(path, ["health", "deep"])) {
    // Session 5 audit fix: the deep health endpoint leaks the full production-
    // readiness map (which secrets are/aren't configured, provider inventory,
    // model slot config). That is reconnaissance gold for an attacker. Require
    // an authenticated owner/admin in production; demo/local stays open for
    // the dev workflow.
    if (getAuthMode() === "production") {
      try {
        const user = await resolveCurrentUser(request);
        if (user.role !== "owner" && user.role !== "admin") {
          return json({ success: false, error: { code: "FORBIDDEN", message: "Deep health requires owner or admin access." } }, 403);
        }
      } catch (error) {
        const status = error instanceof AuthenticationError ? error.statusCode : 401;
        return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
      }
    }
    const providers = listProviders();
    const slots = await getModelSlots(workspaceId, repos);
    // S-9 defense-in-depth (batch 3, 2026-07-27): the gate above (owner/admin
    // only in production) is correct — operators NEED this surface to debug
    // ops issues. But the rate-limit snapshot keys can contain userIds (not
    // secrets, but identifiers). Run the whole payload through the redaction
    // chokepoint as belt-and-suspenders: any field that ever leaks a secret-
    // shaped name (e.g. a future `authorization` log) gets masked here too.
    // The slot list deliberately exposes provider/model names (NOT keys) so
    // the operator can see which slots are wired; productionReadiness returns
    // only booleans (never the secret values themselves).
    const { redactSecretsFromObject } = await import("@/lib/secret-redaction");
    return json(redactSecretsFromObject({
      ok: true,
      status: "healthy",
      persistenceProvider: process.env.PERSISTENCE_PROVIDER || "json",
      authMode: process.env.AUTH_MODE || "demo",
      environment: process.env.NODE_ENV || "development",
      llm: { providers: providers.length, slots: slots.map((slot) => ({ slotId: slot.slotId, provider: slot.provider, modelName: slot.modelName, fallback: slot.fallbackProvider })) },
      rateLimits: listRateLimitSnapshot().slice(-10),
      productionReadiness: {
        authConfigured: productionAuthConfigured(),
        encryptionConfigured: Boolean(process.env.ENCRYPTION_KEY),
        webhookSecretConfigured: Boolean(process.env.INBOUND_WEBHOOK_SECRET || process.env.API_SHARED_SECRET),
        whatsappCloudConfigured: Boolean(process.env.WHATSAPP_CLOUD_ACCESS_TOKEN && process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID),
        whatsappWebhookVerifyTokenConfigured: Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
        persistenceProvider: process.env.PERSISTENCE_PROVIDER || "json",
      },
      prospecting: {
        serpApiConfigured: Boolean(process.env.PLATFORM_SERPAPI_API_KEY || process.env.SERPAPI_API_KEY),
        liveSearchProvider: "SerpApi Google Maps",
        fallbackMode: "LLM-assisted demo prospects",
      },
      warnings: ["JSON mode is the default demo runtime.", "Production auth, encryption, and PostgreSQL runtime still require final setup."],
    }));
  }
  if (match(path, ["knowledge", "questionnaire", "pdf"])) {
    const pdf = await buildKnowledgeQuestionnairePdf((await getWorkspaceChecklist(workspaceId, repos)).framework);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="leadcockpit-knowledge-base-questionnaire.pdf"',
        "cache-control": "no-store",
      },
    });
  }
  if (path.length === 0 || path[0] === "state") {
    const data = await repos.readAll?.();
    if (!data) return json({ error: "State snapshot is not available for this persistence provider" }, 500);
    // Cluster 1 fix (P0-1): scope the dashboard by the SESSION workspace,
    // not the defaultWorkspaceId constant.
    return json(dashboardState(data, workspaceId));
  }

  if (match(path, ["workspaces", ":id"])) {
    // Cluster B fix (2026-07-21 session 17): scope by session workspace.
    // The OLD code returned ANY workspace by URL id, allowing cross-tenant
    // reads (P0 finding A2). In demo mode workspaceId=default so this
    // passes through; in production we explicitly check the URL matches.
    if (path[1] !== workspaceId) {
      return json({ success: false, error: { code: "FORBIDDEN", message: "Workspace ID in URL does not match the authenticated workspace." } }, 403);
    }
    // Same class as the other single-entity GETs: the id matches the session,
    // but the row can still be absent -- a workspace deleted while a session is
    // alive, or a session carrying an id that no longer exists. That answered
    // `200 null`, which the page reads as "your workspace, and it is empty".
    return jsonOne(await repos.workspace.getById(path[1]), "Workspace");
  }
  // R2 audit fix: NEVER use path[1] as the workspaceId. The previous code read
  // the workspace from the URL segment, which let any authenticated user read
  // another workspace's business profile by typing its ID into the URL. The
  // path segment is informational only; scoping is session-derived.
  if (match(path, ["business-profile", ":workspaceId"]) || match(path, ["business-profile"])) {
    // The segment is still never used for scoping -- that was the R2 audit fix and
    // it stands. What changed: a segment naming a DIFFERENT workspace is now
    // refused rather than quietly ignored, matching ["workspaces", ":id"] above.
    // Ignoring it answered a question nobody asked ("here is YOUR profile") to a
    // caller who asked for somebody else's, and that silence hid a real bug: the
    // main page load passed a hardcoded "workspace_demo" for every customer.
    if (path[1] && path[1] !== workspaceId) {
      return forbiddenResponse("Workspace ID in URL does not match the authenticated workspace.");
    }
    return json(await repos.businessProfile.getByWorkspace(workspaceId));
  }
  if (match(path, ["crawl", ":jobId", "status"])) return jsonOne(await repos.websiteCrawlJob.getById(workspaceId, path[1]), "Crawl job");
  // A sub-resource under a parent this caller may not own. Without this guard the
  // scoped query simply finds nothing and the route answers 200 with an empty
  // list -- which reads as "this parent has no rows" when the truth is "this
  // parent is not yours". The caller cannot tell those apart, so say it plainly.
  if (match(path, ["crawl", ":jobId", "pages"])) {
    if (!(await repos.websiteCrawlJob.getById(workspaceId, path[1]))) return notFoundResponse("Crawl job not found");
    return json(await repos.websiteCrawlPage.listByCrawlJob(workspaceId, path[1]));
  }
  if (path[0] === "icp") return json(await repos.icp.listByWorkspace(workspaceId));
  // 2026-08-08 — closes coverage-map #46/#47 (creative + image-gen briefs).
  // MUST be above the `path[0]==="campaigns" && path[1]` catch-all below
  // (same reason as CP-22's conversation-summary note further down: that
  // catch-all isn't length-checked, so it would swallow this 3-segment
  // route first). Explicit dedicated endpoints, deliberately NOT reachable
  // from Owner Copilot chat text (image_generation/creative_generation stay
  // T4 — never fire from a casual chat line, see CreativeBriefService.ts).
  if (match(path, ["campaigns", ":id", "creative-brief"])) {
    const { generateCreativeBrief } = await import("@/services/CreativeBriefService");
    return json(await generateCreativeBrief(workspaceId, path[1], repos));
  }
  if (match(path, ["campaigns", ":id", "image-brief"])) {
    const { generateImageBrief } = await import("@/services/CreativeBriefService");
    return json(await generateImageBrief(workspaceId, path[1], repos));
  }
  if (path[0] === "campaigns" && path[1]) return jsonOne(await repos.campaign.getById(workspaceId, path[1]), "Campaign");
  if (path[0] === "campaigns") return json(await repos.campaign.listByWorkspace(workspaceId));
  // CP-22 (2026-08-02) — AI conversation summary. MUST be above the
  // `path[0]==="leads" && path[1]` catch-all (which returns the lead object
  // for ANY leads/:id* GET). This specific 3-segment route returns the summary.
  // N11/N12 — what this buyer has told us, against THIS lead's list.
  if (match(path, ["leads", ":id", "conversation-messages"])) {
    const { customerConversationHistory } = await import("@/services/CustomerConversationHistoryService");
    return json(await customerConversationHistory(workspaceId, path[1], repos));
  }
  if (match(path, ["leads", ":id", "discovery"])) {
    const { getLeadDiscovery } = await import("@/services/DiscoveryService");
    return json(await getLeadDiscovery(workspaceId, path[1], repos));
  }
  if (match(path, ["leads", ":id", "conversation-summary"])) {
    if (!(await repos.lead.getLeadById(workspaceId, path[1]))) return notFoundResponse("Lead not found");
    const { generateConversationSummary } = await import("@/services/ConversationSummaryService");
    return json(await generateConversationSummary(workspaceId, path[1], repos));
  }
  // 2026-08-08 — closes coverage-map #53 (re-engagement nudge). GET, same as
  // conversation-summary above: calls a real LLM but persists nothing, so it
  // doesn't need the mutating-route Zod gate (F-7).
  if (match(path, ["leads", ":id", "reengagement-nudge"])) {
    if (!(await repos.lead.getLeadById(workspaceId, path[1]))) return notFoundResponse("Lead not found");
    const { generateReEngagementNudge } = await import("@/services/ReEngagementService");
    return json(await generateReEngagementNudge(workspaceId, path[1], repos));
  }
  if (match(path, ["workspace", "quiet-leads"])) {
    const { findQuietLeads } = await import("@/services/ReEngagementService");
    return json(await findQuietLeads(workspaceId, repos));
  }
  // 2026-08-08 — closes coverage-map #57 (at-risk detection). Assesses every
  // candidate the deterministic pre-filter found; the filter itself is cheap
  // (in-memory scan) and candidate counts are small in practice (one per lead
  // with an unanswered complaint), so no artificial cap is needed here.
  if (match(path, ["workspace", "at-risk-leads"])) {
    const { findAtRiskCandidates, assessLeadRisk } = await import("@/services/AtRiskDetectionService");
    const candidates = await findAtRiskCandidates(workspaceId, repos);
    const assessed = await Promise.all(candidates.map(async (candidate) => ({
      leadId: candidate.lead.id,
      companyName: candidate.lead.companyName || candidate.lead.contactName || candidate.lead.id,
      triggerText: candidate.triggerReply.rawText,
      ...(await assessLeadRisk(workspaceId, candidate, repos)),
    })));
    return json(assessed);
  }
  // 2026-08-08 — closes coverage-map #56 (cross-customer morning digest).
  if (match(path, ["workspace", "cross-customer-digest"])) {
    const { buildCrossCustomerDigest } = await import("@/services/CrossCustomerDigestService");
    return json(await buildCrossCustomerDigest(workspaceId, repos));
  }
  // CP-25 — list WhatsApp message templates.
  if (match(path, ["whatsapp-templates"])) return json(await repos.whatsAppTemplate.listByWorkspace(workspaceId));
  // CP-24 — the 24h window status for a lead (drives the countdown badge).
  if (match(path, ["leads", ":id", "whatsapp-window"])) {
    const lead = await repos.lead.getLeadById(workspaceId, path[1]);
    if (!lead) return notFoundResponse("Lead not found");
    const { isWithin24hWindow } = await import("@/lib/whatsapp-window");
    return json(isWithin24hWindow(lead.lastInboundAt));
  }
  // 2026-09-28 — this must come BEFORE the catch-all below. It was registered
  // further down, so GET /leads/:id/follow-ups returned the LEAD, the
  // reminders panel called .map() on it, and opening any customer's record
  // crashed the whole Leads screen.
  if (match(path, ["leads", ":id", "follow-ups"])) {
    const { listRemindersForLead } = await import("@/services/FollowUpService");
    return json(await listRemindersForLead(workspaceId, path[1], repos));
  }
  if (path[0] === "leads" && path[1]) return jsonOne(await repos.lead.getLeadById(workspaceId, path[1]), "Lead");
  if (path[0] === "leads") {
    // P-3 fix (Session 7, 2026-07-28): OPT-IN pagination for the lead list.
    // The base listLeads stays uncapped for internal services that need all
    // leads (LeadReviewBatchService, ProspectingService dedup, etc.).
    //
    // BACKWARDS COMPATIBILITY: when no ?limit/?offset is passed, return a bare
    // Lead[] exactly as before (the dashboard UI at page.tsx:171 does
    // `api<Lead[]>("/api/leads")` and expects an array). When the caller
    // explicitly opts into pagination (?limit or ?offset), return the page
    // envelope {items,total,limit,offset,hasMore}. This bounds the payload for
    // any new paginated consumer WITHOUT breaking the existing UI or forcing a
    // giant ripple. Pinned by golden:list-pagination.
    const limitParam = request.nextUrl.searchParams.get("limit");
    const offsetParam = request.nextUrl.searchParams.get("offset");
    const campaignId = request.nextUrl.searchParams.get("campaignId") || undefined;
    if (limitParam === null && offsetParam === null) {
      // Default path: bare array (backwards-compatible). Still respects ?campaignId.
      //
      // 2026-08-05 (audit F-8): routed through jsonList so the CEILING applies
      // here too. The Session-7 P-3 fix added pagination but only on the
      // opt-in path — and the dashboard never opts in, so the one code path
      // that carries all the real traffic stayed uncapped. Behaviour is
      // identical for any workspace under BARE_LIST_CEILING; beyond it the
      // response is capped AND labelled (X-Truncated) rather than silently
      // shortened, because the dashboard computes counts from this array.
      return jsonList(request, await repos.lead.listLeads(workspaceId, campaignId ? { campaignId } : {}));
    }
    // Explicit pagination path: envelope (limit clamped to a hard ceiling).
    const { listLeadsPage } = await import("@/services/LeadListPagination");
    return json(await listLeadsPage(repos, workspaceId, {
      limit: limitParam ? Number(limitParam) : undefined,
      offset: offsetParam ? Number(offsetParam) : undefined,
      filters: campaignId ? { campaignId } : undefined,
    }));
  }
  if (match(path, ["outreach-queue"])) return json(await getOutreachQueue(workspaceId, repos));
  if (match(path, ["activity", "lead", ":leadId"])) return json(await getLeadActivityTimeline(workspaceId, path[2], repos));
  if (match(path, ["followup-radar"])) return json(await getFollowupRadar(workspaceId, repos));
  if (match(path, ["dashboard", "intelligence"])) return json(await getDashboardIntelligence(workspaceId, repos));
  // F-8: previously all three returned an uncapped array.
  if (path[0] === "messages") return jsonList(request, await repos.messageTemplate.listByWorkspace(workspaceId));
  // A sub-resource under a parent this caller may not own. Without this guard the
  // scoped query simply finds nothing and the route answers 200 with an empty
  // list -- which reads as "this parent has no rows" when the truth is "this
  // parent is not yours". The caller cannot tell those apart, so say it plainly.
  if (match(path, ["outreach", ":leadId"])) {
    if (!(await repos.lead.getLeadById(workspaceId, path[1]))) return notFoundResponse("Lead not found");
    return jsonList(request, await repos.outreachActivity.listByLead(workspaceId, path[1]));
  }
  if (path[0] === "replies") return jsonList(request, await repos.reply.listByWorkspace(workspaceId));
  if (match(path, ["media"])) {
    const category = request.nextUrl.searchParams.get("category") || undefined;
    const leadId = request.nextUrl.searchParams.get("leadId") || undefined;
    return json(await listMediaCatalogItems(workspaceId, repos, { category, leadId }));
  }
  // 2026-09-04 N-UX-17 — read back the learnings the learning loop writes.
  //
  // POST .../generate-learning has existed since the start and stores a
  // CampaignLearning row. Nothing ever read it back, so the Analytics screen
  // showed a button, ran a real agent, wrote a real row, and then displayed
  // nothing — the operator had no way to tell the difference between "it
  // worked" and "it did nothing". Same tenant discipline as the report route
  // below: refuse an unknown campaign BEFORE reading anything about it.
  if (match(path, ["analytics", "campaign", ":campaignId", "learnings"])) {
    const learningCampaign = await repos.campaign.getById(workspaceId, path[2]);
    if (!learningCampaign) return json({ success: false, error: { code: "CAMPAIGN_NOT_FOUND", message: "The selected campaign was not found in your workspace." } }, 404);
    const learnings = await repos.campaignLearning.getByCampaign(workspaceId, path[2]);
    return json(learnings);
  }
  if (match(path, ["analytics", "campaign", ":campaignId", "details"])) {
    const campaign = await repos.campaign.getById(workspaceId, path[2]);
    if (!campaign) return json({ success: false, error: { code: "CAMPAIGN_NOT_FOUND", message: "The selected campaign was not found in your workspace." } }, 404);
    const query = request.nextUrl.searchParams;
    const metric = query.get("metric") || undefined;
    const pageRaw = query.get("page") ?? "1", sizeRaw = query.get("pageSize") ?? "25";
    if ((metric !== undefined && !ANALYTICS_METRIC_KEYS.includes(metric as AnalyticsMetricKey)) || !/^[1-9]\d*$/.test(pageRaw) || !/^[1-9]\d*$/.test(sizeRaw) || Number(pageRaw) > 100000 || Number(sizeRaw) > 100) {
      return json({ success: false, error: { code: "INVALID_ANALYTICS_QUERY", message: "Choose a valid metric, page (1–100000) and page size (1–100)." } }, 400);
    }
    const data = await repos.readAll?.();
    if (!data) return json({ success: false, error: { code: "ANALYTICS_UNAVAILABLE", message: "Campaign results could not be read. Please try again." } }, 500);
    return json(buildCampaignAnalyticsDetails(data, path[2], workspaceId, { metric: metric as AnalyticsMetricKey | undefined, page: Number(pageRaw), pageSize: Number(sizeRaw) }));
  }
  if (match(path, ["analytics", "campaign", ":campaignId"])) {
    // Stage 2 (2026-08-25, CEO-loop session 19): refuse the campaign BEFORE
    // reading anything about it.
    //
    // The session-17 fix passed workspaceId down into campaignAnalytics and
    // scoped every counted collection. It missed one line — `bestIcp` looked
    // the campaign up by id across ALL tenants and returned that campaign's ICP
    // NAME. A tenant holding a neighbour's campaign id got the neighbour's ICP
    // name back, which scripts/probes/tenant-read-boundary.ts caught on a live
    // two-tenant run. Scoping that one line fixes today's leak; refusing the
    // whole request fixes the CLASS, because a field added to the report next
    // month cannot leak from a request that never got this far.
    const campaign = await repos.campaign.getById(workspaceId, path[2]);
    if (!campaign) return json({ success: false, error: { code: "CAMPAIGN_NOT_FOUND", message: "The selected campaign was not found in your workspace." } }, 404);
    const data = await repos.readAll?.();
    if (!data) return json({ error: "Analytics snapshot is not available for this persistence provider" }, 500);
    return json(campaignAnalytics(data, path[2], workspaceId));
  }
  // Stage 5 / WP1 (2026-07-28) — list invites + members for the team-management
  // UI. Returns pending invites (no token hashes) + active members.
  if (match(path, ["invites"])) {
    const invites = await repos.invite.listByWorkspace(workspaceId);
    // Strip tokenHash from the response (never leak hashes to the UI).
    const safe = invites.map(({ tokenHash: _omit, ...rest }) => rest);
    return json(safe);
  }
  if (match(path, ["workspace-members"])) {
    return json(await repos.workspaceMember.listByWorkspace(workspaceId));
  }
  if (path[0] === "integrations") {
    // Cluster 9 / P2-1: redact secrets before returning. The integration
    // records may hold API keys / tokens / passwords once real integrations
    // connect. Run them through the same secret-redaction chokepoint the
    // data/export endpoint uses (lib/secret-redaction.ts).
    const { redactSecretsFromObject } = await import("@/lib/secret-redaction");
    const raw = await repos.integration.listByWorkspace(workspaceId);
    return json(redactSecretsFromObject(raw));
  }
  if (match(path, ["data", "export"])) {
    // Session 5 audit fix: the export endpoint dumps the ENTIRE workspace
    // (leads, replies, knowledge, audit logs, agent runs). In production this
    // must be owner-only. Also apply the export rate limit.
    const exportLimit = await checkRateLimit({ workspaceId, action: "export" });
    if (!exportLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: exportLimit.reason, details: exportLimit } }, 429);
    if (getAuthMode() === "production") {
      try {
        const user = await resolveCurrentUser(request);
        if (user.role !== "owner") {
          return json({ success: false, error: { code: "FORBIDDEN", message: "Data export requires owner access." } }, 403);
        }
      } catch (error) {
        const status = error instanceof AuthenticationError ? error.statusCode : 401;
        return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
      }
    }
    const data = await repos.readAll?.();
    if (!data) return json({ error: "Workspace export is available only for repository snapshots in this runtime." }, 500);
    // Cluster 1 fix (P0-2): export ONLY this workspace's data. Previously
    // readAll() returned every workspace's records and the session id was
    // stamped on top — a direct cross-tenant data breach.
    return json(redactSecretsFromObject({
      exportedAt: timestamp(),
      mode: "demo_json_workspace_export",
      workspaceId,
      warning: "Demo export only. Restore is intentionally not implemented to avoid accidental overwrite.",
      data: scopeDataForExport(data, workspaceId),
    }));
  }
  // N10 — is meaning search actually working? Counts only; no model call.
  if (match(path, ["knowledge", "search-status"])) {
    const { getSearchStatus } = await import("@/rag/search-status");
    return json(await getSearchStatus(workspaceId, repos));
  }
  if (match(path, ["knowledge", "removed-source-facts"])) {
    const { listRetiredChunks } = await import("@/services/KnowledgeCorrectionService");
    return json(await listRetiredChunks(workspaceId, repos));
  }
  if (match(path, ["knowledge", "documents"])) {
    const documents = await listKnowledgeDocuments(workspaceId);
    const user = await resolveCurrentUser(request);
    return json(user.role === "owner" ? documents : documents.filter((document) => document.documentType !== "agent_instruction" && document.source !== "workspace_override"));
  }
  // N-AI-14 (2026-08-27): the Agent Instructions screen never loaded what the
  // owner had saved — the textarea started life holding a hardcoded default and
  // stayed that way. Since the save path is now an upsert (N-AI-12), pressing
  // Save on that unloaded box would OVERWRITE real instructions with the
  // placeholder. The screen has to read before it writes.
  //
  // A dedicated route, rather than letting the screen filter the document list
  // itself: the "which instruction counts" rule must exist in exactly one place,
  // because a save rule and a read rule that can drift apart is precisely how
  // N-AI-12 happened.
  if (match(path, ["knowledge", "agent-instructions", ":agentName"])) {
    await requireRole(request, "owner");
    const documents = await listKnowledgeDocuments(workspaceId);
    const current = pickCurrentAgentInstruction(documents, decodeURIComponent(path[2] || ""));
    const contentText = current?.contentText || "";
    const conflicts = contentText
      ? checkAgentInstruction(contentText, await listKnowledgeQuestionAnswers(workspaceId, repos))
      : checkAgentInstruction("");
    return json({ agentName: path[2], document: current || null, contentText, conflicts, applied: Boolean(contentText) && !conflicts.hasFindings });
  }
  if (match(path, ["knowledge", "question-framework"])) {
    // N13: the workspace's checklist, not the whole question pool.
    const checklist = await getWorkspaceChecklist(workspaceId, repos);
    const presentation = getQuestionPresentationSummary(checklist.questions);
    const essentialGroups = getEssentialQuestionGroups(checklist.questions);
    const essentialCount = essentialGroups.reduce((sum, group) => sum + group.questions.length, 0);
    const domains = checklist.framework.map((domain) => ({
      domainKey: domain.domainKey,
      domainTitle: domain.domainTitle,
      coreDomainKey: domain.questions[0]?.coreDomainKey,
      coreDomainTitle: domain.questions[0]?.coreDomainTitle,
      description: domain.description,
      questionCount: domain.questions.length,
      essentialCount: domain.questions.filter((question) => question.isEssential).length,
      highPriorityCount: domain.questions.filter((question) => question.priority === "high").length,
      requiredCount: domain.questions.filter((question) => question.required).length,
      humanReviewCount: domain.questions.filter((question) => question.humanReviewRequired).length,
      sampleQuestions: domain.questions.filter((question) => question.isEssential).slice(0, 3).map((question) => question.question),
    }));
    return json({
      totalQuestions: domains.reduce((sum, domain) => sum + domain.questionCount, 0),
      domainCount: domains.length,
      coreDomainCount: 12,
      essentialQuestionCount: essentialCount,
      highPriorityCount: domains.reduce((sum, domain) => sum + domain.highPriorityCount, 0),
      requiredCount: domains.reduce((sum, domain) => sum + domain.requiredCount, 0),
      humanReviewCount: domains.reduce((sum, domain) => sum + domain.humanReviewCount, 0),
      checklist: { kinds: checklist.choice.kinds, exports: checklist.choice.exports, source: checklist.choice.source, description: describeChecklist(checklist.choice) },
      frontendPresentation: {
        message: "Internal questions are preserved for extraction and agent mapping. Business users see the essential setup questions, guided sections, structured settings, and grouped information-needed cards.",
        categoryCounts: presentation.categoryCounts,
        essentialQuestionCount: essentialCount,
        coreDomainCount: essentialGroups.length,
      },
      domains,
    });
  }
  if (match(path, ["knowledge", "essential-questions"])) {
    const checklist = await getWorkspaceChecklist(workspaceId, repos);
    const groups = getEssentialQuestionGroups(checklist.questions);
    const essentialQuestionCount = groups.reduce((sum, group) => sum + group.questions.length, 0);
    return json({
      totalInternalQuestions: checklist.questions.length,
      visibleEssentialQuestions: essentialQuestionCount,
      coreDomainCount: 12,
      message: "Business owners only need to review these essential setup questions first. The deeper internal framework stays hidden for extraction, sync, and agent reasoning.",
      groups,
    });
  }
  if (match(path, ["knowledge", "guided-blocks"])) {
    const [answers, checklist] = await Promise.all([listKnowledgeQuestionAnswers(workspaceId, repos), getWorkspaceChecklist(workspaceId, repos)]);
    return json({ blocks: buildGuidedKnowledgeBlocks(answers.filter((answer) => answer.onChecklist), checklist.framework), totalInternalQuestions: checklist.questions.length });
  }
  if (match(path, ["knowledge", "question-answers"])) {
    return json(await listKnowledgeQuestionAnswers(workspaceId, repos));
  }
  if (match(path, ["extraction-runs", "active"])) {
    return json(await getActiveKnowledgeExtractionStatus(workspaceId, repos));
  }
  if (match(path, ["extraction-runs", ":id"])) {
    return jsonOne(await getKnowledgeExtractionRun(workspaceId, path[1], repos), "Extraction run");
  }
  if (match(path, ["extraction-runs", ":id", "batches"])) {
    if (!(await getKnowledgeExtractionRun(workspaceId, path[1], repos))) return notFoundResponse("Extraction run not found");
    return json(await listKnowledgeExtractionBatches(workspaceId, path[1], repos));
  }
  if (match(path, ["knowledge", "documents", ":id"])) {
    const document = await getKnowledgeDocument(workspaceId, path[2]);
    if (document?.documentType === "agent_instruction" || document?.source === "workspace_override") await requireRole(request, "owner");
    return jsonOne(document, "Document");
  }
  if (match(path, ["unknown-questions"])) {
    const items = await syncMissingKnowledgeQuestions(workspaceId, repos);
    // Q-7: essentiality is decided from the 424-question framework, which is a
    // server-side table. Deriving it here keeps that table out of the browser
    // bundle while still letting a screen say "8 essential questions left".
    return json(items.map((item) => ({ ...item, isEssential: isEssentialSetupQuestion(item) })));
  }
  if (match(path, ["unknown-questions", "groups"])) {
    const items = await syncMissingKnowledgeQuestions(workspaceId, repos);
    // Q-7: the "start here" stage rides on this same response rather than a
    // second endpoint. syncMissingKnowledgeQuestions() WRITES (see A-4 in
    // docs/SYSTEM-AUDIT.md), so a separate GET for the essential stage would
    // have doubled that write on every page view.
    return json({
      groups: groupMissingBusinessDetails(items),
      rawOpenCount: items.filter((item) => item.status === "open" && item.channel === "knowledge").length,
      essential: groupEssentialSetupQuestions(items),
    });
  }
  if (match(path, ["auto-reply-logs"])) {
    // F-8: the Replies inbox. The biggest list in the product (the audit found
    // a workspace holding 99 held replies) and previously uncapped.
    const status = request.nextUrl.searchParams.get("status") || undefined;
    return jsonList(request, await repos.autoReplyLog.listByWorkspace(workspaceId, status ? { status } : undefined));
  }
  if (match(path, ["auto-reply-logs", ":id"])) {
    return jsonOne(await repos.autoReplyLog.getById(workspaceId, path[1]), "Reply");
  }

  // === 2026-07-21 (M6) — Tickets API (Stage 2 UI plumbing) ===
  if (match(path, ["tickets"]) || match(path, ["tickets", "list"])) {
    return jsonList(request, await repos.ticket.listByWorkspace(workspaceId)); // F-8
  }
  // LITERAL SUB-RESOURCES MUST COME BEFORE ["tickets", ":id"]. The :id segment
  // is a wildcard (match() treats any ":xxx" as a catch-all), so a literal like
  // "sla-settings" would be swallowed by ":id" if it sat below it — the handler
  // would then look up a ticket with id === "sla-settings", get undefined, and
  // json(undefined) throws "Value is not JSON serializable" (HTTP 500). This was
  // a real P0 found by the full-ui-sweep on 2026-07-27 (every Workspace tab load
  // crashed the /api/tickets/sla-settings fetch). Pinned by golden:sla-settings-routing.
  // 2026-09-30 — the festival list (Google's public India holidays calendar)
  // and this company's holiday rules. Read-only.
  if (match(path, ["festivals"])) {
    const { getFestivalView } = await import("@/services/FestivalCalendarService");
    return json(await getFestivalView(workspaceId, repos));
  }
  if (match(path, ["tickets", "sla-settings"])) {
    const settings = await repos.ticketSlaSettings.getByWorkspace(workspaceId);
    // 2026-09-28: a company that never saved gets the defaults the clock
    // actually uses, so the screen can describe its reply deadlines.
    const { defaultTicketSlaSettings } = await import("@/lib/ticket-sla");
    return json(settings || defaultTicketSlaSettings(workspaceId));
  }
  if (match(path, ["tickets", ":id"])) {
    return jsonOne(await repos.ticket.getById(workspaceId, path[1]), "Ticket");
  }
  if (match(path, ["tickets", ":id", "closure-draft"])) {
    const { getTicketClosureDraft } = await import("@/services/TicketClosureService");
    return json(await getTicketClosureDraft(workspaceId, path[1], repos));
  }
  if (match(path, ["tickets", ":id", "events"])) {
    if (!(await repos.ticket.getById(workspaceId, path[1]))) return notFoundResponse("Ticket not found");
    return json(await repos.ticketEvent.listByTicket(workspaceId, path[1]));
  }

  // === 2026-07-21 (M7) — Orders + Quotes API (Stage 3 UI plumbing) ===
  if (match(path, ["orders"]) || match(path, ["orders", "list"])) {
    const status = request.nextUrl.searchParams.get("status") as "draft" | "confirmed" | "in_progress" | "partial_shipped" | "shipped" | "delivered" | "cancelled" | "partial_cancelled" | "returned" | undefined;
    return jsonList(request, await repos.order.listByWorkspace(workspaceId, status ? { status } : {})); // F-8
  }
  if (match(path, ["orders", ":id"])) {
    return jsonOne(await repos.order.getById(workspaceId, path[1]), "Order");
  }
  if (match(path, ["quotes"]) || match(path, ["quotes", "list"])) {
    const status = request.nextUrl.searchParams.get("status") as "draft" | "sent" | "accepted" | "rejected" | "expired" | "superseded" | "converted" | undefined;
    return jsonList(request, await repos.quote.listByWorkspace(workspaceId, status ? { status } : {})); // F-8
  }
  if (match(path, ["quotes", ":id"])) {
    return jsonOne(await repos.quote.getById(workspaceId, path[1]), "Quote");
  }

  // === Owner Copilot (2026-08-01) — owner-facing assistant chat (GET) =======
  // GET /copilot/conversations — get-or-create the owner's active conversation
  //   (one active chat per owner; the panel is global per operator Q1). If the
  //   owner has none yet, this CREATES one and returns it. Optional
  //   ?leadId=... sets the active lead for per-lead action isolation.
  // GET /copilot/conversations/:id/messages — the chat history (audit trail).
  // N8 — a master-agent job: its plan, status and report.
  // Command Center (2026-09-24) — the owner's recent master-AI jobs, and the
  // team the master can give work to, in the owner's words.
  if (match(path, ["copilot", "jobs"])) {
    const { listJobs } = await import("@/services/OrchestrationService");
    const { SUBORDINATES } = await import("@/agents/subordinates");
    return json({
      jobs: await listJobs(workspaceId, repos),
      team: SUBORDINATES.map((agent) => ({ name: agent.name, label: agent.label, summary: agent.summary })),
    });
  }
  // 2026-09-25 — how much of the business checklist is still missing, for the
  // assistant's "continue setting up" card.
  if (match(path, ["copilot", "setup-progress"])) {
    const { setupProgress } = await import("@/services/SetupInterviewService");
    const { describeChecklist } = await import("@/knowledge/knowledge-sheets");
    const [progress, checklist] = await Promise.all([setupProgress(workspaceId, repos), getWorkspaceChecklist(workspaceId, repos)]);
    return json({ missing: progress.missing, total: progress.total, checklist: { ...checklist.choice, description: describeChecklist(checklist.choice) } });
  }
  if (match(path, ["copilot", "jobs", ":id"])) {
    const { getJob } = await import("@/services/OrchestrationService");
    return json(await getJob(workspaceId, path[2], repos));
  }
  if (match(path, ["copilot", "conversations"]) || match(path, ["copilot", "conversations", ":id", "messages"])) {
    // Resolve the owner's userId from the session (demo falls back to a stable
    // owner id so the demo chat is consistent across reloads).
    let ownerUserId = "user_owner";
    try {
      const u = await resolveCurrentUser(request);
      if (u?.id) ownerUserId = u.id;
    } catch {
      /* unauthenticated — demo path; keep the fallback. */
    }
    if (match(path, ["copilot", "conversations"])) {
      const leadId = request.nextUrl.searchParams.get("leadId") || undefined;
      if (leadId && !(await repos.lead.getLeadById(workspaceId, leadId))) return notFoundResponse("Customer not found");
      const withCustomer = async (conversation: import("@/lib/types").OwnerCopilotConversation) => {
        const customer = conversation.activeLeadId ? await repos.lead.getLeadById(workspaceId, conversation.activeLeadId) : undefined;
        return { ...conversation, activeLeadName: customer?.companyName || customer?.contactName };
      };
      // 2026-09-25 — the full-page assistant keeps a list of conversations;
      // ?list=1 returns it, ?id= opens one of them.
      if (request.nextUrl.searchParams.get("list")) {
        const conversations = await repos.ownerCopilotConversation.listForOwner(workspaceId, ownerUserId, 30);
        const titled = await Promise.all(conversations.map(async (conversation) => {
          const messages = await repos.ownerCopilotMessage.listByConversation(workspaceId, conversation.id);
          const first = messages.find((message) => message.role === "owner");
          return { id: conversation.id, title: (first?.text || "New conversation").slice(0, 80), messageCount: messages.length, updatedAt: conversation.updatedAt };
        }));
        return json(titled);
      }
      const wanted = request.nextUrl.searchParams.get("id");
      if (wanted) {
        const found = await repos.ownerCopilotConversation.getById(workspaceId, wanted);
        if (!found || found.ownerUserId !== ownerUserId) return notFoundResponse("Conversation not found");
        return json(await withCustomer(found));
      }
      let convo = await repos.ownerCopilotConversation.getActiveForOwner(workspaceId, ownerUserId);
      if (!convo) {
        convo = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId, activeLeadId: leadId });
      } else if (leadId && convo.activeLeadId !== leadId) {
        // A different customer starts a different thread; previous history stays bound.
        convo = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId, activeLeadId: leadId });
      }
      return json(await withCustomer(convo));
    }
    // messages route: /copilot/conversations/:id/messages -> path = ["copilot","conversations",":id","messages"]
    // Same parent guard as the other sub-resource lists: the message query is
    // workspace-scoped, so a neighbour's conversation id yields [] -- "no
    // messages" where the truth is "not your conversation".
    //
    // N-AUTH-1 (fixed 2026-09-26, CEO: "fix the open items"): the guard is
    // owner-scoped, the same rule as opening (?id=) and writing into a
    // conversation. Before, anyone in the workspace could read the owner's
    // assistant history by its id.
    const parent = await repos.ownerCopilotConversation.getById(workspaceId, path[2]);
    if (!parent || parent.ownerUserId !== ownerUserId) {
      return notFoundResponse("Conversation not found");
    }
    const messages = await repos.ownerCopilotMessage.listByConversation(workspaceId, path[2]);
    return json(messages);
  }

  // === 2026-07-21 (M8) — Price-change preview (read-only, no sends) ===
  // Returns the list of customers who would be notified IF the owner
  // changed a product's price + the rendered messages. Two-step approval:
  // this endpoint just previews; a future endpoint will send after owner
  // approval. Per docs/LOGIC.md 6 guardrails.
  if (match(path, ["price-change", "preview"])) {
    const productId = request.nextUrl.searchParams.get("productId");
    const newPrice = Number(request.nextUrl.searchParams.get("newPrice") || 0);
    if (!productId) return validationErrorResponse("productId query param required");
    // Load product name + current price from settings.
    const ps = await repos.productSettings.getByWorkspace(workspaceId);
    const product = ps?.products.find((p) => p.id === productId);
    if (!product) return notFoundResponse("Product not found");
    const oldPrice = product.price ?? 0;
    // Load all open commitments.
    const [leads, quotes, orders] = await Promise.all([
      repos.lead.listLeads(workspaceId),
      repos.quote.listByWorkspace(workspaceId),
      repos.order.listByWorkspace(workspaceId),
    ]);
    // DNC leads (simplified — uses the lead.doNotContact flag).
    const dncLeadIds = new Set(leads.filter((l) => l.doNotContact || l.status === "do_not_contact").map((l) => l.id));
    const { previewPriceChangeNotifications } = await import("@/services/PriceChangeNotifyService");
    const preview = previewPriceChangeNotifications({
      workspaceId, productId, productName: product.name,
      oldPrice, newPrice,
      settings: { notifyCustomersOnPriceChange: true, templateId: "price_change_v1" },
      leads, quotes, orders, dncLeadIds,
    });
    return json(preview);
  }

  // === 2026-07-21 (M9) — Workspace settings: insights + kill-switch ===
  // Insights are stored in the auditLog-style flat collection. For demo
  // simplicity we keep them in an audit log namespace; a dedicated repo
  // can be added later if volume grows.
  if (match(path, ["workspace", "insights"])) {
    const all = await repos.auditLog.listByWorkspace(workspaceId);
    const insights = all.filter((e) => e.eventType === "insight_note").reverse();
    return json(insights);
  }
  if (match(path, ["workspace", "kill-switch"])) {
    const ws = await repos.workspace.getById(workspaceId);
    return json({ autonomyKillSwitch: Boolean(ws?.autonomyKillSwitch), autoSendToggle: Boolean(ws?.autoSendToggle) });
  }
  if (match(path, ["workspace", "digest", "latest"])) {
    // 2026-07-21 (R2) — return the most recent digest_sent audit entry.
    // Cluster 9 / P2-6: was `.find()` which returns the FIRST match in
    // insertion order (the OLDEST), not the latest. Now sort by createdAt
    // desc and take the first so we actually return the newest digest.
    const all = await repos.auditLog.listByWorkspace(workspaceId);
    const digests = all.filter((e) => e.eventType === "digest_sent");
    const latest = digests.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )[0];
    return json(latest || null);
  }

  // === 2026-07-21 (M10) — Consent list + Erasure plan (read-only) ===
  if (match(path, ["consent"])) {
    // Read all leads; expose consentStatus (currently stored on Lead) so
    // the consent screen can show what basis each prospect has.
    // Cluster 7: also expose the DNC flag so the Compliance screen can show
    // a "Remove from DNC" action for blocked prospects (the owner-only path
    // added in Cluster 2 / D-2026-07-26-2).
    const leads = await repos.lead.listLeads(workspaceId);
    return json(leads.map((l) => ({
      leadId: l.id,
      contactName: l.contactName || l.companyName || "(no name)",
      whatsappNumber: l.whatsappNumber,
      email: l.email,
      consentStatus: (l as { consentStatus?: string }).consentStatus || "none",
      doNotContact: Boolean(l.doNotContact) || l.status === "do_not_contact",
    })));
  }
  if (match(path, ["erasure", "preview"])) {
    const leadId = request.nextUrl.searchParams.get("leadId");
    if (!leadId) return validationErrorResponse("leadId query param required");
    const lead = await repos.lead.getLeadById(workspaceId, leadId);
    if (!lead) return notFoundResponse("Lead not found");
    // Count related records (read-only preview, no deletion yet).
    // Cluster 5 P1-2: replaced `.catch(() => [])` (which silently hid REAL
    // errors and made the preview lie "0 orders" when the repo threw) with
    // safeNotFound — only not-found (ENOENT/P2025) is swallowed; everything
    // else re-throws so the operator sees the truth before approving a delete.
    const { safeNotFound } = await import("@/lib/safe-not-found");
    const [replies, tickets, orders, quotes] = await Promise.all([
      safeNotFound(() => repos.reply.listByWorkspace(workspaceId), { fallback: [] as Reply[], context: "erasure/preview reply.listByWorkspace" }),
      safeNotFound(() => repos.ticket.listByWorkspace(workspaceId, { leadId }), { fallback: [] as Ticket[], context: "erasure/preview ticket.listByWorkspace" }),
      safeNotFound(() => repos.order.listByLead(workspaceId, leadId), { fallback: [], context: "erasure/preview order.listByLead" }),
      safeNotFound(() => repos.quote.listByLead(workspaceId, leadId), { fallback: [], context: "erasure/preview quote.listByLead" }),
    ]);
    const leadReplies = (replies as Reply[]).filter((r) => r.leadId === leadId);
    // 2026-07-27 (audit P1): mirror ErasureService.eraseCustomer's contract.
    // The service REFUSES to erase a lead with no contactName AND no companyName
    // (it needs a confirmable name for the two-step safety check). Previously
    // the preview returned `confirmName: ""` for such leads, so the UI's confirm
    // modal rendered blank and the operator could type anything and hit a 422.
    // Now the preview tells the truth up front: canErase=false + a reason, so
    // the UI can show "Add a name before erasing" instead of a broken modal.
    const confirmName = (lead.contactName || lead.companyName || "").trim() || null;
    return json({
      leadId,
      contactName: lead.contactName || lead.companyName,
      // null (not "") when nameless — JSON-safe and distinguishable from a real
      // empty-string name. The frontend treats null as "cannot confirm".
      confirmName,
      canErase: confirmName !== null,
      reason: confirmName === null
        ? "This lead has no contact name or company name on file. Add a name before erasing (erasure requires a two-step name confirmation)."
        : null,
      counts: {
        replies: leadReplies.length,
        tickets: tickets.length,
        orders: orders.length,
        quotes: quotes.length,
      },
    });
  }

  if (match(path, ["lead-review", "settings"])) {
    return json(await getLeadReviewSettings(workspaceId, repos));
  }
  // N12 — what this owner wants to learn about buyers. Proposed until saved.
  if (match(path, ["whatsapp-agent", "discovery-checklist"])) {
    const { getDiscoveryChecklist } = await import("@/services/DiscoveryService");
    return json(await getDiscoveryChecklist(workspaceId, repos));
  }
  // 2026-09-27 — reminders for later (docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md §2).
  // The per-customer list is served further up, before the catch-all
  // GET /leads/:id (see there).
  // 2026-09-28 — "What the system learned this week" (proposals only).
  if (match(path, ["learning", "this-week"])) {
    const { getLearnedThisWeek } = await import("@/services/OutcomeLearningService");
    return json(await getLearnedThisWeek(workspaceId, repos));
  }
  // 2026-09-28 — "Needs you" v2: ONE list and ONE count for the screen, the
  // header and the morning summary (src/services/NeedsYouService.ts). Held
  // replies are listed only for the owner, the only role that may send them.
  if (match(path, ["needs-you"])) {
    let includeHeldReplies = true;
    if (getAuthMode() === "production") {
      try { includeHeldReplies = (await resolveCurrentUser(request)).role === "owner"; } catch { includeHeldReplies = false; }
    }
    // Keeps the setup-question backlog current, as the old screen's fetch did.
    await syncMissingKnowledgeQuestions(workspaceId, repos).catch(() => undefined);
    const { buildNeedsYouList } = await import("@/services/NeedsYouService");
    const list = await buildNeedsYouList(workspaceId, repos, { includeHeldReplies });
    if (request.nextUrl.searchParams.get("countOnly") === "1") return json({ count: list.count, counts: list.counts });
    return json(list);
  }
  // 2026-09-28 — "Today's new buyers": AI-scored good, reachable, uncontacted
  // prospects found since yesterday (src/services/NewBuyersTodayService.ts).
  // Sales staff and up (a viewer does not work leads). Reads only.
  if (match(path, ["new-buyers", "today"])) {
    if (getAuthMode() === "production") {
      try {
        await requireRole(request, "sales_member");
      } catch (error) {
        if (error instanceof AuthorizationError) return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
        const status = error instanceof AuthenticationError ? error.statusCode : 401;
        return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
      }
    }
    const { listNewBuyersToday } = await import("@/services/NewBuyersTodayService");
    return json(await listNewBuyersToday(workspaceId, repos));
  }
  // 2026-09-28 — ACTIVITY LOG: "who did what" in plain sentences. Owner/admin
  // only: "activity" is in ADMIN_REQUIRED_PREFIXES, so the sensitive-GET gate
  // above refuses sales members and viewers in production. Company-scoped by
  // the session workspace. Rules: docs/LOGIC.md "2026-09-28 — ACTIVITY LOG".
  if (match(path, ["activity"])) {
    const { listActivity } = await import("@/services/ActivityLogService");
    const q = request.nextUrl.searchParams;
    const limit = Number(q.get("limit") || "50");
    return json(await listActivity(workspaceId, repos, {
      who: q.get("who") || undefined,
      kind: q.get("kind") || undefined,
      before: q.get("before") || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    }));
  }
  // 2026-09-28 — the owner's own WhatsApp summary + alerts (owner-only prefix).
  if (match(path, ["owner-alerts", "settings"])) {
    const { getOwnerNotifyView } = await import("@/services/OwnerNotifyService");
    return json(await getOwnerNotifyView(workspaceId, repos));
  }
  if (match(path, ["follow-ups", "due"])) {
    const { listDueReminders, listProposedReminders } = await import("@/services/FollowUpService");
    return json({ due: await listDueReminders(workspaceId, undefined, repos), proposed: await listProposedReminders(workspaceId, repos) });
  }
  // D-2026-09-27-b — the trial record per kind of question, for the
  // "Replies the AI may send by itself" list.
  if (match(path, ["whatsapp-agent", "auto-reply-trial"])) {
    const trial = await import("@/services/AutoReplyTrialService");
    return json({
      records: await trial.getTrialRecords(workspaceId, repos),
      minReviewed: trial.TRIAL_MIN_REVIEWED,
      minUnchangedShare: trial.TRIAL_MIN_UNCHANGED_SHARE,
      windowDays: trial.TRIAL_WINDOW_DAYS,
    });
  }
  if (match(path, ["whatsapp-agent", "settings"])) {
    const settings = await getWhatsAppSettings(workspaceId);
    return json({
      ...settings,
      configStatus: {
        accessToken: Boolean(process.env.WHATSAPP_CLOUD_ACCESS_TOKEN),
        phoneNumberId: Boolean(process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID),
        businessAccountId: Boolean(process.env.WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID),
        verifyToken: Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
        isConfigured: Boolean(process.env.WHATSAPP_CLOUD_ACCESS_TOKEN && process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID),
      }
    });
  }
  // D-2026-08-02 / CP-17: per-workspace WhatsApp Cloud credentials — GET (view).
  // 2026-08-02 audit fix: this route was misplaced inside the DELETE handler
  // (line ~2353), so GET /api/whatsapp-agent/credentials 404'd and the WhatsApp
  // Agent tab logged a console error on every load. Moved here into the GET
  // handler next to the other whatsapp-agent GET (settings).
  if (match(path, ["whatsapp-agent", "credentials"])) {
    const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
    return json(await new WhatsAppCredentialService(repos).getView(workspaceId));
  }
  // 2026-09-24 — saved AI keys, with the slots using each (keys never returned).
  if (match(path, ["ai", "credentials"])) {
    const { listAICredentials } = await import("@/services/AICredentialCleanupService");
    return json({ credentials: await listAICredentials(workspaceId, repos) });
  }
  if (match(path, ["ai", "settings"])) {
    return json(await getAISettings(workspaceId));
  }
  if (match(path, ["ai", "providers"])) {
    return json(listProviders());
  }
  if (match(path, ["ai", "model-catalog"])) {
    return json({ ...catalogSummary(), models: listStaticCatalog(typeof request.nextUrl.searchParams.get("provider") === "string" ? String(request.nextUrl.searchParams.get("provider")) : undefined) });
  }
  if (match(path, ["ai", "models"])) {
    const provider = request.nextUrl.searchParams.get("provider");
    return json({ provider: provider || "all", models: listStaticCatalog(provider || undefined) });
  }
  if (match(path, ["ai", "model-routing"])) {
    return json(await repos.llmModelRouting.listByWorkspace(workspaceId));
  }
  if (match(path, ["ai", "model-slots"])) {
    return json(await getModelSlots(workspaceId, repos));
  }
  // N-BUG (2026-09-08): the header chip reported which autonomy jobs were
  // switched ON, never whether the key behind them worked — so a workspace
  // whose provider balance hit zero read "AI running 6/6" on every screen while
  // every call fell back to canned replies. This is the honest answer.
  if (match(path, ["ai", "provider-health"])) {
    return json(await getProviderHealth(workspaceId, repos));
  }
  // 2026-09-09 — the workspace's own AI spend cap.
  //
  // ProviderHealthService blocks every model call when a cap is hit and tells
  // the operator to "Raise the token cap in AI Settings". There was no screen
  // showing a cap and no route to read or change one, so the instruction named
  // a control that did not exist. On the live demo the cap stopped all AI work
  // mid-simulation with no way forward but waiting for the daily reset.
  // The agent's recommendation had a write side and no read side: pressing
  // "Agent recommendation" on Lead Review spent a real model call, wrote a
  // leadReviewDecision row, audited it and emitted an event - and the screen
  // showed the operator nothing, because no route ever handed the decision
  // back. Found on the live demo with fifty-three leads waiting.
  if (match(path, ["lead-review-decisions"])) {
    return json(await repos.leadReviewDecision.listByWorkspace(workspaceId));
  }

  if (match(path, ["ai", "usage-limits"])) {
    const usage = await repos.aiUsageLimit.getByWorkspace(workspaceId);
    return json(usage || {
      workspaceId,
      currentDailyTokens: 0,
      currentMonthlyTokens: 0,
      currentDailyCost: 0,
      currentMonthlyCost: 0,
    });
  }
  if (match(path, ["agent-autonomous", "settings"])) {
    return json(await getAgentAutonomousSettings(workspaceId, repos));
  }
  if (match(path, ["agent-context", "summary"])) {
    return json(await buildAgentWorkspaceContextSummary(workspaceId, repos));
  }
  if (match(path, ["settings", "sales"])) {
    const data = await getSalesSettings(workspaceId, repos);
    return json(data || {});
  }
  if (match(path, ["settings", "products"])) {
    const data = await getProductSettings(workspaceId, repos);
    return json(data || { products: [] });
  }
  if (match(path, ["settings", "policy"])) {
    const data = await getPolicySettings(workspaceId, repos);
    return json(data || {});
  }
  if (match(path, ["settings", "communication"])) {
    const data = await getCommunicationSettings(workspaceId, repos);
    return json(data || {});
  }
  if (match(path, ["settings", "conflicts"])) {
    const status = request.nextUrl.searchParams.get("status") || undefined;
    const settingsArea = request.nextUrl.searchParams.get("settingsArea") || undefined;
    return json(await repos.settingsConflict.listByWorkspace(workspaceId, { status, settingsArea }));
  }
  if (match(path, ["settings", "pending-drafts"])) {
    return json(await listPendingSettingsDrafts(workspaceId, repos));
  }

  // === Stage 5 / WP3 (2026-07-28) — Platform tickets: USER-SIDE reads ===
  // A workspace owner/admin sees their own workspace's support tickets to the
  // SaaS operator. RBAC gate (admin+) is applied by enforceAuthGate via the
  // "platform-tickets" entry in rbac-map.ts. The route additionally re-checks
  // the resolved user's role (defense in depth — matches the service rule).
  if (match(path, ["platform-tickets"]) || match(path, ["platform-tickets", "list"])) {
    const user = await resolveCurrentUser(request);
    if (user.role !== "owner" && user.role !== "admin") {
      return json({ error: "Only owners and admins can view support tickets." }, 403);
    }
    const status = request.nextUrl.searchParams.get("status") as "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed" | "reopened" | undefined;
    const category = request.nextUrl.searchParams.get("category") as "bug" | "account" | "billing" | "how_to" | "data_request" | "other" | undefined;
    // Stage 5 re-audit F-P2-5 (2026-07-28): project to the user view so
    // operator-internal fields (assignedAdminId, isSpamFlagged, slaDueAt,
    // firstResponseAt) are NOT leaked to the workspace user.
    const { toUserView } = await import("@/services/PlatformTicketService");
    const tickets = await repos.platformTicket.listForUser(workspaceId, { status, category });
    return json(tickets.map(toUserView));
  }
  if (match(path, ["platform-tickets", ":id"])) {
    const user = await resolveCurrentUser(request);
    if (user.role !== "owner" && user.role !== "admin") return json({ error: "Forbidden" }, 403);
    const ticket = await repos.platformTicket.getForUser(workspaceId, path[1]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    // Stage 5 re-audit F-P2-5 (2026-07-28): project to the user view.
    const { toUserView } = await import("@/services/PlatformTicketService");
    return json(toUserView(ticket));
  }
  if (match(path, ["platform-tickets", ":id", "events"])) {
    const user = await resolveCurrentUser(request);
    if (user.role !== "owner" && user.role !== "admin") return json({ error: "Forbidden" }, 403);
    // Verify the ticket belongs to this workspace before returning its thread.
    const ticket = await repos.platformTicket.getForUser(workspaceId, path[1]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    // Stage 5 re-audit F-P2-5 (2026-07-28): project events to the user view
    // (strips actorAdminId — the operator's internal admin id).
    const { toUserEventView } = await import("@/services/PlatformTicketService");
    const events = await repos.platformTicketEvent.listByTicket(path[1]);
    return json(events.map(toUserEventView));
  }

  return json({ error: "Route not found", path }, 404);
}

/**
 * Stage 5 / WP3 (2026-07-28) — Platform-admin GET routes (/admin/*).
 * Gated by the platform-admin session (separate cookie + secret). The workspace
 * enforceAuthGate is intentionally bypassed for `/admin/*` — these routes are a
 * different audience (the operator), not workspace users.
 */
async function handlePlatformAdminGet(request: NextRequest, path: string[], repos: ReturnType<typeof createRepositories>) {
  const { requirePlatformAdmin } = await import("@/services/PlatformAdminAuthService");

  // /admin/auth/status — reachable WITHOUT an admin session so the login page
  // can render. Returns whether any admin exists + whether THIS request is auth'd.
  if (match(path, ["admin", "auth", "status"])) {
    const hasAdmin = await repos.platformAdmin.hasAnyAdmin();
    const admin = await (await import("@/services/PlatformAdminAuthService")).resolveCurrentPlatformAdmin(request);
    return json({ hasAdmin, authenticated: Boolean(admin), admin });
  }

  // Stage 5 re-audit F-P1-5: the GET-side RBAC is NOT a single flat "any
  // admin" gate. A support_agent may ONLY read its ticket inbox + self;
  // workspaces / users / audit-logs / feature-flags / health / impersonation
  // are operator-only. The rule lives in ONE chokepoint
  // (`requiredAdminRoleForGetPath`) so a future agent can't silently widen it.
  // Pinned by golden:platform-admin-get-rbac.
  const { requiredAdminRoleForGetPath } = await import("@/lib/platform-admin-rbac");
  const requiredRole = requiredAdminRoleForGetPath(path);
  const admin = await requirePlatformAdmin(request, requiredRole ?? "support_agent");

  if (match(path, ["admin", "platform-tickets"]) || match(path, ["admin", "platform-tickets", "list"])) {
    const filters: Record<string, unknown> = {};
    const sp = request.nextUrl.searchParams;
    if (sp.get("status")) filters.status = sp.get("status");
    if (sp.get("category")) filters.category = sp.get("category");
    if (sp.get("workspaceId")) filters.workspaceId = sp.get("workspaceId");
    if (sp.get("includeSpamFlagged") === "true") filters.includeSpamFlagged = true;
    return json(await repos.platformTicket.listForOperator(filters));
  }
  if (match(path, ["admin", "platform-tickets", ":id"])) {
    const ticket = await repos.platformTicket.getForOperator(path[2]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    return json(ticket);
  }
  if (match(path, ["admin", "platform-tickets", ":id", "events"])) {
    const ticket = await repos.platformTicket.getForOperator(path[2]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    return json(await repos.platformTicketEvent.listByTicket(path[2]));
  }
  if (match(path, ["admin", "platform-tickets", "sla-settings"])) {
    return json(await repos.platformTicketSlaSettings.get());
  }
  if (match(path, ["admin", "platform-tickets", "support-hours"])) {
    return json(await repos.platformSupportHours.get());
  }
  if (match(path, ["admin", "audit-logs"])) {
    const limit = Number(request.nextUrl.searchParams.get("limit") || 100);
    return json(await repos.platformAuditLog.list({ limit }));
  }

  // ─── Stage 5 / WP2 (2026-07-28) — operator admin ops GET routes ────
  // All operator-console reads. Workspace/user/flag/health surfaces.
  if (match(path, ["admin", "workspaces"]) || match(path, ["admin", "workspaces", "list"])) {
    const { listAllWorkspaces } = await import("@/services/PlatformAdminService");
    const includeSuspended = request.nextUrl.searchParams.get("includeSuspended") === "true";
    return json(await listAllWorkspaces({ includeSuspended }));
  }
  if (match(path, ["admin", "workspaces", ":id"])) {
    const ws = await repos.workspace.getById(path[2]);
    if (!ws) return json({ error: "Workspace not found" }, 404);
    const users = await repos.user.listForWorkspace(path[2]);
    return json({ workspace: ws, users });
  }
  if (match(path, ["admin", "workspaces", ":id", "users"])) {
    return json(await repos.user.listForWorkspace(path[2]));
  }
  if (match(path, ["admin", "feature-flags"])) {
    const { listAllFlags } = await import("@/services/FeatureFlagService");
    return json(await listAllFlags());
  }
  if (match(path, ["admin", "health"])) {
    // System health read: persistence provider, email provider, rate-limit
    // backend, admin count, suspended-workspace count. Honest status everywhere
    // (no fake "healthy"). Read-only; no side effects.
    const { getActiveEmailProvider } = await import("@/providers/email");
    const { getAccountEmailConfiguration } = await import("@/lib/account-email");
    const { getActiveBackendName } = await import("@/services/RateLimitService");
    const { getPersistenceProvider } = await import("@/repositories");
    const adminCount = (await repos.platformAdmin.listAll()).length;
    const allWorkspaces = await repos.workspace.listAll(true);
    const suspendedCount = allWorkspaces.filter((w) => w.status === "suspended").length;
    const { ready, senderConfigured, reason } = getAccountEmailConfiguration();
    return json({
      persistence: getPersistenceProvider(),
      emailProvider: getActiveEmailProvider(),
      accountEmail: { ready, senderConfigured, reason },
      rateLimitBackend: getActiveBackendName(),
      adminCount,
      workspaceCount: allWorkspaces.length,
      suspendedWorkspaceCount: suspendedCount,
      timestamp: new Date().toISOString(),
    });
  }
  if (match(path, ["admin", "system-health"])) {
    // Stage 5 / WP5 (2026-07-29) — the 5-card operability status page.
    // Operator-ONLY (per D-2026-07-29-f: support_agent is excluded — they
    // see tickets, not ops). Returns the probeSystemHealth() output for the
    // AdminHealth section to render as 5 cards + a banner.
    //
    // The route injects a real DB probe when persistence=prisma (a `SELECT 1`
    // timed by the wrapper's 2s race). For JSON demo it returns up:true
    // (no real DB to fail). The other 4 cards use the SystemHealthProbe
    // defaults, which read the live LLM slots + the edge-RL block counts.
    if (admin.role !== "operator") {
      return json({ success: false, error: { code: "FORBIDDEN", message: "System health requires operator access." } }, 403);
    }
    const { probeSystemHealth, setProductionProbes } = await import("@/services/SystemHealthProbe");
    // Inject a persistence-aware DB probe. The probe times out at 2s; if the
    // DB is unreachable the wrapper returns up:false + timedOut:true.
    if (getPersistenceProvider() === "prisma") {
      const { prisma } = await import("@/lib/prisma");
      setProductionProbes({
        dbProbe: async () => {
          const start = Date.now();
          // `$queryRaw` is the cheapest round-trip. Throws on connection
          // failure (caught by the wrapper's timeout/error race → up:false).
          await prisma.$queryRaw`SELECT 1`;
          return { up: true, latencyMs: Date.now() - start };
        },
        // Scheduler: read the most recent digest_sent audit log to determine
        // lastRunAt + status. Workspaces are scanned in turn; the first hit
        // wins. If none found anywhere → status="never".
        schedulerProbe: async () => {
          try {
            const workspaces = await repos.workspace.listAll(false);
            for (const ws of workspaces) {
              const logs = await repos.auditLog.listByWorkspace(ws.id);
              const digest = logs
                .filter((l) => l.eventType === "digest_sent")
                .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))[0];
              if (digest) {
                return { lastRunAt: digest.createdAt, status: "ok" as const };
              }
            }
            return { lastRunAt: null, status: "never" as const };
          } catch {
            return { lastRunAt: null, status: "error" as const };
          }
        },
        // LLM: read the live model slots.
        llmProbe: async () => {
          const slots = await getModelSlots("__global__", repos);
          return {
            slots: slots.map((s) => ({
              slotId: s.slotId,
              provider: s.provider,
              status: s.fallbackProvider ? "fallback" : (s.provider === "mock" ? "mock" : "real"),
            })),
          };
        },
      });
    }
    const probe = await probeSystemHealth();
    return json({ probe, timestamp: new Date().toISOString() });
  }
  if (match(path, ["admin", "impersonation", "active"])) {
    // Does THIS admin have an active impersonation session? Drives the
    // "Exit impersonation" button in the UI.
    const { getActiveImpersonation } = await import("@/services/PlatformAdminService");
    const session = await getActiveImpersonation(admin.id);
    return json({ active: session ? {
      targetUserId: session.targetUserId,
      targetWorkspaceId: session.targetWorkspaceId,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      reason: session.reason,
    } : null });
  }

  if (match(path, ["admin", "me"])) {
    return json({ admin });
  }
  void admin;
  return json({ error: "Admin route not found", path }, 404);
}

/**
 * Stage 5 / WP3 (2026-07-28) — Platform-admin POST routes (/admin/*, excluding
 * the public admin/auth/login + admin/auth/logout handled in handlePost).
 * Gated by the platform-admin session. Operator-only actions (flag spam, block
 * user, config) require the `operator` role; ticket replies/status are
 * support_agent+ (any admin). No-auto-outreach: none of these sends anything.
 */
async function handlePlatformAdminPost(request: NextRequest, path: string[], repos: ReturnType<typeof createRepositories>) {
  // Stage 5 re-audit F-P1-6: CSRF gate. The workspace-side `enforceAuthGate`
  // (which carries the CSRF check) is deliberately bypassed for `/admin/*`
  // because these routes use a DIFFERENT session cookie (platform-admin, not
  // workspace). But that bypass ALSO bypassed CSRF — so a malicious site
  // could forge a cross-site POST to /admin/users/block or
  // /admin/workspaces/:id/suspend. We re-apply the CSRF chokepoint HERE, before
  // any platform-admin action runs. Pinned by golden:platform-admin-csrf.
  if (!isCsrfSafe(request)) {
    return json({ success: false, error: { code: "CSRF_REJECTED", message: "Request blocked: cross-site form submission." } }, 403);
  }

  const { requirePlatformAdmin } = await import("@/services/PlatformAdminAuthService");
  const body = await safeBody(request);

  // /admin/platform-tickets/:id/comments — operator/support_agent reply.
  if (match(path, ["admin", "platform-tickets", ":id", "comments"])) {
    const admin = await requirePlatformAdmin(request, "support_agent");
    const ticket = await repos.platformTicket.getForOperator(path[2]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    const parsed = platformTicketCommentSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { addPlatformTicketComment } = await import("@/services/PlatformTicketService");
    const result = await addPlatformTicketComment({
      ticketId: path[2],
      actorType: "operator",
      actorAdminId: admin.id,
      note: parsed.data.note,
    });
    return json(result);
  }

  // /admin/platform-tickets/:id/status — operator status move.
  if (match(path, ["admin", "platform-tickets", ":id", "status"])) {
    const admin = await requirePlatformAdmin(request, "support_agent");
    const ticket = await repos.platformTicket.getForOperator(path[2]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    const parsed = platformTicketOperatorUpdateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    if (parsed.data.toStatus) {
      const { changePlatformTicketStatus } = await import("@/services/PlatformTicketService");
      await changePlatformTicketStatus({
        ticketId: path[2],
        toStatus: parsed.data.toStatus,
        actorType: "operator",
        actorAdminId: admin.id,
        note: parsed.data.note,
      });
    }
    if (parsed.data.assignedAdminId !== undefined) {
      const updated = await repos.platformTicket.updateForOperator(path[2], {
        assignedAdminId: parsed.data.assignedAdminId || undefined,
      });
      await repos.platformAuditLog.create({ adminId: admin.id, action: "ticket_assigned", metadata: { ticketId: path[2], assignedAdminId: parsed.data.assignedAdminId } });
      return json(updated);
    }
    return json(await repos.platformTicket.getForOperator(path[2]));
  }

  // /admin/platform-tickets/:id/flag-spam — operator-only.
  if (match(path, ["admin", "platform-tickets", ":id", "flag-spam"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const parsed = platformTicketFlagSpamSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { flagPlatformTicketAsSpam } = await import("@/services/PlatformTicketService");
    const updated = await flagPlatformTicketAsSpam({ ticketId: path[2], adminId: admin.id, reason: parsed.data.reason });
    return json(updated);
  }

  // /admin/users/block — operator-only: block/unblock a user from support.
  if (match(path, ["admin", "users", "block"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const parsed = platformUserBlockSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { blockPlatformUser } = await import("@/services/PlatformTicketService");
    await blockPlatformUser({
      userId: parsed.data.userId,
      workspaceId: parsed.data.workspaceId,
      adminId: admin.id,
      isBlockedFromSupport: parsed.data.isBlockedFromSupport,
      reason: parsed.data.reason,
    });
    return json({ ok: true });
  }

  // /admin/platform-tickets/sla-settings — operator-only: configure internal SLA.
  if (match(path, ["admin", "platform-tickets", "sla-settings"])) {
    await requirePlatformAdmin(request, "operator");
    const update: Record<string, unknown> = {};
    if (typeof body.urgentSlaMinutes === "number") update.urgentSlaMinutes = body.urgentSlaMinutes;
    if (typeof body.highSlaMinutes === "number") update.highSlaMinutes = body.highSlaMinutes;
    if (typeof body.mediumSlaMinutes === "number") update.mediumSlaMinutes = body.mediumSlaMinutes;
    if (typeof body.lowSlaMinutes === "number") update.lowSlaMinutes = body.lowSlaMinutes;
    if (typeof body.clockMode === "string") update.clockMode = body.clockMode;
    return json(await repos.platformTicketSlaSettings.update(update));
  }

  // /admin/platform-tickets/support-hours — operator-only: configure support hours.
  if (match(path, ["admin", "platform-tickets", "support-hours"])) {
    await requirePlatformAdmin(request, "operator");
    const update: Record<string, unknown> = {};
    if (typeof body.hoursStart === "string") update.hoursStart = body.hoursStart;
    if (typeof body.hoursEnd === "string") update.hoursEnd = body.hoursEnd;
    if (Array.isArray(body.businessDays)) update.businessDays = body.businessDays;
    return json(await repos.platformSupportHours.update(update));
  }

  // ─── Stage 5 / WP2 (2026-07-28) — operator admin ops POST routes ────
  // Suspend/resume/impersonate/reset-password/flag-toggle. All operator-only
  // (requirePlatformAdmin "operator"); the services re-assert the role as
  // defense-in-depth. No-auto-outreach: the only send is the password-reset
  // email (transactional, to a known user — the operator-confirmed exception).

  // /admin/workspaces/:id/suspend — operator kill-switch.
  if (match(path, ["admin", "workspaces", ":id", "suspend"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const parsed = adminSuspendWorkspaceSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { suspendWorkspace } = await import("@/services/PlatformAdminService");
    const updated = await suspendWorkspace({ adminId: admin.id, workspaceId: path[2], reason: parsed.data.reason });
    return json(updated);
  }

  // /admin/workspaces/:id/activate — operator resume (unsuspend).
  if (match(path, ["admin", "workspaces", ":id", "activate"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const { resumeWorkspace } = await import("@/services/PlatformAdminService");
    const updated = await resumeWorkspace({ adminId: admin.id, workspaceId: path[2] });
    return json(updated);
  }

  // Stage 5 / WP1 (2026-07-28) — /admin/workspaces/provision — operator
  // hand-provisions a pilot workspace + owner. No verification email (the
  // operator uses the WP2 password-reset flow to let the owner set a password).
  if (match(path, ["admin", "workspaces", "provision"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const parsed = adminProvisionWorkspaceSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    try {
      const result = await handProvisionWorkspace({
        adminId: admin.id,
        ownerEmail: parsed.data.ownerEmail,
        ownerName: parsed.data.ownerName,
        businessName: parsed.data.businessName,
      });
      return json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provisioning failed.";
      const errAny = error as { statusCode?: number };
      const status = errAny.statusCode || (/already/i.test(message) ? 409 : 400);
      return json({ ok: false, error: { code: "PROVISION_FAILED", message } }, status);
    }
  }

  // /admin/workspaces/:id/impersonate — start impersonation (operator-only).
  // Stage 5 re-audit fix (F-P1-4, 2026-07-28): the startImpersonation helper +
  // 5 hard limits are proven (golden:platform-admin-ops CASE E-J), but the
  // session-marker cookie wiring + in-SPA impersonation UX are NOT yet built
  // — the feature delivered zero impersonation capability. Per the audit's
  // option (b), this route returns 503 (honest "not available") until the
  // wiring lands. The UI button is also disabled. The operator audit log +
  // one-at-a-time + owner-blocked + TTL limits remain proven at the helper.
  if (match(path, ["admin", "workspaces", ":id", "impersonate"])) {
    await requirePlatformAdmin(request, "operator"); // still RBAC-gate (don't leak that it's disabled)
    return json({ ok: false, error: { code: "IMPERSONATION_NOT_AVAILABLE", message: "Impersonation is not yet available. The session-marker cookie wiring is a planned follow-up (F-P1-4)." } }, 503);
  }

  // /admin/impersonation/exit — end the active impersonation.
  if (match(path, ["admin", "impersonation", "exit"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) return json({ error: "Impersonation token is required." }, 400);
    const { exitImpersonation } = await import("@/services/PlatformAdminService");
    await exitImpersonation({ adminId: admin.id, token });
    return json({ ok: true });
  }

  // /admin/users/:id/reset-password — operator issues a one-time reset.
  // Generates the token, kills existing sessions, emails the link via the
  // provider. Rate-limited per target user (anti-spam). The token is NEVER
  // returned to the operator — it goes straight to the user's email.
  if (match(path, ["admin", "users", ":id", "reset-password"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const targetUserId = path[2];
    const targetWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!targetWorkspaceId) return json({ error: "workspaceId is required." }, 400);

    // Rate-limit: cap resets per target user per hour (anti-spam).
    const floodLimit = await checkRateLimit({
      workspaceId: targetWorkspaceId, userId: targetUserId, action: "password_reset_email",
    });
    if (!floodLimit.allowed) return json({ error: { code: "RATE_LIMITED", message: floodLimit.reason } }, 429);

    const { issuePasswordReset } = await import("@/services/PlatformAdminService");
    const { getActiveEmailProvider } = await import("@/providers/email");
    const { accountEmailSender, sendAccountEmail } = await import("@/lib/account-email");
    const { accountEmailOrigin } = await import('@/lib/account-email-origin');
    if (getActiveEmailProvider() === 'mock') return json({ ok: false, error: { code: 'EMAIL_NOT_CONFIGURED', message: 'Account email is not connected. No reset was issued and existing sessions are unchanged.' } }, 400);
    const origin = accountEmailOrigin();
    try { accountEmailSender(); } catch {
      return json({ ok: false, error: { code: 'EMAIL_NOT_CONFIGURED', message: 'Account email needs a verified sender configured. No reset was issued and existing sessions are unchanged.' } }, 400);
    }
    const result = await issuePasswordReset({
      adminId: admin.id,
      targetUserId,
      targetWorkspaceId,
    });

    // Transactional reset: the operator never sees the token. Issuance ends
    // sessions but preserves the existing password until the link is redeemed.
    // Provider acceptance and inbox delivery are distinct outcomes.
    const user = await repos.user.findById(targetUserId);
    const resetLink = `${origin}/reset-password?token=${encodeURIComponent(result.token)}`;
    let emailResult;
    try {
      emailResult = await sendAccountEmail({
        to: user?.email || "",
        subject: "Reset your LeadCockpit password",
        html: `<p>Hi ${user?.name || ""},</p><p>An operator issued a password reset for your account. Click the link below to set a new password. The link expires in 24 hours.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't expect this, you can ignore this email — your existing password still works until someone uses this link.</p>`,
        purpose: "password_reset",
      });
    } catch (emailErr) {
      // Keep the ended-session state honest. An uncertain network outcome
      // requires checking before reissue; the existing password still works.
      console.error("[reset-password] sendEmail FAILED after issuePasswordReset for user", targetUserId, ":", (emailErr as Error).message);
      const { EmailSendError } = await import('@/providers/email/EmailSendProvider');
      const unconfirmed = emailErr instanceof EmailSendError && emailErr.outcomeUnknown;
      return json({
        ok: false,
        error: {
          code: unconfirmed ? 'RESET_EMAIL_UNCONFIRMED' : "RESET_ISSUED_BUT_EMAIL_FAILED",
          message: unconfirmed
            ? 'Existing sessions ended. Email acceptance is unconfirmed; check the inbox or email provider before requesting another link. The existing password still works.'
            : 'Existing sessions ended, but the reset email was not accepted. The existing password still works; sign in again and ask the administrator to retry once account email recovers.',
          expiresAt: result.expiresAt,
        },
      }, 502);
    }

    return json({
      ok: true,
      // Honest provider status (resend = real send; mock = recorded to outbox).
      emailProvider: getActiveEmailProvider(),
      emailOk: emailResult.ok,
      accepted: emailResult.ok && emailResult.provider !== 'mock',
      expiresAt: result.expiresAt,
    });
  }

  // /admin/feature-flags — operator toggles a global kill-switch.
  if (match(path, ["admin", "feature-flags"])) {
    const admin = await requirePlatformAdmin(request, "operator");
    const parsed = adminFeatureFlagSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { setFeatureFlag } = await import("@/services/FeatureFlagService");
    const result = await setFeatureFlag({ adminId: admin.id, key: parsed.data.key, enabled: parsed.data.enabled });
    return json(result);
  }

  return json({ error: "Admin route not found", path }, 404);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  try {
    return await handlePost(request, context);
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const path = (await context.params).path || [];
    const repos = createRepositories();
    // Stage 5 / WP5 (2026-07-29) — front-door rate limit (mirrors the other verbs).
    const deleteEdgeBlock = await applyEdgeRateLimit(request, path, await resolveWorkspaceId(request));
    if (deleteEdgeBlock) return deleteEdgeBlock;
    // Session 1 auth + CSRF gate for DELETE + Phase 5.8 RBAC gate.
    const gate = await enforceAuthGate(request);
    if (gate) return gate;
    // Cluster 1 fix (P0-5): resolve workspace from the session, NOT the
    // defaultWorkspaceId constant. Previously any sales_member could delete
    // any media item by id (workspace filter used the constant).
    if (match(path, ["media", ":id"])) {
      // S6 W-1: hard-delete now records an audit trail + uses the session actor.
      const workspaceId = await resolveWorkspaceId(request);
      const { resolveActor } = await import("./workspace-resolution");
      const actor = await resolveActor(request, undefined);
      return json(await deleteMediaCatalogItem(workspaceId, path[1], actor.userId, repos));
    }
    // D-2026-08-02 / CP-17 FIX: WhatsApp credentials clear (DELETE) — moved here
    // from handlePost where the `=== "DELETE"` guard was always false. Sweep-caught.
    if (match(path, ["whatsapp-agent", "credentials"])) {
      const workspaceId = await resolveWorkspaceId(request);
      const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
      await new WhatsAppCredentialService(repos).clear(workspaceId);
      return json({ success: true });
    }
    // N12 — remove a line added to one lead. What the customer already
    // answered stays on the lead.
    if (match(path, ["leads", ":id", "discovery-lines", ":key"])) {
      const workspaceId = await resolveWorkspaceId(request);
      const { removeLeadDiscoveryLine } = await import("@/services/DiscoveryService");
      return json(await removeLeadDiscoveryLine(workspaceId, path[1], path[3], repos));
    }
    // CP-25 — delete a WhatsApp template.
    if (match(path, ["whatsapp-templates", ":id"])) {
      const workspaceId = await resolveWorkspaceId(request);
      return json(await repos.whatsAppTemplate.deleteById(workspaceId, path[1]));
    }
    // 2026-09-08 — remove a knowledge source document.
    //
    // There was no way to do this, on any substrate. The Knowledge Base is the
    // agent's source of truth: whatever sits in it is retrieved and quoted back
    // to customers. A workspace that ingested the wrong brochure, or ran an
    // extraction while the AI had no key and stored a page of canned fallback
    // text, was stuck with that content in the retrieval path for ever. The
    // demo deployment was in exactly that state — a document titled "Combined
    // onboarding sources" holding boilerplate about a Cloud ERP system, in a
    // workspace that manufactures zari thread.
    //
    // The chunks go with the document (Postgres cascades; the JSON repository
    // removes them in the same mutation), because a deleted document whose
    // chunks survive is the worst outcome: gone from the screen, still in every
    // answer.
    if (match(path, ["knowledge", "documents", ":id"])) {
      const workspaceId = await resolveWorkspaceId(request);
      const { resolveActor } = await import("./workspace-resolution");
      const actor = await resolveActor(request, undefined);
      const existing = await repos.knowledgeBaseDocument.getById(workspaceId, path[2]);
      if (!existing) return notFoundResponse("Knowledge document not found");
      if (existing.documentType === "agent_instruction" || existing.source === "workspace_override") await requireRole(request, "owner");
      const removed = await repos.knowledgeBaseDocument.delete(workspaceId, path[2]);
      await safeAudit(repos, {
        workspaceId,
        userId: actor.userId,
        action: "knowledge.document_deleted",
        entityType: "knowledge_base_document",
        entityId: path[2],
        oldValuesJson: { title: existing.title, documentType: existing.documentType, source: existing.source },
      });
      await emitBackendEvent("knowledge.document_deleted", workspaceId, "knowledge_base_document", path[2], {
        title: existing.title,
        source: existing.source,
      });
      return json(removed);
    }
    return json({ error: "Route not found", path }, 404);
  } catch (error) {
    return errorToResponse(error);
  }
}


async function handlePost(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const path = (await context.params).path || [];
  const repos = createRepositories();

  // Stage 5 / WP5 (2026-07-29) — front-door rate limit (mirrors handleGet).
  // Workspace ID resolved defensively (POST routes include public auth paths
  // that have no session yet, so resolveWorkspaceId falls back to the demo
  // workspace — the IP counter still applies).
  const postWorkspaceId = await resolveWorkspaceId(request);
  const edgeBlock = await applyEdgeRateLimit(request, path, postWorkspaceId);
  if (edgeBlock) return edgeBlock;

  // ---- Public auth endpoints (Session 1) -----------------------------------
  // These must be reachable WITHOUT a session so a logged-out user can log in.
  // Public does not mean a browser may submit from another site. Keep
  // header-less non-browser auth clients compatible, but reject an explicit
  // hostile Origin/Referer before login can issue a cookie or logout revokes it.
  if (path[0] === "auth" && getAuthMode() === "production" &&
    (request.headers.has("origin") || request.headers.has("referer")) && !isCsrfSafe(request)) {
    return json({ success: false, error: { code: "CSRF_REJECTED", message: "This request came from a different site. Open LeadCockpit and try again." } }, 403);
  }
  if (match(path, ["auth", "login"])) {
    if (getAuthMode() !== "production") {
      // Demo/local: no real login needed; return the demo owner.
      return json({ ok: true, user: { id: "user_owner", email: "owner@example.com", name: "Demo Owner", role: "owner", workspaceId: defaultWorkspaceId }, mode: getAuthMode() });
    }
    const parsed = loginSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // Phase 1.5 audit fix: rate-limit login attempts to stop brute-force
    // attacks. Keyed by email (falls back to IP). 5 failures per 10 minutes.
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const loginLimit = await checkRateLimit({ workspaceId: parsed.data.workspaceId || defaultWorkspaceId, userId: parsed.data.email || clientIp, action: "login" });
    if (!loginLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: loginLimit.reason, details: loginLimit } }, 429);
    // 2026-09-27: a workspaceId in the body is the company the person picked
    // after being asked "which company?" — only that one is checked then.
    const result = await loginWithPassword(defaultWorkspaceId, parsed.data.email, parsed.data.password, { chosenWorkspaceId: parsed.data.workspaceId || undefined });
    if (!result.ok && result.choices?.length) {
      return json({ ok: false, chooseCompany: result.choices, error: { code: "CHOOSE_COMPANY", message: result.reason } }, 409);
    }
    if (!result.ok) return json({ ok: false, error: { code: "INVALID_CREDENTIALS", message: result.reason } }, 401);
    const response = NextResponse.json({ ok: true, user: result.user });
    setSessionCookie(response, result.token);
    return response;
  }
  if (match(path, ["auth", "logout"])) {
    // 2026-09-28 (S4): signing out ends the session for real. Sessions are
    // signed cookies with no server table, so this bumps the person's session
    // version — which signs them out on every device (the screen says so).
    // A tour session is shared by every visitor, so it is only cleared.
    if (getAuthMode() === "production") {
      const current = await resolveUserFromSession(request.cookies.get("lc_session")?.value);
      if (current && !current.isTour) {
        const { endAllSessions } = await import("@/services/AccountSecurityService");
        await endAllSessions(current.id, current.workspaceId, "sign_out");
      }
    }
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  }
  // 2026-09-28 — self-service "Forgot password?". PUBLIC. Answers the same
  // thing whether or not the email has an account, and does not wait for the
  // lookup or the email, so neither the words nor the timing tell them apart.
  if (match(path, ["auth", "forgot-password"])) {
    if (getAuthMode() !== "production") {
      return json({ ok: false, error: { code: "DEMO_MODE", message: "Password reset is only available on the live site." } }, 400);
    }
    const parsed = forgotPasswordSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const perEmail = await checkRateLimit({ workspaceId: defaultWorkspaceId, userId: `${clientIp}:${parsed.data.email}`, action: "forgot_password" });
    const perIp = await checkRateLimit({ workspaceId: defaultWorkspaceId, userId: `ip:${clientIp}`, action: "forgot_password", limit: 20 });
    if (!perEmail.allowed || !perIp.allowed) {
      return json({ success: false, error: { code: "RATE_LIMITED", message: (perEmail.allowed ? perIp : perEmail).reason } }, 429);
    }
    const { requestPasswordReset } = await import("@/services/AccountSecurityService");
    const { getActiveEmailProvider } = await import('@/providers/email');
    if (getActiveEmailProvider() === 'mock') return json({ ok: true, message: 'Account email is not connected. No reset email can be sent. Ask your administrator for help; your existing password still works.' });
    const { accountEmailOrigin } = await import('@/lib/account-email-origin');
    const { accountEmailSender } = await import('@/lib/account-email');
    try { accountEmailOrigin(); accountEmailSender(); } catch {
      return json({ ok: true, message: 'Account email needs its public application address and verified sender configured. Ask your administrator for help; your existing password still works.' });
    }
    // A provider wait only for known accounts would disclose membership through
    // response timing. Acknowledge the request uniformly; Next keeps the callback
    // alive after the response. This acknowledgement does not claim delivery.
    after(async () => {
      await requestPasswordReset(parsed.data.email).catch((e: unknown) => console.error("[forgot-password] failed:", e instanceof Error ? e.message : e));
    });
    return json({ ok: true, message: FORGOT_PASSWORD_MESSAGE });
  }
  if (match(path, ["auth", "bootstrap"])) {
    // Owner first-run setup. Only succeeds when no credentials exist.
    if (getAuthMode() !== "production") {
      return json({ ok: true, user: { id: "user_owner", email: "owner@example.com", name: "Demo Owner", role: "owner", workspaceId: defaultWorkspaceId }, mode: getAuthMode(), message: "Demo mode does not require bootstrap." });
    }
    const parsed = ownerBootstrapSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    try {
      const user = await bootstrapOwner(parsed.data);
      const response = NextResponse.json({ ok: true, user });
      setSessionCookie(response, issueSessionForUser(user));
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bootstrap failed.";
      const status = /already exists/i.test(message) ? 409 : 400;
      return json({ ok: false, error: { code: "BOOTSTRAP_FAILED", message } }, status);
    }
  }
  // CP-20 (2026-08-02) — public read-only tour. A visitor clicks "Explore the
  // live demo" on the landing page; this mints a viewer session on
  // workspace_demo flagged isTour. Production-only (the RBAC gate is a no-op
  // in demo/local, so the read-only guarantee wouldn't hold there). Sits in
  // the pre-gate public auth block (like signup/login) so it needs no session
  // + skips CSRF; the front-door edge rate limit at the top of handlePost
  // already applies. CP-20e adds a per-IP cap (10/hour) to prevent abuse.
  if (match(path, ["auth", "tour", "start"])) {
    if (getAuthMode() !== "production") {
      return json({ ok: false, error: { code: "DEMO_MODE", message: "The public tour runs in production mode. Use the demo-mode entry for local testing." } }, 400);
    }
    // CP-20e — per-IP rate limit (mirrors the signup F-P1-1 chokepoint).
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const tourLimit = await checkRateLimit({ workspaceId: defaultWorkspaceId, userId: clientIp, action: "tour-start" });
    if (!tourLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: tourLimit.reason, details: tourLimit } }, 429);
    const result = await startTourSession();
    if (!result.ok) {
      return json({ ok: false, error: { code: result.statusCode === 429 ? "RATE_LIMITED" : "TOUR_UNAVAILABLE", message: result.reason } }, result.statusCode);
    }
    const response = NextResponse.json({ ok: true, user: result.user });
    setSessionCookie(response, result.token);
    return response;
  }
  // Stage 5 / WP1 (2026-07-28) — public self-serve signup. Gated by the
  // new_signup_enabled feature flag at the service layer. Demo mode is a
  // no-op (signup is a production feature; the demo uses bootstrap:owner).
  if (match(path, ["auth", "signup"])) {
    if (getAuthMode() !== "production") {
      return json({ ok: false, error: { code: "DEMO_MODE", message: "Signup is production-only. Use bootstrap:owner for the demo." } }, 400);
    }
    const parsed = signupSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // Stage 5 re-audit F-P1-1 (2026-07-28): rate-limit the PUBLIC signup route.
    // Each signup burns ~150ms CPU (scrypt) + 4 DB writes + an outbound email;
    // an attacker could flood this to burn the Resend quota + amplify CPU.
    // Keyed by IP+email (5/hour). Pinned by golden:stage5-batch4-chokepoints CASE 1.
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    // Keep one aggregate budget too: rotating addresses must not buy another
    // five signup attempts from the same source. Uses the existing signup cap.
    const signupIpLimit = await checkRateLimit({ workspaceId: defaultWorkspaceId, userId: `signup-ip:${clientIp}`, action: "signup" });
    if (!signupIpLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: signupIpLimit.reason, details: signupIpLimit } }, 429);
    const signupLimit = await checkRateLimit({ workspaceId: defaultWorkspaceId, userId: `${clientIp}:${parsed.data.email}`, action: "signup" });
    if (!signupLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: signupLimit.reason, details: signupLimit } }, 429);
    try {
      // 2026-09-28 (S7): the answer is the same whether or not the email
      // already has an account (that person is told by email instead), and
      // nobody is signed in here — a new owner signs in with the password
      // they just chose.
      await publicSignup(parsed.data);
      return json({ ok: true, checkEmail: true, message: PUBLIC_SIGNUP_MESSAGE });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Signup failed.";
      const errAny = error as { statusCode?: number };
      const status = errAny.statusCode || (/already/i.test(message) ? 409 : 400);
      return json({ ok: false, error: { code: "SIGNUP_FAILED", message } }, status);
    }
  }
  // Stage 5 / WP1 (2026-07-28) — public invite acceptance. The invitee has
  // the token from their invite email. Creates their account + issues a session.
  if (match(path, ["auth", "invites", "accept"])) {
    if (getAuthMode() !== "production") {
      return json({ ok: false, error: { code: "DEMO_MODE", message: "Invites are production-only." } }, 400);
    }
    const parsed = acceptInviteSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // Stage 5 re-audit F-P1-1 (2026-07-28): rate-limit public invite-accept.
    // Keyed by IP (20/hour). Pinned by golden:stage5-batch4-chokepoints CASE 1.
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const acceptLimit = await checkRateLimit({ workspaceId: defaultWorkspaceId, userId: clientIp, action: "invite_accept" });
    if (!acceptLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: acceptLimit.reason, details: acceptLimit } }, 429);
    try {
      // The invite's id is resolved inside acceptInvite via the token hash.
      const result = await acceptInvite({
        inviteId: "", // resolved by token lookup inside the service
        rawToken: parsed.data.token,
        name: parsed.data.name,
        password: parsed.data.password,
      });
      const response = NextResponse.json({ ok: true, user: result.user });
      setSessionCookie(response, result.sessionToken);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invite acceptance failed.";
      const errAny = error as { statusCode?: number };
      const status = errAny.statusCode || (/expired|revoked/i.test(message) ? 410 : 400);
      return json({ ok: false, error: { code: "INVITE_FAILED", message } }, status);
    }
  }

  // ---- Stage 5 re-audit fix (F-P0-4, 2026-07-28) — Redeem password-reset ----
  // PUBLIC (the user clicked the emailed link). Mirrors /auth/verify-email +
  // /auth/invites/accept. Sets the new password + consumes the token. The
  // user is NOT auto-logged-in (they must log in with the new password —
  // defense-in-depth: the reset link proves email control, not session
  // continuity).
  if (match(path, ["auth", "reset-password"])) {
    if (getAuthMode() !== "production") {
      return json({ ok: false, error: { code: "DEMO_MODE", message: "Password reset is production-only." } }, 400);
    }
    const parsed = redeemPasswordResetSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    try {
      const { redeemPasswordReset } = await import("@/services/PasswordResetService");
      const result = await redeemPasswordReset({
        rawToken: parsed.data.token,
        newPassword: parsed.data.password,
      });
      return json({ ok: true, userId: result.userId, completedAt: result.completedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Password reset failed.";
      const errAny = error as { statusCode?: number };
      const status = errAny.statusCode || (/expired|already been used/i.test(message) ? 410 : 400);
      return json({ ok: false, error: { code: "RESET_FAILED", message } }, status);
    }
  }

  // ---- Stage 5 / WP3 (2026-07-28) — Platform admin auth (public) -----------
  // Separate from workspace auth: distinct cookie (lc_platform_admin) +
  // secret + session payload. The admin panel is production-only; in demo
  // mode login is a no-op (the panel isn't reachable in demo).
  if (match(path, ["admin", "auth", "login"])) {
    const { loginPlatformAdmin, setAdminSessionCookie } = await import("@/services/PlatformAdminAuthService");
    if (getAuthMode() !== "production") {
      return json({ ok: false, error: { code: "DEMO_MODE", message: "The admin panel is production-only. Set AUTH_MODE=production." } }, 400);
    }
    const parsed = platformAdminLoginSchema.safeParse(await safeBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const limit = await checkRateLimit({ workspaceId: "platform", userId: parsed.data.email || clientIp, action: "platform_admin_login" });
    if (!limit.allowed) return json({ ok: false, error: { code: "RATE_LIMITED", message: limit.reason } }, 429);
    const result = await loginPlatformAdmin(parsed.data.email, parsed.data.password);
    if (!result.ok) return json({ ok: false, error: { code: "INVALID_CREDENTIALS", message: result.reason } }, 401);
    const response = NextResponse.json({ ok: true, admin: { id: result.admin.id, email: result.admin.email, name: result.admin.name, role: result.admin.role } });
    setAdminSessionCookie(response, result.token);
    return response;
  }
  if (match(path, ["admin", "auth", "logout"])) {
    const { clearAdminSessionCookie, signOutPlatformAdmin, PLATFORM_ADMIN_COOKIE } = await import("@/services/PlatformAdminAuthService");
    // 2026-09-28 (S4): end the admin session for real, not just the cookie.
    if (getAuthMode() === "production") await signOutPlatformAdmin(request.cookies.get(PLATFORM_ADMIN_COOKIE)?.value);
    const response = NextResponse.json({ ok: true });
    clearAdminSessionCookie(response);
    return response;
  }

  // All remaining /admin/* POST routes require a platform-admin session.
  if (path[0] === "admin") {
    return await handlePlatformAdminPost(request, path, repos);
  }

  // 2026-09-27 (CEO: "the daily routine runs by itself") — a free outside
  // schedule wakes the site and starts the daily routine here. Off unless
  // DAILY_RUN_SECRET (32+ characters) is set; the caller must send it in
  // x-daily-run-secret. Answers at once and runs in the background; the
  // once-per-company-per-day claim makes a repeated call harmless.
  if (match(path, ["internal", "daily-run"])) {
    const { dailyRunSecretMatches } = await import("@/lib/daily-run-secret");
    const verdict = dailyRunSecretMatches(request.headers.get("x-daily-run-secret"), process.env.DAILY_RUN_SECRET);
    if (verdict === "off") return json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    if (verdict === "wrong") return json({ success: false, error: { code: "FORBIDDEN", message: "Not allowed." } }, 403);
    const { runDailyRoutine } = await import("@/services/DailyRoutineService");
    void runDailyRoutine(repos)
      .then((reports) => console.log(`[daily-run] done: ${reports.map((r) => `${r.workspaceId} ${r.skipped ? `skipped (${r.skipped})` : `new=${r.leadsCreated} scored=${r.aiScored} approved=${r.autoApproved} due=${r.followUpsDue} errors=${r.errors.length}`}`).join("; ")}`))
      .catch((error) => console.error("[daily-run] failed:", error instanceof Error ? error.message : error));
    return json({ ok: true, started: true }, 202);
  }
  // 2026-09-28 — the regular check for time-based owner alerts (a customer
  // waiting over 2 working hours, an urgent ticket 30 minutes from its
  // deadline). Same secret as the daily run; off when it is not set.
  if (match(path, ["internal", "owner-alerts-check"])) {
    const { dailyRunSecretMatches } = await import("@/lib/daily-run-secret");
    const verdict = dailyRunSecretMatches(request.headers.get("x-daily-run-secret"), process.env.DAILY_RUN_SECRET);
    if (verdict === "off") return json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    if (verdict === "wrong") return json({ success: false, error: { code: "FORBIDDEN", message: "Not allowed." } }, 403);
    const { checkTimedOwnerAlertsForAll } = await import("@/services/OwnerNotifyService");
    void checkTimedOwnerAlertsForAll(repos)
      .then((n) => console.log(`[owner-alerts] check done: ${n} alert(s) raised`))
      .catch((error) => console.error("[owner-alerts] check failed:", error instanceof Error ? error.message : error));
    return json({ ok: true, started: true }, 202);
  }
  if (match(path, ["inbound", "whatsapp-webhook"])) {
    // Session 4 audit fix: rate-limit the webhook POST. Each inbound message
    // triggers the full LLM pipeline; without a cap, repeated forged webhooks
    // are a cheap cost-amplification DoS.
    const webhookLimit = await checkRateLimit({ workspaceId: defaultWorkspaceId, action: "whatsapp_webhook" });
    if (!webhookLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: webhookLimit.reason, details: webhookLimit } }, 429);

    // Phase 1.2 audit fix: verify the X-Hub-Signature-256 HMAC before
    // processing. Without this, anyone could POST a forged Meta payload.
    const signatureCheck = await readAndVerifyWebhookBody(request);
    if (!signatureCheck.ok) {
      return json({ success: false, error: { code: "SIGNATURE_INVALID", message: signatureCheck.reason } }, signatureCheck.status);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(signatureCheck.rawBody);
    } catch {
      return json({ success: false, error: { code: "INVALID_JSON", message: "Webhook body is not valid JSON." } }, 400);
    }
    // 2026-09-27 (review S1): file each message under the company that owns
    // the receiving number, not the default company.
    const { routeWhatsAppWebhook } = await import("@/services/WhatsAppWebhookService");
    const { routed, unrouted } = await routeWhatsAppWebhook(body, repos, {
      defaultWorkspaceId,
      deploymentPhoneNumberId: process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID,
      demoFallback: getAuthMode() !== "production",
    });
    const results = [];
    for (const item of routed) results.push(await processWhatsAppCloudWebhook(item.workspaceId, item.payload, repos));
    return json({
      ok: true,
      provider: "meta_cloud",
      messagesReceived: results.reduce((sum, r) => sum + r.messagesReceived, 0),
      statusesReceived: results.reduce((sum, r) => sum + r.statusesReceived, 0),
      processedMessages: results.flatMap((r) => r.processedMessages),
      unrouted,
    });
  }
  if (getAuthMode() === "production" && !productionAuthConfigured()) return forbiddenResponse("Production authentication is not configured.");

  // ---- Session 1 auth + CSRF gate + Phase 5.8 RBAC gate --------------------
  // Every request past this point (i.e. every non-auth, non-webhook mutation)
  // must pass CSRF, be authenticated, AND have a role sufficient for the route.
  // enforceAuthGate returns null on success or a JSON error response on failure.
  {
    const gate = await enforceAuthGate(request);
    if (gate) return gate;
  }
  if (match(path, ["documents", "extract-file-text"])) {
    return json(await extractUploadedFileText(request));
  }
  if (match(path, ["media", "upload"])) {
    return json(await uploadMediaCatalogFile(request, repos));
  }
  const body = await safeBody(request);

  // Cluster B fix (2026-07-21 session 17): workspace resolution + cross-
  // tenant block. Replaces the old check that compared body.workspaceId
  // against the CONSTANT defaultWorkspaceId — which admitted the A1 attack
  // (any authenticated user writing into the demo tenant). The helper now
  // resolves the workspace from the SESSION and blocks mismatches.
  // Pinned by golden:workspace-scoping. Demo mode bypasses (auth gate is
  // no-op) so smokes + JSON demo keep working.
  let workspaceId: string = defaultWorkspaceId;
  if (getAuthMode() === "production") {
    const { resolveMutationWorkspace } = await import("./workspace-resolution");
    let sessionUser: { workspaceId: string; userId: string } | null = null;
    try {
      const u = await resolveCurrentUser(request);
      sessionUser = u ? { workspaceId: u.workspaceId, userId: u.id } : null;
    } catch {
      // Unauthenticated — the enforceAuthGate below will reject. Pass null
      // so the helper applies its defensive default.
      sessionUser = null;
    }
    const resolution = await resolveMutationWorkspace({
      authMode: getAuthMode(),
      request,
      bodyWorkspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
      sessionUser,
    });
    if (!resolution.ok) {
      return json({ success: false, error: { code: resolution.code, message: resolution.message } }, resolution.status);
    }
    workspaceId = resolution.workspaceId;
  } else {
    // Demo: the body may name the workspace, but only as text — a number or
    // object used to become the stored workspaceId (break test, 2026-09-26).
    workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId : defaultWorkspaceId;
  }

  // Cluster 4 fix (2026-07-26 audit, P1-1 / F1 / F2): resolve the actor ONCE
  // here (from the SESSION in production, never trusted from the body) and
  // thread it into every audit-log call below. Previously each audit callsite
  // either omitted userId (blank actor → non-repudiation gap) or took it from
  // body.actorUserId (forgery vector). Now AuditInput.userId is REQUIRED and
  // every route-supplied call uses this session-derived value. Body-supplied
  // actorUserId is passed only as the demo-mode hint (production ignores it).
  const { resolveActor } = await import("./workspace-resolution");
  const postActorUserId = (await resolveActor(request, typeof body.actorUserId === "string" ? body.actorUserId : undefined)).userId;

  // === Owner Copilot (2026-08-01) — owner-facing assistant chat =============
  // Design: docs/planning/OWNER_COPILOT_DESIGN.md. Universal + 5-tier safety.
  // Owner-only (it acts on the owner's behalf, drafts/approves quotes/tickets).
  // Never auto-sends to a customer (no-auto-outreach). Every turn is audited.
  // 2026-09-26 (break test) — writing into a conversation now requires that
  // it exists in THIS workspace and belongs to the caller. Before, any id was
  // accepted: a message could be attached to a conversation id from another
  // workspace, or to one that did not exist at all.
  const ownedConversation = async (conversationId: string) => {
    let ownerUserId = "user_owner";
    try {
      const u = await resolveCurrentUser(request);
      if (u?.id) ownerUserId = u.id;
    } catch {
      /* demo path */
    }
    const conversation = conversationId ? await repos.ownerCopilotConversation.getById(workspaceId, conversationId) : undefined;
    return conversation && conversation.ownerUserId === ownerUserId ? { conversation, ownerUserId } : undefined;
  };
  // 2026-09-26 — the "Save it there" / "Don't save" buttons on the assistant's
  // "that sounds like the answer to another question" message.
  if (match(path, ["copilot", "setup-answer"]) && request.method === "POST") {
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const messageId = typeof body.messageId === "string" ? body.messageId : "";
    if (typeof body.save !== "boolean") return json({ success: false, error: { code: "BAD_REQUEST", message: "Say whether to save." } }, 400);
    const owned = await ownedConversation(conversationId);
    if (!owned) return notFoundResponse("Conversation not found");
    const { resolveSetupAnswerProposal } = await import("@/services/OwnerCopilotService");
    const result = await resolveSetupAnswerProposal({ repos, workspaceId, ownerUserId: owned.ownerUserId, conversationId, messageId: messageId || undefined, save: body.save });
    if (!result.ok) return json({ success: false, error: { code: "CONFLICT", message: result.error } }, 409);
    return json({ ok: true, response: result.response });
  }
  // 2026-09-25 — "New conversation" on the full-page assistant.
  if (match(path, ["copilot", "conversations"]) && request.method === "POST") {
    // Same owner resolution as GET /copilot/conversations, so the new chat
    // appears in the list that GET returns (demo falls back to user_owner).
    let ownerUserId = "user_owner";
    try {
      const u = await resolveCurrentUser(request);
      if (u?.id) ownerUserId = u.id;
    } catch {
      /* demo path */
    }
    const activeLeadId = typeof body.leadId === "string" ? body.leadId : undefined;
    if (activeLeadId && !(await repos.lead.getLeadById(workspaceId, activeLeadId))) return notFoundResponse("Customer not found");
    // A fresh chat the owner has not written in yet is reused: a double-click
    // (or pressing New twice) used to leave a trail of empty conversations.
    // Requests for the same owner run one at a time, so five at once cannot
    // each see "no empty chat yet" and each make one (break test, 2026-09-26).
    return json(await oneAtATime(`copilot-new:${workspaceId}:${ownerUserId}`, async () => {
      const [latest] = await repos.ownerCopilotConversation.listForOwner(workspaceId, ownerUserId, 1);
      if (latest && !(await repos.ownerCopilotMessage.listByConversation(workspaceId, latest.id)).length) {
        return latest.activeLeadId === activeLeadId ? latest : await repos.ownerCopilotConversation.update(workspaceId, latest.id, { activeLeadId });
      }
      return repos.ownerCopilotConversation.create({ workspaceId, ownerUserId, activeLeadId });
    }));
  }
  if (match(path, ["copilot", "message"]) && request.method === "POST") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'text'." } }, 400);
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    if (!conversationId) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'conversationId'. Use GET /copilot/conversations to get/create one." } }, 400);
    const owned = await ownedConversation(conversationId);
    if (!owned) return notFoundResponse("Conversation not found");
    const requestedLeadId = typeof body.leadId === "string" ? body.leadId : undefined;
    const capturedLeadId = body.quoteCapture && typeof body.quoteCapture === "object"
      ? (body.quoteCapture as Record<string, unknown>).leadId : undefined;
    const conversationLeadId = owned.conversation.activeLeadId;
    if (conversationLeadId && ((requestedLeadId && requestedLeadId !== conversationLeadId)
      || (capturedLeadId && capturedLeadId !== conversationLeadId))) {
      return json({ success: false, error: { code: "CONVERSATION_CUSTOMER_MISMATCH", message: "This conversation belongs to another customer. Open a new conversation for this customer." } }, 409);
    }
    const leadId = conversationLeadId || requestedLeadId;
    if (leadId && !(await repos.lead.getLeadById(workspaceId, leadId))) return notFoundResponse("Customer not found");
    if (text.length > 4000) return json({ success: false, error: { code: "BAD_REQUEST", message: "That message is too long — keep it under 4,000 characters." } }, 400);
    // Quote (T2) structured capture, if the owner already provided the fields.
    let quoteCapture: import("@/services/OwnerCopilotService").QuoteCaptureInput | undefined;
    if (body.quoteCapture && typeof body.quoteCapture === "object") {
      const q = body.quoteCapture as Record<string, unknown>;
      quoteCapture = {
        workspaceId,
        leadId: leadId || (typeof q.leadId === "string" ? q.leadId : ""),
        productName: String(q.productName || ""),
        productId: typeof q.productId === "string" ? q.productId : undefined,
        quantity: Number(q.quantity),
        unit: String(q.unit || ""),
        unitPrice: Number(q.unitPrice),
        currencyCode: String(q.currencyCode || "INR"),
        validityNote: typeof q.validityNote === "string" ? q.validityNote : undefined,
      };
    }
    const { handleOwnerCopilotTurn } = await import("@/services/OwnerCopilotService");
    try {
      const response = await handleOwnerCopilotTurn({
        workspaceId,
        ownerUserId: owned.ownerUserId,
        conversationId,
        ownerText: text,
        quoteCapture,
        leadId,
        repos,
      });
      return json({ ok: true, response });
    } catch (error) {
      // Never-guess throws land here (missing quote fields) → surface honestly.
      const message = error instanceof Error ? error.message : "Copilot turn failed.";
      return json({ success: false, error: { code: "COPILOT_TURN_FAILED", message } }, 400);
    }
  }
  if (match(path, ["copilot", "approve"]) && request.method === "POST") {
    const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
    if (!quoteId) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'quoteId'." } }, 400);
    const { approveQuoteDraft } = await import("@/services/OwnerCopilotService");
    // M1 (2026-09-27): one at a time with the quote's other status changes.
    const updated = await oneAtATime(`quote-change:${workspaceId}:${quoteId}`, () =>
      approveQuoteDraft(workspaceId, quoteId, repos, { actorUserId: postActorUserId, logAudit: true }));
    return json({ ok: true, quote: updated });
  }
  // POST /copilot/confirm — CP-10: owner confirmed a T3 big job → RUN it.
  // The confirm gate (handleOwnerCopilotTurn → copilot_confirm) stood; this is
  // the "go". Executes the job (ICP/campaign/research/etc.) + reports in chat.
  // N8 — the master agent, directly. The chat uses the same two steps through
  // /copilot/message and /copilot/confirm; these exist so a job can be planned
  // and run without a conversation around it. Owner-only via the copilot prefix.
  if (match(path, ["copilot", "jobs"]) && request.method === "POST") {
    const { proposeJob, describePlan } = await import("@/services/OrchestrationService");
    const job = await proposeJob({ workspaceId, goal: typeof body.goal === "string" ? body.goal : "", repos });
    return json({ ...job, text: describePlan(job) });
  }
  // 2026-09-27 — reminders for later.
  if (match(path, ["leads", ":id", "follow-ups"])) {
    const { resolveActor } = await import("./workspace-resolution");
    const actor = (await resolveActor(request, undefined)).userId;
    const { createReminder } = await import("@/services/FollowUpService");
    return json(await createReminder(workspaceId, { leadId: path[1], dueOn: String(body.dueOn || ""), note: String(body.note || ""), createdBy: actor }, repos), 201);
  }
  // 2026-09-28 — the owner's own WhatsApp summary + alerts. Owner-only (rbac-map "owner-alerts").
  if (match(path, ["owner-alerts", "settings"])) {
    const { resolveActor } = await import("./workspace-resolution");
    const actor = (await resolveActor(request, undefined)).userId;
    const { saveOwnerNotifySettings, getOwnerNotifyView } = await import("@/services/OwnerNotifyService");
    await saveOwnerNotifySettings(workspaceId, (body || {}) as Record<string, unknown>, actor, repos);
    return json(await getOwnerNotifyView(workspaceId, repos));
  }
  if (match(path, ["follow-ups", ":id", "confirm"])) {
    const { confirmReminder } = await import("@/services/FollowUpService");
    return json(await confirmReminder(workspaceId, path[1], { dueOn: typeof body.dueOn === "string" ? body.dueOn : undefined, note: typeof body.note === "string" ? body.note : undefined }, repos));
  }
  if (match(path, ["follow-ups", ":id", "done"]) || match(path, ["follow-ups", ":id", "dismiss"])) {
    const { closeReminder } = await import("@/services/FollowUpService");
    return json(await closeReminder(workspaceId, path[1], path[2] === "done" ? "done" : "dismissed", repos));
  }
  if (match(path, ["copilot", "jobs", ":id", "cancel"]) && request.method === "POST") {
    const { cancelJob } = await import("@/services/OrchestrationService");
    return json(await cancelJob(workspaceId, path[2], repos));
  }
  // 2026-09-27 (A4) — a fresh copy of a finished, failed or stopped job,
  // waiting for the owner's go-ahead. Running it is the ordinary .../run.
  if (match(path, ["copilot", "jobs", ":id", "again"]) && request.method === "POST") {
    const { copyJobToRunAgain, describePlan } = await import("@/services/OrchestrationService");
    const job = await copyJobToRunAgain(workspaceId, path[2], repos);
    return json({ ...job, text: describePlan(job) });
  }
  if (match(path, ["copilot", "jobs", ":id", "run"]) && request.method === "POST") {
    const { runJob } = await import("@/services/OrchestrationService");
    return json(await runJob({ workspaceId, jobId: path[2], repos }));
  }
  if (match(path, ["copilot", "confirm"]) && request.method === "POST") {
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const pendingActionId = typeof body.pendingActionId === "string" ? body.pendingActionId : "";
    const intent = typeof body.intent === "string" ? body.intent : "";
    if (!conversationId) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'conversationId'." } }, 400);
    if (!pendingActionId) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'pendingActionId'." } }, 400);
    if (!intent) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'intent'." } }, 400);
    const owned = await ownedConversation(conversationId);
    if (!owned) return notFoundResponse("Conversation not found");
    const { confirmCopilotBigJob } = await import("@/services/OwnerCopilotService");
    try {
      const response = await confirmCopilotBigJob({
        workspaceId,
        ownerUserId: owned.ownerUserId,
        conversationId,
        pendingActionId,
        intent,
        repos,
      });
      return json({ ok: true, response });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Copilot confirm failed.";
      return json({ success: false, error: { code: "COPILOT_CONFIRM_FAILED", message } }, 400);
    }
  }
  // POST /copilot/save-fact — CP-5/CP-11: owner accepted the "save this fact?"
  // offer → capture it as an Information Needed card (never a silent KB write).
  if (match(path, ["copilot", "save-fact"]) && request.method === "POST") {
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const questionText = typeof body.questionText === "string" ? body.questionText.trim() : "";
    if (!conversationId) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'conversationId'." } }, 400);
    if (!questionText) return json({ success: false, error: { code: "BAD_REQUEST", message: "Missing 'questionText'." } }, 400);
    const owned = await ownedConversation(conversationId);
    if (!owned) return notFoundResponse("Conversation not found");
    const { saveCopilotFact } = await import("@/services/OwnerCopilotService");
    try {
      const response = await saveCopilotFact({
        workspaceId,
        ownerUserId: owned.ownerUserId,
        conversationId,
        questionText,
        missingTopic: typeof body.missingTopic === "string" ? body.missingTopic : undefined,
        leadId: typeof body.leadId === "string" ? body.leadId : undefined,
        repos,
      });
      return json({ ok: true, response });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Copilot save-fact failed.";
      return json({ success: false, error: { code: "COPILOT_SAVE_FACT_FAILED", message } }, 400);
    }
  }

  if (path[0] === "inbound") {
    const auth = validateApiKeyOrWebhookSecret(request);
    if (!auth.ok) return forbiddenResponse("Invalid inbound API secret");
    // R3 audit fix: resolve the inbound target workspace from the server side,
    // never from the body. Single-workspace today (defaultWorkspaceId); when
    // multi-workspace lands, this reads from INBOUND_WEBHOOK_WORKSPACE_ID or a
    // per-secret mapping. The body's workspaceId is NOT trusted.
    const inboundWorkspaceId = process.env.INBOUND_WEBHOOK_WORKSPACE_ID || defaultWorkspaceId;
    const limit = await checkRateLimit({ workspaceId: inboundWorkspaceId, action: "inbound_webhook" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);

    if (["leads", "forms"].includes(path[1] || "")) {
      const parsed = inboundLeadSchema.safeParse({ ...body, provider: body.provider || (path[1] === "forms" ? "website_form" : "manual") });
      if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
      // R3 audit fix: force the server-side workspace; ignore parsed.data.workspaceId.
      const lead = await repos.lead.createLead({
        workspaceId: inboundWorkspaceId,
        companyName: parsed.data.companyName,
        contactName: parsed.data.contactName,
        email: parsed.data.email || undefined,
        phone: parsed.data.phone,
        whatsappNumber: parsed.data.whatsappNumber,
        source: parsed.data.provider,
        fitReason: parsed.data.message ? `Inbound message: ${parsed.data.message}` : "Inbound prospect submitted for review.",
        personalizationNote: parsed.data.message,
        status: "needs_review",
        reviewStatus: "pending",
        enrichmentStatus: "not_started",
      });
      await emitBackendEvent("lead.created", inboundWorkspaceId, "lead", lead.id, { provider: parsed.data.provider, source: parsed.data.source });
      return successResponse({ lead }, { authMode: auth.mode }, 201);
    }

    if (["replies", "whatsapp", "gmail", "webhook"].includes(path[1] || "")) {
      const parsed = inboundReplySchema.safeParse({ ...body, provider: body.provider || path[1] || "manual" });
      if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
      // R3 audit fix: force the server-side workspace; ignore parsed.data.workspaceId.
      // F-GHOST-1 (2026-08-04 build-right audit): VALIDATE the leadId before
      // creating the reply. Previously `parsed.data.leadId` came straight from
      // the request body with no existence/scoping check — a caller with the
      // inbound secret could create reply rows pointing at a non-existent or
      // cross-workspace leadId. Those orphan replies are invisible in the CRM
      // (no lead to attach to) and can never be cleaned up by the erasure
      // cascade (it keys replies by leadId). Same family as CP-6 finding H.
      const inboundLead = await repos.lead.getLeadById(inboundWorkspaceId, parsed.data.leadId);
      if (!inboundLead) {
        return validationErrorResponse("leadId does not match a known lead in this workspace");
      }
      const reply = await repos.reply.create({
        workspaceId: inboundWorkspaceId,
        leadId: parsed.data.leadId,
        channel: parsed.data.channel,
        rawText: parsed.data.rawText,
      });
      await emitBackendEvent("reply.created", inboundWorkspaceId, "reply", reply.id, { provider: parsed.data.provider, providerMessageId: parsed.data.providerMessageId });
      return successResponse({ reply }, { authMode: auth.mode }, 201);
    }

    return json({ error: "Inbound route not found", path }, 404);
  }

  // ---- Stage 5 / WP1 (2026-07-28) — member invites (authed, owner/admin) ----
  // POST /invites — create a member invite (owner/admin only).
  if (match(path, ["invites"]) && !path[1]) {
    const user = await requireRole(request, "admin"); // owner or admin
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    try {
      const result = await createInvite({
        workspaceId,
        invitedByUserId: user.id,
        inviteeEmail: parsed.data.email,
        role: parsed.data.role,
      });
      // Zero-knowledge: the rawToken is NOT returned to the inviter. It was
      // already emailed by the service. The response only carries the inviteId.
      return json({ ok: true, inviteId: result.inviteId, emailSent: result.emailSent, emailUnconfirmed: result.emailUnconfirmed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invite failed.";
      const errAny = error as { statusCode?: number };
      const status = errAny.statusCode || (/already|pending|member/i.test(message) ? 409 : 400);
      return json({ ok: false, error: { code: "INVITE_FAILED", message } }, status);
    }
  }
  // POST /invites/:id/revoke — revoke a pending invite (owner/admin only).
  if (match(path, ["invites", ":id", "revoke"])) {
    const user = await requireRole(request, "admin");
    try {
      await revokeInvite({ workspaceId, inviteId: path[1], revokedByUserId: user.id });
      return json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Revoke failed.";
      const errAny = error as { statusCode?: number };
      const status = errAny.statusCode || 400;
      return json({ ok: false, error: { code: "REVOKE_FAILED", message } }, status);
    }
  }
  // ---- 2026-09-28 — the signed-in person's own sessions and password -------
  // Past the auth gate: CSRF-checked and signed in.
  if (match(path, ["auth", "logout-everywhere"])) {
    const user = await resolveCurrentUser(request);
    if (user.isTour) return json({ ok: false, error: { code: "TOUR", message: "The demo tour has nothing to sign out of." } }, 400);
    const { endAllSessions } = await import("@/services/AccountSecurityService");
    await endAllSessions(user.id, user.workspaceId, "sign_out_everywhere");
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  }
  if (match(path, ["auth", "change-password"])) {
    const user = await resolveCurrentUser(request);
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const limit = await checkRateLimit({ workspaceId: user.workspaceId, userId: user.id, action: "change_password" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason } }, 429);
    const { changePassword } = await import("@/services/AccountSecurityService");
    const result = await changePassword(user, parsed.data);
    const response = NextResponse.json({ ok: true });
    setSessionCookie(response, result.sessionToken);
    return response;
  }
  // ---- 2026-09-28 (S3) — team management (owner/admin; "team" is admin in rbac-map)
  if (match(path, ["team", "members", ":id", "remove"])) {
    const user = await requireRole(request, "admin");
    const { removeTeamMember } = await import("@/services/TeamService");
    return json({ ok: true, member: await removeTeamMember({ workspaceId, actorUserId: user.id, memberId: path[2] }) });
  }
  if (match(path, ["team", "members", ":id", "role"])) {
    const user = await requireRole(request, "admin");
    const parsed = teamRoleSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { changeTeamMemberRole } = await import("@/services/TeamService");
    return json({ ok: true, member: await changeTeamMemberRole({ workspaceId, actorUserId: user.id, memberId: path[2], role: parsed.data.role }) });
  }

  // POST /auth/resend-verification — re-send the signup verification email to
  // the logged-in (but unverified) user. Authed (the user is logged in).
  if (match(path, ["auth", "resend-verification"])) {
    const user = await resolveCurrentUser(request);
    if (user.isTour) return json({ ok: false, error: { code: 'TOUR_READ_ONLY', message: 'The sample account cannot request account emails. Sign in to your own company account.' } }, 403);
    // Stage 5 re-audit F-P1-1 (2026-07-28): rate-limit resend-verification so
    // a logged-in unverified user can't spam the email provider infinitely.
    // Keyed by userId (5/hour). Pinned by golden:stage5-batch4-chokepoints CASE 1.
    const resendLimit = await checkRateLimit({ workspaceId: user.workspaceId, userId: user.id, action: "resend_verification" });
    if (!resendLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: resendLimit.reason, details: resendLimit } }, 429);
    try {
      const { getActiveEmailProvider } = await import("@/providers/email");
      if (getActiveEmailProvider() === "mock") return json({ ok: false, error: { code: "EMAIL_NOT_CONFIGURED", message: "Account email delivery is not configured. You can still sign in; ask your administrator to connect account email." } }, 400);
      await resendVerificationService({ userId: user.id });
      return json({ ok: true, accepted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resend failed.";
      const { EmailSendError } = await import('@/providers/email/EmailSendProvider');
      const unconfirmed = error instanceof EmailSendError && error.outcomeUnknown;
      return json({ ok: false, error: { code: unconfirmed ? 'EMAIL_UNCONFIRMED' : "RESEND_FAILED", message: unconfirmed ? 'Email acceptance is unconfirmed. Check your inbox or ask your administrator to check the email provider before requesting another link.' : message } }, unconfirmed ? 502 : 400);
    }
  }

  if (path[0] === "workspaces") {
    const workspace = await repos.workspace.create({ name: body.name || "New workspace" });
    await emitBackendEvent("workspace.created", workspace.id, "workspace", workspace.id, {});
    return json(workspace);
  }

  if (path[0] === "business-profile" && !path[1]) {
    // F-7: validate format (websiteUrl/contactEmail, when present) before
    // create OR update. The schema is .passthrough(), so every other field
    // on this large object is unaffected — this only rejects a malformed URL
    // or email, exactly the class of bug already sitting in the demo data.
    const parsed = businessProfileUpdateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const existing = await repos.businessProfile.getByWorkspace(workspaceId);
    if (existing) {
      const updated = await repos.businessProfile.update(workspaceId, existing.id, body);
      // N-AI-10 (2026-08-27): saving the profile used to write the row and stop.
      // The AI does not read BusinessProfile — it reads the knowledge chunks
      // built from it — so the operator saw the new value on screen while the
      // AI kept quoting the old one until a human remembered the Sync button.
      const knowledge = await refreshBusinessProfileKnowledge(workspaceId, repos);
      return json({ ...updated, knowledge });
    }
    const profile = await repos.businessProfile.create({ ...body, workspaceId });
    await emitBackendEvent("business_profile.created", workspaceId, "business_profile", profile.id, {});
    const knowledge = await refreshBusinessProfileKnowledge(workspaceId, repos);
    return json({ ...profile, knowledge });
  }

  if (match(path, ["business-profile", ":id", "approve"])) {
    const profile = await repos.businessProfile.approve(workspaceId, path[1]);
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "business_profile.approved", entityType: "business_profile", entityId: profile.id });
    await emitBackendEvent("business_profile.approved", workspaceId, "business_profile", profile.id, {});
    return json(profile);
  }

  if (match(path, ["crawl", "start"])) {
    // Session 4 audit fix: rate-limit crawl starts (each crawl fans out many fetches).
    const crawlLimit = await checkRateLimit({ workspaceId, action: "crawl_start" });
    if (!crawlLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: crawlLimit.reason, details: crawlLimit } }, 429);
      const consent = await repos.websiteCrawlConsent.getLatestForUrl(workspaceId, String(body.websiteUrl || ""));
      if (!consent?.consentGiven) {
        return json({ error: "Website scan requires explicit consent before crawling.", consentRequired: true }, 400);
      }
      // M3.8 / O9: consent covers the seed URL/domain. The crawler itself
      // enforces additional safety per page: robots.txt is fetched and
      // respected, and a sensitive-URL denylist (admin / .git / .env / etc.)
      // skips pages that look non-public. See src/lib/crawler.ts.
    const job = await repos.websiteCrawlJob.create({ workspaceId, websiteUrl: body.websiteUrl, status: "running", pagesFound: 0, pagesCrawled: 0, startedAt: timestamp() });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "website_crawl.started", entityType: "website_crawl_job", entityId: job.id, newValuesJson: { websiteUrl: body.websiteUrl } });
    await emitBackendEvent("website_crawl.started", workspaceId, "website_crawl_job", job.id, { websiteUrl: body.websiteUrl });
    const run = await repos.agentRun.create({ workspaceId, agentName: "Website Extraction Agent", input: { websiteUrl: body.websiteUrl }, status: "running", startedAt: timestamp() });
    try {
      const pages = await crawlWebsite(body.websiteUrl, Number(body.pageLimit || 12));
      await repos.websiteCrawlPage.createMany(pages.map((page) => ({
        crawlJobId: job.id,
        workspaceId,
        url: page.url,
        title: page.title,
        cleanedText: page.text,
        metadata: { links: page.links, emails: page.emails, phones: page.phones, socials: page.socials, catalogues: page.catalogues },
      })));
      const completed = await repos.websiteCrawlJob.complete(workspaceId, job.id, pages.length, pages.length);
      await repos.agentRun.update(workspaceId, run.id, { status: "completed", output: { pagesCrawled: pages.length }, completedAt: timestamp() });
      return json(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown crawl failure";
      const failed = await repos.websiteCrawlJob.fail(workspaceId, job.id, message);
      await repos.agentRun.update(workspaceId, run.id, { status: "failed", errorMessage: message, completedAt: timestamp() });
      return json(failed);
    }
  }

  if (match(path, ["crawl", ":jobId", "extract"])) {
    // S6 S-3: cap extraction fan-out (crawl pages + LLM Q&A).
    const extractLimit = await checkRateLimit({ workspaceId, action: "document_extraction" });
    if (!extractLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: extractLimit.reason, details: extractLimit } }, 429);
    const job = must(await repos.websiteCrawlJob.getById(workspaceId, path[1]), "Crawl job not found");
    const crawlPages = await repos.websiteCrawlPage.listByCrawlJob(workspaceId, job.id);
    const pages = crawlPages.map((page) => ({
      title: page.title || "",
      text: page.cleanedText,
      emails: arrayFrom(page.metadata.emails),
      phones: arrayFrom(page.metadata.phones),
      socials: arrayFrom(page.metadata.socials),
      catalogues: arrayFrom(page.metadata.catalogues),
    }));
    const run = await repos.agentRun.create({ workspaceId, agentName: "Business Profile Agent", input: { crawlJobId: job.id }, status: "running", startedAt: timestamp() });
    const extraction = await repos.businessExtraction.create(extractBusinessFromPages(workspaceId, job.id, pages));
    const profileInput = profileFromExtraction(workspaceId, job.websiteUrl, extraction);
    const existing = await repos.businessProfile.getByWorkspace(workspaceId);
    const profile = existing
      ? await repos.businessProfile.update(workspaceId, existing.id, profileInput)
      : await repos.businessProfile.create({ id: uid("profile"), ...profileInput });
    await repos.agentRun.update(workspaceId, run.id, { status: "completed", output: { extraction, profile }, completedAt: timestamp() });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "business_extraction.generated", entityType: "business_extraction", entityId: extraction.id, newValuesJson: { profileId: profile.id } });
    await emitBackendEvent("business_extraction.generated", workspaceId, "business_extraction", extraction.id, { profileId: profile.id });
    await emitBackendEvent("website_crawl.extraction_review_required", workspaceId, "business_profile", profile.id, { crawlJobId: job.id, extractionId: extraction.id });
    await emitBackendEvent("business_profile.created", workspaceId, "business_profile", profile.id, { crawlJobId: job.id, extractionId: extraction.id });
    const websiteDocumentText = crawlPages
      .map((page) => [
        `URL: ${page.url}`,
        page.title ? `Title: ${page.title}` : "",
        page.cleanedText,
      ].filter(Boolean).join("\n"))
      .join("\n\n---\n\n");
    const questionAnswering = websiteDocumentText.trim()
      ? await answerDocumentQuestions({
        workspaceId,
        documentId: job.id,
        documentText: websiteDocumentText,
        documentMetadata: { title: `Website scan: ${job.websiteUrl}`, sourceType: "website" },
      }, repos)
      : null;
    if (questionAnswering) {
      await emitBackendEvent("knowledge.document_created", workspaceId, "website_crawl_job", job.id, {
        extractionRunId: questionAnswering.run.id,
        answeredCount: questionAnswering.answeredCount,
        partialCount: questionAnswering.partialCount,
        conflictCount: questionAnswering.conflictCount,
      });
      // Route high-confidence extracted facts into structured settings safely
      if (questionAnswering.answers?.length) {
        const routingResult = await routeExtractedFactsToSettings(workspaceId, questionAnswering.answers, `website:${job.websiteUrl}`, repos);
        if (routingResult.conflictsCreated > 0) {
          await emitBackendEvent("settings.conflicts_created", workspaceId, "settings_conflict", job.id, {
            conflictsCreated: routingResult.conflictsCreated,
            source: "website_extraction",
          });
        }
      }
    }
    return json({ extraction, profile, questionAnswering });
  }

  if (match(path, ["crawl", "consent"])) {
    // F14 (2026-08-04 CONTINUOUS-2 audit): thread the session-resolved actor
    // (postActorUserId) into the consent record + audit entry instead of the
    // hardcoded "user_owner". The consent record is the legal artifact proving
    // the operator had permission to scrape; mis-attributing it to the owner
    // when an admin acted is a non-repudiation gap.
    const consent = await repos.websiteCrawlConsent.create({ workspaceId, websiteUrl: String(body.websiteUrl || ""), consentGiven: Boolean(body.consentGiven), consentGivenAt: timestamp(), consentTextVersion: "v1", userId: postActorUserId });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "website_crawl.consent_given", entityType: "website_crawl_consent", entityId: consent.id, newValuesJson: { websiteUrl: consent.websiteUrl, consentGiven: consent.consentGiven } });
    await emitBackendEvent("website_crawl.consent_given", workspaceId, "website_crawl_consent", consent.id, { websiteUrl: consent.websiteUrl, consentGiven: consent.consentGiven });
    return json(consent);
  }

  if (match(path, ["onboarding", "extract-company-knowledge"])) {
    // S6 S-3: cap the full extraction pipeline (website + docs + LLM).
    const limit = await checkRateLimit({ workspaceId, action: "document_extraction" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    try {
      const result = await extractCompanyKnowledgeFromSourceBundle({
        workspaceId,
        websiteUrl: body.websiteUrl ? String(body.websiteUrl) : undefined,
        websiteConsent: Boolean(body.websiteConsent),
        files: Array.isArray(body.files) ? body.files.map((file: Record<string, unknown>) => ({
          fileName: String(file.fileName || "Uploaded file"),
          fileType: file.fileType ? String(file.fileType) : undefined,
          extractedText: String(file.extractedText || ""),
          size: typeof file.size === "number" ? file.size : undefined,
          warning: file.warning ? String(file.warning) : undefined,
        })) : [],
        pastedText: body.pastedText ? String(body.pastedText) : undefined,
        pageLimit: Number(body.pageLimit || 8),
      }, repos);
      return json(result);
    } catch (error) {
      return errorToResponse(error);
    }
  }


  // N-FEAT-1 (2026-09-05) — product application research.
  //
  // The dashboard has always been able to tell an operator to "analyze product
  // applications and buyer segments to improve targeting", and until now there
  // was nothing behind that sentence: the five repositories existed, the five
  // types existed, the smoke called this path, and the route did not exist. A
  // 404 is what the operator's next step was made of.
  if (match(path, ["product-research", "generate"])) {
    const researchLimit = await checkRateLimit({ workspaceId, action: "product_research" });
    if (!researchLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: researchLimit.reason, details: researchLimit } }, 429);
    const researchProfile = await repos.businessProfile.getByWorkspace(workspaceId);
    if (!researchProfile) {
      return json({ success: false, error: { code: "PROFILE_REQUIRED", message: "Fill in your business profile first — product research is built from the products and customer types it holds." } }, 400);
    }
    // N-BUG (2026-09-08): this gated on `researchProfile.products`, and the
    // Profile screen says in as many words that "products, customers and
    // selling points ... moved to the Knowledge Base". Nothing writes
    // profile.products any more, so the gate rejected every workspace — while
    // the dashboard's own recommendedNextAction told the operator to "analyze
    // product applications and buyer segments to improve targeting". The
    // catalogue the operator actually fills is Settings → Products, so read it.
    const catalogue = await repos.productSettings.getByWorkspace(workspaceId);
    const catalogueNames = (catalogue?.products || []).map((p) => p.name?.trim()).filter((name): name is string => Boolean(name));
    const productNames = (researchProfile.products || []).length ? researchProfile.products! : catalogueNames;
    if (!productNames.length) {
      return json({ success: false, error: { code: "PRODUCTS_REQUIRED", message: "Add at least one product on the Catalogue page (Add your products) first. Targeting advice built on a product you do not sell is worse than none." } }, 400);
    }
    const researchRun = await repos.agentRun.create({ workspaceId, agentName: "Product Research Agent", input: { businessProfileId: researchProfile.id }, status: "running", startedAt: timestamp() });
    const research = await runProductApplicationResearch({ ...researchProfile, products: productNames }, repos);
    await repos.agentRun.update(workspaceId, researchRun.id, {
      status: "completed",
      output: { products: research.products.length, buyerSegments: research.buyerSegments.length, marketMaps: research.marketMaps.length, mode: research.mode },
      completedAt: timestamp(),
    });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "product_research.generated", entityType: "business_profile", entityId: researchProfile.id, newValuesJson: { products: research.products.length, buyerSegments: research.buyerSegments.length, marketMaps: research.marketMaps.length, mode: research.mode } });
    await emitBackendEvent("product_research.generated", workspaceId, "business_profile", researchProfile.id, { products: research.products.length, marketMaps: research.marketMaps.length });
    return json(research);
  }

  if (match(path, ["icp", "generate"])) {
    // Phase 5.7: ICP generation runs an agent + writes; rate-limit to stop abuse.
    const icpLimit = await checkRateLimit({ workspaceId, action: "icp_generate" });
    if (!icpLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: icpLimit.reason, details: icpLimit } }, 429);
    const profile = must(await repos.businessProfile.getByWorkspace(workspaceId), "Fill in your business profile first (Knowledge → Profile).");
    const run = await repos.agentRun.create({ workspaceId, agentName: "ICP Generation Agent", input: { businessProfileId: profile.id }, status: "running", startedAt: timestamp() });
    const icps = await repos.icp.replaceForBusinessProfile(workspaceId, profile.id, await generateICPs(profile, repos));
    await repos.agentRun.update(workspaceId, run.id, { status: "completed", output: { icps }, completedAt: timestamp() });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "icp.generated", entityType: "business_profile", entityId: profile.id, newValuesJson: { count: icps.length } });
    await emitBackendEvent("icp.generated", workspaceId, "business_profile", profile.id, { count: icps.length });
    return json(icps);
  }

  if (match(path, ["icp", ":id", "select"]) || match(path, ["icp", ":id", "reject"])) {
    const icp = path[2] === "select" ? await repos.icp.select(workspaceId, path[1]) : await repos.icp.reject(workspaceId, path[1]);
    if (path[2] === "select") {
      await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "icp.selected", entityType: "icp", entityId: icp.id });
      await emitBackendEvent("icp.selected", workspaceId, "icp", icp.id, { name: icp.name });
    }
    return json(icp);
  }

  if (path[0] === "campaigns" && !path[1]) {
    // F-7: leadGoal/dailyOutreachLimit go through Number() below with no
    // check — "abc" becomes NaN and silently corrupts the campaign's daily
    // send budget. z.coerce.number() rejects a non-numeric string outright.
    const parsedCampaign = campaignCreateSchema.safeParse(body);
    if (!parsedCampaign.success) return validationErrorResponse(parsedCampaign.error.flatten());
    const profile = must(await repos.businessProfile.getByWorkspace(workspaceId), "Fill in your business profile first (Knowledge → Profile).");
    const allIcps = await repos.icp.listByWorkspace(workspaceId);
    const icp = body.icpId
      ? allIcps.find((item) => item.id === body.icpId)
      : allIcps.find((item) => item.status === "selected");
    if (!icp) return json({ success: false, error: { code: "NEEDS_ACTION", message: body.icpId ? "That ideal customer is no longer available. Select it again before creating the campaign." : "Pick an ideal customer first (Prospecting → Ideal Customers)." } }, 400);
    const partial = { targetRegion: body.targetRegion || icp.geography, offer: body.offer || "Catalogue request", productFocus: body.productFocus || profile.products };
    const campaign = await repos.campaign.create({
      workspaceId,
      businessProfileId: profile.id,
      icpId: icp.id,
      name: body.name || `${icp.name} campaign`,
      goal: body.goal || "get catalogue requests",
      targetRegion: partial.targetRegion,
      productFocus: partial.productFocus,
      offer: partial.offer,
      selectedChannels: body.selectedChannels || icp.preferredChannels,
      dailyOutreachLimit: Number(body.dailyOutreachLimit || 20),
      leadGoal: Number(body.leadGoal || 50),
      status: "draft",
      approvalStatus: "needs_review",
      plan: await planCampaign(profile, icp, partial, repos),
    });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "campaign.created", entityType: "campaign", entityId: campaign.id });
    await emitBackendEvent("campaign.created", workspaceId, "campaign", campaign.id, { icpId: campaign.icpId });
    return json(campaign);
  }

  if (match(path, ["campaigns", ":id", "approve"]) || match(path, ["campaigns", ":id", "pause"])) {
    // 2026-09-26 (break test): approve sets a campaign running, so approving a
    // finished or archived one quietly started it again; approving a running
    // one logged a second approval.
    const current = await repos.campaign.getById(workspaceId, path[1]);
    if (!current) return notFoundResponse("Campaign not found");
    if (current.status === "completed" || current.status === "archived") {
      throw new NeedsActionError(`This campaign is ${current.status === "completed" ? "finished" : "archived"} — make a new one instead.`);
    }
    if (path[2] === "approve" && current.status === "active" && current.approvalStatus === "approved") return json(current);
    const campaign = path[2] === "approve"
      ? await repos.campaign.approve(workspaceId, path[1])
      : await repos.campaign.update(workspaceId, path[1], { status: "paused" });
    if (path[2] === "approve") {
      await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "campaign.approved", entityType: "campaign", entityId: campaign.id });
      await emitBackendEvent("campaign.approved", workspaceId, "campaign", campaign.id, {});
    }
    return json(campaign);
  }

  // === Session 55 — reset and restore. =====================================
  // Recorded in session 54 and left open: "No workspace reset and no backup
  // restore ('Loading a backup back in isn't built yet'). Cleaning a demo means
  // erasing leads one at a time." Both are owner-only, both require the
  // operator to type the word, and both are audited. See
  // RESET_PRESERVED_COLLECTIONS for what a reset deliberately does not touch.
  if (match(path, ["data", "reset"])) {
    try {
      await requireRole(request, "owner");
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
      }
      throw error;
    }
    // Typed confirmation, not a boolean. A stray `{}` or a repeated request
    // must not be able to empty a workspace.
    if (String(body?.confirm || "") !== "RESET") {
      return validationErrorResponse('Send confirm: "RESET" to empty this workspace.');
    }
    if (!repos.clearWorkspaceCollections) {
      return json({ error: "Reset is not available in this runtime." }, 500);
    }
    // Session 55: this used to be `repos.mutateAll(clearWorkspaceData)`, which
    // deletes on JSON and CANNOT delete on Postgres — the snapshot writer there
    // is upsert-only, so the route answered 400 and removed nothing on the
    // substrate production runs on. The repository deletes with a WHERE clause
    // that says what it means, on whichever substrate it is running.
    const removed = await repos.clearWorkspaceCollections(workspaceId, resetTargetCollections());
    const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
    await safeAudit(repos, {
      workspaceId,
      userId: postActorUserId,
      action: "workspace.reset",
      entityType: "workspace",
      entityId: workspaceId,
      newValuesJson: { removedRows: total, removedByCollection: removed, preserved: RESET_PRESERVED_COLLECTIONS },
    });
    return json({ removedRows: total, removedByCollection: removed, preserved: RESET_PRESERVED_COLLECTIONS });
  }

  if (match(path, ["data", "restore"])) {
    try {
      await requireRole(request, "owner");
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
      }
      throw error;
    }
    if (String(body?.confirm || "") !== "RESTORE") {
      return validationErrorResponse('Send confirm: "RESTORE" to overwrite this workspace with a backup.');
    }
    if (!repos.mutateAll || !repos.clearWorkspaceCollections) {
      return json({ error: "Restore is not available in this runtime." }, 500);
    }
    // Accept the whole downloaded file or just its `data` object, because the
    // operator has a file on disk and should not have to edit it first.
    const backupRoot = (body?.backup ?? body?.data) as Record<string, unknown> | undefined;
    const backup = (backupRoot && typeof backupRoot === "object" && "data" in backupRoot
      ? (backupRoot as { data: unknown }).data
      : backupRoot) as Record<string, unknown> | undefined;
    if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
      return validationErrorResponse("The backup file could not be read. Send the JSON file this workspace exported.");
    }
    // Only collections the export itself produces. An unknown key in the file
    // is ignored rather than written blindly into the snapshot.
    const knownCollections = new Set(Object.keys(scopeDataForExport({} as AppData, workspaceId)));
    const unknownKeys = Object.keys(backup).filter((key) => !knownCollections.has(key));
    if (Object.keys(backup).some(key => knownCollections.has(key) && !Array.isArray(backup[key]))) {
      return validationErrorResponse("A company-data section in the backup is unreadable. Nothing was changed.");
    }
    const restorable = Object.keys(backup).filter((key) => knownCollections.has(key) && Array.isArray(backup[key]));
    if (!restorable.some(key => !(RESET_PRESERVED_COLLECTIONS as readonly string[]).includes(key))) {
      return validationErrorResponse("That file contains no workspace data this version can restore.");
    }

    // Validate every row before transforming or clearing any data.
    for (const key of restorable) {
      if ((backup[key] as unknown[]).some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        return validationErrorResponse("The backup contains an invalid record. Nothing was changed.");
      }
    }

    // The DNC registry is never replaced, only added to: restoring an older
    // backup must not resurrect contactability for somebody who opted out after
    // that backup was taken. Work out the additions BEFORE the write, against
    // what is registered now.
    //
    // Identity is the CONTACT, not the row id. The first version of this keyed
    // on `contactValue`, which is not a field DoNotContactEntry has — so every
    // comparison fell through to the id and a backup row carrying the same
    // phone under a different id was re-added as a duplicate.
    // 2026-09-28: phones compare on their last 10 digits, like every other
    // register lookup (src/lib/phone-match.ts), and the website host counts.
    const dncPhoneKey = (value: unknown) => {
      const digits = String(value ?? "").replace(/\D/g, "");
      return digits.length >= 10 ? digits.slice(-10) : digits;
    };
    const dncKey = (row: { normalizedPhone?: unknown; normalizedEmail?: unknown; normalizedDomain?: unknown; id?: unknown }) =>
      `${dncPhoneKey(row.normalizedPhone)}|${String(row.normalizedEmail ?? "").trim().toLowerCase()}|${String(row.normalizedDomain ?? "").trim().toLowerCase()}` ||
      String(row.id ?? "");
    const existingDnc = await repos.doNotContact.listByWorkspace(workspaceId);
    const existingDncKeys = new Set(existingDnc.map(dncKey));
    const backupDnc = Array.isArray(backup.doNotContactRegistry)
      ? (backup.doNotContactRegistry as Array<Record<string, unknown>>)
      : [];
    const newDnc: Array<Record<string, unknown>> = [];
    for (const row of backupDnc) {
      const key = dncKey(row);
      if (existingDncKeys.has(key)) continue;
      existingDncKeys.add(key);
      newDnc.push(row);
    }

    const rowsByCollection: Record<string, Array<Record<string, unknown>>> = {};
    for (const key of restorable) {
      if (key === "doNotContactRegistry") continue;
      // The workspace itself and its members are what a reset PRESERVES, so a
      // restore has nothing to put back: re-creating them would either be a
      // no-op or would re-admit somebody the owner has since removed.
      if ((RESET_PRESERVED_COLLECTIONS as readonly string[]).includes(key)) continue;
      // Re-stamp onto THIS workspace: a backup may have been taken from a
      // different workspace id, and rows carrying a foreign id would be
      // invisible to every query in the product. And drop values the export
      // masked, so a credential field is left alone rather than filled with
      // the literal string "****".
      rowsByCollection[key] = (backup[key] as Array<Record<string, unknown>>)
        .map((row) => ({ ...stripRedactedValues(row), workspaceId }));
    }
    if (newDnc.length) {
      rowsByCollection.doNotContactRegistry = newDnc.map((row) => ({ ...stripRedactedValues(row), workspaceId }));
    }

    const { removed, result } = await restoreWorkspaceAtomically(repos, workspaceId, rowsByCollection, resetTargetCollections());

    const restoredRows = Object.values(result.restored).reduce((sum, count) => sum + count, 0);
    await safeAudit(repos, {
      workspaceId,
      userId: postActorUserId,
      action: "workspace.restored",
      entityType: "workspace",
      entityId: workspaceId,
      newValuesJson: { restoredRows, restoredByCollection: result.restored, removedByCollection: removed, ignoredKeys: unknownKeys, unsupported: result.unsupported, errorCount: result.errors.length },
    });
    return json({
      restoredRows,
      restoredByCollection: result.restored,
      removedByCollection: removed,
      ignoredKeys: unknownKeys,
      // What could NOT be brought back, said out loud. A restore that reports
      // only its successes is how "restoredRows: 2342" came to mean nothing.
      unsupportedCollections: result.unsupported,
      failedRows: result.errors.slice(0, 25),
      failedRowCount: result.errors.length,
      // Said plainly because it is the one thing a restore cannot give back.
      note: "Saved credentials are stripped from every export, so integrations must be reconnected after a restore.",
    });
  }

  if (match(path, ["leads", "manual"])) {
    // Phase 5.6: validate the manual-lead payload. Email, if provided, must be
    // a valid address (the schema allows "" for leads with only a phone).
    const parsed = leadCreateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // 2026-09-26 (break test): an empty form created "Untitled prospect" — a
    // lead with nothing to identify or reach it by.
    const identifying = ["companyName", "contactName", "email", "phone", "whatsappNumber", "websiteUrl"]
      .some((key) => typeof body[key] === "string" && String(body[key]).trim());
    if (!identifying) return json({ success: false, error: { code: "VALIDATION_ERROR", message: "Give the lead at least a company name, a person's name, a phone number, an email or a website.", details: {} } }, 400);
    // 2026-09-26 (break test): do-not-contact and existing-lead checks live in the service.
    const lead = await createManualLead(workspaceId, body, repos);
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "lead.created", entityType: "lead", entityId: lead.id });
    await emitBackendEvent("lead.created", workspaceId, "lead", lead.id, { source: lead.source });
    return json(lead);
  }

  if (match(path, ["leads", "upload-csv"])) {
    // Session 4 audit fix: rate-limit CSV uploads (no cap → cheap mass-insert DoS).
    const csvLimit = await checkRateLimit({ workspaceId, action: "csv_upload" });
    if (!csvLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: csvLimit.reason, details: csvLimit } }, 429);
    // 2026-09-24: the import itself lives in LeadImportService so it can be
    // tested by running it (golden-csv-import-behaviour).
    const { importLeadsFromCsv } = await import("@/services/LeadImportService");
    const result = await importLeadsFromCsv(workspaceId, String(body.csv || ""), {
      campaignId: body.campaignId ? String(body.campaignId) : undefined,
      icpId: body.icpId ? String(body.icpId) : undefined,
    }, repos);
    if ("refused" in result) {
      return json({ success: false, error: { code: result.code, message: result.message } }, result.status);
    }
    await safeAudit(repos, {
      workspaceId,
      userId: postActorUserId,
      action: "lead.csv_imported",
      entityType: "lead",
      entityId: String(body.campaignId || "csv"),
      newValuesJson: {
        created: result.created,
        duplicatesSkipped: result.duplicatesSkipped,
        emptyRowsSkipped: result.emptyRowsSkipped,
        doNotContactSkipped: result.doNotContactSkipped,
        rows: result.rowsRead,
      },
    });
    return json(result);
  }

  if (match(path, ["leads", "discover"])) {
    const limit = await checkRateLimit({ workspaceId, action: "prospect_discovery", limit: 60, windowMs: 24 * 60 * 60 * 1000 });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    const result = await new ProspectingService(repos).prospectForWorkspace({
      workspaceId,
      campaignId: String(body.campaignId || ""),
      icpId: body.icpId ? String(body.icpId) : undefined,
      query: body.query ? String(body.query) : undefined,
      region: body.region ? String(body.region) : undefined,
      limit: Number(body.limit || 5),
    });
    await safeAudit(repos, {
      workspaceId,
      userId: postActorUserId,
      action: "lead.discovery.completed",
      entityType: "campaign",
      entityId: String(body.campaignId || ""),
      newValuesJson: { mode: result.mode, created: result.created, updated: result.updated, queries: result.queries },
    });
    await emitBackendEvent("lead.created", workspaceId, "campaign", String(body.campaignId || ""), {
      mode: result.mode,
      created: result.created,
      updated: result.updated,
      leadIds: result.leads.map((lead) => lead.id),
    });
    return json(result);
  }

  // N12 — a line on ONE lead's list ("ask whether the sample reached").
  if (match(path, ["leads", ":id", "discovery-lines"])) {
    const { addLeadDiscoveryLine } = await import("@/services/DiscoveryService");
    return json(await addLeadDiscoveryLine(workspaceId, path[1], typeof body.label === "string" ? body.label : "", repos));
  }
  if (match(path, ["leads", ":id", "approve"]) || match(path, ["leads", ":id", "reject"])) {
    const approved = path[2] === "approve";
    const lead = approved
      ? await approveLead(workspaceId, path[1], repos, postActorUserId)
      : await rejectLead(workspaceId, path[1], repos, body.reason ? { reason: String(body.reason) } : undefined, postActorUserId);
    return json(lead);
  }

  if (match(path, ["leads", "bulk-approve"]) || match(path, ["leads", "bulk-reject"])) {
    const approved = path[1] === "bulk-approve";
    // Phase 5.12: validate the ids array and cap it so a request with
    // thousands of ids cannot be used to exhaust the daily approval budget or
    // lock the event loop. 200 is generous for a single bulk action.
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    const MAX_BULK = 200;
    if (ids.length === 0) return validationErrorResponse({ ids: "At least one lead id is required." });
    if (ids.length > MAX_BULK) return json({ success: false, error: { code: "BULK_TOO_LARGE", message: `Bulk actions are limited to ${MAX_BULK} leads at a time. You sent ${ids.length}.` } }, 413);
    const uniqueIds = new Set<string>(ids);
    // F5 (2026-08-04 CONTINUOUS-2 audit): bulk-reject now accepts an optional
    // reason (D-2026-08-04-l — "ask once, apply to all") so bulk-rejected leads
    // keep audit parity with the single-lead reject flow. approve ignores it.
    const rejectReason = (!approved && typeof body.reason === "string" && body.reason.trim())
      ? { reason: body.reason.trim().slice(0, 500) }
      : undefined;
    // 2026-09-26 (break test): one blocked lead no longer stops the rest.
    const result = await bulkReviewLeads(workspaceId, [...uniqueIds], approved ? "approve" : "reject", repos, rejectReason, postActorUserId);
    return json(result);
  }

  if (match(path, ["leads", "enrich-approved"])) {
    // S6 S-3: cap bulk enrichment (LLM/search fan-out).
    const enrichLimit = await checkRateLimit({ workspaceId, action: "lead_enrichment" });
    if (!enrichLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: enrichLimit.reason, details: enrichLimit } }, 429);
    return json(await bulkEnrichApproved(workspaceId, repos));
  }

  if (match(path, ["leads", ":id", "enrich"])) {
    // S6 S-3: cap single-lead enrichment.
    const enrichLimit = await checkRateLimit({ workspaceId, action: "lead_enrichment" });
    if (!enrichLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: enrichLimit.reason, details: enrichLimit } }, 429);
    const testCandidates = Array.isArray(body.testCandidates) && process.env.NODE_ENV !== "production"
      ? body.testCandidates as LeadEnrichmentCandidate[]
      : undefined;
    return json(await enrichLead(workspaceId, path[1], { candidates: testCandidates }, repos));
  }

  if (match(path, ["leads", ":id", "score"])) {
    // Phase 5.7: scoring is cheap but creates an agent run; rate-limit lightly.
    const scoreLimit = await checkRateLimit({ workspaceId, action: "lead_scoring" });
    if (!scoreLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: scoreLimit.reason, details: scoreLimit } }, 429);
    const lead = must(await repos.lead.getLeadById(workspaceId, path[1]), "Lead not found");
    const run = await repos.agentRun.create({ workspaceId, agentName: "Lead Scoring Agent", input: { leadId: lead.id }, status: "running", startedAt: timestamp() });
    // 2026-09-09 (session 55): a lead with no ICP attached - which is every
    // CSV import - was scored against no ICP at all, and a lead attached to an
    // ARCHIVED one was scored against a target market the owner had abandoned.
    // See scoringIcpFor.
    const icp = await scoringIcpFor(repos, workspaceId, lead);
    // 2026-09-25 (CEO decision): scoring is AI only - the rule-based path
    // (the old arithmetic scorer and its opt-out flag) is gone. If the AI does not score it,
    // the lead is left exactly as it was and the reason is returned.
    const { fields, aiScored, reason } = await new ProspectingService(repos).rescoreLead(workspaceId, lead, icp);
    if (!aiScored) {
      await repos.agentRun.update(workspaceId, run.id, { status: "failed", errorMessage: reason, completedAt: timestamp() });
      return json({ ...lead, aiScored: false, scoreMessage: reason });
    }
    const updated = await repos.lead.updateLeadScore(workspaceId, lead.id, fields);
    await repos.agentRun.update(workspaceId, run.id, { status: "completed", output: { leadId: updated.id, score: updated.leadScore }, completedAt: timestamp() });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "lead.scored", entityType: "lead", entityId: updated.id, newValuesJson: fields });
    await emitBackendEvent("lead.scored", workspaceId, "lead", updated.id, { leadScore: updated.leadScore, qualificationStatus: updated.qualificationStatus });
    return json({ ...updated, aiScored: true });
  }

  if (match(path, ["leads", ":id", "review-decision"])) {
    return json(await recommendLeadReviewDecision(workspaceId, path[1], repos, postActorUserId));
  }

  if (match(path, ["leads", ":id", "agent-action-plan"])) {
    return json(await createLeadAgentActionPlan(workspaceId, path[1], repos));
  }

  if (match(path, ["leads", "bulk-score"])) {
    // Phase 5.7: bulk-score iterates all leads in a campaign; rate-limit.
    const bulkScoreLimit = await checkRateLimit({ workspaceId, action: "lead_scoring" });
    if (!bulkScoreLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: bulkScoreLimit.reason, details: bulkScoreLimit } }, 429);
    // 2026-09-25 (CEO decision): AI only. "Score with AI" asks the model about
    // leads it has NOT scored yet - never scored, scored by the old rules, or
    // waiting because the AI was down - and never re-reads ones it has. Rejected
    // and do-not-contact leads are skipped: scoring them spends money for nothing.
    //
    // The cap is a WALL-CLOCK budget measured on the live demo (session 55):
    // per-lead latency ran ~3.5s to ~8s depending on provider load, so five
    // leads (~40s at the slow rate) fits under the ~100s a proxy will hold. An
    // explicit `limit` may ask for up to fifty for a caller with its own timeout.
    const result = await scoreLeadsAwaitingAi(repos, workspaceId, {
      campaignId: typeof body.campaignId === "string" ? body.campaignId : undefined,
      limit: Math.max(1, Math.min(Number(body.limit) || 5, 50)),
    });
    return json(result);
  }

  if (match(path, ["messages", "generate"])) {
    // Phase 5.7: message generation runs an LLM draft; rate-limit per workspace.
    const msgLimit = await checkRateLimit({ workspaceId, action: "message_generation" });
    if (!msgLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: msgLimit.reason, details: msgLimit } }, 429);
    // Phase 5.6: validate body before lookup so a missing/garbage leadId is a
    // clean 422 instead of a confusing "Lead not found" on undefined.
    const parsed = messageGenerationSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const lead = must(await repos.lead.getLeadById(workspaceId, parsed.data.leadId), "Lead not found");
    if (lead.doNotContact || lead.reviewStatus === "rejected") throw new Error("Cannot generate outreach for rejected or do-not-contact lead");
    // Session 3 audit fix: defense-in-depth — also check the permanent DNC
    // registry so a lead whose flag was cleared by any means is still blocked.
    const dncCheck = await isContactBlocked(workspaceId, lead);
    if (dncCheck.blocked) throw new NeedsActionError(dncCheck.reason || "This contact is on the do-not-contact list.", 400);
    if (lead.reviewStatus !== "approved") throw new NeedsActionError("Approve this lead before generating outreach.");
    const campaign = must(await repos.campaign.getById(workspaceId, parsed.data.campaignId || lead.campaignId || ""), "Choose a campaign for this lead first (Prospecting → Campaign).");
    if (campaign.approvalStatus !== "approved") throw new NeedsActionError("Approve this campaign before preparing outreach messages (Prospecting → Campaign).", 409);
    const profile = must(await repos.businessProfile.getByWorkspace(workspaceId), "Fill in your business profile first (Knowledge → Profile).");
    // Soft warning: enrichment not yet attempted — message is still generated but metadata notes the gap
    const unenriched = !lead.enrichmentStatus || lead.enrichmentStatus === "not_started" || lead.enrichmentStatus === "failed";
    if (unenriched) {
      // Patch enrichmentResult so MessageGenerationService can surface the warning correctly
      Object.assign(lead, {
        enrichmentResult: lead.enrichmentResult || {
          status: "no_results" as const,
          validationNote: lead.enrichmentStatus === "failed"
            ? "Enrichment failed for this lead. Contact details may be incomplete. Verify before sending."
            : "This lead has not been enriched yet. Consider running enrichment to find contact details before sending.",
        },
      });
    }
    const message = await createReviewedOutreachDraft({ workspaceId, lead, campaign, profile, channel: parsed.data.channel || "WhatsApp", repos });
    if (!shouldProtectQualifiedStatus(lead.status)) await repos.lead.updateLeadStatus(workspaceId, lead.id, "message_ready");
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "message.generated", entityType: "lead", entityId: lead.id, newValuesJson: { messageId: message.id, generationMeta: message.personalizationUsed.generationMeta } });
    await emitBackendEvent("message.generated", workspaceId, "message_template", message.id, { leadId: lead.id, channel: message.channel });
    return json(message);
  }

  if (match(path, ["messages", ":id", "approve"]) || match(path, ["messages", ":id", "mark-used"])) {
    const existing = await repos.messageTemplate.getById(workspaceId, path[1]);
    if (!existing) throw new NeedsActionError("That message no longer exists.", 404);
    const linkedLead = existing.leadId ? await repos.lead.getLeadById(workspaceId, existing.leadId) : undefined;
    if (!linkedLead || linkedLead.reviewStatus !== "approved" || ["rejected", "invalid", "duplicate", "not_interested"].includes(linkedLead.status)) {
      throw new NeedsActionError("Outreach is blocked for this buyer. Review an eligible buyer before approving a message.", 409);
    }
    const blocked = await isContactBlocked(workspaceId, linkedLead, repos);
    if (blocked.blocked) throw new NeedsActionError(blocked.reason || "This buyer asked not to be contacted.", 409);
    const generationMeta = existing?.personalizationUsed?.generationMeta;
    const nextStatus = path[2] === "approve" ? "approved" : "used";
    // 2026-09-26 (break test): approving again moved a message already marked
    // "used" back to "approved" and logged a second approval. Already there
    // (or past it) means nothing to do.
    if (existing && (existing.status === nextStatus || (nextStatus === "approved" && existing.status === "used"))) return json(existing);
    const nextPersonalization = generationMeta && typeof generationMeta === "object" && !Array.isArray(generationMeta)
      ? {
        ...(existing?.personalizationUsed || {}),
        generationMeta: {
          ...(generationMeta as Record<string, unknown>),
          reviewState: nextStatus,
          humanReviewRequired: false,
        },
      }
      : existing?.personalizationUsed;
    const message = await repos.messageTemplate.update(workspaceId, path[1], { status: nextStatus, personalizationUsed: nextPersonalization });
    if (path[2] === "approve") {
      await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "message.approved", entityType: "message_template", entityId: message.id });
      await emitBackendEvent("message.approved", workspaceId, "message_template", message.id, {});
    }
    return json(message);
  }

  if (match(path, ["outreach", "mark-sent"]) || match(path, ["outreach", "log-activity"])) {
    // Phase 5.6: validate the required leadId up front.
    const parsed = outreachMarkSentSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const lead = must(await repos.lead.getLeadById(workspaceId, parsed.data.leadId), "Lead not found");
    if (!canCreateOutreachActivity(lead)) throw new Error("Outreach blocked by lead status");
    // R1 audit fix: consult the PERMANENT DNC registry too, so manual outreach
    // cannot be logged for a contact whose lead flag was cleared but who is
    // still on the permanent DNC list. Mirrors the message-generation gate.
    const outreachDncCheck = await isContactBlocked(workspaceId, lead);
    if (outreachDncCheck.blocked) throw new Error(outreachDncCheck.reason || "Outreach blocked: contact is on the do-not-contact list.");
    const message = body.messageTemplateId ? await repos.messageTemplate.getById(workspaceId, body.messageTemplateId) : undefined;
    const provider = new ManualOutreachProvider();
    const result = message ? await provider.sendMessage(body.channel || message.channel, lead.whatsappNumber || lead.email || lead.phone || "", message) : { status: "manual" as const };
    const activity = await repos.outreachActivity.create({
      workspaceId,
      campaignId: body.campaignId || lead.campaignId,
      leadId: lead.id,
      channel: body.channel || message?.channel || "manual",
      messageTemplateId: message?.id,
      direction: body.direction || "outbound",
      status: "sent_manual",
      sentManually: true,
      body: body.body || message?.body || "",
      subject: body.subject || message?.subject,
      activityAt: timestamp(),
      createdBy: "user_owner",
    });
    const nextStatus = shouldProtectQualifiedStatus(lead.status) ? lead.status : (body.direction === "inbound" ? "replied" : "contacted");
    await repos.lead.updateLead(workspaceId, lead.id, { status: nextStatus, lastContactedAt: timestamp() });
    const resultPayload = { activity, manualUrl: result.url };
    await safeAudit(repos, {
      workspaceId,
      userId: postActorUserId,
      action: "outreach.marked_sent",
      entityType: "lead",
      entityId: body.leadId,
      newValuesJson: { activityId: resultPayload.activity.id, status: resultPayload.activity.status },
    });
    if (message) {
      const generationMeta = message.personalizationUsed?.generationMeta;
      const nextPersonalization = generationMeta && typeof generationMeta === "object" && !Array.isArray(generationMeta)
        ? {
          ...(message.personalizationUsed || {}),
          generationMeta: {
            ...(generationMeta as Record<string, unknown>),
            reviewState: "used",
            humanReviewRequired: false,
          },
        }
        : message.personalizationUsed;
      await repos.messageTemplate.update(workspaceId, message.id, { status: "used", personalizationUsed: nextPersonalization });
    }
    await emitBackendEvent("outreach.marked_sent", workspaceId, "outreach_activity", activity.id, { leadId: lead.id, status: activity.status });
    return json(resultPayload);
  }

  if (path[0] === "replies" && !path[1]) {
    // Phase 5.6: validate reply create — leadId is required.
    const parsed = replyCreateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // F-API-3 (2026-08-04): confirm the leadId exists in THIS workspace before
    // creating the reply. The inbound path (F-GHOST-1 fix) does this at :1791;
    // this workspace-facing create was not swept — a sales_member could POST a
    // reply with a fabricated/cross-workspace leadId, producing an orphan row
    // the erasure cascade (keys replies by leadId) can never clean up.
    const lead = await repos.lead.getLeadById(workspaceId, parsed.data.leadId);
    if (!lead) return notFoundResponse("Lead not found");
    const reply = await repos.reply.create({
        workspaceId,
        campaignId: body.campaignId,
        leadId: body.leadId,
        channel: body.channel || "manual",
        rawText: body.rawText || "",
    });
    await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "reply.created", entityType: "reply", entityId: reply.id });
    await emitBackendEvent("reply.created", workspaceId, "reply", reply.id, { leadId: reply.leadId });
    return json(reply);
  }

  if (match(path, ["replies", ":id", "classify"])) {
    // Phase 5.7: reply classification runs an agent; rate-limit per workspace.
    const clsLimit = await checkRateLimit({ workspaceId, action: "reply_classify" });
    if (!clsLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: clsLimit.reason, details: clsLimit } }, 429);
    const reply = must(await repos.reply.getById(workspaceId, path[1]), "Reply not found");
    const run = await repos.agentRun.create({ workspaceId, agentName: "Reply Classification Agent", input: { replyId: reply.id, rawText: reply.rawText }, status: "running", startedAt: timestamp() });
    const result = classifyReply(reply);
    const updatedReply = await repos.reply.update(workspaceId, reply.id, {
        classification: result.classification,
        confidenceScore: result.confidenceScore,
        summary: result.summary,
        suggestedNextAction: result.suggestedNextAction,
        suggestedResponse: result.suggestedResponse,
    });
    // N-DATA-19: a reply from a number that matched no lead has no leadId at
    // all. Classifying it is still useful (it is recorded and summarised);
    // there is simply no lead status to move.
    const lead = reply.leadId ? await repos.lead.getLeadById(workspaceId, reply.leadId) : undefined;
    let leadStatus = result.leadStatus as Lead["status"];
    if (lead) {
      leadStatus = getLeadStatusFromReplyClassification(result.classification, lead.status);
      const changed = await repos.lead.updateLead(workspaceId, lead.id, { status: leadStatus, doNotContact: leadStatus === "do_not_contact" ? true : lead.doNotContact });
      // 2026-09-28 — won / lost / opted out are real results (outcome signals).
      const { recordLeadChangeOutcome } = await import("@/services/OutcomeSignalService");
      await recordLeadChangeOutcome(workspaceId, lead, changed, repos);
    }
    await repos.agentRun.update(workspaceId, run.id, { status: "completed", output: result, completedAt: timestamp() });
    await safeAudit(repos, {
      workspaceId,
      userId: postActorUserId,
      action: "reply.classified",
      entityType: "reply",
      entityId: updatedReply.id,
      newValuesJson: { classification: updatedReply.classification, leadStatus },
    });
    await emitBackendEvent("reply.classified", workspaceId, "reply", updatedReply.id, { classification: updatedReply.classification, leadStatus });
    if (leadStatus === "mql") await emitBackendEvent("lead.became_mql", workspaceId, "lead", reply.leadId, { replyId: reply.id });
    if (leadStatus === "sql") await emitBackendEvent("lead.became_sql", workspaceId, "lead", reply.leadId, { replyId: reply.id });
    if (leadStatus === "hot_lead") await emitBackendEvent("lead.became_hot", workspaceId, "lead", reply.leadId, { replyId: reply.id });
    if (leadStatus === "do_not_contact") await emitBackendEvent("lead.marked_do_not_contact", workspaceId, "lead", reply.leadId, { replyId: reply.id });
    return json({ reply: updatedReply, leadStatus });
  }

  if (match(path, ["analytics", "campaign", ":campaignId", "generate-learning"])) {
    // S6 S-3: cap the campaign learning-loop agent run.
    const learnLimit = await checkRateLimit({ workspaceId, action: "campaign_learning" });
    if (!learnLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: learnLimit.reason, details: learnLimit } }, 429);
    const campaign = must(await repos.campaign.getById(workspaceId, path[2]), "Campaign not found");
    const run = await repos.agentRun.create({ workspaceId, agentName: "Campaign Analytics Agent", input: { campaignId: campaign.id }, status: "running", startedAt: timestamp() });
    const leads = await repos.lead.listLeadsByCampaign(workspaceId, campaign.id);
    const learning = await repos.campaignLearning.create(generateLearning(campaign, leads));
    await repos.agentRun.update(workspaceId, run.id, { status: "completed", output: { learning }, completedAt: timestamp() });
    await (async () => {
      await emitBackendEvent("campaign.learning_generated", workspaceId, "campaign_learning", learning.id, { campaignId: learning.campaignId });
      return learning;
    })();
    return json(learning);
  }

  // Stage B (2026-07-26) — REAL WhatsApp Cloud test-connection endpoint.
  // Replaces the placeholder stub. Validates credentials WITHOUT sending a
  // message — pings Meta's GET /v20.0/{phoneNumberId}. The Integrations UI
  // uses this for the "Save & Test" button. Honest about every failure mode
  // (auth_failed, wrong_number, rate_limited, network_error, not_configured).
  if (match(path, ["integrations", "test"]) && request.method === "POST") {
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    // 2026-09-30 (page guide): test what this workspace actually sends with —
    // its own saved credentials first, the server's as fallback — the same
    // resolution every send path uses. It used to test the server's settings
    // only, so a workspace with working saved credentials read "not configured".
    const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
    const provider = await new WhatsAppCredentialService(repos).resolveProvider(workspaceId);
    const result = await provider.testConnection();
    return json(result);
  }

  // ── D-2026-08-02 / CP-17: per-workspace WhatsApp Cloud credentials ─────────
  // Concierge path: an operator/owner pastes a customer's WhatsApp creds into
  // their workspace via the UI. Stored encrypted, masked in the view, scoped to
  // one workspace (never cross-tenant). These routes live under "whatsapp-agent"
  // so the admin RBAC gate applies (sensitive keys).
  // (The GET for this route lives in the GET handler up top; the PUT lives in
  // handlePut; the DELETE lives in handleDelete. They were originally placed
  // HERE in handlePost by mistake — where request.method is always POST, so the
  // `=== "PUT"` / `=== "DELETE"` guards were always false → 404. Moved to their
  // correct verb handlers 2026-08-02. Caught by the full-button sweep.)
  if (match(path, ["whatsapp-agent", "credentials", "test"]) && request.method === "POST") {
    // Rate-limited (hits Meta). Validates the POSTED values, not env (CP-17d).
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
    const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
    const businessAccountId = typeof body.businessAccountId === "string" ? body.businessAccountId.trim() : undefined;
    const result = await new WhatsAppCredentialService(repos).testConnection({ accessToken, phoneNumberId, businessAccountId });
    return json(result);
  }

  // ── D-2026-08-02-b / CP-18: per-workspace integration keys (SerpApi + Resend) ─
  // Single-key integrations. Owner/admin-gated (under "integrations" prefix →
  // owner RBAC). Rate-limited test. Per-workspace key overrides env.
  if (match(path, ["integrations", "credentials", ":provider"]) && request.method === "GET") {
    const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
    const provider = String(path[2] || "");
    if (provider !== "serpapi" && provider !== "resend") return json({ success: false, error: { code: "VALIDATION_ERROR", message: "Unknown integration provider." } }, 400);
    return json(await new IntegrationCredentialService(repos).getView(workspaceId, provider as "serpapi" | "resend"));
  }
  if (match(path, ["integrations", "credentials", ":provider"]) && request.method === "PUT") {
    const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
    const provider = String(path[2] || "");
    if (provider !== "serpapi" && provider !== "resend") return json({ success: false, error: { code: "VALIDATION_ERROR", message: "Unknown integration provider." } }, 400);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) return json({ success: false, error: { code: "VALIDATION_ERROR", message: "API key is required." } }, 400);
    await new IntegrationCredentialService(repos).save(workspaceId, provider as "serpapi" | "resend", apiKey);
    return json({ success: true });
  }
  // 2026-09-24 — remove a saved AI key that no slot uses. Owner-only (ai prefix).
  if (match(path, ["ai", "credentials", ":id"]) && request.method === "DELETE") {
    const { removeUnusedAICredential } = await import("@/services/AICredentialCleanupService");
    const result = await removeUnusedAICredential(workspaceId, path[2], repos);
    if (result.removed) {
      await safeAudit(repos, { workspaceId, userId: postActorUserId, action: "ai.credential.removed", entityType: "llm_provider_credential", entityId: path[2], newValuesJson: { removed: true } });
    }
    return json(result, result.removed ? 200 : 400);
  }
  if (match(path, ["integrations", "credentials", ":provider"]) && request.method === "DELETE") {
    const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
    const provider = String(path[2] || "");
    if (provider !== "serpapi" && provider !== "resend") return json({ success: false, error: { code: "VALIDATION_ERROR", message: "Unknown integration provider." } }, 400);
    await new IntegrationCredentialService(repos).clear(workspaceId, provider as "serpapi" | "resend");
    return json({ success: true });
  }
  if (match(path, ["integrations", "credentials", ":provider", "test"]) && request.method === "POST") {
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
    const provider = String(path[2] || "");
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (provider === "serpapi") return json(await new IntegrationCredentialService(repos).testSerpApi(apiKey));
    if (provider === "resend") return json(new IntegrationCredentialService(repos).testResend(apiKey));
    return json({ ok: false, status: "unknown_error", message: "Unknown integration provider." });
  }
  // Legacy connect endpoint kept for back-compat with any old callers.
  if (match(path, ["integrations", "connect"])) {
    return json({ ok: true, mode: "placeholder", message: "Integration interface is ready; MVP uses manual/mock providers." });
  }

  if (match(path, ["whatsapp-agent", "dry-run"])) {
    // S6 S-3: cap the WhatsApp conversation engine dry-run (LLM + retrieval + decision).
    const dryRunLimit = await checkRateLimit({ workspaceId, action: "whatsapp_dry_run" });
    if (!dryRunLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: dryRunLimit.reason, details: dryRunLimit } }, 429);
    return json(await handleIncomingWhatsAppMessage({
      workspaceId,
      leadId: body.leadId,
      phone: body.phone,
      rawText: String(body.rawText || ""),
      providerMessageId: body.providerMessageId,
      metadata: body.metadata || {},
    }, undefined, { dryRun: true }));
  }

  if (match(path, ["leads", ":id", "generate-policy"])) {
    // S6 S-3: cap PDF generation (CPU-bound).
    const pdfLimit = await checkRateLimit({ workspaceId, action: "policy_pdf" });
    if (!pdfLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: pdfLimit.reason, details: pdfLimit } }, 429);
    return json(await generatePolicyPdfForLead({
      workspaceId,
      leadId: path[1],
      title: typeof body.title === "string" ? body.title : undefined,
      customClauses: typeof body.customClauses === "string" ? body.customClauses : undefined,
    }, repos));
  }

  if (match(path, ["quotes", ":id", "generate-pdf"])) {
    // GAP-7 (2026-07-31): Quote PDF generation. Reuses the same PDF rate-limit
    // bucket + chokepoint as policy PDFs (CPU-bound, cap to control cost).
    const pdfLimit = await checkRateLimit({ workspaceId, action: "policy_pdf" });
    if (!pdfLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: pdfLimit.reason, details: pdfLimit } }, 429);
    return json(await generateQuotePdf({
      workspaceId,
      quoteId: path[1],
      title: typeof body.title === "string" ? body.title : undefined,
    }, repos));
  }

  if (match(path, ["whatsapp-agent", "llm-test"])) {
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);

    const parsed = whatsappLlmTestSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const { customerMessage, leadId, forceRealModel = false } = parsed.data;
    const startTime = Date.now();

    // 1. Load Fast Customer Reply slot routing
    const workspaceRoutes = await repos.llmModelRouting.listByWorkspace(workspaceId);
    const { routeModelSelection } = await import("@/llm/ModelRouter");
    const route = routeModelSelection("whatsapp_reply", workspaceRoutes);
    const slotDisplayName = "Fast Customer Reply Model";

    // 2. Validate credential availability
    const credentials = await repos.llmProviderCredential.listByWorkspace(workspaceId);
    const isRealProvider = route.provider !== "mock" && route.provider !== "ollama";
    const hasCredential = route.credentialId
      ? credentials.some((c) => c.id === route.credentialId && c.provider === route.provider)
      : Boolean(process.env[`PLATFORM_${route.provider.toUpperCase()}_API_KEY`]);

    if (forceRealModel && isRealProvider && !hasCredential) {
      return json({
        success: false,
        error: {
          code: "MISSING_API_KEY",
          message: `API key is required for provider "${route.provider}" but is not configured. Set it in AI Settings or as a platform environment variable.`,
          details: { provider: route.provider, slotKey: "fast_customer_reply", slotDisplayName },
        },
      }, 400);
    }

    // 3. Retrieve relevant knowledge
    const { getRelevantContext } = await import("@/services/KnowledgeBaseService");
    const context = await getRelevantContext(workspaceId, customerMessage, repos);
    const knowledgeChunksUsed = context.chunks.length;
    const retrievedKnowledgeSummary = context.chunks.length > 0
      ? context.chunks.map((c, i) => `[${i + 1}] ${c.chunkText.slice(0, 120)}...`).join(" | ")
      : "No relevant knowledge found in knowledge base.";

    // 4. Load WhatsApp settings
    const { getWhatsAppSettings } = await import("@/services/AISettingsService");
    const settings = await getWhatsAppSettings(workspaceId);

    // 5. Load business profile for context injection
    const profile = await repos.businessProfile.getByWorkspace(workspaceId);
    const companyName = profile?.companyName || "Our company";
    const companyDesc = profile?.description || "";

    // 6. Build enriched input for LLM (knowledge + message)
    const llmInput = {
      customerMessage,
      companyName,
      companyDescription: companyDesc,
      companyKnowledge: context.contextText || "No specific knowledge available.",
      knowledgeConfidence: context.confidenceScore,
      conversationMode: settings?.mode || "draft_only",
    };

    // 7. Call LLMService with real model + disableFallback if forceRealModel
    let llmResult: Awaited<ReturnType<InstanceType<typeof LLMService>["runTask"]>> | undefined;
    let llmError: string | undefined;
    let validationError: string | undefined;
    let parsedOutput: import("@/validation/schemas").WhatsAppLLMReplyOutput | undefined;

    try {
      const svc = new LLMService(undefined, repos);
      llmResult = await svc.runTask<Record<string, unknown>>("whatsapp_reply", llmInput, {
        workspaceId,
        disableFallback: forceRealModel,
      });

      // 8. Validate structured output
      const validated = WhatsAppLLMReplyOutputSchema.safeParse(llmResult.output);
      if (!validated.success) {
        validationError = `LLM output did not match expected schema: ${validated.error.issues.map((i) => i.message).join("; ")}`;
      } else {
        parsedOutput = validated.data;
      }
    } catch (err) {
      llmError = err instanceof Error ? err.message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ****") : "LLM call failed";
    }

    const latencyMs = Date.now() - startTime;
    // M3.7 / O5 audit fix: when the LLM call errored AND no result came back,
    // the previous code defaulted `mode` to "real" — dishonest. A crashed
    // call is not "real". Now we default to "mock" when there's no result,
    // regardless of whether an error was thrown. The error itself is still
    // surfaced in `llmError` and propagated to the response.
    const mode: "real" | "mock" | "fallback" = llmResult?.mode ?? "mock";
    const fallbackUsed = Boolean(llmResult?.fallbackUsed);
    const providerUsed = llmResult?.provider || route.provider;
    const modelNameUsed = llmResult?.modelName || route.modelName;
    const { PROVIDER_LABELS: PL } = await import("@/llm/provider-types");
    const providerDisplayName = (PL as Record<string, string>)[providerUsed] || providerUsed;

    // 9. If LLM failed or validation failed, return error
    if (llmError) {
      return json({
        success: false,
        error: { code: "LLM_FAILED", message: llmError, details: { provider: providerUsed, model: modelNameUsed, latencyMs } },
      }, 500);
    }
    if (validationError || !parsedOutput) {
      const agentRun = await repos.agentRun.create({
        workspaceId,
        agentName: llmResult?.agentName || "whatsapp_conversation_agent",
        input: { customerMessage, provider: providerUsed, model: modelNameUsed },
        status: "failed",
        startedAt: new Date().toISOString(),
      });
      await repos.agentRun.update(workspaceId, agentRun.id, { status: "failed", errorMessage: validationError || "Schema validation failed", completedAt: new Date().toISOString() });
      return json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: validationError || "LLM output failed structured validation.", details: { provider: providerUsed, model: modelNameUsed, latencyMs } },
      }, 422);
    }

    // 10. Resolve lead if provided
    const lead = leadId ? await repos.lead.getLeadById(workspaceId, leadId) : undefined;

    // 11. Run AutoReplyDecisionService (overrides LLM canAutoSend)
    const { decideAutoReply } = await import("@/services/AutoReplyDecisionService");
    const isGenericSafeReply = ["greeting", "catalogue_request"].includes(parsedOutput.classification);
    const decision = decideAutoReply({
      settings: settings ?? { id: "default", workspaceId, enabled: false, mode: "draft_only", createdAt: "", updatedAt: "" } as never,
      classification: {
        category: parsedOutput.classification as never,
        confidence: parsedOutput.confidenceScore,
        riskLevel: parsedOutput.riskLevel as never,
        requiresHumanReview: parsedOutput.needsHumanReview,
        reason: parsedOutput.reason,
        leadStatusSuggestion: parsedOutput.leadStatusSuggestion as never,
      },
      lead,
      hasSupportingKnowledge: context.confidenceScore >= 0.35,
      isGenericSafeReply,
    });

    // Policy note: LLM vs decision override
    const policyNote = parsedOutput.canAutoSend !== decision.canAutoSend
      ? `LLM suggested canAutoSend=${parsedOutput.canAutoSend}, policy decision overrides to canAutoSend=${decision.canAutoSend}.`
      : `LLM and policy agree on canAutoSend=${decision.canAutoSend}.`;

    // 12. Create AutoReplyLog
    const finalStatus = decision.blocked ? "blocked" : decision.canAutoSend ? "drafted" : "held_for_review";
    const autoReplyLog = await repos.autoReplyLog.create(workspaceId, {
      leadId: leadId,
      channel: "whatsapp",
      incomingMessage: customerMessage,
      retrievedContext: { confidenceScore: context.confidenceScore, chunks: context.chunks.map((c) => ({ id: c.id, score: c.score, documentTitle: c.documentTitle })) },
      classification: parsedOutput.classification,
      generatedReply: parsedOutput.suggestedReply,
      confidenceScore: parsedOutput.confidenceScore,
      canAutoSend: decision.canAutoSend,
      needsHumanReview: decision.needsHumanReview,
      reason: decision.reason,
      modelProvider: providerUsed,
      modelName: modelNameUsed || "unknown",
      status: `test_only_${finalStatus}` as never,
    });

    // 13. Create UnknownQuestion if knowledge is missing
    let unknownQuestionCreated = false;
    const shouldCreateUnknown = parsedOutput.missingKnowledge && ![
      "unsubscribe", "abusive_message", "not_interested"
    ].includes(parsedOutput.classification);
    if (shouldCreateUnknown && parsedOutput.missingQuestion) {
      await repos.unknownQuestion.create(workspaceId, {
        leadId,
        channel: "whatsapp",
        questionText: parsedOutput.missingQuestion || customerMessage,
        missingTopic: parsedOutput.classification,
        status: "open",
        suggestedAnswer: "I'll confirm this with our team and get back to you.",
      });
      unknownQuestionCreated = true;
    }

    // 14. Determine result status
    const isRealSuccess = mode === "real" && !fallbackUsed && providerUsed !== "mock";
    const isMockOrFallback = mode === "mock" || mode === "fallback" || fallbackUsed || providerUsed === "mock";

    return json({
      success: true,
      resultStatus: isRealSuccess ? "real_success" : isMockOrFallback ? "mock_or_fallback" : "unknown",
      data: {
        slotKey: "fast_customer_reply",
        slotDisplayName,
        provider: providerUsed,
        providerDisplayName,
        modelName: modelNameUsed || "unknown",
        effectiveModelName: llmResult?.modelName || modelNameUsed || "unknown",
        mode,
        fallbackUsed,
        customerMessage,
        classification: parsedOutput.classification,
        riskLevel: parsedOutput.riskLevel,
        retrievedKnowledgeSummary,
        knowledgeChunksUsed,
        knowledgeConfidenceScore: context.confidenceScore,
        suggestedReply: parsedOutput.suggestedReply,
        confidenceScore: parsedOutput.confidenceScore,
        canAutoSend: decision.canAutoSend,
        needsHumanReview: decision.needsHumanReview,
        blocked: decision.blocked,
        reason: decision.reason,
        policyNote,
        missingKnowledge: parsedOutput.missingKnowledge,
        missingQuestion: parsedOutput.missingQuestion,
        unknownQuestionCreated,
        leadStatusSuggestion: parsedOutput.leadStatusSuggestion,
        autoReplyLogId: autoReplyLog.id,
        agentRunId: llmResult?.runId || null,
        latencyMs,
        status: `test_only_${finalStatus}`,
        message: isRealSuccess
          ? `Real LLM responded via ${providerDisplayName} (${modelNameUsed}).`
          : `Mock or fallback was used. Provider: ${providerDisplayName}. Real LLM response was NOT confirmed.`,
        warning: isMockOrFallback ? "Mock or fallback provider was used. This is NOT a real LLM response." : undefined,
      },
    });
  }

  // CP-25 (2026-08-02) — WhatsApp message template CRUD. These are pre-approved
  // by Meta and are the ONLY way to message after the 24h window closes.
  if (match(path, ["whatsapp-templates"]) && request.method === "POST") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const tplBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!name || !tplBody) return json({ success: false, error: { code: "VALIDATION_ERROR", message: "Template name and body are required." } }, 400);
    return json(await repos.whatsAppTemplate.create(workspaceId, {
      name,
      body: tplBody,
      language: typeof body.language === "string" ? body.language : "en_US",
      category: typeof body.category === "string" ? body.category : "UTILITY",
      header: typeof body.header === "string" ? body.header : undefined,
      footer: typeof body.footer === "string" ? body.footer : undefined,
      status: "draft",
    }));
  }
  if (match(path, ["whatsapp-templates", ":id", "submit"])) {
    const tpl = await repos.whatsAppTemplate.getById(workspaceId, path[1]);
    if (!tpl) return notFoundResponse("Template not found");
    // Submit to Meta for approval (best-effort — Meta approval takes hours/days).
    // v1: mark as pending. The owner manually marks approved after Meta confirms.
    return json(await repos.whatsAppTemplate.update(workspaceId, path[1], { status: "pending" }));
  }
  if (match(path, ["whatsapp-templates", ":id", "approve"])) {
    // Manual approve (owner confirms Meta approved it).
    return json(await repos.whatsAppTemplate.update(workspaceId, path[1], { status: "approved" }));
  }

  if (match(path, ["knowledge", "documents"])) {
    // S6 S-3: cap knowledge-document create + auto-chunk.
    const docLimit = await checkRateLimit({ workspaceId, action: "knowledge_sync" });
    if (!docLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: docLimit.reason, details: docLimit } }, 429);
    const documentType = String(body.documentType || "other");
    const metadata = (body.metadata || {}) as Record<string, unknown>;
    const agentName = String(metadata.agentName || "").trim();
    if (documentType === "agent_instruction" || body.source === "workspace_override") await requireRole(request, "owner");
    if (body.source === "workspace_override" && documentType !== "agent_instruction") {
      return json({ success: false, error: { code: "INVALID_AGENT_GUIDANCE", message: "Save additional agent instructions from the Agent Instructions page." } }, 400);
    }
    // N-AI-12 (2026-08-27): agent instructions are an UPSERT, not an append.
    // This endpoint always created a new row, so saving instructions twice left
    // two rows and the loader obeyed the older one forever. One agent has
    // exactly one workspace override; the save path now says so.
    if (documentType === "agent_instruction") {
      if (!agentName || !AGENT_NAMES.some((name) => normalizeAgentName(name) === normalizeAgentName(agentName))) {
        return json({ success: false, error: { code: "INVALID_AGENT", message: "Choose an available agent before saving additional instructions." } }, 400);
      }
      const instructionText = String(body.contentText || "");
      // Check before changing the working guidance. If company knowledge cannot
      // be read, the request fails rather than silently skipping that check.
      const settledAnswers = await listKnowledgeQuestionAnswers(workspaceId, repos);
      const conflicts = checkAgentInstruction(instructionText, settledAnswers);
      if (conflicts.hasFindings) {
        const reasons = [...conflicts.lockedRuleConflicts.map((conflict) => conflict.rule), ...conflicts.knowledgeConflicts.map((conflict) => `Your saved answer to “${conflict.question}” is “${conflict.savedAnswer}”.`)];
        return json({ success: false, error: { code: "AGENT_GUIDANCE_CONFLICT", message: `These additional instructions were not saved. ${reasons.join(" ")} Update them and try again.`, details: { conflicts } } }, 409);
      }
      const saved = await saveAgentInstruction(workspaceId, agentName, instructionText, repos, {
        title: body.title ? String(body.title) : undefined,
        source: String(body.source || "workspace_override"),
        metadata,
      });
      return json({ document: saved.document, chunks: saved.chunks, replacedExisting: saved.replacedExisting, conflicts });
    }
    const document = await createKnowledgeDocument({
      workspaceId,
      title: String(body.title || "Untitled knowledge"),
      documentType,
      source: String(body.source || "manual"),
      contentText: String(body.contentText || ""),
      metadata: body.metadata || {},
    });
    const chunks = await chunkKnowledgeDocument(workspaceId, document.id);
    return json({ document, chunks });
  }
  if (match(path, ["knowledge", "structured-settings", "sync"])) {
    return json(await syncStructuredSettingsToQuestions(workspaceId, body.settings || {}, repos));
  }
  if (match(path, ["settings", "products", "draft"])) {
    return json(draftProductSettingsFromNotes(String(body.notes || "")));
  }
  if (match(path, ["settings", "draft-from-answer"])) {
    return json(draftStructuredSettingsFromAnswer({
      domainKey: typeof body.domainKey === "string" ? body.domainKey : undefined,
      relatedQuestionKeys: Array.isArray(body.relatedQuestionKeys) ? body.relatedQuestionKeys.map(String) : [],
      answer: String(body.answer || ""),
    }));
  }
  if (match(path, ["settings", "pending-drafts"])) {
    return json(await savePendingSettingsDraft(workspaceId, body, repos));
  }
  if (match(path, ["settings", "pending-drafts", ":id", "saved"])) {
    return json(await markPendingSettingsDraftSaved(workspaceId, path[2], repos));
  }
  if (match(path, ["settings", "pending-drafts", ":id", "discard"])) {
    return json(await discardPendingSettingsDraft(workspaceId, path[2], repos));
  }

  if (match(path, ["documents", "process"])) {
    // Session 4 audit fix: rate-limit document processing (triggers LLM extraction).
    const docLimit = await checkRateLimit({ workspaceId, action: "document_process" });
    if (!docLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: docLimit.reason, details: docLimit } }, 429);
    const title = String(body.title || "Untitled document");
    const contentText = String(body.contentText || "");
    const questionAnswering = await answerDocumentQuestions({
      workspaceId,
      documentText: contentText,
      documentMetadata: { title, sourceType: "document" },
    }, repos);
    const legacyPreview = await withTimeout(
      mapDocumentExtraction({
        workspaceId,
        title,
        documentType: String(body.documentType || "other"),
        contentText,
      }, repos),
      8000,
      fallbackDocumentPreview(title, String(body.documentType || "other"), contentText)
    );
    return json({ ...legacyPreview, questionAnswering });
  }

  if (match(path, ["documents", ":id", "extract-questions"])) {
    // S6 S-3: cap LLM document-question extraction.
    const exLimit = await checkRateLimit({ workspaceId, action: "document_extraction" });
    if (!exLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: exLimit.reason, details: exLimit } }, 429);
    const title = String(body.title || "Uploaded document");
    const contentText = String(body.contentText || "");
    return json(await answerDocumentQuestions({
      workspaceId,
      documentId: path[1],
      documentText: contentText,
      documentMetadata: { title, sourceType: "document" },
    }, repos));
  }

  if (match(path, ["extraction-runs", ":id", "retry-failed"])) {
    // S6 S-3: cap batch retry (re-runs LLM extraction on failed pages).
    const retryLimit = await checkRateLimit({ workspaceId, action: "document_extraction" });
    if (!retryLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: retryLimit.reason, details: retryLimit } }, 429);
    return json(await retryFailedKnowledgeExtractionBatches(workspaceId, path[1], repos));
  }

  if (match(path, ["extraction-runs", "cancel-active"])) {
    return json(await cancelActiveKnowledgeExtraction(workspaceId, repos));
  }

  if (match(path, ["documents", "apply"])) {
    // S6 S-3: cap extraction-apply (writes extracted facts across the KB).
    const applyLimit = await checkRateLimit({ workspaceId, action: "document_extraction" });
    if (!applyLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: applyLimit.reason, details: applyLimit } }, 429);
    return json(await applyDocumentExtraction({ workspaceId, preview: body.preview }, repos));
  }

  if (match(path, ["knowledge", "documents", ":id", "chunk"])) {
    const document = await getKnowledgeDocument(workspaceId, path[2]);
    if (document?.documentType === "agent_instruction" || document?.source === "workspace_override") await requireRole(request, "owner");
    return json(await chunkKnowledgeDocument(workspaceId, path[2]));
  }

  if (match(path, ["knowledge", "search"])) {
    // S6 S-3: cap knowledge retrieval (could be abused to enumerate/scan).
    const searchLimit = await checkRateLimit({ workspaceId, action: "knowledge_sync" });
    if (!searchLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: searchLimit.reason, details: searchLimit } }, 429);
    return json(await searchKnowledge(workspaceId, String(body.query || "")));
  }

  if (match(path, ["knowledge", "sync"]) && typeof body.questionKey === "string" && typeof body.answer === "string") {
    return json(await upsertKnowledgeEntry({
      workspaceId,
      questionKey: body.questionKey,
      domainKey: typeof body.domainKey === "string" ? body.domainKey : undefined,
      answer: body.answer,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    }, repos));
  }

  if (match(path, ["fallback", "resolve"])) {
    if (typeof body.questionKey !== "string" || typeof body.answer !== "string") {
      return validationErrorResponse({ fieldErrors: { questionKey: ["Required"], answer: ["Required"] }, formErrors: [] });
    }
    return json(await upsertKnowledgeEntry({
      workspaceId,
      questionKey: body.questionKey,
      domainKey: typeof body.domainKey === "string" ? body.domainKey : undefined,
      answer: body.answer,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
    }, repos));
  }

  if (match(path, ["knowledge", "sync"])) {
    // S6 S-3: cap the full workspace knowledge re-sync (expensive).
    const syncLimit = await checkRateLimit({ workspaceId, action: "knowledge_sync" });
    if (!syncLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: syncLimit.reason, details: syncLimit } }, 429);
    const summary = await syncWorkspaceKnowledge(workspaceId, repos);
    return json(summary);
  }

  // Cluster 3 fix (2026-07-26 audit, P0-7): the "Sync Knowledge" button on
  // the Profile tab targets /api/knowledge/sync-business-profile, which
  // previously did not exist → 404. The business profile is just another
  // knowledge source, so this delegates to the same workspace sync the KB
  // tab uses (the service already includes the approved profile). Pinned by
  // e2e/cluster3-buttons.spec.ts "Sync Knowledge on Profile does not 404".
  if (match(path, ["knowledge", "sync-business-profile"])) {
    // S6 S-3: same expensive full-sync cap as /knowledge/sync.
    const syncLimit = await checkRateLimit({ workspaceId, action: "knowledge_sync" });
    if (!syncLimit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: syncLimit.reason, details: syncLimit } }, 429);
    const summary = await syncWorkspaceKnowledge(workspaceId, repos);
    return json(summary);
  }

  if (match(path, ["knowledge", "question-answers", "approve-safe"])) {
    return json(await approveAllSafeKnowledgeAnswers(workspaceId, repos));
  }

  if (match(path, ["knowledge", "process-manual-answer"])) {
    return json(await processManualAnswer({
      workspaceId,
      answerText: String(body.answerText || ""),
      originalQuestionId: String(body.originalQuestionId || ""),
    }, repos));
  }

  if (match(path, ["unknown-questions", "groups", "answer"])) {
    const parsed = unknownQuestionGroupAnswerSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    return json(await answerUnknownQuestionGroup(
      workspaceId,
      parsed.data.questionIds,
      parsed.data.finalAnswer,
      Boolean(parsed.data.addToKnowledge),
      repos,
      { domainKey: parsed.data.domainKey, relatedQuestionKeys: parsed.data.relatedQuestionKeys },
    ));
  }

  if (match(path, ["unknown-questions", ":id", "answer"])) {
    const parsed = unknownQuestionAnswerSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    return json(await answerUnknownQuestion(workspaceId, path[1], String(body.finalAnswer || ""), Boolean(body.addToKnowledge), repos));
  }

  if (match(path, ["unknown-questions", ":id", "add-to-knowledge"])) {
    return json(await addUnknownQuestionToKnowledge(workspaceId, path[1], repos));
  }

  // === 2026-07-21 (Cluster A fix B3, session 16) — Convert-to-Ticket endpoints.
  // The convertToTicket pure helper has existed + been golden-tested since
  // session 8, but had NO route to invoke it. These endpoints close that gap.
  // Per docs/LOGIC.md Batch 1 Q5: source is linked via sourceEntityType +
  // sourceEntityId on the Ticket; double-convert throws; status starts "open".
  if (match(path, ["unknown-questions", ":id", "convert"]) && request.method === "POST") {
    // 2026-09-26 (break test): two clicks at once both saw "not converted
    // yet" and made two tickets. Conversions of one item run one at a time.
    return oneAtATime(`ticket-convert:${workspaceId}:${path[1]}`, async () => {
      const { convertToTicket } = await import("@/services/TicketService");
      const { defaultTicketSlaSettings } = await import("@/lib/ticket-sla");
      // Cluster E fix (2026-07-21 session 20): actor from session, not body.
      const { resolveActor } = await import("./workspace-resolution");
      const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
      const source = await repos.unknownQuestion.getById(workspaceId, path[1]);
      if (!source) return notFoundResponse("Unknown question not found");
      let slaSettings = await repos.ticketSlaSettings.getByWorkspace(workspaceId);
      if (!slaSettings) {
        // defaultTicketSlaSettings returns a full TicketSlaSettings-shaped object;
        // upsertForWorkspace accepts Partial, so we spread to drop the literal cast.
        const defaults = defaultTicketSlaSettings(workspaceId);
        slaSettings = await repos.ticketSlaSettings.upsertForWorkspace(workspaceId, { ...defaults });
      }
      try {
        const draft = await convertToTicket({
          source: { entity: "unknown_question", record: source },
          type: body?.type || "question",
          priority: body?.priority || "medium",
          slaSettings,
        });
        // Cluster 6 fix (P1-6): wrap the 3 writes (ticket create + unknown-
        // question update + ticket-event create) in ONE atomic transaction.
        // The OLD code did them as 3 separate writes — a crash after the ticket
        // create left an orphan ticket with no source link + no creation event.
        // Now all 3 commit together or none does.
        //
        // 2026-07-26 Session 4 audit fix (P0-2): same split-brain as the
        // quote→order conversion. runInTransaction's only adapter is JSON-file.
        // Branch on the provider so Prisma mode actually writes to Postgres.
        // Prisma-mode cross-collection atomicity is the same documented known
        // limitation as Cluster F (each per-repo op is atomic; a crash between
        // them could leave a ticket without the source marker — caught by the
        // idempotency check above).
        const { sourcePatch, ...ticketFields } = draft;
        void sourcePatch;
        let saved: typeof ticketFields;
        if (getPersistenceProvider() === "json") {
          const { runInTransaction } = await import("@/lib/run-in-transaction");
          const { uid: uidHelper, timestamp: tsHelper } = await import("@/lib/db");
          saved = await runInTransaction(async (data) => {
            // Allocate ticket number the same way the JSON repo does (max + 1).
            if (!data.tickets) data.tickets = [];
            if (!data.ticketEvents) data.ticketEvents = [];
            const existingTickets = data.tickets.filter((r: Ticket) => r.workspaceId === workspaceId);
            const ticketNumber = existingTickets.reduce((acc: number, r: Ticket) => Math.max(acc, Number(r.ticketNumber || 0)), 0) + 1;
            const newTicket = { ...ticketFields, id: ticketFields.id || uidHelper("ticket"), ticketNumber } as typeof ticketFields;
            data.tickets.push(newTicket);
            // Mark the source converted in the SAME transaction.
            data.unknownQuestions = (data.unknownQuestions || []).map((q: UnknownQuestion) =>
              q.id === path[1] && q.workspaceId === workspaceId
                ? { ...q, convertedToTicketId: newTicket.id, updatedAt: tsHelper() }
                : q,
            );
            // Creation event in the SAME transaction.
            data.ticketEvents.push({
              id: uidHelper("ticketEvent"),
              workspaceId,
              ticketId: newTicket.id,
              eventType: "created",
              actorType: "owner",
              actorUserId,
              note: `Converted from UnknownQuestion ${path[1]}.`,
              createdAt: tsHelper(),
            } as TicketEvent);
            return newTicket;
          });
        } else {
          // Prisma mode: per-collection repos. Atomic per-repo; cross-collection
          // atomicity is the documented Cluster F limitation.
          const ticketRepo = repos.ticket as unknown as {
            createWithNextTicketNumber?: (input: typeof ticketFields) => Promise<typeof ticketFields>;
            nextTicketNumber: (ws: string) => Promise<number>;
            create: (input: typeof ticketFields & { ticketNumber: number }) => Promise<typeof ticketFields>;
          };
          if (typeof ticketRepo.createWithNextTicketNumber === "function") {
            saved = await ticketRepo.createWithNextTicketNumber(ticketFields);
          } else {
            const ticketNumber = await ticketRepo.nextTicketNumber(workspaceId);
            saved = await ticketRepo.create({ ...ticketFields, ticketNumber });
          }
          await repos.unknownQuestion.update(workspaceId, path[1], { convertedToTicketId: saved.id });
          await repos.ticketEvent.create({
            workspaceId, ticketId: saved.id, eventType: "created",
            actorType: "owner", actorUserId,
            note: `Converted from UnknownQuestion ${path[1]}.`,
          });
        }
        return json(saved);
      } catch (conversionError) {
        const message = conversionError instanceof Error ? conversionError.message : String(conversionError);
        const status = /already been converted|converted/i.test(message) ? 409 : 422;
        return json({ success: false, error: { code: status === 409 ? "CONFLICT" : "VALIDATION_ERROR", message } }, status);
      }
    });
  }

  if (match(path, ["human-fallback-tasks", ":id", "convert"]) && request.method === "POST") {
    // 2026-09-26 (break test): two clicks at once both saw "not converted
    // yet" and made two tickets. Conversions of one item run one at a time.
    return oneAtATime(`ticket-convert:${workspaceId}:${path[1]}`, async () => {
      // HumanFallbackTask has no dedicated repository yet — fetch via the bundle's
      // readAll (provider-aware) + update via mutateAll (provider-aware). Pre-fix
      // this used readData/mutateData directly, which only writes the JSON file —
      // in Prisma mode the source record was never marked converted (silent
      // split-brain, 2026-07-26 Session 4 audit P0-2). When a real repo lands,
      // swap the readAll/mutateAll calls for it.
      const { convertToTicket } = await import("@/services/TicketService");
      const { defaultTicketSlaSettings } = await import("@/lib/ticket-sla");
      // Cluster E fix (2026-07-21 session 20): actor from session, not body.
      const { resolveActor } = await import("./workspace-resolution");
      const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
      const source = ((await repos.readAll!()).humanFallbackTasks || []).find((t) => t.workspaceId === workspaceId && t.id === path[1]);
      if (!source) return notFoundResponse("Human fallback task not found");
      let slaSettings = await repos.ticketSlaSettings.getByWorkspace(workspaceId);
      if (!slaSettings) {
        const defaults = defaultTicketSlaSettings(workspaceId);
        slaSettings = await repos.ticketSlaSettings.upsertForWorkspace(workspaceId, { ...defaults });
      }
      try {
        const draft = await convertToTicket({
          source: { entity: "human_fallback_task", record: source },
          type: body?.type || "request",
          priority: body?.priority || "medium",
          slaSettings,
        });
        // F-DATA-4 (2026-08-04): wrap the 3 writes (ticket create + human-
        // fallback-task update + ticket-event create) in ONE atomic transaction,
        // mirroring the sibling unknown-questions/:id/convert route (Cluster 6
        // P1-6 fix). The OLD code did them as 3 separate awaits — a crash after
        // the ticket create left an orphan ticket with no source link + no
        // creation event. Same split-brain fix as P0-2: branch on the provider so
        // Prisma mode writes to Postgres, not the JSON file.
        const { sourcePatch, ...ticketFields } = draft;
        void sourcePatch; // applied via mutateAll/runInTransaction below.
        let saved: typeof ticketFields;
        if (getPersistenceProvider() === "json") {
          const { runInTransaction } = await import("@/lib/run-in-transaction");
          const { uid: uidHelper, timestamp: tsHelper } = await import("@/lib/db");
          saved = await runInTransaction(async (data) => {
            if (!data.tickets) data.tickets = [];
            if (!data.ticketEvents) data.ticketEvents = [];
            const existingTickets = data.tickets.filter((r: Ticket) => r.workspaceId === workspaceId);
            const ticketNumber = existingTickets.reduce((acc: number, r: Ticket) => Math.max(acc, Number(r.ticketNumber || 0)), 0) + 1;
            const newTicket = { ...ticketFields, id: ticketFields.id || uidHelper("ticket"), ticketNumber } as typeof ticketFields;
            data.tickets.push(newTicket);
            // Mark the source converted in the SAME transaction.
            if (data.humanFallbackTasks) {
              data.humanFallbackTasks = data.humanFallbackTasks.map((t) =>
                t.id === path[1] && t.workspaceId === workspaceId
                  ? { ...t, convertedToTicketId: newTicket.id, updatedAt: tsHelper() }
                  : t,
              );
            }
            // Creation event in the SAME transaction.
            data.ticketEvents.push({
              id: uidHelper("ticketEvent"),
              workspaceId,
              ticketId: newTicket.id,
              eventType: "created",
              actorType: "owner",
              actorUserId,
              note: `Converted from HumanFallbackTask ${path[1]}.`,
              createdAt: tsHelper(),
            } as TicketEvent);
            return newTicket;
          });
        } else {
          // Prisma mode: per-collection repos. Atomic per-repo; cross-collection
          // atomicity is the documented Cluster F limitation (same as the
          // sibling route). The idempotency check above catches retries.
          const ticketRepo = repos.ticket as unknown as {
            createWithNextTicketNumber?: (input: typeof ticketFields) => Promise<typeof ticketFields>;
            nextTicketNumber: (ws: string) => Promise<number>;
            create: (input: typeof ticketFields & { ticketNumber: number }) => Promise<typeof ticketFields>;
          };
          if (typeof ticketRepo.createWithNextTicketNumber === "function") {
            saved = await ticketRepo.createWithNextTicketNumber(ticketFields);
          } else {
            const ticketNumber = await ticketRepo.nextTicketNumber(workspaceId);
            saved = await ticketRepo.create({ ...ticketFields, ticketNumber });
          }
          // Mark the source converted via mutateAll (provider-aware).
          await repos.mutateAll!((data) => {
            const task = (data.humanFallbackTasks || []).find((t) => t.id === path[1]);
            if (task) {
              task.convertedToTicketId = saved.id;
              task.updatedAt = new Date().toISOString();
            }
            return task;
          });
          await repos.ticketEvent.create({
            workspaceId, ticketId: saved.id, eventType: "created",
            actorType: "owner", actorUserId,
            note: `Converted from HumanFallbackTask ${path[1]}.`,
          });
        }
        return json(saved);
      } catch (conversionError) {
        const message = conversionError instanceof Error ? conversionError.message : String(conversionError);
        const status = /already been converted|converted/i.test(message) ? 409 : 422;
        return json({ success: false, error: { code: status === 409 ? "CONFLICT" : "VALIDATION_ERROR", message } }, status);
      }
    });
  }

  if (match(path, ["auto-reply-logs", ":id", "approve"])) {
    // A-1 (Session 7, 2026-07-28): thread the REAL session user as the audit
    // actor. Previously this omitted actorUserId, so the audit log recorded the
    // literal string "owner" instead of which owner approved (a non-repudiation
    // gap). Now resolveActor returns the authenticated user in production and
    // the demo hint otherwise — same pattern as the other POST handlers.
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, typeof body.actorUserId === "string" ? body.actorUserId : undefined)).userId;
    // F-API-1 (2026-08-04): forward the owner-selected WhatsApp template so a
    // closed-24h-window approve actually reaches Meta's template API. The
    // service (AutoReplyReviewService.sendApprovedReply) already consumes
    // templateName/templateLanguage and routes to sendTemplateMessage — the
    // route was just dropping them.
    return json(await approveAutoReplyLog(workspaceId, path[1], {
      body: typeof body.body === "string" ? body.body : undefined,
      mediaAttachmentId: typeof body.mediaAttachmentId === "string" ? body.mediaAttachmentId : undefined,
      templateName: typeof body.templateName === "string" && body.templateName ? body.templateName : undefined,
      templateLanguage: typeof body.templateLanguage === "string" && body.templateLanguage ? body.templateLanguage : undefined,
    }, repos, actorUserId));
  }

  if (match(path, ["auto-reply-logs", ":id", "reject"])) {
    // F14 (2026-08-04 CONTINUOUS-2 audit): thread the session-resolved actor
    // into the reject path. The sibling APPROVE route resolves the actor via
    // resolveActor + threads it through; the reject route was not updated to
    // match, so the "message.rejected" audit row always said "owner". Optional
    // reason from the body (single-lead reject PromptModal) is passed through.
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, typeof body?.actorUserId === "string" ? body.actorUserId : undefined)).userId;
    const reason = (typeof body?.reason === "string" && body.reason.trim()) ? { reason: body.reason.trim().slice(0, 500) } : undefined;
    return json(await rejectAutoReplyLog(workspaceId, path[1], repos, reason, actorUserId));
  }

  // 2026-09-29 (walk-through R2) — "I sent it myself" on an approved reply that
  // did not reach the customer.
  if (match(path, ["auto-reply-logs", ":id", "sent-by-me"]) && request.method === "POST") {
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, undefined)).userId;
    const { markReplySentByOwner } = await import("@/services/AutoReplyReviewService");
    return json(await markReplySentByOwner(workspaceId, path[1], repos, actorUserId));
  }
  // 2026-08-05 (UX Fix 1) — save the operator's internal note on a reply.
  // 2026-09-28 — "looked fine / should not have sent" on a reply the AI sent by
  // itself. Feeds the trial; "should not have sent" switches that kind off.
  if (match(path, ["auto-reply-logs", ":id", "mark"]) && request.method === "POST") {
    const { markAutomaticReply } = await import("@/services/AutoReplyTrialService");
    return json(await markAutomaticReply(workspaceId, path[1], body?.verdict, repos));
  }
  // 2026-09-28 — the owner has read the "switched off" notice.
  if (match(path, ["whatsapp-agent", "auto-reply-paused", ":topic", "seen"]) && request.method === "POST") {
    const { acknowledgePause } = await import("@/services/AutoReplyTrialService");
    return json(await acknowledgePause(workspaceId, path[2], repos));
  }
  if (match(path, ["auto-reply-logs", ":id", "note"]) && request.method === "POST") {
    const note = typeof body?.note === "string" ? body.note.slice(0, 2000) : "";
    const updated = await repos.autoReplyLog.updateNote(workspaceId, path[1], note);
    return json({ ok: true, log: updated });
  }

  if (match(path, ["settings", "conflicts", ":id", "resolve"])) {
    const { resolution, customValue, reason } = body;
    // F-UI-3 (depth-audit 2026-07-29): the conflict id is at path[2], NOT
    // path[1]. The pattern ["settings","conflicts",":id","resolve"] puts the
    // id at index 2; path[1] is the literal "conflicts". The old code passed
    // "conflicts" as the id → every resolution 404'd (the whole conflict-
    // resolution UI was dead). Now uses the correct index.
    return json(await resolveSettingsConflict(workspaceId, path[2], resolution, customValue, reason, repos));
  }

  if (match(path, ["settings", "conflicts", ":id", "ignore"])) {
    // F-UI-3: same off-by-one as resolve — id is at path[2].
    return json(await repos.settingsConflict.ignore(workspaceId, path[2]));
  }

  // === 2026-07-21 (M6) — Tickets mutations ===
  // === Stage 5 / WP3 (2026-07-28) — Platform tickets: USER-SIDE writes ===
  // RBAC (admin+) is applied by enforceAuthGate via the "platform-tickets" entry
  // in rbac-map.ts. The service re-checks the role + block status (defense in
  // depth). No-auto-outreach: none of these sends anything to anyone.
  if (match(path, ["platform-tickets"]) && request.method === "POST") {
    const { createPlatformTicket } = await import("@/services/PlatformTicketService");
    const user = await resolveCurrentUser(request);
    const parsed = platformTicketCreateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // Stage 5 / WP3 (2026-07-28): a platform ticket is scoped to the CALLER's
    // workspace (the session), NEVER the body's workspaceId. This matches the
    // GET /platform-tickets resolution (resolveWorkspaceId) and closes the
    // demo-mode inconsistency where handlePost's `workspaceId` falls back to
    // body.workspaceId. The schema doesn't even accept workspaceId — we resolve
    // it server-side so a user can't file a ticket into another tenant's queue.
    const sessionWorkspaceId = await resolveWorkspaceId(request);
    const floodLimit = await checkRateLimit({ workspaceId: sessionWorkspaceId, userId: user.id, action: "platform_ticket_create" });
    if (!floodLimit.allowed) return json({ error: { code: "RATE_LIMITED", message: floodLimit.reason } }, 429);
    const ticket = await createPlatformTicket({
      workspaceId: sessionWorkspaceId,
      raisedByUserId: user.id,
      creatorRole: user.role,
      subject: parsed.data.subject,
      description: parsed.data.description,
      category: parsed.data.category,
      priority: parsed.data.priority,
    });
    return json(ticket, 201);
  }
  if (match(path, ["platform-tickets", ":id", "comments"]) && request.method === "POST") {
    const { addPlatformTicketComment } = await import("@/services/PlatformTicketService");
    const user = await resolveCurrentUser(request);
    if (user.role !== "owner" && user.role !== "admin") return json({ error: "Forbidden" }, 403);
    // Stage 5 re-audit F-P3-3 (2026-07-28): rate-limit user-side comments
    // (was uncapped — asymmetry vs the capped create route). A stolen cookie
    // could append unlimited comments + ping the operator inbox. Keyed by
    // user.id (30/hour). Pinned by golden:stage5-batch4-chokepoints CASE 12.
    const commentLimit = await checkRateLimit({ workspaceId, userId: user.id, action: "platform_ticket_comment" });
    if (!commentLimit.allowed) return json({ error: { code: "RATE_LIMITED", message: commentLimit.reason } }, 429);
    const ticket = await repos.platformTicket.getForUser(workspaceId, path[1]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    const parsed = platformTicketCommentSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const result = await addPlatformTicketComment({
      ticketId: path[1],
      actorType: "user",
      actorUserId: user.id,
      note: parsed.data.note,
    });
    return json(result);
  }
  if (match(path, ["platform-tickets", ":id", "status"]) && request.method === "POST") {
    // User-side: a user can close/reopen their OWN ticket. Operator-side moves
    // use /admin/platform-tickets/:id/* (separate auth).
    const { changePlatformTicketStatus } = await import("@/services/PlatformTicketService");
    const user = await resolveCurrentUser(request);
    if (user.role !== "owner" && user.role !== "admin") return json({ error: "Forbidden" }, 403);
    // Stage 5 re-audit F-P3-3 (2026-07-28): rate-limit user-side status moves.
    const statusLimit = await checkRateLimit({ workspaceId, userId: user.id, action: "platform_ticket_status" });
    if (!statusLimit.allowed) return json({ error: { code: "RATE_LIMITED", message: statusLimit.reason } }, 429);
    const ticket = await repos.platformTicket.getForUser(workspaceId, path[1]);
    if (!ticket) return json({ error: "Ticket not found" }, 404);
    const parsed = platformTicketStatusSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const updated = await changePlatformTicketStatus({
      ticketId: path[1],
      toStatus: parsed.data.toStatus,
      actorType: "user",
      actorUserId: user.id,
      note: parsed.data.note,
    });
    return json(updated);
  }

  if (match(path, ["tickets"]) && request.method === "POST") {
    // 2026-07-21 (Thread 2): create a ticket manually (for testing + future
    // manual ticket creation UI). Uses the same service the WhatsApp engine uses.
    // F6 (2026-08-04 CONTINUOUS-2 audit): validate leadId belongs to this
    // workspace before persisting (D-2026-08-04-m). Mirrors the order/quote
    // POST checks above + the F-API-3 reply fix.
    if (typeof body?.leadId === "string" && body.leadId.trim()) {
      const lead = await repos.lead.getLeadById(workspaceId, body.leadId.trim());
      if (!lead) return json({ success: false, error: { code: "LEAD_NOT_FOUND", message: "The selected lead was not found in your workspace." } }, 404);
    }
    // N-P1-2 (2026-08-07): the ticket-to-order/quote link is optional, but if
    // given it must belong to this workspace — same F6 pattern as leadId.
    if (typeof body?.orderId === "string" && body.orderId.trim()) {
      const order = await repos.order.getById(workspaceId, body.orderId.trim());
      if (!order) return json({ success: false, error: { code: "ORDER_NOT_FOUND", message: "The selected order was not found in your workspace." } }, 404);
    }
    if (typeof body?.quoteId === "string" && body.quoteId.trim()) {
      const quote = await repos.quote.getById(workspaceId, body.quoteId.trim());
      if (!quote) return json({ success: false, error: { code: "QUOTE_NOT_FOUND", message: "The selected quote was not found in your workspace." } }, 404);
    }
    const { createTicketFromInbound } = await import("@/services/TicketService");
    const ticket = await createTicketFromInbound({
      workspaceId,
      leadId: body?.leadId,
      orderId: typeof body?.orderId === "string" && body.orderId.trim() ? body.orderId.trim() : undefined,
      quoteId: typeof body?.quoteId === "string" && body.quoteId.trim() ? body.quoteId.trim() : undefined,
      sourceChannel: body?.sourceChannel || "manual",
      type: body?.type || "question",
      priority: body?.priority || "medium",
      subject: body?.subject || "(no subject)",
      description: body?.description || "",
      // Cluster 4 fix (P1-1 / F1): use the SESSION-resolved actor, not the
      // body-supplied actorUserId (forgery vector — a sales_member could
      // stamp any user as the ticket creator).
      createdBy: postActorUserId,
    }, repos);
    return json(ticket);
  }
  if (match(path, ["tickets", ":id", "closure-draft"]) && request.method === "POST") {
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, undefined)).userId;
    const { saveTicketClosureDraft } = await import("@/services/TicketClosureService");
    return json(await saveTicketClosureDraft(workspaceId, path[1], {
      body: body.body, replaceExisting: body.replaceExisting, actorUserId,
    }, repos));
  }
  if (match(path, ["tickets", ":id", "status"])) {
    const { toStatus, actorUserId: bodyActor, actorType, note } = body || {};
    if (!toStatus) return validationErrorResponse("toStatus is required");
    if (note !== undefined && (typeof note !== "string" || note.length > 5000)) {
      return validationErrorResponse("The outcome note must be text of at most 5,000 characters.");
    }
    // F-API-6 (2026-08-04): validate toStatus against the TicketStatus union.
    // The orders/:id/status + quotes/:id/status routes already do this; the
    // ticket route accepted ANY string and wrote it straight into patch.status.
    // A caller could stamp "closed" on an open ticket, skipping the
    // firstRespondedAt + resolved/closed timestamps changeTicketStatus sets
    // conditionally. Mirror the order/quote enum gate.
    const VALID_TICKET_STATUSES = ["open", "in_progress", "waiting_customer", "resolved", "closed", "reopened"] as const;
    if (!(VALID_TICKET_STATUSES as readonly string[]).includes(String(toStatus))) {
      return validationErrorResponse(`toStatus must be one of: ${VALID_TICKET_STATUSES.join(", ")}`);
    }
    // Cluster E fix (2026-07-21 session 20): actor from session, not body.
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, bodyActor)).userId;
    // Import locally to avoid touching the top-level import block.
    const { changeTicketStatus } = await import("@/services/TicketService");
    const updated = await changeTicketStatus(workspaceId, path[1], toStatus, {
      userId: actorUserId,
      actorType: actorType || "owner",
      note,
    }, repos);
    return json(updated);
  }
  if (match(path, ["tickets", ":id", "assign"])) {
    const { assignedTo, actorUserId: bodyActor } = body || {};
    // Cluster E fix (2026-07-21 session 20): actor from session, not body.
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, bodyActor)).userId;
    // 2026-09-26 (break test): only active team members can be assigned.
    const { assignTicketToMember } = await import("@/services/TicketService");
    return json(await assignTicketToMember(workspaceId, path[1], assignedTo, actorUserId, repos));
  }

  // === 2026-07-26 Session 4 audit fix (P2-DESIGN-1) — operator-controlled
  // business hours. Operator directive: "the business hours will be actually
  // set by the user. As the customer wants to put seven days, it will be seven
  // days. If a customer wants six days, it will be six days." This route lets
  // the owner edit the SLA clock window + clock mode per workspace. The GET
  // already exists at /tickets/sla-settings (line 411); this is the matching
  // PUT. Owner-only per the prefix map (tickets = sales_member, but
  // sla-settings is admin-config — gate explicitly here).
  // 2026-09-30 — save the company's festival rules; they become closed days,
  // which move every reply deadline, so owner-only like the ticket clock.
  // 2026-09-30 — the "festival coming" card: set a reminder per customer, or
  // not this year. Sends nothing to anyone.
  if (match(path, ["festivals", "prompts", ":key", "remind"]) && request.method === "POST") {
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, undefined)).userId;
    const { remindForFestival } = await import("@/services/FestivalSeasonService");
    return json(await remindForFestival(workspaceId, path[2], repos, actorUserId));
  }
  if (match(path, ["festivals", "prompts", ":key", "skip"]) && request.method === "POST") {
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, undefined)).userId;
    const { skipFestival } = await import("@/services/FestivalSeasonService");
    return json(await skipFestival(workspaceId, path[2], repos, actorUserId));
  }
  if (match(path, ["festivals", "rules"]) && request.method === "POST") {
    try {
      await requireRole(request, "owner");
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
      }
      throw error;
    }
    const { saveFestivalRules } = await import("@/services/FestivalCalendarService");
    return json(await saveFestivalRules(workspaceId, body?.rules, repos));
  }
  if (match(path, ["tickets", "sla-settings"]) && request.method === "POST") {
    // Owner-only: changing the SLA clock affects every ticket's due-date
    // computation. Tighter than the tickets prefix default (sales_member).
    // requireRole throws AuthorizationError on insufficient role; convert to 403.
    try {
      await requireRole(request, "owner");
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
      }
      throw error;
    }
    const { clockMode, businessHoursStart, businessHoursEnd, businessDays,
            urgentSlaMinutes, highSlaMinutes, mediumSlaMinutes, lowSlaMinutes,
            assignmentMode, assignmentRules, closedDates } = body || {};
    // Validate the inputs minimally. Sla minutes must be positive integers;
    // businessDays is an array of ISO weekday numbers (1-7); times are HH:MM.
    if (clockMode && !["business_hours", "always_24_7", "mixed"].includes(clockMode)) {
      return validationErrorResponse("clockMode must be one of: business_hours, always_24_7, mixed");
    }
    if (businessDays !== undefined) {
      if (!Array.isArray(businessDays) || businessDays.some((d: unknown) => typeof d !== "number" || d < 1 || d > 7 || !Number.isInteger(d))) {
        return validationErrorResponse("businessDays must be an array of integers 1-7 (Mon-Sun)");
      }
    }
    for (const [key, value] of Object.entries({ urgentSlaMinutes, highSlaMinutes, mediumSlaMinutes, lowSlaMinutes })) {
      // 2026-09-26 (break test): capped at one year — a huge number made every
      // new ticket's deadline an invalid date (a crash on ticket creation).
      if (value !== undefined && (typeof value !== "number" || value <= 0 || !Number.isFinite(value) || value > 525_600)) {
        return validationErrorResponse(`${key} must be a positive number of minutes, at most one year (525600)`);
      }
    }
    // Session 55: assignmentMode and assignmentRules were the only fields of
    // TicketSlaSettings this route did not accept. `assignTicket` implements
    // all three modes and is called on every ticket create, but with no way to
    // leave "manual" the auto_rule and round_robin branches were unreachable
    // in every workspace — a ticket raised from a customer complaint could
    // never be routed to anybody.
    if (assignmentMode !== undefined && !["manual", "auto_rule", "round_robin"].includes(assignmentMode)) {
      return validationErrorResponse("assignmentMode must be one of: manual, auto_rule, round_robin");
    }
    if (assignmentRules !== undefined) {
      if (!Array.isArray(assignmentRules)) {
        return validationErrorResponse("assignmentRules must be an array");
      }
      // A rule pointing at somebody who is not active staff would send the
      // ticket nowhere and report success, so the ids are checked here rather
      // than discovered when a customer is waiting.
      const activeStaff = await repos.workspace.listActiveStaffForWorkspace(workspaceId);
      const staffIds = new Set(activeStaff.map((member) => member.userId).filter(Boolean));
      for (const [index, rule] of assignmentRules.entries()) {
        if (!rule || typeof rule !== "object") {
          return validationErrorResponse(`assignmentRules[${index}] must be an object`);
        }
        const assignToUserId = (rule as { assignToUserId?: unknown }).assignToUserId;
        if (typeof assignToUserId !== "string" || !assignToUserId.trim()) {
          return validationErrorResponse(`assignmentRules[${index}].assignToUserId is required`);
        }
        if (!staffIds.has(assignToUserId)) {
          return validationErrorResponse(`assignmentRules[${index}].assignToUserId is not active staff in this workspace`);
        }
        const ruleMatch = (rule as { match?: unknown }).match;
        if (ruleMatch !== undefined) {
          if (typeof ruleMatch !== "object" || ruleMatch === null || Array.isArray(ruleMatch)) {
            return validationErrorResponse(`assignmentRules[${index}].match must be an object`);
          }
          const allowed = ["sourceChannel", "priority", "type"];
          for (const key of Object.keys(ruleMatch)) {
            if (!allowed.includes(key)) {
              return validationErrorResponse(`assignmentRules[${index}].match.${key} is not a matchable field (allowed: ${allowed.join(", ")})`);
            }
          }
        }
      }
    }
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (businessHoursStart !== undefined && !timeRegex.test(String(businessHoursStart))) {
      return validationErrorResponse("businessHoursStart must be HH:MM (24-hour)");
    }
    if (businessHoursEnd !== undefined && !timeRegex.test(String(businessHoursEnd))) {
      return validationErrorResponse("businessHoursEnd must be HH:MM (24-hour)");
    }
    // Merge with existing settings (caller may send only the fields they want
    // to change). Falls back to defaults for any missing field on a fresh
    // workspace so the upsert always has a complete record.
    const { defaultTicketSlaSettings, slaSettingsProblem, tidyClosedDates } = await import("@/lib/ticket-sla");
    const existing = await repos.ticketSlaSettings.getByWorkspace(workspaceId);
    const base = existing || defaultTicketSlaSettings(workspaceId);
    const merged = {
      ...base,
      // 2026-09-28 (M10): the company's closed dates (holidays).
      ...(closedDates !== undefined ? { closedDates } : {}),
      ...(clockMode !== undefined ? { clockMode } : {}),
      ...(businessHoursStart !== undefined ? { businessHoursStart } : {}),
      ...(businessHoursEnd !== undefined ? { businessHoursEnd } : {}),
      ...(businessDays !== undefined ? { businessDays } : {}),
      ...(urgentSlaMinutes !== undefined ? { urgentSlaMinutes } : {}),
      ...(highSlaMinutes !== undefined ? { highSlaMinutes } : {}),
      ...(mediumSlaMinutes !== undefined ? { mediumSlaMinutes } : {}),
      ...(lowSlaMinutes !== undefined ? { lowSlaMinutes } : {}),
      ...(assignmentMode !== undefined ? { assignmentMode } : {}),
      ...(assignmentRules !== undefined ? { assignmentRules } : {}),
    };
    // 2026-09-28: refuse settings the clock cannot use — no working days, a
    // day that ends before it starts, a closed "date" that is not a date — in
    // words the owner can act on (NeedsActionError is shown as written).
    const problem = slaSettingsProblem(merged);
    if (problem) throw new NeedsActionError(problem, 400);
    if (Array.isArray(merged.closedDates)) merged.closedDates = tidyClosedDates(merged.closedDates);
    const saved = await repos.ticketSlaSettings.upsertForWorkspace(workspaceId, merged);
    return json(saved);
  }

  // === 2026-07-21 (M7) — Orders + Quotes mutations ===
  if (match(path, ["orders"]) && request.method === "POST") {
    // Cluster C fix (2026-07-21 session 19): validate lineItems via zod.
    // Previously body.lineItems was raw + unvalidated, allowing negative
    // qty/price (negative totals) or thousands of items (DoS).
    const { orderCreateSchema } = await import("@/validation/schemas");
    const parsed = orderCreateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // F6 (2026-08-04 CONTINUOUS-2 audit): validate the leadId belongs to this
    // workspace before persisting (D-2026-08-04-m). Same orphan family as
    // F-API-3 (replies) / F-GHOST-1 (inbound) / finding H (Copilot quote) —
    // the create routes were not swept. Empty leadId stays valid (order with
    // no linked lead). Prevents orphan orders + cross-workspace references +
    // stale-id retention past a DPDPA erasure.
    if (parsed.data.leadId && parsed.data.leadId.trim()) {
      const lead = await repos.lead.getLeadById(workspaceId, parsed.data.leadId.trim());
      if (!lead) return json({ success: false, error: { code: "LEAD_NOT_FOUND", message: "The selected lead was not found in your workspace." } }, 404);
    }
    const { validateOrderReplyLink } = await import("@/services/CommercialReferenceService");
    const sourceReplyId = await validateOrderReplyLink(workspaceId, parsed.data.leadId?.trim() || "", parsed.data.sourceReplyId, repos);
    // M7 (2026-09-27): a real ISO currency, and every line in it.
    const { resolveDocumentCurrency } = await import("@/lib/currency");
    const orderCurrency = resolveDocumentCurrency(parsed.data.currencyCode, parsed.data.lineItems, "order");
    // M6 (2026-09-27): a double-click sends the same create twice; the second
    // gets the first order back instead of making order N+1.
    const { onceWithin, createRequestKey } = await import("@/lib/duplicate-create-guard");
    const orderKey = createRequestKey("order", workspaceId, { leadId: parsed.data.leadId?.trim(), currencyCode: orderCurrency, status: parsed.data.status, lineItems: parsed.data.lineItems, notes: parsed.data.notes, sourceReplyId, sourceInteractionId: parsed.data.sourceInteractionId });
    return json((await onceWithin(orderKey, async () => {
    const { createOrderDirect, hydrateCommercialLineItems } = await import("@/services/OrderService");
    // F-LOGIC-2 (2026-08-04 build-right audit): load the workspace product
    // catalog so createOrderDirect can detect discounts (a line item priced
    // below the catalog rate → discountGiven badge). Previously `products` was
    // never passed, so OrderService.computeDiscountFlag never ran and
    // discountGiven was ALWAYS false on real orders — the LOGIC.md "discounts
    // allowed but flagged" rule was silently unenforced. Best-effort: if the
    // catalog read fails, the order still creates (no discount flag) rather
    // than blocking a legitimate order.
    let workspaceProducts: import("@/lib/types").ProductSetting[] = [];
    try {
      const catalog = await repos.productSettings.getByWorkspace(workspaceId);
      workspaceProducts = catalog?.products || [];
    } catch (e) {
      console.warn("[orders POST] product catalog unavailable; discount flag will be skipped:", e instanceof Error ? e.message : e);
    }
    const draft = await createOrderDirect({
      workspaceId,
      leadId: parsed.data.leadId?.trim() || "",
      lineItems: hydrateCommercialLineItems(parsed.data.lineItems, workspaceProducts, orderCurrency),
      currencyCode: orderCurrency,
      status: parsed.data.status, // F-UI-2 (2026-07-29): honor operator choice
      notes: parsed.data.notes,
      sourceReplyId,
      sourceInteractionId: parsed.data.sourceInteractionId,
      products: workspaceProducts,
    });
    // Cluster D fix (2026-07-21 session 20): use the atomic
    // createWithNextOrderNumber when available (JSON mode) so the read-
    // increment-write happens in one mutateData — eliminates the duplicate-
    // number race. Falls back to nextOrderNumber + create for repos that
    // don't implement the atomic method yet (Prisma stubs).
    const orderRepo = repos.order as { createWithNextOrderNumber?: (input: typeof draft) => Promise<typeof draft>; nextOrderNumber: (ws: string) => Promise<number>; create: (input: typeof draft & { orderNumber: number }) => Promise<typeof draft> };
    let saved: typeof draft;
    if (typeof orderRepo.createWithNextOrderNumber === "function") {
      saved = await orderRepo.createWithNextOrderNumber(draft);
    } else {
      const orderNumber = await orderRepo.nextOrderNumber(workspaceId);
      saved = await orderRepo.create({ ...draft, orderNumber });
    }
    // 2026-09-28 — an order born confirmed is a placed order (outcome signal).
    const { recordOrderOutcome } = await import("@/services/OutcomeSignalService");
    await recordOrderOutcome(workspaceId, saved, repos);
    await alertOwnerBigAmount(request, workspaceId, repos, { kind: "order", record: saved as unknown as Record<string, unknown> });
    return saved;
    })).value);
  }
  if (match(path, ["quotes"]) && request.method === "POST") {
    // 2026-07-21 (Thread 3): create a quote directly (for testing + future
    // manual quote creation UI). Mirrors the orders POST pattern.
    // Cluster C fix (2026-07-21 session 19): validate lineItems via zod.
    const { quoteCreateSchema } = await import("@/validation/schemas");
    const parsed = quoteCreateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // F6 (2026-08-04 CONTINUOUS-2 audit): validate leadId belongs to this
    // workspace before persisting (D-2026-08-04-m). Mirrors the order POST
    // check above + the F-API-3 reply fix. Empty leadId stays valid.
    if (parsed.data.leadId && parsed.data.leadId.trim()) {
      const lead = await repos.lead.getLeadById(workspaceId, parsed.data.leadId.trim());
      if (!lead) return json({ success: false, error: { code: "LEAD_NOT_FOUND", message: "The selected lead was not found in your workspace." } }, 404);
    }
    // M7 (2026-09-27): a real ISO currency, and every line in it.
    const { resolveDocumentCurrency } = await import("@/lib/currency");
    const quoteCurrency = resolveDocumentCurrency(parsed.data.currencyCode, parsed.data.lineItems, "quote");
    // M6 (2026-09-27): same double-click guard as POST /orders.
    const { onceWithin, createRequestKey } = await import("@/lib/duplicate-create-guard");
    const quoteKey = createRequestKey("quote", workspaceId, { leadId: parsed.data.leadId?.trim(), currencyCode: quoteCurrency, lineItems: parsed.data.lineItems, notes: parsed.data.notes, validityNote: parsed.data.validityNote });
    return json((await onceWithin(quoteKey, async () => {
    // M3 (2026-09-27): server line ids + exact line totals, as for orders.
    const { computeGrandTotal, finalizeLineItems, hydrateCommercialLineItems } = await import("@/services/OrderService");
    const catalog = await repos.productSettings.getByWorkspace(workspaceId);
    const lineItems = finalizeLineItems(hydrateCommercialLineItems(parsed.data.lineItems, catalog?.products || [], quoteCurrency));
    // Compute grandTotal from lineItems (use computeGrandTotal for honesty).
    const grandTotal = computeGrandTotal(lineItems);
    const quoteDraft = {
      workspaceId,
      leadId: parsed.data.leadId?.trim() || "",
      // 2026-09-26 (break test): the status came from the request, so a quote
      // could be born "accepted" (or "converted") and skip sending and the
      // customer's yes. A new quote is a draft; its status moves only through
      // quotes/:id/status, which checks each step.
      status: "draft" as never,
      lineItems,
      grandTotal,
      currencyCode: quoteCurrency,
      validityNote: parsed.data.validityNote,
      notes: parsed.data.notes,
    };
    // Cluster D fix (2026-07-21 session 20): use the atomic
    // createWithNextQuoteNumber when available (JSON mode).
    const quoteRepo = repos.quote as unknown as {
      createWithNextQuoteNumber?: (input: typeof quoteDraft) => Promise<unknown>;
      nextQuoteNumber: (ws: string) => Promise<number>;
      create: (input: typeof quoteDraft & { quoteNumber: number }) => Promise<unknown>;
    };
    let saved: unknown;
    if (typeof quoteRepo.createWithNextQuoteNumber === "function") {
      saved = await quoteRepo.createWithNextQuoteNumber(quoteDraft);
    } else {
      const quoteNumber = await quoteRepo.nextQuoteNumber(workspaceId);
      saved = await quoteRepo.create({ ...quoteDraft, quoteNumber });
    }
    await alertOwnerBigAmount(request, workspaceId, repos, { kind: "quote", record: saved as Record<string, unknown> });
    return saved;
    })).value);
  }
  if (match(path, ["orders", ":id", "reorder"])) {
    const source = await repos.order.getById(workspaceId, path[1]);
    if (!source) return notFoundResponse("Order not found");
    if (source.leadId && !(await repos.lead.getLeadById(workspaceId, source.leadId))) return notFoundResponse("Customer not found");
    const { createReorderDraft } = await import("@/services/OrderService");
    const catalog = await repos.productSettings.getByWorkspace(workspaceId);
    const draft = await createReorderDraft(source, { products: catalog?.products || [] });
    const save = async () => {
      const saved = await repos.order.createWithNextOrderNumber(draft);
      await repos.auditLog.create({ workspaceId, entityType: "order", entityId: saved.id, eventType: "reorder_draft_created", payload: { reorderedFromOrderId: source.id }, createdAt: timestamp() });
      return saved;
    };
    const saved = repos.withTransaction ? await repos.withTransaction(save) : await save();
    return json(saved);
  }
  if (match(path, ["orders", ":id", "cancel"])) {
    // M5 (2026-09-27): two cancels at once both read the order before either
    // saved, so both succeeded and the second overwrote the first's record.
    // Changes to one order (cancel and status) now run one at a time, so the
    // second sees what the first did.
    return oneAtATime(`order-change:${workspaceId}:${path[1]}`, async () => {
    const { cancelOrder } = await import("@/services/OrderService");
    const order = await repos.order.getById(workspaceId, path[1]);
    if (!order) return notFoundResponse("Order not found");
    // Cluster C fix (2026-07-21 session 19) + Golden Thread fix (session 21):
    // pass cancelQuantitiesByLine through AND persist grandTotal +
    // cancelledQuantityByLine. The OLD route dropped all three — the math
    // was right but the API silently lost it. Caught by golden-thread-fixes-api.
    const { resolveActor: resolveCancellationActor } = await import("./workspace-resolution");
    const cancellationActor = await resolveCancellationActor(request, undefined);
    const updated = await cancelOrder(order, {
      actor: cancellationActor.userId,
      reason: body?.reason,
      cancelQuantitiesByLine: body?.cancelQuantitiesByLine,
    });
    const saved = await repos.order.update(workspaceId, path[1], {
      status: updated.status,
      grandTotal: updated.grandTotal,
      cancelledAt: updated.cancelledAt,
      cancelledBy: updated.cancelledBy,
      cancelReason: updated.cancelReason,
      cancelledQuantityByLine: updated.cancelledQuantityByLine,
    });
    // F-API-4 (2026-08-04): audit-log the cancel. The sibling orders/:id/status
    // route writes order.status_change on every transition, but cancelling an
    // order mutates grandTotal + cancelledAt/By/Reason + cancelledQuantityByLine
    // (a money-impacting, hard-to-reverse action) — and was the one status
    // change with NO audit trail. The cancel REASON is the most important field
    // to preserve for non-repudiation, so capture old+new here.
    try {
      const { safeAudit } = await import("@/lib/safe-audit");
      const { resolveActor } = await import("./workspace-resolution");
      const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
      await safeAudit(repos, {
        workspaceId, userId: actorUserId, action: "order.cancelled", entityType: "order", entityId: path[1],
        oldValuesJson: { status: order.status, grandTotal: order.grandTotal },
        newValuesJson: { status: updated.status, grandTotal: updated.grandTotal, cancelledAt: updated.cancelledAt, cancelledBy: updated.cancelledBy, cancelReason: updated.cancelReason, cancelledQuantityByLine: updated.cancelledQuantityByLine },
        metadataJson: { orderNumber: order.orderNumber },
      });
    } catch {
      /* audit-log is best-effort; never block a cancel on it */
    }
    return json(saved);
    });
  }
  if (match(path, ["quotes", ":id", "convert"])) {
    // M1 (2026-09-27): runs one at a time with the quote's status changes
    // (status route + Copilot approve), so an approve cannot write "sent"
    // over a quote this request has just converted.
    return oneAtATime(`quote-change:${workspaceId}:${path[1]}`, async () => {
    const { convertPersistedQuoteToOrder } = await import("@/services/QuoteConversionService");
    const quote = await repos.quote.getById(workspaceId, path[1]);
    if (!quote) return notFoundResponse("Quote not found");
    let convertProducts: import("@/lib/types").ProductSetting[] = [];
    try {
      const catalog = await repos.productSettings.getByWorkspace(workspaceId);
      convertProducts = catalog?.products || [];
    } catch (e) {
      console.warn("[quotes convert] product catalog unavailable; discount flag will be skipped:", e instanceof Error ? e.message : e);
    }
    const result = await convertPersistedQuoteToOrder(workspaceId, path[1], { products: convertProducts }, repos);
    if (!result) return notFoundResponse("Quote not found");
    if (result.alreadyConverted) return json(result);
    const { order: savedOrder, quote: updatedQuote } = result;
    {
      // 2026-09-28 — an order made from a quote is a placed order.
      const { recordOrderOutcome } = await import("@/services/OutcomeSignalService");
      await recordOrderOutcome(workspaceId, savedOrder, repos);
    }
    await alertOwnerBigAmount(request, workspaceId, repos, { kind: "order", record: savedOrder as unknown as Record<string, unknown> });
    // F-API-4 (2026-08-04): audit-log the conversion. Creating an order from a
    // quote + flipping the quote to "converted" is a money-impacting, hard-to-
    // reverse action (and the audit trail is what makes the double-convert
    // idempotency check auditable later). The sibling quotes/:id/status route
    // writes quote.status_change; this dedicated route wrote nothing.
    try {
      const { safeAudit } = await import("@/lib/safe-audit");
      const { resolveActor } = await import("./workspace-resolution");
      const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
      await safeAudit(repos, {
        workspaceId, userId: actorUserId, action: "quote.converted", entityType: "quote", entityId: path[1],
        oldValuesJson: { status: result.previousStatus },
        newValuesJson: { status: updatedQuote.status, orderId: savedOrder.id },
        metadataJson: { newOrderId: savedOrder.id, quoteNumber: quote.quoteNumber },
      });
    } catch {
      /* audit-log is best-effort; never block a convert on it */
    }
    return json({ order: savedOrder, quote: updatedQuote });
    });
  }

  // === F-DATA-5 (2026-08-17, CEO decision D5) — quote revision ==============
  // `supersedeQuote` (OrderService.ts:240) has existed with a passing golden
  // since 2026-07-21 and ZERO call sites: docs/LOGIC.md says "a new quote
  // supersedes the old one", and that rule has never actually run. The open
  // question was WHEN it should fire. Recorded answer (docs/CEO-LOOP-STATUS.md,
  // decision D5): **supersession is an explicit revise action, never automatic.**
  //   - Automatic-on-every-new-quote is wrong: one lead can legitimately hold
  //     several live quotes for different products, and auto-superseding would
  //     silently kill a valid parallel quote the owner still expects an answer on.
  //   - "Never" leaves the price history unlinked — the owner can't see that
  //     quote #14 is the renegotiated version of #9.
  // So the owner says "revise this quote"; the system copies it, links the new
  // one back via supersedesQuoteId, and retires the old one.
  //
  // REFUSALS (both money-safety, both 409):
  //   - accepted / converted quotes are commitments. The customer said yes; an
  //     order may already exist. Superseding one would rewrite an agreed price
  //     out of the history. Re-price via a NEW quote instead.
  //   - an already-superseded quote can't be superseded twice (idempotency —
  //     otherwise a double-click makes two replacements for one original).
  //
  // Replacement and retirement commit together against the locked current
  // quote. A failure leaves the original usable and no spare replacement.
  if (match(path, ["quotes", ":id", "revise"]) && request.method === "POST") {
    // 2026-09-26 (break test): three Revise clicks at once all read the quote
    // before any retired it, and made three replacement quotes. Revisions of
    // one quote now run one at a time; the later clicks see "already replaced".
    return oneAtATime(`quote-change:${workspaceId}:${path[1]}`, async () => {
    let previousStatus: Quote["status"] | undefined;
    const result = await repos.quote.reviseAtomically(workspaceId, path[1], async oldQuote => {
      previousStatus = oldQuote.status;
      if (oldQuote.status === "accepted" || oldQuote.status === "converted") {
        throw new NeedsActionError(`Quote #${oldQuote.quoteNumber} is already ${oldQuote.status}. Create a new quote to preserve the agreed price.`, 409);
      }
      if (oldQuote.status === "superseded") throw new NeedsActionError("This quote has already been replaced by a newer quote.", 409);
    const { quoteCreateSchema } = await import("@/validation/schemas");
    const parsed = quoteCreateSchema.safeParse({ ...body, leadId: oldQuote.leadId, lineItems: body?.lineItems ?? oldQuote.lineItems, currencyCode: body?.currencyCode ?? oldQuote.currencyCode });
    if (!parsed.success) throw new NeedsActionError("The revised quote contains invalid details. Check its quantities, prices and notes.", 400);
    const lineItems = parsed.data.lineItems;
    const { computeGrandTotal, finalizeLineItems, hydrateCommercialLineItems } = await import("@/services/OrderService");
    // Fresh line-item ids: line ids key per-line maps elsewhere (shipped/
    // cancelled quantities on the eventual order), so two quotes must never
    // share one. finalizeLineItems gives server ids + exact totals (M2/M3).
    const catalog = await repos.productSettings.getByWorkspace(workspaceId);
    const copiedLines = finalizeLineItems(hydrateCommercialLineItems(lineItems, catalog?.products || [], body?.currencyCode || oldQuote.currencyCode));
    // M7 (2026-09-27): the revised quote's currency is checked like a new one
    // ("" or "rupees" used to be saved as the currency).
    const { resolveDocumentCurrency } = await import("@/lib/currency");
    const revisedCurrency = resolveDocumentCurrency(
      body?.currencyCode || oldQuote.currencyCode,
      copiedLines,
      "quote",
    );
    const replacementDraft = {
      workspaceId,
      leadId: oldQuote.leadId,
      status: "draft" as const,
      lineItems: copiedLines,
      grandTotal: computeGrandTotal(copiedLines),
      currencyCode: revisedCurrency,
      validityNote: parsed.data.validityNote ?? oldQuote.validityNote,
      notes: parsed.data.notes ?? oldQuote.notes,
      supersedesQuoteId: oldQuote.id,
    };
    return replacementDraft;
    });
    if (!result) return notFoundResponse("Quote not found");
    const { quote: replacement, supersededQuote: savedOld } = result;
    const oldQuote = savedOld;
    try {
      const { safeAudit } = await import("@/lib/safe-audit");
      const { resolveActor } = await import("./workspace-resolution");
      const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
      await safeAudit(repos, {
        workspaceId, userId: actorUserId, action: "quote.superseded", entityType: "quote", entityId: oldQuote.id,
        oldValuesJson: { status: previousStatus, grandTotal: oldQuote.grandTotal },
        newValuesJson: { status: "superseded", replacedByQuoteId: replacement.id, replacementGrandTotal: replacement.grandTotal },
        metadataJson: { quoteNumber: oldQuote.quoteNumber, replacementQuoteNumber: replacement.quoteNumber },
      });
    } catch {
      /* audit-log is best-effort; never block a revision on it */
    }
    return json({ quote: replacement, supersededQuote: savedOld });
    });
  }

  // === 2026-08-02 audit P2-5 — Order + Quote status transitions. ===========
  // Pre-fix the UI could create an order/quote and cancel/convert it, but had
  // NO way to advance the lifecycle (quoted → in_progress → shipped → delivered,
  // or quote draft → sent/rejected/expired). The state machines existed in the
  // backend type unions but only a subset was reachable. These two routes mirror
  // the existing tickets/:id/status pattern: validate the target against the
  // union, persist via the repo, audit-log the change. Read-only list + detail
  // already showed all statuses; this makes them MUTABLE from the UI.
  if (match(path, ["orders", ":id", "status"]) && request.method === "POST") {
    const VALID_ORDER_STATUSES = ["draft", "quoted", "confirmed", "in_progress", "partial_shipped", "shipped", "delivered", "cancelled", "partial_cancelled", "returned"] as const;
    const { toStatus } = body || {};
    if (!toStatus || !(VALID_ORDER_STATUSES as readonly string[]).includes(String(toStatus))) {
      return validationErrorResponse(`toStatus must be one of: ${VALID_ORDER_STATUSES.join(", ")}`);
    }
    // F-DATA-2 (2026-08-04): cancels MUST go through the dedicated cancel route
    // (POST /orders/:id/cancel), which runs cancelOrder — the only place that
    // (a) refuses to cancel a shipped/delivered order, and (b) records
    // cancelledAt/By/Reason + recomputes grandTotal + cancelledQuantityByLine.
    // Letting the generic status route set "cancelled"/"partial_cancelled"
    // bypassed all of that — a sales_member could move a delivered order to
    // cancelled with no audit trail and a lying grandTotal. Redirect to the
    // honest route instead of silently performing half the work.
    if (toStatus === "cancelled" || toStatus === "partial_cancelled") {
      return validationErrorResponse(
        `Use POST /api/orders/${path[1]}/cancel to cancel an order (it enforces the delivered-throws guard and records cancelledQuantityByLine).`,
      );
    }
    // M5 (2026-09-27): one at a time with this order's cancels (see /cancel).
    return oneAtATime(`order-change:${workspaceId}:${path[1]}`, async () => {
    const order = await repos.order.getById(workspaceId, path[1]);
    if (!order) return notFoundResponse("Order not found");
    // N-DATA-12 (2026-08-20): validate the move, not just the destination. Until
    // now this route checked `toStatus` against the union and never looked at
    // the status the order was already in, so `delivered → draft` returned 200
    // — a delivered order silently became a draft, keeping its deliveredAt. The
    // legal moves live in ONE shared map that the drawer's dropdown also reads,
    // so the screen cannot offer what the API refuses.
    {
      const { isAllowedOrderTransition, nextOrderStatuses, transitionRefusal } = await import("@/lib/status-transitions");
      if (!isAllowedOrderTransition(order.status, toStatus as typeof order.status)) {
        // 409 + the real sentence, NOT validationErrorResponse: that helper
        // hardcodes the top-level message to "Validation failed" and buries the
        // detail in `error.details`, while the client (api-client.ts:134) shows
        // `error.message` and nothing else. The operator would have read
        // "Validation failed" and learned nothing. 409 + a named code is the
        // shape the sibling /revise route already uses for QUOTE_COMMITTED.
        return errorResponse(
          transitionRefusal("order", order.status, String(toStatus), nextOrderStatuses(order.status)),
          409,
          undefined,
          "INVALID_STATUS_TRANSITION",
        );
      }
    }
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
    // F7 (2026-08-04 CONTINUOUS-2 audit): stamp the matching timestamp on each
    // lifecycle transition (D-2026-08-04-k — "stamp on each status"), mirroring
    // how changeTicketStatus stamps resolvedAt/closedAt. Previously this route
    // did a bare status update with NO timestamp, so a delivered order had no
    // deliveredAt, a shipped order had no shippedAt. AND shippedQuantityByLine
    // was NEVER written by any code — so a later cancelOrder treated
    // partial_shipped orders as fully cancellable (cancel math subtracted 0).
    const now = timestamp();
    const patch: Record<string, unknown> = { status: toStatus };
    if (toStatus === "confirmed" && !order.confirmedAt) patch.confirmedAt = now;
    if (toStatus === "shipped" && !order.shippedAt) patch.shippedAt = now;
    if (toStatus === "delivered" && !order.deliveredAt) patch.deliveredAt = now;
    if (toStatus === "in_progress" && !order.confirmedAt) patch.confirmedAt = now;
    if (toStatus === "partial_shipped" && !order.shippedAt) patch.shippedAt = now;
    // partial_shipped REQUIRES a shippedQuantityByLine so cancel math works.
    // 2026-09-26 (break test): the counts are checked before they are stored
    // (over-ship, unknown lines, counts going backwards were all saved as sent).
    // 2026-09-27 (M8): the counts are now REQUIRED — with none, the route used
    // to record every unit as shipped. "shipped" records the whole remainder
    // explicitly, and "delivered" from a partial state waits for the rest.
    {
      const { shipmentPatchFor } = await import("@/services/OrderService");
      Object.assign(patch, shipmentPatchFor(order, toStatus as typeof order.status, body?.shippedQuantityByLine));
    }
    const updated = await repos.order.update(workspaceId, path[1], patch as Partial<typeof order>);
    {
      // 2026-09-28 — confirmed (or further) = placed; once per order.
      const { recordOrderOutcome } = await import("@/services/OutcomeSignalService");
      await recordOrderOutcome(workspaceId, updated, repos);
    }
    try {
      const { safeAudit } = await import("@/lib/safe-audit");
      await safeAudit(repos, { workspaceId, userId: actorUserId, action: "order.status_change", entityType: "order", entityId: path[1], oldValuesJson: { status: order.status }, newValuesJson: { status: toStatus, ...(patch.confirmedAt ? { confirmedAt: patch.confirmedAt } : {}), ...(patch.shippedAt ? { shippedAt: patch.shippedAt } : {}), ...(patch.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}), ...(patch.shippedQuantityByLine ? { shippedQuantityByLine: patch.shippedQuantityByLine } : {}) }, metadataJson: { orderNumber: order.orderNumber } });
    } catch {
      /* audit-log is best-effort; never block a status change on it */
    }
    return json(updated);
    });
  }
  if (match(path, ["quotes", ":id", "status"]) && request.method === "POST") {
    const VALID_QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired", "superseded", "converted"] as const;
    const { toStatus } = body || {};
    if (!toStatus || !(VALID_QUOTE_STATUSES as readonly string[]).includes(String(toStatus))) {
      return validationErrorResponse(`toStatus must be one of: ${VALID_QUOTE_STATUSES.join(", ")}`);
    }
    // M1 (2026-09-27): one at a time with /convert and the Copilot approve.
    return oneAtATime(`quote-change:${workspaceId}:${path[1]}`, async () => {
    const quote = await repos.quote.getById(workspaceId, path[1]);
    if (!quote) return notFoundResponse("Quote not found");
    // F-DATA-2 (2026-08-04): "converted" is ONLY set by POST /quotes/:id/convert,
    // which atomically creates the linked order + stamps orderId. Letting the
    // generic status route set "converted" would create a converted quote with
    // no order, after which convertQuoteToOrder's idempotency check (status===
    // "converted" && quote.orderId) would refuse to create the missing order —
    // a permanently stuck quote.
    if (toStatus === "converted") {
      return validationErrorResponse(
        `Use POST /api/quotes/${path[1]}/convert to convert a quote to an order (it creates the linked order and stamps orderId atomically).`,
      );
    }
    // F-DATA-5 (2026-08-17, decision D5): same reasoning for "superseded". It is
    // only meaningful ALONGSIDE a replacement quote — a hand-set "superseded"
    // leaves a retired quote with no successor and no supersedesQuoteId link, so
    // the owner loses the price history the status exists to record.
    if (toStatus === "superseded") {
      return validationErrorResponse(
        `Use POST /api/quotes/${path[1]}/revise to replace a quote (it creates the replacement, links it back to this one, and retires this one).`,
      );
    }
    // N-DATA-12 (2026-08-20): see the order route above. `accepted → draft` used
    // to return 200 here, walking a quote the customer had signed back to a
    // draft — while POST /quotes/:id/revise refuses the same thing in writing
    // ("A quote the customer has committed to can't be revised"). One route
    // protected the agreed price and its sibling let a dropdown edit it away.
    {
      const { isAllowedQuoteTransition, nextQuoteStatuses, transitionRefusal } = await import("@/lib/status-transitions");
      if (!isAllowedQuoteTransition(quote.status, toStatus as typeof quote.status)) {
        // 409 + the real sentence, NOT validationErrorResponse: that helper
        // hardcodes the top-level message to "Validation failed" and buries the
        // detail in `error.details`, while the client (api-client.ts:134) shows
        // `error.message` and nothing else. The operator would have read
        // "Validation failed" and learned nothing. 409 + a named code is the
        // shape the sibling /revise route already uses for QUOTE_COMMITTED.
        return errorResponse(
          transitionRefusal("quote", quote.status, String(toStatus), nextQuoteStatuses(quote.status)),
          409,
          undefined,
          "INVALID_STATUS_TRANSITION",
        );
      }
    }
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
    // N-DATA-11 (2026-08-20): stamp the matching timestamp on each transition,
    // exactly as the ORDER route 40 lines above already does (F7, 2026-08-04:
    // "Previously this route did a bare status update with NO timestamp, so a
    // delivered order had no deliveredAt"). That same defect was left standing
    // here. `Quote.sentAt` and `Quote.acceptedAt` exist on the type and are
    // persisted by both substrates, but a repo-wide search showed NOTHING ever
    // wrote them — no route, no service. Two consequences, both real:
    //   - the drawer's `Accepted:` row (Commercial.tsx) could never render in
    //     production, because the value it reads was never written. Found on
    //     the running app: quote #2 shows the badge "Accepted" and no accepted
    //     date, because accepted_at was NULL;
    //   - the audit record logged only {status}, while its order sibling logs
    //     the stamped times — so "when did the customer say yes?" had no answer
    //     on screen OR in the trail.
    // Guarded with `!quote.<field>` so a re-transition never rewrites history.
    // 2026-09-27 (M1): the patch now comes from OrderService.quoteStatusPatch,
    // the one guarded transition the Copilot approve also uses; it also
    // refuses "sent" while a line has no price.
    const { quoteStatusPatch } = await import("@/services/OrderService");
    const quotePatch: Partial<typeof quote> = quoteStatusPatch(quote, toStatus as typeof quote.status, timestamp());
    const updated = await repos.quote.update(workspaceId, path[1], quotePatch, quote.status);
    {
      // 2026-09-28 — the customer said yes (outcome signal, once per quote).
      const { recordQuoteOutcome } = await import("@/services/OutcomeSignalService");
      await recordQuoteOutcome(workspaceId, updated, repos);
    }
    try {
      const { safeAudit } = await import("@/lib/safe-audit");
      await safeAudit(repos, { workspaceId, userId: actorUserId, action: "quote.status_change", entityType: "quote", entityId: path[1], oldValuesJson: { status: quote.status }, newValuesJson: { status: toStatus, ...(quotePatch.sentAt ? { sentAt: quotePatch.sentAt } : {}), ...(quotePatch.acceptedAt ? { acceptedAt: quotePatch.acceptedAt } : {}) } });
    } catch {
      /* audit-log is best-effort */
    }
    return json(updated);
    });
  }

  // === 2026-07-21 (M9) — Workspace mutations: insights + kill-switch ===
  if (match(path, ["workspace", "insights"]) && request.method === "POST") {
    const { note } = body || {};
    if (!note || !note.trim()) return validationErrorResponse("Insight note text is required");
    const entry = await repos.auditLog.create({
      workspaceId,
      eventType: "insight_note",
      // Cluster 4 fix (P1-1 / F1): use the SESSION-resolved actor, not
      // body.authorUserId (forgery vector — could stamp "owner" on any note).
      actorUserId: postActorUserId,
      payload: { note: note.trim() },
    } as Partial<AuditLog>);
    return json(entry);
  }
  if (match(path, ["workspace", "kill-switch"]) && request.method === "POST") {
    // R4 2026-07-21 — extended to also flip the per-customer autoSendToggle.
    // The kill-switch (autonomyKillSwitch) and the toggle (autoSendToggle)
    // are SEPARATE controls per docs/LOGIC.md 2026-07-21 (Q13):
    //   - kill-switch = owner panic button (overrides everything)
    //   - toggle = per-customer opt-in for auto-first-message (default OFF)
    // AutoSendGate checks kill-switch FIRST, then toggle. The toggle has
    // NO effect while the kill-switch is engaged (the gate fails earlier).
    //
    // Cluster A fix B2 (2026-07-21 session 16): the kill-switch flip now
    // goes through flipKillSwitch() so the audit log captures the from→to
    // transition (previousValue + newValue). Previously the audit only had
    // {newValue}, destroying the trail of what changed.
    const { autonomyKillSwitch, autoSendToggle, actorUserId: bodyActor } = body || {};
    const current = await repos.workspace.getById(workspaceId);
    if (!current) return notFoundResponse("Workspace not found");
    // Cluster B fix (2026-07-21 session 17): derive actor from session in
    // production (P0 finding A5 — body actorUserId was forgeable).
    const { resolveActor } = await import("./workspace-resolution");
    const actor = await resolveActor(request, bodyActor);
    const actorUserId = actor.userId;

    // Kill-switch flip: use the pure helper for the full audit shape.
    if (typeof autonomyKillSwitch === "boolean") {
      const { flipKillSwitch } = await import("@/services/DailyDigestService");
      const { updatedWorkspace, auditEvent } = flipKillSwitch({
        workspace: current,
        newKillSwitchValue: autonomyKillSwitch,
        actor: { userId: actorUserId || "owner", actorType: "owner" },
      });
      // Persist the workspace field, then the audit event (with from→to).
      await repos.workspace.update(workspaceId, { autonomyKillSwitch });
      void updatedWorkspace; // helper returns the patched object; we persisted the field above.
      // F14 (2026-08-04 CONTINUOUS-2 audit): the kill-switch flip is an
      // irreversible compliance action — the mutation has already landed, so
      // the audit write MUST be best-effort (a transient audit-store failure
      // must never lose the only trail). Wrap so a failure logs loudly to
      // console.error instead of throwing a 500 that hides the successful flip.
      try {
        await repos.auditLog.create({
          workspaceId,
          eventType: "kill_switch_toggled",
          actorUserId: actorUserId || "owner",
          payload: { previousValue: auditEvent.previousValue, newValue: auditEvent.newValue },
        } as Partial<AuditLog>);
      } catch (auditErr) {
        console.error(`[kill-switch] audit-log write FAILED for workspaceId="${workspaceId}" (the toggle flip succeeded: ${auditEvent.previousValue}→${auditEvent.newValue}). Error:`, auditErr);
      }
    }
    // autoSendToggle flip: separate event type, separate rule (no from→to
    // requirement in LOGIC.md for the toggle). Capture both values anyway
    // for consistency, so the operator's audit trail is uniform.
    if (typeof autoSendToggle === "boolean") {
      const previousToggleValue = Boolean(current.autoSendToggle);
      await repos.workspace.update(workspaceId, { autoSendToggle });
      // F14: same best-effort audit wrap as the kill-switch above.
      try {
        await repos.auditLog.create({
          workspaceId,
          eventType: "auto_send_toggle_changed",
          actorUserId: actorUserId || "owner",
          payload: { previousValue: previousToggleValue, newValue: autoSendToggle },
        } as Partial<AuditLog>);
      } catch (auditErr) {
        console.error(`[autoSendToggle] audit-log write FAILED for workspaceId="${workspaceId}" (the toggle flip succeeded: ${previousToggleValue}→${autoSendToggle}). Error:`, auditErr);
      }
    }
    const updated = await repos.workspace.getById(workspaceId);
    return json({
      autonomyKillSwitch: Boolean(updated?.autonomyKillSwitch),
      autoSendToggle: Boolean(updated?.autoSendToggle),
    });
  }

  // R6 2026-07-21 — POST /price-change/send
  // Executes the actual WhatsApp send for the recipients the owner approved
  // from the preview. Implements guardrails 3 (two-step approval: this is
  // step 2), 4 (owner-approved template), 5 (audit log per send), 6 (DNC
  // respected — re-checked at send time; a customer who went DNC between
  // preview + send is skipped).
  //
  // Per AGENTS.md: no auto customer-facing outreach. The owner's explicit
  // "Send" button click IS the human approval — same pattern as
  // approveAutoReplyLog. This is NOT auto-send.
  if (match(path, ["price-change", "send"]) && request.method === "POST") {
    const { productId, oldPrice, newPrice, leadIds, actorUserId: bodyActor } = body || {};
    // Cluster E fix (2026-07-21 session 20): derive actor from session in
    // production (P0 finding A5 — body actorUserId was forgeable on this
    // customer-facing send endpoint).
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, bodyActor)).userId;
    if (!productId) return validationErrorResponse("productId required");
    if (typeof oldPrice !== "number" || typeof newPrice !== "number") {
      return validationErrorResponse("oldPrice and newPrice (numbers) required");
    }
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return validationErrorResponse("leadIds (non-empty array) required");
    }
    // Re-load product + leads (don't trust the client's idea of who to send to).
    const ps = await repos.productSettings.getByWorkspace(workspaceId);
    const product = ps?.products.find((p) => p.id === productId);
    if (!product) return notFoundResponse("Product not found");
    const allLeads = await repos.lead.listLeads(workspaceId);
    // Cluster 2 fix (2026-07-26 audit, P1-3 / D-2026-07-26-3): consult the
    // PERMANENT DNC REGISTRY (via isContactBlocked) for every recipient, not
    // just the lead-record flag. Previously a customer whose flag was cleared
    // (re-import, manual edit, the now-locked-down leads/:id PUT) but who is
    // still in the registry would receive a price-change WhatsApp. Every other
    // send path (approve, message-generate, mark-sent) already calls this.
    const { isContactBlocked } = await import("@/lib/dnc-registry");
    const dncLeadIds = new Set<string>();
    for (const lead of allLeads) {
      const check = await isContactBlocked(workspaceId, lead);
      if (check.blocked) dncLeadIds.add(lead.id);
    }
    const { renderPriceChangeMessage } = await import("@/services/PriceChangeNotifyService");

    // F-ISO-2 (2026-08-04 build-right audit): resolve the WhatsApp provider
    // from the workspace's saved credentials FIRST (CP-17c / CP-17b), falling
    // back to env vars when none. Previously this path constructed
    // `new MetaWhatsAppCloudProvider()` (env-only), so a workspace that saved
    // its own WhatsApp creds had price-change notifications sent via the
    // operator's env creds (or fail) instead of its own. Now matches the
    // approved-reply path (AutoReplyReviewService) + the WhatsApp engine.
    const { MetaWhatsAppCloudProvider } = await import("@/providers/whatsapp/MetaWhatsAppCloudProvider");
    const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
    const provider = await new WhatsAppCredentialService(repos).resolveProvider(workspaceId);
    const providerConfigured = provider.isConfigured();

    const results: Array<{
      leadId: string;
      customerName: string;
      status: "sent" | "skipped_dnc" | "not_configured" | "no_number" | "failed";
      error?: string;
    }> = [];

    // 2026-09-26 (break test): a list naming the same customer twice sent them
    // the same WhatsApp twice. Each customer is messaged once.
    for (const leadId of new Set(leadIds.map(String))) {
      const lead = allLeads.find((l) => l.id === leadId);
      if (!lead) {
        results.push({ leadId, customerName: "(unknown)", status: "failed", error: "Lead not found" });
        continue;
      }
      const customerName = lead.contactName || lead.companyName || "Customer";
      // Guardrail 6 — DNC re-check at send time (customer may have opted out
      // between the preview and the send click).
      if (dncLeadIds.has(leadId)) {
        results.push({ leadId, customerName, status: "skipped_dnc" });
        continue;
      }
      if (!lead.whatsappNumber) {
        results.push({ leadId, customerName, status: "no_number" });
        continue;
      }
      if (!providerConfigured) {
        // Honest: WhatsApp not configured. Still record the audit entry so the
        // owner sees the attempt; the message did NOT go out.
        results.push({ leadId, customerName, status: "not_configured" });
        continue;
      }
      const rendered = renderPriceChangeMessage({
        customerName, productName: product.name, oldPrice, newPrice, templateId: "price_change_v1",
      });
      try {
        const sendResult = await provider.sendTextMessage({
          workspaceId,
          to: lead.whatsappNumber,
          body: rendered.body,
          previewOnly: false,
          publicOrigin: process.env.WHATSAPP_PUBLIC_ORIGIN,
        });
        // Cluster J fix (2026-07-21 session 20): record HONESTLY. The OLD
        // code used `sendResult.status === "sent" || sendResult.attempted`
        // — but a FAILED send also has attempted=true, so failures were
        // silently recorded as "sent" (audit lied). Now only a true "sent"
        // status counts as sent.
        if (sendResult.status === "sent") {
          results.push({ leadId, customerName, status: "sent" });
        } else {
          results.push({ leadId, customerName, status: "failed", error: sendResult.errorMessage || "Unknown send failure" });
        }
      } catch (error) {
        results.push({
          leadId, customerName, status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Guardrail 5 — audit log entry per send (one summary entry with the
    // per-recipient results; the audit log is immutable).
    // D-8 fix (batch 3, 2026-07-27): the WhatsApp sends above are IRREVERSIBLE.
    // If this audit write threw (Postgres transient, JSON file-lock), the old
    // code crashed the route with a 500 — but the messages were already sent,
    // so the operator would lose the ONLY record of who was notified (a silent
    // loss of the audit trail, violating build-right Phase 4 "No Silent
    // Failures"). Routed through safeAudit so the audit is best-effort +
    // failures are logged to console.error + Sentry without crashing the route
    // after the irreversible sends. The send results are still returned in the
    // response body (results[] below) so the operator sees them immediately.
    const sentCount = results.filter((r) => r.status === "sent").length;
    const skippedCount = results.filter((r) => r.status !== "sent").length;
    await safeAudit(repos, {
      workspaceId,
      userId: actorUserId || "owner",
      action: "price_change_notified",
      entityType: "product",
      entityId: productId,
      newValuesJson: {
        productName: product.name,
        oldPrice, newPrice,
        sentCount, skippedCount,
        results,
      },
    });

    return json({
      productId,
      productName: product.name,
      sentCount,
      skippedCount,
      results,
      providerConfigured,
    });
  }

  // === 2026-07-21 (M10) — Consent + Erasure mutations ===
  if (match(path, ["consent", ":leadId"]) && request.method === "POST") {
    // Cluster A fix B4 (2026-07-21 session 16): UPGRADES now go through the
    // upgradeConsentBasis pure helper so evidence is required. Previously
    // the route wrote consentStatus directly to the lead, allowing a
    // DPDPA-illegal flip to legitimate_interest with no documented reason.
    //
    // Downgrade to "none" is always allowed (no evidence) — it's a reset.
    const { basis, evidence, actorUserId: bodyActor } = body || {};
    if (!basis || !["inbound", "consent", "legitimate_interest", "none"].includes(basis)) {
      return validationErrorResponse("basis must be one of: inbound, consent, legitimate_interest, none");
    }
    // Load the lead so we can build its current consent state.
    const lead = await repos.lead.getLeadById(workspaceId, path[1]);
    if (!lead) return notFoundResponse("Lead not found");
    // Cluster B fix (2026-07-21 session 17): actor from session, not body.
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, bodyActor)).userId;

    if (basis === "none") {
      // Reset/downgrade — no evidence required. Just write the field.
      await repos.lead.updateLead(workspaceId, path[1], { consentStatus: "none" } as Partial<Lead>);
    } else {
      // Upgrade — REQUIRE evidence, route through the pure helper so the
      // safety rule is enforced at the math layer (pinned by golden:consent-wiring).
      const { createDefaultConsent, upgradeConsentBasis } = await import("@/services/ConsentService");
      // Build a transient consent record from the lead's current state.
      // If the lead had no consent record yet, start from the default.
      const current = createDefaultConsent({ workspaceId, leadId: path[1], sourceChannel: lead.source || "manual" });
      current.basis = (lead.consentStatus === "inbound" || lead.consentStatus === "consent" || lead.consentStatus === "legitimate_interest" || lead.consentStatus === "none")
        ? lead.consentStatus
        : "none";
      try {
        const upgraded = upgradeConsentBasis(current, {
          basis: basis as "inbound" | "consent" | "legitimate_interest",
          evidence: typeof evidence === "string" ? evidence : "",
        });
        await repos.lead.updateLead(workspaceId, path[1], { consentStatus: upgraded.basis } as Partial<Lead>);
      } catch (validationError) {
        // Surface the helper's throw as a 400 validation error.
        const message = validationError instanceof Error ? validationError.message : String(validationError);
        return json(
          { success: false, error: { code: "VALIDATION_ERROR", message } },
          400,
        );
      }
    }
    await repos.auditLog.create({
      workspaceId,
      eventType: "consent_basis_changed",
      actorUserId: actorUserId || "owner",
      entityId: path[1],
      entityType: "lead",
      payload: { basis, evidence: typeof evidence === "string" && evidence.trim() ? evidence : "(none)" },
    } as Partial<AuditLog>);
    return json({ leadId: path[1], basis });
  }
  // 2026-09-28 (L10) — the owner puts a lead on the permanent do-not-contact
  // register: every number, the email and the website host, so a company
  // known only by its website can be registered. Admin-gated by the "consent"
  // prefix; a written reason is required and audited. remove-dnc (below,
  // owner-only) is the way back.
  if (match(path, ["consent", ":leadId", "add-dnc"]) && request.method === "POST") {
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, body?.actorUserId)).userId;
    const { putLeadOnDoNotContact } = await import("@/services/LeadImportService");
    const result = await putLeadOnDoNotContact(workspaceId, path[1], String(body?.reason || ""), repos, actorUserId || "owner");
    return json({ leadId: path[1], registered: result.registered, lead: result.lead });
  }
  if (match(path, ["consent", ":leadId", "remove-dnc"]) && request.method === "POST") {
    // D-2026-07-26-2 (Cluster 2): the ONE legitimate way to take a customer
    // off the permanent DNC registry. Owner-only, requires a written reason,
    // audit-logged, then removes the registry entry AND clears the lead flag
    // + moves status out of do_not_contact / not_interested. Previously there
    // was no UI/API to ever remove a customer from DNC.
    const { reason, actorUserId: bodyActor } = body || {};
    // Owner-only (defense-in-depth on top of the admin-level RBAC gate).
    const { resolveCurrentUser } = await import("@/lib/auth-service");
    const currentUser = await resolveCurrentUser(request);
    if (!currentUser || currentUser.role !== "owner") {
      return json({ success: false, error: { code: "FORBIDDEN", message: "Only the owner can remove a customer from the DNC list." } }, 403);
    }
    if (typeof reason !== "string" || reason.trim().length < 5) {
      return validationErrorResponse("A written reason (min 5 chars) is required to remove a customer from DNC.");
    }
    const lead = await repos.lead.getLeadById(workspaceId, path[1]);
    if (!lead) return notFoundResponse("Lead not found");
    const { removeFromDncRegistry } = await import("@/lib/dnc-registry");
    const removedCount = await removeFromDncRegistry(workspaceId, {
      whatsappNumber: lead.whatsappNumber || lead.phone,
      phone: lead.phone,
      email: lead.email,
      // 2026-09-28 (L10): the website host is a register key too.
      websiteUrl: lead.websiteUrl,
    }, repos);
    // Clear the lead-record signals so the lead is contactable again.
    const nextStatus = lead.status === "do_not_contact" || lead.status === "not_interested" ? "discovered" : lead.status;
    await repos.lead.updateLead(workspaceId, path[1], {
      doNotContact: false,
      doNotContactReason: undefined,
      status: nextStatus,
    } as Partial<Lead>);
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, bodyActor)).userId;
    // F-AUDIT-1 (2026-08-05 CONTINUOUS-3 audit): the DNC removal is an
    // irreversible compliance action — the registry entry is already deleted
    // + the lead is already contactable again (above). The audit write MUST
    // be best-effort: a transient audit-store failure (Postgres error, JSON
    // file-lock timeout) must never throw a 500 that hides the successful
    // removal AND loses the only trail of who lifted a DNC block + why.
    // Mirrors the F14 fix for kill_switch_toggled (route.ts ~3835).
    try {
      await repos.auditLog.create({
        workspaceId,
        eventType: "dnc_removed",
        actorUserId: actorUserId || currentUser.id,
        entityId: path[1],
        entityType: "lead",
        payload: { reason: reason.trim(), registryEntriesRemoved: removedCount, previousStatus: lead.status },
      } as Partial<AuditLog>);
    } catch (auditErr) {
      console.error(`[dnc-removed] audit-log write FAILED for workspaceId="${workspaceId}" leadId="${path[1]}" (the DNC removal + lead clear succeeded: ${removedCount} registry entries removed). Error:`, auditErr);
    }
    return json({ leadId: path[1], removed: removedCount, reason: reason.trim() });
  }
  if (match(path, ["erasure", ":leadId"]) && request.method === "POST") {
    // R5 2026-07-21 — Real DPDPA hard-delete cascade (replaces the inline
    // anonymize that shipped earlier). Per docs/LOGIC.md Q18: owner-only,
    // two-step name confirmation, cascade-delete all 10 record types,
    // PRESERVE DNC entry (compliance), write anonymized audit entry.
    //
    // Layer 1 — API-level owner gate (production mode only; demo bypasses
    // so the JSON demo + smokes still work, same as the data/export gate).
    if (getAuthMode() === "production") {
      try {
        const user = await resolveCurrentUser(request);
        if (user.role !== "owner") {
          return json({ success: false, error: { code: "FORBIDDEN", message: "Customer erasure requires owner access." } }, 403);
        }
      } catch (error) {
        const status = error instanceof AuthenticationError ? error.statusCode : 401;
        return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
      }
    }
    const { confirmName, actorUserId: bodyActor } = body || {};
    // Cluster E fix (2026-07-21 session 20): actor from session, not body.
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, bodyActor)).userId;
    const lead = await repos.lead.getLeadById(workspaceId, path[1]);
    if (!lead) return notFoundResponse("Lead not found");

    // Load all 10 cascade record types in parallel. Each call is workspace-
    // scoped so we never accidentally plan another tenant's data.
    // Cluster 5 P1-2: every `.catch(() => [])` here was a silent count-lie.
    // Replaced with safeNotFound — only not-found is swallowed; real errors
    // (corrupt JSON, repo throw) re-throw so the operator never approves a
    // delete thinking "0 records to lose" when the repo actually crashed.
    const { safeNotFound } = await import("@/lib/safe-not-found");
    const [
      replies, tickets, ticketEvents, orders, quotes,
      outreachActivities, autoReplyLogs, unknownQuestions, humanFallbackTasks,
    ] = await Promise.all([
      safeNotFound(() => repos.reply.listByWorkspace(workspaceId), { fallback: [] as Reply[], context: "erasure reply.listByWorkspace" }),
      safeNotFound(() => repos.ticket.listByWorkspace(workspaceId, { leadId: path[1] }), { fallback: [] as Ticket[], context: "erasure ticket.listByWorkspace" }),
      // TicketEvents: load all events for the workspace, then filter to the
      // tickets being erased (eraseCustomer() does the actual filter).
      safeNotFound(
        async () => {
          const ts = await repos.ticket.listByWorkspace(workspaceId, { leadId: path[1] });
          const eventArrays = await Promise.all(
            ts.map((t) => repos.ticketEvent.listByTicket(workspaceId, t.id)),
          );
          return eventArrays.flat();
        },
        { fallback: [] as TicketEvent[], context: "erasure ticketEvent.listByTicket" },
      ),
      safeNotFound(() => repos.order.listByLead(workspaceId, path[1]), { fallback: [], context: "erasure order.listByLead" }),
      safeNotFound(() => repos.quote.listByLead(workspaceId, path[1]), { fallback: [], context: "erasure quote.listByLead" }),
      safeNotFound(() => repos.outreachActivity.listByLead(workspaceId, path[1]), { fallback: [], context: "erasure outreachActivity.listByLead" }),
      safeNotFound(() => repos.autoReplyLog.listByWorkspace(workspaceId), { fallback: [], context: "erasure autoReplyLog.listByWorkspace" }),
      safeNotFound(() => repos.unknownQuestion.listByWorkspace(workspaceId), { fallback: [], context: "erasure unknownQuestion.listByWorkspace" }),
      // HumanFallbackTask has no dedicated repository, so it is loaded from the
      // whole-store read.
      //
      // 2026-08-25 (audit A-7, N-DATA-16): this used to call readData() from
      // @/lib/db, which is the JSON file and ONLY the JSON file — it does not
      // dispatch on the persistence provider. On Postgres this erasure ran
      // against a JSON file nothing else in the app writes to, so it found no
      // fallback tasks and erased none of them: personal data left behind by a
      // right-to-erasure request. repos.readAll() is provider-aware and its
      // Prisma implementation covers humanFallbackTasks.
      safeNotFound(
        async () => ((await repos.readAll!()).humanFallbackTasks || []).filter((t) => t.workspaceId === workspaceId),
        { fallback: [], context: "erasure humanFallbackTasks" },
      ),
    ]);
    // S6 S-5: was loading the ENTIRE DNC registry across all workspaces, then
    // passing it to eraseCustomer (which filters by phone/email/leadId but NOT
    // workspaceId). At Stage 5 this could leak a count signal from another
    // tenant's DNC entries. Now scoped to this workspace.
    //
    // 2026-08-25 (audit A-7, N-DATA-16): same JSON-file bug as above, and worse
    // here — the do-not-contact registry is the one thing an erasure must
    // PRESERVE. Reading an empty JSON registry on Postgres meant the erasure
    // could not preserve what it could not see. There is a real repository for
    // this collection and it is already workspace-scoped at the query.
    const dncRegistry = await repos.doNotContact.listByWorkspace(workspaceId);

    // Layer 2 — call the pure planning function. It re-checks owner +
    // confirmName internally (defense in depth; tests pin both throws).
    let plan;
    try {
      plan = await eraseCustomer({
        workspaceId,
        leadId: path[1],
        actor: { userId: actorUserId || "owner", actorType: "owner" },
        confirmName: String(confirmName || ""),
        lead,
        replies: replies as Reply[],
        tickets: tickets as Ticket[],
        ticketEvents: ticketEvents as TicketEvent[],
        orders: orders as Order[],
        quotes: quotes as Quote[],
        outreachActivities: outreachActivities as OutreachActivity[],
        autoReplyLogs: autoReplyLogs as AutoReplyLog[],
        unknownQuestions: unknownQuestions as UnknownQuestion[],
        humanFallbackTasks: humanFallbackTasks as HumanFallbackTask[],
        doNotContactRegistry: dncRegistry,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /forbidden|owner/i.test(message) ? 403 : 422;
      return json({ success: false, error: { code: status === 403 ? "FORBIDDEN" : "VALIDATION_ERROR", message } }, status);
    }

    // Layer 3 — execute the cascade ATOMICALLY (Cluster D fix, session 20).
    // The OLD code did 9 separate awaits (one per record type), so a crash
    // mid-cascade left half-deleted records. Now JSON mode runs the entire
    // cascade inside ONE mutateData transaction. Pinned by
    // golden:erasure-atomicity. Prisma mode keeps the per-repo calls for
    // now (Prisma gets its own $transaction wrap in Cluster F).
    let cascadeCounts: { replies: number; tickets: number; ticketEvents: number; orders: number; quotes: number; outreachActivities: number; autoReplyLogs: number; unknownQuestions: number; humanFallbackTasks: number; mediaItems: number; reviewDecisions: number; messageDrafts: number; agentRuns: number; webhookPhonesScrubbed: number; lead: number };
    let cascadePreservedDnc: number;
    let mediaStoragePathsToDelete: string[] = [];
    let mediaItemIdsToPurge: string[] = [];
    if (getPersistenceProvider() === "json") {
      const { eraseLeadCascade } = await import("@/services/ErasureCascade");
      const { readData, mutateData } = await import("@/lib/db");
      const result = await eraseLeadCascade({
        workspaceId,
        leadId: path[1],
        data: await readData(),
        mutateData: mutateData as never,
      });
      cascadeCounts = {
        replies: result.counts.replies,
        tickets: result.counts.tickets,
        ticketEvents: result.counts.ticketEvents,
        orders: result.counts.orders,
        quotes: result.counts.quotes,
        outreachActivities: result.counts.outreachActivities,
        autoReplyLogs: result.counts.autoReplyLogs,
        unknownQuestions: result.counts.unknownQuestions,
        humanFallbackTasks: result.counts.humanFallbackTasks,
        mediaItems: result.counts.mediaItems,
        reviewDecisions: result.counts.reviewDecisions,
        messageDrafts: result.counts.messageDrafts,
        agentRuns: result.counts.agentRuns,
        webhookPhonesScrubbed: result.counts.webhookPhonesScrubbed,
        lead: result.counts.lead,
      };
      cascadePreservedDnc = result.preservedDncCount;
      mediaStoragePathsToDelete = result.mediaStoragePathsToDelete;
      mediaItemIdsToPurge = result.mediaItemIdsToPurge;
    } else {
      // Prisma mode — per-repo deletes. Cluster 6 fix (P1-6): wrap in a
      // defensive try/catch so a mid-cascade crash is VISIBLE (not silent
      // partial deletion — a DPDPA violation). The JSON mode above is fully
      // atomic via eraseLeadCascade; Prisma gets a true $transaction wrap
      // when the Order/Quote Prisma models ship (Stage 5). Until then, a
      // partial failure throws a clear error + records an audit entry so the
      // operator can reconcile.
      // 2026-09-28 (S5): one shared, golden-pinned function
      // (eraseLeadViaRepositories) now also removes review notes, drafted
      // messages, reminders, agent runs about the customer and their number
      // in the webhook log — and passes TICKET ids to the ticket-event delete
      // (it was handed event ids, which matched nothing).
      let repoCounts: import("@/services/ErasureCascade").RepositoryErasureCounts;
      try {
        const { eraseLeadViaRepositories } = await import("@/services/ErasureCascade");
        repoCounts = await eraseLeadViaRepositories({ workspaceId, lead, repos });
      } catch (cascadeError) {
        // Partial cascade. Record loudly + re-throw with context.
        await repos.auditLog.create({
          workspaceId,
          eventType: "customer_erased_partial",
          actorUserId: actorUserId || "owner",
          entityType: "lead",
          entityId: path[1],
          payload: {
            warning: "Erasure cascade failed mid-way. Some customer records may still exist — manual reconciliation required.",
            error: cascadeError instanceof Error ? cascadeError.message : String(cascadeError),
          },
        }).catch(() => undefined);
        throw new Error(`Erasure cascade failed mid-way (DPDPA risk — manual reconciliation required): ${cascadeError instanceof Error ? cascadeError.message : String(cascadeError)}`);
      }
      cascadeCounts = {
        replies: repoCounts.replies,
        tickets: repoCounts.tickets,
        ticketEvents: repoCounts.ticketEvents,
        orders: repoCounts.orders,
        quotes: repoCounts.quotes,
        outreachActivities: repoCounts.outreachActivities,
        autoReplyLogs: repoCounts.autoReplyLogs,
        unknownQuestions: repoCounts.unknownQuestions,
        // Removed by the database with the chat lines they hang off.
        humanFallbackTasks: plan.deleted.humanFallbackTaskIds.length,
        mediaItems: repoCounts.mediaItems,
        reviewDecisions: repoCounts.reviewDecisions,
        messageDrafts: repoCounts.messageDrafts,
        agentRuns: repoCounts.agentRuns,
        webhookPhonesScrubbed: repoCounts.webhookPhonesScrubbed,
        lead: repoCounts.lead,
      };
      cascadePreservedDnc = plan.preservedDncIds.length;
    }
    // CP-13e (2026-08-01) — JSON mode collected file paths inside the atomic
    // transaction; the DB rows are already gone. Now best-effort-delete the
    // actual files AFTER commit (filesystem ops can't be transactional). A
    // failed file delete is non-fatal + logged (no silent gap) — the DB row is
    // already removed, so the worst case is an orphan file, never corrupt data.
    for (const storagePath of mediaStoragePathsToDelete) {
      await import("node:fs/promises").then(({ rm }) => rm(storagePath, { force: true }).catch((e) => {
        console.error(`[erasure] media file delete failed for ${storagePath}:`, e);
      }));
    }
    // 2026-09-10: media uploaded since the bytes moved off the container's
    // filesystem has no storagePath at all, so the loop above would silently
    // erase nothing. The cascade removed the rows itself inside the snapshot
    // mutation and therefore never reached the repository's delete -- ask the
    // store directly to forget the bytes, or a customer's erased photos live on
    // with nothing naming them.
    if (mediaItemIdsToPurge.length) {
      const { purgeMediaBlobs } = await import("@/repositories/json");
      await purgeMediaBlobs(mediaItemIdsToPurge).catch((e) => {
        console.error("[erasure] media byte purge failed:", e);
      });
    }
    // PRESERVES the DNC entry per LOGIC.md Q18 — do NOT delete doNotContactRegistry.

    // Layer 4 — write the anonymized audit entry (preserved forever).
    await repos.auditLog.create({
      workspaceId,
      eventType: "customer_erased",
      actorUserId: actorUserId || "owner",
      entityId: path[1],
      entityType: "lead",
      payload: {
        anonymizedCustomerId: plan.auditEntry.anonymizedCustomerId,
        note: plan.auditEntry.note,
        deletedCounts: cascadeCounts,
        preservedDncCount: cascadePreservedDnc,
      },
    } as Partial<AuditLog>);

    return json({
      erased: true,
      leadId: path[1],
      anonymizedCustomerId: plan.auditEntry.anonymizedCustomerId,
      deletedCounts: cascadeCounts,
      preservedDncCount: cascadePreservedDnc,
    });
  }

  // N2 + N10 (2026-09-23) — measure what each layer of search buys on THIS
  // workspace's real knowledge. Owner-only (ai prefix), rate-limited like the
  // other AI tests. Sends nothing; costs one embedding per question plus the
  // loop's calls where the plain search was weak.
  if (match(path, ["ai", "measure-retrieval"])) {
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    const { measureRetrieval } = await import("@/services/RetrievalMeasurementService");
    return json(await measureRetrieval(workspaceId, repos));
  }
  if (match(path, ["ai", "test-model-routing"])) {
    // F-WIRE-2 (2026-08-04 build-right audit, P3): this was an unconditional
    // stub that ALWAYS returned provider:"mock", status:"ok", "Mock routing is
    // active" — regardless of the workspace's actual configured routing. An API
    // consumer (or future UI) calling it would be misled into thinking routing
    // is healthy when it may not be. Now it returns an honest "not implemented"
    // status so it can't be mistaken for a real health check. The real
    // per-slot test is POST /ai/model-slots/:slotId/test (wired + working).
    return json({
      taskName: body.taskName || "message_generation",
      provider: "not_implemented",
      modelTier: "not_implemented",
      status: "not_implemented",
      message: "This endpoint is a legacy stub and does not perform a real routing test. Use POST /api/ai/model-slots/:slotId/test to test a configured slot.",
    });
  }

  if (match(path, ["ai", "models", "fetch"])) {
    const parsed = modelFetchSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    const provider = isLLMProviderId(String(body.provider || "")) ? body.provider : "mock";
    const credential = body.credentialId
      ? (await repos.llmProviderCredential.listByWorkspace(workspaceId)).find((item) => item.id === body.credentialId)
      : { provider, encryptedApiKey: body.apiKey ? String(body.apiKey) : undefined, config: { baseUrl: body.baseUrl } };
    return json(await fetchProviderModels(provider, credential));
  }

  if (match(path, ["ai", "models", "validate-selection"])) {
    const provider = isLLMProviderId(String(body.provider || "")) ? body.provider : "mock";
    const model = findModel(provider, String(body.modelName || ""));
    return json(validateModelCapability(model, String(body.slotId || "daily_workhorse") as never));
  }

  if (match(path, ["ai", "model-slots", ":slotId", "test"])) {
    const limit = await checkRateLimit({ workspaceId, action: "llm_test" });
    if (!limit.allowed) return json({ success: false, error: { code: "RATE_LIMITED", message: limit.reason, details: limit } }, 429);
    
    const slotId = path[2];
    const taskName = testTaskForSlot(slotId);
    const overridePrompt = `Return only this JSON: {"ok": true, "message": "connected"}`;
    
    try {
      const result = await new LLMService().runTask(taskName, { }, { workspaceId, overridePrompt, slotId: slotId as never });
      
      const slotDisplayName = ({
        fast_customer_reply: "Fast Customer Reply Model",
        daily_workhorse: "Daily Workhorse Model",
        deep_reasoning: "Deep Reasoning Model",
        research_search: "Research / Search Model",
        creative_image: "Creative / Image Model",
        embedding_advanced: "Embedding / Knowledge Search Model",
      } as Record<string, string>)[slotId] || slotId.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());

      const providerId = (result.provider || "ollama") as LLMProviderId;
      let providerDisplayName = PROVIDER_LABELS[providerId] || (providerId ? providerId.charAt(0).toUpperCase() + providerId.slice(1) : "Ollama local");
      let effectiveModelName = result.modelName || "gemma:2b";

      // Final safety for Ollama
      if (providerId === "ollama") {
        providerDisplayName = "Ollama local";
        if (!result.modelName || result.modelName === "ollama-custom") {
           effectiveModelName = "Custom Ollama Model";
        }
      }

      return json({
        success: true,
        data: {
          slotKey: slotId,
          slotDisplayName,
          provider: providerId,
          providerDisplayName,
          modelName: result.modelName || effectiveModelName,
          effectiveModelName,
          baseUrl: result.baseUrl || (providerId === "ollama" ? "http://localhost:11434" : ""),
          mode: result.mode || "unknown",
          fallbackUsed: Boolean(result.fallbackUsed),
          fallbackProvider: result.fallbackProvider || null,
          fallbackModelName: result.fallbackModelName || null,
          fallbackReason: result.warning || null,
          credentialUsed: Boolean(result.credentialUsed),
          testPrompt: result.testPrompt || overridePrompt,
          testResponse: typeof result.output === "object" ? JSON.stringify(result.output) : String(result.output),
          latencyMs: result.latencyMs || 0,
          status: result.fallbackUsed ? "fallback_used" : "ready",
          message: result.fallbackUsed ? "Fallback was used because the primary model failed." : "The selected model responded successfully and is ready to use.",
          routeSource: result.routeSource || "unknown",
          runId: result.runId || null,
          debug: {
            taskName,
            resultProvider: result.provider,
            resultModelName: result.modelName,
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Test failed";
      
      const slotDisplayName = ({
        fast_customer_reply: "Fast Customer Reply Model",
        daily_workhorse: "Daily Workhorse Model",
        deep_reasoning: "Deep Reasoning Model",
        research_search: "Research / Search Model",
        creative_image: "Creative / Image Model",
        embedding_advanced: "Embedding / Knowledge Search Model",
      } as Record<string, string>)[slotId] || slotId;

      return json({
        success: false,
        error: {
          code: "PROVIDER_ERROR",
          message,
          details: {
            slotKey: slotId,
            slotDisplayName,
          }
        }
      }, 500);
    }
  }

  if (match(path, ["lead-review", "settings"])) {
    const input = settingsInput(leadReviewSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    return json(await updateLeadReviewSettings(workspaceId, input.data, repos));
  }
  if (match(path, ["agent-autonomous", "settings"])) {
    const input = settingsInput(agentAutonomousSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    return json(await updateAgentAutonomousSettings(workspaceId, input.data, repos));
  }

  return json({ error: "Route not found", path }, 404);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  try {
    return await handlePut(request, context);
  } catch (error) {
    return errorToResponse(error);
  }
}

async function handlePut(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const path = (await context.params).path || [];
  const body = await safeBody(request);
  const repos = createRepositories();
  if (getAuthMode() === "production" && !productionAuthConfigured()) return forbiddenResponse("Production authentication is not configured.");

  // Stage 5 / WP5 (2026-07-29) — front-door rate limit (mirrors handleGet/Post).
  const putEdgeBlock = await applyEdgeRateLimit(request, path, await resolveWorkspaceId(request));
  if (putEdgeBlock) return putEdgeBlock;

  // Cluster B fix (2026-07-21 session 17): workspace resolution via the
  // shared helper (see handlePost for the full comment). Pinned by
  // golden:workspace-scoping.
  let workspaceId: string = defaultWorkspaceId;
  if (getAuthMode() === "production") {
    const { resolveMutationWorkspace } = await import("./workspace-resolution");
    let sessionUser: { workspaceId: string; userId: string } | null = null;
    try {
      const u = await resolveCurrentUser(request);
      sessionUser = u ? { workspaceId: u.workspaceId, userId: u.id } : null;
    } catch {
      sessionUser = null;
    }
    const resolution = await resolveMutationWorkspace({
      authMode: getAuthMode(),
      request,
      bodyWorkspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
      sessionUser,
    });
    if (!resolution.ok) {
      return json({ success: false, error: { code: resolution.code, message: resolution.message } }, resolution.status);
    }
    workspaceId = resolution.workspaceId;
  } else {
    // Demo: the body may name the workspace, but only as text — a number or
    // object used to become the stored workspaceId (break test, 2026-09-26).
    workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId : defaultWorkspaceId;
  }

  // Session 1 auth + CSRF gate for every PUT + Phase 5.8 RBAC gate.
  {
    const gate = await enforceAuthGate(request);
    if (gate) return gate;
  }

  // ---- Security-critical routes: STRICT validation (no unknown fields) -----
  // These routes touch fields an attacker could abuse (DNC, review status,
  // WhatsApp mode, API keys). Unknown fields are rejected.
  if (match(path, ["leads", ":id"])) {
    const parsed = leadUpdateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    // 2026-09-27 (break test L8/L9): the do-not-contact register and the
    // campaign's owner are checked in the service.
    const { updateLeadDetails } = await import("@/services/LeadImportService");
    let actorUserId = "user_owner";
    try {
      actorUserId = (await resolveCurrentUser(request))?.id || actorUserId;
    } catch {
      // Demo mode or no session: the default actor stands.
    }
    return json(await updateLeadDetails(workspaceId, path[1], parsed.data, repos, actorUserId));
  }

  // 2026-09-27 (A2) — the owner corrects what the AI remembers about a
  // customer. Sales-member gated by the "leads" prefix; an empty note hands
  // the memory back to the AI.
  if (match(path, ["leads", ":id", "memory"])) {
    const { resolveActor } = await import("./workspace-resolution");
    const actor = (await resolveActor(request, typeof body?.actorUserId === "string" ? body.actorUserId : undefined)).userId;
    const { editLeadMemoryAsOwner } = await import("@/services/LeadMemoryService");
    return json(await editLeadMemoryAsOwner(workspaceId, path[1], body.memory, actor, repos));
  }

  if (match(path, ["leads", ":id", "discovery-facts", ":key"])) {
    const { resolveActor } = await import("./workspace-resolution");
    const actor = (await resolveActor(request, typeof body?.actorUserId === "string" ? body.actorUserId : undefined)).userId;
    const { changeLeadDiscoveryFact } = await import("@/services/DiscoveryService");
    return json(await changeLeadDiscoveryFact(workspaceId, path[1], path[3], { action: body.action, value: body.value }, actor, repos));
  }

  // N12 — the owner's buyer checklist. Admin-gated by the whatsapp-agent
  // prefix: what the business wants to learn about buyers is a workspace-wide
  // decision, not something one salesperson changes for everyone.
  if (match(path, ["whatsapp-agent", "discovery-checklist"])) {
    const { saveDiscoveryChecklist } = await import("@/services/DiscoveryService");
    return json(await saveDiscoveryChecklist(workspaceId, { spine: body.spine, segments: body.segments }, repos));
  }
  if (match(path, ["whatsapp-agent", "settings"])) {
    const parsed = whatsappSettingsUpdateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const result = await updateWhatsAppSettings(workspaceId, parsed.data);
    // CP-23 — wire the batching toggle to the in-process batcher.
    const { setMessageBatchingEnabled } = await import("@/services/MessageBatcher");
    setMessageBatchingEnabled(Boolean(parsed.data.messageBatchingEnabled));
    return json(result);
  }

  // CP-25 — update a WhatsApp template.
  if (match(path, ["whatsapp-templates", ":id"])) {
    return json(await repos.whatsAppTemplate.update(workspaceId, path[1], {
      name: typeof body.name === "string" ? body.name : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
      language: typeof body.language === "string" ? body.language : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      header: typeof body.header === "string" ? body.header : undefined,
      footer: typeof body.footer === "string" ? body.footer : undefined,
      status: (typeof body.status === "string" && ["draft", "pending", "approved", "rejected", "paused"].includes(body.status) ? body.status : undefined) as "draft" | "pending" | "approved" | "rejected" | "paused" | undefined,
    }));
  }

  // D-2026-08-02 / CP-17 FIX (walkthrough sweep): the per-workspace WhatsApp
  // credentials PUT route was misplaced INSIDE handlePost (where request.method
  // is always POST, so the `=== "PUT"` guard was always false → 404). Moved
  // here to handlePut where it belongs. Same root cause as the earlier CP-17
  // GET-route misplacement; the PUT + DELETE were left behind. Caught by the
  // full-button sweep (Integrations → "Save credentials" → 404).
  if (match(path, ["whatsapp-agent", "credentials"])) {
    const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
    const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
    const businessAccountId = typeof body.businessAccountId === "string" ? body.businessAccountId.trim() : undefined;
    // undefined leaves the stored verify token alone; "" clears it.
    const verifyToken = typeof body.verifyToken === "string" ? body.verifyToken : undefined;
    if (!phoneNumberId) {
      return json({ success: false, error: { code: "VALIDATION_ERROR", message: "Phone number ID is required." } }, 400);
    }
    try {
      await new WhatsAppCredentialService(repos).save(workspaceId, { accessToken, phoneNumberId, businessAccountId, verifyToken });
    } catch (error) {
      return json({ success: false, error: { code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "Could not save WhatsApp credentials." } }, 400);
    }
    return json({ success: true });
  }

  if (match(path, ["ai", "settings"])) {
    const parsed = aiSettingsUpdateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    return json(await updateAISettings(workspaceId, parsed.data));
  }

  // ---- Admin settings routes: sanitize dangerous keys, pass through -------
  // These routes are admin-only (gated by auth above). The body is already
  // prototype-stripped by safeBody(); we run sanitizeStrictShape as defense in
  // depth before handing the rich object to the repo layer.
  if (match(path, ["business-profile", ":id"])) {
    // F-7: same format check as the POST path above.
    const parsed = businessProfileUpdateSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error.flatten());
    const updatedProfile = await repos.businessProfile.update(workspaceId, path[1], {
      ...sanitizeStrictShape(body, [...GOVERNED_FIELDS.businessProfile]),
      // Moving a profile BACK to draft is allowed here; approving it is not
      // (that is POST business-profile/:id/approve, which records who did it).
      ...(body.status === "draft" ? { status: "draft" as const } : {}),
    });
    // N-AI-10: same rebuild as the POST path above.
    const knowledge = await refreshBusinessProfileKnowledge(workspaceId, repos);
    return json({ ...updatedProfile, knowledge });
  }

  if (match(path, ["icp", ":id"])) {
    return json(await repos.icp.update(workspaceId, path[1], sanitizeStrictShape(body, [...GOVERNED_FIELDS.icp])));
  }

  if (match(path, ["campaigns", ":id"])) {
    return json(await repos.campaign.update(workspaceId, path[1], sanitizeStrictShape(body, [...GOVERNED_FIELDS.campaign])));
  }

  if (match(path, ["messages", ":id"])) {
    return json(await repos.messageTemplate.update(workspaceId, path[1], sanitizeStrictShape(body, [...GOVERNED_FIELDS.messageTemplate])));
  }

  if (match(path, ["integrations", ":id"])) {
    return json(await repos.integration.update(workspaceId, path[1], sanitizeStrictShape(body)));
  }

  if (match(path, ["knowledge", "documents", ":id"])) {
    const existing = await getKnowledgeDocument(workspaceId, path[2]);
    if (!existing) return notFoundResponse("Knowledge document not found");
    if (existing.documentType === "agent_instruction" || existing.source === "workspace_override" || body.documentType === "agent_instruction" || body.source === "workspace_override") {
      await requireRole(request, "owner");
      // A generic document edit must not bypass the validated specialist save,
      // change its role, or promote an ordinary document into guidance.
      return json({ success: false, error: { code: "INVALID_AGENT_GUIDANCE", message: "Save additional agent instructions from the Agent Instructions page." } }, 400);
    }
    return json(await updateKnowledgeDocument(workspaceId, path[2], sanitizeStrictShape(body)));
  }

  // N13 — the owner confirms or changes the kind of business the checklist
  // follows ("Your checklist: … · Change" on the Knowledge Base).
  if (match(path, ["knowledge", "checklist"])) {
    const result = await setWorkspaceChecklist(workspaceId, { kinds: body.kinds, exports: body.exports }, repos);
    if (result.problem) return json({ success: false, error: { code: "VALIDATION_ERROR", message: result.problem, details: {} } }, 400);
    const choice = result.checklist!.choice;
    return json({ kinds: choice.kinds, exports: choice.exports, source: choice.source, description: describeChecklist(choice), questionCount: result.checklist!.questions.length });
  }

  if (match(path, ["knowledge", "question-answers", ":id"])) {
    const input = settingsInput(knowledgeAnswerEditSchema, body);
    if (!input.ok) return input.response;
    return json(await updateKnowledgeQuestionAnswer(workspaceId, path[2], input.data, repos));
  }

  if (match(path, ["knowledge", "question-answers", ":id", "approve"])) {
    return json(await approveKnowledgeQuestionAnswer(workspaceId, path[2], repos));
  }

  // 2026-09-18 (session 57) — after correcting an answer, ask which lines in
  // the uploaded documents it replaces. This READS and proposes; it changes
  // nothing. The owner decides, because the system cannot reliably tell a
  // contradiction ("MOQ 50 kg") from a different case ("MOQ 50 kg for stocked
  // shades, 100 kg for custom"), and getting that wrong deletes a true fact.
  if (match(path, ["knowledge", "question-answers", ":id", "superseded-candidates"])) {
    const answers = await listKnowledgeQuestionAnswers(workspaceId, repos);
    const answer = answers.find((item) => item.id === path[2]);
    if (!answer) return json({ error: "Knowledge question answer not found" }, 404);
    return json({ candidates: await proposeSupersededChunks(workspaceId, answer, repos) });
  }

  // Retire one document line the owner has confirmed is superseded. The chunk
  // keeps its text — it is the evidence of what the file said — but leaves the
  // search index. Undo with .../restore.
  if (match(path, ["knowledge", "chunks", ":id", "retire"])) {
    const schema = z.object({ answerId: z.string().min(1), replacedBy: z.string().optional() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return json({ error: "answerId is required to record WHY a line was retired." }, 400);
    const { resolveActor } = await import("./workspace-resolution");
    const actor = (await resolveActor(request, typeof body?.actorUserId === "string" ? body.actorUserId : undefined)).userId;
    const chunk = await retireChunk(workspaceId, path[2], { ...parsed.data, actorUserId: actor }, repos);
    if (!chunk) return json({ error: "Knowledge chunk not found" }, 404);
    return json({ chunk });
  }

  if (match(path, ["knowledge", "chunks", ":id", "restore"])) {
    const { resolveActor: resolveRestoreActor } = await import("./workspace-resolution");
    const restoreActor = (await resolveRestoreActor(request, typeof body?.actorUserId === "string" ? body.actorUserId : undefined)).userId;
    const chunk = await restoreChunk(workspaceId, path[2], repos, restoreActor);
    if (!chunk) return json({ error: "Knowledge chunk not found" }, 404);
    return json({ chunk });
  }

  if (match(path, ["ai", "usage-limits"])) {
    // A cap is a safety rail the owner sets, so it is theirs to move. Zero and
    // null both mean "no cap" — the health check already treats a cap of 0 as
    // unset — and a negative one would block every call with no way to read why.
    const capSchema = z.object({
      dailyTokenLimit: z.number().min(0).max(1_000_000_000).nullish(),
      monthlyTokenLimit: z.number().min(0).max(1_000_000_000).nullish(),
      dailyCostLimit: z.number().min(0).max(1_000_000).nullish(),
      monthlyCostLimit: z.number().min(0).max(1_000_000).nullish(),
    });
    const parsedCaps = capSchema.safeParse(body);
    if (!parsedCaps.success) return validationErrorResponse(parsedCaps.error.flatten());
    // Clearing a cap has to travel as 0, not as undefined. Both substrates read
    // undefined as "leave this column alone" — the JSON repository's
    // assignUpdate skips it and Prisma's update ignores it — so an emptied box
    // sent as undefined would look saved and leave the old cap blocking. The
    // health check already treats a cap of 0 as unset, so 0 IS "no cap".
    const patch: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsedCaps.data)) {
      if (value === undefined) continue;
      patch[key] = value === null ? 0 : value;
    }
    const saved = await repos.aiUsageLimit.upsertForWorkspace(workspaceId, patch);
    const { resolveActor: resolveCapActor } = await import("./workspace-resolution");
    await safeAudit(repos, {
      workspaceId,
      userId: (await resolveCapActor(request, body?.actorUserId)).userId,
      action: "ai.usage_limit_changed",
      entityType: "ai_usage_limit",
      entityId: saved.id,
      newValuesJson: patch,
    });
    return json(saved);
  }

  if (match(path, ["ai", "model-routing"])) {
    return json(await updateModelRouting(workspaceId, Array.isArray(body.routes) ? body.routes : []));
  }

  if (match(path, ["ai", "model-slots"])) {
    // F-7: baseUrl/fallbackBaseUrl feed straight into an outbound LLM request
    // — a malformed one fails at call time with a confusing provider error
    // instead of at save time with a clear one.
    const parsedSlots = z.array(modelSlotSchema).safeParse(Array.isArray(body.slots) ? body.slots : []);
    if (!parsedSlots.success) return validationErrorResponse(parsedSlots.error.flatten());
    return json(await updateModelSlots(workspaceId, parsedSlots.data));
  }

  if (match(path, ["lead-review", "settings"])) {
    const input = settingsInput(leadReviewSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    return json(await updateLeadReviewSettings(workspaceId, input.data, repos));
  }

  if (match(path, ["agent-autonomous", "settings"])) {
    const input = settingsInput(agentAutonomousSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    return json(await updateAgentAutonomousSettings(workspaceId, input.data, repos));
  }

  if (match(path, ["unknown-questions", ":id"])) {
    return json(await updateUnknownQuestion(workspaceId, path[1], sanitizeStrictShape(body)));
  }

  if (match(path, ["settings", "sales"])) {
    const input = settingsInput(salesSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    const result = await updateSalesSettings(workspaceId, input.data, repos);
    const sync = await syncStructuredSettingsToQuestions(workspaceId, { sales: result }, repos);
    return json({ settings: result, sync });
  }
  if (match(path, ["settings", "products"])) {
    const input = settingsInput(productSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    const products = input.data.products?.map((product) => ({ ...product, id: product.id || uid("prod") }));
    const result = await updateProductSettings(workspaceId, products ? { products: products as never } : {}, repos);
    const sync = await syncStructuredSettingsToQuestions(workspaceId, { product: result }, repos);
    return json({ settings: result, sync });
  }
  if (match(path, ["settings", "policy"])) {
    const input = settingsInput(policySettingsSaveSchema, body);
    if (!input.ok) return input.response;
    const result = await updatePolicySettings(workspaceId, input.data, repos);
    const sync = await syncStructuredSettingsToQuestions(workspaceId, { policy: result }, repos);
    return json({ settings: result, sync });
  }
  if (match(path, ["settings", "communication"])) {
    const input = settingsInput(communicationSettingsSaveSchema, body);
    if (!input.ok) return input.response;
    const result = await updateCommunicationSettings(workspaceId, input.data, repos);
    const sync = await syncStructuredSettingsToQuestions(workspaceId, { communication: result }, repos);
    return json({ settings: result, sync });
  }

  return json({ error: "Route not found", path }, 404);
}

/**
 * 2026-09-26 (break test) — a settings save accepts only the fields that
 * settings type has, with the right types (src/validation/schemas.ts). Before,
 * the whole request was stored: a wrong-shaped product list wiped the
 * products, and junk keys / a forged id were saved. Returns the clean input,
 * or a 400 response naming what was wrong.
 */
function settingsInput<T extends z.ZodTypeAny>(schema: T, body: Record<string, unknown>): { ok: true; data: z.infer<T> } | { ok: false; response: NextResponse } {
  const parsed = schema.safeParse(withoutNulls(body));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join(".") || "request";
    return { ok: false, response: json({ success: false, error: { code: "VALIDATION_ERROR", message: `"${field}" is not in the right form: ${first?.message || "invalid"}. Nothing was saved.`, details: parsed.error.flatten() } }, 400) };
  }
  return { ok: true, data: parsed.data };
}

function match(path: string[], pattern: string[]) {
  if (path.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || part === path[index]);
}

function testTaskForSlot(slotId: string) {
  const map: Record<string, "whatsapp_reply" | "message_generation" | "campaign_planning" | "web_search" | "image_generation" | "embedding"> = {
    fast_customer_reply: "whatsapp_reply",
    daily_workhorse: "message_generation",
    deep_reasoning: "campaign_planning",
    research_search: "web_search",
    creative_image: "image_generation",
    embedding_advanced: "embedding",
  };
  return map[slotId] || "whatsapp_reply";
}

// The safeBody return type is intentionally loose to preserve backward
// compatibility with the many downstream string reads of `body.someField`.
// Runtime safety is enforced by parseBodySafely (prototype-key stripping) and
// strict zod schemas on the security-critical PUT routes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseBody = Record<string, any>;

class MalformedBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedBodyError";
  }
}

/**
 * Map a caught error to a JSON response. Centralizes the small set of error
 * shapes we want to translate into specific HTTP statuses so each top-level
 * handler (GET/POST/PUT/DELETE) behaves consistently:
 *   - MalformedBodyError -> 400 (Phase 5.4)
 *   - "not found" message -> 404
 *   - AuthenticationError (auth-service) -> its own statusCode
 *   - everything else -> 500
 */
function errorToResponse(error: unknown, fallbackCode = "PROVIDER_ERROR") {
  // 2026-09-26 — "you need to do X first" is the person's next step, not a
  // server fault: show it as written (see src/lib/user-errors.ts).
  if (error instanceof NeedsActionError) {
    return json({ success: false, error: { code: error.statusCode === 404 ? "NOT_FOUND" : "NEEDS_ACTION", message: error.message, details: {} } }, error.statusCode);
  }
  if (error instanceof MalformedBodyError) {
    return json({ success: false, error: { code: "MALFORMED_JSON", message: error.message, details: {} } }, 400);
  }
  if (error instanceof AuthorizationError) {
    return json({ success: false, error: { code: "FORBIDDEN", message: error.message, details: {} } }, error.statusCode);
  }
  if (error instanceof AuthenticationError) {
    return json({ success: false, error: { code: "UNAUTHENTICATED", message: error.message, details: {} } }, error.statusCode);
  }
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  const status = /not found/i.test(message) ? 404 : /cannot|only approved|do-not-contact|blocked|forbidden/i.test(message) ? 400 : 500;
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "VALIDATION_ERROR" : fallbackCode;
  // Stage 5 / WP5 (2026-07-29) — on a true 500 (server error, not user
  // error), route to Sentry + fire a SEV3 alert (queued for digest).
  //
  // DESIGN NOTE (build-right honesty): a per-500 alert is SEV3, NOT SEV1.
  // SEV1 is reserved for SYSTEM-WIDE events (DB down, auth broken) per
  // docs/LOGIC.md §WP5.1. A single 500 is a per-request bug; firing SEV1
  // per-500 would spam the operator's inbox if a bug affects many requests
  // (violating "only SEV1 wakes you"). The error-RATE detector on the
  // status page (errorRate card, threshold) is what escalates to SEV1 —
  // when many 500s pile up in an hour, the rate crosses threshold + the
  // banner goes red, and a future watchdog can promote that to a SEV1.
  //
  // The alert is async + never awaited (must not block the error response)
  // + never throws (AlertService wraps its own failures). 4xx errors are
  // user mistakes (not system health) and do NOT alert.
  if (status === 500) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { captureException } = require("@/lib/monitoring");
      captureException(error, { source: "api.errorToResponse.500" });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { routeAlert } = require("@/services/AlertService");
      void routeAlert({
        severity: "SEV3",
        event: "api_500_error",
        summary: message,
        context: { stack: error instanceof Error ? error.stack : undefined },
      }).catch(() => { /* alerting must never throw */ });
    } catch {
      // alerting/monitoring wiring must never become a new source of 500s
    }
  }
  // N-SEC-9 (2026-09-05). A 500 used to answer with the raw `error.message`.
  // For an unexpected error that message is written by whatever threw it, not
  // by us, and Prisma's is a small essay: the absolute path of the server file
  // it failed in, the generated chunk name, the surrounding source, the table
  // and the column. Asking POST /api/settings/pending-drafts with an empty body
  // returned every one of those to the caller.
  //
  // A 4xx message is ours — written for the person reading it, and the UI shows
  // it — so those are unchanged. A 500 means we did not expect this, and there
  // is nothing in an unexpected error that is both safe to publish and useful
  // to the reader. The full error still reaches the operator: captureException
  // and the SEV3 alert above already carry it, and the reference below ties the
  // customer's screenshot to that log line.
  if (status === 500) {
    const reference = `err_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    console.error(`[api] 500 ${reference}:`, error);
    return json({
      success: false,
      error: {
        code,
        message: `Something went wrong on our side. Nothing you did caused it. Quote reference ${reference} if you report it.`,
        details: { reference },
      },
    }, status);
  }
  return json({ success: false, error: { code, message, details: {} } }, status);
}

/* ===========================================================================
 * Phase 5.8: RBAC — minimum required role per route.
 *
 * Routes not listed default to `sales_member` for state-changing verbs
 * (POST/PUT/DELETE) — that is the minimum role for day-to-day CRM work, so a
 * viewer cannot mutate anything by default. Read (GET) has no role gate here
 * beyond the existing authenticated-session check; finer GET redaction is
 * handled by the response layer (Phase 5.10).
 *
 * Owner/admin-only actions (settings, integrations, credentials, AI config,
 * workspace membership, destructive bulk ops) are tagged explicitly. Add a
 * new entry here whenever you add a privileged route.
 *
 * 2026-07-27 (audit S6 S-1/S-2): the role map, role ladder, and
 * requiredRoleForPath() were extracted to src/lib/rbac-map.ts so the contract
 * can be golden-pinned (scripts/golden/golden-rbac-map.ts) and there is ONE
 * copy (build-right Phase 3d chokepoint rule). This file now imports them.
 * =========================================================================== */

/**
 * Production auth + CSRF + RBAC gate shared by POST/PUT/DELETE handlers.
 * Returns a JSON error response if the request must be rejected, or null if
 * it passed. In demo/local mode this is a no-op (returns null) so the JSON
 * demo and smoke tests keep working.
 */
async function enforceAuthGate(request: NextRequest): Promise<NextResponse | null> {
  if (getAuthMode() !== "production") return null;
  if (!productionAuthConfigured()) return forbiddenResponse("Production authentication is not configured.");
  if (!isCsrfSafe(request)) {
    return json({ success: false, error: { code: "CSRF_REJECTED", message: "Request blocked: cross-site form submission." } }, 403);
  }
  // Resolve the path from the request URL (handlers also do this, but we need
  // it here to pick the required role before the handler runs).
  const path = request.nextUrl.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  try {
    await requireRole(request, requiredRoleForPath(path, request.method.toUpperCase()));
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return json({ success: false, error: { code: "FORBIDDEN", message: error.message } }, 403);
    }
    const status = error instanceof AuthenticationError ? error.statusCode : 401;
    return json({ success: false, error: { code: "UNAUTHENTICATED", message: error instanceof Error ? error.message : "Authentication required." } }, status);
  }
  return null;
}

async function safeBody(request: NextRequest): Promise<LooseBody> {
  // Session 1 audit fix: parse + strip prototype-polluting keys (__proto__,
  // constructor, prototype) at the boundary so they can never reach the
  // Object.assign-based JSON repository layer. See src/lib/safe-body.ts.
  //
  // Phase 5.4: a present-but-malformed body now throws MalformedBodyError so
  // the route can answer 400 with the parse error instead of silently treating
  // broken JSON as an empty object (which masked broken clients and made every
  // downstream field look "missing").
  const result = await parseBodySafely(request);
  if (!result.ok) throw new MalformedBodyError(result.message);
  return result.value as LooseBody;
}

/** Reject a request that is not a file upload, or is too big, BEFORE reading it into memory. */
function assertFileUpload(request: NextRequest, maxBytes: number) {
  const type = request.headers.get("content-type") || "";
  if (!/multipart\/form-data/i.test(type)) throw new NeedsActionError("Attach a file to upload.", 400);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new NeedsActionError(`That upload is too large — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`, 400);
}

async function uploadMediaCatalogFile(request: NextRequest, repos: ReturnType<typeof createRepositories>) {
  // One 12 MB file plus the form's own bytes.
  assertFileUpload(request, 13 * 1024 * 1024);
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new NeedsActionError("Upload a catalog, certificate, image, or PDF file.", 400);
  const maxBytes = 12 * 1024 * 1024;
  if (file.size > maxBytes) throw new NeedsActionError("File is larger than 12 MB.", 400);
  // Cluster 1 fix (P0-4): resolve the workspace from the SESSION, then reject
  // any form-supplied workspaceId that doesn't match. Previously the workspace
  // was read straight from FormData, so an authenticated user could persist a
  // file into ANOTHER tenant's media catalog by sending FormData.workspaceId.
  const sessionWorkspaceId = await resolveWorkspaceId(request);
  const formWorkspaceId = String(formData.get("workspaceId") || sessionWorkspaceId);
  if (getAuthMode() === "production" && formWorkspaceId !== sessionWorkspaceId) {
    return json({ success: false, error: { code: "FORBIDDEN", message: "Form workspaceId does not match your session." } }, 403);
  }
  const workspaceId = sessionWorkspaceId;
  const category = String(formData.get("category") || "other") as Parameters<typeof saveMediaCatalogItem>[0]["category"];
  const title = String(formData.get("title") || "");
  const caption = String(formData.get("caption") || "");
  const leadId = String(formData.get("leadId") || "") || undefined;
  return saveMediaCatalogItem({
    workspaceId,
    fileName: file.name || "media.bin",
    fileType: file.type || "application/octet-stream",
    buffer: Buffer.from(await file.arrayBuffer()),
    category,
    title,
    caption,
    leadId,
  }, repos);
}

async function extractUploadedFileText(request: NextRequest) {
  // Up to 6 files of 8 MB each, plus the form's own bytes.
  assertFileUpload(request, 50 * 1024 * 1024);
  const formData = await request.formData();
  const files = formData.getAll("files").filter((value): value is File => value instanceof File);
  const maxFiles = 6;
  const maxBytes = 8 * 1024 * 1024;
  const selected = files.slice(0, maxFiles);
  const rejectedFiles: { fileName: string; reason: string }[] = [];
  if (files.length > maxFiles) {
    rejectedFiles.push({ fileName: "additional files", reason: `Only ${maxFiles} files can be processed at once.` });
  }

  const results = [];
  for (const file of selected) {
    // Only the name, never a folder path someone put in front of it.
    const fileName = (file.name || "uploaded-file").split(/[\\/]/).pop() || "uploaded-file";
    const extension = fileName.split(".").pop()?.toLowerCase() || "";
    if (file.size > maxBytes) {
      rejectedFiles.push({ fileName, reason: "File is larger than 8 MB." });
      continue;
    }
    if (!["pdf", "docx", "txt", "md", "markdown", "csv", "json"].includes(extension)) {
      rejectedFiles.push({
        fileName,
        reason: extension === "doc"
          ? "Older Word files (.doc) can't be read. Open it in Word and save it as .docx or PDF, then upload that."
          : ["xls", "xlsx"].includes(extension)
            ? "Excel files can't be read here. Save the sheet as CSV (File → Save As → CSV), or as PDF, then upload that."
            : "This kind of file can't be read. Upload a PDF, Word (.docx), text or CSV file.",
      });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const extractedText = await extractTextFromBuffer(buffer, extension);
      // 2026-09-26 (break test): a binary file named .txt came through as
      // "text" — thousands of control characters sent on to the AI and saved.
      if (looksBinary(extractedText)) {
        results.push({ fileName, fileType: extension, status: "failed", extractedText: "", warning: "This file does not contain readable text. Check it is the right file." });
        continue;
      }
      results.push({
        fileName,
        fileType: extension,
        status: extractedText.trim() ? "extracted" : "empty",
        extractedText,
        warning: extractedText.trim() ? undefined : extension === "pdf"
          ? "No readable text was found. If this is a scanned PDF (a photo of pages), upload the original document instead."
          : "This file is empty.",
      });
    } catch (error) {
      // The reading library's own words ("Invalid PDF structure.", "Corrupted
      // zip: can't find end of central directory") mean nothing to an owner.
      console.warn(`[extract-file-text] could not read ${extension} file:`, error instanceof Error ? error.message : error);
      results.push({
        fileName,
        fileType: extension,
        status: "failed",
        extractedText: "",
        warning: extension === "pdf" || extension === "docx"
          ? `This ${extension.toUpperCase()} could not be opened — it may be damaged, password-protected or not really a ${extension.toUpperCase()}. Try saving it again and re-uploading.`
          : "This file could not be read.",
      });
    }
  }

  return {
    files: results,
    rejectedFiles,
    combinedText: results
      .filter((item) => item.extractedText.trim())
      .map((item) => `Source file: ${item.fileName}\n${item.extractedText.trim()}`)
      .join("\n\n---\n\n"),
  };
}

/** More than 5% control characters (other than tab and line breaks) is not text. */
function looksBinary(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 20000);
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffd) control++;
  }
  return control / sample.length > 0.05;
}

async function extractTextFromBuffer(buffer: Buffer, extension: string) {
  if (["txt", "md", "markdown", "csv", "json"].includes(extension)) {
    return buffer.toString("utf8");
  }
  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  if (extension === "pdf") {
    // K4 (2026-09-27): a scanned PDF comes back as page markers only
    // ("-- 1 of 3 --"), which passed the empty check in the caller and went
    // to the AI. extractPdfText drops the markers and returns "" when the
    // pages hold too little real text, so the "scanned PDF" message is shown.
    return extractPdfText(buffer);
  }
  return "";
}

function json(payload: unknown, status = 200) {
  // Defense-in-depth: NextResponse.json() (the Web Fetch Response.json) uses a
  // stricter serializer than JSON.stringify and THROWS "Value is not JSON
  // serializable" on `undefined` — which surfaces as a confusing HTTP 500
  // PROVIDER_ERROR instead of a clean response. Coerce undefined → null (the
  // JSON-safe equivalent) so a route that returns undefined never crashes the
  // serializer. This was the amplifier behind the 2026-07-27 sla-settings P0
  // (route shadowing returned undefined → 500). Real bugs should still be fixed
  // at the route, but this chokepoint guarantees no silent serializer crash.
  const safe = payload === undefined ? null : payload;
  return NextResponse.json(safe, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * 2026-08-05 (audit finding F-8) — the ONE gate every list GET goes through.
 *
 * Two behaviours in one place, chosen by whether the caller opted into paging:
 *
 *   ?limit / ?offset present → a page envelope { items, total, limit, offset,
 *                              hasMore }, so the client can page properly.
 *
 *   neither present          → the legacy bare array, unchanged for any
 *                              workspace under BARE_LIST_CEILING rows (i.e.
 *                              every real workspace today), but capped so a
 *                              runaway tenant can never OOM the process.
 *
 * Truncation is NEVER silent: X-Total-Count / X-Returned-Count are always set
 * and X-Truncated marks a capped response, because a UI that computes counts
 * from a quietly-shortened array renders confidently wrong numbers — a worse
 * failure than a slow page.
 *
 * Per the reasoning in LeadListPagination.ts, this is an API-boundary concern
 * only. Internal services keep calling the repositories directly because they
 * genuinely need every row.
 */
function jsonList<T>(request: NextRequest, all: T[]): NextResponse {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const offsetParam = request.nextUrl.searchParams.get("offset");

  if (limitParam !== null || offsetParam !== null) {
    const page = paginate(all, limitParam ? Number(limitParam) : undefined, offsetParam ? Number(offsetParam) : undefined);
    return NextResponse.json(page, {
      headers: { "cache-control": "no-store", "X-Total-Count": String(page.total), "X-Returned-Count": String(page.items.length) },
    });
  }

  const capped = capBareList(all);
  if (capped.truncated) {
    // Loud on the server too — a truncated list means this workspace has
    // outgrown the bare-array contract and its screens need real paging.
    console.warn(`[list-cap] ${request.nextUrl.pathname} returned ${capped.items.length} of ${capped.total} rows (ceiling ${BARE_LIST_CEILING}). This screen needs server-side pagination.`);
  }
  return NextResponse.json(capped.items, {
    headers: { "cache-control": "no-store", ...paginationHeaders(capped) },
  });
}

function must<T>(value: T | undefined, message: string): T {
  if (!value) throw new NeedsActionError(message, /not found/i.test(message) ? 404 : 409);
  return value;
}

function arrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function emitBackendEvent(eventType: AppEventType, workspaceId: string, entityType: string, entityId: string | undefined, payload: Record<string, unknown>) {
  await emitEvent({
    eventType,
    workspaceId,
    entityType,
    entityId,
    source: "api",
    payload,
  });
}

// Cluster 1 fix (2026-07-26 audit, P0-1): dashboardState now takes the
// session workspaceId as a parameter and scopes EVERY collection by it.
// Previously it used the `defaultWorkspaceId` constant, which made every
// caller see the demo workspace's data — a cross-tenant leak the moment a
// second workspace exists. Pinned by golden-multi-tenant-scoping.
export function dashboardState(data: AppData, workspaceId: string) {
  const profile = data.businessProfiles.find((item) => item.workspaceId === workspaceId);
  const activeCampaigns = data.campaigns.filter((item) => item.workspaceId === workspaceId && item.status === "active");
  const leads = data.leads.filter((item) => item.workspaceId === workspaceId);
  const pendingReviews = leads.filter((lead) => lead.reviewStatus === "pending").length;
  const hotLeads = leads.filter((lead) => lead.status === "hot_lead").length;
  const recentReplies = data.replies.filter((item) => item.workspaceId === workspaceId).slice(-5).reverse();
  // Cluster 1 fix: every collection feeding recommendedNextAction must be
  // scoped to this workspace, otherwise ws_B's open questions / unreviewed
  // drafts leak into ws_A's dashboard guidance.
  const scoped = {
    knowledgeDocs: (data.knowledgeBaseDocuments || []).filter((d) => d.workspaceId === workspaceId),
    productKnowledges: (data.productKnowledges || []).filter((p) => p.workspaceId === workspaceId),
    icps: data.icps.filter((i) => i.workspaceId === workspaceId),
    campaigns: data.campaigns.filter((c) => c.workspaceId === workspaceId),
    unknownQuestions: (data.unknownQuestions || []).filter((q) => q.workspaceId === workspaceId),
    autoReplyLogs: (data.autoReplyLogs || []).filter((l) => l.workspaceId === workspaceId),
  };
  const recommendedNextAction = !profile
    ? "Add your website or fill the business profile manually."
    : profile.status !== "approved"
      ? "Review and approve your business profile before campaign launch."
      : !scoped.knowledgeDocs.length
        ? "Sync your approved profile into the Knowledge Base."
        : !scoped.productKnowledges.length
          ? "Analyze product applications and buyer segments to improve targeting."
          : scoped.icps.length === 0
            ? "Generate ICPs and select one buyer profile."
            : scoped.campaigns.length === 0
              ? "Create your first campaign from the selected ICP."
              : scoped.unknownQuestions.some((item) => item.status === "open")
                ? "Answer missing knowledge questions so the AI does not guess."
                : scoped.autoReplyLogs.some((item) => item.status === "held_for_review" || item.status === "drafted")
                  ? "Review AI reply drafts before sending anything manually."
                  : pendingReviews > 0
                    ? "Review discovered leads and approve only the relevant ones."
                    : "Generate messages for approved leads and send them manually.";
  // F-API-2 (2026-08-04): the `|| data.workspaces[0]` fallback returned
  // ANOTHER tenant's workspace object when the session workspace was missing
  // (provisioning race / partial write). The Cluster 1 P0-1 sweep rescoped
  // every collection here by workspaceId but missed the workspace object
  // itself. If our workspace isn't in the file, return null — never silently
  // substitute another tenant's row.
  const workspace = data.workspaces.find((w) => w.id === workspaceId) || null;
  return {
    workspace,
    profile,
    activeCampaigns,
    totalLeads: leads.length,
    hotLeads,
    pendingReviews,
    followUpsDue: leads.filter((lead) => lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) <= new Date()).length,
    recentReplies,
    recommendedNextAction,
    // Cluster 1 fix: scope integrations + agentRuns by workspace too.
    integrations: (data.integrations || []).filter((i) => i.workspaceId === workspaceId),
    agentRuns: (data.agentRuns || []).filter((r) => r.workspaceId === workspaceId).slice(-10).reverse(),
  };
}

// Cluster 1 fix (2026-07-26 audit, P0-2): scopeDataForExport returns ONLY the
// workspace's own collections. Previously data/export called readAll() (every
// workspace) and stamped the session id on top — a direct cross-tenant breach.
// Pinned by golden-multi-tenant-scoping CASE C/D.
//
// I-5 fix (batch 3, 2026-07-27): export FIDELITY. The audit found 32 AppData
// collections were silently dropped from the export (the operator's backup was
// incomplete). Now every workspace-scoped business collection is included.
// The output is still passed through redactSecretsFromObject by the caller
// (line above), so any secret-bearing field is masked before it leaves.
//
// DELIBERATELY EXCLUDED (with reason — do NOT add without a DECISIONS entry):
//   - userCredentials, llmProviderCredentials, providerAccounts  → SECRETS.
//     Even masked, these have no business value in a workspace backup and
//     bloat the file. The operator re-enters credentials after a restore.
//   - processedWebhookMessageIds → internal dedup registry (see I-3 fix).
//     Not business data; regenerates on inbound traffic.
//   - users → contains password hashes. The workspace-scoped user list is
//     available via GET /workspace/members (with role info, no hashes).
//   - knowledgeBaseQueryLogs, eventLogs, jobRuns → high-volume telemetry.
//     Exporting them would OOM the JSON file on a busy workspace; they're
//     queryable via the audit log / dedicated endpoints when needed.
export function scopeDataForExport(data: AppData, workspaceId: string) {
  const by = <T extends { workspaceId?: string }>(arr: T[] | undefined): T[] =>
    (arr || []).filter((item) => item.workspaceId === workspaceId);
  return {
    workspaces: (data.workspaces || []).filter((w) => w.id === workspaceId),
    workspaceMembers: by(data.workspaceMembers),
    businessProfiles: by(data.businessProfiles),
    leads: by(data.leads),
    interactions: by(data.interactions),
    replies: by(data.replies),
    campaigns: by(data.campaigns),
    icps: by(data.icps),
    messageTemplates: by(data.messageTemplates),
    outreachActivities: by(data.outreachActivities),
    autoReplyLogs: by(data.autoReplyLogs),
    unknownQuestions: by(data.unknownQuestions),
    tickets: by(data.tickets),
    ticketEvents: by(data.ticketEvents),
    ticketSlaSettings: by(data.ticketSlaSettings),
    orders: by(data.orders),
    quotes: by(data.quotes),
    mediaCatalogItems: by(data.mediaCatalogItems),
    knowledgeBaseDocuments: by(data.knowledgeBaseDocuments),
    knowledgeBaseChunks: by(data.knowledgeBaseChunks),
    knowledgeQuestionAnswers: by(data.knowledgeQuestionAnswers),
    knowledgeEntries: by(data.knowledgeEntries),
    knowledgeExtractionRuns: by(data.knowledgeExtractionRuns),
    knowledgeExtractionBatches: by(data.knowledgeExtractionBatches),
    knowledgeExtractionSources: by(data.knowledgeExtractionSources),
    knowledgeExtractionSourceBundles: by(data.knowledgeExtractionSourceBundles),
    productKnowledges: by(data.productKnowledges),
    productVarieties: by(data.productVarieties),
    productApplications: by(data.productApplications),
    productApplicationMarketMaps: by(data.productApplicationMarketMaps),
    buyerSegments: by(data.buyerSegments),
    humanFallbackTasks: by(data.humanFallbackTasks),
    escalationRules: by(data.escalationRules),
    leadReviewSettings: by(data.leadReviewSettings),
    leadReviewDecisions: by(data.leadReviewDecisions),
    doNotContactRegistry: by(data.doNotContactRegistry),
    integrations: by(data.integrations),
    agentRuns: by(data.agentRuns),
    agentAutonomousSettings: by(data.agentAutonomousSettings),
    agentBehaviorPolicies: by(data.agentBehaviorPolicies),
    whatsAppAgentSettings: by(data.whatsAppAgentSettings),
    companyCommunicationSettings: by(data.companyCommunicationSettings),
    conversationPolicies: by(data.conversationPolicies),
    aiUsageLimits: by(data.aiUsageLimits),
    llmModelRoutings: by(data.llmModelRoutings),
    auditLogs: by(data.auditLogs),
    salesSettings: by(data.salesSettings),
    productSettings: by(data.productSettings),
    policySettings: by(data.policySettings),
    communicationSettings: by(data.communicationSettings),
    settingsConflicts: by(data.settingsConflicts),
    pendingSettingsDrafts: by(data.pendingSettingsDrafts),
    campaignMetrics: by(data.campaignMetrics),
    campaignLearnings: by(data.campaignLearnings),
    websiteCrawlConsents: by(data.websiteCrawlConsents),
    crawlJobs: by(data.crawlJobs),
    crawlPages: by(data.crawlPages),
    businessExtractions: by(data.businessExtractions),
    followUps: by(data.followUps),
    outcomeSignals: by(data.outcomeSignals),
  };
}

/**
 * The collections a reset clears: everything `scopeDataForExport` says belongs
 * to a workspace, minus the three it deliberately keeps. Exported because the
 * repository layer is handed this list rather than deriving its own — one
 * authority, so the JSON and Postgres resets cannot disagree about what a
 * workspace contains. See src/lib/workspace-reset.ts for what is preserved and
 * why.
 */
export function resetTargetCollections(): string[] {
  return Object.keys(scopeDataForExport({} as AppData, ""))
    .filter((key) => !(RESET_PRESERVED_COLLECTIONS as readonly string[]).includes(key));
}

/**
 * Clear a workspace's contents from a snapshot. Kept as a named export because
 * it is the JSON substrate's actual delete path, reached through
 * `repos.clearWorkspaceCollections`.
 */
export function clearWorkspaceData(data: AppData, workspaceId: string): Record<string, number> {
  return clearWorkspaceCollectionsInSnapshot(data, workspaceId, resetTargetCollections());
}

export function campaignAnalytics(data: AppData, campaignId: string, workspaceId?: string) {
  return buildCampaignAnalytics(data, campaignId, workspaceId);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fallbackDocumentPreview(title: string, documentType: string, contentText: string): DocumentExtractionMappingPreview {
  const createdAt = timestamp();
  return {
    documentId: uid("doc_preview"),
    documentTitle: title,
    documentType,
    confidenceScore: contentText.length > 80 ? 0.5 : 0.25,
    businessProfilePatch: {},
    products: [],
    productVarieties: [],
    applications: [],
    buyerSegments: [],
    knowledgeDocuments: [{
      title: `${title} extracted text`,
      documentType: "question_answer_extraction",
      contentText: contentText || "No extractable text was provided.",
      confidenceScore: contentText ? 0.5 : 0,
    }],
    communicationSettingsPatch: {},
    whatsappSettingsPatch: {},
    policies: [],
    // The free rule-based finder still runs when the AI step times out: this
    // returned no FAQs at all, so "Q: … A: …" in an uploaded document was lost
    // whenever the checklist extraction before it took long (2026-09-26).
    faqs: detectFaqs(contentText),
    companyKnowledge: [],
    customerKnowledge: [],
    leadQualificationRules: [],
    unmappedInformation: contentText ? [] : ["No extractable text was provided."],
    missingQuestions: [],
    modelUsed: { provider: "mock", modelName: "deterministic-timeout-fallback", slotId: "daily_workhorse", fallbackUsed: true },
    createdAt,
  };
}

/**
 * 2026-09-28 — a new order or quote at or above the owner's amount alerts the
 * owner (their own WhatsApp, when switched on) — unless the owner made it.
 * Never blocks the create.
 */
async function alertOwnerBigAmount(
  request: NextRequest,
  workspaceId: string,
  repos: ReturnType<typeof createRepositories>,
  input: { kind: "order" | "quote"; record: Record<string, unknown> },
): Promise<void> {
  try {
    const { resolveActor } = await import("./workspace-resolution");
    const actorUserId = (await resolveActor(request, undefined)).userId;
    const { alertOwnerOnBigAmount } = await import("@/services/OwnerNotifyService");
    const r = input.record;
    await alertOwnerOnBigAmount(workspaceId, {
      kind: input.kind,
      id: String(r.id || ""),
      number: Number(input.kind === "order" ? r.orderNumber : r.quoteNumber) || undefined,
      total: Number(r.grandTotal) || 0,
      currencyCode: typeof r.currencyCode === "string" ? r.currencyCode : undefined,
      leadId: typeof r.leadId === "string" ? r.leadId : undefined,
      actorUserId,
    }, repos);
  } catch (error) {
    console.error("[owner-alerts] big-amount alert failed:", error instanceof Error ? error.message : error);
  }
}
