/**
 * golden-snapshot-mapper-coverage.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Read off the live deployment's own /api/data/export, on Postgres:
 *
 *   leads[0].createdAt                  "2026-09-07T18:17:30.639Z"   ✅
 *   tickets[0].createdAt                "2026-09-07T20:05:29.840Z"   ✅
 *   agentRuns[0].createdAt              "2026-09-07T17:42:36.263Z"   ✅
 *   doNotContactRegistry[0].createdAt   {}                           ❌
 *
 * Eleven populated tables came back that way, and one of them is the COMPLIANCE
 * record — where "when did this person opt out?" is the question an audit asks,
 * and whose whole purpose is to survive everything else being deleted.
 *
 * The cause: `PrismaRepositories.readAll()` builds its snapshot by mapping each
 * collection through its mapper, except a handful written as a raw
 * `x as AppData["x"]` cast. A cast changes the TYPE and not the VALUE, so the
 * Postgres row went out as-is: `createdAt` stayed a Date-like object with no
 * usable JSON form, and nullable columns stayed `null` where the domain type
 * says `undefined`. `mapDnc` existed the whole time and the repository read
 * path already used it — only the snapshot skipped it.
 *
 * This is the session's recurring family in its purest form: the Prisma path
 * quietly disagreeing with the JSON path, while the goldens run on JSON.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the compliance table is mapped, not cast. This is the live bug.
 *
 *   CASE B — a stored opt-out reads back with a createdAt that is an ISO string
 *   and parses as a date, which is what the export promised and did not deliver.
 *
 *   CASE C — no collection in the snapshot is passed through raw. Eleven populated
 *   tables shipped "createdAt": {}, not one; a fix for a single row that leaves
 *   the next ten waiting is not a fix. Every entry now goes through either its
 *   own mapper or the shared datesToIso pass.
 *
 *   CASE D — the JSON substrate produces that same shape, so what CASE B asserts
 *   is what the rest of the product already expects — and is exactly why the
 *   Postgres divergence went unnoticed for so long.
 *
 *   CASE E — the CASE C scanner works in both directions: it catches a raw cast
 *   put back, and does not fire on either legitimate form of the fix.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readSource } from "./_helpers/read-source";
import { createJsonRepos } from "./_helpers/provider";
import { registerDoNotContact } from "@/lib/dnc-registry";

type Case = { name: string; fn: () => Promise<void> | void };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void> | void) { cases.push({ name, fn }); }

const PRISMA = readSource("src/repositories/prisma/index.ts");

/** The `readAll()` snapshot literal — the only place these casts live. */
function snapshotBlock(): string {
  const start = PRISMA.indexOf("doNotContactRegistry:");
  assert.ok(start > 0, "could not locate the readAll snapshot — this golden's source parse needs updating");
  // Walk out to a generous window around the snapshot object literal.
  const from = PRISMA.lastIndexOf("return {", start);
  const to = PRISMA.indexOf("\n      };", start);
  assert.ok(from > 0 && to > from, "could not bound the readAll snapshot literal");
  return PRISMA.slice(from, to);
}

const NEWLINE = String.fromCharCode(10);

test("CASE A — the do-not-contact registry is mapped, not cast", () => {
  const block = snapshotBlock();
  const line = block.split("\n").find((l) => l.trim().startsWith("doNotContactRegistry:")) || "";
  assert.ok(!/as AppData\["doNotContactRegistry"\]/.test(line),
    `the compliance record exported createdAt as {} on the live deployment — got: ${line.trim()}`);
  assert.ok(/\.map\(mapDnc\)/.test(line),
    `it must go through the mapper the repository already uses — got: ${line.trim()}`);
});

test("CASE B — a stored opt-out reads back with a usable timestamp", async () => {
  const repos = createJsonRepos();
  const workspaceId = `ws_snap_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: "Snapshot golden", status: "active" });
  await registerDoNotContact(workspaceId, { phone: "+1 555 0999", reason: "Customer requested opt-out via WhatsApp." }, repos);

  const [entry] = await repos.doNotContact.listByWorkspace(workspaceId);
  assert.ok(entry, "the registration must be readable back");
  assert.strictEqual(typeof entry.createdAt, "string",
    "createdAt is an ISO string in the domain type — the live export showed {} because the Postgres row was passed through raw");
  assert.ok(!Number.isNaN(Date.parse(entry.createdAt)), `and it must parse as a date: ${entry.createdAt}`);
});

test("CASE C — no collection in the snapshot is passed through raw", () => {
  // The invariant, stated once: every collection goes through its own mapper or
  // through datesToIso. A bare `x as AppData["x"]` is the shape that put eleven
  // populated tables into the owner's backup with "createdAt": {}.
  const raw = snapshotBlock()
    .split(NEWLINE)
    .filter((line) => /^\s*[A-Za-z0-9_]+:\s*[A-Za-z0-9_]+ as (?:unknown as )?AppData\[/.test(line))
    .map((line) => line.trim());
  assert.deepStrictEqual(raw, [],
    "a cast changes the type and not the value, so a Postgres row goes out where a domain object was promised");
});

test("CASE D — the JSON substrate produces the shape CASE B asserts", async () => {
  const repos = createJsonRepos();
  const workspaceId = `ws_snap2_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: "Snapshot golden 2", status: "active" });
  await registerDoNotContact(workspaceId, { email: "opt@example.com", reason: "Customer requested opt-out." }, repos);

  const snapshot = await repos.readAll?.();
  const rows = (snapshot?.doNotContactRegistry || []).filter((row) => row.workspaceId === workspaceId);
  assert.strictEqual(rows.length, 1, "the snapshot both substrates share must contain the entry");
  assert.strictEqual(typeof rows[0].createdAt, "string",
    "JSON has always produced a string here — which is exactly why the Postgres divergence went unnoticed");
});

test("CASE E — the scanner would catch this coming back", () => {
  const RAW = /^\s*[A-Za-z0-9_]+:\s*[A-Za-z0-9_]+ as (?:unknown as )?AppData\[/;
  const reintroduced = '        doNotContactRegistry: doNotContactRegistry as AppData["doNotContactRegistry"],';
  assert.ok(RAW.test(reintroduced), "a scanner that cannot fail is not a test");

  const allowed = [
    '        doNotContactRegistry: doNotContactRegistry.map(mapDnc),',
    '        salesSettings: datesToIso<NonNullable<AppData["salesSettings"]>[number]>(salesSettings as unknown as Record<string, unknown>[]),',
    '        leads: leads.map(mapLead),',
  ];
  const falsePositives = allowed.filter((line) => RAW.test(line));
  assert.deepStrictEqual(falsePositives, [],
    "both real fixes — a bespoke mapper and the shared date pass — must read as correct");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-snapshot-mapper-coverage — N-BUG (the compliance record exported createdAt as {})\n");
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
  console.log(`snapshot-mapper-coverage: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
