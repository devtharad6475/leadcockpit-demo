/**
 * run-in-transaction.ts — Cluster 6 P1-6 family chokepoint (build-right Phase 3d).
 *
 * PROBLEM (audit P1-6): 6 multi-write flows do separate writes — each
 * acquiring the file lock independently. A crash mid-flow leaves partial
 * state:
 *   - approve flow: customer got the WhatsApp message but no audit record.
 *   - quote→order conversion: order created but quote not marked converted.
 *   - inbound WhatsApp: reply exists but no DNC update / no ticket.
 *   - extraction apply: partial KB after a mid-extraction crash.
 *   - erasure cascade: some records deleted, others left (DPDPA violation).
 *   - unknown-question→ticket: ticket created but unknown-question still open.
 *
 * CONTRACT (pinned by golden:run-in-transaction):
 *   - All writes inside one transaction commit together OR none commit.
 *   - A throw mid-transaction rolls back EVERY write made in that transaction.
 *   - Reads inside the transaction see earlier writes in the same transaction
 *     (read-your-writes / isolation).
 *   - The helper returns the callback's return value + propagates any throw.
 *
 * IMPLEMENTATION NOTES:
 *   - The JSON runtime's `mutateData` ALREADY provides file-level atomicity
 *     (read + mutate + write inside one lock). The bug was that the 6 flows
 *     called it MULTIPLE times instead of ONCE. So `runInTransaction` is
 *     literally: wrap the whole flow's writes in a single `mutateData` call.
 *   - For testability (the global file is hardcoded in db.ts), the helper
 *     accepts an optional `adapter` parameter. Production passes nothing
 *     (uses the default mutateData adapter); tests pass an in-memory adapter.
 *   - Side-effect-then-atomic-write pattern: an external side effect (e.g.
 *     the WhatsApp send itself) cannot be rolled back. The contract is:
 *     validate everything → do the irreversible external action → wrap all
 *     local writes in one transaction. If the local writes fail, you still
 *     have the external side effect, but at least the database state is
 *     consistent (no half-written local records). The approve-flow caller
 *     records a `message.send_failed` audit entry in this case.
 */
import { mutateData, readData, type AppData } from "@/lib/db";

/**
 * A storage adapter that the transaction helper uses. Production uses the
 * default (which delegates to mutateData — file-level atomic). Tests inject
 * an in-memory adapter to verify the rollback contract without touching the
 * global file.
 */
export interface TransactionAdapter {
  /** Run a mutator against the live data; the adapter guarantees atomicity
   *  (read + mutate + write inside one lock, or rollback on throw). */
  run<T>(mutator: (data: AppData) => T | Promise<T>): Promise<T>;
}

/** Default adapter: delegates to the JSON runtime's atomic mutateData. */
const defaultAdapter: TransactionAdapter = {
  run<T>(mutator: (data: AppData) => T | Promise<T>): Promise<T> {
    return mutateData(mutator);
  },
};

/**
 * Run a multi-write flow inside one atomic transaction. The callback receives
 * the live `AppData` and may mutate it directly + read it back (read-your-
 * writes). If the callback throws, NOTHING commits (all earlier writes in the
 * callback are rolled back). Returns whatever the callback returns.
 *
 * Usage (the approve-flow pattern):
 *   await runInTransaction(async (data) => {
 *     // Validate (no writes yet).
 *     // ... do the irreversible external action (e.g. WhatsApp send) ...
 *     // Now do ALL local writes inside this one transaction:
 *     data.autoReplyLogs = data.autoReplyLogs.map(...)
 *     data.outreachActivities.push(...)
 *     data.leads = data.leads.map(...)
 *     data.auditLogs.push(...)
 *     return approvedLog;
 *   });
 *
 * @param adapter Optional. Tests inject an in-memory adapter. Production
 *                omits this (uses the default file-backed adapter).
 */
export async function runInTransaction<T>(
  callback: (data: AppData) => T | Promise<T>,
  adapter: TransactionAdapter = defaultAdapter,
): Promise<T> {
  return adapter.run(callback);
}

/**
 * Read the live data (for flows that need to read WITHOUT writing). Wraps
 * readData() so flows have one import for the transaction primitives.
 */
export async function readLiveData(): Promise<AppData> {
  return readData();
}
