/**
 * Golden test — saving one answer reads the workspace once, and never holds the
 * snapshot across a network call.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo. Nine answer saves in about thirty-five seconds took
 * the container down — "Server returned a non-JSON response with status 502" —
 * and the saves were lost.
 *
 * N-PERF-3 (2026-08-25) had already diagnosed and fixed exactly this shape for
 * the GROUP save: `repos.mutateAll` reads the whole snapshot, mutates in
 * memory, writes it back, and the knowledge services call it several times per
 * save. Measured then on 27,271 records, answering a seven-question card read
 * the database fifteen times. `withSnapshotSession` was built to make the whole
 * save one unit of work, and `answerUnknownQuestionGroup` was wrapped in it.
 *
 * `answerUnknownQuestion` — the SINGLE-question save, the button an owner
 * presses on a WhatsApp question the AI could not answer — was never wrapped.
 * It still ran a full snapshot cycle in each of `answerKnowledgeQuestionFromUnknown`,
 * `upsertKnowledgeEntryForUnknownQuestion` and `createKnowledgeDocument`. A
 * human answering at human pace does not notice, which is why it survived; it
 * needs somebody working quickly, which is what an owner does on their first
 * afternoon with the product.
 *
 * The second half of this is subtler. `chunkKnowledgeDocument` embeds every
 * chunk, one metered network call each, and the GROUP path was calling it from
 * INSIDE its session. snapshot-session.ts says plainly not to do that: in JSON
 * mode the session holds the data-file lock for its whole life, so a session
 * spanning n embedding calls blocks every other write for their duration. So
 * the fix that closes the single-save hole must not copy the group's mistake —
 * both now do their database work in a session and their embedding outside it.
 *
 *   CASE A — the single-answer save runs in a snapshot session.
 *
 *   CASE B — neither path embeds inside its session.
 *
 *   CASE C — the document is still chunked. Moving the call out must not drop
 *     it: an unchunked document is invisible to retrieval, so the answer the
 *     owner just typed would never reach a customer.
 *
 *   CASE D — the group path still reports how many chunks it wrote. The count
 *     is part of the response the screen shows.
 *
 * Substrate: static read of the service. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const SERVICE = "src/services/AISettingsService.ts";
const SESSION = "src/repositories/snapshot-session.ts";

/** The body of a named function, up to the next top-level closing brace. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert(start > 0, `setup: ${SERVICE} no longer defines ${signature}`);
  const end = source.indexOf("\n}", start);
  assert(end > start, `setup: could not find the end of ${signature}`);
  return source.slice(start, end);
}

function main() {
  console.log("=== GOLDEN: one answer is one unit of work ===\n");

  const service = readSource(SERVICE);
  const single = functionBody(service, "export async function answerUnknownQuestion(");
  const groupWrapper = functionBody(service, "export async function answerUnknownQuestionGroup(");
  const groupWork = functionBody(service, "async function answerUnknownQuestionGroupWork(");

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /withSnapshotSession/.test(single),
      `CASE A: the single-answer save does not open a snapshot session, so it reads and rewrites the whole workspace several times per save`,
    );
    assert(
      /withSnapshotSession/.test(groupWrapper),
      `CASE A: the group save must keep the session it has had since N-PERF-3`,
    );
    console.log("✅ CASE A — both answer paths save inside one snapshot session");
  }

  // ---------------------------------------------------------------- CASE B
  {
    // The session callback is what must not contain the embedding call.
    const sessionBody = single.slice(single.indexOf("withSnapshotSession"));
    assert(
      !/chunkKnowledgeDocument/.test(sessionBody.slice(0, sessionBody.indexOf("});"))),
      `CASE B: the single-answer session spans chunkKnowledgeDocument, which makes one network call per chunk`,
    );
    assert(
      !/chunkKnowledgeDocument/.test(groupWork),
      `CASE B: the group's session body still chunks inside the session — see the warning in ${SESSION}`,
    );
    console.log("✅ CASE B — no session is held across an embedding call");
  }

  // ---------------------------------------------------------------- CASE C
  {
    for (const [label, body] of [["single", single], ["group", groupWrapper]] as const) {
      assert(
        /chunkKnowledgeDocument\(workspaceId, /.test(body),
        `CASE C: the ${label} path no longer chunks the document at all — the answer would never reach retrieval`,
      );
    }
    console.log("✅ CASE C — the document is still chunked, just outside the session");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /chunks: chunks\.length/.test(groupWrapper),
      `CASE D: the group response must still carry the chunk count the screen reports`,
    );
    console.log("✅ CASE D — the group save still reports how many chunks it wrote");
  }

  console.log("\n=== GOLDEN PASSED (A-D) ===");
}

main();
