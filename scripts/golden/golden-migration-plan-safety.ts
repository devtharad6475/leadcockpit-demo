/**
 * golden-migration-plan-safety.ts — N-DATA-2 pin (2026-08-18, CEO-loop session 5).
 *
 * THE RISK THIS PINS
 * ------------------
 * Moving the demo dataset from the JSON store to Postgres is NOT an import into
 * empty space. Both substrates use the SAME workspace id (`workspace_demo`,
 * src/lib/db.ts:38) and therefore the same row ids, so a replay upserts onto
 * live rows. The failure mode is silent: a Postgres row is replaced by a JSON
 * row of the same id, the migration reports success, and nothing looks wrong
 * until somebody goes looking for the row that used to be there.
 *
 * I originally wrote the risk down as "re-parenting" — different workspace ids
 * needing remapping — and that was WRONG; the ids are already the same. The
 * real risk is the opposite one (collision, not mismatch), which is why this
 * golden is about overwrite policy and not about id translation.
 *
 * WHY IT RUNS OFFLINE. `buildMigrationPlan` is pure: two snapshots in, a
 * description of the intended writes out. No database, no file system, no
 * clock. That is deliberate — it means the decision about what may be replaced
 * is pinned by fixtures BEFORE the executor touches the ship database, rather
 * than being discovered by running it.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE the executor existed):
 *
 *   CASE A — a row whose id is absent from Postgres is a CREATE. The bulk of
 *            the real move (all 523 knowledge answers) is this case, so if it
 *            were wrong nothing else here would matter.
 *   CASE B — a row identical on both sides is IDENTICAL, not OVERWRITE. Without
 *            this, re-running the migration would report the whole dataset as
 *            being rewritten and the report would be unreadable.
 *   CASE C — a row that differs is OVERWRITE **and names the differing fields**.
 *            A plan that says "1 overwrite" without saying what changes cannot
 *            be reviewed by a human, which is the only reason the plan exists.
 *   CASE D — THE IMPORTANT ONE. An overwrite in a collection that has not opted
 *            in marks that collection `blocked` and the whole plan `blocked`.
 *            Default-deny: a collection must say in writing that its Postgres
 *            rows may be replaced.
 *   CASE E — the same overwrite in a collection that HAS opted in is not
 *            blocked. Proves CASE D is a real policy check and not a function
 *            that always returns "blocked".
 *   CASE F — a row that exists ONLY in Postgres is reported as POSTGRES_ONLY and
 *            never appears as anything else. A migration that removes rows it
 *            did not bring is a destructive operation wearing an import's
 *            clothes.
 *   CASE G — a JSON collection with NO declared rule is reported as undeclared
 *            and blocks the plan. Refusing to guess is the whole point: a
 *            default here is how a collection gets migrated by accident.
 *   CASE H — a `skip` rule produces no row plans and keeps its reason, so the
 *            report can say why something was left behind.
 *   CASE I — a row differing ONLY in `updatedAt` is IDENTICAL. Every write moves
 *            that field; counting it would mark all 1,268 rows as changed and
 *            drown the handful that genuinely differ.
 *   CASE J — a field present in POSTGRES but missing from JSON is reported as
 *            UNMIGRATABLE: visible, but not blocking.
 *
 *            REVISED 2026-08-18 (N-DATA-2). This case used to require such a
 *            field to make the row an OVERWRITE, on the grounds that it is
 *            the direction that LOSES data and must not be invisible. The
 *            second half of that still holds and is still asserted below —
 *            the field is named on the row and printed in the report. What
 *            was wrong was making it block, because the migration cannot
 *            resolve it: a field the JSON row does not have is not part of
 *            the write, so Postgres keeps its value and the next re-plan
 *            reports the identical difference forever. Measured on the real
 *            run: 0 write errors, 844 rows correct, and 414 rows still
 *            'unmigrated' — all of them Postgres column defaults (false, {})
 *            that the JSON source never had an opinion about. A verifier
 *            whose success condition is unreachable stops being read, which
 *            is precisely why CASE I excludes updatedAt.
 *
 *   CASE K — the guard on CASE J: a field JSON has and Postgres LACKS is still
 *            a blocking overwrite. That direction the migration CAN fix, so
 *            failing to is a real failure. Without this, CASE J's relaxation
 *            would be indistinguishable from switching the check off.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { buildMigrationPlan, changedFields, type CollectionRule } from "@/migration/json-to-postgres-plan";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

const RULES: Record<string, CollectionRule> = {
  leads: { policy: "repository" },
  workspaces: { policy: "repository", allowOverwrite: true, reason: "test fixture: opted in" },
  knowledgeQuestionAnswers: { policy: "snapshot" },
  userCredentials: { policy: "skip", reason: "credentials are not demo data" },
};

function outcomeOf(plan: ReturnType<typeof buildMigrationPlan>, collection: string, id: string) {
  const c = plan.collections.find((x) => x.collection === collection);
  assert.ok(c, `collection ${collection} missing from plan`);
  const row = c.rows.find((r) => r.id === id);
  assert.ok(row, `row ${id} missing from ${collection} plan`);
  return row;
}

function main() {
  console.log("GOLDEN migration-plan-safety — N-DATA-2 overwrite policy\n");

  const json = {
    leads: [
      { id: "lead_new", companyName: "Aarna Bridal Studio" },
      { id: "lead_same", companyName: "Meera Ethnic Wear" },
      { id: "lead_diff", companyName: "Meghdoot Zari", city: "Surat" },
      { id: "lead_touched", companyName: "Bharat Textiles", updatedAt: "2026-08-18T00:00:00.000Z" },
      { id: "lead_missing_field", companyName: "Patel Fabrics" },
    ],
    workspaces: [{ id: "workspace_demo", name: "Meghdoot Zari" }],
    knowledgeQuestionAnswers: [{ id: "kqa_1", answer: "5 kg per shade" }],
    userCredentials: [{ id: "cred_tour", passwordHash: "irrelevant" }],
  };

  const postgres = {
    leads: [
      { id: "lead_same", companyName: "Meera Ethnic Wear" },
      { id: "lead_diff", companyName: "Meghdoot Zari", city: "Mumbai" },
      { id: "lead_touched", companyName: "Bharat Textiles", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "lead_missing_field", companyName: "Patel Fabrics", assignedTo: "user_owner" },
      { id: "seed_lead_hot", companyName: "Seeded by seed-demo-prisma" },
    ],
    workspaces: [{ id: "workspace_demo", name: "Demo Workspace" }],
    knowledgeQuestionAnswers: [],
    userCredentials: [],
  };

  const plan = buildMigrationPlan(json, postgres, RULES);

  check("CASE A — id absent from Postgres is a CREATE", () => {
    assert.strictEqual(outcomeOf(plan, "leads", "lead_new").outcome, "create");
    assert.strictEqual(outcomeOf(plan, "knowledgeQuestionAnswers", "kqa_1").outcome, "create");
  });

  check("CASE B — identical row is IDENTICAL, not OVERWRITE", () => {
    assert.strictEqual(outcomeOf(plan, "leads", "lead_same").outcome, "identical");
  });

  check("CASE C — differing row is OVERWRITE and names the changed fields", () => {
    const row = outcomeOf(plan, "leads", "lead_diff");
    assert.strictEqual(row.outcome, "overwrite");
    assert.deepStrictEqual(row.changedFields, ["city"],
      `Expected the plan to name 'city' as the difference, got ${JSON.stringify(row.changedFields)}`);
  });

  check("CASE D — overwrite in a collection that has NOT opted in blocks the plan", () => {
    const leads = plan.collections.find((c) => c.collection === "leads")!;
    assert.strictEqual(leads.allowOverwrite, false, "leads must default to deny");
    assert.strictEqual(leads.blocked, true, "leads has an overwrite and no opt-in, so it must be blocked");
    assert.strictEqual(plan.blocked, true, "a blocked collection must block the whole plan");
  });

  check("CASE E — the same overwrite in a collection that HAS opted in is allowed", () => {
    const ws = plan.collections.find((c) => c.collection === "workspaces")!;
    assert.strictEqual(outcomeOf(plan, "workspaces", "workspace_demo").outcome, "overwrite",
      "the workspace name genuinely differs between substrates — that is the real case");
    assert.strictEqual(ws.blocked, false, "workspaces opted in, so it must NOT be blocked");
  });

  check("CASE F — a Postgres-only row is POSTGRES_ONLY and is never rewritten", () => {
    const row = outcomeOf(plan, "leads", "seed_lead_hot");
    assert.strictEqual(row.outcome, "postgres_only");
    const leads = plan.collections.find((c) => c.collection === "leads")!;
    assert.strictEqual(leads.counts.postgres_only, 1);
    assert.ok(!leads.rows.some((r) => r.id === "seed_lead_hot" && r.outcome !== "postgres_only"),
      "a Postgres-only row must not also appear as create/overwrite");
  });

  check("CASE G — an undeclared collection is reported and blocks the plan", () => {
    const withExtra = buildMigrationPlan({ ...json, orders: [{ id: "order_1" }] }, postgres, RULES);
    assert.deepStrictEqual(withExtra.undeclared, ["orders"],
      `Expected 'orders' to be undeclared, got ${JSON.stringify(withExtra.undeclared)}`);
    assert.strictEqual(withExtra.blocked, true, "an undeclared collection must block the plan");
    assert.ok(!withExtra.collections.some((c) => c.collection === "orders"),
      "an undeclared collection must not be given a default plan");
  });

  check("CASE H — a skip rule plans no rows and keeps its reason", () => {
    const creds = plan.collections.find((c) => c.collection === "userCredentials")!;
    assert.strictEqual(creds.policy, "skip");
    assert.strictEqual(creds.rows.length, 0);
    assert.strictEqual(creds.reason, "credentials are not demo data");
  });

  check("CASE I — a row differing only in updatedAt is IDENTICAL", () => {
    assert.strictEqual(outcomeOf(plan, "leads", "lead_touched").outcome, "identical",
      "updatedAt moves on every write; counting it would mark the whole dataset as changed");
    assert.deepStrictEqual(changedFields({ a: 1, updatedAt: "x" }, { a: 1, updatedAt: "y" }), []);
  });

  check("CASE J — a field Postgres has and JSON lacks is UNMIGRATABLE, not blocking", () => {
    const row = outcomeOf(plan, "leads", "lead_missing_field");
    assert.strictEqual(row.outcome, "identical",
      "the migration cannot write a field the JSON row does not have, so the row is at its fixpoint and must not block");
    assert.deepStrictEqual(row.unmigratableFields, ["assignedTo"],
      "…but it must still be NAMED — losing sight of it is the failure this case was written for");
    assert.ok(!(row.changedFields ?? []).includes("assignedTo"),
      "an unmigratable field must not also be counted as a writable change");
  });

  check("CASE K — a field JSON has and Postgres lacks is STILL a blocking overwrite", () => {
    // The direction CASE J relaxed is the one the migration cannot fix. This is
    // the other direction, which it can — so it must still block.
    const p2 = buildMigrationPlan(
      { leads: [{ id: "l1", city: "Surat" }] },
      { leads: [{ id: "l1" }] },
      { leads: { policy: "repository" } },
    );
    const row = outcomeOf(p2, "leads", "l1");
    assert.strictEqual(row.outcome, "overwrite",
      "a field the migration CAN write and has not written is a real, blocking difference");
    assert.deepStrictEqual(row.changedFields, ["city"]);
    assert.strictEqual(p2.blocked, true);
  });

  console.log("");
  console.log(`=== GOLDEN migration-plan-safety: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
