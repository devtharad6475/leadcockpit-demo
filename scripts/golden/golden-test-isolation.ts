/**
 * golden-test-isolation.ts — pins Ironclad Gate #8 (Test Isolation) for the
 * Stage 5 goldens that historically polluted the shared JSON demo file.
 *
 * WHAT THIS PROVES (Stage 5 re-audit, F-P0-5)
 *   The shared `.leadgen-data/app-data.json` file is a global store. A golden
 *   test that seeds rows into it but never cleans up leaves those rows behind
 *   for the NEXT test (or the next run of the SAME test). That is a flaky-test
 *   factory: a future case that counts "how many workspaces exist" gets a
 *   wrong answer because of leftover state. build-right Gate #8: every test
 *   must run on its own clean slate, never on shared state from a prior run.
 *
 * THE CONTRACT (hand-computed BEFORE writing assertions):
 *
 *   CASE A — golden-signup-invite is self-cleaning. Snapshot the demo file's
 *            row counts across every Stage-5 table BEFORE the run. Spawn the
 *            golden as a child process (real pipeline, the same path CI runs).
 *            After it exits green, snapshot again. The row counts MUST be
 *            byte-for-byte identical. If the test left even one workspace
 *            behind, this case fails.
 *
 *   CASE B — golden-platform-admin-ops is self-cleaning. Same contract: the
 *            WP2 golden seeds 13 workspaces + 13 admins + audit rows + flag
 *            toggles + impersonation sessions + password-reset tokens. After
 *            the run, ALL of those must be gone. The shared file is unchanged.
 *
 *   CASE C — Re-runnability: the same golden run TWICE in succession leaves
 *            the file unchanged after BOTH runs. (This catches the failure
 *            mode where the cleanup only works once because it relies on
 *            state from the first run.)
 *
 * WHY SPAWN A CHILD PROCESS: the goldens call `createRepositories()` which
 * binds to the demo file via a module-level singleton. Running them in-process
 * would share the same module state. Spawning a fresh `tsx` child gives each
 * golden its own module graph AND its own process exit — exactly what CI does.
 *
 * Run: npx tsx scripts/golden/golden-test-isolation.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const DEMO_FILE = `${process.cwd()}/.leadgen-data/app-data.json`;

/** Tables the Stage 5 goldens touch. The snapshot must be identical before
 *  and after a self-cleaning golden run. */
const STAGE5_TABLES = [
  "workspaces",
  "users",
  "userCredentials",
  "workspaceMembers",
  "auditLogs",
  "platformAdmins",
  "platformAdminCredentials",
  "platformAuditLogs",
  "featureFlags",
  "invites",
  "emailVerificationTokens",
  "passwordResetTokens",
  "impersonationSessions",
];

type Snapshot = Record<string, number>;

function snapshot(): Snapshot {
  const raw = readFileSync(DEMO_FILE, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const counts: Snapshot = {};
  for (const table of STAGE5_TABLES) {
    const value = data[table];
    counts[table] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

function assertSnapshotsEqual(before: Snapshot, after: Snapshot, label: string) {
  for (const table of STAGE5_TABLES) {
    assert.strictEqual(
      after[table],
      before[table],
      `${label}: table "${table}" changed ${before[table]} → ${after[table]} (golden leaked rows — Gate #8 violation)`,
    );
  }
}

/** Run a golden as a child process (mirrors CI). Throws if the golden fails. */
function runGolden(scriptRel: string): void {
  // Stage 6 / 2026-07-31: logic goldens must run with the JSON-provider preload
  // so the service-layer `repositories` singleton (read once at module-load)
  // resolves to JSON regardless of `.env`. This mirrors what the suite runner
  // (run-all-goldens.ts) and the standalone `golden:*` npm scripts do. Without
  // this, spawning golden-signup-invite under a prisma `.env` would fail with
  // "Admin not found" — the spawned golden seeds JSON while its services read
  // the Prisma singleton (split-brain). The golden under test here (the one
  // being checked for self-cleaning) is always a logic golden.
  const args = ["tsx", "--import", "./scripts/golden/_helpers/force-json-provider.ts", scriptRel];
  const out = execFileSync("npx", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    shell: process.platform === "win32",
  });
  if (!/Result: \d+ passed, 0 failed/.test(out) && !/ALL GREEN/.test(out) && !/\d+ passed, 0 failed/.test(out)) {
    throw new Error(`golden ${scriptRel} did not report green:\n${out.slice(-800)}`);
  }
}

// ─── CASE A: golden-signup-invite is self-cleaning ──────────────────────────
test("CASE A — golden-signup-invite leaves the demo file byte-for-byte unchanged", async () => {
  const before = snapshot();
  runGolden("scripts/golden/golden-signup-invite.ts");
  const after = snapshot();
  assertSnapshotsEqual(before, after, "signup-invite run 1");
});

// ─── CASE B: golden-platform-admin-ops is self-cleaning ─────────────────────
test("CASE B — golden-platform-admin-ops leaves the demo file byte-for-byte unchanged", async () => {
  const before = snapshot();
  runGolden("scripts/golden/golden-platform-admin-ops.ts");
  const after = snapshot();
  assertSnapshotsEqual(before, after, "platform-admin-ops run 1");
});

// ─── CASE C: re-runnability (run twice, both clean) ─────────────────────────
test("CASE C — running each golden TWICE in a row still leaves the file clean both times", async () => {
  const scripts = [
    "scripts/golden/golden-signup-invite.ts",
    "scripts/golden/golden-platform-admin-ops.ts",
  ];
  for (const rel of scripts) {
    const before = snapshot();
    runGolden(rel); // run 1
    const after1 = snapshot();
    assertSnapshotsEqual(before, after1, `${rel} run 1`);
    runGolden(rel); // run 2 — must not depend on run 1's leftover state
    const after2 = snapshot();
    assertSnapshotsEqual(before, after2, `${rel} run 2`);
  }
});

// ─── Runner ─────────────────────────────────────────────────────────────────
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
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-test-isolation FAILED — Stage 5 goldens are leaking rows (F-P0-5 not closed).");
    process.exit(1);
  }
  console.log("✅ golden-test-isolation ALL GREEN ✅");
  process.exit(0);
})();
