/**
 * golden-atomic-write-retry.ts — N-DATA-5 pin (2026-08-19, CEO-loop session 7).
 *
 * THE BUG THIS PINS
 * -----------------
 * Every JSON-substrate write ends in `rename(tmp, app-data.json)`. On Windows
 * that rename fails while any other process holds a handle on the destination:
 *
 *     EPERM: operation not permitted, rename
 *       '.leadgen-data-e2e/app-data.21408.<ts>.<rand>.tmp'
 *       -> '.leadgen-data-e2e/app-data.json'
 *       at async writeData (src/lib/db.ts:241)
 *
 * quoted verbatim from the e2e run on 2026-08-19 — where it surfaced to the
 * client as `api.errorToResponse.500`. The old inline policy retried 5 times
 * over 500ms; that was not enough, and the operator lost the write.
 *
 * WHY THE POLICY IS TESTED AND NOT THE FILESYSTEM
 * ----------------------------------------------
 * The condition is another process holding a handle at exactly the wrong
 * moment. It cannot be summoned on demand, so a test that writes a real file
 * and asserts success proves only that nothing happened to collide that
 * second. `renameWithRetry` therefore takes its `rename` and `sleep` as
 * arguments, and this golden hands it renames that fail on purpose.
 *
 * CASE B is the one that stops "fix it by retrying harder" from being the
 * answer to everything: a full disk must fail NOW, not in three seconds.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — 6 consecutive EPERMs are survived (the old 5-attempt policy died here).
 *   CASE B — a non-transient error (ENOSPC) is rethrown on attempt 1, with no waiting.
 *   CASE C — the budget is at least 2.5s in total, spread over >= 10 retries.
 *   CASE D — when the budget runs out, the LAST real error is what propagates.
 *   CASE E — EBUSY and EACCES are treated as transient too, not just EPERM.
 *   CASE F — a real writeData()/readData() round trip still works end to end.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RENAME_BACKOFF_MS,
  TRANSIENT_RENAME_CODES,
  renameWithRetry,
} from "../../src/lib/atomic-rename";

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

function errno(code: string) {
  const e = new Error(`${code}: simulated, rename 'a' -> 'b'`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** A rename that fails `failures` times with `code`, then succeeds. */
function flakyRename(failures: number, code = "EPERM") {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls <= failures) throw errno(code);
  };
  return { fn, calls: () => calls };
}

/** Records what it was asked to wait for without actually waiting. */
function fakeSleep() {
  const waits: number[] = [];
  return { fn: async (ms: number) => { waits.push(ms); }, waits };
}

async function main() {
  console.log("");
  console.log("=== GOLDEN atomic-write-retry (N-DATA-5) ===");
  console.log("");

  await check("CASE A — six consecutive EPERMs are survived", async () => {
    const r = flakyRename(6);
    const s = fakeSleep();
    const out = await renameWithRetry("a", "b", { rename: r.fn, sleep: s.fn });
    assert.strictEqual(out.attempts, 7,
      `expected the 7th attempt to be the one that worked, got ${out.attempts}. The policy this replaced gave up after 5 — which is exactly why the operator saw a 500.`);
    assert.strictEqual(r.calls(), 7, "rename should have been called once per attempt");
  });

  await check("CASE B — a non-transient error fails immediately, with no waiting", async () => {
    const r = flakyRename(1, "ENOSPC");
    const s = fakeSleep();
    await assert.rejects(
      () => renameWithRetry("a", "b", { rename: r.fn, sleep: s.fn }),
      /ENOSPC/,
      "a full disk must surface as itself, not as a retry storm",
    );
    assert.strictEqual(r.calls(), 1, "a non-transient error must not be retried even once");
    assert.deepStrictEqual(s.waits, [],
      "THIS is the case that stops 'retry harder' being the answer to everything: an error that will never heal must not cost the caller three seconds first");
  });

  await check("CASE C — the budget is at least 2.5s over at least 10 retries", () => {
    const total = RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0);
    assert.ok(RENAME_BACKOFF_MS.length >= 10,
      `only ${RENAME_BACKOFF_MS.length} retries are scheduled; the observed locks needed more than the old five`);
    assert.ok(total >= 2_500,
      `total backoff budget is ${total}ms, which is below the 2.5s this bug needed. The old policy's 500ms is what let the EPERM through.`);
  });

  await check("CASE D — when the budget runs out, the real error propagates", async () => {
    const r = flakyRename(Number.MAX_SAFE_INTEGER);
    const s = fakeSleep();
    await assert.rejects(
      () => renameWithRetry("a", "b", { rename: r.fn, sleep: s.fn }),
      (err: NodeJS.ErrnoException) => err.code === "EPERM" && /rename/.test(err.message),
      "giving up must rethrow the last real error — a wrapped or generic failure leaves the next reader with no code and no paths",
    );
    assert.strictEqual(r.calls(), RENAME_BACKOFF_MS.length + 1,
      `expected ${RENAME_BACKOFF_MS.length + 1} attempts before giving up, got ${r.calls()}`);
  });

  await check("CASE E — EBUSY and EACCES are transient too", async () => {
    assert.deepStrictEqual([...TRANSIENT_RENAME_CODES].sort(), ["EACCES", "EBUSY", "EPERM"]);
    for (const code of ["EBUSY", "EACCES"]) {
      const r = flakyRename(3, code);
      const s = fakeSleep();
      const out = await renameWithRetry("a", "b", { rename: r.fn, sleep: s.fn });
      assert.strictEqual(out.attempts, 4, `${code} should have been retried`);
    }
  });

  await check("CASE F — a real writeData()/readData() round trip still works", async () => {
    // The unit cases above all use a fake rename. This one uses the real
    // filesystem. Being honest about what it proves: with no lock contention a
    // plain rename would pass it too, so it does NOT prove the retry policy is
    // wired into writeData — it proves the wiring did not break the write.
    // CASES A-E are where the policy itself is pinned.
    const dir = await mkdtemp(path.join(tmpdir(), "leadgen-atomic-"));
    const previous = process.env.LEADGEN_DATA_DIR;
    process.env.LEADGEN_DATA_DIR = dir;
    try {
      const db = await import("../../src/lib/db");
      const data = await db.readData();
      const marker = `atomic-write-retry-${Date.now()}`;
      assert.ok(data.workspaces.length > 0, "the seed data should contain at least one workspace");
      data.workspaces[0].name = marker;
      await db.writeData(data);
      const again = await db.readData();
      assert.strictEqual(again.workspaces[0].name, marker,
        "the value written did not come back — the rename either did not happen or landed somewhere else");
    } finally {
      if (previous === undefined) delete process.env.LEADGEN_DATA_DIR;
      else process.env.LEADGEN_DATA_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  console.log("");
  console.log(`=== GOLDEN atomic-write-retry: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
