/**
 * PROBE — P0-PERF-1: what one page view of the onboarding screen costs.
 *
 * `GET /api/unknown-questions` and `GET /api/unknown-questions/groups` both call
 * syncMissingKnowledgeQuestions, which goes through repos.mutateAll. Before the
 * 2026-08-24 fix that meant: read every row of 15 collections across every
 * tenant, then re-upsert ALL of them inside one 45-second transaction. Measured
 * at 17 workspaces it was 9,444 upserts per page view, and the transaction had
 * already started expiring:
 *
 *   Transaction API error: A commit cannot be executed on an expired
 *   transaction. The timeout for this transaction was 45000 ms, however
 *   90804 ms passed since the start of the transaction.
 *
 * This probe calls the same function directly against the real database.
 *
 * HOW IT KNOWS WHETHER ANYTHING WAS WRITTEN. Not by trusting the code — by
 * asking the database. `updated_at` on both big tables is `@updatedAt`, so
 * Prisma stamps it on every update, including a pointless one that writes the
 * same values back. Counting rows whose `updated_at` moved during the call is
 * therefore substrate truth: if the snapshot is still being rewritten, thousands
 * of rows will have a fresh timestamp even though nothing about them changed.
 *
 * It asserts three things:
 *
 *   1. the call still returns the tenant's questions — a fast wrong answer is
 *      not a fix, and this check comes FIRST because "zero writes" is trivially
 *      true of a function that has stopped working
 *   2. a read that changes nothing writes nothing
 *   3. it finishes far inside the 45s transaction budget
 *
 * Usage:  npm run probe:snapshot-cost
 */
import { prisma } from "../../src/lib/prisma";
import { createPrismaRepositories } from "../../src/repositories/prisma";
import { syncMissingKnowledgeQuestions } from "../../src/services/DocumentQuestionAnsweringService";

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

/** Rows whose auto-managed updated_at moved since `since`. */
async function touchedSince(since: Date) {
  const [questions, answers] = await Promise.all([
    prisma.unknownQuestion.count({ where: { updatedAt: { gte: since } } }),
    prisma.knowledgeQuestionAnswer.count({ where: { updatedAt: { gte: since } } }),
  ]);
  return { questions, answers, total: questions + answers };
}

async function main() {
  console.log("\nP0-PERF-1 write-cost probe\n");

  const workspaces = await prisma.workspace.count();
  const questionCount = await prisma.unknownQuestion.count();
  const answerCount = await prisma.knowledgeQuestionAnswer.count();
  console.log(`  database holds ${workspaces} workspaces, ${questionCount} unknown questions, ${answerCount} answer stubs`);
  console.log(`  a full-snapshot write would touch ${questionCount + answerCount} rows in these two tables alone`);

  const newest = await prisma.workspace.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!newest) {
    console.error("\nCANNOT RUN: no workspace in the database to read.\n");
    process.exit(2);
  }
  console.log(`  reading as workspace ${newest.id}\n`);

  const repos = createPrismaRepositories();

  // First call may legitimately write: it seeds this tenant's framework stubs
  // if they are missing. The SECOND call is the one that must be free, because
  // that is what every subsequent page view is.
  await syncMissingKnowledgeQuestions(newest.id, repos);

  // Postgres and this process can disagree by a fraction of a second; back the
  // mark off slightly so a genuine write cannot slip in under the boundary.
  const mark = new Date(Date.now() - 1000);
  const started = Date.now();
  const items = await syncMissingKnowledgeQuestions(newest.id, repos);
  const elapsed = Date.now() - started;
  const touched = await touchedSince(mark);

  console.log(`  one page view: ${elapsed} ms; rows re-stamped: ${touched.total} (${touched.questions} questions, ${touched.answers} answers)\n`);

  check(
    items.length > 0,
    `the call still returns this tenant's questions (${items.length})`,
    items.length ? "" : "zero questions returned; a fast empty answer is not a fix",
  );
  check(
    touched.total === 0,
    `a read that changes nothing writes nothing (${touched.total} rows re-stamped)`,
    touched.total ? "the snapshot is still being written back on a pure read" : "",
  );
  check(
    elapsed < 45_000,
    `finished inside the 45s transaction budget (${(elapsed / 1000).toFixed(1)}s)`,
    elapsed >= 45_000 ? "still over budget — the transaction will expire under load" : "",
  );
  check(
    elapsed < 5_000,
    `fast enough to sit on a page load (${(elapsed / 1000).toFixed(1)}s, target under 5s)`,
  );

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL GREEN\n" : `\n${failures} CHECK(S) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nPROBE COULD NOT COMPLETE:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
