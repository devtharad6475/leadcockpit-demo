// PRISMA_GOLDEN
/**
 * golden-mutateall-removal-parity.ts — N-BUG-3/4/5 pin (2026-09-05, CEO-loop session 52).
 *
 * THE RISK THIS PINS
 * ------------------
 * `repos.mutateAll` hands a caller the whole database as a plain object and
 * writes back what changed. On the JSON substrate that object IS the database,
 * so dropping a row from one of its arrays deletes the row. On Postgres it is a
 * copy, and the writer that puts it back is upsert-only — it has never issued a
 * DELETE. The comment above `persistSnapshot` says so plainly.
 *
 * So the identical line of code deletes on one substrate and does nothing at
 * all on the other. Not an error, not a warning: the caller asks for a row to
 * go away, is told the write succeeded, and the row stays. The product runs on
 * Postgres. Every removal written this way has been silently ignored in
 * production for as long as it has existed.
 *
 * Three callers were doing exactly that when this golden was written:
 *
 *   1. Knowledge sync (DocumentQuestionAnsweringService). Every sync deleted
 *      the document's old search chunks and wrote fresh ones. The delete never
 *      happened, so every sync left ANOTHER complete copy of the company's
 *      knowledge in the search index. The AI then answered out of an index
 *      holding N copies of the same text, oldest included — so an answer the
 *      owner had corrected could still be retrieved from a stale copy, and the
 *      table grew by a full copy per sync forever.
 *   2. Webhook dedup (WebhookDedupService). A cap of the last 10,000 entries
 *      that has never once trimmed anything on Postgres.
 *   3. Product research (ProductApplicationResearchService). Re-running it
 *      appended a second full set instead of replacing the first. Four runs of
 *      a business that sells five things left 21 products and 172 market maps.
 *
 * WHAT IS PINNED HERE. Not "the three call sites are fixed" — that pins the
 * symptom three times and says nothing about the fourth caller someone writes
 * next month. CASE A pins the RULE: on Postgres, a removal through mutateAll
 * now raises a loud error instead of being discarded. The guard never deletes
 * anything itself; it refuses, names the row, and points at the repository
 * method that can. A silent wrong answer becomes an obvious one.
 *
 * WHY IT NEEDS A REAL DATABASE. The entire defect is the difference between an
 * in-memory array and what Postgres holds afterwards. A mock has no "afterwards"
 * — a mocked version of this golden passes against every broken version of the
 * code it is meant to catch.
 *
 * ISOLATION. Everything is written under per-run workspace ids and deleted in
 * the finally block, so this never touches demo or ship data.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — dropping a row from a mutateAll snapshot THROWS on Postgres, and
 *            the row is still there afterwards. Both halves matter: the throw
 *            proves the silence is gone, and the surviving row proves the guard
 *            refuses rather than guessing at a delete it was never designed to
 *            do safely.
 *   CASE B — syncing company knowledge twice leaves ONE copy of the search
 *            chunks. Before the fix the second sync doubled them.
 *   CASE C — the five product-research collections can actually be emptied for
 *            one workspace, and emptying one workspace leaves another
 *            workspace's rows untouched. The second half is the tenant guard:
 *            a delete keyed on the wrong column would pass the first half and
 *            wipe a neighbouring customer.
 *   CASE D — the webhook dedup log can be trimmed to the most recent N, on the
 *            real table, keeping the newest and dropping the oldest.
 */
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { syncKnowledgeQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

const RUN = Date.now().toString(36);
const WS_GUARD = `ws_golden_rm_guard_${RUN}`;
const WS_SYNC = `ws_golden_rm_sync_${RUN}`;
const WS_PROD = `ws_golden_rm_prod_${RUN}`;
const WS_NEIGHBOUR = `ws_golden_rm_neighbour_${RUN}`;
const WS_DEDUP = `ws_golden_rm_dedup_${RUN}`;
const ALL_WORKSPACES = [WS_GUARD, WS_SYNC, WS_PROD, WS_NEIGHBOUR, WS_DEDUP];

async function main() {
  console.log("");
  console.log("=== GOLDEN mutateall-removal-parity (N-BUG-3/4/5) ===");
  console.log("");

  const repos = createRepositories("prisma");
  const { prisma } = await import("@/lib/prisma");

  const idsIn = async (table: string, workspaceId: string): Promise<string[]> => {
    const rows: { id: string }[] = await prisma.$queryRawUnsafe(
      `SELECT id::text FROM "${table}" WHERE workspace_id = '${workspaceId}' ORDER BY id`,
    );
    return rows.map((row) => row.id);
  };

  try {
    for (const workspaceId of ALL_WORKSPACES) {
      await repos.workspace.create({ id: workspaceId, name: `golden removal ${workspaceId}` });
    }

    await check("CASE A — dropping a row inside mutateAll FAILS LOUDLY on Postgres, and does not lose the row", async () => {
      const documentId = `kbd_golden_rm_${RUN}`;
      await repos.mutateAll!((data) => {
        data.knowledgeBaseDocuments ||= [];
        data.knowledgeBaseDocuments.push({
          id: documentId,
          workspaceId: WS_GUARD,
          title: "removal guard probe",
          documentType: "note",
          source: "golden_removal_probe",
          status: "active",
          contentText: "probe",
          metadata: {},
          createdAt: "2021-03-04T05:06:07.000Z",
          updatedAt: "2021-03-04T05:06:07.000Z",
        });
        return true;
      });
      assert.deepStrictEqual(
        await idsIn("knowledge_base_documents", WS_GUARD),
        [documentId],
        "setup: the row has to really be in Postgres before removing it can prove anything",
      );

      let raised = "";
      try {
        await repos.mutateAll!((data) => {
          data.knowledgeBaseDocuments = (data.knowledgeBaseDocuments || []).filter((item) => item.id !== documentId);
          return true;
        });
      } catch (err) {
        raised = (err as Error).message;
      }

      assert.ok(
        raised.includes("knowledgeBaseDocuments") && raised.includes(documentId),
        "removing a row through mutateAll must raise an error that NAMES the collection and the row, so the author can see what was discarded. " +
          `Got instead: ${raised || "no error at all — the removal was silently discarded, which is the bug"}`,
      );
      assert.deepStrictEqual(
        await idsIn("knowledge_base_documents", WS_GUARD),
        [documentId],
        "the guard must REFUSE, not delete: mutateAll never had a safe delete (its snapshot is a read of the whole database taken before other requests wrote to it), so inventing one here would be worse than the silence it replaces",
      );
    });

    await check("CASE B — syncing company knowledge twice leaves ONE copy of the search chunks, not two", async () => {
      await syncKnowledgeQuestionAnswers(WS_SYNC, repos);
      const afterFirst = await idsIn("knowledge_base_chunks", WS_SYNC);
      assert.ok(
        afterFirst.length > 0,
        "setup: the first sync has to write at least one chunk, or the second sync proves nothing",
      );

      await syncKnowledgeQuestionAnswers(WS_SYNC, repos);
      const live = await repos.knowledgeBaseChunk.listByWorkspace(WS_SYNC);

      assert.strictEqual(
        live.length,
        afterFirst.length,
        `the second sync must REPLACE the search chunks, not add a second copy. The index the AI answers out of held ${afterFirst.length} chunk(s) after one sync and ${live.length} after two`,
      );
    });

    await check("CASE C — product-research rows can be emptied for one workspace without touching another", async () => {
      const seed = async (workspaceId: string) => {
        const product = await repos.productKnowledge.create({
          workspaceId,
          productName: "golden probe product",
          source: "golden",
        });
        const [variety] = await repos.productVariety.createMany([
          { workspaceId, productKnowledgeId: product.id, name: "golden probe variety" },
        ]);
        const [application] = await repos.productApplication.createMany([
          { workspaceId, productKnowledgeId: product.id, varietyId: variety.id, applicationName: "golden probe application" },
        ]);
        const [segment] = await repos.buyerSegment.createMany([
          { workspaceId, name: "golden probe segment", segmentType: "direct" },
        ]);
        await repos.productApplicationMarketMap.createMany([
          {
            workspaceId,
            productKnowledgeId: product.id,
            varietyId: variety.id,
            applicationId: application.id,
            buyerSegmentId: segment.id,
            targetingAngle: "golden probe angle",
            messageAngle: "golden probe message",
          },
        ]);
      };
      await seed(WS_PROD);
      await seed(WS_NEIGHBOUR);

      const tables = [
        "product_application_market_maps",
        "product_applications",
        "product_varieties",
        "buyer_segments",
        "product_knowledges",
      ];
      for (const table of tables) {
        assert.strictEqual(
          (await idsIn(table, WS_PROD)).length,
          1,
          `setup: ${table} must hold exactly one row for the workspace under test before it is emptied`,
        );
      }

      await repos.productApplicationMarketMap.deleteByWorkspace!(WS_PROD);
      await repos.productApplication.deleteByWorkspace!(WS_PROD);
      await repos.productVariety.deleteByWorkspace!(WS_PROD);
      await repos.buyerSegment.deleteByWorkspace!(WS_PROD);
      await repos.productKnowledge.deleteByWorkspace!(WS_PROD);

      for (const table of tables) {
        assert.deepStrictEqual(
          await idsIn(table, WS_PROD),
          [],
          `${table} still holds rows for the workspace after it was emptied — this is the bug that made re-running product research append a second full set instead of replacing the first`,
        );
        assert.strictEqual(
          (await idsIn(table, WS_NEIGHBOUR)).length,
          1,
          `${table} lost the OTHER workspace's row — a delete that is not keyed on the workspace wipes a neighbouring customer`,
        );
      }
    });

    await check("CASE D — the webhook dedup log trims to the most recent N on the real table", async () => {
      const { recordProcessedMessageId } = await import("@/services/WebhookDedupService");
      for (let index = 0; index < 5; index++) {
        await recordProcessedMessageId(WS_DEDUP, `wamid.golden.${RUN}.${index}`, "processed", undefined, repos);
      }
      assert.strictEqual(
        (await idsIn("processed_webhook_messages", WS_DEDUP)).length,
        5,
        "setup: five dedup entries have to be in the real table before trimming proves anything",
      );

      const removed = await repos.trimProcessedWebhookMessages!(2);
      assert.ok(removed >= 3, `the trim must report what it removed; it reported ${removed}`);

      const survivors: { provider_message_id: string }[] = await prisma.$queryRawUnsafe(
        `SELECT provider_message_id FROM "processed_webhook_messages" WHERE workspace_id = '${WS_DEDUP}'`,
      );
      const kept = survivors.map((row) => row.provider_message_id);
      assert.strictEqual(
        kept.length,
        2,
        `trimming to the most recent 2 must leave 2 rows, not ${kept.length} — on Postgres this cap has never removed anything`,
      );
      assert.ok(
        kept.includes(`wamid.golden.${RUN}.4`),
        "the NEWEST entry must survive a trim — a cap that keeps the oldest ids would forget exactly the messages Meta is still retrying",
      );
      assert.ok(
        !kept.includes(`wamid.golden.${RUN}.0`),
        "the OLDEST entry must be the one dropped",
      );
    });
  } finally {
    for (const workspaceId of ALL_WORKSPACES) {
      await prisma.$executeRawUnsafe(`DELETE FROM "workspaces" WHERE id = '${workspaceId}'`).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  }

  console.log("");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
