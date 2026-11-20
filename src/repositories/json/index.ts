import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { samePhoneForOptOut } from "@/lib/phone-match";
import { agentRunText, textMentionsCustomer, type CustomerNeedles } from "@/lib/customer-traces";
import { canonicalLeadStatus, leadStatusNames } from "@/lib/lead-status";
import { NeedsActionError } from "@/lib/user-errors";
import path from "node:path";
import { dataDirectory, defaultWorkspaceId, mutateData, readData, timestamp, touch, uid } from "@/lib/db";
import { clearWorkspaceCollectionsInSnapshot } from "@/lib/workspace-reset";
import { withSnapshotSession } from "@/repositories/snapshot-session";
import { DEFAULT_BUSINESS_DAYS, DEFAULT_BUSINESS_HOURS_START, DEFAULT_BUSINESS_HOURS_END, DEFAULT_CLOCK_MODE, DEFAULT_SLA_MINUTES, upgradeLegacySlaDefaults } from "@/lib/ticket-sla";
import type { AgentBehaviorPolicy, AgentRun, AgentAutonomousSettings, AIUsageLimit, AppData, AuditLog, AutoReplyLog, BusinessExtraction, BusinessProfile, BuyerSegment, Campaign, CampaignLearning, CampaignMetric, DoNotContactEntry, CompanyCommunicationSettings, CommunicationSettings, ConversationPolicy, EscalationRule, EventLog, ICP, Integration, JobRun, KnowledgeBaseChunk, KnowledgeBaseDocument, KnowledgeBaseQueryLog, Lead, LeadReviewDecision, LeadReviewSettings, LLMModelRouting, LLMProviderCredential, MediaCatalogItem, MessageTemplate, OutreachActivity, PendingSettingsDraft, PolicySettings, ProductSettings, ProductApplication, ProductApplicationMarketMap, ProductKnowledge, ProductVariety, ProviderAccount, Reply, SalesSettings, SettingsConflict, Ticket, TicketEvent, TicketSlaSettings, UnknownQuestion, WebsiteCrawlConsent, WebsiteCrawlJob, WebsiteCrawlPage, WhatsAppAgentSettings, WhatsAppTemplate, Workspace, WorkspaceMember, Order, Quote, User, UserCredential, PlatformTicket, PlatformTicketEvent, PlatformSupportHours, PlatformTicketSlaSettings, PlatformUserBlock, PlatformAdmin, PlatformAdminCredential, PlatformAuditLog, FeatureFlag, PasswordResetToken, ImpersonationSession, EmailVerificationToken, Invite, LeadPhoneNumber, OwnerCopilotConversation, OwnerCopilotMessage, FollowUp, OutcomeSignal } from "@/lib/types";
import type {
  AgentRunRepository,
  AgentBehaviorPolicyRepository,
  AgentAutonomousSettingsRepository,
  AIUsageLimitRepository,
  AuditLogRepository,
  AutoReplyLogRepository,
  BusinessExtractionRepository,
  BusinessProfileRepository,
  BuyerSegmentRepository,
  CampaignRepository,
  CampaignLearningRepository,
  DoNotContactRepository,
  CampaignMetricRepository,
  CommunicationSettingsRepository,
  CompanyCommunicationSettingsRepository,
  ConversationPolicyRepository,
  EscalationRuleRepository,
  EventLogRepository,
  ICPRepository,
  IntegrationRepository,
  JobRunRepository,
  KnowledgeBaseChunkRepository,
  KnowledgeBaseDocumentRepository,
  KnowledgeBaseQueryLogRepository,
  LeadReviewDecisionRepository,
  LeadReviewSettingsRepository,
  LeadRepository,
  ListLeadFilters,
  LLMModelRoutingRepository,
  LLMProviderCredentialRepository,
  MediaCatalogRepository,
  WhatsAppTemplateRepository,
  MessageTemplateRepository,
  OutreachActivityRepository,
  PolicySettingsRepository,
  PendingSettingsDraftRepository,
  ProductApplicationMarketMapRepository,
  ProductApplicationRepository,
  ProductKnowledgeRepository,
  ProductSettingsRepository,
  ProductVarietyRepository,
  ProviderAccountRepository,
  ReplyRepository,
  SalesSettingsRepository,
  SettingsConflictRepository,
  TicketRepository,
  TicketEventRepository,
  TicketSlaSettingsRepository,
  OrderRepository,
  QuoteRepository,
  UnknownQuestionRepository,
  WebsiteCrawlConsentRepository,
  WebsiteCrawlJobRepository,
  WebsiteCrawlPageRepository,
  WhatsAppAgentSettingsRepository,
  WorkspaceRepository,
  AuthRepository,
  WorkspaceMemberRepository,
  // Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth.
  PlatformTicketRepository,
  PlatformTicketEventRepository,
  PlatformSupportHoursRepository,
  PlatformTicketSlaSettingsRepository,
  PlatformUserBlockRepository,
  PlatformAdminRepository,
  PlatformAuditLogRepository,
  // Stage 5 / WP2 (2026-07-28) — operator admin ops.
  UserRepository,
  UserCredentialRepository,
  FeatureFlagRepository,
  PasswordResetTokenRepository,
  ImpersonationSessionRepository,
  EmailVerificationTokenRepository,
  InviteRepository,
  OwnerCopilotConversationRepository,
  OwnerCopilotMessageRepository,
  FollowUpRepository,
  OutcomeSignalRepository,
  ProcessedWebhookMessageInput,
  DncKeys,
} from "../interfaces";

function notFound(message: string): never {
  throw new Error(message);
}

function ensureCollections(data: Awaited<ReturnType<typeof readData>>) {
  data.auditLogs ||= [];
  data.providerAccounts ||= [];
  data.websiteCrawlConsents ||= [];
  data.productKnowledges ||= [];
  data.productVarieties ||= [];
  data.productApplications ||= [];
  data.buyerSegments ||= [];
  data.productApplicationMarketMaps ||= [];
  data.leadReviewSettings ||= [];
  data.leadReviewDecisions ||= [];
  data.campaignMetrics ||= [];
  data.eventLogs ||= [];
  data.jobRuns ||= [];
  data.agentBehaviorPolicies ||= [];
  data.companyCommunicationSettings ||= [];
  data.conversationPolicies ||= [];
  data.whatsAppAgentSettings ||= [];
  data.escalationRules ||= [];
  data.unknownQuestions ||= [];
  // Stage 2 (2026-07-20) — tickets.
  data.tickets ||= [];
  data.ticketEvents ||= [];
  data.ticketSlaSettings ||= [];
  // Stage 3 (2026-07-21 / M7) — orders + quotes.
  data.orders ||= [];
  data.quotes ||= [];
  data.autoReplyLogs ||= [];
  // N-DNC-1 (2026-08-18): the permanent opt-out registry. Initialised here so
  // a store written before this collection existed does not make every DNC
  // check throw on undefined.
  data.doNotContactRegistry ||= [];
  data.mediaCatalogItems ||= [];
  data.whatsAppTemplates ||= [];
  data.knowledgeBaseDocuments ||= [];
  data.knowledgeBaseChunks ||= [];
  data.knowledgeBaseQueryLogs ||= [];
  data.llmProviderCredentials ||= [];
  data.llmModelRoutings ||= [];
  data.aiUsageLimits ||= [];
  data.agentAutonomousSettings ||= [];
  data.salesSettings ||= [];
  data.productSettings ||= [];
  data.policySettings ||= [];
  data.communicationSettings ||= [];
  data.settingsConflicts ||= [];
  data.pendingSettingsDrafts ||= [];
  // Session 6 I-3 — inbound-webhook message-id dedup log.
  data.processedWebhookMessageIds ||= [];
  // Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth.
  data.platformTickets ||= [];
  data.platformTicketEvents ||= [];
  data.platformSupportHours ||= [];
  data.platformTicketSlaSettings ||= [];
  data.platformUserBlocks ||= [];
  data.platformAdmins ||= [];
  data.platformAdminCredentials ||= [];
  data.platformAuditLogs ||= [];
  // Stage 5 / WP2 (2026-07-28) — global feature flags + password-reset
  // tokens + impersonation sessions. See docs/LOGIC.md 2026-07-28.
  data.featureFlags ||= [];
  data.passwordResetTokens ||= [];
  data.impersonationSessions ||= [];
  // Stage 5 / WP1 (2026-07-28) — signup verification tokens + invites.
  data.emailVerificationTokens ||= [];
  data.invites ||= [];
  // Owner Copilot (2026-08-01) — owner-facing assistant chat.
  data.ownerCopilotConversations ||= [];
  data.ownerCopilotMessages ||= [];
  data.followUps ||= [];
  data.outcomeSignals ||= [];
}

/**
 * Object.assign for an EXISTING record, minus the two fields a caller must not
 * be able to overwrite by accident.
 *
 * WHY (N-DATA-2, 2026-08-18). Fifteen upsert methods in this file are written
 * as: find the row, create it with a carefully-chosen id if missing, then
 * assign the caller's whole object over it. That last step hands across
 * everything the caller carried — including `id` and `createdAt`. So the id
 * chosen on the line above is immediately overwritten by whatever the caller
 * happened to be holding, and a caller holding `id: null` (an API payload, a
 * spread of a partially-filled form) sets the row's id to null.
 *
 * That is not hypothetical: the demo workspace's communicationSettings row was
 * sitting in .leadgen-data/app-data.json with `"id": null` while the other five
 * settings singletons had proper ids, and the JSON→Postgres migration could not
 * plan it at all — it reported `undefined cannot be created`.
 *
 * `createdAt` is treated differently from `id`: a genuinely supplied creation
 * time still wins, because `input.createdAt || timestamp()` is this substrate's
 * declared contract and the migration depends on it. Only an ABSENT one
 * (null/undefined) is dropped instead of being written over a real value.
 * `id` is never taken from input here — renaming an existing row is not
 * something an update call should be able to do by accident.
 */
function assignUpdate<T extends object>(item: T, input: object, overrides: object): T {
  const { id: _ignoredId, createdAt, ...rest } = input as Record<string, unknown>;
  void _ignoredId;
  return Object.assign(
    item,
    rest,
    createdAt === null || createdAt === undefined ? {} : { createdAt },
    overrides,
  );
}

export class JsonWorkspaceRepository implements WorkspaceRepository {
  async getById(id: string) {
    return (await readData()).workspaces.find((item) => item.id === id);
  }

  async getDefault() {
    return (await readData()).workspaces[0];
  }

  async create(input: Partial<Workspace>) {
    return mutateData((data) => {
      const item: Workspace = {
        id: input.id || uid("workspace"),
        name: input.name || "New workspace",
        ownerUserId: input.ownerUserId,
        businessName: input.businessName,
        industry: input.industry,
        targetAudience: input.targetAudience,
        status: input.status || "active",
        autonomyKillSwitch: input.autonomyKillSwitch,
        autoSendToggle: input.autoSendToggle,
        ownerWhatsappNumber: input.ownerWhatsappNumber,
        // Stage 5 / WP2 (2026-07-28) — suspend fields pass-through.
        suspendedAt: input.suspendedAt,
        suspendedByAdminId: input.suspendedByAdminId,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.workspaces.push(item);
      return item;
    });
  }

  // 2026-07-21 (M9) — update workspace fields.
  async update(id: string, data: Partial<Workspace>) {
    return mutateData((d) => {
      const item = d.workspaces.find((w) => w.id === id);
      if (!item) throw new Error(`Workspace ${id} not found`);
      Object.assign(item, data, { updatedAt: timestamp() });
      return item;
    });
  }

  /**
   * N-DATA-2 (2026-08-18) — delete a workspace and everything under it.
   *
   * Postgres gets this free: all 68 workspace child relations in schema.prisma
   * declare `onDelete: Cascade`. JSON implements no cascade at all — the
   * substrate-parity golden's own comment says so — so the sweep is done here
   * by hand, and it has to match what Postgres does or the parity golden (the
   * thing that lets JSON results stand in for production) goes red.
   *
   * WHY THE SWEEP IS GENERIC rather than a hand-written list of collections:
   * a hand-written list is a list that goes stale the next time someone adds a
   * collection, and it goes stale SILENTLY — the rows just survive. Measured
   * on the live store before writing this: of the populated collections, 46 of
   * 46 carry a `workspaceId`; the only two that do not are `workspaces` itself
   * (removed by id below) and `agentBehaviorPolicies`, which is global config
   * and correctly not workspace-scoped. So "every array whose rows carry this
   * workspaceId" is the honest rule, and it keeps working as collections are
   * added.
   *
   * Deleting an absent workspace is deliberately NOT an error: cleanup code
   * runs in `finally` blocks, and a cleanup that throws hides the real failure
   * that put it there.
   */
  async delete(id: string) {
    return mutateData((data) => {
      const store = data as unknown as Record<string, unknown>;
      const existed = Array.isArray(data.workspaces) && data.workspaces.some((item) => item.id === id);
      let deletedRows = 0;

      for (const [collection, value] of Object.entries(store)) {
        if (collection === "workspaces" || !Array.isArray(value)) continue;
        const before = value.length;
        const kept = value.filter((row) => !(row && typeof row === "object" && (row as { workspaceId?: string }).workspaceId === id));
        if (kept.length !== before) {
          store[collection] = kept;
          deletedRows += before - kept.length;
        }
      }

      if (existed) {
        data.workspaces = data.workspaces.filter((item) => item.id !== id);
      }
      return { deleted: existed, deletedRows };
    });
  }

  // 2026-07-21 (Cluster A fix, session 16) — feed the assignTicket round-robin.
  // Returns members whose status === "active" for this workspace.
  async listActiveStaffForWorkspace(workspaceId: string) {
    const data = await readData();
    data.workspaceMembers ||= [];
    return data.workspaceMembers.filter((m) => m.workspaceId === workspaceId && m.status === "active");
  }

  // Stage 5 / WP2 (2026-07-28) — operator console: list EVERY workspace
  // (cross-tenant). Default excludes suspended; includeSuspended reveals.
  // Order: created desc. NOT paginated in WP2 (tenant count is small).
  async listAll(includeSuspended = false) {
    const all = (await readData()).workspaces.slice();
    const filtered = includeSuspended ? all : all.filter((w) => w.status !== "suspended");
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class JsonBusinessProfileRepository implements BusinessProfileRepository {
  async getByWorkspace(workspaceId: string) {
    return (await readData()).businessProfiles.find((item) => item.workspaceId === workspaceId);
  }

  async create(input: Partial<BusinessProfile>) {
    return mutateData((data) => {
      const item = normalizeProfile(input);
      data.businessProfiles.push(item);
      return item;
    });
  }

  async update(workspaceId: string, profileId: string, data: Partial<BusinessProfile>) {
    return mutateData((store) => {
      const profile = store.businessProfiles.find((item) => item.workspaceId === workspaceId && item.id === profileId) || notFound("Business profile not found");
      Object.assign(profile, data);
      return touch(profile);
    });
  }

  async approve(workspaceId: string, profileId: string) {
    return this.update(workspaceId, profileId, { status: "approved" });
  }
}

export class JsonICPRepository implements ICPRepository {
  async createMany(input: Partial<ICP>[]) {
    return mutateData((data) => {
      const items = input.map((item) => normalizeICP(item));
      data.icps.push(...items);
      return items;
    });
  }

  async replaceForBusinessProfile(workspaceId: string, businessProfileId: string, input: Partial<ICP>[]) {
    return mutateData((data) => {
      data.icps = data.icps.filter((item) => !(item.workspaceId === workspaceId && item.businessProfileId === businessProfileId));
      const items = input.map((item) => normalizeICP({ ...item, workspaceId, businessProfileId }));
      data.icps.push(...items);
      return items;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).icps.filter((item) => item.workspaceId === workspaceId);
  }

  async getById(workspaceId: string, icpId: string) {
    return (await readData()).icps.find((item) => item.workspaceId === workspaceId && item.id === icpId);
  }

  async update(workspaceId: string, icpId: string, data: Partial<ICP>) {
    return mutateData((store) => {
      const item = store.icps.find((icp) => icp.workspaceId === workspaceId && icp.id === icpId) || notFound("ICP not found");
      Object.assign(item, data);
      return touch(item);
    });
  }

  async select(workspaceId: string, icpId: string) {
    return mutateData((data) => {
      data.icps.filter((item) => item.workspaceId === workspaceId).forEach((item) => {
        if (item.status === "selected") item.status = "suggested";
      });
      const item = data.icps.find((icp) => icp.workspaceId === workspaceId && icp.id === icpId) || notFound("ICP not found");
      item.status = "selected";
      return touch(item);
    });
  }

  async reject(workspaceId: string, icpId: string) {
    return this.update(workspaceId, icpId, { status: "rejected" });
  }
}

export class JsonCampaignRepository implements CampaignRepository {
  async create(input: Partial<Campaign>) {
    return mutateData((data) => {
      const item = normalizeCampaign(input);
      data.campaigns.push(item);
      return item;
    });
  }

  async getById(workspaceId: string, campaignId: string) {
    return (await readData()).campaigns.find((item) => item.workspaceId === workspaceId && item.id === campaignId);
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).campaigns.filter((item) => item.workspaceId === workspaceId);
  }

  async update(workspaceId: string, campaignId: string, data: Partial<Campaign>) {
    return mutateData((store) => {
      const item = store.campaigns.find((campaign) => campaign.workspaceId === workspaceId && campaign.id === campaignId) || notFound("Campaign not found");
      Object.assign(item, data);
      return touch(item);
    });
  }

  async approve(workspaceId: string, campaignId: string) {
    return this.update(workspaceId, campaignId, { status: "active", approvalStatus: "approved" });
  }
}

export class JsonLeadRepository implements LeadRepository {
  async createLead(input: Partial<Lead>) {
    return mutateData((data) => {
      // 2026-09-28 (L10): one stored name per stage (won, lost, discovered).
      const item = normalizeLead(input.status ? { ...input, status: canonicalLeadStatus(input.status) } : input);
      data.leads.push(item);
      return item;
    });
  }

  async getLeadById(workspaceId: string, leadId: string) {
    return (await readData()).leads.find((item) => item.workspaceId === workspaceId && item.id === leadId);
  }

  /**
   * P-1 fix (Session 7, 2026-07-28): find a single lead in this workspace by
   * phone. Workspace-scoped (uses the in-memory workspace filter; the Prisma
   * impl pushes the workspace filter into the DB query). Matches both the
   * `whatsappNumber` and `phone` fields.
   *
   * NORMALIZATION: digit-only (`replace(/\D/g, "")`) so "+919999000777" and
   * "919999000777" resolve to the SAME lead. This matches the established
   * inbound-webhook contract (WhatsAppWebhookService.normalizePhone) — Meta
   * delivers E.164 with "+", manual leads may be stored either way, and the
   * realistic match is on the digit string. (The dnc-registry normalizePhone
   * preserves the "+", which is correct for DNC cross-channel matching but too
   * strict for lead-by-phone resolution.) Pinned by `golden:find-lead-by-phone`.
   */
  async findLeadByPhone(workspaceId: string, phone: string) {
    const target = (phone || "").replace(/\D/g, "");
    if (!target) return undefined;
    const data = await readData();
    const leads = data.leads.filter((item) => item.workspaceId === workspaceId);
    // 1. Match the primary flat fields (the original contract).
    const byFlat = leads.find((item) => (item.whatsappNumber || item.phone || "").replace(/\D/g, "") === target);
    if (byFlat) return byFlat;
    // 2. Stage 6 / WP6-C (6C-2): match ANY of the lead's stored numbers.
    //    A text from the customer's 2nd WhatsApp number must resolve to the
    //    SAME lead instead of creating a duplicate.
    const leadIdsWithNumber = new Set(
      (data.leadPhoneNumbers ?? [])
        .filter((n) => n.workspaceId === workspaceId && n.normalizedDigits === target)
        .map((n) => n.leadId),
    );
    const byExtra = leads.find((item) => leadIdsWithNumber.has(item.id));
    if (byExtra) return byExtra;
    // 3. 2026-09-26 (break test): WhatsApp reports a sender as 919825033333;
    //    Indian lists store "98250 33333" or "098250 33333". Exact digits never
    //    matched, so every reply from such a customer made a second, empty lead
    //    and the conversation lost its history. Same subscriber rule as the
    //    do-not-contact register (last 10 digits), used only after an exact
    //    match has failed.
    return leads.find((item) => samePhoneForOptOut(item.whatsappNumber, target) || samePhoneForOptOut(item.phone, target))
      ?? leads.find((item) => (data.leadPhoneNumbers ?? []).some((n) => n.workspaceId === workspaceId && n.leadId === item.id && samePhoneForOptOut(n.normalizedDigits, target)));
  }

  // Stage 6 / WP6-C (2026-07-30) — multi-number storage per lead.
  async addLeadPhoneNumber(workspaceId: string, leadId: string, input: { number: string; type: string; isPrimary?: boolean; label?: string }) {
    const normalizedDigits = (input.number || "").replace(/\D/g, "");
    return mutateData((store) => {
      store.leadPhoneNumbers ||= [];
      // Idempotent: re-adding the same normalized number returns the existing row.
      const existing = store.leadPhoneNumbers.find(
        (n) => n.workspaceId === workspaceId && n.leadId === leadId && n.normalizedDigits === normalizedDigits,
      );
      if (existing) return existing;
      const record: LeadPhoneNumber = {
        id: uid("lpn"),
        workspaceId,
        leadId,
        number: input.number,
        normalizedDigits,
        type: input.type,
        isPrimary: Boolean(input.isPrimary),
        label: input.label,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      };
      store.leadPhoneNumbers.push(record);
      // 6C-1 primary sync: keep the flat lead field in sync so existing readers
      // (which read lead.phone / lead.whatsappNumber) see the primary number.
      if (record.isPrimary) {
        const lead = store.leads.find((l) => l.workspaceId === workspaceId && l.id === leadId);
        if (lead) {
          if (input.type === "whatsapp") lead.whatsappNumber = input.number;
          else lead.phone = input.number;
          touch(lead);
        }
      }
      return record;
    });
  }

  async listLeadPhoneNumbers(workspaceId: string, leadId: string) {
    return ((await readData()).leadPhoneNumbers || []).filter((n) => n.workspaceId === workspaceId && n.leadId === leadId);
  }

  async listLeads(workspaceId: string, filters: ListLeadFilters = {}) {
    return (await readData()).leads.filter((lead) =>
      lead.workspaceId === workspaceId &&
      (!filters.campaignId || lead.campaignId === filters.campaignId) &&
      // 2026-09-28 (L10): "won" also finds rows stored as "closed_won", and so on.
      (!filters.status || leadStatusNames(filters.status).includes(lead.status)) &&
      (!filters.reviewStatus || lead.reviewStatus === filters.reviewStatus)
    );
  }

  async listLeadsByCampaign(workspaceId: string, campaignId: string) {
    return this.listLeads(workspaceId, { campaignId });
  }

  async updateLead(workspaceId: string, leadId: string, data: Partial<Lead>) {
    return mutateData((store) => {
      const lead = store.leads.find((item) => item.workspaceId === workspaceId && item.id === leadId) || notFound("Lead not found");
      Object.assign(lead, data.status ? { ...data, status: canonicalLeadStatus(data.status) } : data);
      return touch(lead);
    });
  }

  async approveLead(workspaceId: string, leadId: string) {
    return this.updateLead(workspaceId, leadId, { reviewStatus: "approved", status: "approved" });
  }

  async rejectLead(workspaceId: string, leadId: string) {
    return this.updateLead(workspaceId, leadId, { reviewStatus: "rejected", status: "rejected" });
  }

  async updateLeadStatus(workspaceId: string, leadId: string, status: Lead["status"]) {
    return this.updateLead(workspaceId, leadId, { status });
  }

  async updateLeadScore(workspaceId: string, leadId: string, scoreData: Partial<Lead>) {
    return this.updateLead(workspaceId, leadId, scoreData);
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete a lead. DPDPA erasure ONLY.
   * Throws if the lead doesn't exist (defensive — the caller should have
   * already verified via getLeadById).
   */
  async deleteById(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      const before = store.leads.length;
      store.leads = store.leads.filter((l) => !(l.workspaceId === workspaceId && l.id === leadId));
      const removed = before - store.leads.length;
      if (removed === 0) notFound("Lead not found");
      // 2026-09-28 (S5): do what Postgres's foreign keys do on a lead delete
      // (ON DELETE CASCADE for chat lines, extra numbers and reminders, and for
      // fallback tasks through their chat line; SET NULL for drafts), so the
      // repository-level erasure behaves the same on both substrates.
      const lineIds = new Set((store.interactions || []).filter((i) => i.workspaceId === workspaceId && i.leadId === leadId).map((i) => i.id));
      store.interactions = (store.interactions || []).filter((i) => !lineIds.has(i.id));
      store.humanFallbackTasks = (store.humanFallbackTasks || []).filter((t) => !lineIds.has(t.interactionId));
      store.leadPhoneNumbers = (store.leadPhoneNumbers || []).filter((n) => !(n.workspaceId === workspaceId && n.leadId === leadId));
      store.followUps = (store.followUps || []).filter((f) => !(f.workspaceId === workspaceId && f.leadId === leadId));
      for (const m of store.messageTemplates) if (m.workspaceId === workspaceId && m.leadId === leadId) m.leadId = undefined;
      return removed;
    });
  }
}

export class JsonMessageTemplateRepository implements MessageTemplateRepository {
  async create(input: Partial<MessageTemplate>) {
    return mutateData((data) => {
      const item = normalizeMessage(input);
      data.messageTemplates.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).messageTemplates.filter((item) => item.workspaceId === workspaceId);
  }

  async getById(workspaceId: string, messageId: string) {
    return (await readData()).messageTemplates.find((item) => item.workspaceId === workspaceId && item.id === messageId);
  }

  async update(workspaceId: string, messageId: string, data: Partial<MessageTemplate>) {
    return mutateData((store) => {
      const item = store.messageTemplates.find((message) => message.workspaceId === workspaceId && message.id === messageId) || notFound("Message not found");
      Object.assign(item, data);
      return touch(item);
    });
  }

  /** 2026-09-28 (S5) — erasure. */
  async deleteByLead(workspaceId: string, leadId: string) {
    return mutateData((store) => {
      const before = store.messageTemplates.length;
      store.messageTemplates = store.messageTemplates.filter((m) => !(m.workspaceId === workspaceId && m.leadId === leadId));
      return before - store.messageTemplates.length;
    });
  }
}

export class JsonOutreachActivityRepository implements OutreachActivityRepository {
  async create(input: Partial<OutreachActivity>) {
    return mutateData((data) => {
      const item = normalizeOutreach(input);
      data.outreachActivities.push(item);
      return item;
    });
  }

  async listByLead(workspaceId: string, leadId: string) {
    return (await readData()).outreachActivities.filter((item) => item.workspaceId === workspaceId && item.leadId === leadId);
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).outreachActivities.filter((item) => item.workspaceId === workspaceId);
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all outreach activities for a
   * lead. DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      const before = store.outreachActivities.length;
      store.outreachActivities = store.outreachActivities.filter(
        (o) => !(o.workspaceId === workspaceId && o.leadId === leadId),
      );
      return before - store.outreachActivities.length;
    });
  }
}

export class JsonReplyRepository implements ReplyRepository {
  async create(input: Partial<Reply>) {
    return mutateData((data) => {
      const item = normalizeReply(input);
      data.replies.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).replies.filter((item) => item.workspaceId === workspaceId);
  }

  async listByLead(workspaceId: string, leadId: string) {
    return (await readData()).replies.filter((item) => item.workspaceId === workspaceId && item.leadId === leadId);
  }

  async getById(workspaceId: string, replyId: string) {
    return (await readData()).replies.find((item) => item.workspaceId === workspaceId && item.id === replyId);
  }

  async update(workspaceId: string, replyId: string, data: Partial<Reply>) {
    return mutateData((store) => {
      const item = store.replies.find((reply) => reply.workspaceId === workspaceId && reply.id === replyId) || notFound("Reply not found");
      Object.assign(item, data);
      return touch(item);
    });
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all replies for a lead.
   * DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      const before = store.replies.length;
      store.replies = store.replies.filter(
        (r) => !(r.workspaceId === workspaceId && r.leadId === leadId),
      );
      return before - store.replies.length;
    });
  }
}

export class JsonAgentRunRepository implements AgentRunRepository {
  async create(input: Partial<AgentRun>) {
    return mutateData((data) => {
      const item: AgentRun = {
        id: input.id || uid("agent"),
        workspaceId: input.workspaceId || defaultWorkspaceId,
        agentName: input.agentName || "unknown_agent",
        input: input.input || {},
        output: input.output,
        status: input.status || "running",
        errorMessage: input.errorMessage,
        startedAt: input.startedAt || timestamp(),
        completedAt: input.completedAt,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.agentRuns.push(item);
      return item;
    });
  }

  async update(workspaceId: string, agentRunId: string, data: Partial<AgentRun>) {
    return mutateData((store) => {
      const item = store.agentRuns.find((run) => run.workspaceId === workspaceId && run.id === agentRunId) || notFound("Agent run not found");
      Object.assign(item, data);
      item.updatedAt = timestamp();
      return item;
    });
  }

  async listRecent(workspaceId: string, limit = 10) {
    return (await readData()).agentRuns.filter((run) => run.workspaceId === workspaceId).slice(-limit).reverse();
  }

  /** 2026-09-28 (S5) — erasure: runs whose text mentions the customer. */
  async deleteMentioning(workspaceId: string, needles: CustomerNeedles) {
    return mutateData((store) => {
      const before = store.agentRuns.length;
      store.agentRuns = store.agentRuns.filter((run) => !(run.workspaceId === workspaceId && textMentionsCustomer(agentRunText(run), needles)));
      return before - store.agentRuns.length;
    });
  }
}

export class JsonAuditLogRepository implements AuditLogRepository {
  async create(input: Partial<AuditLog>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: AuditLog = {
        id: input.id || uid("audit"),
        workspaceId: input.workspaceId || defaultWorkspaceId,
        actorUserId: input.actorUserId,
        eventType: input.eventType || "unknown",
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload || {},
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.auditLogs?.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).auditLogs || []).filter((item) => item.workspaceId === workspaceId);
  }
}

export class JsonIntegrationRepository implements IntegrationRepository {
  async create(workspaceId: string, input: Partial<Integration>) {
    return mutateData((store) => {
      const id = input.id || uid("integration");
      if (store.integrations.some((item) => item.workspaceId === workspaceId && item.id === id)) {
        throw new Error(`Integration ${id} already exists in workspace ${workspaceId}`);
      }
      // Postgres declares @@unique([workspaceId, provider]) and rejects a
      // second row for the same provider. JSON has no constraints whatsoever,
      // so it is enforced here by hand: without this, a duplicate is accepted
      // on the substrate the goldens run on and rejected on the substrate we
      // ship on, and the difference only surfaces in production.
      if (input.provider && store.integrations.some((item) => item.workspaceId === workspaceId && item.provider === input.provider)) {
        throw new Error(`Integration for provider ${input.provider} already exists in workspace ${workspaceId}`);
      }
      const item: Integration = {
        id,
        workspaceId,
        provider: input.provider || "manual",
        status: input.status || "not_connected",
        authType: input.authType,
        config: input.config || {},
        lastConnectedAt: input.lastConnectedAt,
        createdAt: input.createdAt || timestamp(),
        updatedAt: input.updatedAt || timestamp(),
      };
      store.integrations.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).integrations.filter((item) => item.workspaceId === workspaceId);
  }

  async update(workspaceId: string, integrationId: string, data: Partial<Integration>) {
    return mutateData((store) => {
      const item = store.integrations.find((integration) => integration.workspaceId === workspaceId && integration.id === integrationId) || notFound("Integration not found");
      Object.assign(item, data);
      return touch(item);
    });
  }
}

export class JsonWebsiteCrawlJobRepository implements WebsiteCrawlJobRepository {
  async create(input: Partial<WebsiteCrawlJob>) {
    return mutateData((data) => {
      const item = normalizeCrawlJob(input);
      data.crawlJobs.push(item);
      return item;
    });
  }

  async getById(workspaceId: string, crawlJobId: string) {
    return (await readData()).crawlJobs.find((item) => item.workspaceId === workspaceId && item.id === crawlJobId);
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).crawlJobs.filter((item) => item.workspaceId === workspaceId);
  }

  async update(workspaceId: string, crawlJobId: string, data: Partial<WebsiteCrawlJob>) {
    return mutateData((store) => {
      const item = store.crawlJobs.find((job) => job.workspaceId === workspaceId && job.id === crawlJobId) || notFound("Crawl job not found");
      Object.assign(item, data);
      return touch(item);
    });
  }

  async updateStatus(workspaceId: string, crawlJobId: string, status: WebsiteCrawlJob["status"]) {
    return this.update(workspaceId, crawlJobId, { status });
  }

  async updateProgress(workspaceId: string, crawlJobId: string, pagesFound: number, pagesCrawled: number) {
    return this.update(workspaceId, crawlJobId, { pagesFound, pagesCrawled });
  }

  async complete(workspaceId: string, crawlJobId: string, pagesFound: number, pagesCrawled: number) {
    return this.update(workspaceId, crawlJobId, { status: "completed", pagesFound, pagesCrawled, completedAt: timestamp() });
  }

  async fail(workspaceId: string, crawlJobId: string, errorMessage: string) {
    return this.update(workspaceId, crawlJobId, { status: "failed", errorMessage, completedAt: timestamp() });
  }
}

export class JsonWebsiteCrawlPageRepository implements WebsiteCrawlPageRepository {
  async create(input: Partial<WebsiteCrawlPage>) {
    return mutateData((data) => {
      const item = normalizeCrawlPage(input);
      data.crawlPages.push(item);
      return item;
    });
  }

  async createMany(input: Partial<WebsiteCrawlPage>[]) {
    return mutateData((data) => {
      const items = input.map(normalizeCrawlPage);
      data.crawlPages.push(...items);
      return items;
    });
  }

  async listByCrawlJob(workspaceId: string, crawlJobId: string) {
    return (await readData()).crawlPages.filter((item) => item.workspaceId === workspaceId && item.crawlJobId === crawlJobId);
  }

  async getById(workspaceId: string, pageId: string) {
    return (await readData()).crawlPages.find((item) => item.workspaceId === workspaceId && item.id === pageId);
  }

  async deleteByCrawlJob(workspaceId: string, crawlJobId: string) {
    await mutateData((data) => {
      data.crawlPages = data.crawlPages.filter((item) => !(item.workspaceId === workspaceId && item.crawlJobId === crawlJobId));
    });
  }
}

export class JsonBusinessExtractionRepository implements BusinessExtractionRepository {
  async create(input: Partial<BusinessExtraction>) {
    return mutateData((data) => {
      const item = normalizeExtraction(input);
      data.businessExtractions.push(item);
      return item;
    });
  }

  async getByCrawlJob(workspaceId: string, crawlJobId: string) {
    return (await readData()).businessExtractions.find((item) => item.workspaceId === workspaceId && item.crawlJobId === crawlJobId);
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).businessExtractions.filter((item) => item.workspaceId === workspaceId);
  }

  async update(workspaceId: string, extractionId: string, data: Partial<BusinessExtraction>) {
    return mutateData((store) => {
      const item = store.businessExtractions.find((extraction) => extraction.workspaceId === workspaceId && extraction.id === extractionId) || notFound("Business extraction not found");
      Object.assign(item, data);
      return touch(item);
    });
  }

  async markReviewed(workspaceId: string, extractionId: string) {
    return this.update(workspaceId, extractionId, { confidence: { status: "reviewed" } });
  }

  async markAppliedToProfile(workspaceId: string, extractionId: string, businessProfileId: string) {
    return this.update(workspaceId, extractionId, { confidence: { status: "applied", businessProfileId } });
  }

  async discard(workspaceId: string, extractionId: string) {
    return this.update(workspaceId, extractionId, { confidence: { status: "discarded" } });
  }
}

export class JsonCampaignLearningRepository implements CampaignLearningRepository {
  async create(input: Partial<CampaignLearning>) {
    return mutateData((data) => {
      const item = normalizeLearning(input);
      data.campaignLearnings.push(item);
      return item;
    });
  }

  async getByCampaign(workspaceId: string, campaignId: string) {
    return (await readData()).campaignLearnings.filter((item) => item.workspaceId === workspaceId && item.campaignId === campaignId);
  }

  async listByWorkspace(workspaceId: string) {
    return (await readData()).campaignLearnings.filter((item) => item.workspaceId === workspaceId);
  }

  async update(workspaceId: string, learningId: string, data: Partial<CampaignLearning>) {
    return mutateData((store) => {
      const item = store.campaignLearnings.find((learning) => learning.workspaceId === workspaceId && learning.id === learningId) || notFound("Campaign learning not found");
      Object.assign(item, data, { updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonCampaignMetricRepository implements CampaignMetricRepository {
  async create(input: Partial<CampaignMetric>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item = normalizeMetric(input);
      data.campaignMetrics?.push(item);
      return item;
    });
  }

  async listByCampaign(workspaceId: string, campaignId: string) {
    return ((await readData()).campaignMetrics || []).filter((item) => item.workspaceId === workspaceId && item.campaignId === campaignId);
  }

  async upsertMetric(input: Partial<CampaignMetric>) {
    return mutateData((data) => {
      ensureCollections(data);
      const existing = data.campaignMetrics?.find((item) => item.workspaceId === input.workspaceId && item.campaignId === input.campaignId && item.metricName === input.metricName);
      if (existing) {
        Object.assign(existing, input);
        return touch(existing);
      }
      const item = normalizeMetric(input);
      data.campaignMetrics?.push(item);
      return item;
    });
  }
}

export class JsonEventLogRepository implements EventLogRepository {
  async create(input: Partial<EventLog>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item = normalizeEventLog(input);
      data.eventLogs?.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).eventLogs || []).filter((item) => item.workspaceId === workspaceId);
  }

  async listByEntity(workspaceId: string, entityType: string, entityId: string) {
    return ((await readData()).eventLogs || []).filter((item) => item.workspaceId === workspaceId && item.entityType === entityType && item.entityId === entityId);
  }
}

export class JsonJobRunRepository implements JobRunRepository {
  async create(input: Partial<JobRun>) {
    return mutateData((data) => {
      ensureCollections(data);
      // 2026-09-27: an id that is already taken is refused, as the Postgres
      // primary key refuses it — the daily-run claim relies on this.
      if (input.id && data.jobRuns?.some((job) => job.id === input.id)) {
        throw new Error(`Job run ${input.id} already exists.`);
      }
      const item = normalizeJobRun(input);
      data.jobRuns?.push(item);
      return item;
    });
  }

  async updateStatus(workspaceId: string, jobRunId: string, status: string) {
    return mutateData((data) => {
      const item = data.jobRuns?.find((job) => job.workspaceId === workspaceId && job.id === jobRunId) || notFound("Job run not found");
      item.status = status;
      return touch(item);
    });
  }

  async complete(workspaceId: string, jobRunId: string, result?: Record<string, unknown>) {
    return mutateData((data) => {
      const item = data.jobRuns?.find((job) => job.workspaceId === workspaceId && job.id === jobRunId) || notFound("Job run not found");
      Object.assign(item, { status: "completed", result, completedAt: timestamp() });
      return touch(item);
    });
  }

  async fail(workspaceId: string, jobRunId: string, errorMessage: string) {
    return mutateData((data) => {
      const item = data.jobRuns?.find((job) => job.workspaceId === workspaceId && job.id === jobRunId) || notFound("Job run not found");
      Object.assign(item, { status: "failed", errorMessage, completedAt: timestamp() });
      return touch(item);
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).jobRuns || []).filter((item) => item.workspaceId === workspaceId);
  }

  async getById(workspaceId: string, jobRunId: string) {
    return ((await readData()).jobRuns || []).find((item) => item.workspaceId === workspaceId && item.id === jobRunId);
  }

  async update(workspaceId: string, jobRunId: string, data: Partial<JobRun>) {
    return mutateData((store) => {
      const item = store.jobRuns?.find((job) => job.workspaceId === workspaceId && job.id === jobRunId) || notFound("Job run not found");
      const { status, payload, result, errorMessage, startedAt, completedAt } = data;
      Object.assign(item, Object.fromEntries(Object.entries({ status, payload, result, errorMessage, startedAt, completedAt }).filter(([, value]) => value !== undefined)));
      return touch(item);
    });
  }

  async claim(workspaceId: string, jobRunId: string, fromStatus: string, toStatus: string, patch: Partial<Pick<JobRun, "payload" | "result" | "errorMessage" | "startedAt" | "completedAt">> = {}) {
    // mutateData serialises writers, so the read and the write here are one step.
    return mutateData((store) => {
      const item = store.jobRuns?.find((job) => job.workspaceId === workspaceId && job.id === jobRunId);
      if (!item || item.status !== fromStatus) return false;
      const { payload, result, errorMessage, startedAt, completedAt } = patch;
      Object.assign(item, Object.fromEntries(Object.entries({ payload, result, errorMessage, startedAt, completedAt }).filter(([, value]) => value !== undefined)));
      item.status = toStatus;
      touch(item);
      return true;
    });
  }
}

export class JsonAgentBehaviorPolicyRepository implements AgentBehaviorPolicyRepository {
  async getActive(workspaceId?: string) {
    return ((await readData()).agentBehaviorPolicies || []).find((item) => item.isActive && (item.workspaceId === workspaceId || (!workspaceId && item.scope === "global")));
  }

  async create(input: Partial<AgentBehaviorPolicy>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: AgentBehaviorPolicy = {
        id: input.id || uid("policy"),
        workspaceId: input.workspaceId,
        name: input.name || "Agent behavior policy",
        scope: input.scope || (input.workspaceId ? "workspace" : "global"),
        version: input.version || "1",
        policy: input.policy || {},
        isActive: input.isActive ?? true,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.agentBehaviorPolicies?.push(item);
      return item;
    });
  }
}

export class JsonCompanyCommunicationSettingsRepository implements CompanyCommunicationSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).companyCommunicationSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<CompanyCommunicationSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.companyCommunicationSettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = {
          id: input.id || uid("comm_settings"),
          workspaceId,
          language: input.language || "English",
          tone: input.tone || "professional_friendly",
          brandVoice: input.brandVoice || "Helpful, concise, respectful",
          messageLength: input.messageLength || "short",
          greeting: input.greeting || "Hello",
          closing: input.closing || "Thank you",
          preferredWords: input.preferredWords || [],
          avoidedWords: input.avoidedWords || [],
          formalityLevel: input.formalityLevel || "balanced",
          emojiUsage: input.emojiUsage || "minimal",
          allowHinglish: input.allowHinglish || false,
          customInstructions: input.customInstructions || "",
          createdAt: input.createdAt || timestamp(),
          updatedAt: timestamp(),
        };
        data.companyCommunicationSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonConversationPolicyRepository implements ConversationPolicyRepository {
  async getByWorkspaceAndChannel(workspaceId: string, channel: string) {
    return ((await readData()).conversationPolicies || []).find((item) => item.workspaceId === workspaceId && item.channel === channel);
  }

  async upsertForWorkspaceAndChannel(workspaceId: string, channel: string, input: Partial<ConversationPolicy>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.conversationPolicies?.find((policy) => policy.workspaceId === workspaceId && policy.channel === channel);
      if (!item) {
        item = { id: input.id || uid("conversation_policy"), workspaceId, channel, policy: {}, sensitiveTopics: [], autoReplyAllowedCategories: [], humanApprovalRequiredCategories: [], createdAt: timestamp(), updatedAt: timestamp() };
        data.conversationPolicies?.push(item);
      }
      assignUpdate(item, input, { workspaceId, channel, updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonWhatsAppAgentSettingsRepository implements WhatsAppAgentSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).whatsAppAgentSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<WhatsAppAgentSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.whatsAppAgentSettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = {
          id: input.id || uid("wa_settings"),
          workspaceId,
          enabled: input.enabled ?? false,
          mode: input.mode || "draft_only",
          defaultLanguage: input.defaultLanguage || "English",
          maxAutoRepliesPerConversation: input.maxAutoRepliesPerConversation || 3,
          businessHours: input.businessHours || {},
          escalationContactName: input.escalationContactName || "",
          escalationContactPhone: input.escalationContactPhone || "",
          escalationContactEmail: input.escalationContactEmail || "",
          unknownAnswerBehavior: input.unknownAnswerBehavior || "hold_for_review",
          abusiveMessageBehavior: input.abusiveMessageBehavior || "escalate",
          priceQuestionBehavior: input.priceQuestionBehavior || "ask_quantity_or_escalate",
          createdAt: input.createdAt || timestamp(),
          updatedAt: timestamp(),
        };
        data.whatsAppAgentSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonEscalationRuleRepository implements EscalationRuleRepository {
  async listActive(workspaceId: string, channel?: string) {
    return ((await readData()).escalationRules || []).filter((item) => item.workspaceId === workspaceId && item.isActive && (!channel || item.channel === channel));
  }

  async create(input: Partial<EscalationRule>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: EscalationRule = { id: input.id || uid("escalation"), workspaceId: input.workspaceId || defaultWorkspaceId, channel: input.channel || "manual", triggerType: input.triggerType || "manual", condition: input.condition || {}, action: input.action || {}, priority: input.priority || 100, isActive: input.isActive ?? true, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.escalationRules?.push(item);
      return item;
    });
  }
}

export class JsonUnknownQuestionRepository implements UnknownQuestionRepository {
  async create(workspaceId: string, input: Partial<UnknownQuestion>) {
    return mutateData((data) => {
      ensureCollections(data);
      // 2026-08-05 (golden:substrate-parity, divergence #3): this constructor
      // used to build the row field-by-field and SILENTLY DROP everything it
      // did not name — generatedBy, relatedDomain, relatedQuestionKey,
      // conflictSourcesJson, sourceIds, sourceDocumentId, priority,
      // convertedToTicketId. Prisma persisted them; JSON did not.
      //
      // That mattered: `generatedBy` is written by 5 services
      // (AISettingsService, DocumentQuestionAnsweringService,
      // KnowledgeAnswerMergeService, OwnerCopilotService,
      // WhatsAppConversationEngine) and READ by
      // KnowledgeQuestionPresentationService to group the "Questions from AI"
      // screen. On the JSON substrate every question therefore collapsed to
      // the "framework" fallback bucket, and every golden that thought it was
      // asserting provenance was asserting undefined.
      const item: UnknownQuestion = {
        id: input.id || uid("unknown"),
        workspaceId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        channel: input.channel || "manual",
        questionText: input.questionText || "",
        missingTopic: input.missingTopic,
        status: input.status || "open",
        suggestedAnswer: input.suggestedAnswer,
        finalAnswer: input.finalAnswer,
        generatedBy: input.generatedBy,
        relatedDomain: input.relatedDomain,
        relatedQuestionKey: input.relatedQuestionKey,
        conflictSourcesJson: input.conflictSourcesJson,
        sourceIds: input.sourceIds,
        sourceDocumentId: input.sourceDocumentId,
        priority: input.priority,
        convertedToTicketId: input.convertedToTicketId,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.unknownQuestions?.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string, filters: { status?: string } = {}) {
    return ((await readData()).unknownQuestions || []).filter((item) => item.workspaceId === workspaceId && (!filters.status || item.status === filters.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // 2026-07-21 (Cluster A fix B3, session 16) — single-record fetch for the
  // convert-to-ticket route.
  async getById(workspaceId: string, id: string) {
    return ((await readData()).unknownQuestions || []).find((item) => item.workspaceId === workspaceId && item.id === id);
  }

  async update(workspaceId: string, id: string, input: Partial<UnknownQuestion>) {
    return mutateData((data) => {
      const item = data.unknownQuestions?.find((question) => question.workspaceId === workspaceId && question.id === id) || notFound("Unknown question not found");
      assignUpdate(item, input, { updatedAt: timestamp() });
      return item;
    });
  }

  async markAnswered(workspaceId: string, id: string, answer: string) {
    return this.update(workspaceId, id, { finalAnswer: answer, status: "answered" });
  }

  async markAddedToKnowledge(workspaceId: string, id: string) {
    return this.update(workspaceId, id, { status: "added_to_knowledge" });
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all unknown questions for a
   * lead. DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      ensureCollections(store);
      const before = (store.unknownQuestions || []).length;
      store.unknownQuestions = (store.unknownQuestions || []).filter(
        (q) => !(q.workspaceId === workspaceId && q.leadId === leadId),
      );
      return before - (store.unknownQuestions || []).length;
    });
  }
}

/**
 * Stage 2 (2026-07-20) — JSON-mode Ticket repository.
 */
export class JsonTicketRepository implements TicketRepository {
  async nextTicketNumber(workspaceId: string): Promise<number> {
    return mutateData((data) => {
      ensureCollections(data);
      const wsTickets = (data.tickets || []).filter((t) => t.workspaceId === workspaceId);
      const max = wsTickets.reduce((acc, t) => Math.max(acc, t.ticketNumber || 0), 0);
      return max + 1;
    });
  }

  async create(input: Partial<Ticket> & { workspaceId: string; type: Ticket["type"]; priority: Ticket["priority"]; subject: string; description: string; sourceChannel: string }): Promise<Ticket> {
    return mutateData((data) => {
      ensureCollections(data);
      const now = timestamp();
      const item: Ticket = {
        id: input.id || uid("ticket"),
        workspaceId: input.workspaceId,
        ticketNumber: input.ticketNumber ?? 0,
        leadId: input.leadId,
        replyId: input.replyId,
        conversationId: input.conversationId,
        orderId: input.orderId,
        quoteId: input.quoteId,
        sourceChannel: input.sourceChannel,
        type: input.type,
        priority: input.priority,
        status: input.status || "open",
        subject: input.subject,
        description: input.description,
        resolution: input.resolution,
        assignedTo: input.assignedTo,
        sourceEntityType: input.sourceEntityType || "manual",
        sourceEntityId: input.sourceEntityId,
        slaStartedAt: input.slaStartedAt || now,
        slaDueAt: input.slaDueAt || now,
        slaBreached: false,
        firstRespondedAt: input.firstRespondedAt,
        resolvedAt: input.resolvedAt,
        closedAt: input.closedAt,
        createdAt: now,
        updatedAt: now,
      };
      data.tickets?.push(item);
      return item;
    });
  }
  /**
   * 2026-07-21 (Cluster D fix, session 20) — Atomic number allocation.
   * Pinned by golden:number-allocation-race.
   */
  async createWithNextTicketNumber(input: Partial<Ticket> & { workspaceId: string; type: Ticket["type"]; priority: Ticket["priority"]; subject: string; description: string; sourceChannel: string }): Promise<Ticket> {
    return mutateData((data) => {
      ensureCollections(data);
      const now = timestamp();
      const existing = (data.tickets || []).filter((r) => r.workspaceId === input.workspaceId);
      const max = existing.reduce((acc, r) => Math.max(acc, Number(r.ticketNumber || 0)), 0);
      const ticketNumber = max + 1;
      const item: Ticket = {
        id: input.id || uid("ticket"),
        workspaceId: input.workspaceId,
        ticketNumber,
        leadId: input.leadId,
        replyId: input.replyId,
        conversationId: input.conversationId,
        orderId: input.orderId,
        quoteId: input.quoteId,
        sourceChannel: input.sourceChannel,
        type: input.type,
        priority: input.priority,
        status: input.status || "open",
        subject: input.subject,
        description: input.description,
        resolution: input.resolution,
        assignedTo: input.assignedTo,
        sourceEntityType: input.sourceEntityType || "manual",
        sourceEntityId: input.sourceEntityId,
        slaStartedAt: input.slaStartedAt || now,
        slaDueAt: input.slaDueAt || now,
        slaBreached: false,
        firstRespondedAt: input.firstRespondedAt,
        resolvedAt: input.resolvedAt,
        closedAt: input.closedAt,
        createdAt: now,
        updatedAt: now,
      };
      data.tickets?.push(item);
      return item;
    });
  }

  async getById(workspaceId: string, ticketId: string): Promise<Ticket | undefined> {
    return (await readData()).tickets?.find((t) => t.workspaceId === workspaceId && t.id === ticketId);
  }

  async getByTicketNumber(workspaceId: string, ticketNumber: number): Promise<Ticket | undefined> {
    return (await readData()).tickets?.find((t) => t.workspaceId === workspaceId && t.ticketNumber === ticketNumber);
  }

  async listByWorkspace(workspaceId: string, filters: { status?: Ticket["status"]; priority?: Ticket["priority"]; leadId?: string } = {}): Promise<Ticket[]> {
    return ((await readData()).tickets || [])
      .filter((t) => t.workspaceId === workspaceId)
      .filter((t) => !filters.status || t.status === filters.status)
      .filter((t) => !filters.priority || t.priority === filters.priority)
      .filter((t) => !filters.leadId || t.leadId === filters.leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listOpenTickets(workspaceId: string): Promise<Ticket[]> {
    const open = (await this.listByWorkspace(workspaceId)).filter((t) => !["resolved", "closed"].includes(t.status));
    return open;
  }

  async listBreached(workspaceId: string): Promise<Ticket[]> {
    return (await this.listOpenTickets(workspaceId)).filter((t) => t.slaBreached);
  }

  async update(workspaceId: string, ticketId: string, data: Partial<Ticket>): Promise<Ticket> {
    return mutateData((d) => {
      const item = d.tickets?.find((t) => t.workspaceId === workspaceId && t.id === ticketId) || notFound("Ticket not found");
      Object.assign(item, data, { updatedAt: timestamp() });
      return item;
    });
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all tickets for a lead.
   * DPDPA erasure cascade ONLY. Returns the count removed.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      ensureCollections(store);
      const before = (store.tickets || []).length;
      store.tickets = (store.tickets || []).filter(
        (t) => !(t.workspaceId === workspaceId && t.leadId === leadId),
      );
      return before - (store.tickets || []).length;
    });
  }
}

export class JsonTicketEventRepository implements TicketEventRepository {
  async create(input: Partial<TicketEvent> & { workspaceId: string; ticketId: string; eventType: TicketEvent["eventType"]; actorType: TicketEvent["actorType"] }): Promise<TicketEvent> {
    return mutateData((data) => {
      ensureCollections(data);
      const item: TicketEvent = {
        id: input.id || uid("tev"),
        ticketId: input.ticketId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        note: input.note,
        createdAt: timestamp(),
      };
      data.ticketEvents?.push(item);
      return item;
    });
  }

  async listByTicket(workspaceId: string, ticketId: string): Promise<TicketEvent[]> {
    return ((await readData()).ticketEvents || [])
      .filter((e) => e.workspaceId === workspaceId && e.ticketId === ticketId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all events for a set of ticket
   * ids. DPDPA erasure cascade ONLY (after tickets themselves are deleted).
   */
  async deleteByTicketIds(workspaceId: string, ticketIds: string[]): Promise<number> {
    if (ticketIds.length === 0) return 0;
    const idSet = new Set(ticketIds);
    return mutateData((store) => {
      ensureCollections(store);
      const before = (store.ticketEvents || []).length;
      store.ticketEvents = (store.ticketEvents || []).filter(
        (e) => !(e.workspaceId === workspaceId && idSet.has(e.ticketId)),
      );
      return before - (store.ticketEvents || []).length;
    });
  }
}

export class JsonTicketSlaSettingsRepository implements TicketSlaSettingsRepository {
  async getByWorkspace(workspaceId: string): Promise<TicketSlaSettings | undefined> {
    const found = (await readData()).ticketSlaSettings?.find((s) => s.workspaceId === workspaceId);
    // 2026-09-28 (M9): untouched old defaults read as the corrected ones.
    return found ? upgradeLegacySlaDefaults(found) : undefined;
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<TicketSlaSettings>): Promise<TicketSlaSettings> {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.ticketSlaSettings?.find((s) => s.workspaceId === workspaceId);
      if (!item) {
        item = {
          id: uid("ticket_sla"),
          workspaceId,
          // 2026-07-26 Session 4 (P2-DESIGN-1): import the single source of truth
          // from ticket-sla.ts. Was hardcoded [1,2,3,4,5,6] in 5 places; now all
          // sites import DEFAULT_BUSINESS_DAYS so a future default change lands
          // in one place. Operator can override per-workspace via the UI.
          clockMode: DEFAULT_CLOCK_MODE,
          businessHoursStart: DEFAULT_BUSINESS_HOURS_START,
          businessHoursEnd: DEFAULT_BUSINESS_HOURS_END,
          businessDays: [...DEFAULT_BUSINESS_DAYS],
          closedDates: [],
          urgentSlaMinutes: DEFAULT_SLA_MINUTES.urgent,
          highSlaMinutes: DEFAULT_SLA_MINUTES.high,
          mediumSlaMinutes: DEFAULT_SLA_MINUTES.medium,
          lowSlaMinutes: DEFAULT_SLA_MINUTES.low,
          assignmentMode: "manual",
          assignmentRules: [],
          roundRobinPointer: 0,
          createdAt: timestamp(),
          updatedAt: timestamp(),
        } as TicketSlaSettings;
        data.ticketSlaSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item;
    });
  }
}

// 2026-07-21 (M7) — Order + Quote JSON repositories (Stage 3 plumbing).
// Mirror the Ticket repository pattern. Pure persistence; business rules
// live in src/services/OrderService.ts.
export class JsonOrderRepository implements OrderRepository {
  async nextOrderNumber(workspaceId: string): Promise<number> {
    const rows = (await readData()).orders || [];
    const max = rows.filter((r) => r.workspaceId === workspaceId).reduce((acc, r) => Math.max(acc, Number(r.orderNumber || 0)), 0);
    return max + 1;
  }
  async create(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }): Promise<Order> {
    return mutateData((data) => {
      ensureCollections(data);
      const now = timestamp();
      const item: Order = {
        id: input.id || uid("order"),
        workspaceId: input.workspaceId,
        orderNumber: input.orderNumber ?? 0,
        leadId: input.leadId,
        quoteId: input.quoteId,
        status: input.status,
        lineItems: input.lineItems,
        grandTotal: input.grandTotal,
        currencyCode: input.currencyCode,
        origin: input.origin,
        reorderedFromOrderId: input.reorderedFromOrderId,
        sourceReplyId: input.sourceReplyId,
        sourceInteractionId: input.sourceInteractionId,
        discountGiven: input.discountGiven,
        totalDiscountAmount: input.totalDiscountAmount,
        shippedQuantityByLine: input.shippedQuantityByLine,
        confirmedAt: input.confirmedAt,
        shippedAt: input.shippedAt,
        deliveredAt: input.deliveredAt,
        cancelledAt: input.cancelledAt,
        cancelledBy: input.cancelledBy,
        cancelReason: input.cancelReason,
        cancelledQuantityByLine: input.cancelledQuantityByLine,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      data.orders?.push(item);
      return item;
    });
  }
  /**
   * 2026-07-21 (Cluster D fix, session 20) — Atomic number allocation.
   * Combines nextOrderNumber + create inside ONE mutateData so concurrent
   * callers cannot both read the same max and create duplicates. Pinned
   * by golden:number-allocation-race.
   *
   * 2026-07-26 Session 4 audit fix (P3-API-2): `cancelledQuantityByLine`
   * added to `create` for symmetry with this atomic method + the Prisma
   * repo. Audit found the non-atomic create silently dropped the field.
   * Combines nextOrderNumber + create inside ONE mutateData so concurrent
   * callers cannot both read the same max and create duplicates. Pinned
   * by golden:number-allocation-race.
   */
  async createWithNextOrderNumber(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }): Promise<Order> {
    return mutateData((data) => {
      ensureCollections(data);
      const now = timestamp();
      const existing = (data.orders || []).filter((r) => r.workspaceId === input.workspaceId);
      const max = existing.reduce((acc, r) => Math.max(acc, Number(r.orderNumber || 0)), 0);
      const orderNumber = max + 1;
      const item: Order = {
        id: input.id || uid("order"),
        workspaceId: input.workspaceId,
        orderNumber,
        leadId: input.leadId,
        quoteId: input.quoteId,
        status: input.status,
        lineItems: input.lineItems,
        grandTotal: input.grandTotal,
        currencyCode: input.currencyCode,
        origin: input.origin,
        reorderedFromOrderId: input.reorderedFromOrderId,
        sourceReplyId: input.sourceReplyId,
        sourceInteractionId: input.sourceInteractionId,
        discountGiven: input.discountGiven,
        totalDiscountAmount: input.totalDiscountAmount,
        shippedQuantityByLine: input.shippedQuantityByLine,
        confirmedAt: input.confirmedAt,
        shippedAt: input.shippedAt,
        deliveredAt: input.deliveredAt,
        cancelledAt: input.cancelledAt,
        cancelledBy: input.cancelledBy,
        cancelReason: input.cancelReason,
        cancelledQuantityByLine: input.cancelledQuantityByLine,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      data.orders?.push(item);
      return item;
    });
  }
  async getById(workspaceId: string, orderId: string): Promise<Order | undefined> {
    return (await readData()).orders?.find((o) => o.workspaceId === workspaceId && o.id === orderId);
  }
  async listByWorkspace(workspaceId: string, filters: { status?: Order["status"]; leadId?: string } = {}): Promise<Order[]> {
    return ((await readData()).orders || [])
      .filter((o) => o.workspaceId === workspaceId)
      .filter((o) => !filters.status || o.status === filters.status)
      .filter((o) => !filters.leadId || o.leadId === filters.leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listByLead(workspaceId: string, leadId: string): Promise<Order[]> {
    return ((await readData()).orders || [])
      .filter((o) => o.workspaceId === workspaceId && o.leadId === leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async update(workspaceId: string, orderId: string, data: Partial<Order>): Promise<Order> {
    return mutateData((d) => {
      const item = d.orders?.find((o) => o.workspaceId === workspaceId && o.id === orderId);
      if (!item) throw new Error(`Order ${orderId} not found`);
      Object.assign(item, data, { updatedAt: timestamp() });
      return item;
    });
  }
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all orders for a lead.
   * DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      ensureCollections(store);
      const before = (store.orders || []).length;
      store.orders = (store.orders || []).filter(
        (o) => !(o.workspaceId === workspaceId && o.leadId === leadId),
      );
      return before - (store.orders || []).length;
    });
  }
}

export class JsonQuoteRepository implements QuoteRepository {
  async reviseAtomically(workspaceId: string, quoteId: string, build: Parameters<QuoteRepository["reviseAtomically"]>[2]) {
    return mutateData(async (data) => {
      ensureCollections(data);
      const current = data.quotes?.find(q => q.workspaceId === workspaceId && q.id === quoteId);
      if (!current) return undefined;
      const draft = await build(structuredClone(current));
      if (draft.workspaceId !== workspaceId || draft.status !== "draft" || draft.supersedesQuoteId !== quoteId) throw new Error("Quote revision returned inconsistent record links.");
      const now = timestamp();
      const quoteNumber = (data.quotes || []).filter(q => q.workspaceId === workspaceId).reduce((max, q) => Math.max(max, Number(q.quoteNumber || 0)), 0) + 1;
      const quote: Quote = { ...draft, id: uid("quote"), quoteNumber, createdAt: now, updatedAt: now };
      data.quotes!.push(quote);
      Object.assign(current, { status: "superseded", updatedAt: now });
      return { quote, supersededQuote: current };
    });
  }
  async convertToOrderAtomically(workspaceId: string, quoteId: string, build: (quote: Quote) => Promise<{ order: Order; quote: Quote }>) {
    return mutateData(async (data) => {
      ensureCollections(data);
      const current = data.quotes?.find(q => q.workspaceId === workspaceId && q.id === quoteId);
      if (!current) return undefined;
      if (current.status === "converted") {
        const existing = data.orders?.find(o => o.workspaceId === workspaceId && o.id === current.orderId && o.quoteId === current.id);
        if (!existing) throw new NeedsActionError("This converted quote has no linked order. Ask the owner to check its history before trying again.", 409);
        return { order: existing, quote: current, alreadyConverted: true };
      }
      const result = await build(structuredClone(current));
      if (result.order.workspaceId !== workspaceId || result.order.quoteId !== quoteId || result.quote.id !== quoteId || result.quote.workspaceId !== workspaceId || result.quote.status !== "converted" || result.quote.orderId !== result.order.id) {
        throw new Error("Quote conversion returned inconsistent record links.");
      }
      const orderNumber = (data.orders || []).filter(o => o.workspaceId === workspaceId).reduce((max, o) => Math.max(max, Number(o.orderNumber || 0)), 0) + 1;
      const order = { ...result.order, orderNumber };
      data.orders!.push(order);
      Object.assign(current, { status: "converted", orderId: order.id, updatedAt: timestamp() });
      return { order, quote: current, alreadyConverted: false };
    });
  }
  async nextQuoteNumber(workspaceId: string): Promise<number> {
    const rows = (await readData()).quotes || [];
    const max = rows.filter((r) => r.workspaceId === workspaceId).reduce((acc, r) => Math.max(acc, Number(r.quoteNumber || 0)), 0);
    return max + 1;
  }
  async create(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }): Promise<Quote> {
    return mutateData((data) => {
      ensureCollections(data);
      const now = timestamp();
      const item: Quote = {
        id: input.id || uid("quote"),
        workspaceId: input.workspaceId,
        quoteNumber: input.quoteNumber ?? 0,
        leadId: input.leadId,
        orderId: input.orderId,
        supersedesQuoteId: input.supersedesQuoteId,
        status: input.status,
        lineItems: input.lineItems,
        grandTotal: input.grandTotal,
        currencyCode: input.currencyCode,
        validityNote: input.validityNote,
        sentAt: input.sentAt,
        acceptedAt: input.acceptedAt,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      data.quotes?.push(item);
      return item;
    });
  }
  /**
   * 2026-07-21 (Cluster D fix, session 20) — Atomic number allocation.
   * Pinned by golden:number-allocation-race.
   */
  async createWithNextQuoteNumber(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }): Promise<Quote> {
    return mutateData((data) => {
      ensureCollections(data);
      const now = timestamp();
      const existing = (data.quotes || []).filter((r) => r.workspaceId === input.workspaceId);
      const max = existing.reduce((acc, r) => Math.max(acc, Number(r.quoteNumber || 0)), 0);
      const quoteNumber = max + 1;
      const item: Quote = {
        id: input.id || uid("quote"),
        workspaceId: input.workspaceId,
        quoteNumber,
        leadId: input.leadId,
        orderId: input.orderId,
        supersedesQuoteId: input.supersedesQuoteId,
        status: input.status,
        lineItems: input.lineItems,
        grandTotal: input.grandTotal,
        currencyCode: input.currencyCode,
        validityNote: input.validityNote,
        sentAt: input.sentAt,
        acceptedAt: input.acceptedAt,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      data.quotes?.push(item);
      return item;
    });
  }
  async getById(workspaceId: string, quoteId: string): Promise<Quote | undefined> {
    return (await readData()).quotes?.find((q) => q.workspaceId === workspaceId && q.id === quoteId);
  }
  async listByWorkspace(workspaceId: string, filters: { status?: Quote["status"]; leadId?: string } = {}): Promise<Quote[]> {
    return ((await readData()).quotes || [])
      .filter((q) => q.workspaceId === workspaceId)
      .filter((q) => !filters.status || q.status === filters.status)
      .filter((q) => !filters.leadId || q.leadId === filters.leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listByLead(workspaceId: string, leadId: string): Promise<Quote[]> {
    return ((await readData()).quotes || [])
      .filter((q) => q.workspaceId === workspaceId && q.leadId === leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async update(workspaceId: string, quoteId: string, data: Partial<Quote>, expectedStatus?: Quote["status"]): Promise<Quote> {
    return mutateData((d) => {
      const item = d.quotes?.find((q) => q.workspaceId === workspaceId && q.id === quoteId);
      if (!item) throw new Error(`Quote ${quoteId} not found`);
      if (expectedStatus !== undefined && item.status !== expectedStatus) throw new NeedsActionError("This quote changed while you were working. Refresh it before trying again.", 409);
      Object.assign(item, data, { updatedAt: timestamp() });
      return item;
    });
  }
  async claimForConversion(workspaceId: string, quoteId: string, fromStatuses: Quote["status"][]): Promise<boolean> {
    return mutateData((d) => {
      const item = d.quotes?.find((q) => q.workspaceId === workspaceId && q.id === quoteId);
      if (!item || !fromStatuses.includes(item.status)) return false;
      Object.assign(item, { status: "converted", updatedAt: timestamp() });
      return true;
    });
  }
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all quotes for a lead.
   * DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      ensureCollections(store);
      const before = (store.quotes || []).length;
      store.quotes = (store.quotes || []).filter(
        (q) => !(q.workspaceId === workspaceId && q.leadId === leadId),
      );
      return before - (store.quotes || []).length;
    });
  }
}

/**
 * N-DNC-1 (2026-08-18). The permanent Do-Not-Contact registry, behind the
 * repository boundary like everything else. Before this existed,
 * src/lib/dnc-registry.ts talked to the JSON file directly on BOTH substrates,
 * so on Postgres the compliance store silently lived somewhere the product
 * does not ship.
 *
 * Matching is OR across the two keys and treats an empty string as absent —
 * see the interface comment for why that distinction matters here.
 */
export class JsonDoNotContactRepository implements DoNotContactRepository {
  async listByWorkspace(workspaceId: string) {
    return ((await readData()).doNotContactRegistry || []).filter((entry) => entry.workspaceId === workspaceId);
  }
  async findMatch(workspaceId: string, keys: DncKeys) {
    if (!keys.normalizedPhone && !keys.normalizedEmail && !keys.normalizedDomain) return undefined;
    return ((await readData()).doNotContactRegistry || []).find(
      (entry) => entry.workspaceId === workspaceId && dncEntryMatches(entry, keys),
    );
  }
  async create(entry: DoNotContactEntry) {
    return mutateData((data) => {
      ensureCollections(data);
      data.doNotContactRegistry ||= [];
      data.doNotContactRegistry.push(entry);
      return entry;
    });
  }
  async removeMatching(workspaceId: string, keys: DncKeys) {
    if (!keys.normalizedPhone && !keys.normalizedEmail && !keys.normalizedDomain) return 0;
    return mutateData((data) => {
      const before = (data.doNotContactRegistry || []).length;
      data.doNotContactRegistry = (data.doNotContactRegistry || []).filter(
        (entry) => !(entry.workspaceId === workspaceId && dncEntryMatches(entry, keys)),
      );
      return before - (data.doNotContactRegistry || []).length;
    });
  }
}

/** One register entry against the supplied keys: phone on its last 10 digits, email and website host exactly. */
function dncEntryMatches(entry: DoNotContactEntry, keys: DncKeys): boolean {
  const phone = keys.normalizedPhone || "";
  const email = keys.normalizedEmail || "";
  const domain = keys.normalizedDomain || "";
  return (phone !== "" && samePhoneForOptOut(entry.normalizedPhone, phone))
    || (email !== "" && entry.normalizedEmail === email)
    || (domain !== "" && entry.normalizedDomain === domain);
}

export class JsonAutoReplyLogRepository implements AutoReplyLogRepository {
  async create(workspaceId: string, input: Partial<AutoReplyLog>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: AutoReplyLog = { id: input.id || uid("auto_reply"), workspaceId, leadId: input.leadId, replyId: input.replyId, channel: input.channel || "manual", incomingMessage: input.incomingMessage || "", retrievedContext: input.retrievedContext || {}, classification: input.classification, generatedReply: input.generatedReply, confidenceScore: input.confidenceScore, canAutoSend: input.canAutoSend || false, needsHumanReview: input.needsHumanReview ?? true, reason: input.reason, modelProvider: input.modelProvider, modelName: input.modelName, modelMode: input.modelMode, fallbackUsed: input.fallbackUsed || false, validationStatus: input.validationStatus || "not_run", sendAttempted: input.sendAttempted || false, sendStatus: input.sendStatus || "not_attempted", providerMessageId: input.providerMessageId, providerError: input.providerError, mediaAttachmentId: input.mediaAttachmentId, mediaAttachmentUrl: input.mediaAttachmentUrl, mediaAttachmentName: input.mediaAttachmentName, status: input.status || "drafted", internalNote: input.internalNote,
        // 2026-09-23 — named for the first time. This writer lists every field by
        // hand and never listed this one, so the holding-message flag was dropped
        // HERE as well as on Postgres: stored on neither substrate since CP-22.
        acknowledgementSent: input.acknowledgementSent, aiDraft: input.aiDraft, ownerEdited: input.ownerEdited,
        createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.autoReplyLogs?.push(item);
      return item;
    });
  }

  async getById(workspaceId: string, id: string) {
    return ((await readData()).autoReplyLogs || []).find((item) => item.workspaceId === workspaceId && item.id === id);
  }

  async listByLead(workspaceId: string, leadId: string) {
    return ((await readData()).autoReplyLogs || []).filter((item) => item.workspaceId === workspaceId && item.leadId === leadId);
  }

  async listByWorkspace(workspaceId: string, filters: { status?: string } = {}) {
    return ((await readData()).autoReplyLogs || []).filter((item) => item.workspaceId === workspaceId && (!filters.status || item.status === filters.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async approve(workspaceId: string, id: string, input: Partial<AutoReplyLog> = {}) {
    return this.setStatus(workspaceId, id, "approved", input);
  }

  async reject(workspaceId: string, id: string) {
    return this.setStatus(workspaceId, id, "rejected");
  }

  /** 2026-08-05 (UX Fix 1) — save the operator's internal note. */
  async updateNote(workspaceId: string, id: string, internalNote: string) {
    return mutateData((data) => {
      const item = data.autoReplyLogs?.find((log) => log.workspaceId === workspaceId && log.id === id) || notFound("Auto-reply log not found");
      item.internalNote = internalNote;
      item.updatedAt = timestamp();
      return item;
    });
  }

  /** 2026-09-28 — the owner's verdict on an automatic reply. */
  async setOwnerVerdict(workspaceId: string, id: string, verdict: NonNullable<AutoReplyLog["ownerVerdict"]>, at: string) {
    return mutateData((data) => {
      const item = data.autoReplyLogs?.find((log) => log.workspaceId === workspaceId && log.id === id) || notFound("Auto-reply log not found");
      item.ownerVerdict = verdict;
      item.ownerVerdictAt = at;
      item.updatedAt = timestamp();
      return item;
    });
  }

  private async setStatus(workspaceId: string, id: string, status: "approved" | "rejected", input: Partial<AutoReplyLog> = {}) {
    return mutateData((data) => {
      const item = data.autoReplyLogs?.find((log) => log.workspaceId === workspaceId && log.id === id) || notFound("Auto-reply log not found");
      assignUpdate(item, input, { status, needsHumanReview: false, updatedAt: timestamp() });
      return item;
    });
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all auto-reply logs for a
   * lead. DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    return mutateData((store) => {
      ensureCollections(store);
      const before = (store.autoReplyLogs || []).length;
      store.autoReplyLogs = (store.autoReplyLogs || []).filter(
        (l) => !(l.workspaceId === workspaceId && l.leadId === leadId),
      );
      return before - (store.autoReplyLogs || []).length;
    });
  }
}

function mediaBlobDirectory() {
  return path.join(dataDirectory(), "media-blobs");
}

/**
 * Remove stored media bytes by item id. For callers that delete the ROWS
 * themselves inside an atomic snapshot mutation (the DPDPA erasure cascade)
 * and therefore never reach the repository's own delete. Without this, erasing
 * a customer would leave their photos on disk with no row naming them -- the
 * exact "ghost file" the cascade exists to prevent.
 */
/** Whether the file behind a media row is actually on disk. */
async function blobExists(id: string) {
  try {
    await stat(mediaBlobPath(id));
    return true;
  } catch {
    return false;
  }
}

export async function purgeMediaBlobs(ids: string[]) {
  for (const id of ids) {
    await rm(mediaBlobPath(id), { force: true }).catch(() => undefined);
  }
}

function mediaBlobPath(id: string) {
  // The id is repository-generated (uid("media")), never caller-supplied text,
  // but strip separators anyway so a hand-written id can never escape the
  // directory.
  return path.join(mediaBlobDirectory(), `${id.replace(/[^\w.-]+/g, "_")}.bin`);
}

export class JsonMediaCatalogRepository implements MediaCatalogRepository {
  // 2026-09-10 (session 55): the file bytes live in a blob file next to
  // app-data.json, keyed by the item id -- NOT inside app-data.json (which is
  // re-read and re-written whole on every mutation) and NOT under public/,
  // which on the deployed substrate is a container filesystem that does not
  // survive a restart. Same contract as the Postgres repository: the bytes are
  // reachable only through getFileBytes.
  async create(workspaceId: string, input: Partial<MediaCatalogItem>, bytes?: Buffer) {
    const created = await mutateData((data) => {
      ensureCollections(data);
      const item: MediaCatalogItem = {
        id: input.id || uid("media"),
        workspaceId,
        title: input.title || input.fileName || "Untitled media",
        category: input.category || "other",
        fileName: input.fileName || "media",
        fileType: input.fileType || "application/octet-stream",
        fileSize: input.fileSize || 0,
        url: input.url || "",
        storagePath: input.storagePath || "",
        caption: input.caption,
        leadId: input.leadId,
        status: input.status || "active",
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.mediaCatalogItems?.push(item);
      return item;
    });
    if (bytes?.length) {
      await mkdir(mediaBlobDirectory(), { recursive: true });
      await writeFile(mediaBlobPath(created.id), bytes);
    }
    return created;
  }

  async getFileBytes(workspaceId: string, id: string) {
    const item = await this.getById(workspaceId, id);
    if (!item) return undefined;
    try {
      return await readFile(mediaBlobPath(id));
    } catch {
      // A row whose blob is missing (uploaded before the bytes moved into the
      // store, or a hand-edited data file). Say "no bytes", not "crash".
      return undefined;
    }
  }

  async listByWorkspace(workspaceId: string, filters: { category?: string; leadId?: string } = {}) {
    const rows = ((await readData()).mediaCatalogItems || [])
      .filter((item) => item.workspaceId === workspaceId && item.status !== "archived")
      .filter((item) => !filters.category || item.category === filters.category)
      .filter((item) => !filters.leadId || item.leadId === filters.leadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(rows.map(async (item) => ({ ...item, fileMissing: !(await blobExists(item.id)) })));
  }

  async getById(workspaceId: string, id: string) {
    const item = ((await readData()).mediaCatalogItems || []).find((row) => row.workspaceId === workspaceId && row.id === id && row.status !== "archived");
    if (!item) return undefined;
    return { ...item, fileMissing: !(await blobExists(id)) };
  }

  async delete(workspaceId: string, id: string) {
    const item = await mutateData((data) => {
      ensureCollections(data);
      const found = data.mediaCatalogItems?.find((media) => media.workspaceId === workspaceId && media.id === id) || notFound("Media item not found");
      found.status = "archived";
      found.updatedAt = timestamp();
      return found;
    });
    // The row is what the operator sees; the bytes are what costs space. Once
    // the row is archived nothing can read the file again, so remove it.
    await rm(mediaBlobPath(id), { force: true }).catch(() => undefined);
    return item;
  }

  /** 2026-09-28 (S5) — erasure: hard-delete the customer's photos / voice notes, rows and bytes. */
  async eraseCustomerMediaForLead(workspaceId: string, leadId: string) {
    const ids = await mutateData((data) => {
      const doomed = (data.mediaCatalogItems || []).filter((m) => m.workspaceId === workspaceId && m.leadId === leadId && (m.category === "customer_photo" || m.category === "customer_voice_note"));
      const set = new Set(doomed.map((m) => m.id));
      data.mediaCatalogItems = (data.mediaCatalogItems || []).filter((m) => !set.has(m.id));
      return doomed.map((m) => m.id);
    });
    for (const id of ids) await rm(mediaBlobPath(id), { force: true }).catch(() => undefined);
    return { removed: ids.length, ids };
  }
}

// CP-25 (2026-08-02) — Meta-approved WhatsApp message templates.
export class JsonWhatsAppTemplateRepository implements WhatsAppTemplateRepository {
  async create(workspaceId: string, input: Partial<WhatsAppTemplate>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: WhatsAppTemplate = {
        id: input.id || uid("watpl"),
        workspaceId,
        providerTemplateId: input.providerTemplateId,
        name: input.name || "unnamed_template",
        language: input.language || "en_US",
        category: input.category || "UTILITY",
        status: input.status || "draft",
        body: input.body || "",
        header: input.header,
        footer: input.footer,
        buttons: input.buttons,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.whatsAppTemplates?.push(item);
      return item;
    });
  }
  async listByWorkspace(workspaceId: string) {
    return ((await readData()).whatsAppTemplates || []).filter((t) => t.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getById(workspaceId: string, id: string) {
    return ((await readData()).whatsAppTemplates || []).find((t) => t.workspaceId === workspaceId && t.id === id);
  }
  async update(workspaceId: string, id: string, patch: Partial<WhatsAppTemplate>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item = data.whatsAppTemplates?.find((t) => t.workspaceId === workspaceId && t.id === id) || notFound("Template not found");
      Object.assign(item, patch, { updatedAt: timestamp() });
      return item;
    });
  }
  async deleteById(workspaceId: string, id: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const idx = data.whatsAppTemplates?.findIndex((t) => t.workspaceId === workspaceId && t.id === id) ?? -1;
      if (idx < 0 || !data.whatsAppTemplates) notFound("Template not found");
      const [removed] = data.whatsAppTemplates!.splice(idx, 1);
      return removed;
    });
  }
}

export class JsonKnowledgeBaseDocumentRepository implements KnowledgeBaseDocumentRepository {
  async create(workspaceId: string, input: Partial<KnowledgeBaseDocument>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: KnowledgeBaseDocument = { id: input.id || uid("kb_doc"), workspaceId, title: input.title || "Untitled knowledge", documentType: input.documentType || "other", source: input.source || "manual", status: input.status || "active", contentText: input.contentText || "", metadata: input.metadata || {}, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.knowledgeBaseDocuments?.push(item);
      return item;
    });
  }

  async update(workspaceId: string, documentId: string, input: Partial<KnowledgeBaseDocument>) {
    return mutateData((data) => {
      const item = data.knowledgeBaseDocuments?.find((doc) => doc.workspaceId === workspaceId && doc.id === documentId) || notFound("Knowledge document not found");
      assignUpdate(item, input, { updatedAt: timestamp() });
      return item;
    });
  }

  async getById(workspaceId: string, documentId: string) {
    return ((await readData()).knowledgeBaseDocuments || []).find((item) => item.workspaceId === workspaceId && item.id === documentId);
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).knowledgeBaseDocuments || []).filter((item) => item.workspaceId === workspaceId);
  }

  async getByTypeAndSource(workspaceId: string, documentType: string, source: string) {
    return ((await readData()).knowledgeBaseDocuments || []).find((item) => item.workspaceId === workspaceId && item.documentType === documentType && item.source === source);
  }

  // 2026-09-08 — the chunks go with it, in the SAME mutation. On Postgres the
  // foreign key cascades; here nothing does, and an orphan chunk is worse than
  // no delete at all: the document vanishes from the Knowledge Base screen
  // while searchByKeyword keeps returning its text to the agent, so the wrong
  // fact stays in every answer with nothing left on screen to explain why.
  async delete(workspaceId: string, documentId: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const index = data.knowledgeBaseDocuments?.findIndex((doc) => doc.workspaceId === workspaceId && doc.id === documentId) ?? -1;
      if (index < 0 || !data.knowledgeBaseDocuments) notFound("Knowledge document not found");
      const [removed] = data.knowledgeBaseDocuments!.splice(index, 1);
      data.knowledgeBaseChunks = (data.knowledgeBaseChunks || []).filter(
        (chunk) => !(chunk.workspaceId === workspaceId && chunk.documentId === documentId),
      );
      return removed;
    });
  }
}

export class JsonKnowledgeBaseChunkRepository implements KnowledgeBaseChunkRepository {
  async createMany(workspaceId: string, documentId: string, chunks: Partial<KnowledgeBaseChunk>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      const items = chunks.map((chunk, index): KnowledgeBaseChunk => ({ id: chunk.id || uid("kb_chunk"), workspaceId, documentId, chunkIndex: chunk.chunkIndex ?? index, chunkText: chunk.chunkText || "", embedding: chunk.embedding, metadata: chunk.metadata || {}, createdAt: chunk.createdAt || timestamp(), updatedAt: timestamp() }));
      data.knowledgeBaseChunks?.push(...items);
      return items;
    });
  }

  async listByDocument(workspaceId: string, documentId: string) {
    return ((await readData()).knowledgeBaseChunks || []).filter((item) => item.workspaceId === workspaceId && item.documentId === documentId);
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).knowledgeBaseChunks || []).filter((item) => item.workspaceId === workspaceId);
  }

  async listByIds(workspaceId: string, ids: string[]) {
    if (!ids.length) return [];
    const wanted = new Set(ids);
    return ((await readData()).knowledgeBaseChunks || []).filter((item) => item.workspaceId === workspaceId && wanted.has(item.id));
  }

  async updateMetadata(workspaceId: string, chunkId: string, metadata: Record<string, unknown>) {
    return mutateData((data) => {
      ensureCollections(data);
      const chunk = (data.knowledgeBaseChunks || []).find((item) => item.workspaceId === workspaceId && item.id === chunkId);
      if (!chunk) return null;
      chunk.metadata = metadata as typeof chunk.metadata;
      chunk.updatedAt = timestamp();
      return chunk;
    });
  }

  async replaceForDocument(workspaceId: string, documentId: string, chunks: Partial<KnowledgeBaseChunk>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      data.knowledgeBaseChunks = (data.knowledgeBaseChunks || []).filter((chunk) => !(chunk.workspaceId === workspaceId && chunk.documentId === documentId));
      const items = chunks.map((chunk, index): KnowledgeBaseChunk => ({ id: chunk.id || uid("kb_chunk"), workspaceId, documentId, chunkIndex: chunk.chunkIndex ?? index, chunkText: chunk.chunkText || "", embedding: chunk.embedding, metadata: chunk.metadata || {}, createdAt: chunk.createdAt || timestamp(), updatedAt: timestamp() }));
      data.knowledgeBaseChunks.push(...items);
      return items;
    });
  }

  async searchByKeyword(workspaceId: string, query: string, limit = 5) {
    const data = await readData();
    const docs = data.knowledgeBaseDocuments || [];
    return (data.knowledgeBaseChunks || [])
      .filter((chunk) => chunk.workspaceId === workspaceId)
      .map((chunk) => ({ ...chunk, score: keywordScore(query, chunk.chunkText), documentTitle: docs.find((doc) => doc.id === chunk.documentId)?.title }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export class JsonKnowledgeBaseQueryLogRepository implements KnowledgeBaseQueryLogRepository {
  async create(workspaceId: string, input: Partial<KnowledgeBaseQueryLog>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: KnowledgeBaseQueryLog = { id: input.id || uid("kb_query"), workspaceId, queryText: input.queryText || "", retrievedChunks: input.retrievedChunks || [], answerUsed: input.answerUsed || false, confidenceScore: input.confidenceScore, createdAt: input.createdAt || timestamp() };
      data.knowledgeBaseQueryLogs?.push(item);
      return item;
    });
  }
}

export class JsonLLMProviderCredentialRepository implements LLMProviderCredentialRepository {
  async listByWorkspace(workspaceId: string) {
    return ((await readData()).llmProviderCredentials || []).filter((item) => item.workspaceId === workspaceId);
  }

  async listWorkspaceIdsForWhatsAppNumber(phoneNumberId: string) {
    const wanted = phoneNumberId.trim();
    if (!wanted) return [];
    const ids = ((await readData()).llmProviderCredentials || [])
      .filter((item) => item.provider === "whatsapp_cloud" && String(item.config?.phoneNumberId || "").trim() === wanted)
      .map((item) => item.workspaceId);
    return [...new Set(ids)];
  }

  async create(workspaceId: string, input: Partial<LLMProviderCredential>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: LLMProviderCredential = { id: input.id || uid("llm_credential"), workspaceId, provider: input.provider || "mock", displayName: input.displayName, encryptedApiKey: input.encryptedApiKey, status: input.status || "not_connected", config: input.config || {}, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.llmProviderCredentials?.push(item);
      return item;
    });
  }

  // I-4 fix (batch 3, 2026-07-27): key rotation. Workspace-scoped so a user
  // from ws_A cannot update ws_B's credential by guessing the id.
  async update(workspaceId: string, id: string, patch: Partial<LLMProviderCredential>) {
    return mutateData((data) => {
      ensureCollections(data);
      const list = data.llmProviderCredentials || [];
      const idx = list.findIndex((c) => c.id === id && c.workspaceId === workspaceId);
      if (idx < 0) throw new Error(`LLMProviderCredential not found: ${id}`);
      const existing = list[idx];
      const updated: LLMProviderCredential = {
        ...existing,
        ...patch,
        id: existing.id,
        workspaceId: existing.workspaceId, // immutable on update
        createdAt: existing.createdAt,      // immutable on update
        updatedAt: timestamp(),
      };
      list[idx] = updated;
      return updated;
    });
  }

  // I-4 fix (batch 3, 2026-07-27): revoke + remove. Workspace-scoped.
  async delete(workspaceId: string, id: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const list = data.llmProviderCredentials || [];
      const before = list.length;
      data.llmProviderCredentials = list.filter((c) => !(c.id === id && c.workspaceId === workspaceId));
      return data.llmProviderCredentials.length < before;
    });
  }
}

export class JsonLLMModelRoutingRepository implements LLMModelRoutingRepository {
  async listByWorkspace(workspaceId: string) {
    return ((await readData()).llmModelRoutings || []).filter((item) => item.workspaceId === workspaceId);
  }

  async replaceForWorkspace(workspaceId: string, routes: Partial<LLMModelRouting>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      data.llmModelRoutings = (data.llmModelRoutings || []).filter((item) => item.workspaceId !== workspaceId);
      const items = routes.map((route): LLMModelRouting => ({ id: route.id || uid("llm_route"), workspaceId, taskName: route.taskName || "message_generation", provider: route.provider || "mock", modelName: route.modelName, modelTier: route.modelTier || "mock", isEnabled: route.isEnabled ?? true, fallbackProvider: route.fallbackProvider || "mock", fallbackModelName: route.fallbackModelName, config: route.config || {}, createdAt: route.createdAt || timestamp(), updatedAt: timestamp() }));
      data.llmModelRoutings.push(...items);
      return items;
    });
  }
}

export class JsonAIUsageLimitRepository implements AIUsageLimitRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).aiUsageLimits || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<AIUsageLimit>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.aiUsageLimits?.find((usage) => usage.workspaceId === workspaceId);
      if (!item) {
        item = { id: input.id || uid("ai_usage"), workspaceId, dailyTokenLimit: input.dailyTokenLimit, monthlyTokenLimit: input.monthlyTokenLimit, dailyCostLimit: input.dailyCostLimit, monthlyCostLimit: input.monthlyCostLimit, currentDailyTokens: input.currentDailyTokens || 0, currentMonthlyTokens: input.currentMonthlyTokens || 0, currentDailyCost: input.currentDailyCost || 0, currentMonthlyCost: input.currentMonthlyCost || 0, resetAt: input.resetAt, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
        data.aiUsageLimits?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonProviderAccountRepository implements ProviderAccountRepository {
  async listByWorkspace(workspaceId: string) {
    return ((await readData()).providerAccounts || []).filter((item) => item.workspaceId === workspaceId);
  }

  async create(workspaceId: string, input: Partial<ProviderAccount>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: ProviderAccount = { id: input.id || uid("provider_account"), workspaceId, integrationId: input.integrationId, provider: input.provider || "manual", accountIdentifier: input.accountIdentifier, email: input.email, phoneNumber: input.phoneNumber, displayName: input.displayName, status: input.status || "active", dailyLimit: input.dailyLimit, usedToday: input.usedToday || 0, config: input.config || {}, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.providerAccounts?.push(item);
      return item;
    });
  }

  async update(workspaceId: string, id: string, input: Partial<ProviderAccount>) {
    return mutateData((data) => {
      const item = data.providerAccounts?.find((account) => account.workspaceId === workspaceId && account.id === id) || notFound("Provider account not found");
      assignUpdate(item, input, { updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonWebsiteCrawlConsentRepository implements WebsiteCrawlConsentRepository {
  async create(input: Partial<WebsiteCrawlConsent>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: WebsiteCrawlConsent = { id: input.id || uid("crawl_consent"), workspaceId: input.workspaceId || defaultWorkspaceId, websiteUrl: input.websiteUrl || "", consentGiven: input.consentGiven ?? true, consentGivenAt: input.consentGivenAt || timestamp(), consentTextVersion: input.consentTextVersion || "v1", userId: input.userId, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.websiteCrawlConsents?.push(item);
      return item;
    });
  }

  async getLatestForUrl(workspaceId: string, websiteUrl: string) {
    return ((await readData()).websiteCrawlConsents || []).filter((item) => item.workspaceId === workspaceId && item.websiteUrl === websiteUrl).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
}

export class JsonProductKnowledgeRepository implements ProductKnowledgeRepository {
  async create(input: Partial<ProductKnowledge>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: ProductKnowledge = { id: input.id || uid("product"), workspaceId: input.workspaceId || defaultWorkspaceId, productName: input.productName || "Product", productCategory: input.productCategory, description: input.description, source: input.source || "agent", confidenceScore: input.confidenceScore ?? 0.72, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.productKnowledges?.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).productKnowledges || []).filter((item) => item.workspaceId === workspaceId);
  }

  // N-BUG-5 (2026-09-05). Same contract as the Prisma repository: remove
  // every row of this collection belonging to ONE workspace, return the count.
  async deleteByWorkspace(workspaceId: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const before = (data.productKnowledges || []).length;
      data.productKnowledges = (data.productKnowledges || []).filter((item) => item.workspaceId !== workspaceId);
      return before - data.productKnowledges.length;
    });
  }
}

export class JsonProductVarietyRepository implements ProductVarietyRepository {
  async createMany(input: Partial<ProductVariety>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      const items = input.map((item): ProductVariety => ({ id: item.id || uid("product_variety"), workspaceId: item.workspaceId || defaultWorkspaceId, productKnowledgeId: item.productKnowledgeId || "", name: item.name || "Variety", description: item.description, useCases: item.useCases || [], buyerTypes: item.buyerTypes || [], confidenceScore: item.confidenceScore ?? 0.7, createdAt: item.createdAt || timestamp(), updatedAt: timestamp() }));
      data.productVarieties?.push(...items);
      return items;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).productVarieties || []).filter((item) => item.workspaceId === workspaceId);
  }

  // N-BUG-5 (2026-09-05). Same contract as the Prisma repository: remove
  // every row of this collection belonging to ONE workspace, return the count.
  async deleteByWorkspace(workspaceId: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const before = (data.productVarieties || []).length;
      data.productVarieties = (data.productVarieties || []).filter((item) => item.workspaceId !== workspaceId);
      return before - data.productVarieties.length;
    });
  }
}

export class JsonProductApplicationRepository implements ProductApplicationRepository {
  async createMany(input: Partial<ProductApplication>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      const items = input.map((item): ProductApplication => ({ id: item.id || uid("product_application"), workspaceId: item.workspaceId || defaultWorkspaceId, productKnowledgeId: item.productKnowledgeId || "", varietyId: item.varietyId, applicationName: item.applicationName || "Application", industry: item.industry, description: item.description, exampleProducts: item.exampleProducts || [], buyerTypes: item.buyerTypes || [], seasonality: item.seasonality || {}, confidenceScore: item.confidenceScore ?? 0.7, createdAt: item.createdAt || timestamp(), updatedAt: timestamp() }));
      data.productApplications?.push(...items);
      return items;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).productApplications || []).filter((item) => item.workspaceId === workspaceId);
  }

  // N-BUG-5 (2026-09-05). Same contract as the Prisma repository: remove
  // every row of this collection belonging to ONE workspace, return the count.
  async deleteByWorkspace(workspaceId: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const before = (data.productApplications || []).length;
      data.productApplications = (data.productApplications || []).filter((item) => item.workspaceId !== workspaceId);
      return before - data.productApplications.length;
    });
  }
}

export class JsonBuyerSegmentRepository implements BuyerSegmentRepository {
  async createMany(input: Partial<BuyerSegment>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      const items = input.map((item): BuyerSegment => ({ id: item.id || uid("buyer_segment"), workspaceId: item.workspaceId || defaultWorkspaceId, name: item.name || "Buyer segment", segmentType: item.segmentType || "buyer", description: item.description, needs: item.needs || [], buyingCriteria: item.buyingCriteria || [], preferredChannels: item.preferredChannels || [], qualificationSignals: item.qualificationSignals || [], badFitSignals: item.badFitSignals || [], createdAt: item.createdAt || timestamp(), updatedAt: timestamp() }));
      data.buyerSegments?.push(...items);
      return items;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).buyerSegments || []).filter((item) => item.workspaceId === workspaceId);
  }

  // N-BUG-5 (2026-09-05). Same contract as the Prisma repository: remove
  // every row of this collection belonging to ONE workspace, return the count.
  async deleteByWorkspace(workspaceId: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const before = (data.buyerSegments || []).length;
      data.buyerSegments = (data.buyerSegments || []).filter((item) => item.workspaceId !== workspaceId);
      return before - data.buyerSegments.length;
    });
  }
}

export class JsonProductApplicationMarketMapRepository implements ProductApplicationMarketMapRepository {
  async createMany(input: Partial<ProductApplicationMarketMap>[]) {
    return mutateData((data) => {
      ensureCollections(data);
      const items = input.map((item): ProductApplicationMarketMap => ({ id: item.id || uid("market_map"), workspaceId: item.workspaceId || defaultWorkspaceId, productKnowledgeId: item.productKnowledgeId || "", varietyId: item.varietyId, applicationId: item.applicationId || "", buyerSegmentId: item.buyerSegmentId || "", targetingAngle: item.targetingAngle || "", messageAngle: item.messageAngle || "", searchQueries: item.searchQueries || [], leadSources: item.leadSources || [], confidenceScore: item.confidenceScore ?? 0.7, createdAt: item.createdAt || timestamp(), updatedAt: timestamp() }));
      data.productApplicationMarketMaps?.push(...items);
      return items;
    });
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).productApplicationMarketMaps || []).filter((item) => item.workspaceId === workspaceId);
  }

  // N-BUG-5 (2026-09-05). Same contract as the Prisma repository: remove
  // every row of this collection belonging to ONE workspace, return the count.
  async deleteByWorkspace(workspaceId: string) {
    return mutateData((data) => {
      ensureCollections(data);
      const before = (data.productApplicationMarketMaps || []).length;
      data.productApplicationMarketMaps = (data.productApplicationMarketMaps || []).filter((item) => item.workspaceId !== workspaceId);
      return before - data.productApplicationMarketMaps.length;
    });
  }
}

export class JsonLeadReviewSettingsRepository implements LeadReviewSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).leadReviewSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<LeadReviewSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.leadReviewSettings?.find((setting) => setting.workspaceId === workspaceId);
      if (!item) {
        item = { id: input.id || uid("lead_review_settings"), workspaceId, mode: input.mode || "manual_review", autoApproveThreshold: input.autoApproveThreshold ?? 0.85, autoRejectThreshold: input.autoRejectThreshold ?? 0.25, maxAutoApprovedPerDay: input.maxAutoApprovedPerDay ?? 25, requireHumanForNewCampaigns: input.requireHumanForNewCampaigns ?? true, requireHumanForNewIndustries: input.requireHumanForNewIndustries ?? true, allowAutoEnrichment: input.allowAutoEnrichment ?? false, allowAutoOutreachPreparation: input.allowAutoOutreachPreparation ?? true, allowAutoSend: false, auditEveryDecision: input.auditEveryDecision ?? true, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
        data.leadReviewSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, allowAutoSend: false, updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonLeadReviewDecisionRepository implements LeadReviewDecisionRepository {
  async create(input: Partial<LeadReviewDecision>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: LeadReviewDecision = { id: input.id || uid("lead_review_decision"), workspaceId: input.workspaceId || defaultWorkspaceId, leadId: input.leadId || "", campaignId: input.campaignId, decision: input.decision || "needs_review", confidenceScore: input.confidenceScore ?? 0.5, reason: input.reason || "Needs human review.", matchedSignals: input.matchedSignals || [], riskSignals: input.riskSignals || [], suggestedNextStep: input.suggestedNextStep, modeUsed: input.modeUsed || "manual_review", decidedBy: input.decidedBy || "agent", createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
      data.leadReviewDecisions?.push(item);
      return item;
    });
  }

  async listByLead(workspaceId: string, leadId: string) {
    return ((await readData()).leadReviewDecisions || []).filter((item) => item.workspaceId === workspaceId && item.leadId === leadId);
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).leadReviewDecisions || []).filter((item) => item.workspaceId === workspaceId);
  }

  /** 2026-09-28 (S5) — erasure. */
  async deleteByLead(workspaceId: string, leadId: string) {
    return mutateData((data) => {
      const before = (data.leadReviewDecisions || []).length;
      data.leadReviewDecisions = (data.leadReviewDecisions || []).filter((r) => !(r.workspaceId === workspaceId && r.leadId === leadId));
      return before - data.leadReviewDecisions.length;
    });
  }
}

export class JsonAgentAutonomousSettingsRepository implements AgentAutonomousSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).agentAutonomousSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<AgentAutonomousSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.agentAutonomousSettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = {
          id: input.id || uid("agent_auto_settings"),
          workspaceId,
          icpGeneratorMode: input.icpGeneratorMode || "manual",
          campaignPlannerMode: input.campaignPlannerMode || "manual",
          discoveryMode: input.discoveryMode || "manual",
          whatsappMode: input.whatsappMode || "manual",
          createdAt: input.createdAt || timestamp(),
          updatedAt: timestamp(),
        };
        data.agentAutonomousSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonSalesSettingsRepository implements SalesSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).salesSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<SalesSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.salesSettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = { id: input.id || uid("sales_settings"), workspaceId, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
        data.salesSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item as SalesSettings;
    });
  }
}

export class JsonProductSettingsRepository implements ProductSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).productSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<ProductSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.productSettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = { id: input.id || uid("product_settings"), workspaceId, products: [], createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
        data.productSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item as ProductSettings;
    });
  }
}

export class JsonPolicySettingsRepository implements PolicySettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).policySettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<PolicySettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.policySettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = { id: input.id || uid("policy_settings"), workspaceId, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
        data.policySettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item as PolicySettings;
    });
  }
}

export class JsonCommunicationSettingsRepository implements CommunicationSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    return ((await readData()).communicationSettings || []).find((item) => item.workspaceId === workspaceId);
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<CommunicationSettings>) {
    return mutateData((data) => {
      ensureCollections(data);
      let item = data.communicationSettings?.find((settings) => settings.workspaceId === workspaceId);
      if (!item) {
        item = { id: input.id || uid("communication_settings"), workspaceId, createdAt: input.createdAt || timestamp(), updatedAt: timestamp() };
        data.communicationSettings?.push(item);
      }
      assignUpdate(item, input, { workspaceId, updatedAt: timestamp() });
      return item as CommunicationSettings;
    });
  }
}

export class JsonSettingsConflictRepository implements SettingsConflictRepository {
  async create(workspaceId: string, input: Partial<SettingsConflict>) {
    return mutateData((data) => {
      ensureCollections(data);
      const item: SettingsConflict = {
        id: input.id || uid("conflict"),
        workspaceId,
        settingsArea: input.settingsArea || "sales",
        fieldKey: input.fieldKey || "unknown",
        existingValue: input.existingValue,
        extractedValue: input.extractedValue,
        customValue: input.customValue,
        extractedSource: input.extractedSource || "extraction",
        status: input.status || "open",
        resolution: input.resolution,
        resolutionReason: input.resolutionReason,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.settingsConflicts?.push(item);
      return item;
    });
  }

  async listByWorkspace(workspaceId: string, filters: { status?: string; settingsArea?: string } = {}) {
    return ((await readData()).settingsConflicts || [])
      .filter((item) => item.workspaceId === workspaceId && (!filters.status || item.status === filters.status) && (!filters.settingsArea || item.settingsArea === filters.settingsArea))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getById(workspaceId: string, id: string) {
    return ((await readData()).settingsConflicts || []).find((item) => item.workspaceId === workspaceId && item.id === id);
  }

  async resolve(workspaceId: string, id: string, resolution: SettingsConflict["resolution"], customValue?: string, reason?: string) {
    return mutateData((data) => {
      const item = data.settingsConflicts?.find((c) => c.workspaceId === workspaceId && c.id === id) || notFound("Conflict not found");
      item.status = "resolved";
      item.resolution = resolution;
      if (customValue !== undefined) item.customValue = customValue;
      if (reason !== undefined) item.resolutionReason = reason;
      item.updatedAt = timestamp();
      return item;
    });
  }

  async ignore(workspaceId: string, id: string) {
    return mutateData((data) => {
      const item = data.settingsConflicts?.find((c) => c.workspaceId === workspaceId && c.id === id) || notFound("Conflict not found");
      item.status = "ignored";
      item.updatedAt = timestamp();
      return item;
    });
  }
}

export class JsonPendingSettingsDraftRepository implements PendingSettingsDraftRepository {
  async listByWorkspace(workspaceId: string) {
    return ((await readData()).pendingSettingsDrafts || [])
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPending(workspaceId: string) {
    return ((await readData()).pendingSettingsDrafts || [])
      .filter((item) => item.workspaceId === workspaceId && item.status === "pending_review")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsertPending(workspaceId: string, input: Partial<PendingSettingsDraft>) {
    return mutateData((data) => {
      ensureCollections(data);
      const drafts = data.pendingSettingsDrafts ||= [];
      const existing = drafts.find((item) =>
        item.workspaceId === workspaceId &&
        item.status === "pending_review" &&
        item.kind === input.kind &&
        Boolean(item.sourceGroupKey) &&
        item.sourceGroupKey === input.sourceGroupKey
      );
      const now = timestamp();
      if (existing) {
        Object.assign(existing, input, { workspaceId, updatedAt: now });
        return existing as PendingSettingsDraft;
      }
      const draft: PendingSettingsDraft = {
        id: input.id || uid("settings_draft"),
        workspaceId,
        kind: input.kind || "structured",
        sourceGroupKey: input.sourceGroupKey,
        sourceTitle: input.sourceTitle,
        sourceTopic: input.sourceTopic,
        sourceAnswer: input.sourceAnswer,
        products: input.products,
        sales: input.sales,
        policy: input.policy,
        communication: input.communication,
        fields: input.fields,
        status: "pending_review",
        createdAt: input.createdAt || now,
        updatedAt: now,
      };
      drafts.push(draft);
      return draft;
    });
  }

  async updateStatus(workspaceId: string, draftId: string, status: PendingSettingsDraft["status"]) {
    return mutateData((data) => {
      ensureCollections(data);
      const draft = data.pendingSettingsDrafts?.find((item) => item.workspaceId === workspaceId && item.id === draftId);
      if (!draft) throw new Error("Pending settings draft not found.");
      draft.status = status;
      draft.updatedAt = timestamp();
      return draft;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 / WP3 (2026-07-28) — Platform ticket + admin repositories (JSON).
// Operator-side records: platform tickets are shared across workspaces.
// ─────────────────────────────────────────────────────────────────────────────

export class JsonPlatformTicketRepository implements PlatformTicketRepository {
  async listForUser(workspaceId: string, filters?: { status?: PlatformTicket["status"]; category?: PlatformTicket["category"] }): Promise<PlatformTicket[]> {
    const all = (await readData()).platformTickets || [];
    return all
      .filter((t) => t.workspaceId === workspaceId)
      .filter((t) => (filters?.status ? t.status === filters.status : true))
      .filter((t) => (filters?.category ? t.category === filters.category : true))
      .sort((a, b) => b.ticketNumber - a.ticketNumber);
  }

  async getForUser(workspaceId: string, ticketId: string): Promise<PlatformTicket | undefined> {
    const all = (await readData()).platformTickets || [];
    return all.find((t) => t.id === ticketId && t.workspaceId === workspaceId);
  }

  async listForOperator(filters?: {
    status?: PlatformTicket["status"];
    category?: PlatformTicket["category"];
    workspaceId?: string;
    includeSpamFlagged?: boolean;
  }): Promise<PlatformTicket[]> {
    const all = (await readData()).platformTickets || [];
    return all
      .filter((t) => (filters?.workspaceId ? t.workspaceId === filters.workspaceId : true))
      .filter((t) => (filters?.status ? t.status === filters.status : true))
      .filter((t) => (filters?.category ? t.category === filters.category : true))
      .filter((t) => (filters?.includeSpamFlagged ? true : !t.isSpamFlagged))
      .sort((a, b) => b.ticketNumber - a.ticketNumber);
  }

  async getForOperator(ticketId: string): Promise<PlatformTicket | undefined> {
    return ((await readData()).platformTickets || []).find((t) => t.id === ticketId);
  }

  /**
   * Atomic create + GLOBAL ticketNumber allocation inside one mutateData lock.
   * Mirrors the proven createWithNextTicketNumber pattern (Cluster D, session 20).
   */
  async createWithNextNumber(input: {
    workspaceId: string;
    raisedByUserId: string;
    subject: string;
    description: string;
    category: PlatformTicket["category"];
    priority: PlatformTicket["priority"];
    slaStartedAt: string;
    slaDueAt: string;
  }): Promise<PlatformTicket> {
    return mutateData((data) => {
      ensureCollections(data);
      const max = (data.platformTickets || []).reduce((acc, t) => Math.max(acc, Number(t.ticketNumber || 0)), 0);
      const now = timestamp();
      const item: PlatformTicket = {
        id: uid("platform_ticket"),
        workspaceId: input.workspaceId,
        raisedByUserId: input.raisedByUserId,
        ticketNumber: max + 1,
        subject: input.subject,
        description: input.description,
        category: input.category,
        status: "open",
        priority: input.priority,
        assignedAdminId: undefined,
        isSpamFlagged: false,
        slaStartedAt: input.slaStartedAt,
        slaDueAt: input.slaDueAt,
        createdAt: now,
        updatedAt: now,
      };
      data.platformTickets?.push(item);
      return item;
    });
  }

  async updateForOperator(ticketId: string, data: Partial<PlatformTicket>): Promise<PlatformTicket> {
    return mutateData((d) => {
      ensureCollections(d);
      const item = (d.platformTickets || []).find((t) => t.id === ticketId);
      if (!item) throw new Error(`Platform ticket ${ticketId} not found`);
      // Whitelist mutable fields (never let a caller change id/workspaceId/
      // ticketNumber/raisedByUserId — those are immutable audit anchors).
      const { id, workspaceId, ticketNumber, raisedByUserId, ...rest } = data;
      void id; void workspaceId; void ticketNumber; void raisedByUserId;
      Object.assign(item, rest, { updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonPlatformTicketEventRepository implements PlatformTicketEventRepository {
  async create(input: {
    ticketId: string;
    workspaceId: string;
    eventType: PlatformTicketEvent["eventType"];
    actorType: PlatformTicketEvent["actorType"];
    actorUserId?: string;
    actorAdminId?: string;
    fromStatus?: PlatformTicketEvent["fromStatus"];
    toStatus?: PlatformTicketEvent["toStatus"];
    note?: string;
  }): Promise<PlatformTicketEvent> {
    return mutateData((data) => {
      ensureCollections(data);
      const item: PlatformTicketEvent = {
        id: uid("platform_ticket_event"),
        ticketId: input.ticketId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        actorAdminId: input.actorAdminId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        note: input.note,
        createdAt: timestamp(),
      };
      data.platformTicketEvents?.push(item);
      return item;
    });
  }

  async listByTicket(ticketId: string): Promise<PlatformTicketEvent[]> {
    const all = (await readData()).platformTicketEvents || [];
    return all.filter((e) => e.ticketId === ticketId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export class JsonPlatformSupportHoursRepository implements PlatformSupportHoursRepository {
  async get(): Promise<PlatformSupportHours> {
    return mutateData((data) => {
      ensureCollections(data);
      let item = (data.platformSupportHours || [])[0];
      if (!item) {
        item = {
          id: "default",
          hoursStart: DEFAULT_BUSINESS_HOURS_START,
          hoursEnd: DEFAULT_BUSINESS_HOURS_END,
          businessDays: [...DEFAULT_BUSINESS_DAYS],
          createdAt: timestamp(),
          updatedAt: timestamp(),
        };
        data.platformSupportHours = [item];
      }
      return item;
    });
  }

  async update(input: Partial<PlatformSupportHours>): Promise<PlatformSupportHours> {
    const current = await this.get();
    return mutateData((data) => {
      ensureCollections(data);
      const item = (data.platformSupportHours || [])[0] || current;
      const { id, createdAt, ...rest } = input;
      void id; void createdAt;
      Object.assign(item, rest, { updatedAt: timestamp() });
      data.platformSupportHours = [item];
      return item;
    });
  }
}

export class JsonPlatformTicketSlaSettingsRepository implements PlatformTicketSlaSettingsRepository {
  async get(): Promise<PlatformTicketSlaSettings> {
    return mutateData((data) => {
      ensureCollections(data);
      let item = (data.platformTicketSlaSettings || [])[0];
      if (!item) {
        item = {
          id: "default",
          // 2026-09-28 (M9): the same working-time defaults as company tickets.
          urgentSlaMinutes: DEFAULT_SLA_MINUTES.urgent, // 4 working hours
          highSlaMinutes: DEFAULT_SLA_MINUTES.high,     // 1 working day
          mediumSlaMinutes: DEFAULT_SLA_MINUTES.medium, // 3 working days
          lowSlaMinutes: DEFAULT_SLA_MINUTES.low,       // 6 working days = 7 calendar days
          clockMode: DEFAULT_CLOCK_MODE,
          createdAt: timestamp(),
          updatedAt: timestamp(),
        };
        data.platformTicketSlaSettings = [item];
      }
      return item;
    });
  }

  async update(input: Partial<PlatformTicketSlaSettings>): Promise<PlatformTicketSlaSettings> {
    const current = await this.get();
    return mutateData((data) => {
      ensureCollections(data);
      const item = (data.platformTicketSlaSettings || [])[0] || current;
      const { id, createdAt, ...rest } = input;
      void id; void createdAt;
      Object.assign(item, rest, { updatedAt: timestamp() });
      data.platformTicketSlaSettings = [item];
      return item;
    });
  }
}

export class JsonPlatformUserBlockRepository implements PlatformUserBlockRepository {
  async get(userId: string): Promise<PlatformUserBlock | undefined> {
    return ((await readData()).platformUserBlocks || []).find((b) => b.userId === userId);
  }

  async isBlocked(userId: string): Promise<boolean> {
    const block = await this.get(userId);
    return Boolean(block?.isBlockedFromSupport);
  }

  async upsert(input: {
    userId: string;
    workspaceId: string;
    isBlockedFromSupport: boolean;
    reason?: string;
    blockedByAdminId: string;
  }): Promise<PlatformUserBlock> {
    return mutateData((data) => {
      ensureCollections(data);
      let item = (data.platformUserBlocks || []).find((b) => b.userId === input.userId);
      if (!item) {
        item = {
          id: uid("platform_user_block"),
          userId: input.userId,
          workspaceId: input.workspaceId,
          isBlockedFromSupport: input.isBlockedFromSupport,
          reason: input.reason,
          blockedByAdminId: input.blockedByAdminId,
          blockedAt: timestamp(),
        };
        data.platformUserBlocks?.push(item);
      } else {
        Object.assign(item, {
          isBlockedFromSupport: input.isBlockedFromSupport,
          reason: input.reason,
          blockedByAdminId: input.blockedByAdminId,
          blockedAt: timestamp(),
        });
      }
      return item;
    });
  }
}

export class JsonPlatformAdminRepository implements PlatformAdminRepository {
  async findByEmail(email: string): Promise<{ admin: PlatformAdmin; credential: PlatformAdminCredential } | null> {
    const data = await readData();
    const e = email.trim().toLowerCase();
    const admin = (data.platformAdmins || []).find((a) => a.email.toLowerCase() === e);
    if (!admin) return null;
    const credential = (data.platformAdminCredentials || []).find((c) => c.adminId === admin.id);
    if (!credential) return null;
    return { admin, credential };
  }

  async findById(adminId: string): Promise<PlatformAdmin | undefined> {
    return ((await readData()).platformAdmins || []).find((a) => a.id === adminId);
  }

  async hasAnyAdmin(): Promise<boolean> {
    return ((await readData()).platformAdmins || []).length > 0;
  }

  async createWithCredential(input: {
    admin: Omit<PlatformAdmin, "createdAt" | "updatedAt">;
    credential: Omit<PlatformAdminCredential, "id" | "createdAt" | "updatedAt">;
  }): Promise<PlatformAdmin> {
    return mutateData((data) => {
      ensureCollections(data);
      const email = input.admin.email.trim().toLowerCase();
      if ((data.platformAdmins || []).some((a) => a.email.toLowerCase() === email)) {
        throw new Error("A platform admin with this email already exists.");
      }
      const now = timestamp();
      const admin: PlatformAdmin = { ...input.admin, email, createdAt: now, updatedAt: now };
      const credential: PlatformAdminCredential = {
        id: uid("platform_admin_cred"),
        ...input.credential,
        email,
        createdAt: now,
        updatedAt: now,
      };
      data.platformAdmins?.push(admin);
      data.platformAdminCredentials?.push(credential);
      return admin;
    });
  }

  async touchLogin(adminId: string): Promise<void> {
    await mutateData((data) => {
      ensureCollections(data);
      const admin = (data.platformAdmins || []).find((a) => a.id === adminId);
      if (admin) {
        admin.lastLoginAt = timestamp();
        admin.updatedAt = timestamp();
      }
      return undefined;
    });
  }

  async listAll(): Promise<PlatformAdmin[]> {
    return (await readData()).platformAdmins || [];
  }

  async updateRole(adminId: string, role: PlatformAdmin["role"]): Promise<PlatformAdmin> {
    return mutateData((data) => {
      ensureCollections(data);
      const admin = (data.platformAdmins || []).find((a) => a.id === adminId);
      if (!admin) throw new Error(`Platform admin ${adminId} not found`);
      admin.role = role;
      admin.updatedAt = timestamp();
      return admin;
    });
  }

  async updateStatus(adminId: string, status: "active" | "suspended"): Promise<PlatformAdmin> {
    return mutateData((data) => {
      ensureCollections(data);
      const admin = (data.platformAdmins || []).find((a) => a.id === adminId);
      if (!admin) throw new Error(`Platform admin ${adminId} not found`);
      admin.status = status;
      admin.updatedAt = timestamp();
      return admin;
    });
  }  async getSessionVersion(adminId: string): Promise<number> {
    const cred = ((await readData()).platformAdminCredentials || []).find((c) => c.adminId === adminId);
    return cred?.sessionVersion ?? 1;
  }

  async bumpSessionVersion(adminId: string): Promise<number> {
    return mutateData((data) => {
      ensureCollections(data);
      const cred = (data.platformAdminCredentials || []).find((c) => c.adminId === adminId);
      if (!cred) return 0;
      cred.sessionVersion = (cred.sessionVersion ?? 1) + 1;
      cred.updatedAt = timestamp();
      return cred.sessionVersion;
    });
  }
}

export class JsonPlatformAuditLogRepository implements PlatformAuditLogRepository {
  async create(input: { adminId: string; action: PlatformAuditLog["action"]; metadata?: Record<string, unknown> }): Promise<PlatformAuditLog> {
    return mutateData((data) => {
      ensureCollections(data);
      const item: PlatformAuditLog = {
        id: uid("platform_audit"),
        adminId: input.adminId,
        action: input.action,
        metadata: input.metadata,
        createdAt: timestamp(),
      };
      data.platformAuditLogs?.push(item);
      return item;
    });
  }

  async list(filters?: { adminId?: string; action?: PlatformAuditLog["action"]; limit?: number }): Promise<PlatformAuditLog[]> {
    const all = ((await readData()).platformAuditLogs || []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const filtered = all
      .filter((l) => (filters?.adminId ? l.adminId === filters.adminId : true))
      .filter((l) => (filters?.action ? l.action === filters.action : true));
    return filters?.limit ? filtered.slice(0, filters.limit) : filtered;
  }
}

// ─── Stage 5 / WP2 (2026-07-28) — operator admin ops repositories ────────────

export class JsonUserRepository implements UserRepository {
  async findById(userId: string) {
    return (await readData()).users.find((u) => u.id === userId);
  }

  async listForWorkspace(workspaceId: string) {
    return (await readData()).users.filter((u) => u.workspaceId === workspaceId);
  }

  async create(input: Partial<User>) {
    return mutateData((data) => {
      const item: User = {
        id: input.id || uid("user"),
        workspaceId: input.workspaceId || defaultWorkspaceId,
        name: input.name || "User",
        email: input.email || "",
        role: input.role || "sales_member",
        emailVerifiedAt: input.emailVerifiedAt,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.users.push(item);
      return item;
    });
  }

  async update(userId: string, patch: Partial<User>) {
    return mutateData((d) => {
      const item = d.users.find((u) => u.id === userId);
      if (!item) throw new Error(`User ${userId} not found`);
      Object.assign(item, patch, { updatedAt: timestamp() });
      return item;
    });
  }
}

export class JsonUserCredentialRepository implements UserCredentialRepository {
  async findByUserId(userId: string) {
    return ((await readData()).userCredentials || []).find((c) => c.userId === userId);
  }

  async updatePasswordAndBumpSession(userId: string, passwordHash: string) {
    return mutateData((d) => {
      d.userCredentials ||= [];
      const item = d.userCredentials.find((c) => c.userId === userId);
      if (!item) throw new Error(`Credential for user ${userId} not found`);
      item.passwordHash = passwordHash;
      item.sessionVersion = (item.sessionVersion || 0) + 1;
      item.updatedAt = timestamp();
      return item;
    });
  }

  async bumpSessionVersion(userId: string): Promise<number> {
    return mutateData((d) => {
      const item = (d.userCredentials || []).find((c) => c.userId === userId);
      if (!item) return 0;
      item.sessionVersion = (item.sessionVersion || 1) + 1;
      item.updatedAt = timestamp();
      return item.sessionVersion;
    });
  }

  async create(input: Partial<UserCredential>) {
    return mutateData((data) => {
      data.userCredentials ||= [];
      const item: UserCredential = {
        id: input.id || uid("cred"),
        userId: input.userId || "",
        workspaceId: input.workspaceId || defaultWorkspaceId,
        email: input.email || "",
        passwordHash: input.passwordHash || "",
        provisional: input.provisional,
        sessionVersion: input.sessionVersion || 1,
        createdAt: input.createdAt || timestamp(),
        updatedAt: timestamp(),
      };
      data.userCredentials.push(item);
      return item;
    });
  }
}

export class JsonFeatureFlagRepository implements FeatureFlagRepository {
  async getByKey(key: string) {
    return ((await readData()).featureFlags || []).find((f) => f.key === key && f.workspaceId === null);
  }

  async upsert(input: { key: string; enabled: boolean; lastToggledByAdminId: string }) {
    return mutateData((d) => {
      d.featureFlags ||= [];
      const existing = d.featureFlags.find((f) => f.key === input.key && f.workspaceId === null);
      if (existing) {
        existing.enabled = input.enabled;
        existing.lastToggledByAdminId = input.lastToggledByAdminId;
        existing.updatedAt = timestamp();
        return existing;
      }
      const item: FeatureFlag = {
        id: uid("flag"),
        key: input.key,
        workspaceId: null,
        enabled: input.enabled,
        lastToggledByAdminId: input.lastToggledByAdminId,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      };
      d.featureFlags.push(item);
      return item;
    });
  }

  async listAll() {
    return ((await readData()).featureFlags || []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class JsonPasswordResetTokenRepository implements PasswordResetTokenRepository {
  async redeem(tokenHash: string, passwordHash: string) {
    return mutateData((data) => {
      const token = (data.passwordResetTokens || []).find((row) => row.tokenHash === tokenHash);
      if (!token || token.consumedAt || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now()) return undefined;
      const credential = (data.userCredentials || []).find((row) => row.userId === token.userId && row.workspaceId === token.workspaceId);
      if (!credential) throw new Error("Password reset credential not found");
      const completedAt = timestamp();
      credential.passwordHash = passwordHash;
      credential.sessionVersion = (credential.sessionVersion || 1) + 1;
      credential.updatedAt = completedAt;
      token.consumedAt = completedAt;
      token.updatedAt = completedAt;
      return { userId: token.userId, workspaceId: token.workspaceId, completedAt };
    });
  }
  async create(input: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    issuedByAdminId: string;
  }) {
    return mutateData((data) => {
      data.passwordResetTokens ||= [];
      const item: PasswordResetToken = {
        id: uid("reset"),
        userId: input.userId,
        workspaceId: input.workspaceId,
        tokenHash: input.tokenHash,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        issuedByAdminId: input.issuedByAdminId,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      };
      data.passwordResetTokens.push(item);
      return item;
    });
  }

  async findLatestForUser(userId: string) {
    const all = ((await readData()).passwordResetTokens || [])
      .filter((t) => t.userId === userId && !t.consumedAt)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return all[0];
  }

  /**
   * Stage 5 re-audit fix (F-P0-4, 2026-07-28). Find a reset token by its
   * SHA-256 hash (the emailed link carries the RAW token; we hash it here to
   * look up the stored row). Mirrors EmailVerificationToken.findByTokenHash.
   */
  async findByTokenHash(tokenHash: string) {
    return ((await readData()).passwordResetTokens || []).find((t) => t.tokenHash === tokenHash);
  }

  async markConsumed(tokenId: string) {
    await mutateData((d) => {
      d.passwordResetTokens ||= [];
      // N-DATA-20 (2026-08-26, S27). This was `const item = ...find(...); if
      // (item) { ... }` — so consuming an id that has no row resolved quietly
      // and reported success while the token stayed live and unconsumed. The
      // Prisma repository issues a bare `update({ where: { id } })` and throws.
      // The two substrates have to agree, and Prisma is the one that is right:
      // a one-shot credential whose "spend" can silently do nothing is a
      // reusable credential. The message deliberately does NOT echo the id — a
      // caller that passed a RAW token here by mistake is exactly the bug this
      // guard exists to catch, and the message must not become the place that
      // logs it. Pinned by
      // scripts/golden/golden-token-consume-unknown-id.ts.
      const item =
        d.passwordResetTokens.find((t) => t.id === tokenId) || notFound("Password reset token not found");
      item.consumedAt = timestamp();
      item.updatedAt = timestamp();
    });
  }
}

export class JsonImpersonationSessionRepository implements ImpersonationSessionRepository {
  async create(input: {
    adminId: string;
    targetUserId: string;
    targetWorkspaceId: string;
    tokenHash: string;
    startedAt: string;
    expiresAt: string;
    reason: string;
  }) {
    return mutateData((data) => {
      data.impersonationSessions ||= [];
      const item: ImpersonationSession = {
        id: uid("imp"),
        adminId: input.adminId,
        targetUserId: input.targetUserId,
        targetWorkspaceId: input.targetWorkspaceId,
        tokenHash: input.tokenHash,
        startedAt: input.startedAt,
        expiresAt: input.expiresAt,
        reason: input.reason,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      };
      data.impersonationSessions.push(item);
      return item;
    });
  }

  async findByTokenHash(tokenHash: string) {
    return ((await readData()).impersonationSessions || []).find((s) => s.tokenHash === tokenHash);
  }

  async findActiveForAdmin(adminId: string) {
    const nowIso = timestamp();
    const all = (await readData()).impersonationSessions || [];
    return all.find((s) =>
      s.adminId === adminId &&
      !s.endedAt &&
      s.expiresAt > nowIso,
    );
  }

  async markEnded(sessionId: string) {
    await mutateData((d) => {
      d.impersonationSessions ||= [];
      // N-DATA-20 (2026-08-26, S27) — see the note on
      // JsonPasswordResetTokenRepository.markConsumed. Same silent no-op, same
      // reason it is wrong: an impersonation session reported as ended while
      // its row still has no endedAt is a support session that is still live.
      const item =
        d.impersonationSessions.find((s) => s.id === sessionId) ||
        notFound("Impersonation session not found");
      item.endedAt = timestamp();
      item.updatedAt = timestamp();
    });
  }
}

// ─── Stage 5 / WP1 (2026-07-28) — signup verification + invites ────────────

export class JsonEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  async verifyAndConsume(tokenHash: string) {
    return mutateData((data) => {
      const token = (data.emailVerificationTokens || []).find((row) => row.tokenHash === tokenHash);
      if (!token || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now()) return undefined;
      const user = data.users.find((row) => row.id === token.userId && row.workspaceId === token.workspaceId);
      if (!user) throw new Error("Verification user not found");
      if (token.consumedAt) return user.emailVerifiedAt;
      const verifiedAt = user.emailVerifiedAt || timestamp();
      user.emailVerifiedAt = verifiedAt;
      user.updatedAt = timestamp();
      token.consumedAt = timestamp();
      token.updatedAt = timestamp();
      return verifiedAt;
    });
  }
  async create(input: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    source: "signup" | "reissue";
  }) {
    return mutateData((data) => {
      data.emailVerificationTokens ||= [];
      const item: EmailVerificationToken = {
        id: uid("evt"),
        userId: input.userId,
        workspaceId: input.workspaceId,
        tokenHash: input.tokenHash,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        source: input.source,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      };
      data.emailVerificationTokens.push(item);
      return item;
    });
  }

  async findLatestForUser(userId: string) {
    const nowIso = timestamp();
    const all = ((await readData()).emailVerificationTokens || [])
      .filter((t) => t.userId === userId && !t.consumedAt && t.expiresAt > nowIso)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return all[0];
  }

  async findByTokenHash(tokenHash: string) {
    return ((await readData()).emailVerificationTokens || []).find((t) => t.tokenHash === tokenHash);
  }

  async markConsumed(tokenId: string) {
    await mutateData((d) => {
      d.emailVerificationTokens ||= [];
      // N-DATA-20 (2026-08-26, S27). This was `const item = ...find(...); if
      // (item) { ... }` — so consuming an id that has no row resolved quietly
      // and reported success while the token stayed live and unconsumed. The
      // Prisma repository issues a bare `update({ where: { id } })` and throws.
      // The two substrates have to agree, and Prisma is the one that is right:
      // a one-shot credential whose "spend" can silently do nothing is a
      // reusable credential. The message deliberately does NOT echo the id — a
      // caller that passed a RAW token here by mistake is exactly the bug this
      // guard exists to catch, and the message must not become the place that
      // logs it. Pinned by
      // scripts/golden/golden-token-consume-unknown-id.ts.
      const item =
        d.emailVerificationTokens.find((t) => t.id === tokenId) || notFound("Email verification token not found");
      item.consumedAt = timestamp();
      item.updatedAt = timestamp();
    });
  }

  async invalidatePriorTokens(userId: string) {
    await mutateData((d) => {
      d.emailVerificationTokens ||= [];
      for (const t of d.emailVerificationTokens) {
        if (t.userId === userId && !t.consumedAt) {
          // Mark consumed so prior links stop working (one-shot semantics).
          t.consumedAt = timestamp();
          t.updatedAt = timestamp();
        }
      }
    });
  }

  async listForUserId(userId: string) {
    return ((await readData()).emailVerificationTokens || [])
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }
}

export class JsonInviteRepository implements InviteRepository {
  async create(input: {
    workspaceId: string;
    email: string;
    role: import("@/lib/types").WorkspaceRole;
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: string;
  }) {
    return mutateData((data) => {
      data.invites ||= [];
      const nowIso = timestamp();
      const item: Invite = {
        id: uid("invite"),
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        status: "pending",
        invitedByUserId: input.invitedByUserId,
        createdAt: nowIso,
        expiresAt: input.expiresAt,
        updatedAt: nowIso,
      };
      data.invites.push(item);
      return item;
    });
  }

  async findById(inviteId: string) {
    return ((await readData()).invites || []).find((i) => i.id === inviteId);
  }

  async findByTokenHash(tokenHash: string) {
    return ((await readData()).invites || []).find((i) => i.tokenHash === tokenHash);
  }

  async findPendingForEmail(workspaceId: string, email: string) {
    return ((await readData()).invites || []).find(
      (i) => i.workspaceId === workspaceId && i.email === email && i.status === "pending",
    );
  }

  async listByWorkspace(workspaceId: string) {
    return ((await readData()).invites || [])
      .filter((i) => i.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markAccepted(inviteId: string, acceptedByUserId: string) {
    await mutateData((d) => {
      d.invites ||= [];
      const item = d.invites.find((i) => i.id === inviteId);
      if (item) {
        item.status = "accepted";
        item.acceptedByUserId = acceptedByUserId;
        item.resolvedAt = timestamp();
        item.updatedAt = timestamp();
      }
    });
  }

  async markRevoked(inviteId: string) {
    await mutateData((d) => {
      d.invites ||= [];
      const item = d.invites.find((i) => i.id === inviteId);
      if (item) {
        item.status = "revoked";
        item.resolvedAt = timestamp();
        item.updatedAt = timestamp();
      }
    });
  }

  /**
   * Stage 5 re-audit fix (F-P2-8, 2026-07-28). Delete all NON-pending
   * (revoked / accepted / expired) invites for (workspaceId, email). Returns
   * the count deleted. Called by createInvite before inserting a new pending
   * invite so the table doesn't accumulate one row per status combo.
   */
  async deleteNonPendingForEmail(workspaceId: string, email: string): Promise<number> {
    let deleted = 0;
    await mutateData((d) => {
      d.invites ||= [];
      const before = d.invites.length;
      d.invites = d.invites.filter(
        (i) => !(i.workspaceId === workspaceId && i.email === email && i.status !== "pending"),
      );
      deleted = before - d.invites.length;
    });
    return deleted;
  }

  /**
   * Stage 5 re-audit fix (F-P0-2, 2026-07-28). Atomically: create the User +
   * UserCredential, activate the invited member row, AND mark the invite
   * accepted — all in ONE mutateData. Pre-fix InviteService.acceptInvite did
   * 4 separate awaits; a throw between them orphaned the user. Pinned by
   * golden:signup-invite-atomicity CASE C.
   */
  async acceptInviteAtomically(input: {
    inviteId: string;
    user: User;
    credential: UserCredential;
    memberEmail: string;
    memberName?: string;
    workspaceId: string;
  }): Promise<User> {
    await mutateData((d) => {
      // F-DATA-3 (2026-08-04): re-check the invite status INSIDE the
      // transaction. acceptInvite pre-checks status==="accepted" at the top,
      // but two concurrent accept requests both pass that pre-check (both see
      // "pending"), then both run this block → two user rows + two credential
      // rows for the same email. The signup path (createWorkspaceWithOwner,
      // F-P1-8 fix) does the same in-transaction re-check; the accept path was
      // asymmetric. JSON has no DB unique constraint so duplicates land
      // silently. Throw here → the caller's catch maps to a 409 conflict.
      d.invites ||= [];
      const cur = d.invites.find((i) => i.id === input.inviteId);
      if (cur && cur.status === "accepted") {
        throw new Error("Invite has already been accepted.");
      }
      // Write 1: User.
      d.users.push(input.user);
      // Write 2: UserCredential.
      d.userCredentials ||= [];
      d.userCredentials.push(input.credential);
      // Write 3: promote the invited member row → active.
      d.workspaceMembers ||= [];
      const member = d.workspaceMembers.find(
        (m) => m.workspaceId === input.workspaceId && m.email === input.memberEmail && m.status === "invited",
      );
      if (member) {
        member.userId = input.user.id;
        member.name = input.memberName ?? member.name;
        member.status = "active";
        member.updatedAt = timestamp();
      }
      // Write 4: mark the invite accepted.
      const invite = d.invites.find((i) => i.id === input.inviteId);
      if (invite) {
        invite.status = "accepted";
        invite.acceptedByUserId = input.user.id;
        invite.resolvedAt = timestamp();
        invite.updatedAt = timestamp();
      }
      return input.user;
    });
    return input.user;
  }

  async backdateForTesting(inviteId: string, createdAt: string) {
    await mutateData((d) => {
      d.invites ||= [];
      const item = d.invites.find((i) => i.id === inviteId);
      if (item) {
        const createdMs = Date.parse(createdAt);
        // Keep the 7-day TTL — shift expiresAt by the same amount.
        const expiresMs = createdMs + 7 * 24 * 60 * 60 * 1000;
        item.createdAt = createdAt;
        item.expiresAt = new Date(expiresMs).toISOString();
        item.updatedAt = timestamp();
      }
    });
  }
}

// ─── Owner Copilot (2026-08-01) — owner-facing assistant chat ───────────────
export class JsonFollowUpRepository implements FollowUpRepository {
  async create(workspaceId: string, input: Partial<FollowUp> & { leadId: string; note: string }) {
    return mutateData((data) => {
      data.followUps ||= [];
      const nowIso = timestamp();
      const item: FollowUp = {
        id: input.id || uid("followup"),
        workspaceId,
        leadId: input.leadId,
        dueOn: input.dueOn,
        note: input.note,
        source: input.source || "owner",
        evidence: input.evidence,
        status: input.status || "open",
        kind: input.kind,
        cycleKey: input.cycleKey,
        createdBy: input.createdBy,
        doneAt: input.doneAt,
        createdAt: input.createdAt || nowIso,
        updatedAt: nowIso,
      };
      data.followUps.push(item);
      return item;
    });
  }
  async getById(workspaceId: string, id: string) {
    return ((await readData()).followUps || []).find((f) => f.workspaceId === workspaceId && f.id === id);
  }
  async listByWorkspace(workspaceId: string, filters: { status?: FollowUp["status"]; leadId?: string } = {}) {
    return ((await readData()).followUps || []).filter((f) => f.workspaceId === workspaceId
      && (!filters.status || f.status === filters.status)
      && (!filters.leadId || f.leadId === filters.leadId));
  }
  async update(workspaceId: string, id: string, data: Partial<FollowUp>) {
    return mutateData((all) => {
      const item = (all.followUps || []).find((f) => f.workspaceId === workspaceId && f.id === id);
      if (!item) throw new NeedsActionError("That reminder no longer exists.", 404);
      assignUpdate(item, data, { workspaceId, updatedAt: timestamp() });
      return item;
    });
  }
  async deleteByLead(workspaceId: string, leadId: string) {
    return mutateData((all) => {
      const before = (all.followUps || []).length;
      all.followUps = (all.followUps || []).filter((f) => !(f.workspaceId === workspaceId && f.leadId === leadId));
      return before - all.followUps.length;
    });
  }
}

/** 2026-09-28 — outcome signals. Idempotent on (workspace, kind, sourceId) inside one mutation. */
export class JsonOutcomeSignalRepository implements OutcomeSignalRepository {
  async create(workspaceId: string, input: Omit<OutcomeSignal, "id" | "workspaceId" | "createdAt"> & { id?: string }) {
    return mutateData((data) => {
      data.outcomeSignals ||= [];
      if (input.sourceId) {
        const existing = data.outcomeSignals.find((s) => s.workspaceId === workspaceId && s.kind === input.kind && s.sourceId === input.sourceId);
        if (existing) return existing;
      }
      const item: OutcomeSignal = {
        id: input.id || uid("outcome"),
        workspaceId,
        leadId: input.leadId,
        kind: input.kind,
        at: input.at,
        value: input.value,
        relatedReplyIds: input.relatedReplyIds,
        sourceId: input.sourceId,
        createdAt: timestamp(),
      };
      data.outcomeSignals.push(item);
      return item;
    });
  }
  async listByWorkspace(workspaceId: string, filters: { leadId?: string; kind?: OutcomeSignal["kind"]; since?: string } = {}) {
    return ((await readData()).outcomeSignals || []).filter((s) => s.workspaceId === workspaceId
      && (!filters.leadId || s.leadId === filters.leadId)
      && (!filters.kind || s.kind === filters.kind)
      && (!filters.since || s.at >= filters.since));
  }
  async deleteByLead(workspaceId: string, leadId: string) {
    return mutateData((all) => {
      const before = (all.outcomeSignals || []).length;
      all.outcomeSignals = (all.outcomeSignals || []).filter((s) => !(s.workspaceId === workspaceId && s.leadId === leadId));
      return before - all.outcomeSignals.length;
    });
  }
}

export class JsonOwnerCopilotConversationRepository implements OwnerCopilotConversationRepository {
  async create(input: Partial<OwnerCopilotConversation> & { workspaceId: string; ownerUserId: string }) {
    return mutateData((data) => {
      data.ownerCopilotConversations ||= [];
      const nowIso = timestamp();
      const item: OwnerCopilotConversation = {
        id: input.id || uid("copilot"),
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        activeLeadId: input.activeLeadId,
        clarifyBatchCount: input.clarifyBatchCount ?? 0,
        createdAt: input.createdAt || nowIso,
        updatedAt: nowIso,
      };
      data.ownerCopilotConversations.push(item);
      return item;
    });
  }
  async getById(workspaceId: string, id: string) {
    return ((await readData()).ownerCopilotConversations || []).find((c) => c.workspaceId === workspaceId && c.id === id);
  }
  async getActiveForOwner(workspaceId: string, ownerUserId: string) {
    const list = ((await readData()).ownerCopilotConversations || []).filter((c) => c.workspaceId === workspaceId && c.ownerUserId === ownerUserId);
    // Most recent by updatedAt.
    return list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  }
  async listForOwner(workspaceId: string, ownerUserId: string, limit = 30) {
    return ((await readData()).ownerCopilotConversations || [])
      .filter((c) => c.workspaceId === workspaceId && c.ownerUserId === ownerUserId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
  }
  async update(workspaceId: string, id: string, data: Partial<OwnerCopilotConversation>) {
    return mutateData((d) => {
      const list = d.ownerCopilotConversations || [];
      const item = list.find((c) => c.workspaceId === workspaceId && c.id === id);
      if (!item) throw new Error(`OwnerCopilotConversation ${id} not found in workspace ${workspaceId}.`);
      Object.assign(item, data, { updatedAt: timestamp() });
      return item;
    });
  }

  /** 2026-09-28 (S5) — erasure. */
  async clearActiveLead(workspaceId: string, leadId: string) {
    return mutateData((d) => {
      let changed = 0;
      for (const c of d.ownerCopilotConversations || []) {
        if (c.workspaceId === workspaceId && c.activeLeadId === leadId) {
          c.activeLeadId = undefined;
          changed += 1;
        }
      }
      return changed;
    });
  }
}

export class JsonOwnerCopilotMessageRepository implements OwnerCopilotMessageRepository {
  async claimConfirmation(input: Parameters<OwnerCopilotMessageRepository["claimConfirmation"]>[0]) {
    return mutateData(data => {
      const conversation = (data.ownerCopilotConversations || []).find(row => row.id === input.conversationId && row.workspaceId === input.workspaceId && row.ownerUserId === input.ownerUserId);
      const messages = (data.ownerCopilotMessages || []).filter(row => row.workspaceId === input.workspaceId && row.conversationId === input.conversationId);
      const proposal = messages.find(row => row.id === input.proposalMessageId && row.role === "copilot" && row.kind === "copilot_confirm" && row.tier === "T3" && row.pendingAction?.entityId === input.pendingActionId && row.pendingAction.intent === input.intent);
      if (!conversation || !proposal || messages.some(row => row.role === "owner" && row.pendingAction?.entityId === input.pendingActionId)) return false;
      data.ownerCopilotMessages ||= [];
      data.ownerCopilotMessages.push({ id: uid("cpmsg"), workspaceId: input.workspaceId, conversationId: input.conversationId, role: "owner", kind: "owner_input", text: input.text, language: input.language, tier: "T3", pendingAction: proposal.pendingAction, createdAt: timestamp() });
      return true;
    });
  }
  async create(input: Partial<OwnerCopilotMessage> & { workspaceId: string; conversationId: string; role: OwnerCopilotMessage["role"]; kind: OwnerCopilotMessage["kind"]; text: string }) {
    return mutateData((data) => {
      data.ownerCopilotMessages ||= [];
      const item: OwnerCopilotMessage = {
        id: input.id || uid("cpmsg"),
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        role: input.role,
        kind: input.kind,
        text: input.text,
        language: input.language || "unknown",
        tier: input.tier,
        pendingAction: input.pendingAction,
        createdAt: input.createdAt || timestamp(),
      };
      data.ownerCopilotMessages.push(item);
      return item;
    });
  }
  async listByConversation(workspaceId: string, conversationId: string) {
    return ((await readData()).ownerCopilotMessages || [])
      .filter((m) => m.workspaceId === workspaceId && m.conversationId === conversationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}

export function createJsonRepositories() {
  return {
    // Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth.
    platformTicket: new JsonPlatformTicketRepository(),
    platformTicketEvent: new JsonPlatformTicketEventRepository(),
    platformSupportHours: new JsonPlatformSupportHoursRepository(),
    platformTicketSlaSettings: new JsonPlatformTicketSlaSettingsRepository(),
    platformUserBlock: new JsonPlatformUserBlockRepository(),
    platformAdmin: new JsonPlatformAdminRepository(),
    platformAuditLog: new JsonPlatformAuditLogRepository(),
    // Stage 5 / WP2 (2026-07-28) — operator admin ops.
    user: new JsonUserRepository(),
    userCredential: new JsonUserCredentialRepository(),
    featureFlag: new JsonFeatureFlagRepository(),
    passwordResetToken: new JsonPasswordResetTokenRepository(),
    impersonationSession: new JsonImpersonationSessionRepository(),
    // Stage 5 / WP1 (2026-07-28) — signup verification + invites.
    emailVerificationToken: new JsonEmailVerificationTokenRepository(),
    invite: new JsonInviteRepository(),
    // Owner Copilot (2026-08-01) — owner-facing assistant chat.
    ownerCopilotConversation: new JsonOwnerCopilotConversationRepository(),
    ownerCopilotMessage: new JsonOwnerCopilotMessageRepository(),
    followUp: new JsonFollowUpRepository(),
    outcomeSignal: new JsonOutcomeSignalRepository(),

    workspace: new JsonWorkspaceRepository(),
    businessProfile: new JsonBusinessProfileRepository(),
    icp: new JsonICPRepository(),
    campaign: new JsonCampaignRepository(),
    lead: new JsonLeadRepository(),
    messageTemplate: new JsonMessageTemplateRepository(),
    outreachActivity: new JsonOutreachActivityRepository(),
    reply: new JsonReplyRepository(),
    agentRun: new JsonAgentRunRepository(),
    auditLog: new JsonAuditLogRepository(),
    integration: new JsonIntegrationRepository(),
    websiteCrawlJob: new JsonWebsiteCrawlJobRepository(),
    websiteCrawlConsent: new JsonWebsiteCrawlConsentRepository(),
    websiteCrawlPage: new JsonWebsiteCrawlPageRepository(),
    businessExtraction: new JsonBusinessExtractionRepository(),
    campaignLearning: new JsonCampaignLearningRepository(),
    campaignMetric: new JsonCampaignMetricRepository(),
    eventLog: new JsonEventLogRepository(),
    jobRun: new JsonJobRunRepository(),
    agentBehaviorPolicy: new JsonAgentBehaviorPolicyRepository(),
    companyCommunicationSettings: new JsonCompanyCommunicationSettingsRepository(),
    conversationPolicy: new JsonConversationPolicyRepository(),
    whatsAppAgentSettings: new JsonWhatsAppAgentSettingsRepository(),
    escalationRule: new JsonEscalationRuleRepository(),
    unknownQuestion: new JsonUnknownQuestionRepository(),
    // Stage 2 (2026-07-20) — tickets.
    ticket: new JsonTicketRepository(),
    ticketEvent: new JsonTicketEventRepository(),
    ticketSlaSettings: new JsonTicketSlaSettingsRepository(),
    // Stage 3 (2026-07-21 / M7) — orders + quotes.
    order: new JsonOrderRepository(),
    quote: new JsonQuoteRepository(),
    autoReplyLog: new JsonAutoReplyLogRepository(),
    doNotContact: new JsonDoNotContactRepository(),
    mediaCatalog: new JsonMediaCatalogRepository(),
    whatsAppTemplate: new JsonWhatsAppTemplateRepository(),
    knowledgeBaseDocument: new JsonKnowledgeBaseDocumentRepository(),
    knowledgeBaseChunk: new JsonKnowledgeBaseChunkRepository(),
    knowledgeBaseQueryLog: new JsonKnowledgeBaseQueryLogRepository(),
    llmProviderCredential: new JsonLLMProviderCredentialRepository(),
    llmModelRouting: new JsonLLMModelRoutingRepository(),
    aiUsageLimit: new JsonAIUsageLimitRepository(),
    productKnowledge: new JsonProductKnowledgeRepository(),
    productVariety: new JsonProductVarietyRepository(),
    productApplication: new JsonProductApplicationRepository(),
    buyerSegment: new JsonBuyerSegmentRepository(),
    productApplicationMarketMap: new JsonProductApplicationMarketMapRepository(),
    leadReviewSettings: new JsonLeadReviewSettingsRepository(),
    leadReviewDecision: new JsonLeadReviewDecisionRepository(),
    agentAutonomousSettings: new JsonAgentAutonomousSettingsRepository(),
    providerAccount: new JsonProviderAccountRepository(),
    salesSettings: new JsonSalesSettingsRepository(),
    productSettings: new JsonProductSettingsRepository(),
    policySettings: new JsonPolicySettingsRepository(),
    communicationSettings: new JsonCommunicationSettingsRepository(),
    settingsConflict: new JsonSettingsConflictRepository(),
    pendingSettingsDraft: new JsonPendingSettingsDraftRepository(),
    // Phase 4C: readAll returns the full AppData snapshot; mutateAll delegates
    // to the existing serialized mutateData queue so multi-collection writes
    // stay atomic. This is what unblocks the 6 split-brain services from
    // importing mutateData/readData directly — they now go through the bundle.
    readAll: async () => readData(),
    mutateAll: async <T>(mutator: (data: AppData) => Promise<T> | T) => mutateData(mutator),
    // Session 55 (2026-09-09). Empty a workspace's contents. On this substrate
    // the snapshot IS the database, so dropping the rows from the arrays is the
    // delete. See the Prisma implementation for why this could not stay a
    // mutateAll call shared by both substrates.
    withTransaction: async <T>(work: () => Promise<T>) => withSnapshotSession(async () => {
      // Acquire the file lock before reads as well as writes in this unit.
      await mutateData(() => undefined);
      return work();
    }),
    withWorkspaceTeamTransaction: async <T>(_workspaceId: string, work: () => Promise<T>) => withSnapshotSession(async () => {
      await mutateData(() => undefined);
      return work();
    }),
    withLeadMemoryTransaction: async <T>(_workspaceId: string, _leadId: string, work: () => Promise<T>) => withSnapshotSession(async () => {
      await mutateData(() => undefined);
      return work();
    }),
    clearWorkspaceCollections: async (workspaceId: string, collections: readonly string[]) =>
      mutateData((data) => clearWorkspaceCollectionsInSnapshot(data, workspaceId, collections)),
    // N-BUG-4 (2026-09-05). Keep the most recent `keep` dedup entries, drop the
    // rest. Newest is decided by processedAt, not by array order, so the two
    // substrates agree on WHICH rows survive and not merely how many.
    trimProcessedWebhookMessages: async (keep: number) => mutateData((data) => {
      const all = data.processedWebhookMessageIds || [];
      if (all.length <= keep) return 0;
      // Ties on processedAt are real — several messages can land in the same
      // millisecond — so insertion order breaks them, which is exactly what the
      // `slice(-keep)` this replaced did.
      const order = new Map(all.map((item, index) => [item.id, index]));
      const survivors = [...all]
        .sort((a, b) => String(b.processedAt).localeCompare(String(a.processedAt)) || (order.get(b.id)! - order.get(a.id)!))
        .slice(0, keep);
      const surviving = new Set(survivors.map((item) => item.id));
      data.processedWebhookMessageIds = all.filter((item) => surviving.has(item.id));
      return all.length - data.processedWebhookMessageIds.length;
    }),
    hasProcessedWebhookMessage: async (workspaceId: string, providerMessageId: string) =>
      ((await readData()).processedWebhookMessageIds || []).some(
        (item) => item.workspaceId === workspaceId && item.providerMessageId === providerMessageId,
      ),
    // 2026-09-28 (S5) — erasure: forget the sender phone, keep the message id.
    scrubProcessedWebhookPhones: async (workspaceId: string, phones: string[]) => mutateData((data) => {
      let scrubbed = 0;
      for (const row of data.processedWebhookMessageIds || []) {
        if (row.workspaceId !== workspaceId || !row.fromPhone) continue;
        if (phones.some((phone) => samePhoneForOptOut(row.fromPhone, phone))) {
          row.fromPhone = undefined;
          scrubbed += 1;
        }
      }
      return scrubbed;
    }),
    recordProcessedWebhookMessage: async (record: ProcessedWebhookMessageInput) => mutateData((data) => {
      const all = (data.processedWebhookMessageIds ||= []);
      if (all.some((item) => item.workspaceId === record.workspaceId && item.providerMessageId === record.providerMessageId)) {
        return { inserted: false, total: all.length };
      }
      all.push({ id: uid("whmsg"), ...record, outcome: record.outcome as (typeof all)[number]["outcome"] });
      return { inserted: true, total: all.length };
    }),
    // Stage A.2 (2026-07-26) — auth + workspaceMember repositories. These
    // wrap exactly the readData/mutateData calls auth-service used to make
    // directly; same JSON file, same atomicity, just routed through the
    // bundle so Prisma mode picks up the Prisma impl instead.
    auth: new JsonAuthRepository(),
    workspaceMember: new JsonWorkspaceMemberRepository(),
  };
}

/**
 * Stage A.2 (2026-07-26) — JSON AuthRepository.
 *
 * Pure refactor of auth-service.ts's old direct readData/mutateData calls.
 * The behaviour is identical: same JSON file, same atomic mutateData write
 * for createOwnerWithCredential (the bootstrapOwner transaction). auth-service
 * now imports this through the bundle instead of touching db.ts directly.
 */
export class JsonAuthRepository implements AuthRepository {
  async findUserById(workspaceId: string, userId: string): Promise<User | undefined> {
    const data = await readData();
    return data.users.find((u) => u.id === userId && u.workspaceId === workspaceId);
  }
  async listUsers(): Promise<User[]> {
    const data = await readData();
    return data.users;
  }
  async findCredentialByEmail(workspaceId: string, email: string): Promise<{ user: User; credential: UserCredential } | null> {
    const data = await readData();
    const lower = email.trim().toLowerCase();
    const credential = (data.userCredentials || []).find((c) => c.email.toLowerCase() === lower && c.workspaceId === workspaceId);
    if (!credential) return null;
    const user = data.users.find((u) => u.id === credential.userId && u.workspaceId === workspaceId);
    if (!user) return null;
    return { user, credential };
  }
  async hasAnyCredentials(): Promise<boolean> {
    const data = await readData();
    return (data.userCredentials || []).length > 0;
  }
  async findCredentialsByEmail(email: string): Promise<Array<{ user: User; credential: UserCredential }>> {
    const data = await readData();
    const lower = email.trim().toLowerCase();
    const out: Array<{ user: User; credential: UserCredential }> = [];
    for (const credential of data.userCredentials || []) {
      if ((credential.email || "").toLowerCase() !== lower) continue;
      const user = data.users.find((u) => u.id === credential.userId && u.workspaceId === credential.workspaceId);
      if (user) out.push({ user, credential });
    }
    return out;
  }
  async createOwnerWithCredential(input: { workspaceId: string; user: User; credential: UserCredential; member: WorkspaceMember }): Promise<User> {
    // Atomic: all three rows land in one mutateData, or none do. Mirrors the
    // old bootstrapOwner transaction exactly.
    await mutateData((data) => {
      // 2026-09-28 (S2): the first owner now gets their OWN company by
      // default, which may not exist yet (the Prisma impl upserts it too).
      if (!data.workspaces.some((ws) => ws.id === input.workspaceId)) {
        const now = timestamp();
        data.workspaces.push({ id: input.workspaceId, name: "My company", ownerUserId: input.user.id, status: "active", autonomyKillSwitch: true, autoSendToggle: false, createdAt: now, updatedAt: now } as Workspace);
      }
      data.users.push(input.user);
      data.userCredentials ||= [];
      data.userCredentials.push(input.credential);
      data.workspaceMembers ||= [];
      if (!data.workspaceMembers.some((m) => m.userId === input.user.id)) {
        data.workspaceMembers.push(input.member);
      }
      return input.user;
    });
    return input.user;
  }
  /**
   * Stage 5 re-audit fix (F-P0-1, F-P1-11, 2026-07-28). Atomically create the
   * workspace AND its owner bundle in ONE mutateData. Pre-fix SignupService did
   * `await workspace.create()` THEN `await auth.createOwnerWithCredential()` —
   * two separate file-locked writes; a throw between them orphaned the workspace.
   * This method does all 4 writes in one transaction (read + mutate + write
   * inside one lock, or rollback on throw).
   */
  async createWorkspaceWithOwner(input: {
    workspace: Workspace;
    user: User;
    credential: UserCredential;
    member: WorkspaceMember;
  }): Promise<{ workspace: Workspace; user: User }> {
    await mutateData((data) => {
      // Stage 5 re-audit fix (F-P1-8, 2026-07-28): re-check GLOBAL email
      // uniqueness INSIDE the atomic write. Pre-fix, SignupService did a
      // check-then-act (loop over workspaces + findCredentialByEmail) with
      // NO transaction wrapping check+create — two concurrent signups with
      // the same email both passed the loop and both created workspaces.
      // The mutateData lock makes THIS check-then-act atomic: the collision
      // check + the push happen under ONE lock, so the second writer is
      // rejected. (A DB-level @@unique([email]) was rejected because it would
      // break CASE M — same email across workspaces via invite-accept is
      // allowed. See golden:stage5-batch4-chokepoints CASE 14 for the decision.)
      data.userCredentials ||= [];
      const lowerEmail = input.credential.email.trim().toLowerCase();
      const collision = data.userCredentials.some(
        (c) => (c.email || "").trim().toLowerCase() === lowerEmail,
      );
      if (collision) {
        throw new Error("An account with this email already exists.");
      }

      data.workspaces.push(input.workspace);
      data.users.push(input.user);
      data.userCredentials.push(input.credential);
      data.workspaceMembers ||= [];
      if (!data.workspaceMembers.some((m) => m.userId === input.user.id)) {
        data.workspaceMembers.push(input.member);
      }
      return input.workspace;
    });
    return { workspace: input.workspace, user: input.user };
  }
}

/**
 * Stage A.2 (2026-07-26) — JSON WorkspaceMemberRepository.
 * CRUD surface for membership. listActiveByWorkspace mirrors the existing
 * WorkspaceRepository.listActiveStaffForWorkspace (kept there for back-compat).
 */
export class JsonWorkspaceMemberRepository implements WorkspaceMemberRepository {
  async listByWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
    const data = await readData();
    return (data.workspaceMembers || []).filter((m) => m.workspaceId === workspaceId);
  }
  async listActiveByWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
    const data = await readData();
    return (data.workspaceMembers || []).filter((m) => m.workspaceId === workspaceId && m.status === "active");
  }
  async create(input: WorkspaceMember): Promise<WorkspaceMember> {
    await mutateData((data) => {
      data.workspaceMembers ||= [];
      if (!data.workspaceMembers.some((m) => m.id === input.id)) {
        data.workspaceMembers.push(input);
      }
      return input;
    });
    return input;
  }
  async deleteInvitedByEmail(workspaceId: string, email: string): Promise<void> {
    await mutateData((data) => {
      data.workspaceMembers ||= [];
      // Only remove rows that are "invited" (never touch active members).
      data.workspaceMembers = data.workspaceMembers.filter(
        (m) => !(m.workspaceId === workspaceId && m.email === email && m.status === "invited"),
      );
    });
  }
  async activateInvitedByEmail(workspaceId: string, email: string, userId: string, name?: string): Promise<void> {
    await mutateData((data) => {
      data.workspaceMembers ||= [];
      const member = data.workspaceMembers.find(
        (m) => m.workspaceId === workspaceId && m.email === email && m.status === "invited",
      );
      if (member) {
        member.userId = userId;
        member.name = name ?? member.name;
        member.status = "active";
        member.updatedAt = timestamp();
      }
    });
  }  async findForUser(workspaceId: string, userId: string): Promise<WorkspaceMember | undefined> {
    const data = await readData();
    return (data.workspaceMembers || []).find((m) => m.workspaceId === workspaceId && m.userId === userId);
  }
  async update(workspaceId: string, memberId: string, patch: Partial<Pick<WorkspaceMember, "role" | "status" | "name" | "userId">>): Promise<WorkspaceMember> {
    return mutateData((data) => {
      const member = (data.workspaceMembers || []).find((m) => m.workspaceId === workspaceId && m.id === memberId);
      if (!member) throw new Error(`Member ${memberId} not found`);
      Object.assign(member, patch, { updatedAt: timestamp() });
      return member;
    });
  }
}

function normalizeProfile(input: Partial<BusinessProfile>): BusinessProfile {
  return {
    id: input.id || uid("profile"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    companyName: input.companyName,
    websiteUrl: input.websiteUrl,
    industry: input.industry,
    businessType: input.businessType,
    description: input.description,
    products: input.products || [],
    services: input.services || [],
    productCategories: input.productCategories || [],
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    whatsappNumber: input.whatsappNumber,
    address: input.address,
    city: input.city,
    state: input.state,
    country: input.country,
    targetGeographies: input.targetGeographies || [],
    currentCustomerTypes: input.currentCustomerTypes || [],
    desiredCustomerTypes: input.desiredCustomerTypes || [],
    strengths: input.strengths || [],
    limitations: input.limitations || [],
    certifications: input.certifications || [],
    socialLinks: input.socialLinks || [],
    catalogueLinks: input.catalogueLinks || [],
    proofAssets: input.proofAssets || [],
    languagePreference: input.languagePreference || "English",
    tonePreference: input.tonePreference || "Warm, concise, businesslike",
    status: input.status || "draft",
    fields: input.fields || [],
    // N13: the owner's checklist choice; must survive create as well as update.
    checklistKinds: input.checklistKinds || [],
    checklistExports: Boolean(input.checklistExports),
    ...(input.checklistConfirmedAt ? { checklistConfirmedAt: input.checklistConfirmedAt } : {}),
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeICP(input: Partial<ICP>): ICP {
  return {
    id: input.id || uid("icp"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    businessProfileId: input.businessProfileId || "",
    name: input.name || "Suggested ICP",
    description: input.description || "",
    buyerType: input.buyerType || "",
    industries: input.industries || [],
    geography: input.geography || [],
    companySizeBucket: input.companySizeBucket || "unknown",
    likelyNeeds: input.likelyNeeds || [],
    buyingTriggers: input.buyingTriggers || [],
    painPoints: input.painPoints || [],
    preferredChannels: input.preferredChannels || [],
    messagingAngles: input.messagingAngles || [],
    qualificationRules: input.qualificationRules || [],
    // 2026-09-25: dropped on create until now (Postgres kept it), so an ICP
    // created WITH "not for" rules — a restored backup, for one — lost them.
    ...(input.exclusions ? { exclusions: input.exclusions } : {}),
    confidenceScore: input.confidenceScore || 0,
    status: input.status || "suggested",
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeCampaign(input: Partial<Campaign>): Campaign {
  return {
    id: input.id || uid("campaign"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    businessProfileId: input.businessProfileId || "",
    icpId: input.icpId || "",
    name: input.name || "Campaign",
    goal: input.goal || "",
    targetRegion: input.targetRegion || [],
    productFocus: input.productFocus || [],
    offer: input.offer || "",
    selectedChannels: input.selectedChannels || [],
    dailyOutreachLimit: input.dailyOutreachLimit || 20,
    leadGoal: input.leadGoal || 50,
    status: input.status || "draft",
    approvalStatus: input.approvalStatus || "needs_review",
    plan: input.plan || { icpSummary: "", prospectSources: [], searchQueries: [], messageStrategy: "", outreachSequence: [], qualificationCriteria: [], expectedLeadStatuses: [], manualExecutionSteps: [] },
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeLead(input: Partial<Lead>): Lead {
  return {
    id: input.id || uid("lead"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    campaignId: input.campaignId,
    icpId: input.icpId,
    companyName: input.companyName,
    contactName: input.contactName,
    contactRole: input.contactRole,
    websiteUrl: input.websiteUrl,
    source: input.source,
    sourceUrl: input.sourceUrl,
    linkedinUrl: input.linkedinUrl,
    instagramUrl: input.instagramUrl,
    facebookUrl: input.facebookUrl,
    email: input.email,
    phone: input.phone,
    whatsappNumber: input.whatsappNumber,
    country: input.country,
    state: input.state,
    city: input.city,
    address: input.address,
    buyerType: input.buyerType,
    industry: input.industry,
    companySizeBucket: input.companySizeBucket || "unknown",
    fitReason: input.fitReason,
    personalizationNote: input.personalizationNote,
    // N4 (2026-09-18). Caught by golden-lead-create-field-fidelity, which
    // exists precisely because Postgres spreads whatever it is given while this
    // function names every field: a field added to one substrate and forgotten
    // here is data that silently survives on production and vanishes in demo
    // mode — a difference nobody notices until the demo is the thing being shown.
    conversationMemory: input.conversationMemory,
    conversationMemorySource: input.conversationMemorySource,
    conversationMemoryAt: input.conversationMemoryAt,
    // N11 (2026-09-19) — same parity trap as the three above.
    discoveryState: input.discoveryState,
    discoveryExtras: input.discoveryExtras,
    leadScore: input.leadScore || 0,
    fitScore: input.fitScore || 0,
    needScore: input.needScore || 0,
    reachabilityScore: input.reachabilityScore || 0,
    timingScore: input.timingScore || 0,
    confidenceScore: input.confidenceScore || 0,
    qualificationStatus: input.qualificationStatus || "unqualified",
    scoreReason: input.scoreReason || {},
    status: input.status || "needs_review",
    enrichmentStatus: input.enrichmentStatus || "not_started",
    enrichmentResult: input.enrichmentResult,
    reviewStatus: input.reviewStatus || "pending",
    doNotContact: input.doNotContact || false,
    consentStatus: input.consentStatus || "none",
    assignedTo: input.assignedTo,
    lastContactedAt: input.lastContactedAt,
    // N-DATA-7 (2026-08-20): these three were MISSING from this whitelist while
    // the Prisma writer passed them straight through (`leadData()` spreads
    // ...rest, and relevancyReason has its own explicit branch). So the same
    // createLead() call kept them on Postgres and silently dropped them on
    // JSON. It was reachable: ProspectingService builds its lead payload as
    // `{...qualified}`, and `qualified` carries BOTH `relevancyReason` (the AI's
    // reason this lead is worth contacting) and `discoveredInfo` (what the
    // crawler actually found) — so on the JSON substrate every prospected lead
    // lost its evidence the moment it was created. LeadAgentActionPlanService
    // reads `lead.relevancyReason`, and LeadEnrichmentService appends to
    // `lead.discoveredInfo`, so the loss was visible to the operator.
    // Pinned by golden-lead-create-field-fidelity (which also fails if a FUTURE
    // Lead field is added to the type and forgotten here).
    lastInboundAt: input.lastInboundAt,
    discoveredInfo: input.discoveredInfo,
    relevancyReason: input.relevancyReason,
    nextFollowUpAt: input.nextFollowUpAt,
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeMessage(input: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: input.id || uid("message"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    campaignId: input.campaignId || "",
    leadId: input.leadId,
    channel: input.channel || "manual",
    subject: input.subject,
    body: input.body || "",
    tone: input.tone || "",
    language: input.language || "English",
    status: input.status || "draft",
    personalizationUsed: input.personalizationUsed || {},
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeOutreach(input: Partial<OutreachActivity>): OutreachActivity {
  return {
    id: input.id || uid("activity"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId || "",
    channel: input.channel || "manual",
    messageTemplateId: input.messageTemplateId,
    direction: input.direction || "outbound",
    status: input.status || "manual",
    sentManually: input.sentManually ?? true,
    body: input.body || "",
    subject: input.subject,
    mediaAttachmentId: input.mediaAttachmentId,
    mediaAttachmentUrl: input.mediaAttachmentUrl,
    mediaAttachmentName: input.mediaAttachmentName,
    activityAt: input.activityAt || timestamp(),
    createdBy: input.createdBy,
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeReply(input: Partial<Reply>): Reply {
  return {
    id: input.id || uid("reply"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId || "",
    channel: input.channel || "manual",
    rawText: input.rawText || "",
    classification: input.classification,
    confidenceScore: input.confidenceScore,
    summary: input.summary,
    suggestedNextAction: input.suggestedNextAction,
    suggestedResponse: input.suggestedResponse,
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeCrawlJob(input: Partial<WebsiteCrawlJob>): WebsiteCrawlJob {
  return {
    id: input.id || uid("crawl"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    websiteUrl: input.websiteUrl || "",
    status: input.status || "pending",
    pagesFound: input.pagesFound || 0,
    pagesCrawled: input.pagesCrawled || 0,
    errorMessage: input.errorMessage,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeCrawlPage(input: Partial<WebsiteCrawlPage>): WebsiteCrawlPage {
  return {
    id: input.id || uid("page"),
    crawlJobId: input.crawlJobId || "",
    workspaceId: input.workspaceId || defaultWorkspaceId,
    url: input.url || "",
    title: input.title,
    cleanedText: input.cleanedText || "",
    metadata: input.metadata || {},
    createdAt: input.createdAt || timestamp(),
  };
}

function normalizeExtraction(input: Partial<BusinessExtraction>): BusinessExtraction {
  return {
    id: input.id || uid("extraction"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    crawlJobId: input.crawlJobId,
    extractedCompanyName: input.extractedCompanyName,
    extractedIndustry: input.extractedIndustry,
    extractedProducts: input.extractedProducts || [],
    extractedServices: input.extractedServices || [],
    extractedContacts: input.extractedContacts || {},
    extractedLocations: input.extractedLocations || [],
    extractedSocials: input.extractedSocials || [],
    extractedStrengths: input.extractedStrengths || [],
    extractedTargetCustomers: input.extractedTargetCustomers || [],
    extractedCertifications: input.extractedCertifications || [],
    extractedCatalogueLinks: input.extractedCatalogueLinks || [],
    confidence: input.confidence || {},
    missingFields: input.missingFields || [],
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function normalizeLearning(input: Partial<CampaignLearning>): CampaignLearning {
  return {
    id: input.id || uid("learning"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    campaignId: input.campaignId || "",
    summary: input.summary || "",
    winningPatterns: input.winningPatterns || [],
    losingPatterns: input.losingPatterns || [],
    recommendedNextSteps: input.recommendedNextSteps || [],
    createdAt: input.createdAt || timestamp(),
    updatedAt: input.updatedAt || timestamp(),
  };
}

function normalizeMetric(input: Partial<CampaignMetric>): CampaignMetric {
  return {
    id: input.id || uid("metric"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    campaignId: input.campaignId || "",
    metricName: input.metricName || "unknown",
    metricValue: Number(input.metricValue || 0),
    calculatedAt: input.calculatedAt || timestamp(),
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}

function keywordScore(query: string, text: string) {
  const queryTerms = tokenize(query);
  const textTerms = new Set(tokenize(text));
  if (!queryTerms.length) return 0;
  const matches = queryTerms.filter((term) => textTerms.has(term)).length;
  return matches / queryTerms.length;
}

function tokenize(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").split(/\s+/).filter((term) => term.length > 2);
}

function normalizeEventLog(input: Partial<EventLog>): EventLog {
  return {
    id: input.id || uid("event"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    eventType: input.eventType || "unknown",
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload || {},
    metadata: input.metadata || {},
    status: input.status || "recorded",
    createdAt: input.createdAt || timestamp(),
  };
}

function normalizeJobRun(input: Partial<JobRun>): JobRun {
  return {
    id: input.id || uid("job"),
    workspaceId: input.workspaceId || defaultWorkspaceId,
    jobType: input.jobType || "unknown",
    status: input.status || "queued",
    payload: input.payload || {},
    result: input.result,
    attempts: input.attempts || 0,
    maxAttempts: input.maxAttempts || 3,
    errorMessage: input.errorMessage,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    createdAt: input.createdAt || timestamp(),
    updatedAt: timestamp(),
  };
}
