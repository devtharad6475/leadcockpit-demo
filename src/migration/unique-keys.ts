/**
 * unique-keys.ts — what makes a row unique BESIDES its id.
 *
 * WHY THIS EXISTS (N-DATA-2, 2026-08-18). The migration planner decided every
 * row's fate by looking at its `id` and nothing else: id in JSON only → create,
 * id in both → compare, id in Postgres only → leave alone. That model is
 * complete only if `id` is the sole unique constraint on the table. It is not.
 * Thirty models carry a second unique constraint, and the planner could not see
 * any of them.
 *
 * The consequence was not theoretical. The first real `--write` run planned
 * `order_demo_1` as a CREATE — correctly, its id was not in Postgres — and the
 * write failed with:
 *
 *     Unique constraint failed on the fields: (`workspace_id`,`order_number`)
 *
 * because a leftover seed row, `seed_order_1`, was already holding order number
 * 1 in that workspace. A different id, the same unique tuple. The plan said the
 * migration was clean; the database disagreed at write time. That is precisely
 * the failure the planner is supposed to make impossible — its whole purpose is
 * that nothing is attempted which was not named in advance.
 *
 * HOW DRIFT IS PREVENTED. These tables are hand-declared, not derived at
 * runtime: this module is pure and must not read schema.prisma. Hand-declared
 * tables rot, so `golden:migration-unique-collision` re-derives both maps from
 * schema.prisma and fails if they disagree — including if a NEW model gains a
 * unique constraint that nobody added here. The golden also asserts a floor on
 * the number of models it parsed, because a broken parse would otherwise pass
 * every check vacuously.
 *
 * Field names below are DOMAIN field names (the camelCase names on the rows the
 * repositories hand back), which for every constraint here are also the Prisma
 * field names. The golden checks that too.
 */

/**
 * Which Prisma model backs each collection in MIGRATION_RULES.
 *
 * Explicit rather than derived by singularising the collection name. A
 * heuristic gets 46 of these 51 right and returns nothing for the other five
 * (`processedWebhookMessageIds`, `icps`, `llmModelRoutings`, `aiUsageLimits`,
 * `doNotContactRegistry`) — and "no model found" would read as "no unique
 * constraints to worry about", which is the vacuous pass this module exists to
 * rule out.
 */
export const COLLECTION_MODELS: Record<string, string> = {
  knowledgeQuestionAnswers: "KnowledgeQuestionAnswer",
  unknownQuestions: "UnknownQuestion",
  knowledgeExtractionRuns: "KnowledgeExtractionRun",
  knowledgeExtractionBatches: "KnowledgeExtractionBatch",
  knowledgeExtractionSourceBundles: "KnowledgeExtractionSourceBundle",
  knowledgeExtractionSources: "KnowledgeExtractionSource",
  knowledgeBaseDocuments: "KnowledgeBaseDocument",
  knowledgeBaseChunks: "KnowledgeBaseChunk",
  knowledgeEntries: "KnowledgeEntry",
  humanFallbackTasks: "HumanFallbackTask",
  processedWebhookMessageIds: "ProcessedWebhookMessage",
  auditLogs: "AuditLog",
  eventLogs: "EventLog",
  users: "User",
  workspaceMembers: "WorkspaceMember",
  workspaces: "Workspace",
  businessProfiles: "BusinessProfile",
  leads: "Lead",
  icps: "ICP",
  campaigns: "Campaign",
  campaignLearnings: "CampaignLearning",
  messageTemplates: "MessageTemplate",
  outreachActivities: "OutreachActivity",
  replies: "Reply",
  agentRuns: "AgentRun",
  integrations: "Integration",
  orders: "Order",
  quotes: "Quote",
  tickets: "Ticket",
  ticketEvents: "TicketEvent",
  ticketSlaSettings: "TicketSlaSettings",
  autoReplyLogs: "AutoReplyLog",
  buyerSegments: "BuyerSegment",
  productKnowledges: "ProductKnowledge",
  productVarieties: "ProductVariety",
  productApplications: "ProductApplication",
  productApplicationMarketMaps: "ProductApplicationMarketMap",
  websiteCrawlConsents: "WebsiteCrawlConsent",
  leadReviewSettings: "LeadReviewSettings",
  leadReviewDecisions: "LeadReviewDecision",
  llmModelRoutings: "LLMModelRouting",
  aiUsageLimits: "AIUsageLimit",
  agentBehaviorPolicies: "AgentBehaviorPolicy",
  companyCommunicationSettings: "CompanyCommunicationSettings",
  communicationSettings: "CommunicationSettings",
  whatsAppAgentSettings: "WhatsAppAgentSettings",
  policySettings: "PolicySettings",
  salesSettings: "SalesSettings",
  productSettings: "ProductSettings",
  settingsConflicts: "SettingsConflict",
  mediaCatalogItems: "MediaCatalogItem",
  doNotContactRegistry: "DoNotContactEntry",
  userCredentials: "UserCredential",
};

/**
 * The non-id unique constraints, per collection. A collection absent from this
 * map has none, and the golden proves the absence rather than assuming it.
 *
 * Each entry is a list of tuples: `[["workspaceId", "orderNumber"]]` means the
 * pair is unique together, so two rows may share a workspace and two rows may
 * share an order number, but not both.
 */
export const UNIQUE_KEYS: Record<string, string[][]> = {
  knowledgeQuestionAnswers: [["workspaceId", "questionKey"]],
  knowledgeEntries: [["workspaceId", "questionId"]],
  processedWebhookMessageIds: [["workspaceId", "providerMessageId"]],
  users: [["workspaceId", "email"]],
  workspaceMembers: [["workspaceId", "userId"], ["workspaceId", "email"]],
  integrations: [["workspaceId", "provider"]],
  orders: [["workspaceId", "orderNumber"]],
  quotes: [["workspaceId", "quoteNumber"]],
  tickets: [["workspaceId", "ticketNumber"]],
  ticketSlaSettings: [["workspaceId"]],
  leadReviewSettings: [["workspaceId"]],
  companyCommunicationSettings: [["workspaceId"]],
  communicationSettings: [["workspaceId"]],
  whatsAppAgentSettings: [["workspaceId"]],
  policySettings: [["workspaceId"]],
  // Both carry @@unique([workspaceId]) in the schema, exactly like the two
  // sibling settings tables above. Declaring the rule without declaring the
  // model here would leave findUniqueCollisions returning [] for them —
  // silently unchecked rather than checked and clean.
  salesSettings: [["workspaceId"]],
  productSettings: [["workspaceId"]],
  userCredentials: [["workspaceId", "email"]],
};

/** One row that cannot be written because a different row already holds its unique tuple. */
export interface UniqueCollision {
  /** The id the migration wanted to create. */
  jsonId: string;
  /** The id already holding the tuple in Postgres. */
  postgresId: string;
  /** The constraint that would fire, e.g. ["workspaceId", "orderNumber"]. */
  key: string[];
  /** The tuple's values, for the report. */
  values: string[];
}

/**
 * Find rows the plan wants to CREATE whose unique tuple is already held by a
 * DIFFERENT id in Postgres.
 *
 * Only creates are checked, and that is deliberate. A row planned as overwrite
 * or identical shares its id with the Postgres row, so it is the same row and
 * cannot collide with itself. A row planned as create is asserting that nothing
 * like it exists — and this is the check that assertion was never getting.
 *
 * A null or undefined component makes the tuple non-comparable and is skipped:
 * SQL unique constraints do not treat NULLs as equal, so a row with a null in
 * the tuple cannot collide with anything.
 */
export function findUniqueCollisions(
  collection: string,
  createIds: Set<string>,
  jsonRows: Record<string, unknown>[],
  postgresRows: Record<string, unknown>[],
): UniqueCollision[] {
  const keys = UNIQUE_KEYS[collection];
  if (!keys || keys.length === 0) return [];

  const collisions: UniqueCollision[] = [];
  for (const key of keys) {
    // tuple -> the Postgres id holding it
    const held = new Map<string, string>();
    for (const row of postgresRows) {
      const tuple = tupleOf(row, key);
      if (tuple) held.set(tuple, String(row.id));
    }
    for (const row of jsonRows) {
      const id = String(row.id);
      if (!createIds.has(id)) continue;
      const tuple = tupleOf(row, key);
      if (!tuple) continue;
      const holder = held.get(tuple);
      if (holder === undefined || holder === id) continue;
      collisions.push({
        jsonId: id,
        postgresId: holder,
        key,
        values: key.map((k) => String(row[k])),
      });
    }
  }
  return collisions;
}

function tupleOf(row: Record<string, unknown>, key: string[]): string | undefined {
  const parts: string[] = [];
  for (const field of key) {
    const value = row[field];
    if (value === null || value === undefined) return undefined;
    parts.push(String(value));
  }
  return JSON.stringify(parts);
}
