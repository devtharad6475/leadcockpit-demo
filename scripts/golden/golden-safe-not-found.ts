/**
 * golden-safe-not-found.ts — Cluster 5 P1-2 family
 *
 * WHAT (build-right Phase 3 — test FIRST, written BEFORE the helper exists):
 *   Pin the contract of a typed "swallow not-found, rethrow+log everything else"
 *   wrapper. The audit (NEW-A / P1-2) found ~30 sites where `.catch(() => [])`
 *   silently hides REAL errors and returns the empty list as if it were the
 *   truth. That makes counts lie (e.g. "0 auto-approves today" when the repo
 *   actually threw) and lets the erasure preview report "0 orders" when there
 *   are orders — operator could approve a delete believing nothing to lose.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *   CASE A — "not found" (ENOENT, Prisma P2025, our NotFoundError) → swallowed,
 *            returns the fallback value. Reason: a missing workspace setting is
 *            NORMAL (workspace hasn't been configured yet); the caller legitimately
 *            wants `undefined` so it can fall back to defaults. NOT a real error.
 *   CASE B — real error (database down, corrupt JSON, TypeError, Error("boom"))
 *            → RE-THROWN. The wrapper MUST NOT swallow it. Caller sees the real
 *            error and surfaces it to the operator.
 *   CASE C — Prisma known "not found" code "P2025" → swallowed (same family).
 *   CASE D — non-Error thrown (string, undefined) → RE-THROWN (never silently
 *            absorbed; surface to operator). This catches the case where a
 *            buggy `throw "oops"` happens.
 *   CASE E — wrapper returns fallback EXACTLY when not-found; the fallback
 *            identity is preserved (caller passes [] → gets the SAME []).
 *
 * REAL PIPELINE: the test imports the actual `safeNotFound` helper from
 * `@/lib/safe-not-found`. It does not mock anything. If the helper hardcodes
 * "always return fallback", CASE B/D fail. If it swallows everything, CASE C
 * still passes but the load-bearing CASE B/D fail.
 *
 * Run: `npm run golden:safe-not-found`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { strict as assert } from "node:assert";
import { safeNotFound, NotFoundError, isNotFoundError } from "@/lib/safe-not-found";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) {
  cases.push({ name, fn });
}

// --- CASE A: ENOENT (file missing) → swallowed, returns fallback ----------------
test("CASE A — ENOENT (file missing) swallowed, fallback returned", async () => {
  // Hand-computed: a missing settings file is NORMAL. Caller wants `undefined`
  // so it can fall back to defaults. NOT a real error.
  const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  const result = await safeNotFound(
    async () => {
      throw enoent;
    },
    { fallback: undefined },
  );
  assert.strictEqual(result, undefined, "ENOENT must be swallowed → fallback undefined");
});

// --- CASE B: real error re-thrown ------------------------------------------------
test("CASE B — real Error('boom') re-thrown (NOT swallowed)", async () => {
  // Hand-computed: a corrupt-JSON parse, a TypeError, or any unrecognised
  // error MUST bubble up so the operator sees the truth. Returning [] here
  // is the entire bug we're killing.
  let caught: unknown = null;
  try {
    await safeNotFound(
      async () => {
        throw new Error("boom — database down");
      },
      { fallback: [] as number[] },
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "real error must be re-thrown as Error");
  assert.match((caught as Error).message, /boom/, "re-thrown error preserves message");
});

// --- CASE C: Prisma P2025 → swallowed -------------------------------------------
test("CASE C — Prisma P2025 (record not found) swallowed", async () => {
  // Hand-computed: Prisma throws code "P2025" when findUnique returns null on
  // a `.getById`-style call. That's "not found", not a crash.
  const p2025 = Object.assign(new Error("No record found"), { code: "P2025" });
  const fallback = { name: "default profile" };
  const result = await safeNotFound(
    async () => {
      throw p2025;
    },
    { fallback },
  );
  assert.strictEqual(result, fallback, "P2025 must return caller's fallback");
});

// --- CASE D: non-Error throw re-thrown ------------------------------------------
test("CASE D — non-Error throw (string) re-thrown, never silently absorbed", async () => {
  // Hand-computed: a buggy `throw "oops"` must NOT be silently absorbed into
  // the fallback. Surface it so the operator knows something threw.
  let caught: unknown = "not-thrown";
  try {
    await safeNotFound(
      async () => {
        // eslint-disable-next-line no-throw-literal
        throw "oops";
      },
      { fallback: [] },
    );
  } catch (e) {
    caught = e;
  }
  assert.notStrictEqual(caught, "not-thrown", "non-Error throw must propagate");
});

// --- CASE E: success path returns the real value --------------------------------
test("CASE E — success returns the real value, fallback untouched", async () => {
  // Hand-computed: happy path. The async function returns the real list; the
  // fallback is never used.
  const result = await safeNotFound(
    async () => [1, 2, 3],
    { fallback: [] as number[] },
  );
  assert.deepStrictEqual(result, [1, 2, 3], "success path returns the real value");
});

// --- CASE F: NotFoundError (our own typed not-found) swallowed ------------------
test("CASE F — NotFoundError swallowed, normal Error re-thrown", async () => {
  // Hand-computed: the typed NotFoundError is the explicit signal "this is a
  // not-found situation" from any code path that wants to participate. A plain
  // Error next to it must still re-throw.
  const r1 = await safeNotFound(
    async () => {
      throw new NotFoundError("workspace has no settings row");
    },
    { fallback: null },
  );
  assert.strictEqual(r1, null, "NotFoundError swallowed → fallback");

  let threw = false;
  try {
    await safeNotFound(
      async () => {
        throw new Error("disk full");
      },
      { fallback: null },
    );
  } catch {
    threw = true;
  }
  assert.ok(threw, "plain Error still re-throws");
});

// --- CASE G: isNotFoundError classifier pinned (the chokepoint contract) --------
test("CASE G — isNotFoundError classifier matches the not-found family only", async () => {
  // Hand-computed: the classifier returns TRUE for ENOENT, P2025, NotFoundError,
  // 404-shaped errors; FALSE for everything else. This is the chokepoint every
  // silent-catch site relies on.
  assert.strictEqual(isNotFoundError(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.strictEqual(isNotFoundError(Object.assign(new Error("x"), { code: "P2025" })), true);
  assert.strictEqual(isNotFoundError(new NotFoundError("x")), true);
  assert.strictEqual(isNotFoundError(new Error("ENOENT in message but no code")), false, "plain Error is NOT auto-treated as not-found");
  assert.strictEqual(isNotFoundError(new TypeError("x")), false);
  assert.strictEqual(isNotFoundError(null), false);
  assert.strictEqual(isNotFoundError(undefined), false);
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
  console.log(`safe-not-found: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
