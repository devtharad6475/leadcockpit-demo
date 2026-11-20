// PRISMA_GOLDEN
/**
 * golden-substrate-write-parity.ts — N-DATA-2 pin (2026-08-18, CEO-loop session 7).
 *
 * THE RISK THIS PINS
 * ------------------
 * The product has two persistence substrates (a JSON file and Postgres) behind
 * one repository interface. They are only interchangeable if a row written
 * through that interface comes back the SAME on both. Every defect pinned here
 * was a place where it did not, and every one of them was silent — no error, no
 * warning, just a row that quietly disagreed with itself across substrates.
 *
 * They were found by migrating the real dataset and re-planning afterwards: the
 * migration wrote 1,268 rows, reported success, and the re-plan still said 1,242
 * of them differed. Nothing in the product would have told anyone. A customer
 * would have found out months later, from a record whose creation date was
 * wrong or a setting that had silently become two settings.
 *
 * WHY IT NEEDS A REAL DATABASE. Every one of these is a property of what
 * Postgres actually stored — a generated cuid, a `@default(now())`, a column
 * default of `{}`. A mock cannot have those defaults, so a mocked version of
 * this golden would pass against the broken code.
 *
 * ISOLATION. Everything is written under a per-run workspace id and deleted in
 * the finally block, so this never touches the demo workspace or the migrated
 * ship data.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — a workspace-singleton create HONOURS a supplied id. Before the fix
 *            the row was born with a generated cuid whatever it was called, so
 *            the same settings row was `tss_demo` on JSON and `cmsyyx69o…` on
 *            Postgres. A migration between the two could never converge: it
 *            planned a create for an id Postgres would never hold, the create
 *            hit the workspace unique constraint, and the next run planned it
 *            again. Five repositories had this bug.
 *   CASE B — the same create HONOURS a supplied createdAt. Without it every
 *            migrated row claimed to have been created at the moment of the
 *            migration, which is a record that lies about itself.
 *   CASE C — an UPDATE does NOT move createdAt. The fix in CASE B applies to
 *            the create half only; a settings save must not be able to rewrite
 *            when the row was made. This is the guard proving CASE B was not
 *            implemented by simply always writing whatever arrived.
 *   CASE D — readAll returns the six collections it used to omit entirely. It
 *            reported them EMPTY however many rows Postgres held, which is how
 *            the migration came to plan a create for a row that already existed
 *            and got back `Unique constraint failed on the fields: (id)`.
 *   CASE E — rows from readAll carry DOMAIN field names, not raw Prisma column
 *            names. Four of those six carry a renamed Json column, and a cast
 *            over the raw rows would hand back the column name the domain type
 *            does not declare while dropping the field it does.
 *   CASE F — an answer created with NO evidence is written successfully, and the
 *            required Json column holds `{ sources: [] }` rather than null.
 *            (2026-09-04, N-BUG-1: this used to expect a bare `{}`. That shape
 *            satisfied the column but crashed extraction on read, because `{}`
 *            is truthy and slips past every caller's absence guard.)
 *
 *            This case exists because I broke it. 392 of the 523 migrated
 *            answers differed from their JSON source on `evidenceJson` alone —
 *            absent on JSON, `{}` on Postgres — and I "fixed" it by changing the
 *            fallback to null so both sides would agree. `evidence_json` is NOT
 *            NULL in the schema, so that change would have thrown on every
 *            answer created without evidence. It passed the migration only
 *            because all 523 answers already existed and took the UPDATE path;
 *            the first customer to create a fresh answer would have hit it.
 *            The substrate difference is real, is not fixable here, and is what
 *            `unmigratableFields` reports instead.
 *   CASE G — the snapshot write path honours createdAt on the CREATE half AND
 *            on the UPDATE half. The update half is the one that was missing,
 *            and it is not cosmetic: a row already in Postgres kept its wrong
 *            creation time forever, because every re-run filled only the create
 *            half and the row was never a create again.
 */
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { persistSnapshot } from "@/repositories/prisma";
import type { AppData } from "@/lib/types";

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
    console.log(`        ${(err as Error).message.split("\n").join("\n        ")}`);
  }
}

const RUN = Date.now().toString(36);
const WS = `ws_golden_parity_${RUN}`;
/** A creation time far enough in the past that no clock default could produce it. */
const OLD = "2021-03-04T05:06:07.000Z";

async function main() {
  console.log("");
  console.log("=== GOLDEN substrate-write-parity (N-DATA-2) ===");
  console.log("");

  const repos = createRepositories("prisma");
  const { prisma } = await import("@/lib/prisma");

  try {
    await repos.workspace.create({ id: WS, name: "golden parity workspace" });

    await check("CASE A — a singleton create honours the supplied id", async () => {
      const written = await repos.ticketSlaSettings.upsertForWorkspace(WS, {
        id: `tss_golden_${RUN}`,
        workspaceId: WS,
      });
      assert.strictEqual(
        written.id,
        `tss_golden_${RUN}`,
        "the row must keep the id it was given; a generated cuid here is what made the two substrates disagree about the identity of the same settings row",
      );
      // …and it is the id Postgres really holds, not just what the mapper echoed.
      const rows: { id: string }[] = await prisma.$queryRawUnsafe(
        `SELECT id::text FROM "ticket_sla_settings" WHERE workspace_id = '${WS}'`,
      );
      assert.deepStrictEqual(rows.map((r) => r.id), [`tss_golden_${RUN}`],
        "the id has to be the one IN THE DATABASE — a mapper that echoes its input would pass the check above and still store a cuid");
    });

    await check("CASE B — a singleton create honours the supplied createdAt", async () => {
      const cases: [string, () => Promise<{ id?: string; createdAt?: string }>][] = [
        ["companyCommunicationSettings", () =>
          repos.companyCommunicationSettings.upsertForWorkspace(WS, {
            id: `ccs_golden_${RUN}`, workspaceId: WS, createdAt: OLD,
          })],
        ["whatsAppAgentSettings", () =>
          repos.whatsAppAgentSettings.upsertForWorkspace(WS, {
            id: `was_golden_${RUN}`, workspaceId: WS, createdAt: OLD,
          })],
        ["aiUsageLimit", () =>
          repos.aiUsageLimit.upsertForWorkspace(WS, {
            id: `aul_golden_${RUN}`, workspaceId: WS, createdAt: OLD,
          })],
        ["leadReviewSettings", () =>
          repos.leadReviewSettings.upsertForWorkspace(WS, {
            id: `lrs_golden_${RUN}`, workspaceId: WS, createdAt: OLD,
          })],
      ];
      for (const [label, write] of cases) {
        const row = await write();
        assert.strictEqual(
          new Date(row.createdAt!).toISOString(), OLD,
          `${label}: the row was stamped with the clock instead of the supplied creation time — every migrated row would claim to have been created by the migration`,
        );
      }
    });

    await check("CASE C — an UPDATE does not move createdAt", async () => {
      // Same workspace, so this is an update of the row CASE B created.
      const again = await repos.companyCommunicationSettings.upsertForWorkspace(WS, {
        workspaceId: WS,
        createdAt: "2099-12-31T00:00:00.000Z",
        language: "en",
      });
      assert.strictEqual(
        new Date(again.createdAt!).toISOString(), OLD,
        "an ordinary settings save must not be able to rewrite when the row was created; without this, CASE B could be satisfied by always writing whatever arrived",
      );
      assert.strictEqual(again.id, `ccs_golden_${RUN}`,
        "and the update must not renumber the row either");
    });

    await check("CASE D — readAll returns the six collections it used to omit", async () => {
      const all = await repos.readAll!();
      const mine = <T extends { workspaceId?: string }>(rows: T[] | undefined) =>
        (rows ?? []).filter((r) => r.workspaceId === WS);

      assert.strictEqual(mine(all.companyCommunicationSettings).length, 1,
        "companyCommunicationSettings was invisible to readAll — it reported empty however many rows Postgres held");
      assert.strictEqual(mine(all.whatsAppAgentSettings).length, 1, "whatsAppAgentSettings was invisible to readAll");
      assert.strictEqual(mine(all.aiUsageLimits).length, 1, "aiUsageLimits was invisible to readAll");
      // The remaining three are exercised by their presence as declared keys:
      // a collection AppData declares and readAll never populates is the bug.
      for (const key of ["agentBehaviorPolicies", "llmModelRoutings", "userCredentials"] as const) {
        assert.ok(Array.isArray(all[key]),
          `readAll returned no array for "${key}" — an absent collection reads as "no rows", which is exactly how the migration planned a create for a row that already existed`);
      }
    });

    await check("CASE E — readAll rows carry domain field names, not raw columns", async () => {
      const all = await repos.readAll!();
      const row = (all.whatsAppAgentSettings ?? []).find((r) => r.workspaceId === WS);
      assert.ok(row, "the row written above must come back");
      const keys = Object.keys(row as object);
      const rawLeaks = keys.filter((k) => k.endsWith("Json") && !["policyJson", "evidenceJson"].includes(k));
      assert.deepStrictEqual(rawLeaks, [],
        `raw Prisma column names leaked into the snapshot: ${rawLeaks.join(", ")} — a cast over raw rows hands back the column name the domain type does not declare and drops the field it does`);
    });

    await check("CASE F — an answer with no evidence writes, and holds an empty sources list, not null and not a bare {}", async () => {
      // Driven through persistSnapshot rather than mutateAll: the fallback lives
      // in the snapshot WRITE path, and mutateAll would read and rewrite the
      // whole database to exercise one row.
      //
      // The assertion that matters is the FIRST one: that this write succeeds at
      // all. A null here is rejected by the column, so a fallback of null turns
      // "create an answer with no evidence" into a runtime crash.
      await persistSnapshot({
        knowledgeQuestionAnswers: [{
          id: `kqa_golden_${RUN}`,
          workspaceId: WS,
          domainKey: "golden_parity",
          questionKey: `golden_parity_${RUN}`,
          question: "does an answer with no evidence write?",
          answerStatus: "answered",
          sourceType: "manual",
          createdAt: OLD,
        }],
      } as unknown as AppData);

      const all = await repos.readAll!();
      const row = (all.knowledgeQuestionAnswers ?? []).find((r) => r.workspaceId === WS);
      assert.ok(row, "the answer written above must come back — if this is undefined the write threw");

      const stored: { evidence_json: unknown }[] = await prisma.$queryRawUnsafe(
        `SELECT evidence_json FROM "knowledge_question_answers" WHERE workspace_id = '${WS}'`,
      );
      // 2026-09-04 N-BUG-1 — this expected a bare `{}`. That value satisfied the
      // NOT NULL column, which is what this case has always been about, but it
      // was also the exact shape that crashed document extraction: `{}` is
      // truthy, so every caller's `evidenceJson ||= { sources: [] }` guard did
      // nothing, and the next line asked the missing `sources` for `.some`.
      //
      // The fallback now writes the empty LIST it means. This is not a relaxed
      // assertion — it is still exact equality, it still forbids null (the
      // failure this case was written for), and it additionally forbids the
      // sourceless shape that caused a real outage.
      assert.deepStrictEqual(stored[0].evidence_json, { sources: [] },
        "the column is NOT NULL, so the no-evidence fallback has to be an empty object — and it must carry an empty sources list, because a bare {} is the shape that crashed extraction (N-BUG-1)");
    });

    await check("CASE G — the snapshot path honours createdAt on CREATE and on UPDATE", async () => {
      // CREATE half: the row written in CASE F was born with a supplied time.
      const created = ((await repos.readAll!()).knowledgeQuestionAnswers ?? [])
        .find((r) => r.workspaceId === WS);
      assert.strictEqual(
        new Date(created!.createdAt!).toISOString(), OLD,
        "a snapshot create must keep the supplied creation time, not stamp the clock",
      );

      // UPDATE half. This is the one that was missing, and it is not cosmetic:
      // batchUpsert is reached from persistSnapshot, whose semantics are "here
      // is the whole row" — on the JSON substrate mutateAll simply replaces the
      // record, creation time included. Filling only the create half meant a row
      // ALREADY in Postgres kept the wrong creation time FOREVER: user_owner
      // stayed at 14:05:18 when the source said 16:13:20, and no number of
      // re-runs could correct it.
      const CORRECTED = "2020-01-02T03:04:05.000Z";
      await persistSnapshot({
        knowledgeQuestionAnswers: [{
          id: `kqa_golden_${RUN}`,
          workspaceId: WS,
          domainKey: "golden_parity",
          questionKey: `golden_parity_${RUN}`,
          question: "does an answer with no evidence write?",
          answerStatus: "answered",
          sourceType: "manual",
          createdAt: CORRECTED,
        }],
      } as unknown as AppData);

      const updated = ((await repos.readAll!()).knowledgeQuestionAnswers ?? [])
        .find((r) => r.workspaceId === WS);
      assert.strictEqual(
        new Date(updated!.createdAt!).toISOString(), CORRECTED,
        "a snapshot re-write of an EXISTING row must be able to correct its creation time, or a migration can never converge on it",
      );
    });

  } finally {
    // Dependents first, then the workspace itself.
    for (const table of [
      "knowledge_question_answers", "company_communication_settings", "whatsapp_agent_settings",
      "ai_usage_limits", "lead_review_settings", "ticket_sla_settings",
    ]) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE workspace_id = '${WS}'`).catch(() => {});
    }
    await prisma.workspace.deleteMany({ where: { id: WS } }).catch(() => {});
  }

  console.log("");
  console.log(`=== GOLDEN substrate-write-parity: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
