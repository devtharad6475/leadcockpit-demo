/**
 * reap-scratch-workspaces.ts — remove the test-scratch workspaces that
 * `golden-substrate-parity.ts` leaked into the ship database (N-DATA-2).
 *
 * BACKGROUND. The parity golden creates a throwaway `sp-<timestamp>-ws`
 * workspace per run. Its cleanup could not delete it — `WorkspaceRepository`
 * had no `delete` method — so on the Prisma substrate the shell survived every
 * run. Fixed 2026-08-18; the leak has stopped, but the shells already sitting
 * in the database are still there and this script is what removes them.
 *
 * SAFETY — this script deletes rows from the real database, so:
 *   - DRY RUN IS THE DEFAULT. It prints exactly what it would remove and exits
 *     without touching anything. Deleting requires `--confirm-delete`.
 *   - It refuses to touch anything that does not match the scratch shape:
 *     the id must match /^sp-\d+-(json|prisma)-ws$/, which is the literal
 *     pattern the golden constructs and which a human-created workspace cannot
 *     plausibly collide with.
 *   - It refuses to delete any workspace that still holds leads. The measured
 *     scratch shells hold zero; one that holds leads is not the thing this
 *     script was written for, and a surprise is a reason to stop, not a reason
 *     to guess. Use --force-nonempty only with eyes open.
 *   - The delete goes through `repos.workspace.delete`, the same code path the
 *     parity golden proves on both substrates — not a bespoke query written
 *     for this script and never tested.
 *
 * Run:  npx tsx scripts/reap-scratch-workspaces.ts                 (dry run)
 *       npx tsx scripts/reap-scratch-workspaces.ts --confirm-delete
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

/** The exact id shape golden-substrate-parity.ts builds. Nothing else. */
const SCRATCH_ID = /^sp-\d+-(json|prisma)-ws$/;

const CONFIRMED = process.argv.includes("--confirm-delete");
const FORCE_NONEMPTY = process.argv.includes("--force-nonempty");

async function main() {
  const { getPersistenceProvider, repositories } = await import("@/repositories");
  const { prisma } = await import("@/lib/prisma");

  console.log(`persistence provider: ${getPersistenceProvider()}`);
  console.log(CONFIRMED ? "mode: DELETE (--confirm-delete given)" : "mode: DRY RUN — nothing will be deleted");
  console.log("");

  const workspaces = await prisma.workspace.findMany({ select: { id: true, name: true, createdAt: true } });
  const scratch = workspaces.filter((item) => SCRATCH_ID.test(item.id));
  const kept = workspaces.filter((item) => !SCRATCH_ID.test(item.id));

  console.log(`workspaces in database: ${workspaces.length}`);
  console.log(`  NOT scratch (will never be touched): ${kept.length}`);
  for (const item of kept) console.log(`    KEEP  ${item.id}  "${item.name}"`);
  console.log(`  scratch shells matching ${SCRATCH_ID}: ${scratch.length}`);

  if (!scratch.length) {
    console.log("\nNothing to reap.");
    return;
  }

  // Count what is underneath each shell before deciding anything. Leads are
  // the row type that would make a shell more than clutter.
  const plan: { id: string; name: string; createdAt: string; leads: number }[] = [];
  for (const item of scratch) {
    const leads = await prisma.lead.count({ where: { workspaceId: item.id } });
    plan.push({ id: item.id, name: item.name, createdAt: item.createdAt.toISOString(), leads });
  }

  console.log("");
  for (const row of plan) {
    console.log(`    ${CONFIRMED ? "DELETE" : "WOULD DELETE"}  ${row.id}  "${row.name}"  created ${row.createdAt}  leads=${row.leads}`);
  }

  const nonEmpty = plan.filter((row) => row.leads > 0);
  if (nonEmpty.length && !FORCE_NONEMPTY) {
    console.log("");
    console.log(`REFUSING: ${nonEmpty.length} scratch workspace(s) still hold leads. Expected zero.`);
    console.log("Inspect them first. Re-run with --force-nonempty only if you are sure.");
    process.exit(1);
  }

  if (!CONFIRMED) {
    console.log("");
    console.log(`DRY RUN — ${plan.length} workspace(s) would be deleted. Nothing was changed.`);
    console.log("Re-run with --confirm-delete to actually remove them.");
    return;
  }

  let deleted = 0;
  for (const row of plan) {
    const result = await repositories.workspace.delete(row.id);
    if (result.deleted) deleted += 1;
    console.log(`    ${result.deleted ? "deleted" : "already gone"}  ${row.id}`);
  }

  const after = await prisma.workspace.count();
  console.log("");
  console.log(`deleted ${deleted} of ${plan.length}. workspaces remaining: ${after}`);
}

main().catch((error) => {
  console.error("REAPER FAILED:", error instanceof Error ? error.message : error);
  process.exit(2);
});
