// PRISMA_GOLDEN
/**
 * golden-seed-refuses-migrated-data.ts — N-SEED-2 pin (2026-08-19, CEO-loop session 7).
 *
 * THE RISK THIS PINS
 * ------------------
 * `scripts/seed-demo-prisma.ts` writes fixed `seed_*` rows. The JSON->Postgres
 * migration writes the real demo data set as `*_demo_*` rows. Both want order
 * number 1 in `workspace_demo`, and `(workspace_id, order_number)` is UNIQUE,
 * so running the seeder against a migrated database died mid-transaction:
 *
 *     Unique constraint failed on the fields: (`workspace_id`,`order_number`)
 *
 * — part-written, with nothing in the message pointing at the cause. Since D3
 * the ship substrate IS Postgres and the demo data IS migrated, so this is the
 * default state of the database anyone would run the seeder against.
 *
 * WHAT MAKES THIS GOLDEN HONEST
 * -----------------------------
 * "It refused" is trivially satisfiable by a guard that refuses always — and
 * such a guard would break the seeder's real job (filling an EMPTY database for
 * the smoke) while passing a naive test. So the pin is in two halves:
 *
 *   CASE A — the classifier says "not ours" for migrated ids, and
 *   CASE B — the classifier says "ours" for a workspace holding only seed_* rows.
 *
 * CASE B is the one that fails if somebody "fixes" the guard by hard-refusing.
 *
 * CASES C-E then prove the guard is actually wired into the real script, by
 * running it as a child process against the real database: exit code 1, a
 * message a human can act on, and — the part that matters — NOT ONE ROW
 * WRITTEN. A refusal that has already written half the rows is not a refusal.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — findForeignRows() flags migrated rows, labelled by kind and id.
 *   CASE B — findForeignRows() returns [] when every row is a seed_* row.
 *   CASE C — the real seeder exits 1 against a database holding foreign rows.
 *     The golden CREATES that condition if the database does not already have
 *     it (2026-09-08), so the result describes the guard rather than whatever
 *     happens to be in the operator's database.
 *   CASE D — its message names the workspace, the count, and a way forward.
 *   CASE E — the row count in workspace_demo is UNCHANGED by the refused run.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { findForeignRows } from "../lib/foreign-rows";

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

const WS = "workspace_demo";

async function countRows() {
  const { createRepositories } = await import("@/repositories");
  const repos = createRepositories();
  const [orders, quotes, leads] = await Promise.all([
    repos.order.listByWorkspace(WS),
    repos.quote.listByWorkspace(WS),
    repos.lead.listLeads(WS),
  ]);
  return { orders: orders.length, quotes: quotes.length, leads: leads.length };
}

/**
 * Make sure workspace_demo holds a row the seeder did not write, and report
 * whether this golden was the one that put it there.
 *
 * Returns the injected lead id (so it can be removed) or undefined when the
 * database already satisfied the precondition on its own.
 */
async function ensureForeignRowPresent(): Promise<string | undefined> {
  const { createRepositories } = await import("@/repositories");
  const repos = createRepositories();

  // The workspace itself may not exist on a fresh database. The seeder would
  // create it; the guard reads rows underneath it, so it has to exist first.
  const workspace = await repos.workspace.getById(WS);
  if (!workspace) {
    await repos.workspace.create({ id: WS, name: "Demo workspace", status: "active" });
  }

  const [orders, quotes, leads] = await Promise.all([
    repos.order.listByWorkspace(WS),
    repos.quote.listByWorkspace(WS),
    repos.lead.listLeads(WS),
  ]);
  if (findForeignRows({ orders, quotes, leads }).length > 0) return undefined;

  const lead = await repos.lead.createLead({
    workspaceId: WS,
    companyName: "Precondition Co (golden-seed-refuses-migrated-data)",
    status: "prospected",
  });
  // Belt and braces: the whole point is that this id is NOT a seed_* id, and a
  // repository that stamped one would silently disarm the precondition.
  assert.ok(
    !lead.id.startsWith("seed_"),
    `the injected row must read as foreign, got id ${lead.id}`,
  );
  return lead.id;
}

async function removeForeignRow(leadId: string): Promise<void> {
  const { createRepositories } = await import("@/repositories");
  await createRepositories().lead.deleteById(WS, leadId);
}

async function main() {
  console.log("");
  console.log("=== GOLDEN seed-refuses-migrated-data (N-SEED-2) ===");
  console.log("");

  await check("CASE A — migrated rows are flagged as not ours", () => {
    const foreign = findForeignRows({
      orders: [{ id: "order_demo_1" }, { id: "seed_order_1" }],
      quotes: [{ id: "quote_demo_1" }],
      leads: [{ id: "lead_review" }, { id: "seed_lead_hot" }],
    });
    assert.deepStrictEqual(foreign, ["order order_demo_1", "quote quote_demo_1", "lead lead_review"],
      "the seeder needs to name what it found, by kind and id — a bare count leaves the reader guessing whose data it is");
  });

  await check("CASE B — a workspace holding only seed_* rows is ours to overwrite", () => {
    const foreign = findForeignRows({
      orders: [{ id: "seed_order_1" }, { id: "seed_order_2" }],
      quotes: [{ id: "seed_quote_1" }],
      leads: [{ id: "seed_lead_hot" }, { id: "seed_lead_dnc" }],
    });
    assert.deepStrictEqual(foreign, [],
      "THIS is the case a blanket refusal breaks: the seeder's actual job is to fill an empty or seed-only database, and a guard that refuses there passes CASE A while making the script useless");
  });

  // PRECONDITION — build the situation under test instead of inheriting it.
  //
  // 2026-09-08. CASES C-E need workspace_demo to contain at least one row the
  // seeder did not write. This golden never created that; it relied on the
  // operator's database already holding the migrated demo data. That is true on
  // the machine it was written on and false everywhere else — on any fresh
  // Postgres (a new laptop, a rebuilt container, CI) the seeder legitimately
  // succeeds, and CASE C reports "the seeder exited 0" as though the guard had
  // been removed. A golden that reads a green or red result off ambient data
  // is measuring the machine, not the code.
  //
  // So: if the workspace already holds foreign rows, use them and touch
  // nothing. If it does not, put ONE row there and take it out again in the
  // `finally` below, whatever the outcome.
  const injectedLeadId = await ensureForeignRowPresent();

  const before = await countRows();
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("npx", ["tsx", "scripts/seed-demo-prisma.ts"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, PERSISTENCE_PROVIDER: "prisma" },
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    exitCode = e.status ?? -1;
    stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  await check("CASE C — the real seeder exits non-zero against the migrated database", () => {
    assert.strictEqual(exitCode, 1,
      `the seeder exited ${exitCode}; a guard that is not wired into main() proves nothing, and exit 0 here means a caller's script would carry on as if seeding had worked. Output was:\n${stdout}`);
  });

  await check("CASE D — the refusal says what it found and how to proceed", () => {
    assert.ok(stdout.includes("Refusing to seed"), "the refusal must be recognisable in a log");
    assert.ok(stdout.includes(WS), "it must name the workspace it refused on");
    assert.ok(/\d+ rows/.test(stdout), "it must say how many rows it found rather than just that it found some");
    assert.ok(stdout.includes("--force"), "a refusal with no way through is its own kind of unhelpful");
  });

  await check("CASE E — nothing was written by the refused run", async () => {
    const after = await countRows();
    assert.deepStrictEqual(after, before,
      `row counts changed across a REFUSED run (before ${JSON.stringify(before)}, after ${JSON.stringify(after)}) — the guard must run before the first write, or it is only a warning with extra steps`);
  });

  // Leave the database as we found it.
  //
  // This exists because of what happened the first time this golden was
  // mutation-tested: unwiring the guard made CASE E fail, correctly — and the
  // now-unguarded seeder had written six seed_* rows into the ship database on
  // its way to that failure. Proving a guard works should not require the
  // person doing it to remember to clean up afterwards, so the golden does it.
  const after = await countRows();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    console.log("");
    console.log("  [cleanup] the run under test wrote rows — purging seed_* debris");
    execFileSync("npx", ["tsx", "scripts/purge-seed-demo-rows.ts", "--apply"], {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, PERSISTENCE_PROVIDER: "prisma" },
    });
  }

  if (injectedLeadId) {
    // Put the database back exactly as it was found, pass or fail.
    await removeForeignRow(injectedLeadId);
    console.log("  [cleanup] removed the injected precondition row");
  }

  console.log("");
  console.log(`=== GOLDEN seed-refuses-migrated-data: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
