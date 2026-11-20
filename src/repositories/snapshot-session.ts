/**
 * N-PERF-3 / audit A-13 (2026-08-25) — one unit of work, one snapshot.
 *
 * THE PROBLEM THIS EXISTS TO FIX. `repos.mutateAll(...)` is the only write path
 * that can touch several collections atomically, so the knowledge services use
 * it for everything. Each call is self-contained: read the WHOLE snapshot, run
 * the mutator in memory, write back what changed. That is fine once. Answering
 * one setup card does it fifteen times.
 *
 * Measured on the real Postgres substrate, 37 tenants, 27,271 records, a
 * seven-question card:
 *
 *   readAll()                                    0.75 s
 *   one mutateAll cycle                          0.96 s
 *   answerUnknownQuestionGroup, seven questions  25.07 s   (3.58 s per question)
 *     of which mutateAll through the bundle      16.85 s   (8 calls)
 *     of which its own bundles                    8.21 s   (7 upsertKnowledgeEntry)
 *
 * Two full snapshot cycles PER QUESTION — one in answerKnowledgeQuestionFromUnknown,
 * one in upsertKnowledgeEntry — plus a final one in persistGroupedFrameworkAnswers.
 * The database was read fifteen times to save one card, and every one of those
 * reads got the same 27,271 records. It is the first screen a paying customer
 * meets and it grows with every tenant sold.
 *
 * THE FIX. A session: read once at the top, let every mutateAll inside run
 * against that one in-memory snapshot, write the difference once at the end.
 * Nothing about the mutators changes — they are the same plain functions
 * mutating the same plain object.
 *
 * WHY AsyncLocalStorage AND NOT A PARAMETER. The obvious version threads a
 * session object through every call. It does not work here: the nested calls do
 * not all receive the caller's bundle — upsertKnowledgeEntryForUnknownQuestion
 * calls upsertKnowledgeEntry without passing `repos`, so that one opens its OWN
 * repository bundle and would miss a session held on the caller's object. Every
 * such omission would be a silent partial fix, and there is no way to see one by
 * reading a diff. AsyncLocalStorage is keyed on the async call tree instead, so
 * any mutateAll anywhere below withSnapshotSession joins it, whichever bundle it
 * belongs to, and concurrent HTTP requests each get their own store because each
 * runs in its own async context.
 *
 * WHAT CHANGES IN BEHAVIOUR, STATED PLAINLY:
 *   - Writes inside a session land at the END of the session, not per call. A
 *     reader in ANOTHER request sees the old values until then. Within the
 *     session everything sees its own writes, because they all share the object.
 *   - If the session body throws, nothing inside it is persisted. Without a
 *     session a throw halfway through left the earlier calls written. Atomic is
 *     the better answer for a card save — the owner retries and gets all of it
 *     or none of it — but it IS a change, so it is written down here.
 *   - Sessions nest. An inner withSnapshotSession joins the outer one rather
 *     than opening a second snapshot, so a service can declare its own boundary
 *     without knowing who called it.
 *
 * WHERE NOT TO USE IT. Do not wrap anything that waits on a model, a webhook or
 * a human. In JSON mode the session holds the data-file lock for its whole life
 * (that is what keeps it atomic), so a session that spans a 30-second AI call
 * blocks every other write for 30 seconds. Sessions belong around a burst of
 * database work, not around an AI conversation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppData } from "@/lib/types";

export type SnapshotSession = {
  /** The one snapshot every mutateAll inside this session runs against. */
  snapshot?: AppData;
  /** Provider-supplied writer, installed by whichever mutateAll opens the snapshot. */
  commit?: () => Promise<void>;
  /** Provider-supplied cleanup (the JSON file lock), always run, even on failure. */
  release?: () => Promise<void>;
};

const storage = new AsyncLocalStorage<SnapshotSession>();

/** The session for the current async call tree, or undefined when there is none. */
export function activeSnapshotSession(): SnapshotSession | undefined {
  return storage.getStore();
}

/**
 * Run `fn` as one unit of work: one snapshot read, one write of the difference.
 *
 * The snapshot is opened lazily by the first mutateAll inside, so a session that
 * turns out to write nothing costs nothing. If `fn` throws, the snapshot is
 * discarded unwritten and the error propagates unchanged.
 */
export async function withSnapshotSession<T>(fn: () => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) return fn();

  const session: SnapshotSession = {};
  return storage.run(session, async () => {
    try {
      const result = await fn();
      if (session.snapshot && session.commit) await session.commit();
      return result;
    } finally {
      await session.release?.();
    }
  });
}
