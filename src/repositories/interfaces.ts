import type { CustomerNeedles } from "@/lib/customer-traces";
import type {
  AgentRun,
  AgentBehaviorPolicy,
  AIUsageLimit,
  AppData,
  AuditLog,
  AutoReplyLog,
  BusinessProfile,
  BusinessExtraction,
  Campaign,
  CampaignLearning,
  CampaignMetric,
  DoNotContactEntry,
  CompanyCommunicationSettings,
  CommunicationSettings,
  ConversationPolicy,
  EscalationRule,
  EventLog,
  ICP,
  Integration,
  JobRun,
  KnowledgeBaseChunk,
  KnowledgeBaseDocument,
  KnowledgeBaseQueryLog,
  Lead,
  LeadReviewDecision,
  LeadReviewSettings,
  LLMModelRouting,
  LLMProviderCredential,
  MediaCatalogItem,
  WhatsAppTemplate,
  MessageTemplate,
  OutreachActivity,
  PendingSettingsDraft,
  PolicySettings,
  ProductSettings,
  ProviderAccount,
  BuyerSegment,
  ProductApplication,
  ProductApplicationMarketMap,
  ProductKnowledge,
  ProductVariety,
  Reply,
  SalesSettings,
  SettingsConflict,
  Ticket,
  TicketEvent,
  TicketSlaSettings,
  Order,
  Quote,
  UnknownQuestion,
  WebsiteCrawlConsent,
  WebsiteCrawlJob,
  WebsiteCrawlPage,
  WhatsAppAgentSettings,
  Workspace,
  WorkspaceMember,
  AgentAutonomousSettings,
  User,
  UserCredential,
  // Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth.
  PlatformTicket,
  PlatformTicketEvent,
  PlatformSupportHours,
  PlatformTicketSlaSettings,
  PlatformUserBlock,
  PlatformAdmin,
  PlatformAdminCredential,
  PlatformAuditLog,
  PlatformAdminRole,
  // Stage 5 / WP2 (2026-07-28) — operator admin ops.
  FeatureFlag,
  PasswordResetToken,
  ImpersonationSession,
  // Stage 5 / WP1 (2026-07-28) — signup verification + invites.
  EmailVerificationToken,
  Invite,
  WorkspaceRole,
  // Stage 6 / WP6-C (2026-07-30) — multi-number storage per lead.
  LeadPhoneNumber,
  // Owner Copilot (2026-08-01) — owner-facing assistant chat.
  OwnerCopilotConversation,
  FollowUp,
  OutcomeSignal,
  OwnerCopilotMessage,
} from "@/lib/types";

export type ListLeadFilters = {
  campaignId?: string;
  status?: string;
  reviewStatus?: string;
};

export interface WorkspaceRepository {
  getById(id: string): Promise<Workspace | undefined>;
  getDefault(): Promise<Workspace | undefined>;
  create(input: Partial<Workspace>): Promise<Workspace>;
  /** 2026-07-21 (M9) — update workspace fields (kill-switch, toggle, etc). */
  update(id: string, data: Partial<Workspace>): Promise<Workspace>;
  /**
   * N-DATA-2 (2026-08-18) — delete a workspace AND everything under it.
   *
   * WHY THIS EXISTS. Tests and tooling could create a workspace through this
   * interface but never remove one, so `golden-substrate-parity.ts` leaked a
   * `sp-*-prisma-ws` shell into the SHIP database on every run — 15 of them had
   * accumulated by the time this was measured, and nothing reaped them. That
   * was not a missing call in the golden's `cleanup()`; it was a missing
   * capability here.
   *
   * CONTRACT — the two substrates must agree, because the JSON goldens are only
   * transferable to production while `golden-substrate-parity` stays green:
   *   - deleting a workspace removes every row belonging to it;
   *   - deleting a workspace that does not exist is NOT an error — it reports
   *     `deleted: false` and changes nothing, so a `finally` block can call it
   *     unconditionally without masking the real failure with a cleanup error;
   *   - `deletedRows` is BEST-EFFORT and substrate-specific. JSON sweeps the
   *     collections itself so it knows the exact count; Postgres cascades
   *     inside the database and reports 0, because getting a true number there
   *     would mean 68 counting queries for a figure no caller acts on. So
   *     `deletedRows` is a debugging aid, NOT a parity assertion — parity is
   *     proven by checking that the rows are actually gone on both substrates.
   *
   * Postgres gets this from the schema: all 68 `workspace Workspace @relation`
   * declarations carry `onDelete: Cascade`. JSON has no cascade whatsoever and
   * must sweep its collections by `workspaceId` by hand.
   *
   * DESTRUCTIVE. This is the only method on this interface that removes another
   * tenant's data wholesale. It exists for test cleanup and operator tooling.
   */
  delete(id: string): Promise<{ deleted: boolean; deletedRows: number }>;
  /**
   * 2026-07-21 (Cluster A fix, session 16) — list ACTIVE staff userIds for a
   * workspace. Used by TicketService.createTicketFromInbound to feed the
   * assignTicket pure helper (round-robin rotation). Returns members whose
   * status === "active". Order is undefined; assignTicket treats the list
   * positionally starting from roundRobinPointer.
   */
  listActiveStaffForWorkspace(workspaceId: string): Promise<WorkspaceMember[]>;
  /**
   * Stage 5 / WP2 (2026-07-28) — List EVERY workspace (operator console).
   * Cross-tenant by design (the operator sees all tenants). When
   * `includeSuspended` is false, workspaces with `status === "suspended"`
   * are EXCLUDED (the default operator view hides kill-switched tenants).
   * Order: created desc. NOT paginated in WP2 (tenant count is small); a
   * future stage may add pagination if tenant count grows large.
   */
  listAll(includeSuspended?: boolean): Promise<Workspace[]>;
}

export interface BusinessProfileRepository {
  getByWorkspace(workspaceId: string): Promise<BusinessProfile | undefined>;
  create(input: Partial<BusinessProfile>): Promise<BusinessProfile>;
  update(workspaceId: string, profileId: string, data: Partial<BusinessProfile>): Promise<BusinessProfile>;
  approve(workspaceId: string, profileId: string): Promise<BusinessProfile>;
}

export interface ICPRepository {
  createMany(input: Partial<ICP>[]): Promise<ICP[]>;
  replaceForBusinessProfile(workspaceId: string, businessProfileId: string, input: Partial<ICP>[]): Promise<ICP[]>;
  listByWorkspace(workspaceId: string): Promise<ICP[]>;
  getById(workspaceId: string, icpId: string): Promise<ICP | undefined>;
  update(workspaceId: string, icpId: string, data: Partial<ICP>): Promise<ICP>;
  select(workspaceId: string, icpId: string): Promise<ICP>;
  reject(workspaceId: string, icpId: string): Promise<ICP>;
}

export interface CampaignRepository {
  create(input: Partial<Campaign>): Promise<Campaign>;
  getById(workspaceId: string, campaignId: string): Promise<Campaign | undefined>;
  listByWorkspace(workspaceId: string): Promise<Campaign[]>;
  update(workspaceId: string, campaignId: string, data: Partial<Campaign>): Promise<Campaign>;
  approve(workspaceId: string, campaignId: string): Promise<Campaign>;
}

export interface LeadRepository {
  createLead(input: Partial<Lead>): Promise<Lead>;
  getLeadById(workspaceId: string, leadId: string): Promise<Lead | undefined>;
  /**
   * Find a single lead in this workspace by phone number. Matches against BOTH
   * the `whatsappNumber` and `phone` fields, with normalization on both sides
   * (so "+91 98765 43210", "919876543210", "+919876543210" all resolve to the
   * same lead). Workspace-scoped at the repo layer — must NEVER load all leads
   * across tenants (P-1 fix, Session 7 2026-07-28). Returns undefined when no
   * lead matches; never throws on miss (the caller decides whether to create).
   *
   * Pinned by `golden:find-lead-by-phone`.
   */
  findLeadByPhone(workspaceId: string, phone: string): Promise<Lead | undefined>;
  /**
   * Stage 6 / WP6-C (2026-07-30) — 6C-1: store/add a phone/WhatsApp number to a
   * lead's full number list. Idempotent (re-adding the same normalized number
   * does not duplicate). When `isPrimary` is true, the matching lead's flat
   * `phone`/`whatsappNumber` field is also updated (keeps the primary in sync).
   * Workspace-scoped. Pinned by golden:lead-multi-number.
   */
  addLeadPhoneNumber(workspaceId: string, leadId: string, input: { number: string; type: string; isPrimary?: boolean; label?: string }): Promise<LeadPhoneNumber>;
  /** 6C-1: list all numbers for a lead. Workspace-scoped. */
  listLeadPhoneNumbers(workspaceId: string, leadId: string): Promise<LeadPhoneNumber[]>;
  listLeads(workspaceId: string, filters?: ListLeadFilters): Promise<Lead[]>;
  listLeadsByCampaign(workspaceId: string, campaignId: string): Promise<Lead[]>;
  updateLead(workspaceId: string, leadId: string, data: Partial<Lead>): Promise<Lead>;
  approveLead(workspaceId: string, leadId: string): Promise<Lead>;
  rejectLead(workspaceId: string, leadId: string): Promise<Lead>;
  updateLeadStatus(workspaceId: string, leadId: string, status: Lead["status"]): Promise<Lead>;
  updateLeadScore(workspaceId: string, leadId: string, scoreData: Partial<Lead>): Promise<Lead>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete a lead by id. Used ONLY by the
   * DPDPA erasure cascade (docs/LOGIC.md Q18). Throws if the lead is not
   * found. Returns the count of records removed (1 on success).
   */
  deleteById(workspaceId: string, leadId: string): Promise<number>;
}

export interface MessageTemplateRepository {
  create(input: Partial<MessageTemplate>): Promise<MessageTemplate>;
  listByWorkspace(workspaceId: string): Promise<MessageTemplate[]>;
  getById(workspaceId: string, messageId: string): Promise<MessageTemplate | undefined>;
  update(workspaceId: string, messageId: string, data: Partial<MessageTemplate>): Promise<MessageTemplate>;
  /**
   * 2026-09-28 (S5) — erasure: delete every drafted message for a lead.
   * On Postgres the lead foreign key is ON DELETE SET NULL, so these drafts
   * (which quote the customer by name) used to outlive the customer.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface OutreachActivityRepository {
  create(input: Partial<OutreachActivity>): Promise<OutreachActivity>;
  listByLead(workspaceId: string, leadId: string): Promise<OutreachActivity[]>;
  listByWorkspace(workspaceId: string): Promise<OutreachActivity[]>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all outreach activities for a
   * lead. Used ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface ReplyRepository {
  create(input: Partial<Reply>): Promise<Reply>;
  listByWorkspace(workspaceId: string): Promise<Reply[]>;
  /**
   * F-DATA-6 (2026-08-07, real-AI proof-pass docs/OPEN-ISSUES.md): a
   * per-lead lookup so gatherHistoryText (conversation memory) doesn't scan
   * every reply in the workspace on every inbound WhatsApp message.
   */
  listByLead(workspaceId: string, leadId: string): Promise<Reply[]>;
  getById(workspaceId: string, replyId: string): Promise<Reply | undefined>;
  update(workspaceId: string, replyId: string, data: Partial<Reply>): Promise<Reply>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all replies for a lead. Used
   * ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface AgentRunRepository {
  create(input: Partial<AgentRun>): Promise<AgentRun>;
  update(workspaceId: string, agentRunId: string, data: Partial<AgentRun>): Promise<AgentRun>;
  listRecent(workspaceId: string, limit?: number): Promise<AgentRun[]>;
  /**
   * 2026-09-28 (S5) — erasure: delete this workspace's agent runs whose input,
   * output or error mentions the customer (src/lib/customer-traces.ts).
   * Returns how many were removed.
   */
  deleteMentioning(workspaceId: string, needles: CustomerNeedles): Promise<number>;
}

export interface AuditLogRepository {
  create(input: Partial<AuditLog>): Promise<AuditLog>;
  listByWorkspace(workspaceId: string): Promise<AuditLog[]>;
}

export interface IntegrationRepository {
  /**
   * N-DATA-2 (2026-08-18, CEO-loop session 6) — create an integration row.
   *
   * WHY IT DID NOT EXIST. Integration rows only ever appeared two ways: the
   * seeder, which writes the JSON file directly, and `persistSnapshot` — and
   * `integrations` is NOT one of the 15 collections persistSnapshot covers.
   * So on Postgres there was no supported way to make one at all. The JSON
   * store holds 17 and the migration has to move them, which makes this a
   * missing CAPABILITY rather than a missing call — the same shape as the
   * `WorkspaceRepository.delete` gap found in session 4, and it stayed
   * invisible for the same reason: nothing had ever needed it.
   *
   * CONTRACT, and the two places the substrates could have drifted:
   *  - **The caller supplies the id.** A generated id would make the migration
   *    non-idempotent and would break the re-plan check that proves it worked
   *    (every row must come back `identical`, which is keyed on id).
   *  - **One integration per provider per workspace.** Postgres enforces it
   *    (`@@unique([workspaceId, provider])`) and throws. JSON has no
   *    constraints at all, so the JSON implementation enforces it in code —
   *    otherwise the duplicate is accepted on the substrate the tests run on
   *    and rejected on the substrate we ship on, which is the exact failure
   *    mode `golden-substrate-parity` exists to prevent.
   */
  create(workspaceId: string, input: Partial<Integration>): Promise<Integration>;
  listByWorkspace(workspaceId: string): Promise<Integration[]>;
  update(workspaceId: string, integrationId: string, data: Partial<Integration>): Promise<Integration>;
}

export interface WebsiteCrawlJobRepository {
  create(input: Partial<WebsiteCrawlJob>): Promise<WebsiteCrawlJob>;
  getById(workspaceId: string, crawlJobId: string): Promise<WebsiteCrawlJob | undefined>;
  listByWorkspace(workspaceId: string): Promise<WebsiteCrawlJob[]>;
  update(workspaceId: string, crawlJobId: string, data: Partial<WebsiteCrawlJob>): Promise<WebsiteCrawlJob>;
  updateStatus(workspaceId: string, crawlJobId: string, status: WebsiteCrawlJob["status"]): Promise<WebsiteCrawlJob>;
  updateProgress(workspaceId: string, crawlJobId: string, pagesFound: number, pagesCrawled: number): Promise<WebsiteCrawlJob>;
  complete(workspaceId: string, crawlJobId: string, pagesFound: number, pagesCrawled: number): Promise<WebsiteCrawlJob>;
  fail(workspaceId: string, crawlJobId: string, errorMessage: string): Promise<WebsiteCrawlJob>;
}

export interface WebsiteCrawlConsentRepository {
  create(input: Partial<WebsiteCrawlConsent>): Promise<WebsiteCrawlConsent>;
  getLatestForUrl(workspaceId: string, websiteUrl: string): Promise<WebsiteCrawlConsent | undefined>;
}

export interface WebsiteCrawlPageRepository {
  create(input: Partial<WebsiteCrawlPage>): Promise<WebsiteCrawlPage>;
  createMany(input: Partial<WebsiteCrawlPage>[]): Promise<WebsiteCrawlPage[]>;
  listByCrawlJob(workspaceId: string, crawlJobId: string): Promise<WebsiteCrawlPage[]>;
  getById(workspaceId: string, pageId: string): Promise<WebsiteCrawlPage | undefined>;
  deleteByCrawlJob(workspaceId: string, crawlJobId: string): Promise<void>;
}

export interface BusinessExtractionRepository {
  create(input: Partial<BusinessExtraction>): Promise<BusinessExtraction>;
  getByCrawlJob(workspaceId: string, crawlJobId: string): Promise<BusinessExtraction | undefined>;
  listByWorkspace(workspaceId: string): Promise<BusinessExtraction[]>;
  update(workspaceId: string, extractionId: string, data: Partial<BusinessExtraction>): Promise<BusinessExtraction>;
  markReviewed(workspaceId: string, extractionId: string): Promise<BusinessExtraction>;
  markAppliedToProfile(workspaceId: string, extractionId: string, businessProfileId: string): Promise<BusinessExtraction>;
  discard(workspaceId: string, extractionId: string): Promise<BusinessExtraction>;
}

export interface CampaignLearningRepository {
  create(input: Partial<CampaignLearning>): Promise<CampaignLearning>;
  getByCampaign(workspaceId: string, campaignId: string): Promise<CampaignLearning[]>;
  listByWorkspace(workspaceId: string): Promise<CampaignLearning[]>;
  update(workspaceId: string, learningId: string, data: Partial<CampaignLearning>): Promise<CampaignLearning>;
}

export interface CampaignMetricRepository {
  create(input: Partial<CampaignMetric>): Promise<CampaignMetric>;
  listByCampaign(workspaceId: string, campaignId: string): Promise<CampaignMetric[]>;
  upsertMetric(input: Partial<CampaignMetric>): Promise<CampaignMetric>;
}

export interface EventLogRepository {
  create(input: Partial<EventLog>): Promise<EventLog>;
  listByWorkspace(workspaceId: string): Promise<EventLog[]>;
  listByEntity(workspaceId: string, entityType: string, entityId: string): Promise<EventLog[]>;
}

export interface JobRunRepository {
  create(input: Partial<JobRun>): Promise<JobRun>;
  updateStatus(workspaceId: string, jobRunId: string, status: string): Promise<JobRun>;
  complete(workspaceId: string, jobRunId: string, result?: Record<string, unknown>): Promise<JobRun>;
  fail(workspaceId: string, jobRunId: string, errorMessage: string): Promise<JobRun>;
  listByWorkspace(workspaceId: string): Promise<JobRun[]>;
  /** N8 — one job, scoped to its workspace. Undefined when it is not there or not theirs. */
  getById(workspaceId: string, jobRunId: string): Promise<JobRun | undefined>;
  /** N8 — record progress, a partial result, or a final one, without forcing "completed". */
  update(workspaceId: string, jobRunId: string, data: Partial<Pick<JobRun, "status" | "payload" | "result" | "errorMessage" | "startedAt" | "completedAt">>): Promise<JobRun>;
  /**
   * N8 — move a job from one status to another ONLY if it is still in the first.
   * Returns false when someone else got there first.
   *
   * This is what stops a double-click running a paid plan twice. A read-then-
   * write check does not: two requests both read "waiting", both write
   * "running", and both spend.
   */
  claim(workspaceId: string, jobRunId: string, fromStatus: string, toStatus: string,
    patch?: Partial<Pick<JobRun, "payload" | "result" | "errorMessage" | "startedAt" | "completedAt">>): Promise<boolean>;
}

export interface AgentBehaviorPolicyRepository {
  getActive(workspaceId?: string): Promise<AgentBehaviorPolicy | undefined>;
  create(input: Partial<AgentBehaviorPolicy>): Promise<AgentBehaviorPolicy>;
}

export interface CompanyCommunicationSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<CompanyCommunicationSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<CompanyCommunicationSettings>): Promise<CompanyCommunicationSettings>;
}

export interface ConversationPolicyRepository {
  getByWorkspaceAndChannel(workspaceId: string, channel: string): Promise<ConversationPolicy | undefined>;
  upsertForWorkspaceAndChannel(workspaceId: string, channel: string, data: Partial<ConversationPolicy>): Promise<ConversationPolicy>;
}

export interface WhatsAppAgentSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<WhatsAppAgentSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<WhatsAppAgentSettings>): Promise<WhatsAppAgentSettings>;
}

export interface EscalationRuleRepository {
  listActive(workspaceId: string, channel?: string): Promise<EscalationRule[]>;
  create(input: Partial<EscalationRule>): Promise<EscalationRule>;
}

/**
 * Stage 2 / 2026-07-20 — Customer Ticket repository.
 */
export interface TicketRepository {
  create(input: Partial<Ticket> & { workspaceId: string; type: Ticket["type"]; priority: Ticket["priority"]; subject: string; description: string; sourceChannel: string }): Promise<Ticket>;
  getById(workspaceId: string, ticketId: string): Promise<Ticket | undefined>;
  getByTicketNumber(workspaceId: string, ticketNumber: number): Promise<Ticket | undefined>;
  listByWorkspace(workspaceId: string, filters?: { status?: Ticket["status"]; priority?: Ticket["priority"]; leadId?: string }): Promise<Ticket[]>;
  listOpenTickets(workspaceId: string): Promise<Ticket[]>;
  listBreached(workspaceId: string): Promise<Ticket[]>;
  update(workspaceId: string, ticketId: string, data: Partial<Ticket>): Promise<Ticket>;
  /** Atomically allocate the next sequential ticket number for a workspace. */
  nextTicketNumber(workspaceId: string): Promise<number>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all tickets for a lead. Used
   * ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface TicketEventRepository {
  create(input: Partial<TicketEvent> & { workspaceId: string; ticketId: string; eventType: TicketEvent["eventType"]; actorType: TicketEvent["actorType"] }): Promise<TicketEvent>;
  listByTicket(workspaceId: string, ticketId: string): Promise<TicketEvent[]>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all events for a set of ticket
   * ids. Used ONLY by the DPDPA erasure cascade (after the tickets them-
   * selves are deleted). Returns the count removed.
   */
  deleteByTicketIds(workspaceId: string, ticketIds: string[]): Promise<number>;
}

export interface TicketSlaSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<TicketSlaSettings | undefined>;
  upsertForWorkspace(workspaceId: string, input: Partial<TicketSlaSettings>): Promise<TicketSlaSettings>;
}

/**
 * 2026-07-21 (M7) — Order + Quote repositories (Stage 3 UI plumbing).
 * Minimal surface: list, get, create, update, next-number. The OrderService
 * + QuoteService pure functions handle the business rules; repos persist.
 */
export interface OrderRepository {
  create(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }): Promise<Order>;
  getById(workspaceId: string, orderId: string): Promise<Order | undefined>;
  listByWorkspace(workspaceId: string, filters?: { status?: Order["status"]; leadId?: string }): Promise<Order[]>;
  listByLead(workspaceId: string, leadId: string): Promise<Order[]>;
  update(workspaceId: string, orderId: string, data: Partial<Order>): Promise<Order>;
  nextOrderNumber(workspaceId: string): Promise<number>;
  /**
   * Allocate the next order number AND create the row in one transaction.
   * Both substrates have implemented this since session 20; it was simply
   * never declared here, so callers had to feature-detect it at runtime
   * (route.ts:1993) and tests could not see it at all. Prefer it over
   * `nextOrderNumber` + `create`, which race: two concurrent creates read
   * the same maximum and collide on @@unique(workspaceId, orderNumber).
   */
  createWithNextOrderNumber(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }): Promise<Order>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all orders for a lead. Used
   * ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export type AtomicQuoteConversionResult = { order: Order; quote: Quote; alreadyConverted: boolean };
export type QuoteCreateInput = Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string };

export interface QuoteRepository {
  /** Recheck the current quote and save its order and conversion link in one
   * storage transaction. The callback owns business rules and must not do I/O.
   * A retry returns the linked order without running the callback again. */
  convertToOrderAtomically(workspaceId: string, quoteId: string, build: (quote: Quote) => Promise<{ order: Order; quote: Quote }>): Promise<AtomicQuoteConversionResult | undefined>;
  /** Create a revision and retire its current original together. */
  reviseAtomically(workspaceId: string, quoteId: string, build: (quote: Quote) => Promise<QuoteCreateInput>): Promise<{ quote: Quote; supersededQuote: Quote } | undefined>;
  create(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }): Promise<Quote>;
  getById(workspaceId: string, quoteId: string): Promise<Quote | undefined>;
  listByWorkspace(workspaceId: string, filters?: { status?: Quote["status"]; leadId?: string }): Promise<Quote[]>;
  listByLead(workspaceId: string, leadId: string): Promise<Quote[]>;
  update(workspaceId: string, quoteId: string, data: Partial<Quote>, expectedStatus?: Quote["status"]): Promise<Quote>;
  /**
   * 2026-09-26 (break test) — flip the quote to "converted" ONLY if it is
   * still in one of `fromStatuses`, in one atomic step. Returns false when
   * another request got there first. Two clicks on "Convert to order" used
   * to both pass the status check and create two orders.
   */
  claimForConversion(workspaceId: string, quoteId: string, fromStatuses: Quote["status"][]): Promise<boolean>;
  nextQuoteNumber(workspaceId: string): Promise<number>;
  /** Same contract as {@link OrderRepository.createWithNextOrderNumber}. */
  createWithNextQuoteNumber(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }): Promise<Quote>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all quotes for a lead. Used
   * ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}


export interface UnknownQuestionRepository {
  create(workspaceId: string, data: Partial<UnknownQuestion>): Promise<UnknownQuestion>;
  listByWorkspace(workspaceId: string, filters?: { status?: string }): Promise<UnknownQuestion[]>;
  /**
   * 2026-07-21 (Cluster A fix B3, session 16) — fetch a single UnknownQuestion
   * by id. Used by POST /unknown-questions/:id/convert to load the source
   * before calling convertToTicket. Returns undefined if not found OR not in
   * this workspace.
   */
  getById(workspaceId: string, id: string): Promise<UnknownQuestion | undefined>;
  update(workspaceId: string, id: string, data: Partial<UnknownQuestion>): Promise<UnknownQuestion>;
  markAnswered(workspaceId: string, id: string, answer: string): Promise<UnknownQuestion>;
  markAddedToKnowledge(workspaceId: string, id: string): Promise<UnknownQuestion>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all unknown questions for a
   * lead. Used ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface AutoReplyLogRepository {
  create(workspaceId: string, data: Partial<AutoReplyLog>): Promise<AutoReplyLog>;
  getById(workspaceId: string, id: string): Promise<AutoReplyLog | undefined>;
  listByWorkspace(workspaceId: string, filters?: { status?: string }): Promise<AutoReplyLog[]>;
  /** F-DATA-6 (2026-08-07) — see ReplyRepository.listByLead for why. */
  listByLead(workspaceId: string, leadId: string): Promise<AutoReplyLog[]>;
  approve(workspaceId: string, id: string, data?: Partial<AutoReplyLog>): Promise<AutoReplyLog>;
  reject(workspaceId: string, id: string): Promise<AutoReplyLog>;
  /** 2026-08-05 (UX Fix 1) — save the operator's internal note on a reply. */
  updateNote(workspaceId: string, id: string, internalNote: string): Promise<AutoReplyLog>;
  /** 2026-09-28 — the owner's "looked fine / should not have sent" on an automatic reply. */
  setOwnerVerdict(workspaceId: string, id: string, verdict: NonNullable<AutoReplyLog["ownerVerdict"]>, at: string): Promise<AutoReplyLog>;
  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all auto-reply logs for a
   * lead. Used ONLY by the DPDPA erasure cascade. Returns the count removed.
   */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface MediaCatalogRepository {
  // 2026-09-10 (session 55): `bytes` is the file itself, and it is a separate
  // argument on purpose. It is never part of MediaCatalogItem, so it cannot
  // ride along in a list response, a workspace export, or a log line -- the
  // only way to read it back is getFileBytes, one item at a time.
  create(workspaceId: string, data: Partial<MediaCatalogItem>, bytes?: Buffer): Promise<MediaCatalogItem>;
  listByWorkspace(workspaceId: string, filters?: { category?: string; leadId?: string }): Promise<MediaCatalogItem[]>;
  getById(workspaceId: string, id: string): Promise<MediaCatalogItem | undefined>;
  /** The stored file, or undefined for a row uploaded before the bytes moved into the store. */
  getFileBytes(workspaceId: string, id: string): Promise<Buffer | undefined>;
  delete(workspaceId: string, id: string): Promise<MediaCatalogItem>;
  /**
   * 2026-09-28 (S5) — erasure: HARD-delete a customer's own photos and voice
   * notes (active and already-archived), row and bytes. `delete` above only
   * archives, which kept the lead id, the AI's description of the photo and
   * the transcript of the voice note after the customer was erased.
   */
  eraseCustomerMediaForLead(workspaceId: string, leadId: string): Promise<{ removed: number; ids: string[] }>;
}

// CP-25 (2026-08-02) — Meta-approved WhatsApp message templates.
export interface WhatsAppTemplateRepository {
  create(workspaceId: string, data: Partial<WhatsAppTemplate>): Promise<WhatsAppTemplate>;
  listByWorkspace(workspaceId: string): Promise<WhatsAppTemplate[]>;
  getById(workspaceId: string, id: string): Promise<WhatsAppTemplate | undefined>;
  update(workspaceId: string, id: string, data: Partial<WhatsAppTemplate>): Promise<WhatsAppTemplate>;
  deleteById(workspaceId: string, id: string): Promise<WhatsAppTemplate>;
}

export interface KnowledgeBaseDocumentRepository {
  create(workspaceId: string, data: Partial<KnowledgeBaseDocument>): Promise<KnowledgeBaseDocument>;
  update(workspaceId: string, documentId: string, data: Partial<KnowledgeBaseDocument>): Promise<KnowledgeBaseDocument>;
  getById(workspaceId: string, documentId: string): Promise<KnowledgeBaseDocument | undefined>;
  listByWorkspace(workspaceId: string): Promise<KnowledgeBaseDocument[]>;
  getByTypeAndSource(workspaceId: string, documentType: string, source: string): Promise<KnowledgeBaseDocument | undefined>;
  /**
   * 2026-09-08 — removing a source document was not possible on any substrate.
   * A workspace that ingested the wrong brochure, or an extraction that ran
   * with no AI key and stored a page of canned fallback text, carried that
   * content into the retrieval context of every reply for the life of the
   * workspace. Deleting the document must also remove its chunks, or the
   * document disappears from the screen while its text keeps being retrieved.
   */
  delete(workspaceId: string, documentId: string): Promise<KnowledgeBaseDocument>;
}

export interface KnowledgeBaseChunkRepository {
  createMany(workspaceId: string, documentId: string, chunks: Partial<KnowledgeBaseChunk>[]): Promise<KnowledgeBaseChunk[]>;
  listByDocument(workspaceId: string, documentId: string): Promise<KnowledgeBaseChunk[]>;
  listByWorkspace(workspaceId: string): Promise<KnowledgeBaseChunk[]>;
  /**
   * The chunks with these ids, in this workspace. Used by vector search, which
   * comes back with ids and similarities and needs the text behind them — the
   * whole point of the index is NOT loading the workspace to find a handful of
   * rows. The workspace filter is a tenancy boundary, not an optimisation: an
   * id from another workspace must return nothing.
   */
  listByIds(workspaceId: string, ids: string[]): Promise<KnowledgeBaseChunk[]>;
  /**
   * Replace one chunk's metadata. Used to RETIRE a chunk the owner has
   * corrected: the row stays (it is the evidence of what the uploaded document
   * actually said) but is marked superseded, and retrieval skips it. Returns
   * the updated chunk, or null when it does not exist in this workspace.
   */
  updateMetadata(workspaceId: string, chunkId: string, metadata: Record<string, unknown>): Promise<KnowledgeBaseChunk | null>;
  replaceForDocument(workspaceId: string, documentId: string, chunks: Partial<KnowledgeBaseChunk>[]): Promise<KnowledgeBaseChunk[]>;
  searchByKeyword(workspaceId: string, query: string, limit?: number): Promise<Array<KnowledgeBaseChunk & { score: number; documentTitle?: string }>>;
}

export interface KnowledgeBaseQueryLogRepository {
  create(workspaceId: string, data: Partial<KnowledgeBaseQueryLog>): Promise<KnowledgeBaseQueryLog>;
}

export interface LLMProviderCredentialRepository {
  listByWorkspace(workspaceId: string): Promise<LLMProviderCredential[]>;
  /**
   * 2026-09-27 (review S1): which companies saved this WhatsApp number (Meta's
   * phone_number_id). The ONE cross-company read here — it returns only ids,
   * so an incoming message can be filed under the company that owns the number.
   */
  listWorkspaceIdsForWhatsAppNumber(phoneNumberId: string): Promise<string[]>;
  create(workspaceId: string, data: Partial<LLMProviderCredential>): Promise<LLMProviderCredential>;
  /**
   * I-4 fix (batch 3, 2026-07-27): key rotation. Updates an existing credential
   * (e.g. to replace a leaked/rotated API key). MUST be workspace-scoped so a
   * user from ws_A cannot update ws_B's credential by guessing the id. Returns
   * the updated record or throws if not found.
   */
  update(workspaceId: string, id: string, data: Partial<LLMProviderCredential>): Promise<LLMProviderCredential>;
  /**
   * I-4 fix (batch 3, 2026-07-27): revoke + remove a credential. MUST be
   * workspace-scoped. Returns true if a record was deleted, false if not found.
   */
  delete(workspaceId: string, id: string): Promise<boolean>;
}

export interface LLMModelRoutingRepository {
  listByWorkspace(workspaceId: string): Promise<LLMModelRouting[]>;
  replaceForWorkspace(workspaceId: string, routes: Partial<LLMModelRouting>[]): Promise<LLMModelRouting[]>;
}

export interface AIUsageLimitRepository {
  getByWorkspace(workspaceId: string): Promise<AIUsageLimit | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<AIUsageLimit>): Promise<AIUsageLimit>;
}

export interface ProductKnowledgeRepository {
  create(input: Partial<ProductKnowledge>): Promise<ProductKnowledge>;
  listByWorkspace(workspaceId: string): Promise<ProductKnowledge[]>;
  /**
   * N-BUG-5 (2026-09-05). Removal used to be written as `data.x = data.x.filter(...)`
   * inside `repos.mutateAll`, which deletes on the JSON substrate and does
   * NOTHING on Postgres — the snapshot writer there is upsert-only. Anything
   * that needs a row gone asks its repository, which knows how to delete on the
   * substrate it is running on. Returns the number of rows removed.
   */
  deleteByWorkspace(workspaceId: string): Promise<number>;
}

export interface ProductVarietyRepository {
  createMany(input: Partial<ProductVariety>[]): Promise<ProductVariety[]>;
  listByWorkspace(workspaceId: string): Promise<ProductVariety[]>;
  /**
   * N-BUG-5 (2026-09-05). Removal used to be written as `data.x = data.x.filter(...)`
   * inside `repos.mutateAll`, which deletes on the JSON substrate and does
   * NOTHING on Postgres — the snapshot writer there is upsert-only. Anything
   * that needs a row gone asks its repository, which knows how to delete on the
   * substrate it is running on. Returns the number of rows removed.
   */
  deleteByWorkspace(workspaceId: string): Promise<number>;
}

export interface ProductApplicationRepository {
  createMany(input: Partial<ProductApplication>[]): Promise<ProductApplication[]>;
  listByWorkspace(workspaceId: string): Promise<ProductApplication[]>;
  /**
   * N-BUG-5 (2026-09-05). Removal used to be written as `data.x = data.x.filter(...)`
   * inside `repos.mutateAll`, which deletes on the JSON substrate and does
   * NOTHING on Postgres — the snapshot writer there is upsert-only. Anything
   * that needs a row gone asks its repository, which knows how to delete on the
   * substrate it is running on. Returns the number of rows removed.
   */
  deleteByWorkspace(workspaceId: string): Promise<number>;
}

export interface BuyerSegmentRepository {
  createMany(input: Partial<BuyerSegment>[]): Promise<BuyerSegment[]>;
  listByWorkspace(workspaceId: string): Promise<BuyerSegment[]>;
  /**
   * N-BUG-5 (2026-09-05). Removal used to be written as `data.x = data.x.filter(...)`
   * inside `repos.mutateAll`, which deletes on the JSON substrate and does
   * NOTHING on Postgres — the snapshot writer there is upsert-only. Anything
   * that needs a row gone asks its repository, which knows how to delete on the
   * substrate it is running on. Returns the number of rows removed.
   */
  deleteByWorkspace(workspaceId: string): Promise<number>;
}

export interface ProductApplicationMarketMapRepository {
  createMany(input: Partial<ProductApplicationMarketMap>[]): Promise<ProductApplicationMarketMap[]>;
  listByWorkspace(workspaceId: string): Promise<ProductApplicationMarketMap[]>;
  /**
   * N-BUG-5 (2026-09-05). Removal used to be written as `data.x = data.x.filter(...)`
   * inside `repos.mutateAll`, which deletes on the JSON substrate and does
   * NOTHING on Postgres — the snapshot writer there is upsert-only. Anything
   * that needs a row gone asks its repository, which knows how to delete on the
   * substrate it is running on. Returns the number of rows removed.
   */
  deleteByWorkspace(workspaceId: string): Promise<number>;
}

export interface LeadReviewSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<LeadReviewSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<LeadReviewSettings>): Promise<LeadReviewSettings>;
}

export interface LeadReviewDecisionRepository {
  create(input: Partial<LeadReviewDecision>): Promise<LeadReviewDecision>;
  listByLead(workspaceId: string, leadId: string): Promise<LeadReviewDecision[]>;
  listByWorkspace(workspaceId: string): Promise<LeadReviewDecision[]>;
  /** 2026-09-28 (S5) — erasure: the review notes about a customer. No foreign key, so nothing else removes them on Postgres. */
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface AgentAutonomousSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<AgentAutonomousSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<AgentAutonomousSettings>): Promise<AgentAutonomousSettings>;
}

export interface ProviderAccountRepository {
  listByWorkspace(workspaceId: string): Promise<ProviderAccount[]>;
  create(workspaceId: string, data: Partial<ProviderAccount>): Promise<ProviderAccount>;
  update(workspaceId: string, id: string, data: Partial<ProviderAccount>): Promise<ProviderAccount>;
}

export interface AgentAutonomousSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<AgentAutonomousSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<AgentAutonomousSettings>): Promise<AgentAutonomousSettings>;
}

export interface SalesSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<SalesSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<SalesSettings>): Promise<SalesSettings>;
}

export interface ProductSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<ProductSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<ProductSettings>): Promise<ProductSettings>;
}

export interface PolicySettingsRepository {
  getByWorkspace(workspaceId: string): Promise<PolicySettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<PolicySettings>): Promise<PolicySettings>;
}

export interface CommunicationSettingsRepository {
  getByWorkspace(workspaceId: string): Promise<CommunicationSettings | undefined>;
  upsertForWorkspace(workspaceId: string, data: Partial<CommunicationSettings>): Promise<CommunicationSettings>;
}

export interface SettingsConflictRepository {
  create(workspaceId: string, data: Partial<SettingsConflict>): Promise<SettingsConflict>;
  listByWorkspace(workspaceId: string, filters?: { status?: string; settingsArea?: string }): Promise<SettingsConflict[]>;
  getById(workspaceId: string, id: string): Promise<SettingsConflict | undefined>;
  resolve(workspaceId: string, id: string, resolution: SettingsConflict["resolution"], customValue?: string, reason?: string): Promise<SettingsConflict>;
  ignore(workspaceId: string, id: string): Promise<SettingsConflict>;
}

export interface PendingSettingsDraftRepository {
  listByWorkspace(workspaceId: string): Promise<PendingSettingsDraft[]>;
  listPending(workspaceId: string): Promise<PendingSettingsDraft[]>;
  upsertPending(workspaceId: string, data: Partial<PendingSettingsDraft>): Promise<PendingSettingsDraft>;
  updateStatus(workspaceId: string, draftId: string, status: PendingSettingsDraft["status"]): Promise<PendingSettingsDraft>;
}

/**
 * Stage A.2 (2026-07-26) — Auth repository.
 *
 * The auth-service used to call readData/mutateData directly (JSON-only). That
 * split-brained in Prisma mode: login would hit the JSON file even when
 * PERSISTENCE_PROVIDER=prisma. This thin interface abstracts the 5 storage
 * operations auth needs, with one JSON-wrapping impl and one Prisma-wrapping
 * impl. auth-service picks whichever the runtime chooses — same pattern as
 * every other repository. Zero behaviour change in demo mode (the JSON impl
 * wraps exactly what was there before).
 */
export interface AuthRepository {
  /** Find a user by id + workspaceId (session validation). */
  findUserById(workspaceId: string, userId: string): Promise<User | undefined>;
  /** All users (used to resolve sessions that carry only userId). */
  listUsers(): Promise<User[]>;
  /** Find a credential by email, scoped to a workspace (login). */
  findCredentialByEmail(workspaceId: string, email: string): Promise<{ user: User; credential: UserCredential } | null>;
  /** True when at least one credential exists (drives setup vs sign-in UI). */
  hasAnyCredentials(): Promise<boolean>;
  /**
   * Atomically create the owner (User + UserCredential + WorkspaceMember) in
   * one transaction. Throws if a credential already exists (the bootstrap
   * guard). Mirrors auth-service.bootstrapOwner's old mutateData shape.
   */
  createOwnerWithCredential(input: {
    workspaceId: string;
    user: User;
    credential: UserCredential;
    member: WorkspaceMember;
  }): Promise<User>;
  /**
   * Stage 5 re-audit fix (F-P0-1, F-P1-11, 2026-07-28) — Atomically create a
   * brand-new workspace TOGETHER with its owner (Workspace + User +
   * UserCredential + WorkspaceMember) in ONE transaction. Used by
   * SignupService.signup + handProvisionWorkspace. Pre-fix, signup did TWO
   * separate awaits (workspace.create THEN createOwnerWithCredential); a
   * failure between them orphaned the workspace. This method closes that gap:
   * all 4 rows commit together or none do.
   *
   * CONTRACT (pinned by golden:signup-invite-atomicity): a throw mid-method
   * rolls back EVERY write made in this method (no orphan workspace, user,
   * credential, or member).
   */
  createWorkspaceWithOwner(input: {
    workspace: Workspace;
    user: User;
    credential: UserCredential;
    member: WorkspaceMember;
  }): Promise<{ workspace: Workspace; user: User }>;
  /**
   * 2026-09-28 (S8) — every account for this email across ALL companies, in
   * one lookup on the indexed email column (sign-in and forgot-password).
   * The email is compared lower-cased.
   */
  findCredentialsByEmail(email: string): Promise<Array<{ user: User; credential: UserCredential }>>;
}

/**
 * Stage A.2 (2026-07-26) — WorkspaceMember repository.
 *
 * The JSON runtime always had listActiveStaffForWorkspace on WorkspaceRepository;
 * Stage 5+ team-management UIs (invite, role-change, deactivate) will need a
 * fuller CRUD surface. For Stage A we expose the minimal list + create so the
 * bootstrap-owner CLI + tests can write membership rows without going through
 * the snapshot helper.
 */
export interface WorkspaceMemberRepository {
  listByWorkspace(workspaceId: string): Promise<WorkspaceMember[]>;
  listActiveByWorkspace(workspaceId: string): Promise<WorkspaceMember[]>;
  create(input: WorkspaceMember): Promise<WorkspaceMember>;
  /**
   * Stage 5 / WP1 (2026-07-28) — Remove the "invited" member row for a given
   * email in a workspace. Used by revokeInvite to enforce the no-orphan rule
   * (a revoked invite must not leave a ghost "invited" member row). Only
   * removes rows whose status === "invited" (never touches active members).
   */
  deleteInvitedByEmail(workspaceId: string, email: string): Promise<void>;
  /**
   * Stage 5 / WP1 (2026-07-28) — Promote an "invited" member row to "active"
   * with the real userId + name (called on invite acceptance). Only updates
   * rows whose status === "invited" for the given email.
   */
  activateInvitedByEmail(workspaceId: string, email: string, userId: string, name?: string): Promise<void>;
  /**
   * 2026-09-28 (S3) — the membership row for this user in this company, in
   * any status (active / invited / disabled). resolveCurrentUser requires it
   * to be active and takes the role from it.
   */
  findForUser(workspaceId: string, userId: string): Promise<WorkspaceMember | undefined>;
  /** 2026-09-28 (S3) — change a member's role / status (team management). */
  update(workspaceId: string, memberId: string, patch: Partial<Pick<WorkspaceMember, "role" | "status" | "name" | "userId">>): Promise<WorkspaceMember>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 / WP3 (2026-07-28) — Platform ticket + admin repositories.
//
// Key design point: platform tickets are the OPERATOR's records, shared across
// all workspaces. So these repos have TWO kinds of methods:
//   - *ForUser methods take a workspaceId (the user-side view: a workspace
//     owner/admin sees their own tickets).
//   - *ForOperator methods take NO workspaceId (the operator-side view: a
//     PlatformAdmin sees every workspace's tickets). The operator methods
//     must NEVER be reachable from a workspace-scoped route — only /admin/*.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformTicketRepository {
  /** User-side: list a workspace's own tickets (creator + same-ws owner/admin). */
  listForUser(workspaceId: string, filters?: { status?: PlatformTicket["status"]; category?: PlatformTicket["category"] }): Promise<PlatformTicket[]>;
  /** User-side: fetch one ticket, scoped to the caller's workspace (isolation). */
  getForUser(workspaceId: string, ticketId: string): Promise<PlatformTicket | undefined>;
  /** Operator-side: list across ALL workspaces. NEVER call from a workspace route. */
  listForOperator(filters?: {
    status?: PlatformTicket["status"];
    category?: PlatformTicket["category"];
    workspaceId?: string;
    includeSpamFlagged?: boolean;
  }): Promise<PlatformTicket[]>;
  /** Operator-side: fetch one ticket by id (cross-workspace). */
  getForOperator(ticketId: string): Promise<PlatformTicket | undefined>;
  /** Atomically create a ticket + allocate the next GLOBAL ticketNumber. */
  createWithNextNumber(input: {
    workspaceId: string;
    raisedByUserId: string;
    subject: string;
    description: string;
    category: PlatformTicket["category"];
    priority: PlatformTicket["priority"];
    slaStartedAt: string;
    slaDueAt: string;
  }): Promise<PlatformTicket>;
  /** Operator-side: update a ticket (status, assignment, spam flag, timestamps). */
  updateForOperator(ticketId: string, data: Partial<PlatformTicket>): Promise<PlatformTicket>;
}

export interface PlatformTicketEventRepository {
  create(input: {
    ticketId: string;
    workspaceId: string;
    eventType: PlatformTicketEvent["eventType"];
    actorType: PlatformTicketEvent["actorType"];
    actorUserId?: string;
    actorAdminId?: string;
    fromStatus?: PlatformTicketEvent["fromStatus"];
    toStatus?: PlatformTicketEvent["toStatus"];
    note?: string;
  }): Promise<PlatformTicketEvent>;
  /** List a ticket's thread. Callable from both user-side + operator-side
   *  (the route layer is responsible for ensuring the caller can see the ticket). */
  listByTicket(ticketId: string): Promise<PlatformTicketEvent[]>;
}

export interface PlatformSupportHoursRepository {
  /** Singleton getter (id="default"); seeds defaults if absent. */
  get(): Promise<PlatformSupportHours>;
  update(input: Partial<PlatformSupportHours>): Promise<PlatformSupportHours>;
}

export interface PlatformTicketSlaSettingsRepository {
  /** Singleton getter (id="default"); seeds defaults if absent. */
  get(): Promise<PlatformTicketSlaSettings>;
  update(input: Partial<PlatformTicketSlaSettings>): Promise<PlatformTicketSlaSettings>;
}

export interface PlatformUserBlockRepository {
  get(userId: string): Promise<PlatformUserBlock | undefined>;
  /** True if the user is currently blocked from opening new tickets. */
  isBlocked(userId: string): Promise<boolean>;
  /** Upsert a block record (admin sets isBlockedFromSupport + reason). */
  upsert(input: {
    userId: string;
    workspaceId: string;
    isBlockedFromSupport: boolean;
    reason?: string;
    blockedByAdminId: string;
  }): Promise<PlatformUserBlock>;
}

// ─── PlatformAdmin auth (operator-side login) ────────────────────────────────

export interface PlatformAdminRepository {
  findByEmail(email: string): Promise<{ admin: PlatformAdmin; credential: PlatformAdminCredential } | null>;
  findById(adminId: string): Promise<PlatformAdmin | undefined>;
  /** Atomically create the first admin (admin + credential). Throws if the
   *  email already exists. Used by the bootstrap CLI + a future operator route. */
  createWithCredential(input: {
    admin: Omit<PlatformAdmin, "createdAt" | "updatedAt">;
    credential: Omit<PlatformAdminCredential, "id" | "createdAt" | "updatedAt">;
  }): Promise<PlatformAdmin>;
  /** True when at least one admin exists (drives "bootstrap vs sign-in"). */
  hasAnyAdmin(): Promise<boolean>;
  /** Update lastLoginAt on successful login. */
  touchLogin(adminId: string): Promise<void>;
  listAll(): Promise<PlatformAdmin[]>;
  updateRole(adminId: string, role: PlatformAdminRole): Promise<PlatformAdmin>;
  updateStatus(adminId: string, status: "active" | "suspended"): Promise<PlatformAdmin>;
  /** 2026-09-28 (S4) — the admin's current session version (1 when never bumped). */
  getSessionVersion(adminId: string): Promise<number>;
  /** 2026-09-28 (S4) — end every admin session (sign-out). Returns the new version. */
  bumpSessionVersion(adminId: string): Promise<number>;
}

export interface PlatformAuditLogRepository {
  create(input: { adminId: string; action: PlatformAuditLog["action"]; metadata?: Record<string, unknown> }): Promise<PlatformAuditLog>;
  list(filters?: { adminId?: string; action?: PlatformAuditLog["action"]; limit?: number }): Promise<PlatformAuditLog[]>;
}

// ─── Stage 5 / WP2 (2026-07-28) — operator admin ops repositories ────────────
//
// These back the operator console: cross-tenant user lookup (for
// impersonation target resolution + the user list), the global feature-flag
// kill-switches, operator-issued password-reset tokens, and active
// impersonation sessions. See docs/LOGIC.md 2026-07-28.

export interface UserRepository {
  /** Find a user across ALL workspaces by id (operator lookup for
   *  impersonation target resolution). Returns undefined if not found. */
  findById(userId: string): Promise<User | undefined>;
  /** List every user in a workspace (operator user-list screen). */
  listForWorkspace(workspaceId: string): Promise<User[]>;
  /** Create a user (used by WP2 test seeding + future invite flow). */
  create(input: Partial<User>): Promise<User>;
  /** Update a user's fields (role change, etc). */
  update(userId: string, data: Partial<User>): Promise<User>;
}

export interface UserCredentialRepository {
  /** Find a credential by userId (for session-version bump on password reset). */
  findByUserId(userId: string): Promise<UserCredential | undefined>;
  /** Update password hash + bump sessionVersion (existing sessions killed). */
  updatePasswordAndBumpSession(
    userId: string,
    passwordHash: string,
  ): Promise<UserCredential>;
  /** Create a credential row (used by test seeding). */
  create(input: Partial<UserCredential>): Promise<UserCredential>;
  /**
   * 2026-09-28 (S3/S4) — end every session this user holds without touching
   * the password (sign-out, removal, role change). Returns the new version.
   * A user with no credential has no sessions; returns 0 and writes nothing.
   */
  bumpSessionVersion(userId: string): Promise<number>;
}

/**
 * Permanent Do-Not-Contact registry (N-DNC-1, 2026-08-18, CEO-loop session 6).
 *
 * WHY THIS REPOSITORY HAD TO EXIST. `src/lib/dnc-registry.ts` used to read and
 * write the registry with `readData()` / `mutateData()`, which are plain file
 * operations on .leadgen-data/app-data.json with no awareness of
 * PERSISTENCE_PROVIDER (db.ts:209, db.ts:260). On Postgres — the substrate this
 * product ships on — the consequence was measured, not guessed:
 *
 *   - registerDoNotContact() ran to completion; postgres do_not_contact_entries
 *     stayed at 0 rows and the JSON file grew by one.
 *   - an opt-out inserted DIRECTLY into postgres was invisible to
 *     isPermanentlyDoNotContact(), which answered false — meaning the product
 *     would have gone on to message somebody who had said stop.
 *
 * This is the compliance store. It has to live on the same substrate as
 * everything else, which means it has to go through a repository.
 *
 * Callers pass ALREADY-NORMALIZED keys. Normalization (normalizePhone /
 * normalizeEmail) stays in dnc-registry.ts as the single source of truth, so
 * the two substrates cannot drift on what "the same phone number" means.
 */
/**
 * Already-normalized register keys. A match on ANY supplied key is a match.
 * Phones compare on the last 10 digits (src/lib/phone-match.ts); the domain
 * (2026-09-28, L10) is a website host as reduced by websiteKey().
 */
export type DncKeys = { normalizedPhone?: string; normalizedEmail?: string; normalizedDomain?: string };

export interface DoNotContactRepository {
  /** Every opt-out recorded for a workspace. */
  listByWorkspace(workspaceId: string): Promise<DoNotContactEntry[]>;
  /**
   * First entry matching the normalized phone OR the normalized email. An
   * empty string counts as "not supplied": matching on "" would match every
   * entry that happens to have no phone, which is the opposite of what a
   * do-not-contact check is for.
   */
  findMatch(
    workspaceId: string,
    keys: DncKeys,
  ): Promise<DoNotContactEntry | undefined>;
  /** Append an opt-out. The caller supplies the id and createdAt. */
  create(entry: DoNotContactEntry): Promise<DoNotContactEntry>;
  /** Remove every entry matching either key. Returns how many were removed. */
  removeMatching(
    workspaceId: string,
    keys: DncKeys,
  ): Promise<number>;
}

export interface FeatureFlagRepository {
  /** Get a flag by key (global flags only in WP2). Returns undefined if never set. */
  getByKey(key: string): Promise<FeatureFlag | undefined>;
  /** Upsert a flag (create if absent, update if present). */
  upsert(input: {
    key: string;
    enabled: boolean;
    lastToggledByAdminId: string;
  }): Promise<FeatureFlag>;
  /** List all set flags (operator flags screen). */
  listAll(): Promise<FeatureFlag[]>;
}

export interface PasswordResetTokenRepository {
  /** Atomically validate/consume a live token and replace its scoped credential. */
  redeem(tokenHash: string, passwordHash: string): Promise<{ userId: string; workspaceId: string; completedAt: string } | undefined>;
  /** Store a new reset token (already hashed). */
  create(input: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    issuedByAdminId: string;
  }): Promise<PasswordResetToken>;
  /** Find the most recent unconsumed, unexpired token for a user. */
  findLatestForUser(userId: string): Promise<PasswordResetToken | undefined>;
  /**
   * Stage 5 re-audit fix (F-P0-4, 2026-07-28) — Find a reset token by its
   * (hashed) raw token. Used by redeemPasswordReset to resolve the token from
   * the emailed link. Mirrors EmailVerificationTokenRepository.findByTokenHash.
   */
  findByTokenHash(tokenHash: string): Promise<PasswordResetToken | undefined>;
  /** Mark a token consumed (user set a new password with it). */
  markConsumed(tokenId: string): Promise<void>;
}

export interface ImpersonationSessionRepository {
  /** Create a new impersonation session (startImpersonation). */
  create(input: {
    adminId: string;
    targetUserId: string;
    targetWorkspaceId: string;
    tokenHash: string;
    startedAt: string;
    expiresAt: string;
    reason: string;
  }): Promise<ImpersonationSession>;
  /** Find a session by its (hashed) token — used by verifyImpersonationToken. */
  findByTokenHash(tokenHash: string): Promise<ImpersonationSession | undefined>;
  /** Find the active (non-ended, non-expired) session for an admin. */
  findActiveForAdmin(adminId: string): Promise<ImpersonationSession | undefined>;
  /** Stamp endedAt on a session (exitImpersonation). */
  markEnded(sessionId: string): Promise<void>;
}

// ─── Stage 5 / WP1 (2026-07-28) — signup verification + invites ────────────
//
// EmailVerificationToken mirrors PasswordResetToken (hashed token, 24h
// expiry, consumed flag). Invite mirrors it too but with a 7-day expiry and a
// status state machine. See docs/LOGIC.md 2026-07-28 (WP1 entries).

export interface EmailVerificationTokenRepository {
  /** Atomically verify a scoped user and consume a live token; repeat clicks are safe. */
  verifyAndConsume(tokenHash: string): Promise<string | undefined>;
  /** Store a new verification token (already hashed). */
  create(input: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    issuedAt: string;
    expiresAt: string;
    source: "signup" | "reissue";
  }): Promise<EmailVerificationToken>;
  /** Find the most recent unconsumed, unexpired token for a user. */
  findLatestForUser(userId: string): Promise<EmailVerificationToken | undefined>;
  /** Find a token row by its (hashed) token — used by verifyEmail. */
  findByTokenHash(tokenHash: string): Promise<EmailVerificationToken | undefined>;
  /** Mark a token consumed (user clicked the verify link). */
  markConsumed(tokenId: string): Promise<void>;
  /** Invalidate all prior unconsumed tokens for a user (used on re-issue). */
  invalidatePriorTokens(userId: string): Promise<void>;
  /** List all tokens for a user (testing/audit only). */
  listForUserId(userId: string): Promise<EmailVerificationToken[]>;
}

export interface InviteRepository {
  /** Create a pending invite (token already hashed). */
  create(input: {
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: string;
  }): Promise<Invite>;
  /** Find an invite by id (workspace-scoped read is the caller's job). */
  findById(inviteId: string): Promise<Invite | undefined>;
  /** Find an invite by its (hashed) token — used by acceptInvite. */
  findByTokenHash(tokenHash: string): Promise<Invite | undefined>;
  /** Find the PENDING invite for (workspaceId, email), if any. */
  findPendingForEmail(workspaceId: string, email: string): Promise<Invite | undefined>;
  /** List all invites for a workspace (team-management UI). */
  listByWorkspace(workspaceId: string): Promise<Invite[]>;
  /** Mark an invite accepted (status=accepted + acceptedByUserId + resolvedAt). */
  markAccepted(inviteId: string, acceptedByUserId: string): Promise<void>;
  /** Mark an invite revoked (status=revoked + resolvedAt). */
  markRevoked(inviteId: string): Promise<void>;
  /**
   * Stage 5 re-audit fix (F-P0-2, 2026-07-28) — Atomically accept an invite:
   * create the User + UserCredential, activate the invited member row, AND mark
   * the invite consumed — all in ONE transaction. Pre-fix, InviteService did 4
   * separate awaits; a failure between them orphaned the user (user with no
   * credential, or invited member stuck while invite marked accepted).
   *
   * CONTRACT (pinned by golden:signup-invite-atomicity CASE C): a throw
   * mid-method rolls back EVERY write (no orphan user, no credential, member
   * NOT activated, invite NOT consumed).
   */
  acceptInviteAtomically(input: {
    inviteId: string;
    user: User;
    credential: UserCredential;
    memberEmail: string;
    memberName?: string;
    workspaceId: string;
  }): Promise<User>;
  /**
   * Stage 5 re-audit fix (F-P2-8, 2026-07-28) — Delete all NON-pending
   * (revoked / accepted / expired) invites for (workspaceId, email). Called
   * by createInvite BEFORE inserting a new pending invite so the table does
   * not accumulate one row per (workspace, email, status) combo (the
   * `@@unique([workspaceId, email, status])` constraint otherwise allows
   * unbounded growth). Pinned by golden:stage5-batch4-chokepoints CASE 9.
   */
  deleteNonPendingForEmail(workspaceId: string, email: string): Promise<number>;
  /**
   * TESTING ONLY — backdate an invite's createdAt+expiresAt to simulate
   * expiry in golden tests. NOT exposed to any route. The JSON impl just
   * edits the row; the Prisma impl updates the row.
   */
  backdateForTesting?(inviteId: string, createdAt: string): Promise<void>;
}

// ─── Owner Copilot (2026-08-01) — owner-facing assistant chat ───────────────
// Design: docs/planning/OWNER_COPILOT_DESIGN.md. The conversation + messages
// are persisted so the chat survives refresh and is itself auditable. The
// 5-tier router + Quote handler live in OwnerCopilotService; these repos only
// store the chat state.
/** 2026-09-27 — reminders to do something later about a customer. Every method is workspace-scoped. */
export interface FollowUpRepository {
  create(workspaceId: string, data: Partial<FollowUp> & { leadId: string; note: string }): Promise<FollowUp>;
  getById(workspaceId: string, id: string): Promise<FollowUp | undefined>;
  listByWorkspace(workspaceId: string, filters?: { status?: FollowUp["status"]; leadId?: string }): Promise<FollowUp[]>;
  update(workspaceId: string, id: string, data: Partial<FollowUp>): Promise<FollowUp>;
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

/**
 * 2026-09-28 — real results after the system talked to a customer. Every
 * method is workspace-scoped. `create` is idempotent on (kind, sourceId): the
 * same order or ticket never counts twice.
 */
export interface OutcomeSignalRepository {
  create(workspaceId: string, data: Omit<OutcomeSignal, "id" | "workspaceId" | "createdAt"> & { id?: string }): Promise<OutcomeSignal>;
  listByWorkspace(workspaceId: string, filters?: { leadId?: string; kind?: OutcomeSignal["kind"]; since?: string }): Promise<OutcomeSignal[]>;
  deleteByLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface OwnerCopilotConversationRepository {
  create(input: Partial<OwnerCopilotConversation> & { workspaceId: string; ownerUserId: string }): Promise<OwnerCopilotConversation>;
  getById(workspaceId: string, id: string): Promise<OwnerCopilotConversation | undefined>;
  /** The owner's most recent conversation (one active chat per owner). */
  getActiveForOwner(workspaceId: string, ownerUserId: string): Promise<OwnerCopilotConversation | undefined>;
  /** The owner's conversations, most recent first (2026-09-25: the chat list). */
  listForOwner(workspaceId: string, ownerUserId: string, limit?: number): Promise<OwnerCopilotConversation[]>;
  update(workspaceId: string, id: string, data: Partial<OwnerCopilotConversation>): Promise<OwnerCopilotConversation>;
  /** 2026-09-28 (S5) — erasure: conversations stop pointing at an erased customer. Returns how many changed. */
  clearActiveLead(workspaceId: string, leadId: string): Promise<number>;
}

export interface OwnerCopilotMessageRepository {
  create(input: Partial<OwnerCopilotMessage> & { workspaceId: string; conversationId: string; role: OwnerCopilotMessage["role"]; kind: OwnerCopilotMessage["kind"]; text: string }): Promise<OwnerCopilotMessage>;
  listByConversation(workspaceId: string, conversationId: string): Promise<OwnerCopilotMessage[]>;
  /** Validate and consume a persisted T3 proposal atomically before job effects. */
  claimConfirmation(input: { workspaceId: string; conversationId: string; ownerUserId: string; proposalMessageId: string; pendingActionId: string; intent: string; text: string; language: "en" | "hi" }): Promise<boolean>;
}

/**
 * Which collections a snapshot needs (2026-09-18, session 57).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `readAll()` on Postgres reads about SIXTY tables with no filter at all, and
 * `mutateAll()` does that AND writes fifteen collections back. Editing one
 * knowledge answer therefore read the entire database and rewrote a third of
 * it. On 2026-09-18 that consumed the hosting plan's whole monthly data
 * allowance and every connection was refused, including `SELECT 1`.
 *
 * ── WHY OMITTING A COLLECTION IS SAFE ───────────────────────────────────────
 * The snapshot writer (`batchUpsert`) returns immediately on an empty array, so
 * a collection that was not loaded is not written and CANNOT be deleted. A
 * mutator that appends to a collection it did not ask for still works — the new
 * row is upserted, and the rows it never saw are left alone.
 *
 * ── HOW TO USE IT ───────────────────────────────────────────────────────────
 * Omitting it loads everything, exactly as before, so nothing breaks while call
 * sites opt in one at a time. Name the collections the mutator actually touches.
 */
export type SnapshotOptions = {
  collections?: ReadonlyArray<keyof AppData>;
};

export interface RepositoryBundle {
  workspace: WorkspaceRepository;
  businessProfile: BusinessProfileRepository;
  icp: ICPRepository;
  campaign: CampaignRepository;
  lead: LeadRepository;
  messageTemplate: MessageTemplateRepository;
  outreachActivity: OutreachActivityRepository;
  reply: ReplyRepository;
  agentRun: AgentRunRepository;
  auditLog: AuditLogRepository;
  integration: IntegrationRepository;
  websiteCrawlJob: WebsiteCrawlJobRepository;
  websiteCrawlConsent: WebsiteCrawlConsentRepository;
  websiteCrawlPage: WebsiteCrawlPageRepository;
  businessExtraction: BusinessExtractionRepository;
  campaignLearning: CampaignLearningRepository;
  campaignMetric: CampaignMetricRepository;
  eventLog: EventLogRepository;
  jobRun: JobRunRepository;
  agentBehaviorPolicy: AgentBehaviorPolicyRepository;
  companyCommunicationSettings: CompanyCommunicationSettingsRepository;
  conversationPolicy: ConversationPolicyRepository;
  whatsAppAgentSettings: WhatsAppAgentSettingsRepository;
  escalationRule: EscalationRuleRepository;
  unknownQuestion: UnknownQuestionRepository;
  /** Stage 2 (2026-07-20) — Customer tickets. */
  ticket: TicketRepository;
  ticketEvent: TicketEventRepository;
  ticketSlaSettings: TicketSlaSettingsRepository;
  /** Stage 3 (2026-07-21 / M7) — Orders + Quotes. */
  order: OrderRepository;
  quote: QuoteRepository;
  autoReplyLog: AutoReplyLogRepository;
  mediaCatalog: MediaCatalogRepository;
  doNotContact: DoNotContactRepository;
  // CP-25 — Meta-approved WhatsApp templates.
  whatsAppTemplate: WhatsAppTemplateRepository;
  knowledgeBaseDocument: KnowledgeBaseDocumentRepository;
  knowledgeBaseChunk: KnowledgeBaseChunkRepository;
  knowledgeBaseQueryLog: KnowledgeBaseQueryLogRepository;
  llmProviderCredential: LLMProviderCredentialRepository;
  llmModelRouting: LLMModelRoutingRepository;
  aiUsageLimit: AIUsageLimitRepository;
  productKnowledge: ProductKnowledgeRepository;
  productVariety: ProductVarietyRepository;
  productApplication: ProductApplicationRepository;
  buyerSegment: BuyerSegmentRepository;
  productApplicationMarketMap: ProductApplicationMarketMapRepository;
  leadReviewSettings: LeadReviewSettingsRepository;
  leadReviewDecision: LeadReviewDecisionRepository;
  providerAccount: ProviderAccountRepository;
  agentAutonomousSettings: AgentAutonomousSettingsRepository;
  salesSettings: SalesSettingsRepository;
  productSettings: ProductSettingsRepository;
  policySettings: PolicySettingsRepository;
  communicationSettings: CommunicationSettingsRepository;
  settingsConflict: SettingsConflictRepository;
  pendingSettingsDraft: PendingSettingsDraftRepository;
  /** Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth. */
  platformTicket: PlatformTicketRepository;
  platformTicketEvent: PlatformTicketEventRepository;
  platformSupportHours: PlatformSupportHoursRepository;
  platformTicketSlaSettings: PlatformTicketSlaSettingsRepository;
  platformUserBlock: PlatformUserBlockRepository;
  platformAdmin: PlatformAdminRepository;
  platformAuditLog: PlatformAuditLogRepository;
  /** Stage 5 / WP2 (2026-07-28) — operator admin ops. See docs/LOGIC.md. */
  user: UserRepository;
  userCredential: UserCredentialRepository;
  featureFlag: FeatureFlagRepository;
  passwordResetToken: PasswordResetTokenRepository;
  impersonationSession: ImpersonationSessionRepository;
  /** Stage 5 / WP1 (2026-07-28) — signup verification + invites. */
  emailVerificationToken: EmailVerificationTokenRepository;
  invite: InviteRepository;
  /** Owner Copilot (2026-08-01) — owner-facing assistant chat. */
  ownerCopilotConversation: OwnerCopilotConversationRepository;
  ownerCopilotMessage: OwnerCopilotMessageRepository;
  /** 2026-09-27 — reminders for later. */
  followUp: FollowUpRepository;
  /** 2026-09-28 — what actually happened (orders, opt-outs, complaints…). */
  outcomeSignal: OutcomeSignalRepository;
  readAll?(options?: SnapshotOptions): Promise<AppData>;
  /**
   * Stage A.2 (2026-07-26) — auth storage. Provides the 5 storage ops
   * auth-service needs, provider-aware (JSON or Prisma). See AuthRepository.
   */
  auth: AuthRepository;
  /** Stage A.2 (2026-07-26) — workspace membership CRUD. */
  workspaceMember: WorkspaceMemberRepository;
  /**
   * Atomic read-mutate-write over the full AppData snapshot.
   *
   * Phase 4C: services that need to update MULTIPLE collections in one
   * consistent operation (e.g. knowledge answers + audit logs + extraction
   * runs) call this instead of touching mutateData/readData directly. In JSON
   * mode it delegates to the serialized mutateData queue. In Prisma mode it
   * reads all collections, runs the mutator in-memory, and writes back inside
   * a $transaction so partial failures roll back.
   *
   * The mutator receives a mutable AppData object and may touch any collection
   * on it. Whatever it returns is returned to the caller.
   */
  mutateAll?<T>(mutator: (data: AppData) => Promise<T> | T, options?: SnapshotOptions): Promise<T>;
  /**
   * N-BUG-4 (2026-09-05). Cap the inbound-webhook dedup log at the most recent
   * `keep` entries across all workspaces. This used to be a `.slice(-10_000)`
   * inside mutateAll, which trimmed the JSON file and never once trimmed
   * Postgres. Returns the number of rows removed.
   */
  trimProcessedWebhookMessages?(keep: number): Promise<number>;
  /**
   * 2026-09-24. Has this inbound message already been handled? One indexed
   * lookup. The dedup check used to call readAll, which on Postgres loads EVERY
   * table of EVERY workspace — once per incoming WhatsApp message.
   */
  hasProcessedWebhookMessage?(workspaceId: string, providerMessageId: string): Promise<boolean>;
  /**
   * 2026-09-24. Record a handled inbound message, once. Returns whether a row
   * was added and how many rows the log now holds (so the caller can trim).
   * Replaces a mutateAll that, on Postgres, rewrote every table per message.
   * The (workspace, message) unique index makes a concurrent second insert a
   * no-op rather than a duplicate.
   */
  recordProcessedWebhookMessage?(record: ProcessedWebhookMessageInput): Promise<{ inserted: boolean; total: number }>;
  /**
   * 2026-09-28 (S5) — erasure: blank the sender phone on this workspace's
   * duplicate-check log rows from any of these numbers (last-10-digit match).
   * The message ids stay, so a late redelivery is still recognised as a
   * duplicate. Returns how many rows were scrubbed.
   */
  scrubProcessedWebhookPhones?(workspaceId: string, phones: string[]): Promise<number>;
  /**
   * Session 55 (2026-09-09) — empty a workspace's contents, substrate-aware.
   *
   * WHY THIS IS NOT `mutateAll`. The reset first shipped as
   * `repos.mutateAll((data) => clearWorkspaceData(data, workspaceId))`, which
   * deletes on the JSON substrate and CANNOT delete on Postgres: the snapshot
   * writer there is upsert-only. The silent-removal guard caught it live with
   * "mutateAll cannot delete rows on the Postgres substrate, and 2339 row(s)
   * were dropped from the snapshot" — so "Empty this workspace" returned a 400
   * and removed nothing on the substrate production actually runs on, while
   * every test passed because they all exercised the JSON-shaped helper.
   *
   * The caller passes the collections to clear, so the route's
   * `scopeDataForExport` stays the single authority on what belongs to a
   * workspace and the two substrates cannot drift apart on that question.
   * Returns rows removed per collection. A collection this substrate cannot
   * clear MUST throw rather than be skipped — a reset that quietly leaves rows
   * behind is the defect this replaces.
   */
  clearWorkspaceCollections?(workspaceId: string, collections: readonly string[]): Promise<Record<string, number>>;
  /** Database-only unit of work. Throws roll back every nested repository write. */
  withTransaction?<T>(work: () => Promise<T>): Promise<T>;
  /** Serialize team access changes and ticket responsibility across server instances. */
  withWorkspaceTeamTransaction?<T>(workspaceId: string, work: () => Promise<T>): Promise<T>;
  /** Protect one customer's memory writes across server instances. */
  withLeadMemoryTransaction?<T>(workspaceId: string, leadId: string, work: () => Promise<T>): Promise<T>;
}

/** 2026-09-24 — one handled inbound message, for the dedup log. */
export type ProcessedWebhookMessageInput = {
  workspaceId: string;
  providerMessageId: string;
  fromPhone?: string;
  processedAt: string;
  outcome: string;
};
