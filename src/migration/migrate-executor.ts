/**
 * migrate-executor.ts — N-DATA-2, the writing half of the JSON → Postgres move.
 *
 * The deciding is done elsewhere and on purpose: `buildMigrationPlan` is pure,
 * offline, and pinned by `golden-migration-plan-safety.ts`. This module does
 * not decide anything. It takes a plan that has already been judged safe and
 * applies exactly the rows that plan named, in an order the database will accept.
 *
 * ─── THE THREE RULES THIS FILE EXISTS TO ENFORCE ──────────────────────────
 *
 * 1. A BLOCKED PLAN IS NEVER APPLIED. Not partially, not "the clean collections
 *    only". A plan is blocked when some collection would overwrite rows it has
 *    not opted into overwriting, and applying the rest first is how you end up
 *    half-migrated with no way to tell which half.
 *
 * 2. `postgres_only` ROWS ARE NEVER TOUCHED. There are 15 of them. They exist
 *    only on the far side, and a migration that deletes rows it did not bring
 *    is a destructive operation wearing an import's clothes. They are counted
 *    and reported, never written and never removed.
 *
 * 3. NOTHING IS BELIEVED WITHOUT RE-PLANNING. The caller re-runs
 *    `buildMigrationPlan` against a freshly-read Postgres afterwards and expects
 *    `create=0, overwrite=0`. "The writes returned without throwing" is not
 *    evidence that the rows are there — several repository writes on this
 *    codebase can silently no-op (writing a non-snapshot collection through
 *    `mutateAll` vanishes with only a warning, prisma/index.ts:3162). The
 *    re-plan is what turns the migration from an assertion into a measurement.
 *
 * ─── WHY TWO PHASES, IN THIS ORDER ────────────────────────────────────────
 *
 * `persistSnapshot` covers 15 collections and writes them in one transaction;
 * everything else must go through its own repository. So the snapshot phase runs
 * first (it carries `users`, which `userCredentials` and `workspaceMembers`
 * point at) — except for `workspaces`, which is lifted out ahead of everything
 * because after N-DATA-3 there are 79 foreign keys pointing at it and no row in
 * this database can exist without it.
 */
import type { MigrationPlan, RowPlan } from "@/migration/json-to-postgres-plan";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AppData } from "@/lib/types";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

export interface CollectionResult {
  collection: string;
  phase: "workspace" | "snapshot" | "repository";
  /** Rows the plan asked for (create + approved overwrite). */
  attempted: number;
  written: number;
  /** Rows present only on Postgres. Reported so "untouched" is a number, not a claim. */
  postgresOnly: number;
  errors: { id: string; message: string }[];
}

export interface ExecutionReport {
  results: CollectionResult[];
  totalAttempted: number;
  totalWritten: number;
  totalErrors: number;
}

/**
 * The 15 collections `persistSnapshotInner` actually upserts, read off the
 * `batchUpsert` calls themselves (src/repositories/prisma/index.ts:3538+) rather
 * than the comment above them — that comment said "14 collections" and listed 15.
 */
const SNAPSHOT_COLLECTIONS = [
  "knowledgeQuestionAnswers", "auditLogs", "eventLogs", "unknownQuestions",
  "knowledgeEntries", "humanFallbackTasks", "processedWebhookMessageIds",
  "knowledgeExtractionRuns", "knowledgeExtractionBatches",
  "knowledgeExtractionSourceBundles", "knowledgeExtractionSources",
  "knowledgeBaseDocuments", "knowledgeBaseChunks", "users", "workspaceMembers",
] as const;

/**
 * Write order for the `repository` collections.
 *
 * Parents before children. Postgres is the final judge — a wrong order raises a
 * foreign-key violation naming the constraint, which is a loud, specific,
 * recoverable failure, and much better than an order that "looks right".
 * Collections not listed here run last, in plan order, so adding one to
 * MIGRATION_RULES without touching this list degrades to "probably fine and
 * loudly wrong if not", never to "silently skipped".
 */
const REPOSITORY_ORDER = [
  "businessProfiles",
  "icps",
  "campaigns",
  "leads",
  "integrations",
  "productKnowledges", "productVarieties", "productApplications",
  // buyerSegments BEFORE productApplicationMarketMaps: a market map carries a
  // buyer_segment_id foreign key, so the wrong way round fails with
  // product_application_market_maps_buyer_segment_id_fkey. Found by running it
  // (N-DATA-2, 2026-08-18) — the list was ordered by name, not by dependency.
  "buyerSegments", "productApplicationMarketMaps",
  "messageTemplates",
  "replies",
  "outreachActivities",
  "agentRuns",
  "campaignLearnings",
  "tickets",
  "ticketEvents",
  "ticketSlaSettings",
  "quotes",
  "orders",
  "autoReplyLogs",
  "mediaCatalogItems",
  "leadReviewSettings",
  "leadReviewDecisions",
  "llmModelRoutings",
  "aiUsageLimits",
  "agentBehaviorPolicies",
  "companyCommunicationSettings",
  "communicationSettings",
  "whatsAppAgentSettings",
  "policySettings",
  "salesSettings",
  "productSettings",
  "settingsConflicts",
  "websiteCrawlConsents",
  // crawlPages and businessExtractions both carry a crawl_job_id, so the job
  // has to exist first. Postgres is the judge either way — the wrong order is
  // a named foreign-key violation, not a silent loss.
  "crawlJobs",
  "crawlPages",
  "businessExtractions",
  "campaignMetrics",
  "escalationRules",
  "conversationPolicies",
  "agentAutonomousSettings",
  "pendingSettingsDrafts",
  "doNotContactRegistry",
  "userCredentials",
];

/**
 * How each `repository` collection is written.
 *
 * Every entry was read off the interface declaration, not guessed from the
 * collection name: the shapes genuinely differ (`create(input)` vs
 * `create(workspaceId, input)` vs `createMany(rows)` vs
 * `upsertForWorkspace(workspaceId, data)`), and a guess that compiles is still
 * a guess. `batch: true` means the repository takes the whole set at once.
 */
type Writer = {
  batch?: boolean;
  write: (repos: RepositoryBundle, rows: Row[], workspaceId: string) => Promise<unknown>;
};

const WRITERS: Record<string, Writer> = {
  businessProfiles: { write: (r, rows) => each(rows, (x) => r.businessProfile.create(x as never)) },
  icps: { batch: true, write: (r, rows) => r.icp.createMany(rows as never) },
  campaigns: { write: (r, rows) => each(rows, (x) => r.campaign.create(x as never)) },
  leads: { write: (r, rows) => each(rows, (x) => r.lead.createLead(x as never)) },
  integrations: { write: (r, rows, ws) => each(rows, (x) => r.integration.create(String(x.workspaceId ?? ws), x as never)) },
  productKnowledges: { write: (r, rows) => each(rows, (x) => r.productKnowledge.create(x as never)) },
  productVarieties: { batch: true, write: (r, rows) => r.productVariety.createMany(rows as never) },
  productApplications: { batch: true, write: (r, rows) => r.productApplication.createMany(rows as never) },
  productApplicationMarketMaps: { batch: true, write: (r, rows) => r.productApplicationMarketMap.createMany(rows as never) },
  buyerSegments: { batch: true, write: (r, rows) => r.buyerSegment.createMany(rows as never) },
  messageTemplates: { write: (r, rows) => each(rows, (x) => r.messageTemplate.create(x as never)) },
  replies: { write: (r, rows) => each(rows, (x) => r.reply.create(x as never)) },
  outreachActivities: { write: (r, rows) => each(rows, (x) => r.outreachActivity.create(x as never)) },
  agentRuns: { write: (r, rows) => each(rows, (x) => r.agentRun.create(x as never)) },
  campaignLearnings: { write: (r, rows) => each(rows, (x) => r.campaignLearning.create(x as never)) },
  tickets: { write: (r, rows) => each(rows, (x) => r.ticket.create(x as never)) },
  ticketEvents: { write: (r, rows) => each(rows, (x) => r.ticketEvent.create(x as never)) },
  ticketSlaSettings: { write: (r, rows, ws) => each(rows, (x) => r.ticketSlaSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  quotes: { write: (r, rows) => each(rows, (x) => r.quote.create(x as never)) },
  orders: { write: (r, rows) => each(rows, (x) => r.order.create(x as never)) },
  autoReplyLogs: { write: (r, rows, ws) => each(rows, (x) => r.autoReplyLog.create(String(x.workspaceId ?? ws), x as never)) },
  mediaCatalogItems: { write: (r, rows, ws) => each(rows, (x) => r.mediaCatalog.create(String(x.workspaceId ?? ws), x as never)) },
  leadReviewSettings: { write: (r, rows, ws) => each(rows, (x) => r.leadReviewSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  leadReviewDecisions: { write: (r, rows) => each(rows, (x) => r.leadReviewDecision.create(x as never)) },
  llmModelRoutings: { batch: true, write: (r, rows, ws) => r.llmModelRouting.replaceForWorkspace(String(rows[0]?.workspaceId ?? ws), rows as never) },
  aiUsageLimits: { write: (r, rows, ws) => each(rows, (x) => r.aiUsageLimit.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  agentBehaviorPolicies: { write: (r, rows) => each(rows, (x) => r.agentBehaviorPolicy.create(x as never)) },
  companyCommunicationSettings: { write: (r, rows, ws) => each(rows, (x) => r.companyCommunicationSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  communicationSettings: { write: (r, rows, ws) => each(rows, (x) => r.communicationSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  whatsAppAgentSettings: { write: (r, rows, ws) => each(rows, (x) => r.whatsAppAgentSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  policySettings: { write: (r, rows, ws) => each(rows, (x) => r.policySettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  salesSettings: { write: (r, rows, ws) => each(rows, (x) => r.salesSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  productSettings: { write: (r, rows, ws) => each(rows, (x) => r.productSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  settingsConflicts: { write: (r, rows, ws) => each(rows, (x) => r.settingsConflict.create(String(x.workspaceId ?? ws), x as never)) },
  websiteCrawlConsents: { write: (r, rows) => each(rows, (x) => r.websiteCrawlConsent.create(x as never)) },
  doNotContactRegistry: { write: (r, rows) => each(rows, (x) => r.doNotContact.create(x as never)) },
  userCredentials: { write: (r, rows) => each(rows, (x) => r.userCredential.create(x as never)) },
  // Session 55 (2026-09-09). These eight were never needed by the one-off
  // JSON→Postgres migration, because the JSON store had no rows in them. They
  // are needed by `restoreWorkspaceCollections` below, which loads an operator's
  // own backup: a collection with no writer is a collection that silently does
  // not come back. `interactions` deliberately has none — there is no
  // interaction repository in the bundle and Postgres never reads the
  // collection, so a restore reports it as unsupported rather than pretending.
  campaignMetrics: { write: (r, rows) => each(rows, (x) => r.campaignMetric.upsertMetric(x as never)) },
  escalationRules: { write: (r, rows) => each(rows, (x) => r.escalationRule.create(x as never)) },
  conversationPolicies: { write: (r, rows, ws) => each(rows, (x) => r.conversationPolicy.upsertForWorkspaceAndChannel(String(x.workspaceId ?? ws), String(x.channel ?? ""), x as never)) },
  agentAutonomousSettings: { write: (r, rows, ws) => each(rows, (x) => r.agentAutonomousSettings.upsertForWorkspace(String(x.workspaceId ?? ws), x as never)) },
  pendingSettingsDrafts: { write: (r, rows, ws) => each(rows, (x) => r.pendingSettingsDraft.upsertPending(String(x.workspaceId ?? ws), x as never)) },
  crawlJobs: { write: (r, rows) => each(rows, (x) => r.websiteCrawlJob.create(x as never)) },
  crawlPages: { write: (r, rows) => each(rows, (x) => r.websiteCrawlPage.create(x as never)) },
  businessExtractions: { write: (r, rows) => each(rows, (x) => r.businessExtraction.create(x as never)) },
};

/**
 * Collections a restore cannot write, and why. Reported to the operator rather
 * than skipped, because "restored" that quietly means "most of it" is the
 * defect this whole path exists to avoid.
 */
export const RESTORE_UNSUPPORTED_COLLECTIONS: Record<string, string> = {
  interactions: "there is no interaction repository, and Postgres does not read this collection",
};

export type RestoreReport = {
  restored: Record<string, number>;
  unsupported: Record<string, string>;
  errors: Array<{ collection: string; id: string; message: string }>;
};

/** Reject unsupported restore sections before any existing data is removed. */
export function unsupportedRestoreCollections(rows: Record<string, Row[]>): string[] {
  return Object.keys(rows).filter(name => rows[name].length > 0 &&
    (RESTORE_UNSUPPORTED_COLLECTIONS[name] ||
      (!(SNAPSHOT_COLLECTIONS as readonly string[]).includes(name) && !WRITERS[name])));
}

/**
 * Session 55 (2026-09-09) — write a workspace's rows back through the
 * repositories, for `POST /api/data/restore`.
 *
 * WHY THIS IS NOT `mutateAll`. Restore first shipped as one mutateAll call that
 * cleared the collections and pushed the backup's rows into the snapshot. On
 * Postgres that is two separate impossibilities: the snapshot writer cannot
 * delete (it is upsert-only, and the guard refused the call outright), and it
 * only upserts FIFTEEN of the fifty-five collections a workspace has — so even
 * with the clear removed, leads, campaigns, tickets, quotes and orders would
 * never have been written. Driven live it answered 200 with "restoredRows:
 * 2342" while the database held nothing. A false success is worse than a
 * failure.
 *
 * This reuses the writers the JSON→Postgres migration already proved, in the
 * same parents-before-children order, and reports per collection what was
 * written, what could not be, and every row that failed.
 */
export async function restoreWorkspaceCollections(
  repos: RepositoryBundle,
  rowsByCollection: Record<string, Row[]>,
  workspaceId: string,
): Promise<RestoreReport> {
  const report: RestoreReport = { restored: {}, unsupported: {}, errors: [] };
  const names = Object.keys(rowsByCollection).filter((name) => (rowsByCollection[name] || []).length > 0);

  // Phase 1: the collections the snapshot writer genuinely does upsert.
  const snapshotNames = names.filter((name) => (SNAPSHOT_COLLECTIONS as readonly string[]).includes(name));
  if (snapshotNames.length) {
    if (!repos.mutateAll) throw new Error("this repository bundle has no mutateAll; the snapshot collections cannot be restored");
    await repos.mutateAll((data) => {
      const store = data as unknown as Record<string, Row[]>;
      for (const name of snapshotNames) {
        const rows = rowsByCollection[name];
        const ids = new Set(rows.map((row) => String(row.id)));
        // Merge, never replace: the snapshot writer cannot delete, so a row
        // dropped here would be a silent no-op at best and a refused write at
        // worst.
        store[name] = (store[name] || []).filter((row) => !ids.has(String(row.id))).concat(rows);
        report.restored[name] = rows.length;
      }
      return null;
    });
  }

  // Phase 2: repository collections, parents before children.
  const repoNames = names.filter((name) => !(SNAPSHOT_COLLECTIONS as readonly string[]).includes(name));
  const ordered = [
    ...REPOSITORY_ORDER.filter((name) => repoNames.includes(name)),
    ...repoNames.filter((name) => !REPOSITORY_ORDER.includes(name)),
  ];
  for (const name of ordered) {
    if (RESTORE_UNSUPPORTED_COLLECTIONS[name]) {
      report.unsupported[name] = RESTORE_UNSUPPORTED_COLLECTIONS[name];
      continue;
    }
    const writer = WRITERS[name];
    if (!writer) {
      report.unsupported[name] = "no writer is declared for this collection";
      continue;
    }
    let written = 0;
    // Row at a time, so one bad row is one reported failure rather than a
    // whole collection vanishing behind a single message.
    for (const row of rowsByCollection[name]) {
      try {
        await writer.write(repos, [row], workspaceId);
        written += 1;
      } catch (error) {
        report.errors.push({ collection: name, id: String(row.id ?? "-"), message: msg(error) });
      }
    }
    if (written) report.restored[name] = written;
  }
  return report;
}

async function each<T>(rows: Row[], fn: (row: Row) => Promise<T>): Promise<void> {
  for (const row of rows) await fn(row);
}

/** The ids a plan says to write: creates, plus overwrites the collection opted into. */
function idsToWrite(rows: RowPlan[], allowOverwrite: boolean): Set<string> {
  return new Set(
    rows
      .filter((r) => r.outcome === "create" || (r.outcome === "overwrite" && allowOverwrite))
      .map((r) => r.id),
  );
}

export async function executeMigration(
  plan: MigrationPlan,
  json: Json,
  repos: RepositoryBundle,
  log: (line: string) => void = console.log,
): Promise<ExecutionReport> {
  if (plan.blocked) {
    throw new Error(
      "REFUSING TO RUN: the plan is blocked. A blocked plan is never applied in part — " +
      "half a migration is worse than none, because nothing afterwards can tell you which half.",
    );
  }
  if (!repos.mutateAll) throw new Error("this repository bundle has no mutateAll; the snapshot phase cannot run");

  const results: CollectionResult[] = [];
  const byName = new Map(plan.collections.map((c) => [c.collection, c]));

  // ── PHASE 0: the workspace ────────────────────────────────────────────────
  // Lifted out of the repository phase and run alone, first. After N-DATA-3
  // there are 79 foreign keys pointing at `workspaces`, so no other row in this
  // database can exist without it. It is also the one collection whose plan is
  // an OVERWRITE rather than a create — the same id holds the real company on
  // JSON and "Demo Workspace" on Postgres, and replacing it is the objective.
  // `update`, not `create`: the row is already there.
  const wsPlan = byName.get("workspaces");
  let workspaceId = "";
  if (wsPlan) {
    const wanted = idsToWrite(wsPlan.rows, wsPlan.allowOverwrite);
    const rows = ((json.workspaces as Row[]) || []).filter((r) => wanted.has(String(r.id)));
    const result: CollectionResult = {
      collection: "workspaces", phase: "workspace",
      attempted: rows.length, written: 0,
      postgresOnly: wsPlan.counts.postgres_only, errors: [],
    };
    for (const row of rows) {
      try {
        const id = String(row.id);
        const existing = await repos.workspace.getById(id);
        if (existing) await repos.workspace.update(id, row as never);
        else await repos.workspace.create(row as never);
        workspaceId = id;
        result.written++;
      } catch (error) {
        result.errors.push({ id: String(row.id), message: msg(error) });
      }
    }
    results.push(result);
    log(`  workspace   workspaces                         wrote ${result.written}/${result.attempted}`);
  }
  if (!workspaceId) {
    workspaceId = String(((json.workspaces as Row[]) || [])[0]?.id || "");
  }

  // ── PHASE 1: the 15 snapshot collections, one transaction ────────────────
  const snapshotNames = SNAPSHOT_COLLECTIONS.filter((c) => byName.has(c));
  const snapshotCounts: Record<string, number> = {};
  await repos.mutateAll(async (data) => {
    for (const name of snapshotNames) {
      const cp = byName.get(name)!;
      const wanted = idsToWrite(cp.rows, cp.allowOverwrite);
      const jsonRows = ((json[name] as Row[]) || []).filter((r) => wanted.has(String(r.id)));
      const store = data as unknown as Record<string, Row[]>;
      const existing = store[name] || [];
      // Merge rather than replace. `postgres_only` rows live in `existing` and
      // must survive: this migration adds and replaces, it never removes.
      const merged = existing.filter((r) => !wanted.has(String(r.id))).concat(jsonRows);
      store[name] = merged;
      snapshotCounts[name] = jsonRows.length;
    }
    return null;
  });
  for (const name of snapshotNames) {
    const cp = byName.get(name)!;
    results.push({
      collection: name, phase: "snapshot",
      attempted: snapshotCounts[name] ?? 0,
      written: snapshotCounts[name] ?? 0,
      postgresOnly: cp.counts.postgres_only, errors: [],
    });
    log(`  snapshot    ${name.padEnd(34)} wrote ${snapshotCounts[name] ?? 0}`);
  }

  // ── PHASE 2: repository collections, parents before children ─────────────
  const repoNames = plan.collections
    .filter((c) => c.policy === "repository" && c.collection !== "workspaces")
    .map((c) => c.collection);
  const ordered = [
    ...REPOSITORY_ORDER.filter((c) => repoNames.includes(c)),
    ...repoNames.filter((c) => !REPOSITORY_ORDER.includes(c)),
  ];

  for (const name of ordered) {
    const cp = byName.get(name)!;
    const wanted = idsToWrite(cp.rows, cp.allowOverwrite);
    const rows = ((json[name] as Row[]) || []).filter((r) => wanted.has(String(r.id)));
    const result: CollectionResult = {
      collection: name, phase: "repository",
      attempted: rows.length, written: 0,
      postgresOnly: cp.counts.postgres_only, errors: [],
    };
    const writer = WRITERS[name];
    if (!writer) {
      result.errors.push({ id: "-", message: `no writer declared for collection ${name}` });
    } else if (rows.length > 0) {
      if (writer.batch) {
        try {
          await writer.write(repos, rows, workspaceId);
          result.written = rows.length;
        } catch (error) {
          result.errors.push({ id: "(batch)", message: msg(error) });
        }
      } else {
        // Row at a time, so one bad row is one reported failure rather than a
        // collection that vanishes behind a single message.
        for (const row of rows) {
          try {
            await writer.write(repos, [row], workspaceId);
            result.written++;
          } catch (error) {
            result.errors.push({ id: String(row.id), message: msg(error) });
          }
        }
      }
    }
    results.push(result);
    const flag = result.errors.length ? `  !! ${result.errors.length} error(s)` : "";
    log(`  repo        ${name.padEnd(34)} wrote ${result.written}/${result.attempted}${flag}`);
    for (const e of result.errors.slice(0, 3)) log(`                ↳ ${e.id}: ${e.message}`);
  }

  return {
    results,
    totalAttempted: results.reduce((n, r) => n + r.attempted, 0),
    totalWritten: results.reduce((n, r) => n + r.written, 0),
    totalErrors: results.reduce((n, r) => n + r.errors.length, 0),
  };
}

function msg(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").filter((l) => l.trim()).slice(-1)[0]?.slice(0, 200) || text.slice(0, 200);
}

export type { AppData };
