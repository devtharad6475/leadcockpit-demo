/**
 * golden-run-in-transaction.ts — Cluster 6 P1-6 family
 *
 * WHAT (build-right Phase 3 — test FIRST, written BEFORE the helper exists):
 *   Pin the contract of a transaction helper for the JSON demo runtime. The
 *   audit (P1-6) found 6 multi-write flows that do separate writes — each
 *   acquiring the file lock independently. A crash mid-flow leaves partial
 *   state: customer got the WhatsApp message but no audit record; reply
 *   exists but no reviewable draft; partial KB after extraction.
 *
 * HOW THIS TEST IS ANTI-CHEAT:
 *   The test injects an in-memory adapter so it can observe the live data
 *   between + after the transaction. If the helper doesn't actually roll back
 *   on failure, CASE B fails (the earlier write would still be in the store).
 *   If the helper swallows the throw, CASE D fails. The helper is a thin
 *   wrapper — it cannot fake atomicity.
 *
 * HAND-COMPUTED CONTRACT (these are the rules, not the code):
 *   CASE A — all writes succeed → all committed.
 *   CASE B — a later write fails AFTER an earlier write in the SAME
 *            transaction → NOTHING commits (rollback). LOAD-BEARING.
 *   CASE C — read inside the transaction sees writes made earlier in the
 *            same transaction (read-your-writes / isolation).
 *   CASE D — a throw inside the transaction propagates to the caller.
 *   CASE E — helper returns the callback's return value.
 *   CASE F — two separate transactions are independent (commit A, then a
 *            failed transaction B does NOT roll back A's commit).
 *
 * Run: `npm run golden:run-in-transaction`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { strict as assert } from "node:assert";
import { runInTransaction, type TransactionAdapter } from "@/lib/run-in-transaction";
import type { AppData } from "@/lib/db";
import type { AuditLog, Lead } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) {
  cases.push({ name, fn });
}

/** In-memory adapter. Implements the SAME atomic contract the JSON file
 *  adapter does: read + mutate + write inside one logical lock, rollback on
 *  throw. Used by every case so we can observe state without touching the
 *  global demo file. */
function makeInMemoryAdapter(initial?: Partial<AppData>): { adapter: TransactionAdapter; snapshot: () => AppData } {
  // Deep-ish clone so the mutator can't leak writes back on throw.
  const clone = (): AppData => ({
    version: 1,
    workspaces: [],
    users: [],
    leads: [],
    replies: [],
    tickets: [],
    orders: [],
    quotes: [],
    campaigns: [],
    icps: [],
    knowledgeBaseDocuments: [],
    knowledgeBaseChunks: [],
    auditLogs: [],
    outreachActivities: [],
    autoReplyLogs: [],
    unknownQuestions: [],
    mediaCatalog: [],
    businessProfiles: [],
    humanFallbackTasks: [],
    ticketEvents: [],
    doNotContactRegistry: [],
    settingsConflicts: [],
    pendingSettingsDrafts: [],
    nextOrderNumbers: [],
    nextQuoteNumbers: [],
    nextTicketNumbers: [],
    metrics: [],
    deletedLeads: [],
    messageTemplates: [],
    agentRuns: [],
    integrations: [],
    campaignLearnings: [],
    crawlJobs: [],
    crawlPages: [],
    businessExtractions: [],
    ...initial,
  } as AppData);

  // The "live" data the adapter exposes to mutators.
  let live: AppData = clone();
  // The "committed" data — what persists after a successful transaction.
  // On rollback, `live` is reset to this.
  let committed: AppData = clone();

  const adapter: TransactionAdapter = {
    async run<T>(mutator: (data: AppData) => T | Promise<T>): Promise<T> {
      // Snapshot the committed state so we can roll back on throw.
      const beforeSnapshot = structuredCloneSafe(committed);
      // Hand the mutator the live data (read-your-writes within this txn).
      live = structuredCloneSafe(committed);
      try {
        const result = await mutator(live);
        // Success — commit.
        committed = live;
        return result;
      } catch (e) {
        // Rollback — discard `live`, restore from the snapshot.
        live = committed;
        committed = beforeSnapshot;
        throw e;
      }
    },
  };
  return { adapter, snapshot: () => structuredCloneSafe(committed) };
}

/** structuredClone with a JSON fallback for older Node. */
function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

test("CASE A — all writes succeed → all committed", async () => {
  const { adapter, snapshot } = makeInMemoryAdapter();
  await runInTransaction(async (data) => {
    data.leads.push({ id: "L1", workspaceId: "ws", contactName: "Alice" } as Lead);
    if (!data.auditLogs) data.auditLogs = [];
    data.auditLogs.push({ id: "A1", workspaceId: "ws", eventType: "test" } as AuditLog);
    return "done";
  }, adapter);
  const after = snapshot();
  assert.strictEqual(after.leads.length, 1, "lead L1 must be committed");
  assert.strictEqual((after.auditLogs || []).length, 1, "audit A1 must be committed");
});

test("CASE B — later write fails → EARLIER write is rolled back (NOTHING persists)", async () => {
  // LOAD-BEARING: this is what makes a transaction a transaction.
  const { adapter, snapshot } = makeInMemoryAdapter();
  let threw = false;
  try {
    await runInTransaction(async (data) => {
      data.leads.push({ id: "L_SURVIVOR", workspaceId: "ws", contactName: "Bob" } as Lead);
      // ... later in the same transaction, something fails:
      throw new Error("simulated mid-flow crash");
    }, adapter);
  } catch {
    threw = true;
  }
  assert.ok(threw, "the throw must propagate");
  const after = snapshot();
  assert.strictEqual(
    after.leads.find((l: { id: string }) => l.id === "L_SURVIVOR"),
    undefined,
    "the earlier write MUST be rolled back — no partial state",
  );
  assert.strictEqual(after.leads.length, 0, "nothing from the failed transaction must persist");
});

test("CASE C — read inside the transaction sees earlier writes in the same transaction (isolation)", async () => {
  const { adapter } = makeInMemoryAdapter();
  let observedInside: string | null = null;
  await runInTransaction(async (data) => {
    data.leads.push({ id: "L_ISO", workspaceId: "ws", contactName: "Carol" } as Lead);
    // Read back what we just wrote — must see it (read-your-writes).
    observedInside = data.leads.find((l: { id: string }) => l.id === "L_ISO")?.id || null;
    return observedInside;
  }, adapter);
  assert.strictEqual(observedInside, "L_ISO", "read inside the transaction must see writes made earlier in the same transaction");
});

test("CASE D — a throw inside the transaction propagates to the caller", async () => {
  const { adapter } = makeInMemoryAdapter();
  const expectedMessage = "explicit failure for CASE D";
  let caught: unknown = null;
  try {
    await runInTransaction(async () => {
      throw new Error(expectedMessage);
    }, adapter);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "throw must propagate as an Error");
  assert.strictEqual((caught as Error).message, expectedMessage, "the original error message is preserved");
});

test("CASE E — helper returns the callback's return value", async () => {
  const { adapter } = makeInMemoryAdapter();
  const result = await runInTransaction(async (data) => {
    data.leads.push({ id: "L_RET", workspaceId: "ws" } as Lead);
    return { createdId: "L_RET", count: data.leads.length };
  }, adapter);
  assert.deepStrictEqual(result, { createdId: "L_RET", count: 1 }, "helper returns the callback's return value");
});

test("CASE F — two separate transactions are independent (committed A survives a failed B)", async () => {
  // Txn A commits. Txn B fails. A's commit must still be there (the helper
  // rolls back only B's writes, not A's — they're separate transactions).
  const { adapter, snapshot } = makeInMemoryAdapter();
  await runInTransaction(async (data) => {
    data.leads.push({ id: "L_A", workspaceId: "ws" } as Lead);
  }, adapter);
  try {
    await runInTransaction(async (data) => {
      data.leads.push({ id: "L_B", workspaceId: "ws" } as Lead);
      throw new Error("B fails");
    }, adapter);
  } catch {
    /* expected */
  }
  const after = snapshot();
  assert.ok(after.leads.find((l: { id: string }) => l.id === "L_A"), "txn A's commit must survive txn B's failure");
  assert.strictEqual(after.leads.find((l: { id: string }) => l.id === "L_B"), undefined, "txn B's write must be rolled back");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`run-in-transaction: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
