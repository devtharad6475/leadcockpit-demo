import { prisma, runTx, currentPrismaClient } from "@/lib/prisma";
import { NeedsActionError } from "@/lib/user-errors";
import { optOutPhoneFilter, samePhoneForOptOut, PHONE_MATCH_DIGITS } from "@/lib/phone-match";
import { agentRunText, textMentionsCustomer, type CustomerNeedles } from "@/lib/customer-traces";
import { canonicalLeadStatus, leadStatusNames } from "@/lib/lead-status";
import { activeSnapshotSession } from "@/repositories/snapshot-session";
import { normalizeCompanySizeBucket, denormalizeCompanySizeBucket } from "@/lib/company-size";
import { DEFAULT_BUSINESS_DAYS, DEFAULT_BUSINESS_HOURS_START, DEFAULT_BUSINESS_HOURS_END, DEFAULT_CLOCK_MODE, DEFAULT_SLA_MINUTES, upgradeLegacySlaDefaults } from "@/lib/ticket-sla";
import type { AgentBehaviorPolicy, AgentRun, AgentAutonomousSettings, AIUsageLimit, AppData, AuditLog, AutoReplyLog, BusinessExtraction, BusinessProfile, BuyerSegment, Campaign, CampaignLearning, CampaignMetric, DoNotContactEntry, CompanyCommunicationSettings, CommunicationSettings, ConversationPolicy, EscalationRule, EventLog, ICP, Integration, JobRun, KnowledgeBaseChunk, KnowledgeBaseDocument, KnowledgeBaseQueryLog, KnowledgeEntry, KnowledgeExtractionBatch, KnowledgeExtractionRun, KnowledgeExtractionSource, KnowledgeExtractionSourceBundle, KnowledgeQuestionAnswer, Lead, LeadReviewDecision, LeadReviewSettings, LLMModelRouting, LLMProviderCredential, MediaCatalogItem, MessageTemplate, OutreachActivity, PendingSettingsDraft, PolicySettings, ProductSettings, ProductApplication, ProductApplicationMarketMap, ProductKnowledge, ProductVariety, ProviderAccount, Reply, SalesSettings, SettingsConflict, Ticket, TicketEvent, TicketSlaSettings, UnknownQuestion, WebsiteCrawlConsent, WebsiteCrawlJob, WebsiteCrawlPage, WhatsAppAgentSettings, WhatsAppTemplate, Workspace, WorkspaceMember, Order, Quote, User, UserCredential, PlatformTicket, PlatformTicketEvent, PlatformSupportHours, PlatformTicketSlaSettings, PlatformUserBlock, PlatformAdmin, PlatformAdminCredential, PlatformAuditLog, FeatureFlag, PasswordResetToken, ImpersonationSession, EmailVerificationToken, Invite, WorkspaceRole, OwnerCopilotConversation, OwnerCopilotMessage, FollowUp, OutcomeSignal } from "@/lib/types";
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
  CampaignMetricRepository,
  DoNotContactRepository,
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
  ProductApplicationMarketMapRepository,
  ProductApplicationRepository,
  ProductKnowledgeRepository,
  ProductSettingsRepository,
  ProductVarietyRepository,
  ProviderAccountRepository,
  PendingSettingsDraftRepository,
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
  // Stage 5 / WP1 (2026-07-28) — signup verification + invites.
  EmailVerificationTokenRepository,
  InviteRepository,
  OwnerCopilotConversationRepository,
  FollowUpRepository,
  OutcomeSignalRepository,
  OwnerCopilotMessageRepository,
  SnapshotOptions,
  ProcessedWebhookMessageInput,
  DncKeys,
} from "../interfaces";

type Delegate = {
  create(args: unknown): Promise<Record<string, unknown>>;
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  findMany(args: unknown): Promise<Record<string, unknown>[]>;
  update(args: unknown): Promise<Record<string, unknown>>;
  upsert(args: unknown): Promise<Record<string, unknown>>;
  delete(args: unknown): Promise<Record<string, unknown>>;
  updateMany?(args: unknown): Promise<unknown>;
  // R5 2026-07-21: deleteMany is required (DPDPA erasure cascade uses it).
  // Returns Prisma's standard { count: number } shape.
  deleteMany(args: unknown): Promise<{ count: number }>;
};

const model = (name: string) => (currentPrismaClient() as Record<string, Delegate>)[name];
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value || new Date().toISOString());
const jsonArray = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const jsonObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * N-BUG (2026-09-08). `readAll()` builds the workspace snapshot — the thing
 * /api/data/export hands the owner as their backup — by mapping each collection
 * through its mapper. Sixteen collections were written as a raw
 * `rows as AppData["x"]` cast instead. A cast changes the TYPE and not the
 * VALUE, so those rows went out exactly as Postgres returned them.
 *
 * Read off the live export: EIGHT populated tables, including the
 * do-not-contact registry, all four business-settings tables and every
 * knowledge-extraction table, exported `"createdAt": {}` — a Date-like object
 * with no usable JSON form — while `leads`, `tickets` and `orders`, which go
 * through mappers, exported proper ISO strings beside them.
 *
 * A backup whose timestamps are all `{}` cannot answer "when did this happen?",
 * which is most of what a backup is for, and on the compliance table it is the
 * question an audit asks.
 *
 * This converts the Postgres types the domain types promise as strings. It is
 * deliberately SHALLOW and deliberately Date-only: JSON columns are already
 * plain objects and must pass through untouched, and `null` is left alone
 * because these collections have been handing callers `null` all along —
 * changing that is a separate decision, not a bug fix. A collection with a real
 * mapper should use it; this is the floor beneath the ones that have none.
 */
const datesToIso = <T>(records: Record<string, unknown>[]): T[] =>
  records.map((record) => {
    let copy: Record<string, unknown> | undefined;
    for (const key of Object.keys(record)) {
      const value = record[key];
      // Postgres hands back a Date and a null; the domain type says an ISO
      // string and undefined. Doing only the first half would leave this
      // helper making the same silent promise the raw cast made.
      if (value instanceof Date) {
        copy = copy || { ...record };
        copy[key] = value.toISOString();
      } else if (value === null) {
        copy = copy || { ...record };
        copy[key] = undefined;
      }
    }
    return (copy || record) as unknown as T;
  }) as T[];

// N-BUG-1 (2026-09-04) — a knowledge answer's evidence is read back from a JSON
// column that holds `{}` when there was never any evidence to store. Callers
// treat `evidenceJson` as "present or absent", so an object with no `sources`
// array is the one shape none of them defends against. Every read goes through
// here so `sources` is always an array.
function normaliseEvidence(value: Record<string, unknown>): KnowledgeQuestionAnswer["evidenceJson"] {
  const sources = Array.isArray(value.sources) ? value.sources : [];
  return { ...value, sources } as unknown as KnowledgeQuestionAnswer["evidenceJson"];
}

/**
 * Remove the raw Prisma column name from a mapped row.
 *
 * WHY (N-DATA-2, 2026-08-18): several mappers are written as
 * `{ ...record, config: jsonObject(record.configJson) }`. The spread copies
 * `configJson` in and the override adds `config` next to it, so the row goes
 * out carrying the SAME value under two names — one of which the domain type
 * does not declare. Nothing reads `.configJson`, so it stayed invisible until
 * the JSON→Postgres migration verifier compared a written row against its JSON
 * source and reported it as changed purely because Postgres had an extra key.
 *
 * Only strips `<name>Json` when `<name>` is actually present, so a field whose
 * REAL domain name ends in Json (unknownQuestions.conflictSourcesJson) survives.
 */
function stripRawJsonColumns<T>(row: T): T {
  const out = row as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (!key.endsWith("Json")) continue;
    if (key.slice(0, -4) in out) delete out[key];
  }
  return row;
}

/**
 * L-1 ROOT FIX (2026-08-04 build-right audit, supersedes the prior "raise the
 * timeout" recommendation). persistSnapshot was writing EVERY row as a
 * separate awaited upsert — N sequential network round-trips to Neon
 * (500 knowledge answers + 200 audit logs + … = 700+ round-trips = 70+s),
 * which exceeded even the 45s TX_OPTS timeout. Raising the timeout further
 * would make every snapshot slow + fragile (build-right 10x Scale Check).
 *
 * This helper is the CHOKEPOINT for batched Prisma upserts:
 *   1. Empty array → return immediately (no round-trip at all).
 *   2. Non-empty → chunk the items (default 50) and run each chunk's upserts
 *      CONCURRENTLY via Promise.all, inside the caller's transaction. Prisma's
 *      `upsert` has no native batch form, but concurrent round-trips within a
 *      transaction are safe + cut wall-clock from ~O(N) to ~O(N/chunkSize).
 *      700 rows at chunkSize 50 → ~14 parallel batches → a few seconds.
 *
 * Note on chunk size: 50 balances throughput vs Neon's per-transaction
 * connection limits. Higher = fewer batches but more concurrent statements;
 * lower = safer but slower. 50 is conservative for the free tier.
 */
async function batchUpsert<T>(
  modelName: string,
  items: T[] | undefined,
  buildArgs: (item: T) => { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> },
  chunkSize = 50,
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  const delegate = model(modelName);
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    // Parallel upserts within the chunk — all share the caller's transaction.
    await Promise.all(
      chunk.map((item) => delegate.upsert(withSuppliedCreatedAt(item, buildArgs(item)))),
    );
  }
}

/**
 * N-DATA-2 (2026-08-18): carry a supplied `createdAt` into the create half of a
 * batched upsert.
 *
 * The JSON substrate states the contract at ~40 sites as
 * `createdAt: input.createdAt || timestamp()`. Every batchUpsert create literal
 * omitted createdAt, so Postgres fell through to @default(now()) and re-dated
 * the row. The N-DATA-2 migration surfaced it: 1178 migrated rows — audit logs,
 * event logs, knowledge answers — came back stamped with the migration's own
 * clock instead of when they actually happened.
 *
 * Applied here rather than at the 15 call sites because batchUpsert is already
 * the documented chokepoint and every model routed through it has created_at.
 * Only fills the gap: a create literal that sets createdAt itself wins, and the
 * update half is never touched (an upsert must not re-date an existing row).
 */
/**
 * The CREATE half of a workspace-singleton upsert.
 *
 * WHY (N-DATA-2, 2026-08-18). Five settings repositories are written as
 * `existing ? update({ where: { id: existing.id }, data: payload }) :
 * create({ data: payload })`, and `payload` is built field by field from the
 * input — every field except `id` and `createdAt`. So a row created through
 * these paths is born with a generated cuid and the clock's idea of now, no
 * matter what it was called or when it was actually made.
 *
 * On the JSON substrate the same row keeps the id it was given (`tss_demo`,
 * `wa_settings_demo`). The two substrates therefore disagreed about the
 * identity of the same settings row, and the JSON→Postgres migration could
 * not converge: it planned a create for an id Postgres would never have, the
 * create was rejected by the unique constraint on workspaceId, and re-running
 * produced the identical plan.
 *
 * Only the create half. Changing the id of a row that already exists is not
 * something an update call should be able to do.
 */
function singletonCreateData(
  input: { id?: string; createdAt?: string },
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...payload,
    ...(input.id ? { id: input.id } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

function withSuppliedCreatedAt<T>(
  item: T,
  args: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> },
) {
  const supplied = (item as Record<string, unknown> | null | undefined)?.createdAt;
  if (supplied === undefined) return args;
  if (args.create.createdAt === undefined) args.create.createdAt = supplied;
  // N-DATA-2: the UPDATE half needs it as well. batchUpsert is reached from
  // persistSnapshot, whose semantics are "here is the whole row" — on the JSON
  // substrate mutateAll simply replaces the record, creation time included, so
  // a row that already existed keeps whatever createdAt the caller handed over.
  // Filling only the create half meant a row that was ALREADY in Postgres kept
  // the wrong creation time forever: user_owner stayed at 14:05:18 when the
  // source said 16:13:20, and no number of re-runs could correct it.
  if (args.update.createdAt === undefined) args.update.createdAt = supplied;
  return args;
}

async function assertScoped(delegate: Delegate, workspaceId: string, id: string, label: string) {
  const record = await delegate.findFirst({ where: { id, workspaceId } });
  if (!record) throw new Error(`${label} not found`);
  return record;
}

function mapWorkspace(record: Record<string, unknown>): Workspace {
  return { ...record, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) } as Workspace;
}

/**
 * Normalize a Workspace partial-update payload for Prisma.
 *
 * WHY (Stage 6 / 2026-07-31 — split-brain field-clearing bug): Prisma treats
 * `{ field: undefined }` in `.update()` as "don't touch this field", but the
 * JSON runtime (Object.assign) treats it as "clear it". So a service that
 * passes `suspendedAt: undefined` to CLEAR the field (e.g. resumeWorkspace)
 * worked in JSON/demo mode but silently did NOTHING in Postgres — the field
 * kept its old value. This made the kill-switch RESTORE not cleanly clear the
 * suspend stamps (golden:prisma-field-clearing CASE A).
 *
 * FIX: for the documented nullable "clearable" fields, an explicit `undefined`
 * means "clear it" → map to Prisma `null`. Other fields pass through unchanged
 * (an undefined there still means "don't touch", preserving the safe default).
 * We enumerate the clearable set explicitly so a stray undefined on a
 * non-clearable field cannot accidentally null it.
 */
const WORKSPACE_CLEARABLE_FIELDS = ["suspendedAt", "suspendedByAdminId"] as const;
function clearableWorkspaceUpdate(data: Partial<Workspace>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const field of WORKSPACE_CLEARABLE_FIELDS) {
    if (out[field] === undefined) {
      // The caller explicitly passed undefined for a clearable field (the key is
      // present). JSON mode clears it; mirror that in Postgres with null. NOTE:
      // we only map when the key is actually present in the input — a field the
      // caller never mentioned stays untouched (Prisma's undefined = ignore).
      if (field in data) out[field] = null;
    }
  }
  return out;
}

// 2026-08-05 audit fix (F-DATA-22) — the workspace Ticket had the SAME
// clearable-field divergence that was fixed for Workspace (above) and for
// PlatformTicket (`updateForOperator` maps resolvedAt/closedAt → null). On
// reopen, `changeTicketStatus` sets `patch.resolvedAt = undefined`; the JSON
// repo clears it via Object.assign, but Prisma's `update({data:{resolvedAt:
// undefined}})` SILENTLY ignores the key — leaving the stale resolvedAt on a
// reopened ticket (wrong "Resolved at …" label + wrong SLA clock). Same
// clearable pattern, same one-line-per-field fix.
// 2026-09-26 (break test): "assignedTo" too — choosing "Unassigned" sent
// assignedTo: undefined, which Postgres ignored, so the ticket stayed assigned.
const TICKET_CLEARABLE_FIELDS = ["resolvedAt", "closedAt", "firstRespondedAt", "assignedTo"] as const;
function clearableTicketUpdate(data: Partial<Ticket>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const field of TICKET_CLEARABLE_FIELDS) {
    if (out[field] === undefined && field in data) {
      out[field] = null;
    }
  }
  return out;
}

function profileData(input: Partial<BusinessProfile>) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    companyName: input.companyName,
    websiteUrl: input.websiteUrl,
    industry: input.industry,
    businessType: input.businessType,
    description: input.description,
    productsJson: input.products,
    servicesJson: input.services,
    productCategoriesJson: input.productCategories,
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    whatsappNumber: input.whatsappNumber,
    address: input.address,
    city: input.city,
    state: input.state,
    country: input.country,
    targetGeographiesJson: input.targetGeographies,
    currentCustomerTypesJson: input.currentCustomerTypes,
    desiredCustomerTypesJson: input.desiredCustomerTypes,
    strengthsJson: input.strengths,
    limitationsJson: input.limitations,
    certificationsJson: input.certifications,
    socialLinksJson: input.socialLinks,
    catalogueLinksJson: input.catalogueLinks,
    proofAssetsJson: input.proofAssets,
    languagePreference: input.languagePreference,
    tonePreference: input.tonePreference,
    status: input.status,
    // M3.x / 2026-07-20: persist profile fields so they survive round-trip.
    fieldsJson: input.fields,
    checklistKinds: input.checklistKinds,
    checklistExports: input.checklistExports,
    checklistConfirmedAt: input.checklistConfirmedAt ? new Date(input.checklistConfirmedAt) : input.checklistConfirmedAt === null ? null : undefined,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

function mapProfile(record: Record<string, unknown>): BusinessProfile {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    companyName: record.companyName as string | undefined,
    websiteUrl: record.websiteUrl as string | undefined,
    industry: record.industry as string | undefined,
    businessType: record.businessType as string | undefined,
    description: record.description as string | undefined,
    products: jsonArray(record.productsJson),
    services: jsonArray(record.servicesJson),
    productCategories: jsonArray(record.productCategoriesJson),
    contactEmail: record.contactEmail as string | undefined,
    contactPhone: record.contactPhone as string | undefined,
    whatsappNumber: record.whatsappNumber as string | undefined,
    address: record.address as string | undefined,
    city: record.city as string | undefined,
    state: record.state as string | undefined,
    country: record.country as string | undefined,
    targetGeographies: jsonArray(record.targetGeographiesJson),
    currentCustomerTypes: jsonArray(record.currentCustomerTypesJson),
    desiredCustomerTypes: jsonArray(record.desiredCustomerTypesJson),
    strengths: jsonArray(record.strengthsJson),
    limitations: jsonArray(record.limitationsJson),
    certifications: jsonArray(record.certificationsJson),
    socialLinks: jsonArray(record.socialLinksJson),
    catalogueLinks: jsonArray(record.catalogueLinksJson),
    proofAssets: jsonArray(record.proofAssetsJson),
    languagePreference: String(record.languagePreference || "English"),
    tonePreference: String(record.tonePreference || "Warm, concise, businesslike"),
    status: record.status as BusinessProfile["status"],
    // M3.x / 2026-07-20: restore profile fields from JSON column instead of
    // always returning empty.
    fields: (record.fieldsJson as BusinessProfile["fields"]) || [],
    checklistKinds: Array.isArray(record.checklistKinds) ? (record.checklistKinds as string[]) : [],
    checklistExports: Boolean(record.checklistExports),
    checklistConfirmedAt: record.checklistConfirmedAt ? iso(record.checklistConfirmedAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

/**
 * Strip the fields a row is IDENTIFIED and OWNED by before an update.
 *
 * WHY (2026-09-09, session 55). The `*Data()` builders are shared between
 * `create` and `update`, and a create needs `id`, `workspaceId` and the
 * creation time. Prisma refuses those on an update — "Unknown argument
 * `workspaceId`. Did you mean `workspace`?" — so every ICP edit through
 * PUT /api/icp/:id answered 500 on Postgres, for as long as the Prisma
 * substrate has existed. Found by typing into "Who you do NOT sell to" and
 * pressing save; no test caught it because the JSON substrate merges the
 * patch onto the row and simply overwrites those three fields with the same
 * values they already held.
 *
 * Dropping them is also the behaviour we want on its own terms: an update is
 * allowed to change what a record SAYS, never which workspace owns it, which
 * row it is, or when it was created. A patch that carries those (the API
 * echoes the whole object back on save) is asking for a no-op, not a move.
 */
function withoutOwnershipFields<T extends Record<string, unknown>>(data: T): Omit<T, "id" | "workspaceId" | "createdAt"> {
  const { id: _id, workspaceId: _workspaceId, createdAt: _createdAt, ...rest } = data;
  return rest;
}

function icpData(input: Partial<ICP>) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    businessProfileId: input.businessProfileId,
    name: input.name,
    description: input.description,
    buyerType: input.buyerType,
    industriesJson: input.industries,
    geographyJson: input.geography,
    companySizeBucket: normalizeCompanySizeBucket(input.companySizeBucket),
    likelyNeedsJson: input.likelyNeeds,
    buyingTriggersJson: input.buyingTriggers,
    painPointsJson: input.painPoints,
    preferredChannelsJson: input.preferredChannels,
    messagingAnglesJson: input.messagingAngles,
    qualificationRulesJson: input.qualificationRules,
    exclusionsJson: input.exclusions,
    confidenceScore: input.confidenceScore,
    status: input.status,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

function mapICP(record: Record<string, unknown>): ICP {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    businessProfileId: String(record.businessProfileId),
    name: String(record.name || ""),
    description: String(record.description || ""),
    buyerType: String(record.buyerType || ""),
    industries: jsonArray(record.industriesJson),
    geography: jsonArray(record.geographyJson),
    // N-DATA-2: the enum label (small_company) is not a member of the domain
    // union; the cast that used to be here hid that. Map it back.
    companySizeBucket: denormalizeCompanySizeBucket(record.companySizeBucket),
    likelyNeeds: jsonArray(record.likelyNeedsJson),
    buyingTriggers: jsonArray(record.buyingTriggersJson),
    painPoints: jsonArray(record.painPointsJson),
    preferredChannels: jsonArray(record.preferredChannelsJson),
    messagingAngles: jsonArray(record.messagingAnglesJson),
    qualificationRules: jsonArray(record.qualificationRulesJson),
    exclusions: jsonArray(record.exclusionsJson),
    confidenceScore: Number(record.confidenceScore || 0),
    status: record.status as ICP["status"],
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function campaignData(input: Partial<Campaign>) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    businessProfileId: input.businessProfileId,
    icpId: input.icpId,
    name: input.name,
    goal: input.goal,
    targetRegionJson: input.targetRegion,
    productFocusJson: input.productFocus,
    offer: input.offer,
    selectedChannelsJson: input.selectedChannels,
    dailyOutreachLimit: input.dailyOutreachLimit,
    leadGoal: input.leadGoal,
    status: input.status,
    approvalStatus: input.approvalStatus,
    planJson: input.plan,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

function mapCampaign(record: Record<string, unknown>): Campaign {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    businessProfileId: String(record.businessProfileId),
    icpId: String(record.icpId),
    name: String(record.name || ""),
    goal: String(record.goal || ""),
    targetRegion: jsonArray(record.targetRegionJson),
    productFocus: jsonArray(record.productFocusJson),
    offer: String(record.offer || ""),
    selectedChannels: jsonArray(record.selectedChannelsJson),
    dailyOutreachLimit: Number(record.dailyOutreachLimit || 0),
    leadGoal: Number(record.leadGoal || 0),
    status: record.status as Campaign["status"],
    approvalStatus: record.approvalStatus as Campaign["approvalStatus"],
    plan: jsonObject(record.planJson) as Campaign["plan"],
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function leadData(input: Partial<Lead>) {
  // M3.x / 2026-07-20: enrichmentResult is now persisted in its own JSON
  // column (enrichment_result_json) instead of being destructured out and
  // silently dropped. Same for relevancyReason (now its own column).
  const { scoreReason, enrichmentResult, relevancyReason, discoveryState, discoveryExtras, ...rest } = input;
  return {
    ...rest,
    // 2026-09-28 (L10): one stored name per stage (won, lost, discovered).
    ...(rest.status ? { status: canonicalLeadStatus(rest.status) } : {}),
    companySizeBucket: normalizeCompanySizeBucket(input.companySizeBucket),
    scoreReasonJson: scoreReason,
    enrichmentResultJson: enrichmentResult,
    relevancyReason: relevancyReason,
    // N11: its own JSON column, named out of the spread like the others above.
    discoveryStateJson: discoveryState,
    discoveryExtrasJson: discoveryExtras,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

function mapLead(record: Record<string, unknown>): Lead {
  // M3.x / 2026-07-20: restore enrichmentResult + relevancyReason from their
  // JSON columns on read. Previously dropped silently.
  // N-DATA-2: scoreReasonJson has to come out of the spread too. It was left
  // in, so a mapped lead carried BOTH `scoreReason` (the domain field, added
  // below) and the raw `scoreReasonJson` column next to it — a field the Lead
  // type does not declare, on all 15 leads.
  const { enrichmentResultJson, relevancyReason, scoreReasonJson: _scoreReasonJson, discoveryStateJson, discoveryExtrasJson, ...rest } =
    record as Record<string, unknown>;
  void _scoreReasonJson;
  return {
    ...(rest as unknown as Lead),
    enrichmentResult: enrichmentResultJson as Lead["enrichmentResult"],
    relevancyReason: relevancyReason as string | undefined,
    scoreReason: jsonObject(record.scoreReasonJson),
    // N-DATA-2: came through raw on the spread above, so a Postgres lead
    // reported "small_company" where the same JSON lead reported "small company".
    companySizeBucket: denormalizeCompanySizeBucket(record.companySizeBucket),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    lastContactedAt: record.lastContactedAt ? iso(record.lastContactedAt) : undefined,
    // CP-24: parse lastInboundAt the same way as lastContactedAt so the window
    // gate gets a real ISO string, not a Prisma Date object.
    lastInboundAt: record.lastInboundAt ? iso(record.lastInboundAt) : undefined,
    nextFollowUpAt: record.nextFollowUpAt ? iso(record.nextFollowUpAt) : undefined,
    // N4: a Date out of Postgres, an ISO string everywhere else. Without this
    // the owner's screen would render a Prisma Date object.
    conversationMemoryAt: record.conversationMemoryAt ? iso(record.conversationMemoryAt) : undefined,
    // N11: out of its column and back into the domain field name.
    //
    // The emptiness check is not tidiness. `jsonObject` returns {} for a NULL
    // column, and {} is truthy — so every lead nobody has ever spoken to would
    // report "we have discovery state", the screen would render its empty-state
    // for the wrong reason, and the JSON substrate (which leaves the field
    // undefined) would disagree with Postgres about the same lead.
    discoveryState: (() => {
      const parsed = jsonObject(discoveryStateJson);
      return Object.keys(parsed).length ? (parsed as Lead["discoveryState"]) : undefined;
    })(),
    // N12: an array or nothing. Same reason as above — a NULL column must not
    // read as "this lead has lines of its own".
    discoveryExtras: Array.isArray(discoveryExtrasJson) && discoveryExtrasJson.length
      ? (discoveryExtrasJson as Lead["discoveryExtras"])
      : undefined,
  };
}

/**
 * 2026-09-01 (N-DATA-23) — was `{ ...rest }`, a blind spread of whatever the
 * caller passed. One caller passed `missingInformation`, which is not a column
 * on MessageTemplate, and Prisma rejected the entire write with
 * `Unknown argument 'missingInformation'` — so every message generation
 * returned 500 against Postgres while staying green on the JSON provider,
 * which ignores unknown keys.
 *
 * Now the columns are named. A caller passing a stray key gets it dropped
 * instead of taking the write down, and a NEW column added to the schema is a
 * one-line addition here rather than a silent no-op — which is the trade this
 * project already made for settings writes (ExtractionRoutingService).
 */
function messageData(input: Partial<MessageTemplate>) {
  const { personalizationUsed, workspaceId, campaignId, leadId, channel, subject, body, tone, language, status, id } = input;
  const data: Record<string, unknown> = { personalizationUsedJson: personalizationUsed };
  if (id !== undefined) data.id = id;
  if (workspaceId !== undefined) data.workspaceId = workspaceId;
  if (campaignId !== undefined) data.campaignId = campaignId;
  if (leadId !== undefined) data.leadId = leadId;
  if (channel !== undefined) data.channel = channel;
  if (subject !== undefined) data.subject = subject;
  if (body !== undefined) data.body = body;
  if (tone !== undefined) data.tone = tone;
  if (language !== undefined) data.language = language;
  if (status !== undefined) data.status = status;
  return data;
}

function mapMessage(record: Record<string, unknown>): MessageTemplate {
  return stripRawJsonColumns({ ...(record as unknown as MessageTemplate), personalizationUsed: jsonObject(record.personalizationUsedJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
}

function mapReply(record: Record<string, unknown>): Reply {
  return { ...(record as unknown as Reply), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapOutreach(record: Record<string, unknown>): OutreachActivity {
  return {
    ...(record as unknown as OutreachActivity),
    activityAt: record.activityAt ? iso(record.activityAt) : iso(record.createdAt),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function crawlJobData(input: Partial<WebsiteCrawlJob>) {
  return { ...input };
}

function mapCrawlJob(record: Record<string, unknown>): WebsiteCrawlJob {
  return {
    ...(record as unknown as WebsiteCrawlJob),
    startedAt: record.startedAt ? iso(record.startedAt) : undefined,
    completedAt: record.completedAt ? iso(record.completedAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function crawlPageData(input: Partial<WebsiteCrawlPage>) {
  const { metadata, ...rest } = input;
  return { ...rest, metadataJson: metadata };
}

function mapCrawlPage(record: Record<string, unknown>): WebsiteCrawlPage {
  return {
    id: String(record.id),
    crawlJobId: String(record.crawlJobId),
    workspaceId: String(record.workspaceId),
    url: String(record.url || ""),
    title: record.title as string | undefined,
    cleanedText: String(record.cleanedText || ""),
    metadata: jsonObject(record.metadataJson),
    createdAt: iso(record.createdAt),
  };
}

function extractionData(input: Partial<BusinessExtraction>) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    crawlJobId: input.crawlJobId,
    extractedCompanyName: input.extractedCompanyName,
    extractedIndustry: input.extractedIndustry,
    extractedProductsJson: input.extractedProducts,
    extractedServicesJson: input.extractedServices,
    extractedContactsJson: input.extractedContacts,
    extractedLocationsJson: input.extractedLocations,
    extractedSocialsJson: input.extractedSocials,
    extractedStrengthsJson: input.extractedStrengths,
    extractedTargetCustomersJson: input.extractedTargetCustomers,
    extractedCertificationsJson: input.extractedCertifications,
    extractedCatalogueLinksJson: input.extractedCatalogueLinks,
    confidenceJson: input.confidence,
    missingFieldsJson: input.missingFields,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

function mapExtraction(record: Record<string, unknown>): BusinessExtraction {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    crawlJobId: record.crawlJobId as string | undefined,
    extractedCompanyName: record.extractedCompanyName as string | undefined,
    extractedIndustry: record.extractedIndustry as string | undefined,
    extractedProducts: jsonArray(record.extractedProductsJson),
    extractedServices: jsonArray(record.extractedServicesJson),
    extractedContacts: jsonObject(record.extractedContactsJson),
    extractedLocations: jsonArray(record.extractedLocationsJson),
    extractedSocials: jsonArray(record.extractedSocialsJson),
    extractedStrengths: jsonArray(record.extractedStrengthsJson),
    extractedTargetCustomers: jsonArray(record.extractedTargetCustomersJson),
    extractedCertifications: jsonArray(record.extractedCertificationsJson),
    extractedCatalogueLinks: jsonArray(record.extractedCatalogueLinksJson),
    confidence: jsonObject(record.confidenceJson),
    missingFields: jsonArray(record.missingFieldsJson),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function learningData(input: Partial<CampaignLearning>) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    summary: input.summary,
    winningPatternsJson: input.winningPatterns,
    losingPatternsJson: input.losingPatterns,
    recommendedNextStepsJson: input.recommendedNextSteps,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

function mapLearning(record: Record<string, unknown>): CampaignLearning {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    campaignId: String(record.campaignId),
    summary: String(record.summary || ""),
    winningPatterns: jsonArray(record.winningPatternsJson),
    losingPatterns: jsonArray(record.losingPatternsJson),
    recommendedNextSteps: jsonArray(record.recommendedNextStepsJson),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function metricData(input: Partial<CampaignMetric>) {
  return { ...input };
}

function mapMetric(record: Record<string, unknown>): CampaignMetric {
  return {
    ...(record as unknown as CampaignMetric),
    calculatedAt: iso(record.calculatedAt),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function eventLogData(input: Partial<EventLog>) {
  const { payload, metadata, ...rest } = input;
  return { ...rest, payloadJson: payload, metadataJson: metadata };
}

function mapEventLog(record: Record<string, unknown>): EventLog {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    eventType: String(record.eventType || ""),
    entityType: record.entityType as string | undefined,
    entityId: record.entityId as string | undefined,
    payload: jsonObject(record.payloadJson),
    metadata: jsonObject(record.metadataJson),
    status: String(record.status || "recorded"),
    createdAt: iso(record.createdAt),
  };
}

// Phase 4C: mappers for the collections the 6 split-brain services touch.
function mapAuditLog(record: Record<string, unknown>): AuditLog {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    actorUserId: record.actorUserId as string | undefined,
    eventType: String(record.eventType || ""),
    entityType: record.entityType as string | undefined,
    entityId: record.entityId as string | undefined,
    payload: jsonObject(record.payloadJson),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function mapKnowledgeQuestionAnswer(record: Record<string, unknown>): KnowledgeQuestionAnswer {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    domainKey: String(record.domainKey || ""),
    questionKey: String(record.questionKey || ""),
    question: String(record.question || ""),
    answer: record.answer as string | undefined,
    answerStatus: String(record.answerStatus || "unanswered") as KnowledgeQuestionAnswer["answerStatus"],
    sourceType: String(record.sourceType || "document") as KnowledgeQuestionAnswer["sourceType"],
    sourceId: record.sourceId as string | undefined,
    sourceTitle: record.sourceTitle as string | undefined,
    sourceUrl: record.sourceUrl as string | undefined,
    sourceFileName: record.sourceFileName as string | undefined,
    confidenceScore: Number(record.confidenceScore || 0),
    usedByAgentsJson: jsonObject(record.usedByAgentsJson),
    mapsToJson: jsonObject(record.mapsToJson),
    humanReviewRequired: Boolean(record.humanReviewRequired),
    sourceSnippet: record.sourceSnippet as string | undefined,
    conflictWithExisting: record.conflictWithExisting as boolean | undefined,
    conflictReason: record.conflictReason as string | undefined,
    reviewedByUser: record.reviewedByUser as string | undefined,
    reviewedAt: record.reviewedAt ? iso(record.reviewedAt) : undefined,
    isUserApproved: record.isUserApproved as boolean | undefined,
    isCanonical: record.isCanonical as boolean | undefined,
    supersededByAnswerId: record.supersededByAnswerId as string | undefined,
    mergedFromAnswerIds: Array.isArray(record.mergedFromAnswerIds) ? record.mergedFromAnswerIds as string[] : undefined,
    // 2026-09-04 N-BUG-1 — this returned whatever the column held, and the
    // column holds `{}` for every answer saved without evidence (see the write
    // mapping below). `{}` is truthy but has no `sources`, so every caller that
    // reasonably wrote `evidenceJson ||= { sources: [] }` was handed an object
    // that passed the guard and then blew up on `.sources`.
    //
    // That crashed document extraction outright: uploading any document threw
    // "Cannot read properties of undefined (reading 'some')", surfaced to the
    // operator as "the configured LLM did not complete" — a message pointing at
    // the wrong thing entirely. It only happened on the Postgres substrate,
    // which is the one that actually runs, and never in JSON mode, which is what
    // the end-to-end suite pins. So the shape is normalised on the way OUT,
    // once, rather than guarded at each of the callers.
    evidenceJson: record.evidenceJson ? normaliseEvidence(jsonObject(record.evidenceJson)) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function mapKnowledgeEntry(record: Record<string, unknown>): KnowledgeEntry {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    questionId: String(record.questionId || ""),
    questionText: String(record.questionText || ""),
    answer: String(record.answer || ""),
    domain: String(record.domain || ""),
    confidence: Number(record.confidence || 1),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

/**
 * The write-side twin of mapUnknownQuestion. Kept immediately next to it so the
 * two cannot drift again — they already did once (N-DATA-2): the read side was
 * updated for the M3.x parity fields and the persistSnapshot write side was not.
 */
function unknownQuestionParityFields(item: UnknownQuestion): Record<string, unknown> {
  return {
    generatedBy: item.generatedBy ?? null,
    relatedDomain: item.relatedDomain ?? null,
    relatedQuestionKey: item.relatedQuestionKey ?? null,
    conflictSourcesJson: item.conflictSourcesJson ?? undefined,
    sourceIdsJson: item.sourceIds ?? undefined,
    sourceDocumentId: item.sourceDocumentId ?? null,
    priority: item.priority ?? null,
    convertedToTicketId: item.convertedToTicketId ?? null,
  };
}

function mapUnknownQuestion(record: Record<string, unknown>): UnknownQuestion {
  // M3.x / 2026-07-20 parity: restore the 7 fields that were previously
  // silently dropped on Prisma read.
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    leadId: record.leadId as string | undefined,
    conversationId: record.conversationId as string | undefined,
    channel: String(record.channel || "manual"),
    questionText: String(record.questionText || ""),
    missingTopic: record.missingTopic as string | undefined,
    status: String(record.status || "open") as UnknownQuestion["status"],
    suggestedAnswer: record.suggestedAnswer as string | undefined,
    finalAnswer: record.finalAnswer as string | undefined,
    generatedBy: record.generatedBy as UnknownQuestion["generatedBy"],
    relatedDomain: record.relatedDomain as string | undefined,
    relatedQuestionKey: record.relatedQuestionKey as string | undefined,
    conflictSourcesJson: record.conflictSourcesJson as UnknownQuestion["conflictSourcesJson"],
    sourceIds: (record.sourceIdsJson as string[] | undefined) || (Array.isArray(record.sourceIds) ? record.sourceIds as string[] : undefined),
    sourceDocumentId: record.sourceDocumentId as string | undefined,
    priority: record.priority as UnknownQuestion["priority"],
    // N-BUG (2026-09-08) — this line was missing while the write side
    // (unknownQuestionParityFields) persisted the column. Postgres therefore
    // stored the link and never gave it back, so the convert route's guard
    //     if (source.record.convertedToTicketId) -> 409
    // could not fire: POST /unknown-questions/:id/convert returned 200 every
    // time and created ANOTHER ticket for the same question. Reproduced on the
    // fixture database — one question, tickets #4 and #5. JSON mode kept the
    // field, so the suite stayed green. The comment above this function says
    // the read and write sides "cannot drift again — they already did once".
    // They drifted again, on this field.
    convertedToTicketId: record.convertedToTicketId as string | undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function mapKnowledgeBaseDocument(record: Record<string, unknown>): KnowledgeBaseDocument {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    title: String(record.title || ""),
    documentType: String(record.documentType || "company_fact"),
    source: record.source as string | undefined,
    status: String(record.status || "active") as KnowledgeBaseDocument["status"],
    contentText: String(record.contentText || ""),
    metadata: jsonObject(record.metadataJson),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function mapKnowledgeBaseChunk(record: Record<string, unknown>): KnowledgeBaseChunk {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    documentId: String(record.documentId || ""),
    chunkIndex: Number(record.chunkIndex || 0),
    chunkText: String(record.chunkText || ""),
    metadata: jsonObject(record.metadataJson),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function jobRunData(input: Partial<JobRun>) {
  const { payload, result, ...rest } = input;
  return { ...rest, payloadJson: payload, resultJson: result };
}

function mapJobRun(record: Record<string, unknown>): JobRun {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    jobType: String(record.jobType || ""),
    status: String(record.status || ""),
    payload: jsonObject(record.payloadJson),
    result: jsonObject(record.resultJson),
    attempts: Number(record.attempts || 0),
    maxAttempts: Number(record.maxAttempts || 3),
    errorMessage: record.errorMessage as string | undefined,
    startedAt: record.startedAt ? iso(record.startedAt) : undefined,
    completedAt: record.completedAt ? iso(record.completedAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function agentRunData(input: Partial<AgentRun>) {
  const { input: inputJsonSource, output, ...rest } = input;
  return { ...rest, inputJson: inputJsonSource, outputJson: output };
}

function mapAgentRun(record: Record<string, unknown>): AgentRun {
  return stripRawJsonColumns({
    ...(record as unknown as AgentRun),
    input: jsonObject(record.inputJson),
    output: jsonObject(record.outputJson),
    startedAt: record.startedAt ? iso(record.startedAt) : iso(record.createdAt),
    completedAt: record.completedAt ? iso(record.completedAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  });
}

function auditData(input: Partial<AuditLog>) {
  const { payload, ...rest } = input;
  return { ...rest, payloadJson: payload };
}

export class WorkspacePrismaRepository implements WorkspaceRepository {
  async getById(id: string) {
    const record = await model("workspace").findFirst({ where: { id } });
    return record ? mapWorkspace(record) : undefined;
  }
  async getDefault() {
    const record = await model("workspace").findFirst({});
    return record ? mapWorkspace(record) : undefined;
  }
  async create(input: Partial<Workspace>) {
    return mapWorkspace(await model("workspace").create({ data: input }));
  }
  async update(id: string, data: Partial<Workspace>) {
    return mapWorkspace(await model("workspace").update({ where: { id }, data: clearableWorkspaceUpdate(data) }));
  }
  /**
   * N-DATA-2 (2026-08-18) — delete a workspace and everything under it.
   *
   * The database does the cascade: checked every `workspace Workspace @relation`
   * declaration in prisma/schema.prisma and all 68 of 68 carry
   * `onDelete: Cascade`, so one delete removes every child row. That is why this
   * is four lines and the JSON implementation is a hand-written sweep.
   *
   * deletedRows is reported as 0 here ON PURPOSE, and the interface says so:
   * Postgres does not tell us how many child rows the cascade removed without a
   * counting query per table, and running 68 counts to produce a number nobody
   * reads would be worse than being honest. The parity golden therefore compares
   * OBSERVABLE state after the delete (rows are gone on both substrates), not
   * this counter.
   *
   * Absent workspace is not an error — see the interface contract. Prisma raises
   * P2025 ("record to delete does not exist"); anything else is a real failure
   * and is rethrown rather than swallowed.
   */
  async delete(id: string) {
    try {
      await model("workspace").delete({ where: { id } });
      return { deleted: true, deletedRows: 0 };
    } catch (error) {
      if ((error as { code?: string })?.code === "P2025") return { deleted: false, deletedRows: 0 };
      throw error;
    }
  }
  // 2026-07-21 (Cluster A fix, session 16) — feed the assignTicket round-robin.
  // Stage A.1 (2026-07-26) — REAL implementation. The WorkspaceMember Prisma
  // model now exists (added this stage). The previous impl returned [] because
  // there was no table to query; round-robin ticket assignment silently
  // no-op'd in Prisma mode. Now queries the new table. Pinned by
  // golden:prisma-commercial-parity CASE 7.
  async listActiveStaffForWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await model("workspaceMember").findMany({ where: { workspaceId, status: "active" } });
    return rows.map((record: Record<string, unknown>) => ({
      id: String(record.id),
      workspaceId: String(record.workspaceId),
      userId: String(record.userId),
      email: String(record.email),
      name: record.name as string | undefined,
      role: record.role as WorkspaceMember["role"],
      status: (record.status as WorkspaceMember["status"]) || "active",
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    }));
  }
  // Stage 5 / WP2 (2026-07-28) — operator console: list EVERY workspace
  // (cross-tenant). Default excludes suspended; includeSuspended reveals.
  // Order: created desc. NOT paginated in WP2 (tenant count is small).
  async listAll(includeSuspended = false): Promise<Workspace[]> {
    const where = includeSuspended ? {} : { NOT: { status: "suspended" } };
    const rows = await model("workspace").findMany({ where, orderBy: { createdAt: "desc" } });
    return rows.map((r: Record<string, unknown>) => mapWorkspace(r));
  }
}

export class BusinessProfilePrismaRepository implements BusinessProfileRepository {
  async getByWorkspace(workspaceId: string) {
    const record = await model("businessProfile").findFirst({ where: { workspaceId } });
    return record ? mapProfile(record) : undefined;
  }
  async create(input: Partial<BusinessProfile>) {
    return mapProfile(await model("businessProfile").create({ data: profileData(input) }));
  }
  async update(workspaceId: string, profileId: string, data: Partial<BusinessProfile>) {
    await assertScoped(model("businessProfile"), workspaceId, profileId, "Business profile");
    return mapProfile(await model("businessProfile").update({ where: { id: profileId }, data: withoutOwnershipFields(profileData(data)) }));
  }
  async approve(workspaceId: string, profileId: string) {
    return this.update(workspaceId, profileId, { status: "approved" });
  }
}

export class ICPPrismaRepository implements ICPRepository {
  async createMany(input: Partial<ICP>[]) {
    return Promise.all(input.map(async (item) => mapICP(await model("iCP").create({ data: icpData(item) }))));
  }
  async replaceForBusinessProfile(workspaceId: string, businessProfileId: string, input: Partial<ICP>[]) {
    // M3.x / 2026-07-20 redo-rule: archive existing rows for this profile
    // (don't delete), then insert new ones. listByWorkspace filters out
    // archived so the user sees only the current set, but history remains.
    await model("iCP").updateMany?.({ where: { workspaceId, businessProfileId, status: { not: "archived" } }, data: { status: "archived" } });
    return this.createMany(input.map((item) => ({ ...item, workspaceId, businessProfileId })));
  }
  async listByWorkspace(workspaceId: string) {
    // M3.x / 2026-07-20 redo-rule: filter archived out of the normal view.
    //
    // 2026-08-05 (golden:substrate-parity, divergence #1): ORDER BY added.
    // Without it Postgres returns rows in physical/heap order, which is not
    // stable — `replaceForBusinessProfile` writes 3 ICPs and the list came
    // back as [Garment makers, Export houses, Trim retailers] on Prisma but
    // [Export houses, Garment makers, Trim retailers] on JSON. The ICP list
    // is rendered directly in the UI, so the operator would see the cards
    // shuffle between refreshes on production only.
    //
    // `id` is the tiebreaker because a batch insert stamps every row with the
    // same createdAt, which alone is not a total order.
    return (await model("iCP").findMany({
      where: { workspaceId, status: { not: "archived" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })).map(mapICP);
  }
  async getById(workspaceId: string, icpId: string) {
    const record = await model("iCP").findFirst({ where: { workspaceId, id: icpId } });
    return record ? mapICP(record) : undefined;
  }
  async update(workspaceId: string, icpId: string, data: Partial<ICP>) {
    await assertScoped(model("iCP"), workspaceId, icpId, "ICP");
    return mapICP(await model("iCP").update({ where: { id: icpId }, data: withoutOwnershipFields(icpData(data)) }));
  }
  async select(workspaceId: string, icpId: string) {
    await model("iCP").updateMany?.({ where: { workspaceId, status: "selected" }, data: { status: "suggested" } });
    return this.update(workspaceId, icpId, { status: "selected" });
  }
  async reject(workspaceId: string, icpId: string) {
    return this.update(workspaceId, icpId, { status: "rejected" });
  }
}

export class CampaignPrismaRepository implements CampaignRepository {
  async create(input: Partial<Campaign>) {
    return mapCampaign(await model("campaign").create({ data: campaignData(input) }));
  }
  async getById(workspaceId: string, campaignId: string) {
    const record = await model("campaign").findFirst({ where: { workspaceId, id: campaignId } });
    return record ? mapCampaign(record) : undefined;
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("campaign").findMany({ where: { workspaceId } })).map(mapCampaign);
  }
  async update(workspaceId: string, campaignId: string, data: Partial<Campaign>) {
    await assertScoped(model("campaign"), workspaceId, campaignId, "Campaign");
    return mapCampaign(await model("campaign").update({ where: { id: campaignId }, data: withoutOwnershipFields(campaignData(data)) }));
  }
  async approve(workspaceId: string, campaignId: string) {
    return this.update(workspaceId, campaignId, { status: "active", approvalStatus: "approved" });
  }
}

export class LeadPrismaRepository implements LeadRepository {
  async createLead(input: Partial<Lead>) {
    return mapLead(await model("lead").create({ data: leadData(input) }));
  }
  async getLeadById(workspaceId: string, leadId: string) {
    const record = await model("lead").findFirst({ where: { workspaceId, id: leadId } });
    return record ? mapLead(record) : undefined;
  }
  /**
   * P-1 fix (Session 7, 2026-07-28): workspace-scoped phone lookup. Phones are
   * stored raw (not normalized), so we cannot do a pure DB-side equality on the
   * normalized form. Instead we ask the DB for ONLY this workspace's leads that
   * have a phone set (uses the workspace + phone indexes — never loads other
   * tenants' leads), then normalize-match in JS. This is the difference between
   * "load 10k leads across all tenants and sift" (the P-1 bug) and "load this
   * workspace's phone-bearing leads" (the fix). Pinned by `golden:find-lead-by-phone`.
   */
  async findLeadByPhone(workspaceId: string, phone: string) {
    // Digit-only normalization — see JSON impl doc. Matches the inbound-webhook
    // contract so "+919999000777" and "919999000777" resolve to the same lead.
    const target = (phone || "").replace(/\D/g, "");
    if (!target) return undefined;
    // 1. Match the primary flat fields (the original contract).
    const records = await model("lead").findMany({
      where: {
        workspaceId,
        OR: [{ phone: { not: null } }, { whatsappNumber: { not: null } }],
      },
    });
    for (const record of records) {
      const mapped = mapLead(record);
      if ((mapped.whatsappNumber || mapped.phone || "").replace(/\D/g, "") === target) return mapped;
    }
    // 2. Stage 6 / WP6-C (6C-2): match ANY of the lead's stored numbers.
    const extraRows = await model("leadPhoneNumber").findMany({
      where: { workspaceId, normalizedDigits: target },
    });
    if (extraRows.length > 0) {
      // F-ISO-1 (2026-08-04 build-right audit): re-assert workspaceId on the
      // lead fetch too (defense-in-depth). The upstream leadPhoneNumber query
      // at :806 is workspace-scoped, so the leadId is transitively trusted —
      // but a future refactor that unscopes the phone query would turn this
      // into a cross-tenant lead read. Adding workspaceId here closes that
      // latent hole at zero cost.
      const lead = await model("lead").findFirst({ where: { id: String(extraRows[0].leadId), workspaceId } });
      if (lead) return mapLead(lead);
    }
    // 3. 2026-09-26 (break test): same subscriber rule as the JSON repo and the
    //    do-not-contact register — "98250 33333" / "098250 33333" is WhatsApp's
    //    919825033333. Only after the exact matches above failed.
    for (const record of records) {
      const mapped = mapLead(record);
      if (samePhoneForOptOut(mapped.whatsappNumber, target) || samePhoneForOptOut(mapped.phone, target)) return mapped;
    }
    if (target.length >= PHONE_MATCH_DIGITS) {
      const looseRows = await model("leadPhoneNumber").findMany({
        where: { workspaceId, normalizedDigits: { endsWith: target.slice(-PHONE_MATCH_DIGITS) } },
      });
      if (looseRows.length > 0) {
        const lead = await model("lead").findFirst({ where: { id: String(looseRows[0].leadId), workspaceId } });
        if (lead) return mapLead(lead);
      }
    }
    return undefined;
  }

  // Stage 6 / WP6-C (2026-07-30) — multi-number storage per lead.
  async addLeadPhoneNumber(workspaceId: string, leadId: string, input: { number: string; type: string; isPrimary?: boolean; label?: string }) {
    const normalizedDigits = (input.number || "").replace(/\D/g, "");
    // Idempotent: the unique index on (leadId, normalizedDigits) + upsert means
    // re-adding the same number updates the existing row instead of duplicating.
    const created = await model("leadPhoneNumber").upsert({
      where: { leadId_normalizedDigits: { leadId, normalizedDigits } },
      create: {
        workspaceId,
        leadId,
        number: input.number,
        normalizedDigits,
        type: input.type,
        isPrimary: Boolean(input.isPrimary),
        label: input.label ?? null,
      },
      update: { type: input.type, isPrimary: Boolean(input.isPrimary), label: input.label ?? null },
    });
    // 6C-1 primary sync: keep the flat lead field in sync so existing readers
    // (which read lead.phone / lead.whatsappNumber) see the primary number.
    if (input.isPrimary) {
      const field = input.type === "whatsapp" ? { whatsappNumber: input.number } : { phone: input.number };
      await model("lead").update({ where: { id: leadId }, data: field });
    }
    return {
      id: String(created.id),
      workspaceId: String(created.workspaceId),
      leadId: String(created.leadId),
      number: String(created.number),
      normalizedDigits: String(created.normalizedDigits),
      type: String(created.type),
      isPrimary: Boolean(created.isPrimary),
      label: created.label != null ? String(created.label) : undefined,
      createdAt: iso(created.createdAt),
      updatedAt: iso(created.updatedAt),
    };
  }

  async listLeadPhoneNumbers(workspaceId: string, leadId: string) {
    const rows = await model("leadPhoneNumber").findMany({ where: { workspaceId, leadId } });
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspaceId),
      leadId: String(r.leadId),
      number: String(r.number),
      normalizedDigits: String(r.normalizedDigits),
      type: String(r.type),
      isPrimary: Boolean(r.isPrimary),
      label: r.label != null ? String(r.label) : undefined,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    }));
  }
  async listLeads(workspaceId: string, filters: ListLeadFilters = {}) {
    // 2026-09-28 (L10): a status filter matches both names of a stage.
    const { status, ...rest } = filters;
    return (await model("lead").findMany({ where: { workspaceId, ...rest, ...(status ? { status: { in: leadStatusNames(status) } } : {}) } })).map(mapLead);
  }
  async listLeadsByCampaign(workspaceId: string, campaignId: string) {
    return this.listLeads(workspaceId, { campaignId });
  }
  async updateLead(workspaceId: string, leadId: string, data: Partial<Lead>) {
    await assertScoped(model("lead"), workspaceId, leadId, "Lead");
    return mapLead(await model("lead").update({ where: { id: leadId }, data: withoutOwnershipFields(leadData(data)) }));
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
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete by id.
   * Throws if the lead doesn't exist (defensive — caller should have
   * already verified via getLeadById).
   */
  async deleteById(workspaceId: string, leadId: string): Promise<number> {
    await assertScoped(model("lead"), workspaceId, leadId, "Lead");
    const result = await model("lead").deleteMany({ where: { workspaceId, id: leadId } });
    if (result.count === 0) throw new Error("Lead not found");
    return result.count;
  }
}

export class MessageTemplatePrismaRepository implements MessageTemplateRepository {
  async create(input: Partial<MessageTemplate>) {
    return mapMessage(await model("messageTemplate").create({ data: messageData(input) }));
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("messageTemplate").findMany({ where: { workspaceId } })).map(mapMessage);
  }
  async getById(workspaceId: string, messageId: string) {
    const record = await model("messageTemplate").findFirst({ where: { workspaceId, id: messageId } });
    return record ? mapMessage(record) : undefined;
  }
  async update(workspaceId: string, messageId: string, data: Partial<MessageTemplate>) {
    await assertScoped(model("messageTemplate"), workspaceId, messageId, "Message");
    return mapMessage(await model("messageTemplate").update({ where: { id: messageId }, data: withoutOwnershipFields(messageData(data)) }));
  }
  /**
   * 2026-09-28 (S5) — erasure. Must run BEFORE the lead delete: the foreign
   * key is ON DELETE SET NULL, so afterwards the drafts can no longer be found
   * by lead and would outlive the customer.
   */
  async deleteByLead(workspaceId: string, leadId: string) {
    return Number((await model("messageTemplate").deleteMany({ where: { workspaceId, leadId } }) as { count?: number }).count || 0);
  }
}

export class OutreachActivityPrismaRepository implements OutreachActivityRepository {
  async create(input: Partial<OutreachActivity>) {
    return mapOutreach(await model("outreachActivity").create({ data: input }));
  }
  async listByLead(workspaceId: string, leadId: string) {
    return (await model("outreachActivity").findMany({ where: { workspaceId, leadId } })).map(mapOutreach);
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("outreachActivity").findMany({ where: { workspaceId } })).map(mapOutreach);
  }
  /**
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete by lead.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("outreachActivity").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}

export class ReplyPrismaRepository implements ReplyRepository {
  async create(input: Partial<Reply>) {
    return mapReply(await model("reply").create({ data: input }));
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("reply").findMany({ where: { workspaceId } })).map(mapReply);
  }
  async listByLead(workspaceId: string, leadId: string) {
    return (await model("reply").findMany({ where: { workspaceId, leadId } })).map(mapReply);
  }
  async getById(workspaceId: string, replyId: string) {
    const record = await model("reply").findFirst({ where: { workspaceId, id: replyId } });
    return record ? mapReply(record) : undefined;
  }
  async update(workspaceId: string, replyId: string, data: Partial<Reply>) {
    await assertScoped(model("reply"), workspaceId, replyId, "Reply");
    return mapReply(await model("reply").update({ where: { id: replyId }, data }));
  }
  /**
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete by lead.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("reply").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}

export class AgentRunPrismaRepository implements AgentRunRepository {
  async create(input: Partial<AgentRun>) {
    return mapAgentRun(await model("agentRun").create({ data: agentRunData(input) }));
  }
  async update(workspaceId: string, agentRunId: string, data: Partial<AgentRun>) {
    await assertScoped(model("agentRun"), workspaceId, agentRunId, "Agent run");
    return mapAgentRun(await model("agentRun").update({ where: { id: agentRunId }, data: agentRunData(data) }));
  }
  async listRecent(workspaceId: string, limit = 10) {
    return (await model("agentRun").findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: limit })).map(mapAgentRun);
  }
  /**
   * 2026-09-28 (S5) — erasure. The text lives in JSON columns, so the match is
   * done here in code over this workspace's runs (read in pages of 500 so a
   * long history does not load at once), then one deleteMany by id.
   */
  async deleteMentioning(workspaceId: string, needles: CustomerNeedles) {
    const doomed: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await model("agentRun").findMany({
        where: { workspaceId },
        select: { id: true, inputJson: true, outputJson: true, errorMessage: true },
        orderBy: { id: "asc" },
        take: 500,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }) as unknown as Array<{ id: string; inputJson?: unknown; outputJson?: unknown; errorMessage?: string | null }>;
      for (const row of page) {
        if (textMentionsCustomer(agentRunText({ input: row.inputJson, output: row.outputJson, errorMessage: row.errorMessage }), needles)) doomed.push(row.id);
      }
      if (page.length < 500) break;
      cursor = page[page.length - 1].id;
    }
    if (!doomed.length) return 0;
    return Number((await model("agentRun").deleteMany({ where: { workspaceId, id: { in: doomed } } }) as { count?: number }).count || 0);
  }
}

export class AuditLogPrismaRepository implements AuditLogRepository {
  async create(input: Partial<AuditLog>) {
    const record = await model("auditLog").create({ data: auditData(input) });
    return stripRawJsonColumns({ ...(record as unknown as AuditLog), payload: jsonObject(record.payloadJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("auditLog").findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } })).map((record) => (stripRawJsonColumns({ ...(record as unknown as AuditLog), payload: jsonObject(record.payloadJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) })));
  }
}

export class IntegrationPrismaRepository implements IntegrationRepository {
  async create(workspaceId: string, input: Partial<Integration>) {
    // createdAt/updatedAt are passed through rather than defaulted, because the
    // migration replays rows and a row whose timestamps move on arrival is a
    // row the re-plan check reports as changed. `updatedAt` carries @updatedAt
    // in the schema; Prisma still honours an explicit value on create.
    const record = await model("integration").create({
      data: {
        id: input.id,
        workspaceId,
        provider: input.provider,
        status: input.status,
        authType: input.authType,
        configJson: input.config,
        lastConnectedAt: input.lastConnectedAt ? new Date(input.lastConnectedAt) : undefined,
        createdAt: input.createdAt ? new Date(input.createdAt) : undefined,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : undefined,
      },
    });
    return stripRawJsonColumns({ ...(record as unknown as Integration), config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("integration").findMany({ where: { workspaceId } })).map((record) => (stripRawJsonColumns({ ...(record as unknown as Integration), config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) })));
  }
  async update(workspaceId: string, integrationId: string, data: Partial<Integration>) {
    await assertScoped(model("integration"), workspaceId, integrationId, "Integration");
    const { config, ...rest } = data;
    const record = await model("integration").update({ where: { id: integrationId }, data: { ...rest, configJson: config } });
    return stripRawJsonColumns({ ...(record as unknown as Integration), config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
  }
}

export class WebsiteCrawlJobPrismaRepository implements WebsiteCrawlJobRepository {
  async create(input: Partial<WebsiteCrawlJob>) {
    return mapCrawlJob(await model("websiteCrawlJob").create({ data: crawlJobData(input) }));
  }
  async getById(workspaceId: string, crawlJobId: string) {
    const record = await model("websiteCrawlJob").findFirst({ where: { workspaceId, id: crawlJobId } });
    return record ? mapCrawlJob(record) : undefined;
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("websiteCrawlJob").findMany({ where: { workspaceId } })).map(mapCrawlJob);
  }
  async update(workspaceId: string, crawlJobId: string, data: Partial<WebsiteCrawlJob>) {
    await assertScoped(model("websiteCrawlJob"), workspaceId, crawlJobId, "Crawl job");
    return mapCrawlJob(await model("websiteCrawlJob").update({ where: { id: crawlJobId }, data: crawlJobData(data) }));
  }
  async updateStatus(workspaceId: string, crawlJobId: string, status: WebsiteCrawlJob["status"]) {
    return this.update(workspaceId, crawlJobId, { status });
  }
  async updateProgress(workspaceId: string, crawlJobId: string, pagesFound: number, pagesCrawled: number) {
    return this.update(workspaceId, crawlJobId, { pagesFound, pagesCrawled });
  }
  async complete(workspaceId: string, crawlJobId: string, pagesFound: number, pagesCrawled: number) {
    return this.update(workspaceId, crawlJobId, { status: "completed", pagesFound, pagesCrawled, completedAt: new Date().toISOString() });
  }
  async fail(workspaceId: string, crawlJobId: string, errorMessage: string) {
    return this.update(workspaceId, crawlJobId, { status: "failed", errorMessage, completedAt: new Date().toISOString() });
  }
}

export class WebsiteCrawlPagePrismaRepository implements WebsiteCrawlPageRepository {
  async create(input: Partial<WebsiteCrawlPage>) {
    return mapCrawlPage(await model("websiteCrawlPage").create({ data: crawlPageData(input) }));
  }
  async createMany(input: Partial<WebsiteCrawlPage>[]) {
    return Promise.all(input.map((item) => this.create(item)));
  }
  async listByCrawlJob(workspaceId: string, crawlJobId: string) {
    // M3.x / 2026-07-20 redo-rule: filter tombstones out of the normal view.
    return (await model("websiteCrawlPage").findMany({ where: { workspaceId, crawlJobId, url: { not: "__deleted__" } } })).map(mapCrawlPage);
  }
  async getById(workspaceId: string, pageId: string) {
    const record = await model("websiteCrawlPage").findFirst({ where: { workspaceId, id: pageId } });
    return record ? mapCrawlPage(record) : undefined;
  }
  async deleteByCrawlJob(workspaceId: string, crawlJobId: string) {
    // M3.x / 2026-07-20 redo-rule: soft-archive via tombstone, keep history.
    await model("websiteCrawlPage").updateMany?.({ where: { workspaceId, crawlJobId, url: { not: "__deleted__" } }, data: { url: "__deleted__" } });
  }
}

export class BusinessExtractionPrismaRepository implements BusinessExtractionRepository {
  async create(input: Partial<BusinessExtraction>) {
    return mapExtraction(await model("businessExtraction").create({ data: extractionData(input) }));
  }
  async getByCrawlJob(workspaceId: string, crawlJobId: string) {
    const record = await model("businessExtraction").findFirst({ where: { workspaceId, crawlJobId } });
    return record ? mapExtraction(record) : undefined;
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("businessExtraction").findMany({ where: { workspaceId } })).map(mapExtraction);
  }
  async update(workspaceId: string, extractionId: string, data: Partial<BusinessExtraction>) {
    await assertScoped(model("businessExtraction"), workspaceId, extractionId, "Business extraction");
    return mapExtraction(await model("businessExtraction").update({ where: { id: extractionId }, data: withoutOwnershipFields(extractionData(data)) }));
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

export class CampaignLearningPrismaRepository implements CampaignLearningRepository {
  async create(input: Partial<CampaignLearning>) {
    return mapLearning(await model("campaignLearning").create({ data: learningData(input) }));
  }
  async getByCampaign(workspaceId: string, campaignId: string) {
    return (await model("campaignLearning").findMany({ where: { workspaceId, campaignId } })).map(mapLearning);
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("campaignLearning").findMany({ where: { workspaceId } })).map(mapLearning);
  }
  async update(workspaceId: string, learningId: string, data: Partial<CampaignLearning>) {
    await assertScoped(model("campaignLearning"), workspaceId, learningId, "Campaign learning");
    return mapLearning(await model("campaignLearning").update({ where: { id: learningId }, data: withoutOwnershipFields(learningData(data)) }));
  }
}

export class CampaignMetricPrismaRepository implements CampaignMetricRepository {
  async create(input: Partial<CampaignMetric>) {
    return mapMetric(await model("campaignMetric").create({ data: metricData(input) }));
  }
  async listByCampaign(workspaceId: string, campaignId: string) {
    return (await model("campaignMetric").findMany({ where: { workspaceId, campaignId } })).map(mapMetric);
  }
  async upsertMetric(input: Partial<CampaignMetric>) {
    // M3.x / 2026-07-20 daily-metric rule: latest number wins, overwrite the
    // earlier one for the same (workspace, campaign, metricName, day) key.
    // Previously this was a stub that always created a new row, which caused
    // duplicate-key constraint failures and double-counted metrics.
    const workspaceId = String(input.workspaceId || "");
    const campaignId = String(input.campaignId || "");
    const metricName = String(input.metricName || "");
    const day = String(input.calculatedAt || "").slice(0, 10);
    const existing = await model("campaignMetric").findFirst({ where: { workspaceId, campaignId, metricName, calculatedAt: day } });
    if (existing) {
      return mapMetric(await model("campaignMetric").update({ where: { id: existing.id }, data: metricData(input) }));
    }
    return mapMetric(await model("campaignMetric").create({ data: metricData(input) }));
  }
}

export class EventLogPrismaRepository implements EventLogRepository {
  async create(input: Partial<EventLog>) {
    return mapEventLog(await model("eventLog").create({ data: eventLogData(input) }));
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("eventLog").findMany({ where: { workspaceId } })).map(mapEventLog);
  }
  async listByEntity(workspaceId: string, entityType: string, entityId: string) {
    return (await model("eventLog").findMany({ where: { workspaceId, entityType, entityId } })).map(mapEventLog);
  }
}

export class JobRunPrismaRepository implements JobRunRepository {
  async create(input: Partial<JobRun>) {
    return mapJobRun(await model("jobRun").create({ data: jobRunData(input) }));
  }
  async updateStatus(workspaceId: string, jobRunId: string, status: string) {
    await assertScoped(model("jobRun"), workspaceId, jobRunId, "Job run");
    return mapJobRun(await model("jobRun").update({ where: { id: jobRunId }, data: { status } }));
  }
  async complete(workspaceId: string, jobRunId: string, result?: Record<string, unknown>) {
    await assertScoped(model("jobRun"), workspaceId, jobRunId, "Job run");
    return mapJobRun(await model("jobRun").update({ where: { id: jobRunId }, data: { status: "completed", resultJson: result, completedAt: new Date() } }));
  }
  async fail(workspaceId: string, jobRunId: string, errorMessage: string) {
    await assertScoped(model("jobRun"), workspaceId, jobRunId, "Job run");
    return mapJobRun(await model("jobRun").update({ where: { id: jobRunId }, data: { status: "failed", errorMessage, completedAt: new Date() } }));
  }
  async getById(workspaceId: string, jobRunId: string) {
    const record = await model("jobRun").findFirst({ where: { id: jobRunId, workspaceId } });
    return record ? mapJobRun(record) : undefined;
  }
  async update(workspaceId: string, jobRunId: string, data: Partial<JobRun>) {
    await assertScoped(model("jobRun"), workspaceId, jobRunId, "Job run");
    return mapJobRun(await model("jobRun").update({
      where: { id: jobRunId },
      data: {
        status: data.status,
        payloadJson: data.payload,
        resultJson: data.result,
        errorMessage: data.errorMessage,
        startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
        completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
      },
    }));
  }
  async claim(workspaceId: string, jobRunId: string, fromStatus: string, toStatus: string, patch: Partial<Pick<JobRun, "payload" | "result" | "errorMessage" | "startedAt" | "completedAt">> = {}) {
    // One conditional UPDATE. Postgres applies it atomically, so of two
    // requests racing for the same job exactly one sees count === 1.
    const updateMany = model("jobRun").updateMany;
    // Refused rather than faked: a read-then-write fallback here would bring
    // back exactly the race this method exists to close.
    if (!updateMany) throw new Error("Cannot claim a job: this database client has no conditional update.");
    const outcome = (await updateMany({ where: { id: jobRunId, workspaceId, status: fromStatus }, data: {
      status: toStatus, payloadJson: patch.payload, resultJson: patch.result, errorMessage: patch.errorMessage,
      startedAt: patch.startedAt ? new Date(patch.startedAt) : undefined,
      completedAt: patch.completedAt ? new Date(patch.completedAt) : undefined,
    } })) as { count?: number };
    return outcome?.count === 1;
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("jobRun").findMany({ where: { workspaceId } })).map(mapJobRun);
  }
}

const mapPolicy = (record: Record<string, unknown>): AgentBehaviorPolicy => ({ id: String(record.id), workspaceId: record.workspaceId as string | undefined, name: String(record.name || ""), scope: String(record.scope || "global") as AgentBehaviorPolicy["scope"], version: String(record.version || "1"), policy: jsonObject(record.policyJson), isActive: Boolean(record.isActive), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapComm = (record: Record<string, unknown>): CompanyCommunicationSettings => ({ id: String(record.id), workspaceId: String(record.workspaceId), language: String(record.language || "English"), tone: String(record.tone || "professional_friendly"), brandVoice: record.brandVoice as string | undefined, messageLength: String(record.messageLength || "short"), greeting: String(record.greeting || "Hello"), closing: String(record.closing || "Thank you"), preferredWords: jsonArray(record.preferredWordsJson), avoidedWords: jsonArray(record.avoidedWordsJson), formalityLevel: record.formalityLevel as string | undefined, emojiUsage: String(record.emojiUsage || "minimal"), allowHinglish: Boolean(record.allowHinglish), customInstructions: record.customInstructions as string | undefined, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapConversationPolicy = (record: Record<string, unknown>): ConversationPolicy => ({ id: String(record.id), workspaceId: String(record.workspaceId), channel: String(record.channel || ""), policy: jsonObject(record.policyJson), sensitiveTopics: jsonArray(record.sensitiveTopicsJson), autoReplyAllowedCategories: jsonArray(record.autoReplyAllowedCategoriesJson), humanApprovalRequiredCategories: jsonArray(record.humanApprovalRequiredCategoriesJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapWASettings = (record: Record<string, unknown>): WhatsAppAgentSettings => ({ id: String(record.id), workspaceId: String(record.workspaceId), enabled: Boolean(record.enabled), mode: String(record.mode || "draft_only") as WhatsAppAgentSettings["mode"], defaultLanguage: String(record.defaultLanguage || "English"), maxAutoRepliesPerConversation: Number(record.maxAutoRepliesPerConversation || 3), businessHours: jsonObject(record.businessHoursJson), escalationContactName: record.escalationContactName as string | undefined, escalationContactPhone: record.escalationContactPhone as string | undefined, escalationContactEmail: record.escalationContactEmail as string | undefined, unknownAnswerBehavior: String(record.unknownAnswerBehavior || "hold_for_review"), abusiveMessageBehavior: String(record.abusiveMessageBehavior || "escalate"), priceQuestionBehavior: String(record.priceQuestionBehavior || "ask_quantity_or_escalate"),
  autoAcknowledgeSensitive: Boolean(record.autoAcknowledgeSensitive),
  acknowledgementTemplate: (record.acknowledgementTemplate as string | null) ?? undefined,
  messageBatchingEnabled: Boolean(record.messageBatchingEnabled),
  autoReplyTopics: Array.isArray(record.autoReplyTopics) ? (record.autoReplyTopics as unknown[]).map(String) : [],
  autoReplyPaused: Array.isArray(record.autoReplyPausedJson) ? (record.autoReplyPausedJson as WhatsAppAgentSettings["autoReplyPaused"]) : undefined,
  // NULL stays undefined: "never decided" and "decided on an empty list" are
  // different states, and {} for NULL would erase the difference.
  discoveryChecklist: record.discoveryChecklistJson && typeof record.discoveryChecklistJson === "object"
    ? (record.discoveryChecklistJson as WhatsAppAgentSettings["discoveryChecklist"])
    : undefined,
  createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapEscalation = (record: Record<string, unknown>): EscalationRule => ({ id: String(record.id), workspaceId: String(record.workspaceId), channel: String(record.channel || ""), triggerType: String(record.triggerType || ""), condition: jsonObject(record.conditionJson), action: jsonObject(record.actionJson), priority: Number(record.priority || 100), isActive: Boolean(record.isActive), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
// M3.x / 2026-07-20: use the full-field mapper (mapUnknownQuestion) instead
// of this lossy inline version. Kept as an alias so existing call sites work.
const mapUnknown = mapUnknownQuestion;
/**
 * N-DNC-1 (2026-08-18). `createdAt` comes back from Postgres as a Date and the
 * domain type is an ISO string, so it goes through `iso()` like every other
 * mapper here. `normalizedPhone`/`normalizedEmail` are nullable columns and
 * optional fields, so null becomes undefined rather than the string "null".
 */
const mapDnc = (record: Record<string, unknown>): DoNotContactEntry => ({
  id: String(record.id),
  workspaceId: String(record.workspaceId),
  normalizedPhone: record.normalizedPhone == null ? undefined : String(record.normalizedPhone),
  normalizedEmail: record.normalizedEmail == null ? undefined : String(record.normalizedEmail),
  normalizedDomain: record.normalizedDomain == null ? undefined : String(record.normalizedDomain),
  reason: String(record.reason || ""),
  sourceLeadId: record.sourceLeadId == null ? undefined : String(record.sourceLeadId),
  createdAt: iso(record.createdAt),
});

// 2026-09-10 (session 55): the three mediaAttachment* fields are read back
// HERE. They were written by the engine and stored by create() above, and this
// mapper simply never mentioned them -- so on Postgres the agent's choice of
// photo existed in the database and nowhere else. The review screen showed "No
// attachment" for a draft the AI had attached a catalogue to, and approving it
// sent the customer text with no photo. On the JSON substrate the whole object
// is kept as-is, so every existing test passed. Verified against a live
// deepseek run: media_attachment_id held the shade card while the API response
// carried no media key at all.
const mapAutoReply = (record: Record<string, unknown>): AutoReplyLog => ({ id: String(record.id), workspaceId: String(record.workspaceId), leadId: record.leadId as string | undefined, replyId: record.replyId as string | undefined, channel: String(record.channel || ""), incomingMessage: String(record.incomingMessage || ""), retrievedContext: jsonObject(record.retrievedContextJson), classification: record.classification as string | undefined, generatedReply: record.generatedReply as string | undefined, confidenceScore: record.confidenceScore === undefined ? undefined : Number(record.confidenceScore), canAutoSend: Boolean(record.canAutoSend), needsHumanReview: Boolean(record.needsHumanReview), reason: record.reason as string | undefined, modelProvider: record.modelProvider as string | undefined, modelName: record.modelName as string | undefined, modelMode: record.modelMode as AutoReplyLog["modelMode"], fallbackUsed: Boolean(record.fallbackUsed), validationStatus: record.validationStatus as AutoReplyLog["validationStatus"], sendAttempted: Boolean(record.sendAttempted), sendStatus: record.sendStatus as AutoReplyLog["sendStatus"], providerMessageId: record.providerMessageId as string | undefined, providerError: record.providerError as string | undefined, mediaAttachmentId: record.mediaAttachmentId as string | undefined, mediaAttachmentUrl: record.mediaAttachmentUrl as string | undefined, mediaAttachmentName: record.mediaAttachmentName as string | undefined, status: String(record.status || "drafted") as AutoReplyLog["status"], internalNote: record.internalNote as string | undefined, acknowledgementSent: Boolean(record.acknowledgementSent), aiDraft: (record.aiDraft as string | null) ?? undefined, ownerEdited: Boolean(record.ownerEdited), ownerVerdict: (record.ownerVerdict as AutoReplyLog["ownerVerdict"] | null) ?? undefined, ownerVerdictAt: record.ownerVerdictAt ? iso(record.ownerVerdictAt) : undefined, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
// 2026-09-10 (session 55): drop contentBase64 on the way out. Every list,
// getById and workspace-export path runs through here, and a 16 MB base64
// string riding inside a JSON list response would be both a payload
// disaster and a quiet way for file bytes to end up in logs. The file is
// readable only through getFileBytes.
const mapMediaCatalogItem = (record: Record<string, unknown>): MediaCatalogItem => {
  const { contentBase64: _fileBytes, ...withoutBytes } = record;
  return { ...(withoutBytes as unknown as MediaCatalogItem), category: String(record.category || "other") as MediaCatalogItem["category"], status: String(record.status || "active") as MediaCatalogItem["status"], fileSize: Number(record.fileSize || 0), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
};
const mapKBDoc = (record: Record<string, unknown>): KnowledgeBaseDocument => ({ id: String(record.id), workspaceId: String(record.workspaceId), title: String(record.title || ""), documentType: String(record.documentType || "other"), source: record.source as string | undefined, status: String(record.status || "active") as KnowledgeBaseDocument["status"], contentText: String(record.contentText || ""), metadata: jsonObject(record.metadataJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapKBChunk = (record: Record<string, unknown>): KnowledgeBaseChunk => ({ id: String(record.id), workspaceId: String(record.workspaceId), documentId: String(record.documentId), chunkIndex: Number(record.chunkIndex || 0), chunkText: String(record.chunkText || ""), embedding: Array.isArray(record.embeddingJson) ? record.embeddingJson.map(Number) : undefined, metadata: jsonObject(record.metadataJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapKBQuery = (record: Record<string, unknown>): KnowledgeBaseQueryLog => ({ id: String(record.id), workspaceId: String(record.workspaceId), queryText: String(record.queryText || ""), retrievedChunks: Array.isArray(record.retrievedChunksJson) ? record.retrievedChunksJson as Record<string, unknown>[] : [], answerUsed: Boolean(record.answerUsed), confidenceScore: record.confidenceScore === undefined ? undefined : Number(record.confidenceScore), createdAt: iso(record.createdAt) });
const mapCredential = (record: Record<string, unknown>): LLMProviderCredential => ({ id: String(record.id), workspaceId: String(record.workspaceId), provider: String(record.provider || ""), displayName: record.displayName as string | undefined, encryptedApiKey: record.encryptedApiKey as string | undefined, status: String(record.status || "not_connected") as LLMProviderCredential["status"], config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapRouting = (record: Record<string, unknown>): LLMModelRouting => ({ id: String(record.id), workspaceId: String(record.workspaceId), taskName: String(record.taskName || ""), provider: String(record.provider || "mock"), modelName: record.modelName as string | undefined, modelTier: String(record.modelTier || "mock"), isEnabled: Boolean(record.isEnabled), fallbackProvider: record.fallbackProvider as string | undefined, fallbackModelName: record.fallbackModelName as string | undefined, config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
// N-BUG (2026-09-07) — `== null`, not `=== undefined`, on the four limit
// fields. Prisma returns NULL columns as `null`; `null === undefined` is false,
// so every nullable limit was read back as `Number(null)` === 0. checkCanRunTask
// then applied `?? DEFAULT`, which does not fire on 0, and refused every LLM
// call with "daily tokens (1000 > 0)". JSON mode never saw it because a missing
// key there really is `undefined`. Prisma-only, and it disabled all AI.
const mapUsage = (record: Record<string, unknown>): AIUsageLimit => ({ id: String(record.id), workspaceId: String(record.workspaceId), dailyTokenLimit: record.dailyTokenLimit == null ? undefined : Number(record.dailyTokenLimit), monthlyTokenLimit: record.monthlyTokenLimit == null ? undefined : Number(record.monthlyTokenLimit), dailyCostLimit: record.dailyCostLimit == null ? undefined : Number(record.dailyCostLimit), monthlyCostLimit: record.monthlyCostLimit == null ? undefined : Number(record.monthlyCostLimit), currentDailyTokens: Number(record.currentDailyTokens || 0), currentMonthlyTokens: Number(record.currentMonthlyTokens || 0), currentDailyCost: Number(record.currentDailyCost || 0), currentMonthlyCost: Number(record.currentMonthlyCost || 0), resetAt: record.resetAt ? iso(record.resetAt) : undefined, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });
const mapProviderAccount = (record: Record<string, unknown>): ProviderAccount => ({ id: String(record.id), workspaceId: String(record.workspaceId), integrationId: record.integrationId as string | undefined, provider: String(record.provider || ""), accountIdentifier: record.accountIdentifier as string | undefined, email: record.email as string | undefined, phoneNumber: record.phoneNumber as string | undefined, displayName: record.displayName as string | undefined, status: String(record.status || "active") as ProviderAccount["status"], dailyLimit: record.dailyLimit === undefined ? undefined : Number(record.dailyLimit), usedToday: Number(record.usedToday || 0), config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) });

export class AgentBehaviorPolicyPrismaRepository implements AgentBehaviorPolicyRepository {
  async getActive(workspaceId?: string) { const record = await model("agentBehaviorPolicy").findFirst({ where: { isActive: true, ...(workspaceId ? { workspaceId } : { scope: "global" }) } }); return record ? mapPolicy(record) : undefined; }
  async create(input: Partial<AgentBehaviorPolicy>) { return mapPolicy(await model("agentBehaviorPolicy").create({ data: { id: input.id, workspaceId: input.workspaceId, name: input.name, scope: input.scope, version: input.version, policyJson: input.policy, isActive: input.isActive , createdAt: input.createdAt, } })); }
}

export class CompanyCommunicationSettingsPrismaRepository implements CompanyCommunicationSettingsRepository {
  async getByWorkspace(workspaceId: string) { const record = await model("companyCommunicationSettings").findFirst({ where: { workspaceId } }); return record ? mapComm(record) : undefined; }
  async upsertForWorkspace(workspaceId: string, data: Partial<CompanyCommunicationSettings>) { const existing = await this.getByWorkspace(workspaceId); const payload = { workspaceId, language: data.language, tone: data.tone, brandVoice: data.brandVoice, messageLength: data.messageLength, greeting: data.greeting, closing: data.closing, preferredWordsJson: data.preferredWords, avoidedWordsJson: data.avoidedWords, formalityLevel: data.formalityLevel, emojiUsage: data.emojiUsage, allowHinglish: data.allowHinglish, customInstructions: data.customInstructions }; return mapComm(existing ? await model("companyCommunicationSettings").update({ where: { id: existing.id }, data: payload }) : await model("companyCommunicationSettings").create({ data: singletonCreateData(data, payload) })); }
}

export class ConversationPolicyPrismaRepository implements ConversationPolicyRepository {
  async getByWorkspaceAndChannel(workspaceId: string, channel: string) { const record = await model("conversationPolicy").findFirst({ where: { workspaceId, channel } }); return record ? mapConversationPolicy(record) : undefined; }
  async upsertForWorkspaceAndChannel(workspaceId: string, channel: string, data: Partial<ConversationPolicy>) { const existing = await this.getByWorkspaceAndChannel(workspaceId, channel); const payload = { workspaceId, channel, policyJson: data.policy || {}, sensitiveTopicsJson: data.sensitiveTopics, autoReplyAllowedCategoriesJson: data.autoReplyAllowedCategories, humanApprovalRequiredCategoriesJson: data.humanApprovalRequiredCategories }; return mapConversationPolicy(existing ? await model("conversationPolicy").update({ where: { id: existing.id }, data: payload }) : await model("conversationPolicy").create({ data: payload })); }
}

export class WhatsAppAgentSettingsPrismaRepository implements WhatsAppAgentSettingsRepository {
  async getByWorkspace(workspaceId: string) { const record = await model("whatsAppAgentSettings").findFirst({ where: { workspaceId } }); return record ? mapWASettings(record) : undefined; }
  async upsertForWorkspace(workspaceId: string, data: Partial<WhatsAppAgentSettings>) { const existing = await this.getByWorkspace(workspaceId); const payload = { workspaceId, enabled: data.enabled, mode: data.mode, defaultLanguage: data.defaultLanguage, maxAutoRepliesPerConversation: data.maxAutoRepliesPerConversation, businessHoursJson: data.businessHours, escalationContactName: data.escalationContactName, escalationContactPhone: data.escalationContactPhone, escalationContactEmail: data.escalationContactEmail, unknownAnswerBehavior: data.unknownAnswerBehavior, abusiveMessageBehavior: data.abusiveMessageBehavior, priceQuestionBehavior: data.priceQuestionBehavior,
      // 2026-09-23 — named here for the first time. They were on the type and in
      // the JSON store since CP-22/CP-23 and this payload never carried them, so
      // on Postgres the owner's choice was dropped on every save.
      autoAcknowledgeSensitive: data.autoAcknowledgeSensitive, acknowledgementTemplate: data.acknowledgementTemplate, messageBatchingEnabled: data.messageBatchingEnabled,
      autoReplyTopics: data.autoReplyTopics,
      autoReplyPausedJson: data.autoReplyPaused as never,
      discoveryChecklistJson: data.discoveryChecklist }; return mapWASettings(existing ? await model("whatsAppAgentSettings").update({ where: { id: existing.id }, data: payload }) : await model("whatsAppAgentSettings").create({ data: singletonCreateData(data, payload) })); }
}

export class EscalationRulePrismaRepository implements EscalationRuleRepository {
  async listActive(workspaceId: string, channel?: string) { return (await model("escalationRule").findMany({ where: { workspaceId, isActive: true, ...(channel ? { channel } : {}) } })).map(mapEscalation); }
  async create(input: Partial<EscalationRule>) { return mapEscalation(await model("escalationRule").create({ data: { id: input.id, workspaceId: input.workspaceId, channel: input.channel, triggerType: input.triggerType, conditionJson: input.condition, actionJson: input.action, priority: input.priority, isActive: input.isActive , createdAt: input.createdAt, } })); }
}

export class UnknownQuestionPrismaRepository implements UnknownQuestionRepository {
  async create(workspaceId: string, data: Partial<UnknownQuestion>) {
    // M3.x / 2026-07-20: persist all 7 previously-dropped fields.
    return mapUnknown(await model("unknownQuestion").create({
      data: {
        id: data.id,
        workspaceId,
        leadId: data.leadId,
        conversationId: data.conversationId,
        channel: data.channel,
        questionText: data.questionText,
        missingTopic: data.missingTopic,
        status: data.status,
        suggestedAnswer: data.suggestedAnswer,
        finalAnswer: data.finalAnswer,
        generatedBy: data.generatedBy,
        relatedDomain: data.relatedDomain,
        relatedQuestionKey: data.relatedQuestionKey,
        conflictSourcesJson: data.conflictSourcesJson,
        sourceIdsJson: data.sourceIds,
        sourceDocumentId: data.sourceDocumentId,
        priority: data.priority,
      
        createdAt: data.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
      },
    }));
  }
  async listByWorkspace(workspaceId: string, filters: { status?: string } = {}) { return (await model("unknownQuestion").findMany({ where: { workspaceId, ...(filters.status ? { status: filters.status } : {}) } })).map(mapUnknown); }
  // 2026-07-21 (Cluster A fix B3, session 16) — single fetch for convert-to-ticket.
  async getById(workspaceId: string, id: string) { const r = await model("unknownQuestion").findFirst({ where: { workspaceId, id } }); return r ? mapUnknown(r) : undefined; }
  async update(workspaceId: string, id: string, data: Partial<UnknownQuestion>) { await assertScoped(model("unknownQuestion"), workspaceId, id, "Unknown question"); return mapUnknown(await model("unknownQuestion").update({ where: { id }, data })); }
  async markAnswered(workspaceId: string, id: string, answer: string) { return this.update(workspaceId, id, { finalAnswer: answer, status: "answered" }); }
  async markAddedToKnowledge(workspaceId: string, id: string) { return this.update(workspaceId, id, { status: "added_to_knowledge" }); }
  /**
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete by lead.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("unknownQuestion").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}

/**
 * Stage 2 (2026-07-20) — Prisma Ticket repository.
 *
 * Uses the same `model()` pattern. Requires `Ticket`, `TicketEvent`,
 * `TicketSlaSettings` Prisma models (added to schema.prisma in the same
 * session). Run `DATABASE_URL=... npx prisma db push && npx prisma generate`
 * before these are called in production.
 */
function mapTicket(record: Record<string, unknown>): Ticket {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    ticketNumber: Number(record.ticketNumber || 0),
    leadId: record.leadId as string | undefined,
    replyId: record.replyId as string | undefined,
    conversationId: record.conversationId as string | undefined,
    orderId: record.orderId as string | undefined,
    quoteId: record.quoteId as string | undefined,
    sourceChannel: String(record.sourceChannel || ""),
    type: record.type as Ticket["type"],
    priority: record.priority as Ticket["priority"],
    status: record.status as Ticket["status"],
    subject: String(record.subject || ""),
    description: String(record.description || ""),
    resolution: record.resolution as string | undefined,
    assignedTo: record.assignedTo as string | undefined,
    sourceEntityType: (record.sourceEntityType as Ticket["sourceEntityType"]) || "manual",
    sourceEntityId: record.sourceEntityId as string | undefined,
    slaStartedAt: iso(record.slaStartedAt),
    slaDueAt: iso(record.slaDueAt),
    slaBreached: Boolean(record.slaBreached),
    firstRespondedAt: record.firstRespondedAt ? iso(record.firstRespondedAt) : undefined,
    resolvedAt: record.resolvedAt ? iso(record.resolvedAt) : undefined,
    closedAt: record.closedAt ? iso(record.closedAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class TicketPrismaRepository implements TicketRepository {
  async nextTicketNumber(workspaceId: string): Promise<number> {
    const rows = await model("ticket").findMany({ where: { workspaceId }, select: { ticketNumber: true } });
    const max = rows.reduce((acc: number, r: Record<string, unknown>) => Math.max(acc, Number(r.ticketNumber || 0)), 0);
    return max + 1;
  }
  async create(input: Partial<Ticket> & { workspaceId: string; type: Ticket["type"]; priority: Ticket["priority"]; subject: string; description: string; sourceChannel: string }): Promise<Ticket> {
    const now = new Date().toISOString();
    return mapTicket(await model("ticket").create({ data: {
      id: input.id, workspaceId: input.workspaceId, ticketNumber: input.ticketNumber ?? 0,
      leadId: input.leadId, replyId: input.replyId, conversationId: input.conversationId,
      orderId: input.orderId, quoteId: input.quoteId,
      sourceChannel: input.sourceChannel, type: input.type, priority: input.priority,
      status: input.status || "open", subject: input.subject, description: input.description,
      resolution: input.resolution, assignedTo: input.assignedTo,
      sourceEntityType: input.sourceEntityType || "manual",
      sourceEntityId: input.sourceEntityId,
      slaStartedAt: input.slaStartedAt || now, slaDueAt: input.slaDueAt || now,
      slaBreached: false, firstRespondedAt: input.firstRespondedAt,
      resolvedAt: input.resolvedAt, closedAt: input.closedAt,
    
      createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
    } }));
  }
  async getById(workspaceId: string, ticketId: string): Promise<Ticket | undefined> {
    const record = await model("ticket").findFirst({ where: { workspaceId, id: ticketId } });
    return record ? mapTicket(record) : undefined;
  }
  async getByTicketNumber(workspaceId: string, ticketNumber: number): Promise<Ticket | undefined> {
    const record = await model("ticket").findFirst({ where: { workspaceId, ticketNumber } });
    return record ? mapTicket(record) : undefined;
  }
  async listByWorkspace(workspaceId: string, filters: { status?: Ticket["status"]; priority?: Ticket["priority"]; leadId?: string } = {}): Promise<Ticket[]> {
    return (await model("ticket").findMany({ where: { workspaceId, ...(filters.status ? { status: filters.status } : {}), ...(filters.priority ? { priority: filters.priority } : {}), ...(filters.leadId ? { leadId: filters.leadId } : {}) }, orderBy: { createdAt: "desc" } })).map(mapTicket);
  }
  async listOpenTickets(workspaceId: string): Promise<Ticket[]> {
    return (await model("ticket").findMany({ where: { workspaceId, status: { notIn: ["resolved", "closed"] } }, orderBy: { createdAt: "desc" } })).map(mapTicket);
  }
  async listBreached(workspaceId: string): Promise<Ticket[]> {
    return (await model("ticket").findMany({ where: { workspaceId, slaBreached: true, status: { notIn: ["resolved", "closed"] } }, orderBy: { slaDueAt: "asc" } })).map(mapTicket);
  }
  async update(workspaceId: string, ticketId: string, data: Partial<Ticket>): Promise<Ticket> {
    await assertScoped(model("ticket"), workspaceId, ticketId, "Ticket");
    return mapTicket(await model("ticket").update({ where: { id: ticketId }, data: clearableTicketUpdate(data) }));
  }
  /**
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete by lead.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("ticket").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}

export class TicketEventPrismaRepository implements TicketEventRepository {
  /**
   * Stage A.1 (2026-07-26) — REAL create. The previous impl returned a
   * synthesized in-memory object with id="" and never wrote to the table;
   * ticket event history was invisible in Prisma mode. Now persists.
   * Pinned by golden:prisma-commercial-parity CASE 5.
   */
  async create(input: Partial<TicketEvent> & { workspaceId: string; ticketId: string; eventType: TicketEvent["eventType"]; actorType: TicketEvent["actorType"] }): Promise<TicketEvent> {
    const record = await model("ticketEvent").create({ data: {
      id: input.id,
      workspaceId: input.workspaceId,
      ticketId: input.ticketId,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorUserId: input.actorUserId,
      actorType: input.actorType,
      note: input.note,
    
      createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
    } });
    return {
      id: String(record.id),
      workspaceId: String(record.workspaceId),
      ticketId: String(record.ticketId),
      eventType: record.eventType as TicketEvent["eventType"],
      fromStatus: record.fromStatus as TicketEvent["fromStatus"],
      toStatus: record.toStatus as TicketEvent["toStatus"],
      actorUserId: record.actorUserId as string | undefined,
      actorType: record.actorType as TicketEvent["actorType"],
      note: record.note as string | undefined,
      createdAt: iso(record.createdAt),
    };
  }
  /**
   * Stage A.1 (2026-07-26) — REAL read. The previous impl returned []
   * unconditionally; the table was never queried. Now reads.
   */
  async listByTicket(workspaceId: string, ticketId: string): Promise<TicketEvent[]> {
    const rows = await model("ticketEvent").findMany({ where: { workspaceId, ticketId }, orderBy: { createdAt: "asc" } });
    return rows.map((record: Record<string, unknown>) => ({
      id: String(record.id),
      workspaceId: String(record.workspaceId),
      ticketId: String(record.ticketId),
      eventType: record.eventType as TicketEvent["eventType"],
      fromStatus: record.fromStatus as TicketEvent["fromStatus"],
      toStatus: record.toStatus as TicketEvent["toStatus"],
      actorUserId: record.actorUserId as string | undefined,
      actorType: record.actorType as TicketEvent["actorType"],
      note: record.note as string | undefined,
      createdAt: iso(record.createdAt),
    }));
  }
  /**
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete events
   * for a set of ticket ids (called after the tickets themselves are gone).
   */
  async deleteByTicketIds(workspaceId: string, ticketIds: string[]): Promise<number> {
    if (ticketIds.length === 0) return 0;
    const result = await model("ticketEvent").deleteMany({ where: { workspaceId, ticketId: { in: ticketIds } } });
    return result.count;
  }
}

export class TicketSlaSettingsPrismaRepository implements TicketSlaSettingsRepository {
  /**
   * Stage A.1 (2026-07-26) — REAL read. The previous impl returned undefined
   * unconditionally; the table was never queried. Now reads the persisted row
   * (or undefined if the workspace hasn't configured SLA yet — which is the
   * correct "use defaults" signal).
   * Pinned by golden:prisma-commercial-parity CASE 6.
   */
  async getByWorkspace(workspaceId: string): Promise<TicketSlaSettings | undefined> {
    const record = await model("ticketSlaSettings").findFirst({ where: { workspaceId } });
    if (!record) return undefined;
    return mapTicketSlaSettings(record);
  }
  /**
   * Stage A.1 (2026-07-26) — REAL upsert. The previous impl returned a
   * hard-coded default with id="" and never persisted; SLA settings silently
   * disappeared in Prisma mode. Now upserts on workspaceId (the @@unique key).
   */
  async upsertForWorkspace(workspaceId: string, input: Partial<TicketSlaSettings>): Promise<TicketSlaSettings> {
    const data = {
      workspaceId,
      clockMode: input.clockMode || "business_hours",
      businessHoursStart: input.businessHoursStart || "09:00",
      businessHoursEnd: input.businessHoursEnd || "18:00",
      businessDaysJson: input.businessDays || [...DEFAULT_BUSINESS_DAYS], // Mon-Sat default (single source of truth in ticket-sla.ts; P2-DESIGN-1)
      // 2026-09-28 (M10) — the company's closed dates (holidays).
      closedDatesJson: input.closedDates || [],
      // 2026-09-30 — only written when given, so a save of the ticket clock
      // alone never wipes the owner's festival rules.
      ...(input.festivalRules !== undefined ? { festivalRulesJson: input.festivalRules } : {}),
      urgentSlaMinutes: input.urgentSlaMinutes ?? DEFAULT_SLA_MINUTES.urgent,
      highSlaMinutes: input.highSlaMinutes ?? DEFAULT_SLA_MINUTES.high,
      mediumSlaMinutes: input.mediumSlaMinutes ?? DEFAULT_SLA_MINUTES.medium,
      lowSlaMinutes: input.lowSlaMinutes ?? DEFAULT_SLA_MINUTES.low,
      assignmentMode: input.assignmentMode || "manual",
      assignmentRulesJson: input.assignmentRules || [],
      roundRobinPointer: input.roundRobinPointer ?? 0,
    };
    const record = await model("ticketSlaSettings").upsert({
      where: { workspaceId },
      create: singletonCreateData(input, data),
      update: data,
    });
    return mapTicketSlaSettings(record);
  }
}

/**
 * Stage A.1 (2026-07-26) — Centralized mapper for TicketSlaSettings, including
 * the 3 assignment fields (assignmentMode, assignmentRules, roundRobinPointer)
 * that were missing from the Prisma schema before this stage.
 */
function mapTicketSlaSettings(record: Record<string, unknown>): TicketSlaSettings {
  // 2026-09-28 (M9): untouched old defaults read as the corrected ones.
  return upgradeLegacySlaDefaults({
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    clockMode: record.clockMode as TicketSlaSettings["clockMode"],
    businessHoursStart: String(record.businessHoursStart || "09:00"),
    businessHoursEnd: String(record.businessHoursEnd || "18:00"),
    businessDays: (record.businessDaysJson as number[]) || [...DEFAULT_BUSINESS_DAYS], // Mon-Sat default (single source of truth in ticket-sla.ts; P2-DESIGN-1)
    closedDates: Array.isArray(record.closedDatesJson) ? (record.closedDatesJson as TicketSlaSettings["closedDates"]) : [],
    festivalRules: Array.isArray(record.festivalRulesJson) ? (record.festivalRulesJson as TicketSlaSettings["festivalRules"]) : [],
    urgentSlaMinutes: Number(record.urgentSlaMinutes || DEFAULT_SLA_MINUTES.urgent),
    highSlaMinutes: Number(record.highSlaMinutes || DEFAULT_SLA_MINUTES.high),
    mediumSlaMinutes: Number(record.mediumSlaMinutes || DEFAULT_SLA_MINUTES.medium),
    lowSlaMinutes: Number(record.lowSlaMinutes || DEFAULT_SLA_MINUTES.low),
    assignmentMode: (record.assignmentMode as TicketSlaSettings["assignmentMode"]) || "manual",
    assignmentRules: (record.assignmentRulesJson as TicketSlaSettings["assignmentRules"]) || [],
    roundRobinPointer: Number(record.roundRobinPointer || 0),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  });
}

/**
 * N-DNC-1 (2026-08-18). The permanent Do-Not-Contact registry on Postgres.
 * Until this class existed there was no repository for it at all, so
 * src/lib/dnc-registry.ts read and wrote .leadgen-data/app-data.json even when
 * the app was bound to Postgres — the compliance store was not on the shipping
 * substrate. Both halves of that were measured before the fix: a registered
 * opt-out left do_not_contact_entries at 0 rows, and an opt-out already in
 * do_not_contact_entries did not block a send.
 *
 * The OR-match is expressed as a Prisma `OR` array built only from the keys
 * that were actually supplied. Building it that way rather than passing
 * `{ normalizedPhone: phone }` with an empty string matters: the column is
 * nullable, and an equality against "" would quietly match nothing while
 * looking like a working query.
 */
export class DoNotContactPrismaRepository implements DoNotContactRepository {
  // 2026-09-24: phones match by subscriber number, not by exact spelling — see
  // src/lib/phone-match.ts. "+91 98250 33333" and WhatsApp's "919825033333"
  // are one person on an opt-out list.
  private matchClause(keys: DncKeys) {
    const or: Record<string, unknown>[] = [];
    const phoneFilter = keys.normalizedPhone ? optOutPhoneFilter(keys.normalizedPhone) : undefined;
    if (phoneFilter) or.push(phoneFilter);
    if (keys.normalizedEmail) or.push({ normalizedEmail: keys.normalizedEmail });
    // 2026-09-28 (L10): a company known only by its website.
    if (keys.normalizedDomain) or.push({ normalizedDomain: keys.normalizedDomain });
    return or;
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("doNotContactEntry").findMany({ where: { workspaceId } })).map(mapDnc);
  }
  async findMatch(workspaceId: string, keys: DncKeys) {
    const OR = this.matchClause(keys);
    if (!OR.length) return undefined;
    const record = await model("doNotContactEntry").findFirst({ where: { workspaceId, OR } });
    return record ? mapDnc(record) : undefined;
  }
  async create(entry: DoNotContactEntry) {
    return mapDnc(await model("doNotContactEntry").create({ data: {
      id: entry.id,
      workspaceId: entry.workspaceId,
      normalizedPhone: entry.normalizedPhone ?? null,
      normalizedEmail: entry.normalizedEmail ?? null,
      normalizedDomain: entry.normalizedDomain ?? null,
      reason: entry.reason,
      sourceLeadId: entry.sourceLeadId ?? null,
      createdAt: entry.createdAt ? new Date(entry.createdAt) : undefined,
    } }));
  }
  async removeMatching(workspaceId: string, keys: DncKeys) {
    const OR = this.matchClause(keys);
    if (!OR.length) return 0;
    const result = await model("doNotContactEntry").deleteMany({ where: { workspaceId, OR } });
    return Number((result as { count?: number }).count || 0);
  }
}

export class AutoReplyLogPrismaRepository implements AutoReplyLogRepository {
  async create(workspaceId: string, data: Partial<AutoReplyLog>) { return mapAutoReply(await model("autoReplyLog").create({ data: { id: data.id, workspaceId, leadId: data.leadId, replyId: data.replyId, channel: data.channel, incomingMessage: data.incomingMessage, retrievedContextJson: data.retrievedContext, classification: data.classification, generatedReply: data.generatedReply, confidenceScore: data.confidenceScore, canAutoSend: data.canAutoSend, needsHumanReview: data.needsHumanReview, reason: data.reason, modelProvider: data.modelProvider, modelName: data.modelName, modelMode: data.modelMode, fallbackUsed: data.fallbackUsed, validationStatus: data.validationStatus, sendAttempted: data.sendAttempted, sendStatus: data.sendStatus, providerMessageId: data.providerMessageId, providerError: data.providerError, mediaAttachmentId: data.mediaAttachmentId, mediaAttachmentUrl: data.mediaAttachmentUrl, mediaAttachmentName: data.mediaAttachmentName, status: data.status , createdAt: data.createdAt, acknowledgementSent: data.acknowledgementSent, aiDraft: data.aiDraft, ownerEdited: data.ownerEdited, } })); }
  async getById(workspaceId: string, id: string) { const record = await model("autoReplyLog").findFirst({ where: { workspaceId, id } }); return record ? mapAutoReply(record) : undefined; }
  async listByWorkspace(workspaceId: string, filters: { status?: string } = {}) { return (await model("autoReplyLog").findMany({ where: { workspaceId, ...(filters.status ? { status: filters.status } : {}) } })).map(mapAutoReply); }
  async listByLead(workspaceId: string, leadId: string) { return (await model("autoReplyLog").findMany({ where: { workspaceId, leadId } })).map(mapAutoReply); }
  async approve(workspaceId: string, id: string, data: Partial<AutoReplyLog> = {}) { await assertScoped(model("autoReplyLog"), workspaceId, id, "Auto-reply log"); return mapAutoReply(await model("autoReplyLog").update({ where: { id }, data: { generatedReply: data.generatedReply, canAutoSend: data.canAutoSend, sendAttempted: data.sendAttempted, sendStatus: data.sendStatus, providerMessageId: data.providerMessageId, providerError: data.providerError, mediaAttachmentId: data.mediaAttachmentId, mediaAttachmentUrl: data.mediaAttachmentUrl, mediaAttachmentName: data.mediaAttachmentName, aiDraft: data.aiDraft, ownerEdited: data.ownerEdited, status: "approved", needsHumanReview: false } })); }
  async reject(workspaceId: string, id: string) { await assertScoped(model("autoReplyLog"), workspaceId, id, "Auto-reply log"); return mapAutoReply(await model("autoReplyLog").update({ where: { id }, data: { status: "rejected", needsHumanReview: false } })); }
  /** 2026-08-05 (UX Fix 1) — save the operator's internal note. */
  async updateNote(workspaceId: string, id: string, internalNote: string) { await assertScoped(model("autoReplyLog"), workspaceId, id, "Auto-reply log"); return mapAutoReply(await model("autoReplyLog").update({ where: { id }, data: { internalNote } })); }
  async setOwnerVerdict(workspaceId: string, id: string, verdict: NonNullable<AutoReplyLog["ownerVerdict"]>, at: string) { await assertScoped(model("autoReplyLog"), workspaceId, id, "Auto-reply log"); return mapAutoReply(await model("autoReplyLog").update({ where: { id }, data: { ownerVerdict: verdict, ownerVerdictAt: new Date(at) } })); }
  /**
   * Stage 5 / 2026-07-21 (R5) — DPDPA erasure cascade. Hard-delete by lead.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("autoReplyLog").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}

export class MediaCatalogPrismaRepository implements MediaCatalogRepository {
  async create(workspaceId: string, data: Partial<MediaCatalogItem>, bytes?: Buffer) { return mapMediaCatalogItem(await model("mediaCatalogItem").create({ data: { id: data.id, workspaceId, title: data.title, category: data.category, fileName: data.fileName, fileType: data.fileType, fileSize: data.fileSize, url: data.url, storagePath: data.storagePath, contentBase64: bytes ? bytes.toString("base64") : undefined, caption: data.caption, leadId: data.leadId, status: data.status , createdAt: data.createdAt, } })); }
  async listByWorkspace(workspaceId: string, filters: { category?: string; leadId?: string } = {}) {
    const where = { workspaceId, status: "active", ...(filters.category ? { category: filters.category } : {}), ...(filters.leadId ? { leadId: filters.leadId } : {}) };
    const rows = await model("mediaCatalogItem").findMany({ where, orderBy: { createdAt: "desc" } });
    // Which of these actually have a file behind them. A second id-only query,
    // because the alternative -- selecting contentBase64 -- would drag every
    // file's bytes through a list that renders six product cards. Rows without
    // bytes are real rows the owner can see; they just cannot be sent, and
    // saying so is the difference between a visible gap and a silent failure
    // at Meta.
    const withBytes = await model("mediaCatalogItem").findMany({ where: { ...where, NOT: { contentBase64: null } }, select: { id: true } }) as Array<{ id: string }>;
    const present = new Set(withBytes.map((row) => row.id));
    return rows.map((row: Record<string, unknown>) => ({ ...mapMediaCatalogItem(row), fileMissing: !present.has(String(row.id)) }));
  }
  async getById(workspaceId: string, id: string) { const record = await model("mediaCatalogItem").findFirst({ where: { workspaceId, id, status: "active" }, omit: { contentBase64: true } }) as Record<string, unknown> | null; if (!record) return undefined; const withBytes = await model("mediaCatalogItem").findFirst({ where: { workspaceId, id, status: "active", NOT: { contentBase64: null } }, select: { id: true } }); return { ...mapMediaCatalogItem(record), fileMissing: !withBytes }; }
  async getFileBytes(workspaceId: string, id: string) { const record = await model("mediaCatalogItem").findFirst({ where: { workspaceId, id, status: "active" }, select: { contentBase64: true } }) as { contentBase64?: string | null } | null; const encoded = record?.contentBase64; return encoded ? Buffer.from(encoded, "base64") : undefined; }
  async delete(workspaceId: string, id: string) { await assertScoped(model("mediaCatalogItem"), workspaceId, id, "Media item"); return mapMediaCatalogItem(await model("mediaCatalogItem").update({ where: { id }, data: { status: "archived", contentBase64: null } })); }
  /** 2026-09-28 (S5) — erasure: hard-delete the customer's photos / voice notes (the bytes live in the row). */
  async eraseCustomerMediaForLead(workspaceId: string, leadId: string) {
    const where = { workspaceId, leadId, category: { in: ["customer_photo", "customer_voice_note"] } };
    const rows = await model("mediaCatalogItem").findMany({ where, select: { id: true } }) as unknown as Array<{ id: string }>;
    if (!rows.length) return { removed: 0, ids: [] };
    const result = await model("mediaCatalogItem").deleteMany({ where: { workspaceId, id: { in: rows.map((r) => r.id) } } }) as { count?: number };
    return { removed: Number(result.count || 0), ids: rows.map((r) => r.id) };
  }
}

// CP-25 (2026-08-02) — Meta-approved WhatsApp message templates.
function mapWhatsAppTemplate(record: Record<string, unknown>): WhatsAppTemplate {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    providerTemplateId: record.providerTemplateId ? String(record.providerTemplateId) : undefined,
    name: String(record.name || ""),
    language: String(record.language || "en_US"),
    category: record.category ? String(record.category) : undefined,
    status: (record.status as WhatsAppTemplate["status"]) || "draft",
    body: String(record.body || ""),
    header: record.header ? String(record.header) : undefined,
    footer: record.footer ? String(record.footer) : undefined,
    buttons: record.buttons as WhatsAppTemplate["buttons"],
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  };
}

export class WhatsAppTemplatePrismaRepository implements WhatsAppTemplateRepository {
  async create(workspaceId: string, data: Partial<WhatsAppTemplate>) {
    return mapWhatsAppTemplate(await model("whatsAppTemplate").create({ data: { id: data.id, workspaceId, providerTemplateId: data.providerTemplateId, name: data.name, language: data.language, category: data.category, status: data.status || "draft", body: data.body, header: data.header, footer: data.footer , createdAt: data.createdAt, } }));
  }
  async listByWorkspace(workspaceId: string) {
    return (await model("whatsAppTemplate").findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } })).map(mapWhatsAppTemplate);
  }
  async getById(workspaceId: string, id: string) {
    const record = await model("whatsAppTemplate").findFirst({ where: { workspaceId, id } });
    return record ? mapWhatsAppTemplate(record) : undefined;
  }
  async update(workspaceId: string, id: string, patch: Partial<WhatsAppTemplate>) {
    await assertScoped(model("whatsAppTemplate"), workspaceId, id, "WhatsApp template");
    return mapWhatsAppTemplate(await model("whatsAppTemplate").update({ where: { id }, data: { providerTemplateId: patch.providerTemplateId, name: patch.name, language: patch.language, category: patch.category, status: patch.status, body: patch.body, header: patch.header, footer: patch.footer } }));
  }
  async deleteById(workspaceId: string, id: string) {
    await assertScoped(model("whatsAppTemplate"), workspaceId, id, "WhatsApp template");
    return mapWhatsAppTemplate(await model("whatsAppTemplate").delete({ where: { id } }));
  }
}

export class KnowledgeBaseDocumentPrismaRepository implements KnowledgeBaseDocumentRepository {
  async create(workspaceId: string, data: Partial<KnowledgeBaseDocument>) { return mapKBDoc(await model("knowledgeBaseDocument").create({ data: { id: data.id, workspaceId, title: data.title, documentType: data.documentType, source: data.source, status: data.status, contentText: data.contentText, metadataJson: data.metadata , createdAt: data.createdAt, } })); }
  async update(workspaceId: string, documentId: string, data: Partial<KnowledgeBaseDocument>) { await assertScoped(model("knowledgeBaseDocument"), workspaceId, documentId, "Knowledge document"); return mapKBDoc(await model("knowledgeBaseDocument").update({ where: { id: documentId }, data: { title: data.title, documentType: data.documentType, source: data.source, status: data.status, contentText: data.contentText, metadataJson: data.metadata } })); }
  async getById(workspaceId: string, documentId: string) { const record = await model("knowledgeBaseDocument").findFirst({ where: { workspaceId, id: documentId } }); return record ? mapKBDoc(record) : undefined; }
  async listByWorkspace(workspaceId: string) { return (await model("knowledgeBaseDocument").findMany({ where: { workspaceId } })).map(mapKBDoc); }
  async getByTypeAndSource(workspaceId: string, documentType: string, source: string) { const record = await model("knowledgeBaseDocument").findFirst({ where: { workspaceId, documentType, source } }); return record ? mapKBDoc(record) : undefined; }
  // 2026-09-08 — KnowledgeBaseChunk.document is onDelete: Cascade, so the
  // chunks go with the row. assertScoped first: a document id from another
  // workspace must not be deletable by guessing it.
  async delete(workspaceId: string, documentId: string) { await assertScoped(model("knowledgeBaseDocument"), workspaceId, documentId, "Knowledge document"); return mapKBDoc(await model("knowledgeBaseDocument").delete({ where: { id: documentId } })); }
}

export class KnowledgeBaseChunkPrismaRepository implements KnowledgeBaseChunkRepository {
  async createMany(workspaceId: string, documentId: string, chunks: Partial<KnowledgeBaseChunk>[]) {
    const created = await Promise.all(chunks.map((chunk, index) => model("knowledgeBaseChunk").create({ data: { id: chunk.id, workspaceId, documentId, chunkIndex: chunk.chunkIndex ?? index, chunkText: chunk.chunkText, embeddingJson: chunk.embedding, metadataJson: chunk.metadata , createdAt: chunk.createdAt, } }).then(mapKBChunk)));
    // 2026-09-17 (session 56): mirror labelled vectors into the pgvector/HNSW
    // index. The single chokepoint every chunk write passes through, so no
    // caller can forget it. A no-op where the index table does not exist, and
    // never able to fail the write it follows.
    const vectorRows = created
      .filter((chunk) => Array.isArray(chunk.embedding) && typeof chunk.metadata?.embeddingModel === "string")
      .map((chunk) => ({ chunkId: chunk.id, model: String(chunk.metadata!.embeddingModel), vector: chunk.embedding }));
    if (vectorRows.length) {
      const { upsertChunkVectors } = await import("@/rag/vector-store");
      await upsertChunkVectors(workspaceId, vectorRows);
    }
    return created;
  }
  async listByDocument(workspaceId: string, documentId: string) {
    // M3.x / 2026-07-20 redo-rule: filter tombstones out of the normal view.
    return (await model("knowledgeBaseChunk").findMany({ where: { workspaceId, documentId, chunkText: { not: "__deleted__" } } })).map(mapKBChunk);
  }
  async listByWorkspace(workspaceId: string) {
    // M3.x / 2026-07-20 redo-rule: filter tombstones out of the normal view.
    return (await model("knowledgeBaseChunk").findMany({ where: { workspaceId, chunkText: { not: "__deleted__" } } })).map(mapKBChunk);
  }
  async listByIds(workspaceId: string, ids: string[]) {
    if (!ids.length) return [];
    return (await model("knowledgeBaseChunk").findMany({ where: { workspaceId, id: { in: ids }, chunkText: { not: "__deleted__" } } })).map(mapKBChunk);
  }
  async updateMetadata(workspaceId: string, chunkId: string, metadata: Record<string, unknown>) {
    const existing = await model("knowledgeBaseChunk").findFirst({ where: { workspaceId, id: chunkId } });
    if (!existing) return null;
    const updated = await model("knowledgeBaseChunk").update({ where: { id: chunkId }, data: { metadataJson: metadata as never } });
    // A retired chunk must leave the vector index too, or a meaning-search can
    // still return text the owner has replaced. The chunk row itself stays.
    if (metadata.supersededBy) {
      const { deleteChunkVectors } = await import("@/rag/vector-store");
      await deleteChunkVectors([chunkId]);
    }
    return mapKBChunk(updated);
  }
  async replaceForDocument(workspaceId: string, documentId: string, chunks: Partial<KnowledgeBaseChunk>[]) {
    // N-BUG-7 (2026-09-05). This used to TOMBSTONE the old chunks — overwrite
    // their text with "__deleted__" and leave the rows — under the M3.x
    // redo-rule of keeping history. The history was never kept for anyone:
    // every one of the seven places that reads this table filters the
    // tombstones straight back out, and no screen, export or report surfaces
    // them. So they were write-only rows, and there were a lot of them. The
    // second-press sweep measured 39 dead rows added per knowledge sync, per
    // workspace, forever — on a table whose search path reads the whole
    // workspace's chunks on every query.
    //
    // Safe to delete outright: the ids are referenced by nothing (a query log
    // stores retrieved chunks as JSON, not a foreign key), and a concurrent
    // request cannot resurrect one, because changedRecordsOnly only writes back
    // records its own mutator actually changed and nothing mutates chunks
    // through the snapshot any more.
    await model("knowledgeBaseChunk").deleteMany({ where: { workspaceId, documentId } });
    return this.createMany(workspaceId, documentId, chunks);
  }
  async searchByKeyword(workspaceId: string, query: string, limit = 5) { const docs = await model("knowledgeBaseDocument").findMany({ where: { workspaceId } }); return (await this.listByWorkspace(workspaceId)).map((chunk) => ({ ...chunk, score: prismaKeywordScore(query, chunk.chunkText), documentTitle: docs.find((doc) => String(doc.id) === chunk.documentId)?.title as string | undefined })).filter((chunk) => chunk.score > 0 && chunk.chunkText !== "__deleted__").sort((a, b) => b.score - a.score).slice(0, limit); }
}

export class KnowledgeBaseQueryLogPrismaRepository implements KnowledgeBaseQueryLogRepository {
  async create(workspaceId: string, data: Partial<KnowledgeBaseQueryLog>) { return mapKBQuery(await model("knowledgeBaseQueryLog").create({ data: { id: data.id, workspaceId, queryText: data.queryText, retrievedChunksJson: data.retrievedChunks, answerUsed: data.answerUsed, confidenceScore: data.confidenceScore , createdAt: data.createdAt, } })); }
}

export class LLMProviderCredentialPrismaRepository implements LLMProviderCredentialRepository {
  async listByWorkspace(workspaceId: string) { return (await model("lLMProviderCredential").findMany({ where: { workspaceId } })).map(mapCredential); }
  // 2026-09-27 (review S1) — see the interface. Ids only.
  async listWorkspaceIdsForWhatsAppNumber(phoneNumberId: string) {
    const wanted = phoneNumberId.trim();
    if (!wanted) return [];
    const rows = await model("lLMProviderCredential").findMany({ where: { provider: "whatsapp_cloud", configJson: { path: ["phoneNumberId"], equals: wanted } }, select: { workspaceId: true } }) as Array<{ workspaceId: string }>;
    return [...new Set(rows.map((row) => row.workspaceId))];
  }
  async create(workspaceId: string, data: Partial<LLMProviderCredential>) { return mapCredential(await model("lLMProviderCredential").create({ data: { id: data.id, workspaceId, provider: data.provider, displayName: data.displayName, encryptedApiKey: data.encryptedApiKey, status: data.status, configJson: data.config , createdAt: data.createdAt, } })); }
  // I-4 fix (batch 3, 2026-07-27): key rotation. Workspace-scoped update —
  // the where clause binds BOTH id AND workspaceId so a cross-tenant guess
  // of the id cannot reach another workspace's credential.
  async update(workspaceId: string, id: string, data: Partial<LLMProviderCredential>) {
    const existing = await model("lLMProviderCredential").findFirst({ where: { id, workspaceId } });
    if (!existing) throw new Error(`LLMProviderCredential not found: ${id}`);
    return mapCredential(await model("lLMProviderCredential").update({ where: { id }, data: { provider: data.provider, displayName: data.displayName, encryptedApiKey: data.encryptedApiKey, status: data.status, configJson: data.config } }));
  }
  // I-4 fix (batch 3, 2026-07-27): revoke + remove. Workspace-scoped.
  async delete(workspaceId: string, id: string) {
    const result = await model("lLMProviderCredential").deleteMany({ where: { id, workspaceId } });
    return (result?.count || 0) > 0;
  }
}

export class LLMModelRoutingPrismaRepository implements LLMModelRoutingRepository {
  async listByWorkspace(workspaceId: string) { return (await model("lLMModelRouting").findMany({ where: { workspaceId } })).map(mapRouting); }
  async replaceForWorkspace(workspaceId: string, routes: Partial<LLMModelRouting>[]) {
    // M3.x / 2026-07-20 redo-rule: archive existing routes for this workspace
    // (delete old, since routes are config not history — they have no audit
    // value when superseded). Then insert new ones. Previously this only
    // inserted, causing duplicate-route lists growing on every config save.
    await model("lLMModelRouting").deleteMany?.({ where: { workspaceId } });
    return Promise.all(routes.map((route) => model("lLMModelRouting").create({ data: { id: route.id, workspaceId, taskName: route.taskName, provider: route.provider, modelName: route.modelName, modelTier: route.modelTier, isEnabled: route.isEnabled, fallbackProvider: route.fallbackProvider, fallbackModelName: route.fallbackModelName, configJson: route.config , createdAt: route.createdAt, } }).then(mapRouting)));
  }
}

export class AIUsageLimitPrismaRepository implements AIUsageLimitRepository {
  async getByWorkspace(workspaceId: string) { const record = await model("aIUsageLimit").findFirst({ where: { workspaceId } }); return record ? mapUsage(record) : undefined; }
  async upsertForWorkspace(workspaceId: string, data: Partial<AIUsageLimit>) { const existing = await this.getByWorkspace(workspaceId); const payload = { workspaceId, dailyTokenLimit: data.dailyTokenLimit, monthlyTokenLimit: data.monthlyTokenLimit, dailyCostLimit: data.dailyCostLimit, monthlyCostLimit: data.monthlyCostLimit, currentDailyTokens: data.currentDailyTokens, currentMonthlyTokens: data.currentMonthlyTokens, currentDailyCost: data.currentDailyCost, currentMonthlyCost: data.currentMonthlyCost, resetAt: data.resetAt ? new Date(data.resetAt) : undefined }; return mapUsage(existing ? await model("aIUsageLimit").update({ where: { id: existing.id }, data: payload }) : await model("aIUsageLimit").create({ data: singletonCreateData(data, payload) })); }
}

export class ProviderAccountPrismaRepository implements ProviderAccountRepository {
  async listByWorkspace(workspaceId: string) { return (await model("providerAccount").findMany({ where: { workspaceId } })).map(mapProviderAccount); }
  async create(workspaceId: string, data: Partial<ProviderAccount>) { return mapProviderAccount(await model("providerAccount").create({ data: { id: data.id, workspaceId, integrationId: data.integrationId, provider: data.provider, accountIdentifier: data.accountIdentifier, email: data.email, phoneNumber: data.phoneNumber, displayName: data.displayName, status: data.status, dailyLimit: data.dailyLimit, usedToday: data.usedToday, configJson: data.config , createdAt: data.createdAt, } })); }
  async update(workspaceId: string, id: string, data: Partial<ProviderAccount>) { await assertScoped(model("providerAccount"), workspaceId, id, "Provider account"); return mapProviderAccount(await model("providerAccount").update({ where: { id }, data: { integrationId: data.integrationId, provider: data.provider, accountIdentifier: data.accountIdentifier, email: data.email, phoneNumber: data.phoneNumber, displayName: data.displayName, status: data.status, dailyLimit: data.dailyLimit, usedToday: data.usedToday, configJson: data.config } })); }
}

export class AgentAutonomousSettingsPrismaRepository implements AgentAutonomousSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    const record = await model("agentAutonomousSettings").findFirst({ where: { workspaceId } });
    return record ? record as AgentAutonomousSettings : undefined;
  }

  async upsertForWorkspace(workspaceId: string, input: Partial<AgentAutonomousSettings>) {
    const data = { ...input, workspaceId };
    const record = await model("agentAutonomousSettings").upsert({
      where: { workspaceId },
      create: data,
      update: data,
    });
    return record as AgentAutonomousSettings;
  }
}

export class WebsiteCrawlConsentPrismaRepository implements WebsiteCrawlConsentRepository {
  async create(input: Partial<WebsiteCrawlConsent>) { return mapCrawlConsent(await model("websiteCrawlConsent").create({ data: { id: input.id, workspaceId: input.workspaceId, websiteUrl: input.websiteUrl, consentGiven: input.consentGiven, consentGivenAt: input.consentGivenAt ? new Date(input.consentGivenAt) : undefined, consentTextVersion: input.consentTextVersion, userId: input.userId , createdAt: input.createdAt, } })); }
  async getLatestForUrl(workspaceId: string, websiteUrl: string) { const record = await model("websiteCrawlConsent").findFirst({ where: { workspaceId, websiteUrl }, orderBy: { createdAt: "desc" } }); return record ? mapCrawlConsent(record) : undefined; }
}

export class ProductKnowledgePrismaRepository implements ProductKnowledgeRepository {
  async create(input: Partial<ProductKnowledge>) { return mapProductKnowledge(await model("productKnowledge").create({ data: { id: input.id, workspaceId: input.workspaceId, productName: input.productName, productCategory: input.productCategory, description: input.description, source: input.source, confidenceScore: input.confidenceScore , createdAt: input.createdAt, } })); }
  async listByWorkspace(workspaceId: string) { return (await model("productKnowledge").findMany({ where: { workspaceId } })).map(mapProductKnowledge); }
  // N-BUG-5 (2026-09-05). Workspace-scoped delete. The where clause binds
  // workspaceId, so regenerating one customer cannot reach another one.
  async deleteByWorkspace(workspaceId: string) { return (await model("productKnowledge").deleteMany({ where: { workspaceId } })).count; }
}

export class ProductVarietyPrismaRepository implements ProductVarietyRepository {
  async createMany(input: Partial<ProductVariety>[]) { return Promise.all(input.map((item) => model("productVariety").create({ data: { id: item.id, workspaceId: item.workspaceId, productKnowledgeId: item.productKnowledgeId, name: item.name, description: item.description, useCasesJson: item.useCases, buyerTypesJson: item.buyerTypes, confidenceScore: item.confidenceScore , createdAt: item.createdAt, } }).then(mapProductVariety))); }
  async listByWorkspace(workspaceId: string) { return (await model("productVariety").findMany({ where: { workspaceId } })).map(mapProductVariety); }
  // N-BUG-5 (2026-09-05). Workspace-scoped delete. The where clause binds
  // workspaceId, so regenerating one customer cannot reach another one.
  async deleteByWorkspace(workspaceId: string) { return (await model("productVariety").deleteMany({ where: { workspaceId } })).count; }
}

export class ProductApplicationPrismaRepository implements ProductApplicationRepository {
  async createMany(input: Partial<ProductApplication>[]) { return Promise.all(input.map((item) => model("productApplication").create({ data: { id: item.id, workspaceId: item.workspaceId, productKnowledgeId: item.productKnowledgeId, varietyId: item.varietyId, applicationName: item.applicationName, industry: item.industry, description: item.description, exampleProductsJson: item.exampleProducts, buyerTypesJson: item.buyerTypes, seasonalityJson: item.seasonality, confidenceScore: item.confidenceScore , createdAt: item.createdAt, } }).then(mapProductApplication))); }
  async listByWorkspace(workspaceId: string) { return (await model("productApplication").findMany({ where: { workspaceId } })).map(mapProductApplication); }
  // N-BUG-5 (2026-09-05). Workspace-scoped delete. The where clause binds
  // workspaceId, so regenerating one customer cannot reach another one.
  async deleteByWorkspace(workspaceId: string) { return (await model("productApplication").deleteMany({ where: { workspaceId } })).count; }
}

export class BuyerSegmentPrismaRepository implements BuyerSegmentRepository {
  async createMany(input: Partial<BuyerSegment>[]) { return Promise.all(input.map((item) => model("buyerSegment").create({ data: { id: item.id, workspaceId: item.workspaceId, name: item.name, segmentType: item.segmentType, description: item.description, needsJson: item.needs, buyingCriteriaJson: item.buyingCriteria, preferredChannelsJson: item.preferredChannels, qualificationSignalsJson: item.qualificationSignals, badFitSignalsJson: item.badFitSignals , createdAt: item.createdAt, } }).then(mapBuyerSegment))); }
  async listByWorkspace(workspaceId: string) { return (await model("buyerSegment").findMany({ where: { workspaceId } })).map(mapBuyerSegment); }
  // N-BUG-5 (2026-09-05). Workspace-scoped delete. The where clause binds
  // workspaceId, so regenerating one customer cannot reach another one.
  async deleteByWorkspace(workspaceId: string) { return (await model("buyerSegment").deleteMany({ where: { workspaceId } })).count; }
}

export class ProductApplicationMarketMapPrismaRepository implements ProductApplicationMarketMapRepository {
  async createMany(input: Partial<ProductApplicationMarketMap>[]) { return Promise.all(input.map((item) => model("productApplicationMarketMap").create({ data: { id: item.id, workspaceId: item.workspaceId, productKnowledgeId: item.productKnowledgeId, varietyId: item.varietyId, applicationId: item.applicationId, buyerSegmentId: item.buyerSegmentId, targetingAngle: item.targetingAngle, messageAngle: item.messageAngle, searchQueriesJson: item.searchQueries, leadSourcesJson: item.leadSources, confidenceScore: item.confidenceScore , createdAt: item.createdAt, } }).then(mapMarketMap))); }
  async listByWorkspace(workspaceId: string) { return (await model("productApplicationMarketMap").findMany({ where: { workspaceId } })).map(mapMarketMap); }
  // N-BUG-5 (2026-09-05). Workspace-scoped delete. The where clause binds
  // workspaceId, so regenerating one customer cannot reach another one.
  async deleteByWorkspace(workspaceId: string) { return (await model("productApplicationMarketMap").deleteMany({ where: { workspaceId } })).count; }
}

export class LeadReviewSettingsPrismaRepository implements LeadReviewSettingsRepository {
  async getByWorkspace(workspaceId: string) { const record = await model("leadReviewSettings").findFirst({ where: { workspaceId } }); return record ? mapLeadReviewSettings(record) : undefined; }
  async upsertForWorkspace(workspaceId: string, input: Partial<LeadReviewSettings>) { const existing = await this.getByWorkspace(workspaceId); const data = { workspaceId, mode: input.mode, autoApproveThreshold: input.autoApproveThreshold, autoRejectThreshold: input.autoRejectThreshold, maxAutoApprovedPerDay: input.maxAutoApprovedPerDay, requireHumanForNewCampaigns: input.requireHumanForNewCampaigns, requireHumanForNewIndustries: input.requireHumanForNewIndustries, allowAutoEnrichment: input.allowAutoEnrichment, allowAutoOutreachPreparation: input.allowAutoOutreachPreparation, allowAutoSend: false, auditEveryDecision: input.auditEveryDecision }; return mapLeadReviewSettings(existing ? await model("leadReviewSettings").update({ where: { id: existing.id }, data }) : await model("leadReviewSettings").create({ data: singletonCreateData(input, data) })); }
}

export class LeadReviewDecisionPrismaRepository implements LeadReviewDecisionRepository {
  async create(input: Partial<LeadReviewDecision>) { return mapLeadReviewDecision(await model("leadReviewDecision").create({ data: { id: input.id, workspaceId: input.workspaceId, leadId: input.leadId, campaignId: input.campaignId, decision: input.decision, confidenceScore: input.confidenceScore, reason: input.reason, matchedSignalsJson: input.matchedSignals, riskSignalsJson: input.riskSignals, suggestedNextStep: input.suggestedNextStep, modeUsed: input.modeUsed, decidedBy: input.decidedBy , createdAt: input.createdAt, } })); }
  async listByLead(workspaceId: string, leadId: string) { return (await model("leadReviewDecision").findMany({ where: { workspaceId, leadId } })).map(mapLeadReviewDecision); }
  async listByWorkspace(workspaceId: string) { return (await model("leadReviewDecision").findMany({ where: { workspaceId } })).map(mapLeadReviewDecision); }
  /** 2026-09-28 (S5) — erasure: the review notes about a customer (no foreign key, so nothing else removes them). */
  async deleteByLead(workspaceId: string, leadId: string) { return Number((await model("leadReviewDecision").deleteMany({ where: { workspaceId, leadId } }) as { count?: number }).count || 0); }
}

function mapCrawlConsent(record: Record<string, unknown>): WebsiteCrawlConsent {
  return { id: String(record.id), workspaceId: String(record.workspaceId), websiteUrl: String(record.websiteUrl), consentGiven: Boolean(record.consentGiven), consentGivenAt: iso(record.consentGivenAt), consentTextVersion: String(record.consentTextVersion || "v1"), userId: record.userId as string | undefined, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapProductKnowledge(record: Record<string, unknown>): ProductKnowledge {
  return { id: String(record.id), workspaceId: String(record.workspaceId), productName: String(record.productName), productCategory: record.productCategory as string | undefined, description: record.description as string | undefined, source: String(record.source || "agent"), confidenceScore: Number(record.confidenceScore || 0.7), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapProductVariety(record: Record<string, unknown>): ProductVariety {
  return { id: String(record.id), workspaceId: String(record.workspaceId), productKnowledgeId: String(record.productKnowledgeId), name: String(record.name), description: record.description as string | undefined, useCases: jsonArray(record.useCasesJson), buyerTypes: jsonArray(record.buyerTypesJson), confidenceScore: Number(record.confidenceScore || 0.7), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapProductApplication(record: Record<string, unknown>): ProductApplication {
  return { id: String(record.id), workspaceId: String(record.workspaceId), productKnowledgeId: String(record.productKnowledgeId), varietyId: record.varietyId as string | undefined, applicationName: String(record.applicationName), industry: record.industry as string | undefined, description: record.description as string | undefined, exampleProducts: jsonArray(record.exampleProductsJson), buyerTypes: jsonArray(record.buyerTypesJson), seasonality: jsonObject(record.seasonalityJson), confidenceScore: Number(record.confidenceScore || 0.7), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapBuyerSegment(record: Record<string, unknown>): BuyerSegment {
  return { id: String(record.id), workspaceId: String(record.workspaceId), name: String(record.name), segmentType: String(record.segmentType), description: record.description as string | undefined, needs: jsonArray(record.needsJson), buyingCriteria: jsonArray(record.buyingCriteriaJson), preferredChannels: jsonArray(record.preferredChannelsJson), qualificationSignals: jsonArray(record.qualificationSignalsJson), badFitSignals: jsonArray(record.badFitSignalsJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapMarketMap(record: Record<string, unknown>): ProductApplicationMarketMap {
  return { id: String(record.id), workspaceId: String(record.workspaceId), productKnowledgeId: String(record.productKnowledgeId), varietyId: record.varietyId as string | undefined, applicationId: String(record.applicationId), buyerSegmentId: String(record.buyerSegmentId), targetingAngle: String(record.targetingAngle || ""), messageAngle: String(record.messageAngle || ""), searchQueries: jsonArray(record.searchQueriesJson), leadSources: jsonArray(record.leadSourcesJson), confidenceScore: Number(record.confidenceScore || 0.7), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapLeadReviewSettings(record: Record<string, unknown>): LeadReviewSettings {
  return { id: String(record.id), workspaceId: String(record.workspaceId), mode: String(record.mode || "manual_review") as LeadReviewSettings["mode"], autoApproveThreshold: Number(record.autoApproveThreshold ?? 0.85), autoRejectThreshold: Number(record.autoRejectThreshold ?? 0.25), maxAutoApprovedPerDay: Number(record.maxAutoApprovedPerDay ?? 25), requireHumanForNewCampaigns: Boolean(record.requireHumanForNewCampaigns ?? true), requireHumanForNewIndustries: Boolean(record.requireHumanForNewIndustries ?? true), allowAutoEnrichment: Boolean(record.allowAutoEnrichment), allowAutoOutreachPreparation: Boolean(record.allowAutoOutreachPreparation ?? true), allowAutoSend: false, auditEveryDecision: Boolean(record.auditEveryDecision ?? true), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function mapLeadReviewDecision(record: Record<string, unknown>): LeadReviewDecision {
  return { id: String(record.id), workspaceId: String(record.workspaceId), leadId: String(record.leadId), campaignId: record.campaignId as string | undefined, decision: String(record.decision || "needs_review") as LeadReviewDecision["decision"], confidenceScore: Number(record.confidenceScore || 0.5), reason: String(record.reason || ""), matchedSignals: jsonArray(record.matchedSignalsJson), riskSignals: jsonArray(record.riskSignalsJson), suggestedNextStep: record.suggestedNextStep as string | undefined, modeUsed: String(record.modeUsed || "manual_review") as LeadReviewSettings["mode"], decidedBy: String(record.decidedBy || "agent") as LeadReviewDecision["decidedBy"], createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) };
}

function prismaKeywordScore(query: string, text: string) {
  const queryTerms = query.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").split(/\s+/).filter((term) => term.length > 2);
  const textTerms = new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").split(/\s+/).filter((term) => term.length > 2));
  return queryTerms.length ? queryTerms.filter((term) => textTerms.has(term)).length / queryTerms.length : 0;
}

// Phase 4B audit fix: these repos now call the REAL Prisma client instead of
// returning defaults/stubs. Each mirrors its JSON-repo counterpart 1:1.

// --- helpers for JSON-field handling ---
export function serializeSettings(input: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    // N-BUG (2026-09-08) — a Date is an object, so the branch below used to
    // JSON.stringify it into `"2026-09-07T17:44:21.470Z"` WITH the quote
    // characters, and Prisma rejected the write:
    //   Invalid value for argument `createdAt`: input contains invalid
    //   characters. Expected ISO-8601 DateTime.
    // deserializeSettings hands back the raw Prisma record, where createdAt is
    // a Date, so any caller that read a settings row and wrote it back tripped
    // this. setSettingValue does exactly that, which meant the FIRST write to
    // a settings area succeeded (no existing row, so no Date to round-trip)
    // and the SECOND one 500'd — measured on the live deployment resolving
    // extraction conflicts.
    if (value instanceof Date) {
      data[key] = value.toISOString();
    } else if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      data[key] = JSON.stringify(value);
    } else {
      data[key] = value;
    }
  }
  return data;
}

export function deserializeSettings(record: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const result: Record<string, unknown> = { ...record };
  for (const key of ["productWiseMOQ", "allowedAutoReplyTopics", "humanReviewRequiredTopics", "products", "mergedFromAnswerIds", "evidenceJson", "usedByAgentsJson", "mapsToJson", "fields", "sales", "policy", "communication"]) {
    if (typeof result[key] === "string") {
      try { result[key] = JSON.parse(result[key] as string); } catch { /* keep as string */ }
    }
  }
  // N-BUG (2026-09-08) — the settings types declare createdAt/updatedAt as
  // `string`, and every other mapper in this file honours that via iso().
  // These two came straight off the Prisma record as Date objects, so the
  // declared type was simply wrong and callers that trusted it wrote a Date
  // back into a string field. Make the type true here rather than asking each
  // caller to remember.
  for (const key of ["createdAt", "updatedAt"]) {
    if (result[key] instanceof Date) result[key] = iso(result[key]);
  }
  return result;
}

export class SalesSettingsPrismaRepository implements SalesSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    const record = await model("salesSettings").findFirst({ where: { workspaceId } });
    return record ? deserializeSettings(record as Record<string, unknown>) as SalesSettings : undefined;
  }
  async upsertForWorkspace(workspaceId: string, input: Partial<SalesSettings>) {
    const data = serializeSettings({ ...input, workspaceId });
    const record = await model("salesSettings").upsert({
      where: { workspaceId },
      create: data,
      update: data,
    });
    return deserializeSettings(record as Record<string, unknown>) as SalesSettings;
  }
}

export class ProductSettingsPrismaRepository implements ProductSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    const record = await model("productSettings").findFirst({ where: { workspaceId } });
    return record ? deserializeSettings(record as Record<string, unknown>) as ProductSettings : undefined;
  }
  async upsertForWorkspace(workspaceId: string, input: Partial<ProductSettings>) {
    const data = serializeSettings({ ...input, workspaceId });
    const record = await model("productSettings").upsert({
      where: { workspaceId },
      create: data,
      update: data,
    });
    return deserializeSettings(record as Record<string, unknown>) as ProductSettings;
  }
}

export class PolicySettingsPrismaRepository implements PolicySettingsRepository {
  async getByWorkspace(workspaceId: string) {
    const record = await model("policySettings").findFirst({ where: { workspaceId } });
    return record ? deserializeSettings(record as Record<string, unknown>) as PolicySettings : undefined;
  }
  async upsertForWorkspace(workspaceId: string, input: Partial<PolicySettings>) {
    const data = serializeSettings({ ...input, workspaceId });
    const record = await model("policySettings").upsert({
      where: { workspaceId },
      create: data,
      update: data,
    });
    return deserializeSettings(record as Record<string, unknown>) as PolicySettings;
  }
}

export class CommunicationSettingsPrismaRepository implements CommunicationSettingsRepository {
  async getByWorkspace(workspaceId: string) {
    const record = await model("communicationSettings").findFirst({ where: { workspaceId } });
    return record ? deserializeSettings(record as Record<string, unknown>) as CommunicationSettings : undefined;
  }
  async upsertForWorkspace(workspaceId: string, input: Partial<CommunicationSettings>) {
    const data = serializeSettings({ ...input, workspaceId });
    const record = await model("communicationSettings").upsert({
      where: { workspaceId },
      create: data,
      update: data,
    });
    return deserializeSettings(record as Record<string, unknown>) as CommunicationSettings;
  }
}

export class SettingsConflictPrismaRepository implements SettingsConflictRepository {
  async create(workspaceId: string, input: Partial<SettingsConflict>) {
    return await model("settingsConflict").create({
      data: { ...input, workspaceId } as Record<string, unknown>,
    }) as SettingsConflict;
  }
  // N-BUG (2026-09-08): this dropped the `filters` argument the interface
  // declares and the JSON repository honours. GET /api/settings/conflicts asks
  // for `?status=open`; on Postgres it got every conflict ever created, so the
  // Conflicts tab kept a red "5" badge and kept rendering five review cards
  // after all five were resolved. The operator had nothing left to decide and
  // the product would not stop asking.
  async listByWorkspace(workspaceId: string, filters: { status?: string; settingsArea?: string } = {}) {
    return await model("settingsConflict").findMany({
      where: {
        workspaceId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.settingsArea ? { settingsArea: filters.settingsArea } : {}),
      },
      orderBy: { createdAt: "desc" },
    }) as SettingsConflict[];
  }
  async getById(workspaceId: string, id: string) {
    const record = await model("settingsConflict").findFirst({ where: { workspaceId, id } });
    return record ? record as SettingsConflict : undefined;
  }
  async resolve(workspaceId: string, id: string, resolution: SettingsConflict["resolution"], customValue?: string, reason?: string) {
    const record = await model("settingsConflict").update({
      where: { id },
      data: { status: "resolved", resolution, customValue, resolutionReason: reason },
    });
    return record as SettingsConflict;
  }
  async ignore(workspaceId: string, id: string) {
    const record = await model("settingsConflict").update({
      where: { id },
      data: { status: "ignored" },
    });
    return record as SettingsConflict;
  }
}

export class PendingSettingsDraftPrismaRepository implements PendingSettingsDraftRepository {
  async listByWorkspace(workspaceId: string) {
    return await model("pendingSettingsDraft").findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" } }) as PendingSettingsDraft[];
  }
  async listPending(workspaceId: string) {
    return await model("pendingSettingsDraft").findMany({ where: { workspaceId, status: "pending_review" }, orderBy: { updatedAt: "desc" } }) as PendingSettingsDraft[];
  }
  async upsertPending(workspaceId: string, input: Partial<PendingSettingsDraft>) {
    // N-BUG-6 (2026-09-05). `kind` is NOT NULL in the schema and the JSON
    // repository has always defaulted it to "structured". This one did not, so
    // the same call that saved a draft on the file substrate answered HTTP 500
    // on Postgres — and the 500 carried Prisma's whole complaint, server file
    // path included, back to the caller. Found by the second-press sweep
    // (scripts/probes/write-route-idempotence.ts).
    const data = serializeSettings({ kind: "structured", ...input, workspaceId });
    // Try to find existing pending draft with same source group key
    const existing = input.sourceGroupKey
      ? await model("pendingSettingsDraft").findFirst({ where: { workspaceId, status: "pending_review", sourceGroupKey: input.sourceGroupKey } })
      : null;
    if (existing) {
      const record = await model("pendingSettingsDraft").update({ where: { id: (existing as { id: string }).id }, data });
      return record as PendingSettingsDraft;
    }
    const record = await model("pendingSettingsDraft").create({ data });
    return record as PendingSettingsDraft;
  }
  async updateStatus(workspaceId: string, draftId: string, status: PendingSettingsDraft["status"]) {
    // N-SEC-10 (2026-09-05). This used to update `where: { id: draftId }` with
    // no workspace in the clause, while the JSON repository has always required
    // BOTH. On Postgres — the substrate the product ships on — that let one
    // customer mark another customer's settings draft saved or discarded by
    // guessing its id. Same rule as every other tenant-scoped write here (see
    // LLMProviderCredential.update): find within the workspace first, and treat
    // a miss as not-found rather than reaching outside it.
    const existing = await model("pendingSettingsDraft").findFirst({ where: { id: draftId, workspaceId } });
    if (!existing) throw new Error("Pending settings draft not found.");
    const record = await model("pendingSettingsDraft").update({ where: { id: draftId }, data: { status } });
    return record as PendingSettingsDraft;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 / WP3 (2026-07-28) — Platform ticket + admin repositories (Prisma).
// Mirrors the JSON impls. Operator-side records: cross-workspace.
// ─────────────────────────────────────────────────────────────────────────────

function mapPlatformTicket(record: Record<string, unknown>): PlatformTicket {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    raisedByUserId: String(record.raisedByUserId),
    ticketNumber: Number(record.ticketNumber || 0),
    subject: String(record.subject || ""),
    description: String(record.description || ""),
    category: record.category as PlatformTicket["category"],
    status: record.status as PlatformTicket["status"],
    priority: String(record.priority) as PlatformTicket["priority"],
    assignedAdminId: record.assignedAdminId ? String(record.assignedAdminId) : undefined,
    isSpamFlagged: Boolean(record.isSpamFlagged),
    spamReason: record.spamReason ? String(record.spamReason) : undefined,
    flaggedByAdminId: record.flaggedByAdminId ? String(record.flaggedByAdminId) : undefined,
    slaStartedAt: iso(record.slaStartedAt),
    slaDueAt: iso(record.slaDueAt),
    firstResponseAt: record.firstResponseAt ? iso(record.firstResponseAt) : undefined,
    resolvedAt: record.resolvedAt ? iso(record.resolvedAt) : undefined,
    closedAt: record.closedAt ? iso(record.closedAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function mapPlatformTicketEvent(record: Record<string, unknown>): PlatformTicketEvent {
  return {
    id: String(record.id),
    ticketId: String(record.ticketId),
    workspaceId: String(record.workspaceId),
    eventType: record.eventType as PlatformTicketEvent["eventType"],
    actorType: record.actorType as PlatformTicketEvent["actorType"],
    actorUserId: record.actorUserId ? String(record.actorUserId) : undefined,
    actorAdminId: record.actorAdminId ? String(record.actorAdminId) : undefined,
    fromStatus: (record.fromStatus as PlatformTicketEvent["fromStatus"]) || undefined,
    toStatus: (record.toStatus as PlatformTicketEvent["toStatus"]) || undefined,
    note: record.note ? String(record.note) : undefined,
    createdAt: iso(record.createdAt),
  };
}

export class PlatformTicketPrismaRepository implements PlatformTicketRepository {
  async listForUser(workspaceId: string, filters?: { status?: PlatformTicket["status"]; category?: PlatformTicket["category"] }): Promise<PlatformTicket[]> {
    const rows = await model("platformTicket").findMany({
      where: { workspaceId, ...(filters?.status ? { status: filters.status } : {}), ...(filters?.category ? { category: filters.category } : {}) },
    });
    return rows.map(mapPlatformTicket).sort((a, b) => b.ticketNumber - a.ticketNumber);
  }

  async getForUser(workspaceId: string, ticketId: string): Promise<PlatformTicket | undefined> {
    const record = await model("platformTicket").findFirst({ where: { id: ticketId, workspaceId } });
    return record ? mapPlatformTicket(record) : undefined;
  }

  async listForOperator(filters?: {
    status?: PlatformTicket["status"];
    category?: PlatformTicket["category"];
    workspaceId?: string;
    includeSpamFlagged?: boolean;
  }): Promise<PlatformTicket[]> {
    const where: Record<string, unknown> = {};
    if (filters?.workspaceId) where.workspaceId = filters.workspaceId;
    if (filters?.status) where.status = filters.status;
    if (filters?.category) where.category = filters.category;
    if (!filters?.includeSpamFlagged) where.isSpamFlagged = false;
    const rows = await model("platformTicket").findMany({ where });
    return rows.map(mapPlatformTicket).sort((a, b) => b.ticketNumber - a.ticketNumber);
  }

  async getForOperator(ticketId: string): Promise<PlatformTicket | undefined> {
    const record = await model("platformTicket").findFirst({ where: { id: ticketId } });
    return record ? mapPlatformTicket(record) : undefined;
  }

  /**
   * Atomic create + GLOBAL ticketNumber allocation inside one $transaction.
   * Mirrors the proven OrderPrismaRepository.createWithNextOrderNumber pattern
   * (Stage A.1, pinned by golden:prisma-commercial-parity). Concurrent callers
   * cannot both get the same number.
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
    return await runTx(async (tx: unknown) => {
      const delegate = (tx as Record<string, Delegate>)["platformTicket"];
      const existing = await delegate.findMany({ select: { ticketNumber: true } });
      const max = existing.reduce((acc: number, r: Record<string, unknown>) => Math.max(acc, Number(r.ticketNumber || 0)), 0);
      const record = await delegate.create({
        data: {
          workspaceId: input.workspaceId,
          raisedByUserId: input.raisedByUserId,
          ticketNumber: max + 1,
          subject: input.subject,
          description: input.description,
          category: input.category,
          status: "open",
          priority: input.priority,
          isSpamFlagged: false,
          slaStartedAt: new Date(input.slaStartedAt),
          slaDueAt: new Date(input.slaDueAt),
        },
      });
      return mapPlatformTicket(record);
    });
  }

  async updateForOperator(ticketId: string, data: Partial<PlatformTicket>): Promise<PlatformTicket> {
    // Whitelist mutable fields; id/workspaceId/ticketNumber/raisedByUserId are immutable anchors.
    const update: Record<string, unknown> = {};
    if (data.status !== undefined) update.status = data.status;
    if (data.priority !== undefined) update.priority = data.priority;
    if (data.assignedAdminId !== undefined) update.assignedAdminId = data.assignedAdminId;
    if (data.isSpamFlagged !== undefined) update.isSpamFlagged = data.isSpamFlagged;
    if (data.spamReason !== undefined) update.spamReason = data.spamReason;
    if (data.flaggedByAdminId !== undefined) update.flaggedByAdminId = data.flaggedByAdminId;
    // Timestamp fields: an EXPLICIT value sets them; an explicit `undefined` or
    // `null` (passed by the caller to CLEAR, e.g. ticket reopen) maps to SQL
    // null. Stage 6 / 2026-07-31 split-brain fix: the previous
    // `if (data.X !== undefined)` guard SILENTLY DROPPED a clear-intent
    // undefined, so resolvedAt/closedAt were never cleared in Postgres on
    // reopen (only the status flipped) — invisible in JSON/demo mode. We now
    // clear whenever the key is PRESENT in the input, regardless of its value.
    if ("firstResponseAt" in data) update.firstResponseAt = data.firstResponseAt ? new Date(data.firstResponseAt) : null;
    if ("resolvedAt" in data) update.resolvedAt = data.resolvedAt ? new Date(data.resolvedAt) : null;
    if ("closedAt" in data) update.closedAt = data.closedAt ? new Date(data.closedAt) : null;
    const record = await model("platformTicket").update({ where: { id: ticketId }, data: update });
    return mapPlatformTicket(record);
  }
}

export class PlatformTicketEventPrismaRepository implements PlatformTicketEventRepository {
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
    const record = await model("platformTicketEvent").create({
      data: {
        ticketId: input.ticketId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        actorType: input.actorType,
        actorUserId: input.actorUserId || null,
        actorAdminId: input.actorAdminId || null,
        fromStatus: input.fromStatus || null,
        toStatus: input.toStatus || null,
        note: input.note || null,
      
      },
    });
    return mapPlatformTicketEvent(record);
  }

  async listByTicket(ticketId: string): Promise<PlatformTicketEvent[]> {
    const rows = await model("platformTicketEvent").findMany({ where: { ticketId } });
    return rows.map(mapPlatformTicketEvent).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export class PlatformSupportHoursPrismaRepository implements PlatformSupportHoursRepository {
  async get(): Promise<PlatformSupportHours> {
    let record = await model("platformSupportHours").findFirst({ where: { id: "default" } });
    if (!record) {
      record = await model("platformSupportHours").create({
        data: {
          id: "default",
          hoursStart: DEFAULT_BUSINESS_HOURS_START,
          hoursEnd: DEFAULT_BUSINESS_HOURS_END,
          businessDays: [...DEFAULT_BUSINESS_DAYS],
        },
      });
    }
    return {
      id: String(record.id),
      hoursStart: String(record.hoursStart),
      hoursEnd: String(record.hoursEnd),
      businessDays: (record.businessDays as number[]) || [...DEFAULT_BUSINESS_DAYS],
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }

  async update(input: Partial<PlatformSupportHours>): Promise<PlatformSupportHours> {
    // Ensure the singleton exists before updating.
    await this.get();
    const data: Record<string, unknown> = {};
    if (input.hoursStart) data.hoursStart = input.hoursStart;
    if (input.hoursEnd) data.hoursEnd = input.hoursEnd;
    if (input.businessDays) data.businessDays = input.businessDays;
    const record = await model("platformSupportHours").update({ where: { id: "default" }, data });
    return {
      id: String(record.id),
      hoursStart: String(record.hoursStart),
      hoursEnd: String(record.hoursEnd),
      businessDays: (record.businessDays as number[]) || [],
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }
}

export class PlatformTicketSlaSettingsPrismaRepository implements PlatformTicketSlaSettingsRepository {
  async get(): Promise<PlatformTicketSlaSettings> {
    let record = await model("platformTicketSlaSettings").findFirst({ where: { id: "default" } });
    if (!record) {
      record = await model("platformTicketSlaSettings").create({
        data: {
          id: "default",
          // 2026-09-28 (M9): working-time defaults, see DEFAULT_SLA_MINUTES.
          urgentSlaMinutes: DEFAULT_SLA_MINUTES.urgent,
          highSlaMinutes: DEFAULT_SLA_MINUTES.high,
          mediumSlaMinutes: DEFAULT_SLA_MINUTES.medium,
          lowSlaMinutes: DEFAULT_SLA_MINUTES.low,
          clockMode: DEFAULT_CLOCK_MODE,
        },
      });
    }
    return {
      id: String(record.id),
      urgentSlaMinutes: Number(record.urgentSlaMinutes),
      highSlaMinutes: Number(record.highSlaMinutes),
      mediumSlaMinutes: Number(record.mediumSlaMinutes),
      lowSlaMinutes: Number(record.lowSlaMinutes),
      clockMode: (record.clockMode as PlatformTicketSlaSettings["clockMode"]) || "business_hours",
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }

  async update(input: Partial<PlatformTicketSlaSettings>): Promise<PlatformTicketSlaSettings> {
    await this.get();
    const data: Record<string, unknown> = {};
    if (input.urgentSlaMinutes !== undefined) data.urgentSlaMinutes = input.urgentSlaMinutes;
    if (input.highSlaMinutes !== undefined) data.highSlaMinutes = input.highSlaMinutes;
    if (input.mediumSlaMinutes !== undefined) data.mediumSlaMinutes = input.mediumSlaMinutes;
    if (input.lowSlaMinutes !== undefined) data.lowSlaMinutes = input.lowSlaMinutes;
    if (input.clockMode) data.clockMode = input.clockMode;
    const record = await model("platformTicketSlaSettings").update({ where: { id: "default" }, data });
    return {
      id: String(record.id),
      urgentSlaMinutes: Number(record.urgentSlaMinutes),
      highSlaMinutes: Number(record.highSlaMinutes),
      mediumSlaMinutes: Number(record.mediumSlaMinutes),
      lowSlaMinutes: Number(record.lowSlaMinutes),
      clockMode: (record.clockMode as PlatformTicketSlaSettings["clockMode"]) || "business_hours",
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }
}

export class PlatformUserBlockPrismaRepository implements PlatformUserBlockRepository {
  async get(userId: string): Promise<PlatformUserBlock | undefined> {
    const record = await model("platformUserBlock").findFirst({ where: { userId } });
    if (!record) return undefined;
    return {
      id: String(record.id),
      userId: String(record.userId),
      workspaceId: String(record.workspaceId),
      isBlockedFromSupport: Boolean(record.isBlockedFromSupport),
      reason: record.reason ? String(record.reason) : undefined,
      blockedByAdminId: String(record.blockedByAdminId),
      blockedAt: iso(record.blockedAt),
    };
  }

  async isBlocked(userId: string): Promise<boolean> {
    const record = await model("platformUserBlock").findFirst({ where: { userId, isBlockedFromSupport: true } });
    return Boolean(record);
  }

  async upsert(input: {
    userId: string;
    workspaceId: string;
    isBlockedFromSupport: boolean;
    reason?: string;
    blockedByAdminId: string;
  }): Promise<PlatformUserBlock> {
    const data = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      isBlockedFromSupport: input.isBlockedFromSupport,
      reason: input.reason || null,
      blockedByAdminId: input.blockedByAdminId,
    };
    const record = await model("platformUserBlock").upsert({
      where: { userId: input.userId },
      create: data,
      update: data,
    });
    return {
      id: String(record.id),
      userId: String(record.userId),
      workspaceId: String(record.workspaceId),
      isBlockedFromSupport: Boolean(record.isBlockedFromSupport),
      reason: record.reason ? String(record.reason) : undefined,
      blockedByAdminId: String(record.blockedByAdminId),
      blockedAt: iso(record.blockedAt),
    };
  }
}

function mapPlatformAdmin(record: Record<string, unknown>): PlatformAdmin {
  return {
    id: String(record.id),
    email: String(record.email),
    name: String(record.name),
    role: record.role as PlatformAdmin["role"],
    status: record.status as PlatformAdmin["status"],
    lastLoginAt: record.lastLoginAt ? iso(record.lastLoginAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

// Stage 5 re-audit F-P2-7 (2026-07-28): extract the inline credential mapping
// into its own helper so EVERY Stage 5 type has a dedicated mapper (no inline
// casting). Pinned by golden:prisma-stage5-mappers.
function mapPlatformAdminCredential(record: Record<string, unknown>): PlatformAdminCredential {
  return {
    id: String(record.id),
    adminId: String(record.adminId),
    email: String(record.email),
    passwordHash: String(record.passwordHash),
    sessionVersion: typeof record.sessionVersion === "number" ? record.sessionVersion : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class PlatformAdminPrismaRepository implements PlatformAdminRepository {
  async findByEmail(email: string): Promise<{ admin: PlatformAdmin; credential: PlatformAdminCredential } | null> {
    const e = email.trim().toLowerCase();
    const admin = await model("platformAdmin").findFirst({ where: { email: e } });
    if (!admin) return null;
    const credential = await model("platformAdminCredential").findFirst({ where: { adminId: String(admin.id) } });
    if (!credential) return null;
    return {
      admin: mapPlatformAdmin(admin),
      credential: mapPlatformAdminCredential(credential),
    };
  }

  async findById(adminId: string): Promise<PlatformAdmin | undefined> {
    const record = await model("platformAdmin").findFirst({ where: { id: adminId } });
    return record ? mapPlatformAdmin(record) : undefined;
  }

  async hasAnyAdmin(): Promise<boolean> {
    const any = await model("platformAdmin").findFirst({ select: { id: true } });
    return Boolean(any);
  }

  async createWithCredential(input: {
    admin: Omit<PlatformAdmin, "createdAt" | "updatedAt">;
    credential: Omit<PlatformAdminCredential, "id" | "createdAt" | "updatedAt">;
  }): Promise<PlatformAdmin> {
    return await runTx(async (tx: unknown) => {
      const delegate = (tx as Record<string, Delegate>);
      const email = input.admin.email.trim().toLowerCase();
      const existing = await delegate["platformAdmin"].findFirst({ where: { email } });
      if (existing) throw new Error("A platform admin with this email already exists.");
      const admin = await delegate["platformAdmin"].create({
        data: {
          id: input.admin.id,
          email,
          name: input.admin.name,
          role: input.admin.role,
          status: input.admin.status,
          lastLoginAt: input.admin.lastLoginAt ? new Date(input.admin.lastLoginAt) : null,
        },
      });
      await delegate["platformAdminCredential"].create({
        data: {
          adminId: input.credential.adminId,
          email,
          passwordHash: input.credential.passwordHash,
        },
      });
      return mapPlatformAdmin(admin);
    });
  }

  async touchLogin(adminId: string): Promise<void> {
    await model("platformAdmin").update({ where: { id: adminId }, data: { lastLoginAt: new Date() } });
  }

  async listAll(): Promise<PlatformAdmin[]> {
    const rows = await model("platformAdmin").findMany({});
    return rows.map(mapPlatformAdmin);
  }

  async updateRole(adminId: string, role: PlatformAdmin["role"]): Promise<PlatformAdmin> {
    const record = await model("platformAdmin").update({ where: { id: adminId }, data: { role } });
    return mapPlatformAdmin(record);
  }

  async updateStatus(adminId: string, status: "active" | "suspended"): Promise<PlatformAdmin> {
    const record = await model("platformAdmin").update({ where: { id: adminId }, data: { status } });
    return mapPlatformAdmin(record);
  }  async getSessionVersion(adminId: string): Promise<number> {
    const cred = await model("platformAdminCredential").findFirst({ where: { adminId } });
    const v = cred ? (cred as Record<string, unknown>).sessionVersion : undefined;
    return typeof v === "number" ? v : 1;
  }

  async bumpSessionVersion(adminId: string): Promise<number> {
    const cred = await model("platformAdminCredential").findFirst({ where: { adminId } });
    if (!cred) return 0;
    // Atomic increment in the database: two sign-outs at once both count.
    const updated = await model("platformAdminCredential").update({
      where: { id: String((cred as Record<string, unknown>).id) },
      data: { sessionVersion: { increment: 1 } },
    });
    return Number((updated as Record<string, unknown>).sessionVersion) || 0;
  }
}

function mapPlatformAuditLog(record: Record<string, unknown>): PlatformAuditLog {
  return {
    id: String(record.id),
    adminId: String(record.adminId),
    action: record.action as PlatformAuditLog["action"],
    metadata: (record.metadata ? jsonObject(record.metadata) : undefined),
    createdAt: iso(record.createdAt),
  };
}

export class PlatformAuditLogPrismaRepository implements PlatformAuditLogRepository {
  async create(input: { adminId: string; action: PlatformAuditLog["action"]; metadata?: Record<string, unknown> }): Promise<PlatformAuditLog> {
    const record = await model("platformAuditLog").create({
      data: {
        adminId: input.adminId,
        action: input.action,
        metadata: input.metadata || undefined,
      
      },
    });
    return mapPlatformAuditLog(record);
  }

  async list(filters?: { adminId?: string; action?: PlatformAuditLog["action"]; limit?: number }): Promise<PlatformAuditLog[]> {
    const where: Record<string, unknown> = {};
    if (filters?.adminId) where.adminId = filters.adminId;
    if (filters?.action) where.action = filters.action;
    const rows = await model("platformAuditLog").findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...(filters?.limit ? { take: filters.limit } : {}),
    });
    return rows.map(mapPlatformAuditLog);
  }
}

// ─── Stage 5 / WP2 (2026-07-28) — operator admin ops repositories (Prisma) ───

export class UserPrismaRepository implements UserRepository {
  async findById(userId: string) {
    const record = await model("user").findFirst({ where: { id: userId } });
    return record ? (record as unknown as User) : undefined;
  }
  async listForWorkspace(workspaceId: string) {
    const rows = await model("user").findMany({ where: { workspaceId } });
    return rows as unknown as User[];
  }
  async create(input: Partial<User>) {
    return (await model("user").create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        workspaceId: input.workspaceId,
        name: input.name,
        email: input.email,
        role: input.role,
        ...(input.emailVerifiedAt ? { emailVerifiedAt: new Date(input.emailVerifiedAt) } : {}),
      
        createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
      },
    })) as unknown as User;
  }
  async update(userId: string, patch: Partial<User>) {
    const data: Record<string, unknown> = { ...patch };
    // Prisma expects a Date for the emailVerifiedAt column; convert ISO string.
    if (typeof data.emailVerifiedAt === "string") data.emailVerifiedAt = new Date(data.emailVerifiedAt);
    return (await model("user").update({ where: { id: userId }, data })) as unknown as User;
  }
}

export class UserCredentialPrismaRepository implements UserCredentialRepository {
  async findByUserId(userId: string) {
    const record = await model("userCredential").findFirst({ where: { userId } });
    return record ? (record as unknown as UserCredential) : undefined;
  }
  async updatePasswordAndBumpSession(userId: string, passwordHash: string) {
    // Read-then-write — acceptable here because only operators issue resets
    // (low frequency, not a hot path). The sessionVersion bump invalidates
    // existing sessions (sessions store the version at issue time).
    const existing = await model("userCredential").findFirst({ where: { userId } });
    if (!existing) throw new Error(`Credential for user ${userId} not found`);
    const nextVersion = (((existing as Record<string, unknown>).sessionVersion as number) || 0) + 1;
    return (await model("userCredential").update({
      where: { id: String((existing as Record<string, unknown>).id) },
      data: { passwordHash, sessionVersion: nextVersion },
    })) as unknown as UserCredential;
  }
  async create(input: Partial<UserCredential>) {
    return (await model("userCredential").create({ data: input })) as unknown as UserCredential;
  }
  async bumpSessionVersion(userId: string): Promise<number> {
    const existing = await model("userCredential").findFirst({ where: { userId } });
    if (!existing) return 0;
    const current = (existing as Record<string, unknown>).sessionVersion;
    // A null version reads as 1 everywhere; set it explicitly rather than
    // incrementing null (which stays null in SQL).
    const updated = typeof current === "number"
      ? await model("userCredential").update({ where: { id: String((existing as Record<string, unknown>).id) }, data: { sessionVersion: { increment: 1 } } })
      : await model("userCredential").update({ where: { id: String((existing as Record<string, unknown>).id) }, data: { sessionVersion: 2 } });
    return Number((updated as Record<string, unknown>).sessionVersion) || 0;
  }
}

// Stage 5 re-audit F-P2-7 (2026-07-28): explicit field-by-field mappers for
// the Stage 5 types. Replaces raw `as unknown as <Type>` casts that hid
// Date-vs-string and field-rename bugs. Each mapper converts every field,
// especially `iso(date)` for timestamps (Prisma returns Date objects; the
// domain types expect ISO strings). Pinned by golden:prisma-stage5-mappers.
function mapFeatureFlag(record: Record<string, unknown>): FeatureFlag {
  return {
    id: String(record.id),
    key: String(record.key),
    workspaceId: record.workspaceId === null ? null : String(record.workspaceId ?? ""),
    enabled: Boolean(record.enabled),
    lastToggledByAdminId: String(record.lastToggledByAdminId ?? ""),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class FeatureFlagPrismaRepository implements FeatureFlagRepository {
  async getByKey(key: string) {
    const record = await model("featureFlag").findFirst({ where: { key, workspaceId: null } });
    return record ? mapFeatureFlag(record) : undefined;
  }
  async upsert(input: { key: string; enabled: boolean; lastToggledByAdminId: string }) {
    const existing = await model("featureFlag").findFirst({ where: { key: input.key, workspaceId: null } });
    if (existing) {
      const updated = await model("featureFlag").update({
        where: { id: String((existing as Record<string, unknown>).id) },
        data: { enabled: input.enabled, lastToggledByAdminId: input.lastToggledByAdminId },
      });
      return mapFeatureFlag(updated);
    }
    const created = await model("featureFlag").create({
      data: { key: input.key, workspaceId: null, enabled: input.enabled, lastToggledByAdminId: input.lastToggledByAdminId  },
    });
    return mapFeatureFlag(created);
  }
  async listAll() {
    const rows = await model("featureFlag").findMany({ orderBy: { updatedAt: "desc" } });
    return rows.map((r: Record<string, unknown>) => mapFeatureFlag(r));
  }
}

function mapPasswordResetToken(record: Record<string, unknown>): PasswordResetToken {
  return {
    id: String(record.id),
    userId: String(record.userId),
    workspaceId: String(record.workspaceId),
    tokenHash: String(record.tokenHash),
    issuedAt: iso(record.issuedAt),
    expiresAt: iso(record.expiresAt),
    consumedAt: record.consumedAt == null ? undefined : iso(record.consumedAt),
    issuedByAdminId: String(record.issuedByAdminId ?? ""),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class PasswordResetTokenPrismaRepository implements PasswordResetTokenRepository {
  async redeem(tokenHash: string, passwordHash: string) {
    return runTx(async (tx: unknown) => {
      const delegate = tx as Record<string, Delegate>;
      const now = new Date();
      const token = await delegate.passwordResetToken.findFirst({ where: { tokenHash, consumedAt: null, expiresAt: { gt: now } } });
      if (!token) return undefined;
      // Conditional UPDATE locks the token row. A concurrent worker cannot spend it twice.
      const claimed = await delegate.passwordResetToken.updateMany!({ where: { id: token.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } }) as { count: number };
      if (claimed.count !== 1) return undefined;
      const credential = await delegate.userCredential.findFirst({ where: { userId: token.userId, workspaceId: token.workspaceId } });
      if (!credential) throw new Error("Password reset credential not found");
      await delegate.userCredential.update({ where: { id: credential.id }, data: { passwordHash, sessionVersion: credential.sessionVersion == null ? 2 : { increment: 1 } } });
      return { userId: String(token.userId), workspaceId: String(token.workspaceId), completedAt: now.toISOString() };
    });
  }
  async create(input: {
    userId: string; workspaceId: string; tokenHash: string;
    issuedAt: string; expiresAt: string; issuedByAdminId: string;
  }) {
    const record = await model("passwordResetToken").create({
      data: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        tokenHash: input.tokenHash,
        issuedAt: new Date(input.issuedAt),
        expiresAt: new Date(input.expiresAt),
        issuedByAdminId: input.issuedByAdminId,
      
      },
    });
    return mapPasswordResetToken(record);
  }
  async findLatestForUser(userId: string) {
    const rows = await model("passwordResetToken").findMany({
      where: { userId, consumedAt: null },
      orderBy: { issuedAt: "desc" },
      take: 1,
    });
    return rows[0] ? mapPasswordResetToken(rows[0]) : undefined;
  }
  /**
   * Stage 5 re-audit fix (F-P0-4, 2026-07-28). Find a reset token by its
   * SHA-256 hash. Mirrors EmailVerificationToken.findByTokenHash.
   */
  async findByTokenHash(tokenHash: string) {
    const record = await model("passwordResetToken").findFirst({ where: { tokenHash } });
    return record ? mapPasswordResetToken(record) : undefined;
  }
  async markConsumed(tokenId: string) {
    await model("passwordResetToken").update({ where: { id: tokenId }, data: { consumedAt: new Date() } });
  }
}

function mapImpersonationSession(record: Record<string, unknown>): ImpersonationSession {
  return {
    id: String(record.id),
    adminId: String(record.adminId),
    targetUserId: String(record.targetUserId),
    targetWorkspaceId: String(record.targetWorkspaceId),
    tokenHash: String(record.tokenHash),
    startedAt: iso(record.startedAt),
    expiresAt: iso(record.expiresAt),
    endedAt: record.endedAt == null ? undefined : iso(record.endedAt),
    reason: String(record.reason ?? ""),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class ImpersonationSessionPrismaRepository implements ImpersonationSessionRepository {
  async create(input: {
    adminId: string; targetUserId: string; targetWorkspaceId: string;
    tokenHash: string; startedAt: string; expiresAt: string; reason: string;
  }) {
    const record = await model("impersonationSession").create({
      data: {
        adminId: input.adminId,
        targetUserId: input.targetUserId,
        targetWorkspaceId: input.targetWorkspaceId,
        tokenHash: input.tokenHash,
        startedAt: new Date(input.startedAt),
        expiresAt: new Date(input.expiresAt),
        reason: input.reason,
      
      },
    });
    return mapImpersonationSession(record);
  }
  async findByTokenHash(tokenHash: string) {
    const record = await model("impersonationSession").findFirst({ where: { tokenHash } });
    return record ? mapImpersonationSession(record) : undefined;
  }
  async findActiveForAdmin(adminId: string) {
    const record = await model("impersonationSession").findFirst({
      where: { adminId, endedAt: null, expiresAt: { gt: new Date() } },
    });
    return record ? mapImpersonationSession(record) : undefined;
  }
  async markEnded(sessionId: string) {
    await model("impersonationSession").update({ where: { id: sessionId }, data: { endedAt: new Date() } });
  }
}

// ─── Stage 5 / WP1 (2026-07-28) — signup verification + invites ────────────

function mapEmailVerificationToken(record: Record<string, unknown>): EmailVerificationToken {
  return {
    id: String(record.id),
    userId: String(record.userId),
    workspaceId: String(record.workspaceId),
    tokenHash: String(record.tokenHash),
    issuedAt: iso(record.issuedAt),
    expiresAt: iso(record.expiresAt),
    consumedAt: record.consumedAt == null ? undefined : iso(record.consumedAt),
    source: (record.source === "reissue" ? "reissue" : "signup"),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class EmailVerificationTokenPrismaRepository implements EmailVerificationTokenRepository {
  async verifyAndConsume(tokenHash: string) {
    return runTx(async (tx: unknown) => {
      const delegate = tx as Record<string, Delegate>;
      const now = new Date();
      const token = await delegate.emailVerificationToken.findFirst({ where: { tokenHash, expiresAt: { gt: now } } });
      if (!token) return undefined;
      const user = await delegate.user.findFirst({ where: { id: token.userId, workspaceId: token.workspaceId } });
      if (!user) throw new Error("Verification user not found");
      if (token.consumedAt) return user.emailVerifiedAt ? iso(user.emailVerifiedAt) : undefined;
      const claimed = await delegate.emailVerificationToken.updateMany!({ where: { id: token.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } }) as { count: number };
      if (claimed.count !== 1) {
        const latest = await delegate.user.findFirst({ where: { id: token.userId, workspaceId: token.workspaceId } });
        return latest?.emailVerifiedAt ? iso(latest.emailVerifiedAt) : undefined;
      }
      const verifiedAt = user.emailVerifiedAt ? iso(user.emailVerifiedAt) : now.toISOString();
      await delegate.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(verifiedAt) } });
      return verifiedAt;
    });
  }
  async create(input: {
    userId: string; workspaceId: string; tokenHash: string;
    issuedAt: string; expiresAt: string; source: "signup" | "reissue";
  }) {
    const record = await model("emailVerificationToken").create({
      data: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        tokenHash: input.tokenHash,
        issuedAt: new Date(input.issuedAt),
        expiresAt: new Date(input.expiresAt),
        source: input.source,
      
      },
    });
    return mapEmailVerificationToken(record);
  }
  async findLatestForUser(userId: string) {
    const rows = await model("emailVerificationToken").findMany({
      where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { issuedAt: "desc" },
      take: 1,
    });
    return rows[0] ? mapEmailVerificationToken(rows[0]) : undefined;
  }
  async findByTokenHash(tokenHash: string) {
    const record = await model("emailVerificationToken").findFirst({ where: { tokenHash } });
    return record ? mapEmailVerificationToken(record) : undefined;
  }
  async markConsumed(tokenId: string) {
    await model("emailVerificationToken").update({ where: { id: tokenId }, data: { consumedAt: new Date() } });
  }
  async invalidatePriorTokens(userId: string) {
    // Mark all prior unconsumed tokens as consumed (one-shot semantics on re-issue).
    const delegate = model("emailVerificationToken");
    if (delegate.updateMany) {
      await delegate.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    } else {
      // Fallback: find + update each (for runtimes without updateMany).
      const rows = await delegate.findMany({ where: { userId, consumedAt: null } });
      for (const row of rows) {
        await delegate.update({ where: { id: String((row as Record<string, unknown>).id) }, data: { consumedAt: new Date() } });
      }
    }
  }
  async listForUserId(userId: string) {
    const rows = await model("emailVerificationToken").findMany({
      where: { userId },
      orderBy: { issuedAt: "desc" },
    });
    return rows.map((r: Record<string, unknown>) => mapEmailVerificationToken(r));
  }
}

function mapInvite(record: Record<string, unknown>): Invite {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    email: String(record.email),
    role: String(record.role) as WorkspaceRole,
    tokenHash: String(record.tokenHash),
    status: String(record.status) as Invite["status"],
    invitedByUserId: String(record.invitedByUserId),
    acceptedByUserId: record.acceptedByUserId == null ? undefined : String(record.acceptedByUserId),
    createdAt: iso(record.createdAt),
    expiresAt: iso(record.expiresAt),
    resolvedAt: record.resolvedAt == null ? undefined : iso(record.resolvedAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class InvitePrismaRepository implements InviteRepository {
  async create(input: {
    workspaceId: string; email: string; role: WorkspaceRole;
    tokenHash: string; invitedByUserId: string; expiresAt: string;
  }) {
    const record = await model("invite").create({
      data: {
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        status: "pending",
        invitedByUserId: input.invitedByUserId,
        expiresAt: new Date(input.expiresAt),
      
      },
    });
    return mapInvite(record);
  }
  async findById(inviteId: string) {
    const record = await model("invite").findFirst({ where: { id: inviteId } });
    return record ? mapInvite(record) : undefined;
  }
  async findByTokenHash(tokenHash: string) {
    const record = await model("invite").findFirst({ where: { tokenHash } });
    return record ? mapInvite(record) : undefined;
  }
  async findPendingForEmail(workspaceId: string, email: string) {
    const record = await model("invite").findFirst({
      where: { workspaceId, email, status: "pending" },
    });
    return record ? mapInvite(record) : undefined;
  }
  async listByWorkspace(workspaceId: string) {
    const rows = await model("invite").findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r: Record<string, unknown>) => mapInvite(r));
  }
  async markAccepted(inviteId: string, acceptedByUserId: string) {
    await model("invite").update({
      where: { id: inviteId },
      data: { status: "accepted", acceptedByUserId, resolvedAt: new Date() },
    });
  }
  async markRevoked(inviteId: string) {
    await model("invite").update({
      where: { id: inviteId },
      data: { status: "revoked", resolvedAt: new Date() },
    });
  }
  /**
   * Stage 5 re-audit fix (F-P2-8, 2026-07-28). Delete all NON-pending invites
   * for (workspaceId, email) so the table doesn't accumulate one row per
   * status combo (the +status unique constraint otherwise allows unbounded
   * growth). Pinned by golden:stage5-batch4-chokepoints CASE 9.
   */
  async deleteNonPendingForEmail(workspaceId: string, email: string): Promise<number> {
    const delegate = model("invite");
    if (delegate.deleteMany) {
      const result = await delegate.deleteMany({
        where: { workspaceId, email, NOT: { status: "pending" } },
      });
      return typeof result.count === "number" ? result.count : 0;
    }
    // Fallback for runtimes without deleteMany: find + delete each.
    const rows = await delegate.findMany({
      where: { workspaceId, email, NOT: { status: "pending" } },
    });
    for (const row of rows) {
      await delegate.delete({ where: { id: String((row as Record<string, unknown>).id) } });
    }
    return rows.length;
  }
  /**
   * Stage 5 re-audit fix (F-P0-2, 2026-07-28). Atomically accept an invite in
   * ONE prisma.$transaction: create User + UserCredential, activate the invited
   * member row, mark the invite accepted. Pinned by golden:signup-invite-
   * atomicity CASE C (the golden runs against JSON; this Prisma impl mirrors
   * the same contract for the cutover runtime).
   */
  async acceptInviteAtomically(input: {
    inviteId: string;
    user: User;
    credential: UserCredential;
    memberEmail: string;
    memberName?: string;
    workspaceId: string;
  }): Promise<User> {
    return await runTx(async (tx: unknown) => {
      const delegate = (tx as Record<string, Delegate>);
      // F-DATA-3 (2026-08-04): re-check the invite status INSIDE the
      // transaction. Without this, the User row is created BEFORE the
      // credential insert fails on the @@unique([workspaceId, email]) index,
      // leaving an orphan user on a double-accept. Mirrors the JSON repo's
      // in-transaction re-check + the F-P1-8 signup fix.
      const curInvite = await delegate["invite"].findFirst({ where: { id: input.inviteId } }) as Record<string, unknown> | null;
      if (curInvite && curInvite.status === "accepted") {
        throw new Error("Invite has already been accepted.");
      }
      await delegate["user"].create({ data: {
        id: input.user.id, workspaceId: input.user.workspaceId,
        name: input.user.name, email: input.user.email, role: input.user.role,
      } });
      await delegate["userCredential"].create({ data: {
        id: input.credential.id, userId: input.credential.userId,
        workspaceId: input.credential.workspaceId,
        email: input.credential.email, passwordHash: input.credential.passwordHash,
        sessionVersion: input.credential.sessionVersion ?? 1,
      } });
      // Activate the invited member row (find by workspace + email + status=invited).
      // Use the same updateMany-optional pattern as invalidatePriorTokens above
      // (some Prisma runtimes don't expose updateMany on the tx delegate).
      const memberDelegate = delegate["workspaceMember"];
      if (memberDelegate?.updateMany) {
        await memberDelegate.updateMany({
          where: { workspaceId: input.workspaceId, email: input.memberEmail, status: "invited" },
          data: { userId: input.user.id, name: input.memberName ?? undefined, status: "active", updatedAt: new Date() },
        });
      } else {
        // Fallback: find + update each (for runtimes without updateMany).
        const rows = await memberDelegate.findMany({
          where: { workspaceId: input.workspaceId, email: input.memberEmail, status: "invited" },
        });
        for (const row of rows) {
          await memberDelegate.update({
            where: { id: String((row as Record<string, unknown>).id) },
            data: { userId: input.user.id, name: input.memberName ?? undefined, status: "active", updatedAt: new Date() },
          });
        }
      }
      await delegate["invite"].update({
        where: { id: input.inviteId },
        data: { status: "accepted", acceptedByUserId: input.user.id, resolvedAt: new Date() },
      });
      return input.user;
    });
  }
  async backdateForTesting(inviteId: string, createdAt: string) {
    const createdMs = Date.parse(createdAt);
    const expiresMs = createdMs + 7 * 24 * 60 * 60 * 1000;
    await model("invite").update({
      where: { id: inviteId },
      data: { createdAt: new Date(createdMs), expiresAt: new Date(expiresMs) },
    });
  }
}

// ─── Owner Copilot (2026-08-01) — owner-facing assistant chat ───────────────
function mapOwnerCopilotConversation(record: Record<string, unknown>): OwnerCopilotConversation {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    ownerUserId: String(record.ownerUserId),
    activeLeadId: record.activeLeadId == null ? undefined : String(record.activeLeadId),
    clarifyBatchCount: Number(record.clarifyBatchCount) || 0,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function mapOwnerCopilotMessage(record: Record<string, unknown>): OwnerCopilotMessage {
  const pending = record.pendingActionJson as OwnerCopilotMessage["pendingAction"] | undefined;
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    conversationId: String(record.conversationId),
    role: String(record.role) as OwnerCopilotMessage["role"],
    kind: String(record.kind) as OwnerCopilotMessage["kind"],
    text: String(record.text),
    language: (String(record.language) || "unknown") as OwnerCopilotMessage["language"],
    tier: record.tier == null ? undefined : (String(record.tier) as OwnerCopilotMessage["tier"]),
    pendingAction: pending,
    createdAt: iso(record.createdAt),
  };
}

function mapFollowUp(record: Record<string, unknown>): FollowUp {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    leadId: String(record.leadId),
    dueOn: record.dueOn == null ? undefined : String(record.dueOn),
    note: String(record.note || ""),
    source: String(record.source || "owner") as FollowUp["source"],
    evidence: record.evidence == null ? undefined : String(record.evidence),
    status: String(record.status || "open") as FollowUp["status"],
    kind: record.kind == null ? undefined : (String(record.kind) as FollowUp["kind"]),
    cycleKey: record.cycleKey == null ? undefined : String(record.cycleKey),
    createdBy: record.createdBy == null ? undefined : String(record.createdBy),
    doneAt: record.doneAt ? iso(record.doneAt) : undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export class FollowUpPrismaRepository implements FollowUpRepository {
  async create(workspaceId: string, input: Partial<FollowUp> & { leadId: string; note: string }) {
    return mapFollowUp(await model("followUp").create({ data: {
      id: input.id, workspaceId, leadId: input.leadId, dueOn: input.dueOn ?? null, note: input.note,
      source: input.source || "owner", evidence: input.evidence ?? null, status: input.status || "open",
      kind: input.kind ?? null, cycleKey: input.cycleKey ?? null,
      createdBy: input.createdBy ?? null, doneAt: input.doneAt ? new Date(input.doneAt) : null, createdAt: input.createdAt,
    } }));
  }
  async getById(workspaceId: string, id: string) {
    const record = await model("followUp").findFirst({ where: { workspaceId, id } });
    return record ? mapFollowUp(record) : undefined;
  }
  async listByWorkspace(workspaceId: string, filters: { status?: FollowUp["status"]; leadId?: string } = {}) {
    const where: Record<string, unknown> = { workspaceId };
    if (filters.status) where.status = filters.status;
    if (filters.leadId) where.leadId = filters.leadId;
    return (await model("followUp").findMany({ where, orderBy: { createdAt: "asc" } })).map(mapFollowUp);
  }
  async update(workspaceId: string, id: string, data: Partial<FollowUp>) {
    await assertScoped(model("followUp"), workspaceId, id, "FollowUp");
    const patch: Record<string, unknown> = {};
    if (data.dueOn !== undefined) patch.dueOn = data.dueOn || null;
    if (data.note !== undefined) patch.note = data.note;
    if (data.status !== undefined) patch.status = data.status;
    if (data.evidence !== undefined) patch.evidence = data.evidence || null;
    if (data.kind !== undefined) patch.kind = data.kind || null;
    if (data.doneAt !== undefined) patch.doneAt = data.doneAt ? new Date(data.doneAt) : null;
    return mapFollowUp(await model("followUp").update({ where: { id }, data: patch }));
  }
  async deleteByLead(workspaceId: string, leadId: string) {
    const outcome = (await model("followUp").deleteMany({ where: { workspaceId, leadId } })) as { count?: number };
    return outcome?.count ?? 0;
  }
}

function mapOutcomeSignal(record: Record<string, unknown>): OutcomeSignal {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    leadId: String(record.leadId),
    kind: String(record.kind) as OutcomeSignal["kind"],
    at: iso(record.at),
    value: record.value == null ? undefined : Number(record.value),
    relatedReplyIds: Array.isArray(record.relatedReplyIds) ? (record.relatedReplyIds as unknown[]).map(String) : [],
    sourceId: record.sourceId == null ? undefined : String(record.sourceId),
    createdAt: iso(record.createdAt),
  };
}

/**
 * 2026-09-28 — outcome signals. The unique index (workspace, kind, source_id)
 * makes a second write of the same order / ticket a no-op: the loser of a race
 * reads back the winner's row.
 */
export class OutcomeSignalPrismaRepository implements OutcomeSignalRepository {
  async create(workspaceId: string, input: Omit<OutcomeSignal, "id" | "workspaceId" | "createdAt"> & { id?: string }) {
    if (input.sourceId) {
      const existing = await model("outcomeSignal").findFirst({ where: { workspaceId, kind: input.kind, sourceId: input.sourceId } });
      if (existing) return mapOutcomeSignal(existing);
    }
    try {
      return mapOutcomeSignal(await model("outcomeSignal").create({ data: {
        id: input.id, workspaceId, leadId: input.leadId, kind: input.kind, at: new Date(input.at),
        value: input.value ?? null, relatedReplyIds: input.relatedReplyIds ?? [], sourceId: input.sourceId ?? null,
      } }));
    } catch (error) {
      if (input.sourceId && (error as { code?: string })?.code === "P2002") {
        const existing = await model("outcomeSignal").findFirst({ where: { workspaceId, kind: input.kind, sourceId: input.sourceId } });
        if (existing) return mapOutcomeSignal(existing);
      }
      throw error;
    }
  }
  async listByWorkspace(workspaceId: string, filters: { leadId?: string; kind?: OutcomeSignal["kind"]; since?: string } = {}) {
    const where: Record<string, unknown> = { workspaceId };
    if (filters.leadId) where.leadId = filters.leadId;
    if (filters.kind) where.kind = filters.kind;
    if (filters.since) where.at = { gte: new Date(filters.since) };
    return (await model("outcomeSignal").findMany({ where, orderBy: { at: "asc" } })).map(mapOutcomeSignal);
  }
  async deleteByLead(workspaceId: string, leadId: string) {
    const outcome = (await model("outcomeSignal").deleteMany({ where: { workspaceId, leadId } })) as { count?: number };
    return outcome?.count ?? 0;
  }
}

export class OwnerCopilotConversationPrismaRepository implements OwnerCopilotConversationRepository {
  async create(input: Partial<OwnerCopilotConversation> & { workspaceId: string; ownerUserId: string }) {
    const record = await model("ownerCopilotConversation").create({
      data: {
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        activeLeadId: input.activeLeadId ?? null,
        clarifyBatchCount: input.clarifyBatchCount ?? 0,
      
        createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
      },
    });
    return mapOwnerCopilotConversation(record);
  }
  async getById(workspaceId: string, id: string) {
    const record = await model("ownerCopilotConversation").findFirst({ where: { workspaceId, id } });
    return record ? mapOwnerCopilotConversation(record) : undefined;
  }
  async getActiveForOwner(workspaceId: string, ownerUserId: string) {
    const rows = await model("ownerCopilotConversation").findMany({
      where: { workspaceId, ownerUserId },
      orderBy: { updatedAt: "desc" },
      take: 1,
    });
    return rows[0] ? mapOwnerCopilotConversation(rows[0]) : undefined;
  }
  async listForOwner(workspaceId: string, ownerUserId: string, limit = 30) {
    const rows = await model("ownerCopilotConversation").findMany({
      where: { workspaceId, ownerUserId },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return rows.map(mapOwnerCopilotConversation);
  }
  /** 2026-09-28 (S5) — erasure: stop pointing at an erased customer. */
  async clearActiveLead(workspaceId: string, leadId: string) {
    return Number((await model("ownerCopilotConversation").updateMany!({ where: { workspaceId, activeLeadId: leadId }, data: { activeLeadId: null } }) as { count?: number }).count || 0);
  }
  async update(workspaceId: string, id: string, data: Partial<OwnerCopilotConversation>) {
    await assertScoped(model("ownerCopilotConversation"), workspaceId, id, "OwnerCopilotConversation");
    const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
    if (data.activeLeadId !== undefined) updateData.activeLeadId = data.activeLeadId;
    const record = await model("ownerCopilotConversation").update({ where: { id }, data: updateData });
    return mapOwnerCopilotConversation(record);
  }
}

export class OwnerCopilotMessagePrismaRepository implements OwnerCopilotMessageRepository {
  async claimConfirmation(input: Parameters<OwnerCopilotMessageRepository["claimConfirmation"]>[0]) {
    return runTx(async (tx: unknown) => {
      const delegate = tx as Record<string, Delegate>;
      const sql = tx as { $executeRawUnsafe(query: string, value: string): Promise<unknown> };
      // Transaction-scoped locking serializes the same conversation across
      // server processes; every contender rechecks the committed claim.
      await sql.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", `copilot-confirm:${input.workspaceId}:${input.conversationId}`);
      const conversation = await delegate.ownerCopilotConversation.findFirst({ where: { id: input.conversationId, workspaceId: input.workspaceId, ownerUserId: input.ownerUserId } });
      if (!conversation) return false;
      const rows = await delegate.ownerCopilotMessage.findMany({ where: { workspaceId: input.workspaceId, conversationId: input.conversationId } });
      const messages = rows.map(mapOwnerCopilotMessage);
      const proposal = messages.find(row => row.id === input.proposalMessageId && row.role === "copilot" && row.kind === "copilot_confirm" && row.tier === "T3" && row.pendingAction?.entityId === input.pendingActionId && row.pendingAction.intent === input.intent);
      if (!proposal || messages.some(row => row.role === "owner" && row.pendingAction?.entityId === input.pendingActionId)) return false;
      await delegate.ownerCopilotMessage.create({ data: { workspaceId: input.workspaceId, conversationId: input.conversationId, role: "owner", kind: "owner_input", text: input.text, language: input.language, tier: "T3", pendingActionJson: proposal.pendingAction } });
      return true;
    });
  }
  async create(input: Partial<OwnerCopilotMessage> & { workspaceId: string; conversationId: string; role: OwnerCopilotMessage["role"]; kind: OwnerCopilotMessage["kind"]; text: string }) {
    const record = await model("ownerCopilotMessage").create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        role: input.role,
        kind: input.kind,
        text: input.text,
        language: input.language || "unknown",
        tier: input.tier ?? null,
        pendingActionJson: (input.pendingAction ?? null) as unknown as never,
      
        createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
      },
    });
    return mapOwnerCopilotMessage(record);
  }
  async listByConversation(workspaceId: string, conversationId: string) {
    const rows = await model("ownerCopilotMessage").findMany({
      where: { workspaceId, conversationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r: Record<string, unknown>) => mapOwnerCopilotMessage(r));
  }
}

/**
 * Should this collection be fetched for this snapshot? (N16, 2026-09-18)
 *
 * Exported and named rather than inlined, because it is the single most
 * dangerous line in the narrowing: inverted, EVERY caller that names nothing
 * receives empty collections, and forty call sites would start reading an empty
 * database while the writer, which never deletes, hid the damage until somebody
 * noticed a duplicate. A predicate can be tested on its own; a boolean buried in
 * an arrow function inside a sixty-entry Promise.all cannot.
 *
 * No `collections` means EVERYTHING, exactly as before this option existed.
 */
export function shouldLoadCollection(collection: string, options?: SnapshotOptions): boolean {
  if (!options?.collections) return true;
  return (options.collections as readonly string[]).includes(collection);
}

export function createPrismaRepositories() {
  return {
    workspace: new WorkspacePrismaRepository(),
    businessProfile: new BusinessProfilePrismaRepository(),
    icp: new ICPPrismaRepository(),
    campaign: new CampaignPrismaRepository(),
    lead: new LeadPrismaRepository(),
    messageTemplate: new MessageTemplatePrismaRepository(),
    outreachActivity: new OutreachActivityPrismaRepository(),
    reply: new ReplyPrismaRepository(),
    agentRun: new AgentRunPrismaRepository(),
    auditLog: new AuditLogPrismaRepository(),
    integration: new IntegrationPrismaRepository(),
    websiteCrawlJob: new WebsiteCrawlJobPrismaRepository(),
    websiteCrawlConsent: new WebsiteCrawlConsentPrismaRepository(),
    websiteCrawlPage: new WebsiteCrawlPagePrismaRepository(),
    businessExtraction: new BusinessExtractionPrismaRepository(),
    campaignLearning: new CampaignLearningPrismaRepository(),
    campaignMetric: new CampaignMetricPrismaRepository(),
    eventLog: new EventLogPrismaRepository(),
    jobRun: new JobRunPrismaRepository(),
    agentBehaviorPolicy: new AgentBehaviorPolicyPrismaRepository(),
    companyCommunicationSettings: new CompanyCommunicationSettingsPrismaRepository(),
    conversationPolicy: new ConversationPolicyPrismaRepository(),
    whatsAppAgentSettings: new WhatsAppAgentSettingsPrismaRepository(),
    escalationRule: new EscalationRulePrismaRepository(),
    unknownQuestion: new UnknownQuestionPrismaRepository(),
    // Stage 2 (2026-07-20) — tickets. Uses the same model() pattern; needs
    // Ticket, TicketEvent, TicketSlaSettings models in the Prisma schema
    // (added in the same session). Until `prisma generate` is re-run after
    // `prisma db push`, calls will throw — that's honest, no silent data loss.
    ticket: new TicketPrismaRepository(),
    ticketEvent: new TicketEventPrismaRepository(),
    ticketSlaSettings: new TicketSlaSettingsPrismaRepository(),
    // Stage 3 (2026-07-21 / M7) — orders + quotes. Prisma stubs that
    // Stage A.1 (2026-07-26) — REAL Prisma Order + Quote repositories (were
    // throwing stubs). Mirror the JSON repos 1:1 incl. atomic number
    // allocation. Pinned by golden:prisma-commercial-parity.
    order: new OrderPrismaRepository(),
    quote: new QuotePrismaRepository(),
    autoReplyLog: new AutoReplyLogPrismaRepository(),
    doNotContact: new DoNotContactPrismaRepository(),
    mediaCatalog: new MediaCatalogPrismaRepository(),
    whatsAppTemplate: new WhatsAppTemplatePrismaRepository(),
    knowledgeBaseDocument: new KnowledgeBaseDocumentPrismaRepository(),
    knowledgeBaseChunk: new KnowledgeBaseChunkPrismaRepository(),
    knowledgeBaseQueryLog: new KnowledgeBaseQueryLogPrismaRepository(),
    llmProviderCredential: new LLMProviderCredentialPrismaRepository(),
    llmModelRouting: new LLMModelRoutingPrismaRepository(),
    aiUsageLimit: new AIUsageLimitPrismaRepository(),
    productKnowledge: new ProductKnowledgePrismaRepository(),
    productVariety: new ProductVarietyPrismaRepository(),
    productApplication: new ProductApplicationPrismaRepository(),
    buyerSegment: new BuyerSegmentPrismaRepository(),
    productApplicationMarketMap: new ProductApplicationMarketMapPrismaRepository(),
    leadReviewSettings: new LeadReviewSettingsPrismaRepository(),
    leadReviewDecision: new LeadReviewDecisionPrismaRepository(),
    providerAccount: new ProviderAccountPrismaRepository(),
    agentAutonomousSettings: new AgentAutonomousSettingsPrismaRepository(),
    salesSettings: new SalesSettingsPrismaRepository(),
    productSettings: new ProductSettingsPrismaRepository(),
    policySettings: new PolicySettingsPrismaRepository(),
    communicationSettings: new CommunicationSettingsPrismaRepository(),
    settingsConflict: new SettingsConflictPrismaRepository(),
    pendingSettingsDraft: new PendingSettingsDraftPrismaRepository(),
    // Stage 5 / WP3 (2026-07-28) — platform tickets + admin auth.
    platformTicket: new PlatformTicketPrismaRepository(),
    platformTicketEvent: new PlatformTicketEventPrismaRepository(),
    platformSupportHours: new PlatformSupportHoursPrismaRepository(),
    platformTicketSlaSettings: new PlatformTicketSlaSettingsPrismaRepository(),
    platformUserBlock: new PlatformUserBlockPrismaRepository(),
    platformAdmin: new PlatformAdminPrismaRepository(),
    platformAuditLog: new PlatformAuditLogPrismaRepository(),
    // Stage 5 / WP2 (2026-07-28) — operator admin ops.
    user: new UserPrismaRepository(),
    userCredential: new UserCredentialPrismaRepository(),
    featureFlag: new FeatureFlagPrismaRepository(),
    passwordResetToken: new PasswordResetTokenPrismaRepository(),
    impersonationSession: new ImpersonationSessionPrismaRepository(),
    // Stage 5 / WP1 (2026-07-28) — signup verification + invites.
    emailVerificationToken: new EmailVerificationTokenPrismaRepository(),
    invite: new InvitePrismaRepository(),
    // Owner Copilot (2026-08-01) — owner-facing assistant chat.
    ownerCopilotConversation: new OwnerCopilotConversationPrismaRepository(),
    ownerCopilotMessage: new OwnerCopilotMessagePrismaRepository(),
    followUp: new FollowUpPrismaRepository(),
    outcomeSignal: new OutcomeSignalPrismaRepository(),
    // UA-1 fix (2026-08-14): the ~57 findMany calls below used to run one at a
    // time (each `await` inside the old object literal blocked the next),
    // paying its own network round-trip sequentially against remote Postgres
    // (18-93s per call, measured). Firing them all via Promise.all instead
    // lets them run concurrently — same query count, same load, but wall-clock
    // time drops to roughly the slowest single query instead of the sum of
    // all of them. This is the stopgap (option b from the audit); scoping each
    // caller to only the tables it needs is the real fix, still open (UA-1).
    readAll: async (options?: SnapshotOptions) => {
      // Only the named collections are fetched; the rest come back empty. See
      // SnapshotOptions for why that cannot lose data — the writer never
      // deletes on an empty array, it simply writes nothing.
      const load = async <T>(collection: string, run: () => Promise<T[]>): Promise<T[]> =>
        shouldLoadCollection(collection, options) ? run() : [];
      // N-PERF-3 (2026-08-25): a snapshot read inside an open session returns
      // the session's own snapshot, so a read after a write inside one
      // operation sees that write. Guarded on `snapshot`, not on the session
      // itself, so the call that OPENS the session still reads the database.
      const session = activeSnapshotSession();
      if (session?.snapshot) return session.snapshot;
      const [
        workspaces, users, workspaceMembers, businessProfiles, websiteCrawlConsents,
        crawlJobs, crawlPages, businessExtractions, productKnowledges, productVarieties,
        productApplications, buyerSegments, productApplicationMarketMaps, icps, campaigns,
        leads, leadReviewSettings, leadReviewDecisions, messageTemplates, outreachActivities,
        replies, agentRuns, integrations, mediaCatalogItems, providerAccounts,
        auditLogs, campaignLearnings, campaignMetrics, eventLogs, jobRuns,
        knowledgeQuestionAnswers, knowledgeEntries, unknownQuestions, knowledgeBaseDocuments, knowledgeBaseChunks,
        knowledgeExtractionRuns, knowledgeExtractionBatches, knowledgeExtractionSourceBundles, knowledgeExtractionSources, humanFallbackTasks,
        doNotContactRegistry, orders, quotes, tickets, ticketEvents,
        ticketSlaSettings, autoReplyLogs, salesSettings, productSettings, policySettings,
        communicationSettings, settingsConflicts, pendingSettingsDrafts, escalationRules, processedWebhookMessageIds,
        // N-DATA-2 (2026-08-18): six collections that readAll simply did not read.
        agentBehaviorPolicies, companyCommunicationSettings, whatsAppAgentSettings,
        llmModelRoutings, aiUsageLimits, userCredentials,
        followUps, outcomeSignals,
      ] = await Promise.all([
        load("workspaces", () => model("workspace").findMany({})),
        load("users", () => model("user").findMany({})),
        load("workspaceMembers", () => model("workspaceMember").findMany({})),
        load("businessProfiles", () => model("businessProfile").findMany({})),
        load("websiteCrawlConsents", () => model("websiteCrawlConsent").findMany({})),
        load("crawlJobs", () => model("websiteCrawlJob").findMany({})),
        load("crawlPages", () => model("websiteCrawlPage").findMany({})),
        load("businessExtractions", () => model("businessExtraction").findMany({})),
        load("productKnowledges", () => model("productKnowledge").findMany({})),
        load("productVarieties", () => model("productVariety").findMany({})),
        load("productApplications", () => model("productApplication").findMany({})),
        load("buyerSegments", () => model("buyerSegment").findMany({})),
        load("productApplicationMarketMaps", () => model("productApplicationMarketMap").findMany({})),
        load("icps", () => model("iCP").findMany({ where: { status: { not: "archived" } } })),
        load("campaigns", () => model("campaign").findMany({})),
        load("leads", () => model("lead").findMany({})),
        load("leadReviewSettings", () => model("leadReviewSettings").findMany({})),
        load("leadReviewDecisions", () => model("leadReviewDecision").findMany({})),
        load("messageTemplates", () => model("messageTemplate").findMany({})),
        load("outreachActivities", () => model("outreachActivity").findMany({})),
        load("replies", () => model("reply").findMany({})),
        load("agentRuns", () => model("agentRun").findMany({})),
        load("integrations", () => model("integration").findMany({})),
        load("mediaCatalogItems", () => model("mediaCatalogItem").findMany({})),
        load("providerAccounts", () => model("providerAccount").findMany({})),
        load("auditLogs", () => model("auditLog").findMany({})),
        load("campaignLearnings", () => model("campaignLearning").findMany({})),
        load("campaignMetrics", () => model("campaignMetric").findMany({})),
        load("eventLogs", () => model("eventLog").findMany({})),
        load("jobRuns", () => model("jobRun").findMany({})),
        load("knowledgeQuestionAnswers", () => model("knowledgeQuestionAnswer").findMany({})),
        load("knowledgeEntries", () => model("knowledgeEntry").findMany({})),
        load("unknownQuestions", () => model("unknownQuestion").findMany({})),
        load("knowledgeBaseDocuments", () => model("knowledgeBaseDocument").findMany({})),
        load("knowledgeBaseChunks", () => model("knowledgeBaseChunk").findMany({ where: { chunkText: { not: "__deleted__" } } })),
        load("knowledgeExtractionRuns", () => model("knowledgeExtractionRun").findMany({})),
        load("knowledgeExtractionBatches", () => model("knowledgeExtractionBatch").findMany({})),
        load("knowledgeExtractionSourceBundles", () => model("knowledgeExtractionSourceBundle").findMany({})),
        load("knowledgeExtractionSources", () => model("knowledgeExtractionSource").findMany({})),
        load("humanFallbackTasks", () => model("humanFallbackTask").findMany({})),
        load("doNotContactRegistry", () => model("doNotContactEntry").findMany({})),
        load("orders", () => model("order").findMany({})),
        load("quotes", () => model("quote").findMany({})),
        load("tickets", () => model("ticket").findMany({})),
        load("ticketEvents", () => model("ticketEvent").findMany({})),
        load("ticketSlaSettings", () => model("ticketSlaSettings").findMany({})),
        load("autoReplyLogs", () => model("autoReplyLog").findMany({})),
        load("salesSettings", () => model("salesSettings").findMany({})),
        load("productSettings", () => model("productSettings").findMany({})),
        load("policySettings", () => model("policySettings").findMany({})),
        load("communicationSettings", () => model("communicationSettings").findMany({})),
        load("settingsConflicts", () => model("settingsConflict").findMany({})),
        load("pendingSettingsDrafts", () => model("pendingSettingsDraft").findMany({})),
        load("escalationRules", () => model("escalationRule").findMany({})),
        load("processedWebhookMessageIds", () => model("processedWebhookMessage").findMany({})),
        // These six were missing from this list, so readAll reported them as
        // EMPTY however many rows Postgres actually held. The JSON→Postgres
        // migration is what exposed it: it planned a create for a row that was
        // already there and the write came back with
        //     Unique constraint failed on the fields: (`id`)
        // for agentBehaviorPolicies — the plan could not see the row it was
        // about to collide with. userCredentials was already known to be
        // missing (scripts/migrate-json-to-postgres.ts read it directly as a
        // workaround); the other five were not, and that workaround is what
        // kept the blind spot looking like a one-off instead of a pattern.
        //
        // Note the model-name casing: `lLMModelRouting` and `aIUsageLimit` are
        // what Prisma generates for models whose names start with an acronym.
        load("agentBehaviorPolicies", () => model("agentBehaviorPolicy").findMany({})),
        load("companyCommunicationSettings", () => model("companyCommunicationSettings").findMany({})),
        load("whatsAppAgentSettings", () => model("whatsAppAgentSettings").findMany({})),
        load("llmModelRoutings", () => model("lLMModelRouting").findMany({})),
        load("aiUsageLimits", () => model("aIUsageLimit").findMany({})),
        load("userCredentials", () => model("userCredential").findMany({})),
        load("followUps", () => model("followUp").findMany({})),
        load("outcomeSignals", () => model("outcomeSignal").findMany({})),
      ]);
      return {
        workspaces: workspaces.map(mapWorkspace),
        users: datesToIso<NonNullable<AppData["users"]>[number]>(users as unknown as Record<string, unknown>[]),
        workspaceMembers: datesToIso<NonNullable<AppData["workspaceMembers"]>[number]>(workspaceMembers as unknown as Record<string, unknown>[]),
        businessProfiles: businessProfiles.map(mapProfile),
        websiteCrawlConsents: websiteCrawlConsents.map(mapCrawlConsent),
        crawlJobs: crawlJobs.map(mapCrawlJob),
        crawlPages: crawlPages.map(mapCrawlPage),
        businessExtractions: businessExtractions.map(mapExtraction),
        productKnowledges: productKnowledges.map(mapProductKnowledge),
        productVarieties: productVarieties.map(mapProductVariety),
        productApplications: productApplications.map(mapProductApplication),
        buyerSegments: buyerSegments.map(mapBuyerSegment),
        productApplicationMarketMaps: productApplicationMarketMaps.map(mapMarketMap),
        icps: icps.map(mapICP),
        campaigns: campaigns.map(mapCampaign),
        leads: leads.map(mapLead),
        leadReviewSettings: leadReviewSettings.map(mapLeadReviewSettings),
        leadReviewDecisions: leadReviewDecisions.map(mapLeadReviewDecision),
        messageTemplates: messageTemplates.map(mapMessage),
        outreachActivities: outreachActivities.map(mapOutreach),
        replies: replies.map(mapReply),
        agentRuns: agentRuns.map(mapAgentRun),
        integrations: integrations.map((record) => (stripRawJsonColumns({ ...(record as unknown as Integration), config: jsonObject(record.configJson), createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt) }))),
        mediaCatalogItems: mediaCatalogItems.map(mapMediaCatalogItem),
        providerAccounts: providerAccounts.map(mapProviderAccount),
        auditLogs: auditLogs.map(mapAuditLog),
        campaignLearnings: campaignLearnings.map(mapLearning),
        campaignMetrics: campaignMetrics.map(mapMetric),
        eventLogs: eventLogs.map(mapEventLog),
        jobRuns: jobRuns.map(mapJobRun),
        knowledgeQuestionAnswers: knowledgeQuestionAnswers.map(mapKnowledgeQuestionAnswer),
        knowledgeEntries: knowledgeEntries.map(mapKnowledgeEntry),
        unknownQuestions: unknownQuestions.map(mapUnknownQuestion),
        knowledgeBaseDocuments: knowledgeBaseDocuments.map(mapKnowledgeBaseDocument),
        knowledgeBaseChunks: knowledgeBaseChunks.map(mapKnowledgeBaseChunk),
        knowledgeExtractionRuns: datesToIso<NonNullable<AppData["knowledgeExtractionRuns"]>[number]>(knowledgeExtractionRuns as unknown as Record<string, unknown>[]),
        knowledgeExtractionBatches: datesToIso<NonNullable<AppData["knowledgeExtractionBatches"]>[number]>(knowledgeExtractionBatches as unknown as Record<string, unknown>[]),
        knowledgeExtractionSourceBundles: datesToIso<NonNullable<AppData["knowledgeExtractionSourceBundles"]>[number]>(knowledgeExtractionSourceBundles as unknown as Record<string, unknown>[]),
        knowledgeExtractionSources: datesToIso<NonNullable<AppData["knowledgeExtractionSources"]>[number]>(knowledgeExtractionSources as unknown as Record<string, unknown>[]),
        humanFallbackTasks: datesToIso<NonNullable<AppData["humanFallbackTasks"]>[number]>(humanFallbackTasks as unknown as Record<string, unknown>[]),
        // N-BUG (2026-09-08): this was a raw cast, so the snapshot carried the
        // Postgres row rather than the domain object — `createdAt` came out of
        // /api/data/export as `{}` instead of a timestamp, and nullable columns
        // stayed `null` where the type says `undefined`. Every other table on
        // this line goes through its mapper; this one is the COMPLIANCE record,
        // where "when did they opt out?" is the question an audit asks, so it
        // is the worst one to export unreadable. mapDnc already exists and the
        // repository path already used it — only the snapshot skipped it.
        doNotContactRegistry: doNotContactRegistry.map(mapDnc),
        orders: orders.map(mapOrder),
        quotes: quotes.map(mapQuote),
        tickets: tickets.map(mapTicket),
        ticketEvents: ticketEvents.map((record) => ({
          id: String(record.id), workspaceId: String(record.workspaceId), ticketId: String(record.ticketId),
          eventType: String(record.eventType), actorType: record.actorType ? String(record.actorType) : undefined,
          actorUserId: record.actorUserId ? String(record.actorUserId) : undefined,
          note: record.note ? String(record.note) : undefined,
          payload: jsonObject(record.payloadJson),
          createdAt: iso(record.createdAt),
        })) as AppData["ticketEvents"],
        ticketSlaSettings: ticketSlaSettings.map(mapTicketSlaSettings),
        // N-DATA-2: was `autoReplyLogs as AppData["autoReplyLogs"]` — a cast over
        // the raw Prisma rows. AutoReplyLog is the one collection in this block
        // whose column is RENAMED (retrievedContextJson → retrievedContext,
        // src/lib/types.ts:1481), so the snapshot carried the column name the
        // domain type does not declare and lost the field the domain type does.
        // The other raw-cast collections here have JSON columns whose domain
        // names genuinely end in Json (outputJson, resultJson, metadataJson…),
        // so a cast is honest for them; it was not honest for this one.
        autoReplyLogs: autoReplyLogs.map(mapAutoReply),
        salesSettings: datesToIso<NonNullable<AppData["salesSettings"]>[number]>(salesSettings as unknown as Record<string, unknown>[]),
        productSettings: datesToIso<NonNullable<AppData["productSettings"]>[number]>(productSettings as unknown as Record<string, unknown>[]),
        policySettings: datesToIso<NonNullable<AppData["policySettings"]>[number]>(policySettings as unknown as Record<string, unknown>[]),
        communicationSettings: datesToIso<NonNullable<AppData["communicationSettings"]>[number]>(communicationSettings as unknown as Record<string, unknown>[]),
        settingsConflicts: datesToIso<NonNullable<AppData["settingsConflicts"]>[number]>(settingsConflicts as unknown as Record<string, unknown>[]),
        pendingSettingsDrafts: datesToIso<NonNullable<AppData["pendingSettingsDrafts"]>[number]>(pendingSettingsDrafts as unknown as Record<string, unknown>[]),
        escalationRules: datesToIso<NonNullable<AppData["escalationRules"]>[number]>(escalationRules as unknown as Record<string, unknown>[]),
        processedWebhookMessageIds: processedWebhookMessageIds.map((record) => ({
          id: String(record.id),
          workspaceId: String(record.workspaceId),
          providerMessageId: String(record.providerMessageId),
          fromPhone: record.fromPhone ?? undefined,
          processedAt: iso(record.processedAt),
          outcome: String(record.outcome),
        })) as AppData["processedWebhookMessageIds"],
        // Four of these six carry a RENAMED Json column (policyJson → policy,
        // configJson → config, businessHoursJson → businessHours, and the two
        // word-list columns on companyCommunicationSettings), so they go
        // through their mappers rather than a cast — a cast would hand back
        // the column name the domain type does not declare and drop the field
        // it does, which is exactly what autoReplyLogs was doing.
        agentBehaviorPolicies: agentBehaviorPolicies.map(mapPolicy),
        companyCommunicationSettings: companyCommunicationSettings.map(mapComm),
        whatsAppAgentSettings: whatsAppAgentSettings.map(mapWASettings),
        llmModelRoutings: llmModelRoutings.map(mapRouting),
        aiUsageLimits: aiUsageLimits.map(mapUsage),
        // UserCredential has no Json columns and no renames, so the row shape
        // already is the domain shape.
        userCredentials: datesToIso<NonNullable<AppData["userCredentials"]>[number]>(userCredentials as unknown as Record<string, unknown>[]),
        followUps: followUps.map(mapFollowUp),
        outcomeSignals: outcomeSignals.map(mapOutcomeSignal),
      };
    },
    // Phase 4C / M3.x 2026-07-20: Prisma mutateAll. Reads the full snapshot,
    // runs the mutator in-memory, then writes back via persistSnapshot (which
    // is now actually wrapped in $transaction — previously the doc claimed it
    // but it wasn't). The write-back uses upsert-per-record (find by id,
    // create or update). Less efficient than targeted queries but preserves
    // the multi-collection atomicity that JSON mode's mutateData gives.
    //
    // ⚠️ 2026-07-26 Session 4 audit (P3-PERSIST-1 landmine): persistSnapshot
    // ONLY writes these 15 collections — knowledgeQAs, auditLogs, eventLogs,
    // unknownQuestions, knowledgeEntries, humanFallbackTasks,
    // processedWebhookMessageIds, 4 knowledge-extraction types,
    // knowledgeBaseDocs, knowledgeBaseChunks, users,
    // workspaceMembers. (Said "14" and omitted processedWebhookMessageIds
    // until 2026-08-18; the count is now checked against the actual
    // batchUpsert calls in persistSnapshotInner rather than maintained by
    // hand. A miscounted safe-list is how an "it does NOT persist" warning
    // stops being trustworthy.) It does NOT persist: orders, quotes, tickets,
    // ticketEvents, ticketSlaSettings, autoReplyLogs, salesSettings,
    // productSettings, policySettings, communicationSettings, settingsConflicts,
    // pendingSettingsDrafts, escalationRules. DO NOT add a mutateAll block
    // that touches any of those collections — the write will silently vanish.
    // Use the dedicated per-collection repository instead (e.g. repos.order,
    // repos.quote, repos.ticket, repos.ticketSlaSettings).
    mutateAll: async <T>(mutator: (data: AppData) => Promise<T> | T, options?: SnapshotOptions): Promise<T> => {
      // N-PERF-3 / A-13 (2026-08-25). Inside a withSnapshotSession the snapshot
      // is read ONCE and the difference written ONCE, however many mutateAll
      // calls the operation makes. Answering a seven-question setup card made
      // fifteen of them — two per question plus a final one — so it read all
      // 27,271 records fifteen times to save one card. Outside a session this
      // is unchanged: read, mutate, write the difference.
      const session = activeSnapshotSession();
      if (session) {
        if (!session.snapshot) {
          const sessionBundle = createPrismaRepositories();
          // Deliberately NOT narrowed inside a session. A session's snapshot is
          // shared by every mutateAll in the operation, and a later one may read
          // a collection this first one never asked for. It could not DELETE
          // anything — the writer skips empty collections — but it could read an
          // empty list as "no such row exists" and create a duplicate. The
          // narrowing is worth having on the single-call path; it is not worth
          // that risk here.
          const loaded = await sessionBundle.readAll!();
          const openedAt = fingerprintSnapshot(loaded);
          session.snapshot = loaded;
          session.commit = async () => {
            assertNoSilentRemovals(openedAt, loaded);
            await persistSnapshot(changedRecordsOnly(openedAt, loaded));
          };
        }
        return mutator(session.snapshot);
      }
      // Read current snapshot via readAll.
      const bundle = createPrismaRepositories();
      const snapshot = await bundle.readAll!(options);
      // P0-PERF-1 (2026-08-24). This used to hand the WHOLE snapshot to
      // persistSnapshot, which upserts every record of 15 collections across
      // every tenant inside one 45s transaction. Two of the busiest GET routes
      // in the product run through here — /api/unknown-questions and
      // /api/unknown-questions/groups both call syncMissingKnowledgeQuestions
      // — so a plain page view rewrote the entire database. Measured on the
      // live database at 17 workspaces: 9,444 rows re-upserted per page view,
      // growing ~1,046 rows per customer signed up. It had already crossed the
      // budget: the browser got back
      //   "Transaction API error: A commit cannot be executed on an expired
      //    transaction. The timeout for this transaction was 45000 ms,
      //    however 90804 ms passed"
      // and the onboarding screen showed a new customer "0 information areas
      // still need owner input" while 523 waited. Cost was O(whole database)
      // per read, so every customer sold made it worse.
      //
      // The fix is the invariant that was always true and never used: a record
      // that came out of the database and was not touched does not need
      // writing back. Fingerprint before, diff after, persist the difference.
      // A read that changes nothing now writes nothing.
      const before = fingerprintSnapshot(snapshot);
      // Run the mutator on the in-memory snapshot.
      const result = await mutator(snapshot);
      // Persist the changed records back to Prisma inside a transaction.
      // Collections without a Prisma model are skipped (JSON mode only).
      assertNoSilentRemovals(before, snapshot);
      await persistSnapshot(changedRecordsOnly(before, snapshot));
      return result;
    },
    // N-BUG-4 (2026-09-05). Keep the most recent `keep` dedup entries, drop the
    // rest. This cap used to be a `.slice(-10_000)` inside mutateAll, which
    // trims a JSON array and is discarded whole on Postgres, so the real table
    // has never been trimmed once. Two round trips, and only when over the cap.
    // Session 55 (2026-09-09). Empty a workspace's contents on Postgres.
    // See RESET_COLLECTION_DELEGATES for why a shared mutateAll implementation
    // could not work here.
    withTransaction: async <T>(work: () => Promise<T>) => runTx(work),
    withLeadMemoryTransaction: async <T>(workspaceId: string, leadId: string, work: () => Promise<T>) => runTx(async () => {
      const tx = currentPrismaClient() as { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number> };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`leadcockpit:lead-memory:${workspaceId}:${leadId}`}, 0))`;
      return work();
    }),
    withWorkspaceTeamTransaction: async <T>(workspaceId: string, work: () => Promise<T>) => runTx(async () => {
      // Transaction-scoped, database-wide: a second server cannot allocate work
      // while this company is checking a staff departure (or vice versa).
      const tx = currentPrismaClient() as { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number> };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`leadcockpit:team-ticket:${workspaceId}`}, 0))`;
      return work();
    }),
    clearWorkspaceCollections: async (workspaceId: string, collections: readonly string[]): Promise<Record<string, number>> => {
      const removed: Record<string, number> = {};
      await runTx(async () => {
        for (const collection of collections) {
          const delegate = RESET_COLLECTION_DELEGATES[collection];
          if (!delegate) {
            // Loud, not skipped. A collection with no mapping would otherwise
            // survive a reset with nobody told, which is the whole defect this
            // method exists to fix.
            throw new Error(
              `clearWorkspaceCollections has no Postgres table mapped for "${collection}". ` +
                "Add it to RESET_COLLECTION_DELEGATES, or the reset would silently leave those rows behind.",
            );
          }
          const result = await model(delegate).deleteMany({ where: { workspaceId } });
          if (result.count > 0) removed[collection] = result.count;
        }
      });
      return removed;
    },
    trimProcessedWebhookMessages: async (keep: number): Promise<number> => {
      const doomed = await model("processedWebhookMessage").findMany({
        select: { id: true },
        // createdAt breaks ties on processedAt, which several messages arriving
        // in the same millisecond genuinely share.
        orderBy: [{ processedAt: "desc" }, { createdAt: "desc" }],
        skip: keep,
      }) as unknown as { id: string }[];
      if (!doomed.length) return 0;
      return (await model("processedWebhookMessage").deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } })).count;
    },
    hasProcessedWebhookMessage: async (workspaceId: string, providerMessageId: string): Promise<boolean> =>
      Boolean(await model("processedWebhookMessage").findFirst({ where: { workspaceId, providerMessageId }, select: { id: true } })),
    // 2026-09-28 (S5) — erasure: forget the sender phone (last-10-digit match,
    // the opt-out rule), keep the message id so a redelivery is still a duplicate.
    scrubProcessedWebhookPhones: async (workspaceId: string, phones: string[]): Promise<number> => {
      const OR = phones.map((phone) => optOutPhoneFilter(phone)).filter(Boolean).map((filter) => ({ fromPhone: (filter as { normalizedPhone: unknown }).normalizedPhone }));
      if (!OR.length) return 0;
      return Number((await model("processedWebhookMessage").updateMany!({ where: { workspaceId, OR }, data: { fromPhone: null } }) as { count?: number }).count || 0);
    },
    recordProcessedWebhookMessage: async (record: ProcessedWebhookMessageInput) => {
      let inserted = true;
      try {
        await model("processedWebhookMessage").create({
          data: {
            workspaceId: record.workspaceId,
            providerMessageId: record.providerMessageId,
            fromPhone: record.fromPhone ?? null,
            processedAt: new Date(record.processedAt),
            outcome: record.outcome,
          },
        });
      } catch (error) {
        // P2002: the (workspace, message) unique index — already recorded.
        if ((error as { code?: string })?.code !== "P2002") throw error;
        inserted = false;
      }
      return { inserted, total: await (model("processedWebhookMessage") as unknown as { count: () => Promise<number> }).count() };
    },
    // Stage A.2 (2026-07-26) — auth + workspaceMember repositories. Same
    // pattern as everything else in the bundle. Pinned by smoke-auth.
    auth: new PrismaAuthRepository(),
    workspaceMember: new PrismaWorkspaceMemberRepository(),
  };
}

/**
 * Stage A.2 (2026-07-26) — Prisma AuthRepository.
 *
 * Reads/writes the `users` + `user_credentials` + `workspace_members` tables.
 * The previous auth-service.ts called readData/mutateData directly (JSON-
 * only), which split-brained in Prisma mode — login would hit the JSON file
 * even when PERSISTENCE_PROVIDER=prisma. This routes through the same Prisma
 * client every other repo uses.
 *
 * createOwnerWithCredential wraps all three writes in one `prisma.$transaction`
 * so the bootstrap is atomic (same guarantee as the JSON mutateData path).
 */
export class PrismaAuthRepository implements AuthRepository {
  async findUserById(workspaceId: string, userId: string): Promise<User | undefined> {
    const record = await model("user").findFirst({ where: { workspaceId, id: userId } });
    return record ? this.mapUser(record) : undefined;
  }
  async listUsers(): Promise<User[]> {
    const rows = await model("user").findMany({});
    return rows.map((r: Record<string, unknown>) => this.mapUser(r));
  }
  async findCredentialByEmail(workspaceId: string, email: string): Promise<{ user: User; credential: UserCredential } | null> {
    const lower = email.trim().toLowerCase();
    // 2026-07-26 Session 4 audit fix (P3-AUTH-1): now uses the unique index
    // on (workspaceId, email) via findFirst instead of scanning all rows for
    // the workspace. Safe because `bootstrapOwner` lowercases emails at write
    // time (src/lib/auth-service.ts:190), so a SQL equality on the lowercased
    // email matches the stored row. Pre-fix this loaded ALL workspace
    // credentials into memory and filtered in JS — wasteful at scale.
    // Defense-in-depth: if a future credential is somehow written with a
    // mixed-case email, the lookup misses (returns null) and the operator sees
    // "invalid credentials" — fail-closed is the right behaviour.
    const credential = await model("userCredential").findFirst({ where: { workspaceId, email: lower } });
    if (!credential) return null;
    const userRecord = await model("user").findFirst({ where: { workspaceId, id: String(credential.userId) } });
    if (!userRecord) return null;
    return { user: this.mapUser(userRecord), credential: this.mapCredential(credential) };
  }
  async findCredentialsByEmail(email: string): Promise<Array<{ user: User; credential: UserCredential }>> {
    const lower = email.trim().toLowerCase();
    // 2026-09-28 (S8): one query on the indexed email column (migration
    // 20260928090000), then one for the matching users — not one per company.
    const credentials = await model("userCredential").findMany({ where: { email: lower } });
    if (!credentials.length) return [];
    const users = await model("user").findMany({ where: { id: { in: credentials.map((c: Record<string, unknown>) => String(c.userId)) } } });
    const out: Array<{ user: User; credential: UserCredential }> = [];
    for (const c of credentials as Record<string, unknown>[]) {
      const u = (users as Record<string, unknown>[]).find((row) => String(row.id) === String(c.userId) && String(row.workspaceId) === String(c.workspaceId));
      if (u) out.push({ user: this.mapUser(u), credential: this.mapCredential(c) });
    }
    return out;
  }
  async hasAnyCredentials(): Promise<boolean> {
    // findFirst is on the Delegate type; count is not. One row is enough to
    // answer "does any credential exist" — no need to count them all.
    const any = await model("userCredential").findFirst({});
    return Boolean(any);
  }
  async createOwnerWithCredential(input: { workspaceId: string; user: User; credential: UserCredential; member: WorkspaceMember }): Promise<User> {
    return await runTx(async (tx: unknown) => {
      const delegate = (tx as Record<string, Delegate>);
      // 2026-07-26 Session 4 audit fix (P0-1): UPSERT the parent Workspace row
      // before inserting user/credential/member. Pre-fix, a fresh Postgres DB
      // (the Stage A cutover target) would fail with `users_workspace_id_fkey`
      // because no `workspaces` row existed for the workspaceId. The JSON
      // runtime doesn't have this problem (the workspace is always pre-seeded
      // by the demo file); Prisma does (clean DB). Upsert inside the same
      // $transaction keeps the atomicity guarantee — all 4 rows commit together
      // or none do. If the workspace already exists (e.g. a re-bootstrap on a
      // workspace that already has members), the upsert's `update: {}` is a no-op.
      await delegate["workspace"].upsert({
        where: { id: input.workspaceId },
        create: {
          id: input.workspaceId,
          name: "Default Workspace",
          status: "active",
          updatedAt: new Date(),
        },
        update: {},
      });
      await delegate["user"].create({ data: {
        id: input.user.id, workspaceId: input.user.workspaceId,
        name: input.user.name, email: input.user.email, role: input.user.role ?? "owner",
      } });
      await delegate["userCredential"].create({ data: {
        id: input.credential.id, userId: input.credential.userId,
        workspaceId: input.credential.workspaceId,
        email: input.credential.email, passwordHash: input.credential.passwordHash,
        provisional: input.credential.provisional ?? null,
        // Stage 5 / WP1 (2026-07-28) — store the initial sessionVersion so the
        // sessionVersion enforcement has a value to compare against from day 1.
        sessionVersion: input.credential.sessionVersion ?? 1,
      } });
      await delegate["workspaceMember"].create({ data: {
        id: input.member.id, workspaceId: input.member.workspaceId, userId: input.member.userId,
        email: input.member.email, name: input.member.name ?? null,
        role: input.member.role ?? "owner", status: input.member.status ?? "active",
      } });
      return input.user;
    });
  }
  /**
   * Stage 5 re-audit fix (F-P0-1, F-P1-11, 2026-07-28). Atomically create a
   * brand-new workspace + owner bundle in ONE prisma.$transaction. The
   * `create` overload creates the Workspace with the CALLER's fields (name,
   * businessName, status, autonomyKillSwitch, autoSendToggle) rather than the
   * bare upsert placeholder `createOwnerWithCredential` uses.
   */
  async createWorkspaceWithOwner(input: {
    workspace: Workspace;
    user: User;
    credential: UserCredential;
    member: WorkspaceMember;
  }): Promise<{ workspace: Workspace; user: User }> {
    return await runTx(async (tx: unknown) => {
      const delegate = (tx as Record<string, Delegate>);
      // Serialise same-email owner creation across server processes without a
      // global email uniqueness constraint (invited memberships may share email).
      const lowerEmail = input.credential.email.trim().toLowerCase();
      const sql = tx as { $executeRawUnsafe(query: string, value: string): Promise<unknown> };
      await sql.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", `owner-signup:${lowerEmail}`);
      const collision = await delegate.userCredential.findFirst({ where: { email: { equals: lowerEmail, mode: "insensitive" } } });
      if (collision) throw new Error("An account with this email already exists.");
      // Create the workspace with the caller's fields.
      await delegate["workspace"].create({ data: {
        id: input.workspace.id,
        name: input.workspace.name,
        ownerUserId: input.workspace.ownerUserId,
        businessName: input.workspace.businessName ?? null,
        industry: input.workspace.industry ?? null,
        targetAudience: input.workspace.targetAudience ?? null,
        status: input.workspace.status ?? "active",
        autonomyKillSwitch: input.workspace.autonomyKillSwitch ?? null,
        autoSendToggle: input.workspace.autoSendToggle ?? null,
        ownerWhatsappNumber: input.workspace.ownerWhatsappNumber ?? null,
      } });
      await delegate["user"].create({ data: {
        id: input.user.id, workspaceId: input.user.workspaceId,
        name: input.user.name, email: input.user.email, role: input.user.role ?? "owner",
      } });
      await delegate["userCredential"].create({ data: {
        id: input.credential.id, userId: input.credential.userId,
        workspaceId: input.credential.workspaceId,
        email: input.credential.email, passwordHash: input.credential.passwordHash,
        provisional: input.credential.provisional ?? null,
        sessionVersion: input.credential.sessionVersion ?? 1,
      } });
      await delegate["workspaceMember"].create({ data: {
        id: input.member.id, workspaceId: input.member.workspaceId, userId: input.member.userId,
        email: input.member.email, name: input.member.name ?? null,
        role: input.member.role ?? "owner", status: input.member.status ?? "active",
      } });
      return { workspace: input.workspace, user: input.user };
    });
  }
  private mapUser(record: Record<string, unknown>): User {
    return {
      id: String(record.id),
      workspaceId: String(record.workspaceId),
      name: String(record.name || ""),
      email: String(record.email || ""),
      role: record.role as User["role"],
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }
  private mapCredential(record: Record<string, unknown>): UserCredential {
    return {
      id: String(record.id),
      userId: String(record.userId),
      workspaceId: String(record.workspaceId),
      email: String(record.email || ""),
      passwordHash: String(record.passwordHash || ""),
      provisional: record.provisional as boolean | undefined,
      // Stage 5 re-audit F-P1-9: PRESERVE sessionVersion. This field is baked
      // into the HMAC-signed session cookie and compared on every authenticated
      // request by resolveUserFromSessionWithVersionCheck. Dropping it here made
      // every credential read from Postgres report sessionVersion=undefined,
      // which broke session-revocation in Prisma-production mode (JSON-demo
      // worked fine — a silent split-brain bug). Pinned by
      // golden:credential-session-version-mapper.
      sessionVersion: typeof record.sessionVersion === "number" ? record.sessionVersion : undefined,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }
}

/**
 * Stage A.2 (2026-07-26) — Prisma WorkspaceMemberRepository.
 * CRUD surface mirroring the JSON impl.
 */
export class PrismaWorkspaceMemberRepository implements WorkspaceMemberRepository {
  async listByWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await model("workspaceMember").findMany({ where: { workspaceId } });
    return rows.map((r: Record<string, unknown>) => this.mapMember(r));
  }
  async listActiveByWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await model("workspaceMember").findMany({ where: { workspaceId, status: "active" } });
    return rows.map((r: Record<string, unknown>) => this.mapMember(r));
  }
  async create(input: WorkspaceMember): Promise<WorkspaceMember> {
    const record = await model("workspaceMember").create({ data: {
      id: input.id, workspaceId: input.workspaceId, userId: input.userId,
      email: input.email, name: input.name ?? null,
      role: input.role ?? "sales_member", status: input.status ?? "active",
    
      createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
    } });
    return this.mapMember(record);
  }
  async deleteInvitedByEmail(workspaceId: string, email: string): Promise<void> {
    // Only remove rows that are "invited" (never touch active members).
    const delegate = model("workspaceMember");
    if (delegate.deleteMany) {
      await delegate.deleteMany({ where: { workspaceId, email, status: "invited" } });
    }
  }
  async activateInvitedByEmail(workspaceId: string, email: string, userId: string, name?: string): Promise<void> {
    // Update the "invited" row to "active" with the real userId + name.
    const delegate = model("workspaceMember");
    if (delegate.updateMany) {
      await delegate.updateMany({
        where: { workspaceId, email, status: "invited" },
        data: { userId, name: name ?? null, status: "active" },
      });
    } else {
      // Fallback: find + update.
      const rows = await delegate.findMany({ where: { workspaceId, email, status: "invited" } });
      for (const row of rows) {
        await delegate.update({
          where: { id: String((row as Record<string, unknown>).id) },
          data: { userId, name: name ?? null, status: "active" },
        });
      }
    }
  }
  async findForUser(workspaceId: string, userId: string): Promise<WorkspaceMember | undefined> {
    const record = await model("workspaceMember").findFirst({ where: { workspaceId, userId } });
    return record ? this.mapMember(record) : undefined;
  }
  async update(workspaceId: string, memberId: string, patch: Partial<Pick<WorkspaceMember, "role" | "status" | "name" | "userId">>): Promise<WorkspaceMember> {
    const existing = await model("workspaceMember").findFirst({ where: { workspaceId, id: memberId } });
    if (!existing) throw new Error(`Member ${memberId} not found`);
    const record = await model("workspaceMember").update({ where: { id: memberId }, data: { ...patch } });
    return this.mapMember(record);
  }
  private mapMember(record: Record<string, unknown>): WorkspaceMember {
    return {
      id: String(record.id),
      workspaceId: String(record.workspaceId),
      userId: String(record.userId),
      email: String(record.email || ""),
      name: record.name as string | undefined,
      role: record.role as WorkspaceMember["role"],
      status: (record.status as WorkspaceMember["status"]) || "active",
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    };
  }
}

/**
 * Persist a full AppData snapshot back to Prisma. Called by mutateAll after
 * the mutator has run. Each collection is written via upsert-per-record.
 *
 * M3.x / 2026-07-20 parity fix: previously this:
 *   (a) was documented as "$transaction-wrapped" but was NOT actually wrapped
 *       — a mid-loop crash left partial state;
 *   (b) only persisted 8 collection types — anything else the mutator touched
 *       (like doNotContactRegistry) was silently lost.
 *
 * Now the whole function runs inside `prisma.$transaction(...)` so a failure
 * in any collection rolls back all. The set of collections persisted matches
 * the set the mutateAll callers (AISettingsService, DocumentExtraction,
 * DocumentQuestionAnswering) actually touch.
 *
 * Collections that have no Prisma model (none today) are silently skipped.
 */
/**
 * Exported (2026-08-18, N-DATA-2) so a golden can drive the snapshot write path
 * with a MINIMAL AppData instead of going through mutateAll, which reads and
 * rewrites the entire database. The two createdAt fixes in withSuppliedCreatedAt
 * live on this path and were otherwise unpinnable at any reasonable cost.
 */
/**
 * P0-PERF-1 support (2026-08-24) — the two halves of "write back only what the
 * mutator actually changed".
 *
 * WHY A FINGERPRINT AND NOT A DIRTY FLAG. The mutators are plain functions that
 * mutate a plain in-memory object; nothing tells us which records they touched,
 * and asking every caller to declare it is the kind of bookkeeping that is
 * correct on the day it is written and wrong six months later. Stringifying the
 * record before and after is dumb, cheap (~9,400 records in tens of
 * milliseconds, against a transaction that was taking 90 SECONDS) and cannot
 * drift out of step with the mutators.
 *
 * WHY SKIPPING UNCHANGED RECORDS IS SAFE. Every record here was just read out of
 * the database by readAll. If the mutator did not touch it, the row already
 * holds exactly these values, so re-upserting it is a no-op that costs a round
 * trip. Deletions are unaffected: persistSnapshot has always been upsert-only
 * and has never deleted anything, so a record dropped from the snapshot was not
 * removed from the database before this change either.
 *
 * Arrays whose elements are not id-keyed objects (e.g. the webhook dedup id
 * list) are compared whole and passed through unchanged-or-entire, because
 * there is no key to diff them by.
 */
export function fingerprintSnapshot(data: AppData): Map<string, string> {
  const marks = new Map<string, string>();
  for (const [key, value] of Object.entries(data as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    if (isIdKeyed(value)) {
      for (const item of value) marks.set(`${key}:${(item as { id: string }).id}`, JSON.stringify(item));
    } else {
      marks.set(`${key}::whole`, JSON.stringify(value));
    }
  }
  return marks;
}

function isIdKeyed(value: unknown[]): boolean {
  return value.every((item) => item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string");
}

export function changedRecordsOnly(before: Map<string, string>, after: AppData): AppData {
  const out: Record<string, unknown> = { ...(after as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (!Array.isArray(value)) continue;
    if (isIdKeyed(value)) {
      out[key] = value.filter((item) => before.get(`${key}:${(item as { id: string }).id}`) !== JSON.stringify(item));
    } else {
      out[key] = before.get(`${key}::whole`) === JSON.stringify(value) ? [] : value;
    }
  }
  return out as unknown as AppData;
}

/**
 * N-BUG-5 (2026-09-05) — the silent-removal guard.
 *
 * `mutateAll` hands the caller the whole database as a plain object. On the
 * JSON substrate that object IS the database, so dropping a row from one of its
 * arrays deletes the row. Here it is a copy, and `persistSnapshot` is upsert-
 * only: it has never issued a DELETE. The same line of code therefore deletes
 * on one substrate and does nothing at all on the other, with no error either
 * way. Three callers were relying on it — knowledge sync left a second copy of
 * the whole search index behind on every run, the webhook dedup cap never once
 * trimmed, and product research appended a full set per press of the button.
 *
 * WHY THIS REFUSES INSTEAD OF DELETING. The obvious repair is to make the
 * writer delete what vanished. It is the wrong one. This snapshot is a read of
 * the ENTIRE database taken before the mutator ran, and other requests write to
 * those tables while it is held; a row inserted by a concurrent request is
 * simply absent from this copy, and a delete-what-is-absent writer would erase
 * it. Upsert-only is forgiving of that race — last write wins per row and
 * nothing is lost. So the guard turns the silent wrong answer into a loud one
 * and points at the repository method, which deletes with a WHERE clause that
 * says what it means.
 */
/**
 * Session 55 (2026-09-09) — which Postgres table holds each workspace
 * collection, for the reset.
 *
 * WHY THIS EXISTS AT ALL. "Empty this workspace" first shipped as
 * `repos.mutateAll((data) => clearWorkspaceData(data, workspaceId))`. Read
 * assertNoSilentRemovals below for why that cannot delete here: the snapshot
 * writer is upsert-only. Driven live on Postgres the route answered 400 with
 * "2339 row(s) were dropped from the snapshot" and removed nothing. Every test
 * passed, because they all exercised the JSON-shaped helper on a plain object.
 *
 * The keys are the collections of `scopeDataForExport` in the API route, which
 * is the authoritative list of what belongs to a workspace, minus the three
 * RESET_PRESERVED_COLLECTIONS. Anything that collection list gains must be
 * added here too — golden-a-backup-can-be-loaded-back-in asserts the two agree,
 * so forgetting is a red test rather than rows that quietly survive a reset.
 *
 * Child rows are not listed and do not need to be: every foreign key into
 * these tables is ON DELETE CASCADE or ON DELETE SET NULL, so deleting a lead
 * takes its interactions, replies, orders, quotes, phone numbers, enrichment
 * runs and duplicate candidates with it. Nothing here is RESTRICT, so order
 * does not matter either.
 */
export const RESET_COLLECTION_DELEGATES: Record<string, string> = {
  followUps: "followUp",
  outcomeSignals: "outcomeSignal",
  businessProfiles: "businessProfile",
  leads: "lead",
  interactions: "interaction",
  replies: "reply",
  campaigns: "campaign",
  icps: "iCP",
  messageTemplates: "messageTemplate",
  outreachActivities: "outreachActivity",
  autoReplyLogs: "autoReplyLog",
  unknownQuestions: "unknownQuestion",
  tickets: "ticket",
  ticketEvents: "ticketEvent",
  ticketSlaSettings: "ticketSlaSettings",
  orders: "order",
  quotes: "quote",
  mediaCatalogItems: "mediaCatalogItem",
  knowledgeBaseDocuments: "knowledgeBaseDocument",
  knowledgeBaseChunks: "knowledgeBaseChunk",
  knowledgeQuestionAnswers: "knowledgeQuestionAnswer",
  knowledgeEntries: "knowledgeEntry",
  knowledgeExtractionRuns: "knowledgeExtractionRun",
  knowledgeExtractionBatches: "knowledgeExtractionBatch",
  knowledgeExtractionSources: "knowledgeExtractionSource",
  knowledgeExtractionSourceBundles: "knowledgeExtractionSourceBundle",
  productKnowledges: "productKnowledge",
  productVarieties: "productVariety",
  productApplications: "productApplication",
  productApplicationMarketMaps: "productApplicationMarketMap",
  buyerSegments: "buyerSegment",
  humanFallbackTasks: "humanFallbackTask",
  escalationRules: "escalationRule",
  leadReviewSettings: "leadReviewSettings",
  leadReviewDecisions: "leadReviewDecision",
  integrations: "integration",
  agentRuns: "agentRun",
  agentAutonomousSettings: "agentAutonomousSettings",
  agentBehaviorPolicies: "agentBehaviorPolicy",
  whatsAppAgentSettings: "whatsAppAgentSettings",
  companyCommunicationSettings: "companyCommunicationSettings",
  conversationPolicies: "conversationPolicy",
  aiUsageLimits: "aIUsageLimit",
  llmModelRoutings: "lLMModelRouting",
  auditLogs: "auditLog",
  salesSettings: "salesSettings",
  productSettings: "productSettings",
  policySettings: "policySettings",
  communicationSettings: "communicationSettings",
  settingsConflicts: "settingsConflict",
  pendingSettingsDrafts: "pendingSettingsDraft",
  campaignMetrics: "campaignMetric",
  campaignLearnings: "campaignLearning",
  websiteCrawlConsents: "websiteCrawlConsent",
  crawlJobs: "websiteCrawlJob",
  crawlPages: "websiteCrawlPage",
  businessExtractions: "businessExtraction",
};

export function assertNoSilentRemovals(before: Map<string, string>, after: AppData): void {
  const present = new Set<string>();
  for (const [key, value] of Object.entries(after as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value) || !isIdKeyed(value)) continue;
    for (const item of value) present.add(`${key}:${(item as { id: string }).id}`);
  }
  const removed: string[] = [];
  for (const key of before.keys()) {
    if (key.endsWith("::whole")) continue;
    if (!present.has(key)) removed.push(key);
  }
  if (!removed.length) return;
  const shown = removed.slice(0, 5).join(", ");
  const more = removed.length > 5 ? ` (and ${removed.length - 5} more)` : "";
  throw new Error(
    `mutateAll cannot delete rows on the Postgres substrate, and ${removed.length} row(s) were dropped from the snapshot: ${shown}${more}. ` +
      "This write path is upsert-only, so the removal would have been silently discarded and the rows would still be in the database. " +
      "Delete through the repository that owns the collection instead (for example repos.productKnowledge.deleteByWorkspace, " +
      "repos.knowledgeBaseChunk.replaceForDocument, or repos.trimProcessedWebhookMessages).",
  );
}

export async function persistSnapshot(data: AppData): Promise<void> {
  await runTx(async () => {
    await persistSnapshotInner(data);
  });
}

async function persistSnapshotInner(data: AppData): Promise<void> {
  // L-1 (2026-08-04): every collection below used to be a sequential
  // `for (const item) { await upsert(item) }` loop — N round-trips per
  // collection, which exceeded Neon's transaction timeout. Now each uses
  // batchUpsert (parallel-chunked, same transaction). Empty arrays short-
  // circuit (no round-trip). Math: 700 rows at chunkSize 50 → ~14 parallel
  // batches instead of 700 sequential awaits.
  await batchUpsert("knowledgeQuestionAnswer", data.knowledgeQuestionAnswers, (item) => ({
    where: { id: item.id },
    create: knowledgeQuestionAnswerCreate(item),
    update: knowledgeQuestionAnswerUpdate(item),
  }));
  // Audit logs — append-only, upsert by id.
  await batchUpsert("auditLog", data.auditLogs, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, actorUserId: item.actorUserId ?? null, eventType: item.eventType, entityType: item.entityType ?? null, entityId: item.entityId ?? null, payloadJson: item.payload ?? {} },
    update: { eventType: item.eventType, entityType: item.entityType ?? null, entityId: item.entityId ?? null, payloadJson: item.payload ?? {} },
  }));
  // Event logs — append-only, upsert by id.
  await batchUpsert("eventLog", data.eventLogs, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, eventType: item.eventType, entityType: item.entityType ?? null, entityId: item.entityId ?? null, payloadJson: item.payload ?? {}, metadataJson: item.metadata ?? {}, status: item.status },
    update: { eventType: item.eventType, status: item.status, payloadJson: item.payload ?? {}, metadataJson: item.metadata ?? {} },
  }));
  // Unknown questions.
  // N-DATA-2 (2026-08-18): the 8 fields below used to be absent from BOTH halves
  // of this upsert. The M3.x / 2026-07-20 parity fix added them to the schema and
  // to mapUnknownQuestion (the read side) but never to persistSnapshot, so the
  // "7 fields previously dropped silently" were still dropped silently — just on
  // a different write path. 486 rows lost them in the N-DATA-2 migration.
  await batchUpsert("unknownQuestion", data.unknownQuestions, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, leadId: item.leadId ?? null, conversationId: item.conversationId ?? null, channel: item.channel, questionText: item.questionText, missingTopic: item.missingTopic ?? null, status: item.status, suggestedAnswer: item.suggestedAnswer ?? null, finalAnswer: item.finalAnswer ?? null, ...unknownQuestionParityFields(item) },
    update: { questionText: item.questionText, status: item.status, suggestedAnswer: item.suggestedAnswer ?? null, finalAnswer: item.finalAnswer ?? null, ...unknownQuestionParityFields(item) },
  }));
  // Knowledge entries.
  await batchUpsert("knowledgeEntry", data.knowledgeEntries, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, questionId: item.questionId, questionText: item.questionText, answer: item.answer, domain: item.domain, confidence: item.confidence ?? 1 },
    update: { questionText: item.questionText, answer: item.answer, domain: item.domain, confidence: item.confidence ?? 1 },
  }));
  // Human fallback tasks.
  await batchUpsert("humanFallbackTask", data.humanFallbackTasks, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, interactionId: item.interactionId, prospectQuery: item.prospectQuery, status: item.status, resolvedAt: item.resolvedAt ?? null },
    update: { prospectQuery: item.prospectQuery, status: item.status, resolvedAt: item.resolvedAt ?? null },
  }));
  // Stage 6 / I-6 (2026-07-30): processed webhook message dedup log. Upsert by
  // id; the (workspaceId, providerMessageId) unique index is the real guard
  // against duplicate rows even under a concurrent double-insert.
  await batchUpsert("processedWebhookMessage", data.processedWebhookMessageIds, (item) => ({
    where: { id: item.id },
    create: {
      id: item.id,
      workspaceId: item.workspaceId,
      providerMessageId: item.providerMessageId,
      fromPhone: item.fromPhone ?? null,
      processedAt: item.processedAt,
      outcome: item.outcome,
    },
    update: { outcome: item.outcome, fromPhone: item.fromPhone ?? null },
  }));
  // Knowledge extraction runs (model added in Step 4).
  await batchUpsert("knowledgeExtractionRun", data.knowledgeExtractionRuns, (item) => ({
    where: { id: item.id },
    create: knowledgeExtractionRunCreate(item),
    update: knowledgeExtractionRunUpdate(item),
  }));
  // Knowledge extraction batches (model added in Step 4).
  await batchUpsert("knowledgeExtractionBatch", data.knowledgeExtractionBatches, (item) => ({
    where: { id: item.id },
    create: knowledgeExtractionBatchCreate(item),
    update: knowledgeExtractionBatchUpdate(item),
  }));
  // Knowledge extraction source bundles (model added in Step 4).
  await batchUpsert("knowledgeExtractionSourceBundle", data.knowledgeExtractionSourceBundles, (item) => ({
    where: { id: item.id },
    create: knowledgeExtractionSourceBundleCreate(item),
    update: knowledgeExtractionSourceBundleUpdate(item),
  }));
  // Knowledge extraction sources (model added in Step 4).
  await batchUpsert("knowledgeExtractionSource", data.knowledgeExtractionSources, (item) => ({
    where: { id: item.id },
    create: knowledgeExtractionSourceCreate(item),
    update: knowledgeExtractionSourceUpdate(item),
  }));
  // Knowledge base documents.
  await batchUpsert("knowledgeBaseDocument", data.knowledgeBaseDocuments, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, title: item.title, documentType: item.documentType, source: item.source ?? null, contentText: item.contentText ?? "", metadataJson: item.metadata ?? {}, status: item.status ?? "active" },
    update: { title: item.title, documentType: item.documentType, status: item.status ?? "active" },
  }));
  // Knowledge base chunks.
  await batchUpsert("knowledgeBaseChunk", data.knowledgeBaseChunks, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, documentId: item.documentId, chunkIndex: item.chunkIndex ?? 0, chunkText: item.chunkText ?? "", metadataJson: item.metadata ?? {} },
    update: { chunkText: item.chunkText ?? "", chunkIndex: item.chunkIndex ?? 0 },
  }));
  // Stage A.1 (2026-07-26) — Users + WorkspaceMembers. Both always existed in
  // the JSON runtime; the Prisma persistSnapshot silently dropped them. This
  // matters because auth bootstrapOwner (after A.2 refactor) and any auth-
  // related mutateAll caller would otherwise write nothing in Prisma mode.
  await batchUpsert("user", data.users, (item) => ({
    where: { id: item.id },
    create: { id: item.id, workspaceId: item.workspaceId, name: item.name, email: item.email, role: item.role ?? "owner" },
    update: { name: item.name, email: item.email, role: item.role ?? "owner" },
  }));
  await batchUpsert("workspaceMember", data.workspaceMembers, (item) => ({
    where: { id: item.id },
    create: {
      id: item.id, workspaceId: item.workspaceId, userId: item.userId,
      email: item.email, name: item.name ?? null, role: item.role ?? "sales_member",
      status: item.status ?? "active",
    },
    update: {
      email: item.email, name: item.name ?? null, role: item.role ?? "sales_member",
      status: item.status ?? "active",
    },
  }));
}

/** Map a KnowledgeQuestionAnswer to Prisma create args. */
function knowledgeQuestionAnswerCreate(item: KnowledgeQuestionAnswer) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    domainKey: item.domainKey,
    questionKey: item.questionKey,
    question: item.question,
    answer: item.answer ?? null,
    answerStatus: item.answerStatus,
    sourceType: item.sourceType,
    sourceId: item.sourceId ?? null,
    sourceTitle: item.sourceTitle ?? null,
    sourceUrl: item.sourceUrl ?? null,
    sourceFileName: item.sourceFileName ?? null,
    confidenceScore: item.confidenceScore ?? 0,
    usedByAgentsJson: item.usedByAgentsJson ?? {},
    mapsToJson: item.mapsToJson ?? {},
    humanReviewRequired: item.humanReviewRequired ?? false,
    sourceSnippet: item.sourceSnippet ?? null,
    conflictWithExisting: item.conflictWithExisting ?? null,
    conflictReason: item.conflictReason ?? null,
    reviewedByUser: item.reviewedByUser ?? null,
    reviewedAt: item.reviewedAt ?? null,
    isUserApproved: item.isUserApproved ?? null,
    isCanonical: item.isCanonical ?? null,
    supersededByAnswerId: item.supersededByAnswerId ?? null,
    mergedFromAnswerIds: item.mergedFromAnswerIds ?? null,
    // N-DATA-2, and DELIBERATELY still `{}` rather than null. Every other field
    // in this builder falls back to null, and I changed this one to match on the
    // grounds that an answer with no evidence read back as `undefined` on JSON
    // and `{}` on Postgres — 392 of the 523 migrated answers differ on this
    // field alone. That change was WRONG and is reverted: `evidence_json` is
    // NOT NULL in the database (prisma/schema.prisma declares `Json`, not
    // `Json?`), so the null fallback would have thrown on every answer created
    // without evidence. It survived the migration only because all 523 answers
    // already existed and took the update path.
    //
    // The substrate difference is real but is NOT a bug and cannot be fixed
    // here: it is a Postgres column that must hold a value against a JSON
    // substrate that has no opinion. That is exactly the category
    // `unmigratableFields` was added for — the plan now reports it by name and
    // does not block on it.
    // N-BUG-1 (2026-09-04) — this stored a bare `{}`, which is the shape that
    // crashed extraction on read. New rows now carry the empty array they mean.
    evidenceJson: item.evidenceJson ?? { sources: [] },
  };
}
function knowledgeQuestionAnswerUpdate(item: KnowledgeQuestionAnswer) {
  const created = knowledgeQuestionAnswerCreate(item);
  // `id` and `workspaceId` are immutable on update; everything else is writable.
  // Prisma upsert update uses the same shape minus the where keys.
  const { id, workspaceId, ...update } = created;
  void id; void workspaceId;
  return update;
}

/** Map a KnowledgeExtractionRun to Prisma create/update args. */
function knowledgeExtractionRunCreate(item: KnowledgeExtractionRun) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    sourceType: item.sourceType,
    sourceId: item.sourceId ?? null,
    status: item.status,
    totalQuestions: item.totalQuestions,
    processedQuestions: item.processedQuestions ?? null,
    answeredCount: item.answeredCount,
    unansweredCount: item.unansweredCount,
    partialCount: item.partialCount,
    conflictCount: item.conflictCount,
    failedBatchCount: item.failedBatchCount ?? null,
    totalBatches: item.totalBatches ?? null,
    completedBatches: item.completedBatches ?? null,
    currentDomain: item.currentDomain ?? null,
    currentBatchIndex: item.currentBatchIndex ?? null,
    modelProvider: item.modelProvider ?? null,
    modelName: item.modelName ?? null,
    fallbackUsed: item.fallbackUsed ?? null,
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? null,
    errorMessage: item.errorMessage ?? null,
    outputJson: item.outputJson ?? {},
  };
}
function knowledgeExtractionRunUpdate(item: KnowledgeExtractionRun) {
  const { id, workspaceId, ...update } = knowledgeExtractionRunCreate(item);
  void id; void workspaceId;
  return update;
}

/** Map a KnowledgeExtractionBatch to Prisma create/update args. */
function knowledgeExtractionBatchCreate(item: KnowledgeExtractionBatch) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    extractionRunId: item.extractionRunId,
    documentId: item.documentId ?? null,
    domainKey: item.domainKey,
    batchIndex: item.batchIndex,
    questionKeysJson: item.questionKeysJson ?? {},
    status: item.status,
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    modelProvider: item.modelProvider ?? null,
    modelName: item.modelName ?? null,
    timeoutMs: item.timeoutMs,
    errorMessage: item.errorMessage ?? null,
    resultJson: item.resultJson ?? {},
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? null,
  };
}
function knowledgeExtractionBatchUpdate(item: KnowledgeExtractionBatch) {
  const { id, workspaceId, ...update } = knowledgeExtractionBatchCreate(item);
  void id; void workspaceId;
  return update;
}

/** Map a KnowledgeExtractionSourceBundle to Prisma create/update args. */
function knowledgeExtractionSourceBundleCreate(item: KnowledgeExtractionSourceBundle) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    status: item.status,
    websiteUrl: item.websiteUrl ?? null,
    websiteCrawlJobId: item.websiteCrawlJobId ?? null,
    uploadedDocumentIdsJson: item.uploadedDocumentIdsJson ?? {},
    sourceCount: item.sourceCount,
    combinedTextLength: item.combinedTextLength,
    extractionRunId: item.extractionRunId ?? null,
    errorMessage: item.errorMessage ?? null,
  };
}
function knowledgeExtractionSourceBundleUpdate(item: KnowledgeExtractionSourceBundle) {
  const { id, workspaceId, ...update } = knowledgeExtractionSourceBundleCreate(item);
  void id; void workspaceId;
  return update;
}

/** Map a KnowledgeExtractionSource to Prisma create/update args. */
function knowledgeExtractionSourceCreate(item: KnowledgeExtractionSource) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    bundleId: item.bundleId,
    sourceType: item.sourceType,
    sourceTitle: item.sourceTitle,
    sourceUrl: item.sourceUrl ?? null,
    sourceFileName: item.sourceFileName ?? null,
    extractedText: item.extractedText,
    metadataJson: item.metadataJson ?? {},
    status: item.status,
  };
}
function knowledgeExtractionSourceUpdate(item: KnowledgeExtractionSource) {
  const { id, workspaceId, ...update } = knowledgeExtractionSourceCreate(item);
  void id; void workspaceId;
  return update;
}

// =============================================================================
// Stage A.1 (2026-07-26) — Order + Quote REAL Prisma repositories.
//
// Replaces the previous stubOrderRepository / stubQuoteRepository (which threw
// "not implemented"). The Prisma schema + the Order/Quote models always
// existed; only the repository implementations were missing. Mirrors the JSON
// JsonOrderRepository / JsonQuoteRepository contract 1:1, including the atomic
// createWithNextOrderNumber / createWithNextQuoteNumber methods (which the
// route prefers when present — see route.ts:1993 + :2030).
//
// Pinned by scripts/golden/golden-prisma-commercial-parity.ts (7 cases).
// =============================================================================

/**
 * Map a Prisma `Order` row (Decimal columns come back as Prisma.Decimal; JSON
 * columns come back as already-parsed objects) to the runtime `Order` shape.
 *
 * Decimal handling: Prisma returns Decimal(12,2) columns as Prisma.Decimal
 * objects. We convert to JS number with Number(value) — safe because the
 * values are money (max ~99,999,999,999.99), well within Number.MAX_SAFE.
 */
function mapOrder(record: Record<string, unknown>): Order {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    orderNumber: Number(record.orderNumber || 0),
    // N-BUG (2026-09-08) — lead_id is nullable: an order with no lead is a
    // documented capability (free sample, walk-in). The domain type uses ""
    // for that, the way the JSON substrate always has, so NULL reads back as
    // "" and nothing above the repository has to learn a second spelling.
    // String(null) would be the literal "null", which is worse than either.
    leadId: record.leadId == null ? "" : String(record.leadId),
    quoteId: record.quoteId as string | undefined,
    status: record.status as Order["status"],
    lineItems: (record.lineItemsJson as Order["lineItems"]) || [],
    grandTotal: Number(record.grandTotal ?? 0),
    currencyCode: String(record.currencyCode || "INR"),
    origin: (record.origin as Order["origin"]) || "direct",
    reorderedFromOrderId: record.reorderedFromOrderId as string | undefined,
    sourceReplyId: record.sourceReplyId as string | undefined,
    sourceInteractionId: record.sourceInteractionId as string | undefined,
    discountGiven: record.discountGiven as boolean | undefined,
    totalDiscountAmount: record.totalDiscountAmount == null ? undefined : Number(record.totalDiscountAmount),
    shippedQuantityByLine: record.shippedQuantityByLine as Record<string, number> | undefined,
    // Stage A.1 schema drift fix: this column was missing before; now persisted.
    cancelledQuantityByLine: record.cancelledQuantityByLineJson as Record<string, number> | undefined,
    confirmedAt: record.confirmedAt ? iso(record.confirmedAt) : undefined,
    shippedAt: record.shippedAt ? iso(record.shippedAt) : undefined,
    deliveredAt: record.deliveredAt ? iso(record.deliveredAt) : undefined,
    cancelledAt: record.cancelledAt ? iso(record.cancelledAt) : undefined,
    cancelledBy: record.cancelledBy as string | undefined,
    cancelReason: record.cancelReason as string | undefined,
    notes: record.notes as string | undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

/** Build the Prisma `data` payload from an Order create input. */
function orderCreateData(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    orderNumber: input.orderNumber ?? 0,
    // "" means "no lead" in the domain type; the column is a foreign key, so it
    // has to be NULL rather than an empty string that matches no lead row.
    leadId: input.leadId || null,
    quoteId: input.quoteId,
    status: input.status,
    lineItemsJson: input.lineItems,
    grandTotal: input.grandTotal,
    currencyCode: input.currencyCode,
    origin: input.origin,
    reorderedFromOrderId: input.reorderedFromOrderId,
    sourceReplyId: input.sourceReplyId,
    sourceInteractionId: input.sourceInteractionId,
    discountGiven: input.discountGiven,
    totalDiscountAmount: input.totalDiscountAmount,
    shippedQuantityByLine: input.shippedQuantityByLine,
    cancelledQuantityByLineJson: input.cancelledQuantityByLine,
    confirmedAt: input.confirmedAt,
    shippedAt: input.shippedAt,
    deliveredAt: input.deliveredAt,
    cancelledAt: input.cancelledAt,
    cancelledBy: input.cancelledBy,
    cancelReason: input.cancelReason,
    notes: input.notes,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

export class OrderPrismaRepository implements OrderRepository {
  async nextOrderNumber(workspaceId: string): Promise<number> {
    const rows = await model("order").findMany({ where: { workspaceId }, select: { orderNumber: true } });
    const max = rows.reduce((acc: number, r: Record<string, unknown>) => Math.max(acc, Number(r.orderNumber || 0)), 0);
    return max + 1;
  }

  async create(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }): Promise<Order> {
    return mapOrder(await model("order").create({ data: orderCreateData(input) }));
  }

  /**
   * Stage A.1 (2026-07-26) — Atomic number allocation. Combines nextOrderNumber
   * + create inside ONE `prisma.$transaction` so concurrent callers cannot both
   * read the same max and create duplicate order numbers. Mirrors the JSON
   * JsonOrderRepository.createWithNextOrderNumber (Cluster D fix, session 20).
   * Pinned by golden:prisma-commercial-parity CASE 1 (Order 1 then Order 2 →
   * orderNumbers 1 then 2, never both 1).
   */
  async createWithNextOrderNumber(input: Partial<Order> & { workspaceId: string; leadId: string; status: Order["status"]; lineItems: Order["lineItems"]; grandTotal: number; currencyCode: string; origin: Order["origin"] }): Promise<Order> {
    return await runTx(async (tx: unknown) => {
      const sql = tx as { $executeRawUnsafe(query: string, value: string): Promise<unknown> };
      await sql.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", `order-number:${input.workspaceId}`);
      const delegate = (tx as Record<string, Delegate>)["order"];
      const existing = await delegate.findMany({ where: { workspaceId: input.workspaceId }, select: { orderNumber: true } });
      const max = existing.reduce((acc: number, r: Record<string, unknown>) => Math.max(acc, Number(r.orderNumber || 0)), 0);
      const orderNumber = max + 1;
      const created = await delegate.create({ data: orderCreateData({ ...input, orderNumber }) });
      return mapOrder(created);
    });
  }

  async getById(workspaceId: string, orderId: string): Promise<Order | undefined> {
    const record = await model("order").findFirst({ where: { workspaceId, id: orderId } });
    return record ? mapOrder(record) : undefined;
  }

  async listByWorkspace(workspaceId: string, filters: { status?: Order["status"]; leadId?: string } = {}): Promise<Order[]> {
    return (await model("order").findMany({
      where: { workspaceId, ...(filters.status ? { status: filters.status } : {}), ...(filters.leadId ? { leadId: filters.leadId } : {}) },
      orderBy: { createdAt: "desc" },
    })).map(mapOrder);
  }

  async listByLead(workspaceId: string, leadId: string): Promise<Order[]> {
    return (await model("order").findMany({ where: { workspaceId, leadId }, orderBy: { createdAt: "desc" } })).map(mapOrder);
  }

  async update(workspaceId: string, orderId: string, data: Partial<Order>): Promise<Order> {
    await assertScoped(model("order"), workspaceId, orderId, "Order");
    // Map domain field names → Prisma column names for the fields that differ.
    const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
    if (data.lineItems !== undefined) { updateData.lineItemsJson = data.lineItems; delete updateData.lineItems; }
    if (data.cancelledQuantityByLine !== undefined) { updateData.cancelledQuantityByLineJson = data.cancelledQuantityByLine; delete updateData.cancelledQuantityByLine; }
    if (data.shippedQuantityByLine !== undefined) { /* column name matches */ }
    return mapOrder(await model("order").update({ where: { id: orderId }, data: updateData }));
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all orders for a lead.
   * DPDPA erasure cascade ONLY. Returns the count removed.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("order").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}

function mapQuote(record: Record<string, unknown>): Quote {
  return {
    id: String(record.id),
    workspaceId: String(record.workspaceId),
    quoteNumber: Number(record.quoteNumber || 0),
    // N-BUG (2026-09-08) — lead_id is nullable: an order with no lead is a
    // documented capability (free sample, walk-in). The domain type uses ""
    // for that, the way the JSON substrate always has, so NULL reads back as
    // "" and nothing above the repository has to learn a second spelling.
    // String(null) would be the literal "null", which is worse than either.
    leadId: record.leadId == null ? "" : String(record.leadId),
    orderId: record.orderId as string | undefined,
    supersedesQuoteId: record.supersedesQuoteId as string | undefined,
    status: record.status as Quote["status"],
    lineItems: (record.lineItemsJson as Quote["lineItems"]) || [],
    grandTotal: Number(record.grandTotal ?? 0),
    currencyCode: String(record.currencyCode || "INR"),
    validityNote: record.validityNote as string | undefined,
    sentAt: record.sentAt ? iso(record.sentAt) : undefined,
    acceptedAt: record.acceptedAt ? iso(record.acceptedAt) : undefined,
    notes: record.notes as string | undefined,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

function quoteCreateData(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }) {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    quoteNumber: input.quoteNumber ?? 0,
    // "" means "no lead" in the domain type; the column is a foreign key, so it
    // has to be NULL rather than an empty string that matches no lead row.
    leadId: input.leadId || null,
    orderId: input.orderId,
    supersedesQuoteId: input.supersedesQuoteId,
    status: input.status,
    lineItemsJson: input.lineItems,
    grandTotal: input.grandTotal,
    currencyCode: input.currencyCode,
    validityNote: input.validityNote,
    sentAt: input.sentAt,
    acceptedAt: input.acceptedAt,
    notes: input.notes,
    createdAt: input.createdAt, // N-DATA-2: honour a supplied creation time (JSON parity)
  };
}

export class QuotePrismaRepository implements QuoteRepository {
  async reviseAtomically(workspaceId: string, quoteId: string, build: Parameters<QuoteRepository["reviseAtomically"]>[2]) {
    return runTx(async (tx: unknown) => {
      const delegates = tx as Record<string, Delegate>;
      const sql = tx as { $queryRawUnsafe(query: string, ...values: string[]): Promise<unknown>; $executeRawUnsafe(query: string, value: string): Promise<unknown> };
      await sql.$queryRawUnsafe('SELECT id FROM quotes WHERE id = $1 AND workspace_id = $2 FOR UPDATE', quoteId, workspaceId);
      const row = await delegates.quote.findFirst({ where: { id: quoteId, workspaceId } });
      if (!row) return undefined;
      const draft = await build(mapQuote(row));
      if (draft.workspaceId !== workspaceId || draft.status !== "draft" || draft.supersedesQuoteId !== quoteId) throw new Error("Quote revision returned inconsistent record links.");
      await sql.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", `quote-number:${workspaceId}`);
      const rows = await delegates.quote.findMany({ where: { workspaceId }, select: { quoteNumber: true } });
      const quoteNumber = rows.reduce((max, q) => Math.max(max, Number(q.quoteNumber || 0)), 0) + 1;
      const quote = mapQuote(await delegates.quote.create({ data: quoteCreateData({ ...draft, quoteNumber }) }));
      const supersededQuote = mapQuote(await delegates.quote.update({ where: { id: quoteId }, data: { status: "superseded", updatedAt: new Date() } }));
      return { quote, supersededQuote };
    });
  }
  async convertToOrderAtomically(workspaceId: string, quoteId: string, build: (quote: Quote) => Promise<{ order: Order; quote: Quote }>) {
    return runTx(async (tx: unknown) => {
      const delegates = tx as Record<string, Delegate>;
      const sql = tx as { $queryRawUnsafe(query: string, ...values: string[]): Promise<unknown>; $executeRawUnsafe(query: string, value: string): Promise<unknown> };
      // A row lock also orders this operation with ordinary updates, across
      // server processes. Read the current quote only after obtaining it.
      await sql.$queryRawUnsafe('SELECT id FROM quotes WHERE id = $1 AND workspace_id = $2 FOR UPDATE', quoteId, workspaceId);
      const row = await delegates.quote.findFirst({ where: { id: quoteId, workspaceId } });
      if (!row) return undefined;
      const current = mapQuote(row);
      if (current.status === "converted") {
        const existing = current.orderId ? await delegates.order.findFirst({ where: { id: current.orderId, workspaceId, quoteId } }) : null;
        if (!existing) throw new NeedsActionError("This converted quote has no linked order. Ask the owner to check its history before trying again.", 409);
        return { order: mapOrder(existing), quote: current, alreadyConverted: true };
      }
      const result = await build(current);
      if (result.order.workspaceId !== workspaceId || result.order.quoteId !== quoteId || result.quote.id !== quoteId || result.quote.workspaceId !== workspaceId || result.quote.status !== "converted" || result.quote.orderId !== result.order.id) {
        throw new Error("Quote conversion returned inconsistent record links.");
      }
      // Share numbering lock with direct orders, so neither can allocate the
      // same next number while the other transaction is uncommitted.
      await sql.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", `order-number:${workspaceId}`);
      const rows = await delegates.order.findMany({ where: { workspaceId }, select: { orderNumber: true } });
      const orderNumber = rows.reduce((max, o) => Math.max(max, Number(o.orderNumber || 0)), 0) + 1;
      const order = mapOrder(await delegates.order.create({ data: orderCreateData({ ...result.order, orderNumber }) }));
      const quote = mapQuote(await delegates.quote.update({ where: { id: quoteId }, data: { status: "converted", orderId: order.id, updatedAt: new Date() } }));
      return { order, quote, alreadyConverted: false };
    });
  }
  async nextQuoteNumber(workspaceId: string): Promise<number> {
    const rows = await model("quote").findMany({ where: { workspaceId }, select: { quoteNumber: true } });
    const max = rows.reduce((acc: number, r: Record<string, unknown>) => Math.max(acc, Number(r.quoteNumber || 0)), 0);
    return max + 1;
  }

  async create(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }): Promise<Quote> {
    return mapQuote(await model("quote").create({ data: quoteCreateData(input) }));
  }

  /**
   * Stage A.1 (2026-07-26) — Atomic number allocation. Mirrors
   * OrderPrismaRepository.createWithNextOrderNumber.
   */
  async createWithNextQuoteNumber(input: Partial<Quote> & { workspaceId: string; leadId: string; status: Quote["status"]; lineItems: Quote["lineItems"]; grandTotal: number; currencyCode: string }): Promise<Quote> {
    return await runTx(async (tx: unknown) => {
      const sql = tx as { $executeRawUnsafe(query: string, value: string): Promise<unknown> };
      await sql.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", `quote-number:${input.workspaceId}`);
      const delegate = (tx as Record<string, Delegate>)["quote"];
      const existing = await delegate.findMany({ where: { workspaceId: input.workspaceId }, select: { quoteNumber: true } });
      const max = existing.reduce((acc: number, r: Record<string, unknown>) => Math.max(acc, Number(r.quoteNumber || 0)), 0);
      const quoteNumber = max + 1;
      const created = await delegate.create({ data: quoteCreateData({ ...input, quoteNumber }) });
      return mapQuote(created);
    });
  }

  async getById(workspaceId: string, quoteId: string): Promise<Quote | undefined> {
    const record = await model("quote").findFirst({ where: { workspaceId, id: quoteId } });
    return record ? mapQuote(record) : undefined;
  }

  async listByWorkspace(workspaceId: string, filters: { status?: Quote["status"]; leadId?: string } = {}): Promise<Quote[]> {
    return (await model("quote").findMany({
      where: { workspaceId, ...(filters.status ? { status: filters.status } : {}), ...(filters.leadId ? { leadId: filters.leadId } : {}) },
      orderBy: { createdAt: "desc" },
    })).map(mapQuote);
  }

  async listByLead(workspaceId: string, leadId: string): Promise<Quote[]> {
    return (await model("quote").findMany({ where: { workspaceId, leadId }, orderBy: { createdAt: "desc" } })).map(mapQuote);
  }

  async update(workspaceId: string, quoteId: string, data: Partial<Quote>, expectedStatus?: Quote["status"]): Promise<Quote> {
    return runTx(async (tx: unknown) => {
      const delegates = tx as Record<string, Delegate>;
      const sql = tx as { $queryRawUnsafe(query: string, ...values: string[]): Promise<unknown> };
      await sql.$queryRawUnsafe('SELECT id FROM quotes WHERE id = $1 AND workspace_id = $2 FOR UPDATE', quoteId, workspaceId);
      const current = await delegates.quote.findFirst({ where: { id: quoteId, workspaceId } });
      if (!current) throw new Error(`Quote ${quoteId} not found`);
      if (expectedStatus !== undefined && current.status !== expectedStatus) throw new NeedsActionError("This quote changed while you were working. Refresh it before trying again.", 409);
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (data.lineItems !== undefined) { updateData.lineItemsJson = data.lineItems; delete updateData.lineItems; }
      return mapQuote(await delegates.quote.update({ where: { id: quoteId }, data: updateData }));
    });
  }
  async claimForConversion(workspaceId: string, quoteId: string, fromStatuses: Quote["status"][]): Promise<boolean> {
    // One conditional UPDATE: Postgres lets only one of two racing requests
    // match the "still sent/accepted" condition.
    const result = await model("quote").updateMany!({
      where: { id: quoteId, workspaceId, status: { in: fromStatuses } },
      data: { status: "converted", updatedAt: new Date() },
    }) as { count: number };
    return result.count === 1;
  }

  /**
   * Stage 5 / 2026-07-21 (R5) — Hard-delete all quotes for a lead.
   * DPDPA erasure cascade ONLY.
   */
  async deleteByLead(workspaceId: string, leadId: string): Promise<number> {
    const result = await model("quote").deleteMany({ where: { workspaceId, leadId } });
    return result.count;
  }
}
