/**
 * golden-conflict-resolve-durability.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * resolveSettingsConflict marked the conflict resolved FIRST and applied the
 * value afterwards. When the write threw, the operator was left with the worst
 * possible state: the review card gone from the queue, and the setting never
 * written. The product reported "resolved" for a business policy that did not
 * exist anywhere, and nothing would ever surface it again.
 *
 * Measured on the live deployment. A Date-serialization fault made the second
 * write to a settings area fail:
 *
 *   Invalid `prisma.policySettings.upsert()` invocation:
 *   Invalid value for argument `createdAt` ...
 *
 * paymentPolicy 500'd three times. Afterwards all five conflicts read
 * `resolved`, `openConflicts: 0` — and the policy_settings row had no
 * paymentPolicy. The operator had approved the company's payment terms and the
 * company had no payment terms.
 *
 * This is separate from the serialization bug that exposed it. Any failure in
 * the write — a dropped connection, a constraint, a future schema change —
 * produced the same silent loss.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — a successful resolution writes the setting AND marks the conflict
 *   resolved. The normal path must be unchanged.
 *
 *   CASE B — when the settings write fails, the call rejects and the conflict
 *   is STILL open. An open conflict is the state that tells the truth: the
 *   operator sees the card again and can retry.
 *
 *   CASE C — the failure must not half-apply. Nothing is recorded as resolved,
 *   and the resolution field stays empty, so a later retry is a clean decision
 *   rather than an edit of a phantom one.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { resolveSettingsConflict } from "@/services/ExtractionRoutingService";
import { createJsonRepos } from "./_helpers/provider";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_conflictdur_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const EXTRACTED = "The company accepts credit cards, wire transfers, and Net-30 terms.";

async function seedConflict(repos: ReturnType<typeof createJsonRepos>, ws: string) {
  return repos.settingsConflict.create(ws, {
    settingsArea: "policy",
    fieldKey: "paymentPolicy",
    existingValue: "",
    extractedValue: EXTRACTED,
    extractedSource: "golden",
    status: "open",
  });
}

test("CASE A — a successful resolution writes the setting and marks the conflict resolved", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  const conflict = await seedConflict(repos, WS);

  await resolveSettingsConflict(WS, conflict.id, "use_extracted", undefined, undefined, repos);

  const policy = await repos.policySettings.getByWorkspace(WS);
  assert.strictEqual(policy?.paymentPolicy, EXTRACTED, "the approved value must actually be stored");
  const after = await repos.settingsConflict.getById(WS, conflict.id);
  assert.strictEqual(after?.status, "resolved", "and the card leaves the queue");
});

test("CASE B — when the settings write fails, the conflict stays OPEN", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const conflict = await seedConflict(repos, WS);

  // Reproduce the live failure: the settings write throws the way Prisma threw.
  const realUpsert = repos.policySettings.upsertForWorkspace.bind(repos.policySettings);
  repos.policySettings.upsertForWorkspace = async () => {
    throw new Error("Invalid value for argument `createdAt`: input contains invalid characters. Expected ISO-8601 DateTime.");
  };

  await assert.rejects(
    () => resolveSettingsConflict(WS, conflict.id, "use_extracted", undefined, undefined, repos),
    /createdAt/,
    "the caller must be told the write failed, not given a success",
  );

  repos.policySettings.upsertForWorkspace = realUpsert;

  const after = await repos.settingsConflict.getById(WS, conflict.id);
  assert.strictEqual(
    after?.status,
    "open",
    "a conflict whose value was never written must stay in the queue — otherwise the operator approved a policy that does not exist and will never see it again",
  );
  const policy = await repos.policySettings.getByWorkspace(WS);
  assert.ok(!policy?.paymentPolicy, "and nothing partial is left behind in settings");
});

test("CASE C — a failed resolution records no decision, so a retry is clean", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const conflict = await seedConflict(repos, WS);

  const realUpsert = repos.policySettings.upsertForWorkspace.bind(repos.policySettings);
  repos.policySettings.upsertForWorkspace = async () => { throw new Error("write failed"); };
  await assert.rejects(() => resolveSettingsConflict(WS, conflict.id, "use_extracted", undefined, undefined, repos));
  repos.policySettings.upsertForWorkspace = realUpsert;

  const mid = await repos.settingsConflict.getById(WS, conflict.id);
  assert.ok(!mid?.resolution, `no resolution may be recorded for a write that did not happen, got ${mid?.resolution}`);

  // The retry, once the underlying fault is gone, must fully succeed.
  await resolveSettingsConflict(WS, conflict.id, "use_extracted", undefined, undefined, repos);
  const policy = await repos.policySettings.getByWorkspace(WS);
  assert.strictEqual(policy?.paymentPolicy, EXTRACTED, "the retry writes the value");
  const after = await repos.settingsConflict.getById(WS, conflict.id);
  assert.strictEqual(after?.status, "resolved", "and only then does the card leave the queue");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-conflict-resolve-durability — N-BUG (a conflict may not be marked resolved before its value is written)\n");
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
  console.log(`conflict-resolve-durability: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
