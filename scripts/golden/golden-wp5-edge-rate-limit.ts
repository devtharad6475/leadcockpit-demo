/**
 * Golden test — Stage 5 / WP5 (2026-07-29) — Front-door edge rate limit.
 *
 * Skill build-right Phase 3: pins the CONTRACT of src/lib/edge-rate-limit.ts.
 *
 * Per docs/LOGIC.md §WP5.4 + docs/DECISIONS.md D-2026-07-29-h, as amended by
 * N-SEC-1 (2026-09-03):
 *   - Per IP:          300 requests/minute across ALL endpoints.
 *   - Per workspace:   600 requests/minute across all that workspace's users.
 *   - Block duration:  until the counting minute rolls over.
 *   - Exempt paths:    /api/health, /api/health/deep,
 *                      /api/inbound/whatsapp-webhook, /api/admin/auth/status,
 *                      /api/auth/status.
 *   - IP extraction:   x-forwarded-for → x-real-ip → "unknown". Never throws.
 *
 * WHAT N-SEC-1 CHANGED HERE, AND WHY IT IS NOT A LOOSENING.
 * --------------------------------------------------------
 * This golden was GREEN while the product was wrong. It pinned the count (300,
 * CASE 1) and it pinned EDGE_BLOCK_MS (CASE 6) — but nothing in it pinned the
 * PERIOD those 300 requests are counted over. The implementation passed the
 * 5-minute block duration in as the counting window, so the shipped guard was
 * 300 per five minutes: five times stricter than every document describing it,
 * and strict enough that ordinary operator clicking triggered a lockout.
 *
 * Two changes follow from that, in opposite directions:
 *   - CASE 6 now expects EDGE_BLOCK_MS === 1 minute instead of 5. That is a
 *     DECISION change (recorded in DECISIONS.md as N-SEC-1), not a test being
 *     relaxed to match broken code: the block period and the counting period
 *     are now deliberately the same thing, because the codebase has exactly one
 *     fixed-window counter and never had a separate penalty mechanism at all.
 *   - CASE 7 is NEW and asserts the counting window directly, by measuring the
 *     resetAt the guard hands back. This is the assertion whose absence let the
 *     bug ship, so it is the one that matters most in this file.
 *   - CASE 4 gains /api/auth/status, whose absence from the exempt list turned
 *     a volume block into "the operator is signed out on every refresh".
 *
 * The guard REUSES the existing rate-limit storage chokepoint (memory in
 * demo, Redis in prod) — it does NOT re-implement the math. So this test
 * exercises the public checkEdgeRateLimit + getClientIp + isEdgeExempt
 * surface, not the underlying counter.
 *
 * Ironclad Gate #8 (Test Isolation): every case calls resetEdgeRateLimit()
 * first so no leftover counter from a prior case affects the next. The
 * guard's counter is its OWN action key (distinct from the 27 per-endpoint
 * presets) so it never pollutes or reads them.
 *
 * Anti-cheat (build-right Phase 3): the test counts requests BY HAND
 * (loop to exactly 300, then 1 more) and asserts the 301st is denied. No
 * hardcoded "expected denied" — the loop IS the proof.
 *
 * Run: npx tsx scripts/golden/golden-wp5-edge-rate-limit.ts
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

const RUN_ID = `wp5edge_${Date.now()}`;

async function main() {
  console.log(`\n=== golden:wp5-edge-rate-limit (RUN_ID=${RUN_ID}) ===\n`);

  // The module is imported lazily so a missing/renamed file fails clearly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../src/lib/edge-rate-limit");
  const {
    checkEdgeRateLimit,
    getClientIp,
    isEdgeExempt,
    resetEdgeRateLimit,
    EDGE_PER_IP_LIMIT,
    EDGE_PER_WORKSPACE_LIMIT,
    EDGE_BLOCK_MS,
    EDGE_WINDOW_MS,
  }: typeof import("../../src/lib/edge-rate-limit") = mod;

  // ===========================================================================
  // CASE 1 — Per-IP: 300 requests in a minute are allowed; the 301st is denied.
  // Hand-computed: counter starts at 0. Requests 1..300 each increment + are
  // allowed (remaining goes 299, 298, ..., 0). Request 301 sees count >= 300
  // → denied with reason + Retry-After-equivalent resetAt.
  // ===========================================================================
  {
    resetEdgeRateLimit();
    const ip = `${RUN_ID}_ip1`;
    let lastAllowed = true;
    for (let i = 1; i <= EDGE_PER_IP_LIMIT; i++) {
      const r = await checkEdgeRateLimit({ ip });
      if (!r.allowed) {
        lastAllowed = false;
        break;
      }
    }
    assert(lastAllowed === true, `first ${EDGE_PER_IP_LIMIT} per-IP requests must be allowed`);
    // The 301st (one past the limit) MUST be denied.
    const over = await checkEdgeRateLimit({ ip });
    assert(over.allowed === false, `request ${EDGE_PER_IP_LIMIT + 1} per-IP must be denied`);
    assert(typeof over.resetAt === "string", "denied response must include resetAt (when the block lifts)");
    pass(`CASE 1 — per-IP allows exactly ${EDGE_PER_IP_LIMIT}/window, denies the next`);
  }

  // ===========================================================================
  // CASE 2 — Per-workspace: 600 requests across ALL of that workspace's users
  // are allowed; the 601st is denied. Proves the workspace counter is
  // INDEPENDENT of the IP counter (simulating 600 requests from many IPs,
  // all attributed to one workspace).
  // ===========================================================================
  {
    resetEdgeRateLimit();
    const workspaceId = `${RUN_ID}_ws1`;
    // Simulate many users in one workspace, each from a distinct IP.
    let allAllowed = true;
    for (let i = 1; i <= EDGE_PER_WORKSPACE_LIMIT; i++) {
      const r = await checkEdgeRateLimit({ ip: `${RUN_ID}_u${i}`, workspaceId });
      if (!r.allowed) {
        allAllowed = false;
        break;
      }
    }
    assert(allAllowed === true, `first ${EDGE_PER_WORKSPACE_LIMIT} per-workspace requests must be allowed`);
    const over = await checkEdgeRateLimit({ ip: `${RUN_ID}_overflow`, workspaceId });
    assert(over.allowed === false, `request ${EDGE_PER_WORKSPACE_LIMIT + 1} per-workspace must be denied`);
    pass(`CASE 2 — per-workspace allows exactly ${EDGE_PER_WORKSPACE_LIMIT}/window, denies the next`);
  }

  // ===========================================================================
  // CASE 3 — Block lifts after the window expires. The window-expiry math
  // lives in the underlying checkRateLimitMemory (proven by golden-rate-limit
  // CASE 1), so we don't re-test that mechanism — we test that our WRAPPER
  // correctly delegates to it by using a SHORT test-only window (50ms) via
  // the per-call windowMs override. After 60ms of real sleep, the wrapper
  // must report allowed=true again (proving the underlying counter reset +
  // the wrapper reads the fresh state honestly).
  //
  // This is the build-right Test-Honesty discipline: don't fake the clock to
  // test behavior that real wall-clock already exercises honestly.
  // ===========================================================================
  {
    resetEdgeRateLimit();
    // The wrapper accepts a test-only windowMs override via the 4th arg.
    // If it doesn't, the case fails LOUDLY (build-right: no silent skips).
    const testWindow = 50; // ms — short enough to sleep through honestly
    const ip = `${RUN_ID}_ip_ttl`;
    for (let i = 0; i < EDGE_PER_IP_LIMIT; i++) {
      await checkEdgeRateLimit({ ip }, { windowMs: testWindow });
    }
    const blocked = await checkEdgeRateLimit({ ip }, { windowMs: testWindow });
    assert(blocked.allowed === false, "IP must be blocked at the limit");
    // Sleep past the window — real wall-clock, no fake.
    await new Promise((r) => setTimeout(r, testWindow + 30));
    const after = await checkEdgeRateLimit({ ip }, { windowMs: testWindow });
    assert(after.allowed === true, "IP must be allowed again after window expires");
    pass(`CASE 3 — block auto-releases after window expires (50ms test window, real sleep)`);
  }

  // ===========================================================================
  // CASE 4 — Exempt paths skip the guard. isEdgeExempt returns true for each
  // path in the whitelist; the route layer uses this to bypass the counter.
  // Proves the 4 documented exempt paths.
  // ===========================================================================
  {
    resetEdgeRateLimit();
    const exempt = [
      ["health"],                                       // /api/health
      ["health", "deep"],                               // /api/health/deep
      ["inbound", "whatsapp-webhook"],                  // webhook ingest
      ["admin", "auth", "status"],                      // admin login probe
      ["auth", "status"],                               // operator identity check (N-SEC-1)
    ];
    for (const path of exempt) {
      assert(isEdgeExempt(path) === true, `path ${JSON.stringify(path)} must be exempt`);
    }
    // A NON-exempt path must return false.
    assert(isEdgeExempt(["leads"]) === false, "non-whitelisted path must NOT be exempt");
    assert(isEdgeExempt(["admin", "workspaces"]) === false, "admin mutation paths must NOT be exempt");
    // The operator's identity check MUST be exempt. Without it, a volume block
    // makes the app's boot call throw, the boot fails closed, and the operator
    // is dropped on the login screen with no way back until the block expires.
    assert(isEdgeExempt(["auth", "status"]) === true, "the operator identity check must be exempt (N-SEC-1)");
    assert(isEdgeExempt(["auth", "login"]) === false, "login itself is NOT exempt — it has its own brute-force preset");
    pass("CASE 4 — 5 exempt paths bypass the guard; non-exempt paths do not");
  }

  // ===========================================================================
  // CASE 5 — getClientIp extracts IP correctly + never throws. Reads
  // x-forwarded-for FIRST (taking the first IP in a comma-separated list,
  // since reverse proxies chain them). Falls back to x-real-ip. Falls back
  // to "unknown" if neither is set. Never throws on a malformed header.
  // ===========================================================================
  {
    // x-forwarded-for single IP.
    const ip1 = getClientIp({ headers: { "x-forwarded-for": "203.0.113.42" } });
    assert(ip1 === "203.0.113.42", `x-forwarded-for single IP must be parsed (got ${ip1})`);
    // x-forwarded-for chain (client IP first, proxies after).
    const ip2 = getClientIp({ headers: { "x-forwarded-for": "203.0.113.42, 10.0.0.1, 10.0.0.2" } });
    assert(ip2 === "203.0.113.42", `x-forwarded-for chain must take the FIRST IP (got ${ip2})`);
    // No x-forwarded-for → fall back to x-real-ip.
    const ip3 = getClientIp({ headers: { "x-real-ip": "198.51.100.7" } });
    assert(ip3 === "198.51.100.7", `x-real-ip fallback must work (got ${ip3})`);
    // Neither header → "unknown" (never throws, never undefined).
    const ip4 = getClientIp({ headers: {} });
    assert(ip4 === "unknown", `missing IP headers must yield "unknown" (got ${ip4})`);
    // Malformed header (empty string) → does not throw, yields "unknown".
    let threw = false;
    let ip5 = "untouched";
    try {
      ip5 = getClientIp({ headers: { "x-forwarded-for": "   " } });
    } catch {
      threw = true;
    }
    assert(threw === false, "getClientIp must NEVER throw on malformed header");
    assert(ip5 === "unknown", `blank x-forwarded-for must yield "unknown" (got ${ip5})`);
    pass("CASE 5 — getClientIp: x-forwarded-for → x-real-ip → 'unknown'; never throws");
  }

  // ===========================================================================
  // CASE 6 — Lock the literal numbers from D-2026-07-29-h into the contract
  // (Golden Thread: golden ↔ LOGIC ↔ UI all carry the same value).
  // ===========================================================================
  {
    assert(EDGE_PER_IP_LIMIT === 300, `EDGE_PER_IP_LIMIT must be 300 (got ${EDGE_PER_IP_LIMIT})`);
    assert(EDGE_PER_WORKSPACE_LIMIT === 600, `EDGE_PER_WORKSPACE_LIMIT must be 600 (got ${EDGE_PER_WORKSPACE_LIMIT})`);
    assert(EDGE_BLOCK_MS === 60 * 1000, `EDGE_BLOCK_MS must be 1 minute in ms (got ${EDGE_BLOCK_MS})`);
    assert(EDGE_WINDOW_MS === 60 * 1000, `EDGE_WINDOW_MS must be 1 minute in ms (got ${EDGE_WINDOW_MS})`);
    assert(EDGE_BLOCK_MS === EDGE_WINDOW_MS, "block period and counting period are deliberately the same (N-SEC-1)");
    pass("CASE 6 — Golden Thread: 300 / 600 / 1min literal values pinned");
  }

  // ===========================================================================
  // CASE 7 — THE COUNTING WINDOW IS ONE MINUTE. (N-SEC-1, 2026-09-03.)
  //
  // This is the assertion this file was missing, and its absence is the whole
  // reason the bug shipped: "300 requests" was pinned, "per minute" was not.
  //
  // It is measured, not read back from the constant — asserting
  // `EDGE_WINDOW_MS === 60000` only proves the constant's value, while the bug
  // was that checkEdgeRateLimit ignored it and used a different number. So this
  // case asks the GUARD what it did: the resetAt it hands back on a fresh
  // counter is `now + the window it actually used`.
  //
  // Hand-computed: one request on an unused IP starts a fresh window, so
  // resetAt - now must be ~60_000ms. A tolerance of 5s absorbs scheduling jitter
  // while still failing loudly at the old value (300_000ms was 5x out).
  // ===========================================================================
  {
    resetEdgeRateLimit();
    const before = Date.now();
    const first = await checkEdgeRateLimit({ ip: `${RUN_ID}_window_probe` });
    assert(first.allowed === true, "CASE 7: the first request on a fresh IP must be allowed");
    const windowUsedMs = new Date(first.resetAt).getTime() - before;
    assert(
      Math.abs(windowUsedMs - 60 * 1000) <= 5000,
      `CASE 7: the guard must count over ONE MINUTE. It counted over ${Math.round(windowUsedMs / 1000)}s. `
      + `(Before N-SEC-1 this was 300s — 300 requests per FIVE minutes — which locked operators out of their own product.)`,
    );
    pass("CASE 7 — the guard counts over 1 minute, measured from the resetAt it returns");
  }

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
