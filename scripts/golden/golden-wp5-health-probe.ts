/**
 * Golden test — Stage 5 / WP5 (2026-07-29) — System health probe (5 cards).
 *
 * Skill build-right Phase 3: pins the CONTRACT of
 * src/services/SystemHealthProbe.ts (the pure chokepoint) +
 * src/lib/health-status.ts (the banner reducer).
 *
 * Per docs/LOGIC.md §WP5.5 + docs/DECISIONS.md D-2026-07-29-f:
 *   - 5 cards: Database (up/down + latencyMs), Scheduler (lastRunAt +
 *     status), LLM providers (slot count + per-slot real/fallback/mock),
 *     Error rate (last 1h count vs threshold), Rate limits (blocked IPs +
 *     workspaces count).
 *   - Status banner: green (all up) · yellow (any warning) · red (DB down
 *     OR error-rate over threshold).
 *   - DB probe times out at 2s → returns {up:false} (never hangs the
 *     dashboard).
 *   - The probe is PURE (no side effects) so it can be unit-tested.
 *
 * Anti-cheat: every numeric assertion is hand-computed in a comment next
 * to it. No "expected" comes from the code under test.
 *
 * Ironclad Gate #8: resetHealthProbe() + restore real clock between cases.
 *
 * Run: npx tsx scripts/golden/golden-wp5-health-probe.ts
 */
export {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

const RUN_ID = `wp5health_${Date.now()}`;

async function main() {
  console.log(`\n=== golden:wp5-health-probe (RUN_ID=${RUN_ID}) ===\n`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const probeMod = require("../../src/services/SystemHealthProbe");
  const {
    probeSystemHealth,
    injectDbProbeForTesting,
    injectSchedulerProbeForTesting,
    injectLlmProbeForTesting,
    injectErrorRateForTesting,
    injectBlockedCountForTesting,
    resetHealthProbe,
    DB_PROBE_TIMEOUT_MS,
  }: typeof import("../../src/services/SystemHealthProbe") = probeMod;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const statusMod = require("../../src/lib/health-status");
  const { computeHealthBanner }: typeof import("../../src/lib/health-status") = statusMod;

  // ===========================================================================
  // CASE 1 — Happy path: all 5 cards present + green banner.
  // Hand-computed: DB up + latencyMs number; scheduler ran recently with
  // status="ok"; 3 LLM slots all real; 0 errors in last hour (threshold=10);
  // 0 blocked IPs/workspaces → banner = "green".
  // ===========================================================================
  {
    resetHealthProbe();
    injectDbProbeForTesting(async () => ({ up: true, latencyMs: 42 }));
    injectSchedulerProbeForTesting(async () => ({ lastRunAt: new Date().toISOString(), status: "ok" }));
    injectLlmProbeForTesting(async () => ({
      slots: [
        { slotId: "fast_reply", provider: "openai", status: "real" },
        { slotId: "workhorse", provider: "anthropic", status: "real" },
        { slotId: "deep", provider: "gemini", status: "real" },
      ],
    }));
    injectErrorRateForTesting(() => ({ last1h: 0, threshold: 10 }));
    injectBlockedCountForTesting(() => ({ blockedIps: 0, blockedWorkspaces: 0 }));

    const probe = await probeSystemHealth();
    assert(probe.database.up === true, "DB up must reflect the probe");
    assert(probe.database.latencyMs === 42, "DB latencyMs must be the injected value (42)");
    assert(probe.scheduler.status === "ok", "scheduler status must be injected");
    assert(Array.isArray(probe.llm.slots) && probe.llm.slots.length === 3, "3 LLM slots expected");
    assert(probe.errorRate.last1h === 0, "0 errors in last hour");
    assert(probe.rateLimits.blockedIps === 0, "0 blocked IPs");
    assert(probe.rateLimits.blockedWorkspaces === 0, "0 blocked workspaces");

    const banner = computeHealthBanner(probe);
    assert(banner.status === "green", `all-healthy probe must yield green banner (got ${banner.status})`);
    pass("CASE 1 — happy path: 5 cards populated, banner = green");
  }

  // ===========================================================================
  // CASE 2 — DB probe times out at 2s and returns {up:false}. The probe
  // MUST NOT hang the dashboard. We inject a probe that sleeps 3s; the
  // wrapper races it against a 2s timeout and resolves {up:false, latencyMs:
  // 2000, timedOut:true}.
  // ===========================================================================
  {
    resetHealthProbe();
    assert(DB_PROBE_TIMEOUT_MS === 2000, `DB probe timeout must be 2000ms (got ${DB_PROBE_TIMEOUT_MS})`);
    // Inject a slow probe (3s, longer than the 2s timeout).
    injectDbProbeForTesting(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return { up: true, latencyMs: 3000 };
    });
    // Inject fast stubs for the other 4 cards so the case stays snappy.
    injectSchedulerProbeForTesting(async () => ({ lastRunAt: new Date().toISOString(), status: "ok" }));
    injectLlmProbeForTesting(async () => ({ slots: [] }));
    injectErrorRateForTesting(() => ({ last1h: 0, threshold: 10 }));
    injectBlockedCountForTesting(() => ({ blockedIps: 0, blockedWorkspaces: 0 }));

    const start = Date.now();
    const probe = await probeSystemHealth();
    const elapsed = Date.now() - start;
    // The probe MUST return well under 3s (proving the timeout fired).
    assert(elapsed < 2500, `probe must respect the 2s timeout (took ${elapsed}ms)`);
    assert(probe.database.up === false, "DB probe must report up=false when it times out");
    assert(probe.database.timedOut === true, "DB probe must report timedOut=true when it times out");
    // Banner must be RED because DB is down.
    const banner = computeHealthBanner(probe);
    assert(banner.status === "red", `DB down must yield red banner (got ${banner.status})`);
    pass(`CASE 2 — DB probe times out at 2s → up:false + red banner (took ${elapsed}ms)`);
  }

  // ===========================================================================
  // CASE 3 — Banner reducer truth table. Hand-computed:
  //   (a) all green                              → green
  //   (b) DB up + scheduler status="error"       → yellow (warning, not down)
  //   (c) DB up + LLM slot status="mock"         → yellow (degraded, not down)
  //   (d) DB up + errorRate.last1h > threshold   → red (error storm)
  //   (e) DB down                                → red (regardless of others)
  // ===========================================================================
  {
    const baseOk = {
      database: { up: true, latencyMs: 10 },
      scheduler: { lastRunAt: new Date().toISOString(), status: "ok" as const },
      llm: { slots: [{ slotId: "s", provider: "openai", status: "real" as const }] },
      errorRate: { last1h: 0, threshold: 10 },
      rateLimits: { blockedIps: 0, blockedWorkspaces: 0 },
    };
    // (a)
    assert(computeHealthBanner(baseOk).status === "green", "(a) all-OK → green");
    // (b) scheduler errored
    assert(
      computeHealthBanner({ ...baseOk, scheduler: { ...baseOk.scheduler, status: "error" } }).status === "yellow",
      "(b) scheduler=error → yellow",
    );
    // (c) LLM mock
    assert(
      computeHealthBanner({ ...baseOk, llm: { slots: [{ slotId: "s", provider: "mock", status: "mock" as const }] } }).status === "yellow",
      "(c) LLM=mock → yellow",
    );
    // (d) error rate over threshold
    assert(
      computeHealthBanner({ ...baseOk, errorRate: { last1h: 15, threshold: 10 } }).status === "red",
      "(d) errorRate 15>10 → red",
    );
    // (e) DB down overrides everything (even with scheduler=ok)
    assert(
      computeHealthBanner({ ...baseOk, database: { up: false, latencyMs: 0, timedOut: true } }).status === "red",
      "(e) DB down → red (regardless of others)",
    );
    // (f) DB down + scheduler error is still red (red wins, not escalated)
    assert(
      computeHealthBanner({ ...baseOk, database: { up: false, latencyMs: 0 }, scheduler: { ...baseOk.scheduler, status: "error" } }).status === "red",
      "(f) DB down + scheduler error → red (red wins)",
    );
    pass("CASE 3 — banner reducer truth table (green/yellow/red priority)");
  }

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
