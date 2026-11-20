/**
 * golden-snapshot-reads-less.ts — N16: editing one answer must not read the
 * whole database (2026-09-18, session 57).
 *
 * ── WHAT THIS COST ──────────────────────────────────────────────────────────
 * `readAll()` on Postgres ran `findMany({})` — no filter of any kind — against
 * about SIXTY tables, and `mutateAll()` did that and wrote fifteen collections
 * back. There are 42 `mutateAll` call sites. Editing one knowledge answer read
 * the entire database and rewrote a third of it.
 *
 * On 2026-09-18 that consumed the hosting plan's entire monthly data allowance.
 * Every connection was refused — including `SELECT 1` — and production was down
 * until the database was moved. It was always going to happen; the date was the
 * only variable, because two of those tables are append-only and grow forever.
 *
 *   CASE A — an answer edit names the collections it touches, and that list
 *            does not include the append-only logs.
 *   CASE B — the rebuild names its own, narrower list.
 *   CASE C — a caller that names nothing still gets everything, so the 40 call
 *            sites that have not opted in yet are unchanged.
 *   CASE D — the safety property the whole design rests on: a collection that
 *            was never loaded is never deleted.
 *
 * Run: npx tsx scripts/golden/golden-snapshot-reads-less.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { updateKnowledgeQuestionAnswer, syncKnowledgeQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";
import type { RepositoryBundle, SnapshotOptions } from "@/repositories/interfaces";
import { shouldLoadCollection } from "@/repositories/prisma";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n16_${Date.now()}_${seq++}`;

/**
 * Records what each `mutateAll` asked for.
 *
 * The narrowing itself is a Postgres behaviour and this suite runs on the JSON
 * substrate, where a snapshot is one file and the option is ignored. What CAN
 * regress here, and what actually matters, is the call site forgetting to
 * declare — so that is what is asserted.
 */
function watchCollections(base: RepositoryBundle) {
  const asked: Array<ReadonlyArray<string> | undefined> = [];
  const proxied = new Proxy(base as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "mutateAll") {
        const original = Reflect.get(target, prop, target) as RepositoryBundle["mutateAll"];
        return (mutator: (data: AppData) => unknown, options?: SnapshotOptions) => {
          asked.push(options?.collections as ReadonlyArray<string> | undefined);
          return original!(mutator as never, options);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;
  return { repos: proxied, asked };
}

async function plantAnswer(workspaceId: string) {
  const id = `kqa_${workspaceId}`;
  await repos.mutateAll!((data: AppData) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push({
      id,
      workspaceId,
      domainKey: "pricing_policy",
      questionKey: "neem_zari_price",
      question: "What is the price of Neem Zari Thread R?",
      answer: "Rs 335 per kg.",
      answerStatus: "answered",
      sourceType: "document_extraction",
      confidenceScore: 0.9,
      humanReviewRequired: false,
      isUserApproved: true,
      isCanonical: true,
      conflictWithExisting: false,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    } as unknown as KnowledgeQuestionAnswer);
    return id;
  });
  return id;
}

test("CASE A — an answer edit declares what it touches, and leaves the logs alone", async () => {
  const workspaceId = freshWorkspace();
  const answerId = await plantAnswer(workspaceId);

  const watched = watchCollections(repos);
  await updateKnowledgeQuestionAnswer(workspaceId, answerId, { answer: "Rs 395 per kg." }, watched.repos);

  const declared = watched.asked[0];
  assert.ok(declared, "the edit must NAME its collections — undefined means 'read all sixty tables', which is the defect");
  assert.ok(declared!.includes("knowledgeQuestionAnswers"), "it reads and writes the answer itself");
  assert.ok(
    !declared!.includes("auditLogs"),
    "and it must NOT load the audit log. It only ever APPENDS there, and the writer upserts, so a row " +
      "pushed onto an unloaded collection is saved while the rest are left alone. Loading an append-only " +
      "table that grows forever, in order to add one line to the end of it, is the shape of the bug.",
  );
  assert.ok(!declared!.includes("eventLogs"), "same for the event log");
  assert.ok(
    declared!.length < 10,
    `a handful, not sixty. Got ${declared!.length}: ${declared!.join(", ")}`,
  );
});

test("CASE B — the rebuild declares its own list", async () => {
  const workspaceId = freshWorkspace();
  await plantAnswer(workspaceId);

  const watched = watchCollections(repos);
  await syncKnowledgeQuestionAnswers(workspaceId, watched.repos);

  const declared = watched.asked[0];
  assert.ok(declared, "the rebuild must name its collections too — it runs on every approval");
  assert.ok(declared!.includes("knowledgeQuestionAnswers"), "it reads every servable answer");
  assert.ok(declared!.includes("knowledgeBaseDocuments"), "and writes the one searchable document");
});

test("CASE E — the load decision itself: naming nothing means EVERYTHING", async () => {
  // The single most dangerous line in this change. Inverted, every one of the
  // forty call sites that has not opted in starts reading an empty database —
  // and the writer never deletes, so nothing would break loudly. It would
  // surface later as duplicates, created because a lookup found nothing.
  assert.strictEqual(shouldLoadCollection("auditLogs", undefined), true, "no options at all means load it");
  assert.strictEqual(shouldLoadCollection("auditLogs", {}), true, "an empty options object means load it");
  assert.strictEqual(
    shouldLoadCollection("auditLogs", { collections: ["knowledgeQuestionAnswers"] }),
    false,
    "and a caller that named its collections gets only those",
  );
  assert.strictEqual(shouldLoadCollection("knowledgeQuestionAnswers", { collections: ["knowledgeQuestionAnswers"] }), true);
});

test("CASE C — a caller that declares nothing still gets everything", async () => {
  // Forty call sites have not opted in. The default has to stay exactly as it
  // was, or this change breaks them all at once instead of improving them one
  // at a time.
  const workspaceId = freshWorkspace();
  await plantAnswer(workspaceId);

  const everything = await repos.readAll!();
  assert.ok(everything.knowledgeQuestionAnswers?.length, "the answers are there");
  assert.ok(Object.keys(everything).length > 20, `a full snapshot still has every collection, got ${Object.keys(everything).length}`);
});

test("CASE D — a collection that was never loaded is never deleted", async () => {
  // THE PROPERTY THE WHOLE DESIGN RESTS ON. If an unloaded collection could be
  // written as empty, narrowing a read would silently destroy data — the worst
  // possible outcome from a change made to save money.
  const workspaceId = freshWorkspace();
  const answerId = await plantAnswer(workspaceId);

  // A document that nothing in the edit path names.
  const doc = await repos.knowledgeBaseDocument.create(workspaceId, {
    title: "Untouched by the edit",
    documentType: "question_answers",
    source: "knowledge_question_answers",
    status: "active",
    contentText: "SURVIVOR-MARKER this row must still be here afterwards",
    metadata: {},
  });

  await updateKnowledgeQuestionAnswer(workspaceId, answerId, { answer: "Rs 500 per kg." }, repos);

  const after = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
  assert.ok(
    after.some((item) => item.id === doc.id),
    "the row survives. A narrowed read that wrote empty collections back would have removed it, and the " +
      "money saved would have cost the company its knowledge base.",
  );
});

(async () => {
  console.log("\n=== GOLDEN: a snapshot reads only what it needs (N16) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: snapshot-reads-less");
    process.exit(1);
  }
})();
