/**
 * GOLDEN — a read that changes nothing must write nothing (P0-PERF-1).
 *
 * Found 2026-08-24, by a browser probe that could not get past the onboarding
 * screen. A brand-new customer was told 523 setup questions were waiting, and
 * the screen those questions live on answered "0 information areas still need
 * owner input", because every request to it came back:
 *
 *   400 VALIDATION_ERROR — Transaction API error: A commit cannot be executed
 *   on an expired transaction. The timeout for this transaction was 45000 ms,
 *   however 90804 ms passed since the start of the transaction.
 *
 * `GET /api/unknown-questions` and `GET /api/unknown-questions/groups` both call
 * syncMissingKnowledgeQuestions → repos.mutateAll. In Prisma mode mutateAll read
 * every row of 15 collections across every tenant and re-upserted ALL of them
 * inside one 45s transaction. At 17 workspaces that was 9,444 rows per PAGE
 * VIEW, growing ~1,046 rows per customer signed up: the cost of reading was
 * O(whole database), so every sale made the product slower for everyone.
 *
 * Measured on the real database, same call, before and after:
 *   before — 90+ seconds, transaction expired, 400 to the browser
 *   after  — 755 ms, 0 rows re-stamped, 523 questions still returned
 *
 * WHAT THIS GOLDEN HOLDS. The diff itself, behaviourally — not a regex over the
 * call site. fingerprintSnapshot/changedRecordsOnly are exported for exactly
 * this reason (same precedent as persistSnapshot, exported for N-DATA-2). CASE A
 * is the one that matters: an untouched snapshot must reduce to nothing.
 *
 * WHAT IT CANNOT DO. It does not touch Postgres, so it cannot prove the route is
 * fast. That is scripts/probes/snapshot-write-cost.ts, which asks the database
 * itself how many rows had their auto-managed updated_at re-stamped by a pure
 * read. Run it against a real database before shipping.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { AppData } from "../../src/lib/types";
import { changedRecordsOnly, fingerprintSnapshot } from "../../src/repositories/prisma";

/**
 * A snapshot with the two collections the P0 lived in, plus a non-keyed array
 * (the webhook dedup list) so the "no id to diff by" branch is covered too.
 */
function snapshot(): AppData {
  return {
    unknownQuestions: [
      { id: "uq-1", workspaceId: "ws-a", questionText: "What is the MOQ?", status: "open" },
      { id: "uq-2", workspaceId: "ws-a", questionText: "Do you ship to Pune?", status: "open" },
      { id: "uq-3", workspaceId: "ws-b", questionText: "Another tenant's question", status: "open" },
    ],
    knowledgeQuestionAnswers: [
      { id: "qa-1", workspaceId: "ws-a", question: "MOQ?", answer: "", answerStatus: "unanswered" },
      { id: "qa-2", workspaceId: "ws-b", question: "Hours?", answer: "9-6", answerStatus: "answered" },
    ],
    processedWebhookMessageIds: ["wamid.1", "wamid.2"],
  } as unknown as AppData;
}

/** Total records left across every array in a snapshot. */
function totalRecords(data: AppData): number {
  return Object.values(data as unknown as Record<string, unknown>)
    .filter(Array.isArray)
    .reduce((sum, arr) => sum + arr.length, 0);
}

test("CASE A — a snapshot nobody touched reduces to nothing to write", () => {
  // This is the whole fix. Every page view of the onboarding screen runs this
  // path, and on a page view the mutator finds the stubs already seeded and
  // changes precisely nothing.
  const data = snapshot();
  const before = fingerprintSnapshot(data);
  const toWrite = changedRecordsOnly(before, data);

  assert.equal(
    totalRecords(toWrite),
    0,
    "an untouched snapshot still produced records to write. Every one of those is a pointless upsert inside a " +
      "45-second transaction, and at 9,444 of them the transaction expires and the customer gets a 400.",
  );
});

test("CASE B — a record the mutator changed IS written, and nothing else is", () => {
  // The dangerous failure of a diff is not that it writes too much; it is that
  // it writes too little. A change that never reaches the database is data loss
  // that looks like success.
  const data = snapshot();
  const before = fingerprintSnapshot(data);

  const answered = (data as unknown as { unknownQuestions: Array<Record<string, unknown>> }).unknownQuestions[1];
  answered.status = "added_to_knowledge";
  answered.finalAnswer = "Yes, Pune is next-day.";

  const toWrite = changedRecordsOnly(before, data) as unknown as { unknownQuestions: Array<{ id: string }> };

  assert.deepEqual(
    toWrite.unknownQuestions.map((item) => item.id),
    ["uq-2"],
    "the diff did not carry exactly the one record the mutator changed. Too few means the customer's answer is " +
      "silently dropped; too many means the pointless writes are back.",
  );
  assert.equal(totalRecords(toWrite as unknown as AppData), 1, "only the changed record should be written");
});

test("CASE C — a record the mutator ADDED is written", () => {
  // Seeding a new tenant's framework stubs goes through this path on the first
  // visit. If new records were dropped, a fresh customer would get an empty
  // onboarding screen forever.
  const data = snapshot();
  const before = fingerprintSnapshot(data);

  (data as unknown as { unknownQuestions: Array<Record<string, unknown>> }).unknownQuestions.push({
    id: "uq-new",
    workspaceId: "ws-a",
    questionText: "Freshly seeded framework question",
    status: "open",
  });

  const toWrite = changedRecordsOnly(before, data) as unknown as { unknownQuestions: Array<{ id: string }> };
  assert.deepEqual(
    toWrite.unknownQuestions.map((item) => item.id),
    ["uq-new"],
    "a record that did not exist when the snapshot was read must be written; it is not in the database yet.",
  );
});

test("CASE D — arrays with no id to diff by are still handled, both ways", () => {
  // processedWebhookMessageIds is a list of plain strings. There is no key to
  // match on, so it is compared whole: unchanged means skip it entirely,
  // changed means send all of it. Getting this wrong reintroduces duplicate
  // WhatsApp message delivery, which is worse than a slow page.
  const untouched = snapshot();
  const beforeUntouched = fingerprintSnapshot(untouched);
  const skipped = changedRecordsOnly(beforeUntouched, untouched) as unknown as { processedWebhookMessageIds: string[] };
  assert.deepEqual(skipped.processedWebhookMessageIds, [], "an unchanged non-keyed array should not be rewritten");

  const changed = snapshot();
  const beforeChanged = fingerprintSnapshot(changed);
  (changed as unknown as { processedWebhookMessageIds: string[] }).processedWebhookMessageIds.push("wamid.3");
  const written = changedRecordsOnly(beforeChanged, changed) as unknown as { processedWebhookMessageIds: string[] };
  assert.deepEqual(
    written.processedWebhookMessageIds,
    ["wamid.1", "wamid.2", "wamid.3"],
    "a changed non-keyed array must be written in full — there is no way to write only part of it",
  );
});

test("CASE E — the fingerprint sees a change anywhere in the record, not just the fields it knows", () => {
  // Property, not shape. The mutators are ordinary functions that mutate a
  // plain object; nothing declares which fields they touch. A diff that only
  // watched a hand-listed set of fields would be correct on the day it was
  // written and would silently start dropping writes the first time a mutator
  // learned a new field. Every field must count.
  const data = snapshot();
  const before = fingerprintSnapshot(data);

  const record = (data as unknown as { knowledgeQuestionAnswers: Array<Record<string, unknown>> }).knowledgeQuestionAnswers[0];
  record.reviewedByUser = "user_owner"; // a field this snapshot never carried

  const toWrite = changedRecordsOnly(before, data) as unknown as { knowledgeQuestionAnswers: Array<{ id: string }> };
  assert.deepEqual(
    toWrite.knowledgeQuestionAnswers.map((item) => item.id),
    ["qa-1"],
    "adding a field the diff had never seen did not mark the record dirty. Any mutator that writes a new field " +
      "would have its work silently discarded.",
  );
});

after(() => {
  console.log(
    "\n  NOTE: this golden holds the diff, not the route. It does not touch Postgres, so it cannot prove a page\n" +
      "  view is fast. That proof is scripts/probes/snapshot-write-cost.ts, which asks the database how many rows\n" +
      "  a pure read re-stamped: it must be 0, and the call must still return the tenant's questions.\n",
  );
});
