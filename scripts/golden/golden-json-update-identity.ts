/**
 * golden-json-update-identity.ts — N-DATA-2 pin (2026-08-18, CEO-loop session 7).
 *
 * THE RISK THIS PINS
 * ------------------
 * Fifteen upsert methods on the JSON substrate are written the same way: find
 * the row, create it with a carefully-chosen id if it is missing, then assign
 * the caller's whole object over the top. That last step hands across
 * EVERYTHING the caller was carrying — including `id`.
 *
 * So the id chosen on the line above is immediately overwritten by whatever the
 * caller happened to hold, and a caller holding `id: null` — an API payload, a
 * spread of a partly-filled form, a row read back from a substrate that does not
 * have the field — sets the row's id to null.
 *
 * Not hypothetical. The demo workspace's communicationSettings row was sitting
 * in .leadgen-data/app-data.json with `"id": null` while the other five settings
 * singletons had proper ids, and the JSON→Postgres migration could not plan it
 * at all: it reported `undefined cannot be created`. A row with a null id is a
 * row nothing can ever reference again.
 *
 * `createdAt` is deliberately NOT treated the same way. `input.createdAt ||
 * timestamp()` is this substrate's declared contract, repeated at roughly forty
 * sites in src/repositories/json/index.ts, and the migration depends on it: a
 * supplied creation time must win. Only an ABSENT one is dropped rather than
 * written over a real value.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — an update carrying `id: null` leaves the row's id alone. This is
 *            the exact shape that corrupted the real data file.
 *   CASE B — an update carrying a DIFFERENT id does not rename the row. Renaming
 *            an existing record is not something a settings save should be able
 *            to do by accident, and it is how one row silently becomes two.
 *   CASE C — an update carrying a real createdAt DOES apply it. Without this the
 *            substrate's stated contract would be broken in the other direction
 *            and the migration could not carry creation times across.
 *   CASE D — an update carrying NO createdAt leaves the existing one intact,
 *            rather than writing undefined over it.
 *   CASE E — ordinary fields still get through. The guard on the four cases
 *            above: a helper that ignored its whole input would pass them all.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { readData, mutateData } from "@/lib/db";

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
const WS = `ws_golden_jsonid_${RUN}`;
const ID = `aul_golden_${RUN}`;
const OLD = "2021-03-04T05:06:07.000Z";

async function main() {
  console.log("");
  console.log("=== GOLDEN json-update-identity (N-DATA-2) ===");
  console.log("");

  const repos = createRepositories("json");
  const read = async () =>
    ((await readData()).aiUsageLimits || []).find((r) => r.workspaceId === WS);

  try {
    await repos.aiUsageLimit.upsertForWorkspace(WS, { id: ID, createdAt: OLD, dailyTokenLimit: 100 });
    const seeded = await read();
    assert.ok(seeded, "setup: the row must exist before any of the cases run");
    assert.strictEqual(seeded!.id, ID, "setup: the row must be created under the id it was given");

    await check("CASE A — an update carrying id: null leaves the id alone", async () => {
      await repos.aiUsageLimit.upsertForWorkspace(WS, {
        id: null as unknown as string,
        dailyTokenLimit: 200,
      });
      const row = await read();
      assert.strictEqual(row!.id, ID,
        "a null id in the payload nulled the row's id — this is the exact corruption found in the real data file, and a row with a null id can never be referenced again");
    });

    await check("CASE B — an update carrying a different id does not rename the row", async () => {
      await repos.aiUsageLimit.upsertForWorkspace(WS, { id: `renamed_${RUN}`, dailyTokenLimit: 300 });
      const row = await read();
      assert.strictEqual(row!.id, ID,
        "an ordinary save renamed an existing row; that is how one record silently becomes two across substrates");
    });

    await check("CASE C — an update carrying a real createdAt applies it", async () => {
      const CORRECTED = "2020-01-02T03:04:05.000Z";
      await repos.aiUsageLimit.upsertForWorkspace(WS, { createdAt: CORRECTED });
      const row = await read();
      assert.strictEqual(row!.createdAt, CORRECTED,
        "`input.createdAt || timestamp()` is this substrate's declared contract and the migration depends on it — a supplied creation time has to win");
    });

    await check("CASE D — an update carrying no createdAt leaves the existing one", async () => {
      const before = (await read())!.createdAt;
      await repos.aiUsageLimit.upsertForWorkspace(WS, { dailyTokenLimit: 400 });
      const row = await read();
      assert.strictEqual(row!.createdAt, before,
        "an absent createdAt must be dropped, not written over a real value as undefined");
    });

    await check("CASE E — ordinary fields still get through", async () => {
      await repos.aiUsageLimit.upsertForWorkspace(WS, { monthlyTokenLimit: 9999 });
      const row = await read();
      assert.strictEqual(row!.monthlyTokenLimit, 9999,
        "the four cases above would all pass in a helper that ignored its input entirely; this is what rules that out");
      assert.strictEqual(row!.dailyTokenLimit, 400,
        "and an unrelated field set by an earlier write must survive");
    });
  } finally {
    await mutateData((data) => {
      data.aiUsageLimits = (data.aiUsageLimits || []).filter((r) => r.workspaceId !== WS);
      return null;
    });
  }

  console.log("");
  console.log(`=== GOLDEN json-update-identity: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
