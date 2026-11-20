/**
 * GOLDEN — one unit of work reads the database once and writes it once.
 *
 * THE DEFECT (N-PERF-3 / audit A-13, measured 2026-08-25 on real Postgres).
 * Answering ONE setup card took 25 seconds over the API and 96 seconds in a
 * real browser. This is the first screen a paying customer meets.
 *
 * Nothing in the save was slow by itself. It was slow because it read the whole
 * database fifteen times to save seven answers — two full snapshot cycles per
 * question (answerKnowledgeQuestionFromUnknown, then upsertKnowledgeEntry) plus
 * a final one in persistGroupedFrameworkAnswers — and each of those reads pulled
 * 27,271 records across 37 tenants. On top of that, two helpers walked the
 * 424-question framework and rescanned the entire answers array for every one of
 * them: 5.9 million comparisons per call, seven calls per card.
 *
 * THE FIX, in two parts:
 *   1. src/repositories/snapshot-session.ts — withSnapshotSession makes an
 *      operation one unit of work: one read at the top, one write of the
 *      difference at the end, however many mutateAll calls happen inside. It
 *      rides on AsyncLocalStorage, so nested calls that open their OWN
 *      repository bundle join it too (upsertKnowledgeEntry does exactly that).
 *   2. DocumentQuestionAnsweringService — the two framework helpers index the
 *      answers array once by (domainKey, questionKey) instead of rescanning it
 *      424 times.
 *
 * Measured on the same seven-question card, same substrate: 25.07s -> 1.46s.
 *
 * WHAT THIS GOLDEN HOLDS:
 *   A. every mutateAll inside a session shares ONE snapshot        <- the fix
 *   B. a session commits once, at the end, and the write is durable
 *   C. a read inside the session sees the session's own writes
 *   D. a session that throws writes NOTHING, and the error still propagates
 *   E. sessions nest — an inner one joins rather than opening a second
 *   F. outside a session mutateAll still writes immediately (unchanged)
 *   G. a failed session does not stall every later write in the process
 *   H. the indexed helpers pick the same canonical answer as the scan did,
 *      and still do not see other tenants' rows
 *   I. the real card save still maps every question on the card
 *
 * WHAT IT CANNOT DO. It cannot prove the seconds. Timing belongs to
 * scripts/probes/essential-stage-ui.ts, which drives a real browser against real
 * Postgres in production auth mode.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import test from "node:test";
import { withSnapshotSession } from "@/repositories/snapshot-session";
import { createRepositories } from "@/repositories";
import { ensureWorkspaces } from "./_helpers/fixtures";
import { answerKnowledgeQuestionFromUnknown, syncMissingKnowledgeQuestions } from "@/services/DocumentQuestionAnsweringService";
import { answerUnknownQuestionGroup } from "@/services/AISettingsService";
import { groupEssentialSetupQuestions } from "@/services/KnowledgeQuestionPresentationService";
import { timestamp, uid } from "@/lib/db";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";

// Every case gets a hard timeout. Two of the mutations written against this
// golden (the session never releasing its lock, and a nested session opening a
// second snapshot) do not fail an assertion — they DEADLOCK, and a deadlocked
// golden without a timeout hangs a CI run forever instead of reporting a bug.
// A stall is a failure here, and it says so within a minute.
const CASE_TIMEOUT_MS = 20_000;

const repos = createRepositories();

/** A marker row we can find again, in a collection persistSnapshot really writes. */
function auditRow(workspaceId: string, eventType: string) {
  return {
    id: uid("audit"),
    workspaceId,
    actorUserId: "user_owner",
    eventType,
    entityType: "golden",
    entityId: "snapshot-session",
    payload: {},
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

async function countAudits(workspaceId: string, eventType: string) {
  const data = await repos.readAll!();
  return (data.auditLogs || []).filter((item) => item.workspaceId === workspaceId && item.eventType === eventType).length;
}

/**
 * Every tenant this file writes to, named in one place.
 *
 * A-7 (2026-08-26): these ids are invented by this golden and exist nowhere
 * else. On JSON that was fine - a file has no foreign keys, so an audit row
 * for a tenant that was never created just gets written. Postgres refuses it
 * with audit_logs_workspace_id_fkey, which means every case here was proving
 * snapshot-session behaviour against a database shape production cannot
 * produce. The fix is to make the tenants real, not to soften the cases.
 */
const TENANTS = [
  "workspace_session_a",
  "workspace_session_b",
  "workspace_session_c",
  "workspace_session_d",
  "workspace_session_e",
  "workspace_session_f",
  "workspace_session_g",
  "workspace_session_h",
  "workspace_session_h_neighbour",
  "workspace_session_i",
];

test("SETUP — the tenants these cases hang rows off exist", { timeout: CASE_TIMEOUT_MS }, async () => {
  await ensureWorkspaces(repos, TENANTS);
  for (const id of TENANTS) {
    assert.ok(await repos.workspace.getById(id), `tenant ${id} was not created, so every case that writes to it is proving nothing`);
  }
});

test("CASE A — every mutateAll inside a session runs against ONE snapshot", { timeout: CASE_TIMEOUT_MS }, async () => {
  const seen: AppData[] = [];
  await withSnapshotSession(async () => {
    await repos.mutateAll!((data) => {
      seen.push(data);
      (data.auditLogs ||= []).push(auditRow("workspace_session_a", "golden.session.first"));
      return 0;
    });
    await repos.mutateAll!((data) => {
      seen.push(data);
      return 0;
    });
  });
  assert.equal(seen.length, 2, "both mutators should have run");
  assert.ok(
    seen[0] === seen[1],
    "the second mutateAll got a DIFFERENT snapshot object, which means it went back to the database for it. " +
      "That is the whole defect: fifteen reads to save one card.",
  );
  const writtenInside = (seen[1].auditLogs || []).filter((item) => item.eventType === "golden.session.first");
  assert.equal(writtenInside.length, 1, "the second mutator could not see what the first one wrote — they are not sharing state");
});

test("CASE B — the session commits once, at the end, and it is durable", { timeout: CASE_TIMEOUT_MS }, async () => {
  const workspaceId = "workspace_session_b";
  await withSnapshotSession(async () => {
    await repos.mutateAll!((data) => {
      (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.durable"));
      return 0;
    });
    await repos.mutateAll!((data) => {
      (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.durable"));
      return 0;
    });
  });
  assert.equal(
    await countAudits(workspaceId, "golden.session.durable"),
    2,
    "work done inside a session did not survive it. Deferring the write is only acceptable if the write actually happens.",
  );
});

test("CASE C — a read inside the session sees the session's own writes", { timeout: CASE_TIMEOUT_MS }, async () => {
  // The write is deferred to the end of the session, so anything that writes and
  // then reads back inside one operation would see stale data unless reads join
  // the session too. That is not hypothetical: chunkKnowledgeDocument loads the
  // document createKnowledgeDocument made moments earlier, and it runs inside
  // exactly this session on every setup-card save.
  const workspaceId = "workspace_session_c";
  let seenMidway = -1;
  await withSnapshotSession(async () => {
    await repos.mutateAll!((data) => {
      (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.readback"));
      return 0;
    });
    seenMidway = await countAudits(workspaceId, "golden.session.readback");
  });
  assert.equal(
    seenMidway,
    1,
    "a read inside the session could not see what the session had just written. Anything that saves and then loads " +
      "its own work — chunking a document it just created, for one — breaks with a not-found error.",
  );
  assert.equal(await countAudits(workspaceId, "golden.session.readback"), 1, "and it must still be there once the session ends");
});

test("CASE D — a session that throws writes nothing, and the error still propagates", { timeout: CASE_TIMEOUT_MS }, async () => {
  const workspaceId = "workspace_session_d";
  await assert.rejects(
    withSnapshotSession(async () => {
      await repos.mutateAll!((data) => {
        (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.rolledback"));
        return 0;
      });
      throw new Error("deliberate failure inside the session");
    }),
    /deliberate failure inside the session/,
    "the session swallowed the error",
  );
  assert.equal(
    await countAudits(workspaceId, "golden.session.rolledback"),
    0,
    "a failed save left half its work written. The owner sees an error and has no idea which half landed.",
  );
});

test("CASE E — sessions nest: an inner one joins the outer, it does not open a second", { timeout: CASE_TIMEOUT_MS }, async () => {
  const seen: AppData[] = [];
  const workspaceId = "workspace_session_e";
  await withSnapshotSession(async () => {
    await repos.mutateAll!((data) => {
      seen.push(data);
      (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.nested"));
      return 0;
    });
    await withSnapshotSession(async () => {
      await repos.mutateAll!((data) => {
        seen.push(data);
        return 0;
      });
    });
  });
  assert.ok(seen[0] === seen[1], "the inner session opened its own snapshot, so a service cannot declare a boundary without knowing its callers");
  assert.equal(
    await countAudits(workspaceId, "golden.session.nested"),
    1,
    "the outer session did not commit after the inner one finished",
  );
});

test("CASE F — outside a session, mutateAll still writes immediately", { timeout: CASE_TIMEOUT_MS }, async () => {
  const workspaceId = "workspace_session_f";
  await repos.mutateAll!((data) => {
    (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.unsessioned"));
    return 0;
  });
  assert.equal(
    await countAudits(workspaceId, "golden.session.unsessioned"),
    1,
    "the ordinary write path changed. Sessions are opt-in; every caller that does not use one must behave exactly as before.",
  );
});

test("CASE G — a failed session does not stall every later write in the process", { timeout: CASE_TIMEOUT_MS }, async () => {
  const workspaceId = "workspace_session_g";
  await withSnapshotSession(async () => {
    await repos.mutateAll!(() => 0);
    throw new Error("failure that must not hold the queue");
  }).catch(() => undefined);

  // In JSON mode a session occupies a slot in the mutation queue and holds the
  // data-file lock. If a failure path forgets to release either one, the next
  // write never runs and the whole process hangs — which a test that only ever
  // takes the happy path would never notice.
  const finished = await Promise.race([
    repos.mutateAll!((data) => {
      (data.auditLogs ||= []).push(auditRow(workspaceId, "golden.session.afterfailure"));
      return "written" as const;
    }),
    new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 10000)),
  ]);
  assert.equal(finished, "written", "a write after a failed session never completed — the session leaked the queue slot or the file lock");
});

/**
 * The duplicate-row hazard is not the same hazard on both substrates, and
 * pretending it is would make this case dishonest on one of them.
 *
 * On JSON there is nothing stopping two rows for the same (workspace,
 * question). The product therefore has to pick a canonical one in code, and
 * this case proves it converges on exactly one.
 *
 * On Postgres `@@unique([workspaceId, questionKey])` makes that state
 * unreachable. So the assertion is not weakened here, it is INVERTED and made
 * stronger: seeding the duplicate must be REFUSED by the database. A case that
 * quietly skipped the seed on Postgres would report a pass for a rule it never
 * exercised.
 *
 * The tenant-isolation half runs identically on both, because "answering one
 * tenant's question must not touch another tenant's row" is true everywhere.
 *
 * Worth knowing (A-7, 2026-08-26): this asymmetry means a JSON file that has
 * accumulated duplicates cannot be loaded into Postgres as-is. The live
 * `.leadgen-data/app-data.json` has none today (checked: 0 duplicate keys), so
 * this is a migration hazard rather than a present defect.
 */
test("CASE H — the indexed helpers pick the same canonical answer, and still ignore other tenants", { timeout: CASE_TIMEOUT_MS }, async () => {
  const onPostgres = process.env.PERSISTENCE_PROVIDER === "prisma";
  const workspaceId = "workspace_session_h";
  const neighbour = "workspace_session_h_neighbour";
  await syncMissingKnowledgeQuestions(workspaceId, repos);
  await syncMissingKnowledgeQuestions(neighbour, repos);

  const seeded = await repos.readAll!();
  const original = (seeded.knowledgeQuestionAnswers || []).find(
    (item) => item.workspaceId === workspaceId && item.answerStatus !== "answered",
  );
  assert.ok(original, "no framework answer row was seeded for the tenant");
  const target = { domainKey: original.domainKey, questionKey: original.questionKey, question: original.question };

  const duplicateOf = (owner: string): KnowledgeQuestionAnswer => ({
    ...original,
    id: uid("kqa"),
    workspaceId: owner,
    answer: "",
    answerStatus: "unanswered",
    isCanonical: true,
    updatedAt: timestamp(),
  } as KnowledgeQuestionAnswer);

  if (onPostgres) {
    // The database must refuse the second row for the same question.
    let refused = "";
    try {
      await repos.mutateAll!((data) => {
        (data.knowledgeQuestionAnswers ||= []).push(duplicateOf(workspaceId));
        return null;
      });
    } catch (error) {
      refused = (error as Error).message || "";
    }
    assert.match(
      refused,
      /Unique constraint failed|P2002/i,
      "Postgres accepted a second answer row for the same (workspace, question). The unique constraint that makes canonical selection unnecessary on this substrate is gone.",
    );
  } else {
    // JSON has no such constraint, so the duplicate lands and the product's own
    // canonical selection is what has to sort it out. Both tenants get one, so
    // a lost workspace filter shows up as the neighbour's row being touched.
    await repos.mutateAll!((data) => {
      const answers = (data.knowledgeQuestionAnswers ||= []);
      for (const owner of [workspaceId, neighbour]) answers.push(duplicateOf(owner));
      return null;
    });
  }

  await answerKnowledgeQuestionFromUnknown(
    workspaceId,
    target.question,
    "We ship from Bhavnagar, Gujarat.",
    `${target.domainKey}/${target.questionKey}`,
    target.domainKey,
    target.questionKey,
    repos,
  );

  const data = await repos.readAll!();
  const rowsFor = (owner: string) =>
    (data.knowledgeQuestionAnswers || []).filter(
      (item) => item.workspaceId === owner && item.domainKey === target.domainKey && item.questionKey === target.questionKey,
    );

  const mine = rowsFor(workspaceId);
  const canonical = mine.filter((item) => item.isCanonical);
  assert.equal(canonical.length, 1, `${canonical.length} rows are marked canonical for one question — the retriever cannot tell which answer is the truth`);
  assert.equal(canonical[0].answerStatus, "answered", "the canonical row is not the answered one, so the owner's answer is not what gets quoted");

  const theirs = rowsFor(neighbour);
  const expected = onPostgres ? 1 : 2;
  assert.ok(
    theirs.length >= expected,
    `the neighbour has ${theirs.length} row(s) for this question, expected at least ${expected}, so this case proves nothing`,
  );
  assert.deepEqual(
    theirs.map((item) => item.answer),
    theirs.map(() => ""),
    "answering one tenant's question wrote into another tenant's rows",
  );
});

test("CASE I — the real card save still resolves every question on the card", { timeout: CASE_TIMEOUT_MS }, async () => {
  const workspaceId = "workspace_session_i";
  const items = await syncMissingKnowledgeQuestions(workspaceId, repos);
  const card = groupEssentialSetupQuestions(items).groups[0];
  assert.ok(card && card.questionIds.length >= 2, "no multi-question start-here card to save");

  const result = await answerUnknownQuestionGroup(
    workspaceId,
    card.questionIds,
    "We manufacture industrial valves and sell to plant buyers across three states.",
    true,
    repos,
    { domainKey: card.domainKey, relatedQuestionKeys: card.relatedQuestionKeys },
  );
  assert.equal(result.answeredQuestions, card.questionIds.length, "not every question on the card was marked answered");
  assert.equal(
    result.mappedAnswers,
    card.questionIds.length,
    "a faster save that saves less is not a fix. Every question on the card must still reach an answer row.",
  );

  const after = await syncMissingKnowledgeQuestions(workspaceId, repos);
  const stillOpen = card.questionIds.filter((id) => after.find((item) => item.id === id)?.status === "open");
  assert.deepEqual(stillOpen, [], "a question the owner just answered came straight back as open");
});
