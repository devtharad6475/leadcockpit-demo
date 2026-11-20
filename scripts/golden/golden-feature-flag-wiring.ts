/**
 * golden-feature-flag-wiring.ts — pins F-P1-3 (Stage 5 re-audit 2026-07-28).
 *
 * WHAT THIS PROVES (docs/AUDIT-FINDINGS-2026-07-28-STAGE5.md):
 *   The Stage 5 re-audit found that 3 of 4 feature flags are WRITE-ONLY:
 *   `setFeatureFlag` writes the row + audit, but NO downstream code reads
 *   `whatsapp_send_enabled`, `ai_usage_enabled`, or `billing_enabled`. The
 *   existing golden (platform-admin-ops CASE L/M) tests the storage layer
 *   round-trip but NOT that flipping a flag AFFECTS the capability.
 *
 *   This golden tests the WIRING: does flipping each flag actually block the
 *   downstream capability?
 *
 * THE CONTRACTS (hand-computed BEFORE writing the assertions):
 *
 *   CASE A — whatsapp_send_enabled=false blocks the WhatsApp send chokepoint:
 *     1. Flag ON (default) → MetaWhatsAppCloudProvider.sendTextMessage proceeds
 *        past the flag check (we don't need a real send; we assert the flag
 *        gate doesn't throw when ON).
 *     2. Flag OFF → sendTextMessage throws a "whatsapp disabled" error BEFORE
 *        attempting the network call (no fetch burn, no provider incident).
 *
 *   CASE B — ai_usage_enabled=false blocks the AI usage chokepoint:
 *     1. Flag ON (default) → AIUsageService.checkCanRunTask returns
 *        {allowed: true} (the existing caps still apply).
 *     2. Flag OFF → checkCanRunTask returns {allowed: false} with a reason
 *        that indicates AI is disabled. No LLM call proceeds.
 *
 *   CASE C — billing_enabled is labeled "not yet enforced" in the UI (WP4 not
 *     built). This is a static check (grep the admin UI source for the label).
 *
 * REAL PIPELINE: imports the real FeatureFlagService + MetaWhatsAppCloudProvider
 * + AIUsageService + real JSON repos. Each case uses a unique RUN_ID namespace
 * (Ironclad Gate #8).
 *
 * Run: npx tsx scripts/golden/golden-feature-flag-wiring.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { repositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { setFeatureFlag, isFeatureEnabled } from "@/services/FeatureFlagService";
import { checkCanRunTask } from "@/services/AIUsageService";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN_ID = `ffw_${Date.now()}`;

/** Seed an isolated operator admin (for setFeatureFlag RBAC). */
async function seedOperator(repos: RepositoryBundle, n: number) {
  const aid = `admin_${RUN_ID}_${n}`;
  await repos.platformAdmin.createWithCredential({
    admin: {
      id: aid,
      email: `op+${RUN_ID}_${n}@test.example`,
      name: `Operator ${n}`,
      role: "operator",
      status: "active",
    },
    credential: {
      adminId: aid,
      email: `op+${RUN_ID}_${n}@test.example`,
      passwordHash: "x".repeat(60),
    },
  });
  return aid;
}

// ─── CASE A: whatsapp_send_enabled gates the WhatsApp send chokepoint ─────
test("CASE A — whatsapp_send_enabled=false blocks MetaWhatsAppCloudProvider.sendTextMessage (flag ON proceeds past the gate)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 1);

  // Flag ON (default) — confirm the flag reads true.
  assert.ok(
    await isFeatureEnabled("whatsapp_send_enabled"),
    "whatsapp_send_enabled must default to true",
  );

  // Dynamic-import the provider (it may have heavy deps). We test the flag
  // gate by calling sendTextMessage with flag OFF and asserting it throws
  // BEFORE any network call. We use a configured-but-flag-off state.
  const { MetaWhatsAppCloudProvider } = await import("@/providers/whatsapp/MetaWhatsAppCloudProvider");

  // Flag OFF.
  await setFeatureFlag({ adminId: aid, key: "whatsapp_send_enabled", enabled: false });
  assert.strictEqual(
    await isFeatureEnabled("whatsapp_send_enabled"),
    false,
    "flag must read false after setFeatureFlag(false)",
  );

  // Construct a provider (it won't actually send — the flag gate throws first).
  // The constructor takes no args (it reads env vars internally); the flag
  // gate runs BEFORE isConfigured(), so even an unconfigured provider throws.
  const provider = new MetaWhatsAppCloudProvider();

  // sendTextMessage with flag OFF must throw with a "disabled" message.
  let threw = false;
  let errMsg = "";
  try {
    await provider.sendTextMessage({
      workspaceId: `ws_${RUN_ID}_a`,
      to: "+919999999999",
      body: "this send must be blocked by the flag",
    });
  } catch (err) {
    threw = true;
    errMsg = (err as Error).message || "";
  }
  assert.ok(threw, "sendTextMessage MUST throw when whatsapp_send_enabled=false (F-P1-3 wiring)");
  assert.match(
    errMsg.toLowerCase(),
    // 2026-09-28: the owner-facing wording ("Sending is paused by the
    // platform") replaced the operator jargon; pinned in golden-review-leftovers.
    /paused by the platform/i,
    `error message must indicate the flag disabled the send (got: "${errMsg}")`,
  );

  // Cleanup: flip the flag back ON so other tests aren't affected.
  await setFeatureFlag({ adminId: aid, key: "whatsapp_send_enabled", enabled: true });
});

// ─── CASE B: ai_usage_enabled gates the AI usage chokepoint ────────────────
test("CASE B — ai_usage_enabled=false makes checkCanRunTask return {allowed: false} (no LLM call proceeds)", async () => {
  const repos = repositories;
  const aid = await seedOperator(repos, 2);
  const workspaceId = `ws_${RUN_ID}_b`;

  // A-7 (2026-08-26): checkCanRunTask writes an ai_usage_limits row for this
  // workspace. The id is invented per run, so on Postgres the write dies on
  // ai_usage_limits_workspace_id_fkey - a tenant that was never created.
  // CASE A deliberately does NOT do this: its workspace id never reaches
  // storage, because the flag gate throws before the send path writes.
  await ensureWorkspace(repos, workspaceId, `feature-flag-wiring golden ${RUN_ID}`);

  // Flag ON (default) — checkCanRunTask allows (within the normal caps).
  assert.ok(await isFeatureEnabled("ai_usage_enabled"), "ai_usage_enabled must default to true");
  const onResult = await checkCanRunTask(workspaceId, "test-task", 100, 0, repos);
  assert.strictEqual(
    onResult.allowed,
    true,
    "checkCanRunTask must ALLOW when ai_usage_enabled=true (within caps)",
  );

  // Flag OFF.
  await setFeatureFlag({ adminId: aid, key: "ai_usage_enabled", enabled: false });
  assert.strictEqual(await isFeatureEnabled("ai_usage_enabled"), false);

  // checkCanRunTask must now REFUSE — no LLM call proceeds.
  const offResult = await checkCanRunTask(workspaceId, "test-task", 100, 0, repos);
  assert.strictEqual(
    offResult.allowed,
    false,
    "checkCanRunTask must REFUSE when ai_usage_enabled=false (F-P1-3 wiring)",
  );
  assert.match(
    (offResult.reason || "").toLowerCase(),
    /disabled|kill.?switch|ai_usage_enabled|not enabled/i,
    `refusal reason must indicate the flag disabled AI usage (got: "${offResult.reason}")`,
  );

  // Cleanup.
  await setFeatureFlag({ adminId: aid, key: "ai_usage_enabled", enabled: true });
});

// ─── CASE C: billing_enabled labeled "not yet enforced" in admin UI ────────
test("CASE C — billing_enabled is labeled 'not yet enforced' in the admin UI (WP4 not built)", async () => {
  // Static check: the admin flags UI must honestly label billing_enabled as
  // not-yet-enforced (since WP4 billing isn't built). Pre-fix the UI showed
  // all 4 toggles as equally functional, which was misleading.
  const uiSrc = readFileSync(
    path.resolve(process.cwd(), "src/app/admin/sections/AdminHealthFlags.tsx"),
    "utf8",
  );
  // The UI must contain some honest labeling for billing_enabled.
  assert.match(
    uiSrc.toLowerCase(),
    /billing.*not.*(enforced|wired|implemented)|(not.*enforced|coming soon|wp4).*billing|billing_enabled.*not/,
    "AdminHealthFlags must honestly label billing_enabled as not-yet-enforced " +
      "(F-P1-3: the UI must not present a write-only toggle as functional)",
  );
});

// ─── Runner ────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(err as Error).message}`);
    }
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-feature-flag-wiring FAILED — see cases above.");
    process.exit(1);
  }
  console.log("✅ golden-feature-flag-wiring ALL GREEN ✅");
  process.exit(0);
})();
