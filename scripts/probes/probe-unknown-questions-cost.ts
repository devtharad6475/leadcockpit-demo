/**
 * probe-unknown-questions-cost.ts — audit A-4 measurement (2026-08-25).
 *
 * WHAT A-4 SAYS AND WHAT IS ACTUALLY LEFT OF IT
 * ---------------------------------------------
 * A-4 says nine GET routes reach a `sync*` function that writes. The write half
 * of that was already fixed in P0-PERF-1 (`src/repositories/prisma/index.ts`):
 * a read that changes nothing now writes nothing. What A-4 still owns is the
 * measured 2.53 s of `GET /api/unknown-questions/groups`, times the 19 calls
 * the shell fires on load — the 37 seconds left in the first-screen wait after
 * A-13 took the card save from 96 s to 1.07 s.
 *
 * This probe does not guess where those 2.53 s go. It splits them:
 *
 *   T_total    one call to syncMissingKnowledgeQuestions(), the thing the GET does
 *   T_readAll  one call to repos.readAll(), the whole-database snapshot that
 *              mutateAll loads before the mutator ever runs
 *   T_rest     T_total - T_readAll — fingerprint, the in-memory framework work,
 *              and the diff-persist
 *
 * And it measures the SHAPE of the problem, which matters more than the number:
 * how many rows the snapshot carries for every tenant versus how many rows this
 * job actually needs, which is two workspace-scoped collections. If the whole
 * database dominates, then the fix is not a faster loop — it is not reading the
 * whole database on a page view, and the cost stops growing with every customer
 * sold.
 *
 * SAFETY. Read-only in intent: it calls the same functions the GET calls and
 * creates nothing of its own. `syncMissingKnowledgeQuestions` may legitimately
 * write if the workspace is genuinely missing stubs — that is the product's own
 * behaviour on any page view, not something this probe adds. The second and
 * third calls are therefore expected to be cheaper than the first, and the probe
 * reports the steady-state number separately rather than averaging them.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") {
    console.error("A-4 is about the substrate we ship on. Run with PERSISTENCE_PROVIDER=prisma.");
    process.exit(1);
  }

  const { prisma } = await import("@/lib/prisma");
  const { repositories: repos } = await import("@/repositories");
  const { syncMissingKnowledgeQuestions } = await import("@/services/DocumentQuestionAnsweringService");

  const workspace = await prisma.workspace.findFirst({ select: { id: true, name: true } });
  if (!workspace) {
    console.log("SKIP: no workspace in this database.");
    process.exit(0);
  }
  console.log(`workspace under test = ${workspace.id}`);

  // ── The shape of the problem ────────────────────────────────────────────
  const workspaces = await prisma.workspace.count();
  const answersAll = await prisma.knowledgeQuestionAnswer.count();
  const answersMine = await prisma.knowledgeQuestionAnswer.count({ where: { workspaceId: workspace.id } });
  const unknownAll = await prisma.unknownQuestion.count();
  const unknownMine = await prisma.unknownQuestion.count({ where: { workspaceId: workspace.id } });

  console.log("");
  console.log("SHAPE — what the job needs versus what it loads");
  console.log(`  tenants in this database                 : ${workspaces}`);
  console.log(`  knowledgeQuestionAnswers  all tenants    : ${answersAll}`);
  console.log(`  knowledgeQuestionAnswers  this workspace : ${answersMine}`);
  console.log(`  unknownQuestions          all tenants    : ${unknownAll}`);
  console.log(`  unknownQuestions          this workspace : ${unknownMine}`);

  // ── T_readAll ───────────────────────────────────────────────────────────
  const readStart = Date.now();
  const snapshot = (await repos.readAll!()) as unknown as Record<string, unknown[]>;
  const readAllMs = Date.now() - readStart;
  const snapshotRows = Object.values(snapshot).reduce<number>(
    (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
    0,
  );
  const snapshotCollections = Object.keys(snapshot).length;

  // ── T_total, three times: first call, then steady state ─────────────────
  const totals: number[] = [];
  let returned = 0;
  for (let i = 0; i < 3; i += 1) {
    const start = Date.now();
    const items = await syncMissingKnowledgeQuestions(workspace.id, repos);
    totals.push(Date.now() - start);
    returned = Array.isArray(items) ? items.length : 0;
  }
  const steady = Math.min(totals[1], totals[2]);

  console.log("");
  console.log("COST — one GET /api/unknown-questions/groups, on real Postgres");
  console.log(`  T_readAll   whole-database snapshot      : ${readAllMs} ms  (${snapshotRows} rows across ${snapshotCollections} collections)`);
  console.log(`  T_total     call 1 / call 2 / call 3     : ${totals[0]} / ${totals[1]} / ${totals[2]} ms  (${returned} questions returned)`);
  console.log(`  T_rest      steady state minus the read  : ${steady - readAllMs} ms  (fingerprint + framework work + diff-persist)`);

  const rowsNeeded = answersMine + unknownMine;
  const waste = snapshotRows > 0 ? Math.round((1 - rowsNeeded / snapshotRows) * 100) : 0;

  console.log("");
  console.log("VERDICT");
  console.log(`  the job needs ${rowsNeeded} rows and loads ${snapshotRows}: ${waste}% of the snapshot is other tenants' data or collections this job never looks at.`);
  console.log(`  one page view fires this 19 times -> about ${((steady * 19) / 1000).toFixed(1)} s of the first-screen wait.`);
  console.log(
    readAllMs > (steady - readAllMs)
      ? "  the whole-database READ dominates. The fix is to stop loading the whole database on a page view, not to make the in-memory work faster."
      : "  the read is NOT the dominant half — the in-memory framework work is. Look at canonicalQuestionAnswers (424 x every tenant's rows) before touching the read path.",
  );
  console.log(`  cost grows with every customer signed up: the snapshot carries ${workspaces} tenants to answer a question about 1.`);

  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

main().catch((error) => {
  console.error("PROBE CRASHED:", error);
  process.exit(1);
});
