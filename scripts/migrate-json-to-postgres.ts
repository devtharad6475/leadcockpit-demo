/**
 * migrate-json-to-postgres.ts — N-DATA-2, the executor half.
 *
 * WHAT IT DOES: reads BOTH substrates, prints exactly what a migration would do
 * row by row, and — only when passed `--write` — applies it and then PROVES it
 * by re-planning against a freshly-read Postgres.
 *
 * Without `--write` it writes nothing. With `--write` it writes everything the
 * plan named and nothing it did not. There is no middle setting, and no flag
 * that is accepted and then quietly ignored (the trap `import-json-to-postgres.ts`
 * fell into: it advertises `--write`, accepts it, and then refuses, which reads
 * like a bug every time somebody tries it).
 *
 * THE RE-PLAN IS THE POINT. "The writes returned without throwing" is not
 * evidence the rows are there — on this codebase a write to a non-snapshot
 * collection through mutateAll vanishes with only a warning (prisma/index.ts:3162).
 * So after writing, this script reads Postgres again from scratch, rebuilds the
 * plan, and requires `create=0` and `overwrite=0`. Anything else is reported as
 * a FAILED migration even if every individual write succeeded.
 *
 * WHY DRY-RUN FIRST, AS ITS OWN STEP. Both substrates use the same workspace id
 * (`workspace_demo`), so this is an upsert onto live rows, not an import into
 * empty space. The decision about which rows may be replaced is made by
 * `buildMigrationPlan` — pure, offline, and pinned by
 * `scripts/golden/golden-migration-plan-safety.ts` (10 cases). This script only
 * supplies the two real snapshots and prints the result.
 *
 * Run: npx tsx scripts/migrate-json-to-postgres.ts            (dry run)
 *      npx tsx scripts/migrate-json-to-postgres.ts --write    (applies it)
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readData } from "@/lib/db";
import { buildMigrationPlan, formatMigrationPlan } from "@/migration/json-to-postgres-plan";
import { MIGRATION_RULES } from "@/migration/migration-rules";
import { explainDbError } from "@/migration/explain-db-error";
import { executeMigration } from "@/migration/migrate-executor";


async function main() {
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") {
    console.error("Run this with PERSISTENCE_PROVIDER=prisma — it reads the Postgres side.");
    process.exit(1);
  }

  // `readData()` reads .leadgen-data/app-data.json directly and is not affected
  // by the provider setting, which is exactly what is needed here: the JSON
  // store is the SOURCE even though the app is bound to Postgres.
  const json = await readData();

  const { createRepositories } = await import("@/repositories");
  const repos = createRepositories();
  const postgres = await readPostgresSnapshot(repos);

  const plan = buildMigrationPlan(
    json as unknown as Record<string, unknown>,
    postgres,
    MIGRATION_RULES,
  );

  const willWrite = process.argv.includes("--write");
  console.log(`=== JSON → POSTGRES MIGRATION PLAN ${willWrite ? "(--write: this plan WILL be applied)" : "(dry run — nothing is written)"} ===\n`);
  console.log(formatMigrationPlan(plan));
  console.log("");

  if (plan.blocked) {
    console.log("PLAN IS BLOCKED. Nothing would run. Reasons above:");
    for (const c of plan.collections.filter((x) => x.blocked)) {
      // Two different reasons, reported separately: an overwrite is a POLICY
      // block (the collection could opt in), a collision is a PHYSICAL one (the
      // constraint would reject the row no matter what the policy says).
      if (c.counts.overwrite > 0 && !c.allowOverwrite) {
        console.log(`  - ${c.collection}: ${c.counts.overwrite} row(s) would be overwritten and it has not opted in.`);
      }
      for (const x of c.collisions) {
        console.log(
          `  - ${c.collection}: ${x.jsonId} cannot be created — (${x.key.join(", ")}) = ` +
          `(${x.values.join(", ")}) is already held by ${x.postgresId}.`,
        );
      }
    }
    for (const c of plan.undeclared) {
      console.log(`  - ${c}: no rule declared.`);
    }
    process.exit(1);
  }

  console.log("PLAN IS CLEAN — every write is either a create, a no-op, or an approved overwrite.");

  if (!process.argv.includes("--write")) {
    console.log("\nDRY RUN — nothing was written. Re-run with --write to apply this plan.");
    return;
  }

  // ── apply ────────────────────────────────────────────────────────────────
  console.log("\n=== APPLYING (--write) ===\n");
  const report = await executeMigration(plan, json as unknown as Record<string, unknown>, repos);
  console.log(`\n  attempted=${report.totalAttempted} written=${report.totalWritten} errors=${report.totalErrors}`);

  // ── prove ────────────────────────────────────────────────────────────────
  // Read Postgres again from scratch. Not the snapshot taken before the write,
  // and not the executor's own tally of what it thinks it did — a fresh read, a
  // fresh plan, and a hard expectation on the result.
  console.log("\n=== RE-PLANNING AGAINST A FRESHLY-READ POSTGRES ===\n");
  const afterPostgres = await readPostgresSnapshot(repos);
  const after = buildMigrationPlan(
    json as unknown as Record<string, unknown>,
    afterPostgres,
    MIGRATION_RULES,
  );
  console.log(formatMigrationPlan(after));

  const remaining = after.totals.create + after.totals.overwrite;
  console.log("");
  if (remaining === 0 && report.totalErrors === 0) {
    console.log(`MIGRATION PROVEN COMPLETE — re-plan says create=0 overwrite=0, and ${after.totals.identical} rows now match on both substrates.`);
    return;
  }

  console.log("MIGRATION DID NOT COMPLETE.");
  console.log(`  write errors:        ${report.totalErrors}`);
  console.log(`  rows still to create: ${after.totals.create}`);
  console.log(`  rows still to overwrite: ${after.totals.overwrite}`);
  for (const r of report.results.filter((x) => x.errors.length)) {
    console.log(`  - ${r.collection}: ${r.errors.length} error(s), first: ${r.errors[0].message}`);
  }
  process.exit(1);
}

/**
 * The Postgres side of the comparison.
 *
 * Split out because it has to be done IDENTICALLY before and after the write.
 * A difference between the two reads shows up as a row that still needs
 * migrating, so the comparison would report the migration as broken when it was
 * not — or, worse, the other way round.
 *
 * This used to also read userCredentials directly, because readAll did not read
 * it. That workaround is gone (2026-08-18, N-DATA-2): readAll was missing SIX
 * collections, not one, and patching the symptom here for the single collection
 * that happened to be noticed is precisely what kept the other five hidden. The
 * blind spot is fixed at source in src/repositories/prisma/index.ts and pinned
 * by scripts/golden/golden-substrate-write-parity.ts (CASE D).
 */
async function readPostgresSnapshot(repos: { readAll?: () => Promise<unknown> }) {
  return (await repos.readAll!()) as unknown as Record<string, unknown>;
}

main().catch((error) => {
  // Lead with the plain-English cause. Prisma's own message for a stopped
  // database says "Invalid `model(\"workspace\").findMany()` invocation" and
  // shows a code frame, which reads as a broken query; the only honest signal
  // is `error.code`, and explainDbError is what reads it. Stack still printed
  // underneath, because for a genuine query defect the stack IS the answer.
  console.error("MIGRATION PLAN FAILED —", explainDbError(error));
  console.error("");
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
