export type JsonRecord = Record<string, unknown>;

export type Workspace = {
  id: string;
  name: string;
  ownerUserId?: string;
  businessName?: string;
  industry?: string;
  targetAudience?: string;
  status: "active" | "paused" | "archived" | "suspended";
  /**
   * 2026-07-21 — Emergency stop for ALL auto-outreach in this workspace.
   * Distinct from per-customer autoSendToggle. When true, AutoSendGate
   * fails immediately at condition #1 regardless of any toggle. Owner-
   * only flips; every flip is audit-logged. Per docs/LOGIC.md 2026-07-21.
   */
  autonomyKillSwitch?: boolean;
  /**
   * 2026-07-21 — Per-workspace auto-send opt-in (default OFF). When true,
   * the daily loop is allowed to auto-send the first message to qualified
   * prospects (subject to the other 11 conditions). Kill-switch above
   * overrides this. Per docs/LOGIC.md 2026-07-21.
   */
  autoSendToggle?: boolean;
  /**
   * 2026-07-21 — Owner's WhatsApp number for daily-digest delivery.
   * Optional; if unset, only the in-app Today surface shows the digest.
   */
  ownerWhatsappNumber?: string;
  /**
   * 2026-09-28 — the owner's own WhatsApp messages: morning summary + urgent
   * alerts (read through readOwnerNotifySettings in src/lib/owner-notify.ts;
   * everything off by default). Never used to message a customer.
   */
  ownerNotifySettings?: Record<string, unknown>;
  /**
   * Stage 5 / WP2 (2026-07-28) — Operator kill-switch timestamp. When
   * `status === "suspended"`, this is when the operator flipped it. Cleared
   * on resume. Per docs/LOGIC.md 2026-07-28. Suspend blocks logins for the
   * workspace's users but PRESERVES all data (reversible kill-switch).
   */
  suspendedAt?: string;
  /**
   * Stage 5 / WP2 (2026-07-28) — Operator who suspended (audit trail).
   * Optional; set together with suspendedAt.
   */
  suspendedByAdminId?: string;
  createdAt: string;
  updatedAt: string;
};

export type User = {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "sales_member" | "viewer";
  /**
   * Stage 5 / WP1 (2026-07-28) — When the user verified their email address
   * (clicked the verification link). Per docs/LOGIC.md 2026-07-28: signup is
   * SOFT-verified — the user can log in before verifying; this is just the
   * honest status for the in-app banner + any future "required" tightening.
   */
  emailVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Credentials are kept in a SEPARATE collection from User so that a user
 * record returned to the UI never accidentally carries its password hash.
 * The hash uses the format documented in src/lib/password.ts (scrypt:N:len:salt:hash).
 */
export type UserCredential = {
  id: string;
  userId: string;
  workspaceId: string;
  email: string;
  passwordHash: string;
  /** Marks credentials created by the bootstrap owner-setup flow. */
  provisional?: boolean;
  /**
   * Stage 5 / WP2 (2026-07-28) — Bumped on password reset to invalidate all
   * existing sessions for this user (sessions store the sessionVersion at
   * issue time; a mismatch on the next request rejects the session). Per
   * docs/LOGIC.md 2026-07-28.
   */
  sessionVersion?: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Permanent Do-Not-Contact registry entry. Appended-only; keyed by normalized
 * phone/email. See src/lib/dnc-registry.ts. This is SEPARATE from the
 * per-lead `doNotContact` boolean so that deleting or re-importing a lead
 * can never clear an opt-out.
 */
export type DoNotContactEntry = {
  id: string;
  workspaceId: string;
  normalizedPhone?: string;
  normalizedEmail?: string;
  /** 2026-09-28 (L10) — website host ("shreezari.in"), for a company known only by its website. */
  normalizedDomain?: string;
  reason: string;
  sourceLeadId?: string;
  createdAt: string;
};

export type WorkspaceRole = "owner" | "admin" | "sales_member" | "viewer";

export type WorkspaceMember = {
  id: string;
  workspaceId: string;
  /**
   * N-DATA-18: null while the member is `status: "invited"`. The User row
   * does not exist until they accept, and the empty string this used to
   * hold was a foreign-key violation on Postgres. Read it as a question:
   * has this person claimed their seat yet?
   */
  userId: string | null;
  email: string;
  name?: string;
  role: WorkspaceRole;
  status: "active" | "invited" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type BusinessProfile = {
  id: string;
  workspaceId: string;
  companyName?: string;
  websiteUrl?: string;
  industry?: string;
  businessType?: string;
  description?: string;
  products: string[];
  services: string[];
  productCategories: string[];
  contactEmail?: string;
  contactPhone?: string;
  whatsappNumber?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  targetGeographies: string[];
  currentCustomerTypes: string[];
  desiredCustomerTypes: string[];
  strengths: string[];
  limitations: string[];
  certifications: string[];
  socialLinks: string[];
  catalogueLinks: string[];
  proofAssets: string[];
  languagePreference: string;
  tonePreference: string;
  status: "draft" | "reviewed" | "approved";
  fields: ProfileField[];
  /** N13: the kinds of business the owner confirmed for the checklist. */
  checklistKinds?: string[];
  checklistExports?: boolean;
  /** N13: when the owner confirmed the checklist; unset = only proposed. */
  checklistConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileField = {
  key: string;
  label: string;
  value: string;
  source: "user" | "manual" | "crawler" | "agent";
  confidence: "low" | "medium" | "high";
  missing?: boolean;
};

export type WebsiteCrawlConsent = {
  id: string;
  workspaceId: string;
  websiteUrl: string;
  consentGiven: boolean;
  consentGivenAt?: string;
  consentTextVersion: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
};

export type WebsiteCrawlJob = {
  id: string;
  workspaceId: string;
  websiteUrl: string;
  status: "pending" | "running" | "completed" | "failed";
  pagesFound: number;
  pagesCrawled: number;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductKnowledge = {
  id: string;
  workspaceId: string;
  productName: string;
  productCategory?: string;
  description?: string;
  source: string;
  confidenceScore: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductVariety = {
  id: string;
  workspaceId: string;
  productKnowledgeId: string;
  name: string;
  description?: string;
  useCases: string[];
  buyerTypes: string[];
  confidenceScore: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductApplication = {
  id: string;
  workspaceId: string;
  productKnowledgeId: string;
  varietyId?: string;
  applicationName: string;
  industry?: string;
  description?: string;
  exampleProducts: string[];
  buyerTypes: string[];
  seasonality: JsonRecord;
  confidenceScore: number;
  createdAt: string;
  updatedAt: string;
};

export type BuyerSegment = {
  id: string;
  workspaceId: string;
  name: string;
  segmentType: string;
  description?: string;
  needs: string[];
  buyingCriteria: string[];
  preferredChannels: string[];
  qualificationSignals: string[];
  badFitSignals: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProductApplicationMarketMap = {
  id: string;
  workspaceId: string;
  productKnowledgeId: string;
  varietyId?: string;
  applicationId: string;
  buyerSegmentId: string;
  targetingAngle: string;
  messageAngle: string;
  searchQueries: string[];
  leadSources: string[];
  confidenceScore: number;
  createdAt: string;
  updatedAt: string;
};

export type LeadReviewSettings = {
  id: string;
  workspaceId: string;
  mode: "manual_review" | "agent_recommendation" | "high_confidence_auto_approval" | "full_automation_with_limits";
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  maxAutoApprovedPerDay: number;
  requireHumanForNewCampaigns: boolean;
  requireHumanForNewIndustries: boolean;
  allowAutoEnrichment: boolean;
  allowAutoOutreachPreparation: boolean;
  allowAutoSend: boolean;
  auditEveryDecision: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LeadReviewDecision = {
  id: string;
  workspaceId: string;
  leadId: string;
  campaignId?: string;
  decision: "approve" | "reject" | "needs_review";
  confidenceScore: number;
  reason: string;
  matchedSignals: string[];
  riskSignals: string[];
  suggestedNextStep?: string;
  modeUsed: LeadReviewSettings["mode"];
  decidedBy: "agent" | "human" | "system";
  createdAt: string;
  updatedAt: string;
};

export type WebsiteCrawlPage = {
  id: string;
  crawlJobId: string;
  workspaceId: string;
  url: string;
  title?: string;
  cleanedText: string;
  metadata: JsonRecord;
  createdAt: string;
};

export type BusinessExtraction = {
  id: string;
  workspaceId: string;
  crawlJobId?: string;
  extractedCompanyName?: string;
  extractedIndustry?: string;
  extractedProducts: string[];
  extractedServices: string[];
  extractedContacts: JsonRecord;
  extractedLocations: string[];
  extractedSocials: string[];
  extractedStrengths: string[];
  extractedTargetCustomers: string[];
  extractedCertifications: string[];
  extractedCatalogueLinks: string[];
  confidence: JsonRecord;
  missingFields: string[];
  createdAt: string;
  updatedAt: string;
};

export type ICP = {
  id: string;
  workspaceId: string;
  businessProfileId: string;
  name: string;
  description: string;
  buyerType: string;
  industries: string[];
  geography: string[];
  companySizeBucket: "solo/small business" | "small company" | "medium company" | "large company" | "unknown";
  likelyNeeds: string[];
  buyingTriggers: string[];
  painPoints: string[];
  preferredChannels: string[];
  messagingAngles: string[];
  qualificationRules: string[];
  /**
   * Session 55 — who this ICP is explicitly NOT for.
   *
   * The ICP could say who to sell to and had no way to say who not to. Asked
   * on the live demo whether the product knows a discovered company is a
   * COMPETITOR rather than a buyer, the answer was that nothing in scoring or
   * review had the concept: `decideLead` awarded "Matches ICP context" merely
   * because an icpId was set, and the F-N-R-T score cannot express a
   * disqualification at all — Reachability dominates it, so the best-contactable
   * competitor rises to the top of the list.
   *
   * Discovering "zari manufacturer Surat" returns Om Jari's own competitors
   * alongside its buyers, and they are the easiest of all to reach. Each entry
   * is a plain phrase the owner types — "manufactures zari themselves",
   * "staffing agency" — matched case-insensitively against what is known about
   * a lead. A match is a risk signal naming the phrase, so the operator sees
   * which of their own rules fired and can overrule it.
   */
  exclusions?: string[];
  confidenceScore: number;
  status: "suggested" | "selected" | "rejected" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type Campaign = {
  id: string;
  workspaceId: string;
  businessProfileId: string;
  icpId: string;
  name: string;
  goal: string;
  targetRegion: string[];
  productFocus: string[];
  offer: string;
  selectedChannels: string[];
  dailyOutreachLimit: number;
  leadGoal: number;
  status: "draft" | "active" | "paused" | "completed" | "archived";
  approvalStatus: "needs_review" | "approved" | "rejected";
  plan: CampaignPlan;
  createdAt: string;
  updatedAt: string;
};

export type CampaignPlan = {
  icpSummary: string;
  prospectSources: string[];
  searchQueries: string[];
  messageStrategy: string;
  outreachSequence: string[];
  qualificationCriteria: string[];
  expectedLeadStatuses: string[];
  manualExecutionSteps: string[];
};

/**
 * N11 — what a buyer has told us about themselves, one entry per wanted fact.
 *
 * `value` is the customer's OWN words, not a normalised code. A buyer who said
 * "abhi Surat se le rahe hain, thoda mehnga padta hai" has said something a
 * dropdown cannot hold, and the whole point of listening is to keep what they
 * actually said.
 *
 * `askedAt` is separate from `answeredAt` on purpose: a fact we asked for and
 * did NOT get is not the same as one we never raised, and asking it a second
 * time is the single thing that makes a conversation feel like a form.
 */
/**
 * N11/N12 — one thing worth knowing about a BUYER.
 *
 * Lives here rather than beside the checklist because the workspace settings
 * and the lead both hold lists of these, and the type file cannot import from a
 * feature module without the dependency running backwards.
 */
export type DiscoveryFact = {
  /** Stable key. Stored per lead, so renaming the label must never change it. */
  key: string;
  /** What we want to know, in the owner's terms — shown on screen. */
  label: string;
  /** How to recognise it in what a customer said. Given to the model. */
  lookFor: string;
  /** A way of asking, as an example of TONE only — never a line to send. */
  exampleAsk: string;
  /** Lower is more useful, so it is asked about earlier. */
  priority: number;
};

/**
 * N12 — what THIS owner wants to know about buyers. Their judgement, not
 * research: two zari sellers would ask different things.
 *
 *   spine    — wanted from every buyer.
 *   segments — extra per buyer type (a trader and an exporter are two different
 *              conversations), keyed by `normaliseSegmentKey(lead.buyerType)`.
 *
 * `decidedAt` is what separates "never touched" from "deliberately empty". Absent,
 * the system PROPOSES a starting six so nobody faces a blank box; present, the
 * owner's list stands exactly as saved — including an empty one, because an
 * owner who wants the system to listen for nothing has made a decision, and
 * silently putting the proposal back would overrule it.
 */
export type DiscoveryChecklistSettings = {
  spine: DiscoveryFact[];
  segments: Record<string, DiscoveryFact[]>;
  decidedAt?: string;
};

export type LeadDiscoveryState = Record<string, {
  value?: string;
  /** Inbound customer message supporting an automatically captured fact. */
  sourceReplyId?: string;
  /** A human correction wins over delayed discovery results. */
  ownerEditedAt?: string;
  /** Clears this checklist answer and pauses capture until explicitly resumed. */
  forgottenAt?: string;
  /** When the customer told us. Absent means they have not. */
  answeredAt?: string;
  /**
   * The question's label when it was answered (N12). Kept so an answer stays
   * readable after the owner removes the question from the list.
   */
  label?: string;
  /**
   * When we last asked. Absent means we never have.
   *
   * Reserved, and not written by the listening half — nothing asks yet. It is
   * declared here because the distinction is the point of the shape: a fact we
   * raised and did NOT get an answer to is not the same as one we never raised,
   * and asking a second time is the single thing that makes a conversation feel
   * like a form.
   */
  askedAt?: string;
}>;

export type Lead = {
  id: string;
  workspaceId: string;
  campaignId?: string;
  icpId?: string;
  companyName?: string;
  contactName?: string;
  contactRole?: string;
  websiteUrl?: string;
  source?: string;
  sourceUrl?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  email?: string;
  phone?: string;
  whatsappNumber?: string;
  country?: string;
  state?: string;
  city?: string;
  address?: string;
  /**
   * Stage 3 (2026-07-20) — billing/shipping address for the customer (Lead).
   * Populated when an order is placed. Optional.
   */
  billingAddress?: CustomerAddress;
  shippingAddress?: CustomerAddress;
  buyerType?: string;
  industry?: string;
  companySizeBucket?: string;
  fitReason?: string;
  discoveredInfo?: string;
  relevancyReason?: string;
  personalizationNote?: string;
  /** N4 — what this buyer has told us, in plain sentences, read before the next reply. */
  conversationMemory?: string;
  /** "ai" or "owner". An owner's correction is never overwritten by the AI. */
  conversationMemorySource?: string;
  conversationMemoryAt?: string;
  /**
   * N11 — which facts from the discovery checklist this buyer has told us, and
   * which we have already asked for. Keyed by `DiscoveryFact.key`.
   */
  discoveryState?: LeadDiscoveryState;
  /**
   * N12 — lines the owner added to THIS lead alone ("ask whether the sample
   * reached"). They join this lead's list until answered.
   */
  discoveryExtras?: DiscoveryFact[];
  leadScore: number;
  fitScore: number;
  needScore: number;
  reachabilityScore: number;
  timingScore: number;
  confidenceScore: number;
  qualificationStatus?: string;
  scoreReason?: JsonRecord;
  status: LeadStatus;
  enrichmentStatus: "not_started" | "pending" | "running" | "completed" | "failed";
  enrichmentResult?: {
    status: "matched" | "ambiguous" | "no_results" | "failed";
    matchedSource?: string;
    ambiguousCount?: number;
    validationNote?: string;
    enrichedAt?: string;
  };
  reviewStatus: "pending" | "approved" | "rejected" | "unsure";
  doNotContact: boolean;
  consentStatus?: string;
  assignedTo?: string;
  lastContactedAt?: string;
  // CP-24 (2026-08-02) — timestamp of the customer's LAST inbound message.
  // Drives the WhatsApp 24-hour customer-service window (Meta rule: free-text
  // replies allowed within 24h of this; after that, templates only).
  // SEPARATE from lastContactedAt (which = WE contacted THEM = outbound).
  lastInboundAt?: string;
  nextFollowUpAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type LeadStatus =
  | "prospected" | "contacted_cold" | "talking" | "sample_phase"
  | "discovered" | "needs_review" | "approved" | "rejected" | "enriching" | "enriched"
  | "message_ready" | "contacted" | "replied" | "interested" | "not_interested"
  | "mql" | "sql" | "hot_lead" | "opportunity" | "won" | "closed_won" | "lost" | "closed_lost"
  | "do_not_contact" | "invalid" | "duplicate";

export type KnowledgeEntry = {
  id: string;
  workspaceId: string;
  questionId: string;
  questionText: string;
  answer: string;
  domain: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type Interaction = {
  id: string;
  workspaceId: string;
  leadId: string;
  role: "AI" | "PROSPECT" | "HUMAN_OVERRIDE" | string;
  channel: "WHATSAPP" | "LINKEDIN" | "EMAIL" | string;
  content: string;
  timestamp: string;
  needsHumanHelp: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HumanFallbackTask = {
  id: string;
  workspaceId: string;
  interactionId: string;
  prospectQuery: string;
  status: "PENDING" | "RESOLVED" | string;
  createdAt: string;
  resolvedAt?: string;
  /**
   * 2026-07-21 — When this task has been converted to a Ticket, references
   * the Ticket.id. Per docs/LOGIC.md 2026-07-21.
   */
  convertedToTicketId?: string;
  updatedAt: string;
};

export type MessageTemplate = {
  id: string;
  workspaceId: string;
  campaignId: string;
  leadId?: string;
  channel: string;
  subject?: string;
  body: string;
  tone: string;
  language: string;
  status: "draft" | "approved" | "rejected" | "used";
  personalizationUsed: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type OutreachQueueItem = {
  message: MessageTemplate;
  lead: Lead;
  enrichmentStatus: NonNullable<Lead["enrichmentResult"]>["status"] | "not_enriched";
  daysOld: number;
};

export type LeadActivityEvent = {
  type: "audit" | "outreach" | "reply";
  label: string;
  detail?: string;
  happenedAt: string;
};

export type DashboardIntelligence = {
  pendingReviewLeads: number;
  approvedLeads: number;
  enrichmentGaps: number;
  ambiguousEnrichments: number;
  draftsPendingReview: number;
  followupsDue: number;
  repliesUnread: number;
  recentActivity: Array<{ label: string; entityId: string; happenedAt: string }>;
};

export type OutreachActivity = {
  id: string;
  workspaceId: string;
  campaignId?: string;
  leadId: string;
  channel: string;
  messageTemplateId?: string;
  direction: "outbound" | "inbound";
  status: "drafted" | "approved" | "sent_manual" | "sent_api" | "sent" | "replied" | "failed" | "manual";
  sentManually: boolean;
  body: string;
  subject?: string;
  mediaAttachmentId?: string;
  mediaAttachmentUrl?: string;
  mediaAttachmentName?: string;
  activityAt: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type Reply = {
  id: string;
  workspaceId: string;
  campaignId?: string;
  /**
   * N-DATA-19: absent when the inbound came from a number that matches no
   * lead - the ordinary first contact from a stranger. It is NOT the old
   * "unmatched_whatsapp_lead" placeholder, which produced orphan rows that
   * survived erasure. Read it as a question: do we know who this is yet?
   */
  leadId?: string;
  channel: string;
  rawText: string;
  classification?: string;
  confidenceScore?: number;
  summary?: string;
  suggestedNextAction?: string;
  suggestedResponse?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentRun = {
  id: string;
  workspaceId: string;
  agentName: string;
  input: JsonRecord;
  output?: JsonRecord;
  status: "running" | "completed" | "failed";
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt?: string;
};

export type Integration = {
  id: string;
  workspaceId: string;
  provider: string;
  status: "not_connected" | "connected" | "error";
  authType?: string;
  config: JsonRecord;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderAccount = {
  id: string;
  workspaceId: string;
  integrationId?: string;
  provider: string;
  accountIdentifier?: string;
  email?: string;
  phoneNumber?: string;
  displayName?: string;
  status: "active" | "paused" | "disconnected" | "error";
  dailyLimit?: number;
  usedToday: number;
  config: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type AuditLog = {
  id: string;
  workspaceId: string;
  actorUserId?: string;
  eventType: string;
  entityType?: string;
  entityId?: string;
  payload: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type CampaignLearning = {
  id: string;
  workspaceId: string;
  campaignId: string;
  summary: string;
  winningPatterns: string[];
  losingPatterns: string[];
  recommendedNextSteps: string[];
  createdAt: string;
  updatedAt?: string;
};

export type CampaignMetric = {
  id: string;
  workspaceId: string;
  campaignId: string;
  metricName: string;
  metricValue: number;
  calculatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type EventLog = {
  id: string;
  workspaceId: string;
  eventType: string;
  entityType?: string;
  entityId?: string;
  payload: JsonRecord;
  metadata: JsonRecord;
  status: string;
  createdAt: string;
};

export type JobRun = {
  id: string;
  workspaceId: string;
  jobType: string;
  status: string;
  payload: JsonRecord;
  result?: JsonRecord;
  attempts: number;
  maxAttempts: number;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentBehaviorPolicy = {
  id: string;
  workspaceId?: string;
  name: string;
  scope: "global" | "workspace";
  version: string;
  policy: JsonRecord;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CompanyCommunicationSettings = {
  id: string;
  workspaceId: string;
  language: string;
  tone: string;
  brandVoice?: string;
  messageLength: string;
  greeting: string;
  closing: string;
  preferredWords: string[];
  avoidedWords: string[];
  formalityLevel?: string;
  emojiUsage: string;
  allowHinglish: boolean;
  customInstructions?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationPolicy = {
  id: string;
  workspaceId: string;
  channel: string;
  policy: JsonRecord;
  sensitiveTopics: string[];
  autoReplyAllowedCategories: string[];
  humanApprovalRequiredCategories: string[];
  createdAt: string;
  updatedAt: string;
};

export type WhatsAppAgentSettings = {
  id: string;
  workspaceId: string;
  enabled: boolean;
  mode: "draft_only" | "automatic" | "safe_auto_reply" | "human_approval";
  defaultLanguage: string;
  maxAutoRepliesPerConversation: number;
  businessHours: JsonRecord;
  escalationContactName?: string;
  escalationContactPhone?: string;
  escalationContactEmail?: string;
  unknownAnswerBehavior: string;
  abusiveMessageBehavior: string;
  priceQuestionBehavior: string;
  // CP-22 (2026-08-02) — auto-acknowledge sensitive questions. When ON + a
  // customer asks a sensitive question, the system auto-sends the
  // acknowledgementTemplate (a generic, owner-written holding message — no
  // prices/facts) then escalates to the owner for the real answer. Default OFF.
  autoAcknowledgeSensitive?: boolean;
  acknowledgementTemplate?: string;
  // CP-23 (2026-08-02) — message batching. When ON, inbound WhatsApp messages
  // from the same number are buffered for 60s, merged into one combined
  // message, then processed — so the AI sees full context instead of
  // fragments. Default OFF.
  messageBatchingEnabled?: boolean;
  /**
   * D-2026-09-27-b — the kinds of question the AI may answer by itself when a
   * customer messages first (only in mode safe_auto_reply / automatic). See
   * AutoReplyTrialService for which kinds are tickable and the trial rule.
   */
  autoReplyTopics?: string[];
  /**
   * 2026-09-28 — kinds the SYSTEM switched off after a bad result (complaint,
   * opt-out, or the owner's "should not have sent") following an automatic
   * reply. One entry per kind, newest pause wins. The kind can be ticked again
   * only after a fresh trial counted from `pausedAt`.
   */
  autoReplyPaused?: AutoReplyPause[];
  /** N12 — what this owner wants to learn about buyers. Absent = still the proposal. */
  discoveryChecklist?: DiscoveryChecklistSettings;
  createdAt: string;
  updatedAt: string;
};

export type EscalationRule = {
  id: string;
  workspaceId: string;
  channel: string;
  triggerType: string;
  condition: JsonRecord;
  action: JsonRecord;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UnknownQuestion = {
  id: string;
  workspaceId: string;
  leadId?: string;
  conversationId?: string;
  channel: string;
  questionText: string;
  missingTopic?: string;
  status: "open" | "answered" | "ignored" | "added_to_knowledge";
  suggestedAnswer?: string;
  finalAnswer?: string;
  /**
   * `learned_from_corrections` (N5): proposed because the owner corrected the
   * AI's replies on the same topic several times. A proposal, never a fact,
   * until the owner saves it.
   */
  generatedBy?: "framework" | "llm_suggested" | "conflict_detection" | "whatsapp_unknown" | "user" | "learned_from_corrections" | "learned_from_outcomes";
  relatedDomain?: string;
  relatedQuestionKey?: string;
  conflictSourcesJson?: JsonRecord;
  sourceIds?: string[];
  sourceDocumentId?: string;
  priority?: "high" | "medium" | "low";
  /**
   * 2026-07-21 — When this UnknownQuestion has been converted to a Ticket,
   * references the Ticket.id. Set by convertToTicket(). Prevents double-
   * conversion. Per docs/LOGIC.md 2026-07-21.
   */
  convertedToTicketId?: string;
  /**
   * Q-7 (2026-08-24) — DERIVED, never stored. GET /api/unknown-questions sets
   * this from the framework's own `isEssential` flag so a screen can separate
   * "the AI is blocked on this" from "this is depth for later" without shipping
   * the 424-question table to the browser. Absent on records read straight
   * from the substrate, which is why it is optional.
   */
  isEssential?: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 3 / 2026-07-20 — Quote, Order, OrderLineItem.
 *
 * Per operator decision (2026-07-20):
 *   - NO Invoice model (invoicing lives in Tally/ERP).
 *   - NO tax/GST calculation (that's Tally/ERP's job).
 *   - Quote is optional; orders can start as a Quote or skip straight.
 *   - Quote → Order conversion snapshots prices at conversion time.
 *   - New quotes supersede old ones (old kept for audit).
 *   - Reorders: AI pre-fills draft Order from customer's last order.
 *
 * LeadCockpit captures the commercial conversation, not the books.
 */
export type OrderLineItem = {
  id: string;
  /** Reference to the workspace's product at order time (may be undefined for ad-hoc). */
  productId?: string;
  /** Reference to a specific variant. */
  productVariantId?: string;
  /** Snapshot of the product name at quote/order time. */
  productName: string;
  /** Snapshot of the SKU at quote/order time. */
  sku?: string;
  quantity: number;
  /** "kg", "piece", "metre", "box", etc. */
  unit: string;
  /** Price per unit at quote/order time (snapshot). */
  unitPrice: number;
  /** currencyCode, e.g. "INR". Default INR per OPEN_QUESTIONS S3-Q3. */
  currencyCode: string;
  /** quantity × unitPrice. Computed at write time, stored as snapshot. */
  lineTotal: number;
  notes?: string;
  /**
   * 2026-07-21 — Reorder flag. When this line item was pre-filled from a
   * past order via createReorderDraft AND the current ProductSetting price
   * differs from the line's unitPrice, this is true. UI shows a warning.
   * Per docs/LOGIC.md 2026-07-21.
   */
  priceChangedSinceLastOrder?: boolean;
  /** The current ProductSetting price at reorder-draft time (when priceChangedSinceLastOrder=true). */
  currentPriceSnapshot?: number;
};

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "superseded" | "converted";

export type Quote = {
  id: string;
  workspaceId: string;
  quoteNumber: number;
  leadId: string;
  /** If this quote was converted to an order, references the order. */
  orderId?: string;
  /** If this quote supersedes an earlier one, references it. */
  supersedesQuoteId?: string;
  status: QuoteStatus;
  lineItems: OrderLineItem[];
  /** Sum of lineItem.lineTotal at write time. Snapshot. */
  grandTotal: number;
  currencyCode: string;
  /** Optional validity period the owner stated (e.g. "7 days"). */
  validityNote?: string;
  /** ISO timestamp sent to customer. */
  sentAt?: string;
  /** ISO timestamp customer accepted. */
  acceptedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type OrderStatus = "draft" | "quoted" | "confirmed" | "in_progress" | "partial_shipped" | "shipped" | "delivered" | "cancelled" | "partial_cancelled" | "returned";

// ─── Owner Copilot (2026-08-01) — owner-facing assistant chat ───────────────
// Design: docs/planning/OWNER_COPILOT_DESIGN.md. The Copilot is a universal
// chat surface (owner talks in plain language; AI asks back; then drafts +
// acts with owner approval). These types persist the conversation so it
// survives refresh and is itself auditable. The 5-tier router lives in
// OwnerCopilotService; these types only carry the persisted chat state.
export type CopilotMessageRole = "owner" | "copilot";

export type CopilotMessageKind =
  | "owner_input" // the owner typed something
  | "copilot_question" // the AI is asking a clarifying question (T2 clarify loop)
  | "copilot_draft" // the AI produced a draft (quote/reply/message) for approval
  | "copilot_info" // T1 read-only answer
  | "copilot_confirm" // T3 "this costs ~₹X / ~Y min. Go?"
  | "copilot_deflect" // T5 "that needs the dedicated screen — [link]"
  | "copilot_action_done"; // after owner approval, the action executed

export type OwnerCopilotMessage = {
  id: string;
  workspaceId: string;
  conversationId: string;
  role: CopilotMessageRole;
  kind: CopilotMessageKind;
  /** The visible text (English or Hindi — operator Q4: both). */
  text: string;
  /** Detected language of THIS message: "en" | "hi" | "unknown". */
  language: "en" | "hi" | "unknown";
  /** Which tier this message belongs to (for the audit/UI). */
  tier?: "T1" | "T2" | "T3" | "T4" | "T5";
  /** For copilot_draft: the action awaiting approval + a reference to the draft. */
  pendingAction?: {
    intent: string;
    /** The resolved request the owner is approving; confirmation must keep it. */
    request?: string;
    /** e.g. the drafted quote id, so approve() can find it. */
    entityId?: string;
    entityType?: "quote" | "reply" | "ticket" | "lead" | "icp" | "campaign" | "unknown_question" | "orchestration_job" | "knowledge_question" | "knowledge_answer_confirm";
    /** knowledge_answer_confirm only (2026-09-26): an answer that seems to
     * belong to a different question than the one asked, waiting for the
     * owner's yes. `entityId` is the question it would be saved under. */
    proposal?: SetupAnswerProposal;
    /** Last successful setup save; lets a later editing request refer to it. */
    savedAnswer?: { marker: string; answer: string; ownerWords: string };
  };
  createdAt: string;
};

/**
 * 2026-09-27 — a reminder to do something later about one customer ("call
 * after Diwali"). Plan: docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md §2.
 * Only an `open` reminder counts; an AI-`proposed` one waits for the owner.
 */
export type FollowUpSource = "owner" | "ai_proposed" | "customer_said";
/** 2026-09-28 — what an ai_proposed reminder is about (reorder = past the usual gap; dormant = 2x the gap). */
export type FollowUpKind = "reorder" | "dormant";
export type FollowUpStatus = "proposed" | "open" | "done" | "dismissed";
export type FollowUp = {
  id: string;
  workspaceId: string;
  leadId: string;
  /** IST calendar date (YYYY-MM-DD) the reminder is due. Absent on a proposal the owner has not dated yet. */
  dueOn?: string;
  note: string;
  source: FollowUpSource;
  /** The customer's own words when the reminder came from their message. */
  evidence?: string;
  status: FollowUpStatus;
  /** 2026-09-28 — set on reorder / dormant proposals only. */
  kind?: FollowUpKind;
  /** 2026-09-28 — the order cycle a reorder proposal belongs to (the last order's id): once per customer per cycle. */
  cycleKey?: string;
  createdBy?: string;
  doneAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type OwnerCopilotConversation = {
  id: string;
  workspaceId: string;
  /** The owner who owns this chat. */
  ownerUserId: string;
  /**
   * The lead the owner is currently talking about. Even though the panel is
   * GLOBAL (operator Q1), ACTIONS (T2+) stay per-lead-isolated. The owner can
   * switch this; T1 read-only Q&A can have no active lead.
   */
  activeLeadId?: string;
  /** Clarify-loop counter — how many question-batches so far (cap = 3). */
  clarifyBatchCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Order = {
  id: string;
  workspaceId: string;
  orderNumber: number;
  leadId: string;
  /** If this order started as a quote, references the originating quote. */
  quoteId?: string;
  status: OrderStatus;
  lineItems: OrderLineItem[];
  grandTotal: number;
  currencyCode: string;
  /** Origin: "from_quote" (quote converted) or "direct" (skipped quote). */
  origin: "from_quote" | "direct";
  /** Reorder: if this order is a repeat of a past order, references it. */
  reorderedFromOrderId?: string;
  /**
   * 2026-07-21 — Conversation link. Pointers to the inbound customer message
   * that originated this order (so a future dispute can pull up the exact
   * message in O(1) instead of AI-searching history). Per docs/LOGIC.md.
   */
  sourceReplyId?: string;
  sourceInteractionId?: string;
  /**
   * 2026-07-21 — Discount flag. True if any line item's unitPrice is below
   * the product's stored base price (same currency). Informational only —
   * the owner sees a "discount given" badge. Per docs/LOGIC.md 2026-07-21.
   */
  discountGiven?: boolean;
  totalDiscountAmount?: number;
  /**
   * 2026-07-21 — Per-line shipped quantity when the order is partially
   * shipped (or partial_cancelled). Keyed by OrderLineItem.id.
   * When status is "partial_shipped" or "partial_cancelled", this records
   * how much of each line was actually shipped.
   */
  shippedQuantityByLine?: Record<string, number>;
  /**
   * 2026-07-21 (Cluster C fix, session 19) — Per-line cancelled quantity
   * when the order is partially cancelled (status="partial_cancelled") or
   * fully cancelled (status="cancelled"). Keyed by OrderLineItem.id.
   *
   * Records exactly how much of each line was cancelled so the audit trail
   * is exact (the owner can answer "of the 10 we quoted, how many did we
   * ship vs. cancel"). Per docs/LOGIC.md 2026-07-21 Batch 2 Q10 + the
   * operator's 2026-07-21 decision "Reduce total".
   */
  cancelledQuantityByLine?: Record<string, number>;
  confirmedAt?: string;
  shippedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  /** Who cancelled this order + when + why (audit). */
  cancelledBy?: string;
  cancelReason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 3 / 2026-07-20 — Customer billing/shipping address (on Lead).
 * Optional; populated when the customer places an order.
 */
export type CustomerAddress = {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  country?: string;
  pincode?: string;
  phone?: string;
};

/**
 * Stage 2 / 2026-07-20 — Customer Ticket.
 *
 * A tracked, status-bearing record of a customer problem/complaint/question
 * that needs resolution. Distinct from UnknownQuestion (missing-knowledge
 * card) and HumanFallbackTask (internal flag) — Ticket is the user-facing
 * "your complaint #42 is being handled" surface.
 */
export type TicketType = "problem" | "complaint" | "question" | "request" | "refund" | "return" | "delivery" | "quality";

export type TicketPriority = "urgent" | "high" | "medium" | "low";

export type TicketStatus = "open" | "in_progress" | "waiting_customer" | "resolved" | "closed" | "reopened";

export type TicketSlaClockMode = "business_hours" | "always_24_7" | "mixed";

/**
 * 2026-07-21 — Ticket assignment mode (per-workspace toggle, default "manual").
 * Per docs/LOGIC.md 2026-07-21.
 */
export type TicketAssignmentMode = "manual" | "auto_rule" | "round_robin";

/**
 * 2026-07-21 — One rule in an "auto_rule" assignment policy. A ticket matches
 * a rule if EVERY field in `match` equals the corresponding ticket field.
 * First matching rule wins. Empty match {} matches every ticket (use
 * sparingly — should be the last rule only).
 */
export type TicketAssignmentRule = {
  match: {
    sourceChannel?: string;
    priority?: TicketPriority;
    type?: TicketType;
  };
  assignToUserId: string;
};

/**
 * 2026-07-21 — Source linkage for tickets converted from legacy entities.
 * Records which entity (UnknownQuestion, HumanFallbackTask) spawned this
 * ticket, so the audit trail is exact and double-convert can be blocked.
 */
export type TicketSourceEntityType = "unknown_question" | "human_fallback_task" | "escalation_rule" | "inbound" | "manual";

export type TicketEvent = {
  id: string;
  ticketId: string;
  workspaceId: string;
  eventType: "created" | "status_changed" | "priority_changed" | "assigned" | "commented" | "sla_breached" | "reopened" | "resolved";
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  actorUserId?: string;
  actorType: "agent" | "owner" | "admin" | "system" | "customer";
  note?: string;
  createdAt: string;
};

export type Ticket = {
  id: string;
  workspaceId: string;
  ticketNumber: number; // Sequential per workspace, e.g. #1, #2 (not a UUID)
  leadId?: string;
  replyId?: string;
  conversationId?: string;
  /**
   * N-P1-2 (2026-08-07, docs/OPEN-ISSUES.md) — the order/quote this ticket
   * is complaining about, if any. The New Ticket placeholder text has always
   * said "complaint for Order #4" with no field to hold that reference until
   * now. Both nullable: most tickets aren't about a specific order or quote.
   */
  orderId?: string;
  quoteId?: string;
  sourceChannel: string; // "whatsapp" | "email" | "manual"
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  subject: string; // Short summary
  description: string; // The customer's original message
  resolution?: string;
  assignedTo?: string; // userId
  /**
   * 2026-07-21 — Source linkage. When a ticket is created from a legacy
   * entity (UnknownQuestion, HumanFallbackTask, EscalationRule), records
   * which entity spawned it so the audit trail is exact and double-convert
   * can be blocked. Direct inbound/manual tickets have sourceEntityType
   * set to "inbound" / "manual" with no sourceEntityId.
   */
  sourceEntityType: TicketSourceEntityType;
  sourceEntityId?: string;
  /** ISO timestamp when the SLA clock started ticking. */
  slaStartedAt: string;
  /** ISO timestamp when the SLA target is/was due (computed from priority + workspace SLA settings). */
  slaDueAt: string;
  /**
   * Has the SLA been breached (passed dueAt without reaching resolved)?
   * NOTE 2026-07-21: this stored field is kept for back-compat but is NOT
   * the authoritative source — computeLiveBreach(ticket, now) is. This
   * field is left false on write and computed live at read time.
   */
  slaBreached: boolean;
  /** ISO timestamps for the lifecycle. */
  firstRespondedAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketSlaSettings = {
  id: string;
  workspaceId: string;
  /** How the SLA clock runs. Per-workspace toggle, default business_hours. */
  clockMode: TicketSlaClockMode;
  /** IST business-hours window (24h "HH:MM"). Defaults "09:00"–"18:00". */
  businessHoursStart: string;
  businessHoursEnd: string;
  /** 0=Sun, 6=Sat. Default [1,2,3,4,5,6] (Mon–Sat — per docs/LOGIC.md, Indian B2B typically works Saturdays). */
  businessDays: number[];
  /**
   * 2026-09-28 (M10) — dates the company is closed (holidays), as IST calendar
   * dates "YYYY-MM-DD". The reply-deadline clock does not run on them. Edited
   * by the owner in Workspace settings. Older records have none.
   */
  closedDates?: Array<{ date: string; label?: string; fromRule?: import("@/lib/festival-calendar").FestivalKey }>;
  /**
   * 2026-09-30 — how the company takes each festival (closed? days before and
   * after?). Turned into `closedDates` (marked `fromRule`) for this year and
   * next by FestivalCalendarService. See docs/LOGIC.md FESTIVAL-CALENDAR.
   */
  festivalRules?: import("@/lib/festival-calendar").FestivalRule[];
  /** SLA duration per priority, in minutes of WORKING time. See DEFAULT_SLA_MINUTES in ticket-sla.ts (2026-09-28 M9). */
  urgentSlaMinutes: number;    // default 240 (4 working hours)
  highSlaMinutes: number;      // default 540 (1 working day of 9 h)
  mediumSlaMinutes: number;    // default 1620 (3 working days)
  lowSlaMinutes: number;       // default 3240 (6 working days = 7 calendar days, Mon–Sat)
  /**
   * 2026-07-21 — Ticket assignment mode. Per docs/LOGIC.md 2026-07-21.
   * Default "manual". When "auto_rule", uses assignmentRules. When
   * "round_robin", uses roundRobinPointer + active staff list.
   */
  assignmentMode: TicketAssignmentMode;
  /** Rules used when assignmentMode="auto_rule". First match wins. */
  assignmentRules: TicketAssignmentRule[];
  /** Pointer into the active-staff rotation when assignmentMode="round_robin". */
  roundRobinPointer: number;
  createdAt: string;
  updatedAt: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 / WP3 (2026-07-28) — Platform tickets (user → SaaS operator) +
// PlatformAdmin auth. SEPARATE from the workspace-scoped customer Ticket
// above: a user reporting "the app crashed" to the operator is a different
// audience, SLA owner, and inbox than a customer complaining about an order.
// Rules in docs/LOGIC.md 2026-07-28 (Stage 5 WP3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 2026-07-28 — Closed list of platform-ticket categories. Operator-confirmed
 * (LOGIC.md). Unknown values are rejected at the zod boundary.
 */
export type PlatformTicketCategory = "bug" | "account" | "billing" | "how_to" | "data_request" | "other";

/**
 * 2026-07-28 — Mirrors the Stage 2 TicketStatus lifecycle, plus
 * `waiting_on_user` (operator is waiting for the user's reply). Transitions
 * are NOT hard-enforced (any → any allowed + audit-logged), same rule as
 * Stage 2 (LOGIC.md 2026-07-21). The 7-day reopen window IS enforced.
 */
export type PlatformTicketStatus = "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed" | "reopened";

/** Reuse the proven Stage 2 priority ladder. */
export type PlatformTicketPriority = TicketPriority;

/** Event types on a platform ticket thread. Mirrors Stage 2 TicketEvent. */
export type PlatformTicketEventType =
  | "created"
  | "status_changed"
  | "priority_changed"
  | "assigned"
  | "commented"
  | "sla_breached"
  | "reopened"
  | "resolved"
  | "closed";

/**
 * Who performed an action on a platform ticket. `user` = the workspace user
 * (owner/admin); `operator` = a PlatformAdmin (you / a support hire);
 * `system` = automated (e.g. SLA breach marker). Distinct from Stage 2's
 * actorType so the two threads can never be confused.
 */
export type PlatformTicketActorType = "user" | "operator" | "system";

/**
 * 2026-07-28 — A support ticket raised by a workspace user TO the SaaS
 * operator. Distinct model from the customer `Ticket` (Stage 2).
 *
 * `ticketNumber` is sequential GLOBALLY (across all workspaces), because this
 * is the operator's single support inbox — unlike Stage 2 tickets which are
 * per-workspace sequential.
 */
export type PlatformTicket = {
  id: string;
  workspaceId: string;
  /** The workspace user who opened the ticket (owner/admin only per LOGIC). */
  raisedByUserId: string;
  /** Sequential across ALL workspaces (operator inbox numbering). */
  ticketNumber: number;
  subject: string;
  description: string;
  category: PlatformTicketCategory;
  status: PlatformTicketStatus;
  priority: PlatformTicketPriority;
  /** PlatformAdmin assigned to handle this ticket (operator-side). */
  assignedAdminId?: string;
  /** Operator-side spam flag (LOGIC.md 2026-07-28). Never auto-set. */
  isSpamFlagged: boolean;
  spamReason?: string;
  flaggedByAdminId?: string;
  /** ISO timestamps for the operator's internal SLA (user never sees these). */
  slaStartedAt: string;
  slaDueAt: string;
  firstResponseAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformTicketEvent = {
  id: string;
  ticketId: string;
  workspaceId: string;
  eventType: PlatformTicketEventType;
  actorType: PlatformTicketActorType;
  /** Set when actorType = "user". */
  actorUserId?: string;
  /** Set when actorType = "operator". */
  actorAdminId?: string;
  fromStatus?: PlatformTicketStatus;
  toStatus?: PlatformTicketStatus;
  note?: string;
  createdAt: string;
};

/**
 * 2026-07-28 — The operator's support-hours window. Used by the platform-
 * ticket SLA clock (NOT the customer workspace's business hours). Seeded with
 * Indian B2B defaults; operator-tunable in the admin panel.
 */
export type PlatformSupportHours = {
  id: string;
  /** IST window, 24h "HH:MM". Defaults 09:00–18:00. */
  hoursStart: string;
  hoursEnd: string;
  /** ISO weekday numbers (1=Mon..7=Sun). Default Mon–Sat. */
  businessDays: number[];
  createdAt: string;
  updatedAt: string;
};

/**
 * 2026-07-28 — The operator's INTERNAL SLA targets per priority. These are
 * YOUR targets, not owed to the user. User never sees them. Defaults from
 * LOGIC.md (urgent=4h / high=1bd / medium=3bd / low=7d).
 */
export type PlatformTicketSlaSettings = {
  id: string;
  urgentSlaMinutes: number;
  highSlaMinutes: number;
  mediumSlaMinutes: number;
  lowSlaMinutes: number;
  /** Clock mode for the operator SLA. Default "business_hours". */
  clockMode: TicketSlaClockMode;
  createdAt: string;
  updatedAt: string;
};

/**
 * 2026-07-28 — Per-user support block (operator-side abuse handling).
 * A blocked user cannot OPEN new platform tickets (HTTP 403); existing open
 * tickets are NOT auto-closed. LOGIC.md 2026-07-28.
 */
export type PlatformUserBlock = {
  id: string;
  userId: string;
  workspaceId: string;
  isBlockedFromSupport: boolean;
  reason?: string;
  blockedByAdminId: string;
  blockedAt: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 / WP3 (2026-07-28) — PlatformAdmin auth (the operator who runs the
// SaaS). Separate from workspace User/role: a PlatformAdmin sees across ALL
// workspaces; a workspace User sees only their own. Separate cookie + login.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 2026-07-28 — Operator-side roles. FLAT ladder (not a privilege ranking):
 * `operator` = full power (you); `support_agent` = limited to tickets.
 * LOGIC.md 2026-07-28.
 */
export type PlatformAdminRole = "operator" | "support_agent";

/** Password hash + metadata for a PlatformAdmin. */
export type PlatformAdminCredential = {
  id: string;
  adminId: string;
  email: string;
  passwordHash: string;
  /** 2026-09-28 (S4): bumped on sign-out so a copied admin cookie stops working. */
  sessionVersion?: number;
  createdAt: string;
  updatedAt: string;
};

export type PlatformAdmin = {
  id: string;
  email: string;
  name: string;
  role: PlatformAdminRole;
  /** Soft-suspend (operator can disable a compromised support_agent). */
  status: "active" | "suspended";
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * 2026-07-28 — Audit log for platform-level actions (admin login, workspace
 * suspend, ticket spam-flag, user block, impersonation, config changes).
 * Separate from the per-workspace AuditLog so platform actions have their own
 * tamper-evident trail.
 */
export type PlatformAuditEvent =
  | "admin_login"
  // 2026-09-28 (S4): the operator signed out; every earlier admin cookie ended.
  | "admin_logout"
  | "admin_login_failed"
  | "admin_created"
  | "admin_suspended"
  | "ticket_flagged_spam"
  | "ticket_assigned"
  | "ticket_status_changed"
  | "user_blocked"
  | "user_unblocked"
  | "workspace_suspended"
  | "workspace_resumed"
  | "workspace_provisioned"
  | "impersonation_started"
  | "impersonation_ended"
  | "config_changed"
  | "password_reset_issued";

export type PlatformAuditLog = {
  id: string;
  adminId: string;
  action: PlatformAuditEvent;
  /** Free-form structured detail (target ids, before/after values). */
  metadata?: Record<string, unknown>;
  createdAt: string;
};

/**
 * Stage 5 / WP2 (2026-07-28) — A GLOBAL feature-flag kill-switch.
 *
 * Per docs/LOGIC.md 2026-07-28: a small FIXED set of keys (see
 * FIXED_FLAG_KEYS in FeatureFlagService). All flags are global
 * (workspaceId = null — NO per-workspace overrides in WP2). Default value
 * for an unset flag is TRUE (the system is "on"; the operator flips to
 * false to kill a capability platform-wide).
 */
export type FeatureFlag = {
  id: string;
  /** One of FIXED_FLAG_KEYS (validated on write). */
  key: string;
  /** Always null in WP2 (global flags only). */
  workspaceId: string | null;
  enabled: boolean;
  /** Operator who last toggled (audit trail). */
  lastToggledByAdminId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 5 / WP2 (2026-07-28) — A one-time password-reset token issued by
 * an operator. Per docs/LOGIC.md 2026-07-28: the token is stored HASHED
 * (never plaintext), has a 24-hour expiry, and is delivered to the user
 * via the email provider (the operator never sees it). Issuing a reset
 * bumps the user's sessionVersion, killing existing sessions.
 */
export type PasswordResetToken = {
  id: string;
  userId: string;
  workspaceId: string;
  /** SHA-256 hash of the raw token. The raw token is NEVER stored. */
  tokenHash: string;
  /** Issued-at (ms epoch) — used together with expiresAt for the 24h rule. */
  issuedAt: string;
  /** issuedAt + 24h. After this, the token is rejected. */
  expiresAt: string;
  /** True once the user has used the token to set a new password. */
  consumedAt?: string;
  /** Operator who issued the reset (audit trail). */
  issuedByAdminId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 5 / WP2 (2026-07-28) — An active operator→workspace-user
 * impersonation session. Per docs/LOGIC.md 2026-07-28: operator-only,
 * 15-minute TTL, one at a time, owner blocked, fully audited.
 */
export type ImpersonationSession = {
  id: string;
  /** The platform admin (operator) who is impersonating. */
  adminId: string;
  /** The workspace user being impersonated. */
  targetUserId: string;
  targetWorkspaceId: string;
  /** SHA-256 hash of the token presented to the workspace-session layer. */
  tokenHash: string;
  startedAt: string;
  /** startedAt + 15min. After this, the impersonation session is rejected. */
  expiresAt: string;
  /** Stamped on exitImpersonation; a session with endedAt is invalid. */
  endedAt?: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 5 / WP1 (2026-07-28) — A one-time email-verification token issued at
 * signup (or re-issued on request). Per docs/LOGIC.md 2026-07-28: stored
 * HASHED (never plaintext), 24-hour expiry, idempotent verify, re-issue
 * invalidates prior tokens. Verification is SOFT (login allowed before
 * verifying) — this row exists for the in-app banner + future tightening.
 *
 * Same security shape as PasswordResetToken (hashed, expiry, consumed) so the
 * two share a repository pattern.
 */
export type EmailVerificationToken = {
  id: string;
  userId: string;
  workspaceId: string;
  /** SHA-256 hash of the raw token. The raw token is NEVER stored. */
  tokenHash: string;
  issuedAt: string;
  /** issuedAt + 24h. After this, the token is rejected. */
  expiresAt: string;
  /** Stamped when the user clicks the verify link. */
  consumedAt?: string;
  /** "signup" (issued at signup) | "reissue" (user requested a new one). */
  source: "signup" | "reissue";
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 5 / WP1 (2026-07-28) — A pending member invite. Per docs/LOGIC.md
 * 2026-07-28: owner/admin invites by email with a role from
 * {admin, sales_member, viewer} (NEVER owner); 7-day expiry; token stored
 * HASHED; revoking invalidates the token AND removes the "invited"
 * WorkspaceMember row. The inviter never sees the raw token (zero-knowledge).
 *
 * Lifecycle: pending → (accepted | revoked | expired). An Invite also creates
 * a sibling WorkspaceMember row with status="invited" so the team list shows
 * the pending invitee; that row is REMOVED on revoke, flipped to "active" on
 * accept.
 */
export type Invite = {
  id: string;
  workspaceId: string;
  /** The invitee's email — what the link was sent to. */
  email: string;
  /** The role the invitee will have on accept. One of admin/sales_member/viewer. */
  role: WorkspaceRole;
  /** SHA-256 hash of the raw token. The raw token is NEVER stored. */
  tokenHash: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  /** The user (owner/admin) who issued the invite (audit trail). */
  invitedByUserId: string;
  /** The userId created on accept (set when status → accepted). */
  acceptedByUserId?: string;
  createdAt: string;
  /** createdAt + 7 days. After this, accept is refused. */
  expiresAt: string;
  /** Stamped when status → accepted | revoked | expired. */
  resolvedAt?: string;
  updatedAt: string;
};

export type AutoReplyLog = {
  id: string;
  workspaceId: string;
  leadId?: string;
  replyId?: string;
  channel: string;
  incomingMessage: string;
  retrievedContext: JsonRecord;
  classification?: string;
  generatedReply?: string;
  confidenceScore?: number;
  canAutoSend: boolean;
  needsHumanReview: boolean;
  reason?: string;
  modelProvider?: string;
  modelName?: string;
  modelMode?: "real" | "mock" | "fallback" | "unknown";
  fallbackUsed?: boolean;
  validationStatus?: "valid" | "invalid" | "not_run";
  sendAttempted?: boolean;
  sendStatus?: "not_attempted" | "not_configured" | "sent" | "failed" | "blocked" | "dry_run" | "sent_by_owner" | "unconfirmed";
  providerMessageId?: string;
  providerError?: string;
  mediaAttachmentId?: string;
  mediaAttachmentUrl?: string;
  mediaAttachmentName?: string;
  // CP-22 — "acknowledged" = a generic holding message was auto-sent to the
  // customer; the real answer draft still awaits owner approval.
  status: "drafted" | "auto_sent" | "held_for_review" | "blocked" | "failed" | "approved" | "rejected" | "acknowledged";
  // CP-22 — true when the acknowledgement template was sent (separate from the
  // draft approval). Lets the UI show "holding message sent" distinctly.
  acknowledgementSent?: boolean;
  // 2026-08-05 (UX Fix 1) — operator's internal note on this reply thread.
  // "Called Priya, wants 500kg at ₹42." Not customer-facing; stays in the
  // conversation timeline for the operator + teammates.
  internalNote?: string;
  /**
   * N5 (2026-09-23) — what the AI originally drafted, kept when the owner
   * changed it before approving. Approval overwrites `generatedReply` with the
   * text that was actually sent; without this the correction itself — the most
   * direct statement of what the AI got wrong — was thrown away.
   */
  aiDraft?: string;
  /** True when the owner's approved text differs from the AI's draft. */
  ownerEdited?: boolean;
  /**
   * 2026-09-28 — the owner's judgement of a reply the AI sent BY ITSELF
   * (status auto_sent). Feeds the trial record; "should_not_have_sent"
   * switches that kind off (AutoReplyTrialService.markAutomaticReply).
   */
  ownerVerdict?: "looked_fine" | "should_not_have_sent";
  ownerVerdictAt?: string;
  createdAt: string;
  updatedAt: string;
};

// CP-25 (2026-08-02) — Meta-approved WhatsApp Message Templates. These are the
// ONLY way to message a customer after the 24-hour window closes (Meta rule).
// The owner creates a template, submits it to Meta for approval, then it's
// selectable in the window-closed reply flow. Matches the Prisma model.
export type WhatsAppTemplateStatus = "draft" | "pending" | "approved" | "rejected" | "paused";

export type WhatsAppTemplate = {
  id: string;
  workspaceId: string;
  /** Meta's template name/id once submitted (e.g. "order_update_en"). */
  providerTemplateId?: string;
  name: string;
  language: string; // e.g. "en_US"
  category?: string; // e.g. "MARKETING" | "UTILITY" | "AUTHENTICATION"
  status: WhatsAppTemplateStatus;
  body: string; // body text with {{1}}, {{2}} variable placeholders
  header?: string;
  footer?: string;
  buttons?: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type MediaCatalogItem = {
  id: string;
  workspaceId: string;
  title: string;
  category: "catalog" | "certificate" | "product_image" | "policy_document" | "customer_photo" | "customer_voice_note" | "other";
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
  storagePath: string;
  /**
   * 2026-09-10 (session 55): true when the ROW exists but the file behind it
   * does not. Seeded demo rows and anything uploaded before the bytes moved
   * into the store are in this state: the catalogue lists them, the agent is
   * offered them, and sending one fails at Meta with nothing on any screen
   * explaining why. Computed on read; never stored.
   */
  fileMissing?: boolean;
  caption?: string;
  leadId?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type AgentAutonomousSettings = {
  id: string;
  workspaceId: string;
  icpGeneratorMode: "manual" | "automatic";
  campaignPlannerMode: "manual" | "automatic";
  discoveryMode: "manual" | "automatic";
  whatsappMode: "manual" | "automatic";
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseDocument = {
  id: string;
  workspaceId: string;
  title: string;
  documentType: string;
  source?: string;
  status: "active" | "draft" | "archived";
  contentText: string;
  metadata: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseChunk = {
  id: string;
  workspaceId: string;
  documentId: string;
  chunkIndex: number;
  chunkText: string;
  embedding?: number[];
  metadata: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseQueryLog = {
  id: string;
  workspaceId: string;
  queryText: string;
  retrievedChunks: JsonRecord[];
  answerUsed: boolean;
  confidenceScore?: number;
  createdAt: string;
};

export type KnowledgeQuestionAnswerStatus = "answered" | "unanswered" | "partial" | "conflict" | "needs_review" | "not_applicable";

export type KnowledgeQuestionAnswerEvidence = {
  sourceType: KnowledgeQuestionAnswer["sourceType"];
  sourceId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceFileName?: string;
  sourceSnippet?: string;
  confidenceScore?: number;
  answer?: string;
  extractionRunId?: string;
  createdAt: string;
};

export type KnowledgeQuestionAnswer = {
  id: string;
  workspaceId: string;
  domainKey: string;
  questionKey: string;
  question: string;
  answer?: string;
  answerStatus: KnowledgeQuestionAnswerStatus;
  sourceType: "document" | "website" | "user_answer" | "manual_edit" | "agent_inference" | "whatsapp_unknown" | "system_generated";
  sourceId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceFileName?: string;
  confidenceScore: number;
  usedByAgentsJson: JsonRecord;
  mapsToJson: JsonRecord;
  humanReviewRequired: boolean;
  sourceSnippet?: string;
  conflictWithExisting?: boolean;
  conflictReason?: string;
  reviewedByUser?: string;
  reviewedAt?: string;
  isUserApproved?: boolean;
  isCanonical?: boolean;
  supersededByAnswerId?: string;
  mergedFromAnswerIds?: string[];
  evidenceJson?: { sources: KnowledgeQuestionAnswerEvidence[] };
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeExtractionRun = {
  id: string;
  workspaceId: string;
  sourceType: "document" | "website" | "manual_text";
  sourceId?: string;
  status: "pending" | "running" | "completed" | "failed" | "partial" | "canceled";
  totalQuestions: number;
  processedQuestions?: number;
  answeredCount: number;
  unansweredCount: number;
  partialCount: number;
  conflictCount: number;
  failedBatchCount?: number;
  totalBatches?: number;
  completedBatches?: number;
  currentDomain?: string;
  currentBatchIndex?: number;
  modelProvider?: string;
  modelName?: string;
  fallbackUsed?: boolean;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  outputJson: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeExtractionSourceBundle = {
  id: string;
  workspaceId: string;
  status: "pending" | "preparing_sources" | "crawling_website" | "extracting_files" | "ready_for_question_answering" | "running_extraction" | "completed" | "partial" | "failed" | "canceled";
  websiteUrl?: string;
  websiteCrawlJobId?: string;
  uploadedDocumentIdsJson: JsonRecord;
  sourceCount: number;
  combinedTextLength: number;
  extractionRunId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeExtractionSource = {
  id: string;
  workspaceId: string;
  bundleId: string;
  sourceType: "website" | "uploaded_file" | "pasted_text" | "manual";
  sourceTitle: string;
  sourceUrl?: string;
  sourceFileName?: string;
  extractedText: string;
  metadataJson: JsonRecord;
  status: "pending" | "ready" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeExtractionBatch = {
  id: string;
  workspaceId: string;
  extractionRunId: string;
  documentId?: string;
  domainKey: string;
  batchIndex: number;
  questionKeysJson: JsonRecord;
  status: "pending" | "running" | "completed" | "failed" | "fallback" | "canceled";
  attemptCount: number;
  maxAttempts: number;
  modelProvider?: string;
  modelName?: string;
  timeoutMs: number;
  errorMessage?: string;
  resultJson: JsonRecord;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type LLMProviderCredential = {
  id: string;
  workspaceId: string;
  provider: string;
  displayName?: string;
  encryptedApiKey?: string;
  status: "not_connected" | "connected" | "error";
  config: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type LLMModelRouting = {
  id: string;
  workspaceId: string;
  taskName: string;
  provider: string;
  modelName?: string;
  modelTier: string;
  isEnabled: boolean;
  fallbackProvider?: string;
  fallbackModelName?: string;
  config: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type AIUsageLimit = {
  id: string;
  workspaceId: string;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  dailyCostLimit?: number;
  monthlyCostLimit?: number;
  currentDailyTokens: number;
  currentMonthlyTokens: number;
  currentDailyCost: number;
  currentMonthlyCost: number;
  resetAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SalesSettings = {
  id: string;
  workspaceId: string;
  defaultMOQ?: string;
  productWiseMOQ?: Record<string, string>;
  standardCreditPeriod?: string;
  maxCreditPeriod?: string;
  advancePaymentRule?: string;
  sampleAvailability?: string;
  quotationValidity?: string;
  bulkOrderRule?: string;
  leadQualificationThresholds?: string;
  humanReviewTriggers?: string;
  priceDiscussionRule?: string;
  discountNegotiationRules?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * T1.2 / 2026-07-20: a product variant. Used when the same product comes in
 * multiple forms (size/color/material) — each variant has its own price + SKU.
 *
 * A "simple product" has empty variants and uses its own `ProductSetting.price`.
 * A "product with variants" has 1+ variants; the ProductSetting.price is the
 * headline/display price, and each variant overrides it.
 */
export type ProductVariant = {
  id: string;
  /** Variant label, e.g. "Gold 100g", "Silver 200g", "Copper 50g". */
  name: string;
  /** Distinguishing attribute keys: { "color": "gold", "size": "100g" }. */
  attributes?: Record<string, string>;
  sku?: string;
  /** Variant-specific price (overrides ProductSetting.price when present). */
  price?: number;
  priceUnit?: string;
  /** Variant-level stock note (display only — stock itself lives in Tally/ERP). */
  inStockNote?: string;
};

export type ProductSetting = {
  id: string;
  name: string;
  category?: string;
  /**
   * T1.2 / 2026-07-20: replaced the loose `variants?: string[]` with a
   * structured `ProductVariant[]`. Backward compat: if the persisted data
   * has string variants, the loader maps them to { name, id } stubs.
   */
  variants?: ProductVariant[];
  /** "simple" (no variants) or "variant" (1+ structured variants). Default "simple". */
  productMode?: "simple" | "variant";
  material?: string;
  sizeSpec?: string;
  packaging?: string;
  customizationAvailable?: boolean;
  inStockDispatchTime?: string;
  productionDispatchTime?: string;
  moq?: string;
  useCaseTags?: string[];
  notes?: string;
  /**
   * Phase 1.5 / skill v2 (2026-07-19): optional base price for this product.
   * For a simple product, this IS the price. For a variant product, this is
   * the headline/display price; each variant overrides it.
   * Owner-controlled factual data; the AI never guesses a price.
   * Regional adjustments / bulk discounts are deferred to a later session.
   */
  price?: number;
  /** Unit the price is for: "per kg", "per piece", "per metre", "per box", etc. */
  priceUnit?: string;
};

export type ProductSettings = {
  id: string;
  workspaceId: string;
  products: ProductSetting[];
  createdAt: string;
  updatedAt: string;
};

export type PolicySettings = {
  id: string;
  workspaceId: string;
  paymentPolicy?: string;
  creditPolicy?: string;
  shippingDeliveryPolicy?: string;
  returnReplacementPolicy?: string;
  cancellationPolicy?: string;
  customizationPolicy?: string;
  samplePolicy?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommunicationSettings = {
  id: string;
  workspaceId: string;
  tone?: string;
  defaultFallbackReply?: string;
  allowedAutoReplyTopics?: string[];
  humanReviewRequiredTopics?: string[];
  priceReplyRule?: string;
  creditPaymentReplyRule?: string;
  complaintReplyRule?: string;
  /** What to do when a customer is abusive: a sentence about behaviour, not a
   *  topic. Abusive messages always go to a person regardless (2026-09-24). */
  abusiveMessageRule?: string;
  stopUnsubscribeBehavior?: string;
  unknownAnswerBehavior?: string;
  createdAt: string;
  updatedAt: string;
};

export type SettingsConflictStatus = "open" | "resolved" | "ignored";
export type SettingsConflictResolution = "keep_existing" | "use_extracted" | "custom" | "keep_both" | "not_applicable";

export type SettingsConflict = {
  id: string;
  workspaceId: string;
  settingsArea: "sales" | "product" | "policy" | "communication" | "profile";
  fieldKey: string;
  existingValue?: string;
  extractedValue?: string;
  customValue?: string;
  extractedSource: string;
  status: SettingsConflictStatus;
  resolution?: SettingsConflictResolution;
  resolutionReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type PendingSettingsDraft = {
  id: string;
  workspaceId: string;
  kind: "product" | "structured";
  sourceGroupKey?: string;
  sourceTitle?: string;
  sourceTopic?: string;
  sourceAnswer?: string;
  products?: ProductSetting[];
  sales?: Partial<SalesSettings>;
  policy?: Partial<PolicySettings>;
  communication?: Partial<CommunicationSettings>;
  fields?: Array<{
    area: "sales" | "policy" | "communication";
    fieldKey: string;
    label: string;
    inputType?: "text" | "textarea" | "list";
    value: string | string[];
  }>;
  status: "pending_review" | "saved" | "discarded";
  createdAt: string;
  updatedAt: string;
};

export type AppData = {
  workspaces: Workspace[];
  users: User[];
  userCredentials?: UserCredential[];
  doNotContactRegistry?: DoNotContactEntry[];
  workspaceMembers?: WorkspaceMember[];
  businessProfiles: BusinessProfile[];
  websiteCrawlConsents?: WebsiteCrawlConsent[];
  crawlJobs: WebsiteCrawlJob[];
  crawlPages: WebsiteCrawlPage[];
  businessExtractions: BusinessExtraction[];
  productKnowledges?: ProductKnowledge[];
  productVarieties?: ProductVariety[];
  productApplications?: ProductApplication[];
  buyerSegments?: BuyerSegment[];
  productApplicationMarketMaps?: ProductApplicationMarketMap[];
  knowledgeEntries?: KnowledgeEntry[];
  icps: ICP[];
  campaigns: Campaign[];
  leads: Lead[];
  interactions?: Interaction[];
  humanFallbackTasks?: HumanFallbackTask[];
  leadReviewSettings?: LeadReviewSettings[];
  leadReviewDecisions?: LeadReviewDecision[];
  messageTemplates: MessageTemplate[];
  outreachActivities: OutreachActivity[];
  replies: Reply[];
  agentRuns: AgentRun[];
  integrations: Integration[];
  providerAccounts?: ProviderAccount[];
  auditLogs?: AuditLog[];
  campaignLearnings: CampaignLearning[];
  campaignMetrics?: CampaignMetric[];
  eventLogs?: EventLog[];
  jobRuns?: JobRun[];
  agentBehaviorPolicies?: AgentBehaviorPolicy[];
  companyCommunicationSettings?: CompanyCommunicationSettings[];
  conversationPolicies?: ConversationPolicy[];
  whatsAppAgentSettings?: WhatsAppAgentSettings[];
  escalationRules?: EscalationRule[];
  unknownQuestions?: UnknownQuestion[];
  /** Stage 2 (2026-07-20) — Customer tickets + SLA settings + events. */
  tickets?: Ticket[];
  ticketEvents?: TicketEvent[];
  ticketSlaSettings?: TicketSlaSettings[];
  /** Stage 3 (2026-07-20) — Quotes + Orders. */
  quotes?: Quote[];
  orders?: Order[];
  autoReplyLogs?: AutoReplyLog[];
  mediaCatalogItems?: MediaCatalogItem[];
  whatsAppTemplates?: WhatsAppTemplate[];
  agentAutonomousSettings?: AgentAutonomousSettings[];
  knowledgeBaseDocuments?: KnowledgeBaseDocument[];
  knowledgeBaseChunks?: KnowledgeBaseChunk[];
  knowledgeBaseQueryLogs?: KnowledgeBaseQueryLog[];
  knowledgeQuestionAnswers?: KnowledgeQuestionAnswer[];
  knowledgeExtractionRuns?: KnowledgeExtractionRun[];
  knowledgeExtractionBatches?: KnowledgeExtractionBatch[];
  knowledgeExtractionSourceBundles?: KnowledgeExtractionSourceBundle[];
  knowledgeExtractionSources?: KnowledgeExtractionSource[];
  llmProviderCredentials?: LLMProviderCredential[];
  llmModelRoutings?: LLMModelRouting[];
  aiUsageLimits?: AIUsageLimit[];
  salesSettings?: SalesSettings[];
  productSettings?: ProductSettings[];
  policySettings?: PolicySettings[];
  communicationSettings?: CommunicationSettings[];
  settingsConflicts?: SettingsConflict[];
  pendingSettingsDrafts?: PendingSettingsDraft[];
  /**
   * Session 6 (2026-07-27) I-3 fix — inbound-webhook message-id dedup.
   * Meta's webhook contract says "expect duplicate deliveries; dedup on
   * message.id." Each processed inbound message.id is recorded here BEFORE
   * the heavy work (LLM/ticket/DNC) so a replay is a no-op. Mirrors the
   * unused Prisma `WebhookEvent` model (which is now wired via this collection
   * in JSON mode). The Prisma impl writes to the same `webhookEvents` table.
   */
  processedWebhookMessageIds?: ProcessedWebhookMessage[];
  /**
   * Stage 6 / WP6-C (2026-07-30) — all phone/WhatsApp numbers per lead (6C-1).
   * The Lead's flat `phone`/`whatsappNumber` fields stay as the PRIMARY; this
   * collection holds the full list so inbound lookup matches ANY number (6C-2).
   */
  leadPhoneNumbers?: LeadPhoneNumber[];
  /**
   * Stage 5 / WP3 (2026-07-28) — Platform tickets (user → operator) +
   * PlatformAdmin auth. Stored at the PLATFORM level (no workspace scoping for
   * the operator views); the JSON demo persists them in the same file for
   * simplicity. See docs/LOGIC.md 2026-07-28.
   */
  platformTickets?: PlatformTicket[];
  platformTicketEvents?: PlatformTicketEvent[];
  platformSupportHours?: PlatformSupportHours[];
  platformTicketSlaSettings?: PlatformTicketSlaSettings[];
  platformUserBlocks?: PlatformUserBlock[];
  platformAdmins?: PlatformAdmin[];
  platformAdminCredentials?: PlatformAdminCredential[];
  platformAuditLogs?: PlatformAuditLog[];
  /**
   * Stage 5 / WP2 (2026-07-28) — Global feature-flag kill-switches,
   * operator-issued password-reset tokens, and active impersonation
   * sessions. See docs/LOGIC.md 2026-07-28.
   */
  featureFlags?: FeatureFlag[];
  passwordResetTokens?: PasswordResetToken[];
  impersonationSessions?: ImpersonationSession[];
  /**
   * Stage 5 / WP1 (2026-07-28) — Self-serve signup verification tokens +
   * member invites. See docs/LOGIC.md 2026-07-28 (WP1 entries).
   */
  emailVerificationTokens?: EmailVerificationToken[];
  invites?: Invite[];
  /**
   * Owner Copilot (2026-08-01) — owner-facing assistant chat. Universal +
   * 5-tiered. See docs/planning/OWNER_COPILOT_DESIGN.md + OwnerCopilotService.
   */
  ownerCopilotConversations?: OwnerCopilotConversation[];
  ownerCopilotMessages?: OwnerCopilotMessage[];
  /** 2026-09-27 — reminders to do something later about a customer. */
  followUps?: FollowUp[];
  /** 2026-09-28 — what actually happened after the system talked to a customer. */
  outcomeSignals?: OutcomeSignal[];
};

/**
 * 2026-09-28 — a real result for one customer, recorded where it happens
 * (order/quote status, lead status, opt-out, complaint ticket, no reply in 14
 * days). The weekly learning step joins these to what was sent in the 14 days
 * before and PROPOSES patterns to the owner; nothing changes by itself.
 * Company-scoped; erased with the customer.
 */
export type OutcomeSignalKind = "order_placed" | "quote_accepted" | "lead_won" | "lead_lost" | "opted_out" | "complaint" | "no_reply_14d";
export type OutcomeSignal = {
  id: string;
  workspaceId: string;
  leadId: string;
  kind: OutcomeSignalKind;
  /** When it happened (ISO). */
  at: string;
  /** Money value when there is one (order / quote grand total). */
  value?: number;
  /** Replies that reached this customer in the 14 days before (auto-reply log ids). */
  relatedReplyIds?: string[];
  /** What caused it (order id, quote id, ticket id…). One signal per kind per source. */
  sourceId?: string;
  createdAt: string;
};

/** 2026-09-28 — see WhatsAppAgentSettings.autoReplyPaused. */
export type AutoReplyPause = {
  topic: string;
  pausedAt: string;
  trigger: "complaint" | "opted_out" | "owner_marked";
  /** Plain words for the owner, e.g. "A customer complained 2 days after an automatic greeting reply." */
  reason: string;
  leadId?: string;
  /** The automatic replies that led to it. */
  evidenceLogIds: string[];
  /** Set when the owner has read the notice in "Needs you". */
  seenAt?: string;
};

/**
 * Session 6 I-3 — a record of an inbound WhatsApp message.id we have already
 * processed, so Meta's duplicate webhook deliveries don't create duplicate
 * leads / replies / tickets / DNC registrations. Keyed on the provider's
 * message.id (globally unique per Meta).
 */
export type ProcessedWebhookMessage = {
  id: string;                       // internal row id
  workspaceId: string;
  providerMessageId: string;        // Meta's message.id — the dedup key
  fromPhone?: string;
  processedAt: string;              // ISO timestamp
  outcome: "processed" | "ignored" | "blocked" | "duplicate_skipped";
};

/**
 * Stage 6 / WP6-C (2026-07-30) — a phone/WhatsApp number belonging to a lead.
 *
 * A real business often has SEVERAL numbers (a landline, a mobile, a WhatsApp
 * number, a second branch). The Lead's flat `phone` / `whatsappNumber` fields
 * stay as the PRIMARY (denormalized, backward-compatible — every existing
 * reader keeps working). This collection holds the FULL list, including the
 * primary, so:
 *   - 6C-1: all discovered numbers are stored, not just one.
 *   - 6C-2: inbound lookup (findLeadByPhone) matches ANY of a lead's numbers,
 *     not just the primary — so a customer who texts from their 2nd WhatsApp
 *     number still resolves to the right lead instead of creating a duplicate.
 *
 * `isPrimary` marks the preferred contact number. `normalizedDigits` is the
 * digit-only form used for matching (so "+91 99999 00000" == "919999900000").
 */
export type LeadPhoneNumber = {
  id: string;
  workspaceId: string;
  leadId: string;
  /** The raw number as captured. */
  number: string;
  /** Digit-only normalized form — the match key. */
  normalizedDigits: string;
  /** "whatsapp" | "phone" | "mobile" | "landline" | "other". */
  type: string;
  /** True for the preferred contact number (mirrors lead.phone/whatsappNumber). */
  isPrimary: boolean;
  /** Optional label the operator can read ("main office", "owner mobile"). */
  label?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Stage 4 / 2026-07-20 — Outreach consent record.
 *
 * Per MASTER_PRD §8 + COMPLIANCE_AND_SAFETY §2.1: every contact carries an
 * OutreachConsent with a lawful basis. Cold-discovered prospects default
 * to basis "none" until consent/inbound is documented. Auto-send (Stage 4,
 * toggle-gated) requires basis != "none".
 */
export type OutreachConsentBasis = "inbound" | "consent" | "legitimate_interest" | "none";

export type OutreachConsent = {
  id: string;
  workspaceId: string;
  leadId: string;
  basis: OutreachConsentBasis;
  /** Evidence text/URL/form-id documenting how the basis was established. */
  evidence?: string;
  grantedAt?: string;
  /** If the customer withdrew consent, when. */
  withdrawnAt?: string;
  sourceChannel?: string;
  /** Version of the classifier/policy in effect when the basis was set. */
  classifierVersion?: string;
  createdAt: string;
  updatedAt: string;
};

/** An owner's chat answer, rewritten for the Knowledge Base, not yet saved. */
export type SetupAnswerProposal = {
  /** The answer as it would be saved (clean wording). */
  answer: string;
  /** What the owner actually typed — kept as the evidence. */
  ownerWords: string;
  /** "domain/key" of the question the assistant had asked (still pending). */
  askedMarker?: string;
  /** A wording revision of an existing answer, not a new business fact. */
  revision?: boolean;
  previousAnswer?: string;
};
