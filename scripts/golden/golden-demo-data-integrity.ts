/**
 * Golden test — Demo data integrity (2026-07-29) — Stage 5 / UI sweep guard.
 *
 * Skill build-right Phase 3. This golden exists because of a P0 demo-killer
 * found during the 2026-07-29 pre-demo UI sweep (build-right Ironclad Gate #2):
 * the dashboard showed "0 Total leads" because golden-test runs had polluted
 * `.leadgen-data/app-data.json` with 251 leads in `ws_golden_*` / `ws_action_plan_*`
 * / `ws_convo_*` workspaces while the real demo workspace `workspace_demo` had 0.
 * A recruiter would have seen a completely empty system.
 *
 * Root cause = Stage 5 re-audit finding F-P0-5 ("goldens pollute the shared demo
 * file"). The full fix (Batch 3: every polluting golden cleans up its own
 * workspaces) is queued; THIS golden is the regression-prevention guard so a
 * polluted demo file is caught BEFORE the next demo, regardless of whether the
 * polluting goldens have been fixed yet.
 *
 * What this golden pins (the contract):
 *   1. `workspace_demo` exists and is the SINGLE workspace in the seed file
 *      (a polluted file has dozens of `ws_*` test workspaces).
 *   2. `workspace_demo` has the expected coherent seed content (≥1 lead,
 *      ≥1 approved lead, the demo owner user) — i.e. the seed was actually
 *      applied, not wiped to empty.
 *   3. NO test-prefixed workspaces leaked into the file (`ws_golden_*`,
 *      `ws_smoke*`, `ws_action_plan_*`, `ws_convo_*`, `ws_wh_webhook_*`,
 *      `ws_svm_*`, `ws_prr_*`, `ws_pkslb_*`, `ws_pt_golden_*`, etc.).
 *      If any exist, the file is polluted → FAIL with an actionable message.
 *
 * This golden runs against the SHARED demo file (the one the dev server
 * serves). It is therefore also a Gate #8 (test isolation) guard: it fails
 * loudly if any other test left state behind in the demo store.
 *
 * The recovery action when this fails: `npm run seed:demo -- --force`
 * (restores a clean, coherent workspace; the previous file is auto-backed up).
 *
 * Run: npx tsx scripts/golden/golden-demo-data-integrity.ts
 */
export {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  cases.push({ name, fn });
}

// Known test-pollution workspace-id prefixes (sourced from the 2026-07-29 audit
// of a polluted file). If ANY of these appear in the demo store, a golden/smoke
// test has leaked state into the demo workspace file.
const POLLUTION_PREFIXES = [
  "ws_golden_",
  "ws_smoke",
  "ws_action_plan_",
  "ws_convo_",
  "ws_wh_webhook_",
  "ws_svm_",
  "ws_prr_",
  "ws_pkslb_",
  "ws_pt_golden_",
  "ws_test_",
];

// ─── CASES ───────────────────────────────────────────────────────────────────

test("CASE 1 — the demo data file exists and parses as JSON", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const file = path.join(process.cwd(), ".leadgen-data", "app-data.json");
  assert(fs.existsSync(file), "missing .leadgen-data/app-data.json — run `npm run seed:demo -- --force`");
  const raw = fs.readFileSync(file, "utf8");
  JSON.parse(raw); // throws on malformed JSON
});

test("CASE 2 — workspace_demo exists and is the ONLY workspace (no test pollution)", async () => {
  const { readData } = require("@/lib/db");
  const data = await readData();
  const workspaces: Array<{ id: string; name?: string }> = data.workspaces || [];
  const demo = workspaces.find((w) => w.id === "workspace_demo");
  assert(demo, "workspace_demo is missing — run `npm run seed:demo -- --force` to restore the demo workspace");
  // The clean seed has exactly ONE workspace. A polluted file has many.
  const polluted = workspaces.filter((w) => POLLUTION_PREFIXES.some((p) => w.id.startsWith(p)));
  assert(
    polluted.length === 0,
    `demo file is POLLUTED with ${polluted.length} test workspace(s): ${polluted.slice(0, 5).map((w) => w.id).join(", ")}${polluted.length > 5 ? " ..." : ""}. RECOVERY: run \`npm run seed:demo -- --force\`. ROOT CAUSE: a golden/smoke test created workspaces without cleaning up (Stage 5 finding F-P0-5).`,
  );
  assert(workspaces.length === 1, `expected exactly 1 workspace (workspace_demo), found ${workspaces.length}: ${workspaces.map((w) => w.id).join(", ")}`);
});

test("CASE 3 — workspace_demo has coherent seed content (not wiped to empty)", async () => {
  const { readData } = require("@/lib/db");
  const data = await readData();
  const leads: Array<{ workspaceId: string; reviewStatus?: string }> = data.leads || [];
  const demoLeads = leads.filter((l) => l.workspaceId === "workspace_demo");
  assert(demoLeads.length >= 1, `workspace_demo has ${demoLeads.length} leads — the seed was not applied. Run \`npm run seed:demo -- --force\`.`);
  const approved = demoLeads.filter((l) => l.reviewStatus === "approved");
  assert(approved.length >= 1, `workspace_demo has ${approved.length} approved leads — expected ≥1 from the seed (the dashboard "Approved" card would show 0)`);
});

test("CASE 4 — the demo owner user exists (dashboard renders 'Demo Owner')", async () => {
  const { readData } = require("@/lib/db");
  const data = await readData();
  const users: Array<{ id: string; workspaceId?: string; name?: string }> = data.users || [];
  const owner = users.find((u) => u.id === "user_owner");
  assert(owner, "user_owner is missing — the dashboard header would show a blank user. Run `npm run seed:demo -- --force`.");
});

test("CASE 5 — no orphan leads in test-prefixed workspaces (Gate #8 isolation guard)", async () => {
  const { readData } = require("@/lib/db");
  const data = await readData();
  const leads: Array<{ workspaceId: string }> = data.leads || [];
  const orphaned = leads.filter((l) => POLLUTION_PREFIXES.some((p) => l.workspaceId.startsWith(p)));
  assert(
    orphaned.length === 0,
    `${orphaned.length} lead(s) are orphaned in test-prefixed workspaces (${orphaned.slice(0, 3).map((l) => l.workspaceId).join(", ")}...). They are invisible in the demo UI but inflate the file. RECOVERY: \`npm run seed:demo -- --force\`.`,
  );
});

// ─── RUNNER ──────────────────────────────────────────────────────────────────

(async () => {
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
  console.log(`demo-data-integrity: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) {
    console.log("");
    console.log("RECOVERY: npm run seed:demo -- --force");
    process.exit(1);
  }
})();
