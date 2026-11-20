/**
 * purge-seed-demo-rows.ts — remove `scripts/seed-demo-prisma.ts` debris from a
 * database that is about to hold, or already holds, the REAL product data.
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF THE MIGRATOR (N-DATA-2, 2026-08-18).
 * `src/migration/migrate-executor.ts` holds one invariant above all others: it
 * never deletes a row it did not bring (json-to-postgres-plan.ts calls a
 * migration that deletes "a destructive operation wearing an import's clothes").
 * Removing the seed rows is genuinely a delete, so it does not belong there —
 * hiding it inside the migrator would buy convenience by breaking the one
 * promise that makes the migrator safe to run twice.
 *
 * WHY IT HAS TO HAPPEN AT ALL. The seeder and the real data want the same
 * numbers. `seed_order_1` holds `(workspace_demo, order_number 1)`; the real
 * order `order_demo_1` wants the same tuple. Two different ids, one unique
 * constraint. The first `--write` run of the migration failed on exactly this:
 *
 *     Unique constraint failed on the fields: (`workspace_id`,`order_number`)
 *
 * There is no ordering, policy or retry that resolves it. One of the two rows
 * has to go, and it is not the product's data.
 *
 * WHAT IT DELETES: rows whose id begins with `seed_`, AND rows that point at a
 * lead whose id begins with `seed_`. Nothing else. A
 * `seed_` prefix is not a heuristic here — `scripts/seed-demo-prisma.ts` assigns
 * those ids literally, and no other writer in the codebase produces them (the
 * app uses cuids).
 *
 * WHAT IT DELIBERATELY KEEPS: postgres-only rows that are NOT seed rows —
 * notably the audit logs written by real golden runs against this database
 * (lead.approved, quote.superseded). Those record things that actually
 * happened. They collide with nothing and deleting them would destroy history
 * to tidy up.
 *
 * WHY THE SECOND CLAUSE EXISTS (added 2026-08-20, N-DATA-10). The first
 * version matched on id alone and the docstring above used to end that
 * sentence with "plus whatever the database cascades from those". That was an
 * assumption, not a fact, and it was wrong: `auto_reply_logs.lead_id` carries
 * no foreign key, so nothing cascaded. The seeder assigns literal `seed_` ids
 * to the rows it names and lets Prisma generate a cuid for the ones it does
 * not — the auto-reply log is one of those. So the purge deleted the lead
 * `seed_lead_hot` and left its draft behind, pointing at a customer record
 * that no longer existed. That orphan then sat in the operator's approval
 * queue, undeliverable. Matching on the lead reference as well as the id is
 * what makes "delete the seed rows" mean the whole subtree, with or without a
 * foreign key underneath it.
 *
 * Run: npx tsx scripts/purge-seed-demo-rows.ts           (dry run)
 *      npx tsx scripts/purge-seed-demo-rows.ts --apply
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const APPLY = process.argv.includes("--apply");

/**
 * Deleted in this order: dependents before the rows they point at, so a
 * RESTRICT foreign key does not stop the delete halfway through and leave the
 * database in a state that is neither seeded nor clean.
 */
const TABLES = [
  "ticket_events",
  "tickets",
  "auto_reply_logs",
  "replies",
  "outreach_activities",
  "orders",
  "quotes",
  "lead_review_decisions",
  "leads",
];

async function main() {
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") {
    console.error("Run this with PERSISTENCE_PROVIDER=prisma — it operates on the Postgres side.");
    process.exit(1);
  }
  const { prisma } = await import("@/lib/prisma");

  console.log(`=== SEED DEBRIS PURGE ${APPLY ? "(--apply: rows WILL be deleted)" : "(dry run — nothing is deleted)"} ===\n`);

  // Which of these tables actually carry a lead reference — discovered from the
  // database rather than hardcoded, so a column added later is covered without
  // anyone remembering to update a list here.
  const leadCols: { table_name: string }[] = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'lead_id'`,
  );
  const hasLeadRef = new Set(leadCols.map((r) => r.table_name));

  let total = 0;
  for (const table of TABLES) {
    // `LIKE 'seed\_%'` — the underscore is a single-character wildcard in LIKE,
    // so an unescaped `seed_%` would also match `seedX...`. Escaped, it matches
    // the literal prefix the seeder writes and nothing else.
    const where = hasLeadRef.has(table)
      ? `id LIKE 'seed\_%' OR lead_id LIKE 'seed\_%'`
      : `id LIKE 'seed\_%'`;
    const rows: { id: string }[] = await prisma.$queryRawUnsafe(
      `SELECT id::text FROM "${table}" WHERE ${where}`,
    );
    if (rows.length === 0) continue;
    total += rows.length;
    console.log(`  ${table}: ${rows.length} seed row(s) — ${rows.map((r) => r.id).join(", ")}`);
    if (APPLY) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where}`);
    }
  }

  console.log(`\n${APPLY ? "DELETED" : "WOULD DELETE"} ${total} seed row(s).`);
  if (!APPLY && total > 0) console.log("Re-run with --apply to remove them.");
  process.exit(0);
}

main().catch((error) => {
  console.error("PURGE FAILED —", error instanceof Error ? error.message : error);
  process.exit(1);
});
