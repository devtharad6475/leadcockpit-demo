/**
 * migration-rules.ts — the registry that says how each collection is allowed to
 * move from the JSON store to Postgres (N-DATA-2).
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A CONST INSIDE THE SCRIPT. Three things
 * need the same answer and must never drift apart: the dry run that prints the
 * plan, the write phase that applies it, and the golden that pins the policy
 * decisions. When the registry lived inside the executor the golden could only
 * reach it by regex-parsing the source file, which is a test that passes when
 * the parse breaks. Exporting it means the golden asserts on the REAL object.
 *
 * Nothing here executes. It is data plus the reasoning that produced it.
 */
import type { CollectionRule } from "@/migration/json-to-postgres-plan";

/**
 * How each collection may move. Every collection holding rows in the JSON store
 * must appear here — an omission is reported as `undeclared` and blocks the
 * plan, which is the intended behaviour rather than an inconvenience.
 *
 * `snapshot` = written by repos.mutateAll → persistSnapshot, one transaction,
 *   chunked for Neon. Verified against the batchUpsert calls in
 *   persistSnapshotInner (src/repositories/prisma/index.ts:3438), NOT against
 *   the comment above it — that comment said "14 collections" and listed 15.
 *
 * `repository` = must go through that collection's own repository. Writing one
 *   of these through mutateAll silently vanishes; the warning at
 *   prisma/index.ts:3162 is explicit about it.
 */
export const MIGRATION_RULES: Record<string, CollectionRule> = {
  // --- persistSnapshot-covered (91.2% of all rows, including all 523 answers) ---
  knowledgeQuestionAnswers: { policy: "snapshot" },
  unknownQuestions: { policy: "snapshot" },
  knowledgeExtractionRuns: { policy: "snapshot" },
  knowledgeExtractionBatches: { policy: "snapshot" },
  knowledgeExtractionSourceBundles: { policy: "snapshot" },
  knowledgeExtractionSources: { policy: "snapshot" },
  knowledgeBaseDocuments: { policy: "snapshot" },
  knowledgeBaseChunks: { policy: "snapshot" },
  knowledgeEntries: { policy: "snapshot" },
  humanFallbackTasks: { policy: "snapshot" },
  processedWebhookMessageIds: { policy: "snapshot" },
  auditLogs: { policy: "snapshot" },
  eventLogs: { policy: "snapshot" },
  // 2026-08-18 (session 6) — opted into overwrite after checking what the
  // login actually keys on. `findCredentialByEmail(workspaceId, email)` looks
  // the row up in `user_credentials` and THEN loads the user by
  // `credential.userId` (src/repositories/prisma/index.ts:3223). The user
  // row own email is not the login key, so replacing user_owner email, name
  // and createdAt cannot lock anybody out. What is being replaced was checked
  // against the live ship database, not assumed:
  //     select id, email, name from users;
  //     -> user_owner | owner@demo.local | Demo Owner   (1 row)
  // That is placeholder seed identity, not anything a person typed.
  users: {
    policy: "snapshot",
    allowOverwrite: true,
    reason: "user_owner on Postgres is placeholder seed identity; login keys on user_credentials.email, not users.email",
  },
  workspaceMembers: { policy: "snapshot" },

  // --- must go through their own repository ---
  // The workspace is the ONE collection expected to overwrite: the same id
  // holds "Meghdoot Zari" on JSON and "Demo Workspace" on Postgres, and the
  // whole point of the move is that the running product shows the real company.
  workspaces: {
    policy: "repository",
    allowOverwrite: true,
    reason: "same id, different name on each substrate — replacing it is the objective (G8)",
  },
  businessProfiles: { policy: "repository" },
  leads: { policy: "repository" },
  icps: { policy: "repository" },
  campaigns: { policy: "repository" },
  campaignLearnings: { policy: "repository" },
  messageTemplates: { policy: "repository" },
  outreachActivities: { policy: "repository" },
  replies: { policy: "repository" },
  agentRuns: { policy: "repository" },
  integrations: { policy: "repository" },
  orders: { policy: "repository" },
  quotes: { policy: "repository" },
  tickets: { policy: "repository" },
  ticketEvents: { policy: "repository" },
  ticketSlaSettings: { policy: "repository" },
  autoReplyLogs: { policy: "repository" },
  buyerSegments: { policy: "repository" },
  productKnowledges: { policy: "repository" },
  productVarieties: { policy: "repository" },
  productApplications: { policy: "repository" },
  productApplicationMarketMaps: { policy: "repository" },
  websiteCrawlConsents: { policy: "repository" },
  leadReviewSettings: { policy: "repository" },
  leadReviewDecisions: { policy: "repository" },
  llmModelRoutings: { policy: "repository" },
  aiUsageLimits: { policy: "repository" },
  agentBehaviorPolicies: { policy: "repository" },
  companyCommunicationSettings: { policy: "repository" },
  communicationSettings: { policy: "repository" },
  whatsAppAgentSettings: { policy: "repository" },
  policySettings: { policy: "repository" },
  // 2026-09-08 — salesSettings and productSettings were the only two of the
  // four business-settings tables with no rule at all. An undeclared collection
  // blocks the WHOLE plan, so a migration with a productSettings row could not
  // run: "PLAN IS BLOCKED ... productSettings: no rule declared". Only
  // productSettings surfaced, because the fixture happened to have no
  // salesSettings row — the same omission was one populated row away from
  // blocking a later migration too. Neither is covered by persistSnapshot; both
  // have their own repository with the same upsertForWorkspace shape as the two
  // siblings above, so they take the same policy.
  salesSettings: { policy: "repository" },
  productSettings: { policy: "repository" },
  settingsConflicts: { policy: "repository" },
  mediaCatalogItems: { policy: "repository" },
  doNotContactRegistry: { policy: "repository" },

  // --- deliberately left behind ---
  // 2026-08-18 (session 6) — WAS `skip`, reason "the demo login is created by
  // the seeder, not migrated". THAT REASON WAS FALSE ON THE SHIP SUBSTRATE.
  // Checked directly, in SQL, against the database this product ships on:
  //     select id, email, user_id from user_credentials;   -> (0 rows)
  //     select id, user_id, email from workspace_members;  -> (0 rows)
  // No seeder had ever put a credential there. Shipping with `skip` would
  // therefore ship a Postgres database NOBODY CAN LOG IN TO —
  // findCredentialByEmail returns null for every address, for every workspace.
  // The JSON store holds exactly one credential (cred_tour -> user_tour /
  // tour@leadcockpit.demo). It is the hash of a deliberately fake demo
  // password (D2) and it is the only thing that makes the shipped product
  // openable, so it moves.
  //
  // `repository`, not `snapshot`: persistSnapshot writes 15 collections and
  // userCredential is not one of them, so a mutateAll write here would vanish
  // without an error. NOT opted into overwrite: this is the collection that
  // controls who can log in, so if a credential ever does exist on the far
  // side, the plan must stop and ask rather than replace it.
  userCredentials: { policy: "repository" },
};
