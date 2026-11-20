/**
 * golden-migration-rules-policy.ts — N-DATA-2 pin (2026-08-18, CEO-loop
 * session 6).
 *
 * WHAT THIS IS FOR, AND HOW IT DIFFERS FROM golden-migration-plan-safety.
 * -----------------------------------------------------------------------
 * `golden-migration-plan-safety.ts` pins the ENGINE: given rules and two
 * snapshots, does buildMigrationPlan classify rows correctly and refuse the
 * ones it is not allowed to replace. It uses fixture rules, so it says nothing
 * about the rules the real migration actually runs with.
 *
 * This golden pins the REGISTRY — `MIGRATION_RULES`, the real object the dry
 * run and the write phase both use. A perfect engine driven by a wrong registry
 * still destroys the right data.
 *
 * THE DEFECT THAT CAUSED IT TO BE WRITTEN
 * ---------------------------------------
 * `userCredentials` was declared `skip`, with the reason "password hashes; the
 * demo login is created by the seeder, not migrated". The second half of that
 * sentence was false. Checked in SQL against the ship database on 2026-08-18:
 *
 *     select id, email, user_id from user_credentials;   -> (0 rows)
 *     select id, user_id, email from workspace_members;  -> (0 rows)
 *
 * No seeder had ever created a credential on Postgres. The rule was skipping
 * the only login in existence on the grounds that something else would provide
 * one, and nothing else did. Shipping that meant shipping a database nobody
 * could log in to: `findCredentialByEmail` (prisma/index.ts:3223) resolves the
 * `user_credentials` row FIRST and returns null when there is none, for every
 * address, in every workspace. The product would have come up at a login screen
 * that could not be passed.
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — every collection that opts into overwrite carries a written
 *            reason. An opt-in with no reason is a decision nobody can review,
 *            which is the same as no decision.
 *   CASE B — every `skip` carries a written reason, for the same purpose: the
 *            report has to be able to say WHY something was left behind.
 *   CASE C — THE IMPORTANT ONE. `userCredentials` is not `skip`. This is the
 *            regression guard for the defect above.
 *   CASE D — `userCredentials` does NOT opt into overwrite. It is the
 *            collection that decides who can log in; if a credential already
 *            exists on the far side the plan must stop and ask, never replace.
 *   CASE E — `userCredentials` is `repository`, not `snapshot`. persistSnapshot
 *            writes 15 collections and userCredential is not one of them, so a
 *            `snapshot` policy here would drop the only login WITHOUT AN ERROR
 *            — the silent-vanish failure warned about at prisma/index.ts:3162.
 *   CASE F — the set of collections declared `snapshot` is EXACTLY the set
 *            persistSnapshotInner actually writes. Not a subset, not a
 *            superset. A collection wrongly marked `snapshot` loses its rows
 *            silently; one wrongly left out gets written row-by-row instead of
 *            in the single transaction, which is slower but not wrong — so the
 *            equality is asserted in both directions and the failure message
 *            says which direction broke.
 *   CASE G — no rule is both `skip` and `allowOverwrite`. Meaningless in
 *            combination, and a sign somebody edited one half of a decision.
 *   CASE H — `users` is opted into overwrite. Pins the session-6 decision so
 *            that flipping it back is a deliberate act with a failing test
 *            attached, not a quiet edit.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { MIGRATION_RULES } from "@/migration/migration-rules";
import { createJsonRepos } from "./_helpers/provider";

/**
 * Every collection a workspace snapshot can carry, read off a real snapshot.
 *
 * Hand-listing them here would reproduce the exact omission CASE I exists to
 * catch, one level up.
 */
async function snapshotCollections(): Promise<string[]> {
  const repos = createJsonRepos();
  const id = `ws_rules_${Date.now()}`;
  await repos.workspace.create({ id, name: "migration-rules golden", status: "active" });
  const snapshot = (await repos.readAll?.()) || {};
  return Object.keys(snapshot).filter((k) => Array.isArray((snapshot as Record<string, unknown>)[k]));
}

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

/**
 * The collections persistSnapshotInner actually writes, transcribed from the
 * batchUpsert calls at src/repositories/prisma/index.ts:3438 and mapped from
 * Prisma model name to snapshot key. Transcribed from the CALLS, not from the
 * comment above them — that comment said "14 collections" and listed 15.
 */
const PERSIST_SNAPSHOT_WRITES = [
  "knowledgeQuestionAnswers",
  "auditLogs",
  "eventLogs",
  "unknownQuestions",
  "knowledgeEntries",
  "humanFallbackTasks",
  "processedWebhookMessageIds",
  "knowledgeExtractionRuns",
  "knowledgeExtractionBatches",
  "knowledgeExtractionSourceBundles",
  "knowledgeExtractionSources",
  "knowledgeBaseDocuments",
  "knowledgeBaseChunks",
  "users",
  "workspaceMembers",
].sort();

async function main() {
  const SNAPSHOT_COLLECTIONS = await snapshotCollections();
  console.log("GOLDEN migration-rules-policy — N-DATA-2 registry\n");

  const entries = Object.entries(MIGRATION_RULES);

  check("CASE A — every overwrite opt-in has a written reason", () => {
    const bad = entries
      .filter(([, r]) => r.allowOverwrite === true)
      .filter(([, r]) => !r.reason || r.reason.trim().length === 0)
      .map(([name]) => name);
    assert.deepStrictEqual(bad, [],
      `These collections may replace live Postgres rows without saying why: ${bad.join(", ")}`);
  });

  check("CASE B — every skip has a written reason", () => {
    const bad = entries
      .filter(([, r]) => r.policy === "skip")
      .filter(([, r]) => !r.reason || r.reason.trim().length === 0)
      .map(([name]) => name);
    assert.deepStrictEqual(bad, [],
      `These collections are left behind with no stated reason: ${bad.join(", ")}`);
  });

  check("CASE C — userCredentials is NOT skipped (the login has to travel)", () => {
    const rule = MIGRATION_RULES.userCredentials;
    assert.ok(rule, "userCredentials has no rule at all — it would be reported as undeclared");
    assert.notStrictEqual(rule.policy, "skip",
      "userCredentials is skipped again. Postgres held 0 credential rows on 2026-08-18, " +
      "so skipping it ships a database whose login screen cannot be passed.");
  });

  check("CASE D — userCredentials does not opt into overwrite", () => {
    assert.notStrictEqual(MIGRATION_RULES.userCredentials.allowOverwrite, true,
      "The collection that decides who can log in must stop and ask before replacing a row.");
  });

  check("CASE E — userCredentials moves by repository, not by snapshot", () => {
    assert.strictEqual(MIGRATION_RULES.userCredentials.policy, "repository",
      "persistSnapshot does not write userCredential; a snapshot policy here drops the login silently.");
    assert.ok(!PERSIST_SNAPSHOT_WRITES.includes("userCredentials"),
      "sanity: userCredentials must not be in the persistSnapshot write list");
  });

  check("CASE F — the snapshot set is exactly what persistSnapshot writes", () => {
    const declared = entries.filter(([, r]) => r.policy === "snapshot").map(([n]) => n).sort();
    const wouldVanish = declared.filter((c) => !PERSIST_SNAPSHOT_WRITES.includes(c));
    const missedOut = PERSIST_SNAPSHOT_WRITES.filter((c) => !declared.includes(c));
    assert.deepStrictEqual(wouldVanish, [],
      `Declared snapshot but persistSnapshot never writes them — these rows would vanish with no error: ${wouldVanish.join(", ")}`);
    assert.deepStrictEqual(missedOut, [],
      `persistSnapshot writes these but the registry routes them elsewhere: ${missedOut.join(", ")}`);
    assert.strictEqual(declared.length, 15, `Expected 15 snapshot collections, got ${declared.length}`);
  });

  check("CASE G — nothing is both skipped and overwrite-approved", () => {
    const bad = entries
      .filter(([, r]) => r.policy === "skip" && r.allowOverwrite === true)
      .map(([name]) => name);
    assert.deepStrictEqual(bad, [], `Contradictory rules: ${bad.join(", ")}`);
  });

  check("CASE H — users is opted into overwrite (session-6 decision)", () => {
    const rule = MIGRATION_RULES.users;
    assert.strictEqual(rule.allowOverwrite, true,
      "user_owner on Postgres is placeholder seed identity (owner@demo.local / 'Demo Owner') " +
      "and must be replaced by the real demo identity. Login keys on user_credentials.email, " +
      "not users.email, so this cannot lock anyone out.");
  });

  check("CASE I — no collection is undeclared that was not already known to be", () => {
    // 2026-09-08. An undeclared collection blocks the ENTIRE plan — by design,
    // and the design is right: guessing how rows move is how data is lost. The
    // cost is that the omission is invisible until a row exists. That is what
    // happened: `productSettings` had no rule, and the first migration run with
    // a productSettings row died on "PLAN IS BLOCKED", having written nothing.
    // `salesSettings` had the same omission and was one row away from the same
    // outcome; its three sibling settings tables were all declared.
    //
    // KNOWN_UNDECLARED is the set that still has no rule. Each is a decision
    // nobody has made yet — NOT a decision to skip it. This case fails when a
    // FOURTEENTH appears, so a collection added to the product cannot silently
    // join them. Removing one is always allowed and is reported, because a list
    // of outstanding work that never shrinks on paper is worse than no list.
    //
    // The collection names come from a real snapshot rather than a hand-kept
    // array here, because a hand-kept array is the same omission one level up.
    const KNOWN_UNDECLARED = [
      "businessExtractions",
      "campaignMetrics",
      "conversationPolicies",
      "crawlJobs",
      "crawlPages",
      "escalationRules",
      "interactions",
      "jobRuns",
      "knowledgeBaseQueryLogs",
      "leadPhoneNumbers",
      "llmProviderCredentials",
      "pendingSettingsDrafts",
      "providerAccounts",
    ];
    const declared = new Set(Object.keys(MIGRATION_RULES));
    const undeclared = SNAPSHOT_COLLECTIONS.filter((c) => !declared.has(c));

    const unexpected = undeclared.filter((c) => !KNOWN_UNDECLARED.includes(c));
    assert.deepStrictEqual(unexpected, [],
      "a collection with no migration rule blocks the whole plan the first time it holds a row — " +
      `decide how ${unexpected.join(", ")} moves, or add it to KNOWN_UNDECLARED with that decision pending`);

    const fixed = KNOWN_UNDECLARED.filter((c) => declared.has(c));
    if (fixed.length > 0) {
      console.log(`     note: now declared — remove from KNOWN_UNDECLARED: ${fixed.join(", ")}`);
    }

    for (const settings of ["salesSettings", "productSettings", "policySettings", "communicationSettings"]) {
      assert.ok(declared.has(settings),
        `${settings} must be declared — all four business-settings tables travel together`);
    }
  });

  console.log("");
  console.log(`=== GOLDEN migration-rules-policy: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

void main();
